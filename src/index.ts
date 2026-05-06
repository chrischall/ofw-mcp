#!/usr/bin/env node
const originalEmit = process.emit.bind(process);
type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;
(process.emit as EmitFn) = function (event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'warning') {
    const w = args[0] as { name?: string; message?: string } | undefined;
    if (w?.name === 'ExperimentalWarning' && /SQLite/i.test(w.message ?? '')) {
      return false;
    }
  }
  return (originalEmit as EmitFn)(event, ...args);
};
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { client } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerMessageTools } from './tools/messages.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerJournalTools } from './tools/journal.js';

const server = new McpServer({ name: 'ofw', version: '2.0.7' });

registerUserTools(server, client);
registerMessageTools(server, client);
registerCalendarTools(server, client);
registerExpenseTools(server, client);
registerJournalTools(server, client);

console.error('[ofw-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.');

const transport = new StdioServerTransport();
await server.connect(transport);
