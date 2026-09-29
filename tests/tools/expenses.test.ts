import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import type { AttachmentIO } from '../../src/tools/attachments.js';
import { CAN_ASK_CTX, NO_ELICIT_CTX, callConfirmed, callPreview, type GatedHandler } from './_confirm-helpers.js';

type ToolHandler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; resultType?: string }>;

let handlers: Map<string, ToolHandler>;

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

function makeAttachmentIO(
  fileName = 'receipt.pdf',
  mimeType = 'application/pdf',
): AttachmentIO {
  return {
    supportsDisk: true,
    resolveUpload: vi.fn().mockResolvedValue({
      blob: new Blob(['%PDF-1.4\n'], { type: mimeType }),
      fileName,
      mimeType,
      sizeBytes: 9,
    }),
    readDownloaded: () => null,
    writeDownload: () => undefined,
  };
}

function setup(client: OFWClient, attachmentIO?: AttachmentIO) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerExpenseTools(server, client, attachmentIO);
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

describe('ofw_list_expense_categories', () => {
  it('calls the expense categories endpoint and returns the payload unchanged', async () => {
    const categories = {
      data: [
        {
          id: 9001,
          title: 'Shared Category',
          description: 'Synthetic shared category.',
          split: { parentSplit: '50', coparentSplit: '50' },
        },
      ],
    };
    const client = makeClient(categories);
    setup(client);

    const result = await handlers.get('ofw_list_expense_categories')!({});

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/expense/categories');
    expect(JSON.parse(result.content[0].text)).toEqual(categories);
  });

  it('registers as a read-only tool', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { annotations?: { readOnlyHint?: boolean } }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
      configs.set(name, config as { annotations?: { readOnlyHint?: boolean } });
      return undefined as never;
    });

    registerExpenseTools(server, new OFWClient(), makeAttachmentIO());

    expect(configs.get('ofw_list_expense_categories')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('ofw_list_expenses', () => {
  it('calls expenses with default page-based pagination', async () => {
    const client = makeClient({ data: [], metadata: { currentPage: 1, perPage: 20, last: true } });
    setup(client);
    await handlers.get('ofw_list_expenses')!({});
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?page=1&size=20'
    );
  });

  it('reports zero returned when the response carries no record array at all', async () => {
    const client = makeClient({ message: 'no records' });
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({})).content[0].text);
    expect(parsed.returned).toBe(0);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPage).toBeNull();
    expect(parsed.message).toBe('no records');
  });

  it('passes custom page and size', async () => {
    const client = makeClient({ data: [], metadata: { currentPage: 3, perPage: 10, last: true } });
    setup(client);
    await handlers.get('ofw_list_expenses')!({ page: 3, size: 10 });
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?page=3&size=10'
    );
  });

  it('uses OFW metadata to expose the next page', async () => {
    const client = makeClient({
      data: [{ id: 1 }, { id: 2 }],
      metadata: { currentPage: 1, page: 1, perPage: 20, count: 20, first: true, last: false },
    });
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({ page: 1, size: 20 })).content[0].text);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPage).toBe(2);
    expect(parsed.page).toBe(1);
    expect(parsed.size).toBe(20);
    expect(parsed.returned).toBe(2);
  });

  it('stops pagination when OFW metadata marks the page last', async () => {
    const client = makeClient({
      data: [{ id: 99 }],
      metadata: { currentPage: 4, page: 4, perPage: 20, count: 20, first: false, last: true },
    });
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({ page: 4 })).content[0].text);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPage).toBeNull();
  });
});

