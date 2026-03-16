import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OFWClient } from '../src/client.js';

const MOCK_TOKEN = 'test-token-abc';
const MOCK_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let idx = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[idx++] ?? { status: 200, body: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body,
    } as Response;
  });
}

describe('OFWClient', () => {
  beforeEach(() => {
    process.env.OFW_EMAIL = 'test@example.com';
    process.env.OFW_PASSWORD = 'testpass';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs in on first request and sets token', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } }, // login
      { status: 200, body: { data: 'ok' } }, // actual request
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    expect(spy).toHaveBeenCalledTimes(2);
    const loginCall = spy.mock.calls[0];
    expect(loginCall[0]).toContain('/pub/v1/auth/login');
  });

  it('reuses token on subsequent requests', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/a');
    await client.request('GET', '/pub/v1/b');

    // login once + 2 requests = 3 calls total
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retries with fresh login on 401', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } }, // initial login
      { status: 401, body: {} },                                               // request fails
      { status: 200, body: { token: 'new-token', tokenExpiry: MOCK_EXPIRY } }, // re-login
      { status: 200, body: { result: 'ok' } },                                 // retry
    ]);

    const client = new OFWClient();
    const result = await client.request<{ result: string }>('GET', '/pub/v1/test');

    expect(result.result).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('throws on second 401', async () => {
    mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 401, body: {} },
      { status: 200, body: { token: 'new-token', tokenExpiry: MOCK_EXPIRY } },
      { status: 401, body: {} },
    ]);

    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('401');
  });

  it('retries once on 429 after 2s delay', async () => {
    vi.useFakeTimers();
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 429, body: {} },
      { status: 200, body: { ok: true } },
    ]);

    const client = new OFWClient();
    const promise = client.request('GET', '/pub/v1/test');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ ok: true });
    vi.useRealTimers();
  });

  it('throws on second 429', async () => {
    vi.useFakeTimers();
    mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);

    const client = new OFWClient();
    const promise = client.request('GET', '/pub/v1/test');
    // Suppress unhandled rejection warning: attach a no-op catch before
    // advancing timers so Node.js doesn't see the rejection as unhandled.
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).rejects.toThrow('Rate limited');
    vi.useRealTimers();
  });

  it('throws if credentials are missing', async () => {
    delete process.env.OFW_EMAIL;
    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('OFW_EMAIL');
  });

  it('sends Authorization header with token', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    const requestCall = spy.mock.calls[1];
    const init = requestCall[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
  });

  it('sends ofw-client and ofw-version headers', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    const init = spy.mock.calls[1][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h['ofw-client']).toBe('WebApplication');
    expect(h['ofw-version']).toBe('1.0.0');
  });
});
