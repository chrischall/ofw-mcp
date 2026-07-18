import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import { NodeAttachmentIO } from '../../src/tools/attachments.js';
import { OFWCache } from '../../src/cache/node.js';
import type {
  CacheStore, MessageRow, DraftRow, UpsertAttachmentInput, AttachmentRow,
} from '../../src/cache/store.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let handlers: Map<string, ToolHandler>;
let tmpDir: string;

// The message tools take an injected async CacheStore + AttachmentIO. Tests
// back the cache with an in-memory `:memory:` OFWCache and drive the disk
// AttachmentIO against real tmp dirs, then seed/assert cache state through the
// synchronous OFWCacheCore (`cache.core`) so the existing test bodies stay
// synchronous.
let cache: OFWCache;
const cacheProvider = (): CacheStore => cache;
const attachmentIO = new NodeAttachmentIO();

// Synchronous cache helpers over the in-memory core — preserve the old
// free-function call sites in the test bodies.
const upsertMessage = (row: MessageRow): void => cache.core.upsertMessage(row);
const upsertDraft = (row: DraftRow): void => cache.core.upsertDraft(row);
const getMessage = (id: number): MessageRow | null => cache.core.getMessage(id);
const setMeta = (key: string, value: string): void => cache.core.setMeta(key, value);
const getDraft = (id: number): DraftRow | null => cache.core.getDraft(id);
const upsertAttachmentForMessage = (input: UpsertAttachmentInput): void => cache.core.upsertAttachmentForMessage(input);
const listAttachmentsForMessage = (messageId: number): AttachmentRow[] => cache.core.listAttachmentsForMessage(messageId);

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

function setup(client: OFWClient) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerMessageTools(server, client, cacheProvider, attachmentIO);
}

function setupWithClient(client: OFWClient): Map<string, ToolHandler> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const localHandlers = new Map<string, ToolHandler>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    localHandlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerMessageTools(server, client, cacheProvider, attachmentIO);
  return localHandlers;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ofw-tools-'));
  cache = OFWCache.open(':memory:');
});

afterEach(() => {
  cache.close();
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ofw_list_message_folders', () => {
  it('calls messageFolders with includeFolderCounts=true', async () => {
    const folders = [{ id: 1, name: 'Inbox', unreadCount: 2 }];
    const client = makeClient(folders);
    setup(client);

    const result = await handlers.get('ofw_list_message_folders')!({});

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/messageFolders?includeFolderCounts=true'
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(folders);
  });
});

describe('ofw_sync_messages', () => {
  it('syncs all folders by default and returns counts plus unread hint', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        systemFolders: [
          { id: '111', folderType: 'INBOX' },
          { id: '222', folderType: 'SENT_MESSAGES' },
          { id: '333', folderType: 'DRAFTS' },
        ],
      })
      .mockResolvedValueOnce({ data: [{
        id: 1, subject: 'New', from: { name: 'Alice' }, date: { dateTime: '2026-05-04T12:00:00Z' },
        showNeverViewed: true, recipients: [],
      }] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });

    setup(client);
    const result = await handlers.get('ofw_sync_messages')!({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.synced).toEqual({ inbox: 1, sent: 0, drafts: 0 });
    expect(parsed.unreadInbox).toHaveLength(1);
    expect(parsed.note).toMatch(/unread inbox/);
    // Unbounded by default (no OFW_SYNC_MAX_REQUESTS / maxRequests) → complete.
    expect(parsed.done).toBe(true);
  });

  it('honours a maxRequests budget: pauses with done:false and a continuation note', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        systemFolders: [
          { id: '111', folderType: 'INBOX' },
          { id: '222', folderType: 'SENT_MESSAGES' },
          { id: '333', folderType: 'DRAFTS' },
        ],
      })
      // inbox page 1 with two new items — the detail fetch is denied by the
      // budget (maxRequests=2: resolveFolderIds + one list page).
      .mockResolvedValueOnce({ data: [
        { id: 1, subject: 'A', from: { name: 'Alice' }, date: { dateTime: '2026-05-04T12:00:00Z' }, showNeverViewed: false, recipients: [] },
        { id: 2, subject: 'B', from: { name: 'Alice' }, date: { dateTime: '2026-05-04T12:00:00Z' }, showNeverViewed: false, recipients: [] },
      ] });

    setup(client);
    const result = await handlers.get('ofw_sync_messages')!({ folders: ['inbox'], deep: true, maxRequests: 2 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.done).toBe(false);
    expect(parsed.note).toMatch(/call ofw_sync_messages again/i);
  });
});

