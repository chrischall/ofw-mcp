import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { jsonResponse } from './_shared.js';
import { findRecordArray, findTotal, offsetState, withPaginationFirst } from './pagination.js';
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
    inputSchema: {
      start: z.number().int().min(0).describe('Start offset, 0-based (default 0). To continue a listing, pass the `nextStart` from the previous response.').optional(),
      max: z.number().int().min(1).describe('Max results (default 20)').optional(),
    },
  }, async (args) => {
    const start = args.start ?? 0;
    const max = args.max ?? 20;
    const data = await client.request('GET', `/pub/v2/expense/expenses?start=${start}&max=${max}`);
    // Paging state FIRST, records after — a partial read of a spilled response
    // must reach "there are more" before it reaches the records. See
    // src/tools/pagination.ts for why the order is load-bearing.
    const found = findRecordArray(data);
    const returned = found?.rows.length ?? 0;
    const total = findTotal(data);
    return jsonResponse(withPaginationFirst({
      state: offsetState({ start, max, returned, total }),
      start, max, returned, total,
      hint: `Re-call ofw_list_expenses with start:${start + max}.`,
      payload: data,
      dataKey: 'expenses',
    }));
  });

  if (allowWrites) server.registerTool('ofw_create_expense', {
    description: 'Log a new expense in OurFamilyWizard',
    annotations: { destructiveHint: false },
    inputSchema: {
      amount: z.number().describe('Expense amount'),
      description: z.string().describe('Expense description'),
    },
  }, async (args) => {
    const data = await client.request('POST', '/pub/v2/expense/expenses', args);
    return jsonResponse(data);
  });
}
