import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';

export function registerJournalTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_list_journal_entries', {
    description: 'List OurFamilyWizard journal entries',
    annotations: { readOnlyHint: true },
    inputSchema: {
      start: z.number().describe('Start offset (default 1)').optional(),
      max: z.number().describe('Max results (default 10)').optional(),
    },
  }, async (args) => {
    // Journal API uses 1-based offset (unlike expenses which start at 0)
    const start = args.start ?? 1;
    const max = args.max ?? 10;
    const data = await client.request('GET', `/pub/v1/journals?start=${start}&max=${max}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_create_journal_entry', {
    description: 'Create a new journal entry in OurFamilyWizard',
    annotations: { destructiveHint: false },
    inputSchema: {
      title: z.string().describe('Entry title'),
      body: z.string().describe('Entry text content'),
    },
  }, async (args) => {
    const data = await client.request('POST', '/pub/v1/journals', args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
