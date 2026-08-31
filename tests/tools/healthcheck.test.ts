import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import type { OFWClient } from '../../src/client.js';
import {
  BRIDGE_DOWN_PREFIX,
  NO_AUTH_CONFIGURED,
  resolveAuth,
  type ResolvedAuth,
} from '../../src/auth.js';

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

  // A downed bridge is NOT "no credential". Flattening it into that arm sends
  // someone to set variables that are already set — and since mcp-utils
  // 0.19.3 classifies resolver throws, it no longer has to.
  it('classifies a downed bridge as transport, not as a missing credential', async () => {
    const r = await call(async () => {
      throw new Error(`${BRIDGE_DOWN_PREFIX} (unreachable after retry). Click the toolbar icon.`);
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('transport');
    // The real cause, and the extension-specific fix, survive into the payload.
    expect(r.error?.message).toMatch(/bridge is down/);
    expect(r.error?.message).toMatch(/toolbar icon/);
    // The hint names ONE cause now, instead of hedging across two.
    expect(r.hint).toMatch(/bridge is down/i);
    expect(r.hint).not.toMatch(/set OFW_USERNAME/);
  });

  // The other side of the same split: the unconfigured hint may now say
  // plainly that nothing is set up, because a failed path no longer lands here.
  it('gives the unconfigured case advice that no longer hedges', async () => {
    const r = await call(async () => {
      throw new Error(NO_AUTH_CONFIGURED);
    });
    expect(r.error?.kind).toBe('no_credential');
    expect(r.hint).toMatch(/OFW_USERNAME/);
    expect(r.hint).not.toMatch(/error\.message/);
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