describe('ofw_list_messages (cache-backed)', () => {
  it('returns cached messages for the inbox folder name', async () => {
    upsertMessage({
      id: 1, folder: 'inbox', subject: 'Hi', fromUser: 'Alice',
      sentAt: '2026-05-04T12:00:00Z', recipients: [], body: 'b',
      fetchedBodyAt: '2026-05-04T12:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const result = await handlers.get('ofw_list_messages')!({ folderId: 'inbox' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].id).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns empty result with sync hint when cache is empty', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_messages')!({ folderId: 'inbox' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages).toEqual([]);
    expect(parsed.note).toMatch(/ofw_sync_messages/);
  });

  it('rejects numeric folder ids with a helpful note', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_messages')!({ folderId: '42' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toMatch(/inbox.*sent/);
  });

  it('filters by date range (since + until)', async () => {
    upsertMessage({
      id: 1, folder: 'inbox', subject: 'Feb msg', fromUser: 'A',
      sentAt: '2026-02-15T00:00:00Z', recipients: [], body: 'b',
      fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 2, folder: 'inbox', subject: 'Boston', fromUser: 'A',
      sentAt: '2026-03-01T09:48:58Z', recipients: [], body: 'b',
      fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 3, folder: 'inbox', subject: 'Apr msg', fromUser: 'A',
      sentAt: '2026-04-01T00:00:00Z', recipients: [], body: 'b',
      fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_messages')!({
      folderId: 'inbox', since: '2026-03-01', until: '2026-03-02',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].subject).toBe('Boston');
    expect(parsed.total).toBe(1);
  });

  it('searches by q across subject and body', async () => {
    upsertMessage({
      id: 1, folder: 'inbox', subject: 'May trip to Boston with the Boys',
      fromUser: 'A', sentAt: '2026-03-01T09:48:58Z',
      recipients: [], body: 'planning', fetchedBodyAt: null,
      replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 2, folder: 'sent', subject: 'unrelated subject',
      fromUser: 'Me', sentAt: '2026-03-10T00:00:00Z',
      recipients: [], body: 'I am taking the boys to Boston', fetchedBodyAt: null,
      replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 3, folder: 'inbox', subject: 'Other thread',
      fromUser: 'A', sentAt: '2026-03-20T00:00:00Z',
      recipients: [], body: 'not related', fetchedBodyAt: null,
      replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_messages')!({ q: 'Boston' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.total).toBe(2);
  });
});

describe('read-state reconciliation (bug: stale read flag vs viewedAt)', () => {
  // The reported record: an inbox message read via a body fetch, whose recipient
  // viewedAt is populated but whose once-scraped listData.read stayed false.
  const staleReadRow = (): MessageRow => ({
    id: 534973630, folder: 'inbox', subject: 'Re: Off-week message: 7/3 - 7/17',
    fromUser: 'Co-parent', sentAt: '2026-07-17T08:00:00',
    recipients: [{ userId: 3039201, name: 'Chris', viewedAt: '2026-07-17T08:37:57' }],
    body: 'body', fetchedBodyAt: '2026-07-17T12:37:57.957Z',
    replyToId: null, chainRootId: null,
    listData: { id: 534973630, read: false, showNeverViewed: true },
  });

  it('ofw_list_messages reports read:true once the message has been read on OFW', async () => {
    upsertMessage(staleReadRow());
    const client = new OFWClient();
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_list_messages')!({ folderId: 'inbox' })).content[0].text);
    const msg = parsed.messages[0];
    expect(msg.read).toBe(true);
    // and the raw listData flags no longer contradict the recipient viewedAt
    expect(msg.listData.read).toBe(true);
    expect(msg.listData.showNeverViewed).toBe(false);
    expect(msg.recipients[0].viewedAt).toBe('2026-07-17T08:37:57');
    // the real account-holder id survived normalization (was 0 before the fix)
    expect(msg.recipients[0].userId).toBe(3039201);
  });

  it('ofw_get_message reports read:true for the same record', async () => {
    upsertMessage(staleReadRow());
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_get_message')!({ messageId: '534973630' })).content[0].text);
    expect(parsed.read).toBe(true);
    expect(parsed.listData.showNeverViewed).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // inbox with a real view time isn't re-fetched
  });

  it('reports read:false for a genuinely unread inbox message', async () => {
    upsertMessage({
      id: 42, folder: 'inbox', subject: 'Unread', fromUser: 'Co-parent',
      sentAt: '2026-07-17T08:00:00',
      recipients: [{ userId: 3039201, name: 'Chris', viewedAt: null }],
      body: null, fetchedBodyAt: null, replyToId: null, chainRootId: null,
      listData: { id: 42, read: false, showNeverViewed: true },
    });
    const client = new OFWClient();
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_list_messages')!({ folderId: 'inbox' })).content[0].text);
    expect(parsed.messages[0].read).toBe(false);
    expect(parsed.messages[0].listData.showNeverViewed).toBe(true);
  });

  it('a resync of the stale list flags never flips a read message back to unread', async () => {
    // The cache holds a read message (viewedAt + fetchedBodyAt). A fresh sync
    // re-scrapes the list, which still carries the stale read:false / never-
    // viewed flags. Since read is derived from the persisted viewedAt /
    // fetchedBodyAt, the message stays read.
    upsertMessage(staleReadRow());
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockImplementation(async (method: string, path: string) => {
      if (path.includes('/pub/v1/messageFolders')) {
        return { systemFolders: [
          { id: '1', folderType: 'INBOX' }, { id: '2', folderType: 'SENT_MESSAGES' }, { id: '3', folderType: 'DRAFTS' },
        ] };
      }
      if (path.includes('folders=1')) {
        // OFW re-serves the message with its (still stale) list flags.
        return { data: [{
          id: 534973630, subject: 'Re: Off-week message: 7/3 - 7/17',
          from: { name: 'Co-parent' }, date: { dateTime: '2026-07-17T08:00:00' },
          read: false, showNeverViewed: true, recipients: [],
        }] };
      }
      return { data: [] };
    });
    setup(client);
    await handlers.get('ofw_sync_messages')!({});
    const parsed = JSON.parse((await handlers.get('ofw_list_messages')!({ folderId: 'inbox' })).content[0].text);
    expect(parsed.messages[0].read).toBe(true);
  });
});

describe('ofw_list_drafts (cache-backed)', () => {
  it('returns cached drafts', async () => {
    upsertDraft({
      id: 5, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);
    const result = await handlers.get('ofw_list_drafts')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.drafts).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns sync hint when empty', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_drafts')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.drafts).toEqual([]);
    expect(parsed.note).toMatch(/ofw_sync_messages/);
  });
});

describe('ofw_get_message (cache-first)', () => {
  it('returns cached message body without hitting OFW', async () => {
    upsertMessage({
      id: 42, folder: 'inbox', subject: 'Cached', fromUser: 'Alice',
      sentAt: '2026-05-04T12:00:00Z', recipients: [], body: 'cached-body',
      fetchedBodyAt: '2026-05-04T12:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '42' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.body).toBe('cached-body');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls through to OFW when row exists but body is NULL (lazy unread)', async () => {
    upsertMessage({
      id: 42, folder: 'inbox', subject: 'Unread', fromUser: 'Alice',
      sentAt: '2026-05-04T12:00:00Z', recipients: [], body: null,
      fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 42, body: 'fresh-body', subject: 'Unread', date: { dateTime: '2026-05-04T12:00:00Z' },
      from: { name: 'Alice' }, recipients: [],
    });
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '42' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.body).toBe('fresh-body');
    expect(getMessage(42)?.body).toBe('fresh-body');
  });

  it('falls through to OFW when row is missing entirely', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 99, body: 'fresh-body', subject: 'New', date: { dateTime: '2026-05-04T12:00:00Z' },
      from: { name: 'Alice' }, recipients: [],
    });
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: '99' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.body).toBe('fresh-body');
  });

  it('labels a live-fetched message "sent" when the detail folder id matches the persisted sent folder id', async () => {
    // Regression: previously a cache-miss live fetch hard-defaulted to 'inbox',
    // so a sent message came back mislabeled 'inbox' (and was then cached that
    // way, hiding it from ofw_get_unread_sent / a sent-scoped list).
    setMeta('sent_folder_id', '222');
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 490670431, subject: 'Re: Upcoming travel', body: 'flights booked',
      date: { dateTime: '2026-02-25T23:19:22Z' }, from: { name: 'Chris Hall' },
      recipients: [], folder: { id: 222, name: 'Sent' },
    });
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '490670431' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.folder).toBe('sent');
    expect(getMessage(490670431)?.folder).toBe('sent'); // cached with the right folder
  });

  it('labels a live-fetched message "inbox" when the detail folder id is not the sent folder', async () => {
    setMeta('sent_folder_id', '222');
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 700, subject: 'From co-parent', body: 'hi', date: { dateTime: '2026-02-25T00:00:00Z' },
      from: { name: 'Alison Hall' }, recipients: [], folder: { id: 111, name: 'Inbox' },
    });
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '700' });
    expect(JSON.parse(result.content[0].text).folder).toBe('inbox');
  });

  it('falls back to "inbox" when the detail omits a folder even though the sent id is known', async () => {
    setMeta('sent_folder_id', '222');
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 701, subject: 'No folder field', body: 'hi', date: { dateTime: '2026-02-25T00:00:00Z' },
      from: { name: 'Someone' }, recipients: [],
    });
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '701' });
    expect(JSON.parse(result.content[0].text).folder).toBe('inbox');
  });

  it('routes draft ids to the drafts cache (folder="drafts") even when the messages cache has a stale row for the same id', async () => {
    // This is the Bug 2 scenario: an earlier ofw_get_message call cached
    // the draft body as an inbox message. Then the user edits the draft
    // in the OFW UI; sync writes the new body to the drafts table. The
    // messages-table row is now stale. We must NOT return it.
    upsertMessage({
      id: 800, folder: 'inbox', subject: 'Stale subject', fromUser: '',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'OLD body',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null,
      listData: { date: { dateTime: '2026-05-01T00:00:00Z' } },
    });
    upsertDraft({
      id: 800, subject: 'Fresh subject', body: 'NEW body',
      recipients: [{ userId: 1, name: 'Co-parent', viewedAt: null }],
      replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z',
      listData: { date: { dateTime: '2026-05-04T12:00:00Z' } },
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '800' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.folder).toBe('drafts');
    expect(parsed.body).toBe('NEW body');
    expect(parsed.subject).toBe('Fresh subject');
    expect(parsed.fromUser).toBe('');
    expect(parsed.sentAt).toBe('2026-05-04T12:00:00Z');
    expect(parsed.fetchedBodyAt).toBe('2026-05-04T12:00:00Z');
    expect(parsed.chainRootId).toBeNull();
    // The drafts-table route doesn't hit OFW or the messages cache.
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns folder="drafts" even when no matching messages-table row exists', async () => {
    upsertDraft({
      id: 801, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z', listData: {},
    });
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: '801' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.folder).toBe('drafts');
    expect(parsed.body).toBe('b');
  });
});

// Helper: real OFW POST /pub/v3/messages returns a minimal `{entityId}`; the
// follow-up GET is what actually populates the cache. Most send_message tests
// just need a generic detail response to chain after the POST mock.
function sendMessageMocks(client: OFWClient, opts: {
  entityId: number;
  detail?: Partial<{
    subject: string; body: string;
    date: { dateTime: string }; from: { name: string };
    recipients: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
  }>;
}) {
  return vi.spyOn(client, 'request')
    .mockResolvedValueOnce({ entityId: opts.entityId })
    .mockResolvedValueOnce({
      id: opts.entityId,
      subject: opts.detail?.subject ?? 'subject',
      body: opts.detail?.body ?? 'body',
      date: opts.detail?.date ?? { dateTime: '2026-05-04T00:00:00Z' },
      from: opts.detail?.from ?? { name: 'Me' },
      recipients: opts.detail?.recipients ?? [],
    });
}

describe('ofw_send_message', () => {
  it('posts to /pub/v3/messages with correct payload', async () => {
    const client = new OFWClient();
    const spy = sendMessageMocks(client, { entityId: 200 });
    setup(client);

    const result = await handlers.get('ofw_send_message')!({
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
    });

    expect(spy).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: false,
      replyToId: null,
    });
    // After POST, we GET to populate the cache from authoritative state.
    expect(spy).toHaveBeenCalledWith('GET', '/pub/v3/messages/200');
    expect(getMessage(200)?.folder).toBe('sent');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it('does not delete a draft when draftId is not provided', async () => {
    const client = new OFWClient();
    const spy = sendMessageMocks(client, { entityId: 200 });
    setup(client);

    await handlers.get('ofw_send_message')!({
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
    });

    // POST + GET, no DELETE.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).not.toHaveBeenCalledWith('DELETE', expect.anything(), expect.anything());
  });

  it('sends reply with replyToId and includeOriginal true to thread message history', async () => {
    const client = new OFWClient();
    const spy = sendMessageMocks(client, { entityId: 201 });
    setup(client);

    await handlers.get('ofw_send_message')!({
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
      replyToId: 55,
    });

    expect(spy).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: true,
      replyToId: 55,
    });
  });

  it('deletes the draft after sending when draftId is provided', async () => {
    const c = new OFWClient();
    const spy = vi.spyOn(c, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'Hello', body: 'World',
        date: { dateTime: '2026-05-04T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});

    const localHandlers = setupWithClient(c);

    const result = await localHandlers.get('ofw_send_message')!({
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
      draftId: 42,
    });

    // POST + GET + DELETE
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenNthCalledWith(1, 'POST', '/pub/v3/messages', {
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: false,
      replyToId: null,
    });
    expect(spy).toHaveBeenNthCalledWith(2, 'GET', '/pub/v3/messages/200');
    expect(spy).toHaveBeenNthCalledWith(3, 'DELETE', '/pub/v1/messages', expect.any(FormData));
    const deleteForm = spy.mock.calls[2][2] as FormData;
    expect(deleteForm.get('messageIds')).toBe('42');
    expect(result.content[0].text).toContain('"id": 200');
  });
});

