import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import {
  closeCache, upsertMessage, upsertDraft, getMessage, getDraft,
  upsertAttachmentForMessage,
} from '../../src/cache.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let handlers: Map<string, ToolHandler>;
let tmpDir: string;
let originalCacheDir: string | undefined;
let originalUsername: string | undefined;

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
  registerMessageTools(server, client);
}

function setupWithClient(client: OFWClient): Map<string, ToolHandler> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const localHandlers = new Map<string, ToolHandler>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    localHandlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerMessageTools(server, client);
  return localHandlers;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ofw-tools-'));
  originalCacheDir = process.env.OFW_CACHE_DIR;
  originalUsername = process.env.OFW_USERNAME;
  process.env.OFW_CACHE_DIR = tmpDir;
  process.env.OFW_USERNAME = 'test@example.com';
});

afterEach(() => {
  closeCache();
  vi.restoreAllMocks();
  if (originalCacheDir === undefined) delete process.env.OFW_CACHE_DIR;
  else process.env.OFW_CACHE_DIR = originalCacheDir;
  if (originalUsername === undefined) delete process.env.OFW_USERNAME;
  else process.env.OFW_USERNAME = originalUsername;
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
});

describe('ofw_send_message', () => {
  it('posts to /pub/v3/messages with correct payload', async () => {
    const client = makeClient({ id: 200, status: 'sent' });
    setup(client);

    const result = await handlers.get('ofw_send_message')!({
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
    });

    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: false,
      replyToId: null,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it('does not delete a draft when draftId is not provided', async () => {
    const client = makeClient({ id: 200, status: 'sent' });
    setup(client);

    await handlers.get('ofw_send_message')!({
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
    });

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).not.toHaveBeenCalledWith('DELETE', expect.anything(), expect.anything());
  });

  it('sends reply with replyToId and includeOriginal true to thread message history', async () => {
    const client = makeClient({ id: 201, status: 'sent' });
    setup(client);

    await handlers.get('ofw_send_message')!({
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
      replyToId: 55,
    });

    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
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
      .mockResolvedValueOnce({ id: 200, status: 'sent' })
      .mockResolvedValueOnce({});

    const localHandlers = setupWithClient(c);

    const result = await localHandlers.get('ofw_send_message')!({
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
      draftId: 42,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, 'POST', '/pub/v3/messages', {
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: false,
      replyToId: null,
    });
    expect(spy).toHaveBeenNthCalledWith(2, 'DELETE', '/pub/v1/messages', expect.any(FormData));
    const deleteForm = spy.mock.calls[1][2] as FormData;
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
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({
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
  });

  it('does not rewrite when replyToId is the chain tip', async () => {
    upsertMessage({
      id: 100, folder: 'inbox', subject: 'Original', fromUser: 'Alice',
      sentAt: '2026-05-01T00:00:00Z', recipients: [], body: 'orig',
      fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    });

    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({
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
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({
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
});

describe('ofw_save_draft', () => {
  it('creates a new draft without messageId', async () => {
    const client = makeClient({ entityId: 42 });
    setup(client);

    await handlers.get('ofw_save_draft')!({
      subject: 'Draft subject',
      body: 'Draft body',
    });

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
    const client = makeClient({ entityId: 42 });
    setup(client);

    await handlers.get('ofw_save_draft')!({
      subject: 'Re: pickup',
      body: 'Draft reply body',
      replyToId: 55,
    });

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

  it('updates an existing draft when messageId is provided', async () => {
    const client = makeClient({ entityId: 99 });
    setup(client);

    await handlers.get('ofw_save_draft')!({
      subject: 'Updated subject',
      body: 'Updated body',
      recipientIds: [3039202],
      messageId: 99,
      replyToId: 55,
    });

    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Updated subject',
      body: 'Updated body',
      recipientIds: [3039202],
      attachments: { myFileIDs: [] },
      draft: true,
      includeOriginal: true,
      replyToId: 55,
      messageId: 99,
    });
  });
});

describe('ofw_save_draft (thread-tip + cache upsert)', () => {
  it('rewrites replyToId to the chain tip and upserts cache', async () => {
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
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({
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
    expect(result.content[0].text).toMatch(/replyToId rewritten from 100 to 142/);

    expect(getDraft(50)?.body).toBe('draft body');
    expect(getDraft(50)?.replyToId).toBe(142);
  });

  it('passes through replyToId unchanged when nothing to rewrite', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 50, subject: 'New', body: 'b',
      date: { dateTime: '2026-05-04T00:00:00Z' },
    });
    setup(client);
    await handlers.get('ofw_save_draft')!({ subject: 'New', body: 'b' });
    const postCall = spy.mock.calls.find((c) => c[0] === 'POST');
    expect((postCall![2] as { replyToId: number | null }).replyToId).toBeNull();
    expect(getDraft(50)?.body).toBe('b');
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
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({
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

  it('links attachment cache rows to the new sent message', async () => {
    // Pre-cache the attachment metadata as if it had been uploaded earlier
    upsertAttachmentForMessage({
      fileId: 50015547, fileName: 'doc.pdf', label: 'doc', mimeType: 'application/pdf',
      sizeBytes: 1024, metadata: {}, messageId: 0,
    });
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce({
      id: 200, subject: 'x', body: 'y',
      date: { dateTime: '2026-05-14T00:00:00Z' }, from: { name: 'Me' }, recipients: [],
    });
    setup(client);
    await handlers.get('ofw_send_message')!({
      subject: 'x', body: 'y', recipientIds: [1], myFileIDs: [50015547],
    });
    // After send, the attachment should now be linked to message 200
    const { listAttachmentsForMessage } = await import('../../src/cache.js');
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

describe('registerMessageTools', () => {
  it('registers 11 message tools', () => {
    const client = makeClient({});
    setup(client);
    expect(handlers.size).toBe(11);
    expect(handlers.has('ofw_list_message_folders')).toBe(true);
    expect(handlers.has('ofw_list_messages')).toBe(true);
    expect(handlers.has('ofw_get_message')).toBe(true);
    expect(handlers.has('ofw_send_message')).toBe(true);
    expect(handlers.has('ofw_list_drafts')).toBe(true);
    expect(handlers.has('ofw_save_draft')).toBe(true);
    expect(handlers.has('ofw_delete_draft')).toBe(true);
    expect(handlers.has('ofw_get_unread_sent')).toBe(true);
    expect(handlers.has('ofw_sync_messages')).toBe(true);
    expect(handlers.has('ofw_download_attachment')).toBe(true);
    expect(handlers.has('ofw_upload_attachment')).toBe(true);
  });
});
