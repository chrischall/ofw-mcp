import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openCache, closeCache,
  upsertMessage, getMessage, listMessages, type MessageRow,
  upsertDraft, getDraft, listDrafts, deleteDraft, listDraftIds, type DraftRow,
} from '../src/cache.js';

let tmp: string;
let originalCacheDir: string | undefined;
let originalUsername: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ofw-cache-'));
  originalCacheDir = process.env.OFW_CACHE_DIR;
  originalUsername = process.env.OFW_USERNAME;
  process.env.OFW_CACHE_DIR = tmp;
  process.env.OFW_USERNAME = 'test@example.com';
});

afterEach(() => {
  closeCache();
  if (originalCacheDir === undefined) delete process.env.OFW_CACHE_DIR;
  else process.env.OFW_CACHE_DIR = originalCacheDir;
  if (originalUsername === undefined) delete process.env.OFW_USERNAME;
  else process.env.OFW_USERNAME = originalUsername;
  rmSync(tmp, { recursive: true, force: true });
});

describe('openCache', () => {
  it('creates the cache directory and database file on first open', () => {
    const cache = openCache();
    expect(existsSync(tmp)).toBe(true);
    expect(cache).toBeDefined();
  });

  it('runs schema migrations on first open', () => {
    const cache = openCache();
    const tables = cache.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('messages');
    expect(names).toContain('drafts');
    expect(names).toContain('sync_state');
    expect(names).toContain('meta');
  });

  it('records schema_version=1 in meta', () => {
    const cache = openCache();
    const row = cache.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    expect(row?.value).toBe('1');
  });

  it('is idempotent — opening twice does not error', () => {
    openCache();
    closeCache();
    expect(() => openCache()).not.toThrow();
  });
});

function sampleRow(overrides: Partial<MessageRow> = {}): MessageRow {
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

describe('messages CRUD', () => {
  it('upsertMessage + getMessage round-trips', () => {
    openCache();
    const row = sampleRow();
    upsertMessage(row);
    const got = getMessage(100);
    expect(got).toEqual(row);
  });

  it('upsertMessage replaces an existing row', () => {
    openCache();
    upsertMessage(sampleRow({ subject: 'Original' }));
    upsertMessage(sampleRow({ subject: 'Updated' }));
    expect(getMessage(100)?.subject).toBe('Updated');
  });

  it('getMessage returns null for unknown id', () => {
    openCache();
    expect(getMessage(999)).toBeNull();
  });

  it('listMessages filters by folder and sorts by sentAt desc', () => {
    openCache();
    upsertMessage(sampleRow({ id: 1, folder: 'inbox', sentAt: '2026-05-01T00:00:00Z' }));
    upsertMessage(sampleRow({ id: 2, folder: 'inbox', sentAt: '2026-05-03T00:00:00Z' }));
    upsertMessage(sampleRow({ id: 3, folder: 'inbox', sentAt: '2026-05-02T00:00:00Z' }));
    upsertMessage(sampleRow({ id: 4, folder: 'sent',  sentAt: '2026-05-04T00:00:00Z' }));

    const inbox = listMessages({ folder: 'inbox', page: 1, size: 50 });
    expect(inbox.map((m) => m.id)).toEqual([2, 3, 1]);

    const sent = listMessages({ folder: 'sent', page: 1, size: 50 });
    expect(sent.map((m) => m.id)).toEqual([4]);
  });

  it('listMessages paginates', () => {
    openCache();
    for (let i = 1; i <= 5; i++) {
      upsertMessage(sampleRow({ id: i, sentAt: `2026-05-0${i}T00:00:00Z` }));
    }
    const page1 = listMessages({ folder: 'inbox', page: 1, size: 2 });
    const page2 = listMessages({ folder: 'inbox', page: 2, size: 2 });
    expect(page1.map((m) => m.id)).toEqual([5, 4]);
    expect(page2.map((m) => m.id)).toEqual([3, 2]);
  });
});

function sampleDraft(overrides: Partial<DraftRow> = {}): DraftRow {
  return {
    id: 200,
    subject: 'Draft subject',
    body: 'Draft body',
    recipients: [{ userId: 1, name: 'Bob', viewedAt: null }],
    replyToId: null,
    modifiedAt: '2026-05-04T12:00:00Z',
    listData: { id: 200 },
    ...overrides,
  };
}

describe('drafts CRUD', () => {
  it('upsertDraft + getDraft round-trips', () => {
    openCache();
    upsertDraft(sampleDraft());
    expect(getDraft(200)).toEqual(sampleDraft());
  });

  it('listDrafts returns drafts sorted by modifiedAt desc', () => {
    openCache();
    upsertDraft(sampleDraft({ id: 1, modifiedAt: '2026-05-01T00:00:00Z' }));
    upsertDraft(sampleDraft({ id: 2, modifiedAt: '2026-05-03T00:00:00Z' }));
    upsertDraft(sampleDraft({ id: 3, modifiedAt: '2026-05-02T00:00:00Z' }));
    const drafts = listDrafts({ page: 1, size: 50 });
    expect(drafts.map((d) => d.id)).toEqual([2, 3, 1]);
  });

  it('deleteDraft removes the row', () => {
    openCache();
    upsertDraft(sampleDraft());
    deleteDraft(200);
    expect(getDraft(200)).toBeNull();
  });

  it('deleteDraft is a no-op for unknown id', () => {
    openCache();
    expect(() => deleteDraft(999)).not.toThrow();
  });

  it('listDraftIds returns all draft ids', () => {
    openCache();
    upsertDraft(sampleDraft({ id: 1 }));
    upsertDraft(sampleDraft({ id: 2 }));
    expect(listDraftIds().sort()).toEqual([1, 2]);
  });
});
