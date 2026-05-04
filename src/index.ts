#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { client } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerMessageTools } from './tools/messages.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerJournalTools } from './tools/journal.js';

const server = new McpServer({ name: 'ofw', version: '2.0.5' });

registerUserTools(server, client);
registerMessageTools(server, client);
registerCalendarTools(server, client);
registerExpenseTools(server, client);
registerJournalTools(server, client);

console.error('[ofw-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.');

const transport = new StdioServerTransport();
await server.connect(transport);