describe('ofw_upload_expense_pdf', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('uploads a PDF as a SHARED expense-source My Files object', async () => {
    const client = makeClient({
      fileId: 123,
      fileName: 'receipt.pdf',
      fileType: 'application/pdf',
      sizeInBytes: 9,
      shareClass: 'SHARED',
    });
    const io = makeAttachmentIO();
    setup(client, io);

    const result = await callConfirmed(handlers.get('ofw_upload_expense_pdf')! as GatedHandler, { path: '/tmp/receipt.pdf' });
    expect(io.resolveUpload).toHaveBeenCalledWith('/tmp/receipt.pdf');

    const call = vi.mocked(client.request).mock.calls[0];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/pub/v3/myfiles/multipart');
    const form = call[2] as FormData;
    expect(form.get('source')).toBe('expense');
    expect(form.get('shareClass')).toBe('SHARED');
    expect(form.get('shared')).toBe('true');
    expect(form.get('fileName')).toBe('receipt.pdf');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.fileId).toBe(123);
    expect(parsed.shareClass).toBe('SHARED');
  });

  it('uploads a signed hosted PDF URL without using local AttachmentIO', async () => {
    const client = makeClient({
      fileId: 456,
      fileName: 'receipt.pdf',
      fileType: 'application/pdf',
      sizeInBytes: 9,
      shareClass: 'SHARED',
    });
    const io = makeAttachmentIO();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': '9',
        },
      }),
    );

    setup(client, io);
    const result = await callConfirmed(handlers.get('ofw_upload_expense_pdf')! as GatedHandler, {
      url: 'https://example.oaiusercontent.com/files/receipt/raw?sig=test',
      fileName: 'receipt.pdf',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(io.resolveUpload).not.toHaveBeenCalled();

    const call = vi.mocked(client.request).mock.calls[0];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/pub/v3/myfiles/multipart');
    const form = call[2] as FormData;
    expect(form.get('source')).toBe('expense');
    expect(form.get('shareClass')).toBe('SHARED');
    expect(form.get('shared')).toBe('true');
    expect(form.get('fileName')).toBe('receipt.pdf');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.fileId).toBe(456);
    expect(parsed.shareClass).toBe('SHARED');
  });

  it('rejects untrusted remote PDF hosts before calling OFW', async () => {
    const client = makeClient({});
    setup(client, makeAttachmentIO());

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({
        url: 'https://example.com/receipt.pdf',
        fileName: 'receipt.pdf',
      }),
    ).rejects.toThrow(/oaiusercontent\.com/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('requires exactly one upload source', async () => {
    const client = makeClient({});
    setup(client, makeAttachmentIO());

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({ fileName: 'receipt.pdf' }),
    ).rejects.toThrow(/exactly one of path or url/i);

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({
        path: '/tmp/receipt.pdf',
        url: 'https://example.oaiusercontent.com/files/receipt/raw?sig=test',
        fileName: 'receipt.pdf',
      }),
    ).rejects.toThrow(/exactly one of path or url/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects non-PDF uploads before calling OFW', async () => {
    const client = makeClient({});
    setup(client, makeAttachmentIO('receipt.jpg', 'image/jpeg'));

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({ path: '/tmp/receipt.jpg' }),
    ).rejects.toThrow(/must be PDF/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('ofw_create_expense', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('posts the current OFW expense-form payload', async () => {
    const client = makeClient({ id: 99 });
    setup(client, makeAttachmentIO());
    const result = await callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, {
      title: 'School supplies',
      amount: 50,
      purchaseDate: '2026-09-20',
      categoryId: 1,
      payerId: 101,
      children: [203],
      description: 'School supplies',
    });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense',
      {
        title: 'School supplies',
        amount: 50,
        purchaseDate: '2026-09-20',
        categoryId: 1,
        payerId: 101,
        children: [203],
        description: 'School supplies',
      },
    );
    expect(result.content).toHaveLength(1);
  });

  it('maps privateExpense to isPrivate=true and attaches one receipt file', async () => {
    const client = makeClient({ id: 100 });
    setup(client, makeAttachmentIO());
    await callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, {
      title: 'Medical copay',
      amount: 42.25,
      purchaseDate: '2026-09-19',
      categoryId: 2,
      payerId: 101,
      children: [203],
      description: 'Medical copay',
      privateExpense: true,
      receiptFileId: 777,
    });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense',
      {
        title: 'Medical copay',
        amount: 42.25,
        purchaseDate: '2026-09-19',
        categoryId: 2,
        payerId: 101,
        children: [203],
        description: 'Medical copay',
        isPrivate: true,
        fileIds: [777],
      },
    );
  });

  it('maps an explicitly shared expense to isPrivate=false', async () => {
    const client = makeClient({ id: 101 });
    setup(client, makeAttachmentIO());
    await callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, {
      title: 'Shared',
      amount: 10,
      purchaseDate: '2026-09-18',
      categoryId: 1,
      payerId: 101,
      children: [201, 202, 203],
      privateExpense: false,
    });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense',
      {
        title: 'Shared',
        amount: 10,
        purchaseDate: '2026-09-18',
        categoryId: 1,
        payerId: 101,
        children: [201, 202, 203],
        isPrivate: false,
      },
    );
  });

  it('requires title, purchase date, category, payer, and at least one child', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodObject }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodObject });
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient(), makeAttachmentIO());

    const schema = configs.get('ofw_create_expense')!.inputSchema!;
    expect(schema.safeParse({
      title: 'Expense',
      amount: 10,
      purchaseDate: '2026-09-28',
      categoryId: 1,
      payerId: 101,
      children: [203],
    }).success).toBe(true);
    expect(schema.safeParse({ amount: 10, description: 'legacy' }).success).toBe(false);
    expect(schema.safeParse({
      title: 'Expense',
      amount: 10,
      purchaseDate: '09/28/2026',
      categoryId: 1,
      payerId: 101,
      children: [203],
    }).success).toBe(false);
    expect(schema.safeParse({
      title: 'Expense',
      amount: 10,
      purchaseDate: '2026-09-28',
      categoryId: 1,
      payerId: 101,
      children: [],
    }).success).toBe(false);
  });
});

