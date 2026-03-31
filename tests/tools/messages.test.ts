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
      replyToId: null,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it('does not delete a draft when draftId is not provided', async () => {
    const client = makeClient({ id: 200, status: 'sent' });

    await handleTool('ofw_send_message', {
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
    }, client);

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).not.toHaveBeenCalledWith('DELETE', expect.anything(), expect.anything());
  });

  it('sends reply with replyToId and includeOriginal true to thread message history', async () => {
    const client = makeClient({ id: 201, status: 'sent' });

    await handleTool('ofw_send_message', {
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipientIds: [123],
      replyToId: 55,
    }, client);

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

    const result = await handleTool('ofw_send_message', {
      subject: 'Hello',
      body: 'World',
      recipientIds: [123],
      draftId: 42,
    }, c);

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
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 200, status: 'sent' });
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

  it('sets includeOriginal true when replyToId is provided', async () => {
    const client = makeClient({ entityId: 42 });

    await handleTool('ofw_save_draft', {
      subject: 'Re: pickup',
      body: 'Draft reply body',
      replyToId: 55,
    }, client);

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
      includeOriginal: true,
      replyToId: 55,
      messageId: 99,
    });
  });
});

describe('ofw_delete_draft', () => {
  it('deletes a draft by messageId using multipart form', async () => {
    const client = makeClient({});

    const result = await handleTool('ofw_delete_draft', { messageId: 42 }, client);

    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v1/messages', expect.any(FormData));
    const form = (client.request as ReturnType<typeof vi.fn>).mock.calls[0][2] as FormData;
    expect(form.get('messageIds')).toBe('42');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('ofw_get_unread_sent', () => {
  it('fetches sent folder id, lists sent messages, and fetches each for read status', async () => {
    const c = new OFWClient();
    const spy = vi.spyOn(c, 'request')
      .mockResolvedValueOnce([
        { id: 'sent-folder-1', folderType: 'SENT_MESSAGES', name: 'Sent' },
        { id: 'inbox-1', folderType: 'INBOX', name: 'Inbox' },
      ])
      .mockResolvedValueOnce({
        data: [
          { id: 101, subject: 'Pickup Tuesday' },
          { id: 102, subject: 'School forms' },
        ],
      })
      .mockResolvedValueOnce({
        id: 101,
        subject: 'Pickup Tuesday',
        date: { dateTime: '2026-03-28T14:00:00Z' },
        recipients: [
          { user: { name: 'Jane Smith' }, viewed: null },
        ],
      })
      .mockResolvedValueOnce({
        id: 102,
        subject: 'School forms',
        date: { dateTime: '2026-03-27T09:00:00Z' },
        recipients: [
          { user: { name: 'Jane Smith' }, viewed: { dateTime: '2026-03-27T10:00:00Z' } },
        ],
      });

    const result = await handleTool('ofw_get_unread_sent', {}, c);

    expect(spy).toHaveBeenNthCalledWith(1, 'GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    // default size=20 (smaller than ofw_list_messages' 50) because each message requires an additional detail fetch
    expect(spy).toHaveBeenNthCalledWith(2, 'GET', '/pub/v3/messages?folders=sent-folder-1&page=1&size=20&sort=date&sortDirection=desc');
    expect(spy).toHaveBeenNthCalledWith(3, 'GET', '/pub/v3/messages/101');
    expect(spy).toHaveBeenNthCalledWith(4, 'GET', '/pub/v3/messages/102');
    expect(spy).toHaveBeenCalledTimes(4);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: 101,
      subject: 'Pickup Tuesday',
      sentAt: '2026-03-28T14:00:00Z',
      unreadBy: ['Jane Smith'],
    });
  });

  it('returns empty array message when all sent messages have been read', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT_MESSAGES', name: 'Sent' }])
      .mockResolvedValueOnce({
        data: [{ id: 200, subject: 'Done' }],
      })
      .mockResolvedValueOnce({
        id: 200,
        subject: 'Done',
        date: { dateTime: '2026-03-20T08:00:00Z' },
        recipients: [
          { user: { name: 'Jane Smith' }, viewed: { dateTime: '2026-03-20T09:00:00Z' } },
        ],
      });

    const result = await handleTool('ofw_get_unread_sent', {}, c);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ message: 'All scanned sent messages have been read.' });
  });

  it('returns all-read message when sent folder has no messages', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT_MESSAGES', name: 'Sent' }])
      .mockResolvedValueOnce({ data: [] });

    const result = await handleTool('ofw_get_unread_sent', {}, c);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ message: 'All scanned sent messages have been read.' });
  });

  it('passes custom page and size', async () => {
    const c = new OFWClient();
    const spy = vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT_MESSAGES', name: 'Sent' }])
      .mockResolvedValueOnce({ data: [] });

    await handleTool('ofw_get_unread_sent', { page: 3, size: 10 }, c);

    expect(spy).toHaveBeenNthCalledWith(2, 'GET', '/pub/v3/messages?folders=sent-1&page=3&size=10&sort=date&sortDirection=desc');
  });

  it('throws if no sent folder is found', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce([
      { id: 'inbox-1', folderType: 'INBOX', name: 'Inbox' },
    ]);

    await expect(handleTool('ofw_get_unread_sent', {}, c)).rejects.toThrow('Sent folder not found');
  });

  it('includes all unread recipients when multiple recipients exist', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT_MESSAGES', name: 'Sent' }])
      .mockResolvedValueOnce({ data: [{ id: 300, subject: 'Group message' }] })
      .mockResolvedValueOnce({
        id: 300,
        subject: 'Group message',
        date: { dateTime: '2026-03-29T10:00:00Z' },
        recipients: [
          { user: { name: 'Alice' }, viewed: { dateTime: '2026-03-29T11:00:00Z' } },
          { user: { name: 'Bob' }, viewed: null },
          { user: { name: 'Carol' }, viewed: null },
        ],
      });

    const result = await handleTool('ofw_get_unread_sent', {}, c);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].unreadBy).toEqual(['Bob', 'Carol']);
  });
});

describe('toolDefinitions', () => {
  it('exports 8 message tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toHaveLength(8);
    expect(names).toContain('ofw_list_message_folders');
    expect(names).toContain('ofw_list_messages');
    expect(names).toContain('ofw_get_message');
    expect(names).toContain('ofw_send_message');
    expect(names).toContain('ofw_list_drafts');
    expect(names).toContain('ofw_save_draft');
    expect(names).toContain('ofw_delete_draft');
    expect(names).toContain('ofw_get_unread_sent');
  });
});

describe('unknown tool', () => {
  it('throws on unknown tool name', async () => {
    const client = makeClient({});
    await expect(handleTool('ofw_unknown', {}, client)).rejects.toThrow('Unknown tool: ofw_unknown');
  });
});
