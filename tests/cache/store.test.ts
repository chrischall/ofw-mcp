import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OFWCache } from '../../src/cache/node.js';
import type { CacheStore, DraftRow } from '../../src/cache/store.js';
import { sampleMessageRow as sampleRow } from '../_fixtures.js';

// Exercises the driver-agnostic core through the async CacheStore surface, on a
// `:memory:` OFWCache (no disk / chmod). The shim's synchronous free-function
// path (which delegates to the same core) is covered by tests/cache.test.ts.

let cache: OFWCache;
let store: CacheStore;

beforeEach(() => {
  cache = OFWCache.open(':memory:');
  store = cache;
});

afterEach(() => {
  cache.close();
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

describe('OFWCache (:memory:) messages', () => {
  it('upsertMessage + getMessage round-trips', async () => {
    const row = sampleRow();
    await store.upsertMessage(row);
    expect(await store.getMessage(100)).toEqual(row);
  });

  it('getMessage returns null for unknown id', async () => {
    expect(await store.getMessage(999)).toBeNull();
  });

  it('deleteMessage removes a row', async () => {
    await store.upsertMessage(sampleRow({ id: 7 }));
    await store.deleteMessage(7);
    expect(await store.getMessage(7)).toBeNull();
  });

  it('listMessages filters by folder, date range, q and paginates', async () => {
    await store.upsertMessage(sampleRow({ id: 1, folder: 'inbox', sentAt: '2026-05-01T00:00:00Z' }));
    await store.upsertMessage(sampleRow({ id: 2, folder: 'inbox', sentAt: '2026-05-03T00:00:00Z', subject: 'Boston trip' }));
    await store.upsertMessage(sampleRow({ id: 3, folder: 'inbox', sentAt: '2026-05-02T00:00:00Z' }));
    await store.upsertMessage(sampleRow({ id: 4, folder: 'sent', sentAt: '2026-05-04T00:00:00Z' }));

    expect((await store.listMessages({ folder: 'inbox', page: 1, size: 50 })).map((m) => m.id)).toEqual([2, 3, 1]);
    expect((await store.listMessages({ page: 1, size: 50 })).map((m) => m.id)).toEqual([4, 2, 3, 1]);
    expect((await store.listMessages({ folder: 'inbox', page: 1, size: 2 })).map((m) => m.id)).toEqual([2, 3]);
    expect(
      (await store.listMessages({ folder: 'inbox', page: 1, size: 50, since: '2026-05-02', until: '2026-05-04' })).map((m) => m.id),
    ).toEqual([2, 3]);
    expect((await store.listMessages({ page: 1, size: 50, q: 'boston' })).map((m) => m.id)).toEqual([2]);
  });

  it('countMessages counts matching rows', async () => {
    await store.upsertMessage(sampleRow({ id: 1, folder: 'inbox' }));
    await store.upsertMessage(sampleRow({ id: 2, folder: 'sent' }));
    expect(await store.countMessages({ folder: 'inbox' })).toBe(1);
    expect(await store.countMessages({})).toBe(2);
  });

  it('defaults undefined recipients/listData and nullish body/replyToId when OFW omits them', async () => {
    // Exercises the `?? []` / `?? null` / nullish(undefined) fallbacks in
    // upsertMessage for a sparse row (missing optional/nullable fields).
    await store.upsertMessage(sampleRow({
      id: 300,
      recipients: undefined as never,
      body: undefined as never,
      fetchedBodyAt: undefined as never,
      replyToId: undefined as never,
      chainRootId: undefined as never,
      listData: undefined as never,
    }));
    const got = await store.getMessage(300);
    expect(got?.recipients).toEqual([]);
    expect(got?.body).toBeNull();
    expect(got?.replyToId).toBeNull();
    expect(got?.listData).toBeNull();
  });
});

describe('OFWCache (:memory:) drafts', () => {
  it('upsertDraft + getDraft round-trips', async () => {
    await store.upsertDraft(sampleDraft());
    expect(await store.getDraft(200)).toEqual(sampleDraft());
  });

  it('getDraft returns null for unknown id', async () => {
    expect(await store.getDraft(999)).toBeNull();
  });

  it('defaults undefined recipients/listData and nullish replyToId on a sparse draft', async () => {
    // Exercises the `?? []` / `?? null` / nullish(undefined) fallbacks in
    // upsertDraft.
    await store.upsertDraft(sampleDraft({
      id: 301,
      recipients: undefined as never,
      replyToId: undefined as never,
      listData: undefined as never,
    }));
    const got = await store.getDraft(301);
    expect(got?.recipients).toEqual([]);
    expect(got?.replyToId).toBeNull();
    expect(got?.listData).toBeNull();
  });

  it('listDrafts sorts by modifiedAt desc; listDraftIds returns all ids; deleteDraft removes', async () => {
    await store.upsertDraft(sampleDraft({ id: 1, modifiedAt: '2026-05-01T00:00:00Z' }));
    await store.upsertDraft(sampleDraft({ id: 2, modifiedAt: '2026-05-03T00:00:00Z' }));
    expect((await store.listDrafts({ page: 1, size: 50 })).map((d) => d.id)).toEqual([2, 1]);
    expect((await store.listDraftIds()).sort()).toEqual([1, 2]);
    await store.deleteDraft(1);
    expect((await store.listDraftIds())).toEqual([2]);
  });
});

describe('OFWCache (:memory:) sync_state and meta', () => {
  it('getSyncState returns null then round-trips setSyncState (incl. null newestId)', async () => {
    expect(await store.getSyncState('inbox')).toBeNull();
    await store.setSyncState('inbox', { lastSyncAt: '2026-05-04T00:00:00Z', newestId: 42 });
    expect(await store.getSyncState('inbox')).toEqual({ lastSyncAt: '2026-05-04T00:00:00Z', newestId: 42 });
    await store.setSyncState('inbox', { lastSyncAt: '2026-05-05T00:00:00Z', newestId: null });
    expect(await store.getSyncState('inbox')).toEqual({ lastSyncAt: '2026-05-05T00:00:00Z', newestId: null });
  });

  it('getMeta returns null then round-trips setMeta', async () => {
    expect(await store.getMeta('nope')).toBeNull();
    await store.setMeta('drafts_folder_id', '13471259');
    expect(await store.getMeta('drafts_folder_id')).toBe('13471259');
  });

  it('stamps schema_version into meta on open', async () => {
    expect(await store.getMeta('schema_version')).toBe('2');
  });
});

describe('OFWCache (:memory:) findLatestReplyTip', () => {
  it('returns input id when parent absent, and the latest sent reply otherwise', async () => {
    expect(await store.findLatestReplyTip(999)).toBe(999);
    await store.upsertMessage(sampleRow({ id: 100, folder: 'inbox' }));
    expect(await store.findLatestReplyTip(100)).toBe(100);
    await store.upsertMessage(sampleRow({ id: 142, folder: 'sent', replyToId: 100, chainRootId: 100 }));
    await store.upsertMessage(sampleRow({ id: 200, folder: 'sent', replyToId: 142, chainRootId: 100 }));
    expect(await store.findLatestReplyTip(100)).toBe(200);
    expect(await store.findLatestReplyTip(142)).toBe(200);
  });
});

describe('OFWCache (:memory:) attachments', () => {
  const base = { fileId: 9, fileName: 'a.pdf', label: 'A', mimeType: 'application/pdf', sizeBytes: 10, metadata: { x: 1 } };

  it('getAttachment returns null for unknown id', async () => {
    expect(await store.getAttachment(999)).toBeNull();
  });

  it('links messageIds, dedupes, and skips the 0 sentinel', async () => {
    await store.upsertAttachmentForMessage({ ...base, messageId: 5 });
    await store.upsertAttachmentForMessage({ ...base, messageId: 5 });
    await store.upsertAttachmentForMessage({ ...base, messageId: 6 });
    expect((await store.getAttachment(9))!.messageIds).toEqual([5, 6]);
    await store.upsertAttachmentForMessage({ fileId: 11, fileName: 'b.txt', label: 'B', mimeType: 'text/plain', sizeBytes: null, metadata: undefined, messageId: 0 });
    expect((await store.getAttachment(11))!.messageIds).toEqual([]);
  });

  it('listAttachmentsForMessage returns attachments linked to a message id', async () => {
    await store.upsertAttachmentForMessage({ ...base, messageId: 5 });
    expect((await store.listAttachmentsForMessage(5)).map((a) => a.fileId)).toEqual([9]);
    expect(await store.listAttachmentsForMessage(999)).toEqual([]);
  });

  it('markAttachmentDownloaded records the path', async () => {
    await store.upsertAttachmentForMessage({ ...base, messageId: 5 });
    await store.markAttachmentDownloaded(9, '/tmp/a.pdf');
    expect((await store.getAttachment(9))!.downloadedPath).toBe('/tmp/a.pdf');
  });
});
