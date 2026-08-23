import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import * as syncModule from '../../src/sync.js';
import { NodeAttachmentIO } from '../../src/tools/attachments.js';
import type { AttachmentIO, ResolvedUpload } from '../../src/tools/attachments.js';
import { draftRevision } from '../../src/tools/draft-freshness.js';
import { OFWCache } from '../../src/cache/node.js';
import { sampleMessageRow } from '../_fixtures.js';
import { makeXlsx, xlsxSheetData, makeDocx, makePptx } from '../extract/_ooxml.js';
import { makePdf, showText } from '../extract/_pdf.js';
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
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.folders).toEqual(folders);
    // Fetched live, so it is current by construction — and says so, rather
    // than leaving the caller to guess whether these counts are cached.
    expect(parsed.freshness.source).toBe('live');
    expect(parsed.freshness.staleness).toBe('fresh');
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
      // drafts run first now, then inbox (1 new + empty page), then sent
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{
        id: 1, subject: 'New', from: { name: 'Alice' }, date: { dateTime: '2026-05-04T12:00:00Z' },
        showNeverViewed: true, recipients: [],
      }] })
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

  it('REFUSES to report emptiness from an unverified cache', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_messages')!({ folderId: 'inbox' });
    const parsed = JSON.parse(result.content[0].text);
    // The old shape — `messages: []` alongside a freshness warning — is
    // indistinguishable from a verified "nothing matched" and is exactly what
    // let a stale cache be narrated as an absence.
    expect(result.isError).toBe(true);
    expect(parsed.messages).toBeUndefined();
    expect(parsed.result).toBe('UNVERIFIED_EMPTY');
    expect(parsed.complete).toBe(false);
    expect(parsed.remedy).toMatch(/ofw_sync_messages/);
  });

  it('rejects numeric folder ids as an error, not as an empty result', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_messages')!({ folderId: '42' });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.result).toBe('INVALID_FOLDER');
    expect(parsed.reason).toMatch(/inbox.*sent/);
    expect(parsed.messages).toBeUndefined();
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

  it('sort:"oldest" makes a TRUNCATED page hold the oldest messages, not a reshuffled newest page', async () => {
    // 25 messages across a wide range, read 5 at a time. The point of the
    // parameter is which 5 you get — re-sorting the returned page would give
    // back the same newest 5 in a different order, which is the non-fix.
    for (let i = 0; i < 25; i++) {
      upsertMessage(sampleMessageRow({
        id: 500 + i,
        folder: 'inbox',
        subject: `Msg ${i}`,
        sentAt: new Date(Date.parse('2025-10-01T00:00:00Z') + i * 86400000).toISOString(),
      }));
    }
    markFresh('inbox');
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const call = async (args: Record<string, unknown>) =>
      JSON.parse((await handlers.get('ofw_list_messages')!(args)).content[0].text);

    const oldest = await call({ folderId: 'inbox', since: '2025-10-01', until: '2025-11-14', size: 5, sort: 'oldest' });
    const newest = await call({ folderId: 'inbox', since: '2025-10-01', until: '2025-11-14', size: 5 });

    expect(oldest.total).toBe(25);
    expect(oldest.messages.map((m: { id: number }) => m.id)).toEqual([500, 501, 502, 503, 504]);
    // Disjoint from the default page — not the same rows in another order.
    expect(newest.messages.map((m: { id: number }) => m.id)).toEqual([524, 523, 522, 521, 520]);

    // Truncation is still reported honestly, and the order is named so the
    // caller can tell WHICH 5 of 25 these are.
    expect(oldest.sort).toBe('oldest');
    expect(oldest.complete).toBe(false);
    expect(oldest.note).toMatch(/oldest first/);
    expect(oldest.note).toMatch(/sort:"newest"/);
    // Omitting sort must not change what an existing caller sees.
    expect(newest.sort).toBe('newest');
    expect(newest.note).toMatch(/newest first/);
    // Paging in the requested order stays a partition: no gaps, no repeats.
    const page2 = await call({ folderId: 'inbox', since: '2025-10-01', until: '2025-11-14', size: 5, sort: 'oldest', page: 2 });
    expect(page2.messages.map((m: { id: number }) => m.id)).toEqual([505, 506, 507, 508, 509]);
    // Pure cache read throughout — sorting costs no OFW request.
    expect(spy).not.toHaveBeenCalled();
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
    expect(msg.recipients[0].viewedAt).toBe('2026-07-17T08:37:57-04:00');
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
  it('returns cached drafts without touching OFW when verify:false', async () => {
    upsertDraft({
      id: 5, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);
    const result = await handlers.get('ofw_list_drafts')!({ verify: false });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.drafts).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('auto-verifies by default: an unverified cache triggers a drafts sync so ONE call answers server-confirmed', async () => {
    upsertDraft({
      id: 5, subject: 'stale subject', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      // syncAll: folder resolve, drafts list page, one draft detail.
      .mockResolvedValueOnce({ systemFolders: [
        { id: '1', folderType: 'INBOX' }, { id: '2', folderType: 'SENT_MESSAGES' }, { id: '3', folderType: 'DRAFTS' },
      ] })
      .mockResolvedValueOnce({ data: [{ id: 5, subject: 'server subject', date: { dateTime: '2026-05-04T12:00:00Z' } }] })
      .mockResolvedValueOnce({ subject: 'server subject', body: 'server body' });
    setup(client);

    const result = await handlers.get('ofw_list_drafts')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(spy).toHaveBeenCalled();
    expect(parsed.autoVerified).toBe(true);
    expect(parsed.drafts).toHaveLength(1);
    // The answer reflects the SERVER, not the stale cache, and says so.
    expect(parsed.drafts[0].subject).toBe('server subject');
    expect(parsed.drafts[0].serverConfirmed).toBe(true);
    expect(parsed.complete).toBe(true);
  });

  it('does not re-sync when the drafts cache is already verified-fresh', async () => {
    upsertDraft({
      id: 5, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z', listData: {},
    });
    setMeta('drafts_cache_status', 'fresh');
    const now = new Date().toISOString();
    setMeta('folder_verified_at:drafts', now);
    cache.core.setSyncState('drafts', { lastSyncAt: now, newestId: null, resumePage: null });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const result = await handlers.get('ofw_list_drafts')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(spy).not.toHaveBeenCalled();
    expect(parsed.autoVerified).toBeUndefined();
    expect(parsed.drafts).toHaveLength(1);
  });

  it('REFUSES to report "no drafts" from an unverified cache (verify:false)', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_list_drafts')!({ verify: false });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.drafts).toBeUndefined();
    expect(parsed.result).toBe('UNVERIFIED_EMPTY');
    expect(parsed.complete).toBe(false);
    expect(parsed.remedy).toMatch(/ofw_sync_messages|ofw_status/);
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
    expect(parsed.sentAt).toBe('2026-05-04T08:00:00-04:00');
    expect(parsed.fetchedBodyAt).toBe('2026-05-04T08:00:00-04:00');
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
    upsertDraft({
      id: 42, subject: 'Hello', body: 'World', recipients: [], replyToId: null,
      modifiedAt: '2026-05-03T00:00:00Z', listData: {},
    });
    const c = new OFWClient();
    const spy = vi.spyOn(c, 'request')
      // Guard pre-read: the draft on OFW matches the cached base → FRESH.
      .mockResolvedValueOnce({ subject: 'Hello', body: 'World', recipients: [], replyToId: null, folder: { id: '3', name: 'Drafts' } })
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

    // guard GET + POST + GET + DELETE
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy).toHaveBeenNthCalledWith(1, 'GET', '/pub/v3/messages/42');
    expect(spy).toHaveBeenNthCalledWith(2, 'POST', '/pub/v3/messages', {
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: false,
      replyToId: null,
    });
    expect(spy).toHaveBeenNthCalledWith(3, 'GET', '/pub/v3/messages/200');
    expect(spy).toHaveBeenNthCalledWith(4, 'DELETE', '/pub/v1/messages', expect.any(FormData));
    const deleteForm = spy.mock.calls[3][2] as FormData;
    expect(deleteForm.get('messageIds')).toBe('42');
    expect(result.content[0].text).toContain('"id": 200');
    expect(result.content[0].text).toContain('"draftDeleted": true');
    expect(result.content[0].text).toContain('"sentMessageId": 200');
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
      // Guard pre-read matches the cached base.
      .mockResolvedValueOnce({ subject: 'Re', body: 'b', recipients: [], replyToId: null, folder: { id: '3', name: 'Drafts' } })
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
  it('sends the SERVER draft by messageId alone, defaulting subject/body/recipientIds from it and deleting the draft after the confirmed send', async () => {
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
      // Guard pre-read: the server copy matches the cached base → FRESH.
      .mockResolvedValueOnce({
        subject: 'Re: Weekly of 5/15 - 5/22',
        body: 'Hi Alison,\n\nI adjusted some account settings on my end.',
        recipients: [{ user: { userId: 3039202, name: 'Alison' }, viewed: null }],
        replyToId: null,
        folder: { id: '3', name: 'Drafts' },
      })
      .mockResolvedValueOnce({ entityId: 519117514 })
      .mockResolvedValueOnce({
        id: 519117514,
        subject: 'Re: Weekly of 5/15 - 5/22',
        body: 'Hi Alison,\n\nI adjusted some account settings on my end.',
        date: { dateTime: '2026-05-28T09:03:28Z' },
        from: { name: 'Me' },
        recipients: [{ user: { userId: 3039202, name: 'Alison' }, viewed: null }],
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_send_message')!({ messageId: 519117394 });

    // The content posted is the SERVER draft's — no body re-supply.
    expect(spy).toHaveBeenNthCalledWith(1, 'GET', '/pub/v3/messages/519117394');
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
    // The structured verdict the caller keys off.
    expect(result.content[0].text).toContain('"sentMessageId": 519117514');
    expect(result.content[0].text).toContain('"draftDeleted": true');
    expect(result.content[0].text).toContain('"previousId": 519117394');
  });

  it('sends the SERVER version, not the stale cached one, when only metadata drifted', async () => {
    // The cache is behind on nothing substantive, but the SERVER body is what
    // must go out — the guard read it, so the send uses it directly.
    upsertDraft({
      id: 60, subject: 'S', body: 'server body', recipients: [], replyToId: 100,
      modifiedAt: '2026-05-01T00:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      // Server copy: OFW dropped the replyToId (metadata-only drift → FRESH).
      .mockResolvedValueOnce({ subject: 'S', body: 'server body', recipients: [], replyToId: null, folder: { id: '3', name: 'Drafts' } })
      .mockResolvedValueOnce({ entityId: 61 })
      .mockResolvedValueOnce({
        id: 61, subject: 'S', body: 'server body',
        date: { dateTime: '2026-05-02T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_send_message')!({ messageId: 60, recipientIds: [7] });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    const sent = postCall![2] as { body: string; replyToId: number | null };
    expect(sent.body).toBe('server body');
    // The SERVER's replyToId (null after OFW's normalization) governs, not the
    // cached row's stale 100.
    expect(sent.replyToId).toBeNull();
    expect(result.content[0].text).toMatch(/treated as current for this send/);
  });

  it('uses provided fields as overrides on top of the server draft', async () => {
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
      .mockResolvedValueOnce({
        subject: 'Cached subject', body: 'Cached body',
        recipients: [{ user: { userId: 1, name: 'A' }, viewed: null }],
        replyToId: null, folder: { id: '3', name: 'Drafts' },
      })
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

  it('REFUSES (STALE_DRAFT) when the draft is not in the local cache and no expectedRevision is supplied — no send, nothing deleted', async () => {
    const client = new OFWClient();
    // Only the guard pre-read fires; the send must not.
    const spy = vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'Server-only draft', body: 'server body', recipients: [], replyToId: null,
      folder: { id: '3', name: 'Drafts' },
    });
    setup(client);

    const result = await handlers.get('ofw_send_message')!({ messageId: 99999 });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('STALE_DRAFT');
    // The refusal carries the server content, so nothing is lost.
    expect(parsed.serverBody).toBe('server body');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('GET', '/pub/v3/messages/99999');
  });

  it('REFUSES (MISSING_DRAFT) when the draft is gone from OFW — it may already have been sent', async () => {
    upsertDraft({
      id: 70, subject: 'S', body: 'B', recipients: [], replyToId: null,
      modifiedAt: '2026-05-01T00:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 404 Not Found'));
    setup(client);

    const result = await handlers.get('ofw_send_message')!({ messageId: 70 });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('MISSING_DRAFT');
    expect(parsed.reason).toMatch(/sent or deleted elsewhere/);
    // No POST went out — a missing draft must never become a double-send.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getDraft(70)).not.toBeNull();
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
      .mockResolvedValueOnce({
        subject: 'Re: Original', body: 'reply body',
        recipients: [{ user: { userId: 1, name: 'Alice' }, viewed: null }],
        replyToId: 100, folder: { id: '3', name: 'Drafts' },
      })
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
      .mockResolvedValueOnce({
        subject: 's', body: 'b',
        recipients: [{ user: { userId: 1, name: 'A' }, viewed: null }],
        replyToId: 100, folder: { id: '3', name: 'Drafts' },
      })
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
    upsertDraft({
      id: 99, subject: 'Old subject', body: 'Old body', recipients: [], replyToId: 55,
      modifiedAt: '2026-05-04T00:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({                                       // freshness GET (matches cache)
        subject: 'Old subject', body: 'Old body', replyToId: 55, recipients: [],
      })
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
    upsertDraft({
      id: 444, subject: 'old', body: 'old', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T00:00:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ subject: 'old', body: 'old', replyToId: null, recipients: [] })
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
    expect(result.content[0].text).toMatch(/could NOT be deleted/);
    expect(result.content[0].text).toMatch(/delete blew up/);
    // Partial-failure safety: the new draft is committed AND the old one is
    // kept (both exist) — the create ran before the delete, so nothing is lost.
    expect(getDraft(555)?.body).toBe('b');
    expect(getDraft(444)).not.toBeNull();
    expect(result.content[0].text).toMatch(/BOTH drafts now exist/);
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

describe('ofw_save_draft — stale-overwrite guard', () => {
  // The incident this guards: a user edited a draft in the OFW web app, the
  // edit never reached the cache, and ofw_save_draft's create-then-delete
  // destroyed it. Replacing a draft does not merge — it DESTROYS.
  const cachedBase = {
    id: 500, subject: 'Pickup', body: 'cached body', recipients: [],
    replyToId: null, modifiedAt: '2026-07-19T12:42:00Z', listData: {},
  };
  const serverEdited = {
    subject: 'Pickup', body: 'the edits made in the web app', replyToId: null, recipients: [],
  };

  it('refuses to overwrite when the server draft diverges from the cached base', async () => {
    upsertDraft(cachedBase);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce(serverEdited);
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBe('STALE_DRAFT');
    expect(payload.draftId).toBe(500);
    expect(payload.changedFields).toContain('body');
    // The content we declined to destroy rides along, so it is not lost.
    expect(payload.serverBody).toBe('the edits made in the web app');
    expect(payload.cachedBody).toBe('cached body');
    expect(payload.recovery).toMatch(/expectedRevision/);
    // NO destructive side effect whatsoever.
    expect(spy.mock.calls.some((c) => c[0] === 'POST')).toBe(false);
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
    expect(getDraft(500)?.body).toBe('cached body');
  });

  it('refuses when expectedRevision is older than the live server revision', async () => {
    upsertDraft(cachedBase);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce(serverEdited);
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup',
      body: 'my new body',
      messageId: 500,
      expectedRevision: draftRevision({
        subject: 'Pickup', body: 'cached body', replyToId: null, recipients: [],
      }),
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).reason).toMatch(/expectedRevision/);
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
  });

  it('allows the overwrite when expectedRevision matches the server, deleting the old id only after the new one is confirmed', async () => {
    upsertDraft(cachedBase);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverEdited)                    // freshness GET
      .mockResolvedValueOnce({ entityId: 501 })               // POST create
      .mockResolvedValueOnce({                                // GET detail (confirms create)
        id: 501, subject: 'Pickup', body: 'my new body',
        date: { dateTime: '2026-07-19T13:30:00Z' },
      })
      .mockResolvedValueOnce({});                             // DELETE old
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup',
      body: 'my new body',
      messageId: 500,
      expectedRevision: draftRevision(serverEdited),
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/replaced draft 500 via create-then-delete/);
    expect(getDraft(501)?.body).toBe('my new body');
    expect(getDraft(500)).toBeNull();

    // Ordering matters: the replacement must be confirmed before the old draft
    // is destroyed, so a failed create can never leave the user with neither.
    const kinds = spy.mock.calls.map((c) => c[0]);
    expect(kinds.indexOf('POST')).toBeLessThan(kinds.indexOf('DELETE'));
    expect(kinds.lastIndexOf('GET')).toBeLessThan(kinds.indexOf('DELETE'));
  });

  it('force:true overwrites a stale draft but echoes the discarded server version and warns', async () => {
    upsertDraft(cachedBase);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverEdited)
      .mockResolvedValueOnce({ entityId: 501 })
      .mockResolvedValueOnce({
        id: 501, subject: 'Pickup', body: 'my new body',
        date: { dateTime: '2026-07-19T13:30:00Z' },
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500, force: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/WARNING: force:true overrode a STALE/);
    // The destroyed content is recoverable from the tool result itself.
    expect(result.content[0].text).toMatch(/the edits made in the web app/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/force:true overrode a STALE verdict on draft 500/));
    expect(getDraft(501)?.body).toBe('my new body');
    warn.mockRestore();
  });

  it('aborts the write when the freshness check itself fails (never a blind overwrite)', async () => {
    upsertDraft(cachedBase);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockRejectedValueOnce(
      new Error('OFW API error: 503 Service Unavailable for GET /pub/v3/messages/500'),
    );
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('FRESHNESS_CHECK_FAILED');
    expect(spy.mock.calls.some((c) => c[0] === 'POST')).toBe(false);
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
    expect(getDraft(500)?.body).toBe('cached body');
  });

  it('force:true proceeds even when the freshness check could not run, and says so', async () => {
    upsertDraft(cachedBase);
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockRejectedValueOnce(new Error('OFW API error: 503 Service Unavailable for GET /pub/v3/messages/500'))
      .mockResolvedValueOnce({ entityId: 501 })
      .mockResolvedValueOnce({
        id: 501, subject: 'Pickup', body: 'my new body',
        date: { dateTime: '2026-07-19T13:30:00Z' },
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500, force: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/current state could not be read/);
    expect(result.content[0].text).toMatch(/NOT recoverable/);
  });

  it('force:true on a draft already gone from OFW reports that there was nothing to preserve', async () => {
    upsertDraft(cachedBase);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockRejectedValueOnce(new Error('OFW API error: 404 Not Found for GET /pub/v3/messages/500'))
      .mockResolvedValueOnce({ entityId: 501 })
      .mockResolvedValueOnce({
        id: 501, subject: 'Pickup', body: 'my new body',
        date: { dateTime: '2026-07-19T13:30:00Z' },
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500, force: true,
    });

    expect(result.content[0].text).toMatch(/no longer existed on OurFamilyWizard/);
    expect(result.content[0].text).toMatch(/"overwrittenServerDraft": null/);
    warn.mockRestore();
  });

  it('refuses a replace when the id is absent from the cache (no base to compare)', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce(serverEdited);
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).serverBody).toBe('the edits made in the web app');
  });

  it('leaves the plain create path (no messageId) unguarded — nothing is destroyed', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 600 })
      .mockResolvedValueOnce({
        id: 600, subject: 'Fresh', body: 'brand new',
        date: { dateTime: '2026-07-19T13:30:00Z' },
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({ subject: 'Fresh', body: 'brand new' });

    expect(result.isError).toBeFalsy();
    // First call is the POST — no freshness GET was needed.
    expect(spy.mock.calls[0][0]).toBe('POST');
    expect(getDraft(600)?.body).toBe('brand new');
  });

  it('after a sync that never verified drafts, a stale cached base still blocks the overwrite', async () => {
    // Regression for the reported incident end-to-end: the drafts pass was
    // deferred for budget, so the cache is unverified AND behind the server.
    setMeta('drafts_cache_status', 'unverified');
    upsertDraft(cachedBase);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce(serverEdited);
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('STALE_DRAFT');
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
  });
});

describe('ofw_save_draft — threading & field preservation (Defects 1 & 3)', () => {
  // ofw_save_draft returns human-readable notes prepended to the JSON payload,
  // so parse from the first `{` (notes never contain one) to reach the object.
  const trailingJson = (text: string): Record<string, unknown> =>
    JSON.parse(text.slice(text.indexOf('{')));

  it('save-then-edit round trip is not refused when OFW normalized replyToId in between', async () => {
    // 1. Create a reply-draft; capture the revision it returns.
    // 2. Immediately edit it using THAT revision — even though OFW dropped the
    //    reply link server-side, the body/subject/recipients are unchanged, so
    //    the guard must treat it as current, not STALE.
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 700 })                       // create POST
      .mockResolvedValueOnce({                                        // create detail (echoes replyToId)
        id: 700, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' }, replyToId: 100,
      })
      .mockResolvedValueOnce({                                        // guard fetch: OFW normalized replyToId → null
        subject: 'S', body: 'B', replyToId: null, recipients: [],
      })
      .mockResolvedValueOnce({ entityId: 701 })                       // replace POST
      .mockResolvedValueOnce({                                        // replace detail
        id: 701, subject: 'S', body: 'B edited',
        date: { dateTime: '2026-07-20T00:05:00Z' }, replyToId: 100,
      })
      .mockResolvedValueOnce({});                                     // DELETE old 700
    setup(client);

    const created = JSON.parse((await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', replyToId: 100,
    })).content[0].text);
    expect(created.revision).toBeDefined();

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B edited', messageId: 700,
      expectedRevision: created.revision,
    });

    // Not refused — the only server-side change was connector-authored metadata.
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toMatch(/STALE_DRAFT/);
    expect(result.content[0].text).toMatch(/normalized connector-authored metadata/);
    expect(getDraft(701)?.body).toBe('B edited');
    expect(getDraft(700)).toBeNull();
    // The replacement actually went out (POST + DELETE both happened).
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(true);
  });

  it('a genuinely stale server body still refuses even with a matching-for-metadata token', async () => {
    // Regression guard: the metadata relaxation must not let a real edit slip
    // through. Server body diverges → STALE, nothing destroyed.
    upsertDraft({
      id: 500, subject: 'Pickup', body: 'cached body', recipients: [],
      replyToId: 100, modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({
      subject: 'Pickup', body: 'edited in the web app', replyToId: null, recipients: [],
    });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Pickup', body: 'my new body', messageId: 500,
      expectedRevision: draftRevision({
        subject: 'Pickup', body: 'cached body', replyToId: 100, recipients: [],
      }),
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBe('STALE_DRAFT');
    expect(payload.serverBody).toBe('edited in the web app');
    expect(spy.mock.calls.some((c) => c[0] === 'POST')).toBe(false);
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
  });

  it('warns loudly (no silent null) when OFW drops the requested replyToId', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 800 })
      .mockResolvedValueOnce({                                        // OFW positively reports NO reply linkage
        id: 800, subject: 'Re: pickup', body: 'reply',
        date: { dateTime: '2026-07-20T00:00:00Z' },
        replyToId: null, inReplyTo: null, showContext: false,
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re: pickup', body: 'reply', replyToId: 100,
    });

    expect(result.content[0].text).toMatch(/WARNING/);
    expect(result.content[0].text).toMatch(/did not thread this draft/);
    const parsed = trailingJson(result.content[0].text);
    // The dropped link is surfaced honestly, not masked with the posted intent.
    expect(parsed.replyToId).toBeNull();
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/replyToId was requested as 100/)]));
    // And the cache reflects the truth, not the intent.
    expect(getDraft(800)?.replyToId).toBeNull();
  });

  it('does not warn when OFW honors the requested replyToId', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 801 })
      .mockResolvedValueOnce({
        id: 801, subject: 'Re: pickup', body: 'reply',
        date: { dateTime: '2026-07-20T00:00:00Z' }, replyToId: 100,
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re: pickup', body: 'reply', replyToId: 100,
    });

    expect(result.content[0].text).not.toMatch(/WARNING/);
    const parsed = trailingJson(result.content[0].text);
    expect(parsed.replyToId).toBe(100);
    expect(parsed.inReplyTo).toBe(100);
    expect(parsed.warnings).toBeUndefined();
  });

  it('the returned revision matches what ofw_check_freshness reports immediately after', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 900 })
      .mockResolvedValueOnce({                                        // save detail
        id: 900, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' }, replyToId: 100,
      })
      .mockResolvedValueOnce({                                        // check_freshness live fetch (same state)
        subject: 'S', body: 'B', replyToId: 100, recipients: [],
        folder: { id: 3, name: 'Drafts' },
      });
    // Folder ids a prior sync would have persisted — without them the probe
    // spends a request re-resolving the map.
    setMeta('inbox_folder_id', '1');
    setMeta('sent_folder_id', '2');
    setMeta('drafts_folder_id', '3');
    setup(client);

    const saved = JSON.parse((await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', replyToId: 100,
    })).content[0].text);

    const checked = JSON.parse((await handlers.get('ofw_check_freshness')!({
      messageIds: [900],
    })).content[0].text);

    expect(checked.items[0].serverRevision).toBe(saved.revision);
    expect(checked.items[0].cacheRevision).toBe(saved.revision);
    expect(checked.items[0].inSync).toBe(true);
  });

  it('warns when requested recipientIds are not all carried onto the saved draft', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 810 })
      .mockResolvedValueOnce({
        id: 810, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' },
        recipients: [{ user: { userId: 1, name: 'A' } }],       // only 1 of the two requested
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', recipientIds: [1, 2],
    });

    expect(result.content[0].text).toMatch(/WARNING/);
    const parsed = trailingJson(result.content[0].text);
    expect(parsed.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/recipientIds were requested as \[1, 2\]/)]));
  });

  it('warns when a requested attachment did not attach to the saved draft', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 820 })
      .mockResolvedValueOnce({
        id: 820, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' },
        files: [5],                                              // 6 was requested but missing
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', myFileIDs: [5, 6],
    });

    expect(result.content[0].text).toMatch(/WARNING/);
    const parsed = trailingJson(result.content[0].text);
    expect(parsed.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/fileId\(s\) 6 .*not attached/)]));
  });

  it('names the rewritten thread tip in the warning when a rewritten replyToId is then dropped', async () => {
    // The connector re-targets replyToId to the chain tip (100 → 142), then OFW
    // drops it entirely. The warning must name both the effective request and
    // where it was rewritten from.
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
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 830 })
      .mockResolvedValueOnce({
        id: 830, subject: 'Re: Original', body: 'reply',
        date: { dateTime: '2026-07-20T00:00:00Z' },
        replyToId: null, inReplyTo: null, showContext: false,
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re: Original', body: 'reply', replyToId: 100,
    });

    expect(result.content[0].text).toMatch(/replyToId was requested as 142 \(rewritten from 100\)/);
  });

  it('warns when OFW re-targets replyToId to a different (non-null) message', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 840 })
      .mockResolvedValueOnce({
        id: 840, subject: 'Re', body: 'reply',
        date: { dateTime: '2026-07-20T00:00:00Z' }, replyToId: 200,   // not the requested 100
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re', body: 'reply', replyToId: 100,
    });

    expect(result.content[0].text).toMatch(/came back with replyToId 200/);
    expect(trailingJson(result.content[0].text).replyToId).toBe(200);
  });

  it('does not warn when every requested recipient is carried over', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 860 })
      .mockResolvedValueOnce({
        id: 860, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' },
        recipients: [{ user: { userId: 2, name: 'B' } }, { user: { userId: 1, name: 'A' } }],
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', recipientIds: [1, 2],
    });

    expect(result.content[0].text).not.toMatch(/WARNING/);
    expect(trailingJson(result.content[0].text).warnings).toBeUndefined();
  });

  it('does not warn when every requested attachment is present', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 870 })
      .mockResolvedValueOnce({
        id: 870, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' }, files: [5, 6],
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', myFileIDs: [5, 6],
    });

    expect(result.content[0].text).not.toMatch(/WARNING/);
  });

  it('the replace NOTE points at the warnings when a carried-over field was dropped', async () => {
    upsertDraft({
      id: 850, subject: 'S', body: 'B', recipients: [], replyToId: 100,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ subject: 'S', body: 'B', replyToId: 100, recipients: [] }) // guard FRESH
      .mockResolvedValueOnce({ entityId: 851 })
      .mockResolvedValueOnce({
        id: 851, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' },
        replyToId: null, inReplyTo: null, showContext: false,          // OFW positively dropped the reply link
      })
      .mockResolvedValueOnce({});                                       // DELETE old 850
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', messageId: 850, replyToId: 100,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/replaced draft 850 via create-then-delete/);
    expect(result.content[0].text).toMatch(/See warnings above/);
    expect(result.content[0].text).toMatch(/did not thread this draft/);
  });

  it('says the reply was RE-TARGETED, not dropped, when OFW threads it elsewhere', async () => {
    // OFW normalizes a reply to the thread tip rather than dropping it. The
    // old warning called that "did not thread this draft (its inReplyTo will
    // be empty)" while the same response echoed inReplyTo: 205 — a warning the
    // caller can see is false is a warning it learns to skip.
    upsertDraft({
      id: 860, subject: 'S', body: 'B', recipients: [], replyToId: 200,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ subject: 'S', body: 'B', replyToId: 200, recipients: [] }) // guard FRESH
      .mockResolvedValueOnce({ entityId: 861 })
      .mockResolvedValueOnce({
        id: 861, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-20T00:00:00Z' },
        replyToId: 205, // re-targeted to the thread tip, NOT dropped
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', messageId: 860, replyToId: 200,
    });
    const text = result.content[0].text;

    expect(text).toMatch(/re-targeted the reply to message 205/);
    expect(text).toMatch(/The draft IS threaded/);
    expect(text).not.toMatch(/did not thread this draft/);
    expect(text).not.toMatch(/inReplyTo\/showContext will be empty/);
    // …and the response's own echo agrees with the warning.
    expect(JSON.parse(text.slice(text.indexOf('{'))).inReplyTo).toBe(205);
  });
});

