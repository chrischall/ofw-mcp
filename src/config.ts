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

// Default for ofw_download_attachment's `inline` arg when the caller doesn't
// pass one. Set OFW_INLINE_ATTACHMENTS=true to have attachments returned as
// MCP content blocks by default (skipping disk) — useful on sandboxed MCP
// hosts where filesystem reads back to the model aren't available.
export function getDefaultInlineAttachments(): boolean {
  return parseBoolEnv('OFW_INLINE_ATTACHMENTS');
}
