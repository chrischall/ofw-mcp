import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageRow } from '../src/cache.js';

/**
 * Build a complete MessageRow with sensible defaults; spread overrides
 * to vary fields per-test. Promoted from tests/cache.test.ts because
 * tests/tools/messages.test.ts had 20+ inline copies of the same shape.
 */
export function sampleMessageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 100,
    folder: 'inbox',
    subject: 'Hello',
    fromUser: 'Alice',
    sentAt: '2026-05-04T12:00:00Z',
    recipients: [{ userId: 1, name: 'Bob', viewedAt: null }],
    body: 'Body text',
    fetchedBodyAt: '2026-05-04T12:01:00Z',
    replyToId: null,
    chainRootId: null,
    listData: { id: 100, raw: true },
    ...overrides,
  };
}

/**
 * Run `fn` with a fresh tmp dir, then rm it. Captures the cleanup so
 * tests don't have to repeat the try/finally + rmSync pattern.
 */
export async function withTmpDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
