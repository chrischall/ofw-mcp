import type { OFWClient } from './client.js';
import {
  setMeta,
  upsertMessage, getMessage, deleteMessage, setSyncState,
  upsertDraft, getDraft, deleteDraft, listDraftIds,
  upsertAttachmentForMessage,
  type MessageRow, type DraftRow, type FolderName,
} from './cache.js';
import { z } from 'zod';
import { ApiRecipientSchema, mapRecipients } from './tools/_shared.js';
import { parseOFW } from './validate.js';

// Each OFW message detail returns `files: [fileId, ...]`. We fetch the metadata
// for each file id (cheap JSON call) so the model can see filenames/mime types
// without downloading bytes. Bytes are pulled lazily by ofw_download_attachment.

// All sync-path schemas are validated LENIENT (issue #83): a mismatch logs a
// structured warning to stderr and the raw response flows on through the
// existing `??` fallbacks — a small OFW backend change degrades gracefully
// instead of bricking sync, but no longer silently. Loose objects keep
// unknown keys, so cached `metadata`/`listData` blobs stay verbatim.
const FileMetaSchema = z.looseObject({
  fileId: z.number(),
  label: z.string().optional(),
  fileName: z.string().optional(),
  fileType: z.string().optional(),   // MIME
  fileSize: z.number().optional(),
});

// Fetches OFW attachment metadata for one file id and writes it to the cache.
// Throws on network/HTTP errors — callers in bulk-sync paths wrap this in the
// best-effort helper below; callers that need the result (download tool) let
// the throw propagate.
export async function fetchAttachmentMeta(
  client: OFWClient,
  fileId: number,
  messageId: number,
): Promise<void> {
  const meta = parseOFW(
    FileMetaSchema,
    await client.request('GET', `/pub/v1/myfiles/${fileId}`),
    'GET /pub/v1/myfiles/{fileId}',
  );
  upsertAttachmentForMessage({
    fileId: meta.fileId ?? fileId,
    fileName: meta.fileName ?? `file-${fileId}`,
    label: meta.label ?? meta.fileName ?? `file-${fileId}`,
    mimeType: meta.fileType ?? 'application/octet-stream',
    sizeBytes: typeof meta.fileSize === 'number' ? meta.fileSize : null,
    metadata: meta,
    messageId,
  });
}

export async function fetchAttachmentMetaForMessage(
  client: OFWClient,
  messageId: number,
  fileIds: number[],
): Promise<void> {
  // Fan out in parallel — each fetch is independent and the file id stays
  // in listData on failure (model can retry via ofw_download_attachment,
  // which surfaces the real error). Promise.allSettled so one bad
  // attachment doesn't break the surrounding sync.
  await Promise.allSettled(fileIds.map((fid) => fetchAttachmentMeta(client, fid, messageId)));
}

export interface FolderIds {
  inbox: string;
  sent: string;
  drafts: string;
}

const FoldersSchema = z.looseObject({
  systemFolders: z.array(z.looseObject({ id: z.string(), folderType: z.string() })).optional(),
});

export async function resolveFolderIds(client: OFWClient): Promise<FolderIds> {
  const data = parseOFW(
    FoldersSchema,
    await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true'),
    'GET /pub/v1/messageFolders',
  );
  const sys = data.systemFolders ?? [];
  const find = (type: string): string => {
    const f = sys.find((x) => x.folderType === type);
    if (!f) throw new Error(`OFW system folder not found: ${type}`);
    return f.id;
  };
  const ids: FolderIds = {
    inbox: find('INBOX'),
    sent: find('SENT_MESSAGES'),
    drafts: find('DRAFTS'),
  };
  setMeta('drafts_folder_id', ids.drafts);
  return ids;
}

// Required fields are the ones the sync loop reads unguarded (id keys the
// cache; showNeverViewed drives unread semantics — per CLAUDE.md it's the
// only reliable unread indicator, so its disappearance must warn loudly).
const ListItemSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  date: z.looseObject({ dateTime: z.string() }),
  from: z.looseObject({ name: z.string().optional() }).optional(),
  showNeverViewed: z.boolean(),
  recipients: z.array(ApiRecipientSchema).optional(),
});
type ListItem = z.infer<typeof ListItemSchema>;