describe('draft reads expose revision + cacheStatus', () => {
  const row = {
    id: 500, subject: 'Pickup', body: 'cached body', recipients: [],
    replyToId: null, modifiedAt: '2026-07-19T12:42:00Z', listData: {},
  };

  // What a COMPLETED drafts walk leaves behind: the folder was diffed against
  // OFW ('fresh') *and* stamped with when that happened. Both are required —
  // reads downgrade to unverified without a recent verification stamp, so that
  // a walk which completed hours ago can't still pass as current.
  const markDraftsVerified = (at: string = new Date().toISOString()): void => {
    setMeta('drafts_cache_status', 'fresh');
    setMeta('folder_verified_at:drafts', at);
  };

  it('ofw_list_drafts stamps each draft with a revision and the cache status', async () => {
    upsertDraft(row);
    markDraftsVerified();
    setup(makeClient({}));

    const parsed = JSON.parse((await handlers.get('ofw_list_drafts')!({})).content[0].text);

    expect(parsed.drafts[0].revision).toBe(draftRevision({
      subject: 'Pickup', body: 'cached body', replyToId: null, recipients: [],
    }));
    expect(parsed.drafts[0].cacheStatus).toBe('fresh');
    expect(parsed.drafts[0].serverConfirmed).toBe(true);
    expect(parsed.freshness.staleness).toBe('fresh');
    expect(parsed.note).toBeUndefined();
  });

  it('downgrades a completed-but-aged drafts walk to unverified', async () => {
    // The walk finished, but long enough ago that a co-parent could have
    // edited or deleted the draft in the web app since — which bumps no
    // timestamp, so nothing else would ever reveal it.
    upsertDraft(row);
    markDraftsVerified(new Date(Date.now() - 3600_000).toISOString());
    setup(makeClient({}));

    const parsed = JSON.parse((await handlers.get('ofw_list_drafts')!({ verify: false })).content[0].text);

    expect(parsed.drafts[0].cacheStatus).toBe('unverified');
    expect(parsed.drafts[0].serverConfirmed).toBe(false);
    expect(parsed.freshness.staleness).toBe('unverified');
    expect(parsed.freshness.ageSeconds).toBeGreaterThanOrEqual(3600);
    expect(parsed.note).toMatch(/still sitting unsent/);
  });

  it('ofw_list_drafts reports unverified and warns when the drafts pass was deferred', async () => {
    upsertDraft(row);
    setMeta('drafts_cache_status', 'unverified');
    setup(makeClient({}));

    const parsed = JSON.parse((await handlers.get('ofw_list_drafts')!({ verify: false })).content[0].text);

    expect(parsed.drafts[0].cacheStatus).toBe('unverified');
    expect(parsed.drafts[0].serverConfirmed).toBe(false);
    expect(parsed.note).toMatch(/may be behind the server/);
  });

  it('treats a never-synced drafts cache as unverified', async () => {
    upsertDraft(row);
    setup(makeClient({}));

    const parsed = JSON.parse((await handlers.get('ofw_list_drafts')!({ verify: false })).content[0].text);

    expect(parsed.drafts[0].cacheStatus).toBe('unverified');
  });

  it('ofw_get_message returns revision + cacheStatus for a draft id', async () => {
    upsertDraft(row);
    markDraftsVerified();
    setup(makeClient({}));

    const parsed = JSON.parse(
      (await handlers.get('ofw_get_message')!({ messageId: '500' })).content[0].text,
    );

    expect(parsed.folder).toBe('drafts');
    expect(parsed.cacheStatus).toBe('fresh');
    expect(parsed.serverConfirmed).toBe(true);
    expect(parsed.freshness.staleness).toBe('fresh');
    expect(parsed.revision).toBe(draftRevision({
      subject: 'Pickup', body: 'cached body', replyToId: null, recipients: [],
    }));
  });
});

