import { describe, it, expect, vi, afterEach } from 'vitest';
import { CredentialsRejectedError, loginWithPassword } from '../src/auth-password.js';

interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Individual Set-Cookie headers, as Headers.getSetCookie() returns them. */
  setCookies?: string[];
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
      headers: {
        get: (key: string) => headerMap[key.toLowerCase()] ?? null,
        getSetCookie: () =>
          r.setCookies ?? (headerMap['set-cookie'] ? [headerMap['set-cookie']] : []),
      },
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

  it('echoes every cookie when init sets multiple Set-Cookie headers', async () => {
    const spy = mockFetch([
      { status: 303, setCookies: ['SESSION=abc; Path=/ofw; HttpOnly', 'XSRF-TOKEN=tok; Path=/'] },
      { status: 200, body: { auth: 't' }, headers: { 'content-type': 'application/json' } },
    ]);
    await loginWithPassword('u', 'p');
    const postHeaders = (spy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(postHeaders.Cookie).toBe('SESSION=abc; XSRF-TOKEN=tok');
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

  it('still reports the status when a non-2xx login body cannot be read', async () => {
    // The edge-block check reads the body; a body that errors mid-read must
    // not replace the login failure with a stream error.
    const spy = mockFetch([
      { status: 303, headers: { 'set-cookie': 'SESSION=x' } },
      { status: 401, body: {}, headers: { 'content-type': 'application/json' } },
    ]);
    const real = spy.getMockImplementation()!;
    let call = 0;
    spy.mockImplementation(async (...args) => {
      const res = await real(...(args as Parameters<typeof fetch>));
      return ++call === 2
        ? ({ ...res, text: async () => Promise.reject(new Error('stream reset')) } as unknown as Response)
        : res;
    });
    await expect(loginWithPassword('u', 'bad')).rejects.toThrow(/OFW login failed: 401/);
  });

  it('throws a clean credentials message (not the HTML dump) when OFW re-serves its login page', async () => {
    const loginHtml = '<!DOCTYPE html><html lang="en"><head><title>OurFamilyWizard</title></head><body>...</body></html>';
    mockFetch([
      { status: 303, headers: { 'set-cookie': 'SESSION=x' } },
      { status: 200, body: loginHtml, headers: { 'content-type': 'text/html' } },
    ]);
    expect.assertions(2);
    try {
      await loginWithPassword('u', 'wrong');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/email or password was not accepted/);
      // The raw HTML page must NOT leak into the error surfaced to the user.
      expect(msg).not.toContain('<!DOCTYPE');
    }
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

// BUG-5: a 200 JSON answer without a usable `auth` (a lockout, MFA or captcha
// challenge) must not become the token "undefined" — every request would then
// carry `Bearer undefined`, 401, and re-mint through another password POST.
describe('loginWithPassword — JSON response without a token', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['no auth field', { error: 'ACCOUNT_LOCKED', message: 'Your account is locked' }],
    ['an empty auth', { auth: '', redirectUrl: '/x' }],
    ['a non-string auth', { auth: 42 }],
    ['a non-object body', null],
  ])('throws an actionable error for %s', async (_label, body) => {
    mockFetch([
      { status: 303, headers: {} },
      { status: 200, body, headers: { 'content-type': 'application/json' } },
    ]);
    await expect(loginWithPassword('u', 'p')).rejects.toThrow(/OFW login returned no token/);
  });

  it('names the response keys and OFW\'s message, but never echoes other values', async () => {
    mockFetch([
      { status: 303, headers: {} },
      {
        status: 200,
        body: { message: 'Verification code required', challengeId: 'secret-challenge-123' },
        headers: { 'content-type': 'application/json' },
      },
    ]);
    const err = await loginWithPassword('u', 'p').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('challengeId');
    expect(err.message).toContain('Verification code required');
    expect(err.message).not.toContain('secret-challenge-123');
  });

  it('does not latch the pair: the next call tries OFW again', async () => {
    mockFetch([
      { status: 303, headers: {} },
      { status: 200, body: {}, headers: { 'content-type': 'application/json' } },
      { status: 303, headers: {} },
      { status: 200, body: { auth: 'tok' }, headers: { 'content-type': 'application/json' } },
    ]);
    await expect(loginWithPassword('u', 'p')).rejects.toThrow(/no token/);
    await expect(loginWithPassword('u', 'p')).resolves.toMatchObject({ token: 'tok' });
  });
});

// BUG-1: OFW counts failed sign-ins against the account. A password it has
// definitively rejected must not be re-sent on every later tool call (a model
// retrying a few tools after the user changed their password on the web would
// otherwise walk a court-record account into a lockout).
describe('loginWithPassword — credential-rejection latch', () => {
  afterEach(() => vi.restoreAllMocks());
  const loginHtml = '<!DOCTYPE html><html><body>login</body></html>';
  const rejected = (): MockResponse[] => [
    { status: 303, headers: { 'set-cookie': 'SESSION=x' } },
    { status: 200, body: loginHtml, headers: { 'content-type': 'text/html' } },
  ];

  it('after OFW rejects a username/password, the same pair is refused locally — no second login POST', async () => {
    const spy = mockFetch([...rejected(), ...rejected()]);
    await expect(loginWithPassword('latch-a@example.test', 'old-pass')).rejects.toBeInstanceOf(CredentialsRejectedError);
    expect(spy).toHaveBeenCalledTimes(2);

    const second = loginWithPassword('latch-a@example.test', 'old-pass');
    await expect(second).rejects.toBeInstanceOf(CredentialsRejectedError);
    await expect(second).rejects.toThrow(/already rejected.*OFW_PASSWORD/s);
    expect(spy).toHaveBeenCalledTimes(2); // nothing new went to OFW
  });

  it('a changed password is tried again (the latch is keyed on the credentials)', async () => {
    const spy = mockFetch([
      ...rejected(),
      { status: 303, headers: { 'set-cookie': 'SESSION=y' } },
      { status: 200, body: { auth: 'tok' }, headers: { 'content-type': 'application/json' } },
    ]);
    await expect(loginWithPassword('latch-b@example.test', 'old-pass')).rejects.toBeInstanceOf(CredentialsRejectedError);
    await expect(loginWithPassword('latch-b@example.test', 'new-pass')).resolves.toMatchObject({ token: 'tok' });
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('a transient failure (5xx) does NOT latch — the next call retries', async () => {
    const spy = mockFetch([
      { status: 303, headers: {} },
      { status: 503 },
      { status: 303, headers: {} },
      { status: 200, body: { auth: 'tok' }, headers: { 'content-type': 'application/json' } },
    ]);
    await expect(loginWithPassword('latch-c@example.test', 'p')).rejects.toThrow(/503/);
    await expect(loginWithPassword('latch-c@example.test', 'p')).resolves.toMatchObject({ token: 'tok' });
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
