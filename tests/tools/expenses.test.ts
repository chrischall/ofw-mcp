import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { readExpenseState, registerExpenseTools } from '../../src/tools/expenses.js';
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
    writeDownload: async () => undefined,
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
    // checkWith names a tool, so the web app is still offered as the fallback.
    expect(parsed.remedy).toMatch(/\(or on ourfamilywizard\.com\)/);
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

  // ofw_list_expenses is not registered here, so recovery guidance that names
  // it leaves the caller no way to check — and a guessed retry logs a
  // duplicate claim. It must point at the web app instead.
  const timeout = () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API request timed out after 30000ms'));
    return client;
  };
  const base = { title: 'T', amount: 50, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203] };

  it.each([
    ['ofw_create_expense', base],
    ['ofw_update_expense', { ...base, expenseId: 9, privateExpense: true, description: null, receiptFileId: null }],
  ])('%s EXPENSE_UNCONFIRMED points at the web app, not the unregistered list tool', async (tool, args) => {
    setup(timeout(), makeAttachmentIO());
    const result = await callConfirmed(handlers.get(tool)! as GatedHandler, args);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBe('EXPENSE_UNCONFIRMED');
    expect(parsed.remedy).toMatch(/ourfamilywizard\.com/);
    expect(parsed.remedy).toMatch(/ofw_list_expenses is not available/);
    // checkWith already points at the web app; the fallback must not repeat it.
    expect(parsed.remedy.match(/ourfamilywizard\.com/g)).toHaveLength(1);
  });

  it('tool descriptions name the web app as the place to check', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const descriptions = new Map<string, string>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
      descriptions.set(name, (config as { description: string }).description);
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient(), makeAttachmentIO());
    for (const tool of ['ofw_create_expense', 'ofw_update_expense']) {
      expect(descriptions.get(tool)).toMatch(/Expenses log on ourfamilywizard\.com \(ofw_list_expenses is not available/);
    }
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

  });
});

