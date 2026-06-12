import { expandPath as expandPathUtil, rawTextResult, textResult } from '@chrischall/mcp-utils';
import type { Recipient } from '../cache.js';
import type { OFWClient } from '../client.js';

// Pretty-printed JSON tool result. Thin wrapper over @chrischall/mcp-utils'
// `textResult` so the rest of the codebase keeps the local name.
export const jsonResponse = textResult;

// Raw-string tool result. Wrapper over @chrischall/mcp-utils' `rawTextResult`.
export const textResponse = rawTextResult;

// OFW API shape for `recipients[]` on message/draft list and detail
// responses. Used wherever we type the response of a `/pub/v3/messages*`
// call. Exported so call sites stop inlining `Array<{ user: ..., viewed: ... }>`.
export interface ApiRecipient {
  user?: { id?: number; name?: string };
  viewed?: { dateTime: string } | null;
}

// Translates OFW API recipient shape into the cache's normalized Recipient.
// Used wherever we surface or persist recipients (sync, get_message, send,
// save_draft) — all five call sites had near-identical inline mappings.
export function mapRecipients(items: ApiRecipient[] | undefined | null): Recipient[] {
  return (items ?? []).map((r) => ({
    userId: r.user?.id ?? 0,
    name: r.user?.name ?? '',
    viewedAt: r.viewed?.dateTime ?? null,
  }));
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
 * Returns a discriminated union so callers can narrow with
 * `if (result.id !== null)`. When id is null (no id field in the
 * response — never observed in production, but defensive), `raw`
 * carries the POST response so the caller can still surface it.
 */
export async function postMessageAndRefetch<TDetail>(
  client: OFWClient,
  payload: unknown,
): Promise<
  | { id: number; detail: TDetail; raw: unknown }
  | { id: null; detail: null; raw: unknown }
> {
  const raw = await client.request<{ id?: number; entityId?: number } & Record<string, unknown>>(
    'POST', '/pub/v3/messages', payload,
  );
  const id =
    typeof raw?.id === 'number' ? raw.id
    : typeof raw?.entityId === 'number' ? raw.entityId
    : null;
  if (id === null) return { id: null, detail: null, raw };
  const detail = await client.request<TDetail>('GET', `/pub/v3/messages/${id}`);
  return { id, detail, raw };
}
