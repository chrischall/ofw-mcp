import type { OFWClient } from './client.js';
import type {
  CacheStore,
  MessageRow, DraftRow, FolderName,
} from './cache/store.js';
import { z } from 'zod';
import { ApiRecipientSchema, hasRealView, mapRecipients } from './tools/_shared.js';
import { parseLenient } from '@chrischall/mcp-utils';

// Each OFW message detail returns `files: [fileId, ...]`. We fetch the metadata
// for each file id (cheap JSON call) so the model can see filenames/mime types
// without downloading bytes. Bytes are pulled lazily by ofw_download_attachment.

// All sync-path schemas are validated LENIENT (issue #83): a mismatch logs a
// structured warning to stderr and the raw response flows on through the
// existing `??` fallbacks — a small OFW backend change degrades gracefully
// instead of bricking sync, but no longer silently. Loose objects keep
// unknown keys, so cached `metadata`/`listData` blobs stay verbatim.
const FileMetaSchema = z.looseObject({
  fileId: z.number(),
  label: z.string().optional(),
  fileName: z.string().optional(),
  fileType: z.string().optional(),   // MIME
  fileSize: z.number().optional(),
});

// Fetches OFW attachment metadata for one file id and writes it to the cache.
// Throws on network/HTTP errors — callers in bulk-sync paths wrap this in the
// best-effort helper below; callers that need the result (download tool) let
// the throw propagate.
export async function fetchAttachmentMeta(
  client: OFWClient,
  fileId: number,
  messageId: number,
  store: CacheStore,
): Promise<void> {
  const meta = parseLenient(
    FileMetaSchema,
    await client.request('GET', `/pub/v1/myfiles/${fileId}`),
    { label: 'ofw-mcp', context: 'GET /pub/v1/myfiles/{fileId}' },
  );
  await store.upsertAttachmentForMessage({
    fileId: meta.fileId ?? fileId,
    fileName: meta.fileName ?? `file-${fileId}`,
    label: meta.label ?? meta.fileName ?? `file-${fileId}`,
    mimeType: meta.fileType ?? 'application/octet-stream',
    sizeBytes: typeof meta.fileSize === 'number' ? meta.fileSize : null,
    metadata: meta,
    messageId,
  });
}

export async function fetchAttachmentMetaForMessage(
  client: OFWClient,
  messageId: number,
  fileIds: number[],
  store: CacheStore,
): Promise<void> {
  // Fan out in parallel — each fetch is independent and the file id stays
  // in listData on failure (model can retry via ofw_download_attachment,
  // which surfaces the real error). Promise.allSettled so one bad
  // attachment doesn't break the surrounding sync.
  await Promise.allSettled(fileIds.map((fid) => fetchAttachmentMeta(client, fid, messageId, store)));
}

/**
 * A per-invocation OFW-request budget. `take()` consumes one unit and returns
 * `false` once the budget is exhausted, at which point the caller must stop
 * making requests and record a resume position.
 */
export interface Budget {
  take(): boolean;
}

/**
 * Build a {@link Budget} that allows `max` requests. `Number.POSITIVE_INFINITY`
 * (the local-stdio default) never exhausts — `take()` always returns true — so
 * bounded logic collapses to the original unbounded walk.
 */
export function makeBudget(max: number): Budget {
  let remaining = max;
  return {
    take(): boolean {
      if (remaining <= 0) return false;
      remaining -= 1;
      return true;
    },
  };
}

// Budget-gated attachment-meta backfill. Spends one unit per file id it can
// afford (in order), skipping the rest, then fetches the affordable ones with
// the existing best-effort parallel helper. Attachment fetches are best-effort:
// a skipped file id stays in the message's listData and can be backfilled later
// by ofw_get_message. Under an infinite budget this fetches every file id — the
// unbounded behaviour.
async function fetchAttachmentMetaBudgeted(
  client: OFWClient,
  messageId: number,
  fileIds: number[],
  store: CacheStore,
  budget: Budget,
): Promise<void> {
  const affordable: number[] = [];
  for (const fid of fileIds) {
    if (!budget.take()) break;
    affordable.push(fid);
  }
  if (affordable.length > 0) {
    await fetchAttachmentMetaForMessage(client, messageId, affordable, store);
  }
}

