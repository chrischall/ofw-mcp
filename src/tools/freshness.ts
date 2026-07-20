import type { CacheStore, FolderName } from '../cache/store.js';
import { getFolderVerifiedAt } from '../sync.js';
import { getFreshnessTtlSeconds } from '../config.js';

/**
 * How much a read result can be trusted as a statement about the present.
 *
 *   fresh       Provably current: fetched live in this call, or compared
 *               against OFW within the freshness threshold by a sync that
 *               actually reached this folder.
 *   unverified  Cached, and something says we cannot vouch for it right now —
 *               it aged past the threshold, or a sync ran and never got to
 *               this folder.
 *   stale       No basis at all: this folder has never been compared against
 *               OFW, so the cache is not evidence of anything.
 *
 * Bias is one-directional and deliberate. A false `unverified` costs one extra
 * read; a false `fresh` is the bug — it lets a caller narrate remembered or
 * cached state as present-tense fact.
 */
export type Staleness = 'fresh' | 'unverified' | 'stale';

export interface FreshnessBlock {
  /** Where this payload's data came from in THIS call. */
  source: 'cache' | 'live';
  /** When the data was actually pulled from OFW. Null = never. */
  asOf: string | null;
  /** now - asOf, in seconds. Null when asOf is null. */
  ageSeconds: number | null;
  staleness: Staleness;
  /** Last sync ATTEMPT against OFW, complete or not. Null = never synced. */
  lastServerSyncAt: string | null;
  /** False when the last sync paused mid-walk or skipped a requested folder. */
  syncComplete: boolean;
  /** False while an old-history backfill is still parked. */
  historyComplete: boolean;
  /** Present whenever staleness !== 'fresh', or history is incomplete. */
  warning?: string;
}

const RANK: Record<Staleness, number> = { fresh: 0, unverified: 1, stale: 2 };