describe('ofw_update_expense', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('publishes a private expense with the full OFW web-app payload', async () => {
    const client = makeClient({ id: 9001 });
    setup(client, makeAttachmentIO());
    await callConfirmed(handlers.get('ofw_update_expense')! as GatedHandler, {
      expenseId: 9001,
      title: 'Sample recurring service expense',
      categoryId: 304873,
      amount: 35.87,
      purchaseDate: '2026-09-09',
      receiptFileId: 7001,
      privateExpense: false,
      payerId: 101,
      children: [203],
    });

    expect(client.request).toHaveBeenCalledWith(
      'PUT',
      '/pub/v2/expense/expenses/9001',
      {
        title: 'Sample recurring service expense',
        amount: 35.87,
        purchaseDate: '2026-09-09',
        categoryId: 304873,
        payerId: 101,
        children: [203],
        isPrivate: false,
        fileIds: [7001],
      },
    );
  });

  it('requires a complete resource payload including privacy', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodObject }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodObject });
      return undefined as never;
    });
    process.env.OFW_WRITE_MODE = 'all';
    registerExpenseTools(server, new OFWClient(), makeAttachmentIO());

    const schema = configs.get('ofw_update_expense')!.inputSchema!;
    expect(schema.safeParse({
      expenseId: 123,
      title: 'Expense',
      amount: 10,
      purchaseDate: '2026-09-28',
      categoryId: 1,
      payerId: 101,
      children: [203],
      privateExpense: false,
    }).success).toBe(true);
    expect(schema.safeParse({
      expenseId: 123,
      title: 'Expense',
      amount: 10,
      purchaseDate: '2026-09-28',
      categoryId: 1,
      payerId: 101,
      children: [203],
    }).success).toBe(false);
  });
});

