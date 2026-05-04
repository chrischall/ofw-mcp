import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCacheDbPath } from '../src/config.js';

describe('getCacheDbPath', () => {
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
    if (originalCacheDir === undefined) delete process.env.OFW_CACHE_DIR;
    else process.env.OFW_CACHE_DIR = originalCacheDir;
    if (originalUsername === undefined) delete process.env.OFW_USERNAME;
    else process.env.OFW_USERNAME = originalUsername;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns a path inside OFW_CACHE_DIR with a 16-char hash filename', () => {
    const path = getCacheDbPath();
    expect(path.startsWith(tmp)).toBe(true);
    const filename = path.slice(tmp.length + 1);
    expect(filename).toMatch(/^[0-9a-f]{16}\.db$/);
  });

  it('returns the same path for the same username', () => {
    expect(getCacheDbPath()).toBe(getCacheDbPath());
  });

  it('returns different paths for different usernames', () => {
    const a = getCacheDbPath();
    process.env.OFW_USERNAME = 'other@example.com';
    const b = getCacheDbPath();
    expect(a).not.toBe(b);
  });

  it('throws if OFW_USERNAME is not set', () => {
    delete process.env.OFW_USERNAME;
    expect(() => getCacheDbPath()).toThrow(/OFW_USERNAME/);
  });
});
