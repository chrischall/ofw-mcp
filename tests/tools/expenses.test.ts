import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
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


describe('expense input schemas', () => {
  it('rejects negative start and non-positive/fractional max', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodRawShape }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown, _cb: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodRawShape });
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient());

    const schema = z.object(configs.get('ofw_list_expenses')!.inputSchema!);
    expect(schema.safeParse({ start: -1 }).success).toBe(false);
    expect(schema.safeParse({ max: 0 }).success).toBe(false);
    expect(schema.safeParse({ max: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ start: 0, max: 20 }).success).toBe(true);
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

  it('ofw_create_expense is absent below mode "all"', () => {
    for (const mode of ['none', 'drafts']) {
      process.env.OFW_WRITE_MODE = mode;
      setup(makeClient({}));
      expect(handlers.has('ofw_create_expense')).toBe(false);
      expect(handlers.has('ofw_list_expenses')).toBe(true); // reads unaffected
      expect(handlers.has('ofw_get_expense_totals')).toBe(true);
    }
  });

  it('ofw_create_expense registers in mode "all"', () => {
    process.env.OFW_WRITE_MODE = 'all';
    setup(makeClient({}));
    expect(handlers.has('ofw_create_expense')).toBe(true);
  });
});
