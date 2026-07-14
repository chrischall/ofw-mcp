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
import { runMcp } from '@chrischall/mcp-utils';
import { client } from './client.js';
import { registerUserTools } from './tools/user.js';
import { registerMessageTools } from './tools/messages.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerJournalTools } from './tools/journal.js';
import { OFWCache } from './cache/node.js';
import { getCacheDbPath } from './config.js';
import { NodeAttachmentIO } from './tools/attachments.js';
import type { CacheStore } from './cache/store.js';

// The stdio server backs the message cache with a local `node:sqlite` file,
// opened lazily on first use (so the server still boots and answers the host's
// install-time tools/list probe when no cache path is configured). The hosted
// Cloudflare connector (a later task) injects a Durable-Object-backed
// CacheStore + a filesystem-free AttachmentIO into the same registrar instead.
let nodeCache: CacheStore | undefined;
const nodeCacheProvider = (): CacheStore => (nodeCache ??= OFWCache.open(getCacheDbPath()));
const nodeAttachmentIO = new NodeAttachmentIO();

// runMcp builds the McpServer, applies the registrars (with `client` threaded
// through as deps), prints the banner to stderr, wires SIGINT/SIGTERM graceful
// shutdown, and connects the stdio transport. The deferred-config-error pattern
// is preserved: `client` is constructed at module load in ./client.js (auth is
// resolved lazily on the first tool call), so the host's initial tools/list
// always succeeds before any credential check runs.
await runMcp({
  name: 'ofw',
  version: '2.6.0', // x-release-please-version
  deps: client,
  tools: [
    registerUserTools,
    (server, deps) => registerMessageTools(server, deps, nodeCacheProvider, nodeAttachmentIO),
    registerCalendarTools,
    registerExpenseTools,
    registerJournalTools,
  ],
  banner:
    '[ofw-mcp] This project was developed and is maintained by AI (Claude Sonnet 4.6). Use at your own discretion.',
});
