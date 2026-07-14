import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { OFWClient } from '../src/client.js';
import { durableCacheProvider, type OFWCacheDO } from '../src/cache/durable.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerJournalTools } from '../src/tools/journal.js';
import type { AttachmentIO, ResolvedUpload } from '../src/tools/attachments.js';

// Handshake + tool-surface test for the OurFamilyWizard Cloudflare remote
// connector, run inside the real Workers runtime (Miniflare) via
// `@cloudflare/vitest-pool-workers` against `wrangler.jsonc`. It proves three
// things that don't require a live OFW session:
//   1. the OAuth default handler serves discovery + the login page, and
//   2. an unauthenticated `/mcp` request is rejected before any tool code runs;
//   3. the exact registrar wiring `src/worker.ts` uses (against the real
//      `env.CACHE_DO` binding) registers the expected OFW tool surface.
//
// The full authenticated `initialize` + `tools/list` handshake over `/mcp`
// requires a real OAuth access token minted via `workers-oauth-provider`'s
// KV-backed grant flow (POST /authorize with real OFW creds → auth code → POST
// /token), which would mean a live OFW Spring-Security login or extensive KV
// mocking — out of scope for a hermetic in-process test. So #3 asserts tool
// registration through the same in-memory MCP harness the stdio suite uses,
// wired exactly as `worker.ts` wires it (including the durable cache provider
// over the real DO binding), rather than through the token-gated `/mcp` route.

// `env` is untyped in the pool; CACHE_DO is the real per-operator cache DO namespace.
const CACHE = (env as unknown as { CACHE_DO: DurableObjectNamespace<OFWCacheDO> }).CACHE_DO;

// Registration never touches disk, so a throwing stub is sufficient here.
const stubAttachmentIO: AttachmentIO = {
  resolveUpload(): Promise<ResolvedUpload> {
    return Promise.reject(new Error('not used during registration'));
  },
  readDownloaded(): Buffer | null {
    throw new Error('not used during registration');
  },
  writeDownload(): void {
    throw new Error('not used during registration');
  },
};

describe('OFW Cloudflare connector — OAuth surface', () => {
  it('serves the OAuth authorization-server discovery document', async () => {
    const res = await SELF.fetch('https://example.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    expect(meta.authorization_endpoint).toContain('/authorize');
    expect(meta.token_endpoint).toContain('/token');
  });

  it('rejects an unauthenticated /mcp request', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('exposes the wrangler.jsonc OFW_SYNC_MAX_REQUESTS var to the Worker runtime', () => {
    // Proves the bounded/resumable-sync default from wrangler.jsonc's `vars`
    // block reaches the Worker (nodejs_compat mirrors it into process.env, which
    // getSyncMaxRequests() reads). `env` from cloudflare:test is the deterministic
    // view of those vars in the Workers pool.
    const wranglerVars = env as unknown as { OFW_SYNC_MAX_REQUESTS?: string };
    expect(wranglerVars.OFW_SYNC_MAX_REQUESTS).toBe('40');
  });

  it('GET /authorize renders the OurFamilyWizard login page with both field labels', async () => {
    // No `client_id` query param: the login page renders without needing a
    // registered OAuth client, which is all we verify here.
    const res = await SELF.fetch('https://example.com/authorize?response_type=code&state=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('OurFamilyWizard');
    expect(html).toContain('OFW email or username');
    expect(html).toContain('OFW password');
    expect(html).toContain('type="password"');
  });
});

describe('OFW Cloudflare connector — tool surface', () => {
  it('registers the full OFW tool set via the same wiring as worker.ts', async () => {
    // Deterministic write-mode so the count doesn't depend on wrangler var
    // propagation into the Workers runtime's process.env.
    process.env.OFW_WRITE_MODE = 'all';
    delete process.env.OFW_CALENDAR_WRITES;

    const client = new OFWClient();
    const provider = durableCacheProvider(CACHE, 'tool_surface_op');

    // Mirror src/worker.ts's `tools` array exactly (same order, same wiring).
    const harness = await createTestHarness((server) => {
      registerUserTools(server, client);
      registerMessageTools(server, client, provider, stubAttachmentIO);
      registerCalendarTools(server, client);
      registerExpenseTools(server, client);
      registerJournalTools(server, client);
    });

    try {
      const names = (await harness.listTools()).map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'ofw_create_event',
          'ofw_create_expense',
          'ofw_create_journal_entry',
          'ofw_delete_draft',
          'ofw_delete_event',
          'ofw_download_attachment',
          'ofw_get_expense_totals',
          'ofw_get_message',
          'ofw_get_notifications',
          'ofw_get_profile',
          'ofw_get_unread_sent',
          'ofw_list_drafts',
          'ofw_list_events',
          'ofw_list_expenses',
          'ofw_list_journal_entries',
          'ofw_list_message_folders',
          'ofw_list_messages',
          'ofw_save_draft',
          'ofw_send_message',
          'ofw_sync_messages',
          'ofw_update_event',
          'ofw_upload_attachment',
        ].sort(),
      );
      expect(names.length).toBe(22);
    } finally {
      await harness.close();
    }
  });
});