describe('ofw_delete_draft', () => {
  // Every delete now re-reads the draft from OFW first (the freshness guard),
  // so each test mocks that GET before the DELETE.
  const seedDraft = (id: number): void => upsertDraft({
    id, subject: 'D', body: 'b', recipients: [], replyToId: null,
    modifiedAt: '2026-05-04T00:00:00Z', listData: {},
  });
  const serverMatching = { subject: 'D', body: 'b', replyToId: null, recipients: [] };

  it('deletes a draft by messageId using multipart form when the cache is current', async () => {
    seedDraft(42);
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverMatching) // freshness GET
      .mockResolvedValueOnce({}); // DELETE
    setup(client);

    const result = await handlers.get('ofw_delete_draft')!({ messageId: 42 });

    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v1/messages', expect.any(FormData));
    const deleteCall = (client.request as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === 'DELETE')!;
    expect((deleteCall[2] as FormData).get('messageIds')).toBe('42');
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBeFalsy();
  });

  it('removes the draft from cache after OFW delete', async () => {
    seedDraft(50);
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverMatching)
      .mockResolvedValueOnce(null);
    setup(client);

    await handlers.get('ofw_delete_draft')!({ messageId: 50 });
    expect(getDraft(50)).toBeNull();
  });

  it('REFUSES to delete a draft that changed on OFW since it was cached', async () => {
    seedDraft(50);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ ...serverMatching, body: 'edited in the web app' });
    setup(client);

    const result = await handlers.get('ofw_delete_draft')!({ messageId: 50 });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBe('STALE_DRAFT');
    expect(payload.serverBody).toBe('edited in the web app');
    // No destructive side effect: no DELETE issued, draft still cached.
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
    expect(getDraft(50)).not.toBeNull();
  });

  it('deletes a changed draft when expectedRevision names the server version', async () => {
    seedDraft(50);
    const server = { ...serverMatching, body: 'edited in the web app' };
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(server)
      .mockResolvedValueOnce(null);
    setup(client);

    const result = await handlers.get('ofw_delete_draft')!({
      messageId: 50,
      expectedRevision: draftRevision({
        subject: 'D', body: 'edited in the web app', replyToId: null, recipients: [],
      }),
    });

    expect(result.isError).toBeFalsy();
    expect(getDraft(50)).toBeNull();
  });

  it('force:true deletes a changed draft and echoes the discarded server version', async () => {
    seedDraft(50);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ ...serverMatching, body: 'edited in the web app' })
      .mockResolvedValueOnce({ deleted: 1 });
    setup(client);

    const result = await handlers.get('ofw_delete_draft')!({ messageId: 50, force: true });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/force:true overrode a STALE/);
    // The deleted content survives in the tool result.
    expect(result.content[0].text).toMatch(/edited in the web app/);
    expect(getDraft(50)).toBeNull();
    warn.mockRestore();
  });

  it('reports MISSING_DRAFT without issuing a DELETE when the draft is gone from OFW', async () => {
    seedDraft(50);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockRejectedValueOnce(
      new Error('OFW API error: 404 Not Found for GET /pub/v3/messages/50'),
    );
    setup(client);

    const result = await handlers.get('ofw_delete_draft')!({ messageId: 50 });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('MISSING_DRAFT');
    expect(spy.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
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
    expect(parsed.unread).toEqual([
      {
        id: 1,
        subject: 'Schedule',
        sentAt: '2026-05-04T08:00:00-04:00',
        sentAtDisplay: 'Mon, May 4, 2026, 8:00 AM EDT',
        unreadBy: ['Alice'],
      },
    ]);
    // Read state here comes entirely from cached view timestamps, so the
    // result must carry the same age label as any other cached read.
    expect(parsed.freshness.source).toBe('cache');
    expect(spy).not.toHaveBeenCalled();
  });

  it('REFUSES to answer from an unverified, empty sent cache', async () => {
    const client = new OFWClient();
    setup(client);
    const result = await handlers.get('ofw_get_unread_sent')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.result).toBe('UNVERIFIED_EMPTY');
    expect(parsed.remedy).toMatch(/ofw_sync_messages/);
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
    // Must NOT read as a bare present-tense "everything has been read" — a
    // recipient can read a message without the cache hearing about it.
    expect(parsed.message).toMatch(/as of the timestamp in `freshness.asOf`/);
    expect(parsed.unread).toEqual([]);
    expect(parsed.freshness).toBeDefined();
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

describe('mark-read gate (issue #192)', () => {
  const KEY = 'OFW_ALLOW_MARK_READ';
  let prevAllow: string | undefined;
  beforeEach(() => { prevAllow = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => {
    if (prevAllow === undefined) delete process.env[KEY];
    else process.env[KEY] = prevAllow;
  });

  /** An inbox row scraped by a list sync: no body yet, never viewed. */
  const unreadInbox = (id: number) => sampleMessageRow({
    id, folder: 'inbox', body: null, fetchedBodyAt: null,
    recipients: [{ userId: 1, name: 'Me', viewedAt: null }],
    listData: { id, showNeverViewed: true },
  });

  it('fetches an unread body by default — unchanged behaviour', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue({
      id: 700, subject: 'S', body: 'live body', from: { name: 'Alice' },
      date: { dateTime: '2026-05-04T12:00:00Z' }, recipients: [],
    });
    upsertMessage(unreadInbox(700));
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_get_message')!({ messageId: '700' })).content[0].text);
    expect(parsed.body).toBe('live body');
    expect(spy).toHaveBeenCalled();
  });

  it('refuses the fetch when the caller opts out, without contacting OFW', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    upsertMessage(unreadInbox(701));
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '701', allowMarkRead: false });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('MARK_READ_BLOCKED');
    expect(parsed.messageId).toBe(701);
    expect(parsed.note).toMatch(/First Viewed/);
    // The refusal must not be the thing that stamps the record.
    expect(spy).not.toHaveBeenCalled();
  });

  it('still serves a cached body when the caller opts out — nothing to stamp', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    upsertMessage(sampleMessageRow({ id: 702, folder: 'inbox', body: 'already here' }));
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_get_message')!({ messageId: '702', allowMarkRead: false })).content[0].text,
    );
    expect(parsed.body).toBe('already here');
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows a SENT body fetch when the caller opts out — our own message stamps nothing', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      id: 703, subject: 'S', body: 'sent body', from: { name: 'Me' },
      date: { dateTime: '2026-05-04T12:00:00Z' }, recipients: [],
    });
    upsertMessage(sampleMessageRow({ id: 703, folder: 'sent', body: null, fetchedBodyAt: null }));
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_get_message')!({ messageId: '703', allowMarkRead: false })).content[0].text,
    );
    expect(parsed.body).toBe('sent body');
  });

  it('allows an ALREADY-READ inbox body fetch when the caller opts out — the stamp exists', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      id: 704, subject: 'S', body: 'refetched', from: { name: 'Alice' },
      date: { dateTime: '2026-05-04T12:00:00Z' }, recipients: [],
    });
    // Body dropped from the cache, but a recipient view time proves it was
    // already opened: re-fetching cannot stamp a First Viewed that exists.
    upsertMessage(sampleMessageRow({
      id: 704, folder: 'inbox', body: null, fetchedBodyAt: null,
      recipients: [{ userId: 1, name: 'Me', viewedAt: '2026-05-04T13:00:00Z' }],
    }));
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_get_message')!({ messageId: '704', allowMarkRead: false })).content[0].text,
    );
    expect(parsed.body).toBe('refetched');
  });

  it('refuses an id it has never seen — it cannot know whether that would stamp', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '705', allowMarkRead: false });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).reason).toMatch(/not in the cache/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('OFW_ALLOW_MARK_READ=false blocks it with no argument at all', async () => {
    process.env[KEY] = 'false';
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    upsertMessage(unreadInbox(706));
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '706' });
    expect(result.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('OFW_ALLOW_MARK_READ=false is a ceiling: allowMarkRead:true cannot raise it', async () => {
    process.env[KEY] = 'false';
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    upsertMessage(unreadInbox(707));
    setup(client);

    const result = await handlers.get('ofw_get_message')!({ messageId: '707', allowMarkRead: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).note).toMatch(/OFW_ALLOW_MARK_READ/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('OFW_FETCH_UNREAD_BODIES=true flips the sync default; the ceiling still overrides it', async () => {
    const prevFetch = process.env.OFW_FETCH_UNREAD_BODIES;
    process.env.OFW_FETCH_UNREAD_BODIES = 'true';
    try {
      const client = new OFWClient();
      vi.spyOn(client, 'request').mockResolvedValue({ systemFolders: [] });
      const syncSpy = vi.spyOn(syncModule, 'syncAll').mockResolvedValue({
        synced: {}, refreshed: [], notRefreshed: [], syncComplete: true, unreadWithoutBodies: [],
      } as never);
      setup(client);

      await handlers.get('ofw_sync_messages')!({});
      expect(syncSpy.mock.calls[0][1]).toMatchObject({ fetchUnreadBodies: true });

      // The ceiling is not a default — it overrides the env default too.
      process.env.OFW_ALLOW_MARK_READ = 'false';
      await handlers.get('ofw_sync_messages')!({});
      expect(syncSpy.mock.calls[1][1]).toMatchObject({ fetchUnreadBodies: false });

      // …and an explicit argument cannot raise it either.
      await handlers.get('ofw_sync_messages')!({ fetchUnreadBodies: true });
      expect(syncSpy.mock.calls[2][1]).toMatchObject({ fetchUnreadBodies: false });
    } finally {
      if (prevFetch === undefined) delete process.env.OFW_FETCH_UNREAD_BODIES;
      else process.env.OFW_FETCH_UNREAD_BODIES = prevFetch;
    }
  });

  it('caps ofw_check_freshness: allowMarkRead:true is ignored under the ceiling', async () => {
    process.env[KEY] = 'false';
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue({ systemFolders: [] });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!({
      messageIds: [708], allowMarkRead: true,
    })).content[0].text);

    expect(parsed.items[0]).toMatchObject({ id: 708, skipped: true, reason: 'WOULD_MARK_READ' });
    // Folder counts are free; the id probe is what would have stamped.
    expect(spy).not.toHaveBeenCalled();
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
      const meta = JSON.parse(result.content[0].text);
      expect(meta.mode).toBe('inline');
      // A text file is delivered as its content, not as bytes the host may refuse.
      expect(meta.deliveredVia).toBe('extracted');
      expect(meta.extracted).toEqual({ kind: 'text', text: bytes.toString('utf8') });
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
      const meta = JSON.parse(result.content[0].text);
      expect(meta.extracted).toEqual({ kind: 'text', text: 'local-copy' });
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
      const meta = JSON.parse(result.content[0].text);
      expect(meta.extracted).toEqual({ kind: 'text', text: 'fresh-bytes' });
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

  // Real magic-number signatures for the sniff path.
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngFixture = (extra = 'png-body'): Buffer => Buffer.concat([PNG_SIG, Buffer.from(extra)]);
  const jpegFixture = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
  const gifFixture = (): Buffer => Buffer.from('GIF89a' + 'gif-body');
  const webpFixture = (): Buffer => Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('webp-body'),
  ]);

  // Build a fresh handler set backed by a hosted (no-filesystem) AttachmentIO.
  function setupHosted(client: OFWClient): Map<string, ToolHandler> {
    const hostedIO: AttachmentIO = {
      supportsDisk: false,
      resolveUpload: (): Promise<ResolvedUpload> => Promise.reject(new Error('no disk')),
      readDownloaded: (): Buffer | null => { throw new Error('no disk'); },
      writeDownload: (): void => { throw new Error('no disk'); },
    };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const localHandlers = new Map<string, ToolHandler>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
      localHandlers.set(name, cb as ToolHandler);
      return undefined as never;
    });
    registerMessageTools(server, client, cacheProvider, hostedIO);
    return localHandlers;
  }

  it('strips a charset parameter off an image Content-Type before rendering (repro fileId 57291220)', async () => {
    const client = new OFWClient();
    const bytes = pngFixture('IMG_9905');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 57291220, fileName: 'IMG_9905.png', label: 'IMG_9905.png',
      fileType: 'image/png', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      // OFW hands back a bogus charset on a binary attachment.
      body: bytes, contentType: 'image/png;charset=UTF-8', suggestedFileName: 'IMG_9905.png',
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 57291220, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.mimeType).toBe('image/png');
    const img = result.content[1];
    expect(img.type).toBe('image');
    // Bare media type only — no ";" parameter the host would reject.
    expect(img.mimeType).toBe('image/png');
    expect(img.mimeType).not.toContain(';');
    expect(Buffer.from(img.data, 'base64').equals(bytes)).toBe(true);
  });

  it('sniffs a PNG from the bytes when the upstream Content-Type is wrong', async () => {
    const client = new OFWClient();
    const bytes = pngFixture();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 201, fileName: 'photo.bin', label: 'photo.bin',
      fileType: 'application/octet-stream', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      // Lying header + non-image extension — only the magic number is truthful.
      body: bytes, contentType: 'text/plain;charset=UTF-8', suggestedFileName: 'photo.bin',
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 201, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.mimeType).toBe('image/png');
    expect(result.content[1].type).toBe('image');
    expect(result.content[1].mimeType).toBe('image/png');
  });

  it.each([
    ['JPEG', 'image/jpeg', 'image/jpeg;charset=UTF-8', 'p.jpg', jpegFixture],
    ['GIF', 'image/gif', 'image/gif; charset=binary', 'p.gif', gifFixture],
    ['WEBP', 'image/webp', 'image/webp;charset=UTF-8', 'p.webp', webpFixture],
  ] as const)('normalizes a parameter-laden %s Content-Type and renders it inline', async (_label, bare, header, name, make) => {
    const client = new OFWClient();
    const bytes = make();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 300, fileName: name, label: name, fileType: bare, fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: header, suggestedFileName: name,
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 300, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.mimeType).toBe(bare);
    const img = result.content[1];
    expect(img.type).toBe('image');
    expect(img.mimeType).toBe(bare);
    expect(Buffer.from(img.data, 'base64').equals(bytes)).toBe(true);
  });

  it('returns a non-renderable type (docx) as an EmbeddedResource with a normalized mime', async () => {
    const client = new OFWClient();
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const bytes = Buffer.from('PK\x03\x04 fake docx', 'binary');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 400, fileName: 'brief.docx', label: 'brief.docx', fileType: docx, fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: `${docx}; name=brief.docx`, suggestedFileName: 'brief.docx',
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 400, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.mimeType).toBe(docx);
    const res = result.content[1];
    expect(res.type).toBe('resource');
    expect(res.resource.mimeType).toBe(docx);
    expect(res.resource.mimeType).not.toContain(';');
    expect(Buffer.from(res.resource.blob, 'base64').equals(bytes)).toBe(true);
  });

  it('normalizes a PDF Content-Type carrying a name parameter', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('%PDF-1.7 body', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 500, fileName: 'statement.pdf', label: 'statement.pdf',
      fileType: 'application/pdf', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: 'application/pdf; name="statement.pdf"', suggestedFileName: 'statement.pdf',
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 500, inline: true });
    expect(result.content[1].resource.mimeType).toBe('application/pdf');
  });

  it('hosted (no disk): explicit inline:false still returns bytes and marks forcedInline', async () => {
    const client = new OFWClient();
    const bytes = pngFixture('hosted');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 600, fileName: 'kid.png', label: 'kid.png',
      fileType: 'image/png', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: 'image/png;charset=UTF-8', suggestedFileName: 'kid.png',
    });
    const hosted = setupHosted(client);

    // Caller asks for disk explicitly; the connector has none, so inline is forced
    // rather than erroring — the request must not be a dead end.
    const result = await hosted.get('ofw_download_attachment')!({ fileId: 600, inline: false, saveTo: '/tmp/x.png' });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.mode).toBe('inline');
    expect(meta.forcedInline).toBe(true);
    expect(meta.mimeType).toBe('image/png');
    const img = result.content[1];
    expect(img.type).toBe('image');
    expect(Buffer.from(img.data, 'base64').equals(bytes)).toBe(true);
  });

  it('hosted (no disk): default inline is not marked forcedInline', async () => {
    const prev = process.env.OFW_INLINE_ATTACHMENTS;
    process.env.OFW_INLINE_ATTACHMENTS = 'true';
    try {
      const client = new OFWClient();
      const bytes = pngFixture('default');
      vi.spyOn(client, 'request').mockResolvedValueOnce({
        fileId: 601, fileName: 'kid.png', label: 'kid.png',
        fileType: 'image/png', fileSize: bytes.length,
      });
      vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
        body: bytes, contentType: 'image/png', suggestedFileName: 'kid.png',
      });
      const hosted = setupHosted(client);

      const result = await hosted.get('ofw_download_attachment')!({ fileId: 601 });
      const meta = JSON.parse(result.content[0].text);
      expect(meta.mode).toBe('inline');
      expect(meta.forcedInline).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OFW_INLINE_ATTACHMENTS;
      else process.env.OFW_INLINE_ATTACHMENTS = prev;
    }
  });

  it('byte integrity: inline base64 round-trips a large image unchanged', async () => {
    const client = new OFWClient();
    // A body large enough to exercise base64 chunking; deterministic contents.
    const big = Buffer.concat([PNG_SIG, Buffer.alloc(525245 - PNG_SIG.length, 0xab)]);
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 57291220, fileName: 'IMG_9905.png', label: 'IMG_9905.png',
      fileType: 'image/png', fileSize: big.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: big, contentType: 'image/png;charset=UTF-8', suggestedFileName: 'IMG_9905.png',
    });
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 57291220, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.sizeBytes).toBe(525245);
    const decoded = Buffer.from(result.content[1].data, 'base64');
    expect(decoded.length).toBe(525245);
    expect(decoded.equals(big)).toBe(true);
  });

  it('disk mode normalizes the returned mime (bytes sniffed) and the no-op mime too', async () => {
    const client = new OFWClient();
    const bytes = pngFixture('disk');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 700, fileName: 'shot.png', label: 'shot.png',
      fileType: 'image/png', fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: 'image/png;charset=UTF-8', suggestedFileName: 'shot.png',
    });
    setup(client);
    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      const first = await handlers.get('ofw_download_attachment')!({ fileId: 700, saveTo: dir + '/' });
      const parsed = JSON.parse(first.content[0].text);
      expect(parsed.mimeType).toBe('image/png');
      expect(parsed.mimeType).not.toContain(';');
      // No-op path also reports a bare mime (sourced from cached metadata).
      const second = await handlers.get('ofw_download_attachment')!({ fileId: 700, saveTo: dir + '/' });
      const parsed2 = JSON.parse(second.content[0].text);
      expect(parsed2.note).toBe('already downloaded');
      expect(parsed2.mimeType).toBe('image/png');
      expect(parsed2.mimeType).not.toContain(';');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------------
  // Delivery ladder: a successful fetch must always produce readable content.
  // ------------------------------------------------------------------

  /** Wire up one attachment fetch with the given bytes and metadata. */
  function stubAttachment(
    client: OFWClient, fileId: number, fileName: string, mimeType: string, bytes: Buffer,
  ): void {
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId, fileName, label: fileName, fileType: mimeType, fileSize: bytes.length,
    });
    vi.spyOn(client, 'requestBinary').mockResolvedValueOnce({
      body: bytes, contentType: mimeType, suggestedFileName: fileName,
    });
  }

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  it('repro (fileId 50015547): an .xlsx comes back as extracted sheet contents', async () => {
    const client = new OFWClient();
    const bytes = makeXlsx({
      sharedStrings: ['Holiday', '2026 Parent', '2027 Parent', 'Thanksgiving', 'Mother', 'Father', 'Christmas'],
      sheets: [{
        name: '2026',
        rows: xlsxSheetData([
          [{ ref: 'A1', t: 's', v: '0' }, { ref: 'B1', t: 's', v: '1' }, { ref: 'C1', t: 's', v: '2' }],
          [{ ref: 'A2', t: 's', v: '3' }, { ref: 'B2', t: 's', v: '4' }, { ref: 'C2', t: 's', v: '5' }],
          [{ ref: 'A3', t: 's', v: '6' }, { ref: 'B3', t: 's', v: '5' }, { ref: 'C3', t: 's', v: '4' }],
        ]),
      }],
    });
    stubAttachment(client, 50015547, 'Hall_Holiday_Schedules_2026_-_2027.xlsx', XLSX_MIME, bytes);
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 50015547, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.mimeType).toBe(XLSX_MIME);
    expect(meta.deliveredVia).toBe('extracted');
    expect(meta.truncated).toBe(false);
    expect(meta.extracted.kind).toBe('spreadsheet');
    expect(meta.extracted.sheets).toHaveLength(1);
    const [sheet] = meta.extracted.sheets;
    expect(sheet.name).toBe('2026');
    expect(sheet.rows).toBe(3);
    expect(sheet.cols).toBe(3);
    expect(sheet.csv).toContain('Thanksgiving,Mother,Father');
    // The old failure mode: bytes delivered, nothing readable.
    expect(JSON.stringify(result.content)).not.toContain('not currently supported');
  });

  it('a PDF comes back as extracted page text', async () => {
    const client = new OFWClient();
    const bytes = makePdf({ pages: [showText('Proposed parenting time 2026')], compress: true });
    stubAttachment(client, 900, 'proposal.pdf', 'application/pdf', bytes);
    setup(client);

    const meta = JSON.parse(
      (await handlers.get('ofw_download_attachment')!({ fileId: 900, inline: true })).content[0].text,
    );
    expect(meta.deliveredVia).toBe('extracted');
    expect(meta.extracted).toMatchObject({
      kind: 'pdf', textLayer: true, pages: [{ number: 1, text: 'Proposed parenting time 2026' }],
    });
  });

  it('a scanned PDF says so instead of returning a silently empty document', async () => {
    const client = new OFWClient();
    stubAttachment(client, 901, 'scan.pdf', 'application/pdf',
      makePdf({ pages: ['q 612 0 0 792 0 0 cm /Im0 Do Q'] }));
    setup(client);

    const meta = JSON.parse(
      (await handlers.get('ofw_download_attachment')!({ fileId: 901, inline: true })).content[0].text,
    );
    expect(meta.extracted.textLayer).toBe(false);
    expect(meta.extracted.note).toMatch(/OCR/);
  });

  it('a .docx comes back as text with its heading and table structure', async () => {
    const client = new OFWClient();
    const body = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Holidays</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Thanksgiving</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>Mother</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    stubAttachment(client, 902, 'schedule.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', makeDocx(body));
    setup(client);

    const meta = JSON.parse(
      (await handlers.get('ofw_download_attachment')!({ fileId: 902, inline: true })).content[0].text,
    );
    expect(meta.extracted).toEqual({
      kind: 'document', text: '# Holidays\n\n| Thanksgiving | Mother |',
    });
  });

  it('a .pptx comes back as per-slide text plus speaker notes', async () => {
    const client = new OFWClient();
    stubAttachment(client, 903, 'deck.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      makePptx([{ paragraphs: ['Parenting plan'], notes: ['Mention pickup times'] }]));
    setup(client);

    const meta = JSON.parse(
      (await handlers.get('ofw_download_attachment')!({ fileId: 903, inline: true })).content[0].text,
    );
    expect(meta.extracted.slides).toEqual([
      { number: 1, text: 'Parenting plan', notes: 'Mention pickup times' },
    ]);
  });

  it('honours a sheet range and reports what the character budget dropped', async () => {
    const client = new OFWClient();
    const bigRows = Array.from({ length: 200 }, (_, i) => [{ ref: `A${i + 1}`, v: String(100000 + i) }]);
    const bytes = makeXlsx({
      sheets: [
        { name: '2026', rows: xlsxSheetData(bigRows) },
        { name: '2027', rows: xlsxSheetData(bigRows) },
        { name: 'Notes', rows: xlsxSheetData([[{ ref: 'A1', v: '1' }]]) },
      ],
    });
    stubAttachment(client, 904, 'big.xlsx', XLSX_MIME, bytes);
    setup(client);

    const meta = JSON.parse((await handlers.get('ofw_download_attachment')!({
      fileId: 904, inline: true, parts: '1-2', maxChars: 500,
    })).content[0].text);

    expect(meta.truncated).toBe(true);
    // Sheet 3 was never selected; sheet 2 fell off the character budget.
    expect(meta.extracted.omitted).toEqual([
      'Notes',
      '2027 (omitted: response character budget)',
    ]);
    const [first] = meta.extracted.sheets;
    expect(first.name).toBe('2026');
    expect(first.truncated).toBe(true);
    expect(first.csv.length).toBeLessThanOrEqual(500);
    // The row count reports what actually came back, not the sheet's real size.
    expect(first.rows).toBe(first.csv.split('\n').length);
    expect(first.rows).toBeLessThan(200);
  });

  it('falls through to raw bytes for a type with no extractor, naming what it tried', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0xff, 0x00, 0x13, 0x37]);
    stubAttachment(client, 905, 'archive.zip', 'application/zip', bytes);
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 905, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.deliveredVia).toBe('blob');
    expect(meta.sizeBytes).toBe(bytes.length);
    expect(meta.deliveryAttempts).toEqual(['no text extractor for application/zip (archive.zip)']);
    const res = result.content[1];
    expect(res.type).toBe('resource');
    // Byte-for-byte intact.
    expect(Buffer.from(res.resource.blob, 'base64').equals(bytes)).toBe(true);
  });

  it('reports why a malformed file of an extractable type fell back to bytes', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('this is not really a workbook', 'utf8');
    stubAttachment(client, 906, 'broken.xlsx', XLSX_MIME, bytes);
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 906, inline: true });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.deliveredVia).toBe('blob');
    expect(meta.deliveryAttempts[0]).toMatch(/extraction failed: .*ZIP/i);
    expect(Buffer.from(result.content[1].resource.blob, 'base64').equals(bytes)).toBe(true);
  });

  it('extract:false returns the raw bytes for an extractable type', async () => {
    const client = new OFWClient();
    const bytes = makeXlsx({ sheets: [{ name: 'S', rows: xlsxSheetData([[{ ref: 'A1', v: '1' }]]) }] });
    stubAttachment(client, 907, 'sheet.xlsx', XLSX_MIME, bytes);
    setup(client);

    const result = await handlers.get('ofw_download_attachment')!({ fileId: 907, inline: true, extract: false });
    const meta = JSON.parse(result.content[0].text);
    expect(meta.deliveredVia).toBe('blob');
    expect(meta.deliveryAttempts).toEqual(['extraction skipped (extract:false)']);
    expect(Buffer.from(result.content[1].resource.blob, 'base64').equals(bytes)).toBe(true);
  });

  it('hosted (no disk): a saveTo request still returns extracted content', async () => {
    const client = new OFWClient();
    const bytes = makeXlsx({
      sharedStrings: ['Spring Break'],
      sheets: [{ name: '2026', rows: xlsxSheetData([[{ ref: 'A1', t: 's', v: '0' }]]) }],
    });
    stubAttachment(client, 908, 'schedule.xlsx', XLSX_MIME, bytes);
    const hosted = setupHosted(client);

    const result = await hosted.get('ofw_download_attachment')!({
      fileId: 908, inline: false, saveTo: '/tmp/nope.xlsx',
    });
    const meta = JSON.parse(result.content[0].text);
    // The disk path could not be honoured, and that is stated — but the content
    // still arrives, which is the whole point.
    expect(meta.forcedInline).toBe(true);
    expect(meta.deliveredVia).toBe('extracted');
    expect(meta.extracted.sheets[0].csv).toBe('Spring Break');
  });

  it('disk mode with extract:true returns both the saved path and the content', async () => {
    const client = new OFWClient();
    const bytes = makeXlsx({
      sharedStrings: ['Winter Break'],
      sheets: [{ name: '2027', rows: xlsxSheetData([[{ ref: 'A1', t: 's', v: '0' }]]) }],
    });
    stubAttachment(client, 909, 'winter.xlsx', XLSX_MIME, bytes);
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      const parsed = JSON.parse((await handlers.get('ofw_download_attachment')!({
        fileId: 909, saveTo: dir + '/', extract: true,
      })).content[0].text);
      expect(parsed.path).toMatch(/winter\.xlsx$/);
      expect(readFileSync(parsed.path).equals(bytes)).toBe(true);
      expect(parsed.extracted.sheets[0].csv).toBe('Winter Break');
      expect(parsed.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disk mode extracts from the existing copy on a repeat call, without re-fetching', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('cached note', 'utf8');
    stubAttachment(client, 910, 'note.txt', 'text/plain', bytes);
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      await handlers.get('ofw_download_attachment')!({ fileId: 910, saveTo: dir + '/' });
      const second = JSON.parse((await handlers.get('ofw_download_attachment')!({
        fileId: 910, saveTo: dir + '/', extract: true,
      })).content[0].text);
      expect(second.note).toBe('already downloaded');
      expect(second.extracted).toEqual({ kind: 'text', text: 'cached note' });
      // Only the first call hit the network.
      expect(client.requestBinary).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-downloads rather than answering "already downloaded" with no content', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from('vanished note', 'utf8');
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      fileId: 911, fileName: 'gone.txt', label: 'gone.txt', fileType: 'text/plain', fileSize: bytes.length,
    });
    const binSpy = vi.spyOn(client, 'requestBinary')
      .mockResolvedValue({ body: bytes, contentType: 'text/plain', suggestedFileName: 'gone.txt' });
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      const first = JSON.parse((await handlers.get('ofw_download_attachment')!({
        fileId: 911, saveTo: dir + '/',
      })).content[0].text);
      rmSync(first.path); // the local copy disappears behind our back

      const second = JSON.parse((await handlers.get('ofw_download_attachment')!({
        fileId: 911, saveTo: dir + '/', extract: true,
      })).content[0].text);
      expect(binSpy).toHaveBeenCalledTimes(2);
      expect(second.note).toBeUndefined();
      expect(second.extracted).toEqual({ kind: 'text', text: 'vanished note' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disk mode reports why an unextractable file yielded no content', async () => {
    const client = new OFWClient();
    const bytes = Buffer.from([0x00, 0x01, 0x02]);
    stubAttachment(client, 912, 'blob.bin', 'application/octet-stream', bytes);
    setup(client);

    const dir = mkdtempSync(join(tmpdir(), 'ofw-dl-'));
    try {
      const parsed = JSON.parse((await handlers.get('ofw_download_attachment')!({
        fileId: 912, saveTo: dir + '/', extract: true,
      })).content[0].text);
      expect(parsed.extracted).toBeUndefined();
      expect(parsed.reason).toMatch(/no text extractor/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    const spy = vi.spyOn(client, 'request')
      // Guard pre-read (matches the cached base), then the id-less POST.
      .mockResolvedValueOnce({
        subject: 'S', body: 'B',
        recipients: [{ user: { userId: 1, name: 'A' }, viewed: null }],
        replyToId: null, folder: { id: '3', name: 'Drafts' },
      })
      .mockResolvedValueOnce({ error: 'boom' }); // POST → no id
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({ messageId: 70 })).content[0].text;

    expect(getDraft(70)).not.toBeNull(); // draft survives
    expect(spy).not.toHaveBeenCalledWith('DELETE', expect.anything(), expect.anything());
    expect(text).toContain('Draft 70 was NOT deleted');
    // …and the structured payload says so, not just the prose note.
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.sendConfirmed).toBe(false);
    expect(parsed.draftRetained).toBe(true);
    expect(parsed.draftRetainedReason).toMatch(/only reliable copy/);
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
    expect(parsed.recipients[0].viewedAt).toBe('2026-06-16T15:49:20-04:00');
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
    expect(JSON.parse(result.content[0].text).recipients[0].viewedAt).toBe('2026-06-16T15:49:20-04:00');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ofw_check_freshness', () => {
  const draft = {
    id: 500, subject: 'Cruise', body: 'draft body', recipients: [],
    replyToId: null, modifiedAt: '2026-07-19T12:42:00Z', listData: {},
  };
  // What the lifecycle probe parses out of GET /pub/v3/messages/{id}. Real OFW
  // detail payloads carry the owning folder, and that is what answers "is this
  // STILL a draft?" — `existsOnServer` cannot, because a SENT draft still exists.
  const serverDraft = (over: Record<string, unknown> = {}) => ({
    subject: 'Cruise', body: 'draft body', replyToId: null, recipients: [],
    folder: { id: 3, name: 'Drafts' }, ...over,
  });
  const foldersPayload = (over: Record<string, unknown> = {}) => ({
    systemFolders: [
      { id: '1', folderType: 'INBOX', totalCount: 10 },
      { id: '2', folderType: 'SENT_MESSAGES', totalCount: 5 },
      { id: '3', folderType: 'DRAFTS', totalCount: 2 },
    ],
    ...over,
  });
  // The folder-id map any past sync would have persisted, so a probe can
  // classify without spending a request re-resolving it.
  beforeEach(() => {
    setMeta('inbox_folder_id', '1');
    setMeta('sent_folder_id', '2');
    setMeta('drafts_folder_id', '3');
  });

  it('confirms a cached draft is still on the server and unchanged', async () => {
    upsertDraft(draft);
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue(serverDraft());
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ messageIds: [500] })).content[0].text,
    );

    expect(parsed.items).toEqual([expect.objectContaining({
      id: 500, state: 'draft', existsOnServer: true, inSync: true,
    })]);
    // One request for the id, and none for folders — an ids-only call must not
    // silently spend budget on a folder probe.
    expect(parsed.requestsUsed).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(parsed.folders).toBeUndefined();
  });

  it('detects a server-side edit the cache missed (inSync:false)', async () => {
    upsertDraft(draft);
    const client = new OFWClient();
    // Edited in the OFW web app: the body differs but `date.dateTime` would
    // NOT have moved, which is why the comparison is by content revision.
    vi.spyOn(client, 'request').mockResolvedValue(serverDraft({ body: 'edited in the web app' }));
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ messageIds: [500] })).content[0].text,
    );

    expect(parsed.items[0].inSync).toBe(false);
    expect(parsed.items[0].existsOnServer).toBe(true);
    expect(parsed.items[0].cacheRevision).not.toBe(parsed.items[0].serverRevision);
    expect(parsed.items[0].note).toMatch(/edited on OurFamilyWizard/);
  });

  it('detects a draft that no longer exists on the server (existsOnServer:false)', async () => {
    upsertDraft(draft);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 404 Not Found'));
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ messageIds: [500] })).content[0].text,
    );

    expect(parsed.items[0]).toEqual(expect.objectContaining({
      id: 500, existsOnServer: false, inSync: false, serverRevision: null,
    }));
    // The exact assertion the triggering bug got wrong.
    expect(parsed.items[0].note).toMatch(/NO LONGER EXISTS|do not describe it as still unsent/i);
  });

  it('refuses to probe a non-draft id by default, because that would mark it read', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue(serverDraft());
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ messageIds: [999] })).content[0].text,
    );

    expect(parsed.items[0]).toEqual(expect.objectContaining({
      id: 999, skipped: true, reason: 'WOULD_MARK_READ',
    }));
    expect(parsed.requestsUsed).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('probes an id cached as SENT without allowMarkRead — that fetch cannot stamp anything', async () => {
    upsertMessage(sampleMessageRow({ id: 777, folder: 'sent' }));
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue(
      serverDraft({ folder: { id: 2, name: 'Sent Messages' }, date: { dateTime: '2026-07-27T23:31:09' } }),
    );
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ messageIds: [777] })).content[0].text,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(parsed.items[0].state).toBe('sent');
    expect(parsed.items[0].sentAt).toBe('2026-07-27T23:31:09-04:00');
  });

  it('probes a non-draft id when allowMarkRead is set', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue(serverDraft());
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!(
      { messageIds: [999], allowMarkRead: true },
    )).content[0].text);

    expect(parsed.items[0].existsOnServer).toBe(true);
    // Not in the drafts cache, so there is nothing to compare it against —
    // `null` (not compared), never `false` (a drift was detected).
    expect(parsed.items[0].cacheRevision).toBeNull();
    expect(parsed.items[0].inSync).toBeNull();
  });

  it('reports a failed check as unconfirmed rather than in-sync', async () => {
    upsertDraft(draft);
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 503'));
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ messageIds: [500] })).content[0].text,
    );

    expect(parsed.items[0].error).toBe('FRESHNESS_CHECK_FAILED');
    expect(parsed.items[0].inSync).toBeNull();
  });

  it('compares live folder counts against the cache in one request', async () => {
    upsertMessage(sampleMessageRow({ id: 1, folder: 'inbox' }));
    cache.core.setSyncState('inbox', {
      lastSyncAt: new Date().toISOString(), newestId: 1, resumePage: null,
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue(foldersPayload());
    setup(client);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ folders: ['inbox'] })).content[0].text,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(parsed.folders[0]).toEqual(expect.objectContaining({
      folder: 'inbox', serverCount: 10, cachedCount: 1, historyComplete: true, inSync: false,
    }));
  });

  it('withholds an inSync verdict while a backfill is still parked', async () => {
    // A partially backfilled folder legitimately holds fewer messages than the
    // server, so a mismatch there proves nothing — crying wolf for the whole
    // duration of a backfill would train the caller to ignore the signal.
    upsertMessage(sampleMessageRow({ id: 1, folder: 'inbox' }));
    cache.core.setSyncState('inbox', {
      lastSyncAt: new Date().toISOString(), newestId: 1, resumePage: 7,
    });
    setup(makeClient(foldersPayload()));

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ folders: ['inbox'] })).content[0].text,
    );

    expect(parsed.folders[0].historyComplete).toBe(false);
    expect(parsed.folders[0].inSync).toBeNull();
    expect(parsed.folders[0].note).toMatch(/backfilled/);
  });

  it('tells a never-synced folder to sync instead of calling it mid-backfill', async () => {
    // No sync state at all. That leaves historyComplete false for the same
    // reason a parked backfill does, but the advice is the opposite: waiting
    // out a backfill that never started gets the caller nowhere.
    setup(makeClient(foldersPayload()));

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ folders: ['inbox'] })).content[0].text,
    );

    expect(parsed.folders[0].historyComplete).toBe(false);
    expect(parsed.folders[0].inSync).toBeNull();
    expect(parsed.folders[0].note).toMatch(/never been synced/);
    expect(parsed.folders[0].note).not.toMatch(/backfilled/);
  });

  it('withholds a verdict when OFW reports no count for the folder', async () => {
    setup(makeClient({ systemFolders: [{ id: '1', folderType: 'INBOX' }] }));

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ folders: ['inbox'] })).content[0].text,
    );

    expect(parsed.folders[0].serverCount).toBeNull();
    expect(parsed.folders[0].inSync).toBeNull();
    expect(parsed.folders[0].note).toMatch(/did not report a count/);
  });

  it('survives a folders payload with no systemFolders key', async () => {
    setup(makeClient({}));

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ folders: ['inbox'] })).content[0].text,
    );

    expect(parsed.folders[0].existsOnServer).toBe(false);
    expect(parsed.folders[0].inSync).toBeNull();
  });

  it('reports a probed non-draft id that is absent from the server', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 404 Not Found'));
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!(
      { messageIds: [999], allowMarkRead: true },
    )).content[0].text);

    expect(parsed.items[0]).toEqual(expect.objectContaining({
      id: 999, existsOnServer: false, cacheRevision: null,
    }));
    expect(parsed.items[0].note).toMatch(/Not found on OurFamilyWizard/);
  });

  it('accepts the alternate count field spellings', async () => {
    setup(makeClient({ systemFolders: [
      { id: '1', folderType: 'INBOX', messageCount: 3 },
      { id: '3', folderType: 'DRAFTS', count: 4 },
    ] }));

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!(
      { folders: ['inbox', 'drafts'] },
    )).content[0].text);

    expect(parsed.folders[0].serverCount).toBe(3);
    expect(parsed.folders[1].serverCount).toBe(4);
  });

  it('flags a folder missing from the server payload', async () => {
    setup(makeClient({ systemFolders: [] }));

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ folders: ['sent'] })).content[0].text,
    );

    expect(parsed.folders[0].existsOnServer).toBe(false);
    expect(parsed.folders[0].serverCount).toBeNull();
  });

  it('counts cached drafts for the drafts folder', async () => {
    upsertDraft(draft);
    cache.core.setSyncState('drafts', {
      lastSyncAt: new Date().toISOString(), newestId: null, resumePage: null,
    });
    setup(makeClient(foldersPayload()));

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ folders: ['drafts'] })).content[0].text,
    );

    expect(parsed.folders[0].cachedCount).toBe(1);
    expect(parsed.folders[0].serverCount).toBe(2);
    expect(parsed.folders[0].inSync).toBe(false);
  });

  it('checks all three folders when called with no arguments', async () => {
    setup(makeClient(foldersPayload()));

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!({})).content[0].text);

    expect(parsed.folders.map((f: { folder: string }) => f.folder))
      .toEqual(['inbox', 'sent', 'drafts']);
    expect(parsed.requestsUsed).toBe(1);
  });

  it('truncates loudly past the per-call id cap instead of turning into a sync', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue(serverDraft());
    setup(client);
    const ids = Array.from({ length: 30 }, (_, i) => 1000 + i);

    const parsed = JSON.parse(
      (await handlers.get('ofw_check_freshness')!({ messageIds: ids, allowMarkRead: true })).content[0].text,
    );

    expect(parsed.items).toHaveLength(25);
    expect(parsed.note).toMatch(/Only the first 25 of 30/);
    expect(parsed.note).toMatch(/were NOT verified/);
  });
});