describe('ofw_create_expense — confirmation gate (SEC-2)', () => {
  it('phase 1 previews the amount and description and posts NOTHING', async () => {
    const client = makeClient({ id: 99 });
    setup(client);
    const preview = await callPreview(handlers.get('ofw_create_expense')! as GatedHandler, { title: 'T', amount: 42.5, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203], description: 'Soccer cleats' });
    expect(client.request).not.toHaveBeenCalled();
    expect(preview.preview).toMatchObject({ title: 'T', amount: 42.5, purchaseDate: '2026-09-20', description: 'Soccer cleats', visibility: 'shared with the co-parent' });
    expect(JSON.stringify(preview.preview)).toMatch(/co-parent/i);
  });

  it('phase 2 with a different amount is refused and posts nothing', async () => {
    const client = makeClient({ id: 99 });
    setup(client);
    const handler = handlers.get('ofw_create_expense')!;
    const { confirmToken } = await callPreview(handler as GatedHandler, { title: 'T', amount: 10, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203], description: 'Lunch' });
    const result = await handler({ title: 'T', amount: 1000, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203], description: 'Lunch', confirmToken }, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'DRAFT_CHANGED', dispatched: false });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('a client that can be prompted gets the real prompt', async () => {
    const client = makeClient({ id: 99 });
    setup(client);
    const result = await handlers.get('ofw_create_expense')!({ title: 'T', amount: 1, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203], description: 'x' }, CAN_ASK_CTX);
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
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API request timed out after 30000ms: POST /pub/v2/expense'));
    setup(client);
    const result = await callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, { title: 'T', amount: 50, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203], description: 'School supplies' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBe('EXPENSE_UNCONFIRMED');
    expect(parsed.mayHaveLanded).toBe(true);
    expect(parsed.remedy).toMatch(/do not retry/i);
    expect(parsed.remedy).toMatch(/ofw_list_expenses/);
  });

  it('a definitive 4xx rejection is still a plain error (nothing landed, a retry is safe)', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 400 Bad Request for POST /pub/v2/expense'));
    setup(client);
    await expect(callConfirmed(handlers.get('ofw_create_expense')! as GatedHandler, { title: 'T', amount: 50, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203], description: 'x' }))
      .rejects.toThrow(/400 Bad Request/);
  });
});

describe('expense input schemas', () => {
  it('rejects invalid expense page and size values', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodObject }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown, _cb: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodObject });
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient(), makeAttachmentIO());

    const schema = configs.get('ofw_list_expenses')!.inputSchema!;
    expect(schema.safeParse({ page: 0 }).success).toBe(false);
    expect(schema.safeParse({ size: 0 }).success).toBe(false);
    expect(schema.safeParse({ size: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ size: 101 }).success).toBe(false);
    expect(schema.safeParse({ page: 1, size: 20 }).success).toBe(true);
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

  it('expense creation is absent below mode "all"', () => {
    for (const mode of ['none', 'drafts']) {
      process.env.OFW_WRITE_MODE = mode;
      setup(makeClient({}), makeAttachmentIO());
      expect(handlers.has('ofw_create_expense')).toBe(false);
      expect(handlers.has('ofw_update_expense')).toBe(false);
      expect(handlers.has('ofw_list_expenses')).toBe(true);
      expect(handlers.has('ofw_get_expense_totals')).toBe(true);
    }
  });

  it('receipt upload (SHARED, so co-parent-visible) is absent below mode "all"', () => {
    for (const mode of ['none', 'drafts']) {
      process.env.OFW_WRITE_MODE = mode;
      setup(makeClient({}), makeAttachmentIO());
      expect(handlers.has('ofw_upload_expense_pdf')).toBe(false);
    }
  });

  it('receipt upload is absent without an attachment I/O implementation', () => {
    process.env.OFW_WRITE_MODE = 'all';
    setup(makeClient({}));
    expect(handlers.has('ofw_upload_expense_pdf')).toBe(false);
  });

  it('registers both expense write tools in mode "all"', () => {
    process.env.OFW_WRITE_MODE = 'all';
    setup(makeClient({}), makeAttachmentIO());
    expect(handlers.has('ofw_create_expense')).toBe(true);
    expect(handlers.has('ofw_update_expense')).toBe(true);
    expect(handlers.has('ofw_upload_expense_pdf')).toBe(true);
  });
});


