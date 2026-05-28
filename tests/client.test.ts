import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OFWClient } from '../src/client.js';

const MOCK_TOKEN = 'test-token-abc';

interface MockResponse {
  status: number;
  body?: unknown;
  bytes?: Uint8Array;
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
      text: async () => JSON.stringify(r.body),
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer,
    } as unknown as Response;
  });
}

// Every login now makes 2 fetches: GET /ofw/login.form + POST /ofw/login
const LOGIN_INIT = {
  status: 303,
  headers: { 'set-cookie': 'SESSION=test-session; Path=/ofw; HttpOnly' },
};
const LOGIN_SUCCESS = {
  status: 200,
  body: { auth: MOCK_TOKEN, redirectUrl: '/app/home' },
  headers: { 'content-type': 'application/json' },
};

describe('OFWClient', () => {
  beforeEach(() => {
    process.env.OFW_USERNAME = 'test@example.com';
    process.env.OFW_PASSWORD = 'testpass';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs in on first request and sets token', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, body: { data: 'ok' } },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    // 3 calls: GET /ofw/login.form, POST /ofw/login, GET /pub/v1/test
    expect(spy).toHaveBeenCalledTimes(3);
    expect((spy.mock.calls[0][0] as string)).toContain('/ofw/login.form');
    expect((spy.mock.calls[1][0] as string)).toContain('/ofw/login');
  });

  it('reuses token on subsequent requests', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/a');
    await client.request('GET', '/pub/v1/b');

    // login (2) + 2 requests = 4 calls total
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('retries with fresh login on 401', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 401, body: {} },
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, body: { result: 'ok' } },
    ]);

    const client = new OFWClient();
    const result = await client.request<{ result: string }>('GET', '/pub/v1/test');

    expect(result.result).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(6);
  });

  it('throws on second 401', async () => {
    mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 401, body: {} },
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 401, body: {} },
    ]);

    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('401');
  });

  it('retries once on 429 after 2s delay', async () => {
    vi.useFakeTimers();
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 429, body: {} },
      { status: 200, body: { ok: true } },
    ]);

    const client = new OFWClient();
    const promise = client.request('GET', '/pub/v1/test');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('throws on second 429', async () => {
    vi.useFakeTimers();
    mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);

    const client = new OFWClient();
    const promise = client.request('GET', '/pub/v1/test');
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).rejects.toThrow('Rate limited');
    vi.useRealTimers();
  });

  it('throws if credentials are missing and fetchproxy is disabled', async () => {
    delete process.env.OFW_USERNAME;
    delete process.env.OFW_PASSWORD;
    process.env.OFW_DISABLE_FETCHPROXY = '1';
    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('OFW_USERNAME');
    delete process.env.OFW_DISABLE_FETCHPROXY;
  });

  it('throws if login POST returns non-2xx', async () => {
    mockFetch([
      LOGIN_INIT,
      { status: 401, body: {}, headers: { 'content-type': 'application/json' } },
    ]);

    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('OFW login failed');
  });

  it('throws if login returns non-JSON (e.g. redirect to login page)', async () => {
    // No content-type header → exercises the ?? '' fallback and the non-JSON branch
    mockFetch([
      LOGIN_INIT,
      { status: 200, body: '<html>login page</html>' },
    ]);

    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('unexpected response');
  });

  it('proceeds without Cookie header when init response has no set-cookie', async () => {
    const spy = mockFetch([
      { status: 303, headers: {} }, // no set-cookie
      LOGIN_SUCCESS,
      { status: 200, body: { ok: true } },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    const loginCall = spy.mock.calls[1][1] as RequestInit;
    const headers = loginCall.headers as Record<string, string>;
    expect(headers['Cookie']).toBeUndefined();
  });

  it('throws on non-2xx API response', async () => {
    mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 500, body: {} },
    ]);

    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('500');
  });

  it('sends Authorization header with token', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    const requestCall = spy.mock.calls[2];
    const init = requestCall[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
  });

  it('sends JSON body when body is provided', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('POST', '/pub/v1/test', { foo: 'bar' });

    const requestCall = spy.mock.calls[2];
    const init = requestCall[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('sends FormData body without Content-Type header', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, body: {} },
    ]);

    const form = new FormData();
    form.append('messageIds', '42');
    const client = new OFWClient();
    await client.request('DELETE', '/pub/v1/messages', form);

    const init = spy.mock.calls[2][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h['Content-Type']).toBeUndefined();
    expect(init.body).toBe(form);
  });

  it('re-authenticates when the cached token enters the expiry skew window', async () => {
    // Six-hour TTL with a five-minute skew: once we're within five
    // minutes of expiry, the next request should trigger a fresh login
    // (init + login + api), not reuse the cached token.
    vi.useFakeTimers();
    try {
      const start = new Date('2026-06-01T00:00:00Z');
      vi.setSystemTime(start);

      const spy = mockFetch([
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 200, body: { ok: 1 } },
        // Second request, after expiry, triggers a fresh login pair:
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 200, body: { ok: 2 } },
      ]);

      const client = new OFWClient();
      await client.request('GET', '/pub/v1/test');
      expect(spy).toHaveBeenCalledTimes(3); // init + login + api

      // Move 5h 56m into the future — past the 5-min skew, so the token
      // is "expiring soon" and the client should re-auth on next call.
      vi.setSystemTime(new Date(start.getTime() + (5 * 60 + 56) * 60 * 1000));

      await client.request('GET', '/pub/v1/test');
      expect(spy).toHaveBeenCalledTimes(6); // re-init + re-login + api
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends ofw-client and ofw-version headers', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    const init = spy.mock.calls[2][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h['ofw-client']).toBe('WebApplication');
    expect(h['ofw-version']).toBe('1.0.0');
  });

  describe('request timeout', () => {
    // Helper: handle the login fetches normally, then hang on subsequent
    // calls until the request's AbortSignal fires. This is the shape of a
    // stuck upstream — fetch never resolves, and prior to the timeout fix
    // it would burn the entire client-side budget.
    function mockLoginThenHang(): ReturnType<typeof vi.spyOn> {
      let call = 0;
      return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        call++;
        if (call === 1) {
          // LOGIN_INIT
          return Promise.resolve({
            ok: false, status: 303, statusText: '303',
            headers: { get: (k: string) => k.toLowerCase() === 'set-cookie' ? 'SESSION=x' : null },
            text: async () => '', json: async () => null,
          } as unknown as Response);
        }
        if (call === 2) {
          // LOGIN_SUCCESS
          return Promise.resolve({
            ok: true, status: 200, statusText: '200',
            headers: { get: (k: string) => k.toLowerCase() === 'content-type' ? 'application/json' : null },
            text: async () => JSON.stringify({ auth: MOCK_TOKEN }),
            json: async () => ({ auth: MOCK_TOKEN }),
          } as unknown as Response);
        }
        // Hang until aborted. Fetch contract: rejects with the signal's
        // reason (or a DOMException) when the signal aborts.
        return new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (!signal) return; // hang forever — test will time itself out
          signal.addEventListener('abort', () => {
            const err: Error & { name?: string } = new Error(
              (signal.reason as Error | undefined)?.message ?? 'aborted',
            );
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
    }

    afterEach(() => {
      delete process.env.OFW_REQUEST_TIMEOUT_MS;
    });

    it('aborts a hung request after the default 30s timeout with a clear error', async () => {
      vi.useFakeTimers();
      try {
        mockLoginThenHang();
        const client = new OFWClient();
        const promise = client.request('GET', '/pub/v3/messages?folders=42&page=1&size=50');
        promise.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(promise).rejects.toThrow(
          /OFW API request timed out after 30000ms.*GET \/pub\/v3\/messages/,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('respects OFW_REQUEST_TIMEOUT_MS override', async () => {
      process.env.OFW_REQUEST_TIMEOUT_MS = '5000';
      vi.useFakeTimers();
      try {
        mockLoginThenHang();
        const client = new OFWClient();
        const promise = client.request('GET', '/pub/v3/messages');
        promise.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(promise).rejects.toThrow(/timed out after 5000ms/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fire the timeout when the request completes promptly', async () => {
      vi.useFakeTimers();
      try {
        mockFetch([
          LOGIN_INIT,
          LOGIN_SUCCESS,
          { status: 200, body: { ok: true } },
        ]);
        const client = new OFWClient();
        const result = await client.request<{ ok: boolean }>('GET', '/pub/v1/test');
        // Advance well past the default timeout to prove the timer is cleared.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(result).toEqual({ ok: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('binaries also respect the timeout', async () => {
      vi.useFakeTimers();
      try {
        mockLoginThenHang();
        const client = new OFWClient();
        const promise = client.requestBinary('GET', '/pub/v1/myfiles/1/data');
        promise.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(promise).rejects.toThrow(/timed out after 30000ms/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('OFW_DEBUG_LOG', () => {
    let originalDebug: string | undefined;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalDebug = process.env.OFW_DEBUG_LOG;
      process.env.OFW_DEBUG_LOG = '1';
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      if (originalDebug === undefined) delete process.env.OFW_DEBUG_LOG;
      else process.env.OFW_DEBUG_LOG = originalDebug;
    });

    it('logs request method/url/headers/body and response status+body when enabled', async () => {
      mockFetch([
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 200, body: { ok: true } },
      ]);
      const client = new OFWClient();
      await client.request('POST', '/pub/v3/messages', { foo: 'bar' });

      const lines = errSpy.mock.calls.map((c) => String(c[0]));
      const debugLines = lines.filter((l) => l.startsWith('[ofw-debug]'));
      expect(debugLines.some((l) => l.includes('→ POST'))).toBe(true);
      expect(debugLines.some((l) => l.includes('"foo":"bar"'))).toBe(true);
      // Authorization header is redacted (only the prefix is logged).
      expect(debugLines.some((l) => l.includes('"Authorization":"Bearer ') && l.includes('…"'))).toBe(true);
      expect(debugLines.some((l) => l.includes('← 200'))).toBe(true);
      expect(debugLines.some((l) => l.includes('response body:'))).toBe(true);
    });

    it('logs FormData payloads as a key summary, not the full multipart contents', async () => {
      mockFetch([
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 200, body: {} },
      ]);
      const form = new FormData();
      form.append('messageIds', '42');
      form.append('messageIds', '43');
      const client = new OFWClient();
      await client.request('DELETE', '/pub/v1/messages', form);

      const lines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('<FormData entries=messageIds,messageIds>'))).toBe(true);
    });

    it('logs <none> for a bodyless request', async () => {
      mockFetch([
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 200, body: {} },
      ]);
      const client = new OFWClient();
      await client.request('GET', '/pub/v1/test');

      const lines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('body: <none>'))).toBe(true);
    });

    it('marks retried requests in the log', async () => {
      mockFetch([
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 401, body: {} },
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 200, body: { ok: true } },
      ]);
      const client = new OFWClient();
      await client.request('GET', '/pub/v1/test');
      const lines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('(retry)'))).toBe(true);
    });

    it('logs <empty> when response body is genuinely empty', async () => {
      // Hand-stub the API call's text() to return '' so we exercise the
      // `text || '<empty>'` branch in client.ts (the shared mockFetch
      // JSON.stringifies its body, which never yields an empty string).
      let call = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call++;
        if (call === 1) {
          return {
            ok: false, status: 303, statusText: '303',
            headers: { get: (k: string) => k.toLowerCase() === 'set-cookie' ? 'SESSION=x' : null },
            text: async () => '', json: async () => null,
          } as unknown as Response;
        }
        if (call === 2) {
          return {
            ok: true, status: 200, statusText: '200',
            headers: { get: (k: string) => k.toLowerCase() === 'content-type' ? 'application/json' : null },
            text: async () => JSON.stringify({ auth: MOCK_TOKEN }),
            json: async () => ({ auth: MOCK_TOKEN }),
          } as unknown as Response;
        }
        return {
          ok: true, status: 200, statusText: '200',
          headers: { get: () => null },
          text: async () => '',
        } as unknown as Response;
      });
      const client = new OFWClient();
      await client.request('GET', '/pub/v1/test');
      const lines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l === '[ofw-debug] response body: <empty>')).toBe(true);
    });
  });
});

