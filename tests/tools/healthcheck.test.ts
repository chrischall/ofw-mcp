import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import type { OFWClient } from '../../src/client.js';
import { NO_AUTH_CONFIGURED, resolveAuth, type ResolvedAuth } from '../../src/auth.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  error?: { kind: string; message: string };
  hint: string;
}

// Imported, never copied: a local copy of this string would keep this file
// green on the day auth.ts reworded it, while production silently stopped
// recognising the case.
const UNCONFIGURED = NO_AUTH_CONFIGURED;

async function call(
  resolve: () => Promise<ResolvedAuth>,
  probe: () => Promise<unknown> = async () => ({ profiles: [] }),
): Promise<Result> {
  const client = { request: probe } as unknown as OFWClient;
  const h = await createTestHarness((server) => registerHealthcheckTools(server, client, resolve));
  const res = await h.client.callTool({ name: 'ofw_healthcheck', arguments: {} });
  await h.close?.();
  return parseToolResult<Result>(res as never);
}

describe('ofw_healthcheck', () => {
  it('reports ok and WHICH path supplied the token', async () => {
    const r = await call(async () => ({ token: 'secret-token', source: 'env' }));
    expect(r.ok).toBe(true);
    expect(r.credential.source).toBe('env');
    expect(r.credential.resolved).toBe(true);
  });

  it('names the fetchproxy path when the token came from a browser tab', async () => {
    const r = await call(async () => ({ token: 't', source: 'fetchproxy' }));
    expect(r.credential.source).toBe('fetchproxy');
  });

  // The whole point of the tool: a healthcheck is what people paste into a
  // chat when something is broken, so it must never carry the credential.
  it('never echoes the token', async () => {
    const r = await call(async () => ({
      token: 'secret-token',
      source: 'env',
      expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    }));
    expect(JSON.stringify(r)).not.toContain('secret-token');
    expect(r.credential.detail).toEqual({ expires_at: '2026-09-01T00:00:00.000Z' });
  });

  it('treats "nothing configured" as no_credential and names both fixes', async () => {
    const r = await call(async () => {
      throw new Error(UNCONFIGURED);
    });
    expect(r.ok).toBe(false);
    expect(r.credential.source).toBeNull();
    expect(r.credential.resolved).toBe(false);
    expect(r.hint).toMatch(/OFW_USERNAME/);
    expect(r.hint).toMatch(/fetchproxy/i);
  });

  // A rejected password and a downed bridge are NOT "no credential". Flattening
  // them into that arm sends someone to set variables that are already set.
  it('keeps a real auth failure distinct from an unconfigured one', async () => {
    const r = await call(async () => {
      throw new Error('OFW auth: fetchproxy bridge is down (extension service worker unreachable after retry).');
    });
    expect(r.ok).toBe(false);
    expect(r.credential.source).toBeNull();
    // The real cause has to survive into the payload — this is the half the
    // shared helper preserves. The hint cannot claim which case it is (the
    // helper gives one static string to both), so it must point at the thing
    // that can: error.message.
    expect(r.error?.message).toMatch(/bridge is down/);
    expect(r.hint).toMatch(/error\.message/);
  });

  it('reports a probe failure without blaming the credential', async () => {
    const r = await call(
      async () => ({ token: 't', source: 'env' }),
      async () => {
        throw Object.assign(new Error('OFW 503'), { status: 503 });
      },
    );
    expect(r.ok).toBe(false);
    expect(r.credential.resolved).toBe(true);
  });
});

// The strings agreeing is not enough — the REAL resolver has to actually raise
// this case, or the pair could agree perfectly about a message nothing throws.
describe('the unconfigured case is what resolveAuth really raises', () => {
  const VARS = ['OFW_USERNAME', 'OFW_PASSWORD', 'OFW_DISABLE_FETCHPROXY'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Fetchproxy off, so path 2 cannot be the one that answers.
    process.env.OFW_DISABLE_FETCHPROXY = '1';
  });
  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('raises exactly NO_AUTH_CONFIGURED, which the healthcheck then recognises', async () => {
    await expect(resolveAuth()).rejects.toThrow(NO_AUTH_CONFIGURED);
    const r = await call(() => resolveAuth());
    expect(r.credential.source).toBeNull();
    expect(r.error?.kind).toBe('no_credential');
  });
});
