import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFWClient } from '../src/client.js';
import {
  closeCache, getMeta, getMessage, listMessages, getSyncState, upsertMessage,
  getDraft, listDraftIds, upsertDraft,
  listAttachmentsForMessage,
} from '../src/cache.js';
import { resolveFolderIds, syncMessageFolder, syncDrafts, syncAll } from '../src/sync.js';

let tmp: string;
let originalCacheDir: string | undefined;
let originalUsername: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ofw-sync-'));
  originalCacheDir = process.env.OFW_CACHE_DIR;
  originalUsername = process.env.OFW_USERNAME;
  process.env.OFW_CACHE_DIR = tmp;
  process.env.OFW_USERNAME = 'test@example.com';
});

afterEach(() => {
  closeCache();
  vi.restoreAllMocks();
  if (originalCacheDir === undefined) delete process.env.OFW_CACHE_DIR;
  else process.env.OFW_CACHE_DIR = originalCacheDir;
  if (originalUsername === undefined) delete process.env.OFW_USERNAME;
  else process.env.OFW_USERNAME = originalUsername;
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveFolderIds', () => {
  it('queries OFW once and returns inbox/sent/drafts IDs', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue({
      systemFolders: [
        { id: '111', folderType: 'INBOX', name: 'Inbox' },
        { id: '222', folderType: 'SENT_MESSAGES', name: 'Sent' },
        { id: '333', folderType: 'DRAFTS', name: 'Drafts' },
        { id: '444', folderType: 'ARCHIVE', name: 'Archive' },
      ],
      userFolders: [],
    });

    const ids = await resolveFolderIds(client);

    expect(ids).toEqual({ inbox: '111', sent: '222', drafts: '333' });
    expect(spy).toHaveBeenCalledWith('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('persists the drafts folder id into meta', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      systemFolders: [
        { id: '111', folderType: 'INBOX', name: 'Inbox' },
        { id: '222', folderType: 'SENT_MESSAGES', name: 'Sent' },
        { id: '333', folderType: 'DRAFTS', name: 'Drafts' },
      ],
    });

    await resolveFolderIds(client);
    expect(getMeta('drafts_folder_id')).toBe('333');
  });

  it('throws if a required system folder is missing', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      systemFolders: [{ id: '111', folderType: 'INBOX', name: 'Inbox' }],
    });

    await expect(resolveFolderIds(client)).rejects.toThrow(/SENT_MESSAGES|DRAFTS/);
  });
});

function listResponse(items: Array<{ id: number; subject?: string; from?: string; sentAt?: string; unread?: boolean }>): unknown {
  return {
    data: items.map((it) => ({
      id: it.id,
      subject: it.subject ?? `Subject ${it.id}`,
      from: { name: it.from ?? 'Alice' },
      date: { dateTime: it.sentAt ?? '2026-05-04T12:00:00Z' },
      showNeverViewed: it.unread ?? false,
      recipients: [{ user: { id: 1, name: 'Bob' }, viewed: it.unread ? null : { dateTime: '2026-05-04T13:00:00Z' } }],
    })),
  };
}

