import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';

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
  registerExpenseTools(server, client);
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_get_expense_totals', () => {
  it('calls /pub/v2/expense/expenses/totals', async () => {
    const totals = { owed: 100, paid: 50 };
    const client = makeClient(totals);
    setup(client);
    const result = await handlers.get('ofw_get_expense_totals')!({});
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/expense/expenses/totals');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(totals);
  });
});

describe('ofw_list_expenses', () => {
  it('calls expenses with default pagination', async () => {
    const client = makeClient([]);
    setup(client);
    await handlers.get('ofw_list_expenses')!({});
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=0&max=20'
    );
  });

  it('passes custom start and max', async () => {
    const client = makeClient([]);
    setup(client);
    await handlers.get('ofw_list_expenses')!({ start: 20, max: 10 });
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=20&max=10'
    );
  });
});

describe('ofw_create_expense', () => {
  it('posts to /pub/v2/expense/expenses', async () => {
    const client = makeClient({ id: 99 });
    setup(client);
    const result = await handlers.get('ofw_create_expense')!({ amount: 50, description: 'School supplies' });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense/expenses',
      expect.objectContaining({ amount: 50 })
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('registerExpenseTools', () => {
  it('registers 3 expense tools', () => {
    const client = makeClient({});
    setup(client);
    expect(handlers.size).toBe(3);
    expect(handlers.has('ofw_get_expense_totals')).toBe(true);
    expect(handlers.has('ofw_list_expenses')).toBe(true);
    expect(handlers.has('ofw_create_expense')).toBe(true);
  });
});
