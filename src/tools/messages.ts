import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_list_message_folders',
    description: 'List OurFamilyWizard message folders (inbox, sent, etc.) and their unread counts. Returns folder IDs needed to call ofw_list_messages. Does NOT return message content.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ofw_list_messages',
    description: 'List messages in an OurFamilyWizard folder. Call ofw_list_message_folders first to get folder IDs. Returns actual message content.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder ID (get from ofw_list_message_folders)' },
        page: { type: 'number', description: 'Page number (default 1)' },
        size: { type: 'number', description: 'Messages per page (default 50)' },
      },
      required: ['folderId'],
    },
  },
  {
    name: 'ofw_get_message',
    description: 'Get a single OurFamilyWizard message by ID. Note: reading an unread message marks it as read.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message ID' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'ofw_send_message',
    description: 'Send a message via OurFamilyWizard. If sending from a draft, pass draftId to automatically delete the draft after sending.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Message subject' },
        body: { type: 'string', description: 'Message body text' },
        recipientIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of recipient user IDs (get from ofw_get_profile)',
        },
        replyToId: {
          type: 'number',
          description: 'ID of the message being replied to. When provided, the original message thread is included (like a standard email reply).',
        },
        draftId: {
          type: 'number',
          description: 'ID of the draft to delete after sending (omit if not sending from a draft)',
        },
      },
      required: ['subject', 'body', 'recipientIds'],
    },
  },
  {
    name: 'ofw_list_drafts',
    description: 'List all draft messages in OurFamilyWizard',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number (default 1)' },
        size: { type: 'number', description: 'Drafts per page (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'ofw_save_draft',
    description: 'Save a message as a draft in OurFamilyWizard. Recipients are optional — a draft can be saved without them. To update an existing draft, provide its messageId.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Message subject' },
        body: { type: 'string', description: 'Message body text' },
        recipientIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of recipient user IDs (optional for drafts)',
        },
        messageId: {
          type: 'number',
          description: 'ID of an existing draft to update (omit to create a new draft)',
        },
        replyToId: {
          type: 'number',
          description: 'ID of the message this draft is replying to (omit for new messages)',
        },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: 'ofw_delete_draft',
    description: 'Delete a draft message from OurFamilyWizard',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'number', description: 'Draft message ID to delete' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'ofw_get_unread_sent',
    description: 'List sent messages that have not been read by one or more recipients. Fetches sent messages page by page and returns only those with unread recipients.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page of sent messages to scan (default 1)' },
        size: { type: 'number', description: 'Number of sent messages per page, max 50 (default 20)' },
      },
      required: [],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_list_message_folders': {
      const data = await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_list_messages': {
      const { folderId, page = 1, size = 50 } = args as {
        folderId: string;
        page?: number;
        size?: number;
      };
      const path = `/pub/v3/messages?folders=${encodeURIComponent(folderId)}&page=${page}&size=${size}&sort=date&sortDirection=desc`;
      const data = await client.request('GET', path);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_get_message': {
      const { messageId } = args as { messageId: string };
      const data = await client.request('GET', `/pub/v3/messages/${encodeURIComponent(messageId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_send_message': {
      const { subject, body, recipientIds, replyToId = null, draftId } = args as {
        subject: string;
        body: string;
        recipientIds: number[];
        replyToId?: number | null;
        draftId?: number;
      };
      const data = await client.request('POST', '/pub/v3/messages', {
        subject, body, recipientIds,
        attachments: { myFileIDs: [] },
        draft: false,
        includeOriginal: replyToId !== null,
        replyToId,
      });
      if (draftId !== undefined) {
        const form = new FormData();
        form.append('messageIds', String(draftId));
        await client.request('DELETE', '/pub/v1/messages', form);
      }
      return { content: [{ type: 'text', text: data ? JSON.stringify(data, null, 2) : 'Message sent successfully.' }] };
    }
    case 'ofw_list_drafts': {
      const { page = 1, size = 50 } = args as { page?: number; size?: number };
      // 13471259 is the system Drafts folder (folderType: DRAFTS)
      const path = `/pub/v3/messages?folders=13471259&page=${page}&size=${size}&sort=date&sortDirection=desc`;
      const data = await client.request('GET', path);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_save_draft': {
      const { subject, body, recipientIds = [], messageId, replyToId = null } = args as {
        subject: string;
        body: string;
        recipientIds?: number[];
        messageId?: number;
        replyToId?: number | null;
      };
      const payload: Record<string, unknown> = {
        subject, body, recipientIds,
        attachments: { myFileIDs: [] },
        draft: true,
        includeOriginal: replyToId !== null,
        replyToId,
      };
      if (messageId !== undefined) payload.messageId = messageId;
      const data = await client.request('POST', '/pub/v3/messages', payload);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_delete_draft': {
      const { messageId } = args as { messageId: number };
      const form = new FormData();
      form.append('messageIds', String(messageId));
      const data = await client.request('DELETE', '/pub/v1/messages', form);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_get_unread_sent': {
      const { page = 1, size = 20 } = args as { page?: number; size?: number };

      // Step 1: find the sent folder
      const foldersData = await client.request<{ data: Array<{ id: string; folderType: string; name: string }> }>(
        'GET', '/pub/v1/messageFolders?includeFolderCounts=true'
      );
      const sentFolder = (foldersData.data ?? []).find((f) => f.folderType === 'SENT_MESSAGES');
      if (!sentFolder) throw new Error('Sent folder not found');

      // Step 2: list sent messages
      const listPath = `/pub/v3/messages?folders=${encodeURIComponent(sentFolder.id)}&page=${page}&size=${size}&sort=date&sortDirection=desc`;
      const listData = await client.request<{ data: Array<{ id: number; subject: string }> }>('GET', listPath);
      const messages = listData.data ?? [];

      // Step 3: fetch each message detail and filter to unread
      const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
      for (const msg of messages) {
        const detail = await client.request<{
          id: number;
          subject: string;
          date: { dateTime: string };
          recipients: Array<{ user: { name: string }; viewed: unknown | null }>;
        }>('GET', `/pub/v3/messages/${msg.id}`);

        const unreadRecipients = (detail.recipients ?? [])
          .filter((r) => !r.viewed)
          .map((r) => r.user.name);

        if (unreadRecipients.length > 0) {
          unread.push({
            id: detail.id,
            subject: detail.subject,
            sentAt: detail.date.dateTime,
            unreadBy: unreadRecipients,
          });
        }
      }

      if (unread.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ message: 'All scanned sent messages have been read.' }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(unread, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
