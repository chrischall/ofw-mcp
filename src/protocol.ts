// Wire-level constants shared by client.ts (general API calls) and
// auth-password.ts (form-login). Kept in a leaf module to avoid an import
// cycle between client.ts → auth.ts → auth-password.ts.

export const BASE_URL = 'https://ofw.ourfamilywizard.com';

// Required on every OFW API request. `ofw-version` is the OFW protocol
// version, not this package's version — do NOT bump it during a release.
export const OFW_PROTOCOL_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0',
} as const;

// OFW doesn't return a token expiry, so we synthesize one. Six hours is
// empirically long enough to be useful and short enough that the 401
// re-auth replay path stays a rare event rather than the common case.
export const OFW_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

// How early we treat a token as expiring. Re-auth before this skew so a
// long-running request doesn't get a stale token mid-flight.
export const OFW_TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

// The only host this server is ever allowed to contact. Derived from BASE_URL
// so the two cannot drift.
const ALLOWED_HOST = new URL(BASE_URL).host;

/**
 * Enforced egress allowlist: every outbound request passes its
 * fully-constructed URL through here before `fetch` (API calls in client.ts,
 * the form login in auth-password.ts).
 *
 * Today this always passes, and that is the point. Every URL is
 * `${BASE_URL}${path}` with a path that begins with '/', so no id or query
 * value interpolated into a path can move the host — an '@' can never land in
 * the authority component when a '/' already precedes it. The check exists so
 * that stays true after a future refactor: a code change (or a compromised
 * dependency) that pointed `fetch` somewhere else would throw here instead of
 * carrying the bearer token or a message body off-host. It makes "this server
 * only ever talks to OFW" a structural invariant rather than a code-review
 * promise.
 *
 * Scope, stated honestly: this is a PRE-FLIGHT check on the URL we construct.
 * It does not follow redirects, so it is not a complete egress control — an
 * OFW-served 3xx to another host is still followed by `fetch` (which does at
 * least drop Authorization on a cross-origin redirect, per the fetch spec).
 */
export function assertOfwUrl(rawUrl: string): void {
  let host: string;
  try {
    host = new URL(rawUrl).host;
  } catch {
    throw new Error(`ofw-mcp: refusing malformed request URL "${rawUrl}"`);
  }
  if (host !== ALLOWED_HOST) {
    throw new Error(
      `ofw-mcp: refusing request to non-OFW host "${host}" — only ${ALLOWED_HOST} is allowed.`,
    );
  }
}