function worst(a: Staleness, b: Staleness): Staleness {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Human-readable age: seconds under a minute, else whole minutes. */
function describeAge(seconds: number): string {
  return seconds < 60 ? `${seconds} sec ago` : `${Math.round(seconds / 60)} min ago`;
}

export interface BuildFreshnessOptions {
  source: 'cache' | 'live';
  /** Folders whose cached state backs this payload. Empty for live-only reads. */
  folders: FolderName[];
  now?: Date;
  ttlSeconds?: number;
}

/**
 * Build the `freshness` block that every message/draft/folder read carries.
 *
 * The point is that the DATA announces its own age and reliability, so a
 * caller cannot assert current state without either a fresh read or an
 * explicit staleness caveat it has to surface. Nothing here depends on the
 * model remembering to re-check.
 *
 * Across multiple folders the block reports the WORST staleness and the OLDEST
 * asOf: a response is only as trustworthy as its least-verified input.
 */
export async function buildFreshness(
  store: CacheStore,
  opts: BuildFreshnessOptions,
): Promise<FreshnessBlock> {
  const now = opts.now ?? new Date();
  const ttl = opts.ttlSeconds ?? getFreshnessTtlSeconds();

  // A cache read backed by NO folder has verified nothing, so nothing in the
  // per-folder loop below can downgrade the 'fresh' initializer — it would
  // return `staleness: 'fresh'` alongside `asOf: null`, self-contradictory by
  // this module's own definition and the one shape that carries no warning at
  // all. Reachable via ofw_sync_messages({folders: []}). Fail to `stale`: an
  // empty scope is the least evidence possible, not the most.
  // (A LIVE read with no folders is different and legitimate — that is
  // ofw_list_message_folders, whose data came straight off the wire.)
  const emptyScope = opts.source === 'cache' && opts.folders.length === 0;
  let staleness: Staleness = emptyScope ? 'stale' : 'fresh';
  let oldestVerifiedAt: string | null = null;
  let sawNeverVerified = false;
  let lastServerSyncAt: string | null = null;
  let historyComplete = true;
  // An empty scope verified nothing, so it cannot claim a complete sync.
  let syncComplete = !emptyScope;
  const deferred: FolderName[] = [];
  const backfilling: FolderName[] = [];

  for (const folder of opts.folders) {
    const verifiedAt = await getFolderVerifiedAt(store, folder);
    const state = await store.getSyncState(folder);

    if (state !== null && (lastServerSyncAt === null || state.lastSyncAt > lastServerSyncAt)) {
      lastServerSyncAt = state.lastSyncAt;
    }
    // A parked backfill means old history is incomplete. It does NOT downgrade
    // staleness: the forward pass runs from page 1 on every call, so the
    // present is current even while history is still being walked. Letting a
    // months-long backfill mark every read `unverified` would train the caller
    // to ignore the warning entirely.
    if (state !== null && state.resumePage !== null) {
      historyComplete = false;
      syncComplete = false;
      backfilling.push(folder);
    }

    if (verifiedAt === null) {
      sawNeverVerified = true;
      staleness = worst(staleness, 'stale');
      syncComplete = false;
      continue;
    }

    if (oldestVerifiedAt === null || verifiedAt < oldestVerifiedAt) oldestVerifiedAt = verifiedAt;

    // A sync ran AFTER the last verification of this folder — i.e. it was
    // attempted and skipped (budget exhausted before reaching it). Recency of
    // the older stamp must not keep it `fresh`; the skip is itself evidence
    // that we do not currently know this folder's state.
    if (state !== null && state.lastSyncAt > verifiedAt) {
      staleness = worst(staleness, 'unverified');
      syncComplete = false;
      deferred.push(folder);
      continue;
    }

    // Clamp at 0: a verifiedAt in the future (clock skew between the machine
    // that wrote it and this one) must not read as a large negative age that
    // can never exceed the threshold — that would be a silent false `fresh`.
    const age = Math.max(0, Math.floor((now.getTime() - Date.parse(verifiedAt)) / 1000));
    if (age > ttl) staleness = worst(staleness, 'unverified');
  }

  // A live read is current by construction — that is the whole point of paying
  // for it — so it reports fresh regardless of what the cache looks like.
  if (opts.source === 'live') {
    const asOf = now.toISOString();
    const block: FreshnessBlock = {
      source: 'live',
      asOf,
      ageSeconds: 0,
      staleness: 'fresh',
      lastServerSyncAt,
      syncComplete,
      historyComplete,
    };
    const liveReasons: string[] = [];
    if (sawNeverVerified) {
      liveReasons.push('the surrounding cache has never been checked against OurFamilyWizard, so anything you did NOT fetch in this call is unverified');
    }
    if (backfilling.length > 0) {
      liveReasons.push(`older history is still being backfilled for ${backfilling.join(', ')}, so older messages may be missing from the cache`);
    }
    if (liveReasons.length > 0) {
      block.warning = `Fetched live from OurFamilyWizard, so this data is current. Note that ${liveReasons.join('; ')}.`;
    }
    return block;
  }

  const asOf = sawNeverVerified ? null : oldestVerifiedAt;
  const ageSeconds = asOf === null
    ? null
    : Math.max(0, Math.floor((now.getTime() - Date.parse(asOf)) / 1000));

  const block: FreshnessBlock = {
    source: 'cache',
    asOf,
    ageSeconds,
    staleness,
    lastServerSyncAt,
    syncComplete,
    historyComplete,
  };

  const reasons: string[] = [];
  if (emptyScope) {
    reasons.push('this result is backed by no synced folder at all, so nothing about it has been verified');
  }
  if (sawNeverVerified) {
    reasons.push('this data has never been checked against OurFamilyWizard');
  }
  if (deferred.length > 0) {
    reasons.push(`the last sync did not finish checking ${deferred.join(', ')}`);
  }
  // Reported independently of the deferral: a response can be BOTH deferred
  // and badly aged, and naming only the deferral understates how old it is.
  if (asOf !== null && ageSeconds !== null && ageSeconds > ttl) {
    reasons.push(`that is past the ${ttl}s freshness threshold`);
  }
  if (backfilling.length > 0) {
    reasons.push(`older history is still being backfilled for ${backfilling.join(', ')}`);
  }

  if (reasons.length > 0) {
    const served = asOf === null
      ? 'Served from cache that was never verified against OurFamilyWizard'
      : `Served from cache last verified ${describeAge(ageSeconds as number)}`;
    block.warning = `${served}; ${reasons.join('; ')}. Re-read before asserting current state — call ofw_check_freshness for a cheap live confirmation, or ofw_sync_messages to refresh.`;
  }

  return block;
}
