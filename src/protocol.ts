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
