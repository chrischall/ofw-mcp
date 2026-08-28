import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { jsonResponse } from './_shared.js';
import { offsetState, readUpstreamPaging, withPaginationFirst } from './pagination.js';
import { getWriteMode } from '../config.js';

export function registerJournalTools(server: McpServer, client: OFWClient): void {
  // Journal writes land on the court-visible record — OFW_WRITE_MODE 'all' only.
  const allowWrites = getWriteMode() === 'all';

  server.registerTool('ofw_list_journal_entries', {
    description: 'List OurFamilyWizard journal entries. Offset-paged via start/max (1-based). The response leads with its paging state — `hasMore` and `nextStart` (null when the list is exhausted) — BEFORE the records, so a truncated or partially-read response still says whether more remain. Never state an entry count or an absence from one page.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      start: z.number().int().min(1).describe('Start offset, 1-based (default 1). To continue a listing, pass the `nextStart` from the previous response.').optional(),
      max: z.number().int().min(1).describe('Max results (default 10)').optional(),
    },
  }, async (args) => {
    // Journal API uses 1-based offset (unlike expenses which start at 0)
    const start = args.start ?? 1;
    const max = args.max ?? 10;
    const data = await client.request('GET', `/pub/v1/journals?start=${start}&max=${max}`);
    // Paging state FIRST, records after — a partial read of a spilled response
    // must reach "there are more" before it reaches the records. See
    // src/tools/pagination.ts for why the order is load-bearing.
    //
    // OFW wraps these listings as {data, metadata} and its metadata carries a
    // `last` boolean, so "is there another page" is answered by the server
    // rather than inferred from a full page (verified live).
    const { returned, total, last } = readUpstreamPaging(data);
    const wrapped = withPaginationFirst({
      state: offsetState({ start, max, returned, total, last, base: 1 }),
      start, max, returned, total,
      hint: `Re-call ofw_list_journal_entries with start:${start + max}.`,
      payload: data,
    });
    // A payload that is not a plain object cannot carry the paging keys at all.
    // Pass it through untouched rather than relocating it — an added field is
    // never worth changing a response's top-level shape.
    return jsonResponse(wrapped ?? data);
  });

  if (allowWrites) server.registerTool('ofw_create_journal_entry', {
    description: 'Create a new journal entry in OurFamilyWizard',
    annotations: { destructiveHint: false },
    inputSchema: {
      title: z.string().describe('Entry title'),
      body: z.string().describe('Entry text content'),
    },
  }, async (args) => {
    const data = await client.request('POST', '/pub/v1/journals', args);
    return jsonResponse(data);
  });
}
