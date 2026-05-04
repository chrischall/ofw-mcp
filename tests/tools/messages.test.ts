import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import { closeCache } from '../../src/cache.js';

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
