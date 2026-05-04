import type { OFWClient } from './client.js';
import {
  setMeta,
  upsertMessage, getMessage, setSyncState,
  upsertDraft, getDraft, deleteDraft, listDraftIds,
  type MessageRow, type Recipient, type DraftRow, type FolderName,
} from './cache.js';

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
  recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
}

interface ListResponse { data?: ListItem[] }
interface DetailResponse { body?: string }

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

function recipientsFromList(item: ListItem): Recipient[] {
  return (item.recipients ?? []).map((r) => ({
    userId: r.user.id,
    name: r.user.name,
    viewedAt: r.viewed?.dateTime ?? null,
  }));
}

export async function syncMessageFolder(
  client: OFWClient,
  folder: 'inbox' | 'sent',
  folderId: string,
  opts: { fetchUnreadBodies: boolean }
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

    let pageSawKnownItem = false;
    for (const item of items) {
      if (newestId === null || item.id > newestId) newestId = item.id;
      const existing = getMessage(item.id);
      if (existing) {
        pageSawKnownItem = true;
        continue;
      }

      const isInboxUnread = folder === 'inbox' && item.showNeverViewed === true;
      const shouldFetchBody = !isInboxUnread || opts.fetchUnreadBodies;

      let body: string | null = null;
      let fetchedBodyAt: string | null = null;
      if (shouldFetchBody) {
        const detail = await client.request<DetailResponse>('GET', `/pub/v3/messages/${item.id}`);
        body = detail.body ?? '';
        fetchedBodyAt = new Date().toISOString();
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
        subject: item.subject,
        fromUser: item.from?.name ?? '',
        sentAt: item.date.dateTime,
        recipients: recipientsFromList(item),
        body,
        fetchedBodyAt,
        replyToId: null,
        chainRootId: null,
        listData: item,
      };
      upsertMessage(row);
      synced++;
    }

    // OFW returns date-desc, so a known item means we've reached cached history.
    if (pageSawKnownItem) break;
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
  recipients?: Array<{ user: { id: number; name: string }; viewed?: { dateTime: string } | null }>;
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
    const existing = getDraft(item.id);
    if (existing && existing.modifiedAt === item.date.dateTime) {
      continue;
    }
    const detail = await client.request<DraftDetailResponse>('GET', `/pub/v3/messages/${item.id}`);
    const row: DraftRow = {
      id: item.id,
      subject: detail.subject ?? item.subject,
      body: detail.body ?? '',
      recipients: (item.recipients ?? []).map((r) => ({
        userId: r.user.id, name: r.user.name, viewedAt: r.viewed?.dateTime ?? null,
      })),
      replyToId: item.replyToId,
      modifiedAt: item.date.dateTime,
      listData: item,
    };
    upsertDraft(row);
    synced++;
  }

  for (const id of listDraftIds()) {
    if (!seenIds.has(id)) deleteDraft(id);
  }

  return { synced };
}

export interface SyncAllOptions {
  folders?: FolderName[];
  fetchUnreadBodies?: boolean;
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
      });
      synced.inbox = r.synced;
      unreadInbox = r.unread;
    } else if (folder === 'sent') {
      const r = await syncMessageFolder(client, 'sent', ids.sent, { fetchUnreadBodies: false });
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
