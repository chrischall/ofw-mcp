import { McpServer } from '@modelcontextprotocol/server';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { OFWClient } from '../client.js';
import { isNoAuthConfigured, isBridgeDown } from '../auth.js';

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
 *
 * The credential comes from the CLIENT (`credentialStatus`), not from a direct
 * `resolveAuth()` call. That used to be a full login — or a fresh browser-bridge
 * spin-up — on every healthcheck, ignoring the six-hour token the client
 * already held; with a bad password each check re-POSTed it against OFW's
 * failed-attempt counter (chrischall/fleet-audit#881). Through the client's
 * TokenManager a held or cached token costs nothing, a needed mint is the one
 * the next tool call would make anyway, and the probe then exercises that very
 * token — so a passing healthcheck means the tools' own token works.
 */
export function registerHealthcheckTools(
  server: McpServer,
  client: OFWClient,
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
        const { source, expiresAt } = await client.credentialStatus();
        return {
          source,
          // Never the token. Expiry is the fact that explains a connector
          // that worked an hour ago and does not now — and this is the one
          // the client itself will re-authenticate at.
          detail: { expires_at: expiresAt.toISOString() },
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
              'ContextMint Bridge is down, so the browser path could not be tried. This is ' +
              'not a credential problem: OFW_USERNAME/OFW_PASSWORD, if set, were not reached ' +
              'either. See error.message for the extension-specific fix.',
          }
        : undefined,
    hints: {
      // Now means exactly what it says: nothing is set up. A configured path
      // that was tried and failed no longer lands here.
      no_credential:
        'No OFW credential is configured. Either set OFW_USERNAME + OFW_PASSWORD, or install ' +
        'ContextMint Bridge and sign in to ourfamilywizard.com in a tab (unsetting ' +
        'OFW_DISABLE_FETCHPROXY if you set it).',
      credential_rejected:
        'OurFamilyWizard rejected the credential. If it came from `env` or `cache`, the password changed or ' +
        'the account is locked; if from `fetchproxy`, the browser session expired — sign in again ' +
        'in the tab. Retrying will not fix either.',
    },
  });
}
