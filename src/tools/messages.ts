import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { syncAll, fetchAttachmentMetaForMessage } from '../sync.js';
import {
  listMessages, countMessages, listDrafts, getMessage, upsertMessage,
  upsertDraft, deleteDraft, findLatestReplyTip,
  listAttachmentsForMessage, getAttachment, upsertAttachmentForMessage, markAttachmentDownloaded,
  type MessageRow, type DraftRow, type Recipient,
} from '../cache.js';
import { getAttachmentsDir } from '../config.js';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, isAbsolute, resolve } from 'node:path';

// Lightweight mime sniff from extension. OFW re-derives mime from the filename
// server-side anyway, so this is just a polite Content-Type for the Blob.
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.ics': 'text/calendar',
};
function mimeFromName(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function registerMessageTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_list_message_folders', {
    description: 'List OurFamilyWizard message folders (inbox, sent, etc.) and their unread counts. Returns folder IDs needed to call ofw_list_messages. Does NOT return message content.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_list_messages', {
    description: 'List messages from the local OurFamilyWizard cache. Supports filtering by folder, date range, and a substring query on subject+body. Pagination is offset-based but if you know what you want (a date range, a topic), prefer the filters over walking pages — the cache may have 1000+ messages. Call ofw_sync_messages first if the cache is empty or stale.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      folderId: z.string().describe('Folder name: "inbox", "sent", or "both" (default "both")').optional(),
      page: z.number().describe('Page number (default 1)').optional(),
      size: z.number().describe('Messages per page (default 50)').optional(),
      since: z.string().describe('ISO date or datetime — only messages with sent_at >= since (inclusive)').optional(),
      until: z.string().describe('ISO date or datetime — only messages with sent_at < until (exclusive)').optional(),
      q: z.string().describe('Substring match on subject AND body (case-insensitive). Use to find messages on a specific topic.').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const folderArg = args.folderId ?? 'both';

    let folder: 'inbox' | 'sent' | undefined;
    if (folderArg === 'inbox') folder = 'inbox';
    else if (folderArg === 'sent') folder = 'sent';
    else if (folderArg === 'both') folder = undefined;
    else {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            messages: [],
            note: 'folderId must be "inbox", "sent", or "both". Numeric OFW folder IDs are not supported by the cache.',
          }, null, 2),
        }],
      };
    }

    const filter = { folder, since: args.since, until: args.until, q: args.q };
    const total = countMessages(filter);
    const messages = listMessages({ ...filter, page, size });

    const payload: Record<string, unknown> = { messages, total, page, size };
    if (total === 0) {
      payload.note = 'No messages match these filters. If you expected results, check ofw_sync_messages was run, or relax the filters.';
    } else if (page * size < total) {
      payload.note = `Showing ${(page - 1) * size + 1}–${(page - 1) * size + messages.length} of ${total}. Increase 'page' to see more, or narrow with since/until/q.`;
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
  });

  server.registerTool('ofw_get_message', {
    description: 'Get a single OurFamilyWizard message by ID. Reads from local cache when available; otherwise fetches from OFW (which will mark unread inbox messages as read on OFW).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      messageId: z.string().describe('Message ID'),
    },
  }, async (args) => {
    const id = Number(args.messageId);
    const cached = getMessage(id);
    if (cached && cached.body !== null) {
      const attachments = listAttachmentsForMessage(id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...cached, attachments }, null, 2) }] };
    }

    const detail = await client.request<{
      id: number; body?: string; subject: string; from?: { name?: string };
      date: { dateTime: string };
      files?: number[];
      recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
    }>('GET', `/pub/v3/messages/${encodeURIComponent(args.messageId)}`);

    const recipients: Recipient[] = (detail.recipients ?? []).map((r) => ({
      userId: r.user.id, name: r.user.name, viewedAt: r.viewed?.dateTime ?? null,
    }));

    const folder: 'inbox' | 'sent' = cached?.folder ?? 'inbox';
    const row: MessageRow = {
      id: detail.id,
      folder,
      subject: detail.subject,
      fromUser: detail.from?.name ?? '',
      sentAt: detail.date?.dateTime ?? new Date().toISOString(),
      recipients,
      body: detail.body ?? '',
      fetchedBodyAt: new Date().toISOString(),
      replyToId: cached?.replyToId ?? null,
      chainRootId: cached?.chainRootId ?? null,
      listData: cached?.listData ?? detail,
    };
    upsertMessage(row);
    if (Array.isArray(detail.files) && detail.files.length > 0) {
      await fetchAttachmentMetaForMessage(client, detail.id, detail.files);
    }
    const attachments = listAttachmentsForMessage(detail.id);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...row, attachments }, null, 2) }] };
  });

  server.registerTool('ofw_send_message', {
    description: 'Send a message via OurFamilyWizard. If sending from a draft, pass draftId to delete the draft after sending. If replyToId is provided, the cache may rewrite it to the latest reply in the same thread (a note is included in the response when this happens). Attach files by passing their fileIds (from ofw_upload_attachment) in myFileIDs.',
    annotations: { destructiveHint: true },
    inputSchema: {
      subject: z.string().describe('Message subject'),
      body: z.string().describe('Message body text'),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (get from ofw_get_profile)'),
      replyToId: z.number().describe('ID of the message being replied to').optional(),
      draftId: z.number().describe('ID of the draft to delete after sending (omit if not sending from a draft)').optional(),
      myFileIDs: z.array(z.number()).describe('Attachment file ids (from ofw_upload_attachment) to attach to the message').optional(),
    },
  }, async (args) => {
    const requestedReplyTo = args.replyToId ?? null;
    let resolvedReplyTo = requestedReplyTo;
    let chainRootId: number | null = null;
    let rewriteNote: string | null = null;

    if (requestedReplyTo !== null) {
      resolvedReplyTo = findLatestReplyTip(requestedReplyTo);
      if (resolvedReplyTo !== requestedReplyTo) {
        rewriteNote = `replyToId rewritten from ${requestedReplyTo} to ${resolvedReplyTo} (later reply in same thread found in sent cache).`;
      }
      const parent = getMessage(resolvedReplyTo);
      chainRootId = parent?.chainRootId ?? parent?.id ?? requestedReplyTo;
    }

    const myFileIDs = args.myFileIDs ?? [];
    const data = await client.request<{
      id?: number; subject?: string; body?: string;
      date?: { dateTime: string }; from?: { name?: string };
      recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
    }>('POST', '/pub/v3/messages', {
      subject: args.subject,
      body: args.body,
      recipientIds: args.recipientIds,
      attachments: { myFileIDs },
      draft: false,
      includeOriginal: resolvedReplyTo !== null,
      replyToId: resolvedReplyTo,
    });

    if (data && typeof data.id === 'number') {
      const recipients: Recipient[] = (data.recipients ?? []).map((r) => ({
        userId: r.user.id, name: r.user.name, viewedAt: r.viewed?.dateTime ?? null,
      }));
      const row: MessageRow = {
        id: data.id,
        folder: 'sent',
        subject: data.subject ?? args.subject,
        fromUser: data.from?.name ?? '',
        sentAt: data.date?.dateTime ?? new Date().toISOString(),
        recipients,
        body: data.body ?? args.body,
        fetchedBodyAt: new Date().toISOString(),
        replyToId: resolvedReplyTo,
        chainRootId,
        listData: data,
      };
      upsertMessage(row);
      // Link attached files to the new message in the attachments cache.
      // We may not have full metadata if the upload happened in a prior
      // session — fall back to what we know.
      for (const fileId of myFileIDs) {
        const existing = getAttachment(fileId);
        upsertAttachmentForMessage({
          fileId,
          fileName: existing?.fileName ?? `file-${fileId}`,
          label: existing?.label ?? existing?.fileName ?? `file-${fileId}`,
          mimeType: existing?.mimeType ?? 'application/octet-stream',
          sizeBytes: existing?.sizeBytes ?? null,
          metadata: existing?.metadata ?? {},
          messageId: data.id,
        });
      }
    }

    if (args.draftId !== undefined) {
      const form = new FormData();
      form.append('messageIds', String(args.draftId));
      await client.request('DELETE', '/pub/v1/messages', form);
      deleteDraft(args.draftId);
    }

    const text = data ? JSON.stringify(data, null, 2) : 'Message sent successfully.';
    const finalText = rewriteNote ? `${rewriteNote}\n\n${text}` : text;
    return { content: [{ type: 'text' as const, text: finalText }] };
  });

  server.registerTool('ofw_list_drafts', {
    description: 'List draft messages from the local OurFamilyWizard cache. Call ofw_sync_messages first if the cache is empty.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      page: z.number().describe('Page number (default 1)').optional(),
      size: z.number().describe('Drafts per page (default 50)').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const drafts = listDrafts({ page, size });
    const payload = drafts.length === 0
      ? { drafts: [], note: 'Cache empty. Call ofw_sync_messages to populate.' }
      : { drafts };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
  });

  server.registerTool('ofw_save_draft', {
    description: 'Save a message as a draft in OurFamilyWizard. Recipients are optional. To update an existing draft, provide its messageId. If replyToId is provided, the cache may rewrite it to the latest reply in the thread (note included in response). Attach files by passing their fileIds (from ofw_upload_attachment) in myFileIDs.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      subject: z.string().describe('Message subject'),
      body: z.string().describe('Message body text'),
      recipientIds: z.array(z.number()).describe('Array of recipient user IDs (optional for drafts)').optional(),
      messageId: z.number().describe('ID of an existing draft to update (omit to create a new draft)').optional(),
      replyToId: z.number().describe('ID of the message this draft replies to').optional(),
      myFileIDs: z.array(z.number()).describe('Attachment file ids (from ofw_upload_attachment)').optional(),
    },
  }, async (args) => {
    const requestedReplyTo = args.replyToId ?? null;
    let resolvedReplyTo = requestedReplyTo;
    let rewriteNote: string | null = null;

    if (requestedReplyTo !== null) {
      resolvedReplyTo = findLatestReplyTip(requestedReplyTo);
      if (resolvedReplyTo !== requestedReplyTo) {
        rewriteNote = `replyToId rewritten from ${requestedReplyTo} to ${resolvedReplyTo} (later reply in same thread found in sent cache).`;
      }
    }

    const myFileIDs = args.myFileIDs ?? [];
    const payload: Record<string, unknown> = {
      subject: args.subject,
      body: args.body,
      recipientIds: args.recipientIds ?? [],
      attachments: { myFileIDs },
      draft: true,
      includeOriginal: resolvedReplyTo !== null,
      replyToId: resolvedReplyTo,
    };
    if (args.messageId !== undefined) payload.messageId = args.messageId;

    const data = await client.request<{
      id?: number; subject?: string; body?: string;
      date?: { dateTime: string };
      replyToId?: number | null;
      recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
    }>('POST', '/pub/v3/messages', payload);

    if (data && typeof data.id === 'number') {
      const draft: DraftRow = {
        id: data.id,
        subject: data.subject ?? args.subject,
        body: data.body ?? args.body,
        recipients: (data.recipients ?? []).map((r) => ({
          userId: r.user.id, name: r.user.name, viewedAt: r.viewed?.dateTime ?? null,
        })),
        replyToId: data.replyToId ?? resolvedReplyTo,
        modifiedAt: data.date?.dateTime ?? new Date().toISOString(),
        listData: data,
      };
      upsertDraft(draft);
    }

    const text = data ? JSON.stringify(data, null, 2) : 'Draft saved.';
    const finalText = rewriteNote ? `${rewriteNote}\n\n${text}` : text;
    return { content: [{ type: 'text' as const, text: finalText }] };
  });

  server.registerTool('ofw_delete_draft', {
    description: 'Delete a draft message from OurFamilyWizard. Also removes the draft from the local cache.',
    annotations: { destructiveHint: true },
    inputSchema: {
      messageId: z.number().describe('Draft message ID to delete'),
    },
  }, async (args) => {
    const form = new FormData();
    form.append('messageIds', String(args.messageId));
    const data = await client.request('DELETE', '/pub/v1/messages', form);
    deleteDraft(args.messageId);
    return { content: [{ type: 'text' as const, text: data ? JSON.stringify(data, null, 2) : 'Draft deleted.' }] };
  });

  server.registerTool('ofw_get_unread_sent', {
    description: 'List sent messages that have not been read by one or more recipients. Reads from local cache; call ofw_sync_messages first if cache is stale.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      page: z.number().describe('Page (default 1)').optional(),
      size: z.number().describe('Per page (default 50)').optional(),
    },
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 50;
    const sent = listMessages({ folder: 'sent', page, size });

    if (sent.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        note: 'Sent cache is empty. Call ofw_sync_messages to populate.',
      }, null, 2) }] };
    }

    const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
    for (const msg of sent) {
      const unreadBy = msg.recipients.filter((r) => r.viewedAt === null).map((r) => r.name);
      if (unreadBy.length > 0) {
        unread.push({ id: msg.id, subject: msg.subject, sentAt: msg.sentAt, unreadBy });
      }
    }

    if (unread.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        message: 'All scanned sent messages have been read.',
      }, null, 2) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(unread, null, 2) }] };
  });

  server.registerTool('ofw_upload_attachment', {
    description: 'Upload a local file to OurFamilyWizard\'s "My Files" so it can be attached to a message. Returns the fileId — pass that to ofw_send_message or ofw_save_draft in myFileIDs to attach it. The file is uploaded as PRIVATE (visible only to you) by default; pass shareClass:"SHARED" to share with co-parents directly via the My Files area.',
    annotations: { destructiveHint: false },
    inputSchema: {
      path: z.string().describe('Absolute path to the local file to upload. Tilde (~) is expanded.'),
      shareClass: z.enum(['PRIVATE', 'SHARED']).describe('Share class (default PRIVATE)').optional(),
      label: z.string().describe('Display label for the file in OFW (default: filename)').optional(),
      description: z.string().describe('Description shown in OFW My Files (default: filename)').optional(),
    },
  }, async (args) => {
    // Resolve and read the local file
    const expanded = args.path.startsWith('~/')
      ? join(process.env.HOME ?? '', args.path.slice(2))
      : args.path;
    const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
    const stat = statSync(abs); // throws if missing
    if (!stat.isFile()) throw new Error(`Not a file: ${abs}`);
    const buf = readFileSync(abs);
    const fileName = basename(abs);
    const mime = mimeFromName(fileName);

    // Build the multipart payload matching the OFW web UI's request shape
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), fileName);
    form.append('source', 'message');
    form.append('description', args.description ?? fileName);
    form.append('label', args.label ?? fileName);
    form.append('fileName', fileName);
    form.append('shareClass', args.shareClass ?? 'PRIVATE');

    const meta = await client.request<{
      fileId: number; fileName?: string; label?: string;
      fileType?: string; sizeInBytes?: number; shareClass?: string;
    }>('POST', '/pub/v3/myfiles/multipart', form);

    // Cache the metadata so subsequent ofw_get_message calls can surface it
    // and ofw_download_attachment short-circuits if asked. messageId is 0
    // because no message references this yet — it'll be linked once a
    // message is sent with this fileId in its attachments.
    upsertAttachmentForMessage({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      label: meta.label ?? args.label ?? fileName,
      mimeType: meta.fileType ?? mime,
      sizeBytes: typeof meta.sizeInBytes === 'number' ? meta.sizeInBytes : buf.length,
      metadata: meta,
      messageId: 0,
    });

    return { content: [{ type: 'text' as const, text: JSON.stringify({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      mimeType: meta.fileType ?? mime,
      sizeBytes: meta.sizeInBytes ?? buf.length,
      shareClass: meta.shareClass ?? args.shareClass ?? 'PRIVATE',
      note: 'Pass this fileId to ofw_send_message or ofw_save_draft in myFileIDs to attach it.',
    }, null, 2) }] };
  });

  server.registerTool('ofw_download_attachment', {
    description: 'Download an OFW message attachment by fileId. Bytes are saved to disk; the tool returns the absolute path, mime type, and size so the caller can then read/analyze the file. fileId comes from the attachments array on ofw_get_message. Saves under ~/.cache/ofw-mcp/attachments/<hash>/ by default (override via OFW_ATTACHMENTS_DIR or the saveTo argument). Re-downloading is a no-op if the file is already on disk.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      fileId: z.number().describe('Attachment file id (from ofw_get_message → attachments[].fileId)'),
      saveTo: z.string().describe('Absolute path or directory to write to. If a directory, the OFW filename is used. Default: ~/.cache/ofw-mcp/attachments/<hash>/<fileId>-<filename>').optional(),
      force: z.boolean().describe('Re-download even if already on disk. Default false.').optional(),
    },
  }, async (args) => {
    const fileId = args.fileId;
    let cached = getAttachment(fileId);
    if (!cached) {
      // Metadata not in cache — fetch on the fly.
      const meta = await client.request<{
        fileId: number; label?: string; fileName?: string; fileType?: string; fileSize?: number;
      }>('GET', `/pub/v1/myfiles/${fileId}`);
      // Store with a sentinel "metadata-only, no message link" — we don't know which message asked.
      // We'll re-link if a message later references it during sync.
      upsertAttachmentForMessage({
        fileId: meta.fileId ?? fileId,
        fileName: meta.fileName ?? `file-${fileId}`,
        label: meta.label ?? meta.fileName ?? `file-${fileId}`,
        mimeType: meta.fileType ?? 'application/octet-stream',
        sizeBytes: typeof meta.fileSize === 'number' ? meta.fileSize : null,
        metadata: meta,
        messageId: 0, // placeholder; will be cleaned up if a real message references it
      });
      cached = getAttachment(fileId);
      if (!cached) throw new Error(`failed to fetch metadata for fileId ${fileId}`);
    }

    // Decide destination path
    let dest: string;
    if (args.saveTo) {
      const expanded = args.saveTo.startsWith('~/')
        ? join(process.env.HOME ?? '', args.saveTo.slice(2))
        : args.saveTo;
      const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
      // If it looks like a directory (ends with /) OR is an existing directory, treat as dir.
      const isDirArg = expanded.endsWith('/') || expanded.endsWith('\\');
      dest = isDirArg ? join(abs, `${fileId}-${cached.fileName}`) : abs;
    } else {
      dest = join(getAttachmentsDir(), `${fileId}-${cached.fileName}`);
    }

    // Short-circuit if already downloaded to this path
    if (!args.force && cached.downloadedPath === dest) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        fileId, path: dest, mimeType: cached.mimeType, sizeBytes: cached.sizeBytes,
        fileName: cached.fileName, note: 'already downloaded',
      }, null, 2) }] };
    }

    // Fetch bytes
    const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, response.body);
    markAttachmentDownloaded(fileId, dest);

    return { content: [{ type: 'text' as const, text: JSON.stringify({
      fileId,
      path: dest,
      mimeType: response.contentType ?? cached.mimeType,
      sizeBytes: response.body.length,
      fileName: response.suggestedFileName ?? cached.fileName,
    }, null, 2) }] };
  });

  server.registerTool('ofw_sync_messages', {
    description: 'Sync messages from OurFamilyWizard into the local cache. Returns counts per folder and a list of unread inbox messages whose bodies were NOT fetched (to avoid mark-as-read on OFW). Call ofw_get_message(id) on those to read them. Pass deep:true to walk all OFW pages instead of stopping at the first all-cached page (use to backfill suspected gaps).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      folders: z.array(z.enum(['inbox', 'sent', 'drafts'])).describe('Folders to sync (default: all three)').optional(),
      fetchUnreadBodies: z.boolean().describe('If true, also fetch bodies for unread inbox messages (will mark them as read on OFW). Default false.').optional(),
      deep: z.boolean().describe('If true, walk every OFW page until empty regardless of cache state. Use to backfill gaps. Default false.').optional(),
    },
  }, async (args) => {
    const result = await syncAll(client, {
      folders: args.folders,
      fetchUnreadBodies: args.fetchUnreadBodies,
      deep: args.deep,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