const ListResponseSchema = z.looseObject({ data: z.array(ListItemSchema).optional() });
const DetailResponseSchema = z.looseObject({
  body: z.string().optional(),
  files: z.array(z.number()).optional(),
});

export interface UnreadHint {
  id: number;
  subject: string;
  from: string;
  sentAt: string;
}

export interface MessageSyncResult {
  synced: number;
  unread: UnreadHint[];
}

export async function syncMessageFolder(
  client: OFWClient,
  folder: 'inbox' | 'sent',
  folderId: string,
  opts: { fetchUnreadBodies: boolean; deep?: boolean }
): Promise<MessageSyncResult> {
  let page = 1;
  let synced = 0;
  let newestId: number | null = null;
  const unread: UnreadHint[] = [];

  while (true) {
    const path = `/pub/v3/messages?folders=${encodeURIComponent(folderId)}&page=${page}&size=50&sort=date&sortDirection=desc`;
    const list = parseOFW(
      ListResponseSchema,
      await client.request('GET', path),
      `GET /pub/v3/messages?folders={${folder}}`,
    );
    const items = list.data ?? [];
    if (items.length === 0) break;

    let pageHadNewItem = false;
    for (const item of items) {
      if (newestId === null || item.id > newestId) newestId = item.id;
      const existing = getMessage(item.id);
      if (existing) continue;
      pageHadNewItem = true;

      const isInboxUnread = folder === 'inbox' && item.showNeverViewed === true;
      const shouldFetchBody = !isInboxUnread || opts.fetchUnreadBodies;

      let body: string | null = null;
      let fetchedBodyAt: string | null = null;
      let detailFileIds: number[] = [];
      if (shouldFetchBody) {
        const detail = parseOFW(
          DetailResponseSchema,
          await client.request('GET', `/pub/v3/messages/${item.id}`),
          'GET /pub/v3/messages/{id} (sync)',
        );
        body = detail.body ?? '';
        fetchedBodyAt = new Date().toISOString();
        if (Array.isArray(detail.files) && detail.files.length > 0) {
          detailFileIds = detail.files;
        }
      } else {
        unread.push({
          id: item.id,
          subject: item.subject,
          from: item.from?.name ?? '',
          sentAt: item.date.dateTime,
        });
      }

      const row: MessageRow = {
        id: item.id,
        folder,
        subject: item.subject ?? '(no subject)',
        fromUser: item.from?.name ?? '',
        sentAt: item.date?.dateTime ?? new Date().toISOString(),
        recipients: mapRecipients(item.recipients),
        body,
        fetchedBodyAt,
        replyToId: null,
        chainRootId: null,
        listData: item,
      };
      upsertMessage(row);
      synced++;
      if (detailFileIds.length > 0) {
        await fetchAttachmentMetaForMessage(client, item.id, detailFileIds);
      }
    }

    // Stop heuristic: a page with no new items means we've reached cached
    // history (OFW returns date-desc). A page with even ONE new item could
    // mean there are more new items on the next page that we haven't seen
    // yet — keep walking. With `deep: true`, walk every page until OFW
    // returns an empty page (used to backfill suspected gaps).
    if (!opts.deep && !pageHadNewItem) break;
    page++;
  }

  setSyncState(folder, {
    lastSyncAt: new Date().toISOString(),
    newestId,
  });

  return { synced, unread };
}

const DraftListItemSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  date: z.looseObject({ dateTime: z.string() }),
  replyToId: z.number().nullable().optional(),
  recipients: z.array(ApiRecipientSchema).optional(),
});
type DraftListItem = z.infer<typeof DraftListItemSchema>;

const DraftListResponseSchema = z.looseObject({ data: z.array(DraftListItemSchema).optional() });
const DraftDetailSchema = z.looseObject({
  body: z.string().optional(),
  subject: z.string().optional(),
});

