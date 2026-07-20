import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FRESHNESS_TTL_SECONDS, getAttachmentsDir, getCacheDbPath, getCalendarWritesAllowed, getDefaultInlineAttachments, getCacheDir, getFreshnessTtlSeconds, getSyncMaxRequests, getWriteMode } from '../src/config.js';

describe('getCacheDbPath', () => {
  let tmp: string;
  let originalCacheDir: string | undefined;
  let originalUsername: string | undefined;
  let originalIdentity: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ofw-cache-'));
    originalCacheDir = process.env.OFW_CACHE_DIR;
    originalUsername = process.env.OFW_USERNAME;
    originalIdentity = process.env.OFW_CACHE_IDENTITY;
    process.env.OFW_CACHE_DIR = tmp;
    process.env.OFW_USERNAME = 'test@example.com';
    delete process.env.OFW_CACHE_IDENTITY;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env.OFW_CACHE_DIR;
    else process.env.OFW_CACHE_DIR = originalCacheDir;
    if (originalUsername === undefined) delete process.env.OFW_USERNAME;
    else process.env.OFW_USERNAME = originalUsername;
    if (originalIdentity === undefined) delete process.env.OFW_CACHE_IDENTITY;
    else process.env.OFW_CACHE_IDENTITY = originalIdentity;
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

  it('uses OFW_CACHE_IDENTITY when set (fetchproxy-only auth, no username)', () => {
    delete process.env.OFW_USERNAME;
    process.env.OFW_CACHE_IDENTITY = 'browser-session';
    const path = getCacheDbPath();
    const filename = path.slice(tmp.length + 1);
    expect(filename).toMatch(/^[0-9a-f]{16}\.db$/);
  });

  it('prefers OFW_CACHE_IDENTITY over OFW_USERNAME when both are set', () => {
    process.env.OFW_USERNAME = 'me@example.com';
    process.env.OFW_CACHE_IDENTITY = 'override';
    const a = getCacheDbPath();
    delete process.env.OFW_CACHE_IDENTITY;
    const b = getCacheDbPath();
    expect(a).not.toBe(b);
  });

  it('falls back to "_default" when neither OFW_USERNAME nor OFW_CACHE_IDENTITY is set', () => {
    delete process.env.OFW_USERNAME;
    // Single-user fetchproxy install: cache is keyed on the placeholder.
    // Multi-account users should set OFW_CACHE_IDENTITY explicitly.
    expect(() => getCacheDbPath()).not.toThrow();
    const path = getCacheDbPath();
    expect(path.startsWith(tmp)).toBe(true);
  });
});

describe('getAttachmentsDir', () => {
  let originalAttachmentsDir: string | undefined;

  beforeEach(() => {
    originalAttachmentsDir = process.env.OFW_ATTACHMENTS_DIR;
    delete process.env.OFW_ATTACHMENTS_DIR;
  });

  afterEach(() => {
    if (originalAttachmentsDir === undefined) delete process.env.OFW_ATTACHMENTS_DIR;
    else process.env.OFW_ATTACHMENTS_DIR = originalAttachmentsDir;
  });

  it('defaults to ~/Downloads/ofw-mcp so sandboxed MCP hosts can read the file', () => {
    expect(getAttachmentsDir()).toBe(join(homedir(), 'Downloads', 'ofw-mcp'));
  });

  it('honors OFW_ATTACHMENTS_DIR override', () => {
    process.env.OFW_ATTACHMENTS_DIR = '/custom/attachments';
    expect(getAttachmentsDir()).toBe('/custom/attachments');
  });
});

describe('getDefaultInlineAttachments', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.OFW_INLINE_ATTACHMENTS;
    delete process.env.OFW_INLINE_ATTACHMENTS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OFW_INLINE_ATTACHMENTS;
    else process.env.OFW_INLINE_ATTACHMENTS = original;
  });

  it('defaults to false when unset', () => {
    expect(getDefaultInlineAttachments()).toBe(false);
  });

  it.each(['true', 'TRUE', 'True', '1', 'yes', 'on', ' true '])('treats %j as true', (val) => {
    process.env.OFW_INLINE_ATTACHMENTS = val;
    expect(getDefaultInlineAttachments()).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', '', 'maybe'])('treats %j as false', (val) => {
    process.env.OFW_INLINE_ATTACHMENTS = val;
    expect(getDefaultInlineAttachments()).toBe(false);
  });
});

describe('getCacheDir', () => {
  it('honors OFW_CACHE_DIR when set, else falls back to ~/.cache/ofw-mcp', () => {
    const orig = process.env.OFW_CACHE_DIR;
    try {
      process.env.OFW_CACHE_DIR = '/tmp/custom-cache';
      expect(getCacheDir()).toBe('/tmp/custom-cache');
      delete process.env.OFW_CACHE_DIR;
      expect(getCacheDir()).toBe(join(homedir(), '.cache', 'ofw-mcp'));
    } finally {
      if (orig === undefined) delete process.env.OFW_CACHE_DIR;
      else process.env.OFW_CACHE_DIR = orig;
    }
  });
});

