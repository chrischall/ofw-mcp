import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sessionCachePath,
  createSessionCache,
  reportCacheWriteFailure,
} from '../src/session-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ofw-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A full env with credentials and the cache enabled. */
const withCreds = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OFW_USERNAME: 'user@example.com',
  OFW_PASSWORD: 'pw1',
  OFW_SESSION_CACHE: 'true',
  ...over,
});

describe('sessionCachePath', () => {
  it('prefers MCP_DATA_DIR, the variable mcp-host injects', () => {
    expect(sessionCachePath({ MCP_DATA_DIR: '/data' })).toBe('/data/.ofw-mcp/session.json');
  });

  it('honours an explicit OFW_SESSION_FILE', () => {
    expect(sessionCachePath({ OFW_SESSION_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' })).toBe(
      '/tmp/x.json',
    );
  });

  it('ignores a sentinel or placeholder override', () => {
    // A relative "./null" would park the session under the process cwd.
    expect(sessionCachePath({ OFW_SESSION_FILE: 'null', HOME: '/home/u' })).toBe(
      '/home/u/.ofw-mcp/session.json',
    );
  });
});

describe('createSessionCache', () => {
  it('round-trips a token through a 0600 file', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    const p = createSessionCache({ env })!;
    expect(p).not.toBeNull();
    p.save({ accessToken: 'TOK', expiresAt: Date.now() + 3_600_000 });
    const file = join(dir, '.ofw-mcp', 'session.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(createSessionCache({ env })!.load()).toEqual(
      expect.objectContaining({ accessToken: 'TOK' }),
    );
  });

  it('discards the cache when the password is rotated', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save({ accessToken: 'TOK', expiresAt: 1 });
    const rotated = createSessionCache({ env: withCreds({ MCP_DATA_DIR: dir, OFW_PASSWORD: 'pw2' }) })!;
    expect(rotated.load()).toBeNull();
  });

  it('discards the cache when the account changes', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save({ accessToken: 'TOK', expiresAt: 1 });
    const other = createSessionCache({
      env: withCreds({ MCP_DATA_DIR: dir, OFW_USERNAME: 'someone@else.com' }),
    })!;
    expect(other.load()).toBeNull();
  });

  it('matches the username case-insensitively', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save({ accessToken: 'TOK', expiresAt: 1 });
    const cased = createSessionCache({
      env: withCreds({ MCP_DATA_DIR: dir, OFW_USERNAME: '  User@Example.COM ' }),
    })!;
    expect(cased.load()).toEqual(expect.objectContaining({ accessToken: 'TOK' }));
  });

  it('writes neither the username nor the password', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save({ accessToken: 'TOK', expiresAt: 1 });
    const body = readFileSync(join(dir, '.ofw-mcp', 'session.json'), 'utf8');
    expect(body).not.toContain('pw1');
    expect(body).not.toContain('user@example.com');
  });

  it('rejects a stored record that is not a token', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save({ accessToken: 'TOK', expiresAt: 1 });
    writeFileSync(join(dir, '.ofw-mcp', 'session.json'), JSON.stringify({ nope: 1 }), {
      mode: 0o600,
    });
    expect(createSessionCache({ env })!.load()).toBeNull();
  });

  it.each([
    ['null', null],
    ['a primitive', 'nope'],
    ['an array', []],
    ['a missing accessToken', { expiresAt: 1 }],
    ['an empty accessToken', { accessToken: '', expiresAt: 1 }],
    ['a non-numeric expiresAt', { accessToken: 'T', expiresAt: 'soon' }],
    ['a non-string refreshToken', { accessToken: 'T', refreshToken: 7, expiresAt: 1 }],
  ])('rejects %s rather than handing it to the token manager', (_label, body) => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    const file = join(dir, '.ofw-mcp', 'session.json');
    createSessionCache({ env })!.save({ accessToken: 'seed', expiresAt: 1 });
    // Swap only the STATE, keeping the envelope's salted binding intact.
    // Overwriting the whole file would be rejected by the binding check before
    // the shape guard ever ran — which is the wrong reason to pass this test.
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { state: unknown };
    envelope.state = body;
    writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
    expect(createSessionCache({ env })!.load()).toBeNull();
  });

  it('accepts a record with no refreshToken', () => {
    const env = withCreds({ MCP_DATA_DIR: dir });
    const p = createSessionCache({ env })!;
    p.save({ accessToken: 'TOK', expiresAt: 42 });
    expect(p.load()).toEqual({ accessToken: 'TOK', expiresAt: 42 });
  });

  it.each([
    ['an injected per-user resolver', { injectedResolver: true }, withCreds({ MCP_DATA_DIR: '/x' })],
    ['OFW_SESSION_CACHE=false', {}, withCreds({ MCP_DATA_DIR: '/x', OFW_SESSION_CACHE: 'false' })],
    ['no username', {}, { OFW_PASSWORD: 'pw', MCP_DATA_DIR: '/x' }],
    ['no password', {}, { OFW_USERNAME: 'u', MCP_DATA_DIR: '/x' }],
  ])('is disabled for %s', (_label, opts, env) => {
    expect(createSessionCache({ ...opts, env })).toBeNull();
  });

  it('writes nothing at all when disabled', () => {
    const env = withCreds({ MCP_DATA_DIR: dir, OFW_SESSION_CACHE: 'false' });
    expect(createSessionCache({ env })).toBeNull();
    expect(existsSync(join(dir, '.ofw-mcp'))).toBe(false);
  });

  it('does not share one file between two users of the same process', () => {
    // The per-user hosted path injects its own resolver. With no
    // identity.perUserChild on the registration, a shared file would hand one
    // user's session to the next — so that path must not cache at all.
    const env = withCreds({ MCP_DATA_DIR: dir });
    createSessionCache({ env })!.save({ accessToken: 'ALICE', expiresAt: Date.now() + 3_600_000 });
    expect(createSessionCache({ env, injectedResolver: true })).toBeNull();
  });
});

describe('reportCacheWriteFailure', () => {
  it.each([
    ['an Error', new Error('EROFS'), 'EROFS'],
    ['a non-Error', 'disk gone', 'disk gone'],
  ])('names the cause for %s and stays on stderr', (_label, thrown, expected) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportCacheWriteFailure(thrown);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(expected as string));
      // stdout is the JSON-RPC channel; a stray write there corrupts the stream.
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
