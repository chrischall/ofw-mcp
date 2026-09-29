import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { MAX_UPLOAD_BYTES, type AttachmentIO } from './attachments.js';
import { jsonResponse, requestWrite, UnconfirmedWriteError, unconfirmedWriteResponse } from './_shared.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';
import { readUpstreamPaging } from './pagination.js';
import { getExpenseUploadOnly, getWriteMode } from '../config.js';
import { parseLenient } from '@chrischall/mcp-utils';

const UploadedExpenseFileSchema = z.looseObject({
  fileId: z.number(),
  fileName: z.string().optional(),
  label: z.string().optional(),
  fileType: z.string().optional(),
  sizeInBytes: z.number().optional(),
  shareClass: z.string().optional(),
});

const PDF_MIME = 'application/pdf';
const MAX_REMOTE_PDF_BYTES = MAX_UPLOAD_BYTES;
const MAX_REMOTE_REDIRECTS = 5;
const REMOTE_FETCH_TIMEOUT_MS = 30_000;

/** `%PDF-` — the one check that holds whatever the name or Content-Type claim. */
function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/**
 * The remote-receipt allowlist, applied to EVERY hop. Following redirects
 * automatically would let the first (allowlisted) hop hand the request to any
 * host at all — including one on the machine's own network — so each Location
 * is re-checked before it is fetched.
 */
function assertReceiptUrl(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new Error('Remote expense receipt URLs must use HTTPS.');
  }
  if (!url.hostname.toLowerCase().endsWith('.oaiusercontent.com')) {
    throw new Error('Remote expense receipt URLs must be signed oaiusercontent.com file URLs.');
  }
}

/**
 * Read a response body, refusing as soon as it passes `cap` — a missing or
 * understated Content-Length must not let the whole body into memory before
 * the size check runs.
 */
async function readCapped(response: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new Error(`Expense receipt exceeds ${cap} bytes.`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > cap) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function resolveRemotePdf(urlValue: string, fileNameValue?: string): Promise<{
  blob: Blob;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}> {
  const fileName = fileNameValue?.trim() || 'receipt.pdf';
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    throw new Error(`Expense receipts must use a .pdf filename; received ${fileName}`);
  }

  let url = new URL(urlValue);
  let response: Response | undefined;
  for (let hop = 0; ; hop++) {
    assertReceiptUrl(url);
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) break;
    if (hop >= MAX_REMOTE_REDIRECTS) {
      throw new Error(`Remote expense receipt redirected more than ${MAX_REMOTE_REDIRECTS} times.`);
    }
    url = new URL(location, url);
  }
  if (!response.ok) {
    throw new Error(`Unable to fetch remote expense receipt: HTTP ${response.status}`);
  }

  const bytes = await readCapped(response, MAX_REMOTE_PDF_BYTES);
  if (!isPdf(bytes)) {
    throw new Error('Remote expense receipt is not a valid PDF file.');
  }

  return {
    blob: new Blob([bytes], { type: PDF_MIME }),
    fileName,
    mimeType: PDF_MIME,
    sizeBytes: bytes.byteLength,
  };
}

/**
 * Who a claim is against and what it is for, for a confirm preview. A person
 * approving a money claim has to see who it is billed to; these are OFW ids
 * this server has no names for, so they are labelled as ids rather than
 * dressed up as names.
 */
function expenseParties(args: { payerId: number; categoryId: number; children: number[] }): Record<string, unknown> {
  return {
    payerUserId: args.payerId,
    categoryId: args.categoryId,
    childUserIds: args.children,
    idsNote: 'payerUserId is the parent this claim is billed to; confirm it names the right parent before approving (ofw_get_profile, where registered, or the OFW web app). categoryId is from ofw_list_expense_categories.',
  };
}

