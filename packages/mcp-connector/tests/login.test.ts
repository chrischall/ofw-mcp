import { describe, it, expect, vi } from 'vitest';
import { handleAuthorize } from '../src/login.js';

const auth = {
  service: 'Untappd',
  fields: [{ name: 'username', label: 'Username' }, { name: 'password', label: 'Password', type: 'password' as const }],
  login: vi.fn(async (f: Record<string,string>) => ({ token: 'TOK', username: f.username })),
};

function fakeEnv() {
  return { OAUTH_PROVIDER: {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'c', redirectUri: 'https://claude.ai/cb', scope: [], state: 's' })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://claude.ai/cb?code=xyz' })),
  }};
}

it('POST /authorize verifies creds and completes authorization with props', async () => {
  const env = fakeEnv();
  const body = new URLSearchParams({ username: 'chris', password: 'pw', oauthReq: btoa(JSON.stringify({ clientId: 'c' })) });
  const req = new Request('https://x/authorize', { method: 'POST', body });
  const res = await handleAuthorize(req, env, auth);
  expect(auth.login).toHaveBeenCalledWith({ username: 'chris', password: 'pw' }, env);
  expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({ props: { token: 'TOK', username: 'chris' }, userId: 'chris' }),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toContain('code=xyz');
});

it('POST with bad creds re-renders the form with an error (no completeAuthorization)', async () => {
  const env = fakeEnv();
  const badAuth = { ...auth, login: vi.fn(async () => { throw new Error('login failed'); }) };
  const body = new URLSearchParams({ username: 'x', password: 'y', oauthReq: btoa(JSON.stringify({ clientId: 'c' })) });
  const req = new Request('https://x/authorize', { method: 'POST', body });
  const res = await handleAuthorize(req, env, badAuth);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('login failed');
  expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
});
