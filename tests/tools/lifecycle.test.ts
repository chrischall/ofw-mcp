import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { OFWCache } from '../../src/cache/node.js';
import { sampleMessageRow } from '../_fixtures.js';
import {
  classifyState, ensureFolderIdMap, newDraftKey, persistFolderIds, probeIds,
  probeWouldStamp, readFolderIdMap, resolveDraftKey,
} from '../../src/tools/lifecycle.js';
import type { FolderIdMap } from '../../src/tools/lifecycle.js';
import type { MessageSnapshot } from '../../src/tools/draft-freshness.js';

let cache: OFWCache;

beforeEach(() => {
  cache = OFWCache.open(':memory:');
});

afterEach(() => {
  cache.close();
  vi.restoreAllMocks();
});

const MAP: FolderIdMap = { inbox: '1', sent: '2', drafts: '3' };

function snapshot(over: Partial<MessageSnapshot> = {}): MessageSnapshot {
  return {
    content: { subject: 'S', body: 'B', replyToId: null, recipients: [] },
    folderId: '3',
    folderName: 'Drafts',
    dateTime: '2026-07-20T00:00:00Z',
    ...over,
  };
}

const seedFolderIds = (): void => {
  cache.core.setMeta('inbox_folder_id', '1');
  cache.core.setMeta('sent_folder_id', '2');
  cache.core.setMeta('drafts_folder_id', '3');
};

describe('classifyState', () => {
  it('maps each known folder id to its lifecycle state', () => {
    expect(classifyState(snapshot({ folderId: '3' }), MAP)).toBe('draft');
    expect(classifyState(snapshot({ folderId: '2' }), MAP)).toBe('sent');
    expect(classifyState(snapshot({ folderId: '1' }), MAP)).toBe('received');
  });

  it('reports deleted for a missing message', () => {
    expect(classifyState(null, MAP)).toBe('deleted');
  });

  it('refuses to guess: an unreported or unmappable folder is "unknown"', () => {
    expect(classifyState(snapshot({ folderId: null }), MAP)).toBe('unknown');
    expect(classifyState(snapshot({ folderId: '77' }), MAP)).toBe('unknown');
    // A map with holes must not accidentally match on a null.
    expect(classifyState(snapshot({ folderId: '3' }), { inbox: null, sent: null, drafts: null })).toBe('unknown');
    expect(classifyState(snapshot({ folderId: '2' }), { inbox: null, sent: null, drafts: '3' })).toBe('unknown');
    expect(classifyState(snapshot({ folderId: '1' }), { inbox: null, sent: '2', drafts: '3' })).toBe('unknown');
  });
});

describe('probeWouldStamp', () => {
  const draftRow = {
    id: 1, subject: 'S', body: 'B', recipients: [], replyToId: null,
    modifiedAt: '2026-07-01T00:00:00Z', listData: {},
  };

  it('is false for a cached draft — drafts have no read state', () => {
    expect(probeWouldStamp(draftRow, null)).toBe(false);
  });

  it('is false for a sent message — its view times belong to the recipient', () => {
    expect(probeWouldStamp(null, sampleMessageRow({ folder: 'sent' }))).toBe(false);
  });

  it('is false for an already-read inbox message — the stamp cannot be added twice', () => {
    expect(probeWouldStamp(null, sampleMessageRow({
      folder: 'inbox', fetchedBodyAt: '2026-07-01T00:00:00Z',
    }))).toBe(false);
  });

  it('is TRUE for an unread inbox message', () => {
    expect(probeWouldStamp(null, sampleMessageRow({
      folder: 'inbox', fetchedBodyAt: null, recipients: [], listData: {},
    }))).toBe(true);
  });

  it('is TRUE for an id with no cached row — unknowable without making the request', () => {
    expect(probeWouldStamp(null, null)).toBe(true);
  });
});

describe('readFolderIdMap / ensureFolderIdMap', () => {
  it('reads a persisted map without spending a request', async () => {
    seedFolderIds();
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');

    expect(await readFolderIdMap(cache)).toEqual(MAP);
    expect(await ensureFolderIdMap(client, cache)).toEqual({ map: MAP, requests: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves live (one request) when the map has never been persisted', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      systemFolders: [
        { id: '1', folderType: 'INBOX' },
        { id: '2', folderType: 'SENT_MESSAGES' },
        { id: '3', folderType: 'DRAFTS' },
      ],
    });

    expect(await ensureFolderIdMap(client, cache)).toEqual({ map: MAP, requests: 1 });
    // And it persisted them, so the next call is free.
    expect(await readFolderIdMap(cache)).toEqual(MAP);
  });

  it('degrades to the partial cached map when the live resolve fails', async () => {
    cache.core.setMeta('drafts_folder_id', '3');
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 503'));

    // Still charges the request it made, and answers with what it had — a
    // folder listing failing must not fail the whole status call.
    expect(await ensureFolderIdMap(client, cache)).toEqual({
      map: { inbox: null, sent: null, drafts: '3' }, requests: 1,
    });
  });
});

