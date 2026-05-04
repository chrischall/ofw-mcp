import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFWClient } from '../src/client.js';
import {
  closeCache, getMeta, getMessage, listMessages, getSyncState, upsertMessage,
  getDraft, listDraftIds, upsertDraft,
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
    expect(spy).toHaveBeenCalledWith(
      'GET',
      '/pub/v3/messages?folders=222&page=1&size=50&sort=date&sortDirection=desc'
    );
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

  it('incremental sync stops on first page with no new ids', async () => {
    upsertMessage({
      id: 1, folder: 'inbox', subject: 'old', fromUser: 'A', sentAt: '2026-05-01T00:00:00Z',
      recipients: [], body: 'cached', fetchedBodyAt: '2026-05-01T00:00:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(listResponse([{ id: 2, unread: false }, { id: 1, unread: false }]))
      .mockResolvedValueOnce({ body: 'body-2' });

    const result = await syncMessageFolder(client, 'inbox', '111', { fetchUnreadBodies: false });

    expect(result.synced).toBe(1);
    expect(getMessage(2)?.body).toBe('body-2');
    const detailCalls = spy.mock.calls.filter((c) => /\/pub\/v3\/messages\/[0-9]+$/.test(c[1] as string));
    expect(detailCalls.map((c) => c[1])).toEqual(['/pub/v3/messages/2']);
    const listCalls = spy.mock.calls.filter((c) => /\/pub\/v3\/messages\?/.test(c[1] as string));
    expect(listCalls).toHaveLength(1);
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

  it('skips refetching a draft whose modifiedAt is unchanged', async () => {
    upsertDraft({
      id: 1, subject: 'Same', body: 'same-body',
      recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T00:00:00Z', listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(draftListResponse([{ id: 1, subject: 'Same', modifiedAt: '2026-05-04T00:00:00Z' }]));

    await syncDrafts(client, '333');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(getDraft(1)?.body).toBe('same-body');
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
