#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { client } from './client.js';
import { toolDefinitions as userTools, handleTool as handleUser } from './tools/user.js';
import { toolDefinitions as messageTools, handleTool as handleMessages } from './tools/messages.js';
import { toolDefinitions as calendarTools, handleTool as handleCalendar } from './tools/calendar.js';
import { toolDefinitions as expenseTools, handleTool as handleExpenses } from './tools/expenses.js';
import { toolDefinitions as journalTools, handleTool as handleJournal } from './tools/journal.js';

const allTools = [
  ...userTools,
  ...messageTools,
  ...calendarTools,
  ...expenseTools,
  ...journalTools,
];

const handlers: Record<string, (name: string, args: Record<string, unknown>) => Promise<CallToolResult>> = {};

for (const tool of userTools) handlers[tool.name] = (n, a) => handleUser(n, a, client);
for (const tool of messageTools) handlers[tool.name] = (n, a) => handleMessages(n, a, client);
for (const tool of calendarTools) handlers[tool.name] = (n, a) => handleCalendar(n, a, client);
for (const tool of expenseTools) handlers[tool.name] = (n, a) => handleExpenses(n, a, client);
for (const tool of journalTools) handlers[tool.name] = (n, a) => handleJournal(n, a, client);

const server = new Server(
  { name: 'ofw', version: '2.0.3' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await handler(name, args as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

console.error('[ofw-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.');

const transport = new StdioServerTransport();
await server.connect(transport);
