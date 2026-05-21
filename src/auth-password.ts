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

const BASE_URL = 'https://ofw.ourfamilywizard.com';

const OFW_PROTOCOL_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0',
} as const;

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
  const setCookie = initResponse.headers.get('set-cookie') ?? '';
  const sessionCookie = setCookie.split(';')[0];

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
    // OFW's login endpoint omits expiry. 6h is the empirical TTL and matches
    // the historical behavior of this client (a single 401 → re-auth + replay
    // covers the edge case where this estimate is wrong).
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
  };
}
