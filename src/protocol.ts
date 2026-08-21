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
// so the two can't drift.
const ALLOWED_HOST = new URL(BASE_URL).host;

/**
 * Enforced egress allowlist. Every outbound request (API calls in client.ts,
 * the form login in auth-password.ts) passes its fully-constructed URL through
 * here first. Today every URL is built from BASE_URL so this always passes —
 * the point is to make "this server only ever talks to OFW" a structural
 * invariant rather than a code-review promise:
 *   - a future code change (or a compromised dependency) that tries to reach
 *     another host throws instead of exfiltrating the bearer token / messages;
 *   - it also blocks a userinfo-splice attack — an attacker-influenced path
 *     like `@evil.com/…` turns `https://ofw.ourfamilywizard.com@evil.com/…`,
 *     whose real host is evil.com. Validating the parsed host catches it.
 * The check is on the resolved URL's host, so no path trick can smuggle a
 * different destination past it.
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
