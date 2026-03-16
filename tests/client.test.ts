import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OFWClient } from '../src/client.js';

const MOCK_TOKEN = 'test-token-abc';

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
      text: async () => JSON.stringify(r.body),
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

  it('throws if credentials are missing', async () => {
    delete process.env.OFW_USERNAME;
    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('OFW_USERNAME');
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
});
