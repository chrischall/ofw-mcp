import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveAuth } from './auth.js';
import { parseBoolEnv } from './config.js';
import { BASE_URL, OFW_PROTOCOL_HEADERS, OFW_TOKEN_TTL_MS, OFW_TOKEN_EXPIRY_SKEW_MS } from './protocol.js';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb bundle)
try {
  const { config } = await import('dotenv');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  config({ path: join(__dirname, '..', '.env'), override: false, quiet: true });
} catch {
  // not available — rely on process.env (mcpb sets credentials via mcp_config.env)
}

export interface BinaryResponse {
  body: Buffer;
  contentType: string | null;
  /** Parsed from Content-Disposition header if present. */
  suggestedFileName: string | null;
}

// Parse a Content-Disposition header for a filename. Prefers RFC 6266
// `filename*=UTF-8''…` (percent-decoded) and falls back to `filename="…"`.
function parseContentDispositionFilename(cd: string): string | null {
  const extMatch = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (extMatch) {
    const raw = extMatch[1].trim().replace(/^"|"$/g, '');
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m ? m[1] : null;
}

// Set OFW_DEBUG_LOG=1 (or true/yes/on) to log every OFW request/response to
// stderr. Authorization is redacted. Bodies are logged in full — set this
// only when debugging, never in normal use.
function debugLogEnabled(): boolean {
  return parseBoolEnv('OFW_DEBUG_LOG');
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out = { ...h };
  if (out.Authorization) out.Authorization = `Bearer ${out.Authorization.slice(7, 17)}…`;
  return out;
}

// Per-request timeout. Overridable via OFW_REQUEST_TIMEOUT_MS. The default
// (30s) is comfortably above OFW's typical p99 but low enough that a stuck
// upstream fails fast instead of burning the MCP client-side budget — which
// is what produced the multi-minute hangs we've seen on ofw_list_messages
// and ofw_save_draft. Each retry (401/429 replay) gets its own fresh window.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
function getRequestTimeoutMs(): number {
  const raw = process.env.OFW_REQUEST_TIMEOUT_MS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REQUEST_TIMEOUT_MS;
}

export class OFWClient {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureAuthenticated();
    const response = await this.fetchWithRetry(method, path, body, 'application/json', false);
    const text = await response.text();
    if (debugLogEnabled()) {
      console.error(`[ofw-debug] response body: ${text || '<empty>'}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Like `request`, but returns the raw bytes plus Content-Type/-Disposition metadata. */
  async requestBinary(method: string, path: string): Promise<BinaryResponse> {
    await this.ensureAuthenticated();
    const response = await this.fetchWithRetry(method, path, undefined, 'application/octet-stream', false);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
      suggestedFileName: parseContentDispositionFilename(response.headers.get('content-disposition') ?? ''),
    };
  }

  // Single fetch+retry scaffold for both JSON and binary callers. Handles
  // 401 (re-auth and replay once), 429 (wait 2s and replay once), and
  // turns any other non-2xx into a thrown Error.
  private async fetchWithRetry(
    method: string,
    path: string,
    body: unknown,
    accept: string,
    isRetry: boolean,
  ): Promise<Response> {
    const isFormData = body instanceof FormData;
    const headers: Record<string, string> = {
      ...OFW_PROTOCOL_HEADERS,
      Accept: accept,
      Authorization: `Bearer ${this.token!}`,
    };
    if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';

    const url = `${BASE_URL}${path}`;
    if (debugLogEnabled()) {
      const bodyPreview = body === undefined
        ? '<none>'
        : isFormData
          ? `<FormData entries=${Array.from((body as FormData).keys()).join(',')}>`
          : JSON.stringify(body);
      console.error(`[ofw-debug] → ${method} ${url}${isRetry ? ' (retry)' : ''}`);
      console.error(`[ofw-debug]   headers: ${JSON.stringify(redactHeaders(headers))}`);
      console.error(`[ofw-debug]   body: ${bodyPreview}`);
    }

    // AbortController + setTimeout (not AbortSignal.timeout) so vitest fake
    // timers can drive the timeout in tests, and so we can attach a clear
    // error message instead of a bare DOMException on the abort path.
    const timeoutMs = getRequestTimeoutMs();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: ac.signal,
        ...(body !== undefined ? { body: isFormData ? body : JSON.stringify(body) } : {}),
      });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (ac.signal.aborted) {
        if (debugLogEnabled()) {
          console.error(`[ofw-debug] ⏱ TIMEOUT after ${elapsed}ms: ${method} ${url}`);
        }
        throw new Error(
          `OFW API request timed out after ${timeoutMs}ms: ${method} ${path}`,
        );
      }
      if (debugLogEnabled()) {
        console.error(`[ofw-debug] ✗ ${(err as Error).message} after ${elapsed}ms: ${method} ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (debugLogEnabled()) {
      console.error(`[ofw-debug] ← ${response.status} ${response.statusText} (${Date.now() - startedAt}ms)`);
    }

    if (response.status === 401 && !isRetry) {
      this.token = null;
      this.tokenExpiry = null;
      await this.ensureAuthenticated();
      return this.fetchWithRetry(method, path, body, accept, true);
    }
    if (response.status === 429) {
      if (!isRetry) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        return this.fetchWithRetry(method, path, body, accept, true);
      }
      throw new Error('Rate limited by OFW API');
    }
    if (!response.ok) {
      throw new Error(`OFW API error: ${response.status} ${response.statusText} for ${method} ${path}`);
    }
    return response;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.isTokenExpiredSoon()) return;
    await this.login();
  }

  // Auth resolution is delegated to `./auth.ts`. This client doesn't care
  // whether the token came from a password POST or from a one-shot
  // fetchproxy session-snapshot — it just consumes the result.
  //
  // If `expiresAt` is missing (the fetchproxy path on a tab whose
  // browser didn't persist tokenExpiry), we fall back to the same 6h
  // estimate the password path uses. The 401-replay path covers us if
  // the estimate is wrong.
  private async login(): Promise<void> {
    const { token, expiresAt } = await resolveAuth();
    this.token = token;
    this.tokenExpiry = expiresAt ?? new Date(Date.now() + OFW_TOKEN_TTL_MS);
  }

  private isTokenExpiredSoon(): boolean {
    if (!this.token || !this.tokenExpiry) return true;
    return this.tokenExpiry.getTime() - Date.now() < OFW_TOKEN_EXPIRY_SKEW_MS;
  }
}

export const client = new OFWClient();
