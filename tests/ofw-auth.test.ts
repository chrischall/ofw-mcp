import { describe, it, expect, vi, beforeEach } from 'vitest';

// The connector login page collects the user's OFW username/password and calls
// `ofwAuth.login(fields, env)`. We store BOTH (encrypted at rest in OAUTH_KV)
// because OFW bearer tokens expire in ~6h with no refresh token — the per-user
// client must be able to re-login. `login()` verifies the creds via
// `loginWithPassword` (throwing on bad creds), which surfaces on the login page.

// Mock the password-login helper at the module boundary so no real network hit.
const loginWithPasswordMock = vi.fn();
vi.mock('../src/auth-password.js', () => ({
  loginWithPassword: (...args: unknown[]) => loginWithPasswordMock(...args),
}));

import { ofwAuth } from '../src/ofw-auth.js';

describe('ofwAuth (Cloudflare connector login)', () => {
  beforeEach(() => {
    loginWithPasswordMock.mockReset();
  });

  it('declares the OFW service, an accent, its two fields, and a privacy note', () => {
    expect(ofwAuth.service).toBe('OurFamilyWizard');
    expect(ofwAuth.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(ofwAuth.fields).toEqual([
      { name: 'username', label: 'OFW email or username' },
      { name: 'password', label: 'OFW password', type: 'password' },
    ]);
    // Honest note: credentials are stored (encrypted), used only to sign in.
    expect(ofwAuth.privacyNote).toMatch(/encrypt/i);
    expect(ofwAuth.privacyNote).toMatch(/sign/i);
  });

  it('login() verifies the credentials and returns { username, password } props', async () => {
    loginWithPasswordMock.mockResolvedValue({ token: 'TOK', expiresAt: new Date() });
    const props = await ofwAuth.login({ username: 'parent@example.com', password: 'pw' }, {});
    expect(loginWithPasswordMock).toHaveBeenCalledWith('parent@example.com', 'pw');
    expect(props).toEqual({ username: 'parent@example.com', password: 'pw' });
  });

  it('login() propagates the error thrown on bad credentials', async () => {
    loginWithPasswordMock.mockRejectedValue(new Error('OFW login failed: 401 Unauthorized'));
    await expect(
      ofwAuth.login({ username: 'parent@example.com', password: 'wrong' }, {}),
    ).rejects.toThrow(/login failed/i);
  });
});