export interface FolderIds {
  inbox: string;
  sent: string;
  drafts: string;
}

const FoldersSchema = z.looseObject({
  systemFolders: z.array(z.looseObject({ id: z.string(), folderType: z.string() })).optional(),
});

export async function resolveFolderIds(client: OFWClient, store: CacheStore): Promise<FolderIds> {
  const data = parseLenient(
    FoldersSchema,
    await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true'),
    { label: 'ofw-mcp', context: 'GET /pub/v1/messageFolders' },
  );
  const sys = data.systemFolders ?? [];
  const find = (type: string): string => {
    const f = sys.find((x) => x.folderType === type);
    if (!f) throw new Error(`OFW system folder not found: ${type}`);
    return f.id;
  };
  const ids: FolderIds = {
    inbox: find('INBOX'),
    sent: find('SENT_MESSAGES'),
    drafts: find('DRAFTS'),
  };
  await store.setMeta('drafts_folder_id', ids.drafts);
  // Persist the sent folder id too: ofw_get_message's live-fetch path uses it to
  // label an uncached message sent-vs-inbox from the detail payload's own folder
  // id, instead of hard-defaulting to inbox.
  await store.setMeta('sent_folder_id', ids.sent);
  return ids;
}

// Required fields are the ones the sync loop reads unguarded (id keys the
// cache; showNeverViewed drives unread semantics — per CLAUDE.md it's the
// only reliable unread indicator, so its disappearance must warn loudly).
const ListItemSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  date: z.looseObject({ dateTime: z.string() }),
  from: z.looseObject({ name: z.string().optional() }).optional(),
  showNeverViewed: z.boolean(),
  recipients: z.array(ApiRecipientSchema).optional(),
});
type ListItem = z.infer<typeof ListItemSchema>;

const ListResponseSchema = z.looseObject({ data: z.array(ListItemSchema).optional() });
const DetailResponseSchema = z.looseObject({
  body: z.string().optional(),
  files: z.array(z.number()).optional(),
  // The detail endpoint carries the REAL recipient view timestamps (the list
  // endpoint only has an epoch placeholder) — used by the view-status refresh.
  recipients: z.array(ApiRecipientSchema).optional(),
});

export interface UnreadHint {
  id: number;
  subject: string;
  from: string;
  sentAt: string;
}

export interface MessageSyncResult {
  synced: number;
  unread: UnreadHint[];
  /** True when the folder walk completed within budget; false when it paused. */
  done: boolean;
}

interface WalkTotals {
  synced: number;
  unread: UnreadHint[];
  /** Highest message id seen on the pages this walk actually fetched. */
  newestId: number | null;
}

/**
 * Outcome of one contiguous page walk. `nextPage` is where a follow-up walk
 * should pick up; `null` (only possible when `done`) means OFW returned an
 * empty page, so history is exhausted and there is nothing left below.
 */
type WalkResult = WalkTotals & (
  | { done: false; nextPage: number }
  | { done: true; nextPage: number | null }
);

const maxId = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/**
 * Walk one folder's list pages from `startPage` toward older messages, caching
 * what isn't cached yet. Stops on an empty page, when `stopAtCachedPage` says
 * we've reached cached history, or when the request budget runs out.
 */
