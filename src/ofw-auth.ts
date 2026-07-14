import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { loginWithPassword } from './auth-password.js';

/**
 * OAuth props stored per user by the Cloudflare connector's OAuth provider.
 *
 * Unlike the Untappd connector (which stores a long-lived access token), we
 * store the OFW username AND password. OFW bearer tokens expire in ~6h with no
 * refresh token, so the per-user client must be able to re-login on its own.
 * These props are encrypted at rest in OAUTH_KV by the OAuth provider.
 *
 * The index signature satisfies `createConnector`'s
 * `Props extends Record<string, unknown>` constraint.
 */
export interface OFWProps {
  username: string;
  password: string;
  [key: string]: unknown;
}

/**
 * `ConnectorAuth` for the OurFamilyWizard remote connector: the login page
 * collects the user's own OFW email/username + password, verifies them via the
 * same Spring Security form login the stdio server uses (`loginWithPassword` in
 * `auth-password.js`), and stores `{ username, password }` as the OAuth props
 * that `worker.ts`'s `buildClient` turns into a per-user `OFWClient` capable of
 * re-authenticating when its 6h token expires.
 */
export const ofwAuth: ConnectorAuth<OFWProps> = {
  service: 'OurFamilyWizard',
  accent: '#00A9A5',
  privacyNote:
    'Your OFW email and password are stored encrypted and used only to sign in to OurFamilyWizard on your behalf ' +
    '(OFW sign-in tokens expire every few hours, so your password is needed to renew them).',
  fields: [
    { name: 'username', label: 'OFW email or username' },
    { name: 'password', label: 'OFW password', type: 'password' },
  ],
  async login(fields) {
    // Verify the credentials up front — a bad password throws here, which the
    // connector surfaces back on the login page. We deliberately discard the
    // returned token: the per-user client logs in again from the stored creds.
    await loginWithPassword(fields.username, fields.password);
    return { username: fields.username, password: fields.password };
  },
};