export function registerExpenseTools(
  server: McpServer,
  client: OFWClient,
  attachmentIO?: AttachmentIO,
): void {
  // Expense writes land on the court-visible record — OFW_WRITE_MODE 'all' only.
  const writeMode = getWriteMode();
  const uploadOnly = getExpenseUploadOnly();
  // Where a caller checks whether an ambiguous write landed. Upload-only mode
  // does not register ofw_list_expenses, and naming a tool the caller cannot
  // call leaves it guessing — a guessed retry logs a duplicate money claim in
  // front of the co-parent. So that mode names the web app instead.
  const checkIn = uploadOnly
    ? 'the Expenses log on ourfamilywizard.com (ofw_list_expenses is not available in this deployment)'
    : 'ofw_list_expenses';
  const allowWrites = writeMode === 'all';
  // The receipt is uploaded SHARED (the only share class OFW accepts in an
  // expense's fileIds), and a SHARED My Files entry is co-parent-visible at
  // once — so, like ofw_upload_attachment's SHARED path, it needs mode 'all'.
  const allowReceiptUploads = allowWrites && attachmentIO !== undefined;

  if (!uploadOnly) server.registerTool('ofw_get_expense_totals', {
    description: 'Get OurFamilyWizard expense summary totals (owed/paid)',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/expense/expenses/totals');
    return jsonResponse(data);
  });

  if (!uploadOnly) server.registerTool('ofw_list_expense_categories', {
    description: 'List OurFamilyWizard expense categories, including preset and custom categories with their responsibility split metadata. Read-only.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/expense/categories');
    return jsonResponse(data);
  });

  if (!uploadOnly) server.registerTool('ofw_list_expenses', {
    description: 'List OurFamilyWizard expenses. OFW pages this endpoint with 1-based page/size parameters; its older start/max parameters are ignored and repeatedly return page 1. The response leads with hasMore and nextPage (null when exhausted) before the records. Continue by passing nextPage.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      page: z.number().int().min(1).describe('1-based page number (default 1). To continue, pass the nextPage returned by the previous response.').optional(),
      size: z.number().int().min(1).max(100).describe('Requested page size (default 20). OFW may cap or normalize this value.').optional(),
    }),
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 20;
    const data = await client.request('GET', `/pub/v2/expense/expenses?page=${page}&size=${size}`);
    const { returned, total, last } = readUpstreamPaging(data);

    const body = typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    if (body === null) return jsonResponse(data);

    const metadata = typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : null;
    const upstreamPage = metadata !== null && typeof metadata.currentPage === 'number'
      ? metadata.currentPage
      : metadata !== null && typeof metadata.page === 'number'
        ? metadata.page
        : page;
    const upstreamSize = metadata !== null && typeof metadata.perPage === 'number'
      ? metadata.perPage
      : size;
    const hasMore = last !== null
      ? !last
      : total !== null
        ? upstreamPage * upstreamSize < total
        : returned >= upstreamSize;
    const nextPage = hasMore ? upstreamPage + 1 : null;
    const scope = total !== null ? ` of ${total}` : '';
    const head = {
      hasMore,
      nextPage,
      page: upstreamPage,
      size: upstreamSize,
      returned,
      ...(total !== null ? { total } : {}),
      paginationNote: hasMore
        ? `PARTIAL: this response holds ${returned} record(s) on page ${upstreamPage}${scope}. Re-call ofw_list_expenses with page:${nextPage}. Do not state a total or an absence from this response alone.`
        : `This response reaches the end of the expense list${scope === '' ? '' : ` (${total} record(s) in total)`}.`,
    };

    return jsonResponse({ ...head, ...body, ...head });
  });

  if (allowReceiptUploads) server.registerTool('ofw_upload_expense_pdf', {
    description: 'Upload a PDF to OurFamilyWizard My Files for later attachment to an expense. Accepts either a local path or a signed ChatGPT/oaiusercontent HTTPS URL plus fileName. Exactly one of path or url must be supplied. This tool accepts PDF files only and uploads them using the same SHARED file metadata as the OFW expense form so the returned fileId can be attached to an expense. A SHARED file is visible to the co-parent in My Files immediately, whatever the visibility of the expense it is later attached to (that is set separately by ofw_create_expense privateExpense). ' + CONFIRM_NOTE,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().describe('Path to a local PDF file inside the upload directory (OFW_UPLOAD_DIR). Tilde (~) is expanded by the configured attachment I/O implementation. Mutually exclusive with url.').optional(),
      url: z.string().describe('Signed HTTPS oaiusercontent.com URL for a PDF supplied by the ChatGPT host. Mutually exclusive with path.').optional(),
      fileName: z.string().describe('Filename to use for a remote URL upload. Must end in .pdf. Defaults to receipt.pdf.').optional(),
      label: z.string().describe('Display label for the file in OFW (default: filename)').optional(),
      description: z.string().describe('Description shown in OFW My Files (default: filename)').optional(),
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const io = attachmentIO!;
    if ((args.path ? 1 : 0) + (args.url ? 1 : 0) !== 1) {
      throw new Error('Pass exactly one of path or url to ofw_upload_expense_pdf.');
    }

    const { blob, fileName, mimeType, sizeBytes } = args.url
      ? await resolveRemotePdf(args.url, args.fileName)
      : await io.resolveUpload(args.path!);
    if (!fileName.toLowerCase().endsWith('.pdf') || mimeType !== PDF_MIME) {
      throw new Error(`Expense receipts must be PDF files; received ${fileName} (${mimeType})`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The name and type say PDF; the bytes have to agree. The remote path
    // already checked, but a local file is only as honest as its extension.
    if (!isPdf(bytes)) {
      throw new Error(`Expense receipts must be PDF files; ${fileName} does not start with a PDF header.`);
    }

    // The upload is SHARED — in front of the co-parent in My Files at once,
    // with no later step to review it in — so it is confirmed first, exactly
    // like ofw_upload_attachment's SHARED path. The token binds a SHA-256 of
    // the bytes: a file (or signed URL) whose content changed between preview
    // and approval is refused, not shared unseen.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    const label = args.label ?? fileName;
    const description = args.description ?? fileName;
    const gate = await confirmWrite(ctx, {
      tool: 'ofw_upload_expense_pdf',
      action: 'ofw.file.share',
      message: `Review and confirm uploading the receipt "${fileName}" to OurFamilyWizard. It is uploaded SHARED, so the co-parent can see it in My Files immediately — even if the expense it is attached to is private.`,
      target: `file:${fileName}`,
      payload: { fileName, sizeBytes, sha256, label, description, shareClass: 'SHARED', source: 'expense' },
      preview: {
        action: 'Upload and SHARE an expense receipt on OurFamilyWizard',
        fileName, sizeBytes, mimeType, label, description, shareClass: 'SHARED',
        from: args.url ? `hosted file (${new URL(args.url).hostname})` : 'local file',
        warning: 'Visible to the co-parent immediately in My Files, whatever the visibility of the expense it is attached to; the file becomes part of the court-visible record.',
      },
      confirmToken: args.confirmToken,
    });
    if (gate) return gate;

    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('source', 'expense');
    form.append('description', args.description ?? fileName);
    form.append('label', args.label ?? fileName);
    form.append('fileName', fileName);
    // Match the OFW expense form upload contract. The attachment itself is
    // uploaded as SHARED so it is eligible for fileIds on an expense. Expense
    // visibility is controlled separately by the expense's isPrivate flag.
    form.append('shared', 'true');
    form.append('shareClass', 'SHARED');

    const meta = parseLenient(
      UploadedExpenseFileSchema,
      await client.request('POST', '/pub/v3/myfiles/multipart', form),
      { label: 'ofw-mcp', context: 'POST /pub/v3/myfiles/multipart (ofw_upload_expense_pdf)', mode: 'strict' },
    );

    return jsonResponse({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      mimeType: meta.fileType ?? mimeType,
      sizeBytes: meta.sizeInBytes ?? sizeBytes,
      shareClass: meta.shareClass ?? 'SHARED',
      note: 'Pass fileId to ofw_create_expense as receiptFileId. Expense visibility is controlled separately by privateExpense.',
    });
  });

  if (allowWrites) server.registerTool('ofw_update_expense', {
    description: `Update an existing OurFamilyWizard expense using the current web-app full-resource update contract. Supply the complete current expense fields plus expenseId. Set privateExpense=false to publish a previously private/staged expense to the co-parent. This is a full update, not a partial patch. If the request fails without a definitive answer the result is EXPENSE_UNCONFIRMED: the update may already have been applied, so check ${checkIn} before retrying. ` + CONFIRM_NOTE,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: z.object({
      expenseId: z.number().int().positive().describe('Existing OFW expense entity id'),
      title: z.string().trim().min(1).describe('Current expense title/name shown in OFW'),
      amount: z.number().positive().describe('Current full expense amount'),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Current expense date, YYYY-MM-DD'),
      categoryId: z.number().int().positive().describe('Current OFW expense category id'),
      payerId: z.number().int().positive().describe('Current OFW payer/reimbursing parent userId'),
      children: z.array(z.number().int().positive()).min(1).describe('Current OFW child userIds associated with the expense'),
      description: z.string().trim().min(1).describe('Current supporting description/details, when present').optional(),
      privateExpense: z.boolean().describe('true = visible only to you; false = shared with co-parent'),
      receiptFileId: z.number().int().positive().describe('Current single OFW receipt fileId, when present').optional(),
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const payload: Record<string, unknown> = {
      title: args.title,
      amount: args.amount,
      purchaseDate: args.purchaseDate,
      categoryId: args.categoryId,
      payerId: args.payerId,
      children: args.children,
      isPrivate: args.privateExpense,
    };

    if (args.description !== undefined) payload.description = args.description;
    if (args.receiptFileId !== undefined) payload.fileIds = [args.receiptFileId];

    const gate = await confirmWrite(ctx, {
      tool: 'ofw_update_expense',
      action: 'ofw.expense.update',
      message: args.privateExpense
        ? 'Review and confirm this update to a private OurFamilyWizard expense.'
        : 'Review and confirm this OurFamilyWizard expense update. The expense will be SHARED: it appears in the ledger the co-parent sees immediately, and cannot be deleted through this server.',
      target: `expense:${args.expenseId}`,
      payload,
      preview: {
        action: args.privateExpense ? 'Update private OurFamilyWizard expense' : 'Update shared OurFamilyWizard expense',
        expenseId: args.expenseId,
        title: args.title,
        amount: args.amount,
        purchaseDate: args.purchaseDate,
        ...expenseParties(args),
        ...(args.description !== undefined ? { description: args.description } : {}),
        visibility: args.privateExpense ? 'private (only you)' : 'shared with the co-parent',
        ...(args.receiptFileId !== undefined ? { receiptFileId: args.receiptFileId } : {}),
        ...(args.privateExpense ? {} : { warning: 'Visible to the co-parent immediately as a claim in the shared expense ledger; part of the court-visible record.' }),
      },
      confirmToken: args.confirmToken,
    });
    if (gate) return gate;
    let data: unknown;
    try {
      data = await requestWrite(client, 'PUT', `/pub/v2/expense/expenses/${args.expenseId}`, payload);
    } catch (e) {
      if (!(e instanceof UnconfirmedWriteError)) throw e;
      return unconfirmedWriteResponse(e, {
        result: 'EXPENSE_UNCONFIRMED',
        what: `update expense ${args.expenseId}`,
        checkWith: `${checkIn} (compare this expense against the values you sent)`,
      });
    }
    return jsonResponse(data);
  });

  if (allowWrites) server.registerTool('ofw_create_expense', {
    description: `Log a new expense in OurFamilyWizard using the current web-app expense contract. Required fields are title, amount, purchaseDate, categoryId, payerId (the parent who owes), and at least one child user id. Supports one previously-uploaded receipt PDF and private entries. privateExpense=true creates an expense visible only to you; false/default creates the normal shared expense. receiptFileId should come from ofw_upload_expense_pdf. A shared expense is a money claim that appears in the ledger in front of the co-parent immediately, and this server cannot delete it. If the request fails without a definitive answer the result is EXPENSE_UNCONFIRMED: the expense may already exist, so do NOT retry until ${checkIn} shows it did not land. ` + CONFIRM_NOTE,
    // Not a harmless local write: a shared claim is co-parent-visible at once
    // and this server has no way to take it back. destructiveHint keeps a host
    // that auto-approves "non-destructive" tools from running it silently.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: z.object({
      title: z.string().trim().min(1).describe('Expense title/name shown in the OFW expense log'),
      amount: z.number().positive().describe('Full expense amount before OFW applies the category split'),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date the expense was incurred, YYYY-MM-DD'),
      categoryId: z.number().int().positive().describe('OFW expense category id (for example General is commonly id 1; use the id from OFW, not the category display name)'),
      payerId: z.number().int().positive().describe('OFW userId of the parent who owes/reimburses this expense'),
      children: z.array(z.number().int().positive()).min(1).describe('One or more OFW child userIds associated with the expense'),
      description: z.string().trim().min(1).describe('Optional supporting description/details for the expense').optional(),
      privateExpense: z.boolean().describe('true = visible only to you; false/default = shared with co-parent').optional(),
      receiptFileId: z.number().int().positive().describe('Single OFW My Files fileId to attach as the receipt, normally returned by ofw_upload_expense_pdf').optional(),
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const payload: Record<string, unknown> = {
      title: args.title,
      amount: args.amount,
      purchaseDate: args.purchaseDate,
      categoryId: args.categoryId,
      payerId: args.payerId,
      children: args.children,
    };

    if (args.description !== undefined) payload.description = args.description;

    // OFW's web app sends isPrivate directly.
    if (args.privateExpense !== undefined) payload.isPrivate = args.privateExpense;

    // OFW's web app sends attachments as a fileIds array. Keep the MCP-facing
    // argument singular so callers still attach at most one canonical receipt.
    if (args.receiptFileId !== undefined) payload.fileIds = [args.receiptFileId];

    const isPrivate = args.privateExpense === true;
    const gate = await confirmWrite(ctx, {
      tool: 'ofw_create_expense',
      action: 'ofw.expense.create',
      message: isPrivate
        ? 'Review and confirm this private OurFamilyWizard expense (visible only to you).'
        : 'Review and confirm this OurFamilyWizard expense. It is logged in the shared ledger the co-parent sees immediately, and cannot be deleted through this server.',
      target: 'expense:new',
      payload,
      preview: {
        action: isPrivate ? 'Log private OurFamilyWizard expense' : 'Log OurFamilyWizard expense',
        title: args.title,
        amount: args.amount,
        purchaseDate: args.purchaseDate,
        ...expenseParties(args),
        ...(args.description !== undefined ? { description: args.description } : {}),
        visibility: isPrivate ? 'private (only you)' : 'shared with the co-parent',
        ...(args.receiptFileId !== undefined ? { receiptFileId: args.receiptFileId } : {}),
        ...(isPrivate ? {} : { warning: 'Visible to the co-parent immediately as a claim in the shared expense ledger; part of the court-visible record.' }),
      },
      confirmToken: args.confirmToken,
    });
    if (gate) return gate;
    let data: unknown;
    try {
      data = await requestWrite(client, 'POST', '/pub/v2/expense', payload);
    } catch (e) {
      if (!(e instanceof UnconfirmedWriteError)) throw e;
      return unconfirmedWriteResponse(e, {
        result: 'EXPENSE_UNCONFIRMED',
        what: 'log this expense',
        checkWith: `${checkIn} (look for this title and amount among the newest expenses)`,
      });
    }
    return jsonResponse(data);
  });
}
