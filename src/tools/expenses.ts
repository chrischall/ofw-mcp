import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { jsonResponse, requestWrite, UnconfirmedWriteError, unconfirmedWriteResponse } from './_shared.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite } from './_confirm.js';
import { offsetState, readUpstreamPaging, withPaginationFirst } from './pagination.js';
import { getWriteMode } from '../config.js';

export function registerExpenseTools(server: McpServer, client: OFWClient): void {
  // Expense writes land on the court-visible record — OFW_WRITE_MODE 'all' only.
  const allowWrites = getWriteMode() === 'all';

  server.registerTool('ofw_get_expense_totals', {
    description: 'Get OurFamilyWizard expense summary totals (owed/paid)',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/expense/expenses/totals');
    return jsonResponse(data);
  });

  server.registerTool('ofw_list_expenses', {
    description: 'List OurFamilyWizard expenses. Offset-paged via start/max. The response leads with its paging state — `hasMore` and `nextStart` (null when the list is exhausted) — BEFORE the records, so a truncated or partially-read response still says whether more remain. Never state an expense total or an absence from one page.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      start: z.number().int().min(0).describe('Start offset, 0-based (default 0). To continue a listing, pass the `nextStart` from the previous response.').optional(),
      max: z.number().int().min(1).describe('Max results (default 20)').optional(),
    }),
  }, async (args) => {
    const start = args.start ?? 0;
    const max = args.max ?? 20;
    const data = await client.request('GET', `/pub/v2/expense/expenses?start=${start}&max=${max}`);
    // Paging state FIRST, records after — a partial read of a spilled response
    // must reach "there are more" before it reaches the records. See
    // src/tools/pagination.ts for why the order is load-bearing.
    //
    // OFW wraps these listings as {data, metadata} and its metadata carries a
    // `last` boolean, so "is there another page" is answered by the server
    // rather than inferred from a full page (verified live).
    const { returned, total, last } = readUpstreamPaging(data);
    const wrapped = withPaginationFirst({
      state: offsetState({ start, max, returned, total, last, base: 0 }),
      start, max, returned, total,
      hint: `Re-call ofw_list_expenses with start:${start + max}.`,
      payload: data,
    });
    // A payload that is not a plain object cannot carry the paging keys at all.
    // Pass it through untouched rather than relocating it — an added field is
    // never worth changing a response's top-level shape.
    return jsonResponse(wrapped ?? data);
  });

  if (allowWrites) server.registerTool('ofw_create_expense', {
    description: 'Log a new expense in OurFamilyWizard. The expense is a money claim that appears in the shared ledger in front of the co-parent immediately, and this server cannot delete it. If the request fails without a definitive answer the result is EXPENSE_UNCONFIRMED: the expense may already exist, so do NOT retry until ofw_list_expenses shows it did not land. ' + CONFIRM_NOTE,
    // Not a harmless local write: the claim is co-parent-visible at once and
    // this server has no way to take it back. destructiveHint keeps a host
    // that auto-approves "non-destructive" tools from running it silently.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: z.object({
      amount: z.number().describe('Expense amount'),
      description: z.string().describe('Expense description'),
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const { confirmToken, ...payload } = args;
    const gate = await confirmWrite(ctx, {
      tool: 'ofw_create_expense',
      action: 'ofw.expense.create',
      message: 'Review and confirm this OurFamilyWizard expense. It is logged in the shared ledger the co-parent sees immediately, and cannot be deleted through this server.',
      target: 'expense:new',
      payload,
      preview: {
        action: 'Log OurFamilyWizard expense',
        amount: payload.amount,
        description: payload.description,
        warning: 'Visible to the co-parent immediately as a claim in the shared expense ledger; part of the court-visible record.',
      },
      confirmToken,
    });
    if (gate) return gate;
    let data: unknown;
    try {
      data = await requestWrite(client, 'POST', '/pub/v2/expense/expenses', payload);
    } catch (e) {
      if (!(e instanceof UnconfirmedWriteError)) throw e;
      return unconfirmedWriteResponse(e, {
        result: 'EXPENSE_UNCONFIRMED',
        what: 'log this expense',
        checkWith: 'ofw_list_expenses (look for this amount and description among the newest expenses)',
      });
    }
    return jsonResponse(data);
  });
}
