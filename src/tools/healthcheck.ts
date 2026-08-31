import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { OFWClient } from '../client.js';
import { resolveAuth, type ResolvedAuth } from '../auth.js';

/**
 * `ofw_healthcheck` — the one call that answers "is this connector working?".
 *
 * OFW had no such tool. `ofw_status` looks like one and is not: it is a
 * heavyweight draft-inventory call, `readOnlyHint: false`, that answers "where
 * do my drafts stand?". Asking it whether auth works spends a drafts sync and
 * still cannot separate "no credential" from "OFW rejected it".
 *
 * The distinction matters most for the two-path auth here: the token comes
 * from either OFW_USERNAME/OFW_PASSWORD or a signed-in browser tab via
 * fetchproxy, and "which of those actually supplied it" is the first thing
 * anyone needs when the connector misbehaves. That is why `source` is
 * reported.
 */
export function registerHealthcheckTools(
  server: McpServer,
  client: OFWClient,
  /** Seam: the auth resolver, injectable so tests need no network. */
  resolve: () => Promise<ResolvedAuth> = resolveAuth,
): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'ofw',
    hostLabel: 'ourfamilywizard.com',
    // The same read `ofw_get_profile` makes: authenticated, cheap, and it
    // changes nothing. A healthcheck that marked a message read would be
    // co-parent-visible and irreversible.
    probePath: '/pub/v2/profiles',
    resolveCredential: async () => {
      try {
        const auth = await resolve();
        return {
          source: auth.source,
          // Never the token. Expiry is the fact that explains a connector
          // that worked an hour ago and does not now.
          detail: auth.expiresAt ? { expires_at: auth.expiresAt.toISOString() } : undefined,
        };
      } catch (e) {
        // "Nothing is configured" is a CREDENTIAL state, not a failure to
        // check — it earns the `no_credential` arm and its advice. Every
        // other error (a rejected password, a bridge that is down) is a real
        // failure and must keep its own message rather than being flattened
        // into "no credential", which would send someone to set variables
        // that are already set.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('OFW auth: set OFW_USERNAME + OFW_PASSWORD')) {
          return { source: null };
        }
        throw e;
      }
    },
    probeFn: () => client.request('GET', '/pub/v2/profiles'),
    hints: {
      // Covers TWO situations, because the shared helper cannot tell them
      // apart: it collapses any `resolveCredential` throw into this arm with
      // this static hint. So the hint must not assert which one happened —
      // `error.message` is what distinguishes them, and it says so. (Teaching
      // the helper to classify a resolver throw would fix this for every
      // connector; noted as a follow-up rather than worked around here.)
      no_credential:
        'No usable OFW credential. Either nothing is configured — set OFW_USERNAME + ' +
        'OFW_PASSWORD, or install the fetchproxy extension and sign in to ourfamilywizard.com ' +
        'in a tab (unsetting OFW_DISABLE_FETCHPROXY if you set it) — or a configured path was ' +
        'tried and failed. `error.message` says which: a bridge that is down or a rejected ' +
        'password reads very differently from nothing being set up at all.',
      credential_rejected:
        'OurFamilyWizard rejected the credential. If it came from `env`, the password changed or ' +
        'the account is locked; if from `fetchproxy`, the browser session expired — sign in again ' +
        'in the tab. Retrying will not fix either.',
    },
  });
}