describe('ofw_send_message (thread-tip + cache write)', () => {
  it('rewrites replyToId to the latest sent reply in the chain', async () => {
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 142, folder: 'sent', subject: 'Re: Original', fromUser: 'Me',
      sentAt: '2026-05-02T00:00:00Z', recipients: [], body: 'first reply',
      fetchedBodyAt: '2026-05-02T00:01:00Z',
      replyToId: 100, chainRootId: 100, listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'Re: Original', body: 'second reply',
        date: { dateTime: '2026-05-03T00:00:00Z' }, from: { name: 'Me' },
        recipients: [{ user: { id: 1, name: 'Alice' }, viewed: null }],
      });
    setup(client);

    const result = await handlers.get('ofw_send_message')!({
      subject: 'Re: Original',
      body: 'second reply',
      recipientIds: [1],
      replyToId: 100,
    });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect(postCall).toBeDefined();
    expect((postCall![2] as { replyToId: number | null }).replyToId).toBe(142);
    expect(result.content[0].text).toMatch(/replyToId rewritten from 100 to 142/);

    const newRow = getMessage(200);
    expect(newRow?.chainRootId).toBe(100);
    expect(newRow?.replyToId).toBe(142);
    expect(newRow?.folder).toBe('sent');
    expect(newRow?.body).toBe('second reply');
  });

  it('does not rewrite when replyToId is the chain tip', async () => {
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'Re: Original', body: 'reply',
        date: { dateTime: '2026-05-03T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);

    const result = await handlers.get('ofw_send_message')!({
      subject: 'Re: Original', body: 'reply', recipientIds: [1], replyToId: 100,
    });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { replyToId: number }).replyToId).toBe(100);
    expect(result.content[0].text).not.toMatch(/rewritten/);
  });

  it('passes through replyToId unchanged when parent not in cache', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'Re: Unknown', body: 'reply',
        date: { dateTime: '2026-05-03T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);

    await handlers.get('ofw_send_message')!({
      subject: 'Re: Unknown', body: 'reply', recipientIds: [1], replyToId: 999,
    });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { replyToId: number }).replyToId).toBe(999);
  });

  it('removes draft from cache when draftId is provided', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'Re', body: 'b', date: { dateTime: '2026-05-03T00:00:00Z' },
        from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce(null);

    upsertDraft({
      id: 50, subject: 'Re', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-03T00:00:00Z', listData: {},
    });
    setup(client);

    await handlers.get('ofw_send_message')!({
      subject: 'Re', body: 'b', recipientIds: [1], draftId: 50,
    });

    expect(getDraft(50)).toBeNull();
  });

  it('falls back to data.id when OFW returns the legacy {id} shape on the POST response', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ id: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 's', body: 'b',
        date: { dateTime: '2026-05-03T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);
    await handlers.get('ofw_send_message')!({ subject: 's', body: 'b', recipientIds: [1] });
    expect(getMessage(200)?.folder).toBe('sent');
  });

  it('does not refetch or write cache when POST returns neither id nor entityId', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ error: 'boom' });
    setup(client);
    await handlers.get('ofw_send_message')!({ subject: 's', body: 'b', recipientIds: [1] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ofw_send_message with messageId (send-existing-draft)', () => {
  it('sends an existing draft by messageId alone, defaulting subject/body/recipientIds from the cached draft and deleting the draft after send', async () => {
    upsertDraft({
      id: 519117394,
      subject: 'Re: Weekly of 5/15 - 5/22',
      body: 'Hi Alison,\n\nI adjusted some account settings on my end.',
      recipients: [{ userId: 3039202, name: 'Alison', viewedAt: null }],
      replyToId: null,
      modifiedAt: '2026-05-27T12:00:00Z',
      listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 519117514 })
      .mockResolvedValueOnce({
        id: 519117514,
        subject: 'Re: Weekly of 5/15 - 5/22',
        body: 'Hi Alison,\n\nI adjusted some account settings on my end.',
        date: { dateTime: '2026-05-28T09:03:28Z' },
        from: { name: 'Me' },
        recipients: [{ user: { id: 3039202, name: 'Alison' }, viewed: null }],
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_send_message')!({ messageId: 519117394 });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect(postCall![2]).toEqual({
      subject: 'Re: Weekly of 5/15 - 5/22',
      body: 'Hi Alison,\n\nI adjusted some account settings on my end.',
      recipientIds: [3039202],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: false,
      replyToId: null,
    });

    const deleteCall = spy.mock.calls.find((c) => c[0] === 'DELETE');
    expect(deleteCall).toBeDefined();
    const form = deleteCall![2] as FormData;
    expect(form.get('messageIds')).toBe('519117394');

    expect(getDraft(519117394)).toBeNull();
    expect(getMessage(519117514)?.folder).toBe('sent');
    expect(result.content[0].text).toContain('"id": 519117514');
  });

  it('uses provided fields as overrides on top of the cached draft', async () => {
    upsertDraft({
      id: 50,
      subject: 'Cached subject',
      body: 'Cached body',
      recipients: [{ userId: 1, name: 'A', viewedAt: null }],
      replyToId: null,
      modifiedAt: '2026-05-01T00:00:00Z',
      listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 99 })
      .mockResolvedValueOnce({
        id: 99, subject: 'Overridden subject', body: 'Cached body',
        date: { dateTime: '2026-05-02T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    await handlers.get('ofw_send_message')!({ messageId: 50, subject: 'Overridden subject' });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    const sent = postCall![2] as { subject: string; body: string; recipientIds: number[] };
    expect(sent.subject).toBe('Overridden subject');
    expect(sent.body).toBe('Cached body');
    expect(sent.recipientIds).toEqual([1]);
  });

  it('errors clearly when messageId references a draft not in the cache and the missing fields are not supplied', async () => {
    const client = new OFWClient();
    // mockResolvedValue so a stray call (which the test asserts does not
    // happen) won't trigger real-network auth and confuse the failure.
    const spy = vi.spyOn(client, 'request').mockResolvedValue({});
    setup(client);

    await expect(handlers.get('ofw_send_message')!({ messageId: 99999 }))
      .rejects.toThrow(/draft 99999 not found/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('errors when neither messageId nor the required fields are provided', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue({});
    setup(client);

    await expect(handlers.get('ofw_send_message')!({}))
      .rejects.toThrow(/subject|body|recipient/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still accepts the legacy call shape (all three fields, no messageId)', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 700 })
      .mockResolvedValueOnce({
        id: 700, subject: 's', body: 'b',
        date: { dateTime: '2026-05-04T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);

    await handlers.get('ofw_send_message')!({ subject: 's', body: 'b', recipientIds: [1] });
    expect(spy).toHaveBeenCalledTimes(2); // POST + GET, no DELETE
  });

  it('errors when messageId and draftId are both set to different ids', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue({});
    setup(client);
    await expect(handlers.get('ofw_send_message')!({ messageId: 1, draftId: 2 }))
      .rejects.toThrow(/refer to different drafts/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('propagates the draft\'s replyToId so a reply-draft sent via messageId still threads', async () => {
    // The parent inbox message anchors the thread; the draft was saved as
    // a reply to it. Without propagation the sent message becomes a new
    // top-level conversation in OFW.
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    upsertDraft({
      id: 42,
      subject: 'Re: Original',
      body: 'reply body',
      recipients: [{ userId: 1, name: 'Alice', viewedAt: null }],
      replyToId: 100,
      modifiedAt: '2026-05-02T00:00:00Z',
      listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'Re: Original', body: 'reply body',
        date: { dateTime: '2026-05-03T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    await handlers.get('ofw_send_message')!({ messageId: 42 });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    const payload = postCall![2] as { replyToId: number | null; includeOriginal: boolean };
    expect(payload.replyToId).toBe(100);
    expect(payload.includeOriginal).toBe(true);
    expect(getMessage(200)?.replyToId).toBe(100);
    expect(getMessage(200)?.chainRootId).toBe(100);
  });

  it('caller-supplied replyToId still overrides the draft\'s replyToId', async () => {
    upsertDraft({
      id: 42, subject: 's', body: 'b',
      recipients: [{ userId: 1, name: 'A', viewedAt: null }],
      replyToId: 100,
      modifiedAt: '2026-05-02T00:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 's', body: 'b',
        date: { dateTime: '2026-05-03T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    await handlers.get('ofw_send_message')!({ messageId: 42, replyToId: 999 });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { replyToId: number | null }).replyToId).toBe(999);
  });
});

describe('ofw_save_draft', () => {
  it('creates a new draft without messageId', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 42 })                       // POST → new id
      .mockResolvedValueOnce({                                        // GET detail (faithful echo)
        id: 42, subject: 'Draft subject', body: 'Draft body',
        date: { dateTime: '2026-05-04T00:00:00Z' },
      });
    setup(client);

    const text = (await handlers.get('ofw_save_draft')!({
      subject: 'Draft subject',
      body: 'Draft body',
    })).content[0].text;

    expect(text).not.toContain('WARNING');
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Draft subject',
      body: 'Draft body',
      recipientIds: [],
      attachments: { myFileIDs: [] },
      draft: true,
      includeOriginal: false,
      replyToId: null,
    });
  });

  it('sets includeOriginal true when replyToId is provided', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 42 })                       // POST → new id
      .mockResolvedValueOnce({                                        // GET detail (faithful echo)
        id: 42, subject: 'Re: pickup', body: 'Draft reply body',
        date: { dateTime: '2026-05-04T00:00:00Z' }, replyToId: 55,
      });
    setup(client);

    const text = (await handlers.get('ofw_save_draft')!({
      subject: 'Re: pickup',
      body: 'Draft reply body',
      replyToId: 55,
    })).content[0].text;

    expect(text).not.toContain('WARNING');
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Re: pickup',
      body: 'Draft reply body',
      recipientIds: [],
      attachments: { myFileIDs: [] },
      draft: true,
      includeOriginal: true,
      replyToId: 55,
    });
  });

  it('replaces an existing draft via create-then-delete (messageId is NOT sent to OFW)', async () => {
    // OFW's POST /pub/v3/messages with messageId silently no-ops. We
    // sidestep the endpoint entirely: POST without messageId (creates a
    // new draft), then DELETE the old one.
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 1234 })                    // POST → new id
      .mockResolvedValueOnce({                                       // GET detail
        id: 1234, subject: 'Updated subject', body: 'Updated body',
        date: { dateTime: '2026-05-04T00:00:00Z' }, replyToId: 55,
      })
      .mockResolvedValueOnce({});                                    // DELETE old
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Updated subject',
      body: 'Updated body',
      recipientIds: [3039202],
      messageId: 99,
      replyToId: 55,
    });

    // POST payload must NOT carry messageId — that's the whole point.
    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect(postCall![2]).toEqual({
      subject: 'Updated subject',
      body: 'Updated body',
      recipientIds: [3039202],
      attachments: { myFileIDs: [] },
      draft: true,
      includeOriginal: true,
      replyToId: 55,
    });
    expect(postCall![2]).not.toHaveProperty('messageId');

    // DELETE must have been called for the OLD draft (99), not the new one.
    const deleteCall = spy.mock.calls.find((c) => c[0] === 'DELETE');
    expect(deleteCall).toBeDefined();
    const form = deleteCall![2] as FormData;
    expect(form.get('messageIds')).toBe('99');

    // The transparency NOTE tells the caller the id changed.
    expect(result.content[0].text).toMatch(/replaced draft 99 via create-then-delete/);
    expect(result.content[0].text).toMatch(/new draft id is 1234/);
  });

  it('does not call DELETE when messageId is omitted (pure create)', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 42 })
      .mockResolvedValueOnce({
        id: 42, subject: 'New', body: 'b',
        date: { dateTime: '2026-05-04T00:00:00Z' },
      });
    setup(client);
    await handlers.get('ofw_save_draft')!({ subject: 'New', body: 'b' });
    expect(spy.mock.calls.find((c) => c[0] === 'DELETE')).toBeUndefined();
  });

  it('surfaces a WARNING when the create succeeds but the old-draft delete fails', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 555 })
      .mockResolvedValueOnce({
        id: 555, subject: 's', body: 'b',
        date: { dateTime: '2026-05-04T00:00:00Z' },
      })
      .mockRejectedValueOnce(new Error('delete blew up'));
    setup(client);
    const result = await handlers.get('ofw_save_draft')!({
      subject: 's', body: 'b', messageId: 444,
    });
    expect(result.content[0].text).toMatch(/WARNING/);
    expect(result.content[0].text).toMatch(/failed to delete the old draft \(444\)/);
    expect(result.content[0].text).toMatch(/delete blew up/);
    // The new draft is still committed locally.
    expect(getDraft(555)?.body).toBe('b');
  });
});

