import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { syncAll, fetchAttachmentMeta, fetchAttachmentMetaForMessage } from '../sync.js';
import {
  listMessages, countMessages, listDrafts, getMessage, upsertMessage,
  upsertDraft, deleteDraft, findLatestReplyTip,
  listAttachmentsForMessage, getAttachment, upsertAttachmentForMessage, markAttachmentDownloaded,
  type MessageRow, type DraftRow,
} from '../cache.js';
import { getAttachmentsDir, getDefaultInlineAttachments } from '../config.js';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { expandPath, jsonResponse, mapRecipients, textResponse } from './_shared.js';

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

// The list endpoint payload (cached as `listData`) reports attachments via
// `files: <count>` (a number) — the actual fileIds only appear on the detail
// endpoint as `files: [number, ...]`. Some intermediate shapes return an
// array on the list too. Treat any of those as "this message has files".
function listDataHintsAtFiles(listData: unknown): boolean {
  if (typeof listData !== 'object' || listData === null) return false;
  const ld = listData as { files?: unknown };
  if (typeof ld.files === 'number') return ld.files > 0;
  if (Array.isArray(ld.files)) return ld.files.length > 0;
  return false;
}

export function registerMessageTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_list_message_folders', {
    description: 'List OurFamilyWizard message folders (inbox, sent, etc.) and their unread counts. Returns folder IDs needed to call ofw_list_messages. Does NOT return message content.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    return jsonResponse(data);
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
      return jsonResponse({
        messages: [],
        note: 'folderId must be "inbox", "sent", or "both". Numeric OFW folder IDs are not supported by the cache.',
      });
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

    return jsonResponse(payload);
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
      let attachments = listAttachmentsForMessage(id);
      // Lazy attachment backfill. The list-endpoint payload (stored in
      // listData) hints at attachments via `files: <count>` but doesn't
      // expose the fileIds — those live only on /pub/v3/messages/{id}.
      // For messages bodied before attachment caching existed, the
      // attachments table is empty even though OFW has files. Re-hit
      // detail to harvest fileIds (idempotent: body is already cached so
      // OFW state isn't changing).
      if (attachments.length === 0 && listDataHintsAtFiles(cached.listData)) {
        try {
          const detail = await client.request<{ files?: number[] }>('GET', `/pub/v3/messages/${id}`);
          if (Array.isArray(detail.files) && detail.files.length > 0) {
            await fetchAttachmentMetaForMessage(client, id, detail.files);
            attachments = listAttachmentsForMessage(id);
          }
        } catch {
          // Backfill is best-effort. Fall through with whatever we have.
        }
      }
      return jsonResponse({ ...cached, attachments });
    }

    const detail = await client.request<{
      id: number; body?: string; subject: string; from?: { name?: string };
      date: { dateTime: string };
      files?: number[];
      recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
    }>('GET', `/pub/v3/messages/${encodeURIComponent(args.messageId)}`);

    const folder: 'inbox' | 'sent' = cached?.folder ?? 'inbox';
    const row: MessageRow = {
      id: detail.id,
      folder,
      subject: detail.subject,
      fromUser: detail.from?.name ?? '',
      sentAt: detail.date?.dateTime ?? new Date().toISOString(),
      recipients: mapRecipients(detail.recipients),
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
    return jsonResponse({ ...row, attachments });
  });

  server.registerTool('ofw_send_message', {
    description: 'Send a message via OurFamilyWizard. If sending from a draft, pass draftId to delete the draft after sending. If replyToId is provided, the cache may rewrite it to the latest reply in the same thread (a note is included in the response when this happens). Attach files by passing their fileIds (from ofw_upload_attachment) in myFileIDs. After sending, the tool re-fetches the message from OFW to populate the local cache and link attachments to the new message id.',
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
    // OFW's POST /pub/v3/messages response is minimal — typically just
    // `{entityId: <id>}` — so the cache write needs to fetch detail
    // afterwards (same shape as ofw_save_draft).
    const data = await client.request<{
      id?: number; entityId?: number;
    } & Record<string, unknown>>('POST', '/pub/v3/messages', {
      subject: args.subject,
      body: args.body,
      recipientIds: args.recipientIds,
      attachments: { myFileIDs },
      draft: false,
      includeOriginal: resolvedReplyTo !== null,
      replyToId: resolvedReplyTo,
    });

    const newId: number | null =
      typeof data?.id === 'number' ? data.id
      : typeof data?.entityId === 'number' ? data.entityId
      : null;

    let persisted: MessageRow | null = null;
    if (newId !== null) {
      const detail = await client.request<{
        id: number; subject?: string; body?: string;
        date?: { dateTime: string }; from?: { name?: string };
        recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
      }>('GET', `/pub/v3/messages/${newId}`);

      persisted = {
        id: newId,
        folder: 'sent',
        subject: detail.subject ?? args.subject,
        fromUser: detail.from?.name ?? '',
        sentAt: detail.date?.dateTime ?? new Date().toISOString(),
        recipients: mapRecipients(detail.recipients),
        body: detail.body ?? args.body,
        fetchedBodyAt: new Date().toISOString(),
        replyToId: resolvedReplyTo,
        chainRootId,
        listData: detail,
      };
      upsertMessage(persisted);
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
          messageId: newId,
        });
      }
    }

    if (args.draftId !== undefined) {
      await deleteOFWMessages(client, [args.draftId]);
      deleteDraft(args.draftId);
    }

    const responseObj = persisted ?? data;
    const text = responseObj ? JSON.stringify(responseObj, null, 2) : 'Message sent successfully.';
    return textResponse(rewriteNote ? `${rewriteNote}\n\n${text}` : text);
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
    return jsonResponse(payload);
  });

  server.registerTool('ofw_save_draft', {
    description: 'Save a message as a draft in OurFamilyWizard. Recipients are optional. To update an existing draft, provide its messageId. If replyToId is provided, the cache may rewrite it to the latest reply in the thread (note included in response). Attach files by passing their fileIds (from ofw_upload_attachment) in myFileIDs. After saving, the tool re-fetches the draft from OFW to populate the local cache and verify what was actually persisted; if OFW silently no-ops an update (a known issue with repeated updates to the same draft), the response includes a WARNING note with a workaround.',
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

    // OFW's POST /pub/v3/messages response for drafts is minimal — typically
    // just `{entityId: <id>}` — and worse, it returns the same success shape
    // even when the server silently no-ops on a subsequent update to the
    // same draft. Don't trust the POST response: extract the id from it,
    // then GET the detail endpoint to repopulate the cache from
    // authoritative server state.
    const data = await client.request<{
      id?: number; entityId?: number;
    } & Record<string, unknown>>('POST', '/pub/v3/messages', payload);

    const newId: number | null =
      typeof data?.id === 'number' ? data.id
      : typeof data?.entityId === 'number' ? data.entityId
      : null;

    let persisted: DraftRow | null = null;
    let noOpWarning: string | null = null;

    if (newId !== null) {
      const detail = await client.request<{
        id: number; subject?: string; body?: string;
        date?: { dateTime: string };
        replyToId?: number | null;
        recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
      }>('GET', `/pub/v3/messages/${newId}`);

      persisted = {
        id: newId,
        subject: detail.subject ?? args.subject,
        body: detail.body ?? '',
        recipients: mapRecipients(detail.recipients),
        replyToId: detail.replyToId ?? resolvedReplyTo,
        modifiedAt: detail.date?.dateTime ?? new Date().toISOString(),
        listData: detail,
      };
      upsertDraft(persisted);

      // If this was an update (messageId provided) and OFW's reported body
      // doesn't match what we asked it to save, the server silently
      // dropped the change. Warn the caller so the model can take the
      // create-then-delete fallback.
      if (args.messageId !== undefined && persisted.body !== args.body) {
        noOpWarning = 'WARNING: OFW reported success but the draft body it returned does not match the requested update. The OFW POST /pub/v3/messages endpoint can silently no-op on subsequent updates to the same draft. Workaround: delete this draft (ofw_delete_draft) and create a new one (ofw_save_draft without messageId).';
      }
    }

    const responseObj = persisted ?? data;
    const text = responseObj ? JSON.stringify(responseObj, null, 2) : 'Draft saved.';
    const notes = [rewriteNote, noOpWarning].filter((n): n is string => n !== null).join('\n\n');
    return textResponse(notes ? `${notes}\n\n${text}` : text);
  });

  server.registerTool('ofw_delete_draft', {
    description: 'Delete a draft message from OurFamilyWizard. Also removes the draft from the local cache.',
    annotations: { destructiveHint: true },
    inputSchema: {
      messageId: z.number().describe('Draft message ID to delete'),
    },
  }, async (args) => {
    const data = await deleteOFWMessages(client, [args.messageId]);
    deleteDraft(args.messageId);
    return data ? jsonResponse(data) : textResponse('Draft deleted.');
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
      return jsonResponse({ note: 'Sent cache is empty. Call ofw_sync_messages to populate.' });
    }

    const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
    for (const msg of sent) {
      const unreadBy = msg.recipients.filter((r) => r.viewedAt === null).map((r) => r.name);
      if (unreadBy.length > 0) {
        unread.push({ id: msg.id, subject: msg.subject, sentAt: msg.sentAt, unreadBy });
      }
    }

    if (unread.length === 0) {
      return jsonResponse({ message: 'All scanned sent messages have been read.' });
    }
    return jsonResponse(unread);
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
    const abs = expandPath(args.path);
    const stat = statSync(abs); // throws if missing
    if (!stat.isFile()) throw new Error(`Not a file: ${abs}`);
    const buf = readFileSync(abs);
    const fileName = basename(abs);
    const mime = mimeFromName(fileName);

    // Build the multipart payload matching the OFW web UI's request shape.
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

    // Cache metadata so subsequent ofw_get_message calls can surface it and
    // ofw_download_attachment can short-circuit. messageId is 0 (the
    // not-yet-linked sentinel) until a message actually references this file.
    upsertAttachmentForMessage({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      label: meta.label ?? args.label ?? fileName,
      mimeType: meta.fileType ?? mime,
      sizeBytes: typeof meta.sizeInBytes === 'number' ? meta.sizeInBytes : buf.length,
      metadata: meta,
      messageId: 0,
    });

    return jsonResponse({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      mimeType: meta.fileType ?? mime,
      sizeBytes: meta.sizeInBytes ?? buf.length,
      shareClass: meta.shareClass ?? args.shareClass ?? 'PRIVATE',
      note: 'Pass this fileId to ofw_send_message or ofw_save_draft in myFileIDs to attach it.',
    });
  });

  server.registerTool('ofw_download_attachment', {
    description: 'Download an OFW message attachment by fileId. By default, bytes are saved to disk (~/Downloads/ofw-mcp/) and the response carries the absolute path, mime type, and size for the caller to read back. Pass inline:true to skip disk entirely and return the bytes as MCP content blocks — images come back as ImageContent (the model sees them directly); other files come back as an EmbeddedResource blob. Use inline for small files where you want the model to read content immediately and the host is sandboxed; use disk for large files or when you want a persistent local copy. The default for `inline` can be flipped server-side via the OFW_INLINE_ATTACHMENTS env var (set to "true" to make inline the default). fileId comes from attachments[].fileId on ofw_get_message. Override disk destination with OFW_ATTACHMENTS_DIR or saveTo. Re-downloading to the same path is a no-op (disk mode only).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      fileId: z.number().describe('Attachment file id (from ofw_get_message → attachments[].fileId)'),
      inline: z.boolean().describe('If true, return bytes inline as MCP content (image for image/*, embedded resource blob otherwise) and skip the disk write. If false, write to disk and return the path. If omitted, falls back to the OFW_INLINE_ATTACHMENTS env var (default: false = disk).').optional(),
      saveTo: z.string().describe('Absolute path or directory to write to. If a directory, the OFW filename is used. Default: ~/Downloads/ofw-mcp/<fileId>-<filename>. Ignored when inline:true.').optional(),
      force: z.boolean().describe('Re-download even if already on disk. Default false. Ignored when inline:true (inline always fetches fresh bytes, or reuses an on-disk copy if present).').optional(),
    },
  }, async (args) => {
    const fileId = args.fileId;
    const inline = args.inline ?? getDefaultInlineAttachments();
    let cached = getAttachment(fileId);
    if (!cached) {
      // Not in cache. Fetch metadata and store under the messageId=0
      // sentinel — gets re-linked if a message later references this file.
      await fetchAttachmentMeta(client, fileId, 0);
      cached = getAttachment(fileId);
      if (!cached) throw new Error(`failed to fetch metadata for fileId ${fileId}`);
    }

    if (inline) {
      // Reuse on-disk bytes if we already have them; otherwise fetch fresh.
      let bytes: Buffer | null = null;
      let mimeType = cached.mimeType;
      let fileName = cached.fileName;
      if (cached.downloadedPath) {
        try { bytes = readFileSync(cached.downloadedPath); } catch { /* on-disk copy missing; fall through */ }
      }
      if (bytes === null) {
        const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
        bytes = response.body;
        mimeType = response.contentType ?? cached.mimeType;
        fileName = response.suggestedFileName ?? cached.fileName;
      }
      const base64 = bytes.toString('base64');
      const metaBlock = { type: 'text' as const, text: JSON.stringify({
        fileId, fileName, mimeType, sizeBytes: bytes.length, mode: 'inline',
      }, null, 2) };
      if (mimeType.startsWith('image/')) {
        return { content: [metaBlock, { type: 'image' as const, data: base64, mimeType }] };
      }
      return { content: [metaBlock, { type: 'resource' as const, resource: {
        uri: `ofw://attachment/${fileId}/${encodeURIComponent(fileName)}`,
        mimeType,
        blob: base64,
      } }] };
    }

    let dest: string;
    if (args.saveTo) {
      // Treat saveTo as a directory if it ends with a separator; otherwise as a full path.
      const isDirArg = args.saveTo.endsWith('/') || args.saveTo.endsWith('\\');
      const abs = expandPath(args.saveTo);
      dest = isDirArg ? join(abs, `${fileId}-${cached.fileName}`) : abs;
    } else {
      dest = join(getAttachmentsDir(), `${fileId}-${cached.fileName}`);
    }

    if (!args.force && cached.downloadedPath === dest) {
      return jsonResponse({
        fileId, path: dest, mimeType: cached.mimeType, sizeBytes: cached.sizeBytes,
        fileName: cached.fileName, note: 'already downloaded',
      });
    }

    const response = await client.requestBinary('GET', `/pub/v1/myfiles/${fileId}/data`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, response.body);
    markAttachmentDownloaded(fileId, dest);

    return jsonResponse({
      fileId,
      path: dest,
      mimeType: response.contentType ?? cached.mimeType,
      sizeBytes: response.body.length,
      fileName: response.suggestedFileName ?? cached.fileName,
    });
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
    return jsonResponse(result);
  });
}

// OFW's bulk-delete endpoint takes a multipart form with `messageIds`.
// Used by both ofw_delete_draft and ofw_send_message (draft cleanup).
async function deleteOFWMessages(client: OFWClient, ids: number[]): Promise<unknown> {
  const form = new FormData();
  for (const id of ids) form.append('messageIds', String(id));
  return client.request('DELETE', '/pub/v1/messages', form);
}
