import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

function readUsername(): string {
  const raw = process.env.OFW_USERNAME;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('OFW_USERNAME must be set to derive cache path');
  }
  return raw.trim();
}

export function getCacheDir(): string {
  const override = process.env.OFW_CACHE_DIR;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), '.cache', 'ofw-mcp');
}

export function getCacheDbPath(): string {
  const username = readUsername();
  const hash = createHash('sha256').update(username).digest('hex').slice(0, 16);
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
