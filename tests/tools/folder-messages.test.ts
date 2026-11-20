import { describe, it, expect, vi } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { fetchFolderPage, folderMessageBrief, getFolderSighting, recordFolderSightings, resolveMessageFolder, sightingGateRow } from '../../src/tools/folder-messages.js';
import { OFWCache } from '../../src/cache/node.js';
import { deriveRead } from '../../src/tools/_shared.js';

// The live /pub/v1/messageFolders shape (verified 2026-11-19): numeric ids,
// `systemFolders` + `userFolders`. Placeholder ids and names only.
const FOLDERS = {
  systemFolders: [
    { id: 101, name: 'Inbox', folderType: 'INBOX' },
    { id: 102, name: 'Action Items', folderType: 'ACTION_ITEMS' },
    { id: 103, name: 'Drafts', folderType: 'DRAFTS' },
    { id: 104, name: 'Sent', folderType: 'SENT_MESSAGES' },
    { id: 105, name: 'Archived', folderType: 'TRASH' },
    { id: -1, name: 'All Messages', folderType: 'ALL_CORRESPONDENCE' },
  ],
  userFolders: [
    { id: 201, name: 'School', folderType: 'USER_DEFINED' },
    { id: 202, name: 'Medical' },
  ],
};

function clientReturning(...values: unknown[]): OFWClient {
  const c = new OFWClient();
  const spy = vi.spyOn(c, 'request');
  for (const v of values) spy.mockResolvedValueOnce(v);
  return c;
}

describe('resolveMessageFolder', () => {
  it('maps the inbox and sent system folders onto the cached folders', async () => {
    expect(await resolveMessageFolder(clientReturning(FOLDERS), '101')).toEqual({ kind: 'cached', folder: 'inbox' });
    expect(await resolveMessageFolder(clientReturning(FOLDERS), 'sent')).toEqual({ kind: 'cached', folder: 'sent' });
  });

  it('routes the drafts folder to the drafts tool', async () => {
    expect(await resolveMessageFolder(clientReturning(FOLDERS), '103')).toEqual({ kind: 'drafts' });
  });

  it('resolves a user folder by id', async () => {
    const c = clientReturning(FOLDERS);
    expect(await resolveMessageFolder(c, '201')).toEqual({
      kind: 'live', folder: { id: '201', name: 'School', folderType: 'USER_DEFINED', user: true },
    });
    expect(c.request).toHaveBeenCalledWith('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
  });

  it('resolves a folder by name, case-insensitively and trimmed', async () => {
    expect(await resolveMessageFolder(clientReturning(FOLDERS), '  medical ')).toEqual({
      kind: 'live', folder: { id: '202', name: 'Medical', folderType: null, user: true },
    });
    expect(await resolveMessageFolder(clientReturning(FOLDERS), 'archived')).toEqual({
      kind: 'live', folder: { id: '105', name: 'Archived', folderType: 'TRASH', user: false },
    });
  });

  it('accepts string ids too', async () => {
    const c = clientReturning({ systemFolders: [], userFolders: [{ id: '301', name: 'X' }] });
    expect(await resolveMessageFolder(c, '301')).toEqual({
      kind: 'live', folder: { id: '301', name: 'X', folderType: null, user: true },
    });
  });

  it('reports an unknown folder with every folder it could have meant', async () => {
    const r = await resolveMessageFolder(clientReturning(FOLDERS), '999');
    expect(r.kind).toBe('unknown');
    if (r.kind !== 'unknown') throw new Error('unreachable');
    expect(r.available.map((f) => f.id)).toEqual(['101', '102', '103', '104', '105', '-1', '201', '202']);
    expect(r.ambiguous).toBe(false);
  });

  it('refuses a name two folders share rather than picking one', async () => {
    const c = clientReturning({
      systemFolders: [],
      userFolders: [{ id: 1, name: 'Dup' }, { id: 2, name: 'dup' }],
    });
    const r = await resolveMessageFolder(c, 'DUP');
    expect(r).toMatchObject({ kind: 'unknown', ambiguous: true });
    if (r.kind !== 'unknown') throw new Error('unreachable');
    expect(r.available.map((f) => f.id)).toEqual(['1', '2']);
  });

  it('tolerates a payload with no folder arrays and skips entries with no id', async () => {
    expect(await resolveMessageFolder(clientReturning(null), '1')).toEqual({ kind: 'unknown', available: [], ambiguous: false });
    const r = await resolveMessageFolder(clientReturning({ userFolders: [{ name: 'no id' }, { id: 7 }] }), '7');
    expect(r).toEqual({ kind: 'live', folder: { id: '7', name: null, folderType: null, user: true } });
  });
});

// A list item as /pub/v3/messages returns it. Placeholders only.
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    subject: 'Field trip form',
    date: { dateTime: '2026-11-02T18:30:00' },
    author: { name: 'Parent A' },
    showNeverViewed: false,
    read: true,
    replied: false,
    files: 2,
    preview: 'first lines of the body',
    recipients: [{ user: { userId: 2000001, name: 'Parent B' }, viewed: { dateTime: '1970-01-01T00:00:00' } }],
    ...over,
  };
}

