import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/journal.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_list_journal_entries', () => {
  it('calls /pub/v1/journals with default pagination', async () => {
    const entries = { entries: [{ id: 1, title: 'Today' }] };
    const client = makeClient(entries);
    const result = await handleTool('ofw_list_journal_entries', {}, client);
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/journals?start=1&max=10');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(entries);
  });

  it('passes custom start and max', async () => {
    const client = makeClient({ entries: [] });
    await handleTool('ofw_list_journal_entries', { start: 11, max: 5 }, client);
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/journals?start=11&max=5');
  });
});

describe('ofw_create_journal_entry', () => {
  it('posts to /pub/v1/journals', async () => {
    const client = makeClient({ id: 1 });
    const result = await handleTool('ofw_create_journal_entry', { title: 'Today', body: 'Good day' }, client);
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v1/journals',
      expect.objectContaining({ title: 'Today' })
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('toolDefinitions', () => {
  it('exports 2 journal tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('ofw_list_journal_entries');
    expect(names).toContain('ofw_create_journal_entry');
  });
});

describe('unknown tool', () => {
  it('throws on unknown tool name', async () => {
    const client = makeClient({});
    await expect(handleTool('ofw_unknown', {}, client)).rejects.toThrow('Unknown tool: ofw_unknown');
  });
});