describe('freshness contract across read tools', () => {
  // Acceptance criterion: no read tool returns message/draft/folder data
  // without a freshness block. A tool that grows a new return path and forgets
  // one should fail here rather than silently shipping unlabelled data.
  const READ_TOOLS: Array<[string, Record<string, unknown>]> = [
    ['ofw_list_messages', {}],
    ['ofw_list_drafts', {}],
    ['ofw_list_message_folders', {}],
    ['ofw_sync_messages', {}],
    ['ofw_get_unread_sent', {}],
  ];

  it.each(READ_TOOLS)('%s returns a well-formed freshness block', async (tool, args) => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      systemFolders: [
        { id: '1', folderType: 'INBOX' },
        { id: '2', folderType: 'SENT_MESSAGES' },
        { id: '3', folderType: 'DRAFTS' },
      ],
      data: [],
    });
    setup(client);

    const parsed = JSON.parse((await handlers.get(tool)!(args)).content[0].text);

    expect(parsed.freshness).toBeDefined();
    expect(['cache', 'live']).toContain(parsed.freshness.source);
    expect(['fresh', 'unverified', 'stale']).toContain(parsed.freshness.staleness);
    expect(parsed.freshness).toHaveProperty('asOf');
    expect(parsed.freshness).toHaveProperty('ageSeconds');
    expect(parsed.freshness).toHaveProperty('lastServerSyncAt');
    expect(parsed.freshness).toHaveProperty('syncComplete');
    // Anything not provably current must carry a human-readable reason.
    if (parsed.freshness.staleness !== 'fresh') {
      expect(typeof parsed.freshness.warning).toBe('string');
      expect(parsed.freshness.warning.length).toBeGreaterThan(0);
    }
  });

  it('ofw_list_messages refuses an invalid folderId rather than returning an empty list', async () => {
    setup(makeClient({}));

    const result = await handlers.get('ofw_list_messages')!({ folderId: '12345' });
    const parsed = JSON.parse(result.content[0].text);

    // No `messages` key at all: a rejected argument must not be answerable as
    // "no messages", which is the shape a caller would summarize from.
    expect(result.isError).toBe(true);
    expect(parsed.messages).toBeUndefined();
    expect(parsed.complete).toBe(false);
    expect(parsed.note).toMatch(/says NOTHING about what is in the cache/);
  });

  it('ofw_get_message carries freshness on the cache, live and draft paths', async () => {
    // Cache path.
    upsertMessage(sampleMessageRow({ id: 100, folder: 'inbox', body: 'cached' }));
    setup(makeClient({}));
    let parsed = JSON.parse(
      (await handlers.get('ofw_get_message')!({ messageId: '100' })).content[0].text,
    );
    expect(parsed.freshness.source).toBe('cache');

    // Live path — fetched in this call, so current by construction.
    setup(makeClient({ id: 101, subject: 'Live', body: 'b', date: { dateTime: '2026-07-20T00:00:00Z' } }));
    parsed = JSON.parse(
      (await handlers.get('ofw_get_message')!({ messageId: '101' })).content[0].text,
    );
    expect(parsed.freshness.source).toBe('live');
    expect(parsed.freshness.staleness).toBe('fresh');

    // Draft path.
    upsertDraft({
      id: 500, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    setup(makeClient({}));
    parsed = JSON.parse(
      (await handlers.get('ofw_get_message')!({ messageId: '500' })).content[0].text,
    );
    expect(parsed.freshness.source).toBe('cache');
    expect(parsed).toHaveProperty('serverConfirmed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Is this entity still what I think it is?" — the layer above freshness.
//
// The triggering failure: an assistant carried three draft ids across many
// turns and recited them as current. One had been SENT the night before. The
// freshness work already in place answers "how old is this data?"; none of it
// stops a claim built on a tool result from an earlier turn that was never
// re-read. These suites cover the three structural closures — a lifecycle state
// in the cheap check, a refusal to report unverified emptiness, and a draft
// identity that survives the create-then-delete id churn.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tiny stand-in for the OFW message API: POST mints an id, GET returns the
 * stored record (404 once deleted), DELETE removes it. Multi-step flows (save →
 * replace → replace → send → verify) need the responses to stay CONSISTENT with
 * each other, which an ordered mockResolvedValueOnce chain cannot express.
 */
function fakeOFW(opts: { draftsFolderId?: number; sentFolderId?: number } = {}) {
  const draftsFolderId = opts.draftsFolderId ?? 3;
  const sentFolderId = opts.sentFolderId ?? 2;
  const messages = new Map<number, Record<string, unknown>>();
  let nextId = 1000;
  const client = new OFWClient();
  vi.spyOn(client, 'request').mockImplementation(
    async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/pub/v3/messages') {
        const p = body as Record<string, unknown>;
        const id = nextId++;
        messages.set(id, {
          id,
          subject: p.subject,
          body: p.body,
          replyToId: p.replyToId ?? null,
          recipients: [],
          date: { dateTime: '2026-07-28T00:00:00Z' },
          folder: p.draft === true
            ? { id: draftsFolderId, name: 'Drafts' }
            : { id: sentFolderId, name: 'Sent Messages' },
        });
        return { entityId: id };
      }
      if (method === 'GET' && path.startsWith('/pub/v3/messages/')) {
        const id = Number(path.split('/').pop());
        const found = messages.get(id);
        if (found === undefined) throw new Error('OFW API error: 404 Not Found');
        return found;
      }
      if (method === 'DELETE' && path === '/pub/v1/messages') {
        for (const raw of (body as FormData).getAll('messageIds')) messages.delete(Number(raw));
        return {};
      }
      throw new Error(`fakeOFW: unexpected ${method} ${path}`);
    },
  );
  return { client, messages };
}

/** The folder-id map any prior sync would have persisted. */
function seedFolderIds(): void {
  setMeta('inbox_folder_id', '1');
  setMeta('sent_folder_id', '2');
  setMeta('drafts_folder_id', '3');
}

/** Mark a folder verified NOW, so reads of it come back `fresh`. */
function markFresh(folder: 'inbox' | 'sent' | 'drafts'): void {
  const now = new Date().toISOString();
  cache.core.setSyncState(folder, { lastSyncAt: now, newestId: null, resumePage: null });
  cache.core.setMeta(`folder_verified_at:${folder}`, now);
  if (folder === 'drafts') cache.core.setMeta('drafts_cache_status', 'fresh');
}

describe('lifecycle state in ofw_check_freshness (Gap 1)', () => {
  it('reports a draft that was SENT as state:"sent" with sentAt — not merely existsOnServer', async () => {
    seedFolderIds();
    // The real scenario: the cache still calls 538279699 a draft because no
    // sync has run since the user sent it from the web app last night.
    upsertDraft({
      id: 538279699, subject: 'Weekly Message 7/17 - 7/26', body: 'weekly',
      recipients: [], replyToId: null, modifiedAt: '2026-07-27T18:00:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'Weekly Message 7/17 - 7/26', body: 'weekly', replyToId: null, recipients: [],
      folder: { id: 2, name: 'Sent Messages' },
      date: { dateTime: '2026-07-27T23:31:09' },
    });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!({
      messageIds: [538279699],
    })).content[0].text);

    expect(parsed.items[0]).toMatchObject({
      id: 538279699,
      state: 'sent',
      sentAt: '2026-07-27T23:31:09-04:00',
      existsOnServer: true,
      inSync: false,
    });
    expect(parsed.items[0].note).toMatch(/no longer a draft|was SENT/i);
  });

  it('reports a deleted draft as state:"deleted"', async () => {
    seedFolderIds();
    upsertDraft({
      id: 501, subject: 'Gone', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 404 Not Found'));
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!({
      messageIds: [501],
    })).content[0].text);

    expect(parsed.items[0]).toMatchObject({ id: 501, state: 'deleted', existsOnServer: false });
  });

  it('fetches the folders endpoint ONCE when asked about folders and ids together', async () => {
    // No sync has ever run, so the folder-id map is empty. The folder-count
    // branch already fetches /pub/v1/messageFolders; harvesting the ids from
    // that same response keeps probeIds' ensureFolderIdMap from re-fetching it.
    upsertDraft({
      id: 503, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockImplementation(async (_m: string, path: string) => {
      if (path.startsWith('/pub/v1/messageFolders')) {
        return {
          systemFolders: [
            { id: '1', folderType: 'INBOX', totalCount: 10 },
            { id: '2', folderType: 'SENT_MESSAGES', totalCount: 5 },
            { id: '3', folderType: 'DRAFTS', totalCount: 1 },
          ],
        };
      }
      return { subject: 'D', body: 'b', replyToId: null, recipients: [], folder: { id: 3, name: 'Drafts' } };
    });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!({
      folders: ['drafts'], messageIds: [503],
    })).content[0].text);

    const folderCalls = spy.mock.calls.filter(([, path]) => String(path).startsWith('/pub/v1/messageFolders'));
    expect(folderCalls).toHaveLength(1);
    // One folder fetch + one id probe — the map came free with the counts.
    expect(parsed.requestsUsed).toBe(2);
    expect(parsed.items[0].state).toBe('draft');
    // And the ids are now persisted for every later call.
    expect(cache.core.getMeta('drafts_folder_id')).toBe('3');
    expect(cache.core.getMeta('sent_folder_id')).toBe('2');
    expect(cache.core.getMeta('inbox_folder_id')).toBe('1');
  });

  it('resolves the folder map live (one extra request) when no sync has ever run', async () => {
    upsertDraft({
      id: 502, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        systemFolders: [
          { id: '1', folderType: 'INBOX' },
          { id: '2', folderType: 'SENT_MESSAGES' },
          { id: '3', folderType: 'DRAFTS' },
        ],
      })
      .mockResolvedValueOnce({
        subject: 'D', body: 'b', replyToId: null, recipients: [], folder: { id: 3, name: 'Drafts' },
      });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_check_freshness')!({
      messageIds: [502],
    })).content[0].text);

    expect(parsed.items[0].state).toBe('draft');
    expect(parsed.requestsUsed).toBe(2);
  });
});

