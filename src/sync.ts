import type { OFWClient } from './client.js';
import {
  setMeta,
  upsertMessage, getMessage, setSyncState,
  upsertDraft, getDraft, deleteDraft, listDraftIds,
  upsertAttachmentForMessage,
  type MessageRow, type DraftRow, type FolderName,
} from './cache.js';
import { mapRecipients, type ApiRecipient } from './tools/_shared.js';

// Each OFW message detail returns `files: [fileId, ...]`. We fetch the metadata
// for each file id (cheap JSON call) so the model can see filenames/mime types
// without downloading bytes. Bytes are pulled lazily by ofw_download_attachment.

interface FileMetaResponse {
  fileId: number;
  label?: string;
  fileName?: string;
  fileType?: string;          // MIME
  fileSize?: number;
  shared?: boolean;
  shareClass?: string;
  lastUpdateDate?: { dateTime?: string };
}

// Fetches OFW attachment metadata for one file id and writes it to the cache.
// Throws on network/HTTP errors — callers in bulk-sync paths wrap this in the
// best-effort helper below; callers that need the result (download tool) let
// the throw propagate.
export async function fetchAttachmentMeta(
  client: OFWClient,
  fileId: number,
  messageId: number,
): Promise<void> {
  const meta = await client.request<FileMetaResponse>('GET', `/pub/v1/myfiles/${fileId}`);
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
  for (const fid of fileIds) {
    // Best-effort: a single bad attachment shouldn't break the surrounding
    // sync. The file id stays in the message's listData; the model can
    // retry later via ofw_download_attachment, which surfaces the real error.
    try { await fetchAttachmentMeta(client, fid, messageId); } catch { /* swallow */ }
  }
}

export interface FolderIds {
  inbox: string;
  sent: string;
  drafts: string;
}

interface FoldersResponse {
  systemFolders?: Array<{ id: string; folderType: string; name: string }>;
  userFolders?: Array<{ id: string; folderType: string; name: string }>;
}

export async function resolveFolderIds(client: OFWClient): Promise<FolderIds> {
  const data = await client.request<FoldersResponse>(
    'GET',
    '/pub/v1/messageFolders?includeFolderCounts=true'
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

interface ListItem {
  id: number;
  subject: string;
  date: { dateTime: string };
  from?: { name?: string };
  showNeverViewed: boolean;
  recipients?: ApiRecipient[];
}

interface ListResponse { data?: ListItem[] }
interface DetailResponse { body?: string; files?: number[] }

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
    const list = await client.request<ListResponse>('GET', path);
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
        const detail = await client.request<DetailResponse>('GET', `/pub/v3/messages/${item.id}`);
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

interface DraftListItem {
  id: number;
  subject: string;
  date: { dateTime: string };
  replyToId: number | null;
  recipients?: ApiRecipient[];
}
interface DraftListResponse { data?: DraftListItem[] }
interface DraftDetailResponse {
  body?: string;
  subject?: string;
  recipientIds?: number[];
}

export interface DraftSyncResult { synced: number }

export async function syncDrafts(client: OFWClient, draftsFolderId: string): Promise<DraftSyncResult> {
  const path = `/pub/v3/messages?folders=${encodeURIComponent(draftsFolderId)}&page=1&size=50&sort=date&sortDirection=desc`;
  const list = await client.request<DraftListResponse>('GET', path);
  const items = list.data ?? [];
  const seenIds = new Set<number>();
  let synced = 0;

  for (const item of items) {
    seenIds.add(item.id);
    const modifiedAt = item.date?.dateTime ?? new Date().toISOString();
    // OFW's list endpoint's `date.dateTime` is NOT a reliable modification
    // timestamp for drafts — direct UI edits don't bump it — so we can't
    // use it to skip the detail fetch. Always re-fetch; drafts are few.
    const existing = getDraft(item.id);
    const detail = await client.request<DraftDetailResponse>('GET', `/pub/v3/messages/${item.id}`);
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
