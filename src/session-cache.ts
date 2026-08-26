import {
  createFileStatePersistence,
  resolveStateFile,
  type BearerTokens,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';

/**
 * Where the OFW session token is cached between runs.
 *
 * OFW has no OAuth refresh token — every renewal re-runs the full
 * `resolveAuth()` (a password POST, or a fetchproxy snapshot). The token itself
 * is good for six hours (`OFW_TOKEN_TTL_MS`), so on a scale-to-zero host, where
 * children idle out after ten minutes and every start is a cold one, the same
 * six-hour token was being re-minted many times over. Caching it turns those
 * restarts into zero-cost ones; an expired token still costs exactly what it did
 * before.
 */
export function sessionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'OFW_SESSION_FILE',
    subdir: '.ofw-mcp',
    fileName: 'session.json',
  });
}

/** Only a token pair is ever stored — never the username or password. */
function isTokens(raw: unknown): raw is BearerTokens {
  if (raw === null || typeof raw !== 'object') return false;
  const t = raw as Partial<BearerTokens>;
  return (
    typeof t.accessToken === 'string' &&
    t.accessToken !== '' &&
    typeof t.expiresAt === 'number' &&
    (t.refreshToken === undefined || typeof t.refreshToken === 'string')
  );
}

/** Options for {@link createSessionCache}. */
export interface SessionCacheOptions {
  env?: NodeJS.ProcessEnv;
  /** True when the caller supplied its own auth resolver — see below. */
  injectedResolver?: boolean;
}

/**
 * The session cache, or `null` when it must not be used.
 *
 * Three ways it comes back `null`, each deliberate:
 *
 *  - `OFW_SESSION_CACHE=false` — the operator opted out.
 *  - **A caller-injected auth resolver.** That is the per-user hosted path, and
 *    this registration declares no `identity.perUserChild`, so one process can
 *    serve several people. A single cache file would hand one user's session to
 *    the next; until the child is per-user, that path simply does not cache.
 *  - **No env credentials.** The fetchproxy path authenticates from a signed-in
 *    browser tab rather than a stored secret, so there is nothing stable to bind
 *    a cached token to — and it is local-only, where cold starts are rare.
 *
 * When it is used, the record is bound to the credentials that minted it, so
 * rotating either discards it. Only a salted digest is written.
 */
export function createSessionCache(
  opts: SessionCacheOptions = {},
): SyncStatePersistence<BearerTokens> | null {
  const env = opts.env ?? process.env;
  if (opts.injectedResolver === true) return null;
  if (!parseBoolEnv('OFW_SESSION_CACHE', { env, default: true })) return null;
  const username = readEnvVar('OFW_USERNAME', { env });
  const password = readEnvVar('OFW_PASSWORD', { env });
  if (username === undefined || password === undefined) return null;

  return createFileStatePersistence<BearerTokens>({
    filePath: sessionCachePath(env),
    // Joined on a NUL, written as an escape rather than a literal byte: a
    // password may contain spaces, so a space-joined pair could collide with
    // a different pair by shifting the boundary between the two halves.
    boundTo: [username.trim().toLowerCase(), password].join('\u0000'),
    validate: (raw) => (isTokens(raw) ? raw : null),
  });
}

/**
 * Report a cache write that failed. Not fatal: OFW tokens are re-mintable from
 * the credentials in the environment, so a lost write costs the next start a
 * login rather than access. Still worth saying — a read-only data dir otherwise
 * looks exactly like a server that never caches. stderr only; stdout is JSON-RPC.
 */
export function reportCacheWriteFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[ofw-mcp] could not cache the session token (${detail}); continuing without the ` +
      'cache — every restart will re-authenticate until this is fixed.',
  );
}
