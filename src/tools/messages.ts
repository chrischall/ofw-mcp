import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_list_message_folders',
    description: 'List OurFamilyWizard message folders (inbox, sent, etc.) and their unread counts. Returns folder IDs needed to call ofw_list_messages. Does NOT return message content.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ofw_list_messages',
    description: 'List messages in an OurFamilyWizard folder. Call ofw_list_message_folders first to get folder IDs. Returns actual message content.',
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
    description: 'Get a single OurFamilyWizard message by ID',
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
    description: 'Send a message via OurFamilyWizard',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Message subject' },
        body: { type: 'string', description: 'Message body text' },
        recipients: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of recipient contact IDs (get from ofw_get_profile)',
        },
      },
      required: ['subject', 'body', 'recipients'],
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
      const { subject, body, recipients } = args as {
        subject: string;
        body: string;
        recipients: number[];
      };
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v3/messages', { subject, body, recipients });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
