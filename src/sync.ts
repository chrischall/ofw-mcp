import type { OFWClient } from './client.js';
import { clearHeldFiles, getHeldFiles, setHeldFiles } from './tools/held-attachments.js';
import type {
  CacheStore,
  MessageRow, DraftRow, FolderName,
} from './cache/store.js';
import { z } from 'zod';
import { ApiRecipientSchema, hasRealView, mapRecipients, scrapeSaysRead, threadedReplyTo } from './tools/_shared.js';
import { senderOf } from './tools/project.js';
import { parseLenient } from '@chrischall/mcp-utils';
import { displayTimeZone, nowNaiveWallClock, parseTimestampValue } from './timestamps.js';
import { readingBlockedToday } from './read-days.js';

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
  // And inbox, which completes the map a lifecycle probe needs to turn a detail
  // payload's own folder id into "draft" / "sent" / "received" (see
  // tools/lifecycle.ts). Without all three, a probe can only say "unknown".
  await store.setMeta('inbox_folder_id', ids.inbox);
  return ids;
}

// Required fields are the ones the sync loop reads unguarded (id keys the
// cache; showNeverViewed is the SENT folder's read signal, so its
// disappearance must warn loudly). `read` is the INBOX list's own read flag —
// the only inbox read evidence (see scrapeSaysRead). It stays optional because
// sent items need not carry it, and a missing inbox `read` already fails
// closed to "unread", which is the safe answer.
const ListItemSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  date: z.looseObject({ dateTime: z.string() }),
  from: z.looseObject({ name: z.string().optional() }).optional(),
  showNeverViewed: z.boolean(),
  read: z.boolean().optional(),
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

/**
 * A new inbox message that was UNREAD per the list when this sync first saw
 * it — the state BEFORE the sync touched anything. `bodyFetched` says whether
 * this call then opened it (only ever under fetchUnreadBodies, which is also
 * reported in `markedRead`); `false` means it is still unread on OFW.
 */
export interface UnreadHint {
  id: number;
  subject: string;
  from: string;
  sentAt: string;
  bodyFetched: boolean;
}

/** A message first cached by THIS sync, inbox or sent, read or unread. */
export interface NewMessageHint {
  id: number;
  folder: 'inbox' | 'sent';
  /** The sender's name, or null when OFW named none (never a guessed ''). */
  from: string | null;
  subject: string;
  sentAt: string;
  /** Read state per the LIST, before this sync touched it (scrapeSaysRead). */
  read: boolean;
  /** Whether this sync fetched its body. */
  bodyFetched: boolean;
}

/**
 * An inbox message this sync marked READ on OurFamilyWizard by fetching its
 * detail. `fetchUnreadBodies` = the caller asked for it; `unexpected` = the
 * detail's own view time shows our fetch stamped a message the list called
 * read (see stampedByFetch) — the belt-and-braces check that makes a leak in
 * the read-state rule visible instead of silent.
 */
export interface MarkedReadHint {
  id: number;
  subject: string;
  from: string | null;
  sentAt: string;
  /** The view time OFW reported after the fetch, or null when it echoed none. */
  viewedAt: string | null;
  reason: 'fetchUnreadBodies' | 'unexpected';
}

/**
 * How far BEFORE the request start a detail's view time may fall and still
 * count as stamped by that request. OFW reports view times to the second
 * (truncation costs up to 1 s) and its clock is not ours; 2 s absorbs both
 * without blaming us for a view that genuinely happened earlier.
 */
export const STAMP_TOLERANCE_MS = 2000;

/**
 * True when `viewedAt` (OFW's naive wall clock, read in DISPLAY_TZ like every
 * other OFW time) is at or after `startedAtMs` less STAMP_TOLERANCE_MS — i.e.
 * the fetch that began at `startedAtMs` is what stamped it. A missing or
 * unparseable time is not evidence. If DISPLAY_TZ does not match the
 * account's zone the comparison is off by the offset; this check is a
 * backstop for the read-state rule, never a substitute for it.
 */
export function stampedByFetch(viewedAt: string | null, startedAtMs: number): boolean {
  if (viewedAt === null) return false;
  const at = parseTimestampValue('viewedAt', viewedAt, displayTimeZone());
  return at !== null && at.getTime() >= startedAtMs - STAMP_TOLERANCE_MS;
}

/** The latest real (non-placeholder) view time on a detail's recipients. */
export function latestViewedAt(recipients: ListItem['recipients']): string | null {
  const times = mapRecipients(recipients).map((r) => r.viewedAt).filter((t): t is string => t !== null);
  return times.length === 0 ? null : times.sort().at(-1)!;
}