describe('ofw_save_draft (thread-tip + cache upsert)', () => {
  it('rewrites replyToId to the chain tip and upserts cache from GET detail (not from POST response)', async () => {
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 142, folder: 'sent', subject: 'Re: Original', fromUser: 'Me',
      sentAt: '2026-05-02T00:00:00Z', recipients: [], body: 'first',
      fetchedBodyAt: null, replyToId: 100, chainRootId: 100, listData: {},
    });

    const client = new OFWClient();
    // OFW's real POST shape is minimal (`{entityId: X}`); the body comes
    // from the follow-up GET on the detail endpoint.
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 50 })
      .mockResolvedValueOnce({
        id: 50, subject: 'Re: Original', body: 'draft body',
        date: { dateTime: '2026-05-04T00:00:00Z' },
        replyToId: 142,
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re: Original',
      body: 'draft body',
      replyToId: 100,
    });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { replyToId: number | null }).replyToId).toBe(142);
    expect(spy.mock.calls[1]).toEqual(['GET', '/pub/v3/messages/50']);
    expect(result.content[0].text).toMatch(/replyToId rewritten from 100 to 142/);

    expect(getDraft(50)?.body).toBe('draft body');
    expect(getDraft(50)?.replyToId).toBe(142);
  });

  it('passes through replyToId unchanged when nothing to rewrite', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 50 })
      .mockResolvedValueOnce({
        id: 50, subject: 'New', body: 'b',
        date: { dateTime: '2026-05-04T00:00:00Z' },
      });
    setup(client);
    await handlers.get('ofw_save_draft')!({ subject: 'New', body: 'b' });
    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { replyToId: number | null }).replyToId).toBeNull();
    expect(getDraft(50)?.body).toBe('b');
  });

  it('falls back to data.id when OFW returns the legacy {id} shape instead of {entityId}', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ id: 77 })
      .mockResolvedValueOnce({
        id: 77, subject: 'Legacy', body: 'legacy body',
        date: { dateTime: '2026-05-04T00:00:00Z' },
      });
    setup(client);
    await handlers.get('ofw_save_draft')!({ subject: 'Legacy', body: 'legacy body' });
    expect(getDraft(77)?.body).toBe('legacy body');
  });

  it('does not refetch when OFW returns a non-2xx error response shape (no id and no entityId)', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ error: 'something went wrong' });
    setup(client);
    await handlers.get('ofw_save_draft')!({ subject: 'X', body: 'y' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ofw_delete_draft', () => {
  it('deletes a draft by messageId using multipart form', async () => {
    const client = makeClient({});
    setup(client);

    const result = await handlers.get('ofw_delete_draft')!({ messageId: 42 });

    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v1/messages', expect.any(FormData));
    const form = (client.request as ReturnType<typeof vi.fn>).mock.calls[0][2] as FormData;
    expect(form.get('messageIds')).toBe('42');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it('removes the draft from cache after OFW delete', async () => {
    upsertDraft({
      id: 50, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T00:00:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce(null);
    setup(client);

    await handlers.get('ofw_delete_draft')!({ messageId: 50 });
    expect(getDraft(50)).toBeNull();
  });
});

describe('ofw_get_unread_sent (cache-backed)', () => {
  it('returns sent messages with at least one unread recipient from cache', async () => {
    upsertMessage({
      id: 1, folder: 'sent', subject: 'Schedule',
      fromUser: 'Me', sentAt: '2026-05-04T12:00:00Z',
      recipients: [
        { userId: 2, name: 'Alice', viewedAt: null },
        { userId: 3, name: 'Bob', viewedAt: '2026-05-04T13:00:00Z' },
      ],
      body: 'b', fetchedBodyAt: '2026-05-04T12:01:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 2, folder: 'sent', subject: 'Read by all',
      fromUser: 'Me', sentAt: '2026-05-04T11:00:00Z',
      recipients: [{ userId: 2, name: 'Alice', viewedAt: '2026-05-04T11:30:00Z' }],
      body: 'b', fetchedBodyAt: '2026-05-04T11:01:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const result = await handlers.get('ofw_get_unread_sent')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      { id: 1, subject: 'Schedule', sentAt: '2026-05-04T12:00:00Z', unreadBy: ['Alice'] },
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns sync hint when sent cache is empty', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_get_unread_sent')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toMatch(/ofw_sync_messages/);
  });

  it('returns all-read message when all recipients have viewedAt', async () => {
    upsertMessage({
      id: 1, folder: 'sent', subject: 'Done',
      fromUser: 'Me', sentAt: '2026-05-04T12:00:00Z',
      recipients: [{ userId: 2, name: 'Alice', viewedAt: '2026-05-04T12:30:00Z' }],
      body: 'b', fetchedBodyAt: null,
      replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_get_unread_sent')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ message: 'All scanned sent messages have been read.' });
  });
});

describe('ofw_upload_attachment', () => {
  it('reads the file, POSTs multipart to /pub/v3/myfiles/multipart, returns fileId', async () => {
    const client = new OFWClient();
    const reqSpy = vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 99887766,
      fileName: 'note.txt',
      label: 'note.txt',
      fileType: 'text/plain',
      sizeInBytes: 19,
      shareClass: 'PRIVATE',
    });
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-up-'));
    const filePath = join(dir, 'note.txt');
    writeFileSync(filePath, 'hello attachments!');
    try {
      const result = await handlers.get('ofw_upload_attachment')!({ path: filePath });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.fileId).toBe(99887766);
      expect(parsed.fileName).toBe('note.txt');
      expect(parsed.shareClass).toBe('PRIVATE');

      // Check the request was POST to the multipart endpoint with FormData
      const [method, path, body] = reqSpy.mock.calls[0];
      expect(method).toBe('POST');
      expect(path).toBe('/pub/v3/myfiles/multipart');
      expect(body).toBeInstanceOf(FormData);
      const form = body as FormData;
      expect(form.get('source')).toBe('message');
      expect(form.get('shareClass')).toBe('PRIVATE');
      expect(form.get('fileName')).toBe('note.txt');
      expect(form.get('label')).toBe('note.txt');
      expect(form.get('description')).toBe('note.txt');
      const fileBlob = form.get('file') as Blob | null;
      expect(fileBlob).not.toBeNull();
      expect(fileBlob?.type).toBe('text/plain');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors shareClass:"SHARED" and custom label/description', async () => {
    const client = new OFWClient();
    const reqSpy = vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 1, fileName: 'a.pdf', fileType: 'application/pdf', sizeInBytes: 4, shareClass: 'SHARED',
    });
    setup(client);
    const dir = mkdtempSync(join(tmpdir(), 'ofw-up-'));
    const filePath = join(dir, 'a.pdf');
    writeFileSync(filePath, 'PDF.');
    try {
      await handlers.get('ofw_upload_attachment')!({
        path: filePath, shareClass: 'SHARED', label: 'May invoice', description: 'Itemized invoice for May',
      });
      const form = reqSpy.mock.calls[0][2] as FormData;
      expect(form.get('shareClass')).toBe('SHARED');
      expect(form.get('label')).toBe('May invoice');
      expect(form.get('description')).toBe('Itemized invoice for May');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the file does not exist', async () => {
    const client = new OFWClient();
    setup(client);
    await expect(
      handlers.get('ofw_upload_attachment')!({ path: '/tmp/does-not-exist-' + Date.now() })
    ).rejects.toThrow();
  });
});

describe('ofw_send_message with attachments', () => {
  it('passes myFileIDs through to the OFW payload', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'with attach', body: 'see attached',
        date: { dateTime: '2026-05-14T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);
    await handlers.get('ofw_send_message')!({
      subject: 'with attach', body: 'see attached', recipientIds: [1],
      myFileIDs: [50015547, 99887766],
    });
    const post = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((post![2] as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([50015547, 99887766]);
  });

  it('links attachment cache rows to the new sent message (using the id from the GET, not POST)', async () => {
    // Pre-cache the attachment metadata as if it had been uploaded earlier
    upsertAttachmentForMessage({
      fileId: 50015547, fileName: 'doc.pdf', label: 'doc', mimeType: 'application/pdf',
      sizeBytes: 1024, metadata: {}, messageId: 0,
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 200 })
      .mockResolvedValueOnce({
        id: 200, subject: 'x', body: 'y',
        date: { dateTime: '2026-05-14T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);
    await handlers.get('ofw_send_message')!({
      subject: 'x', body: 'y', recipientIds: [1], myFileIDs: [50015547],
    });
    // After send, the attachment should now be linked to message 200
    const atts = listAttachmentsForMessage(200);
    expect(atts).toHaveLength(1);
    expect(atts[0].fileId).toBe(50015547);
  });
});

describe('ofw_download_attachment', () => {
  it('fetches metadata + bytes, writes file, returns path/mime/size', async () => {
    const client = new OFWClient();
    const xlsxBytes = Buffer.from('PKfake-xlsx-content', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 50015547,
      label: 'Hall Holiday Schedules 2026 - 2027.xlsx',
      fileName: 'Hall_Holiday_Schedules_2026_-_2027.xlsx',
      fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileSize: xlsxBytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: xlsxBytes,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      suggestedFileName: 'Hall_Holiday_Schedules_2026_-_2027.xlsx',
    });
    setup(client);

    const downloadDir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      const result = await handlers.get('ofw_download_attachment')!({ fileId: 50015547, saveTo: downloadDir + '/' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.fileId).toBe(50015547);
      expect(parsed.path).toMatch(/Hall_Holiday_Schedules/);
      expect(parsed.mimeType).toContain('spreadsheetml');
      expect(parsed.sizeBytes).toBe(xlsxBytes.length);
      // File actually exists on disk
      const written = readFileSync(parsed.path);
      expect(written.equals(xlsxBytes)).toBe(true);
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  });

  it('sanitizes a co-parent-controlled ../ filename so the write stays in the target dir', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('evil-bytes', 'utf8');
    // The co-parent who uploaded the file controls the metadata fileName.
    const malicious = '../../../../tmp/ofw-traversal-evil.png';
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 66, label: malicious, fileName: malicious,
      fileType: 'image/png', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: 'image/png', suggestedFileName: malicious,
    });
    setup(client);

    const downloadDir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      const result = await handlers.get('ofw_download_attachment')!({ fileId: 66, saveTo: downloadDir + '/' });
      const parsed = JSON.parse(result.content[0].text);
      // The written path must stay directly under the requested dir…
      expect(resolve(dirname(parsed.path))).toBe(resolve(downloadDir));
      // …with the traversal segments stripped (basename only).
      expect(parsed.path).toMatch(/66-ofw-traversal-evil\.png$/);
      expect(parsed.path).not.toContain('..');
      expect(readFileSync(parsed.path).equals(bytes)).toBe(true);
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  });

  it('inline:true returns ImageContent for image MIME and writes no file', async () => {
    const client = new OFWClient();
    const pngBytes = Buffer.from('\x89PNGfake-png-bytes', 'binary');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 42, fileName: 'kid.png', label: 'kid.png',
      fileType: 'image/png', fileSize: pngBytes.length,
    });
    const binSpy = vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: pngBytes, contentType: 'image/png', suggestedFileName: 'kid.png',
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 42, inline: true });
    expect(binSpy).toHaveBeenCalledTimes(1);
    expect(result.content).toHaveLength(2);
    const meta = JSON.parse(result.content[0].text);
    expect(meta).toMatchObject({ fileId: 42, fileName: 'kid.png', mimeType: 'image/png', mode: 'inline', sizeBytes: pngBytes.length });
    const img = result.content[1];
    expect(img.type).toBe('image');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').equals(pngBytes)).toBe(true);
  });

  it('inline:true returns EmbeddedResource blob for non-image MIME', async () => {
    const client = new OFWClient();
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 7, fileName: 'receipt.pdf', label: 'receipt.pdf',
      fileType: 'application/pdf', fileSize: pdfBytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: pdfBytes, contentType: 'application/pdf', suggestedFileName: 'receipt.pdf',
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 7, inline: true });
    expect(result.content).toHaveLength(2);
    const res = result.content[1];
    expect(res.type).toBe('resource');
    expect(res.resource.mimeType).toBe('application/pdf');
    expect(res.resource.uri).toBe('ofw://attachment/7/receipt.pdf');
    expect(Buffer.from(res.resource.blob, 'base64').equals(pdfBytes)).toBe(true);
  });

  it('OFW_INLINE_ATTACHMENTS=true makes inline the default when arg is omitted', async () => {
    const prev = process.env.OFW_INLINE_ATTACHMENTS;
    process.env.OFW_INLINE_ATTACHMENTS = 'true';
    try {
      const client = new OFWClient();
      const bytes = Buffer.from('env-flipped', 'utf8');
      vi.spyOn(client, 'request').mockResolvedValueOnce({
        fileId: 11, fileName: 'memo.txt', label: 'memo.txt',
        fileType: 'text/plain', fileSize: bytes.length,
      });
      vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
        body: bytes, contentType: 'text/plain', suggestedFileName: 'memo.txt',
      });
      setup(client);

      // No inline arg — should default to inline because of the env var.
      const result = await handlers.get('ofw_download_attachment')!({ fileId: 11 });
      expect(result.content).toHaveLength(2);
      const meta = JSON.parse(result.content[0].text);
      expect(meta.mode).toBe('inline');
      const res = result.content[1];
      expect(res.type).toBe('resource');
      expect(Buffer.from(res.resource.blob, 'base64').equals(bytes)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OFW_INLINE_ATTACHMENTS;
      else process.env.OFW_INLINE_ATTACHMENTS = prev;
    }
  });

  it('explicit inline:false overrides OFW_INLINE_ATTACHMENTS=true', async () => {
    const prev = process.env.OFW_INLINE_ATTACHMENTS;
    process.env.OFW_INLINE_ATTACHMENTS = 'true';
    try {
      const client = new OFWClient();
      vi.spyOn(client, 'request').mockResolvedValueOnce({
        fileId: 12, fileName: 'memo.txt', label: 'memo.txt',
        fileType: 'text/plain', fileSize: 4,
      });
      vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
        body: Buffer.from('data'), contentType: 'text/plain', suggestedFileName: 'memo.txt',
      });
      setup(client);
      const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
      try {
        const result = await handlers.get('ofw_download_attachment')!({ fileId: 12, inline: false, saveTo: dir + '/' });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.path).toMatch(/memo\.txt$/);
        expect(parsed.mode).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      if (prev === undefined) delete process.env.OFW_INLINE_ATTACHMENTS;
      else process.env.OFW_INLINE_ATTACHMENTS = prev;
    }
  });

  it('inline:true reuses on-disk bytes instead of re-fetching when previously downloaded', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('local-copy', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 99, fileName: 'note.txt', label: 'note.txt',
      fileType: 'text/plain', fileSize: bytes.length,
    });
    const binSpy = vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: 'text/plain', suggestedFileName: 'note.txt',
    });
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      // First: disk download populates downloadedPath.
      await handlers.get('ofw_download_attachment')!({ fileId: 99, saveTo: dir + '/' });
      // Second: inline mode should read from disk, not hit the network.
      const result = await handlers.get('ofw_download_attachment')!({ fileId: 99, inline: true });
      expect(binSpy).toHaveBeenCalledTimes(1);
      const res = result.content[1];
      expect(res.type).toBe('resource');
      expect(Buffer.from(res.resource.blob, 'base64').equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inline:true falls through to a network fetch when the on-disk copy is missing', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('fresh-bytes', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 77, fileName: 'gone.txt', label: 'gone.txt',
      fileType: 'text/plain', fileSize: bytes.length,
    });
    const binSpy = vi.spyOn(client, 'requestBinary')
      .mockResolvedValueOnce({ body: bytes, contentType: 'text/plain', suggestedFileName: 'gone.txt' })
      .mockResolvedValueOnce({ body: bytes, contentType: 'text/plain', suggestedFileName: 'gone.txt' });
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      // Populate downloadedPath in the attachment cache, then delete the actual file.
      const first = await handlers.get('ofw_download_attachment')!({ fileId: 77, saveTo: dir + '/' });
      const path = JSON.parse(first.content[0].text).path;
      rmSync(path);

      // Inline mode should detect the missing file and re-fetch from the network.
      const result = await handlers.get('ofw_download_attachment')!({ fileId: 77, inline: true });
      expect(binSpy).toHaveBeenCalledTimes(2);
      const res = result.content[1];
      expect(res.type).toBe('resource');
      expect(Buffer.from(res.resource.blob, 'base64').equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inline:true falls back to cached mime/filename when the server omits Content-Type/Disposition', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('%PDF-1.4 fake', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 88, fileName: 'cached.pdf', label: 'cached.pdf',
      fileType: 'application/pdf', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: null, suggestedFileName: null,
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 88, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.mimeType).toBe('application/pdf');
    expect(meta.fileName).toBe('cached.pdf');
    const res = result.content[1];
    expect(res.type).toBe('resource');
    expect(res.resource.mimeType).toBe('application/pdf');
    expect(res.resource.uri).toBe('ofw://attachment/88/cached.pdf');
  });

  it('disk mode falls back to cached mime/filename when the server omits Content-Type/Disposition', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('zipdata', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 89, fileName: 'archive.zip', label: 'archive.zip',
      fileType: 'application/zip', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: null, suggestedFileName: null,
    });
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      const result = await handlers.get('ofw_download_attachment')!({ fileId: 89, saveTo: dir + '/' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.mimeType).toBe('application/zip');
      expect(parsed.fileName).toBe('archive.zip');
      expect(parsed.path.endsWith('89-archive.zip')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips re-download when the file is already at the same path (no force)', async () => {
    const client = new OFWClient();
    const reqSpy = vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 1, fileName: 'a.txt', label: 'a.txt', fileType: 'text/plain', fileSize: 4,
    });
    const binSpy = vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: Buffer.from('data'),
      contentType: 'text/plain',
      suggestedFileName: 'a.txt',
    });
    setup(client);
    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      // First call downloads.
      await handlers.get('ofw_download_attachment')!({ fileId: 1, saveTo: dir + '/' });
      // Second call should hit the short-circuit.
      const second = await handlers.get('ofw_download_attachment')!({ fileId: 1, saveTo: dir + '/' });
      expect(binSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(second.content[0].text);
      expect(parsed.note).toBe('already downloaded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      void reqSpy; // silence unused-var lint
    }
  });
});

