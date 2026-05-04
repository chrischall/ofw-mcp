import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { syncAll } from '../sync.js';

export function registerMessageTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_list_message_folders', {
    description: 'List OurFamilyWizard message folders (inbox, sent, etc.) and their unread counts. Returns folder IDs needed to call ofw_list_messages. Does NOT return message content.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_list_messages', {
    description: 'List messages in an OurFamilyWizard folder. Call ofw_list_message_folders first to get folder IDs. Returns actual message content.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      folderId: z.string().describe('Folder ID (get from ofw_list_message_folders)'),
      page: z.number().describe('Page number (default 1)').optional(),
      size: z.number().describe('Messages per page (default 50)').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const path = `/pub/v3/messages?folders=${encodeURIComponent(args.folderId)}&page=${page}&size=${size}&sort=date&sortDirection=desc`;
    const data = await client.request('GET', path);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_get_message', {
    description: 'Get a single OurFamilyWizard message by ID. Note: reading an unread message marks it as read.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      messageId: z.string().describe('Message ID'),
    },
  }, async (args) => {
    const data = await client.request('GET', `/pub/v3/messages/${encodeURIComponent(args.messageId)}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_send_message', {
    description: 'Send a message via OurFamilyWizard. If sending from a draft, pass draftId to automatically delete the draft after sending.',
    annotations: { destructiveHint: true },
    inputSchema: {
      subject: z.string().describe('Message subject'),
      body: z.string().describe('Message body text'),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (get from ofw_get_profile)'),
      replyToId: z.number().describe('ID of the message being replied to. When provided, the original message thread is included (like a standard email reply).').optional(),
      draftId: z.number().describe('ID of the draft to delete after sending (omit if not sending from a draft)').optional(),
    },
  }, async (args) => {
    const replyToId = args.replyToId ?? null;
    const data = await client.request('POST', '/pub/v3/messages', {
      subject: args.subject,
      body: args.body,
      recipientIds: args.recipientIds,
      attachments: { myFileIDs: [] },
      draft: false,
      includeOriginal: replyToId !== null,
      replyToId,
    });
    if (args.draftId !== undefined) {
      const form = new FormData();
      form.append('messageIds', String(args.draftId));
      await client.request('DELETE', '/pub/v1/messages', form);
    }
    return { content: [{ type: 'text' as const, text: data ? JSON.stringify(data, null, 2) : 'Message sent successfully.' }] };
  });

  server.registerTool('ofw_list_drafts', {
    description: 'List all draft messages in OurFamilyWizard',
    annotations: { readOnlyHint: true },
    inputSchema: {
      page: z.number().describe('Page number (default 1)').optional(),
      size: z.number().describe('Drafts per page (default 50)').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    // 13471259 is the system Drafts folder (folderType: DRAFTS)
    const path = `/pub/v3/messages?folders=13471259&page=${page}&size=${size}&sort=date&sortDirection=desc`;
    const data = await client.request('GET', path);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_save_draft', {
    description: 'Save a message as a draft in OurFamilyWizard. Recipients are optional — a draft can be saved without them. To update an existing draft, provide its messageId.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      subject: z.string().describe('Message subject'),
      body: z.string().describe('Message body text'),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (optional for drafts)').optional(),
      messageId: z.number().describe('ID of an existing draft to update (omit to create a new draft)').optional(),
      replyToId: z.number().describe('ID of the message this draft is replying to (omit for new messages)').optional(),
    },
  }, async (args) => {
    const replyToId = args.replyToId ?? null;
    const payload: Record<string, unknown> = {
      subject: args.subject,
      body: args.body,
      recipientIds: args.recipientIds ?? [],
      attachments: { myFileIDs: [] },
      draft: true,
      includeOriginal: replyToId !== null,
      replyToId,
    };
    if (args.messageId !== undefined) payload.messageId = args.messageId;
    const data = await client.request('POST', '/pub/v3/messages', payload);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_delete_draft', {
    description: 'Delete a draft message from OurFamilyWizard',
    annotations: { destructiveHint: true },
    inputSchema: {
      messageId: z.number().describe('Draft message ID to delete'),
    },
  }, async (args) => {
    const form = new FormData();
    form.append('messageIds', String(args.messageId));
    const data = await client.request('DELETE', '/pub/v1/messages', form);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_get_unread_sent', {
    description: 'List sent messages that have not been read by one or more recipients. Fetches sent messages page by page and returns only those with unread recipients.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      page: z.number().describe('Page of sent messages to scan (default 1)').optional(),
      size: z.number().describe('Number of sent messages per page, max 50 (default 20)').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 20;

    // Step 1: find the sent folder
    const foldersData = await client.request<{ systemFolders: Array<{ id: string; folderType: string; name: string }>; userFolders: Array<{ id: string; folderType: string; name: string }> }>(
      'GET', '/pub/v1/messageFolders?includeFolderCounts=true'
    );
    const sentFolder = (foldersData.systemFolders ?? []).find((f) => f.folderType === 'SENT_MESSAGES');
    if (!sentFolder) throw new Error('Sent folder not found');

    // Step 2: list sent messages (the list endpoint already includes per-recipient viewed status)
    const listPath = `/pub/v3/messages?folders=${encodeURIComponent(sentFolder.id)}&page=${page}&size=${size}&sort=date&sortDirection=desc`;
    const listData = await client.request<{ data: Array<{
      id: number;
      subject: string;
      date: { dateTime: string };
      showNeverViewed: boolean;
      recipients: Array<{ user: { name: string }; viewed?: { dateTime: string } }>;
    }> }>('GET', listPath);
    const messages = listData.data ?? [];

    // Step 3: filter to unread using showNeverViewed (avoids N+1 detail fetches
    // and the detail endpoint's inconsistent viewed field which can return null
    // for read messages instead of the epoch sentinel the list endpoint uses)
    const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
    for (const msg of messages) {
      if (!msg.showNeverViewed) continue;

      const unreadRecipients = (msg.recipients ?? [])
        .filter((r) => !r.viewed)
        .map((r) => r.user.name);

      if (unreadRecipients.length > 0) {
        unread.push({
          id: msg.id,
          subject: msg.subject,
          sentAt: msg.date.dateTime,
          unreadBy: unreadRecipients,
        });
      }
    }

    if (unread.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'All scanned sent messages have been read.' }, null, 2) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(unread, null, 2) }] };
  });

  server.registerTool('ofw_sync_messages', {
    description: 'Sync messages from OurFamilyWizard into the local cache. Returns counts per folder and a list of unread inbox messages whose bodies were NOT fetched (to avoid mark-as-read on OFW). Call ofw_get_message(id) on those to read them.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      folders: z.array(z.enum(['inbox', 'sent', 'drafts'])).describe('Folders to sync (default: all three)').optional(),
      fetchUnreadBodies: z.boolean().describe('If true, also fetch bodies for unread inbox messages (will mark them as read on OFW). Default false.').optional(),
    },
  }, async (args) => {
    const result = await syncAll(client, {
      folders: args.folders,
      fetchUnreadBodies: args.fetchUnreadBodies,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