async function walkPages(
  client: OFWClient,
  folder: 'inbox' | 'sent',
  folderId: string,
  opts: {
    startPage: number;
    /**
     * True (FORWARD pass) — stop at the first page holding no new messages.
     * OFW sorts date-desc, so such a page is where cached history begins and
     * everything below it is already known.
     *
     * False (BACKFILL pass) — walk until OFW returns an empty page. A backfill
     * runs below cached history by construction, so "this page is all cached"
     * says nothing about whether older messages remain underneath it; stopping
     * there would orphan them and report a false completion.
     */
    stopAtCachedPage: boolean;
    fetchUnreadBodies: boolean;
    budget: Budget;
  },
  store: CacheStore,
): Promise<WalkResult> {
  const budget = opts.budget;
  let page = opts.startPage;
  let newestId: number | null = null;
  let synced = 0;
  const unread: UnreadHint[] = [];

  while (true) {
    // One unit per list-page fetch. Out of budget → pause and resume at `page`.
    if (!budget.take()) {
      return { synced, unread, newestId, done: false, nextPage: page };
    }
    const path = `/pub/v3/messages?folders=${encodeURIComponent(folderId)}&page=${page}&size=50&sort=date&sortDirection=desc`;
    const list = parseLenient(
      ListResponseSchema,
      await client.request('GET', path),
      { label: 'ofw-mcp', context: `GET /pub/v3/messages?folders={${folder}}` },
    );
    const items = list.data ?? [];
    if (items.length === 0) {
      return { synced, unread, newestId, done: true, nextPage: null };
    }

    // One batch read of this page's ids (S1) instead of a per-item getMessage.
    const existingById = new Map(
      (await store.getMessages(items.map((it) => it.id))).map((row) => [row.id, row]),
    );
    // Rows created/updated this page, flushed in ONE batch upsert (S1).
    const toUpsert: MessageRow[] = [];
    let pageHadNewItem = false;
    let pageBudgetHit = false;

    for (const item of items) {
      if (newestId === null || item.id > newestId) newestId = item.id;
      const existing = existingById.get(item.id);
      if (existing) {
        // A sent message's read status changes AFTER it's first cached, when
        // the recipient opens it — so we can't just skip existing rows. The
        // list item carries the reliable `showNeverViewed` boolean but only an
        // epoch placeholder for the timestamp; the real "First Viewed" time is
        // on the detail endpoint. So when a sent message has flipped to read
        // and we don't yet hold a real viewed time, re-fetch detail to capture
        // it (no body re-fetch — only the recipient view fields can change).
        if (folder === 'sent' && item.showNeverViewed === false && !hasRealView(existing.recipients)) {
          if (!budget.take()) { pageBudgetHit = true; break; }
          const detail = parseLenient(
            DetailResponseSchema,
            await client.request('GET', `/pub/v3/messages/${item.id}`),
            { label: 'ofw-mcp', context: 'GET /pub/v3/messages/{id} (view-status refresh)' },
          );
          toUpsert.push({ ...existing, recipients: mapRecipients(detail.recipients), listData: item });
          synced++;
        }
        continue;
      }
      pageHadNewItem = true;

      const isInboxUnread = folder === 'inbox' && item.showNeverViewed === true;
      const shouldFetchBody = !isInboxUnread || opts.fetchUnreadBodies;

      let body: string | null = null;
      let fetchedBodyAt: string | null = null;
      let detailFileIds: number[] = [];
      // Prefer the DETAIL endpoint's recipients when we fetch it: the list only
      // ever carries an epoch placeholder for `viewed.dateTime` (even on a read
      // message), while detail carries the real "First Viewed" time. Building
      // the row from the list would cache viewedAt:null for a message that was
      // already read by the time we first saw it — reporting "never viewed" for
      // a message OFW shows as read, until a later sync's refresh healed it.
      let detailRecipients: ListItem['recipients'];
      if (shouldFetchBody) {
        if (!budget.take()) { pageBudgetHit = true; break; }
        const detail = parseLenient(
          DetailResponseSchema,
          await client.request('GET', `/pub/v3/messages/${item.id}`),
          { label: 'ofw-mcp', context: 'GET /pub/v3/messages/{id} (sync)' },
        );
        body = detail.body ?? '';
        fetchedBodyAt = new Date().toISOString();
        detailRecipients = detail.recipients;
        if (Array.isArray(detail.files) && detail.files.length > 0) {
          detailFileIds = detail.files;
        }
      } else {
        unread.push({
          id: item.id,
          subject: item.subject,
          from: item.from?.name ?? '',
          sentAt: item.date.dateTime,
        });
      }

      const row: MessageRow = {
        id: item.id,
        folder,
        subject: item.subject ?? '(no subject)',
        fromUser: item.from?.name ?? '',
        sentAt: item.date?.dateTime ?? new Date().toISOString(),
        recipients: mapRecipients(detailRecipients ?? item.recipients),
        body,
        fetchedBodyAt,
        replyToId: null,
        chainRootId: null,
        listData: item,
      };
      toUpsert.push(row);
      synced++;
      if (detailFileIds.length > 0) {
        await fetchAttachmentMetaBudgeted(client, item.id, detailFileIds, store, budget);
      }
    }

    // Flush the page's rows in one transaction/RPC. Empty array is a no-op.
    await store.upsertMessages(toUpsert);

    if (pageBudgetHit) {
      // Paused mid-page. Resume at THIS page: the partial rows are cached, so
      // getMessages skips them next time and upserts are idempotent.
      return { synced, unread, newestId, done: false, nextPage: page };
    }

    // Reached cached history (see `stopAtCachedPage`). Report THIS page as the
    // resume point rather than the next one: it costs one redundant (cheap,
    // all-cached) fetch if a backfill later starts here, and it cannot skip a
    // message the way an off-by-one `page + 1` could.
    if (opts.stopAtCachedPage && !pageHadNewItem) {
      return { synced, unread, newestId, done: true, nextPage: page };
    }
    page++;
  }
}