describe('syncMessageFolder', () => {
  it('initial sync of sent folder fetches bodies eagerly', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(listResponse([{ id: 1 }, { id: 2 }]))
      .mockResolvedValueOnce({ body: 'body-1' })
      .mockResolvedValueOnce({ body: 'body-2' })
      .mockResolvedValueOnce(listResponse([])); // page 2 empty

    const result = await syncMessageFolder(client, 'sent', '222', { fetchUnreadBodies: false });

    expect(result.synced).toBe(2);
    expect(getMessage(1)?.body).toBe('body-1');
    expect(getMessage(2)?.body).toBe('body-2');
    // Loose-match on the query string — exact order/format isn't a contract
    // we want to lock down in tests; only the meaningful params are.
    expect(spy).toHaveBeenCalledWith('GET', expect.stringMatching(/^\/pub\/v3\/messages\?.*folders=222.*page=1.*size=50/));
  });

  it('initial sync of inbox fetches bodies for read but not unread', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(listResponse([
        { id: 1, unread: false },
        { id: 2, unread: true },
      ]))
      .mockResolvedValueOnce({ body: 'body-1' })
      .mockResolvedValueOnce(listResponse([])); // page 2 empty

    const result = await syncMessageFolder(client, 'inbox', '111', { fetchUnreadBodies: false });

    expect(result.synced).toBe(2);
    expect(result.unread).toEqual([
      { id: 2, subject: 'Subject 2', from: 'Alice', sentAt: '2026-05-04T12:00:00Z' },
    ]);
    expect(getMessage(1)?.body).toBe('body-1');
    expect(getMessage(2)?.body).toBeNull();
    const detailCalls = spy.mock.calls.filter((c) => /\/pub\/v3\/messages\/[0-9]+$/.test(c[1] as string));
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0][1]).toBe('/pub/v3/messages/1');
  });

  it('fetchUnreadBodies=true also fetches unread bodies', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(listResponse([{ id: 1, unread: true }, { id: 2, unread: true }]))
      .mockResolvedValueOnce({ body: 'body-1' })
      .mockResolvedValueOnce({ body: 'body-2' })
      .mockResolvedValueOnce(listResponse([]));

    const result = await syncMessageFolder(client, 'inbox', '111', { fetchUnreadBodies: true });

    expect(result.unread).toEqual([]);
    expect(getMessage(1)?.body).toBe('body-1');
    expect(getMessage(2)?.body).toBe('body-2');
  });

  it('incremental sync stops on first page with zero new ids', async () => {
    // Cache has the most-recent N items already.
    upsertMessage({
      id: 5, folder: 'inbox', subject: 'old5', fromUser: 'A', sentAt: '2026-05-05T00:00:00Z',
      recipients: [], body: 'b5', fetchedBodyAt: '2026-05-05T00:00:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 4, folder: 'inbox', subject: 'old4', fromUser: 'A', sentAt: '2026-05-04T00:00:00Z',
      recipients: [], body: 'b4', fetchedBodyAt: '2026-05-04T00:00:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      // page 1: one new + one cached
      .mockResolvedValueOnce(listResponse([{ id: 6, unread: false, sentAt: '2026-05-06T00:00:00Z' }, { id: 5, unread: false }]))
      .mockResolvedValueOnce({ body: 'body-6' })
      // page 2: only the other cached item — zero new → stop
      .mockResolvedValueOnce(listResponse([{ id: 4, unread: false }]));

    const result = await syncMessageFolder(client, 'inbox', '111', { fetchUnreadBodies: false });

    expect(result.synced).toBe(1);
    expect(getMessage(6)?.body).toBe('body-6');
    const detailCalls = spy.mock.calls.filter((c) => /\/pub\/v3\/messages\/[0-9]+$/.test(c[1] as string));
    expect(detailCalls.map((c) => c[1])).toEqual(['/pub/v3/messages/6']);
    // Walked exactly two list pages: stopped on page 2 because it had no new items.
    const listCalls = spy.mock.calls.filter((c) => /\/pub\/v3\/messages\?/.test(c[1] as string));
    expect(listCalls).toHaveLength(2);
  });

  it('walks past pages with cached items mixed in (gap recovery)', async () => {
    // Simulates an ad-hoc cached old item creating a "gap" between recent
    // history and that one cached item. The sync should walk past it and
    // continue until a page has no new items.
    upsertMessage({
      id: 50, folder: 'inbox', subject: 'old', fromUser: 'A', sentAt: '2026-03-01T00:00:00Z',
      recipients: [], body: 'cached', fetchedBodyAt: null,
      replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    vi.spyOn(client, 'request')
      // page 1: new + the cached old item interleaved
      .mockResolvedValueOnce(listResponse([{ id: 100, unread: false }, { id: 50, unread: false }]))
      .mockResolvedValueOnce({ body: 'body-100' })
      // page 2: another new item below — would be MISSED by old early-stop logic
      .mockResolvedValueOnce(listResponse([{ id: 49, unread: false }]))
      .mockResolvedValueOnce({ body: 'body-49' })
      // page 3: empty
      .mockResolvedValueOnce(listResponse([]));

    const result = await syncMessageFolder(client, 'inbox', '111', { fetchUnreadBodies: false });

    expect(result.synced).toBe(2);
    expect(getMessage(100)?.body).toBe('body-100');
    expect(getMessage(49)?.body).toBe('body-49');
  });

  it('deep:true walks every page even when no new items appear', async () => {
    upsertMessage({
      id: 1, folder: 'inbox', subject: 'cached', fromUser: 'A', sentAt: '2026-05-01T00:00:00Z',
      recipients: [], body: 'b', fetchedBodyAt: null,
      replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(listResponse([{ id: 1, unread: false }]))
      .mockResolvedValueOnce(listResponse([{ id: 2, unread: false, sentAt: '2026-04-30T00:00:00Z' }]))
      .mockResolvedValueOnce({ body: 'body-2' })
      .mockResolvedValueOnce(listResponse([])); // empty

    const result = await syncMessageFolder(client, 'inbox', '111', { fetchUnreadBodies: false, deep: true });

    expect(result.synced).toBe(1);
    expect(getMessage(2)?.body).toBe('body-2');
    // With deep:true, walked all the way to the empty page (3 list calls).
    const listCalls = spy.mock.calls.filter((c) => /\/pub\/v3\/messages\?/.test(c[1] as string));
    expect(listCalls).toHaveLength(3);
  });

  it('walks forward when page 1 has all-new ids', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(listResponse([{ id: 3 }, { id: 2 }]))
      .mockResolvedValueOnce({ body: 'body-3' })
      .mockResolvedValueOnce({ body: 'body-2' })
      .mockResolvedValueOnce(listResponse([{ id: 1 }]))
      .mockResolvedValueOnce({ body: 'body-1' })
      .mockResolvedValueOnce(listResponse([])); // empty page 3

    const result = await syncMessageFolder(client, 'sent', '222', { fetchUnreadBodies: false });

    expect(result.synced).toBe(3);
    expect(listMessages({ folder: 'sent', page: 1, size: 50 }).map((m) => m.id)).toEqual([3, 2, 1]);
  });

  it('fetches attachment metadata for messages with files', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      // page 1: one message with files
      .mockResolvedValueOnce({
        data: [{
          id: 100, subject: 'with attachment',
          from: { name: 'Alice' }, date: { dateTime: '2026-05-13T12:00:00Z' },
          showNeverViewed: false, recipients: [],
        }],
      })
      // body fetch — includes files array
      .mockResolvedValueOnce({ body: 'see attached', files: [55] })
      // per-file metadata fetch
      .mockResolvedValueOnce({
        fileId: 55, fileName: 'doc.pdf', label: 'doc',
        fileType: 'application/pdf', fileSize: 1024,
      })
      // page 2: empty
      .mockResolvedValueOnce({ data: [] });

    const result = await syncMessageFolder(client, 'inbox', '111', { fetchUnreadBodies: false });
    expect(result.synced).toBe(1);

    const atts = listAttachmentsForMessage(100);
    expect(atts).toHaveLength(1);
    expect(atts[0].fileId).toBe(55);
    expect(atts[0].fileName).toBe('doc.pdf');
    expect(atts[0].mimeType).toBe('application/pdf');
    expect(atts[0].sizeBytes).toBe(1024);
  });

  it('handles messages where OFW omits date.dateTime (regression)', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        data: [{
          id: 99,
          subject: 'missing date',
          from: { name: 'Alice' },
          // NOTE: date is missing
          showNeverViewed: false,
          recipients: [],
        }],
      })
      .mockResolvedValueOnce({ body: 'body-99' })
      .mockResolvedValueOnce(listResponse([]));

    const result = await syncMessageFolder(client, 'sent', '222', { fetchUnreadBodies: false });
    expect(result.synced).toBe(1);
    expect(getMessage(99)?.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('updates sync_state with newest id and timestamp', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(listResponse([{ id: 5 }, { id: 4 }]))
      .mockResolvedValueOnce({ body: 'body-5' })
      .mockResolvedValueOnce({ body: 'body-4' })
      .mockResolvedValueOnce(listResponse([]));

    await syncMessageFolder(client, 'sent', '222', { fetchUnreadBodies: false });
    const state = getSyncState('sent');
    expect(state?.newestId).toBe(5);
    expect(state?.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

function draftListResponse(items: Array<{ id: number; subject?: string; modifiedAt?: string; replyToId?: number | null }>): unknown {
  return {
    data: items.map((it) => ({
      id: it.id,
      subject: it.subject ?? `Draft ${it.id}`,
      date: { dateTime: it.modifiedAt ?? '2026-05-04T12:00:00Z' },
      replyToId: it.replyToId ?? null,
      recipients: [],
    })),
  };
}

describe('syncDrafts', () => {
  it('inserts new drafts with bodies', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(draftListResponse([{ id: 1 }, { id: 2 }]))
      .mockResolvedValueOnce({ body: 'draft-1', subject: 'Draft 1', recipientIds: [] })
      .mockResolvedValueOnce({ body: 'draft-2', subject: 'Draft 2', recipientIds: [] });

    const result = await syncDrafts(client, '333');

    expect(result.synced).toBe(2);
    expect(getDraft(1)?.body).toBe('draft-1');
    expect(getDraft(2)?.body).toBe('draft-2');
  });

  it('deletes cached drafts no longer present in OFW', async () => {
    upsertDraft({
      id: 99, subject: 'Stale', body: 'gone',
      recipients: [], replyToId: null,
      modifiedAt: '2026-05-01T00:00:00Z', listData: {},
    });

    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(draftListResponse([{ id: 1 }]))
      .mockResolvedValueOnce({ body: 'draft-1', subject: 'Draft 1', recipientIds: [] });

    await syncDrafts(client, '333');

    expect(getDraft(99)).toBeNull();
    expect(listDraftIds()).toEqual([1]);
  });

  it('updates a changed draft (different modifiedAt)', async () => {
    upsertDraft({
      id: 1, subject: 'Old', body: 'old-body',
      recipients: [], replyToId: null,
      modifiedAt: '2026-05-01T00:00:00Z', listData: {},
    });

    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(draftListResponse([{ id: 1, subject: 'New', modifiedAt: '2026-05-04T00:00:00Z' }]))
      .mockResolvedValueOnce({ body: 'new-body', subject: 'New', recipientIds: [] });

    await syncDrafts(client, '333');

    const got = getDraft(1);
    expect(got?.subject).toBe('New');
    expect(got?.body).toBe('new-body');
    expect(got?.modifiedAt).toBe('2026-05-04T00:00:00Z');
  });

  it('handles drafts where OFW omits replyToId (regression for SQLite param-5 bind error)', async () => {
    // OFW occasionally returns drafts without a replyToId field at all.
    // upsertDraft must accept that (treat as null) — previously this raised
    // "Provided value cannot be bound to SQLite parameter 5".
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        data: [{
          id: 1,
          subject: 'Draft no replyToId',
          date: { dateTime: '2026-05-06T00:00:00Z' },
          // NOTE: no replyToId field
          recipients: [],
        }],
      })
      .mockResolvedValueOnce({ body: 'body', subject: 'Draft no replyToId', recipientIds: [] });

    const result = await syncDrafts(client, '333');
    expect(result.synced).toBe(1);
    expect(getDraft(1)?.replyToId).toBeNull();
  });

  it('handles drafts where OFW omits the date field entirely', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        data: [{ id: 1, subject: 'no date', replyToId: null, recipients: [] }],
      })
      .mockResolvedValueOnce({ body: 'b', subject: 'no date', recipientIds: [] });

    const result = await syncDrafts(client, '333');
    expect(result.synced).toBe(1);
    expect(getDraft(1)?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('always refetches detail even when the list modifiedAt is unchanged (OFW list date.dateTime does not reflect UI edits)', async () => {
    upsertDraft({
      id: 1, subject: 'Same', body: 'stale-body',
      recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T00:00:00Z', listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(draftListResponse([{ id: 1, subject: 'Same', modifiedAt: '2026-05-04T00:00:00Z' }]))
      .mockResolvedValueOnce({ body: 'fresh-body', subject: 'Same', recipientIds: [] });

    const result = await syncDrafts(client, '333');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]).toEqual(['GET', '/pub/v3/messages/1']);
    expect(getDraft(1)?.body).toBe('fresh-body');
    // synced counts as 1 because the body actually changed
    expect(result.synced).toBe(1);
  });

  it('does not count unchanged drafts toward synced even though it refetches them', async () => {
    upsertDraft({
      id: 1, subject: 'Same', body: 'same-body',
      recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T00:00:00Z', listData: {},
    });

    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(draftListResponse([{ id: 1, subject: 'Same', modifiedAt: '2026-05-04T00:00:00Z' }]))
      .mockResolvedValueOnce({ body: 'same-body', subject: 'Same', recipientIds: [] });

    const result = await syncDrafts(client, '333');
    expect(result.synced).toBe(0);
  });
});

function foldersResponse() {
  return {
    systemFolders: [
      { id: '111', folderType: 'INBOX', name: 'Inbox' },
      { id: '222', folderType: 'SENT_MESSAGES', name: 'Sent' },
      { id: '333', folderType: 'DRAFTS', name: 'Drafts' },
    ],
  };
}

describe('syncAll', () => {
  it('runs all three folders by default and aggregates counts', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      // resolveFolderIds
      .mockResolvedValueOnce(foldersResponse())
      // inbox: page 1 with 1 read item, body, then empty
      .mockResolvedValueOnce(listResponse([{ id: 10, unread: false }]))
      .mockResolvedValueOnce({ body: 'inbox-10' })
      .mockResolvedValueOnce(listResponse([]))
      // sent: page 1 with 1 item, body, then empty
      .mockResolvedValueOnce(listResponse([{ id: 20 }]))
      .mockResolvedValueOnce({ body: 'sent-20' })
      .mockResolvedValueOnce(listResponse([]))
      // drafts: page 1 with 1 item + body
      .mockResolvedValueOnce(draftListResponse([{ id: 30 }]))
      .mockResolvedValueOnce({ body: 'draft-30', subject: 'Draft 30', recipientIds: [] });

    const result = await syncAll(client, {});

    expect(result.synced).toEqual({ inbox: 1, sent: 1, drafts: 1 });
    expect(result.unreadInbox).toEqual([]);
  });

  it('returns unreadInbox when fetchUnreadBodies is false (default)', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(foldersResponse())
      .mockResolvedValueOnce(listResponse([{ id: 10, unread: true }]))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(draftListResponse([]));

    const result = await syncAll(client, {});

    expect(result.unreadInbox).toEqual([
      { id: 10, subject: 'Subject 10', from: 'Alice', sentAt: '2026-05-04T12:00:00Z' },
    ]);
    expect(result.note).toMatch(/unread inbox/);
  });

  it('respects an explicit folders subset', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(foldersResponse())
      .mockResolvedValueOnce(draftListResponse([]));

    const result = await syncAll(client, { folders: ['drafts'] });

    expect(result.synced).toEqual({ drafts: 0 });
    const inboxCalls = spy.mock.calls.filter((c) => (c[1] as string).includes('folders=111'));
    const sentCalls = spy.mock.calls.filter((c) => (c[1] as string).includes('folders=222'));
    expect(inboxCalls).toHaveLength(0);
    expect(sentCalls).toHaveLength(0);
  });
});
