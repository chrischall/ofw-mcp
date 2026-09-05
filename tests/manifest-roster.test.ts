import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerJournalTools } from '../src/tools/journal.js';
import { NodeAttachmentIO } from '../src/tools/attachments.js';
import type { CacheStore } from '../src/cache/store.js';
import type { OFWClient } from '../src/client.js';

/**
 * `manifest.json`'s tool roster must equal the REGISTERED roster, both ways.
 *
 * This is the file an mcpb host reads to decide what to show. A tool missing
 * from it is callable by name and invisible in the UI; a tool listed but not
 * registered is advertised and then fails. Neither breaks a test, breaks the
 * build, or breaks the server — nothing else in this repo reads the file — so
 * the drift is silent in both directions and only a user notices.
 *
 * It had drifted: `ofw_check_freshness` and `ofw_status` were registered and
 * absent from the manifest. `ofw_status` is the call the whole "verify rather
 * than recite" design rests on (see CLAUDE.md), so it was exactly the wrong
 * one to hide.
 *
 * The roster is read by REGISTERING, not by scanning source. A grep for
 * `registerTool('name'` misses a name on a continuation line, a name that is a
 * loop variable, and a tool registered through a shared helper — all three
 * occur across this fleet.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'),
) as { tools: { name: string; description?: string }[] };

function registeredToolNames(): string[] {
  const names: string[] = [];
  const server = { registerTool: (name: string) => void names.push(name) } as unknown as McpServer;
  const client = {} as OFWClient;
  // Neither the cache nor the attachment IO is touched by registration — the
  // handlers are never invoked here — so a stub keeps the test off the disk.
  const cacheProvider = (): CacheStore => ({}) as CacheStore;
  registerHealthcheckTools(server, client);
  registerUserTools(server, client);
  registerMessageTools(server, client, cacheProvider, new NodeAttachmentIO());
  registerCalendarTools(server, client);
  registerExpenseTools(server, client);
  registerJournalTools(server, client);
  return names;
}

describe('manifest.json tool roster', () => {
  // Registration is gated by OFW_WRITE_MODE, and the manifest describes the
  // full surface — so the comparison has to be made in the mode that registers
  // everything, or the test would "pass" by hiding the write tools too.
  const saved = process.env.OFW_WRITE_MODE;
  beforeAll(() => {
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = saved;
  });

  it('lists every registered tool', () => {
    const registered = registeredToolNames().sort();
    const listed = manifest.tools.map((t) => t.name).sort();
    expect(registered.filter((n) => !listed.includes(n))).toEqual([]);
  });

  it('lists no tool that is not registered', () => {
    const registered = registeredToolNames();
    const listed = manifest.tools.map((t) => t.name).sort();
    expect(listed.filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('gives every entry a non-blank description', () => {
    expect(manifest.tools.filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
  });
});