/**
 * Sync one message folder. Runs two independent passes so that a long backfill
 * can never starve new messages:
 *
 *  1. FORWARD — always from page 1, every call, regardless of how deep a
 *     backfill is parked. This is what guarantees a message sent or received
 *     since the last sync is cached by the next ordinary call. Once caught up
 *     it costs a single request: page 1 holds nothing new, so it stops there.
 *  2. BACKFILL — resumes the parked cursor (or, for `deep`, walks past where
 *     the forward pass stopped) with whatever budget the forward pass left,
 *     and re-parks the cursor if it pauses again.
 *
 * Both passes share one budget, and the forward pass draws first: the newest
 * messages are the ones a caller is most likely to need, and history that has
 * waited months can wait one more call.
 */
export async function syncMessageFolder(
  client: OFWClient,
  folder: 'inbox' | 'sent',
  folderId: string,
  opts: { fetchUnreadBodies: boolean; deep?: boolean; budget?: Budget },
  store: CacheStore,
): Promise<MessageSyncResult> {
  // No budget → unbounded (local stdio): every take() succeeds, so an ordinary
  // sync is byte-for-byte the original unbounded walk (forward pass only).
  const budget = opts.budget ?? makeBudget(Number.POSITIVE_INFINITY);
  const saved = await store.getSyncState(folder);
  const savedResume = saved?.resumePage ?? null;

  const fwd = await walkPages(client, folder, folderId, {
    startPage: 1,
    stopAtCachedPage: true,
    fetchUnreadBodies: opts.fetchUnreadBodies,
    budget,
  }, store);

  let synced = fwd.synced;
  const unread = [...fwd.unread];
  // Never regress the folder's newest id: a pass that only walked cached pages
  // still saw page 1, but a paused one may not have.
  let newestId = maxId(saved?.newestId ?? null, fwd.newestId);
  let done: boolean;
  let resumePage: number | null;

  if (!fwd.done) {
    // The forward pass itself ran out of budget, so it never reached cached
    // history — everything from `fwd.nextPage` down is unverified. Park the
    // backfill at whichever cursor is higher up the folder, so no page that
    // still owes us messages ends up above the resume point.
    done = false;
    resumePage = savedResume === null ? fwd.nextPage : Math.min(fwd.nextPage, savedResume);
  } else if (fwd.nextPage === null) {
    // The forward pass walked clean off the end of the folder — by definition
    // there is no older history left to backfill.
    done = true;
    resumePage = null;
  } else if (savedResume === null && !opts.deep) {
    // Ordinary incremental sync with no backfill parked: caught up.
    done = true;
    resumePage = null;
  } else {
    const bf = await walkPages(client, folder, folderId, {
      startPage: savedResume ?? fwd.nextPage,
      stopAtCachedPage: false,
      fetchUnreadBodies: opts.fetchUnreadBodies,
      budget,
    }, store);
    synced += bf.synced;
    unread.push(...bf.unread);
    newestId = maxId(newestId, bf.newestId);
    done = bf.done;
    resumePage = bf.done ? null : bf.nextPage;
  }

  await store.setSyncState(folder, {
    lastSyncAt: new Date().toISOString(),
    newestId,
    resumePage,
  });

  return { synced, unread, done };
}

const DraftListItemSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  date: z.looseObject({ dateTime: z.string() }),
  replyToId: z.number().nullable().optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
});
type DraftListItem = z.infer<typeof DraftListItemSchema>;

const DraftListResponseSchema = z.looseObject({ data: z.array(DraftListItemSchema).optional() });
const DraftDetailSchema = z.looseObject({
  body: z.string().optional(),
  subject: z.string().optional(),
});

export interface DraftSyncResult {
  synced: number;
  /** True when the full drafts walk + reconciliation ran; false when deferred. */
  done: boolean;
}

export async function syncDrafts(
  client: OFWClient,
  draftsFolderId: string,
  store: CacheStore,
  budget?: Budget,
): Promise<DraftSyncResult> {
  // No budget → unbounded (local stdio): identical to the original walk.
  const b = budget ?? makeBudget(Number.POSITIVE_INFINITY);

  // The reconciliation step below DELETES any cached draft not seen in the
  // listing, so a partial walk must apply NOTHING. We therefore buffer the
  // entire walk (all list pages + every detail) BEFORE touching the cache: if
  // the budget can't fund the whole walk we discard the buffer and defer the
  // drafts folder to a later call (done:false). The OFW requests already spent
  // still count against the budget; drafts are few, so a discarded partial is
  // cheap and — crucially — never evicts a real draft.
  const items: DraftListItem[] = [];
  let page = 1;
  while (true) {
    if (!b.take()) return { synced: 0, done: false };
    const path = `/pub/v3/messages?folders=${encodeURIComponent(draftsFolderId)}&page=${page}&size=50&sort=date&sortDirection=desc`;
    const list = parseLenient(
      DraftListResponseSchema,
      await client.request('GET', path),
      { label: 'ofw-mcp', context: 'GET /pub/v3/messages?folders={drafts}' },
    );
    const pageItems = list.data ?? [];
    items.push(...pageItems);
    if (pageItems.length < 50) break;
    page++;
  }

  // Fetch every draft's detail up front, still buffered. OFW's list
  // `date.dateTime` is NOT a reliable modification timestamp for drafts —
  // direct UI edits don't bump it — so we can't skip the detail fetch.
  const rows: DraftRow[] = [];
  for (const item of items) {
    if (!b.take()) return { synced: 0, done: false };
    const detail = parseLenient(
      DraftDetailSchema,
      await client.request('GET', `/pub/v3/messages/${item.id}`),
      { label: 'ofw-mcp', context: 'GET /pub/v3/messages/{id} (drafts sync)' },
    );
    rows.push({
      id: item.id,
      subject: detail.subject ?? item.subject ?? '(no subject)',
      body: detail.body ?? '',
      recipients: mapRecipients(item.recipients),
      replyToId: item.replyToId ?? null,
      modifiedAt: item.date?.dateTime ?? new Date().toISOString(),
      listData: item,
    });
  }

  // Budget funded the whole walk — apply atomically. Batch reads (S1) snapshot
  // pre-upsert state for the synced-count comparison and stale-row eviction.
  const ids = items.map((it) => it.id);
  const existingById = new Map((await store.getDrafts(ids)).map((d) => [d.id, d]));
  await store.upsertDrafts(rows);

  // If a stale `messages` row exists for a draft id (cached by a prior
  // ofw_get_message call before the drafts table knew about this id), evict it.
  // The drafts table is the source of truth for drafts.
  for (const stale of await store.getMessages(ids)) {
    await store.deleteMessage(stale.id);
  }

  let synced = 0;
  for (const row of rows) {
    const existing = existingById.get(row.id);
    if (!existing
        || existing.body !== row.body
        || existing.subject !== row.subject
        || existing.replyToId !== row.replyToId) {
      synced++;
    }
  }

  const seenIds = new Set(ids);
  for (const id of await store.listDraftIds()) {
    if (!seenIds.has(id)) await store.deleteDraft(id);
  }

  return { synced, done: true };
}