describe('getSyncMaxRequests', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_SYNC_MAX_REQUESTS;
    delete process.env.OFW_SYNC_MAX_REQUESTS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_SYNC_MAX_REQUESTS;
    else process.env.OFW_SYNC_MAX_REQUESTS = original;
  });

  it('is POSITIVE_INFINITY (unbounded) when unset or blank', () => {
    expect(getSyncMaxRequests()).toBe(Number.POSITIVE_INFINITY);
    process.env.OFW_SYNC_MAX_REQUESTS = '   ';
    expect(getSyncMaxRequests()).toBe(Number.POSITIVE_INFINITY);
  });

  it('parses a positive integer (trimmed)', () => {
    process.env.OFW_SYNC_MAX_REQUESTS = '25';
    expect(getSyncMaxRequests()).toBe(25);
    process.env.OFW_SYNC_MAX_REQUESTS = ' 200 ';
    expect(getSyncMaxRequests()).toBe(200);
  });

  it.each(['0', '-5', '12.5', 'abc', 'NaN'])('falls back to unbounded for invalid value %j', (val) => {
    process.env.OFW_SYNC_MAX_REQUESTS = val;
    expect(getSyncMaxRequests()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('getWriteMode', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
    vi.restoreAllMocks();
  });

  it('defaults to "all" when unset or blank', () => {
    delete process.env.OFW_WRITE_MODE;
    expect(getWriteMode()).toBe('all');
    process.env.OFW_WRITE_MODE = '   ';
    expect(getWriteMode()).toBe('all');
  });

  it('accepts none/drafts/all, case-insensitive and trimmed', () => {
    process.env.OFW_WRITE_MODE = 'none';
    expect(getWriteMode()).toBe('none');
    process.env.OFW_WRITE_MODE = ' Drafts ';
    expect(getWriteMode()).toBe('drafts');
    process.env.OFW_WRITE_MODE = 'ALL';
    expect(getWriteMode()).toBe('all');
  });

  it('fails closed to "none" on an unrecognized value, warning on stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OFW_WRITE_MODE = 'readonly';
    expect(getWriteMode()).toBe('none');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Unrecognized OFW_WRITE_MODE "readonly"'));
  });
});

describe('getCalendarWritesAllowed', () => {
  let originalMode: string | undefined;
  let originalFlag: string | undefined;
  beforeEach(() => {
    originalMode = process.env.OFW_WRITE_MODE;
    originalFlag = process.env.OFW_CALENDAR_WRITES;
    delete process.env.OFW_WRITE_MODE;
    delete process.env.OFW_CALENDAR_WRITES;
  });
  afterEach(() => {
    if (originalMode === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = originalMode;
    if (originalFlag === undefined) delete process.env.OFW_CALENDAR_WRITES;
    else process.env.OFW_CALENDAR_WRITES = originalFlag;
    vi.restoreAllMocks();
  });

  it('is true in mode "all" regardless of the flag', () => {
    process.env.OFW_WRITE_MODE = 'all';
    expect(getCalendarWritesAllowed()).toBe(true);
    process.env.OFW_CALENDAR_WRITES = 'false';
    expect(getCalendarWritesAllowed()).toBe(true);
  });

  it('is false in mode "drafts" without the flag', () => {
    process.env.OFW_WRITE_MODE = 'drafts';
    expect(getCalendarWritesAllowed()).toBe(false);
    process.env.OFW_CALENDAR_WRITES = 'no';
    expect(getCalendarWritesAllowed()).toBe(false);
  });

  it('is true in mode "drafts" with OFW_CALENDAR_WRITES set', () => {
    process.env.OFW_WRITE_MODE = 'drafts';
    process.env.OFW_CALENDAR_WRITES = 'true';
    expect(getCalendarWritesAllowed()).toBe(true);
  });

  it('never overrides mode "none", including the unrecognized-mode fail-closed path', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OFW_CALENDAR_WRITES = 'true';
    process.env.OFW_WRITE_MODE = 'none';
    expect(getCalendarWritesAllowed()).toBe(false);
    process.env.OFW_WRITE_MODE = 'readonly'; // fails closed to 'none'
    expect(getCalendarWritesAllowed()).toBe(false);
    expect(err).toHaveBeenCalled();
  });
});

describe('getFreshnessTtlSeconds', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_FRESHNESS_TTL_SECONDS;
    delete process.env.OFW_FRESHNESS_TTL_SECONDS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_FRESHNESS_TTL_SECONDS;
    else process.env.OFW_FRESHNESS_TTL_SECONDS = original;
  });

  it('defaults to 5 minutes when unset or blank', () => {
    expect(getFreshnessTtlSeconds()).toBe(DEFAULT_FRESHNESS_TTL_SECONDS);
    process.env.OFW_FRESHNESS_TTL_SECONDS = '   ';
    expect(getFreshnessTtlSeconds()).toBe(DEFAULT_FRESHNESS_TTL_SECONDS);
  });

  it('honours a positive integer', () => {
    process.env.OFW_FRESHNESS_TTL_SECONDS = '30';
    expect(getFreshnessTtlSeconds()).toBe(30);
  });

  it('falls back to the default on junk rather than widening the window', () => {
    // A bad value must never make stale data pass as fresh for longer, so
    // every unusable input lands on the default instead of Infinity/NaN.
    for (const bad of ['0', '-5', '1.5', 'soon', 'Infinity']) {
      process.env.OFW_FRESHNESS_TTL_SECONDS = bad;
      expect(getFreshnessTtlSeconds()).toBe(DEFAULT_FRESHNESS_TTL_SECONDS);
    }
  });
});
