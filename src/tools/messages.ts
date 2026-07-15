import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { syncAll, fetchAttachmentMeta, fetchAttachmentMetaForMessage } from '../sync.js';
import type { CacheStore, MessageRow, DraftRow } from '../cache/store.js';
import type { AttachmentIO } from './attachments.js';
import { getAttachmentsDir, getDefaultInlineAttachments, getSyncMaxRequests, getWriteMode } from '../config.js';
import { basename, join } from 'node:path';
import { ApiRecipientSchema, expandPath, hasRealView, jsonResponse, mapRecipients, postMessageAndRefetch, textResponse, verifyWriteLanded } from './_shared.js';
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
    description: 'List OurFamilyWizard message folders (inbox, sent, etc.) and their unread counts. Returns folder IDs needed to call ofw_list_messages. Does NOT return message content.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    return jsonResponse(data);
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
      return jsonResponse({
        messages: [],
        note: 'folderId must be "inbox", "sent", or "both". Numeric OFW folder IDs are not supported by the cache.',
      });
    }

    const cache = cacheProvider();
    const filter = { folder, since: args.since, until: args.until, q: args.q };
    const total = await cache.countMessages(filter);
    const messages = await cache.listMessages({ ...filter, page, size });

    const payload: Record<string, unknown> = { messages, total, page, size };
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
      return jsonResponse({ ...row, attachments });
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
    return jsonResponse({ ...row, attachments });
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
    const drafts = await cacheProvider().listDrafts({ page, size });
    const payload = drafts.length === 0
      ? { drafts: [], note: 'Cache empty. Call ofw_sync_messages to populate.' }
      : { drafts };
    return jsonResponse(payload);
  });

  if (allowDrafts) server.registerTool('ofw_save_draft', {
    description: 'Save a message as a draft in OurFamilyWizard. Recipients are optional. Pass messageId to replace an existing draft — note that under the hood this creates a NEW draft and deletes the old one (OFW\'s update-in-place endpoint silently no-ops while echoing the posted body, so we don\'t use it); the response.id will be the NEW id, not the messageId you passed, and the change is documented in a transparency NOTE in the response. If replyToId is provided, the cache may rewrite it to the latest reply in the thread (note included in response). Attach files by passing their fileIds (from ofw_upload_attachment) in myFileIDs. After saving, the tool re-fetches the draft from OFW to populate the local cache from authoritative server state.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      subject: z.string().describe('Message subject'),
      body: z.string().describe('Message body text'),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (optional for drafts)').optional(),
      messageId: z.number().describe('ID of an existing draft to replace (the new draft will have a new id; the old is deleted)').optional(),
      replyToId: z.number().describe('ID of the message this draft replies to').optional(),
      myFileIDs: z.array(z.number()).describe('Attachment file ids (from ofw_upload_attachment)').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();
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

      // Replace-path: caller passed messageId, so they want the old draft
      // gone. Delete it after the new one is safely created+cached.
      if (args.messageId !== undefined && args.messageId !== newId) {
        try {
          await deleteOFWMessages(client, [args.messageId]);
          await cache.deleteDraft(args.messageId);
          replaceNote = `NOTE: ofw_save_draft replaced draft ${args.messageId} via create-then-delete. The new draft id is ${newId}; the old draft has been deleted. (OFW's update-in-place endpoint silently no-ops on subsequent updates, so we never use it. If you cached the old id anywhere, replace it with the new one.)`;
        } catch (e) {
          replaceNote = `WARNING: New draft ${newId} created successfully, but failed to delete the old draft (${args.messageId}): ${(e as Error).message}. You may want to clean it up manually with ofw_delete_draft.`;
        }
      }
    }

    const responseObj = persisted ?? raw;
    const text = responseObj ? JSON.stringify(responseObj, null, 2) : 'Draft saved.';
    const notes = [rewriteNote, verifyNote, replaceNote].filter((n): n is string => n !== null).join('\n\n');
    return textResponse(notes ? `${notes}\n\n${text}` : text);
  });

  if (allowDrafts) server.registerTool('ofw_delete_draft', {
    description: 'Delete a draft message from OurFamilyWizard. Also removes the draft from the local cache.',
    annotations: { destructiveHint: true },
    inputSchema: {
      messageId: z.number().describe('Draft message ID to delete'),
    },
  }, async (args) => {
    const data = await deleteOFWMessages(client, [args.messageId]);
    await cacheProvider().deleteDraft(args.messageId);
    return data ? jsonResponse(data) : textResponse('Draft deleted.');
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
    const sent = await cacheProvider().listMessages({ folder: 'sent', page, size });

    if (sent.length === 0) {
      return jsonResponse({ note: 'Sent cache is empty. Call ofw_sync_messages to populate.' });
    }

    const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
    for (const msg of sent) {
      const unreadBy = msg.recipients.filter((r) => r.viewedAt === null).map((r) => r.name);
      if (unreadBy.length > 0) {
        unread.push({ id: msg.id, subject: msg.subject, sentAt: msg.sentAt, unreadBy });
      }
    }

    if (unread.length === 0) {
      return jsonResponse({ message: 'All scanned sent messages have been read.' });
    }
    return jsonResponse(unread);
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
    description: 'Download an OFW message attachment by fileId. By default, bytes are saved to disk (~/Downloads/ofw-mcp/) and the response carries the absolute path, mime type, and size for the caller to read back. Pass inline:true to skip disk entirely and return the bytes as MCP content blocks — images come back as ImageContent (the model sees them directly); other files come back as an EmbeddedResource blob. Use inline for small files where you want the model to read content immediately and the host is sandboxed; use disk for large files or when you want a persistent local copy. The default for `inline` can be flipped server-side via the OFW_INLINE_ATTACHMENTS env var (set to "true" to make inline the default). fileId comes from attachments[].fileId on ofw_get_message. Override disk destination with OFW_ATTACHMENTS_DIR or saveTo. Re-downloading to the same path is a no-op (disk mode only).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      fileId: z.number().describe('Attachment file id (from ofw_get_message → attachments[].fileId)'),
      inline: z.boolean().describe('If true, return bytes inline as MCP content (image for image/*, embedded resource blob otherwise) and skip the disk write. If false, write to disk and return the path. If omitted, falls back to the OFW_INLINE_ATTACHMENTS env var (default: false = disk).').optional(),
      saveTo: z.string().describe('Absolute path or directory to write to. If a directory, the OFW filename is used. Default: ~/Downloads/ofw-mcp/<fileId>-<filename>. Ignored when inline:true.').optional(),
      force: z.boolean().describe('Re-download even if already on disk. Default false. Ignored when inline:true (inline always fetches fresh bytes, or reuses an on-disk copy if present).').optional(),
    },
  }, async (args) => {
    const fileId = args.fileId;
    const cache = cacheProvider();
    const inline = args.inline ?? getDefaultInlineAttachments();
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
      let mimeType = cached.mimeType;
      let fileName = cached.fileName;
      if (cached.downloadedPath) {
        bytes = attachmentIO.readDownloaded(cached.downloadedPath);
      }
      if (bytes === null) {
        const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
        bytes = response.body;
        mimeType = response.contentType ?? cached.mimeType;
        fileName = response.suggestedFileName ?? cached.fileName;
      }
      const base64 = bytes.toString('base64');
      const metaBlock = { type: 'text' as const, text: JSON.stringify({
        fileId, fileName, mimeType, sizeBytes: bytes.length, mode: 'inline',
      }, null, 2) };
      if (mimeType.startsWith('image/')) {
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
        fileId, path: dest, mimeType: cached.mimeType, sizeBytes: cached.sizeBytes,
        fileName: cached.fileName, note: 'already downloaded',
      });
    }

    const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
    attachmentIO.writeDownload(dest, response.body);
    await cache.markAttachmentDownloaded(fileId, dest);

    return jsonResponse({
      fileId,
      path: dest,
      mimeType: response.contentType ?? cached.mimeType,
      sizeBytes: response.body.length,
      fileName: response.suggestedFileName ?? cached.fileName,
    });
  });

  server.registerTool('ofw_sync_messages', {
    description: 'Sync messages from OurFamilyWizard into the local cache. Returns counts per folder and a list of unread inbox messages whose bodies were NOT fetched (to avoid mark-as-read on OFW). Call ofw_get_message(id) on those to read them. Pass deep:true to walk all OFW pages instead of stopping at the first all-cached page (use to backfill suspected gaps). Sync is BOUNDED and RESUMABLE: on hosted deployments a per-call OFW-request budget (env OFW_SYNC_MAX_REQUESTS, or the maxRequests argument) caps how far one call walks; when the budget is hit the response reports done:false with a note — call again with the SAME arguments to resume where it left off and continue the backfill. Local installs are unbounded by default (done is always true).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      folders: z.array(z.enum(['inbox', 'sent', 'drafts'])).describe('Folders to sync (default: all three)').optional(),
      fetchUnreadBodies: z.boolean().describe('If true, also fetch bodies for unread inbox messages (will mark them as read on OFW). Default false.').optional(),
      deep: z.boolean().describe('If true, walk every OFW page until empty regardless of cache state. Use to backfill gaps. Default false.').optional(),
      maxRequests: z.number().int().min(1).describe('Maximum OFW requests this single call may make before pausing. When hit, the response reports done:false — call again with the same arguments to continue. Omit to use the server default (OFW_SYNC_MAX_REQUESTS, or unbounded on local installs).').optional(),
    },
  }, async (args) => {
    const result = await syncAll(client, {
      folders: args.folders,
      fetchUnreadBodies: args.fetchUnreadBodies,
      deep: args.deep,
      maxRequests: args.maxRequests ?? getSyncMaxRequests(),
    }, cacheProvider());
    return jsonResponse(result);
  });
}

// OFW's bulk-delete endpoint takes a multipart form with `messageIds`.
// Used by both ofw_delete_draft and ofw_send_message (draft cleanup).
async function deleteOFWMessages(client: OFWClient, ids: number[]): Promise<unknown> {
  const form = new FormData();
  for (const id of ids) form.append('messageIds', String(id));
  return client.request('DELETE', '/pub/v1/messages', form);
}