export interface MessageSyncResult {
  synced: number;
  unread: UnreadHint[];
  /** Every message first cached by this call (unsorted, uncapped). */
  newMessages: NewMessageHint[];
  /** Inbox messages this call marked read on OFW (see MarkedReadHint). */
  markedRead: MarkedReadHint[];
  /** True when the folder walk completed within budget; false when it paused. */
  done: boolean;
  /**
   * True when the FORWARD pass completed, i.e. this folder was actually
   * compared against OFW down to cached history. Distinct from `done`: a call
   * can verify the present (`verified: true`) while still owing old history
   * (`done: false`). Only `verified` licenses reporting the folder as
   * refreshed — a paused forward pass never reached cached history, so its
   * `synced` count is "what we applied", not "what changed on the server".
   */
  verified: boolean;
}

interface WalkTotals {
  synced: number;
  unread: UnreadHint[];
  newMessages: NewMessageHint[];
  markedRead: MarkedReadHint[];
  /** Highest message id seen on the pages this walk actually fetched. */
  newestId: number | null;
  /**
   * How many list pages this walk actually fetched. Zero means the budget was
   * already spent when it started, so the walk observed NOTHING about the
   * folder — distinct from "fetched a page and found it all cached". Callers
   * must not draw conclusions (or move persisted cursors) from a zero-page
   * walk; see the resume-cursor logic in syncMessageFolder.
   */
  pagesFetched: number;
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
    /**
     * False on a no-read day (see read-days.ts): make NO detail request for any
     * message, read or unread. A detail GET downloads the body even when we
     * throw it away, and that is the content the day forbids. Rows are cached
     * from the list payload alone (body null), and the next sync on a reading
     * day fills the bodies in — see the heal path below.
     */
    fetchBodies: boolean;
    budget: Budget;
  },
  store: CacheStore,
): Promise<WalkResult> {
  const budget = opts.budget;
  let page = opts.startPage;
  let newestId: number | null = null;
  let synced = 0;
  let pagesFetched = 0;
  const unread: UnreadHint[] = [];
  const newMessages: NewMessageHint[] = [];
  const markedRead: MarkedReadHint[] = [];
  const totals = (): WalkTotals => ({ synced, unread, newMessages, markedRead, newestId, pagesFetched });

  /**
   * GET one message's detail. For an INBOX message, compare the view time OFW
   * now reports with when the request began: a view at/after it means this
   * fetch stamped "First Viewed", and that is reported, never silent.
   * `deliberate` = the caller asked for unread bodies, so it is reported
   * whatever the echo says.
   */
  const fetchDetail = async (item: ListItem, row: Pick<MessageRow, 'subject' | 'sentAt'> & { from: string | null }, context: string, deliberate: boolean) => {
    const startedAt = Date.now();
    const detail = parseLenient(
      DetailResponseSchema,
      await client.request('GET', `/pub/v3/messages/${item.id}`),
      { label: 'ofw-mcp', context },
    );
    if (folder === 'inbox') {
      const viewedAt = latestViewedAt(detail.recipients);
      if (deliberate || stampedByFetch(viewedAt, startedAt)) {
        markedRead.push({
          id: item.id, subject: row.subject, from: row.from, sentAt: row.sentAt, viewedAt,
          reason: deliberate ? 'fetchUnreadBodies' : 'unexpected',
        });
      }
    }
    return detail;
  };

  while (true) {
    // One unit per list-page fetch. Out of budget → pause and resume at `page`.
    if (!budget.take()) {
      return { ...totals(), done: false, nextPage: page };
    }
    const path = `/pub/v3/messages?folders=${encodeURIComponent(folderId)}&page=${page}&size=50&sort=date&sortDirection=desc`;
    const list = parseLenient(
      ListResponseSchema,
      await client.request('GET', path),
      { label: 'ofw-mcp', context: `GET /pub/v3/messages?folders={${folder}}` },
    );
    pagesFetched++;
    const items = list.data ?? [];
    if (items.length === 0) {
      return { ...totals(), done: true, nextPage: null };
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
      // Read per the LIST, before we touch anything. For inbox that is the
      // list's own `read === true` and nothing else: `showNeverViewed` on the
      // inbox list is the sender-side badge and reads false on a message we
      // never opened, so trusting it fetched — and stamped — unread bodies.
      // Missing/non-boolean `read` fails closed to unread (scrapeSaysRead).
      const listRead = scrapeSaysRead(folder, item);
      const isInboxUnread = folder === 'inbox' && !listRead;
      if (existing) {
        // Heal a row cached without its body — typically one listed on a
        // no-read day — once fetching it can stamp nothing: a sent message, or
        // an inbox message OFW's list reports as read. An unread inbox body
        // stays the caller's explicit choice (ofw_get_message), as before.
        if (opts.fetchBodies && existing.body === null && !isInboxUnread) {
          if (!budget.take()) { pageBudgetHit = true; break; }
          const detail = await fetchDetail(
            item, { subject: existing.subject, sentAt: existing.sentAt, from: senderOf(existing) },
            'GET /pub/v3/messages/{id} (body backfill)', false,
          );
          toUpsert.push({
            ...existing,
            body: detail.body ?? '',
            fetchedBodyAt: new Date().toISOString(),
            recipients: mapRecipients(detail.recipients ?? item.recipients),
            listData: item,
          });
          synced++;
          // Counts as new: a forward pass must keep walking past a page it
          // still had work on, or older withheld rows would never be reached.
          pageHadNewItem = true;
          if (Array.isArray(detail.files) && detail.files.length > 0) {
            await fetchAttachmentMetaBudgeted(client, item.id, detail.files, store, budget);
          }
          continue;
        }
        // A sent message's read status changes AFTER it's first cached, when
        // the recipient opens it — so we can't just skip existing rows. The
        // list item carries the reliable `showNeverViewed` boolean but only an
        // epoch placeholder for the timestamp; the real "First Viewed" time is
        // on the detail endpoint. So when a sent message has flipped to read
        // and we don't yet hold a real viewed time, re-fetch detail to capture
        // it (no body re-fetch — only the recipient view fields can change).
        if (opts.fetchBodies && folder === 'sent' && item.showNeverViewed === false && !hasRealView(existing.recipients)) {
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

      const shouldFetchBody = opts.fetchBodies && (!isInboxUnread || opts.fetchUnreadBodies);

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
      // The row as the list describes it; the detail (if fetched) fills in
      // body and real view times below.
      const row: MessageRow = {
        id: item.id,
        folder,
        subject: item.subject ?? '(no subject)',
        fromUser: item.from?.name ?? '',
        sentAt: item.date?.dateTime ?? nowNaiveWallClock(),
        recipients: mapRecipients(item.recipients),
        body: null,
        fetchedBodyAt: null,
        replyToId: null,
        chainRootId: null,
        listData: item,
      };
      const from = senderOf(row);
      if (shouldFetchBody) {
        if (!budget.take()) { pageBudgetHit = true; break; }
        // Reached for an unread inbox message only under fetchUnreadBodies.
        const detail = await fetchDetail(item, { subject: row.subject, sentAt: row.sentAt, from }, 'GET /pub/v3/messages/{id} (sync)', isInboxUnread);
        body = detail.body ?? '';
        fetchedBodyAt = new Date().toISOString();
        detailRecipients = detail.recipients;
        if (Array.isArray(detail.files) && detail.files.length > 0) {
          detailFileIds = detail.files;
        }
      }
      if (isInboxUnread) {
        // Pre-sync state: listed even when fetchUnreadBodies then opened it.
        unread.push({
          id: item.id,
          subject: item.subject,
          from: from ?? '',
          sentAt: item.date.dateTime,
          bodyFetched: shouldFetchBody,
        });
      }
      newMessages.push({
        id: item.id, folder, from, subject: row.subject, sentAt: row.sentAt,
        read: listRead, bodyFetched: shouldFetchBody,
      });

      row.body = body;
      row.fetchedBodyAt = fetchedBodyAt;
      if (detailRecipients) row.recipients = mapRecipients(detailRecipients);
      toUpsert.push(row);
      synced++;
      if (detailFileIds.length > 0) {
        await fetchAttachmentMetaBudgeted(client, item.id, detailFileIds, store, budget);
      }
    }

    // Flush the page's rows in one transaction/RPC. Skipped entirely when the
    // page held nothing new: where the cache is remote this call is a round
    // trip, counting against the same subrequest budget as an OFW fetch.
    // A deep re-walk crosses page after page of already-cached messages, so an
    // unconditional "no-op" write spends the caller's budget to store nothing.
    if (toUpsert.length > 0) await store.upsertMessages(toUpsert);

    if (pageBudgetHit) {
      // Paused mid-page. Resume at THIS page: the partial rows are cached, so
      // getMessages skips them next time and upserts are idempotent.
      return { ...totals(), done: false, nextPage: page };
    }

    // Reached cached history (see `stopAtCachedPage`). Report THIS page as the
    // resume point rather than the next one: it costs one redundant (cheap,
    // all-cached) fetch if a backfill later starts here, and it cannot skip a
    // message the way an off-by-one `page + 1` could.
    if (opts.stopAtCachedPage && !pageHadNewItem) {
      return { ...totals(), done: true, nextPage: page };
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
  opts: { fetchUnreadBodies: boolean; fetchBodies?: boolean; deep?: boolean; budget?: Budget },
  store: CacheStore,
): Promise<MessageSyncResult> {
  const fetchBodies = opts.fetchBodies ?? true;
  // No budget → unbounded (local stdio): every take() succeeds, so an ordinary
  // sync is byte-for-byte the original unbounded walk (forward pass only).
  const budget = opts.budget ?? makeBudget(Number.POSITIVE_INFINITY);
  const saved = await store.getSyncState(folder);
  const savedResume = saved?.resumePage ?? null;

  const fwd = await walkPages(client, folder, folderId, {
    startPage: 1,
    stopAtCachedPage: true,
    fetchUnreadBodies: opts.fetchUnreadBodies,
    fetchBodies,
    budget,
  }, store);

  let synced = fwd.synced;
  const unread = [...fwd.unread];
  const newMessages = [...fwd.newMessages];
  const markedRead = [...fwd.markedRead];
  // Never regress the folder's newest id: a pass that only walked cached pages
  // still saw page 1, but a paused one may not have.
  let newestId = maxId(saved?.newestId ?? null, fwd.newestId);
  let done: boolean;
  let resumePage: number | null;

  if (!fwd.done) {
    done = false;
    if (fwd.pagesFetched === 0) {
      // The budget was already spent when the forward pass started, so it
      // fetched nothing and observed NOTHING about this folder. Leave the
      // parked cursor exactly as it was: moving it on zero information is a
      // pure loss.
      //
      // This was a real starvation bug. `fwd.nextPage` is just the start page
      // (1) when nothing was fetched, so the `Math.min` below would silently
      // reset a deep backfill — e.g. resumePage 87 → 1 — discarding 86 pages
      // of progress. Under a request budget (OFW_SYNC_MAX_REQUESTS) a user
      // with enough drafts to consume the whole budget, with drafts running
      // first, hit this on EVERY call: inbox/sent never got budget, their
      // cursor was reset every time, and the backfill could never advance.
      resumePage = savedResume;
    } else {
      // The forward pass did look, and ran out before reaching cached history
      // — everything from `fwd.nextPage` down is unverified. Park the backfill
      // at whichever cursor is higher up the folder, so no page that still
      // owes us messages ends up above the resume point.
      resumePage = savedResume === null ? fwd.nextPage : Math.min(fwd.nextPage, savedResume);
    }
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
      fetchBodies,
      budget,
    }, store);
    synced += bf.synced;
    unread.push(...bf.unread);
    newMessages.push(...bf.newMessages);
    markedRead.push(...bf.markedRead);
    newestId = maxId(newestId, bf.newestId);
    done = bf.done;
    resumePage = bf.done ? null : bf.nextPage;
  }

  const now = new Date().toISOString();
  await store.setSyncState(folder, { lastSyncAt: now, newestId, resumePage });
  // The FORWARD pass is what proves our picture of the present is current: it
  // always starts at page 1 and stops only once it reaches cached history. Its
  // completion — not the backfill's — is what makes reads `fresh`. Same `now`
  // as lastSyncAt so a verified folder never looks a millisecond behind its own
  // sync (buildFreshness downgrades when lastSyncAt runs ahead of verifiedAt).
  if (fwd.done) await markFolderVerified(store, folder, now);

  return { synced, unread, newMessages, markedRead, done, verified: fwd.done };
}

const DraftListItemSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  date: z.looseObject({ dateTime: z.string() }),
  // Both spellings of the threading echo — OFW reports the reply target as
  // `inReplyTo` (with showContext) on list payloads where `replyToId` is null.
  // The cached row must derive the SAME value ofw_save_draft derived from the
  // detail, or the content revision drifts between a save and the next sync.
  replyToId: z.number().nullable().optional(),
  inReplyTo: z.number().nullable().optional(),
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

/**
 * Meta key holding whether the drafts cache has been compared against OFW.
 * `'fresh'` only after a COMPLETE drafts walk; `'unverified'` whenever a walk
 * was deferred for budget. Read by ofw_list_drafts / ofw_get_message to stamp
 * each draft's `cacheStatus`, and by the destructive draft tools to decide how
 * loudly to warn. Absent (never synced) reads as unverified.
 */
export const DRAFTS_CACHE_STATUS_KEY = 'drafts_cache_status';

export type DraftsCacheStatus = 'fresh' | 'unverified';

export async function getDraftsCacheStatus(store: CacheStore): Promise<DraftsCacheStatus> {
  return (await store.getMeta(DRAFTS_CACHE_STATUS_KEY)) === 'fresh' ? 'fresh' : 'unverified';
}

export async function setDraftsCacheStatus(store: CacheStore, status: DraftsCacheStatus): Promise<void> {
  await store.setMeta(DRAFTS_CACHE_STATUS_KEY, status);
}

/**
 * Meta key holding when a folder was last actually COMPARED against OFW.
 *
 * Deliberately distinct from `sync_state.last_sync_at`, which is written on
 * every call including one that paused mid-walk — so `last_sync_at` alone
 * cannot mean "this folder is current", only "we tried". This key advances
 * only when the folder was verified:
 *
 *   inbox/sent  the FORWARD pass completed, i.e. it walked from page 1 down to
 *               cached history (or off the end of the folder). That is exactly
 *               the pass that proves no new message is missing. A parked
 *               BACKFILL does not hold it back: incomplete old history says
 *               nothing about whether our picture of the present is current,
 *               and letting it downgrade every read would make the whole
 *               freshness signal noise during a long backfill.
 *   drafts      the full walk + reconciliation ran (the same moment
 *               DRAFTS_CACHE_STATUS_KEY goes 'fresh').
 *
 * Absent = never verified, which reads as `stale`, not `fresh`.
 */
export function folderVerifiedAtKey(folder: FolderName): string {
  return `folder_verified_at:${folder}`;
}

export async function getFolderVerifiedAt(store: CacheStore, folder: FolderName): Promise<string | null> {
  return (await store.getMeta(folderVerifiedAtKey(folder))) ?? null;
}

export async function markFolderVerified(
  store: CacheStore,
  folder: FolderName,
  at: string = new Date().toISOString(),
): Promise<void> {
  await store.setMeta(folderVerifiedAtKey(folder), at);
}

/**
 * A draft replaced OUTSIDE this cache — by another session or deployment
 * (create-then-delete there), or in the web app — vanishes here while a new
 * id appears, and the stable `draftKey` plus the attachments held for it would
 * be lost with the old id. When EXACTLY ONE new draft carries the vanished
 * draft's subject, body and reply target, it is the same message: move the
 * key and the held files across, marked `draft_key_inferred:<id>`. Anything
 * ambiguous (two candidates, changed content, a new draft that already has a
 * lineage) is left unlinked — a wrong guess would hand one message's
 * identity and attachments to another, which is worse than none.
 */
async function inferReplacedDraftLineage(store: CacheStore, vanishedIds: number[], newRows: DraftRow[]): Promise<void> {
  if (vanishedIds.length === 0 || newRows.length === 0) return;
  for (const goneId of vanishedIds) {
    // A vanished id came from this cache's own draft list, so its row exists.
    const gone = (await store.getDraft(goneId))!;
    const key = (await store.getDraftLineageById(goneId))?.draftKey;
    const held = await getHeldFiles(store, goneId);
    if (!key && held.length === 0) continue;
    const matches = newRows.filter((r) => r.subject === gone.subject && r.body === gone.body && r.replyToId === gone.replyToId);
    if (matches.length !== 1) continue;
    const target = matches[0]!;
    if (await store.getDraftLineageById(target.id)) continue;
    if (key) {
      await store.recordDraftLineage({ id: target.id, draftKey: key, previousId: goneId, recordedAt: new Date().toISOString() });
      await store.setMeta(`draft_key_inferred:${target.id}`, '1');
    }
    if (held.length > 0) {
      await setHeldFiles(store, target.id, [...held, ...(await getHeldFiles(store, target.id))]);
      await clearHeldFiles(store, goneId);
    }
  }
}

export async function syncDrafts(
  client: OFWClient,
  draftsFolderId: string,
  store: CacheStore,
  budget?: Budget,
): Promise<DraftSyncResult> {
  // No budget → unbounded (local stdio): identical to the original walk.
  const b = budget ?? makeBudget(Number.POSITIVE_INFINITY);

  // Deferring means we never compared the drafts cache to OFW on this call.
  // Mark it unverified so reads can say so and the destructive draft tools
  // know the cache is not a trustworthy base — the count we return here is
  // "nothing applied", NOT "nothing changed on the server".
  const defer = async (): Promise<DraftSyncResult> => {
    await setDraftsCacheStatus(store, 'unverified');
    // Record the ATTEMPT but not a verification: buildFreshness compares the
    // two and downgrades when a sync ran without verifying this folder, so a
    // deferred walk actively marks reads unverified rather than leaving them
    // coasting on an older stamp.
    await store.setSyncState('drafts', {
      lastSyncAt: new Date().toISOString(),
      newestId: null,
      resumePage: null,
    });
    return { synced: 0, done: false };
  };

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
    if (!b.take()) return defer();
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
    if (!b.take()) return defer();
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
      replyToId: threadedReplyTo(item),
      modifiedAt: item.date?.dateTime ?? nowNaiveWallClock(),
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
  const vanished = (await store.listDraftIds()).filter((id) => !seenIds.has(id));
  await inferReplacedDraftLineage(store, vanished, rows.filter((r) => !existingById.has(r.id)));
  for (const id of vanished) await store.deleteDraft(id);

  // The complete walk fetched every draft's DETAIL and reconciled deletions, so
  // the cache is now known-equal to the server. Only here is `synced: 0`
  // truthful as "verified no changes" — and only here may reads report the
  // drafts as server-confirmed.
  const now = new Date().toISOString();
  await setDraftsCacheStatus(store, 'fresh');
  await store.setSyncState('drafts', { lastSyncAt: now, newestId: null, resumePage: null });
  await markFolderVerified(store, 'drafts', now);

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
  /**
   * Present only when `markedRead` is non-empty: a loud, top-of-payload
   * statement that this sync marked messages read on OurFamilyWizard.
   */
  warning?: string;
  /**
   * Per-folder count of messages/drafts applied. A key is present ONLY when
   * that folder was actually diffed against OFW — see `notRefreshed`. A `0`
   * here always means "verified, nothing changed", never "not looked at".
   */
  synced: Partial<Record<FolderName, number>>;
  /** Always present; `markedRead` is omitted when this is 0. */
  markedReadCount: number;
  /** Every message first cached by this call, before the cap. */
  newMessagesTotal: number;
  /** True when `newMessages` holds only the newest NEW_MESSAGES_CAP of them. */
  newMessagesTruncated: boolean;
  unreadInbox: UnreadHint[];
  /** True only when every requested folder completed within the budget. */
  done: boolean;
  /** Alias of `done`, named for callers reading the freshness contract. */
  syncComplete: boolean;
  /** Requested folders that WERE compared against OFW on this call. */
  refreshed: FolderName[];
  /**
   * Requested folders that were NOT compared against OFW on this call (the
   * request budget ran out first). Their cached contents are unverified and
   * carry no `synced` count.
   */
  notRefreshed: FolderName[];
  /** Present (true) when today is a no-read day and no message body was fetched. */
  bodiesWithheld?: true;
  note?: string;
  /** Inbox messages this call marked read on OFW. Omitted when none. */
  markedRead?: MarkedReadHint[];
  /**
   * Every message first cached by this call, inbox and sent, read or unread,
   * newest first, capped at NEW_MESSAGES_CAP. Always present (`[]` when none).
   * Emitted after the counts above so a truncated read reaches "this is a
   * slice" before the array.
   */
  newMessages: NewMessageHint[];
}

/**
 * The most new messages one sync response lists. A first sync of a large
 * account caches thousands of rows; echoing them all would make the response
 * the problem (see "Response shape" in CLAUDE.md). The newest are the ones a
 * caller acts on, `newMessagesTotal` keeps the real count, and
 * `newMessagesTruncated` says the array is a slice — ofw_list_messages pages
 * through the rest.
 */
export const NEW_MESSAGES_CAP = 50;

/** Newest first: by sentAt (OFW's uniform naive format sorts as text), then id. */
function newestFirst(a: NewMessageHint, b: NewMessageHint): number {
  if (a.sentAt !== b.sentAt) return a.sentAt < b.sentAt ? 1 : -1;
  return b.id - a.id;
}

/**
 * The sync note for unread inbox messages cached without bodies. Exported so
 * ofw_sync_messages can rewrite it after a confirmed open of some of them —
 * a note still counting messages the same call opened would contradict
 * `unreadInbox` in one payload.
 */
export function unreadInboxNote(count: number): string {
  return `${count} unread inbox messages cached without bodies. Call ofw_get_message(id) to read them — this will mark them as read on OFW.`;
}

const MARKED_READ_LEAD = 'MARKED READ on OurFamilyWizard by this sync:';

/**
 * The note line for messages this sync marked read. Exported, like
 * unreadInboxNote, so ofw_sync_messages can rewrite it after a confirmed open.
 */
export function markedReadNote(markedRead: MarkedReadHint[]): string {
  const unexpected = markedRead.filter((m) => m.reason === 'unexpected').length;
  return `${MARKED_READ_LEAD} ${markedRead.length} inbox message${markedRead.length === 1 ? '' : 's'} (ids ${markedRead.map((m) => m.id).join(', ')}). Each now carries a "First Viewed" time your co-parent can see; it cannot be undone.${unexpected > 0 ? ` ${unexpected} of them ${unexpected === 1 ? 'was' : 'were'} NOT requested (reason "unexpected").` : ''}`;
}

/** The top-level `warning` for messages this sync marked read. */
export function markedReadWarning(markedRead: MarkedReadHint[]): string {
  const unexpected = markedRead.filter((m) => m.reason === 'unexpected').length;
  return `WARNING: this sync marked ${markedRead.length} inbox message${markedRead.length === 1 ? '' : 's'} READ on OurFamilyWizard (see markedRead). Your co-parent can see the "First Viewed" time, and it cannot be undone.${unexpected > 0 ? ` ${unexpected} of them ${unexpected === 1 ? 'was' : 'were'} NOT requested: the list reported ${unexpected === 1 ? 'it' : 'them'} as already read, but the fetch stamped ${unexpected === 1 ? 'it' : 'them'}. Tell the user, and report this as a bug.` : ''}`;
}

/**
 * Recompute everything in a sync result DERIVED from `markedRead` and
 * `unreadInbox` — `warning`, `markedReadCount`, and their two note lines —
 * from the arrays as they now stand. syncAll calls it once; ofw_sync_messages
 * calls it again after a confirmed open adds to them, so one payload never
 * carries two counts for the same thing. Other note lines keep their order.
 */
export function refreshReadReporting(result: SyncAllResult): void {
  const markedRead = result.markedRead ?? [];
  const notes = (result.note === undefined ? [] : result.note.split('\n\n'))
    .filter((n) => !n.startsWith(MARKED_READ_LEAD) && !/^\d+ unread inbox messages cached without bodies\./.test(n));
  const bodiless = result.unreadInbox.filter((h) => !h.bodyFetched).length;
  if (bodiless > 0) notes.push(unreadInboxNote(bodiless));
  if (markedRead.length > 0) notes.unshift(markedReadNote(markedRead));
  result.note = notes.length > 0 ? notes.join('\n\n') : undefined;
  if (result.note === undefined) delete result.note;
  result.markedReadCount = markedRead.length;
  if (markedRead.length > 0) {
    result.warning = markedReadWarning(markedRead);
    result.markedRead = markedRead;
  } else {
    delete result.warning;
    delete result.markedRead;
  }
}

export async function syncAll(client: OFWClient, opts: SyncAllOptions, store: CacheStore): Promise<SyncAllResult> {
  const requested = opts.folders ?? ['inbox', 'sent', 'drafts'];
  // Drafts go FIRST. They are the only folder a destructive tool
  // (ofw_save_draft / ofw_delete_draft) reads as its base, and they are cheap
  // and bounded — one list page plus one detail per draft. Running them last,
  // behind inbox and sent, meant a bounded call (the
  // OFW_SYNC_MAX_REQUESTS=40) spent its whole budget backfilling history and
  // deferred drafts on every single call, so server-side draft edits stayed
  // invisible indefinitely while the response reported `drafts: 0`.
  const folders: FolderName[] = [
    ...requested.filter((f) => f === 'drafts'),
    ...requested.filter((f) => f !== 'drafts'),
  ];
  // ONE budget shared across resolveFolderIds and every requested folder, in
  // order — so the whole invocation stays under the hosting subrequest cap.
  const budget = makeBudget(opts.maxRequests ?? Number.POSITIVE_INFINITY);
  // Decided HERE, not by each caller, so every path into a sync — the tool,
  // a read's autoRefresh, ofw_status — honours a no-read day (read-days.ts).
  const readingBlocked = readingBlockedToday() !== null;
  // resolveFolderIds always makes exactly one request; the tool guarantees
  // maxRequests >= 1, so this unit is always available (result intentionally
  // ignored — we account for it without a branch that can't be reached).
  budget.take();
  const ids = await resolveFolderIds(client, store);
  const synced: Partial<Record<FolderName, number>> = {};
  let unreadInbox: UnreadHint[] = [];
  const newMessages: NewMessageHint[] = [];
  const markedRead: MarkedReadHint[] = [];
  let done = true;
  let draftsUnverified = false;
  const refreshed: FolderName[] = [];
  const notRefreshed: FolderName[] = [];

  // Same rule for every folder: a count is reported, and the folder is listed
  // as refreshed, ONLY when it was actually diffed against OFW. A folder the
  // budget never reached reports no number at all — `inbox: 0` reads as
  // "verified, no new messages", and that lie is the whole bug this guards.
  const record = (folder: FolderName, verified: boolean, count: number): void => {
    if (verified) {
      synced[folder] = count;
      refreshed.push(folder);
    } else {
      notRefreshed.push(folder);
    }
  };

  for (const folder of folders) {
    if (folder === 'inbox') {
      const r = await syncMessageFolder(client, 'inbox', ids.inbox, {
        fetchUnreadBodies: !readingBlocked && (opts.fetchUnreadBodies ?? false),
        fetchBodies: !readingBlocked,
        deep: opts.deep ?? false,
        budget,
      }, store);
      record('inbox', r.verified, r.synced);
      unreadInbox = r.unread;
      newMessages.push(...r.newMessages);
      markedRead.push(...r.markedRead);
      if (!r.done) done = false;
    } else if (folder === 'sent') {
      const r = await syncMessageFolder(client, 'sent', ids.sent, {
        fetchUnreadBodies: false,
        fetchBodies: !readingBlocked,
        deep: opts.deep ?? false,
        budget,
      }, store);
      record('sent', r.verified, r.synced);
      // A sent detail never stamps OUR read state, so it adds no markedRead.
      newMessages.push(...r.newMessages);
      if (!r.done) done = false;
    } else if (folder === 'drafts') {
      const r = await syncDrafts(client, ids.drafts, store, budget);
      // Only report a drafts count when the walk actually compared against
      // OFW. A deferred walk applied nothing, and reporting its `0` as
      // `drafts: 0` reads as "verified, no changes" — the exact lie that let a
      // server-side draft edit be overwritten. Omit the number instead.
      record('drafts', r.done, r.synced);
      if (!r.done) {
        draftsUnverified = true;
        done = false;
      }
    }
  }

  const notes: string[] = [];
  if (readingBlocked) {
    notes.push('Today is a no-read day (OFW_READ_DAYS / OFW_NO_READ_DAYS): new inbox and sent messages were cached from the list only — sender, date and subject — and no message body was downloaded. The first sync on a reading day fills in bodies that can be fetched without marking anything read.');
  }
  if (draftsUnverified) {
    notes.push('The drafts folder was NOT checked against OurFamilyWizard on this call (the request budget ran out first), so no drafts count is reported and the cached drafts are marked "unverified". Cached draft bodies may be behind the server. Call ofw_sync_messages again — or ofw_sync_messages with folders:["drafts"] — before editing or deleting a draft.');
  }
  if (notRefreshed.length > 0) {
    notes.push(`NOT checked against OurFamilyWizard on this call: ${notRefreshed.join(', ')}. No count is reported for ${notRefreshed.length > 1 ? 'those folders' : 'that folder'} — absence of a count means "not looked at", not "no changes". Cached contents may be behind the server; call ofw_sync_messages again to finish, or ofw_check_freshness for a cheap live confirmation.`);
  }
  if (!done) {
    notes.push('Paused after the request budget to stay within the hosting limit; more pages remain — call ofw_sync_messages again with the same arguments to resume where it left off and continue the backfill.');
  }
  const note = notes.length > 0 ? notes.join('\n\n') : undefined;
  newMessages.sort(newestFirst);

  // Key order is the emitted order: the warning first (a truncated read must
  // hit it), counts before arrays, newMessages last. `warning` is declared
  // here as a placeholder so refreshReadReporting fills it IN PLACE.
  const result: SyncAllResult = {
    warning: undefined,
    synced,
    markedReadCount: 0,
    newMessagesTotal: newMessages.length,
    newMessagesTruncated: newMessages.length > NEW_MESSAGES_CAP,
    unreadInbox,
    done,
    syncComplete: done,
    refreshed,
    notRefreshed,
    ...(readingBlocked ? { bodiesWithheld: true as const } : {}),
    note,
    markedRead,
    newMessages: newMessages.slice(0, NEW_MESSAGES_CAP),
  };
  refreshReadReporting(result);
  return result;
}
