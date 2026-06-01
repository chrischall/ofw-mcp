// ────────────────────────────────────────────────────────────────────────────
// Auth resolution — Pattern A template
// ────────────────────────────────────────────────────────────────────────────
//
// This file is the canonical shape for "browser-bootstrap + Node-direct"
// auth used across our MCP servers. The other six MCPs in this family
// (resy-mcp, opentable-mcp, splitwise-mcp, …) will model their auth
// resolution after this one — keep the structure flat, the path-selection
// explicit, and the error messages actionable.
//
// THE THREE PATHS, in priority order:
//
//   1. Env-var credentials (existing behavior)
//      OFW_USERNAME + OFW_PASSWORD set → POST the login form, get a token.
//      This is the legacy path. It runs unchanged when both vars are set
//      so existing users (Claude Desktop with mcpb env config, etc.) are
//      not disrupted.
//
//   2. fetchproxy fallback (new)
//      When credentials are absent, we try to lift the user's session
//      out of their signed-in browser tab via the fetchproxy extension.
//      The `@fetchproxy/bootstrap` helper spins up a one-shot WebSocket
//      bridge, asks the extension for `localStorage["auth"]` and
//      `localStorage["tokenExpiry"]` from any ourfamilywizard.com tab,
//      then closes the bridge. From here on, all OFW API calls go out
//      via plain Node `fetch()` — fetchproxy is NOT in the hot path.
//
//      Users opt out with OFW_DISABLE_FETCHPROXY=1 (anyone who wants the
//      old behavior of "fail loudly when creds are missing").
//
//   3. Error
//      Nothing to authenticate with. We throw a message that tells the
//      user exactly what to do: set creds, OR install the extension and
//      sign in.
//
// Why fetchproxy is only a one-shot read:
//   The bootstrap call snapshots the session blob and returns. The MCP
//   then operates from Node with direct fetch + Authorization header,
//   so latency and reliability are not coupled to the browser bridge
//   for normal tool calls. Pre-PR mcp-chrome and tab-routing concerns
//   (see opentable-mcp/CLAUDE.md "Bridge selection") do not apply here.
//
// Testability:
//   - `@fetchproxy/bootstrap` is mocked at the module boundary in tests.
//   - `./auth-password.js` (loginWithPassword) is a separate module
//     specifically so it can be mocked here too. This keeps the
//     selection logic independent of either implementation.

import { readEnvVar } from '@chrischall/mcp-utils';
import { bootstrap } from '@fetchproxy/bootstrap';
import { classifyBridgeError, FetchproxyBridgeDownError } from '@chrischall/mcp-utils/fetchproxy';
import { loginWithPassword } from './auth-password.js';
import { parseBoolEnv } from './config.js';
import pkg from '../package.json' with { type: 'json' };

/** Result of resolving auth, regardless of which path was taken. */
export interface ResolvedAuth {
  /** Bearer token for OFW API requests. */
  token: string;
  /** Best-effort expiry. Absent on the fetchproxy path when the browser tab didn't store one. */
  expiresAt?: Date;
  /** Which path produced the token. Used for diagnostics + future cache keying. */
  source: 'env' | 'fetchproxy';
}

/**
 * Read an env var, trim, and treat blank / `${UNEXPANDED}` placeholders as
 * unset. Defends against MCP hosts that pass `.mcp.json` env blocks through
 * without variable expansion. Delegates to @chrischall/mcp-utils' `readEnvVar`,
 * which applies the identical sanitization (blank, `undefined`/`null`,
 * `${...}` placeholder → unset).
 */
function readEnv(key: string): string | undefined {
  return readEnvVar(key);
}

/** True if the user has explicitly disabled the fetchproxy fallback. */
function fetchproxyDisabled(): boolean {
  return parseBoolEnv('OFW_DISABLE_FETCHPROXY');
}

/**
 * Resolve OFW auth using the three-path priority described at the top of
 * this file. Throws with an actionable error message when no path succeeds.
 *
 * Callers (i.e. `OFWClient.login()`) treat the return value as opaque
 * credentials — they should not branch on `source`. The field exists for
 * logging / future cache-keying only.
 */
export async function resolveAuth(): Promise<ResolvedAuth> {
  // ── Path 1: env-var credentials (unchanged from pre-fetchproxy behavior).
  const username = readEnv('OFW_USERNAME');
  const password = readEnv('OFW_PASSWORD');
  if (username && password) {
    const { token, expiresAt } = await loginWithPassword(username, password);
    return { token, expiresAt, source: 'env' };
  }

  // ── Path 2: fetchproxy fallback (new).
  if (!fetchproxyDisabled()) {
    try {
      const session = await bootstrap({
        serverName: pkg.name,
        version: pkg.version,
        // OFW serves both ofw.ourfamilywizard.com and www.ourfamilywizard.com;
        // the API + auth token live on the apex. The extension matches on
        // suffix, so listing the apex covers both.
        domains: ['ourfamilywizard.com'],
        declare: {
          cookies: [],
          // The web app stores the Bearer token in localStorage["auth"] and
          // its expiry (ISO string) in localStorage["tokenExpiry"]. Mirroring
          // both means our 401-replay logic can be slightly smarter, and the
          // expiry surfaces correctly in diagnostics.
          localStorage: ['auth', 'tokenExpiry'],
          sessionStorage: [],
          captureHeaders: [],
        },
      });

      const token = session.localStorage['auth'];
      const expiryRaw = session.localStorage['tokenExpiry'];
      if (!token) {
        throw new Error(
          'localStorage["auth"] missing on ourfamilywizard.com. ' +
            'Sign into OFW in your browser (with the fetchproxy extension installed) and retry.',
        );
      }
      return {
        token,
        expiresAt: expiryRaw ? new Date(expiryRaw) : undefined,
        source: 'fetchproxy',
      };
    } catch (e) {
      // FetchproxyBridgeDownError only escapes bootstrap() after the lazy-revive retry fails — surface .hint verbatim (actionable "click toolbar icon" copy).
      if (classifyBridgeError(e) === 'bridge_down') {
        const downErr = e as FetchproxyBridgeDownError;
        throw new Error(
          `OFW auth: fetchproxy bridge is down (extension service worker unreachable after retry). ${downErr.hint}`,
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `OFW auth: no OFW_USERNAME/OFW_PASSWORD set, and fetchproxy fallback failed: ${msg}`,
      );
    }
  }

  // ── Path 3: nothing configured. Surface both fixes side-by-side so the
  //    user can pick whichever fits their setup.
  throw new Error(
    'OFW auth: set OFW_USERNAME + OFW_PASSWORD, ' +
      'or install the fetchproxy extension and sign into ourfamilywizard.com ' +
      '(unset OFW_DISABLE_FETCHPROXY if it is set).',
  );
}