describe('OFW_EXPENSE_UPLOAD_ONLY gating', () => {
  let originalMode: string | undefined;
  let originalOnly: string | undefined;
  let originalUploadOnly: string | undefined;

  beforeEach(() => {
    originalMode = process.env.OFW_WRITE_MODE;
    originalOnly = process.env.OFW_EXPENSE_ONLY;
    originalUploadOnly = process.env.OFW_EXPENSE_UPLOAD_ONLY;
    process.env.OFW_WRITE_MODE = 'all';
    delete process.env.OFW_EXPENSE_ONLY;
    process.env.OFW_EXPENSE_UPLOAD_ONLY = 'true';
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = originalMode;
    if (originalOnly === undefined) delete process.env.OFW_EXPENSE_ONLY;
    else process.env.OFW_EXPENSE_ONLY = originalOnly;
    if (originalUploadOnly === undefined) delete process.env.OFW_EXPENSE_UPLOAD_ONLY;
    else process.env.OFW_EXPENSE_UPLOAD_ONLY = originalUploadOnly;
  });

  it('registers only the upload/create expense tools inside the expense registrar', () => {
    setup(makeClient({}), makeAttachmentIO());
    expect([...handlers.keys()].sort()).toEqual([
      'ofw_create_expense',
      'ofw_update_expense',
      'ofw_upload_expense_pdf',
    ]);
  });
});


