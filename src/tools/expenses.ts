import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_get_expense_totals',
    description: 'Get OurFamilyWizard expense summary totals (owed/paid)',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ofw_list_expenses',
    description: 'List OurFamilyWizard expenses with pagination',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', description: 'Start offset (default 0)' },
        max: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'ofw_create_expense',
    description: 'Log a new expense in OurFamilyWizard',
    annotations: { destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Expense amount' },
        description: { type: 'string', description: 'Expense description' },
        // Additional fields TBD — add after DevTools capture (see pre-task note)
      },
      required: ['amount', 'description'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_get_expense_totals': {
      const data = await client.request('GET', '/pub/v2/expense/expenses/totals');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_list_expenses': {
      const { start = 0, max = 20 } = args as { start?: number; max?: number };
      const data = await client.request('GET', `/pub/v2/expense/expenses?start=${start}&max=${max}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_create_expense': {
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v2/expense/expenses', args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