export interface DraftSyncResult { synced: number }

export async function syncDrafts(client: OFWClient, draftsFolderId: string): Promise<DraftSyncResult> {
  // Walk every page. The reconciliation loop at the bottom deletes any
  // cached draft that wasn't seen in the listing, so a partial walk would
  // wrongly evict real drafts beyond the first page.
  const items: DraftListItem[] = [];
  let page = 1;
  while (true) {
    const path = `/pub/v3/messages?folders=${encodeURIComponent(draftsFolderId)}&page=${page}&size=50&sort=date&sortDirection=desc`;
    const list = parseOFW(
      DraftListResponseSchema,
      await client.request('GET', path),
      'GET /pub/v3/messages?folders={drafts}',
    );
    const pageItems = list.data ?? [];
    items.push(...pageItems);
    if (pageItems.length < 50) break;
    page++;
  }
  const seenIds = new Set<number>();
  let synced = 0;

  for (const item of items) {
    seenIds.add(item.id);
    const modifiedAt = item.date?.dateTime ?? new Date().toISOString();
    // OFW's list endpoint's `date.dateTime` is NOT a reliable modification
    // timestamp for drafts — direct UI edits don't bump it — so we can't
    // use it to skip the detail fetch. Always re-fetch; drafts are few.
    const existing = getDraft(item.id);
    const detail = parseOFW(
      DraftDetailSchema,
      await client.request('GET', `/pub/v3/messages/${item.id}`),
      'GET /pub/v3/messages/{id} (drafts sync)',
    );
    const row: DraftRow = {
      id: item.id,
      subject: detail.subject ?? item.subject ?? '(no subject)',
      body: detail.body ?? '',
      recipients: mapRecipients(item.recipients),
      replyToId: item.replyToId ?? null,
      modifiedAt,
      listData: item,
    };
    upsertDraft(row);
    // If a stale `messages` row exists for this id (cached by a prior
    // ofw_get_message call before the drafts table knew about this id),
    // evict it. The drafts table is the source of truth for drafts; we
    // don't want ofw_get_message returning a stale messages-table copy.
    if (getMessage(item.id)) deleteMessage(item.id);
    if (!existing
        || existing.body !== row.body
        || existing.subject !== row.subject
        || existing.replyToId !== row.replyToId) {
      synced++;
    }
  }

  for (const id of listDraftIds()) {
    if (!seenIds.has(id)) deleteDraft(id);
  }

  return { synced };
}

export interface SyncAllOptions {
  folders?: FolderName[];
  fetchUnreadBodies?: boolean;
  deep?: boolean;
}

export interface SyncAllResult {
  synced: Partial<Record<FolderName, number>>;
  unreadInbox: UnreadHint[];
  note?: string;
}

export async function syncAll(client: OFWClient, opts: SyncAllOptions): Promise<SyncAllResult> {
  const folders = opts.folders ?? ['inbox', 'sent', 'drafts'];
  const ids = await resolveFolderIds(client);
  const synced: Partial<Record<FolderName, number>> = {};
  let unreadInbox: UnreadHint[] = [];

  for (const folder of folders) {
    if (folder === 'inbox') {
      const r = await syncMessageFolder(client, 'inbox', ids.inbox, {
        fetchUnreadBodies: opts.fetchUnreadBodies ?? false,
        deep: opts.deep ?? false,
      });
      synced.inbox = r.synced;
      unreadInbox = r.unread;
    } else if (folder === 'sent') {
      const r = await syncMessageFolder(client, 'sent', ids.sent, {
        fetchUnreadBodies: false,
        deep: opts.deep ?? false,
      });
      synced.sent = r.synced;
    } else if (folder === 'drafts') {
      const r = await syncDrafts(client, ids.drafts);
      synced.drafts = r.synced;
    }
  }

  const note = unreadInbox.length > 0
    ? `${unreadInbox.length} unread inbox messages cached without bodies. Call ofw_get_message(id) to read them — this will mark them as read on OFW.`
    : undefined;

  return { synced, unreadInbox, ...(note ? { note } : {}) };
}
