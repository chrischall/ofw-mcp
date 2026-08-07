import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseBoolEnv, readEnvVar } from '@chrischall/mcp-utils';

// Cache identity drives the per-user SQLite DB filename. Order of preference:
//   1. OFW_CACHE_IDENTITY — explicit override for users who want to label the
//      cache themselves (e.g. when authing via fetchproxy and OFW_USERNAME is
//      not set).
//   2. OFW_USERNAME — legacy path; existing users keep their existing DB.
//   3. "_default" — fallback for fetchproxy-only setups where neither is set.
//      Single-user installs are fine on this; multi-account users should set
//      OFW_CACHE_IDENTITY explicitly so their caches don't collide.
function readCacheIdentity(): string {
  return readEnvVar('OFW_CACHE_IDENTITY') ?? readEnvVar('OFW_USERNAME') ?? '_default';
}

export function getCacheDir(): string {
  const override = process.env.OFW_CACHE_DIR;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), '.cache', 'ofw-mcp');
}

export function getCacheDbPath(): string {
  const identity = readCacheIdentity();
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return join(getCacheDir(), `${hash}.db`);
}

export function getAttachmentsDir(): string {
  const override = process.env.OFW_ATTACHMENTS_DIR;
  if (override && override.trim().length > 0) return override.trim();
  // Default to ~/Downloads/ofw-mcp/ — the cache dir (~/.cache/...) is hidden and
  // typically outside the filesystem allowlist of sandboxed MCP hosts like
  // Claude Desktop, so files written there are unreadable to the model that
  // just downloaded them. Downloads is the standard "user-accessible files"
  // location across macOS/Linux/Windows.
  return join(homedir(), 'Downloads', 'ofw-mcp');
}

export type WriteMode = 'none' | 'drafts' | 'all';

/**
 * Gate for write-tool registration, read at registration time (startup).
 *
 *   none    No write tools are registered — pure read/sync/search surface.
 *   drafts  Draft-level writes only (ofw_save_draft, ofw_delete_draft,
 *           ofw_upload_attachment). Nothing that lands on the court-visible
 *           record (send, calendar/expense/journal writes) is registered —
 *           the only way to send remains a human in the OFW web UI.
 *   all     Every tool registers (the default; fully backward compatible).
 *
 * Unregistered tools cannot be invoked by any host permission setting or
 * injected instruction — the gate is structural, not behavioral. An
 * unrecognized value fails closed to 'none': this is a safety control, so a
 * typo must never silently grant write access.
 */
export function getWriteMode(): WriteMode {
  const raw = process.env.OFW_WRITE_MODE;
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'all';
  const mode = raw.trim().toLowerCase();
  if (mode === 'none' || mode === 'drafts' || mode === 'all') return mode;
  // stdio transport: stderr only — stdout is reserved for JSON-RPC.
  console.error(
    `[ofw-mcp] Unrecognized OFW_WRITE_MODE "${raw.trim()}" — failing closed to "none" (no write tools registered). Valid values: none, drafts, all.`,
  );
  return 'none';
}

/**
 * Calendar-write opt-in for 'drafts' deployments.
 *
 * Messages have a draft stage (the human sends from the web UI), so 'drafts'
 * mode keeps a human between model output and the court-visible record.
 * Calendar events have no draft stage — but unlike a sent message they are
 * fully reversible (editable and deletable), so a drafts-mode user may accept
 * direct calendar writes without accepting sends. Setting
 * OFW_CALENDAR_WRITES=true registers the calendar write tools
 * (ofw_create_event, ofw_update_event, ofw_delete_event) alongside the
 * draft-level message writes.
 *
 * The flag never overrides 'none': that mode is the hard read-only guarantee,
 * including the fail-closed result of an unrecognized OFW_WRITE_MODE.
 */
export function getCalendarWritesAllowed(): boolean {
  const mode = getWriteMode();
  if (mode === 'all') return true;
  return mode === 'drafts' && parseBoolEnv('OFW_CALENDAR_WRITES');
}

/**
 * Deployment-wide ceiling on reads that STAMP the record.
 *
 * Fetching a message body from OFW marks it read and stamps a "First Viewed"
 * timestamp the co-parent can see. That is part of the court-visible record and
 * it cannot be undone — and unlike a send, it happens as a side effect of an
 * ordinary read, so nothing about the caller's intent signals it.
 *
 * Default TRUE: unset means exactly the behaviour that shipped before this flag
 * existed. Set OFW_ALLOW_MARK_READ=false and it becomes a hard ceiling rather
 * than a default — `ofw_get_message` refuses a fetch that would stamp,
 * `ofw_check_freshness` ignores `allowMarkRead:true`, and `ofw_sync_messages`
 * ignores `fetchUnreadBodies:true`. A per-call argument (or an instruction
 * injected into one) cannot raise it, which is the same structural posture
 * OFW_WRITE_MODE takes for writes.
 *
 * An unrecognized value fails CLOSED, with a warning: someone who wrote
 * "flase" meant to disable this, and honouring the typo as the permissive
 * default would keep stamping the record while looking configured.
 */
