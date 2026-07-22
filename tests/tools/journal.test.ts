import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerJournalTools } from '../../src/tools/journal.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let handlers: Map<string, ToolHandler>;

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

function setup(client: OFWClient) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerJournalTools(server, client);
}

afterEach(() => vi.restoreAllMocks());

// Default write mode is now fail-safe 'none'; these tests exercise the write
// tools, so opt into 'all'. The OFW_WRITE_MODE gating describe overrides.
let originalWriteMode: string | undefined;
beforeEach(() => {
  originalWriteMode = process.env.OFW_WRITE_MODE;
  process.env.OFW_WRITE_MODE = 'all';
});
afterEach(() => {
  if (originalWriteMode === undefined) delete process.env.OFW_WRITE_MODE;
  else process.env.OFW_WRITE_MODE = originalWriteMode;
});

describe('ofw_list_journal_entries', () => {
  it('calls /pub/v1/journals with default pagination', async () => {
    const entries = { entries: [{ id: 1, title: 'Today' }] };
    const client = makeClient(entries);
    setup(client);
    const result = await handlers.get('ofw_list_journal_entries')!({});
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/journals?start=1&max=10');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(entries);
  });

  it('passes custom start and max', async () => {
    const client = makeClient({ entries: [] });
    setup(client);
    await handlers.get('ofw_list_journal_entries')!({ start: 11, max: 5 });
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/journals?start=11&max=5');
  });
});

describe('ofw_create_journal_entry', () => {
  it('posts to /pub/v1/journals', async () => {
    const client = makeClient({ id: 1 });
    setup(client);
    const result = await handlers.get('ofw_create_journal_entry')!({ title: 'Today', body: 'Good day' });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v1/journals',
      expect.objectContaining({ title: 'Today' })
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});


describe('journal input schemas', () => {
  it('rejects non-positive start/max (journal offsets are 1-based)', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodRawShape }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown, _cb: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodRawShape });
      return undefined as never;
    });
    registerJournalTools(server, new OFWClient());

    const schema = z.object(configs.get('ofw_list_journal_entries')!.inputSchema!);
    expect(schema.safeParse({ start: 0 }).success).toBe(false);
    expect(schema.safeParse({ max: 0 }).success).toBe(false);
    expect(schema.safeParse({ start: 1, max: 10 }).success).toBe(true);
  });
});

describe('OFW_WRITE_MODE gating', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('ofw_create_journal_entry is absent below mode "all"', () => {
    for (const mode of ['none', 'drafts']) {
      process.env.OFW_WRITE_MODE = mode;
      setup(makeClient({}));
      expect(handlers.has('ofw_create_journal_entry')).toBe(false);
      expect(handlers.has('ofw_list_journal_entries')).toBe(true); // reads unaffected
    }
  });

  it('ofw_create_journal_entry registers in mode "all"', () => {
    process.env.OFW_WRITE_MODE = 'all';
    setup(makeClient({}));
    expect(handlers.has('ofw_create_journal_entry')).toBe(true);
  });
});