describe('persistFolderIds', () => {
  it('harvests ids from an already-fetched listing, making ensureFolderIdMap free', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');

    await persistFolderIds(cache, [
      { id: '1', folderType: 'INBOX' },
      { id: '2', folderType: 'SENT_MESSAGES' },
      { id: '3', folderType: 'DRAFTS' },
      { id: '9', folderType: 'SOMETHING_ELSE' },
    ]);

    expect(await readFolderIdMap(cache)).toEqual(MAP);
    expect(await ensureFolderIdMap(client, cache)).toEqual({ map: MAP, requests: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('persists only the folders the listing actually reported', async () => {
    await persistFolderIds(cache, [{ id: '3', folderType: 'DRAFTS' }]);
    expect(await readFolderIdMap(cache)).toEqual({ inbox: null, sent: null, drafts: '3' });
  });
});

describe('resolveDraftKey', () => {
  it('resolves to the chain tip and lists every id', async () => {
    await cache.recordDraftLineage({ id: 10, draftKey: 'dk_a', previousId: null, recordedAt: '2026-07-01T00:00:00Z' });
    await cache.recordDraftLineage({ id: 20, draftKey: 'dk_a', previousId: 10, recordedAt: '2026-07-02T00:00:00Z' });
    expect(await resolveDraftKey(cache, 'dk_a')).toEqual({ currentId: 20, ids: [10, 20] });
  });

  it('returns null for a key that was never recorded, rather than nothing-in-particular', async () => {
    expect(await resolveDraftKey(cache, 'dk_never')).toBeNull();
  });
});

describe('newDraftKey', () => {
  it('mints distinct, prefixed keys', () => {
    const a = newDraftKey();
    const b = newDraftKey();
    expect(a).toMatch(/^dk_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});

describe('probeIds', () => {
  const draftRow = {
    id: 500, subject: 'S', body: 'B', recipients: [], replyToId: null,
    modifiedAt: '2026-07-01T00:00:00Z', listData: {},
  };

  it('spends NOTHING — not even the folder-map resolve — when every id is refused', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');

    const { items, requests } = await probeIds(client, cache, [999], { allowMarkRead: false });

    expect(requests).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({ id: 999, skipped: true, reason: 'WOULD_MARK_READ' });
  });

  it('reports a sent draft as state:"sent" with sentAt, not merely existsOnServer', async () => {
    seedFolderIds();
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null, recipients: [],
      folder: { id: 2, name: 'Sent Messages' },
      date: { dateTime: '2026-07-27T23:31:09' },
    });

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });

    expect(items[0]).toMatchObject({
      id: 500,
      state: 'sent',
      sentAt: '2026-07-27T23:31:09',
      existsOnServer: true,
      // Content is byte-identical, so a revision-only comparison would have
      // said inSync:true — which is exactly the bug.
      inSync: false,
    });
    expect(items[0].cacheRevision).toBe(items[0].serverRevision);
    expect(items[0].note).toMatch(/was SENT/);
  });

  it('accepts a STRING folder id — the strict schema must not hard-fail on it', async () => {
    // OFW types this id as a string on the folders listing and a number on
    // message detail. ServerDraftSchema is parsed strict because it backs the
    // destructive-draft guard, so pinning one spelling would turn a harmless
    // representation change into a failed ofw_save_draft / ofw_delete_draft.
    seedFolderIds();
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null, recipients: [],
      folder: { id: '2', name: 'Sent Messages' },
      date: { dateTime: '2026-07-27T23:31:09' },
    });

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });
    expect(items[0]).toMatchObject({ id: 500, state: 'sent', sentAt: '2026-07-27T23:31:09' });
  });

  it('reports an id that OFW moved to the inbox as "received"', async () => {
    seedFolderIds();
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null, recipients: [],
      folder: { id: 1, name: 'Inbox' },
    });

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });
    expect(items[0]).toMatchObject({ id: 500, state: 'received', inSync: false });
    expect(items[0].note).toMatch(/Inbox/);
  });

  it('reports an inbox message as "received" without draft-specific wording', async () => {
    seedFolderIds();
    // Already read, so probing it cannot stamp anything and needs no override.
    await cache.upsertMessage(sampleMessageRow({
      id: 4243, folder: 'inbox', fetchedBodyAt: '2026-07-01T00:00:00Z',
    }));
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null, recipients: [], folder: { id: 1, name: 'Inbox' },
    });

    const { items } = await probeIds(client, cache, [4243], { allowMarkRead: false });
    expect(items[0]).toMatchObject({ id: 4243, state: 'received', inSync: null });
    expect(items[0].note).toMatch(/is an inbox message on OurFamilyWizard/);
  });

  it('reports a sent message that was never a cached draft without draft-specific wording', async () => {
    seedFolderIds();
    await cache.upsertMessage(sampleMessageRow({ id: 4244, folder: 'sent' }));
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null, recipients: [],
      folder: { id: 2, name: 'Sent Messages' },
    });

    const { items } = await probeIds(client, cache, [4244], { allowMarkRead: false });
    expect(items[0].note).toMatch(/is a sent message on OurFamilyWizard/);
  });

  it('reports a deleted draft as state:"deleted"', async () => {
    seedFolderIds();
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 404 Not Found'));

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });
    expect(items[0]).toMatchObject({
      id: 500, state: 'deleted', existsOnServer: false, inSync: false, serverRevision: null,
    });
    expect(items[0].note).toMatch(/NO LONGER EXISTS/);
  });

  it('reports "deleted" without the draft-specific wording for an uncached id', async () => {
    seedFolderIds();
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 404 Not Found'));

    const { items } = await probeIds(client, cache, [4242], { allowMarkRead: true });
    expect(items[0]).toMatchObject({ id: 4242, state: 'deleted', inSync: null });
    expect(items[0].note).toBe('Not found on OurFamilyWizard.');
  });

  it('surfaces content drift AND an unmappable folder together — neither swallows the other', async () => {
    // No folder ids seeded and the resolve fails, so the state is genuinely
    // unresolved; the content comparison is still valid and must survive.
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockRejectedValueOnce(new Error('OFW API error: 503'))       // folder resolve
      .mockResolvedValueOnce({ subject: 'S', body: 'EDITED', replyToId: null, recipients: [] });

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });

    expect(items[0].state).toBe('unknown');
    expect(items[0].inSync).toBe(false);
    expect(items[0].note).toMatch(/did not report a folder/);
    expect(items[0].note).toMatch(/edited on OurFamilyWizard/);
  });

  it('leaves inSync null when the content matches but the state is unresolved', async () => {
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockRejectedValueOnce(new Error('OFW API error: 503'))
      .mockResolvedValueOnce({ subject: 'S', body: 'B', replyToId: null, recipients: [] });

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });
    expect(items[0].state).toBe('unknown');
    // Not `true` — the content agreeing proves nothing about whether it is
    // still a draft, which is the question being asked.
    expect(items[0].inSync).toBeNull();
  });

  it('names the folder OFW reported when it cannot be mapped', async () => {
    seedFolderIds();
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null, recipients: [],
      folder: { id: 77, name: 'Archive' },
    });

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });
    expect(items[0].note).toMatch(/reported "Archive"/);
  });

  it('turns a failed probe into an error item rather than an in-sync verdict', async () => {
    seedFolderIds();
    await cache.upsertDraft(draftRow);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 503'));

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });
    expect(items[0]).toMatchObject({ id: 500, error: 'FRESHNESS_CHECK_FAILED', inSync: null });
    expect(items[0].state).toBeUndefined();
  });

  it('carries the draftKey when the id belongs to a known chain', async () => {
    seedFolderIds();
    await cache.upsertDraft(draftRow);
    await cache.recordDraftLineage({ id: 500, draftKey: 'dk_z', previousId: null, recordedAt: '2026-07-01T00:00:00Z' });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null, recipients: [], folder: { id: 3, name: 'Drafts' },
    });

    const { items } = await probeIds(client, cache, [500], { allowMarkRead: false });
    expect(items[0]).toMatchObject({ id: 500, state: 'draft', inSync: true, draftKey: 'dk_z' });
  });

  it('surfaces a recipient view timestamp', async () => {
    seedFolderIds();
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'S', body: 'B', replyToId: null,
      recipients: [
        { user: { userId: 7, name: 'Co-parent' }, viewed: { dateTime: '1970-01-01T00:00:00' } },
        { user: { userId: 8, name: 'Other' }, viewed: { dateTime: '2026-07-28T09:00:00' } },
      ],
      folder: { id: 2, name: 'Sent Messages' },
    });

    const { items } = await probeIds(client, cache, [4242], { allowMarkRead: true });
    // The epoch placeholder is not a view time; the real one is.
    expect(items[0].viewedAt).toBe('2026-07-28T09:00:00');
  });

  it('probes nothing for an empty id list', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    expect(await probeIds(client, cache, [], { allowMarkRead: false })).toEqual({ items: [], requests: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});