export function getAllowMarkRead(): boolean {
  const raw = process.env.OFW_ALLOW_MARK_READ;
  if (typeof raw !== 'string' || raw.trim().length === 0) return true;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  // stdio transport: stderr only — stdout is reserved for JSON-RPC.
  console.error(
    `[ofw-mcp] Unrecognized OFW_ALLOW_MARK_READ "${raw.trim()}" — failing closed to "false" (no tool may mark a message read on OFW). Valid values: true, false.`,
  );
  return false;
}

/**
 * Default for ofw_sync_messages' `fetchUnreadBodies` arg. False (the shipped
 * default) so an ordinary sync never stamps unread inbox messages; set
 * OFW_FETCH_UNREAD_BODIES=true on a deployment where read receipts are routine
 * and you would rather have the bodies cached. Capped by getAllowMarkRead().
 */
export function getFetchUnreadBodies(): boolean {
  return parseBoolEnv('OFW_FETCH_UNREAD_BODIES');
}

/**
 * Default for the read tools' `autoRefresh` arg.
 *
 * When a cached read comes back EMPTY and the cache is not `fresh`, the tools
 * refuse to report that emptiness (see UNVERIFIED_EMPTY in tools/messages.ts):
 * an empty result from a 207-minute-old cache is shaped identically to a
 * verified "nothing there", and answering "no, it wasn't sent" from one is how
 * a false negative becomes a confident statement about a legal record.
 *
 * The refusal names its remedy, so the default (false) costs one extra call.
 * Set OFW_AUTO_REFRESH=true and the tools instead sync the backing folders
 * themselves and answer from the refreshed cache — same guarantee, no round
 * trip. Never silently degrades: if the refresh does not make the read
 * verifiable, the refusal still fires.
 */
export function getAutoRefreshStaleReads(): boolean {
  return parseBoolEnv('OFW_AUTO_REFRESH');
}

// Default for ofw_download_attachment's `inline` arg when the caller doesn't
// pass one. Set OFW_INLINE_ATTACHMENTS=true to have attachments returned as
// MCP content blocks by default (skipping disk) — necessary wherever the
// caller cannot read the server's filesystem.
export function getDefaultInlineAttachments(): boolean {
  return parseBoolEnv('OFW_INLINE_ATTACHMENTS');
}

/**
 * Per-invocation OFW-request budget for ofw_sync_messages.
 *
 * A hosted deployment may enforce a request cap per call
 * (every OFW API fetch and every cache round trip counts), so a deep
 * backfill must be bounded and resumable there. Set OFW_SYNC_MAX_REQUESTS to a
 * positive integer to cap the number of OFW requests one sync call may make
 * before pausing; the next call resumes the walk (deep or not) where it left off.
 *
 * Unset / blank / non-positive / non-integer → POSITIVE_INFINITY, i.e. the
 * local stdio server stays unbounded (walks fully in one call) by default.
 */
export function getSyncMaxRequests(): number {
  const raw = readEnvVar('OFW_SYNC_MAX_REQUESTS');
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return Number.POSITIVE_INFINITY;
  return n;
}

/** Default for getFreshnessTtlSeconds() when OFW_FRESHNESS_TTL_SECONDS is unset. */
export const DEFAULT_FRESHNESS_TTL_SECONDS = 300;

/**
 * How long a folder's verified-against-OFW state stays labelled `fresh`.
 *
 * Read tools serve from the local cache, so every read result carries a
 * `freshness` block saying when the data was last actually compared against
 * OFW. Past this age the block downgrades to `unverified` and grows a warning,
 * because a co-parent can send a message — or edit a draft in the OFW web app,
 * which bumps no timestamp at all — at any moment without us hearing about it.
 *
 * Set OFW_FRESHNESS_TTL_SECONDS to a positive integer to tune it. Anything
 * else (unset / blank / zero / negative / non-integer) falls back to the
 * default: a bad value must not silently widen the window in which stale data
 * is presented as current.
 */
export function getFreshnessTtlSeconds(): number {
  const raw = readEnvVar('OFW_FRESHNESS_TTL_SECONDS');
  if (raw === undefined) return DEFAULT_FRESHNESS_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_FRESHNESS_TTL_SECONDS;
  return n;
}