describe('fetchFolderPage', () => {
  const folder = { id: '201', name: 'School', folderType: null, user: true };

  it('fetches one list page newest-first and never a body', async () => {
    const c = clientReturning({ data: [item()] });
    const r = await fetchFolderPage(c, folder, { page: 2, size: 25, sort: 'newest', checkedAt: '2026-11-19T00:00:00.000Z' });
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(c.request).toHaveBeenCalledWith('GET', '/pub/v3/messages?folders=201&page=2&size=25&sort=date&sortDirection=desc');
    expect(r.returned).toBe(1);
    expect(r.messages[0]).toEqual({
      id: 5001,
      folderId: '201',
      folderName: 'School',
      subject: 'Field trip form',
      from: 'Parent A',
      sentAt: '2026-11-02T18:30:00',
      recipients: [{ userId: 2000001, name: 'Parent B', viewedAt: null, viewedAtSource: 'list', viewedPlaceholder: '1970-01-01T00:00:00' }],
      read: true,
      replied: false,
      files: 2,
    });
    // No body, no preview: a list read must never carry message content.
    expect(JSON.stringify(r.messages)).not.toContain('first lines');
  });

  it('sorts oldest-first on request and encodes the folder id', async () => {
    const c = clientReturning({ data: [] });
    await fetchFolderPage(c, { ...folder, id: '-1' }, { page: 1, size: 50, sort: 'oldest', checkedAt: 'x' });
    expect(c.request).toHaveBeenCalledWith('GET', '/pub/v3/messages?folders=-1&page=1&size=50&sort=date&sortDirection=asc');
  });

  it('keeps unknowns unknown: no read flag, sender, files or date', async () => {
    const c = clientReturning({ data: [item({ read: 'yes', author: undefined, from: undefined, files: undefined, replied: undefined, date: undefined, recipients: undefined })] });
    const [m] = (await fetchFolderPage(c, folder, { page: 1, size: 50, sort: 'newest', checkedAt: 'x' })).messages;
    expect(m.read).toBeNull();
    expect(m.from).toBeNull();
    expect(m.sentAt).toBeNull();
    expect(m.recipients).toEqual([]);
    expect('files' in m).toBe(false);
    expect('replied' in m).toBe(false);
  });

  it('falls back to from.name for the sender and counts a files array', async () => {
    const c = clientReturning({ data: [item({ author: { name: '' }, from: { name: 'Parent C' }, files: [9, 8, 7] })] });
    const [m] = (await fetchFolderPage(c, folder, { page: 1, size: 50, sort: 'newest', checkedAt: 'x' })).messages;
    expect(m.from).toBe('Parent C');
    expect(m.files).toBe(3);
  });

  it('full view keeps the list echo minus every copy of the body', async () => {
    const c = clientReturning({ data: [item({ body: 'whole body' })] });
    const r = await fetchFolderPage(c, folder, { page: 1, size: 50, sort: 'newest', checkedAt: 'x', full: true });
    const listData = r.messages[0].listData as Record<string, unknown>;
    expect(listData.subject).toBe('Field trip form');
    expect(listData).not.toHaveProperty('preview');
    expect(listData).not.toHaveProperty('body');
  });

  it('derives paging from OFW metadata first, then a total, then a full page', async () => {
    const opts = { page: 1, size: 2, sort: 'newest' as const, checkedAt: 'x' };
    const two = [item({ id: 1 }), item({ id: 2 })];
    expect(await fetchFolderPage(clientReturning({ data: two, metadata: { last: true } }), folder, opts))
      .toMatchObject({ hasMore: false, nextPage: null, total: null });
    expect(await fetchFolderPage(clientReturning({ data: two, metadata: { totalElements: 3 } }), folder, opts))
      .toMatchObject({ hasMore: true, nextPage: 2, total: 3 });
    expect(await fetchFolderPage(clientReturning({ data: two, metadata: { totalElements: 2 } }), folder, opts))
      .toMatchObject({ hasMore: false, nextPage: null, total: 2 });
    // No metadata: a full page probably means more (a wasted call beats a hidden page).
    expect(await fetchFolderPage(clientReturning({ data: two }), folder, opts))
      .toMatchObject({ hasMore: true, nextPage: 2, total: null });
    expect(await fetchFolderPage(clientReturning({ data: [item()] }), folder, opts))
      .toMatchObject({ hasMore: false, nextPage: null });
  });

  it('treats a payload with no data array as an empty page', async () => {
    const r = await fetchFolderPage(clientReturning({}), folder, { page: 1, size: 50, sort: 'newest', checkedAt: 'x' });
    expect(r).toMatchObject({ returned: 0, messages: [], hasMore: false });
  });

  it('skips list items with no numeric id rather than inventing one', async () => {
    const r = await fetchFolderPage(clientReturning({ data: [item({ id: 'abc' }), 'junk', item({ subject: undefined })] }), folder, { page: 1, size: 50, sort: 'newest', checkedAt: 'x' });
    expect(r.messages.map((m) => m.id)).toEqual([5001]);
    expect(r.messages[0].subject).toBe('');
    // `returned` is the record count; the dropped item is counted, not hidden.
    expect(r.returned).toBe(1);
    expect(r.skipped).toBe(2);
  });
});

