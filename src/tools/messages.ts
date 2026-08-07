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
import { FOLDER_TYPE, newDraftKey, persistFolderIds, probeIds, resolveDraftKey } from './lifecycle.js';
import type { LifecycleItem } from './lifecycle.js';
import type { CacheStore, MessageRow, DraftRow, FolderName } from '../cache/store.js';
import { getFolderVerifiedAt } from '../sync.js';
import type { AttachmentIO } from './attachments.js';
import { buildInlineDelivery, tryExtract } from './delivery.js';
import { resolveDownloadMime } from './attachments.js';
import {
  getAllowMarkRead, getAttachmentsDir, getAutoRefreshStaleReads, getDefaultInlineAttachments,
  getFetchUnreadBodies, getSyncMaxRequests, getWriteMode,
} from '../config.js';
import { basename, join } from 'node:path';
import { ApiRecipientSchema, deriveRead, expandPath, hasRealView, jsonErrorResponse, jsonResponse, mapRecipients, postMessageAndRefetch, reportsThreaded, reportsUnthreaded, textResponse, threadedReplyTo, verifyWriteLanded, withReadState } from './_shared.js';
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
  // The threading echo, in BOTH spellings plus showContext — OFW reports the
  // reply target inconsistently across payloads (see ThreadingEcho in
  // _shared.ts). Backs the `threaded` verdict on ofw_send_message.
  replyToId: z.number().nullable().optional(),
  inReplyTo: z.number().nullable().optional(),
  showContext: z.boolean().optional(),
});
const SavedDraftDetailSchema = z.looseObject({
  subject: z.string().optional(),
  body: z.string().optional(),
  date: DateSchema.optional(),
  // All three threading-echo fields. Reading ONLY `replyToId` here fired a
  // false "OurFamilyWizard did not thread this draft" warning on nearly every
  // threaded save, while the same payload's `inReplyTo`/`showContext` showed
  // the draft WAS threaded — see threadedReplyTo in _shared.ts.
  replyToId: z.number().nullable().optional(),
  inReplyTo: z.number().nullable().optional(),
  showContext: z.boolean().optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
  // Read to audit whether requested myFileIDs actually attached (Defect 3).
  files: z.array(z.number()).optional(),
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
  // Same union as ServerDraftSchema's, for the same reason — OFW types this id
  // as a string on the folders listing and a number on message detail. Lenient
  // here, so a mismatch only warns, but it would warn on EVERY live fetch.
  folder: z.looseObject({ id: z.union([z.string(), z.number()]) }).optional(),
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

/**
 * Description shared by every read tool's `autoRefresh` argument, so the escape
 * hatch from an UNVERIFIED_EMPTY refusal reads identically wherever it appears.
 */
const AUTO_REFRESH_DESC = 'If the result comes back EMPTY from a cache that is not verified-fresh, sync the backing folders first and answer from the refreshed cache instead of refusing. Defaults to the OFW_AUTO_REFRESH env var (false unless set), in which case the call refuses with result:"UNVERIFIED_EMPTY" and names the remedy. Costs OFW requests when it fires.';

/**
 * Run a cached read, and never let it answer "nothing there" on the strength of
 * a cache that cannot vouch for itself.
 *
 * The failure this closes: an empty result set carrying a 207-minute-old
 * `freshness` block is shaped IDENTICALLY to a verified "nothing matched". Skim
 * past the warning and the natural next sentence is "no, that message was never
 * sent" — a false negative stated as fact about a court-visible record. A false
 * negative is more dangerous than a refusal precisely because it reads as a
 * definitive answer, so the bias is: refuse, and say how to get a real one.
 *
 * `autoRefresh` turns the refusal into a sync-then-retry. If that still cannot
 * make the read verifiable (the budget paused, OFW was unreachable), the refusal
 * fires anyway — a refresh that did not work must not be treated as one that did.
 *
 * Non-empty results are never touched: a stale cache that DID find something is
 * evidence of presence, and its `freshness` block already labels its age.
 */
async function guardedCacheRead<T extends { freshness: FreshnessBlock }>(o: {
  client: OFWClient;
  cache: CacheStore;
  folders: FolderName[];
  autoRefresh: boolean;
  read: () => Promise<T>;
  /**
   * Whether this read found NOTHING AT ALL — a claim of absence. Deliberately
   * the total, not the returned slice: page 9 of a 2-page result is an empty
   * array, but "there are no drafts" would be a lie about it. That case is
   * covered by `complete`, not by a refusal.
   */
  isEmpty: (value: T) => boolean;
}): Promise<{ value: T; refreshed: boolean; unverifiedEmpty: boolean }> {
  let value = await o.read();
  let refreshed = false;
  const unverifiable = (v: T): boolean => o.isEmpty(v) && v.freshness.staleness !== 'fresh';

  if (unverifiable(value) && o.autoRefresh) {
    await syncAll(o.client, {
      folders: o.folders,
      // Same ceiling ofw_sync_messages applies: an automatic refresh must never
      // stamp unread inbox messages as a side effect of a list read.
      fetchUnreadBodies: getAllowMarkRead() && getFetchUnreadBodies(),
      maxRequests: getSyncMaxRequests(),
    }, o.cache);
    refreshed = true;
    value = await o.read();
  }

  return { value, refreshed, unverifiedEmpty: unverifiable(value) };
}

/** The structured non-result returned instead of an unverifiable empty list. */
function unverifiedEmptyResponse(input: {
  what: string;
  freshness: FreshnessBlock;
  remedy: string;
  refreshed: boolean;
  extra?: Record<string, unknown>;
}): ReturnType<typeof jsonErrorResponse> {
  const { freshness } = input;
  const age = freshness.ageSeconds === null
    ? 'it has never been checked against OurFamilyWizard'
    : `it was last verified ${freshness.ageSeconds < 60 ? `${freshness.ageSeconds} sec` : `${Math.round(freshness.ageSeconds / 60)} min`} ago`;
  const refreshClause = input.refreshed
    ? ' An automatic refresh ran on this call and did NOT make the result verifiable (the sync paused or skipped this folder), so the refusal stands.'
    : '';
  return jsonErrorResponse({
    result: 'UNVERIFIED_EMPTY',
    reason: `No ${input.what} were found, but the backing cache is "${freshness.staleness}" — ${age}. Refusing to report absence from unverified data: an empty result from a stale cache is indistinguishable from a verified "nothing there", and repeating it as one asserts a false negative about a legal record.${refreshClause}`,
    remedy: input.remedy,
    complete: false,
    freshness,
    ...input.extra,
  });
}

/**
 * Decide whether fetching this message's body from OFW would stamp the record,
 * and refuse when the caller (or the deployment) has opted out of that.
 *
 * Returns null to proceed, or a structured refusal to return as-is.
 *
 * Only ONE case actually stamps: fetching the body of an UNREAD INBOX message.
 * Everything else is waved through, because refusing a read that changes
 * nothing would be friction with no safety to show for it:
 *   - a SENT message — the "First Viewed" times on it belong to the recipient,
 *     and our own fetch never writes one;
 *   - an already-read inbox message — the stamp exists; re-reading cannot add
 *     a second one (`deriveRead` is monotonic, so this cannot flip back);
 *   - a cached body — this function is never reached, the cache served it.
 *
 * An id with NO cached row is refused: whether it would stamp is exactly what
 * we cannot know without making the request that stamps it. Syncing first
 * (which reads list pages, not bodies) resolves it.
 */
export function markReadVerdict(
  cached: MessageRow | null,
  requested: boolean | undefined,
): ReturnType<typeof jsonErrorResponse> | null {
  const ceiling = getAllowMarkRead();
  if (ceiling && (requested ?? true)) return null;

  const wouldStamp = cached === null
    || (cached.folder === 'inbox' && !deriveRead(cached));
  if (!wouldStamp) return null;

  const because = ceiling
    ? 'you passed allowMarkRead:false'
    : 'this server runs with OFW_ALLOW_MARK_READ=false';
  return jsonErrorResponse({
    error: 'MARK_READ_BLOCKED',
    messageId: cached?.id ?? null,
    reason: cached === null
      ? 'This id is not in the cache, so whether reading it would mark it read is unknowable without making the request that would.'
      : 'This is an unread inbox message; fetching its body would mark it read on OurFamilyWizard.',
    note: `Refused because ${because}. Reading a message for the first time stamps a "First Viewed" timestamp that your co-parent can see and that forms part of the record — it cannot be undone. To read it anyway, call again with allowMarkRead:true${ceiling ? '' : ' (which this deployment does not permit — clear OFW_ALLOW_MARK_READ to re-enable)'}.`,
    ...(cached === null
      ? { hint: 'Run ofw_sync_messages first: it walks list pages, not bodies, so it can tell you what this id is without stamping anything.' }
      : { subject: cached.subject, fromUser: cached.fromUser, sentAt: cached.sentAt }),
  });
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
    description: 'List messages from the local OurFamilyWizard cache. Supports filtering by folder, date range, and a substring query on subject+body. Pagination is offset-based but if you know what you want (a date range, a topic), prefer the filters over walking pages — the cache may have 1000+ messages. Returns an explicit `complete` boolean describing the RESULT SET: true means "this is every message on OurFamilyWizard matching these filters as of freshness.asOf" — check it before asserting a count. An empty result from a cache that is not verified-fresh is REFUSED (result:"UNVERIFIED_EMPTY") rather than reported as an absence; pass autoRefresh:true to sync and answer instead.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      folderId: z.string().describe('Folder name: "inbox", "sent", or "both" (default "both")').optional(),
      page: z.number().int().min(1).describe('Page number (default 1)').optional(),
      size: z.number().int().min(1).describe('Messages per page (default 50)').optional(),
      since: z.string().describe('ISO date or datetime — only messages with sent_at >= since (inclusive)').optional(),
      until: z.string().describe('ISO date or datetime — only messages with sent_at < until (exclusive)').optional(),
      q: z.string().describe('Substring match on subject AND body (case-insensitive). Use to find messages on a specific topic.').optional(),
      autoRefresh: z.boolean().describe(AUTO_REFRESH_DESC).optional(),
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
      // A rejected argument is an ERROR, not a result. Returning `messages: []`
      // here — even with a note attached — hands back the one shape this whole
      // mechanism exists to eliminate: an empty list that looks like an answer.
      return jsonErrorResponse({
        result: 'INVALID_FOLDER',
        reason: `folderId must be "inbox", "sent", or "both" (got ${JSON.stringify(folderArg)}). Numeric OFW folder IDs are not supported by the cache.`,
        remedy: 'Re-call with folderId omitted (searches both) or set to one of the three accepted names.',
        complete: false,
        note: 'No lookup was performed. This says NOTHING about what is in the cache — do not read it as "no messages".',
      });
    }

    const cache = cacheProvider();
    const folders: FolderName[] = folder === undefined ? ['inbox', 'sent'] : [folder];
    const filter = { folder, since: args.since, until: args.until, q: args.q };

    const { value, refreshed, unverifiedEmpty } = await guardedCacheRead({
      client,
      cache,
      folders,
      autoRefresh: args.autoRefresh ?? getAutoRefreshStaleReads(),
      isEmpty: (v) => v.total === 0,
      read: async () => {
        const total = await cache.countMessages(filter);
        // Reconcile each row's read state at read time: the cached list flags
        // can be stale (a message read after it was first scraped), so `read`
        // is derived from the record's own `viewedAt`/`fetchedBodyAt` and
        // `listData` is forced to agree — see withReadState.
        const messages = (await cache.listMessages({ ...filter, page, size })).map((m) => withReadState(m));
        // Served from the local cache, so the result must say how old it is and
        // whether anything vouches for it — a caller cannot state current state
        // from this payload without either re-reading or surfacing the caveat.
        const freshness = await buildFreshness(cache, { source: 'cache', folders });
        return { messages, total, freshness };
      },
    });

    if (unverifiedEmpty) {
      return unverifiedEmptyResponse({
        what: 'messages matching these filters',
        freshness: value.freshness,
        refreshed,
        remedy: `Call ofw_sync_messages(folders:${JSON.stringify(folders)}) and retry, or re-call this tool with autoRefresh:true. ofw_check_freshness is the cheap live alternative when you only need to confirm a specific message.`,
        extra: { page, size, filters: { folderId: folderArg, since: args.since, until: args.until, q: args.q } },
      });
    }

    const { messages, total, freshness } = value;
    // `complete` describes the RESULT SET, not the sync: true only when this
    // payload holds every matching message the server has. `syncComplete` /
    // `historyComplete` in `freshness` describe the walk that filled the cache
    // and cannot answer "have I now seen all of them?" on their own — a caller
    // needs one boolean to check before saying "you have N messages".
    const fullSlice = page === 1 && messages.length === total;
    const complete = fullSlice && freshness.staleness === 'fresh' && freshness.historyComplete;

    const payload: Record<string, unknown> = { messages, total, page, size, complete, freshness };
    if (!complete) {
      payload.completeNote = [
        !fullSlice ? `this page holds ${messages.length} of ${total} matching cached messages` : null,
        freshness.staleness !== 'fresh' ? `the cache is "${freshness.staleness}", so newer messages may exist on OurFamilyWizard` : null,
        !freshness.historyComplete ? 'older history is still being backfilled, so the cache does not yet hold every message' : null,
      ].filter((r): r is string => r !== null)
        .join('; ')
        .concat('. Do not state a total or an absence from this result without resolving that first.');
    }
    if (total === 0) {
      payload.note = 'No messages match these filters, and the cache IS verified-fresh for these folders — so this is a real "nothing matched", not a stale-cache artefact. If you expected results, relax the filters.';
    } else if (page * size < total) {
      payload.note = `Showing ${(page - 1) * size + 1}–${(page - 1) * size + messages.length} of ${total}. Increase 'page' to see more, or narrow with since/until/q.`;
    }
    if (refreshed) {
      payload.autoRefreshed = true;
    }

    return jsonResponse(payload);
  });

  server.registerTool('ofw_get_message', {
    description: 'Get a single OurFamilyWizard message OR draft by ID. Reads from local cache when available; otherwise fetches from OFW — and for an UNREAD INBOX message that fetch marks it read and stamps a "First Viewed" time the co-parent can see, which is part of the record and cannot be undone. Pass allowMarkRead:false to refuse such a fetch instead (cached bodies, sent messages and already-read messages are unaffected, because none of them stamp anything). For ids that match a draft (in the drafts cache), the response carries folder="drafts" and the body/subject/recipients reflect the drafts cache (which ofw_sync_messages keeps fresh) — drafts have no `fromUser`, and `sentAt`/`fetchedBodyAt` mirror the draft\'s `modifiedAt`. For inbox/sent messages, folder is "inbox" or "sent" as before.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      messageId: z.string().describe('Message ID (also accepts draft IDs — drafts are routed via the drafts cache)'),
      allowMarkRead: z.boolean().describe('Default true (the long-standing behaviour). Set false to refuse a fetch that would mark an unread INBOX message as READ on OurFamilyWizard — an irreversible, co-parent-visible change to the record. Reads that cannot stamp anything (a cached body, a sent message, an already-read message) still succeed. The server-wide OFW_ALLOW_MARK_READ=false is a ceiling this argument cannot raise.').optional(),
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
        // Stable identity FIRST — the id below changes on every edit
        // (create-then-delete), so callers should key off draftKey. Null when
        // this draft was never written through this tool (e.g. authored in
        // the web app).
        draftKey: (await cache.getDraftLineageById(draftRow.id))?.draftKey ?? null,
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
        // ofw_delete_draft / ofw_send_message to assert you are acting on
        // THIS version.
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

    // Everything above this line was served without asking OFW for a body.
    // This is the one path that fetches one — and fetching the body of an
    // unread INBOX message marks it read on OFW, stamping a "First Viewed"
    // time the co-parent can see. That is a court-visible, irreversible change
    // made as a side effect of an ordinary read, so it gets an explicit gate.
    const markReadCheck = markReadVerdict(cached, args.allowMarkRead);
    if (markReadCheck !== null) return markReadCheck;

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
    description: 'Send a message via OurFamilyWizard — the ONE irreversible operation here, so it carries the strongest guard. TO SEND AN EXISTING DRAFT (the safe default): pass draftId (or messageId — same thing). The tool re-reads the draft from OFW and sends the SERVER\'S version, so what goes out is what is on OurFamilyWizard, not what this session remembers — subject/body act only as explicit overrides. It is guarded exactly like ofw_save_draft: pass expectedRevision to assert which version you are sending; if the draft changed on OFW since you read it — or no longer exists (it may already have been SENT) — the send is REFUSED with the current server content echoed back, and nothing goes out. RECIPIENTS: OurFamilyWizard does not persist recipients on drafts, so recipientIds is usually still required at send time (ids from ofw_get_profile). After the send is CONFIRMED (OFW returned the new message id and the re-fetched sent record matches what was posted), the source draft is deleted automatically; pass deleteDraftOnSuccess:false to keep it. On ANY failure or ambiguity the draft is never deleted — the response carries draftRetained:true with the reason. TO COMPOSE FROM SCRATCH: supply subject/body/recipientIds with no draftId. If replyToId is provided (or inherited from the draft), the cache may rewrite it to the latest reply in the same thread (a note is included when this happens). ATTACHMENTS: when sending by draftId, the server draft\'s own attachments carry over automatically; myFileIDs (from ofw_upload_attachment) overrides or attaches files on a fresh compose. The response leads with sentMessageId and the stable draftKey, and reports threaded (whether OFW actually linked the reply) and draftDeleted.',
    annotations: { destructiveHint: true },
    inputSchema: {
      subject: z.string().describe('Message subject. Required unless draftId/messageId is given (then it overrides the server draft\'s subject).').optional(),
      body: z.string().describe('Message body text. Required unless draftId/messageId is given (then it overrides the server draft\'s body — omit it to send exactly what is on OurFamilyWizard).').optional(),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (get from ofw_get_profile). Usually required even when sending a draft: OurFamilyWizard does not persist recipients on drafts.').optional(),
      replyToId: z.number().describe('ID of the message being replied to. Defaults to the draft\'s stored reply target when sending by draftId.').optional(),
      draftId: z.number().describe('ID of an existing draft to send. The draft is re-read from OurFamilyWizard and its SERVER content is sent; missing subject/body default from it. Guarded: a draft that changed since you read it, or that was already sent/deleted, refuses rather than sending blind.').optional(),
      messageId: z.number().describe('Synonym for draftId (if both are passed they must be equal).').optional(),
      expectedRevision: z.string().describe('With draftId: the `revision` from ofw_list_drafts / ofw_get_message / ofw_check_freshness for that draft. Asserts you are sending THAT version; if the draft changed on OFW since, the send is refused and the current server content returned. Omit and the tool compares the server against the local cache instead — omitting never means "send whatever is there now".').optional(),
      deleteDraftOnSuccess: z.boolean().describe('Default true. Delete the source draft after — and ONLY after — the send is confirmed (new message id returned and the re-fetched sent record checks out). Set false to keep the draft. On a failed or unverifiable send the draft is ALWAYS kept, regardless of this flag.').optional(),
      force: z.boolean().describe('Default false. Send even when the draft changed on OurFamilyWizard since you read it, or its current state could not be read. Only use after showing the user the conflict.').optional(),
      myFileIDs: z.array(z.number()).describe('Attachment file ids (from ofw_upload_attachment) to attach to the message. When sending by draftId, omit it to carry the server draft\'s own attachments over; passing it overrides them.').optional(),
    },
  }, async (args) => {
    if (args.messageId !== undefined && args.draftId !== undefined && args.messageId !== args.draftId) {
      throw new Error(`messageId (${args.messageId}) and draftId (${args.draftId}) refer to different drafts; pass only one.`);
    }
    const draftRef = args.messageId ?? args.draftId;
    const cache = cacheProvider();
    const deleteOnSuccess = args.deleteDraftOnSuccess ?? true;

    let subject = args.subject;
    let body = args.body;
    let recipientIds = args.recipientIds;
    let draftReplyToId: number | null = null;
    let guardNote: string | null = null;
    let serverDraft: DraftContent | null | undefined;

    if (draftRef !== undefined) {
      const cachedDraft = await cache.getDraft(draftRef);
      // The guard runs whenever this call would TRUST the draft (a content
      // field defaults from it) or DESTROY it (delete after send). Only a call
      // that overrides every field AND keeps the draft touches nothing that
      // needs guarding. Sending is the one irreversible operation here, so it
      // is never less protected than ofw_save_draft.
      const needsContent = subject === undefined || body === undefined || recipientIds === undefined;
      if (needsContent || deleteOnSuccess) {
        const guard = await guardDestructiveDraftOp({
          cache,
          draftId: draftRef,
          expectedRevision: args.expectedRevision,
          force: args.force ?? false,
          action: 'send',
        });
        if (!guard.ok) return guard.response;
        guardNote = guard.note;
        serverDraft = guard.server;
      }
      // Content defaults come from the SERVER draft the guard just read — the
      // point of sending by id is that the artifact sent is the artifact on
      // the server. The cached row is a fallback only for the force paths
      // where the server copy could not be read (or the guard was skipped).
      const base = serverDraft ?? cachedDraft;
      if (base != null) {
        subject = subject ?? base.subject;
        body = body ?? base.body;
        draftReplyToId = base.replyToId;
      }
      if (recipientIds === undefined) {
        // OFW does not persist recipients on drafts (the server copy routinely
        // reports []), so take any NON-EMPTY recipient set we have — server
        // first, then cache — and otherwise require the caller to supply one.
        // Defaulting to [] would "send" to nobody.
        const source = [serverDraft ?? null, cachedDraft].find(
          (s) => s !== null && s !== undefined && s.recipients.some((r) => r.userId !== 0),
        );
        if (source != null) {
          recipientIds = [...new Set(source.recipients.map((r) => r.userId).filter((id) => id !== 0))];
        }
      }
    }
    if (subject === undefined || body === undefined || recipientIds === undefined) {
      const missing = [
        subject === undefined ? 'subject' : null,
        body === undefined ? 'body' : null,
        recipientIds === undefined ? 'recipientIds' : null,
      ].filter((n): n is string => n !== null).join(', ');
      const hint = draftRef === undefined
        ? 'Pass them directly, or pass draftId to send an existing draft.'
        : missing === 'recipientIds'
          ? `Draft ${draftRef} carries no stored recipients — OurFamilyWizard does not persist recipients on drafts, so they must be supplied at send time. Get the co-parent's user id from ofw_get_profile and pass recipientIds.`
          : `Draft ${draftRef}'s content was not readable from OurFamilyWizard or the local cache, so it cannot supply the missing fields. Pass them explicitly.`;
      throw new Error(`ofw_send_message requires ${missing}. ${hint}`);
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

    // Attachments carry over from the SERVER draft the guard read — sending
    // "the draft as it exists on the server" includes its files, or the send
    // would silently strip them. Explicit myFileIDs still overrides.
    const myFileIDs = args.myFileIDs ?? serverDraft?.files ?? [];
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
    let sentDraftKey: string | null = null;
    let threaded = false;
    let threadNote: string | null = null;
    if (newId !== null) {
      verifyNote = verifyWriteLanded('message', { subject, body }, detail);

      // Threading verdict, from OFW's own echo on the re-fetched sent record.
      // Both directions demand POSITIVE evidence (see reportsUnthreaded): a
      // bare `replyToId: null` — OFW's normal shape even on threaded items —
      // and a total absence of echo fields are both "not echoed", NOT
      // "dropped". A warning the caller can see is false is a warning it
      // learns to skip.
      const echoed = threadedReplyTo(detail);
      if (resolvedReplyTo === null) {
        threaded = reportsThreaded(detail);
      } else if (reportsThreaded(detail)) {
        threaded = true;
        if (echoed !== null && echoed !== resolvedReplyTo) {
          threadNote = `NOTE: the sent message threads to ${echoed}, not the requested ${resolvedReplyTo} — OurFamilyWizard re-targeted the reply within the thread.`;
        }
      } else if (reportsUnthreaded(detail)) {
        threaded = false;
        threadNote = `WARNING: the sent message came back UNTHREADED — replyToId ${resolvedReplyTo} was posted but OurFamilyWizard reports no reply linkage on the sent record, so it went out as a new top-level conversation. Verify on ourfamilywizard.com.`;
      } else {
        threaded = true;
      }

      // Recipient confirmation is part of "the send is confirmed" (it gates
      // the draft delete below). Only a NON-EMPTY echo can disconfirm: an
      // omitted or empty recipients array is "not echoed" (OFW routinely
      // echoes [] the way it does on drafts), and crying wolf on it would
      // retain the draft after every ordinary send.
      const storedRecipients = mapRecipients(detail.recipients);
      if (Array.isArray(detail.recipients) && detail.recipients.length > 0) {
        const landed = new Set(storedRecipients.map((r) => r.userId));
        const missingRecipients = recipientIds.filter((rid) => !landed.has(rid));
        if (missingRecipients.length > 0) {
          verifyNote = [
            verifyNote,
            `WARNING: the sent record does not list requested recipient id(s) ${missingRecipients.join(', ')}, so the send could not be fully confirmed. Verify on ourfamilywizard.com.`,
          ].filter((n): n is string => n !== null).join('\n\n');
        }
      }

      persisted = {
        id: newId,
        folder: 'sent',
        subject: detail.subject ?? subject,
        fromUser: detail.from?.name ?? '',
        sentAt: detail.date?.dateTime ?? new Date().toISOString(),
        recipients: storedRecipients,
        body: detail.body ?? body,
        fetchedBodyAt: new Date().toISOString(),
        // Prefer OFW's own echo of where the reply landed; keep what was
        // posted when OFW echoed nothing (sent rows feed findLatestReplyTip,
        // and a null would break the chain for a message that IS threaded).
        // A positively UNTHREADED send stores null — the chain link OFW says
        // does not exist must not be invented.
        replyToId: threaded ? echoed ?? resolvedReplyTo : null,
        chainRootId: threaded ? chainRootId : null,
        listData: detail,
      };
      await cache.upsertMessage(persisted);
      // Extend the draft's identity chain onto the SENT message. Without this
      // the chain would dead-end at the last draft id and "what happened to the
      // draft I was editing?" would answer `deleted` — technically true of that
      // id, and the exact wrong impression. With it, resolving the key lands on
      // the sent message and reports state:"sent" with its sentAt.
      if (draftRef !== undefined) {
        const prior = await cache.getDraftLineageById(draftRef);
        const now = new Date().toISOString();
        const key = prior?.draftKey ?? newDraftKey();
        if (prior === null) {
          await cache.recordDraftLineage({ id: draftRef, draftKey: key, previousId: null, recordedAt: now });
        }
        await cache.recordDraftLineage({ id: newId, draftKey: key, previousId: draftRef, recordedAt: now });
        sentDraftKey = key;
      }
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

    // Clean up the draft ONLY once the send is confirmed: OFW returned the new
    // message id AND the re-fetched sent record raised no verification warning
    // (subject/body landed, requested recipients listed). On any failure or
    // ambiguity the draft is the user's only reliable copy — keep it and say
    // why, never silently.
    let unconfirmedNote: string | null = null;
    let draftDeleted = false;
    let draftRetainedReason: string | null = null;
    if (newId === null) {
      const draftClause = draftRef !== undefined
        ? `Draft ${draftRef} was NOT deleted — check`
        : 'Check';
      unconfirmedNote = `WARNING: OFW's send response did not include a message id, so the send could not be confirmed. ${draftClause} ourfamilywizard.com to see whether the message went out before retrying.`;
      if (draftRef !== undefined) {
        draftRetainedReason = 'the send could not be confirmed (OFW returned no message id), so the draft is your only reliable copy of the message';
      }
    } else if (draftRef !== undefined) {
      if (verifyNote !== null) {
        draftRetainedReason = 'the sent record could not be fully verified against what was posted (see WARNING above) — the draft is kept until you confirm the send on ourfamilywizard.com';
      } else if (!deleteOnSuccess) {
        draftRetainedReason = 'deleteDraftOnSuccess:false — kept by request';
      } else {
        try {
          await deleteOFWMessages(client, [draftRef]);
          await cache.deleteDraft(draftRef);
          draftDeleted = true;
        } catch (e) {
          draftRetainedReason = `the send succeeded but the draft delete failed (${(e as Error).message}) — remove it with ofw_delete_draft once you have verified the sent message`;
        }
      }
    }
    const retainNote = draftRef !== undefined && newId !== null && !draftDeleted
      ? `NOTE: draft ${draftRef} was retained: ${draftRetainedReason}.`
      : null;

    // Leads with the stable identifiers (sentMessageId, draftKey) — the
    // volatile ids and the full sent row follow.
    const responseObj = persisted === null
      ? (draftRef !== undefined
        ? { sendConfirmed: false, draftDeleted: false, draftRetained: true, draftRetainedReason, raw }
        : raw)
      : {
        sentMessageId: newId,
        draftKey: sentDraftKey,
        threaded,
        ...(draftRef !== undefined
          ? {
            draftDeleted,
            ...(draftDeleted ? {} : { draftRetained: true, draftRetainedReason }),
            previousId: draftRef,
          }
          : {}),
        ...persisted,
      };
    const text = responseObj ? JSON.stringify(responseObj, null, 2) : 'Message sent successfully.';
    const notes = [guardNote, rewriteNote, verifyNote, threadNote, unconfirmedNote, retainNote]
      .filter((n): n is string => n !== null).join('\n\n');
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
  // On ok:true, `server` carries the draft content the guard already read from
  // OFW — the authoritative copy. ofw_send_message sends exactly this content,
  // so "what goes out is what is on the server" costs no extra request. It is
  // `undefined` (not null) when the guard proceeded WITHOUT reading the server
  // (force:true over a failed freshness fetch); `null` means the server
  // affirmatively reported the draft gone.
  type DraftGuardOutcome =
    | { ok: true; note: string | null; server: DraftContent | null | undefined }
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
      // Anything landing here means the check could not RUN. Most failures
      // arrive as DraftFreshnessError from fetchServerDraft, but not all of
      // them: a strict parseLenient mismatch on the server draft throws
      // McpToolError instead. Both are caught, and both abort — which is the
      // point. A failed check is not permission to proceed: a transient 5xx
      // must not degrade into a blind overwrite. (The cast below only reads
      // `.message`, which every Error carries.)
      const reason = (e as DraftFreshnessError).message;
      if (force) {
        return { ok: true, note: `WARNING: force:true — proceeded with ${action} on draft ${draftId} even though its current state could not be read from OurFamilyWizard (${reason}). Any newer server-side version was destroyed and is NOT recoverable from this response.`, server: undefined };
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
    if (verdict.verdict === 'FRESH') {
      // A metadata-only "conflict" is the connector's own post-save replyToId
      // normalization catching up — safe to proceed, but say so rather than
      // pretending nothing moved.
      const note = verdict.metadataOnly
        ? `NOTE: draft ${draftId} was treated as current for this ${action}. Since you read it, OurFamilyWizard normalized connector-authored metadata (${verdict.changedFields.join(', ')}); the subject, body and recipients are unchanged, so this is not a conflict.`
        : null;
      return { ok: true, note, server };
    }

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
        server,
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
    description: 'List draft messages, verified against OurFamilyWizard in ONE call: when the local drafts cache is not verified-fresh, a cheap drafts sync runs first by default (verify:true), so the answer is server-confirmed without a second call. Pass verify:false to answer purely from the cache (no OFW requests). Returns an explicit `complete` boolean describing the RESULT SET: true means "these are ALL the drafts on OurFamilyWizard as of freshness.asOf" — check it before saying "you have N drafts". Each draft carries its `draftKey` (stable across the create-then-delete churn of editing) when one is known. An empty result from a cache that is not verified-fresh is REFUSED (result:"UNVERIFIED_EMPTY"); pass autoRefresh:true to sync and answer instead.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      page: z.number().int().min(1).describe('Page number (default 1)').optional(),
      size: z.number().int().min(1).describe('Drafts per page (default 50)').optional(),
      verify: z.boolean().describe('Default true: when the drafts cache is not verified-fresh, run a drafts sync first (cheap — one list page plus one detail per draft) so the response is server-confirmed in one call. Set false to serve straight from the local cache with no OFW requests.').optional(),
      autoRefresh: z.boolean().describe(AUTO_REFRESH_DESC).optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const cache = cacheProvider();

    // Auto-verify (default on): drafts change rarely but INVISIBLY — a web-app
    // edit bumps no timestamp — so an aged cache used to answer "unverified,
    // don't state a count" and force a second call. The drafts walk is cheap
    // enough to just run it. Two honesty rules: `autoVerified` is derived from
    // the POST-sync cache status, because a budget-paused walk applies nothing
    // and claiming autoVerified next to serverConfirmed:false would be one
    // payload contradicting itself; and a sync that CANNOT run (OFW/network
    // down) degrades to the honestly-labelled cache answer below rather than
    // turning a previously infallible cache read into a hard error.
    let autoVerified = false;
    let verifyNote: string | null = null;
    if (args.verify ?? true) {
      const { cacheStatus } = await draftsFreshness(cache);
      if (cacheStatus !== 'fresh') {
        try {
          await syncAll(client, { folders: ['drafts'], maxRequests: getSyncMaxRequests() }, cache);
          autoVerified = await getDraftsCacheStatus(cache) === 'fresh';
        } catch (e) {
          verifyNote = `The automatic drafts verification could not reach OurFamilyWizard (${(e as Error).message}). Answering from the local cache — the freshness block below labels its age, and an empty result will still be refused rather than reported as an absence.`;
        }
      }
    }

    const { value, refreshed, unverifiedEmpty } = await guardedCacheRead({
      client,
      cache,
      folders: ['drafts'],
      autoRefresh: args.autoRefresh ?? getAutoRefreshStaleReads(),
      isEmpty: (v) => v.total === 0,
      read: async () => {
        const { freshness, serverConfirmed, cacheStatus } = await draftsFreshness(cache);
        const rows = await cache.listDrafts({ page, size });
        const total = await cache.countDrafts();
        // One batch lookup for the whole page — on the Durable Object backend a
        // per-draft lineage read would be a subrequest each.
        const keyById = new Map(
          (await cache.getDraftLineageByIds(rows.map((d) => d.id))).map((l) => [l.id, l.draftKey]),
        );
        // Every draft carries the concurrency token to echo back on a write, its
        // stable identity across edits, and whether the last sync actually
        // compared this cache against OFW.
        const drafts = rows.map((d) => ({
          ...d,
          revision: draftRevision(d),
          draftKey: keyById.get(d.id) ?? null,
          cacheStatus,
          serverConfirmed,
          asOf: freshness.asOf,
        }));
        return { drafts, total, freshness, serverConfirmed };
      },
    });

    if (unverifiedEmpty) {
      return unverifiedEmptyResponse({
        what: 'drafts',
        freshness: value.freshness,
        refreshed,
        remedy: 'Call ofw_sync_messages(folders:["drafts"]) and retry, re-call with autoRefresh:true, or use ofw_status(includeDraftInventory:true) for a single live answer.',
        extra: { page, size, ...(verifyNote !== null ? { verifyNote } : {}) },
      });
    }

    const { drafts, total, freshness, serverConfirmed } = value;
    // True only when this payload IS the full server-side draft set: verified
    // against OFW inside the freshness window AND not a slice of a larger list.
    const fullSlice = page === 1 && drafts.length === total;
    const complete = serverConfirmed && fullSlice;

    const payload: Record<string, unknown> = { drafts, total, page, size, complete, freshness };
    if (!complete) {
      payload.completeNote = [
        !fullSlice ? `this page holds ${drafts.length} of ${total} cached drafts` : null,
        !serverConfirmed ? 'the drafts cache has not been confirmed against OurFamilyWizard inside the freshness window' : null,
      ].filter((r): r is string => r !== null)
        .join('; ')
        .concat('. Do NOT state a draft count from this result — call ofw_status(includeDraftInventory:true) for a live, complete one.');
    }
    if (!serverConfirmed) {
      payload.note = 'serverConfirmed:false — these drafts are remembered from the local cache, NOT confirmed to still exist unsent on OurFamilyWizard right now, and their bodies may be behind the server. Do not state that a draft "is still sitting unsent" on this basis; drafts edited, deleted or SENT in the OFW web app bump no timestamp, so the cache cannot detect it on its own. Call ofw_status / ofw_check_freshness (cheap, live) or ofw_sync_messages first. Writes are guarded regardless — ofw_save_draft and ofw_delete_draft re-check the server and refuse a stale overwrite.';
    }
    if (refreshed) {
      payload.autoRefreshed = true;
    }
    if (autoVerified) {
      payload.autoVerified = true;
    }
    if (verifyNote !== null) {
      payload.verifyNote = verifyNote;
    }
    return jsonResponse(payload);
  });

  if (allowDrafts) server.registerTool('ofw_save_draft', {
    description: 'Save a message as a draft in OurFamilyWizard. RECIPIENTS: OurFamilyWizard does NOT persist recipients on drafts — recipientIds are accepted but the saved draft comes back with none (documented OFW behavior, noted once in the response, not warned about; supply recipientIds at send time instead). IDENTITY: the response leads with `draftKey`, the stable identity that survives editing — key off it, because the `id` changes on EVERY edit (replacing a draft creates a NEW draft and deletes the old one; OFW\'s update-in-place endpoint silently no-ops, so we never use it). Pass messageId to replace an existing draft; the response.id will be the NEW id, and a transparency NOTE documents the swap and which fields were carried over. THREADING: if replyToId is provided, the cache may rewrite it to the latest reply in the thread (note included). The threading verdict is read from OFW\'s full echo (replyToId/inReplyTo/showContext) — a warning appears ONLY when the reply linkage was genuinely dropped or re-targeted, and the response\'s top-level replyToId/inReplyTo always agree with its listData. Attach files via myFileIDs (from ofw_upload_attachment). After saving, the tool re-fetches the draft from OFW, and the returned `revision` reflects that authoritative state (so it will match on your next edit). SAFETY: because replacing DESTROYS the old draft rather than merging, passing messageId first re-reads that draft from OFW and REFUSES the write if its subject/body/recipients changed since you read it (drafts edited in the OFW web app do not bump any timestamp, so the local cache can be silently behind). A pure replyToId normalization by OFW is NOT treated as a conflict. The refusal returns the current server body under serverBody — merge your edit into it and retry with expectedRevision.',
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
    let recipientsNote: string | null = null;
    let newRevision: string | null = null;
    let draftKey: string | null = null;
    // Fields accepted on the write that the saved draft must carry — or their
    // loss must be reported. Never a silent drop (Defect 3).
    const warnings: string[] = [];

    if (newId !== null) {
      verifyNote = verifyWriteLanded('draft', { subject: args.subject, body: args.body }, detail);
      // Trust the re-fetched server detail as the source of truth for the stored
      // replyToId — NOT `resolvedReplyTo` (what we intended to post). OFW
      // normalizes/drops threading after a save, and masking that with our own
      // intent (the old `detail.replyToId ?? resolvedReplyTo`) both returned a
      // revision that was stale on arrival (Defect 1) and hid a dropped reply
      // link (Defect 3). The echo is read via threadedReplyTo because OFW
      // reports the target as `inReplyTo` on payloads where `replyToId` is
      // null — reading only `replyToId` fired a false "did not thread" warning
      // on nearly every threaded save while the same response's listData
      // showed inReplyTo populated.
      const effectiveReplyTo = threadedReplyTo(detail);
      const storedRecipients = mapRecipients(detail.recipients);
      persisted = {
        id: newId,
        subject: detail.subject ?? args.subject,
        body: detail.body ?? '',
        recipients: storedRecipients,
        replyToId: effectiveReplyTo,
        modifiedAt: detail.date?.dateTime ?? new Date().toISOString(),
        listData: detail,
      };
      await cache.upsertDraft(persisted);
      // The revision is now computed from the server-authoritative detail, so it
      // is the value a subsequent read/verify will observe (Defect 1).
      newRevision = draftRevision(persisted);

      // Carry the logical identity across the id change. Replacing a draft mints
      // a NEW OFW id every time (create-then-delete — see the note below), so
      // ten edits produced ten unrelated ids and there was no way to ask what
      // became of the one you started with. The key is minted on first sight —
      // including retroactively for the draft being replaced, so a draft that
      // predates this mechanism joins a chain the moment it is edited.
      const now = new Date().toISOString();
      if (args.messageId !== undefined) {
        const prior = await cache.getDraftLineageById(args.messageId);
        if (prior !== null) {
          draftKey = prior.draftKey;
        } else {
          draftKey = newDraftKey();
          await cache.recordDraftLineage({
            id: args.messageId, draftKey, previousId: null, recordedAt: now,
          });
        }
      } else {
        draftKey = newDraftKey();
      }
      await cache.recordDraftLineage({
        id: newId,
        draftKey,
        previousId: args.messageId ?? null,
        recordedAt: now,
      });

      // Audit every field the caller supplied against what actually landed, so a
      // silent normalization becomes a visible warning rather than a surprise.
      // The verdict comes from the FULL threading echo (replyToId, inReplyTo,
      // showContext) — a draft reporting inReplyTo (or showContext:true) IS
      // threaded, and warning about it anyway is the false positive that
      // trained callers to skim warnings. The "dropped" warning demands
      // POSITIVE evidence (reportsUnthreaded): a bare `replyToId: null` or a
      // detail omitting every echo field is "not echoed", never "dropped".
      // The stored replyToId is still the server echo (null when unreported) —
      // masking it with intent was Defect 1, and the revision must hash what
      // the next sync will read.
      if (resolvedReplyTo !== null && effectiveReplyTo !== resolvedReplyTo && reportsUnthreaded(detail)) {
        const rewrittenFrom = requestedReplyTo !== resolvedReplyTo ? ` (rewritten from ${requestedReplyTo})` : '';
        warnings.push(
          `replyToId was requested as ${resolvedReplyTo}${rewrittenFrom} but the saved draft came back with replyToId null — OurFamilyWizard did not thread this draft (its inReplyTo/showContext are empty). The subject and body were saved; only the reply linkage was dropped. If threading matters, verify on ourfamilywizard.com.`,
        );
      } else if (resolvedReplyTo !== null && effectiveReplyTo !== null && effectiveReplyTo !== resolvedReplyTo) {
        // OFW RE-TARGETED the link to another message in the thread — the
        // draft IS threaded, just not to the requested id, and the inReplyTo
        // in this response reflects where it actually landed.
        const rewrittenFrom = requestedReplyTo !== resolvedReplyTo ? ` (rewritten from ${requestedReplyTo})` : '';
        warnings.push(
          `replyToId was requested as ${resolvedReplyTo}${rewrittenFrom} but the saved draft came back with replyToId ${effectiveReplyTo} — OurFamilyWizard re-targeted the reply to message ${effectiveReplyTo} instead. The draft IS threaded — to that message, not the one requested. If threading matters, verify on ourfamilywizard.com.`,
        );
      }
      // Recipients: OFW does NOT persist recipients on drafts — the saved copy
      // routinely comes back with [] no matter what was posted. That is
      // documented OFW behavior (and doubles as an accidental-send guard), so
      // it gets a one-line NOTE, not a per-call WARNING that cries wolf on
      // every save. A PARTIAL echo (some stored, but not what was asked) is a
      // genuine drop and still warns. Both only when the detail actually
      // reported recipients — an omitted array is "not echoed", not "dropped".
      if (args.recipientIds !== undefined && args.recipientIds.length > 0 && Array.isArray(detail.recipients)) {
        const requested = [...new Set(args.recipientIds)].sort((a, b) => a - b);
        const stored = [...new Set(storedRecipients.map((r) => r.userId))].sort((a, b) => a - b);
        if (stored.length === 0) {
          recipientsNote = 'NOTE: OurFamilyWizard does not persist recipients on drafts — the recipientIds you passed were accepted but are not stored on the draft (documented OFW behavior, not an error; it also means a draft cannot be sent by accident). Supply recipientIds when you send: ofw_send_message requires them when the draft carries none.';
        } else if (requested.join(',') !== stored.join(',')) {
          warnings.push(
            `recipientIds were requested as [${requested.join(', ')}] but the saved draft has [${stored.join(', ')}]. Verify the recipients on ourfamilywizard.com.`,
          );
        }
      }
      if (myFileIDs.length > 0 && Array.isArray(detail.files)) {
        const storedFiles = new Set(detail.files);
        const missing = myFileIDs.filter((id) => !storedFiles.has(id));
        if (missing.length > 0) {
          warnings.push(
            `Attachment fileId(s) ${missing.join(', ')} were requested in myFileIDs but are not attached to the saved draft. Re-upload or re-attach if needed.`,
          );
        }
      }

      // Replace-path: caller passed messageId, so they want the old draft
      // gone. Delete it after the new one is safely created+cached.
      if (args.messageId !== undefined && args.messageId !== newId) {
        try {
          await deleteOFWMessages(client, [args.messageId]);
          await cache.deleteDraft(args.messageId);
          replaceNote = `NOTE: ofw_save_draft replaced draft ${args.messageId} via create-then-delete. The new draft id is ${newId}; the old draft has been deleted. The draftKey is UNCHANGED — key off it rather than the volatile id, which changes on every edit. (OFW's update-in-place endpoint silently no-ops on subsequent updates, so we never use it.) Fields carried over to the new draft: subject, body, recipients (${persisted.recipients.length}), replyToId (${persisted.replyToId === null ? 'none' : persisted.replyToId}), attachments (${myFileIDs.length}).${warnings.length > 0 ? ' See warnings above for any field OurFamilyWizard did not carry over.' : ''}`;
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
    // cache freshness. The response LEADS with `draftKey` (stable across the
    // create-then-delete id churn of editing — key off it, not `id`) and the
    // `revision` concurrency token; the volatile `id` is carried further down
    // as an implementation detail. `inReplyTo` echoes the effective threading,
    // and `warnings` names any requested field that did not land.
    const responseObj = persisted !== null
      ? {
        draftKey,
        revision: newRevision,
        ...persisted,
        inReplyTo: persisted.replyToId,
        previousId: args.messageId ?? null,
        cacheStatus: 'fresh',
        serverConfirmed: true,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(recipientsNote !== null ? { recipientsNote } : {}),
      }
      : raw;
    const text = responseObj ? JSON.stringify(responseObj, null, 2) : 'Draft saved.';
    const warnNote = warnings.length > 0
      ? `WARNING: ${warnings.join('\n\n')}`
      : null;
    const notes = [forceNote, rewriteNote, verifyNote, warnNote, recipientsNote, replaceNote]
      .filter((n): n is string => n !== null).join('\n\n');
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
    description: 'List sent messages that have not been read by one or more recipients. Reads from local cache. Returns `complete` describing whether every sent message was scanned. An empty SENT cache that is not verified-fresh is REFUSED (result:"UNVERIFIED_EMPTY") rather than reported as "nothing sent"; pass autoRefresh:true to sync and answer instead.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      page: z.number().int().min(1).describe('Page (default 1)').optional(),
      size: z.number().int().min(1).describe('Per page (default 50)').optional(),
      autoRefresh: z.boolean().describe(AUTO_REFRESH_DESC).optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const cache = cacheProvider();

    const { value, refreshed, unverifiedEmpty } = await guardedCacheRead({
      client,
      cache,
      folders: ['sent'],
      autoRefresh: args.autoRefresh ?? getAutoRefreshStaleReads(),
      // The guard is about the CACHE being empty, not the verdict. "You have
      // no sent messages" is an absence claim a stale cache cannot support;
      // "all of them are read" is a verdict over messages we did see, and it is
      // labelled by `freshness` and `complete` as before.
      isEmpty: (v) => v.total === 0,
      read: async () => {
        const sent = await cache.listMessages({ folder: 'sent', page, size });
        const total = await cache.countMessages({ folder: 'sent' });
        // "Nobody has read it yet" is a present-tense claim drawn entirely from
        // cached view timestamps, which only move when a sync refreshes them —
        // so it needs the same age label as any other cached read.
        const freshness = await buildFreshness(cache, { source: 'cache', folders: ['sent'] });
        return { sent, total, freshness };
      },
    });

    if (unverifiedEmpty) {
      return unverifiedEmptyResponse({
        what: 'sent messages in the local cache',
        freshness: value.freshness,
        refreshed,
        remedy: 'Call ofw_sync_messages(folders:["sent"]) and retry, or re-call with autoRefresh:true.',
        extra: { page, size },
      });
    }

    const { sent, total, freshness } = value;
    const fullSlice = page === 1 && sent.length === total;
    const complete = fullSlice && freshness.staleness === 'fresh' && freshness.historyComplete;

    const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
    for (const msg of sent) {
      const unreadBy = msg.recipients.filter((r) => r.viewedAt === null).map((r) => r.name);
      if (unreadBy.length > 0) {
        unread.push({ id: msg.id, subject: msg.subject, sentAt: msg.sentAt, unreadBy });
      }
    }

    const payload: Record<string, unknown> = { unread, scanned: sent.length, total, complete, freshness };
    if (!complete) {
      payload.completeNote = `This verdict covers the ${sent.length} of ${total} cached sent messages on this page${freshness.staleness === 'fresh' ? '' : `, from a cache that is "${freshness.staleness}"`}. It is not a statement about every message you have sent.`;
    }
    if (unread.length === 0) {
      payload.message = 'Every sent message scanned had been read as of the timestamp in `freshness.asOf`. A recipient may have read — or not read — a message since without the cache hearing about it.';
    }
    if (refreshed) {
      payload.autoRefreshed = true;
    }
    return jsonResponse(payload);
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
    // (disk read on node; an in-memory source on a hosted deployment).
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
    description: 'Download an OFW message attachment by fileId and return content you can actually read. Inline delivery walks a ladder and returns the first rung that works: (1) host-renderable images (PNG/JPEG/GIF/WEBP) come back as ImageContent; (2) .xlsx/.csv/.tsv, .pdf, .docx, .pptx and text files come back as EXTRACTED CONTENT — per-sheet CSV, per-page/slide text, document text — in the response JSON under `extracted`; (3) anything else comes back as an EmbeddedResource blob of the raw bytes. The meta block names the rung as `deliveredVia` and, when it falls through to bytes, lists what was tried in `deliveryAttempts`. Reported mime types are always normalized to a bare media type (no charset/name parameters). In disk mode the bytes are saved to ~/Downloads/ofw-mcp/ and the response carries the absolute path; pass extract:true to ALSO get the extracted content in that response. The default for `inline` can be flipped server-side via the OFW_INLINE_ATTACHMENTS env var. On a hosted deployment with no filesystem, disk mode is unavailable, so inline is forced (forcedInline:true) rather than failing — a saveTo path never costs you the content. fileId comes from attachments[].fileId on ofw_get_message. Override disk destination with OFW_ATTACHMENTS_DIR or saveTo. Re-downloading to the same path is a no-op (disk mode only).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      fileId: z.number().describe('Attachment file id (from ofw_get_message → attachments[].fileId)'),
      inline: z.boolean().describe('If true, return content inline as MCP content blocks and skip the disk write. If false, write to disk and return the path — except on a hosted deployment with no filesystem, where inline is forced (forcedInline:true) so the content is still returned. If omitted, falls back to the OFW_INLINE_ATTACHMENTS env var (default: false = disk).').optional(),
      saveTo: z.string().describe('Absolute path or directory to write to. If a directory, the OFW filename is used. Default: ~/Downloads/ofw-mcp/<fileId>-<filename>. Ignored when inline is in effect.').optional(),
      force: z.boolean().describe('Re-download even if already on disk. Default false. Ignored when inline:true (inline always fetches fresh bytes, or reuses an on-disk copy if present).').optional(),
      extract: z.boolean().describe('Whether to extract readable content from the file. Default: on for inline delivery of any non-image type, off in disk mode. Set false to get the raw bytes inline instead of extracted text (e.g. to hash or re-upload the file); set true in disk mode to get both the saved path and the extracted content.').optional(),
      maxChars: z.number().int().min(500).max(500_000).describe('Ceiling on extracted characters (default 50000). Over it, content is clipped on a row/line boundary, `truncated` is set, and anything dropped whole is listed in `extracted.omitted`.').optional(),
      parts: z.string().describe('Which sheets / slides / pages to extract, e.g. "1-3,5" (1-based positions) or a sheet name like "2026". A bare number matches either a position or a name. Omit for everything. Unselected parts are listed in `extracted.omitted`.').optional(),
    },
  }, async (args) => {
    const fileId = args.fileId;
    const cache = cacheProvider();
    const requestedInline = args.inline ?? getDefaultInlineAttachments();
    // When the deployment has no filesystem, inline is the
    // ONLY path to the bytes — force it rather than erroring on a disk write.
    // `forcedInline` records that we overrode an explicit `inline:false` so the
    // response is honest about it instead of silently ignoring the argument.
    const inline = requestedInline || !attachmentIO.supportsDisk;
    const forcedInline = inline && !requestedInline;
    const deliveryOptions = { extract: args.extract, maxChars: args.maxChars, parts: args.parts };
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
      // The ladder decides between rendering, extracted content, and raw bytes
      // — see src/tools/delivery.ts. Whatever the host can draw, the caller
      // ends up holding something readable.
      return await buildInlineDelivery({
        fileId, fileName, mimeType, bytes, forcedInline, options: deliveryOptions,
      });
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

    // Disk mode extracts only on request: the caller already has a real file to
    // open, so extraction is an add-on here rather than the point.
    const extractOnDisk = args.extract === true;

    if (!args.force && cached.downloadedPath === dest) {
      // Nothing was re-fetched, so an extraction has to come off the copy on
      // disk. If that copy has gone missing, fall through and download again
      // rather than answering "already downloaded" with no content.
      const onDisk = extractOnDisk ? attachmentIO.readDownloaded(dest) : null;
      if (!extractOnDisk || onDisk) {
        // No bytes on hand for the plain no-op case: normalize the
        // cached/extension MIME (an empty buffer sniffs nothing) so a stored
        // `image/png;charset=…` still reports bare.
        const mimeType = resolveDownloadMime(onDisk ?? Buffer.alloc(0), cached.mimeType, cached.fileName);
        return jsonResponse({
          fileId, path: dest, mimeType,
          sizeBytes: cached.sizeBytes, fileName: cached.fileName, note: 'already downloaded',
          ...(onDisk ? await tryExtract(onDisk, mimeType, cached.fileName, deliveryOptions) : {}),
        });
      }
    }

    const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
    attachmentIO.writeDownload(dest, response.body);
    await cache.markAttachmentDownloaded(fileId, dest);

    const fileName = response.suggestedFileName ?? cached.fileName;
    const mimeType = resolveDownloadMime(response.body, response.contentType ?? cached.mimeType, fileName);
    return jsonResponse({
      fileId,
      path: dest,
      mimeType,
      sizeBytes: response.body.length,
      fileName,
      ...(extractOnDisk ? await tryExtract(response.body, mimeType, fileName, deliveryOptions) : {}),
    });
  });

  server.registerTool('ofw_sync_messages', {
    description: 'Sync messages from OurFamilyWizard into the local cache. Returns counts per folder and a list of unread inbox messages whose bodies were NOT fetched (to avoid mark-as-read on OFW). Call ofw_get_message(id) on those to read them. EVERY call re-checks the newest page first, so new messages are picked up promptly even while an old-history backfill is still running; only then does it spend what is left of its budget advancing that backfill. Pass deep:true to walk all OFW pages instead of stopping at the first all-cached page (use to backfill suspected gaps). Sync is BOUNDED and RESUMABLE: on hosted deployments a per-call OFW-request budget (env OFW_SYNC_MAX_REQUESTS, or the maxRequests argument) caps how far one call walks; when the budget is hit the response reports done:false with a note — call again with the SAME arguments to resume. done:false means older history is still being backfilled; it does NOT mean recent messages are missing. Local installs are unbounded by default (done is always true).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      folders: z.array(z.enum(['inbox', 'sent', 'drafts'])).min(1).describe('Folders to sync (default: all three). Must be non-empty if given — an empty list would sync nothing while reporting success.').optional(),
      fetchUnreadBodies: z.boolean().describe('If true, also fetch bodies for unread inbox messages — which marks each one READ on OurFamilyWizard and stamps a co-parent-visible "First Viewed" time that cannot be undone. Defaults to the OFW_FETCH_UNREAD_BODIES env var (false unless set), and is forced off entirely when OFW_ALLOW_MARK_READ=false.').optional(),
      deep: z.boolean().describe('If true, walk every OFW page until empty regardless of cache state. Use to backfill gaps. Default false.').optional(),
      maxRequests: z.number().int().min(1).describe('Maximum OFW requests this single call may make before pausing. When hit, the response reports done:false — call again with the same arguments to continue. Omit to use the server default (OFW_SYNC_MAX_REQUESTS, or unbounded on local installs).').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();
    const result = await syncAll(client, {
      folders: args.folders,
      // Default from OFW_FETCH_UNREAD_BODIES (false unless set), and capped by
      // the OFW_ALLOW_MARK_READ ceiling — fetching those bodies is exactly what
      // stamps a First Viewed time on every unread message it touches.
      fetchUnreadBodies: getAllowMarkRead() && (args.fetchUnreadBodies ?? getFetchUnreadBodies()),
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
    description: 'Cheaply confirm whether the local cache still matches OurFamilyWizard, WITHOUT running a full sync. Use this before asserting anything about current state — especially "draft X is still sitting unsent". Costs one OFW request for the folder check plus one per messageId. For each folder it returns the live server count next to the cached count. For each id it returns a LIVE lifecycle `state` — "draft" | "sent" | "received" | "deleted" | "unknown" — alongside `folder`, `sentAt`, `existsOnServer` and a content comparison. `state` is the field that answers "is this still a draft?": a draft that has been SENT still exists on the server, so existsOnServer:true never distinguished the two. A cached draft whose state is no longer "draft" reports inSync:false even when its text is byte-identical. Content is compared by revision hash, because OFW draft timestamps do NOT change when a draft is edited in the web app. Does not fetch bodies into the cache, does not touch attachments, and does not depend on sync state. For draftKeys, or a full live draft inventory, use ofw_status.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      folders: z.array(z.enum(['inbox', 'sent', 'drafts'])).min(1).describe('Folders to compare cached vs live counts for. Defaults to all three when messageIds is not given. Must be non-empty if given.').optional(),
      messageIds: z.array(z.number()).describe(`Specific ids to verify against OFW (max ${MAX_FRESHNESS_IDS}). Ids cached as drafts, as sent messages, or as already-read inbox messages are probed freely — none of those can stamp the record. Anything else is skipped — see allowMarkRead.`).optional(),
      allowMarkRead: z.boolean().describe('Default false. Probing an id whose cached state cannot rule out an unread INBOX message requires fetching its detail, which marks it READ on OurFamilyWizard and stamps a co-parent-visible "First Viewed" time — irreversible. Such ids are skipped (reason:"WOULD_MARK_READ") unless you set this to true. The server-wide OFW_ALLOW_MARK_READ=false is a ceiling this cannot raise.').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();
    // The server-wide ceiling wins: a per-call allowMarkRead:true (or an
    // instruction injected into one) must not be able to stamp the record on a
    // deployment configured to never do so.
    const allowMarkRead = getAllowMarkRead() && (args.allowMarkRead ?? false);
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
      // Take the folder ids while we have them. Without this a call asking
      // about BOTH folders and ids, on a cache that has never synced, fetched
      // this exact endpoint twice — once here for the counts and again inside
      // probeIds' ensureFolderIdMap for the ids it already had in hand.
      await persistFolderIds(cache, sys);
      for (const folder of wantFolders) {
        const entry = sys.find((x) => x.folderType === FOLDER_TYPE[folder]);
        const serverCount = entry?.totalCount ?? entry?.messageCount ?? entry?.count ?? null;
        const cachedCount = folder === 'drafts'
          ? (await cache.listDraftIds()).length
          : await cache.countMessages({ folder });
        const state = await cache.getSyncState(folder);
        // Never synced at all is a DIFFERENT state from "backfill in progress",
        // and both leave historyComplete false. Conflating them told the caller
        // that older history was still being backfilled for a folder whose
        // backfill had never started — advice that reads as "wait it out" when
        // the real answer is "run a sync".
        const neverSynced = state === null;
        const historyComplete = !neverSynced && state.resumePage === null;
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
              : neverSynced
                ? 'This folder has never been synced, so the cache holds nothing to compare. Run ofw_sync_messages.'
                : 'Older history is still being backfilled, so a lower cachedCount is expected and does not indicate drift.' }
            : {}),
        });
      }
    }

    // One folder-id resolve for the whole batch, and only when at least one id
    // is actually going to be probed — a call whose every id is refused for
    // mark-read reasons must cost nothing at all.
    const probed = await probeIds(client, cache, ids, { allowMarkRead });
    requestsUsed += probed.requests;
    const items = probed.items;

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

  server.registerTool('ofw_status', {
    description: 'ONE live call that answers "where does everything stand?". This is the call that should back any status summary about drafts or specific messages — never session memory, and never a cached read alone. With no arguments it returns the FULL current draft inventory, verified against OurFamilyWizard. Pass ids and/or draftKeys to get each one\'s live lifecycle `state` ("draft" | "sent" | "received" | "deleted" | "unknown") with `sentAt` and `viewedAt`. A draftKey is the stable identity ofw_save_draft returns: editing a draft mints a new OFW id every time (create-then-delete), so the key is the only way to ask "what happened to the thing I was working on?" — it resolves to the chain\'s current id and keeps resolving after the draft is SENT (state:"sent" with sentMessageId). The top-level `complete` is true ONLY when every part of this snapshot was verified live; if it is false, do not state a draft count or a lifecycle claim from this payload.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      ids: z.array(z.number()).describe(`Message/draft ids to resolve to a live state (combined with draftKeys, max ${MAX_FRESHNESS_IDS} probes per call).`).optional(),
      draftKeys: z.array(z.string()).describe('Stable draft keys (from ofw_save_draft / ofw_list_drafts) to resolve to their CURRENT id and state.').optional(),
      includeDraftInventory: z.boolean().describe('Return the full current draft list, verified against OurFamilyWizard first. Defaults to TRUE when neither ids nor draftKeys is given (so a bare ofw_status() is a complete status snapshot), otherwise false.').optional(),
      allowMarkRead: z.boolean().describe('Default false. An id whose cached state cannot rule out an unread INBOX message can only be probed by fetching its detail, which marks it READ on OurFamilyWizard — irreversible and co-parent-visible. Those are skipped unless this is true. Cached drafts, sent messages and already-read messages are always probed. Capped by OFW_ALLOW_MARK_READ.').optional(),
    },
  }, async (args) => {
    const cache = cacheProvider();
    const allowMarkRead = getAllowMarkRead() && (args.allowMarkRead ?? false);
    const requestedIds = args.ids ?? [];
    const requestedKeys = args.draftKeys ?? [];
    // A bare ofw_status() is meant to be the "here is where everything stands"
    // call, so it defaults to the inventory. Asking about specific ids does not
    // silently spend a drafts sync you did not ask for.
    const wantInventory = args.includeDraftInventory
      ?? (requestedIds.length === 0 && requestedKeys.length === 0);

    // Ids and keys share ONE probe budget: each costs the same single request,
    // and a cap that counted them separately would let a caller spend double.
    type Target = { kind: 'id'; id: number } | { kind: 'draftKey'; draftKey: string };
    const allTargets: Target[] = [
      ...requestedIds.map((id): Target => ({ kind: 'id', id })),
      ...requestedKeys.map((draftKey): Target => ({ kind: 'draftKey', draftKey })),
    ];
    const targets = allTargets.slice(0, MAX_FRESHNESS_IDS);
    const truncated = allTargets.length - targets.length;

    // Nothing asked for, nothing checked — so there is nothing to be complete
    // ABOUT. Returning `complete: true` here would be a reassuring-looking
    // payload that verified precisely nothing, which is the failure mode this
    // whole tool exists to remove.
    if (!wantInventory && targets.length === 0) {
      return jsonErrorResponse({
        result: 'NOTHING_REQUESTED',
        reason: 'ofw_status was called with includeDraftInventory:false and no ids or draftKeys, so nothing was checked.',
        remedy: 'Call ofw_status() with no arguments for the full draft inventory, or pass ids / draftKeys.',
        complete: false,
      });
    }

    let probeRequests = 0;
    const incomplete: string[] = [];

    // ── Draft inventory ────────────────────────────────────────────────────
    let drafts: Array<Record<string, unknown>> | undefined;
    let inventoryComplete = true;
    let inventoryFreshness: FreshnessBlock | undefined;
    if (wantInventory) {
      const sync = await syncAll(client, {
        folders: ['drafts'],
        maxRequests: getSyncMaxRequests(),
      }, cache);
      // `refreshed` is the only honest signal that the walk actually diffed
      // against OFW. A budget-paused walk applies nothing and returns no count
      // — reporting its inventory as complete would be the same lie as
      // `drafts: 0` from a deferred sync.
      inventoryComplete = sync.refreshed.includes('drafts');
      const { freshness, cacheStatus, serverConfirmed } = await draftsFreshness(cache);
      inventoryFreshness = freshness;
      if (!serverConfirmed) inventoryComplete = false;
      const total = await cache.countDrafts();
      const rows = await cache.listDrafts({ page: 1, size: Math.max(total, 1) });
      const keyById = new Map(
        (await cache.getDraftLineageByIds(rows.map((d) => d.id))).map((l) => [l.id, l.draftKey]),
      );
      drafts = rows.map((d) => ({
        id: d.id,
        draftKey: keyById.get(d.id) ?? null,
        subject: d.subject,
        revision: draftRevision(d),
        modifiedAt: d.modifiedAt,
        recipients: d.recipients,
        replyToId: d.replyToId,
        cacheStatus,
      }));
      if (!inventoryComplete) {
        incomplete.push('the drafts folder was not fully verified against OurFamilyWizard on this call (the request budget paused the walk), so this inventory may be missing or misreporting drafts');
      }
    }

    // ── Per-id / per-key lifecycle ─────────────────────────────────────────
    const requested: Array<Record<string, unknown>> = [];
    if (targets.length > 0) {
      // Resolve keys to ids first so a key and a bare id naming the SAME
      // message are probed once, not twice.
      const resolved = new Map<string, { currentId: number; ids: number[] } | null>();
      for (const t of targets) {
        if (t.kind === 'draftKey' && !resolved.has(t.draftKey)) {
          resolved.set(t.draftKey, await resolveDraftKey(cache, t.draftKey));
        }
      }
      const toProbe = new Set<number>();
      for (const t of targets) {
        if (t.kind === 'id') toProbe.add(t.id);
        else {
          const chain = resolved.get(t.draftKey);
          if (chain !== null && chain !== undefined) toProbe.add(chain.currentId);
        }
      }
      const probed = await probeIds(client, cache, [...toProbe], { allowMarkRead });
      probeRequests += probed.requests;
      const probes = new Map(probed.items.map((item) => [item.id, item]));

      for (const t of targets) {
        if (t.kind === 'id') {
          requested.push(decorate(probes.get(t.id) as LifecycleItem));
          continue;
        }
        const chain = resolved.get(t.draftKey);
        if (chain === null || chain === undefined) {
          requested.push({
            draftKey: t.draftKey,
            state: 'unknown',
            error: 'UNKNOWN_DRAFT_KEY',
            note: 'This draftKey has never been recorded in the local cache, so it cannot be resolved to a message id. Draft keys are minted by ofw_save_draft; a cache rebuilt or opened on another machine will not know an older key.',
          });
          continue;
        }
        requested.push({
          draftKey: t.draftKey,
          currentId: chain.currentId,
          previousIds: chain.ids.slice(0, -1),
          ...decorate(probes.get(chain.currentId) as LifecycleItem),
        });
      }

      for (const entry of requested) {
        if (entry.skipped === true || entry.error !== undefined || entry.state === 'unknown') {
          incomplete.push(`id/key ${String(entry.draftKey ?? entry.id)} could not be resolved to a confirmed live state`);
        }
      }
    }

    if (truncated > 0) {
      incomplete.push(`${truncated} of ${allTargets.length} requested ids/draftKeys were not probed (per-call cap of ${MAX_FRESHNESS_IDS})`);
    }

    const complete = incomplete.length === 0;
    return jsonResponse({
      checkedAt: new Date().toISOString(),
      probeRequests,
      ...(drafts !== undefined ? { drafts, draftCount: drafts.length, draftInventoryComplete: inventoryComplete } : {}),
      ...(requested.length > 0 ? { requested } : {}),
      complete,
      ...(complete
        ? {}
        : { incompleteReasons: incomplete, note: 'complete:false — this snapshot is NOT a verified statement of current state. Do not report a draft count or say whether something was sent from it; resolve the reasons above (usually by calling ofw_sync_messages, or re-calling with allowMarkRead:true) and ask again.' }),
      ...(inventoryFreshness !== undefined ? { freshness: inventoryFreshness } : {}),
    });
  });
}

/**
 * Add the derived fields a status entry wants on top of a raw lifecycle probe.
 * `sentMessageId` names the id the message ended up as once sent — the answer to
 * "the draft I was editing went where?" — and only exists for a `sent` verdict.
 */
function decorate(item: LifecycleItem): Record<string, unknown> {
  return item.state === 'sent' ? { ...item, sentMessageId: item.id } : { ...item };
}

// OFW's bulk-delete endpoint takes a multipart form with `messageIds`.
// Used by both ofw_delete_draft and ofw_send_message (draft cleanup).
async function deleteOFWMessages(client: OFWClient, ids: number[]): Promise<unknown> {
  const form = new FormData();
  for (const id of ids) form.append('messageIds', String(id));
  return client.request('DELETE', '/pub/v1/messages', form);
}
