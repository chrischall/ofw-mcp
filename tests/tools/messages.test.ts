import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/messages.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_list_message_folders', () => {
  it('calls messageFolders with includeFolderCounts=true', async () => {
    const folders = [{ id: 1, name: 'Inbox', unreadCount: 2 }];
    const client = makeClient(folders);

    const result = await handleTool('ofw_list_message_folders', {}, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/messageFolders?includeFolderCounts=true'
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(folders);
  });
});

describe('ofw_list_messages', () => {
  it('calls messages endpoint with folderId and defaults', async () => {
    const messages = { items: [{ id: 1, subject: 'Hello' }] };
    const client = makeClient(messages);

    await handleTool('ofw_list_messages', { folderId: '42' }, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v3/messages?folders=42&page=1&size=50&sort=date&sortDirection=desc'
    );
  });

  it('passes custom page and size', async () => {
    const client = makeClient({ items: [] });

    await handleTool('ofw_list_messages', { folderId: '5', page: 2, size: 10 }, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v3/messages?folders=5&page=2&size=10&sort=date&sortDirection=desc'
    );
  });
});

describe('ofw_get_message', () => {
  it('calls /pub/v3/messages/{id}', async () => {
    const msg = { id: 99, subject: 'Test', body: 'Hello' };
    const client = makeClient(msg);

    const result = await handleTool('ofw_get_message', { messageId: '99' }, client);

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v3/messages/99');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(msg);
  });
});

describe('ofw_send_message', () => {
  it('posts to /pub/v3/messages with correct payload', async () => {
    const client = makeClient({ id: 200, status: 'sent' });

    const result = await handleTool('ofw_send_message', {
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
    }, client);

    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: false,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('ofw_list_drafts', () => {
  it('queries the DRAFTS folder with defaults', async () => {
    const client = makeClient({ items: [] });

    await handleTool('ofw_list_drafts', {}, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v3/messages?folders=13471259&page=1&size=50&sort=date&sortDirection=desc'
    );
  });

  it('passes custom page and size', async () => {
    const client = makeClient({ items: [] });

    await handleTool('ofw_list_drafts', { page: 2, size: 10 }, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v3/messages?folders=13471259&page=2&size=10&sort=date&sortDirection=desc'
    );
  });
});

describe('ofw_save_draft', () => {
  it('creates a new draft without messageId', async () => {
    const client = makeClient({ entityId: 42 });

    await handleTool('ofw_save_draft', {
      subject: 'Draft subject',
      body: 'Draft body',
    }, client);

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

  it('updates an existing draft when messageId is provided', async () => {
    const client = makeClient({ entityId: 99 });

    await handleTool('ofw_save_draft', {
      subject: 'Updated subject',
      body: 'Updated body',
      recipientIds: [3039202],
      messageId: 99,
      replyToId: 55,
    }, client);

    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', {
      subject: 'Updated subject',
      body: 'Updated body',
      recipientIds: [3039202],
      attachments: { myFileIDs: [] },
      draft: true,
      includeOriginal: false,
      replyToId: 55,
      messageId: 99,
    });
  });
});

describe('ofw_delete_draft', () => {
  it('deletes a draft by messageId', async () => {
    const client = makeClient({});

    const result = await handleTool('ofw_delete_draft', { messageId: 42 }, client);

    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v3/messages/42');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('toolDefinitions', () => {
  it('exports 7 message tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toHaveLength(7);
    expect(names).toContain('ofw_list_message_folders');
    expect(names).toContain('ofw_list_messages');
    expect(names).toContain('ofw_get_message');
    expect(names).toContain('ofw_send_message');
    expect(names).toContain('ofw_list_drafts');
    expect(names).toContain('ofw_save_draft');
    expect(names).toContain('ofw_delete_draft');
  });
});

describe('unknown tool', () => {
  it('throws on unknown tool name', async () => {
    const client = makeClient({});
    await expect(handleTool('ofw_unknown', {}, client)).rejects.toThrow('Unknown tool: ofw_unknown');
  });
});