describe('UNVERIFIED_EMPTY: absence is never reported from a stale cache (Gap 2)', () => {
  it('ofw_list_messages answers normally when the cache IS fresh and genuinely empty', async () => {
    markFresh('inbox');
    setup(makeClient({}));

    const result = await handlers.get('ofw_list_messages')!({ folderId: 'inbox' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.messages).toEqual([]);
    expect(parsed.complete).toBe(true);
    expect(parsed.note).toMatch(/verified-fresh/);
  });

  it('ofw_list_drafts answers normally when the drafts cache IS verified and empty', async () => {
    markFresh('drafts');
    setup(makeClient({}));

    const result = await handlers.get('ofw_list_drafts')!({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.drafts).toEqual([]);
    expect(parsed.complete).toBe(true);
    expect(parsed.total).toBe(0);
  });

  it('does NOT refuse a page PAST THE END — an empty slice is not a claim of absence', async () => {
    // The cache is stale and page 2 is empty, but there IS a draft. Refusing
    // with "no drafts were found" would be its own false statement.
    upsertDraft({
      id: 1, subject: 'A', body: 'a', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:00:00Z', listData: {},
    });
    setup(makeClient({}));

    const result = await handlers.get('ofw_list_drafts')!({ page: 2, verify: false });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.drafts).toEqual([]);
    expect(parsed.total).toBe(1);
    expect(parsed.complete).toBe(false);
  });

  it('does NOT refuse a non-empty result from a stale cache — presence is still evidence', async () => {
    upsertMessage(sampleMessageRow({ id: 1, folder: 'inbox' }));
    setup(makeClient({}));

    const result = await handlers.get('ofw_list_messages')!({ folderId: 'inbox' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.messages).toHaveLength(1);
    // ...but it is still not a complete answer, and says so.
    expect(parsed.complete).toBe(false);
    expect(parsed.completeNote).toMatch(/cache is "stale"/);
  });

  it('autoRefresh:true syncs and returns REAL results instead of refusing', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({                                    // resolveFolderIds
        systemFolders: [
          { id: '1', folderType: 'INBOX' },
          { id: '2', folderType: 'SENT_MESSAGES' },
          { id: '3', folderType: 'DRAFTS' },
        ],
      })
      .mockResolvedValueOnce({                                    // inbox page 1
        data: [{
          id: 77, subject: 'Found after refresh', date: { dateTime: '2026-07-28T10:00:00Z' },
          from: { name: 'Co-parent' }, showNeverViewed: false,
        }],
      })
      .mockResolvedValueOnce({ body: 'the body' })                // detail
      .mockResolvedValueOnce({ data: [] });                       // inbox page 2 → done
    setup(client);

    const result = await handlers.get('ofw_list_messages')!({ folderId: 'inbox', autoRefresh: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].subject).toBe('Found after refresh');
    expect(parsed.autoRefreshed).toBe(true);
    expect(parsed.complete).toBe(true);
  });

  it('autoRefresh that does NOT make the read verifiable still refuses', async () => {
    const client = new OFWClient();
    // The folder resolve eats the entire budget, so the inbox walk never runs.
    process.env.OFW_SYNC_MAX_REQUESTS = '1';
    vi.spyOn(client, 'request').mockResolvedValue({
      systemFolders: [
        { id: '1', folderType: 'INBOX' },
        { id: '2', folderType: 'SENT_MESSAGES' },
        { id: '3', folderType: 'DRAFTS' },
      ],
    });
    setup(client);

    const result = await handlers.get('ofw_list_messages')!({ folderId: 'inbox', autoRefresh: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.result).toBe('UNVERIFIED_EMPTY');
    expect(parsed.reason).toMatch(/automatic refresh ran on this call and did NOT/);
    delete process.env.OFW_SYNC_MAX_REQUESTS;
  });

  it('honours the OFW_AUTO_REFRESH env default', async () => {
    process.env.OFW_AUTO_REFRESH = 'true';
    try {
      const client = new OFWClient();
      vi.spyOn(client, 'request')
        .mockResolvedValueOnce({
          systemFolders: [
            { id: '1', folderType: 'INBOX' },
            { id: '2', folderType: 'SENT_MESSAGES' },
            { id: '3', folderType: 'DRAFTS' },
          ],
        })
        .mockResolvedValueOnce({ data: [] });                     // drafts walk: none
      const localHandlers = setupWithClient(client);

      const result = await localHandlers.get('ofw_list_drafts')!({ verify: false });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBeUndefined();
      expect(parsed.autoRefreshed).toBe(true);
      expect(parsed.drafts).toEqual([]);
      expect(parsed.complete).toBe(true);
    } finally {
      delete process.env.OFW_AUTO_REFRESH;
    }
  });

  it('ofw_get_unread_sent also refreshes rather than refusing when asked to', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({                                    // resolveFolderIds
        systemFolders: [
          { id: '1', folderType: 'INBOX' },
          { id: '2', folderType: 'SENT_MESSAGES' },
          { id: '3', folderType: 'DRAFTS' },
        ],
      })
      .mockResolvedValueOnce({                                    // sent page 1
        data: [{
          id: 88, subject: 'Awaiting a read', date: { dateTime: '2026-07-28T10:00:00Z' },
          from: { name: 'Me' }, showNeverViewed: true,
          recipients: [{ user: { userId: 2, name: 'Co-parent' } }],
        }],
      })
      .mockResolvedValueOnce({ body: 'the body' })                // detail
      .mockResolvedValueOnce({ data: [] });                       // sent page 2 → done
    setup(client);

    const result = await handlers.get('ofw_get_unread_sent')!({ autoRefresh: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.autoRefreshed).toBe(true);
    expect(parsed.unread).toHaveLength(1);
    expect(parsed.unread[0].unreadBy).toEqual(['Co-parent']);
  });

  it('names the age in the refusal when the cache was verified but has gone stale', async () => {
    const old = new Date(Date.now() - 207 * 60 * 1000).toISOString();
    cache.core.setSyncState('sent', { lastSyncAt: old, newestId: null, resumePage: null });
    cache.core.setMeta('folder_verified_at:sent', old);
    setup(makeClient({}));

    const result = await handlers.get('ofw_get_unread_sent')!({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.reason).toMatch(/last verified 207 min ago/);
  });

  it('names a sub-minute age rather than rounding it to "0 min"', async () => {
    const recent = new Date(Date.now() - 5000).toISOString();
    cache.core.setSyncState('sent', { lastSyncAt: recent, newestId: null, resumePage: null });
    cache.core.setMeta('folder_verified_at:sent', recent);
    // Inside the TTL it would be `fresh`; shrink the window so it is not.
    process.env.OFW_FRESHNESS_TTL_SECONDS = '1';
    try {
      const localHandlers = setupWithClient(makeClient({}));
      const parsed = JSON.parse(
        (await localHandlers.get('ofw_get_unread_sent')!({})).content[0].text,
      );
      expect(parsed.reason).toMatch(/last verified \d+ sec ago/);
    } finally {
      delete process.env.OFW_FRESHNESS_TTL_SECONDS;
    }
  });
});

describe('pagination state survives lossy consumption', () => {
  /** Seed `count` inbox+sent messages spread across 2025-10-01 onward. */
  function seedRange(count: number): void {
    for (let i = 0; i < count; i++) {
      upsertMessage(sampleMessageRow({
        id: 2000 + i,
        folder: i % 2 === 0 ? 'inbox' : 'sent',
        subject: `Ranged ${i}`,
        sentAt: new Date(Date.parse('2025-10-01T00:00:00Z') + i * 5 * 3600_000).toISOString(),
      }));
    }
    markFresh('inbox');
    markFresh('sent');
  }

  const listMessages = async (args: Record<string, unknown>) =>
    JSON.parse((await handlers.get('ofw_list_messages')!(args)).content[0].text);

  it('the reported call: 391 total, 60 returned, paging state ahead of the bulk', async () => {
    seedRange(391);
    setup(makeClient({}));

    const parsed = await listMessages({
      folderId: 'both', since: '2025-10-01', until: '2025-12-31', size: 60,
    });

    expect(parsed.total).toBe(391);
    expect(parsed.complete).toBe(false);
    expect(parsed.hasMore).toBe(true);
    // The remedy is a VALUE, not something to infer from `complete:false`.
    expect(parsed.nextPage).toBe(2);

    // KEY ORDER. This is the whole point of the change: a `head` of a spilled
    // response, a truncated preview, or a script that reads the first N keys
    // must reach the paging state before it reaches a single message body.
    // Asserted explicitly because it is exactly what a refactor undoes silently.
    const keys = Object.keys(parsed);
    expect(keys[0]).toBe('complete');
    expect(keys.slice(0, 5)).toEqual(['complete', 'hasMore', 'nextPage', 'returned', 'total']);
    expect(keys.at(-1)).toBe('messages');
    for (const key of ['complete', 'hasMore', 'nextPage', 'returned', 'total', 'page', 'size', 'completeNote', 'note', 'freshness']) {
      expect(keys.indexOf(key)).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf(key)).toBeLessThan(keys.indexOf('messages'));
    }
    // Order in the object literal is order in the wire format — assert on the
    // serialized text, not just the parsed object.
    const text = (await handlers.get('ofw_list_messages')!({
      folderId: 'both', since: '2025-10-01', until: '2025-12-31', size: 60,
    })).content[0].text;
    expect(text.indexOf('"nextPage"')).toBeLessThan(text.indexOf('"messages"'));
    expect(text.indexOf('"complete"')).toBeLessThan(text.indexOf('"messages"'));

    // Nothing was renamed or removed: the fields the previous shape carried
    // are all still present, with the same meanings.
    expect(parsed.page).toBe(1);
    expect(parsed.size).toBe(60);
    expect(parsed.completeNote).toMatch(/60 of 391/);
    expect(parsed.note).toMatch(/Showing 1–60 of 391/);
    expect(parsed.freshness).toBeDefined();

    // The honest record count is a SCALAR, ahead of the array, so a consumer
    // never has to reach `messages` to learn how many records came back.
    expect(parsed.returned).toBe(60);
    expect(keys.indexOf('returned')).toBeLessThan(keys.indexOf('messages'));

    // `messages` holds records and nothing else — its length IS the count.
    expect(parsed.messages).toHaveLength(60);
    expect(parsed.messages.every((m: { id?: number }) => typeof m.id === 'number')).toBe(true);
  });

  it('a COMPLETE result set reports nextPage:null', async () => {
    seedRange(3);
    setup(makeClient({}));

    const parsed = await listMessages({ folderId: 'both', since: '2025-10-01', until: '2025-12-31', size: 60 });

    expect(parsed.total).toBe(3);
    expect(parsed.complete).toBe(true);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPage).toBeNull();
    expect(parsed.messages).toHaveLength(3);
    // Key order holds on the complete path too.
    expect(Object.keys(parsed).at(-1)).toBe('messages');
  });

  it('a page PAST the end reports nextPage:null rather than advertising a page that returns nothing', async () => {
    seedRange(3);
    setup(makeClient({}));

    // `returned < total` is true here (0 < 3) but nothing remains — deciding
    // hasMore from the offset instead is what keeps this from looping forever.
    const parsed = await listMessages({ folderId: 'both', page: 9, size: 60 });

    expect(parsed.total).toBe(3);
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPage).toBeNull();
  });

  it('ofw_list_drafts leads with paging state, drafts last', async () => {
    for (let i = 0; i < 3; i++) {
      upsertDraft({
        id: 700 + i, subject: `D${i}`, body: 'b', recipients: [],
        modifiedAt: `2026-05-0${i + 1}T00:00:00Z`, replyToId: null, listData: {},
      });
    }
    markFresh('drafts');
    setup(makeClient({}));

    const parsed = JSON.parse(
      (await handlers.get('ofw_list_drafts')!({ size: 2, verify: false })).content[0].text,
    );

    const keys = Object.keys(parsed);
    expect(keys.slice(0, 4)).toEqual(['complete', 'hasMore', 'nextPage', 'returned']);
    expect(parsed.returned).toBe(2);
    expect(keys.at(-1)).toBe('drafts');
    expect(keys.indexOf('freshness')).toBeLessThan(keys.indexOf('drafts'));
    expect(parsed.nextPage).toBe(2);
    expect(parsed.complete).toBe(false);
    expect(parsed.drafts).toHaveLength(2);
    expect(parsed.drafts.every((d: { id?: number }) => typeof d.id === 'number')).toBe(true);
  });

  it('ofw_get_unread_sent leads with paging state, unread last', async () => {
    for (let i = 0; i < 3; i++) {
      upsertMessage(sampleMessageRow({
        id: 800 + i, folder: 'sent', fetchedBodyAt: '2026-05-04T12:00:00Z',
        recipients: [{ userId: 5, name: 'Bob', viewedAt: '2026-05-04T13:00:00Z' }],
      }));
    }
    markFresh('sent');
    setup(makeClient({}));

    const parsed = JSON.parse(
      (await handlers.get('ofw_get_unread_sent')!({ size: 2 })).content[0].text,
    );

    const keys = Object.keys(parsed);
    expect(keys.slice(0, 3)).toEqual(['complete', 'hasMore', 'nextPage']);
    expect(keys.at(-1)).toBe('unread');
    expect(keys.indexOf('freshness')).toBeLessThan(keys.indexOf('unread'));
    expect(parsed.nextPage).toBe(2);
    // Truncated scan, but every recipient had read — `unread` stays empty.
    expect(parsed.unread).toHaveLength(0);
    expect(parsed.scanned).toBe(2);
    expect(parsed.total).toBe(3);
  });
});

