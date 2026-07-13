import { loadDotenvSafely, parseBoolEnv, redactSecrets } from '@chrischall/mcp-utils';
import { TokenManager } from '@chrischall/mcp-utils/session';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveAuth } from './auth.js';
import { BASE_URL, OFW_PROTOCOL_HEADERS, OFW_TOKEN_TTL_MS, OFW_TOKEN_EXPIRY_SKEW_MS } from './protocol.js';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb
// bundle). loadDotenvSafely applies override:false + quiet:true and swallows a
// missing dotenv module, matching the prior inline try/catch exactly.
const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env') });

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

// Sentinel "refresh token" handed to the shared TokenManager. OFW has no
// OAuth-style refresh token — every renewal re-runs the full `resolveAuth()`
// (password POST or fetchproxy snapshot). The TokenManager only refuses to
// refresh when its refresh token is `undefined`, so a non-empty placeholder
// keeps the single-flight refresh path live; the refresh callback ignores it.
const OFW_REFRESH_SENTINEL = 'ofw';

export class OFWClient {
  // Bearer-token lifecycle is delegated to the shared, race-safe TokenManager
  // (proactive refresh inside the skew window, single-flight refresh so a burst
  // of concurrent callers coalesces onto ONE `resolveAuth()`, and a 401-replay
  // guarded against double-refresh). It is created lazily, seeded with an
  // already-expired placeholder token so the first request drives the refresh
  // callback — i.e. the original "log in on first request" behavior.
  private tokenManager: TokenManager | undefined;

  private getTokenManager(): TokenManager {
    if (!this.tokenManager) {
      this.tokenManager = new TokenManager({
        initial: { accessToken: '', refreshToken: OFW_REFRESH_SENTINEL, expiresAt: 0 },
        skewMs: OFW_TOKEN_EXPIRY_SKEW_MS,
        // Map OFW's mint/refresh onto the refresh callback. `resolveAuth()`
        // returns a token and a best-effort expiry; when the fetchproxy path
        // can't supply one we fall back to the same 6h estimate the password
        // path uses (the 401-replay covers a wrong guess). We re-arm the
        // sentinel so the manager can refresh again later.
        refresh: async () => {
          const { token, expiresAt } = await resolveAuth();
          return {
            accessToken: token,
            refreshToken: OFW_REFRESH_SENTINEL,
            expiresAt: (expiresAt ?? new Date(Date.now() + OFW_TOKEN_TTL_MS)).getTime(),
          };
        },
      });
    }
    return this.tokenManager;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchAuthed(method, path, body, 'application/json');
    const text = await response.text();
    if (debugLogEnabled()) {
      console.error(`[ofw-debug] response body: ${text || '<empty>'}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Like `request`, but returns the raw bytes plus Content-Type/-Disposition metadata. */
  async requestBinary(method: string, path: string): Promise<BinaryResponse> {
    const response = await this.fetchAuthed(method, path, undefined, 'application/octet-stream');
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
      suggestedFileName: parseContentDispositionFilename(response.headers.get('content-disposition') ?? ''),
    };
  }

  // Authenticated fetch for both JSON and binary callers. Auth (proactive
  // refresh inside the skew window + one 401-replay, guarded against a
  // double-refresh under concurrency) is delegated to the shared TokenManager's
  // `withAuth`. The 429 wait-and-replay and the non-2xx → throw remain here.
  private async fetchAuthed(
    method: string,
    path: string,
    body: unknown,
    accept: string,
  ): Promise<Response> {
    // `withAuth` invokes `call` once, and again after a refresh on a 401. The
    // second invocation is the replay — mark it `(retry)` in the debug log,
    // preserving the prior bespoke-loop diagnostic.
    let attempt = 0;
    let response = await this.getTokenManager().withAuth((token) =>
      this.fetchOnce(method, path, body, accept, token, attempt++ > 0),
    );
    if (response.status === 429) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      response = await this.getTokenManager().withAuth((token) =>
        this.fetchOnce(method, path, body, accept, token, true),
      );
      if (response.status === 429) throw new Error('Rate limited by OFW API');
    }
    if (!response.ok) {
      throw new Error(`OFW API error: ${response.status} ${response.statusText} for ${method} ${path}`);
    }
    return response;
  }

  // A single OFW API fetch with the bearer token supplied by `withAuth`.
  // Carries the per-request timeout (AbortController + setTimeout so vitest
  // fake timers can drive it and we attach a clear error message) and the
  // OFW_DEBUG_LOG instrumentation. Returns the raw Response — 401/429/non-2xx
  // handling lives in the callers (`withAuth` and `fetchAuthed`).
  private async fetchOnce(
    method: string,
    path: string,
    body: unknown,
    accept: string,
    token: string,
    isRetry = false,
  ): Promise<Response> {
    const isFormData = body instanceof FormData;
    const headers: Record<string, string> = {
      ...OFW_PROTOCOL_HEADERS,
      Accept: accept,
      Authorization: `Bearer ${token}`,
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
      // redactSecrets scrubs the Bearer token (and any other secret shapes)
      // from the serialized header map — shared fleet redaction, never bespoke.
      console.error(`[ofw-debug]   headers: ${redactSecrets(JSON.stringify(headers))}`);
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

    return response;
  }
}

export const client = new OFWClient();
