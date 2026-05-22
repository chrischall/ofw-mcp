import { describe, it, expect, vi, afterEach } from 'vitest';
import { loginWithPassword } from '../src/auth-password.js';

interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockFetch(responses: MockResponse[]) {
  let idx = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[idx++] ?? { status: 200, body: {} };
    const headerMap = r.headers ?? {};
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      headers: { get: (key: string) => headerMap[key.toLowerCase()] ?? null },
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    } as unknown as Response;
  });
}

// Direct unit tests for the Spring Security form-login helper. Previously
// only exercised end-to-end through OFWClient — this gives us a faster
// signal on regressions in cookie parsing, error paths, and the response-
// shape contract.
describe('loginWithPassword', () => {
  afterEach(() => vi.restoreAllMocks());

  it('captures SESSION cookie from init, posts URL-encoded form, returns token + ~6h expiry', async () => {
    const spy = mockFetch([
      { status: 303, headers: { 'set-cookie': 'SESSION=abc123; Path=/ofw; HttpOnly' } },
      {
        status: 200,
        body: { auth: 'bearer-xyz', redirectUrl: '/app/home' },
        headers: { 'content-type': 'application/json' },
      },
    ]);

    const before = Date.now();
    const result = await loginWithPassword('me@example.com', 'pw');
    const after = Date.now();

    expect(result.token).toBe('bearer-xyz');
    // Synthesized 6h TTL
    const ttlMs = result.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000 + (after - before) + 10);

    // Second call (POST) carried the Cookie + ofw-* headers + form body
    const postInit = spy.mock.calls[1][1] as RequestInit;
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postHeaders.Cookie).toBe('SESSION=abc123');
    expect(postHeaders['ofw-client']).toBe('WebApplication');
    expect(postHeaders['ofw-version']).toBe('1.0.0');
    expect(postHeaders['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(postInit.body).toContain('username=me%40example.com');
    expect(postInit.body).toContain('password=pw');
    expect(postInit.body).toContain('submit=Sign+In');
  });

  it('omits Cookie header when init returns no set-cookie', async () => {
    const spy = mockFetch([
      { status: 303, headers: {} },
      { status: 200, body: { auth: 't' }, headers: { 'content-type': 'application/json' } },
    ]);
    await loginWithPassword('u', 'p');
    const postHeaders = (spy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(postHeaders.Cookie).toBeUndefined();
  });

  it('throws with status + statusText when login POST returns non-2xx', async () => {
    mockFetch([
      { status: 303, headers: { 'set-cookie': 'SESSION=x' } },
      { status: 401, body: {}, headers: { 'content-type': 'application/json' } },
    ]);
    await expect(loginWithPassword('u', 'bad')).rejects.toThrow(/OFW login failed: 401/);
  });

  it('throws with truncated body preview when login returns non-JSON', async () => {
    const html = '<html><body>maintenance</body></html>'.repeat(20);
    mockFetch([
      { status: 303, headers: {} },
      { status: 200, body: html },
    ]);
    await expect(loginWithPassword('u', 'p')).rejects.toThrow(/unexpected response/);
    // Body preview is clipped to 200 chars (per source) — full HTML is ~700.
    // Confirm by catching the error and inspecting the message length.
    try {
      mockFetch([
        { status: 303, headers: {} },
        { status: 200, body: html },
      ]);
      await loginWithPassword('u', 'p');
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(300);
    }
  });
});
