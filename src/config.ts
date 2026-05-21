import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Cache identity drives the per-user SQLite DB filename. Order of preference:
//   1. OFW_CACHE_IDENTITY — explicit override for users who want to label the
//      cache themselves (e.g. when authing via fetchproxy and OFW_USERNAME is
//      not set).
//   2. OFW_USERNAME — legacy path; existing users keep their existing DB.
//   3. "_default" — fallback for fetchproxy-only setups where neither is set.
//      Single-user installs are fine on this; multi-account users should set
//      OFW_CACHE_IDENTITY explicitly so their caches don't collide.
function readCacheIdentity(): string {
  const explicit = process.env.OFW_CACHE_IDENTITY;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  const username = process.env.OFW_USERNAME;
  if (typeof username === 'string' && username.trim().length > 0) return username.trim();
  return '_default';
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

// Default for ofw_download_attachment's `inline` arg when the caller doesn't
// pass one. Set OFW_INLINE_ATTACHMENTS=true to have attachments returned as
// MCP content blocks by default (skipping disk) — useful on sandboxed MCP
// hosts where filesystem reads back to the model aren't available.
// Accepts: "1", "true", "yes", "on" (case-insensitive) → true; anything else → false.
export function getDefaultInlineAttachments(): boolean {
  const raw = process.env.OFW_INLINE_ATTACHMENTS;
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}