describe('explicit `complete` on list reads (requirement 5)', () => {
  it('ofw_list_messages: complete:false for a partial page even on a fresh cache', async () => {
    markFresh('inbox');
    upsertMessage(sampleMessageRow({ id: 1, folder: 'inbox' }));
    upsertMessage(sampleMessageRow({ id: 2, folder: 'inbox' }));
    setup(makeClient({}));

    const parsed = JSON.parse(
      (await handlers.get('ofw_list_messages')!({ folderId: 'inbox', size: 1 })).content[0].text,
    );

    expect(parsed.total).toBe(2);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.complete).toBe(false);
    expect(parsed.completeNote).toMatch(/1 of 2/);
  });

  it('ofw_list_messages: complete:false while an old-history backfill is parked', async () => {
    const now = new Date().toISOString();
    cache.core.setSyncState('inbox', { lastSyncAt: now, newestId: 1, resumePage: 87 });
    cache.core.setMeta('folder_verified_at:inbox', now);
    upsertMessage(sampleMessageRow({ id: 1, folder: 'inbox' }));
    setup(makeClient({}));

    const parsed = JSON.parse(
      (await handlers.get('ofw_list_messages')!({ folderId: 'inbox' })).content[0].text,
    );

    // The PRESENT is current (staleness stays fresh mid-backfill by design)...
    expect(parsed.freshness.staleness).toBe('fresh');
    // ...but the result set is not the full server-side set, and says so.
    expect(parsed.complete).toBe(false);
    expect(parsed.completeNote).toMatch(/backfilled/);
  });

  it('ofw_list_drafts: complete:true only when the whole verified set is returned', async () => {
    markFresh('drafts');
    upsertDraft({
      id: 1, subject: 'A', body: 'a', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:00:00Z', listData: {},
    });
    upsertDraft({
      id: 2, subject: 'B', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-20T12:00:00Z', listData: {},
    });
    setup(makeClient({}));

    let parsed = JSON.parse((await handlers.get('ofw_list_drafts')!({})).content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.complete).toBe(true);

    parsed = JSON.parse((await handlers.get('ofw_list_drafts')!({ size: 1 })).content[0].text);
    expect(parsed.complete).toBe(false);
    expect(parsed.completeNote).toMatch(/1 of 2/);
  });

  it('ofw_list_drafts: complete:false when the cache was never confirmed, even for a full page', async () => {
    upsertDraft({
      id: 1, subject: 'A', body: 'a', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:00:00Z', listData: {},
    });
    setup(makeClient({}));

    const parsed = JSON.parse((await handlers.get('ofw_list_drafts')!({ verify: false })).content[0].text);
    expect(parsed.complete).toBe(false);
    expect(parsed.completeNote).toMatch(/not been confirmed against OurFamilyWizard/);
    expect(parsed.note).toMatch(/serverConfirmed:false/);
  });

  it('ofw_get_unread_sent: reports scanned/total and a complete flag', async () => {
    markFresh('sent');
    upsertMessage(sampleMessageRow({
      id: 1, folder: 'sent', recipients: [{ userId: 2, name: 'Co-parent', viewedAt: null }],
    }));
    upsertMessage(sampleMessageRow({
      id: 2, folder: 'sent', recipients: [{ userId: 2, name: 'Co-parent', viewedAt: '2026-07-01T00:00:00Z' }],
    }));
    setup(makeClient({}));

    let parsed = JSON.parse((await handlers.get('ofw_get_unread_sent')!({})).content[0].text);
    expect(parsed.unread).toHaveLength(1);
    expect(parsed).toMatchObject({ scanned: 2, total: 2, complete: true });

    parsed = JSON.parse((await handlers.get('ofw_get_unread_sent')!({ size: 1 })).content[0].text);
    expect(parsed.complete).toBe(false);
    expect(parsed.completeNote).toMatch(/1 of 2/);
  });

  it('ofw_get_unread_sent: a partial page from a stale cache names the staleness too', async () => {
    upsertMessage(sampleMessageRow({
      id: 1, folder: 'sent', recipients: [{ userId: 2, name: 'Co-parent', viewedAt: null }],
    }));
    upsertMessage(sampleMessageRow({
      id: 2, folder: 'sent', recipients: [{ userId: 2, name: 'Co-parent', viewedAt: null }],
    }));
    setup(makeClient({}));

    const parsed = JSON.parse(
      (await handlers.get('ofw_get_unread_sent')!({ size: 1 })).content[0].text,
    );
    expect(parsed.complete).toBe(false);
    expect(parsed.completeNote).toMatch(/from a cache that is "stale"/);
  });

  it('ofw_get_unread_sent: "all read" is a verdict over what was scanned, not an absence', async () => {
    markFresh('sent');
    upsertMessage(sampleMessageRow({
      id: 1, folder: 'sent', recipients: [{ userId: 2, name: 'Co-parent', viewedAt: '2026-07-01T00:00:00Z' }],
    }));
    setup(makeClient({}));

    const result = await handlers.get('ofw_get_unread_sent')!({});
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(parsed.unread).toEqual([]);
    expect(parsed.message).toMatch(/Every sent message scanned/);
  });
});

