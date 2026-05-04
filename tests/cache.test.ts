import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCache, closeCache } from '../src/cache.js';

let tmp: string;
let originalCacheDir: string | undefined;
let originalUsername: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ofw-cache-'));
  originalCacheDir = process.env.OFW_CACHE_DIR;
  originalUsername = process.env.OFW_USERNAME;
  process.env.OFW_CACHE_DIR = tmp;
  process.env.OFW_USERNAME = 'test@example.com';
});

afterEach(() => {
  closeCache();
  if (originalCacheDir === undefined) delete process.env.OFW_CACHE_DIR;
  else process.env.OFW_CACHE_DIR = originalCacheDir;
  if (originalUsername === undefined) delete process.env.OFW_USERNAME;
  else process.env.OFW_USERNAME = originalUsername;
  rmSync(tmp, { recursive: true, force: true });
});

describe('openCache', () => {
  it('creates the cache directory and database file on first open', () => {
    const cache = openCache();
    expect(existsSync(tmp)).toBe(true);
    expect(cache).toBeDefined();
  });

  it('runs schema migrations on first open', () => {
    const cache = openCache();
    const tables = cache.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('messages');
    expect(names).toContain('drafts');
    expect(names).toContain('sync_state');
    expect(names).toContain('meta');
  });

  it('records schema_version=1 in meta', () => {
    const cache = openCache();
    const row = cache.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    expect(row?.value).toBe('1');
  });

  it('is idempotent — opening twice does not error', () => {
    openCache();
    closeCache();
    expect(() => openCache()).not.toThrow();
  });
});
