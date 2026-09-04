import { projectOrRaw, pruneUndefined, type View } from '@chrischall/mcp-utils';
import type { DraftRow, MessageRow } from '../cache/store.js';

/**
 * The compact projection (`docs` — fleet convention "Response shape", and
 * `@chrischall/mcp-utils`' `view` vocabulary).
 *
 * A default `ofw_list_messages()` is 50 messages, and it used to weigh 135 KB
 * — roughly 34,000 tokens for one call. Measured against a real 1,335-row
 * cache, `listData` was 58% of that, and 78% of `listData` duplicated fields
 * the same object already emitted at the top level:
 *
 * - `listData.date` is 421 bytes per message: ELEVEN pre-formatted renderings
 *   of one timestamp (`displayDate`, `threeCharMonthWeekdayTimeNoYear`, …)
 *   sitting beside the `sentAt` + `sentAtDisplay` that `timestamps.ts` already
 *   derives — and `normalizeTimestampsInValue` then adds a twelfth inside it.
 * - `listData.recipients[].user` carries eight fields per person, including
 *   `color` and `displayInitials`, next to the three-field recipients the row
 *   already normalised.
 * - `listData.read` / `.showNeverViewed` are FORCED to agree with the derived
 *   `read` before they are emitted (`withReadState`), so the copy cannot even
 *   disagree usefully.
 * - `listData.preview` is a truncation of the body in the same object.
 *
 * What compact keeps is everything a caller can act on. What it drops is what
 * the response says twice, what is near-constant across every row, and what
 * `folder` already answers. `full` returns the row untouched.
 *
 * There is no `raw` rung. A message here is ASSEMBLED — the list endpoint
 * supplies `listData`, the detail GET supplies `body` and the real `viewedAt`,
 * and `timestamps.ts` rewrites both — so there is no single upstream payload
 * to hand back, and a `raw` that skipped normalisation would put naive local
 * times back beside UTC ones on the one rung a caller reaches for when
 * something already looks wrong.
 */
export const MESSAGE_VIEWS = ['compact', 'full'] as const;

const LABEL = 'ofw-mcp';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Who sent it.
 *
 * `fromUser` is the empty string on all 1,335 rows of a real cache — inbox and
 * sent alike — because OFW names the sender in the LIST payload's `author` and
 * nowhere else. So this is not a nicety: deleting `listData` without promoting
 * it would have taken the sender's name off every message, and compact is
 * where a field that has never worked starts working.
 */