describe('folderMessageBrief', () => {
  it('names the sender, the time and the list read state', () => {
    const line = folderMessageBrief({ id: 1, folderId: '201', folderName: 'School', subject: 'Hi', from: 'Parent A', sentAt: '2026-11-02T18:30:00', recipients: [], read: false }, 'America/New_York');
    expect(line).toBe('Parent A: Hi — 2026-11-02T18:30:00-05:00 — unread');
    expect(folderMessageBrief({ id: 1, folderId: '201', folderName: null, subject: 'Hi', from: null, sentAt: null, recipients: [], read: null }, 'America/New_York'))
      .toBe('Hi — no date — read state unknown');
    expect(folderMessageBrief({ id: 1, folderId: '201', folderName: null, subject: 'Hi', from: null, sentAt: null, recipients: [], read: true }, 'America/New_York'))
      .toBe('Hi — no date — read');
  });
});

describe('folder sightings', () => {
  const msg = (id: number, read: boolean | null) => ({
    id, folderId: '201', folderName: 'School', subject: `S${id}`, from: 'Parent A', sentAt: '2026-11-02T18:30:00', recipients: [], read,
  });

  it('records what a live folder page showed, per id, and reads it back', async () => {
    const store = OFWCache.open(':memory:');
    await recordFolderSightings(store, [msg(1, true), msg(2, false)], '2026-11-19T00:00:00.000Z');
    expect(await getFolderSighting(store, 2)).toEqual({
      folderId: '201', folderName: 'School', subject: 'S2', from: 'Parent A', sentAt: '2026-11-02T18:30:00', read: false,
      seenAt: '2026-11-19T00:00:00.000Z',
    });
    expect(await getFolderSighting(store, 3)).toBeNull();
  });

  it('treats a corrupt or foreign record as no sighting', async () => {
    const store = OFWCache.open(':memory:');
    await store.setMeta('folder_sighting:4', 'not json');
    await store.setMeta('folder_sighting:5', JSON.stringify({ folderId: 7 }));
    await store.setMeta('folder_sighting:6', JSON.stringify(null));
    expect(await getFolderSighting(store, 4)).toBeNull();
    expect(await getFolderSighting(store, 5)).toBeNull();
    expect(await getFolderSighting(store, 6)).toBeNull();
  });

  it('reads back a sighting with unknown name, sender, date and read flag', async () => {
    const store = OFWCache.open(':memory:');
    await store.setMeta('folder_sighting:8', JSON.stringify({ folderId: '201', subject: 'x', read: 'maybe' }));
    expect(await getFolderSighting(store, 8)).toEqual({
      folderId: '201', folderName: null, subject: 'x', from: null, sentAt: null, read: null, seenAt: null,
    });
  });

  it('gates as read ONLY when OFW said read:true — anything else fails closed to unread', () => {
    const s = { folderId: '201', folderName: 'School', subject: 'x', from: 'A', sentAt: '2026-11-02T18:30:00', seenAt: null };
    const readRow = sightingGateRow(9, { ...s, read: true });
    expect(readRow).toMatchObject({ id: 9, subject: 'x', fromUser: 'A', sentAt: '2026-11-02T18:30:00', body: null });
    expect(deriveRead(readRow)).toBe(true);
    expect(deriveRead(sightingGateRow(9, { ...s, read: false }))).toBe(false);
    expect(deriveRead(sightingGateRow(9, { ...s, read: null, from: null, sentAt: null }))).toBe(false);
    expect(sightingGateRow(9, { ...s, read: null, from: null, sentAt: null })).toMatchObject({ fromUser: '', sentAt: '(time unknown)' });
    expect(sightingGateRow(9, { ...s, read: false, folderName: null }).listData).toEqual({ read: false, sightedInFolder: '201' });
  });
});
