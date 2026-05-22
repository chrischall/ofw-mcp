import { isAbsolute, join, resolve } from 'node:path';
import type { Recipient } from '../cache.js';

export function jsonResponse(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

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

// Expand a user-provided path: ~ → $HOME, relative → absolute.
export function expandPath(p: string): string {
  const expanded = p.startsWith('~/') ? join(process.env.HOME ?? '', p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
