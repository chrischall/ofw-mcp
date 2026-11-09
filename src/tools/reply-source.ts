// Where each cached draft's reply target came from.
//
// The drafts table holds the target itself; this records whether it is
// OurFamilyWizard's own echo (`server`) or this server's record of it, kept
// because OFW's payload did not report the linkage (`cache` — see
// draftReplyTarget in _shared.ts). It lives in the cache's `meta` table, keyed
// by draft id like the held files, so it needed no schema migration. A row
// written before this existed has no entry and reads as `server`: every such
// row's target was taken from an OFW payload.

import type { CacheStore } from '../cache/store.js';
import type { ReplyToSource } from './_shared.js';

const key = (draftId: number): string => `draft_reply_source:${draftId}`;

/** Record how a draft's reply target was established (null: it has none). */
export async function setReplyToSource(
  cache: CacheStore,
  draftId: number,
  source: ReplyToSource | null,
): Promise<void> {
  await cache.setMeta(key(draftId), source ?? '');
}

/**
 * The source of a draft's reply target, or null when it has no target.
 * Anything but an explicit `cache` reads as `server` (see the header).
 */
export async function getReplyToSource(
  cache: CacheStore,
  draftId: number,
  replyToId: number | null,
): Promise<ReplyToSource | null> {
  if (replyToId === null) return null;
  return (await cache.getMeta(key(draftId))) === 'cache' ? 'cache' : 'server';
}

/** `{ replyToSource }` for a draft with a reply target, `{}` otherwise. */
export async function replyToSourceField(
  cache: CacheStore,
  draftId: number,
  replyToId: number | null,
): Promise<{ replyToSource?: ReplyToSource }> {
  const source = await getReplyToSource(cache, draftId, replyToId);
  return source === null ? {} : { replyToSource: source };
}