describe('ofw_get_message attachments backfill', () => {
  it('re-fetches detail to harvest fileIds when listData.files > 0 but cache is empty', async () => {
    // Simulate a message bodied before attachment caching existed:
    // body present, listData has files count, attachments table empty.
    upsertMessage({
      id: 7777, folder: 'inbox', subject: 'has attachment',
      fromUser: 'Alice', sentAt: '2026-05-14T12:00:00Z',
      recipients: [], body: 'see attached',
      fetchedBodyAt: '2026-05-13T00:00:00Z',
      replyToId: null, chainRootId: null,
      listData: { id: 7777, files: 1, preview: 'see…' },
    });

    const client = new OFWClient();
    // First call: detail re-fetch returns files array.
    // Second call: attachment metadata fetch for fileId 4242.
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ id: 7777, body: 'see attached', files: [4242] })
      .mockResolvedValueOnce({
        fileId: 4242, fileName: 'invite.ics', label: 'invite',
        fileType: 'text/calendar', fileSize: 512,
      });
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '7777' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].fileId).toBe(4242);
    expect(parsed.attachments[0].fileName).toBe('invite.ics');
    expect(parsed.attachments[0].mimeType).toBe('text/calendar');
    // Two requests: detail + per-file metadata
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][1]).toBe('/pub/v3/messages/7777');
  });

  it('does not re-fetch when listData has no files hint', async () => {
    upsertMessage({
      id: 8888, folder: 'inbox', subject: 'no attachment',
      fromUser: 'Alice', sentAt: '2026-05-14T12:00:00Z',
      recipients: [], body: 'plain',
      fetchedBodyAt: '2026-05-13T00:00:00Z',
      replyToId: null, chainRootId: null,
      listData: { id: 8888, files: 0 },
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    await handlers.get('ofw_get_message')!({ messageId: '8888' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not re-fetch when attachments are already cached', async () => {
    upsertMessage({
      id: 9999, folder: 'inbox', subject: 'has attachment',
      fromUser: 'Alice', sentAt: '2026-05-14T12:00:00Z',
      recipients: [], body: 'see attached',
      fetchedBodyAt: '2026-05-13T00:00:00Z',
      replyToId: null, chainRootId: null,
      listData: { id: 9999, files: 1 },
    });
    upsertAttachmentForMessage({
      fileId: 5555, fileName: 'doc.pdf', label: 'doc', mimeType: 'application/pdf',
      sizeBytes: 100, metadata: {}, messageId: 9999,
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '9999' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.attachments).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ofw_get_message attachments', () => {
  it('surfaces attachments array on cached message', async () => {
    upsertMessage({
      id: 42, folder: 'inbox', subject: 'with attachment', fromUser: 'Alice',
      sentAt: '2026-05-13T12:00:00Z', recipients: [], body: 'see attached',
      fetchedBodyAt: '2026-05-13T12:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    upsertAttachmentForMessage({
      fileId: 99, fileName: 'doc.pdf', label: 'doc', mimeType: 'application/pdf',
      sizeBytes: 1024, metadata: {}, messageId: 42,
    });
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: '42' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].fileId).toBe(99);
    expect(parsed.attachments[0].fileName).toBe('doc.pdf');
  });
});


describe('messages.ts — coverage backfill', () => {
  it('upload_attachment: unknown extension + bare meta → octet-stream + filename fallbacks', async () => {
    const file = join(tmpDir, 'note.unknownext');
    writeFileSync(file, 'X');
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({ fileId: 8 }); // bare meta → 504–517
    setup(c);
    const out = JSON.parse((await handlers.get('ofw_upload_attachment')!({ path: file })).content[0].text);
    expect(out.fileId).toBe(8);
    expect(out.fileName).toBe('note.unknownext');
    expect(out.mimeType).toBe('application/octet-stream'); // mimeFromName fallback (43)
  });

  it('upload_attachment: rejects a non-file path', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({});
    setup(c);
    await expect(handlers.get('ofw_upload_attachment')!({ path: tmpDir })).rejects.toThrow(/Not a file/); // 480
  });

  it('download_attachment: fetches metadata when uncached and writes into a saveTo directory', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({ fileId: 50, fileName: 'f.bin', fileType: 'application/octet-stream', fileSize: 3 });
    vi.spyOn(c, 'requestBinary').mockResolvedValue({ body: Buffer.from('abc'), contentType: 'application/octet-stream', suggestedFileName: 'f.bin' } as never);
    setup(c);
    const out = JSON.parse((await handlers.get('ofw_download_attachment')!({ fileId: 50, saveTo: join(tmpDir, 'dl') + '/' })).content[0].text);
    expect(out.path).toContain('50-f.bin'); // 540 (uncached) + dir branch (574–577)
  });

  it('download_attachment: writes to an explicit saveTo file path (binary fallbacks)', async () => {
    upsertAttachmentForMessage({ fileId: 51, fileName: 'g.bin', label: 'g', mimeType: 'application/octet-stream', sizeBytes: 3, metadata: {}, messageId: 0 });
    const c = new OFWClient();
    vi.spyOn(c, 'requestBinary').mockResolvedValue({ body: Buffer.from('xyz') } as never); // no contentType/suggestedFileName → fallbacks
    setup(c);
    const dest = join(tmpDir, 'explicit.bin');
    const out = JSON.parse((await handlers.get('ofw_download_attachment')!({ fileId: 51, saveTo: dest })).content[0].text);
    expect(out.path).toBe(dest); // file-path branch (578)
  });

  it('list_messages: folderId "sent" + a paged note when results exceed the page', async () => {
    for (let i = 1; i <= 5; i++) upsertMessage({ id: i, folder: 'sent', subject: `s${i}`, fromUser: 'A', sentAt: `2026-05-0${i}T00:00:00Z`, recipients: [], body: 'b', fetchedBodyAt: 't', replyToId: null, chainRootId: null, listData: {} });
    const c = new OFWClient(); vi.spyOn(c, 'request').mockResolvedValue({}); setup(c);
    const out = JSON.parse((await handlers.get('ofw_list_messages')!({ folderId: 'sent', size: 2, page: 1 })).content[0].text);
    expect(out.total).toBe(5);
    expect(out.note).toMatch(/Showing 1–2 of 5/); // 85 (sent) + 102 (paged note)
  });

  it('get_message: detail fetch with missing optional fields fills defaults', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValue({ id: 77, subject: 'S', files: [] }); // detail: no subject/from/date/body
    setup(c);
    const out = JSON.parse((await handlers.get('ofw_get_message')!({ messageId: 77 })).content[0].text);
    expect(out.fromUser).toBe('');  // 180
    expect(out.body).toBe('');      // 183
  });

  it('send_message: reports the missing required fields for a fresh send', async () => {
    const c = new OFWClient(); vi.spyOn(c, 'request').mockResolvedValue({}); setup(c);
    await expect(handlers.get('ofw_send_message')!({})).rejects.toThrow(/subject|body|recipientIds/); // 244–246
  });
});