export interface SyncAllOptions {
  folders?: FolderName[];
  fetchUnreadBodies?: boolean;
  deep?: boolean;
  /**
   * Max OFW requests this whole invocation may make (resolveFolderIds + list
   * pages + detail + attachment-meta fetches share the budget). Omit / Infinity
   * → unbounded (local stdio). A bounded call pauses when spent and reports
   * `done: false` so the caller resumes the backfill (deep or not) next time.
   */
  maxRequests?: number;
}

export interface SyncAllResult {
  synced: Partial<Record<FolderName, number>>;
  unreadInbox: UnreadHint[];
  /** True only when every requested folder completed within the budget. */
  done: boolean;
  note?: string;
}

export async function syncAll(client: OFWClient, opts: SyncAllOptions, store: CacheStore): Promise<SyncAllResult> {
  const folders = opts.folders ?? ['inbox', 'sent', 'drafts'];
  // ONE budget shared across resolveFolderIds and every requested folder, in
  // order — so the whole invocation stays under the hosting subrequest cap.
  const budget = makeBudget(opts.maxRequests ?? Number.POSITIVE_INFINITY);
  // resolveFolderIds always makes exactly one request; the tool guarantees
  // maxRequests >= 1, so this unit is always available (result intentionally
  // ignored — we account for it without a branch that can't be reached).
  budget.take();
  const ids = await resolveFolderIds(client, store);
  const synced: Partial<Record<FolderName, number>> = {};
  let unreadInbox: UnreadHint[] = [];
  let done = true;

  for (const folder of folders) {
    if (folder === 'inbox') {
      const r = await syncMessageFolder(client, 'inbox', ids.inbox, {
        fetchUnreadBodies: opts.fetchUnreadBodies ?? false,
        deep: opts.deep ?? false,
        budget,
      }, store);
      synced.inbox = r.synced;
      unreadInbox = r.unread;
      if (!r.done) done = false;
    } else if (folder === 'sent') {
      const r = await syncMessageFolder(client, 'sent', ids.sent, {
        fetchUnreadBodies: false,
        deep: opts.deep ?? false,
        budget,
      }, store);
      synced.sent = r.synced;
      if (!r.done) done = false;
    } else if (folder === 'drafts') {
      const r = await syncDrafts(client, ids.drafts, store, budget);
      synced.drafts = r.synced;
      if (!r.done) done = false;
    }
  }

  const notes: string[] = [];
  if (unreadInbox.length > 0) {
    notes.push(`${unreadInbox.length} unread inbox messages cached without bodies. Call ofw_get_message(id) to read them — this will mark them as read on OFW.`);
  }
  if (!done) {
    notes.push('Paused after the request budget to stay within the hosting limit; more pages remain — call ofw_sync_messages again with the same arguments to resume where it left off and continue the backfill.');
  }
  const note = notes.length > 0 ? notes.join('\n\n') : undefined;

  return { synced, unreadInbox, done, ...(note ? { note } : {}) };
}
