import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/expenses.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_get_expense_totals', () => {
  it('calls /pub/v2/expense/expenses/totals', async () => {
    const totals = { owed: 100, paid: 50 };
    const client = makeClient(totals);
    const result = await handleTool('ofw_get_expense_totals', {}, client);
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/expense/expenses/totals');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(totals);
  });
});

describe('ofw_list_expenses', () => {
  it('calls expenses with default pagination', async () => {
    const client = makeClient([]);
    await handleTool('ofw_list_expenses', {}, client);
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=0&max=20'
    );
  });

  it('passes custom start and max', async () => {
    const client = makeClient([]);
    await handleTool('ofw_list_expenses', { start: 20, max: 10 }, client);
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=20&max=10'
    );
  });
});

describe('ofw_create_expense', () => {
  it('posts to /pub/v2/expense/expenses', async () => {
    const client = makeClient({ id: 99 });
    const result = await handleTool('ofw_create_expense', { amount: 50, description: 'School supplies' }, client);
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense/expenses',
      expect.objectContaining({ amount: 50 })
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('toolDefinitions', () => {
  it('exports 3 expense tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toHaveLength(3);
    expect(names).toContain('ofw_get_expense_totals');
    expect(names).toContain('ofw_list_expenses');
    expect(names).toContain('ofw_create_expense');
  });
});

describe('unknown tool', () => {
  it('throws on unknown tool name', async () => {
    const client = makeClient({});
    await expect(handleTool('ofw_unknown', {}, client)).rejects.toThrow('Unknown tool: ofw_unknown');
  });
});