describe('draftKey: identity that survives the create-then-delete churn (Gap 3)', () => {
  it('carries ONE key across three edits, then onto the sent message', async () => {
    seedFolderIds();
    const { client } = fakeOFW();
    setup(client);

    // ofw_save_draft prepends transparency NOTEs before its JSON payload.
    const save = async (args: Record<string, unknown>) => {
      const text = (await handlers.get('ofw_save_draft')!(args)).content[0].text;
      return JSON.parse(text.slice(text.indexOf('{')));
    };

    const v1 = await save({ subject: 'Weekly', body: 'draft one' });
    const v2 = await save({ subject: 'Weekly', body: 'draft two', messageId: v1.id });
    const v3 = await save({ subject: 'Weekly', body: 'draft three', messageId: v2.id });

    // Three different OFW ids...
    expect(new Set([v1.id, v2.id, v3.id]).size).toBe(3);
    // ...one logical document.
    expect(v1.draftKey).toBeTruthy();
    expect(v2.draftKey).toBe(v1.draftKey);
    expect(v3.draftKey).toBe(v1.draftKey);
    expect(v3.previousId).toBe(v2.id);

    // The ORIGINAL key resolves to the CURRENT id — the question that was
    // previously unanswerable ("what happened to the thing I was editing?").
    let parsed = JSON.parse((await handlers.get('ofw_status')!({
      draftKeys: [v1.draftKey],
    })).content[0].text);
    expect(parsed.requested[0]).toMatchObject({
      draftKey: v1.draftKey, currentId: v3.id, state: 'draft',
    });
    expect(parsed.requested[0].previousIds).toEqual([v1.id, v2.id]);
    expect(parsed.complete).toBe(true);

    // Send it, and the key follows the message into Sent.
    const sent = JSON.parse((await handlers.get('ofw_send_message')!({
      messageId: v3.id, recipientIds: [7],
    })).content[0].text);
    expect(sent.draftKey).toBe(v1.draftKey);

    parsed = JSON.parse((await handlers.get('ofw_status')!({
      draftKeys: [v1.draftKey],
    })).content[0].text);
    expect(parsed.requested[0]).toMatchObject({
      draftKey: v1.draftKey,
      currentId: sent.id,
      state: 'sent',
      sentMessageId: sent.id,
    });
    expect(parsed.requested[0].sentAt).toBe('2026-07-27T20:00:00-04:00');
  });

  it('adopts a draft that predates the mechanism, retroactively linking the old id', async () => {
    seedFolderIds();
    const { client, messages } = fakeOFW();
    // A draft authored in the OFW web app: in the cache, no lineage row.
    messages.set(400, {
      id: 400, subject: 'Old', body: 'body', replyToId: null, recipients: [],
      date: { dateTime: '2026-07-01T00:00:00Z' }, folder: { id: 3, name: 'Drafts' },
    });
    upsertDraft({
      id: 400, subject: 'Old', body: 'body', recipients: [], replyToId: null,
      modifiedAt: '2026-07-01T00:00:00Z', listData: {},
    });
    setup(client);

    const savedText = (await handlers.get('ofw_save_draft')!({
      subject: 'Old', body: 'edited', messageId: 400,
    })).content[0].text;
    const saved = JSON.parse(savedText.slice(savedText.indexOf('{')));

    expect(saved.draftKey).toBeTruthy();
    expect(saved.previousId).toBe(400);
    const parsed = JSON.parse((await handlers.get('ofw_status')!({
      draftKeys: [saved.draftKey],
    })).content[0].text);
    expect(parsed.requested[0].previousIds).toEqual([400]);
    expect(parsed.requested[0].currentId).toBe(saved.id);
  });

  it('surfaces the draftKey on ofw_list_drafts and ofw_get_message, null when unknown', async () => {
    seedFolderIds();
    markFresh('drafts');
    upsertDraft({
      id: 400, subject: 'Old', body: 'body', recipients: [], replyToId: null,
      modifiedAt: '2026-07-01T00:00:00Z', listData: {},
    });
    upsertDraft({
      id: 401, subject: 'Known', body: 'body', recipients: [], replyToId: null,
      modifiedAt: '2026-07-02T00:00:00Z', listData: {},
    });
    cache.core.recordDraftLineage({
      id: 401, draftKey: 'dk_known', previousId: null, recordedAt: '2026-07-02T00:00:00Z',
    });
    setup(makeClient({}));

    const listed = JSON.parse((await handlers.get('ofw_list_drafts')!({})).content[0].text);
    const byId = new Map(listed.drafts.map((d: { id: number; draftKey: string | null }) => [d.id, d.draftKey]));
    expect(byId.get(401)).toBe('dk_known');
    expect(byId.get(400)).toBeNull();

    const got = JSON.parse((await handlers.get('ofw_get_message')!({ messageId: '401' })).content[0].text);
    expect(got.draftKey).toBe('dk_known');
    const unknown = JSON.parse((await handlers.get('ofw_get_message')!({ messageId: '400' })).content[0].text);
    expect(unknown.draftKey).toBeNull();
  });

  it('links a draft sent WITHOUT a prior save, so the key exists from the send alone', async () => {
    seedFolderIds();
    const { client, messages } = fakeOFW();
    messages.set(400, {
      id: 400, subject: 'Old', body: 'body', replyToId: null, recipients: [],
      date: { dateTime: '2026-07-01T00:00:00Z' }, folder: { id: 3, name: 'Drafts' },
    });
    upsertDraft({
      id: 400, subject: 'Old', body: 'body', recipients: [], replyToId: null,
      modifiedAt: '2026-07-01T00:00:00Z', listData: {},
    });
    setup(client);

    const sent = JSON.parse((await handlers.get('ofw_send_message')!({
      messageId: 400, recipientIds: [7],
    })).content[0].text);

    expect(sent.draftKey).toBeTruthy();
    expect(sent.previousId).toBe(400);
    const parsed = JSON.parse((await handlers.get('ofw_status')!({
      draftKeys: [sent.draftKey],
    })).content[0].text);
    expect(parsed.requested[0]).toMatchObject({ currentId: sent.id, state: 'sent' });
  });

  it('refuses to invent an answer for a key it has never seen', async () => {
    seedFolderIds();
    setup(makeClient({}));

    const parsed = JSON.parse((await handlers.get('ofw_status')!({
      draftKeys: ['dk_from_another_machine'],
    })).content[0].text);

    expect(parsed.requested[0]).toMatchObject({
      draftKey: 'dk_from_another_machine', state: 'unknown', error: 'UNKNOWN_DRAFT_KEY',
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.incompleteReasons.join(' ')).toMatch(/dk_from_another_machine/);
  });
});

describe('ofw_status (requirement 4)', () => {
  const foldersResponse = {
    systemFolders: [
      { id: '1', folderType: 'INBOX' },
      { id: '2', folderType: 'SENT_MESSAGES' },
      { id: '3', folderType: 'DRAFTS' },
    ],
  };

  it('with no arguments returns a verified full draft inventory', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(foldersResponse)                       // resolveFolderIds
      .mockResolvedValueOnce({                                      // drafts list (short page → done)
        data: [
          { id: 10, subject: 'One', date: { dateTime: '2026-07-20T00:00:00Z' } },
          { id: 11, subject: 'Two', date: { dateTime: '2026-07-21T00:00:00Z' } },
        ],
      })
      .mockResolvedValueOnce({ subject: 'One', body: 'body one' })  // detail 10
      .mockResolvedValueOnce({ subject: 'Two', body: 'body two' }); // detail 11
    // One of them came from a prior ofw_save_draft, so it carries an identity.
    cache.core.recordDraftLineage({
      id: 11, draftKey: 'dk_inventory', previousId: null, recordedAt: '2026-07-21T00:00:00Z',
    });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_status')!({})).content[0].text);

    expect(parsed.complete).toBe(true);
    expect(parsed.draftInventoryComplete).toBe(true);
    expect(parsed.draftCount).toBe(2);
    const byId = new Map(parsed.drafts.map((d: { id: number }) => [d.id, d]));
    expect([...byId.keys()].sort()).toEqual([10, 11]);
    expect(byId.get(11)).toMatchObject({ draftKey: 'dk_inventory' });
    expect(byId.get(10)).toMatchObject({ draftKey: null });
    expect(byId.get(10)).toHaveProperty('revision');
    expect(parsed.requested).toBeUndefined();
  });

  it('reports complete:false when the inventory walk was paused by the request budget', async () => {
    process.env.OFW_SYNC_MAX_REQUESTS = '1';                        // resolveFolderIds eats it
    try {
      const client = new OFWClient();
      vi.spyOn(client, 'request').mockResolvedValue(foldersResponse);
      const localHandlers = setupWithClient(client);

      const parsed = JSON.parse((await localHandlers.get('ofw_status')!({})).content[0].text);

      expect(parsed.draftInventoryComplete).toBe(false);
      expect(parsed.complete).toBe(false);
      expect(parsed.incompleteReasons.join(' ')).toMatch(/not fully verified/);
      expect(parsed.note).toMatch(/Do not report a draft count/);
    } finally {
      delete process.env.OFW_SYNC_MAX_REQUESTS;
    }
  });

  it('THE REGRESSION: three tracked ids, one sent externally → two drafts + one sent, in one call', async () => {
    seedFolderIds();
    // What the assistant "remembered": three drafts.
    for (const id of [537828154, 538086428, 538279699]) {
      upsertDraft({
        id, subject: `Draft ${id}`, body: 'body', recipients: [], replyToId: null,
        modifiedAt: '2026-07-27T18:00:00Z', listData: {},
      });
    }
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockImplementation(async (_m: string, path: string) => {
      const id = Number(path.split('/').pop());
      // 538279699 was sent from the web app last night; the cache never heard.
      if (id === 538279699) {
        return {
          subject: 'Draft 538279699', body: 'body', replyToId: null, recipients: [],
          folder: { id: 2, name: 'Sent Messages' },
          date: { dateTime: '2026-07-27T23:31:09' },
        };
      }
      return {
        subject: `Draft ${id}`, body: 'body', replyToId: null, recipients: [],
        folder: { id: 3, name: 'Drafts' },
      };
    });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_status')!({
      ids: [537828154, 538086428, 538279699],
    })).content[0].text);

    const byId = new Map(parsed.requested.map((r: { id: number }) => [r.id, r]));
    expect(byId.get(537828154)).toMatchObject({ state: 'draft', inSync: true });
    expect(byId.get(538086428)).toMatchObject({ state: 'draft', inSync: true });
    expect(byId.get(538279699)).toMatchObject({
      state: 'sent', sentAt: '2026-07-27T23:31:09-04:00', sentMessageId: 538279699, inSync: false,
    });
    // Every id was resolved live, so the snapshot IS a usable basis for a claim.
    expect(parsed.complete).toBe(true);
    expect(parsed.probeRequests).toBe(3);
  });

  it('probes an id named by BOTH a draftKey and a bare id only once', async () => {
    seedFolderIds();
    upsertDraft({
      id: 600, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    cache.core.recordDraftLineage({
      id: 600, draftKey: 'dk_dup', previousId: null, recordedAt: '2026-07-19T12:42:00Z',
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'D', body: 'b', replyToId: null, recipients: [], folder: { id: 3, name: 'Drafts' },
    });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_status')!({
      ids: [600], draftKeys: ['dk_dup'],
    })).content[0].text);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(parsed.probeRequests).toBe(1);
    expect(parsed.requested).toHaveLength(2);
    expect(parsed.requested[0].id).toBe(600);
    expect(parsed.requested[1].draftKey).toBe('dk_dup');
  });

  it('marks the snapshot incomplete when an id had to be skipped for mark-read reasons', async () => {
    seedFolderIds();
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request');
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_status')!({ ids: [999] })).content[0].text);

    expect(spy).not.toHaveBeenCalled();
    expect(parsed.requested[0]).toMatchObject({ skipped: true, reason: 'WOULD_MARK_READ' });
    expect(parsed.complete).toBe(false);
    expect(parsed.drafts).toBeUndefined();
  });

  it('caps the combined ids+draftKeys probe budget and says what it dropped', async () => {
    seedFolderIds();
    const ids = Array.from({ length: 30 }, (_, i) => 700 + i);
    for (const id of ids) {
      upsertDraft({
        id, subject: 'D', body: 'b', recipients: [], replyToId: null,
        modifiedAt: '2026-07-19T12:42:00Z', listData: {},
      });
    }
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValue({
      subject: 'D', body: 'b', replyToId: null, recipients: [], folder: { id: 3, name: 'Drafts' },
    });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_status')!({ ids })).content[0].text);

    expect(parsed.requested).toHaveLength(25);
    expect(parsed.complete).toBe(false);
    expect(parsed.incompleteReasons.join(' ')).toMatch(/5 of 30 requested ids\/draftKeys were not probed/);
  });

  it('can combine an explicit inventory with per-id probes', async () => {
    seedFolderIds();
    upsertDraft({
      id: 800, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(foldersResponse)                       // sync: resolveFolderIds
      .mockResolvedValueOnce({                                      // drafts list
        data: [{ id: 800, subject: 'D', date: { dateTime: '2026-07-19T12:42:00Z' } }],
      })
      .mockResolvedValueOnce({ subject: 'D', body: 'b' })           // draft detail
      .mockResolvedValueOnce({                                      // probe
        subject: 'D', body: 'b', replyToId: null, recipients: [], folder: { id: 3, name: 'Drafts' },
      });
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_status')!({
      ids: [800], includeDraftInventory: true,
    })).content[0].text);

    expect(parsed.draftCount).toBe(1);
    expect(parsed.requested[0].state).toBe('draft');
    expect(parsed.complete).toBe(true);
    expect(parsed.freshness).toBeDefined();
  });

  it('refuses a call that would check nothing rather than reporting complete:true', async () => {
    setup(makeClient({}));
    const result = await handlers.get('ofw_status')!({ includeDraftInventory: false });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.result).toBe('NOTHING_REQUESTED');
    expect(parsed.complete).toBe(false);
  });

  it('is honest when a probe outright fails', async () => {
    seedFolderIds();
    upsertDraft({
      id: 900, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-07-19T12:42:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 503'));
    setup(client);

    const parsed = JSON.parse((await handlers.get('ofw_status')!({ ids: [900] })).content[0].text);

    expect(parsed.requested[0].error).toBe('FRESHNESS_CHECK_FAILED');
    expect(parsed.complete).toBe(false);
  });
});