describe('messages.ts — attachment-backfill branches', () => {
  const M = (over: Record<string, unknown>) => ({ id: 0, folder: 'inbox', subject: 's', fromUser: 'A', sentAt: 't', recipients: [], body: 'b', fetchedBodyAt: 't', replyToId: null, chainRootId: null, listData: {}, ...over });

  it('get_message: cached message with non-object listData skips backfill', async () => {
    upsertMessage(M({ id: 60, listData: 'not-an-object' }) as never);
    const c = new OFWClient(); vi.spyOn(c, 'request').mockResolvedValue({}); setup(c);
    expect(JSON.parse((await handlers.get('ofw_get_message')!({ messageId: 60 })).content[0].text).id).toBe(60); // 51
  });

  it('get_message: cached listData.files array triggers attachment backfill', async () => {
    upsertMessage(M({ id: 61, listData: { files: [9] } }) as never);
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce({ files: [9] }).mockResolvedValueOnce({ fileId: 9, fileName: 'x.pdf' });
    setup(c);
    expect(JSON.parse((await handlers.get('ofw_get_message')!({ messageId: 61 })).content[0].text).attachments).toHaveLength(1); // 54
  });

  it('get_message: non-cached detail with files harvests attachment metadata', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce({ id: 62, subject: 'S', files: [12] }).mockResolvedValueOnce({ fileId: 12, fileName: 'y.pdf' });
    setup(c);
    expect(JSON.parse((await handlers.get('ofw_get_message')!({ messageId: 62 })).content[0].text).attachments).toHaveLength(1); // 190-191
  });

  it('get_message: listData hints files but re-fetch returns none → no backfill', async () => {
    upsertMessage(M({ id: 63, listData: { files: [9] } }) as never);
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce({ files: [] }); // detail has no fileIds → 157[1]
    setup(c);
    expect(JSON.parse((await handlers.get('ofw_get_message')!({ messageId: 63 })).content[0].text).attachments).toHaveLength(0);
  });

  it('send_message: subject+body present lists only the missing recipientIds', async () => {
    const c = new OFWClient(); vi.spyOn(c, 'request'); setup(c);
    await expect(handlers.get('ofw_send_message')!({ subject: 'S', body: 'B' })) // 244[1],245[1]
      .rejects.toThrow(/requires recipientIds\b/);
  });

  it('send_message: only recipientIds present lists subject, body', async () => {
    const c = new OFWClient(); vi.spyOn(c, 'request'); setup(c);
    await expect(handlers.get('ofw_send_message')!({ recipientIds: [1] })) // 246[1]
      .rejects.toThrow(/requires subject, body\b/);
  });

  it('send_message: re-fetched detail missing fields falls back to inputs and WARNs (unverifiable write)', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request')
      .mockResolvedValueOnce({ entityId: 500 }) // POST
      .mockResolvedValueOnce({ id: 500 }); // GET bare detail → 290-294 fallbacks
    setup(c);
    const text = (await handlers.get('ofw_send_message')!({ subject: 'S', body: 'B', recipientIds: [1] })).content[0].text;
    // A detail with neither subject nor body cannot confirm the write landed.
    expect(text).toMatch(/^WARNING: the message re-fetched from OFW does not contain the subject and body/);
    const out = JSON.parse(text.slice(text.indexOf('\n\n') + 2));
    expect(out.id).toBe(500);
    expect(out.subject).toBe('S'); // detail.subject ?? subject
    expect(out.fromUser).toBe(''); // detail.from?.name ?? ''
    expect(out.body).toBe('B'); // detail.body ?? body
  });

  it('send_message: POST with no id falls back to the generic text plus an unconfirmed-send warning', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce(null); // raw falsy, id null
    setup(c);
    const text = (await handlers.get('ofw_send_message')!({ subject: 'S', body: 'B', recipientIds: [1] })).content[0].text;
    expect(text).toContain("WARNING: OFW's send response did not include a message id");
    expect(text).toContain('Message sent successfully.');
  });

  it('save_draft: POST with no id returns the generic saved message', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce(null); // raw falsy, id null → 421[1]
    setup(c);
    const text = (await handlers.get('ofw_save_draft')!({ subject: 'S', body: 'B' })).content[0].text;
    expect(text).toBe('Draft saved.');
  });

  it('download_attachment: no saveTo writes into the default attachments dir', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce({ fileId: 70, fileName: 'd.bin', fileType: 'application/octet-stream', fileSize: 3 });
    vi.spyOn(c, 'requestBinary').mockResolvedValueOnce({ body: Buffer.from('def'), contentType: 'application/octet-stream', suggestedFileName: 'd.bin' } as never);
    setup(c);
    const dir = mkdtempSync(join(tmpdir(), 'ofw-attach-'));
    const prev = process.env.OFW_ATTACHMENTS_DIR;
    process.env.OFW_ATTACHMENTS_DIR = dir;
    try {
      const out = JSON.parse((await handlers.get('ofw_download_attachment')!({ fileId: 70 })).content[0].text); // 578
      expect(out.path).toBe(join(dir, '70-d.bin'));
      expect(readFileSync(out.path).toString()).toBe('def');
    } finally {
      if (prev === undefined) delete process.env.OFW_ATTACHMENTS_DIR; else process.env.OFW_ATTACHMENTS_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('send/save write verification', () => {
  it('send_message warns when the re-fetched message does not contain the posted body', async () => {
    const client = new OFWClient();
    sendMessageMocks(client, { entityId: 200, detail: { subject: 'Hi', body: 'completely different' } });
    setup(client);
    const text = (await handlers.get('ofw_send_message')!({
      subject: 'Hi', body: 'my real text', recipientIds: [1],
    })).content[0].text;
    expect(text).toMatch(/^WARNING: the message re-fetched from OFW does not contain the body that was posted/);
  });

  it('send_message does not warn when OFW appends the original to a reply body (containment)', async () => {
    const client = new OFWClient();
    sendMessageMocks(client, { entityId: 201, detail: { subject: 'RE: Hi', body: 'my reply\n\n--- original ---' } });
    setup(client);
    const text = (await handlers.get('ofw_send_message')!({
      subject: 'Hi', body: 'my reply', recipientIds: [1],
    })).content[0].text;
    expect(text).not.toContain('WARNING');
  });

  it('save_draft warns when the re-fetched draft does not contain the posted body', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 80 })
      .mockResolvedValueOnce({ id: 80, subject: 'S', body: 'echoed-but-wrong', date: { dateTime: '2026-05-01T00:00:00Z' } });
    setup(client);
    const text = (await handlers.get('ofw_save_draft')!({ subject: 'S', body: 'intended body' })).content[0].text;
    expect(text).toMatch(/WARNING: the draft re-fetched from OFW does not contain the body that was posted/);
  });

  it('save_draft warns and falls back to posted values when the re-fetched detail is sparse', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 82 })
      .mockResolvedValueOnce({ id: 82 }); // detail missing subject/body/date entirely
    setup(client);
    const text = (await handlers.get('ofw_save_draft')!({ subject: 'S', body: 'B' })).content[0].text;
    expect(text).toMatch(/WARNING: the draft re-fetched from OFW does not contain the subject and body/);
    // Cache row falls back to the posted subject and an empty body.
    const cached = getDraft(82)!;
    expect(cached.subject).toBe('S');
    expect(cached.body).toBe('');
  });

  it('save_draft does not warn when OFW echoes the draft faithfully', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 81 })
      .mockResolvedValueOnce({ id: 81, subject: 'S', body: 'intended body', date: { dateTime: '2026-05-01T00:00:00Z' } });
    setup(client);
    const text = (await handlers.get('ofw_save_draft')!({ subject: 'S', body: 'intended body' })).content[0].text;
    expect(text).not.toContain('WARNING');
  });
});

