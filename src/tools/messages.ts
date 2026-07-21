import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { syncAll, fetchAttachmentMeta, fetchAttachmentMetaForMessage, getDraftsCacheStatus } from '../sync.js';
import type { DraftsCacheStatus } from '../sync.js';
import { buildFreshness } from './freshness.js';
import type { FreshnessBlock } from './freshness.js';
import {
  DraftFreshnessError, checkDraftFreshness, draftRevision, fetchServerDraft, staleDraftPayload,
} from './draft-freshness.js';
import type { DraftContent } from './draft-freshness.js';
import type { CacheStore, MessageRow, DraftRow, FolderName } from '../cache/store.js';
import { getFolderVerifiedAt } from '../sync.js';
import type { AttachmentIO } from './attachments.js';
import { isHostRenderableImage, resolveDownloadMime } from './attachments.js';
import { getAttachmentsDir, getDefaultInlineAttachments, getSyncMaxRequests, getWriteMode } from '../config.js';
import { basename, join } from 'node:path';
import { ApiRecipientSchema, expandPath, hasRealView, jsonErrorResponse, jsonResponse, mapRecipients, postMessageAndRefetch, textResponse, verifyWriteLanded, withReadState } from './_shared.js';
import { parseLenient } from '@chrischall/mcp-utils';

// Schemas for the load-bearing fields of each /pub/v3 response this file
// reads (issue #83). Loose: unknown keys pass through into cached listData.
const DateSchema = z.looseObject({ dateTime: z.string() });

// Detail GET after a send/save POST — validated STRICT inside
// postMessageAndRefetch (write-verification boundary). All fields optional:
// absence is handled by verifyWriteLanded's WARNING; a present-but-mistyped
// field throws.
const SentDetailSchema = z.looseObject({
  subject: z.string().optional(),
  body: z.string().optional(),
  date: DateSchema.optional(),
  from: z.looseObject({ name: z.string().optional() }).optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
});
const SavedDraftDetailSchema = z.looseObject({
  subject: z.string().optional(),
  body: z.string().optional(),
  date: DateSchema.optional(),
  replyToId: z.number().nullable().optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
});

// ofw_get_message's uncached detail fetch — lenient: a mismatch warns to
// stderr and the existing ?? fallbacks keep the tool serving.
const MessageDetailSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  body: z.string().optional(),
  date: DateSchema,
  from: z.looseObject({ name: z.string().optional() }).optional(),
  files: z.array(z.number()).optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
  // The detail payload carries its own owning folder ({id, name}). We read the
  // id to label a live-fetched message sent-vs-inbox instead of blindly
  // defaulting to inbox — see the folder derivation in ofw_get_message.
  folder: z.looseObject({ id: z.number() }).optional(),
});

// Attachment-backfill detail fetch reads only `files`.
const DetailFilesSchema = z.looseObject({ files: z.array(z.number()).optional() });

// ofw_check_freshness' folder probe. `includeFolderCounts=true` returns a
// per-folder count, but the field name varies across OFW payload versions —
// accept the known spellings and degrade to a null serverCount rather than
// guessing, since a wrong count would manufacture a false out-of-sync verdict.
const FolderCountsSchema = z.looseObject({
  systemFolders: z.array(z.looseObject({
    id: z.string(),
    folderType: z.string(),
    totalCount: z.number().optional(),
    messageCount: z.number().optional(),
    count: z.number().optional(),
  })).optional(),
});

const FOLDER_TYPE: Record<FolderName, string> = {
  inbox: 'INBOX',
  sent: 'SENT_MESSAGES',
  drafts: 'DRAFTS',
};

/**
 * Cap on per-id probes in one ofw_check_freshness call.
 *
 * Each id costs one OFW request, and on the hosted Worker every request counts
 * against the subrequest cap (see OFW_SYNC_MAX_REQUESTS). The check has to stay
 * cheap enough that a caller reaches for it freely — that is the entire point
 * of it existing — so it truncates loudly rather than turning into a sync.
 */
const MAX_FRESHNESS_IDS = 25;

// Upload response — STRICT: fileId is the whole point of the call; caching
// or returning an undefined/mistyped fileId produces an unusable attachment.
const UploadedFileSchema = z.looseObject({
  fileId: z.number(),
  fileName: z.string().optional(),
  label: z.string().optional(),
  fileType: z.string().optional(),
  sizeInBytes: z.number().optional(),
  shareClass: z.string().optional(),
});

// The list endpoint payload (cached as `listData`) reports attachments via
// `files: <count>` (a number) — the actual fileIds only appear on the detail
// endpoint as `files: [number, ...]`. Some intermediate shapes return an
// array on the list too. Treat any of those as "this message has files".
function listDataHintsAtFiles(listData: unknown): boolean {
  if (typeof listData !== 'object' || listData === null) return false;
  const ld = listData as { files?: unknown };
  if (typeof ld.files === 'number') return ld.files > 0;
  if (Array.isArray(ld.files)) return ld.files.length > 0;
  return false;
}

/**
 * Freshness for a drafts read, plus the per-draft `serverConfirmed` flag.
 *
 * `serverConfirmed` answers the question that triggered this whole mechanism:
 * "is this draft actually still sitting unsent on OFW?" It is true ONLY when a
 * completed drafts walk verified the cache against OFW within the freshness
 * window (getFreshnessTtlSeconds, default 300s) — NOT a claim about this exact
 * instant, which no cache can make. Anything less — a deferred walk, an aged
 * stamp, a cache that was never checked — is false, meaning the draft's
 * existence and unsent status are remembered, not known. On a false, a caller
 * must not state either as present-tense fact without calling
 * ofw_check_freshness first.
 */
async function draftsFreshness(
  cache: CacheStore,
): Promise<{ freshness: FreshnessBlock; serverConfirmed: boolean; cacheStatus: DraftsCacheStatus }> {
  const freshness = await buildFreshness(cache, { source: 'cache', folders: ['drafts'] });
  // Reconcile the two signals so a single response can never contradict
  // itself (the same rule withReadState applies to read flags). The drafts
  // meta key says whether the last walk COMPLETED; freshness additionally
  // knows whether that walk has since aged out or been overtaken by a sync
  // that skipped drafts. Downgrade only — this can turn 'fresh' off, never on.
  const completed = await getDraftsCacheStatus(cache);
  const cacheStatus: DraftsCacheStatus = completed === 'fresh' && freshness.staleness === 'fresh'
    ? 'fresh'
    : 'unverified';
  return { freshness, serverConfirmed: cacheStatus === 'fresh', cacheStatus };
}

