import { expandPath as expandPathUtil, rawTextResult, textResult } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { MessageRow, Recipient } from '../cache/store.js';
import type { OFWClient } from '../client.js';
import { parseLenient } from '@chrischall/mcp-utils';

// Pretty-printed JSON tool result. Thin wrapper over @chrischall/mcp-utils'
// `textResult` so the rest of the codebase keeps the local name.
export const jsonResponse = textResult;

// Raw-string tool result. Wrapper over @chrischall/mcp-utils' `rawTextResult`.
export const textResponse = rawTextResult;

// A STRUCTURED failure: the machine-readable payload of `jsonResponse` plus
// `isError`, so a refusal can carry recovery data (e.g. the server draft body
// we declined to overwrite) without being mistaken for a successful write.
// mcp-utils' `errorResult` only carries a string.
export function jsonErrorResponse(data: unknown): ReturnType<typeof textResult> {
  return { ...textResult(data), isError: true };
}

// OFW API shape for `recipients[]` on message/draft list and detail
// responses. Used wherever we validate the response of a `/pub/v3/messages*`
// call. Loose: unknown keys pass through (and survive into cached listData).
export const ApiRecipientSchema = z.looseObject({
  // Live OFW payloads key the recipient's id as `userId` (verified against a
  // real /pub/v3/messages record: `recipients[].user.userId === 3039201`). An
  // earlier guess read `id`, which is absent — so every normalized recipient
  // came out with `userId: 0`, breaking any "find my own recipient" match. Both
  // are accepted (userId first, id fallback) so a backend that ever returns `id`
  // still resolves.
  user: z.looseObject({
    userId: z.number().optional(),
    id: z.number().optional(),
    name: z.string().optional(),
  }).optional(),
  viewed: z.looseObject({ dateTime: z.string() }).nullable().optional(),
});
export type ApiRecipient = z.infer<typeof ApiRecipientSchema>;

// Translates OFW API recipient shape into the cache's normalized Recipient.
// Used wherever we surface or persist recipients (sync, get_message, send,
// save_draft).
//
// `viewedAt` is the recipient's true "First Viewed" time, or null if not yet
// viewed. Only the DETAIL endpoint (/pub/v3/messages/{id}) carries a real
// timestamp; the LIST endpoint returns an epoch-zero PLACEHOLDER
// ("1970-01-01T00:00:00") in the SAME field even for read messages (on the
// list, read status lives in `showNeverViewed`, not the timestamp). So treat
// the epoch placeholder as "no real view time" — otherwise a list-sourced row
// reports a bogus 1970 read time. A detail re-fetch is what fills in the truth.
export function mapRecipients(items: ApiRecipient[] | undefined | null): Recipient[] {
  return (items ?? []).map((r) => {
    const dt = r.viewed?.dateTime;
    const viewedAt = typeof dt === 'string' && !dt.startsWith('1970-01-01') ? dt : null;
    return { userId: r.user?.userId ?? r.user?.id ?? 0, name: r.user?.name ?? '', viewedAt };
  });
}

// True if any recipient has a *real* "First Viewed" time — i.e. present and
// not the epoch-zero placeholder. After mapRecipients a fresh `viewedAt` is
// only ever a real timestamp or null, but a cache row written by older code
// (which trusted the list endpoint's `viewed`) may still hold the literal
// "1970-01-01T00:00:00". Treating that as "not viewed" lets sync/get_message
// re-fetch detail and self-heal the stale row to the real timestamp.
export function hasRealView(recipients: { viewedAt: string | null }[]): boolean {
  return recipients.some((r) => r.viewedAt !== null && !r.viewedAt.startsWith('1970-01-01'));
}

// Just the read-relevant slice of a MessageRow — so deriveRead/withReadState can
// be unit-tested and called without constructing a whole row.
type ReadStateInput = Pick<MessageRow, 'folder' | 'recipients' | 'fetchedBodyAt' | 'listData'>;

// True when the once-scraped list flags themselves say the message is read.
// `showNeverViewed === false` is OFW's reliable "has been viewed" signal (per
// CLAUDE.md); `read === true` is the inbox list's own flag. Both are only ever
// captured at first sight, so they can go stale — they raise `read` but never
// lower it (see deriveRead).
function scrapeSaysRead(listData: unknown): boolean {
  if (typeof listData !== 'object' || listData === null) return false;
  const ld = listData as { read?: unknown; showNeverViewed?: unknown };
  return ld.read === true || ld.showNeverViewed === false;
}

/**
 * Derive a message's authoritative read state from the cached record itself,
 * rather than trusting the `read`/`showNeverViewed` flags scraped once from the
 * list endpoint. Those flags are frozen at first sight and drift the moment a
 * message is read after caching — most often when a body fetch
 * (`ofw_get_message`) marks an inbox message read on OFW as a side effect,
 * populating `fetchedBodyAt` and the recipient's `viewedAt` but leaving the
 * stale `read: false` behind.
 *
 * The derivation is monotonic — every input can only turn read ON — so a later
 * resync (which re-scrapes the list flags) can never flip a read message back
 * to unread:
 *
 *  - INBOX: the account holder is the recipient. When we know our own id
 *    (`selfUserId`), that recipient's `viewedAt` is authoritative; otherwise any
 *    recipient's `viewedAt` stands in (1:1 co-parent messaging). Fetching the
 *    body marks the message read on OFW, so a non-null `fetchedBodyAt` is also
 *    read=true. The stale scrape flag is only a last-resort fallback.
 *  - SENT: "read" means a *recipient* has opened it — tracked via their
 *    `viewedAt` (the detail endpoint's real timestamp) — never our own body
 *    fetch, which is always set for sent messages.
 */