describe('send_message draft preservation on unconfirmed send', () => {
  it('keeps the draft and skips the DELETE when the POST response carries no id', async () => {
    upsertDraft({
      id: 70, subject: 'S', body: 'B',
      recipients: [{ userId: 1, name: 'A', viewedAt: null }],
      replyToId: null, modifiedAt: '2026-05-01T00:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({ error: 'boom' }); // POST → no id
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({ messageId: 70 })).content[0].text;

    expect(getDraft(70)).not.toBeNull(); // draft survives
    expect(spy).not.toHaveBeenCalledWith('DELETE', expect.anything(), expect.anything());
    expect(text).toContain('Draft 70 was NOT deleted');
  });

  it('warns about the unconfirmed send even when no draft was involved', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({ error: 'boom' }); // POST → no id
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      subject: 'Hi', body: 'B', recipientIds: [1],
    })).content[0].text;

    expect(text).toContain("WARNING: OFW's send response did not include a message id");
    expect(text).not.toContain('NOT deleted'); // no draft in play
  });
});

describe('pagination input schemas', () => {
  it('rejects non-positive or fractional page/size on the cached list tools', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodRawShape }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown, _cb: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodRawShape });
      return undefined as never;
    });
    registerMessageTools(server, new OFWClient(), cacheProvider, attachmentIO);

    for (const tool of ['ofw_list_messages', 'ofw_list_drafts', 'ofw_get_unread_sent']) {
      const schema = z.object(configs.get(tool)!.inputSchema!);
      expect(schema.safeParse({ page: 0 }).success).toBe(false);
      expect(schema.safeParse({ size: -1 }).success).toBe(false);
      expect(schema.safeParse({ size: 1.5 }).success).toBe(false);
      expect(schema.safeParse({ page: 1, size: 50 }).success).toBe(true);
    }
  });
});