function senderOf(row: MessageRow): string | null {
  if (typeof row.fromUser === 'string' && row.fromUser !== '') return row.fromUser;
  const author = asRecord(asRecord(row.listData)?.author);
  const name = author?.name;
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * How many attachments — as a NUMBER, from a field OFW sends two ways (`1`, or
 * `[]` on the nine live rows that have no files).
 *
 * `undefined` when OFW reported nothing, and the caller then sees no `files`
 * key at all. Defaulting to 0 there would turn "we did not see a count" into
 * "there are none", which is the shape that reads as a verified absence — the
 * failure every guard in this server exists to prevent.
 */
function fileCountOf(row: MessageRow): number | undefined {
  const files = asRecord(row.listData)?.files;
  if (typeof files === 'number') return files;
  if (Array.isArray(files)) return files.length;
  return undefined;
}

/** Whether this message has been replied to. Varies on 442 of 1,335 live rows. */
function repliedOf(row: MessageRow): boolean | undefined {
  const replied = asRecord(row.listData)?.replied;
  return typeof replied === 'boolean' ? replied : undefined;
}

/**
 * One cached message row, projected.
 *
 * Key order matches the row's, so a caller reading either rung sees the same
 * fields in the same places. `undefined` values are dropped by
 * `JSON.stringify`, which is how the optional keys above stay absent rather
 * than becoming nulls that claim more than we know.
 */
export function compactMessage(row: MessageRow & { read?: boolean }): Record<string, unknown> {
  const { listData: _drop, fromUser: _dropFrom, ...rest } = row;
  // `pruneUndefined`, not just `JSON.stringify`'s own dropping of undefined:
  // an optional field must be ABSENT from the object a test or an in-process
  // caller inspects, not present-and-undefined. "We did not see a count" and
  // "there are none" have to be different facts at every layer, not only after
  // serialisation.
  return pruneUndefined({
    id: rest.id,
    folder: rest.folder,
    subject: rest.subject,
    from: senderOf(row),
    sentAt: rest.sentAt,
    recipients: rest.recipients,
    read: rest.read,
    replied: repliedOf(row),
    files: fileCountOf(row),
    replyToId: rest.replyToId,
    chainRootId: rest.chainRootId,
    body: rest.body,
    fetchedBodyAt: rest.fetchedBodyAt,
    // Anything a TOOL added on top of the cache row — `attachments`,
    // `revision`, `cacheStatus`, `serverConfirmed`, `freshness` — is kept
    // wholesale. Those are this server's own answers, never OFW's echo, and a
    // projection that dropped one would be removing the thing the caller
    // asked for rather than the thing they got twice.
    ...omitKnown(rest as Record<string, unknown>, MESSAGE_ROW_KEYS),
  });
}

/**
 * Each projector's OWN columns — the ones it names explicitly above — so the
 * spread adds only what a tool supplied on top of the cache row.
 *
 * Two sets rather than one union. A shared set is the union of `MessageRow` and
 * `DraftRow`, so each projector would silently swallow any tool-supplied extra
 * that happened to be named after the OTHER shape's column: a message carrying
 * a `modifiedAt`, a draft carrying a `folder`. Nothing supplies those today,
 * which is exactly what makes it the kind of trap that is only found once
 * something does — and it would have quietly contradicted the "kept wholesale"
 * promise below.
 */
const MESSAGE_ROW_KEYS = new Set([
  'id', 'folder', 'subject', 'sentAt', 'recipients', 'read', 'replyToId', 'chainRootId', 'body', 'fetchedBodyAt',
]);

const DRAFT_ROW_KEYS = new Set(['id', 'subject', 'recipients', 'replyToId', 'modifiedAt', 'body']);

function omitKnown(rest: Record<string, unknown>, own: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) if (!own.has(key)) out[key] = value;
  return out;
}

/**
 * One cached draft row, projected.
 *
 * `revision`, `draftKey` and `cacheStatus` are added by the tool rather than
 * the cache and survive untouched — they are the concurrency token, the
 * identity that outlives the create-then-delete churn, and the statement of
 * whether a walk actually compared this row against OFW. Losing any of them to
 * a projection would break every guarded write in this server.
 */
export function compactDraft(row: DraftRow): Record<string, unknown> {
  const { listData: _drop, ...rest } = row;
  return pruneUndefined({
    id: rest.id,
    subject: rest.subject,
    recipients: rest.recipients,
    replyToId: rest.replyToId,
    modifiedAt: rest.modifiedAt,
    body: rest.body,
    ...omitKnown(rest as Record<string, unknown>, DRAFT_ROW_KEYS),
  });
}

/**
 * Project a page of messages, or hand it back whole.
 *
 * The array is projected as ONE unit on purpose. Row-at-a-time would let a
 * single unexpected row come back projected-to-nothing among 49 good ones —
 * a hole in the middle of an answer, which is worse than a fat page and
 * indistinguishable from a message with no content. It also means one stderr
 * line per page rather than fifty.
 */
export function viewMessages<T extends MessageRow>(view: View, rows: T[]): Array<T | Record<string, unknown>> {
  if (view !== 'compact') return rows;
  return projectOrRaw(rows, (rs) => rs.map((r) => compactMessage(r)), {
    label: LABEL,
    context: 'the cached message rows',
  });
}

/** As {@link viewMessages}, for drafts. */
export function viewDrafts<T extends DraftRow>(view: View, rows: T[]): Array<T | Record<string, unknown>> {
  if (view !== 'compact') return rows;
  return projectOrRaw(rows, (rs) => rs.map((r) => compactDraft(r)), {
    label: LABEL,
    context: 'the cached draft rows',
  });
}

/**
 * One message, projected — `ofw_get_message`'s single-record path.
 *
 * Same fallback as the array form: a row this projector cannot read comes back
 * whole. A detail read is the call a caller makes when they need everything
 * about one message, so answering it with a record that has holes in it is the
 * worst place in this server to get a projection wrong.
 */
export function viewOne<T extends MessageRow>(view: View, row: T): T | Record<string, unknown> {
  if (view !== 'compact') return row;
  return projectOrRaw(row, (r) => compactMessage(r), { label: LABEL, context: 'a cached message row' });
}
