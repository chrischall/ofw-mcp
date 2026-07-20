import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OFWCache } from '../../src/cache/node.js';
import type { CacheStore, FolderName } from '../../src/cache/store.js';
import { markFolderVerified, setDraftsCacheStatus } from '../../src/sync.js';
import { buildFreshness } from '../../src/tools/freshness.js';

let cache: OFWCache;
let store: CacheStore;

const NOW = new Date('2026-07-20T12:00:00.000Z');
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

beforeEach(() => {
  cache = OFWCache.open(':memory:');
  store = cache;
});

afterEach(() => {
  cache.close();
});

/** Seed a folder as verified-and-synced at the same instant. */
async function seedVerified(folder: FolderName, at: string, resumePage: number | null = null): Promise<void> {
  await store.setSyncState(folder, { lastSyncAt: at, newestId: null, resumePage });
  await markFolderVerified(store, folder, at);
}

describe('buildFreshness', () => {
  it('labels a folder that has never been synced `stale`, not `fresh`', async () => {
    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox'], now: NOW });

    expect(f.staleness).toBe('stale');
    expect(f.asOf).toBeNull();
    expect(f.ageSeconds).toBeNull();
    expect(f.lastServerSyncAt).toBeNull();
    expect(f.warning).toMatch(/never been checked against OurFamilyWizard/);
  });

  it('labels a recently verified folder `fresh` with no warning', async () => {
    await seedVerified('inbox', ago(30));

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox'], now: NOW });

    expect(f.staleness).toBe('fresh');
    expect(f.source).toBe('cache');
    expect(f.asOf).toBe(ago(30));
    expect(f.ageSeconds).toBe(30);
    expect(f.syncComplete).toBe(true);
    expect(f.historyComplete).toBe(true);
    expect(f.warning).toBeUndefined();
  });

  it('downgrades to `unverified` past the freshness threshold, reporting the age', async () => {
    await seedVerified('inbox', ago(5231));

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox'], now: NOW, ttlSeconds: 300 });

    expect(f.staleness).toBe('unverified');
    expect(f.asOf).toBe(ago(5231));
    expect(f.ageSeconds).toBe(5231);
    // The warning must state the age and the reason, not just that it is stale.
    expect(f.warning).toMatch(/87 min ago/);
    expect(f.warning).toMatch(/Re-read before asserting current state/);
  });

  it('downgrades when a sync ran but did NOT verify the folder (budget-paused walk)', async () => {
    // Verified 10s ago — well inside the TTL — but a later sync attempt failed
    // to reach this folder. Recency alone must not keep it `fresh`.
    await markFolderVerified(store, 'drafts', ago(10));
    await store.setSyncState('drafts', { lastSyncAt: ago(1), newestId: null, resumePage: null });
    await setDraftsCacheStatus(store, 'unverified');

    const f = await buildFreshness(store, { source: 'cache', folders: ['drafts'], now: NOW });

    expect(f.staleness).toBe('unverified');
    expect(f.syncComplete).toBe(false);
    expect(f.lastServerSyncAt).toBe(ago(1));
    expect(f.warning).toMatch(/did not finish checking drafts/);
  });

  it('does NOT downgrade staleness for a parked backfill, but reports historyComplete:false', async () => {
    // A long backfill must not make every read `unverified` — the forward pass
    // is what proves the present is current, and desensitising the caller to
    // the warning would reproduce the bug this whole block exists to prevent.
    await seedVerified('inbox', ago(30), 42);

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox'], now: NOW });

    expect(f.staleness).toBe('fresh');
    expect(f.historyComplete).toBe(false);
    expect(f.warning).toMatch(/older history is still being backfilled/);
  });

  it('takes the WORST staleness across folders and the OLDEST asOf', async () => {
    await seedVerified('inbox', ago(30));
    await seedVerified('sent', ago(9000));

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox', 'sent'], now: NOW });

    expect(f.staleness).toBe('unverified');
    expect(f.asOf).toBe(ago(9000));
    expect(f.ageSeconds).toBe(9000);
  });

  it('a never-synced folder alongside a fresh one still yields `stale`', async () => {
    await seedVerified('inbox', ago(30));

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox', 'drafts'], now: NOW });

    expect(f.staleness).toBe('stale');
    expect(f.asOf).toBeNull();
  });

  it('a CACHE read backed by no folder is `stale`, never `fresh`', async () => {
    // Regression: the per-folder loop is the only thing that downgrades the
    // 'fresh' initializer, so a zero-folder scope used to return
    // `staleness: "fresh"` next to `asOf: null` — self-contradictory, and the
    // one shape that carried no warning at all. Reachable in production via
    // ofw_sync_messages({folders: []}).
    const f = await buildFreshness(store, { source: 'cache', folders: [], now: NOW });

    expect(f.staleness).toBe('stale');
    expect(f.asOf).toBeNull();
    expect(f.syncComplete).toBe(false);
    expect(f.warning).toMatch(/backed by no synced folder/);
  });

  it('clamps a future verifiedAt to age 0 rather than letting skew fake freshness', async () => {
    // A negative age can never exceed the TTL, so unclamped clock skew would
    // be a silent false `fresh` that no threshold could catch.
    await seedVerified('inbox', ago(-600));

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox'], now: NOW });

    expect(f.ageSeconds).toBe(0);
    expect(f.staleness).toBe('fresh');
  });

  it('names BOTH the deferral and the age when a folder is deferred and stale', async () => {
    await markFolderVerified(store, 'drafts', ago(9000));
    await store.setSyncState('drafts', { lastSyncAt: ago(1), newestId: null, resumePage: null });

    const f = await buildFreshness(store, { source: 'cache', folders: ['drafts'], now: NOW, ttlSeconds: 300 });

    expect(f.warning).toMatch(/did not finish checking drafts/);
    expect(f.warning).toMatch(/past the 300s freshness threshold/);
  });

  it('a live read warns when the surrounding cache was never verified', async () => {
    const f = await buildFreshness(store, { source: 'live', folders: ['inbox'], now: NOW });

    expect(f.staleness).toBe('fresh');
    expect(f.warning).toMatch(/never been checked against OurFamilyWizard/);
    expect(f.warning).toMatch(/anything you did NOT fetch in this call/);
  });

  it('a live read is `fresh` as-of now regardless of cache state', async () => {
    await seedVerified('inbox', ago(9000));

    const f = await buildFreshness(store, { source: 'live', folders: ['inbox'], now: NOW });

    expect(f.source).toBe('live');
    expect(f.staleness).toBe('fresh');
    expect(f.asOf).toBe(NOW.toISOString());
    expect(f.ageSeconds).toBe(0);
    expect(f.warning).toBeUndefined();
  });

  it('a live read stays `fresh` but still flags an incomplete backfill', async () => {
    // The fetched item is current; the surrounding cache is not complete. Say
    // both, so a caller does not read "live" as "the cache holds everything".
    await seedVerified('inbox', ago(30), 12);

    const f = await buildFreshness(store, { source: 'live', folders: ['inbox'], now: NOW });

    expect(f.staleness).toBe('fresh');
    expect(f.historyComplete).toBe(false);
    expect(f.warning).toMatch(/older history is still being backfilled/);
    expect(f.warning).toMatch(/this data is current/);
  });

  it('a live read with no folders reports complete and carries no sync timestamps', async () => {
    const f = await buildFreshness(store, { source: 'live', folders: [], now: NOW });

    expect(f.staleness).toBe('fresh');
    expect(f.lastServerSyncAt).toBeNull();
    expect(f.syncComplete).toBe(true);
    expect(f.historyComplete).toBe(true);
  });

  it('reports the age in seconds when under a minute', async () => {
    await seedVerified('inbox', ago(40));

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox'], now: NOW, ttlSeconds: 10 });

    expect(f.staleness).toBe('unverified');
    expect(f.warning).toMatch(/40 sec ago/);
  });

  it('uses the newest lastServerSyncAt across folders', async () => {
    await seedVerified('inbox', ago(500));
    await seedVerified('sent', ago(100));

    const f = await buildFreshness(store, { source: 'cache', folders: ['inbox', 'sent'], now: NOW });

    expect(f.lastServerSyncAt).toBe(ago(100));
  });
});