describe('OFW_WRITE_MODE gating', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('mode "none" registers no message write tools', () => {
    process.env.OFW_WRITE_MODE = 'none';
    setup(makeClient({}));
    expect(handlers.has('ofw_send_message')).toBe(false);
    expect(handlers.has('ofw_save_draft')).toBe(false);
    expect(handlers.has('ofw_delete_draft')).toBe(false);
    expect(handlers.has('ofw_upload_attachment')).toBe(false);
    // read/sync/download surface stays intact
    expect(handlers.has('ofw_list_message_folders')).toBe(true);
    expect(handlers.has('ofw_list_messages')).toBe(true);
    expect(handlers.has('ofw_get_message')).toBe(true);
    expect(handlers.has('ofw_list_drafts')).toBe(true);
    expect(handlers.has('ofw_get_unread_sent')).toBe(true);
    expect(handlers.has('ofw_download_attachment')).toBe(true);
    expect(handlers.has('ofw_sync_messages')).toBe(true);
  });

  it('mode "drafts" registers draft-level writes but never send', () => {
    process.env.OFW_WRITE_MODE = 'drafts';
    setup(makeClient({}));
    expect(handlers.has('ofw_send_message')).toBe(false);
    expect(handlers.has('ofw_save_draft')).toBe(true);
    expect(handlers.has('ofw_delete_draft')).toBe(true);
    expect(handlers.has('ofw_upload_attachment')).toBe(true);
  });

  it('mode "all" (and unset) registers everything', () => {
    process.env.OFW_WRITE_MODE = 'all';
    setup(makeClient({}));
    expect(handlers.has('ofw_send_message')).toBe(true);
    delete process.env.OFW_WRITE_MODE;
    setup(makeClient({}));
    expect(handlers.has('ofw_send_message')).toBe(true);
    expect(handlers.has('ofw_save_draft')).toBe(true);
    expect(handlers.has('ofw_delete_draft')).toBe(true);
    expect(handlers.has('ofw_upload_attachment')).toBe(true);
  });
});

describe('response validation (issue #83)', () => {
  it('send_message: strict — a mistyped entityId in the POST response throws instead of degrading to "unconfirmed send"', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({ entityId: '42' }); // string, not number
    setup(client);
    await expect(handlers.get('ofw_send_message')!({ subject: 'S', body: 'B', recipientIds: [1] }))
      .rejects.toThrow(/Unexpected POST \/pub\/v3\/messages \(ofw_send_message\) shape from the upstream API\. entityId/);
  });

  it('send_message: strict — a mistyped field in the re-fetched detail throws', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 7 })
      .mockResolvedValueOnce({ subject: 123 }); // detail subject mistyped
    setup(client);
    await expect(handlers.get('ofw_send_message')!({ subject: 'S', body: 'B', recipientIds: [1] }))
      .rejects.toThrow(/Unexpected GET \/pub\/v3\/messages\/\{id\} \(ofw_send_message\) shape from the upstream API\. subject/);
  });

  it('save_draft: strict — a mistyped replyToId in the re-fetched detail throws', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 8 })
      .mockResolvedValueOnce({ replyToId: 'nope' });
    setup(client);
    await expect(handlers.get('ofw_save_draft')!({ subject: 'S', body: 'B' }))
      .rejects.toThrow(/\(ofw_save_draft\) shape from the upstream API\. replyToId/);
  });

  it('upload_attachment: strict — a missing fileId in the upload response throws', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({ fileName: 'note.txt' }); // no fileId
    setup(client);
    const dir = mkdtempSync(join(tmpdir(), 'ofw-upv-'));
    const filePath = join(dir, 'note.txt');
    writeFileSync(filePath, 'x');
    try {
      await expect(handlers.get('ofw_upload_attachment')!({ path: filePath }))
        .rejects.toThrow(/Unexpected POST \/pub\/v3\/myfiles\/multipart \(ofw_upload_attachment\) shape from the upstream API\. fileId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('get_message: lenient — a malformed uncached detail warns to stderr but still serves', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 60, subject: 'S', body: 'B', date: { dateTime: '2026-05-01T00:00:00Z' },
      files: 'nope', // mistyped: number[] expected
    });
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: 60 });
    expect(JSON.parse(result.content[0].text).id).toBe(60); // raw flows through
    const warning = err.mock.calls.map((c) => c[0]).find((m) => typeof m === 'string' && m.includes('proceeding with the raw response'));
    expect(warning).toContain('GET /pub/v3/messages/{id} (ofw_get_message)');
    expect(warning).toContain('files');
  });
});

describe('ofw_get_message — sent view-status refresh', () => {
  it('refreshes view status for a cached sent message the recipient has since read', async () => {
    upsertMessage({
      id: 600, folder: 'sent', subject: 'Sent', fromUser: '',
      sentAt: '2026-06-15T00:00:00Z',
      recipients: [{ userId: 1, name: 'Co-parent', viewedAt: null }],
      body: 'sent-body', fetchedBodyAt: '2026-06-15T00:01:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 600, subject: 'Sent', body: 'sent-body', date: { dateTime: '2026-06-15T00:00:00Z' },
      recipients: [{ user: { id: 1, name: 'Co-parent' }, viewed: { dateTime: '2026-06-16T15:49:20' } }],
    });
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: '600' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.recipients[0].viewedAt).toBe('2026-06-16T15:49:20');
    expect(getMessage(600)?.recipients[0].viewedAt).toBe('2026-06-16T15:49:20');
    // listData read-flag reconciled so it can't contradict recipients
    expect(parsed.listData.showNeverViewed).toBe(false);
  });

  it('keeps showNeverViewed true when the refresh confirms the recipient still has not viewed', async () => {
    upsertMessage({
      id: 603, folder: 'sent', subject: 'Sent', fromUser: '',
      sentAt: '2026-06-15T00:00:00Z',
      recipients: [{ userId: 1, name: 'Co-parent', viewedAt: null }],
      body: 'sent-body', fetchedBodyAt: '2026-06-15T00:01:00Z',
      replyToId: null, chainRootId: null, listData: { showNeverViewed: true },
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 603, subject: 'Sent', body: 'sent-body', date: { dateTime: '2026-06-15T00:00:00Z' },
      recipients: [{ user: { id: 1, name: 'Co-parent' }, viewed: null }],
    });
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: '603' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.recipients[0].viewedAt).toBeNull();
    expect(parsed.listData.showNeverViewed).toBe(true);
  });

  it('falls back to the cached row when the refresh fetch fails', async () => {
    upsertMessage({
      id: 601, folder: 'sent', subject: 'Sent', fromUser: '',
      sentAt: '2026-06-15T00:00:00Z',
      recipients: [{ userId: 1, name: 'Co-parent', viewedAt: null }],
      body: 'sent-body', fetchedBodyAt: '2026-06-15T00:01:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValueOnce(new Error('network'));
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: '601' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.body).toBe('sent-body');
    expect(parsed.recipients[0].viewedAt).toBeNull();
  });

  it('does not refetch a cached sent message that already has a view timestamp', async () => {
    upsertMessage({
      id: 602, folder: 'sent', subject: 'Sent', fromUser: '',
      sentAt: '2026-06-15T00:00:00Z',
      recipients: [{ userId: 1, name: 'Co-parent', viewedAt: '2026-06-16T15:49:20' }],
      body: 'sent-body', fetchedBodyAt: '2026-06-15T00:01:00Z',
      replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);
    const result = await handlers.get('ofw_get_message')!({ messageId: '602' });
    expect(JSON.parse(result.content[0].text).recipients[0].viewedAt).toBe('2026-06-16T15:49:20');
    expect(spy).not.toHaveBeenCalled();
  });
});
