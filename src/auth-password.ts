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

import { BASE_URL, OFW_PROTOCOL_HEADERS, OFW_TOKEN_TTL_MS } from './protocol.js';

interface LoginResponse {
  auth: string;
  redirectUrl: string;
}

export interface PasswordLoginResult {
  token: string;
  expiresAt: Date;
}

export async function loginWithPassword(
  username: string,
  password: string,
): Promise<PasswordLoginResult> {
  // Step 1: get a SESSION cookie (Spring Security refuses the POST without it).
  const initResponse = await fetch(`${BASE_URL}/ofw/login.form`, {
    headers: { ...OFW_PROTOCOL_HEADERS },
    redirect: 'manual',
  });
  // headers.get('set-cookie') folds multiple Set-Cookie headers into one
  // comma-joined string; getSetCookie() preserves them individually. Echo
  // every cookie back (name=value only) so login keeps working if OFW ever
  // sets cookies beyond SESSION.
  const sessionCookie = initResponse.headers.getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  // Step 2: submit the form.
  const response = await fetch(`${BASE_URL}/ofw/login`, {
    method: 'POST',
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
    throw new Error(`OFW login failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const body = await response.text();
    throw new Error(`OFW login returned unexpected response (${contentType}): ${body.substring(0, 200)}`);
  }

  const data = (await response.json()) as LoginResponse;
  return {
    token: data.auth,
    expiresAt: new Date(Date.now() + OFW_TOKEN_TTL_MS),
  };
}
