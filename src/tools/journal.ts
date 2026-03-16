import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_list_journal_entries',
    description: 'List OurFamilyWizard journal entries',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', description: 'Start offset (default 1)' },
        max: { type: 'number', description: 'Max results (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'ofw_create_journal_entry',
    description: 'Create a new journal entry in OurFamilyWizard',
    annotations: { destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Entry title' },
        body: { type: 'string', description: 'Entry text content' },
        // Additional fields TBD — add after DevTools capture (see pre-task note)
      },
      required: ['title', 'body'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_list_journal_entries': {
      // Journal API uses 1-based offset (unlike expenses which start at 0)
      const { start = 1, max = 10 } = args as { start?: number; max?: number };
      const data = await client.request('GET', `/pub/v1/journals?start=${start}&max=${max}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_create_journal_entry': {
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v1/journals', args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