describe('expense tools — edge-case coverage', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
  const URL_OK = 'https://files.oaiusercontent.com/r?sig=x';

  describe('ofw_list_expenses paging fallbacks', () => {
    it('passes a non-object payload through untouched', async () => {
      setup(makeClient([{ id: 1 }]));
      const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({})).content[0].text);
      expect(parsed).toEqual([{ id: 1 }]);
    });

    it('reads metadata.page and derives hasMore from a reported total', async () => {
      setup(makeClient({ data: [{ id: 1 }], metadata: { page: 2, totalElements: 45 } }));
      const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({ page: 2 })).content[0].text);
      expect(parsed.page).toBe(2);
      expect(parsed.size).toBe(20);
      expect(parsed.total).toBe(45);
      expect(parsed.hasMore).toBe(true);
      expect(parsed.nextPage).toBe(3);
      expect(parsed.paginationNote).toMatch(/of 45/);
    });

    it('reports the total when the last page is reached', async () => {
      setup(makeClient({ data: [{ id: 1 }], metadata: { currentPage: 3, perPage: 20, totalElements: 41 } }));
      const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({ page: 3 })).content[0].text);
      expect(parsed.hasMore).toBe(false);
      expect(parsed.paginationNote).toMatch(/41 record\(s\) in total/);
    });

    it('treats a full page with no metadata as probably-more', async () => {
      setup(makeClient({ data: [{ id: 1 }, { id: 2 }], metadata: [] }));
      const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({ size: 2 })).content[0].text);
      expect(parsed.hasMore).toBe(true);
      expect(parsed.nextPage).toBe(2);
    });
  });

  describe('ofw_upload_expense_pdf', () => {
    it('requires exactly one of path or url', async () => {
      setup(makeClient({}), makeAttachmentIO());
      const h = handlers.get('ofw_upload_expense_pdf')!;
      await expect(h({})).rejects.toThrow(/exactly one of path or url/);
      await expect(h({ path: '/a.pdf', url: URL_OK })).rejects.toThrow(/exactly one of path or url/);
    });

    it('fills response fields from the local file when OFW echoes only the fileId', async () => {
      setup(makeClient({ fileId: 5 }), makeAttachmentIO());
      const parsed = JSON.parse((await callConfirmed(handlers.get('ofw_upload_expense_pdf')! as GatedHandler, { path: '/a.pdf', label: 'L', description: 'D' })).content[0].text);
      expect(parsed).toMatchObject({ fileId: 5, fileName: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 9, shareClass: 'SHARED' });
    });

    it('defaults a remote upload to receipt.pdf when no filename is given', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(PDF, { status: 200 }));
      const client = makeClient({ fileId: 6 });
      setup(client, makeAttachmentIO());
      await callConfirmed(handlers.get('ofw_upload_expense_pdf')! as GatedHandler, { url: URL_OK });
      const form = vi.mocked(client.request).mock.calls[0][2] as FormData;
      expect(form.get('fileName')).toBe('receipt.pdf');
    });

    it.each([
      ['a non-HTTPS URL', 'http://files.oaiusercontent.com/r', undefined, /must use HTTPS/],
      ['a host outside oaiusercontent.com', 'https://example.com/r.pdf', undefined, /oaiusercontent\.com/],
      ['a non-.pdf filename', URL_OK, 'receipt.png', /\.pdf filename/],
    ])('rejects %s', async (_label, url, fileName, error) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(PDF, { status: 200 }));
      const client = makeClient({});
      setup(client, makeAttachmentIO());
      await expect(handlers.get('ofw_upload_expense_pdf')!({ url, fileName })).rejects.toThrow(error);
      expect(client.request).not.toHaveBeenCalled();
    });

    it.each([
      ['an HTTP error', () => new Response('nope', { status: 403 }), /HTTP 403/],
      ['a declared length over the cap', () => new Response(PDF, { status: 200, headers: { 'content-length': String(26 * 1024 * 1024) } }), /exceeds/],
      ['a body over the cap', () => new Response(new Uint8Array(25 * 1024 * 1024 + 1), { status: 200 }), /exceeds/],
      ['bytes that are not a PDF', () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { status: 200 }), /not a valid PDF/],
      ['a body too short to be a PDF', () => new Response(new Uint8Array([0x25]), { status: 200 }), /not a valid PDF/],
    ])('rejects a remote receipt with %s', async (_label, response, error) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
      const client = makeClient({});
      setup(client, makeAttachmentIO());
      await expect(handlers.get('ofw_upload_expense_pdf')!({ url: URL_OK })).rejects.toThrow(error);
      expect(client.request).not.toHaveBeenCalled();
    });
  });

  describe('ofw_create_expense', () => {
    it('previews a private expense without the co-parent warning', async () => {
      setup(makeClient({ id: 1 }), makeAttachmentIO());
      const preview = await callPreview(handlers.get('ofw_create_expense')! as GatedHandler, {
        title: 'T', amount: 5, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203],
        privateExpense: true, receiptFileId: 77,
      });
      expect(preview.preview).toMatchObject({ visibility: 'private (only you)', receiptFileId: 77 });
      expect(preview.preview).not.toHaveProperty('warning');
    });
  });

  describe('ofw_update_expense', () => {
    const base = { expenseId: 9, title: 'T', amount: 5, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203] };

    it('sends the description and previews a private update without the co-parent warning', async () => {
      const client = makeClient({ id: 9 });
      setup(client, makeAttachmentIO());
      const h = handlers.get('ofw_update_expense')! as GatedHandler;
      const preview = await callPreview(h, { ...base, privateExpense: true, description: 'D' });
      expect(preview.preview).toMatchObject({ visibility: 'private (only you)' });
      expect(preview.preview).not.toHaveProperty('warning');
      await callConfirmed(h, { ...base, privateExpense: true, description: 'D' });
      expect(client.request).toHaveBeenCalledWith('PUT', '/pub/v2/expense/expenses/9', expect.objectContaining({ description: 'D', isPrivate: true }));
    });

    it('warns that publishing makes the expense co-parent-visible', async () => {
      setup(makeClient({ id: 9 }), makeAttachmentIO());
      const preview = await callPreview(handlers.get('ofw_update_expense')! as GatedHandler, { ...base, privateExpense: false });
      expect(preview.preview).toMatchObject({ visibility: 'shared with the co-parent' });
      expect(String(preview.preview.warning)).toMatch(/co-parent/);
    });

    it('a PUT that times out returns EXPENSE_UNCONFIRMED', async () => {
      const client = new OFWClient();
      vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API request timed out after 30000ms: PUT /pub/v2/expense/expenses/9'));
      setup(client, makeAttachmentIO());
      const result = await callConfirmed(handlers.get('ofw_update_expense')! as GatedHandler, { ...base, privateExpense: false });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.result).toBe('EXPENSE_UNCONFIRMED');
      expect(parsed.remedy).toMatch(/ofw_list_expenses/);
    });

    it('a definitive 4xx rejection is still a plain error', async () => {
      const client = new OFWClient();
      vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 400 Bad Request for PUT /pub/v2/expense/expenses/9'));
      setup(client, makeAttachmentIO());
      await expect(callConfirmed(handlers.get('ofw_update_expense')! as GatedHandler, { ...base, privateExpense: false }))
        .rejects.toThrow(/400 Bad Request/);
    });
  });

  describe('ofw_upload_expense_pdf — confirmation gate', () => {
    it('phase 1 previews the SHARED upload and uploads NOTHING', async () => {
      const client = makeClient({ fileId: 5 });
      setup(client, makeAttachmentIO());
      const preview = await callPreview(handlers.get('ofw_upload_expense_pdf')! as GatedHandler, { path: '/a.pdf' });
      expect(client.request).not.toHaveBeenCalled();
      expect(preview.preview).toMatchObject({ fileName: 'receipt.pdf', shareClass: 'SHARED', from: 'local file' });
      expect(String(preview.preview.warning)).toMatch(/co-parent/);
    });

    it('names the hosted source in the preview', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(PDF, { status: 200 }));
      setup(makeClient({ fileId: 5 }), makeAttachmentIO());
      const preview = await callPreview(handlers.get('ofw_upload_expense_pdf')! as GatedHandler, { url: URL_OK });
      expect(preview.preview.from).toBe('hosted file (files.oaiusercontent.com)');
    });

    it('refuses a token when the file content changed between preview and approval', async () => {
      const client = makeClient({ fileId: 5 });
      const io = makeAttachmentIO();
      setup(client, io);
      const handler = handlers.get('ofw_upload_expense_pdf')!;
      const { confirmToken } = await callPreview(handler as GatedHandler, { path: '/a.pdf' });
      vi.mocked(io.resolveUpload).mockResolvedValue({
        blob: new Blob(['%PDF-1.7 different'], { type: 'application/pdf' }),
        fileName: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 9,
      });
      const result = await handler({ path: '/a.pdf', confirmToken }, NO_ELICIT_CTX);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'DRAFT_CHANGED' });
      expect(client.request).not.toHaveBeenCalled();
    });

    it('declares the confirm token and the open-world hint', () => {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      const configs = new Map<string, { annotations?: Record<string, unknown>; inputSchema?: z.ZodObject; description: string }>();
      vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
        configs.set(name, config as { annotations?: Record<string, unknown>; inputSchema?: z.ZodObject; description: string });
        return undefined as never;
      });
      registerExpenseTools(server, new OFWClient(), makeAttachmentIO());
      const tool = configs.get('ofw_upload_expense_pdf')!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      expect(tool.inputSchema!.shape).toHaveProperty('confirmToken');
      expect(tool.description).toMatch(/MCP_CONFIRM_MODE/);
    });

    it('rejects a local file named .pdf whose bytes are not a PDF', async () => {
      const client = makeClient({ fileId: 5 });
      const io = makeAttachmentIO();
      vi.mocked(io.resolveUpload).mockResolvedValue({
        blob: new Blob(['GIF89a'], { type: 'application/pdf' }),
        fileName: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 6,
      });
      setup(client, io);
      await expect(handlers.get('ofw_upload_expense_pdf')!({ path: '/a.pdf' }, NO_ELICIT_CTX)).rejects.toThrow(/PDF header/);
      expect(client.request).not.toHaveBeenCalled();
    });
  });

  describe('remote receipt fetch hardening', () => {
    it('follows a redirect that stays on oaiusercontent.com, re-checking each hop', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith('https://files.oaiusercontent.com/')) {
          return new Response(null, { status: 302, headers: { location: 'https://cdn.oaiusercontent.com/blob' } });
        }
        return new Response(PDF, { status: 200 });
      });
      setup(makeClient({ fileId: 5 }), makeAttachmentIO());
      await callPreview(handlers.get('ofw_upload_expense_pdf')! as GatedHandler, { url: URL_OK });
      expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([URL_OK, 'https://cdn.oaiusercontent.com/blob']);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    });

    it('refuses a redirect that leaves the allowlist without fetching it', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }));
      const client = makeClient({});
      setup(client, makeAttachmentIO());
      await expect(handlers.get('ofw_upload_expense_pdf')!({ url: URL_OK }, NO_ELICIT_CTX)).rejects.toThrow(/oaiusercontent\.com/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(client.request).not.toHaveBeenCalled();
    });

    it('gives up after too many redirects', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(null, { status: 302, headers: { location: 'https://files.oaiusercontent.com/again' } }));
      setup(makeClient({}), makeAttachmentIO());
      await expect(handlers.get('ofw_upload_expense_pdf')!({ url: URL_OK }, NO_ELICIT_CTX)).rejects.toThrow(/redirected more than 5 times/);
    });

    it('treats a 3xx with no Location as the final (failed) response', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 304 }));
      setup(makeClient({}), makeAttachmentIO());
      await expect(handlers.get('ofw_upload_expense_pdf')!({ url: URL_OK }, NO_ELICIT_CTX)).rejects.toThrow(/HTTP 304/);
    });

    it('stops reading an undeclared-length body as soon as it passes the cap', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(chunk);
          if (pulled > 100) controller.close();
        },
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 200 }));
      setup(makeClient({}), makeAttachmentIO());
      await expect(handlers.get('ofw_upload_expense_pdf')!({ url: URL_OK }, NO_ELICIT_CTX)).rejects.toThrow(/exceeds/);
      expect(pulled).toBeLessThan(30);
    });

    it('treats a bodiless 200 as an empty (non-PDF) file', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }));
      setup(makeClient({}), makeAttachmentIO());
      await expect(handlers.get('ofw_upload_expense_pdf')!({ url: URL_OK }, NO_ELICIT_CTX)).rejects.toThrow(/not a valid PDF/);
    });
  });

  describe('expense previews name the parties', () => {
    it('create shows who the claim is billed to, the category and the children', async () => {
      setup(makeClient({ id: 1 }), makeAttachmentIO());
      const preview = await callPreview(handlers.get('ofw_create_expense')! as GatedHandler, {
        title: 'T', amount: 5, purchaseDate: '2026-09-20', categoryId: 7, payerId: 101, children: [203, 204],
      });
      expect(preview.preview).toMatchObject({ payerUserId: 101, categoryId: 7, childUserIds: [203, 204] });
    });

    it('update shows the parties, description and receipt', async () => {
      setup(makeClient({ id: 1 }), makeAttachmentIO());
      const preview = await callPreview(handlers.get('ofw_update_expense')! as GatedHandler, {
        expenseId: 9, title: 'T', amount: 5, purchaseDate: '2026-09-20', categoryId: 7, payerId: 101, children: [203],
        description: 'D', receiptFileId: 77, privateExpense: false,
      });
      expect(preview.preview).toMatchObject({ payerUserId: 101, categoryId: 7, childUserIds: [203], description: 'D', receiptFileId: 77 });
    });
  });
});
