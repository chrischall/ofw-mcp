import { renderLoginPage } from './login-page.js';
import type { ConnectorAuth } from './types.js';

export interface ParsedLoginForm {
  /** Raw form field values, keyed by input name (excludes the hidden oauthReq carrier). */
  values: Record<string, string>;
  /** The decoded OAuth authorization request carried in the hidden `oauthReq` field. */
  oauthReq: unknown;
}

/**
 * Parses the login form's POST body: extracts plain field values and decodes
 * the hidden `oauthReq` field (base64-encoded JSON) that round-trips the
 * pending OAuth authorization request across the login form submission.
 */
export async function parseLoginForm(request: Request): Promise<ParsedLoginForm> {
  const formData = await request.formData();
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      values[key] = value;
    }
  }
  const { oauthReq: encodedOauthReq, ...rest } = values;
  const oauthReq = encodedOauthReq ? JSON.parse(atob(encodedOauthReq)) : undefined;
  return { values: rest, oauthReq };
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Default handler for the `/authorize` route: GET renders the service's login
 * form; POST verifies the submitted credentials via `auth.login` and, on
 * success, completes the OAuth authorization with the resulting props.
 */
export async function handleAuthorize<Props>(
  request: Request,
  env: any,
  auth: ConnectorAuth<Props>,
): Promise<Response> {
  if (request.method === 'GET') {
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    return new Response(renderLoginPage(auth, { oauthReq: oauthReqInfo }), {
      headers: { 'content-type': 'text/html' },
    });
  }

  const { values, oauthReq: oauthReqInfo } = await parseLoginForm(request);
  const fields: Record<string, string> = {};
  for (const field of auth.fields) {
    fields[field.name] = values[field.name] ?? '';
  }

  try {
    const props = await auth.login(fields, env);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: fields[auth.fields[0].name],
      scope: [],
      metadata: {},
      props,
    });
    return Response.redirect(redirectTo, 302);
  } catch (e) {
    return new Response(renderLoginPage(auth, { error: messageOf(e), oauthReq: oauthReqInfo }), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }
}
