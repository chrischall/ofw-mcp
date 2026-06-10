import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { jsonResponse } from './_shared.js';

export function registerExpenseTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_get_expense_totals', {
    description: 'Get OurFamilyWizard expense summary totals (owed/paid)',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/expense/expenses/totals');
    return jsonResponse(data);
  });

  server.registerTool('ofw_list_expenses', {
    description: 'List OurFamilyWizard expenses with pagination',
    annotations: { readOnlyHint: true },
    inputSchema: {
      start: z.number().int().min(0).describe('Start offset (default 0)').optional(),
      max: z.number().int().min(1).describe('Max results (default 20)').optional(),
    },
  }, async (args) => {
    const start = args.start ?? 0;
    const max = args.max ?? 20;
    const data = await client.request('GET', `/pub/v2/expense/expenses?start=${start}&max=${max}`);
    return jsonResponse(data);
  });

  server.registerTool('ofw_create_expense', {
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