export function deriveRead(row: ReadStateInput, selfUserId?: number): boolean {
  if (row.folder === 'inbox') {
    const viewed = selfUserId !== undefined
      ? row.recipients.some((r) => r.userId === selfUserId && r.viewedAt !== null)
      : row.recipients.some((r) => r.viewedAt !== null);
    return viewed || row.fetchedBodyAt !== null || scrapeSaysRead(row.listData);
  }
  return row.recipients.some((r) => r.viewedAt !== null) || scrapeSaysRead(row.listData);
}

/**
 * Return the row augmented with an authoritative top-level `read` boolean and a
 * `listData` whose `read`/`showNeverViewed` flags are forced to agree with it —
 * so a single response can never contradict itself (the reported bug: a record
 * carrying `listData.read: false` alongside a populated recipient `viewedAt`).
 * A non-object `listData` (null / legacy string) is passed through untouched.
 */
export function withReadState<T extends MessageRow>(
  row: T,
  selfUserId?: number,
): T & { read: boolean } {
  const read = deriveRead(row, selfUserId);
  const listData = (typeof row.listData === 'object' && row.listData !== null)
    ? { ...(row.listData as Record<string, unknown>), read, showNeverViewed: !read }
    : row.listData;
  return { ...row, read, listData };
}

// Expand a user-provided path: ~ → home, relative → absolute. Re-exports
// @chrischall/mcp-utils' `expandPath`.
export const expandPath = expandPathUtil;

/**
 * Best-effort check that OFW actually persisted what we posted. OFW's
 * draft-update path is known to silently no-op while echoing success in the
 * POST response, so callers re-GET the detail and compare it to what was
 * sent. Containment (not equality) because OFW legitimately transforms
 * content — replies get the original message appended to the body
 * (includeOriginal) and may get a subject prefix. Returns a WARNING string
 * when the persisted content can't be confirmed to contain what was sent,
 * else null.
 */
export function verifyWriteLanded(
  kind: 'message' | 'draft',
  sent: { subject: string; body: string },
  persisted: { subject?: string; body?: string },
): string | null {
  const mismatches: string[] = [];
  if (typeof persisted.subject !== 'string' || !persisted.subject.includes(sent.subject)) {
    mismatches.push('subject');
  }
  if (typeof persisted.body !== 'string' || !persisted.body.includes(sent.body)) {
    mismatches.push('body');
  }
  if (mismatches.length === 0) return null;
  return `WARNING: the ${kind} re-fetched from OFW does not contain the ${mismatches.join(' and ')} that was posted — OFW may have silently dropped or altered the write. Verify the ${kind} on ourfamilywizard.com before relying on it.`;
}

// POST /pub/v3/messages response: minimal, `{entityId: <id>}` or legacy
// `{id: <id>}`, sometimes an empty body (→ null). Validated STRICT: a
// mistyped id (e.g. entityId as a string) must throw rather than silently
// degrade into the "unconfirmed send" path when the write actually landed.
// Absence of both ids stays legal — callers handle it with a WARNING.
const PostMessagesResponseSchema = z.looseObject({
  id: z.number().optional(),
  entityId: z.number().optional(),
}).nullable();

/**
 * POST a payload to /pub/v3/messages, then immediately GET the detail
 * endpoint for the resulting message id. This is the only correct way to
 * populate the cache after `ofw_send_message` or `ofw_save_draft`:
 *
 *  - OFW's POST response is minimal (typically just `{entityId: <id>}`
 *    or sometimes legacy `{id: <id>}`), so we can't build a full row
 *    from it directly.
 *  - Worse, on draft updates OFW returns the same success shape even
 *    when the server silently no-ops, so the GET is also how we verify
 *    the write landed (callers compare detail.body to args.body).
 *
 * Both responses are validated STRICT against `detailSchema` / the POST
 * schema (this is the write-verification boundary — issue #83); `ctx`
 * names the calling tool in the error message.
 *
 * Returns a discriminated union so callers can narrow with
 * `if (result.id !== null)`. When id is null (no id field in the
 * response — never observed in production, but defensive), `raw`
 * carries the POST response so the caller can still surface it.
 *
 * The generic is parametrized on the schema's OUTPUT type `T`
 * (`detailSchema: z.ZodType<T>`, `detail: T`) rather than on the schema
 * type itself. This mirrors `parseLenient`'s own signature
 * (`<T>(schema: ZodType<T>, …): T`) exactly, so `T` is inferred straight
 * from the schema and flows into the return type with no `as` cast — the
 * compiler verifies that `detail` matches `detailSchema`'s output. (A
 * `<S extends z.ZodType>` constraint would widen the output to `unknown`
 * and force a cast at this call site.)
 */
export async function postMessageAndRefetch<T>(
  client: OFWClient,
  payload: unknown,
  detailSchema: z.ZodType<T>,
  ctx: string,
): Promise<
  | { id: number; detail: T; raw: unknown }
  | { id: null; detail: null; raw: unknown }
> {
  const raw = parseLenient(
    PostMessagesResponseSchema,
    await client.request('POST', '/pub/v3/messages', payload),
    { label: 'ofw-mcp', context: `POST /pub/v3/messages (${ctx})`, mode: 'strict' },
  );
  const id =
    typeof raw?.id === 'number' ? raw.id
    : typeof raw?.entityId === 'number' ? raw.entityId
    : null;
  if (id === null) return { id: null, detail: null, raw };
  const detail = parseLenient(
    detailSchema,
    await client.request('GET', `/pub/v3/messages/${id}`),
    { label: 'ofw-mcp', context: `GET /pub/v3/messages/{id} (${ctx})`, mode: 'strict' },
  );
  return { id, detail, raw };
}
