import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { CAN_ASK_CTX, NO_ELICIT_CTX, callConfirmed, callPreview, type GatedHandler } from './_confirm-helpers.js';

type ToolHandler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; resultType?: string }>;

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

  it('reports zero returned when the response carries no record array at all', async () => {
    // Defensive: these endpoints are unvalidated passthroughs, so an upstream
    // shape with no array must still produce honest paging state rather than
    // a crash or a confident "there is more".
    const client = makeClient({ message: 'no records' });
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({})).content[0].text);
    expect(parsed.returned).toBe(0);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextStart).toBeNull();
    expect(parsed.message).toBe('no records');
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
    const result = await callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, { amount: 50, description: 'School supplies' });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense/expenses',
      expect.objectContaining({ amount: 50 })
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});


describe('ofw_create_expense — confirmation gate (SEC-2)', () => {
  it('phase 1 previews the amount and description and posts NOTHING', async () => {
    const client = makeClient({ id: 99 });
    setup(client);
    const preview = await callPreview(handlers.get('ofw_create_expense')! as GatedHandler, { amount: 42.5, description: 'Soccer cleats' });
    expect(client.request).not.toHaveBeenCalled();
    expect(preview.preview).toMatchObject({ amount: 42.5, description: 'Soccer cleats' });
    expect(JSON.stringify(preview.preview)).toMatch(/co-parent/i);
  });

  it('phase 2 with a different amount is refused and posts nothing', async () => {
    const client = makeClient({ id: 99 });
    setup(client);
    const handler = handlers.get('ofw_create_expense')!;
    const { confirmToken } = await callPreview(handler as GatedHandler, { amount: 10, description: 'Lunch' });
    const result = await handler({ amount: 1000, description: 'Lunch', confirmToken }, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'DRAFT_CHANGED', dispatched: false });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('a client that can be prompted gets the real prompt', async () => {
    const client = makeClient({ id: 99 });
    setup(client);
    const result = await handlers.get('ofw_create_expense')!({ amount: 1, description: 'x' }, CAN_ASK_CTX);
    expect(result.resultType).toBe('input_required');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('is annotated so hosts do not auto-approve it as a harmless local write', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { annotations?: Record<string, unknown>; inputSchema?: z.ZodObject; description: string }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
      configs.set(name, config as { annotations?: Record<string, unknown>; inputSchema?: z.ZodObject; description: string });
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient());
    const tool = configs.get('ofw_create_expense')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tool.inputSchema!.shape).toHaveProperty('confirmToken');
    expect(tool.description).toMatch(/MCP_CONFIRM_MODE/);
  });
});

describe('ofw_create_expense — unconfirmed outcome (BUG-2)', () => {
  it('a POST that times out returns EXPENSE_UNCONFIRMED telling the caller NOT to retry', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API request timed out after 30000ms: POST /pub/v2/expense/expenses'));
    setup(client);
    const result = await callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, { amount: 50, description: 'School supplies' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBe('EXPENSE_UNCONFIRMED');
    expect(parsed.mayHaveLanded).toBe(true);
    expect(parsed.remedy).toMatch(/do not retry/i);
    expect(parsed.remedy).toMatch(/ofw_list_expenses/);
  });

  it('a definitive 4xx rejection is still a plain error (nothing landed, a retry is safe)', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 400 Bad Request for POST /pub/v2/expense/expenses'));
    setup(client);
    await expect(callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, { amount: 50, description: 'x' }))
      .rejects.toThrow(/400 Bad Request/);
  });
});

describe('expense input schemas', () => {
  it('rejects negative start and non-positive/fractional max', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodObject }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown, _cb: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodObject });
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient());

    const schema = configs.get('ofw_list_expenses')!.inputSchema!;
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