describe('ofw_send_message — send-by-draft guard & verdicts (consolidated fixes)', () => {
  const seedDraft = (over: Partial<DraftRow> = {}): void => upsertDraft({
    id: 300, subject: 'S', body: 'draft body', recipients: [], replyToId: null,
    modifiedAt: '2026-07-29T12:00:00Z', listData: {}, ...over,
  });
  const serverCopy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    subject: 'S', body: 'draft body', recipients: [], replyToId: null,
    folder: { id: '3', name: 'Drafts' }, ...over,
  });

  it('REFUSES a send with a stale expectedRevision — nothing sent, draft intact (required test 2)', async () => {
    seedDraft();
    const staleRevision = draftRevision({ subject: 'S', body: 'OLD body the caller last saw', replyToId: null, recipients: [] });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy({ body: 'edited on OFW since' }));
    setup(client);

    const result = await handlers.get('ofw_send_message')!({
      draftId: 300, expectedRevision: staleRevision,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('STALE_DRAFT');
    expect(parsed.serverBody).toBe('edited on OFW since');
    // ONE request: the freshness pre-read. No POST — nothing was sent.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
    expect(getDraft(300)).not.toBeNull();
  });

  it('a matching expectedRevision sends the server draft even when the local cache has never seen it', async () => {
    const serverContent = { subject: 'S', body: 'server body', replyToId: null, recipients: [] };
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy({ body: 'server body' }))
      .mockResolvedValueOnce({ entityId: 900 })
      .mockResolvedValueOnce({
        id: 900, subject: 'S', body: 'server body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    const result = await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7], expectedRevision: draftRevision(serverContent),
    });

    expect(result.isError).toBeUndefined();
    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { body: string }).body).toBe('server body');
    expect(result.content[0].text).toContain('"sentMessageId": 900');
    expect(result.content[0].text).toContain('"draftDeleted": true');
  });

  it('deleteDraftOnSuccess:false keeps the draft and says so', async () => {
    seedDraft();
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy())
      .mockResolvedValueOnce({ entityId: 901 })
      .mockResolvedValueOnce({
        id: 901, subject: 'S', body: 'draft body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7], deleteDraftOnSuccess: false,
    })).content[0].text;

    expect(spy).not.toHaveBeenCalledWith('DELETE', expect.anything(), expect.anything());
    expect(getDraft(300)).not.toBeNull();
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.draftDeleted).toBe(false);
    expect(parsed.draftRetained).toBe(true);
    expect(parsed.draftRetainedReason).toMatch(/kept by request/);
  });

  it('skips the guard entirely when every field is overridden AND the draft is kept', async () => {
    seedDraft({ replyToId: 42 });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 902 })
      .mockResolvedValueOnce({
        id: 902, subject: 'X', body: 'Y',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);

    await handlers.get('ofw_send_message')!({
      draftId: 300, subject: 'X', body: 'Y', recipientIds: [7], deleteDraftOnSuccess: false,
    });

    // No guard pre-read: nothing was trusted or destroyed. POST + GET only —
    // and the cached draft's replyToId still threads the send.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe('POST');
    expect((spy.mock.calls[0][2] as { replyToId: number | null }).replyToId).toBe(42);
    expect(getDraft(300)).not.toBeNull();
  });

  it('guard-skipped send with no cached draft still works — draftId is only a lineage link', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 903 })
      .mockResolvedValueOnce({
        id: 903, subject: 'X', body: 'Y',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 999888, subject: 'X', body: 'Y', recipientIds: [7], deleteDraftOnSuccess: false,
    })).content[0].text;

    expect(spy).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.sentMessageId).toBe(903);
    expect(parsed.draftKey).toBeTruthy();
  });

  it('retains the draft when the send lands but the draft delete FAILS', async () => {
    seedDraft();
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pub/v3/messages/300') return serverCopy();
      if (method === 'POST') return { entityId: 904 };
      if (method === 'GET' && path === '/pub/v3/messages/904') {
        return {
          id: 904, subject: 'S', body: 'draft body',
          date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
        };
      }
      throw new Error('OFW API error: 500 delete blew up');
    });
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7],
    })).content[0].text;

    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.sentMessageId).toBe(904);
    expect(parsed.draftDeleted).toBe(false);
    expect(parsed.draftRetained).toBe(true);
    expect(parsed.draftRetainedReason).toMatch(/delete failed/);
    expect(text).toMatch(/draft 300 was retained/);
    // The sent message is cached; the draft row survives for manual cleanup.
    expect(getMessage(904)?.folder).toBe('sent');
    expect(getDraft(300)).not.toBeNull();
  });

  it('retains the draft when the re-fetched sent record cannot be verified against what was posted', async () => {
    seedDraft();
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy())
      .mockResolvedValueOnce({ entityId: 905 })
      .mockResolvedValueOnce({
        id: 905, subject: 'S', body: 'something else entirely',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      });
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7],
    })).content[0].text;

    expect(spy).not.toHaveBeenCalledWith('DELETE', expect.anything(), expect.anything());
    expect(getDraft(300)).not.toBeNull();
    expect(text).toMatch(/WARNING: the message re-fetched from OFW does not contain the body/);
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.draftRetained).toBe(true);
    expect(parsed.draftRetainedReason).toMatch(/could not be fully verified/);
  });

  it('retains the draft when the sent record lists recipients but NOT the requested one', async () => {
    seedDraft();
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy())
      .mockResolvedValueOnce({ entityId: 906 })
      .mockResolvedValueOnce({
        id: 906, subject: 'S', body: 'draft body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' },
        recipients: [{ user: { userId: 999, name: 'Somebody Else' }, viewed: null }],
      });
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7],
    })).content[0].text;

    expect(text).toMatch(/does not list requested recipient id\(s\) 7/);
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.draftDeleted).toBe(false);
    expect(parsed.draftRetained).toBe(true);
    expect(getDraft(300)).not.toBeNull();
  });

  it('defaults recipients from the CACHED draft when the server copy reports none', async () => {
    // The server copy has no recipients (OFW never stores them on drafts) but
    // the cached row remembers who this was addressed to. The caller names the
    // server version with expectedRevision, so the guard passes on the token
    // and the recipient fallback walks server → cache.
    seedDraft({ recipients: [{ userId: 7, name: 'Co-parent', viewedAt: null }] });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy())
      .mockResolvedValueOnce({ entityId: 907 })
      .mockResolvedValueOnce({
        id: 907, subject: 'S', body: 'draft body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    await handlers.get('ofw_send_message')!({
      draftId: 300,
      expectedRevision: draftRevision({ subject: 'S', body: 'draft body', replyToId: null, recipients: [] }),
    });
    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { recipientIds: number[] }).recipientIds).toEqual([7]);
  });

  it('defaults recipients from the SERVER copy when it does report them', async () => {
    seedDraft({ recipients: [{ userId: 7, name: 'Co-parent', viewedAt: null }] });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy({ recipients: [{ user: { userId: 7, name: 'Co-parent' }, viewed: null }] }))
      .mockResolvedValueOnce({ entityId: 912 })
      .mockResolvedValueOnce({
        id: 912, subject: 'S', body: 'draft body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    await handlers.get('ofw_send_message')!({ draftId: 300 });
    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { recipientIds: number[] }).recipientIds).toEqual([7]);
  });

  it('errors with the OFW-drafts-store-no-recipients explanation when nobody can supply recipients', async () => {
    seedDraft();
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce(serverCopy());
    setup(client);

    await expect(handlers.get('ofw_send_message')!({ draftId: 300 }))
      .rejects.toThrow(/does not persist recipients on drafts.*ofw_get_profile/s);
    expect(getDraft(300)).not.toBeNull();
  });

  it('force:true past a failed freshness read falls back to the CACHED draft content', async () => {
    seedDraft({ body: 'cached body', replyToId: null });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockRejectedValueOnce(new Error('OFW API error: 503'))
      .mockResolvedValueOnce({ entityId: 908 })
      .mockResolvedValueOnce({
        id: 908, subject: 'S', body: 'cached body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7], force: true,
    })).content[0].text;

    expect(text).toMatch(/WARNING: force:true/);
    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { body: string }).body).toBe('cached body');
  });

  it('force:true with no server read AND no cached draft demands the missing fields explicitly', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValueOnce(new Error('OFW API error: 503'));
    setup(client);

    await expect(handlers.get('ofw_send_message')!({ draftId: 777, force: true }))
      .rejects.toThrow(/content was not readable.*Pass them explicitly/s);
  });

  it('reports threaded:true with a NOTE when OFW re-targets the reply within the thread', async () => {
    seedDraft({ replyToId: 100 });
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy({ replyToId: 100 }))
      .mockResolvedValueOnce({ entityId: 909 })
      .mockResolvedValueOnce({
        id: 909, subject: 'S', body: 'draft body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
        inReplyTo: 555, showContext: true,
      })
      .mockResolvedValueOnce({});
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7],
    })).content[0].text;

    expect(text).toMatch(/NOTE: the sent message threads to 555, not the requested 100/);
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.threaded).toBe(true);
    // The cached sent row records where the reply actually landed.
    expect(getMessage(909)?.replyToId).toBe(555);
  });

  it('reports threaded:false and WARNS when OFW positively reports no reply linkage', async () => {
    seedDraft({ replyToId: 100 });
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy({ replyToId: 100 }))
      .mockResolvedValueOnce({ entityId: 910 })
      .mockResolvedValueOnce({
        id: 910, subject: 'S', body: 'draft body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
        replyToId: null, inReplyTo: null, showContext: false,
      })
      .mockResolvedValueOnce({});
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7],
    })).content[0].text;

    expect(text).toMatch(/WARNING: the sent message came back UNTHREADED/);
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.threaded).toBe(false);
    // No invented chain link for a message OFW says is not threaded.
    expect(getMessage(910)?.replyToId).toBeNull();
    expect(getMessage(910)?.chainRootId).toBeNull();
  });

  it('reports threaded:true silently when the echo confirms the requested target via inReplyTo', async () => {
    seedDraft({ replyToId: 100 });
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverCopy({ replyToId: 100 }))
      .mockResolvedValueOnce({ entityId: 911 })
      .mockResolvedValueOnce({
        id: 911, subject: 'S', body: 'draft body',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
        replyToId: null, inReplyTo: 100, showContext: true,
      })
      .mockResolvedValueOnce({});
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 300, recipientIds: [7],
    })).content[0].text;

    expect(text).not.toContain('WARNING');
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    expect(parsed.threaded).toBe(true);
    expect(parsed.draftDeleted).toBe(true);
    expect(getMessage(911)?.replyToId).toBe(100);
  });
});

describe('ofw_save_draft — threading verdict reads the FULL echo (consolidated fix 2)', () => {
  const trailingJson = (text: string): Record<string, unknown> =>
    JSON.parse(text.slice(text.indexOf('{')));

  it('does NOT warn when the saved draft echoes the target as inReplyTo with replyToId null (the observed false positive)', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 950 })
      .mockResolvedValueOnce({
        id: 950, subject: 'Re: Weekly', body: 'B',
        date: { dateTime: '2026-07-29T00:00:00Z' },
        replyToId: null, inReplyTo: 538672434, showContext: true,
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re: Weekly', body: 'B', replyToId: 538672434,
    });

    const text = result.content[0].text;
    expect(text).not.toContain('WARNING');
    expect(text).not.toContain('did not thread');
    const parsed = trailingJson(text);
    expect(parsed.warnings).toBeUndefined();
    // Top-level threading agrees with the listData echo — the two never disagree.
    expect(parsed.replyToId).toBe(538672434);
    expect(parsed.inReplyTo).toBe(538672434);
    // …and the revision hashes the SAME derived value a later read will see.
    expect(parsed.revision).toBe(draftRevision({
      subject: 'Re: Weekly', body: 'B', replyToId: 538672434, recipients: [],
    }));
  });

  it('does NOT warn when OFW confirms threading via showContext alone', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 951 })
      .mockResolvedValueOnce({
        id: 951, subject: 'Re: Weekly', body: 'B',
        date: { dateTime: '2026-07-29T00:00:00Z' },
        showContext: true,
      });
    setup(client);

    const text = (await handlers.get('ofw_save_draft')!({
      subject: 'Re: Weekly', body: 'B', replyToId: 200,
    })).content[0].text;

    expect(text).not.toContain('WARNING');
    expect(trailingJson(text).warnings).toBeUndefined();
  });

  it('still warns about a rewritten-then-RE-TARGETED reply, naming both hops', async () => {
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    upsertMessage({
      id: 142, folder: 'sent', subject: 'Re: Original', fromUser: 'Me',
      sentAt: '2026-05-02T00:00:00Z', recipients: [], body: 'first reply',
      fetchedBodyAt: '2026-05-02T00:01:00Z', replyToId: 100, chainRootId: 100, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 952 })
      .mockResolvedValueOnce({
        id: 952, subject: 'Re: Original', body: 'B',
        date: { dateTime: '2026-07-29T00:00:00Z' },
        replyToId: 205, showContext: true,
      });
    setup(client);

    const text = (await handlers.get('ofw_save_draft')!({
      subject: 'Re: Original', body: 'B', replyToId: 100,
    })).content[0].text;

    const parsed = trailingJson(text);
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/requested as 142 \(rewritten from 100\).*re-targeted the reply to message 205/s),
    ]));
    expect(parsed.replyToId).toBe(205);
  });
});

describe('ofw_save_draft — draft recipients are a documented NOTE, not a warning (consolidated fix 3)', () => {
  const trailingJson = (text: string): Record<string, unknown> =>
    JSON.parse(text.slice(text.indexOf('{')));

  it('an empty recipients echo produces recipientsNote and NO warning', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 960 })
      .mockResolvedValueOnce({
        id: 960, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-29T00:00:00Z' },
        recipients: [],
      });
    setup(client);

    const text = (await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', recipientIds: [3039201],
    })).content[0].text;

    expect(text).not.toContain('WARNING');
    expect(text).toMatch(/does not persist recipients on drafts/);
    const parsed = trailingJson(text);
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.recipientsNote).toMatch(/Supply recipientIds when you send/);
  });

  it('an empty recipientIds request does not trigger the note at all', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 961 })
      .mockResolvedValueOnce({
        id: 961, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-29T00:00:00Z' },
        recipients: [],
      });
    setup(client);

    const text = (await handlers.get('ofw_save_draft')!({
      subject: 'S', body: 'B', recipientIds: [],
    })).content[0].text;

    expect(text).not.toContain('WARNING');
    expect(trailingJson(text).recipientsNote).toBeUndefined();
  });
});

describe('auto-review follow-ups for the consolidated fixes (issue #207)', () => {
  const trailingJson = (text: string): Record<string, unknown> =>
    JSON.parse(text.slice(text.indexOf('{')));

  it('send: a bare replyToId:null echo is NOT evidence of a drop — threaded, no warning, chain preserved', async () => {
    // OFW routinely emits replyToId:null on items that ARE threaded (the
    // linkage lives in inReplyTo, which this payload simply omits). Treating
    // it as disconfirmation produced a false UNTHREADED warning and nulled
    // the cached chain link, dropping the message out of findLatestReplyTip.
    upsertDraft({
      id: 310, subject: 'S', body: 'B', recipients: [], replyToId: 100,
      modifiedAt: '2026-07-29T12:00:00Z', listData: {},
    });
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: '2026-05-01T00:01:00Z', replyToId: null, chainRootId: null, listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ subject: 'S', body: 'B', recipients: [], replyToId: 100, folder: { id: '3', name: 'Drafts' } })
      .mockResolvedValueOnce({ entityId: 920 })
      .mockResolvedValueOnce({
        id: 920, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
        replyToId: null,                                    // present-but-null, nothing else
      })
      .mockResolvedValueOnce({});
    setup(client);

    const text = (await handlers.get('ofw_send_message')!({
      draftId: 310, recipientIds: [7],
    })).content[0].text;

    expect(text).not.toContain('UNTHREADED');
    expect(text).not.toContain('WARNING');
    const parsed = trailingJson(text);
    expect(parsed.threaded).toBe(true);
    expect(parsed.draftDeleted).toBe(true);
    // The chain link survives for findLatestReplyTip.
    expect(getMessage(920)?.replyToId).toBe(100);
    expect(getMessage(920)?.chainRootId).toBe(100);
  });

  it('save: a bare replyToId:null echo does not warn either — same evidence rule as send', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 921 })
      .mockResolvedValueOnce({
        id: 921, subject: 'Re: pickup', body: 'reply',
        date: { dateTime: '2026-07-20T00:00:00Z' }, replyToId: null,
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re: pickup', body: 'reply', replyToId: 100,
    });

    expect(result.content[0].text).not.toMatch(/WARNING/);
    expect(result.content[0].text).not.toMatch(/did not thread/);
    const parsed = trailingJson(result.content[0].text);
    expect(parsed.warnings).toBeUndefined();
    // The stored value is still the server echo (null), never masked intent —
    // the revision must hash what the next sync reads.
    expect(parsed.replyToId).toBeNull();
  });

  it('save: a detail omitting EVERY echo field is "not echoed", never "dropped"', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ entityId: 922 })
      .mockResolvedValueOnce({
        id: 922, subject: 'Re: pickup', body: 'reply',
        date: { dateTime: '2026-07-20T00:00:00Z' },
      });
    setup(client);

    const result = await handlers.get('ofw_save_draft')!({
      subject: 'Re: pickup', body: 'reply', replyToId: 100,
    });

    expect(result.content[0].text).not.toMatch(/did not thread/);
    expect(trailingJson(result.content[0].text).warnings).toBeUndefined();
  });

  it('list_drafts: a budget-paused auto-verify does NOT claim autoVerified', async () => {
    upsertDraft({
      id: 5, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z', listData: {},
    });
    // A budget of 1 is spent entirely on the folder resolve; the drafts walk
    // defers, so the cache is still unverified after the "verification".
    process.env.OFW_SYNC_MAX_REQUESTS = '1';
    try {
      const client = new OFWClient();
      vi.spyOn(client, 'request').mockResolvedValue({
        systemFolders: [
          { id: '1', folderType: 'INBOX' },
          { id: '2', folderType: 'SENT_MESSAGES' },
          { id: '3', folderType: 'DRAFTS' },
        ],
      });
      const localHandlers = setupWithClient(client);

      const parsed = JSON.parse((await localHandlers.get('ofw_list_drafts')!({})).content[0].text);
      expect(parsed.autoVerified).toBeUndefined();
      expect(parsed.drafts[0].serverConfirmed).toBe(false);
      expect(parsed.complete).toBe(false);
    } finally {
      delete process.env.OFW_SYNC_MAX_REQUESTS;
    }
  });

  it('list_drafts: a failed auto-verify degrades to the labelled cache answer, not a hard error', async () => {
    upsertDraft({
      id: 5, subject: 'D', body: 'b', recipients: [], replyToId: null,
      modifiedAt: '2026-05-04T12:00:00Z', listData: {},
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 503 down'));
    setup(client);

    const result = await handlers.get('ofw_list_drafts')!({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.verifyNote).toMatch(/could not reach OurFamilyWizard.*503/s);
    expect(parsed.drafts[0].serverConfirmed).toBe(false);
  });

  it('list_drafts: a failed auto-verify over an EMPTY cache still refuses, with the failure named', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 503 down'));
    setup(client);

    const result = await handlers.get('ofw_list_drafts')!({});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBe('UNVERIFIED_EMPTY');
    expect(parsed.verifyNote).toMatch(/could not reach OurFamilyWizard/);
  });

  it('send-by-draft carries the SERVER draft\'s attachments onto the sent message', async () => {
    upsertDraft({
      id: 320, subject: 'S', body: 'B', recipients: [], replyToId: null,
      modifiedAt: '2026-07-29T12:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        subject: 'S', body: 'B', recipients: [], replyToId: null,
        folder: { id: '3', name: 'Drafts' }, files: [51, 52],
      })
      .mockResolvedValueOnce({ entityId: 930 })
      .mockResolvedValueOnce({
        id: 930, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    await handlers.get('ofw_send_message')!({ draftId: 320, recipientIds: [7] });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([51, 52]);
    // …and the attachment cache links them to the new sent id.
    expect(listAttachmentsForMessage(930).map((a) => a.fileId).sort()).toEqual([51, 52]);
  });

  it('an explicit myFileIDs still overrides the server draft\'s attachments', async () => {
    upsertDraft({
      id: 321, subject: 'S', body: 'B', recipients: [], replyToId: null,
      modifiedAt: '2026-07-29T12:00:00Z', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        subject: 'S', body: 'B', recipients: [], replyToId: null,
        folder: { id: '3', name: 'Drafts' }, files: [51],
      })
      .mockResolvedValueOnce({ entityId: 931 })
      .mockResolvedValueOnce({
        id: 931, subject: 'S', body: 'B',
        date: { dateTime: '2026-07-29T13:00:00Z' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    await handlers.get('ofw_send_message')!({ draftId: 321, recipientIds: [7], myFileIDs: [99] });

    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { attachments: { myFileIDs: number[] } }).attachments.myFileIDs).toEqual([99]);
  });
});