describe('OFWClient.requestBinary', () => {
  beforeEach(() => {
    process.env.OFW_USERNAME = 'test@example.com';
    process.env.OFW_PASSWORD = 'testpass';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('returns body as Buffer with content-type and parsed filename', async () => {
    mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, bytes: PNG_BYTES, headers: {
        'content-type': 'image/png',
        'content-disposition': 'attachment; filename="kid.png"',
      } },
    ]);

    const client = new OFWClient();
    const r = await client.requestBinary('GET', '/pub/v1/myfiles/1/data');

    expect(Buffer.isBuffer(r.body)).toBe(true);
    expect(r.body.equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(r.contentType).toBe('image/png');
    expect(r.suggestedFileName).toBe('kid.png');
  });

  it('sends Authorization, ofw-* headers, and Accept: application/octet-stream', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 200, bytes: PNG_BYTES },
    ]);

    const client = new OFWClient();
    await client.requestBinary('GET', '/pub/v1/myfiles/1/data');

    const init = spy.mock.calls[2][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
    expect(h['Accept']).toBe('application/octet-stream');
    expect(h['ofw-client']).toBe('WebApplication');
    expect(h['ofw-version']).toBe('1.0.0');
    expect(h['Content-Type']).toBeUndefined();
  });

  it('re-logs in and retries on 401', async () => {
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 401, body: {} },
      LOGIN_INIT,
      { ...LOGIN_SUCCESS, body: { auth: 'new-token', redirectUrl: '/' } },
      { status: 200, bytes: PNG_BYTES },
    ]);

    const client = new OFWClient();
    const r = await client.requestBinary('GET', '/pub/v1/myfiles/1/data');
    expect(r.body.length).toBe(PNG_BYTES.length);
    expect(spy).toHaveBeenCalledTimes(6);
  });

  it('throws on a second 401', async () => {
    mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 401, body: {} },
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 401, body: {} },
    ]);

    const client = new OFWClient();
    await expect(client.requestBinary('GET', '/pub/v1/myfiles/1/data')).rejects.toThrow('401');
  });

  it('waits 2s and retries on 429', async () => {
    vi.useFakeTimers();
    const spy = mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 429, body: {} },
      { status: 200, bytes: PNG_BYTES },
    ]);

    const client = new OFWClient();
    const promise = client.requestBinary('GET', '/pub/v1/myfiles/1/data');
    await vi.advanceTimersByTimeAsync(2000);
    const r = await promise;

    expect(r.body.length).toBe(PNG_BYTES.length);
    expect(spy).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('throws "Rate limited" on a second 429 (matches request() behavior)', async () => {
    vi.useFakeTimers();
    mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);

    const client = new OFWClient();
    const promise = client.requestBinary('GET', '/pub/v1/myfiles/1/data');
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).rejects.toThrow('Rate limited');
    vi.useRealTimers();
  });

  it('throws on non-2xx response', async () => {
    mockFetch([
      LOGIN_INIT,
      LOGIN_SUCCESS,
      { status: 500, body: {} },
    ]);

    const client = new OFWClient();
    await expect(client.requestBinary('GET', '/pub/v1/myfiles/1/data')).rejects.toThrow('500');
  });

  describe('Content-Disposition filename parsing', () => {
    async function downloadWithCD(cd: string | undefined): Promise<string | null> {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
      if (cd !== undefined) headers['content-disposition'] = cd;
      mockFetch([
        LOGIN_INIT,
        LOGIN_SUCCESS,
        { status: 200, bytes: new Uint8Array([1, 2, 3]), headers },
      ]);
      const client = new OFWClient();
      const r = await client.requestBinary('GET', '/pub/v1/myfiles/1/data');
      return r.suggestedFileName;
    }

    it('decodes RFC 6266 filename*=UTF-8\'\'percent-encoded', async () => {
      expect(await downloadWithCD("attachment; filename*=UTF-8''Hello%20World.pdf")).toBe('Hello World.pdf');
    });

    it('decodes filename*= without the UTF-8\'\' prefix', async () => {
      expect(await downloadWithCD('attachment; filename*=Hello%20World.pdf')).toBe('Hello World.pdf');
    });

    it('prefers filename*= over legacy filename=', async () => {
      expect(await downloadWithCD(
        'attachment; filename="legacy.pdf"; filename*=UTF-8\'\'fancy%20name.pdf',
      )).toBe('fancy name.pdf');
    });

    it('matches legacy quoted filename', async () => {
      expect(await downloadWithCD('attachment; filename="legacy file.pdf"')).toBe('legacy file.pdf');
    });

    it('matches legacy unquoted filename', async () => {
      expect(await downloadWithCD('attachment; filename=legacy.pdf')).toBe('legacy.pdf');
    });

    it('falls back to the raw value when filename*= has broken percent-encoding', async () => {
      // %ZZ is invalid → decodeURIComponent throws → we keep the raw token.
      expect(await downloadWithCD("attachment; filename*=UTF-8''bad%ZZname.pdf")).toBe('bad%ZZname.pdf');
    });

    it('returns null when there is no Content-Disposition header', async () => {
      expect(await downloadWithCD(undefined)).toBeNull();
    });

    it('returns null when Content-Disposition has no filename', async () => {
      expect(await downloadWithCD('attachment')).toBeNull();
    });
  });
});
