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

  it('listMessages sorts oldest-first on request, tiebreaking id in the same direction', async () => {
    await store.upsertMessage(sampleRow({ id: 1, folder: 'inbox', sentAt: '2026-05-01T00:00:00Z' }));
    await store.upsertMessage(sampleRow({ id: 2, folder: 'inbox', sentAt: '2026-05-03T00:00:00Z' }));
    await store.upsertMessage(sampleRow({ id: 3, folder: 'inbox', sentAt: '2026-05-02T00:00:00Z' }));

    expect((await store.listMessages({ page: 1, size: 50, sort: 'oldest' })).map((m) => m.id)).toEqual([1, 3, 2]);
    // Explicit 'newest' and an omitted sort are the same query — the default
    // must not shift under existing callers.
    expect((await store.listMessages({ page: 1, size: 50, sort: 'newest' })).map((m) => m.id)).toEqual([2, 3, 1]);
    expect((await store.listMessages({ page: 1, size: 50 })).map((m) => m.id)).toEqual([2, 3, 1]);

    // The id tiebreaker follows the timestamp direction, so a page boundary
    // that falls inside a group of equal timestamps neither drops nor repeats.
    await store.upsertMessage(sampleRow({ id: 10, folder: 'sent', sentAt: '2026-06-01T00:00:00Z' }));
    await store.upsertMessage(sampleRow({ id: 11, folder: 'sent', sentAt: '2026-06-01T00:00:00Z' }));
    await store.upsertMessage(sampleRow({ id: 12, folder: 'sent', sentAt: '2026-06-01T00:00:00Z' }));
    const first = await store.listMessages({ folder: 'sent', page: 1, size: 2, sort: 'oldest' });
    const second = await store.listMessages({ folder: 'sent', page: 2, size: 2, sort: 'oldest' });
    expect([...first, ...second].map((m) => m.id)).toEqual([10, 11, 12]);
  });

  it('countMessages counts matching rows', async () => {
    await store.upsertMessage(sampleRow({ id: 1, folder: 'inbox' }));
    await store.upsertMessage(sampleRow({ id: 2, folder: 'sent' }));
    expect(await store.countMessages({ folder: 'inbox' })).toBe(1);
    expect(await store.countMessages({})).toBe(2);
  });

  it('getMessages batch-reads only present ids (empty array short-circuits, no query)', async () => {
    // Empty ids returns [] without touching the DB.
    expect(await store.getMessages([])).toEqual([]);

    await store.upsertMessage(sampleRow({ id: 1 }));
    await store.upsertMessage(sampleRow({ id: 2 }));
    // Partial hit: id 3 is absent — only present rows come back.
    const got = await store.getMessages([1, 3, 2]);
    expect(got.map((m) => m.id).sort()).toEqual([1, 2]);
    // Full round-trip fidelity for one row.
    const one = (await store.getMessages([1]))[0];
    expect(one).toEqual(sampleRow({ id: 1 }));
  });

  it('upsertMessages batch-writes in one transaction (empty array is a no-op)', async () => {
    await store.upsertMessages([]); // no-op, must not throw
    expect(await store.countMessages({})).toBe(0);

    await store.upsertMessages([
      sampleRow({ id: 10, subject: 'A' }),
      sampleRow({ id: 11, subject: 'B' }),
    ]);
    expect((await store.getMessage(10))?.subject).toBe('A');
    expect((await store.getMessage(11))?.subject).toBe('B');

    // Re-upsert overwrites in place (same ON CONFLICT path as the single-row write).
    await store.upsertMessages([sampleRow({ id: 10, subject: 'A (edited)' })]);
    expect((await store.getMessage(10))?.subject).toBe('A (edited)');
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

  it('getDrafts batch-reads only present ids (empty array short-circuits, no query)', async () => {
    expect(await store.getDrafts([])).toEqual([]);

    await store.upsertDraft(sampleDraft({ id: 1 }));
    await store.upsertDraft(sampleDraft({ id: 2 }));
    const got = await store.getDrafts([1, 3, 2]);
    expect(got.map((d) => d.id).sort()).toEqual([1, 2]);
    expect((await store.getDrafts([1]))[0]).toEqual(sampleDraft({ id: 1 }));
  });

  it('upsertDrafts batch-writes in one transaction (empty array is a no-op)', async () => {
    await store.upsertDrafts([]); // no-op, must not throw
    expect(await store.listDraftIds()).toEqual([]);

    await store.upsertDrafts([
      sampleDraft({ id: 10, subject: 'A' }),
      sampleDraft({ id: 11, subject: 'B' }),
    ]);
    expect((await store.getDraft(10))?.subject).toBe('A');
    expect((await store.getDraft(11))?.subject).toBe('B');

    await store.upsertDrafts([sampleDraft({ id: 10, subject: 'A (edited)' })]);
    expect((await store.getDraft(10))?.subject).toBe('A (edited)');
    expect((await store.listDraftIds()).sort()).toEqual([10, 11]);
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
  it('getSyncState returns null then round-trips setSyncState (incl. null newestId + resumePage)', async () => {
    expect(await store.getSyncState('inbox')).toBeNull();
    await store.setSyncState('inbox', { lastSyncAt: '2026-05-04T00:00:00Z', newestId: 42, resumePage: null });
    expect(await store.getSyncState('inbox')).toEqual({ lastSyncAt: '2026-05-04T00:00:00Z', newestId: 42, resumePage: null });
    await store.setSyncState('inbox', { lastSyncAt: '2026-05-05T00:00:00Z', newestId: null, resumePage: null });
    expect(await store.getSyncState('inbox')).toEqual({ lastSyncAt: '2026-05-05T00:00:00Z', newestId: null, resumePage: null });
  });

  it('persists a non-null resumePage cursor (deep-backfill resume) and clears it back to null', async () => {
    await store.setSyncState('sent', { lastSyncAt: '2026-05-04T00:00:00Z', newestId: 500, resumePage: 7 });
    expect(await store.getSyncState('sent')).toEqual({ lastSyncAt: '2026-05-04T00:00:00Z', newestId: 500, resumePage: 7 });
    // A subsequent completed walk writes resumePage: null.
    await store.setSyncState('sent', { lastSyncAt: '2026-05-06T00:00:00Z', newestId: 500, resumePage: null });
    expect((await store.getSyncState('sent'))?.resumePage).toBeNull();
  });

  it('getMeta returns null then round-trips setMeta', async () => {
    expect(await store.getMeta('nope')).toBeNull();
    await store.setMeta('drafts_folder_id', '13471259');
    expect(await store.getMeta('drafts_folder_id')).toBe('13471259');
  });

  it('stamps schema_version into meta on open', async () => {
    expect(await store.getMeta('schema_version')).toBe('3');
  });
});

describe('OFWCache (:memory:) draft lineage', () => {
  it('countDrafts reflects inserts and deletes', async () => {
    expect(await store.countDrafts()).toBe(0);
    await store.upsertDraft(sampleDraft({ id: 1 }));
    await store.upsertDraft(sampleDraft({ id: 2 }));
    expect(await store.countDrafts()).toBe(2);
    await store.deleteDraft(1);
    expect(await store.countDrafts()).toBe(1);
  });

  it('records a chain and resolves it oldest-first', async () => {
    await store.recordDraftLineage({ id: 10, draftKey: 'dk_a', previousId: null, recordedAt: '2026-07-01T00:00:00Z' });
    await store.recordDraftLineage({ id: 20, draftKey: 'dk_a', previousId: 10, recordedAt: '2026-07-02T00:00:00Z' });
    await store.recordDraftLineage({ id: 30, draftKey: 'dk_a', previousId: 20, recordedAt: '2026-07-03T00:00:00Z' });
    // A different document must not bleed into the chain.
    await store.recordDraftLineage({ id: 99, draftKey: 'dk_b', previousId: null, recordedAt: '2026-07-02T12:00:00Z' });

    expect((await store.getDraftLineage('dk_a')).map((r) => r.id)).toEqual([10, 20, 30]);
    expect(await store.getDraftLineage('dk_unknown')).toEqual([]);
    expect(await store.getDraftLineageById(20)).toEqual({
      id: 20, draftKey: 'dk_a', previousId: 10, recordedAt: '2026-07-02T00:00:00Z',
    });
    expect(await store.getDraftLineageById(12345)).toBeNull();
  });

  it('tie-breaks same-millisecond links on id, so a replacement still sorts last', async () => {
    // ofw_save_draft records the retroactive link for the OLD id and the link
    // for the NEW id with the same timestamp. OFW mints ids monotonically, so
    // id ASC is what keeps the newer one at the end of the chain.
    const at = '2026-07-28T10:00:00Z';
    await store.recordDraftLineage({ id: 500, draftKey: 'dk_c', previousId: null, recordedAt: at });
    await store.recordDraftLineage({ id: 900, draftKey: 'dk_c', previousId: 500, recordedAt: at });
    expect((await store.getDraftLineage('dk_c')).map((r) => r.id)).toEqual([500, 900]);
  });

  it('re-recording an id rewrites its link instead of duplicating it', async () => {
    await store.recordDraftLineage({ id: 10, draftKey: 'dk_a', previousId: null, recordedAt: '2026-07-01T00:00:00Z' });
    await store.recordDraftLineage({ id: 10, draftKey: 'dk_a', previousId: 5, recordedAt: '2026-07-04T00:00:00Z' });
    const chain = await store.getDraftLineage('dk_a');
    expect(chain).toHaveLength(1);
    expect(chain[0].previousId).toBe(5);
  });

  it('getDraftLineageByIds batches, omits absent ids, and short-circuits on []', async () => {
    await store.recordDraftLineage({ id: 10, draftKey: 'dk_a', previousId: null, recordedAt: '2026-07-01T00:00:00Z' });
    await store.recordDraftLineage({ id: 20, draftKey: 'dk_b', previousId: null, recordedAt: '2026-07-01T00:00:00Z' });
    expect(await store.getDraftLineageByIds([])).toEqual([]);
    const rows = await store.getDraftLineageByIds([10, 20, 30]);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([10, 20]);
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
