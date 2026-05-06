import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import { closeCache, upsertMessage, upsertDraft, getMessage, getDraft } from '../../src/cache.js';

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

describe('registerMessageTools', () => {
  it('registers 9 message tools (8 original + ofw_sync_messages)', () => {
    const client = makeClient({});
    setup(client);
    expect(handlers.size).toBe(9);
    expect(handlers.has('ofw_list_message_folders')).toBe(true);
    expect(handlers.has('ofw_list_messages')).toBe(true);
    expect(handlers.has('ofw_get_message')).toBe(true);
    expect(handlers.has('ofw_send_message')).toBe(true);
    expect(handlers.has('ofw_list_drafts')).toBe(true);
    expect(handlers.has('ofw_save_draft')).toBe(true);
    expect(handlers.has('ofw_delete_draft')).toBe(true);
    expect(handlers.has('ofw_get_unread_sent')).toBe(true);
    expect(handlers.has('ofw_sync_messages')).toBe(true);
  });
});