export function registerMessageTools(
  server: McpServer,
  client: OFWClient,
  cacheProvider: () => CacheStore,
  attachmentIO: AttachmentIO,
): void {
  // OFW_WRITE_MODE gate (see config.ts). Send lands on the court-visible
  // record, so it is 'all'-only; draft-level writes (save/delete drafts,
  // upload attachments) also register under 'drafts'. Read/sync/download
  // tools always register.
  const writeMode = getWriteMode();
  const allowSend = writeMode === 'all';
  const allowDrafts = writeMode !== 'none';

  server.registerTool('ofw_list_message_folders', {
    description: 'List OurFamilyWizard message folders (inbox, sent, etc.) and their unread counts. Fetched LIVE from OFW, so the counts are current. Returns folder IDs needed to call ofw_list_messages. Does NOT return message content.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    const freshness = await buildFreshness(cacheProvider(), { source: 'live', folders: [] });
    return jsonResponse({ folders: data, freshness });
  });

  server.registerTool('ofw_list_messages', {
    description: 'List messages from the local OurFamilyWizard cache. Supports filtering by folder, date range, and a substring query on subject+body. Pagination is offset-based but if you know what you want (a date range, a topic), prefer the filters over walking pages — the cache may have 1000+ messages. Call ofw_sync_messages first if the cache is empty or stale.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      folderId: z.string().describe('Folder name: "inbox", "sent", or "both" (default "both")').optional(),
      page: z.number().int().min(1).describe('Page number (default 1)').optional(),
      size: z.number().int().min(1).describe('Messages per page (default 50)').optional(),
      since: z.string().describe('ISO date or datetime — only messages with sent_at >= since (inclusive)').optional(),
      until: z.string().describe('ISO date or datetime — only messages with sent_at < until (exclusive)').optional(),
      q: z.string().describe('Substring match on subject AND body (case-insensitive). Use to find messages on a specific topic.').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const folderArg = args.folderId ?? 'both';

    let folder: 'inbox' | 'sent' | undefined;
    if (folderArg === 'inbox') folder = 'inbox';
    else if (folderArg === 'sent') folder = 'sent';
    else if (folderArg === 'both') folder = undefined;
    else {
      // Still carries freshness: `messages: []` with no age label is exactly
      // the shape this mechanism exists to eliminate, even when the emptiness
      // is caused by a bad argument rather than an empty cache.
      return jsonResponse({
        messages: [],
        freshness: await buildFreshness(cacheProvider(), {
          source: 'cache',
          folders: ['inbox', 'sent'],
        }),
        note: 'folderId must be "inbox", "sent", or "both". Numeric OFW folder IDs are not supported by the cache. No lookup was performed — this empty result says nothing about what is in the cache.',
      });
    }

    const cache = cacheProvider();
    const filter = { folder, since: args.since, until: args.until, q: args.q };
    const total = await cache.countMessages(filter);
    // Reconcile each row's read state at read time: the cached list flags can be
    // stale (a message read after it was first scraped), so `read` is derived
    // from the record's own `viewedAt`/`fetchedBodyAt` and `listData` is forced
    // to agree — see withReadState.
    const messages = (await cache.listMessages({ ...filter, page, size })).map((m) => withReadState(m));

    // Served from the local cache, so the result must say how old it is and
    // whether anything vouches for it — a caller cannot state current state
    // from this payload without either re-reading or surfacing the caveat.
    const freshness = await buildFreshness(cache, {
      source: 'cache',
      folders: folder === undefined ? ['inbox', 'sent'] : [folder],
    });

    const payload: Record<string, unknown> = { messages, total, page, size, freshness };
    if (total === 0) {
      payload.note = 'No messages match these filters. If you expected results, check ofw_sync_messages was run, or relax the filters.';
    } else if (page * size < total) {
      payload.note = `Showing ${(page - 1) * size + 1}–${(page - 1) * size + messages.length} of ${total}. Increase 'page' to see more, or narrow with since/until/q.`;
    }

    return jsonResponse(payload);
  });

  server.registerTool('ofw_get_message', {
    description: 'Get a single OurFamilyWizard message OR draft by ID. Reads from local cache when available; otherwise fetches from OFW (which will mark unread inbox messages as read on OFW). For ids that match a draft (in the drafts cache), the response carries folder="drafts" and the body/subject/recipients reflect the drafts cache (which ofw_sync_messages keeps fresh) — drafts have no `fromUser`, and `sentAt`/`fetchedBodyAt` mirror the draft\'s `modifiedAt`. For inbox/sent messages, folder is "inbox" or "sent" as before.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      messageId: z.string().describe('Message ID (also accepts draft IDs — drafts are routed via the drafts cache)'),
    },
  }, async (args) => {
    const id = Number(args.messageId);
    const cache = cacheProvider();

    // Draft routing: if this id is in the drafts cache, return a
    // MessageRow-shaped synthesis built from the draft. The drafts table
    // is the source of truth for draft bodies (sync keeps it fresh);
    // the messages-table cache for the same id is stale by construction
    // when ofw_get_message was called on a draft id before sync caught
    // up — see syncDrafts, which also evicts these stale rows.
    const draftRow = await cache.getDraft(id);
    if (draftRow !== null) {
      const { freshness, serverConfirmed, cacheStatus } = await draftsFreshness(cache);
      return jsonResponse({
        id: draftRow.id,
        folder: 'drafts',
        subject: draftRow.subject,
        fromUser: '',
        sentAt: draftRow.modifiedAt,
        recipients: draftRow.recipients,
        body: draftRow.body,
        // Best approximation: drafts don't separately track when the body
        // was last *fetched* — we last wrote it on the last sync, which
        // also updates modifiedAt.
        fetchedBodyAt: draftRow.modifiedAt,
        replyToId: draftRow.replyToId,
        chainRootId: null,
        listData: draftRow.listData,
        attachments: [],
        // Concurrency token — pass as expectedRevision to ofw_save_draft /
        // ofw_delete_draft to assert you are editing THIS version.
        revision: draftRevision(draftRow),
        cacheStatus,
        // False = this draft's existence and unsent status are remembered from
        // a cache, not confirmed on OFW. Call ofw_check_freshness before
        // stating either as current fact.
        serverConfirmed,
        freshness,
      });
    }

    const cached = await cache.getMessage(id);
    if (cached && cached.body !== null) {
      let row = cached;
      // Refresh view status for a sent message we still believe is unviewed:
      // the recipient may have opened it since the last sync, and the detail
      // endpoint carries the real "First Viewed" timestamp (a list-synced row
      // only knows the showNeverViewed boolean / epoch placeholder). Best-
      // effort and one-way — once a real viewed time is cached we stop re-
      // fetching. Sent-only: re-hitting an unread INBOX detail would mark it
      // read on OFW.
      if (cached.folder === 'sent' && !hasRealView(cached.recipients)) {
        try {
          const detail = parseLenient(
            MessageDetailSchema,
            await client.request('GET', `/pub/v3/messages/${id}`),
            { label: 'ofw-mcp', context: 'GET /pub/v3/messages/{id} (view-status refresh)' },
          );
          const recipients = mapRecipients(detail.recipients);
          // Keep the raw listData read-flag in step with the refreshed
          // recipients so `showNeverViewed` can't contradict `viewedAt`.
          // (Spreading a null/absent listData is a no-op, so no guard needed.)
          row = {
            ...cached,
            recipients,
            listData: { ...(cached.listData as Record<string, unknown> | null), showNeverViewed: !hasRealView(recipients) },
          };
          await cache.upsertMessage(row);
        } catch {
          // Best-effort: fall back to the cached row on any fetch/parse error.
        }
      }
      let attachments = await cache.listAttachmentsForMessage(id);
      // Lazy attachment backfill. The list-endpoint payload (stored in
      // listData) hints at attachments via `files: <count>` but doesn't
      // expose the fileIds — those live only on /pub/v3/messages/{id}.
      // For messages bodied before attachment caching existed, the
      // attachments table is empty even though OFW has files. Re-hit
      // detail to harvest fileIds (idempotent: body is already cached so
      // OFW state isn't changing).
      if (attachments.length === 0 && listDataHintsAtFiles(row.listData)) {
        try {
          const detail = parseLenient(
            DetailFilesSchema,
            await client.request('GET', `/pub/v3/messages/${id}`),
            { label: 'ofw-mcp', context: 'GET /pub/v3/messages/{id} (attachment backfill)' },
          );
          if (Array.isArray(detail.files) && detail.files.length > 0) {
            await fetchAttachmentMetaForMessage(client, id, detail.files, cache);
            attachments = await cache.listAttachmentsForMessage(id);
          }
        } catch {
          // Backfill is best-effort. Fall through with whatever we have.
        }
      }
      // Cache-served: the body is whatever the last sync stored. Even though
      // this call may have re-hit detail for view status, the message content
      // itself was not re-verified, so report the folder's cache freshness.
      const freshness = await buildFreshness(cache, { source: 'cache', folders: [row.folder] });
      return jsonResponse({ ...withReadState(row), attachments, freshness });
    }

    const detail = parseLenient(
      MessageDetailSchema,
      await client.request('GET', `/pub/v3/messages/${encodeURIComponent(args.messageId)}`),
      { label: 'ofw-mcp', context: 'GET /pub/v3/messages/{id} (ofw_get_message)' },
    );

    // Derive the folder for a live-fetched message. A cached row (reached here
    // only when its body was NULL) already knows its folder, so keep it.
    // Otherwise use the detail's own folder id, matched against the sent folder
    // id persisted by the last resolveFolderIds — a sent message must not be
    // mislabeled 'inbox' (which would also hide it from ofw_get_unread_sent and
    // a sent-scoped ofw_list_messages). When that mapping isn't known yet (no
    // sync has run in this cache), fall back to 'inbox' as before.
    let folder: 'inbox' | 'sent' = cached?.folder ?? 'inbox';
    if (!cached) {
      const sentFolderId = await cache.getMeta('sent_folder_id');
      if (sentFolderId !== null && detail.folder?.id != null && String(detail.folder.id) === sentFolderId) {
        folder = 'sent';
      }
    }
    const row: MessageRow = {
      id: detail.id,
      folder,
      subject: detail.subject,
      fromUser: detail.from?.name ?? '',
      sentAt: detail.date?.dateTime ?? new Date().toISOString(),
      recipients: mapRecipients(detail.recipients),
      body: detail.body ?? '',
      fetchedBodyAt: new Date().toISOString(),
      replyToId: cached?.replyToId ?? null,
      chainRootId: cached?.chainRootId ?? null,
      listData: cached?.listData ?? detail,
    };
    await cache.upsertMessage(row);
    if (Array.isArray(detail.files) && detail.files.length > 0) {
      await fetchAttachmentMetaForMessage(client, detail.id, detail.files, cache);
    }
    const attachments = await cache.listAttachmentsForMessage(detail.id);
    // Fetched live from OFW in this call — current by construction.
    const freshness = await buildFreshness(cache, { source: 'live', folders: [folder] });
    return jsonResponse({ ...withReadState(row), attachments, freshness });
  });

  if (allowSend) server.registerTool('ofw_send_message', {
    description: 'Send a message via OurFamilyWizard. To send an existing draft, pass messageId — subject/body/recipientIds become optional overrides (missing fields default to the draft\'s cached values) and the draft is deleted after sending. To send a fresh message, supply subject/body/recipientIds directly. draftId is the legacy spelling of messageId and works the same way. If replyToId is provided, the cache may rewrite it to the latest reply in the same thread (a note is included in the response when this happens). Attach files by passing their fileIds (from ofw_upload_attachment) in myFileIDs. After sending, the tool re-fetches the message from OFW to populate the local cache and link attachments to the new message id.',
    annotations: { destructiveHint: true },
    inputSchema: {
      subject: z.string().describe('Message subject. Required unless messageId/draftId references a cached draft.').optional(),
      body: z.string().describe('Message body text. Required unless messageId/draftId references a cached draft.').optional(),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (get from ofw_get_profile). Required unless messageId/draftId references a cached draft.').optional(),
      replyToId: z.number().describe('ID of the message being replied to').optional(),
      messageId: z.number().describe('ID of an existing draft to send. When set, missing subject/body/recipientIds default to the draft\'s cached values, and the draft is deleted after sending.').optional(),
      draftId: z.number().describe('Legacy synonym for messageId. If both are passed they must be equal.').optional(),
      myFileIDs: z.array(z.number()).describe('Attachment file ids (from ofw_upload_attachment) to attach to the message').optional(),
    },
  }, async (args) => {
    if (args.messageId !== undefined && args.draftId !== undefined && args.messageId !== args.draftId) {
      throw new Error(`messageId (${args.messageId}) and draftId (${args.draftId}) refer to different drafts; pass only one.`);
    }
    const draftRef = args.messageId ?? args.draftId;
    const cache = cacheProvider();

    // Best-effort draft lookup: when draftRef points at a cached draft, use
    // its stored fields (including replyToId) as defaults for anything the
    // caller didn't supply. The "missing draft" case only matters when we
    // actually NEED the defaults — a caller passing all fields explicitly
    // can use draftId as a pure delete-target even on an empty cache.
    let subject = args.subject;
    let body = args.body;
    let recipientIds = args.recipientIds;
    let draftReplyToId: number | null = null;
    let draftLookupAttempted = false;
    let draftFound = false;
    if (draftRef !== undefined) {
      draftLookupAttempted = true;
      const draft = await cache.getDraft(draftRef);
      if (draft !== null) {
        draftFound = true;
        subject = subject ?? draft.subject;
        body = body ?? draft.body;
        recipientIds = recipientIds ?? draft.recipients.map((r) => r.userId);
        draftReplyToId = draft.replyToId;
      }
    }
    if (subject === undefined || body === undefined || recipientIds === undefined) {
      if (draftLookupAttempted && !draftFound) {
        throw new Error(
          `draft ${draftRef} not found in local cache. Call ofw_sync_messages first, or supply subject/body/recipientIds explicitly.`,
        );
      }
      const missing = [
        subject === undefined ? 'subject' : null,
        body === undefined ? 'body' : null,
        recipientIds === undefined ? 'recipientIds' : null,
      ].filter((n): n is string => n !== null).join(', ');
      throw new Error(
        `ofw_send_message requires ${missing}. Pass it directly, or pass messageId to default missing fields from a cached draft.`,
      );
    }

    // Inherit the draft's replyToId when the caller didn't supply one. A
    // reply-draft saved with replyToId would otherwise be sent as a
    // top-level message — silently losing the thread.
    const requestedReplyTo = args.replyToId ?? draftReplyToId ?? null;
    let resolvedReplyTo = requestedReplyTo;
    let chainRootId: number | null = null;
    let rewriteNote: string | null = null;

    if (requestedReplyTo !== null) {
      resolvedReplyTo = await cache.findLatestReplyTip(requestedReplyTo);
      if (resolvedReplyTo !== requestedReplyTo) {
        rewriteNote = `replyToId rewritten from ${requestedReplyTo} to ${resolvedReplyTo} (later reply in same thread found in sent cache).`;
      }
      const parent = await cache.getMessage(resolvedReplyTo);
      chainRootId = parent?.chainRootId ?? parent?.id ?? requestedReplyTo;
    }

    const myFileIDs = args.myFileIDs ?? [];
    const { id: newId, detail, raw } = await postMessageAndRefetch(client, {
      subject,
      body,
      recipientIds,
      attachments: { myFileIDs },
      draft: false,
      includeOriginal: resolvedReplyTo !== null,
      replyToId: resolvedReplyTo,
    }, SentDetailSchema, 'ofw_send_message');

    let persisted: MessageRow | null = null;
    let verifyNote: string | null = null;
    if (newId !== null) {
      verifyNote = verifyWriteLanded('message', { subject, body }, detail);
      persisted = {
        id: newId,
        folder: 'sent',
        subject: detail.subject ?? subject,
        fromUser: detail.from?.name ?? '',
        sentAt: detail.date?.dateTime ?? new Date().toISOString(),
        recipients: mapRecipients(detail.recipients),
        body: detail.body ?? body,
        fetchedBodyAt: new Date().toISOString(),
        replyToId: resolvedReplyTo,
        chainRootId,
        listData: detail,
      };
      await cache.upsertMessage(persisted);
      // Link attached files to the new message in the attachments cache.
      // We may not have full metadata if the upload happened in a prior
      // session — fall back to what we know.
      for (const fileId of myFileIDs) {
        const existing = await cache.getAttachment(fileId);
        await cache.upsertAttachmentForMessage({
          fileId,
          fileName: existing?.fileName ?? `file-${fileId}`,
          label: existing?.label ?? existing?.fileName ?? `file-${fileId}`,
          mimeType: existing?.mimeType ?? 'application/octet-stream',
          sizeBytes: existing?.sizeBytes ?? null,
          metadata: existing?.metadata ?? {},
          messageId: newId,
        });
      }
    }

    // Only clean up the draft once the send is confirmed (the POST response
    // carried an id). On the unconfirmed path the draft is the user's only
    // copy of the message — keep it.
    let unconfirmedNote: string | null = null;
    if (newId === null) {
      const draftClause = draftRef !== undefined
        ? `Draft ${draftRef} was NOT deleted — check`
        : 'Check';
      unconfirmedNote = `WARNING: OFW's send response did not include a message id, so the send could not be confirmed. ${draftClause} ourfamilywizard.com to see whether the message went out before retrying.`;
    } else if (draftRef !== undefined) {
      await deleteOFWMessages(client, [draftRef]);
      await cache.deleteDraft(draftRef);
    }

    const responseObj = persisted ?? raw;
    const text = responseObj ? JSON.stringify(responseObj, null, 2) : 'Message sent successfully.';
    const notes = [rewriteNote, verifyNote, unconfirmedNote].filter((n): n is string => n !== null).join('\n\n');
    return textResponse(notes ? `${notes}\n\n${text}` : text);
  });

  // ── Destructive-draft-op guard ──────────────────────────────────────────
  //
  // Every path that DESTROYS an existing draft (ofw_save_draft's replace path,
  // ofw_delete_draft) runs through this first. It re-reads the draft from OFW
  // and refuses unless we can show the caller is current with it.
  //
  // Background: drafts edited in the OFW web app do not bump any timestamp the
  // API exposes, so a cached draft can silently be months behind the server.
  // ofw_save_draft replaces via create-then-delete, so acting on a stale base
  // does not merge — it DESTROYS the server's version. Hence: refuse by
  // default, and never treat "no token supplied" as consent to overwrite.
  type DraftGuardOutcome =
    | { ok: true; note: string | null }
    | { ok: false; response: ReturnType<typeof jsonErrorResponse> };

  async function guardDestructiveDraftOp(input: {
    cache: CacheStore;
    draftId: number;
    expectedRevision?: string;
    force: boolean;
    action: string;
  }): Promise<DraftGuardOutcome> {
    const { cache, draftId, expectedRevision, force, action } = input;

    const cachedRow = await cache.getDraft(draftId);
    const cached: DraftContent | null = cachedRow === null ? null : {
      subject: cachedRow.subject,
      body: cachedRow.body,
      recipients: cachedRow.recipients,
      replyToId: cachedRow.replyToId,
    };

    let server: DraftContent | null;
    try {
      server = await fetchServerDraft(client, draftId);
    } catch (e) {
      // fetchServerDraft funnels every non-404 failure into DraftFreshnessError,
      // so anything landing here means the check could not RUN. That is not
      // permission to proceed: a transient 5xx must not degrade into a blind
      // overwrite.
      const reason = (e as DraftFreshnessError).message;
      if (force) {
        return { ok: true, note: `WARNING: force:true — proceeded with ${action} on draft ${draftId} even though its current state could not be read from OurFamilyWizard (${reason}). Any newer server-side version was destroyed and is NOT recoverable from this response.` };
      }
      return {
        ok: false,
        response: jsonErrorResponse({
          error: 'FRESHNESS_CHECK_FAILED',
          draftId,
          reason,
          recovery: 'Nothing was changed. This is usually transient — retry. If it persists, verify the draft on ourfamilywizard.com. Pass force:true only if you accept overwriting a version you have not seen.',
        }),
      };
    }

    const verdict = checkDraftFreshness({ server, cached, expectedRevision });
    if (verdict.verdict === 'FRESH') return { ok: true, note: null };

    if (force) {
      // Loud, and the overwritten content rides along in the response so it is
      // recoverable from the tool result itself.
      console.error(`[ofw-mcp] WARNING: force:true overrode a ${verdict.verdict} verdict on draft ${draftId} (${action}). ${verdict.reason}`);
      const echoed = server === null
        ? 'The draft no longer existed on OurFamilyWizard.'
        : `The server version that was overwritten is preserved below under "overwrittenServerDraft".`;
      return {
        ok: true,
        note: `WARNING: force:true overrode a ${verdict.verdict} freshness verdict on draft ${draftId}. ${verdict.reason} ${echoed}\n\n${JSON.stringify(
          { overwrittenServerDraft: server === null ? null : { ...server, revision: draftRevision(server) } },
          null,
          2,
        )}`,
      };
    }

    return {
      ok: false,
      response: jsonErrorResponse(staleDraftPayload({
        error: verdict.verdict === 'MISSING' ? 'MISSING_DRAFT' : 'STALE_DRAFT',
        draftId,
        verdict,
        server,
        cached,
      })),
    };
  }

  server.registerTool('ofw_list_drafts', {
    description: 'List draft messages from the local OurFamilyWizard cache. Call ofw_sync_messages first if the cache is empty.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      page: z.number().int().min(1).describe('Page number (default 1)').optional(),
      size: z.number().int().min(1).describe('Drafts per page (default 50)').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const cache = cacheProvider();
    const { freshness, serverConfirmed, cacheStatus } = await draftsFreshness(cache);
    const rows = await cache.listDrafts({ page, size });
    // Every draft carries the concurrency token to echo back on a write, plus
    // whether the last sync actually compared this cache against OFW and
    // whether its presence-on-server is confirmed or merely remembered.
    const drafts = rows.map((d) => ({
      ...d,
      revision: draftRevision(d),
      cacheStatus,
      serverConfirmed,
      asOf: freshness.asOf,
    }));

    if (drafts.length === 0) {
      return jsonResponse({
        drafts: [],
        freshness,
        note: 'No drafts in the local cache. That is NOT proof there are no drafts on OurFamilyWizard — call ofw_sync_messages to populate, or ofw_check_freshness to confirm.',
      });
    }
    const payload: Record<string, unknown> = { drafts, freshness };
    if (!serverConfirmed) {
      payload.note = 'serverConfirmed:false — these drafts are remembered from the local cache, NOT confirmed to still exist unsent on OurFamilyWizard right now, and their bodies may be behind the server. Do not state that a draft "is still sitting unsent" on this basis; drafts edited or deleted in the OFW web app bump no timestamp, so the cache cannot detect it on its own. Call ofw_check_freshness (cheap, live) or ofw_sync_messages first. Writes are guarded regardless — ofw_save_draft and ofw_delete_draft re-check the server and refuse a stale overwrite.';
    }
    return jsonResponse(payload);
  });

  if (allowDrafts) server.registerTool('ofw_save_draft', {
    description: 'Save a message as a draft in OurFamilyWizard. Recipients are optional. Pass messageId to replace an existing draft — note that under the hood this creates a NEW draft and deletes the old one (OFW\'s update-in-place endpoint silently no-ops while echoing the posted body, so we don\'t use it); the response.id will be the NEW id, not the messageId you passed, and the change is documented in a transparency NOTE in the response. If replyToId is provided, the cache may rewrite it to the latest reply in the thread (note included in response). Attach files by passing their fileIds (from ofw_upload_attachment) in myFileIDs. After saving, the tool re-fetches the draft from OFW to populate the local cache from authoritative server state. SAFETY: because replacing DESTROYS the old draft rather than merging, passing messageId first re-reads that draft from OFW and REFUSES the write if it changed since you read it (drafts edited in the OFW web app do not bump any timestamp, so the local cache can be silently behind). The refusal returns the current server body under serverBody — merge your edit into it and retry with expectedRevision.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      subject: z.string().describe('Message subject'),
      body: z.string().describe('Message body text'),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (optional for drafts)').optional(),
      messageId: z.number().describe('ID of an existing draft to replace (the new draft will have a new id; the old is deleted)').optional(),
      replyToId: z.number().describe('ID of the message this draft replies to').optional(),
      myFileIDs: z.array(z.number()).describe('Attachment file ids (from ofw_upload_attachment)').optional(),
      expectedRevision: z.string().describe('With messageId: the `revision` you got from ofw_list_drafts/ofw_get_message for that draft. Asserts you are replacing THAT version. If the draft changed on OFW since, the write is refused and the current server body is returned. Omit and the tool compares the server against the local cache instead — omitting never means "overwrite anyway".').optional(),
      force: z.boolean().describe('Default false. Overwrite even when the draft changed on OurFamilyWizard since you read it. The discarded server version is echoed back in the response. Only use after showing the user the conflict.').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();

    // Guard BEFORE the POST: refusing after creating a replacement would leave
    // a stray draft behind for a write we then decline to finish.
    let forceNote: string | null = null;
    if (args.messageId !== undefined) {
      const guard = await guardDestructiveDraftOp({
        cache,
        draftId: args.messageId,
        expectedRevision: args.expectedRevision,
        force: args.force ?? false,
        action: 'replace',
      });
      if (!guard.ok) return guard.response;
      forceNote = guard.note;
    }
    const requestedReplyTo = args.replyToId ?? null;
    let resolvedReplyTo = requestedReplyTo;
    let rewriteNote: string | null = null;

    if (requestedReplyTo !== null) {
      resolvedReplyTo = await cache.findLatestReplyTip(requestedReplyTo);
      if (resolvedReplyTo !== requestedReplyTo) {
        rewriteNote = `replyToId rewritten from ${requestedReplyTo} to ${resolvedReplyTo} (later reply in same thread found in sent cache).`;
      }
    }

    const myFileIDs = args.myFileIDs ?? [];
    // Deliberately do NOT pass `args.messageId` to OFW's POST payload.
    // OFW's update-by-messageId path silently no-ops on subsequent
    // updates while echoing the posted body in the immediate GET — so
    // there is no honest way to detect a failure from the response.
    // We always create a fresh draft; if the caller provided a
    // messageId, we delete the old draft afterward (the "replace" path).
    const payload: Record<string, unknown> = {
      subject: args.subject,
      body: args.body,
      recipientIds: args.recipientIds ?? [],
      attachments: { myFileIDs },
      draft: true,
      includeOriginal: resolvedReplyTo !== null,
      replyToId: resolvedReplyTo,
    };

    const { id: newId, detail, raw } = await postMessageAndRefetch(
      client, payload, SavedDraftDetailSchema, 'ofw_save_draft',
    );

    let persisted: DraftRow | null = null;
    let replaceNote: string | null = null;
    let verifyNote: string | null = null;
    let newRevision: string | null = null;

    if (newId !== null) {
      verifyNote = verifyWriteLanded('draft', { subject: args.subject, body: args.body }, detail);
      persisted = {
        id: newId,
        subject: detail.subject ?? args.subject,
        body: detail.body ?? '',
        recipients: mapRecipients(detail.recipients),
        replyToId: detail.replyToId ?? resolvedReplyTo,
        modifiedAt: detail.date?.dateTime ?? new Date().toISOString(),
        listData: detail,
      };
      await cache.upsertDraft(persisted);
      newRevision = draftRevision(persisted);

      // Replace-path: caller passed messageId, so they want the old draft
      // gone. Delete it after the new one is safely created+cached.
      if (args.messageId !== undefined && args.messageId !== newId) {
        try {
          await deleteOFWMessages(client, [args.messageId]);
          await cache.deleteDraft(args.messageId);
          replaceNote = `NOTE: ofw_save_draft replaced draft ${args.messageId} via create-then-delete. The new draft id is ${newId}; the old draft has been deleted. (OFW's update-in-place endpoint silently no-ops on subsequent updates, so we never use it. If you cached the old id anywhere, replace it with the new one.)`;
        } catch (e) {
          // Partial-failure safety: the new draft is already created and
          // cached, so BOTH drafts now exist. That is the correct end state —
          // deleting first and failing to create would have lost the content.
          replaceNote = `WARNING: New draft ${newId} was created successfully, but the old draft ${args.messageId} could NOT be deleted: ${(e as Error).message}. BOTH drafts now exist on OurFamilyWizard and nothing was lost. Verify ${newId} reads correctly, then remove ${args.messageId} with ofw_delete_draft.`;
        }
      }
    }

    // The draft was just re-fetched from OFW by postMessageAndRefetch, so this
    // one row IS server-confirmed regardless of the drafts folder's overall
    // cache freshness.
    const responseObj = persisted !== null
      ? { ...persisted, revision: newRevision, cacheStatus: 'fresh', serverConfirmed: true }
      : raw;
    const text = responseObj ? JSON.stringify(responseObj, null, 2) : 'Draft saved.';
    const notes = [forceNote, rewriteNote, verifyNote, replaceNote].filter((n): n is string => n !== null).join('\n\n');
    return textResponse(notes ? `${notes}\n\n${text}` : text);
  });

  if (allowDrafts) server.registerTool('ofw_delete_draft', {
    description: 'Delete a draft message from OurFamilyWizard. Also removes the draft from the local cache. Before deleting, the draft is re-read from OFW and the delete is REFUSED if it changed since you last read it (the current server body is returned so nothing is lost) — pass expectedRevision to assert which version you mean, or force:true to delete regardless.',
    annotations: { destructiveHint: true },
    inputSchema: {
      messageId: z.number().describe('Draft message ID to delete'),
      expectedRevision: z.string().describe('The `revision` you got from ofw_list_drafts/ofw_get_message. Asserts you are deleting THAT version; if the draft changed on OFW since, the delete is refused and the current server body returned.').optional(),
      force: z.boolean().describe('Default false. Delete even if the draft changed on OurFamilyWizard since you read it. The discarded server version is echoed back in the response.').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();
    const guard = await guardDestructiveDraftOp({
      cache,
      draftId: args.messageId,
      expectedRevision: args.expectedRevision,
      force: args.force ?? false,
      action: 'delete',
    });
    if (!guard.ok) return guard.response;

    const data = await deleteOFWMessages(client, [args.messageId]);
    await cache.deleteDraft(args.messageId);
    const text = data ? JSON.stringify(data, null, 2) : 'Draft deleted.';
    return textResponse(guard.note ? `${guard.note}\n\n${text}` : text);
  });

  server.registerTool('ofw_get_unread_sent', {
    description: 'List sent messages that have not been read by one or more recipients. Reads from local cache; call ofw_sync_messages first if cache is stale.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      page: z.number().int().min(1).describe('Page (default 1)').optional(),
      size: z.number().int().min(1).describe('Per page (default 50)').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const cache = cacheProvider();
    const sent = await cache.listMessages({ folder: 'sent', page, size });
    // "Nobody has read it yet" is a present-tense claim drawn entirely from
    // cached view timestamps, which only move when a sync refreshes them —
    // so it needs the same age label as any other cached read.
    const freshness = await buildFreshness(cache, { source: 'cache', folders: ['sent'] });

    if (sent.length === 0) {
      return jsonResponse({
        unread: [],
        freshness,
        note: 'Sent cache is empty. Call ofw_sync_messages to populate. An empty cache is NOT evidence that no sent messages exist.',
      });
    }

    const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
    for (const msg of sent) {
      const unreadBy = msg.recipients.filter((r) => r.viewedAt === null).map((r) => r.name);
      if (unreadBy.length > 0) {
        unread.push({ id: msg.id, subject: msg.subject, sentAt: msg.sentAt, unreadBy });
      }
    }

    if (unread.length === 0) {
      return jsonResponse({
        unread: [],
        freshness,
        message: 'All scanned sent messages had been read as of the timestamp in `freshness.asOf`. A recipient may have read a message since without the cache hearing about it.',
      });
    }
    return jsonResponse({ unread, freshness });
  });

  if (allowDrafts) server.registerTool('ofw_upload_attachment', {
    description: 'Upload a local file to OurFamilyWizard\'s "My Files" so it can be attached to a message. Returns the fileId — pass that to ofw_send_message or ofw_save_draft in myFileIDs to attach it. The file is uploaded as PRIVATE (visible only to you) by default; pass shareClass:"SHARED" to share with co-parents directly via the My Files area.',
    annotations: { destructiveHint: false },
    inputSchema: {
      path: z.string().describe('Absolute path to the local file to upload. Tilde (~) is expanded.'),
      shareClass: z.enum(['PRIVATE', 'SHARED']).describe('Share class (default PRIVATE)').optional(),
      label: z.string().describe('Display label for the file in OFW (default: filename)').optional(),
      description: z.string().describe('Description shown in OFW My Files (default: filename)').optional(),
    },
  }, async (args) => {
    // Resolve the upload source through the injected attachment-I/O boundary
    // (disk read on node; an in-memory source on the hosted connector).
    const { blob, fileName, mimeType: mime, sizeBytes } = await attachmentIO.resolveUpload(args.path);

    // Build the multipart payload matching the OFW web UI's request shape.
    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('source', 'message');
    form.append('description', args.description ?? fileName);
    form.append('label', args.label ?? fileName);
    form.append('fileName', fileName);
    form.append('shareClass', args.shareClass ?? 'PRIVATE');

    const meta = parseLenient(
      UploadedFileSchema,
      await client.request('POST', '/pub/v3/myfiles/multipart', form),
      { label: 'ofw-mcp', context: 'POST /pub/v3/myfiles/multipart (ofw_upload_attachment)', mode: 'strict' },
    );

    // Cache metadata so subsequent ofw_get_message calls can surface it and
    // ofw_download_attachment can short-circuit. messageId is 0 (the
    // not-yet-linked sentinel) until a message actually references this file.
    await cacheProvider().upsertAttachmentForMessage({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      label: meta.label ?? args.label ?? fileName,
      mimeType: meta.fileType ?? mime,
      sizeBytes: typeof meta.sizeInBytes === 'number' ? meta.sizeInBytes : sizeBytes,
      metadata: meta,
      messageId: 0,
    });

    return jsonResponse({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      mimeType: meta.fileType ?? mime,
      sizeBytes: meta.sizeInBytes ?? sizeBytes,
      shareClass: meta.shareClass ?? args.shareClass ?? 'PRIVATE',
      note: 'Pass this fileId to ofw_send_message or ofw_save_draft in myFileIDs to attach it.',
    });
  });

  server.registerTool('ofw_download_attachment', {
    description: 'Download an OFW message attachment by fileId. By default, bytes are saved to disk (~/Downloads/ofw-mcp/) and the response carries the absolute path, mime type, and size for the caller to read back. Pass inline:true to skip disk entirely and return the bytes as MCP content blocks — host-renderable images (PNG/JPEG/GIF/WEBP) come back as ImageContent (the model sees them directly); every other file comes back as an EmbeddedResource blob carrying the bytes. Reported mime types are always normalized to a bare media type (no charset/name parameters). Use inline for small files where you want the model to read content immediately and the host is sandboxed; use disk for large files or when you want a persistent local copy. The default for `inline` can be flipped server-side via the OFW_INLINE_ATTACHMENTS env var (set to "true" to make inline the default). On a hosted deployment with no filesystem, disk mode is unavailable, so inline is forced (the response is marked forcedInline:true) rather than failing. fileId comes from attachments[].fileId on ofw_get_message. Override disk destination with OFW_ATTACHMENTS_DIR or saveTo. Re-downloading to the same path is a no-op (disk mode only).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      fileId: z.number().describe('Attachment file id (from ofw_get_message → attachments[].fileId)'),
      inline: z.boolean().describe('If true, return bytes inline as MCP content (ImageContent for host-renderable images, embedded resource blob otherwise) and skip the disk write. If false, write to disk and return the path — except on a hosted deployment with no filesystem, where inline is forced (forcedInline:true) so the bytes are still returned. If omitted, falls back to the OFW_INLINE_ATTACHMENTS env var (default: false = disk).').optional(),
      saveTo: z.string().describe('Absolute path or directory to write to. If a directory, the OFW filename is used. Default: ~/Downloads/ofw-mcp/<fileId>-<filename>. Ignored when inline is in effect.').optional(),
      force: z.boolean().describe('Re-download even if already on disk. Default false. Ignored when inline:true (inline always fetches fresh bytes, or reuses an on-disk copy if present).').optional(),
    },
  }, async (args) => {
    const fileId = args.fileId;
    const cache = cacheProvider();
    const requestedInline = args.inline ?? getDefaultInlineAttachments();
    // When the deployment has no filesystem (hosted connector), inline is the
    // ONLY path to the bytes — force it rather than erroring on a disk write.
    // `forcedInline` records that we overrode an explicit `inline:false` so the
    // response is honest about it instead of silently ignoring the argument.
    const inline = requestedInline || !attachmentIO.supportsDisk;
    const forcedInline = inline && !requestedInline;
    let cached = await cache.getAttachment(fileId);
    if (!cached) {
      // Not in cache. Fetch metadata and store under the messageId=0
      // sentinel — gets re-linked if a message later references this file.
      await fetchAttachmentMeta(client, fileId, 0, cache);
      cached = await cache.getAttachment(fileId);
      /* v8 ignore next -- fetchAttachmentMeta persists the row it just fetched; a still-null read here is an unreachable storage failure */
      if (!cached) throw new Error(`failed to fetch metadata for fileId ${fileId}`);
    }

    if (inline) {
      // Reuse on-disk bytes if we already have them; otherwise fetch fresh.
      let bytes: Buffer | null = null;
      let headerMime: string | null = cached.mimeType;
      let fileName = cached.fileName;
      if (cached.downloadedPath) {
        bytes = attachmentIO.readDownloaded(cached.downloadedPath);
      }
      if (bytes === null) {
        const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
        bytes = response.body;
        headerMime = response.contentType ?? cached.mimeType;
        fileName = response.suggestedFileName ?? cached.fileName;
      }
      // Normalize to a bare media type: sniff the bytes first (OFW tacks a bogus
      // charset onto binaries), then fall back to the stripped header, then the
      // extension. A parameter suffix would make the host reject an image.
      const mimeType = resolveDownloadMime(bytes, headerMime, fileName);
      const base64 = bytes.toString('base64');
      const meta: Record<string, unknown> = {
        fileId, fileName, mimeType, sizeBytes: bytes.length, mode: 'inline',
      };
      if (forcedInline) meta.forcedInline = true;
      const metaBlock = { type: 'text' as const, text: JSON.stringify(meta, null, 2) };
      // Only host-renderable image types go back as ImageContent (with the bare
      // media type the renderer accepts); everything else — non-renderable
      // images included — goes back as an EmbeddedResource so the caller always
      // gets the bytes.
      if (isHostRenderableImage(mimeType)) {
        return { content: [metaBlock, { type: 'image' as const, data: base64, mimeType }] };
      }
      return { content: [metaBlock, { type: 'resource' as const, resource: {
        uri: `ofw://attachment/${fileId}/${encodeURIComponent(fileName)}`,
        mimeType,
        blob: base64,
      } }] };
    }

    let dest: string;
    // The filename comes from OFW file metadata — i.e. it is controlled by the
    // co-parent who uploaded the attachment. basename() it before interpolating
    // into a path so a crafted `../…` name can't escape the target directory
    // (the upload path at :549 already applies basename to its input).
    const safeName = basename(cached.fileName);
    if (args.saveTo) {
      // Treat saveTo as a directory if it ends with a separator; otherwise as a full path.
      const isDirArg = args.saveTo.endsWith('/') || args.saveTo.endsWith('\\');
      const abs = expandPath(args.saveTo);
      dest = isDirArg ? join(abs, `${fileId}-${safeName}`) : abs;
    } else {
      dest = join(getAttachmentsDir(), `${fileId}-${safeName}`);
    }

    if (!args.force && cached.downloadedPath === dest) {
      return jsonResponse({
        // No bytes on hand for the no-op case: normalize the cached/extension
        // MIME (empty buffer sniffs nothing) so a stored `image/png;charset=…`
        // still reports bare.
        fileId, path: dest, mimeType: resolveDownloadMime(Buffer.alloc(0), cached.mimeType, cached.fileName),
        sizeBytes: cached.sizeBytes, fileName: cached.fileName, note: 'already downloaded',
      });
    }

    const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
    attachmentIO.writeDownload(dest, response.body);
    await cache.markAttachmentDownloaded(fileId, dest);

    const fileName = response.suggestedFileName ?? cached.fileName;
    return jsonResponse({
      fileId,
      path: dest,
      mimeType: resolveDownloadMime(response.body, response.contentType ?? cached.mimeType, fileName),
      sizeBytes: response.body.length,
      fileName,
    });
  });

  server.registerTool('ofw_sync_messages', {
    description: 'Sync messages from OurFamilyWizard into the local cache. Returns counts per folder and a list of unread inbox messages whose bodies were NOT fetched (to avoid mark-as-read on OFW). Call ofw_get_message(id) on those to read them. EVERY call re-checks the newest page first, so new messages are picked up promptly even while an old-history backfill is still running; only then does it spend what is left of its budget advancing that backfill. Pass deep:true to walk all OFW pages instead of stopping at the first all-cached page (use to backfill suspected gaps). Sync is BOUNDED and RESUMABLE: on hosted deployments a per-call OFW-request budget (env OFW_SYNC_MAX_REQUESTS, or the maxRequests argument) caps how far one call walks; when the budget is hit the response reports done:false with a note — call again with the SAME arguments to resume. done:false means older history is still being backfilled; it does NOT mean recent messages are missing. Local installs are unbounded by default (done is always true).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      folders: z.array(z.enum(['inbox', 'sent', 'drafts'])).min(1).describe('Folders to sync (default: all three). Must be non-empty if given — an empty list would sync nothing while reporting success.').optional(),
      fetchUnreadBodies: z.boolean().describe('If true, also fetch bodies for unread inbox messages (will mark them as read on OFW). Default false.').optional(),
      deep: z.boolean().describe('If true, walk every OFW page until empty regardless of cache state. Use to backfill gaps. Default false.').optional(),
      maxRequests: z.number().int().min(1).describe('Maximum OFW requests this single call may make before pausing. When hit, the response reports done:false — call again with the same arguments to continue. Omit to use the server default (OFW_SYNC_MAX_REQUESTS, or unbounded on local installs).').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();
    const result = await syncAll(client, {
      folders: args.folders,
      fetchUnreadBodies: args.fetchUnreadBodies,
      deep: args.deep,
      maxRequests: args.maxRequests ?? getSyncMaxRequests(),
    }, cache);
    // Freshness of the cache AS OF this sync completing — so a paused call
    // that skipped a folder says so here too, not just in `notRefreshed`.
    const freshness = await buildFreshness(cache, {
      source: 'cache',
      folders: args.folders ?? ['inbox', 'sent', 'drafts'],
    });
    return jsonResponse({ ...result, freshness });
  });

  server.registerTool('ofw_check_freshness', {
    description: 'Cheaply confirm whether the local cache still matches OurFamilyWizard, WITHOUT running a full sync. Use this before asserting anything about current state — especially "draft X is still sitting unsent" — when a read returned serverConfirmed:false or freshness.staleness other than "fresh". Costs one OFW request for the folder check plus one per messageId. For each folder it returns the live server count next to the cached count; for each id, whether it still exists on OFW and whether its content matches the cache (compared by content revision, because OFW draft timestamps do NOT change when a draft is edited in the web app). Does not fetch bodies into the cache, does not touch attachments, and does not depend on sync state.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      folders: z.array(z.enum(['inbox', 'sent', 'drafts'])).min(1).describe('Folders to compare cached vs live counts for. Defaults to all three when messageIds is not given. Must be non-empty if given.').optional(),
      messageIds: z.array(z.number()).describe(`Specific ids to verify against OFW (max ${MAX_FRESHNESS_IDS}). By default only ids present in the drafts cache are probed — see allowMarkRead.`).optional(),
      allowMarkRead: z.boolean().describe('Default false. Probing an id that is NOT a cached draft requires fetching its detail, which marks an unread inbox message as READ on OurFamilyWizard — an irreversible change to the record. Such ids are skipped unless you set this to true.').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();
    const allowMarkRead = args.allowMarkRead ?? false;
    const requestedIds = args.messageIds ?? [];
    const ids = requestedIds.slice(0, MAX_FRESHNESS_IDS);
    // Folders default to "all three" only when the caller asked about nothing
    // else; an ids-only call shouldn't silently spend a request on folders.
    const wantFolders: FolderName[] = args.folders
      ?? (requestedIds.length > 0 ? [] : ['inbox', 'sent', 'drafts']);

    let requestsUsed = 0;
    const folders: Array<Record<string, unknown>> = [];

    if (wantFolders.length > 0) {
      requestsUsed++;
      const data = parseLenient(
        FolderCountsSchema,
        await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true'),
        { label: 'ofw-mcp', context: 'GET /pub/v1/messageFolders (ofw_check_freshness)' },
      );
      const sys = data.systemFolders ?? [];
      for (const folder of wantFolders) {
        const entry = sys.find((x) => x.folderType === FOLDER_TYPE[folder]);
        const serverCount = entry?.totalCount ?? entry?.messageCount ?? entry?.count ?? null;
        const cachedCount = folder === 'drafts'
          ? (await cache.listDraftIds()).length
          : await cache.countMessages({ folder });
        const state = await cache.getSyncState(folder);
        const historyComplete = state !== null && state.resumePage === null;
        // A partially backfilled folder legitimately holds fewer messages than
        // the server, so a count mismatch there proves nothing. Report both
        // numbers and leave the verdict null rather than crying wolf for the
        // entire duration of a backfill.
        const inSync = serverCount === null || !historyComplete
          ? null
          : serverCount === cachedCount;
        folders.push({
          folder,
          existsOnServer: entry !== undefined,
          serverCount,
          cachedCount,
          historyComplete,
          lastVerifiedAt: await getFolderVerifiedAt(cache, folder),
          inSync,
          ...(inSync === null
            ? { note: serverCount === null
              ? 'OFW did not report a count for this folder, so cached-vs-server cannot be compared. Use the per-id check instead.'
              : 'Older history is still being backfilled, so a lower cachedCount is expected and does not indicate drift.' }
            : {}),
        });
      }
    }

    const items: Array<Record<string, unknown>> = [];
    for (const id of ids) {
      const cachedDraft = await cache.getDraft(id);
      // Drafts have no read state, so probing one is genuinely side-effect
      // free. Any other id means GET /pub/v3/messages/{id}, which marks an
      // unread inbox message read on OFW — a permanent change to a
      // court-visible record. Refuse by default rather than quietly doing it.
      if (cachedDraft === null && !allowMarkRead) {
        items.push({
          id,
          skipped: true,
          reason: 'NOT_A_CACHED_DRAFT',
          note: 'Not in the drafts cache. Verifying it requires fetching its detail from OFW, which would mark an unread inbox message as READ on OurFamilyWizard. Pass allowMarkRead:true if that is acceptable.',
        });
        continue;
      }
      requestsUsed++;
      try {
        const server = await fetchServerDraft(client, id);
        const cacheRevision = cachedDraft === null ? null : draftRevision(cachedDraft);
        if (server === null) {
          items.push({
            id,
            existsOnServer: false,
            inSync: false,
            cacheRevision,
            serverRevision: null,
            note: cachedDraft === null
              ? 'Not found on OurFamilyWizard.'
              : 'This draft is in the local cache but NO LONGER EXISTS on OurFamilyWizard — it was sent or deleted elsewhere. Do not describe it as still unsent.',
          });
          continue;
        }
        const serverRevision = draftRevision(server);
        items.push({
          id,
          existsOnServer: true,
          cacheRevision,
          serverRevision,
          inSync: cacheRevision !== null && cacheRevision === serverRevision,
          ...(cacheRevision === null
            ? { note: 'Exists on OurFamilyWizard but is not in the local cache.' }
            : cacheRevision !== serverRevision
              ? { note: 'Content differs from the cache — it was edited on OurFamilyWizard since the last sync. Run ofw_sync_messages before reading or writing it.' }
              : {}),
        });
      } catch (e) {
        // A check that could not run must not read as "in sync".
        items.push({
          id,
          error: 'FRESHNESS_CHECK_FAILED',
          message: (e as Error).message,
          inSync: null,
          note: 'The freshness check itself failed, so nothing is confirmed either way.',
        });
      }
    }

    const payload: Record<string, unknown> = {
      checkedAt: new Date().toISOString(),
      requestsUsed,
      ...(folders.length > 0 ? { folders } : {}),
      ...(items.length > 0 ? { items } : {}),
    };
    if (requestedIds.length > ids.length) {
      payload.note = `Only the first ${MAX_FRESHNESS_IDS} of ${requestedIds.length} messageIds were checked (per-call cap). The remaining ${requestedIds.length - ids.length} were NOT verified — call again with the rest.`;
    }
    return jsonResponse(payload);
  });
}

// OFW's bulk-delete endpoint takes a multipart form with `messageIds`.
// Used by both ofw_delete_draft and ofw_send_message (draft cleanup).
async function deleteOFWMessages(client: OFWClient, ids: number[]): Promise<unknown> {
  const form = new FormData();
  for (const id of ids) form.append('messageIds', String(id));
  return client.request('DELETE', '/pub/v1/messages', form);
}
