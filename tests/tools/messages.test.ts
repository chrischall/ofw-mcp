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

