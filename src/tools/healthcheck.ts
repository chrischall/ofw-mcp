import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { OFWClient } from '../client.js';
import { resolveAuth, isNoAuthConfigured, isBridgeDown, type ResolvedAuth } from '../auth.js';

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
        // `isNoAuthConfigured` rather than a prefix match on a copy of the
        // message: the copy would pass this module's own test while silently
        // stopping matching the day auth.ts reworded it, and the failure mode
        // is giving a rejected password the advice meant for a blank setup.
        if (isNoAuthConfigured(e)) return { source: null };
        throw e;
      }
    },
    probeFn: () => client.request('GET', '/pub/v2/profiles'),
    // A downed bridge is not a missing credential, and since mcp-utils 0.19.3
    // the helper consults this for a `resolveCredential` failure too — so it
    // gets its own arm instead of the `no_credential` copy. That copy could
    // previously only hedge across both cases and point at `error.message`;
    // now each answer names one cause and one fix.
    classifyThrown: (err: unknown) =>
      isBridgeDown(err)
        ? {
            kind: 'transport',
            // The upstream `.hint` rides along in `error.message` — it carries
            // the actionable "click the toolbar icon" copy this cannot know.
            hint:
              'The fetchproxy bridge is down, so the browser path could not be tried. This is ' +
              'not a credential problem: OFW_USERNAME/OFW_PASSWORD, if set, were not reached ' +
              'either. See error.message for the extension-specific fix.',
          }
        : undefined,
    hints: {
      // Now means exactly what it says: nothing is set up. A configured path
      // that was tried and failed no longer lands here.
      no_credential:
        'No OFW credential is configured. Either set OFW_USERNAME + OFW_PASSWORD, or install ' +
        'the fetchproxy extension and sign in to ourfamilywizard.com in a tab (unsetting ' +
        'OFW_DISABLE_FETCHPROXY if you set it).',
      credential_rejected:
        'OurFamilyWizard rejected the credential. If it came from `env`, the password changed or ' +
        'the account is locked; if from `fetchproxy`, the browser session expired — sign in again ' +
        'in the tab. Retrying will not fix either.',
    },
  });
}
