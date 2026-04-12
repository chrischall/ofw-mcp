import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('registerJournalTools', () => {
  it('registers 2 journal tools', () => {
    const client = makeClient({});
    setup(client);
    expect(handlers.size).toBe(2);
    expect(handlers.has('ofw_list_journal_entries')).toBe(true);
    expect(handlers.has('ofw_create_journal_entry')).toBe(true);
  });
});
