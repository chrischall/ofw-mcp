// Attachments HELD against a draft, because OurFamilyWizard will not keep
// them on one.
//
// Verified live 2026-11-06: a draft saved with fileIds — PRIVATE or SHARED,
// by create OR by the web app's own in-place update — always comes back
// `files: []`, and the web app's compose screen never loads files from a
// draft (its attachment list starts empty and only ever holds what was added
// in that session; they go out with the final send). Before this module,
// ofw_save_draft posted the ids, OFW discarded them, and the response both
// warned that they were missing AND claimed "attachments (N)" were carried
// over — while the next edit posted `[]` and lost them for good.
//
// So the ids live here, in the cache's `meta` table keyed by draft id, moved
// to the new id on every create-then-delete replace, folded into the draft's
// `revision`, and attached by ofw_send_message when the draft is sent.

import type { CacheStore } from '../cache/store.js';

const key = (draftId: number): string => `draft_held_files:${draftId}`;

/** De-duplicate, preserving first-seen order. */
export function uniqueIds(ids: Iterable<number>): number[] {
  return [...new Set(ids)];
}

/** The file ids held for a draft (empty when none). */
export async function getHeldFiles(cache: CacheStore, draftId: number): Promise<number[]> {
  const raw = await cache.getMeta(key(draftId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => Number.isInteger(v)) : [];
  } catch {
    return [];
  }
}

/** Replace the held set for a draft. An empty set clears it. */
export async function setHeldFiles(cache: CacheStore, draftId: number, ids: number[]): Promise<void> {
  await cache.setMeta(key(draftId), JSON.stringify(uniqueIds(ids)));
}

/** Forget a draft's held files (sent, deleted, or replaced). */
export async function clearHeldFiles(cache: CacheStore, draftId: number): Promise<void> {
  await cache.setMeta(key(draftId), '[]');
}

/** Held sets for several drafts at once, for list-shaped reads. */
export async function heldFilesFor(cache: CacheStore, draftIds: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  for (const id of draftIds) out.set(id, await getHeldFiles(cache, id));
  return out;
}

/** The note every response about held files carries. */
export const HELD_NOTE =
  'OurFamilyWizard drafts do not store attachments, so these files are held with this draft by this server and attached when you send it with ofw_send_message (draftId). They are not visible on the draft in the OurFamilyWizard web app.';
