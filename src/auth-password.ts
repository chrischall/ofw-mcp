// OFW's existing password-login path.
//
// `POST /ofw/login` is Spring Security form-urlencoded; it requires a SESSION
// cookie that we capture from `GET /ofw/login.form` first. The response body
// is JSON `{ auth: "<Bearer token>", redirectUrl: "..." }`. OFW does not return
// a token expiry, so we synthesize a 6h lifetime — long enough to be useful,
// short enough that a 401 re-auth replay is rare.
//
// This file exists as a standalone helper (not a method on `OFWClient`) so
// `resolveAuth()` in `./auth.ts` can call it without a Client instance, and
// so tests can mock it at the module boundary.

import { createHash } from 'node:crypto';
import { EdgeBlockedError, currentCallSignal, detectEdgeBlock } from '@chrischall/mcp-utils';
import { BASE_URL, OFW_PROTOCOL_HEADERS, OFW_TOKEN_TTL_MS, assertOfwUrl } from './protocol.js';

export interface PasswordLoginResult {
  token: string;
  expiresAt: Date;
}

/**
 * OFW definitively refused this username/password (it re-rendered its login
 * page). Distinct from a transient failure (5xx, timeout), which is retried.
 */
export class CredentialsRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsRejectedError';
  }
}

// ── Credential-rejection latch ───────────────────────────────────────────
// OFW counts failed sign-ins against the account, and nothing upstream of this
// function remembers a rejection: the TokenManager caches no failure, so every
// later tool call (and every healthcheck) would re-POST the same stale
// password — the realistic trigger being a password changed in the OFW web app
// while this process keeps the old one in its env. So a DEFINITIVE rejection is
// latched here, per credential pair, for the life of the process: the pair is
// refused locally until OFW_USERNAME/OFW_PASSWORD change or the server
// restarts. Only a digest of the pair is held, never the password itself.
const rejectedPairs = new Set<string>();

// Synchronous on purpose: an extra await ahead of the first fetch would shift
// every caller's timing (config.ts already hashes with node:crypto).
function pairDigest(username: string, password: string): string {
  return createHash('sha256').update(`${username.length}:${username}\u0000${password}`).digest('hex');
}

/** Test hook: forget every latched rejection. */
export function resetCredentialRejections(): void {
  rejectedPairs.clear();
}

export async function loginWithPassword(
  username: string,
  password: string,
): Promise<PasswordLoginResult> {
  const digest = pairDigest(username, password);
  if (rejectedPairs.has(digest)) {
    throw new CredentialsRejectedError(
      'OFW login not attempted — this OurFamilyWizard email and password were already rejected by OFW '
      + 'earlier in this session, and OFW counts failed sign-ins against the account, so they are not re-sent. '
      + 'Update OFW_USERNAME / OFW_PASSWORD to the current values (or restart the server) and try again.',
    );
  }

  // Step 1: get a SESSION cookie (Spring Security refuses the POST without it).
  const initUrl = `${BASE_URL}/ofw/login.form`;
  assertOfwUrl(initUrl);
  const initResponse = await fetch(initUrl, {
    headers: { ...OFW_PROTOCOL_HEADERS },
    redirect: 'manual',
    // Honour a caller who has given up (mcp-utils `cancel`). A sign-in
    // nobody is waiting for should not keep hitting OFW, which counts
    // failed attempts against the account.
    signal: currentCallSignal(),
  });
  // headers.get('set-cookie') folds multiple Set-Cookie headers into one
  // comma-joined string; getSetCookie() preserves them individually. Echo
  // every cookie back (name=value only) so login keeps working if OFW ever
  // sets cookies beyond SESSION.
  const sessionCookie = initResponse.headers.getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  // Step 2: submit the form.
  const loginUrl = `${BASE_URL}/ofw/login`;
  assertOfwUrl(loginUrl);
  const response = await fetch(loginUrl, {
    method: 'POST',
    signal: currentCallSignal(),
    headers: {
      ...OFW_PROTOCOL_HEADERS,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: new URLSearchParams({
      submit: 'Sign In',
      _eventId: 'submit',
      username,
      password,
    }).toString(),
  });

  if (!response.ok) {
    // A CDN/WAF refusal page is not OFW judging the password: name it, so the
    // healthcheck reports edge_blocked instead of a missing credential, and
    // nothing is latched as rejected (chrischall/mcp-host#1015). The page
    // itself stays out of the message.
    const edge = detectEdgeBlock({
      body: await response.text().catch(() => ''),
      headers: response.headers,
      status: response.status,
    });
    if (edge !== null) {
      throw new EdgeBlockedError(response.status, edge.vendor, {
        service: 'OurFamilyWizard',
        method: 'POST',
        path: '/ofw/login',
      });
    }
    throw new Error(`OFW login failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // OFW rejects bad credentials by re-serving its HTML login page (Spring
    // Security re-renders the form rather than returning 401/JSON). Surface a
    // clean, actionable message instead of dumping the HTML page — this is what
    // a hosted deployment's login page shows the user on a failed sign-in.
    if (contentType.includes('text/html')) {
      rejectedPairs.add(digest);
      throw new CredentialsRejectedError(
        'OFW login failed — your OurFamilyWizard email or password was not accepted. Check them and try again. '
        + 'They will not be re-sent until OFW_USERNAME / OFW_PASSWORD change or the server restarts.',
      );
    }
    const body = await response.text();
    throw new Error(`OFW login returned unexpected response (${contentType || 'no content-type'}): ${body.substring(0, 200)}`);
  }

  // A 200 JSON answer is not proof of a token: a lockout, MFA or captcha
  // challenge can arrive the same way. Without this check the token would be
  // the string "undefined", every request would 401, and the TokenManager
  // would re-mint through another password POST — one OFW counts against the
  // account. Not latched: this is not OFW judging the password.
  const data: unknown = await response.json();
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  const token = record?.auth;
  if (typeof token !== 'string' || token === '') {
    throw new Error(describeTokenlessLogin(record));
  }
  return {
    token,
    expiresAt: new Date(Date.now() + OFW_TOKEN_TTL_MS),
  };
}

/**
 * An actionable message for a login answer that carried no token. It names
 * the response's KEYS and OFW's own `message` text, never any other value —
 * a challenge payload can carry ids or tokens that do not belong in an error.
 */
function describeTokenlessLogin(record: Record<string, unknown> | null): string {
  const base = 'OFW login returned no token, so it did not sign in';
  if (record === null) {
    return `${base} (the response was not a JSON object). Sign in to OurFamilyWizard in a browser to check the account, then try again.`;
  }
  const keys = Object.keys(record);
  const said = typeof record.message === 'string' ? ` OFW said: "${record.message.substring(0, 200)}".` : '';
  return `${base} (response fields: ${keys.length > 0 ? keys.join(', ') : 'none'}).${said} `
    + 'The account may be locked or need a verification step: sign in to OurFamilyWizard in a browser to clear it, then try again.';
}
