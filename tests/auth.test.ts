import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolveAuth() drives three paths:
//   1. env vars (OFW_USERNAME + OFW_PASSWORD) → password login POST
//   2. fetchproxy fallback (read browser session via @fetchproxy/bootstrap)
//   3. error: tell the user to set creds or sign in via the extension
//
// These tests verify path selection, error shapes, and that we don't accidentally
// preempt env-var auth when it's set.

// Mock @fetchproxy/bootstrap at the module boundary — never hit a real WS.
const bootstrapMock = vi.fn();
vi.mock('@fetchproxy/bootstrap', () => ({
  bootstrap: (...args: unknown[]) => bootstrapMock(...args),
}));

// And mock the password-login helper so we can assert it's called with the right creds.
const loginWithPasswordMock = vi.fn();
vi.mock('../src/auth-password.js', () => ({
  loginWithPassword: (...args: unknown[]) => loginWithPasswordMock(...args),
}));

import { resolveAuth } from '../src/auth.js';

describe('resolveAuth', () => {
  let originalUsername: string | undefined;
  let originalPassword: string | undefined;
  let originalDisable: string | undefined;

  beforeEach(() => {
    originalUsername = process.env.OFW_USERNAME;
    originalPassword = process.env.OFW_PASSWORD;
    originalDisable = process.env.OFW_DISABLE_FETCHPROXY;
    delete process.env.OFW_USERNAME;
    delete process.env.OFW_PASSWORD;
    delete process.env.OFW_DISABLE_FETCHPROXY;
    bootstrapMock.mockReset();
    loginWithPasswordMock.mockReset();
  });

  afterEach(() => {
    if (originalUsername === undefined) delete process.env.OFW_USERNAME;
    else process.env.OFW_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.OFW_PASSWORD;
    else process.env.OFW_PASSWORD = originalPassword;
    if (originalDisable === undefined) delete process.env.OFW_DISABLE_FETCHPROXY;
    else process.env.OFW_DISABLE_FETCHPROXY = originalDisable;
  });

  describe('path 1: env-var credentials', () => {
    it('uses password login when both OFW_USERNAME and OFW_PASSWORD are set', async () => {
      process.env.OFW_USERNAME = 'me@example.com';
      process.env.OFW_PASSWORD = 'hunter2';
      const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
      loginWithPasswordMock.mockResolvedValue({ token: 'tok-from-pw', expiresAt });

      const result = await resolveAuth();

      expect(loginWithPasswordMock).toHaveBeenCalledWith('me@example.com', 'hunter2');
      expect(bootstrapMock).not.toHaveBeenCalled();
      expect(result).toEqual({ token: 'tok-from-pw', expiresAt, source: 'env' });
    });

    it('takes env-var precedence even when fetchproxy is enabled', async () => {
      process.env.OFW_USERNAME = 'me@example.com';
      process.env.OFW_PASSWORD = 'hunter2';
      loginWithPasswordMock.mockResolvedValue({ token: 'tok-from-pw' });

      await resolveAuth();

      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it('does not treat username alone (no password) as env-var credentials', async () => {
      // username is needed elsewhere for cache keying — it must NOT mean
      // "use password login" without a password.
      process.env.OFW_USERNAME = 'me@example.com';
      bootstrapMock.mockResolvedValue({
        cookies: {},
        localStorage: { auth: 'tok-from-fp', tokenExpiry: '' },
        sessionStorage: {},
        capturedHeaders: {},
      });

      const result = await resolveAuth();

      expect(loginWithPasswordMock).not.toHaveBeenCalled();
      expect(bootstrapMock).toHaveBeenCalled();
      expect(result.source).toBe('fetchproxy');
    });
  });

  describe('path 2: fetchproxy fallback', () => {
    it('reads auth + tokenExpiry from localStorage via bootstrap()', async () => {
      const isoExpiry = '2027-01-01T00:00:00.000Z';
      bootstrapMock.mockResolvedValue({
        cookies: {},
        localStorage: { auth: 'tok-from-fp', tokenExpiry: isoExpiry },
        sessionStorage: {},
        capturedHeaders: {},
      });

      const result = await resolveAuth();

      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      const opts = bootstrapMock.mock.calls[0][0] as {
        serverName: string;
        version: string;
        domains: string[];
        declare: { cookies: string[]; localStorage: string[]; sessionStorage: string[]; captureHeaders: unknown[] };
      };
      expect(opts.serverName).toBe('ofw-mcp');
      expect(typeof opts.version).toBe('string');
      expect(opts.domains).toEqual(['ourfamilywizard.com']);
      expect(opts.declare.localStorage).toEqual(['auth', 'tokenExpiry']);
      expect(opts.declare.cookies).toEqual([]);
      expect(opts.declare.sessionStorage).toEqual([]);
      expect(opts.declare.captureHeaders).toEqual([]);

      expect(result.token).toBe('tok-from-fp');
      expect(result.source).toBe('fetchproxy');
      expect(result.expiresAt?.toISOString()).toBe(isoExpiry);
    });

    it('passes through with no expiry when tokenExpiry is missing', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: {},
        localStorage: { auth: 'tok-from-fp' },
        sessionStorage: {},
        capturedHeaders: {},
      });

      const result = await resolveAuth();

      expect(result.token).toBe('tok-from-fp');
      expect(result.expiresAt).toBeUndefined();
    });

    it('throws with a helpful message when localStorage["auth"] is missing', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: {},
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      });

      await expect(resolveAuth()).rejects.toThrow(/fetchproxy fallback failed/);
      await expect(resolveAuth()).rejects.toThrow(/Sign into OFW in your browser/);
    });

    it('wraps bootstrap() errors with actionable context', async () => {
      bootstrapMock.mockRejectedValue(new Error('extension offline'));

      await expect(resolveAuth()).rejects.toThrow(/fetchproxy fallback failed: extension offline/);
    });
  });

  describe('env-var sanitization', () => {
    // Matches the readVar() helper hardening that used to live in client.ts:
    // defenses against MCP hosts that pass through unexpanded `${VAR}` or
    // serialize undefined/null as a string.
    it.each(['undefined', 'null', '${OFW_PASSWORD}', '   ', ''])(
      'treats OFW_PASSWORD=%j as unset and falls through to fetchproxy',
      async (val) => {
        process.env.OFW_USERNAME = 'me@example.com';
        process.env.OFW_PASSWORD = val;
        bootstrapMock.mockResolvedValue({
          cookies: {},
          localStorage: { auth: 'tok' },
          sessionStorage: {},
          capturedHeaders: {},
        });

        const result = await resolveAuth();

        expect(loginWithPasswordMock).not.toHaveBeenCalled();
        expect(result.source).toBe('fetchproxy');
      },
    );
  });

  describe('error handling', () => {
    it('handles non-Error rejections from bootstrap()', async () => {
      bootstrapMock.mockRejectedValue('plain string failure');

      await expect(resolveAuth()).rejects.toThrow(/fetchproxy fallback failed: plain string failure/);
    });
  });

  describe('path 3: nothing configured', () => {
    it('skips fetchproxy when OFW_DISABLE_FETCHPROXY=1 is set', async () => {
      process.env.OFW_DISABLE_FETCHPROXY = '1';

      await expect(resolveAuth()).rejects.toThrow(/OFW_USERNAME \+ OFW_PASSWORD/);
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it.each(['1', 'true', 'yes', 'on', 'TRUE'])(
      'treats OFW_DISABLE_FETCHPROXY=%j as disabled',
      async (val) => {
        process.env.OFW_DISABLE_FETCHPROXY = val;
        await expect(resolveAuth()).rejects.toThrow(/OFW_USERNAME/);
        expect(bootstrapMock).not.toHaveBeenCalled();
      },
    );

    it.each(['0', 'false', 'no', '', 'off'])(
      'treats OFW_DISABLE_FETCHPROXY=%j as enabled (default)',
      async (val) => {
        process.env.OFW_DISABLE_FETCHPROXY = val;
        bootstrapMock.mockResolvedValue({
          cookies: {},
          localStorage: { auth: 'tok' },
          sessionStorage: {},
          capturedHeaders: {},
        });
        await resolveAuth();
        expect(bootstrapMock).toHaveBeenCalled();
      },
    );
  });
});
