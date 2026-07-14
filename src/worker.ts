import { createConnector } from '@chrischall/mcp-connector';
import { createHelpfulError } from '@chrischall/mcp-utils';
import { OFWClient } from './client.js';
import { ofwAuth, type OFWProps } from './ofw-auth.js';
import { loginWithPassword } from './auth-password.js';
import { registerUserTools } from './tools/user.js';
import { registerMessageTools } from './tools/messages.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerJournalTools } from './tools/journal.js';
import { OFWCacheDO, durableCacheProvider } from './cache/durable.js';
import type { AttachmentIO, ResolvedUpload } from './tools/attachments.js';
import type { CacheStore } from './cache/store.js';
import pkg from '../package.json' with { type: 'json' };

// Capture the Worker `env` (bindings) + operator username per client instance.
// We set this in `buildClient` — which the connector ALWAYS calls with `env`
// (the API tools depend on it) — and read it back in the message registrar's
// cache provider, keyed by the exact client instance so concurrent user
// sessions never cross wires. Deliberately NOT threaded through a registrar
// context argument: that would depend on the connector build forwarding it, and
// a stale bundle silently dropping it is what makes every cache-backed tool
// throw "Cannot read properties of undefined (reading 'env')".
const cacheContext = new WeakMap<
  OFWClient,
  { env: { CACHE_DO?: DurableObjectNamespace<OFWCacheDO> }; username: string }
>();

// The hosted connector has no local filesystem: attachment downloads are
// returned inline as bytes (wrangler.jsonc sets OFW_INLINE_ATTACHMENTS=true, so
// the disk write/read path in the message tools is never taken), and uploads
// from a local file path are simply unavailable. Every disk method therefore
// throws an actionable error rather than reaching for node:fs.
const workerAttachmentIO: AttachmentIO = {
  resolveUpload(_path: string): Promise<ResolvedUpload> {
    return Promise.reject(
      createHelpfulError('Uploading a local file path is not available on the hosted OFW connector.', {
        hint: 'The hosted connector has no local filesystem, so it cannot read a file off disk. Use the stdio/desktop server for path-based uploads.',
      }),
    );
  },
  readDownloaded(_path: string): Buffer | null {
    throw createHelpfulError('Reading a downloaded attachment from disk is not available on the hosted OFW connector.', {
      hint: 'Hosted attachments are inline-only — bytes are returned in the response instead of written to disk.',
    });
  },
  writeDownload(_dest: string, _bytes: Buffer): void {
    throw createHelpfulError('Writing a downloaded attachment to disk is not available on the hosted OFW connector.', {
      hint: 'Hosted attachments are inline-only — bytes are returned in the response instead of written to disk.',
    });
  },
};

// The Cloudflare remote-connector entrypoint: wires the same tool registrars
// the stdio server uses (`src/index.ts`) into `@chrischall/mcp-connector`'s
// generic OAuth + McpAgent harness, with OFW's own password login
// (`src/ofw-auth.ts` → `loginWithPassword`) and a per-user `OFWClient` that
// re-authenticates from the stored OFW credentials when its ~6h token expires.
const { Agent, handler } = createConnector<OFWProps, OFWClient>({
  name: 'ofw-mcp',
  version: pkg.version,
  auth: ofwAuth,
  buildClient: (props, env) => {
    // Inject a per-user auth resolver: each token refresh re-runs OFW's Spring
    // Security form login from this operator's stored credentials, so concurrent
    // user sessions never share a bearer token.
    const client = new OFWClient({
      resolveAuth: async () => {
        const { token, expiresAt } = await loginWithPassword(props.username, props.password);
        return { token, expiresAt, source: 'env' };
      },
    });
    if (!env?.CACHE_DO) {
      console.error(
        '[ofw-mcp] worker: CACHE_DO Durable Object binding is missing — message cache tools will error until it is declared in wrangler.jsonc and redeployed.',
      );
    }
    cacheContext.set(client, { env, username: props.username });
    return client;
  },
  // Keep the SAME order as src/index.ts. Only the message registrar needs the
  // per-user Durable-Object cache + the inline attachment I/O; the other four
  // pass through unchanged.
  tools: [
    registerUserTools,
    (server, client) => registerMessageTools(server, client, providerFor(client), workerAttachmentIO),
    registerCalendarTools,
    registerExpenseTools,
    registerJournalTools,
  ],
});

/** The operator's Durable Object cache-store provider for a given client instance. */
function providerFor(client: OFWClient): () => CacheStore {
  const cx = cacheContext.get(client);
  return durableCacheProvider(cx?.env?.CACHE_DO, cx?.username);
}

// The connector's per-session MCP agent Durable Object
// (`wrangler.jsonc`'s `MCP_OBJECT` → `OFWMcpAgent`) resolves this named export.
export { Agent as OFWMcpAgent };

// The per-operator durable message-cache Durable Object
// (`wrangler.jsonc`'s `CACHE_DO` → `OFWCacheDO`). Exported so the runtime can
// resolve the class.
export { OFWCacheDO };

export default handler;