describe('ofw_update_expense — read, merge, write (never erase an omitted field)', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  // A private expense with a description and TWO receipts, in OFW's nested
  // read shape. Every one of those is what a full PUT from caller args alone
  // would have erased.
  const NESTED = {
    data: {
      id: 9001,
      title: 'Copay',
      amount: '35.87',
      purchaseDate: { dateTime: '2026-09-09T00:00:00' },
      category: { id: 304873, title: 'Medical' },
      payer: { userId: 101, name: 'Parent B' },
      children: [{ userId: 203, name: 'Child' }],
      isPrivate: true,
      description: 'Follow-up visit',
      files: [{ fileId: 7001 }, { fileId: 7002 }],
    },
  };

  /**
   * A client whose GET serves `state.detail` (an Error rejects) and whose PUT
   * records the payload. `state.readback`, when set, is what the post-PUT
   * GET sees instead.
   */
  function routed(state: { detail: unknown; readback?: unknown; put?: unknown }) {
    const client = new OFWClient();
    let putDone = false;
    vi.spyOn(client, 'request').mockImplementation(async (method: string) => {
      if (method === 'PUT') {
        if (state.put instanceof Error) throw state.put;
        putDone = true;
        return state.put ?? { id: 9001 };
      }
      const value = putDone && 'readback' in state ? state.readback : state.detail;
      if (value instanceof Error) throw value;
      return value;
    });
    return client;
  }
  const puts = (c: OFWClient) => vi.mocked(c.request).mock.calls.filter((call) => call[0] === 'PUT');
  const update = () => handlers.get('ofw_update_expense')! as GatedHandler;

  it('publishing sends only the change and keeps every other field as OFW has it', async () => {
    const client = routed({ detail: NESTED, readback: { data: { ...NESTED.data, isPrivate: false } } });
    setup(client, makeAttachmentIO());
    const result = await callConfirmed(update(), { expenseId: 9001, privateExpense: false });
    expect(puts(client)).toEqual([['PUT', '/pub/v2/expense/expenses/9001', {
      title: 'Copay',
      amount: 35.87,
      purchaseDate: '2026-09-09',
      categoryId: 304873,
      payerId: 101,
      children: [203],
      isPrivate: false,
      description: 'Follow-up visit',
      fileIds: [7001, 7002],
    }]]);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ result: 'EXPENSE_UPDATED', expenseId: 9001, changed: ['privateExpense'] });
    expect(parsed.kept).toEqual(['title', 'amount', 'purchaseDate', 'categoryId', 'payerId', 'children', 'description', 'receiptFileId']);
    expect(parsed).not.toHaveProperty('warnings');
  });

  it('previews the change as from → to, the full result, and the co-parent warning when shared', async () => {
    setup(routed({ detail: NESTED }), makeAttachmentIO());
    const preview = await callPreview(update(), { expenseId: 9001, privateExpense: false });
    expect(preview.preview).toMatchObject({
      action: 'Update shared OurFamilyWizard expense',
      changes: { privateExpense: { from: true, to: false } },
      after: { title: 'Copay', amount: 35.87, payerUserId: 101, description: 'Follow-up visit', receiptFileIds: [7001, 7002], visibility: 'shared with the co-parent' },
    });
    expect(String(preview.preview.warning)).toMatch(/co-parent/);
    expect(preview.preview).not.toHaveProperty('baseNote');
  });

  it('an update that stays private carries no co-parent warning, and an unchanged value is not listed as a change', async () => {
    setup(routed({ detail: NESTED }), makeAttachmentIO());
    const preview = await callPreview(update(), { expenseId: 9001, amount: 40, title: 'Copay' });
    expect(preview.preview.changes).toEqual({ amount: { from: 35.87, to: 40 } });
    expect(preview.preview).not.toHaveProperty('warning');
  });

  it('reads the flat write-vocabulary shape too; no description and no receipt stay omitted', async () => {
    const client = routed({ detail: {
      title: 'Lunch', amount: 12, purchaseDate: '2026-09-01', categoryId: 1, payerId: 101,
      children: [203, 204], private: false, description: null, fileIds: [],
    } });
    setup(client, makeAttachmentIO());
    await callConfirmed(update(), { expenseId: 5, amount: 15 });
    expect(puts(client)[0][2]).toEqual({
      title: 'Lunch', amount: 15, purchaseDate: '2026-09-01', categoryId: 1, payerId: 101, children: [203, 204], isPrivate: false,
    });
  });

  it('receiptFileId replaces every current receipt; null removes them and description:null removes it', async () => {
    const client = routed({ detail: NESTED });
    setup(client, makeAttachmentIO());
    await callConfirmed(update(), { expenseId: 9001, receiptFileId: 8000 });
    expect(puts(client)[0][2]).toMatchObject({ fileIds: [8000] });

    vi.mocked(client.request).mockClear();
    await callConfirmed(update(), { expenseId: 9001, receiptFileId: null, description: null });
    const sent = puts(client)[0][2] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('fileIds');
    expect(sent).not.toHaveProperty('description');
  });

  it('refuses, naming the fields, when an omitted field cannot be read back — and sends nothing', async () => {
    const { description: _d, files: _f, ...rest } = NESTED.data;
    const client = routed({ detail: rest });
    setup(client, makeAttachmentIO());
    const result = await update()({ expenseId: 9001, privateExpense: false }, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ result: 'EXPENSE_FIELDS_UNREADABLE', expenseId: 9001, missing: ['description', 'receiptFileId'] });
    expect(parsed.reason).toMatch(/did not include a readable value/);
    expect(parsed.remedy).toMatch(/erase/);
    expect(puts(client)).toEqual([]);

    // Supplying them (here: "none") unblocks it.
    await callConfirmed(update(), { expenseId: 9001, privateExpense: false, description: null, receiptFileId: null });
    expect(puts(client)).toHaveLength(1);
  });

  it('a failed read is never a blind write: every omitted field is refused, with the read error', async () => {
    const client = routed({ detail: new Error('OFW API error: 404 Not Found for GET /pub/v2/expense/expenses/9001') });
    setup(client, makeAttachmentIO());
    const parsed = JSON.parse((await update()({ expenseId: 9001, privateExpense: false }, NO_ELICIT_CTX)).content[0].text);
    expect(parsed.result).toBe('EXPENSE_FIELDS_UNREADABLE');
    expect(parsed.missing).toEqual(['title', 'amount', 'purchaseDate', 'categoryId', 'payerId', 'children', 'description', 'receiptFileId']);
    expect(parsed.reason).toMatch(/404 Not Found/);
    expect(puts(client)).toEqual([]);
  });

  it('with the read failing, a call that supplies every field still goes through and says nothing was carried over', async () => {
    const client = routed({ detail: new Error('boom'), readback: new Error('still down') });
    setup(client, makeAttachmentIO());
    const all = {
      expenseId: 9001, title: 'T', amount: 5, purchaseDate: '2026-09-20', categoryId: 1, payerId: 101, children: [203],
      privateExpense: true, description: 'D', receiptFileId: 7001,
    };
    const preview = await callPreview(update(), all);
    expect(String(preview.preview.baseNote)).toMatch(/could not be read.*boom/);
    expect((preview.preview.changes as Record<string, { from: unknown }>).title.from).toBe('unknown (not readable from OFW)');
    const result = await callConfirmed(update(), all);
    expect(puts(client)).toHaveLength(1);
    expect(JSON.parse(result.content[0].text).warnings).toEqual([expect.stringMatching(/could not be read back.*still down/)]);
  });

  it('a stringly-typed non-Error read failure is reported too', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue('socket hang up');
    setup(client, makeAttachmentIO());
    const parsed = JSON.parse((await update()({ expenseId: 1, title: 'T' }, NO_ELICIT_CTX)).content[0].text);
    expect(parsed.reason).toMatch(/socket hang up/);
  });

  it('refuses a call that changes nothing', async () => {
    const client = routed({ detail: NESTED });
    setup(client, makeAttachmentIO());
    const result = await update()({ expenseId: 9001 }, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).result).toBe('NO_CHANGES');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('refuses a call whose fields all equal what OFW already holds, before any confirmation or PUT', async () => {
    const client = routed({ detail: NESTED });
    setup(client, makeAttachmentIO());
    // Already private; same amount; same receipts in the same order.
    const result = await update()({ expenseId: 9001, privateExpense: true, amount: 35.87, title: 'Copay' }, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ result: 'NO_CHANGES', expenseId: 9001 });
    expect(parsed.remedy).toMatch(/already has that value/);
    expect(puts(client)).toEqual([]);
  });

  it('a token minted before the expense changed on OFW is refused, not applied over that change', async () => {
    const state = { detail: NESTED as unknown };
    const client = routed(state);
    setup(client, makeAttachmentIO());
    const { confirmToken } = await callPreview(update(), { expenseId: 9001, privateExpense: false });
    state.detail = { data: { ...NESTED.data, amount: 99 } };
    const result = await update()({ expenseId: 9001, privateExpense: false, confirmToken }, NO_ELICIT_CTX);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'DRAFT_CHANGED' });
    expect(puts(client)).toEqual([]);
  });

  it('reports any field OFW reads back differently from what was sent', async () => {
    const client = routed({ detail: NESTED, readback: { data: { ...NESTED.data, isPrivate: false, files: [] } } });
    setup(client, makeAttachmentIO());
    const parsed = JSON.parse((await callConfirmed(update(), { expenseId: 9001, privateExpense: false })).content[0].text);
    expect(parsed.warnings).toEqual([expect.stringMatching(/receiptFileId as \[\] after the update, not the \[7001,7002\]/)]);
  });

  it('a non-Error readback failure still becomes a warning', async () => {
    const client = routed({ detail: NESTED });
    let n = 0;
    const real = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation(async (method: string, ...rest: unknown[]) => {
      if (method === 'GET' && ++n === 3) throw 'gone';
      return (real as (...a: unknown[]) => Promise<unknown>)(method, ...rest);
    });
    setup(client, makeAttachmentIO());
    const parsed = JSON.parse((await callConfirmed(update(), { expenseId: 9001, amount: 1 })).content[0].text);
    expect(parsed.warnings).toEqual([expect.stringMatching(/could not be read back to verify it \(gone\)/)]);
  });

  it('a PUT that times out is EXPENSE_UNCONFIRMED; a definitive 4xx is a plain error', async () => {
    const client = routed({ detail: NESTED, put: new Error('OFW API request timed out after 30000ms: PUT /pub/v2/expense/expenses/9001') });
    setup(client, makeAttachmentIO());
    const parsed = JSON.parse((await callConfirmed(update(), { expenseId: 9001, privateExpense: false })).content[0].text);
    expect(parsed).toMatchObject({ result: 'EXPENSE_UNCONFIRMED', mayHaveLanded: true });
    expect(parsed.remedy).toMatch(/ofw_list_expenses/);

    setup(routed({ detail: NESTED, put: new Error('OFW API error: 400 Bad Request for PUT /pub/v2/expense/expenses/9001') }), makeAttachmentIO());
    await expect(callConfirmed(update(), { expenseId: 9001, privateExpense: false })).rejects.toThrow(/400 Bad Request/);
  });

  it('requires only expenseId; accepts null to clear description and receipt', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodObject; description: string }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodObject; description: string });
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient(), makeAttachmentIO());
    const tool = configs.get('ofw_update_expense')!;
    expect(tool.inputSchema!.safeParse({ expenseId: 1 }).success).toBe(true);
    expect(tool.inputSchema!.safeParse({ expenseId: 1, description: null, receiptFileId: null }).success).toBe(true);
    expect(tool.inputSchema!.safeParse({ title: 'T' }).success).toBe(false);
    expect(tool.description).toMatch(/every field you omit keeps its current value/);
  });
});

describe('readExpenseState', () => {
  it('reads nothing from a non-object', () => {
    expect(readExpenseState(null)).toEqual({});
    expect(readExpenseState([1])).toEqual({});
  });

  it('leaves unrecognised values unknown rather than empty', () => {
    expect(readExpenseState({
      title: '  ', amount: 'abc', purchaseDate: 'soon', categoryId: 0, category: 'x', payerId: -1, payer: { name: 'n' },
      children: [], isPrivate: 'yes', description: 42, fileIds: 'x', files: [{ fileId: 1 }],
    })).toEqual({});
  });

  it('treats a child list with an unreadable entry as unknown', () => {
    expect(readExpenseState({ children: [203, { name: 'no id' }] })).toEqual({});
  });

  it('reads ids given as {id}, a null file list as none, and an empty description as none', () => {
    expect(readExpenseState({ payer: { id: 7 }, children: [{ id: 8 }], files: null, description: '' }))
      .toEqual({ payerId: 7, children: [8], fileIds: [], description: null });
  });
});
