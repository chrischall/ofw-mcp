import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAttachmentsDir, getCacheDbPath, getDefaultInlineAttachments } from '../src/config.js';

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
