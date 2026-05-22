import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCacheDbPath } from './config.js';

export interface Cache {
  db: DatabaseSync;
}

let instance: Cache | null = null;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  folder TEXT NOT NULL,
  subject TEXT NOT NULL,
  from_user TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  body TEXT,
  fetched_body_at TEXT,
  reply_to_id INTEGER,
  chain_root_id INTEGER,
  list_data_json TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_folder_sent_at ON messages(folder, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chain_root ON messages(chain_root_id);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  reply_to_id INTEGER,
  modified_at TEXT NOT NULL,
  list_data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  folder TEXT PRIMARY KEY,
  last_sync_at TEXT NOT NULL,
  newest_id INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// v2: add attachments table. Idempotent — IF NOT EXISTS.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS attachments (
  file_id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  label TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER,
  metadata_json TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,  -- JSON array of message ids that reference this file
  downloaded_path TEXT,             -- absolute path on disk if/when downloaded
  downloaded_at TEXT,
  fetched_metadata_at TEXT NOT NULL
);
`;

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_V1);
  db.exec(SCHEMA_V2);
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run('schema_version', '2');
}

export function openCache(): Cache {
  if (instance) return instance;
  const path = getCacheDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  instance = { db };
  return instance;
}

export function closeCache(): void {
  if (instance) {
    instance.db.close();
    instance = null;
  }
}

export interface Recipient {
  userId: number;
  name: string;
  viewedAt: string | null;
}

export interface MessageRow {
  id: number;
  folder: 'inbox' | 'sent';
  subject: string;
  fromUser: string;
  sentAt: string;
  recipients: Recipient[];
  body: string | null;
  fetchedBodyAt: string | null;
  replyToId: number | null;
  chainRootId: number | null;
  listData: unknown;
}

interface MessageDbRow {
  id: number;
  folder: string;
  subject: string;
  from_user: string;
  sent_at: string;
  recipients_json: string;
  body: string | null;
  fetched_body_at: string | null;
  reply_to_id: number | null;
  chain_root_id: number | null;
  list_data_json: string;
  last_seen_at: string;
}

function rowFromDb(r: MessageDbRow): MessageRow {
  return {
    id: r.id,
    folder: r.folder as 'inbox' | 'sent',
    subject: r.subject,
    fromUser: r.from_user,
    sentAt: r.sent_at,
    recipients: JSON.parse(r.recipients_json) as Recipient[],
    body: r.body,
    fetchedBodyAt: r.fetched_body_at,
    replyToId: r.reply_to_id,
    chainRootId: r.chain_root_id,
    listData: JSON.parse(r.list_data_json),
  };
}

// node:sqlite rejects `undefined` as a bound parameter ("Provided value cannot
// be bound"). Normalize undefined to null for nullable columns so callers
// don't have to remember; throw with a useful error for NOT NULL fields that
// somehow arrived as undefined.
function nullish<T>(v: T | undefined | null): T | null {
  return v === undefined ? null : v;
}

function requireString(field: string, v: string | undefined | null): string {
  if (typeof v === 'string') return v;
  throw new Error(`cache: ${field} is required (got ${v === undefined ? 'undefined' : 'null'})`);
}

export function upsertMessage(row: MessageRow): void {
  const { db } = openCache();
  db.prepare(
    `INSERT INTO messages (
       id, folder, subject, from_user, sent_at, recipients_json,
       body, fetched_body_at, reply_to_id, chain_root_id, list_data_json, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       folder=excluded.folder,
       subject=excluded.subject,
       from_user=excluded.from_user,
       sent_at=excluded.sent_at,
       recipients_json=excluded.recipients_json,
       body=excluded.body,
       fetched_body_at=excluded.fetched_body_at,
       reply_to_id=excluded.reply_to_id,
       chain_root_id=excluded.chain_root_id,
       list_data_json=excluded.list_data_json,
       last_seen_at=excluded.last_seen_at`
  ).run(
    row.id,
    requireString('messages.folder', row.folder),
    requireString('messages.subject', row.subject),
    requireString('messages.fromUser', row.fromUser),
    requireString('messages.sentAt', row.sentAt),
    JSON.stringify(row.recipients ?? []),
    nullish(row.body),
    nullish(row.fetchedBodyAt),
    nullish(row.replyToId),
    nullish(row.chainRootId),
    JSON.stringify(row.listData ?? null),
    new Date().toISOString()
  );
}

export function getMessage(id: number): MessageRow | null {
  const { db } = openCache();
  const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageDbRow | undefined;
  return r ? rowFromDb(r) : null;
}

/**
 * Remove a row from the `messages` table. Used by syncDrafts to evict
 * stale rows that were cached when a draft was previously read through
 * `ofw_get_message` (which would have wrongly classified it as `inbox`)
 * — the drafts table is the authoritative source for that id now.
 */
export function deleteMessage(id: number): void {
  const { db } = openCache();
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

export interface ListMessagesOptions {
  folder?: 'inbox' | 'sent';   // omit to search both
  page: number;
  size: number;
  since?: string;              // ISO date or datetime, inclusive
  until?: string;              // ISO date or datetime, exclusive
  q?: string;                  // substring match on subject and body (case-insensitive)
}

type MessageFilter = Omit<ListMessagesOptions, 'page' | 'size'>;

// Build the WHERE clause + bound params for message queries. listMessages and
// countMessages share this so the filter semantics can't drift.
function buildMessageFilter(opts: MessageFilter): { where: string; params: unknown[] } {
  const wheres: string[] = [];
  const params: unknown[] = [];
  if (opts.folder !== undefined) {
    wheres.push('folder = ?');
    params.push(opts.folder);
  }
  if (opts.since !== undefined) {
    wheres.push('sent_at >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    wheres.push('sent_at < ?');
    params.push(opts.until);
  }
  if (opts.q !== undefined && opts.q.length > 0) {
    const pattern = `%${opts.q}%`;
    wheres.push('(subject LIKE ? OR body LIKE ?)');
    params.push(pattern, pattern);
  }
  return {
    where: wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '',
    params,
  };
}

export function listMessages(opts: ListMessagesOptions): MessageRow[] {
  const { db } = openCache();
  const { where, params } = buildMessageFilter(opts);
  const offset = (opts.page - 1) * opts.size;
  const rows = db.prepare(
    `SELECT * FROM messages ${where}
     ORDER BY sent_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).all(...params as never[], opts.size, offset) as unknown as MessageDbRow[];
  return rows.map(rowFromDb);
}

export function countMessages(opts: MessageFilter): number {
  const { db } = openCache();
  const { where, params } = buildMessageFilter(opts);
  const r = db.prepare(`SELECT COUNT(*) as n FROM messages ${where}`)
    .get(...params as never[]) as { n: number } | undefined;
  return r?.n ?? 0;
}

export interface DraftRow {
  id: number;
  subject: string;
  body: string;
  recipients: Recipient[];
  replyToId: number | null;
  modifiedAt: string;
  listData: unknown;
}

interface DraftDbRow {
  id: number;
  subject: string;
  body: string;
  recipients_json: string;
  reply_to_id: number | null;
  modified_at: string;
  list_data_json: string;
}

function draftFromDb(r: DraftDbRow): DraftRow {
  return {
    id: r.id,
    subject: r.subject,
    body: r.body,
    recipients: JSON.parse(r.recipients_json) as Recipient[],
    replyToId: r.reply_to_id,
    modifiedAt: r.modified_at,
    listData: JSON.parse(r.list_data_json),
  };
}

export function upsertDraft(row: DraftRow): void {
  const { db } = openCache();
  db.prepare(
    `INSERT INTO drafts (id, subject, body, recipients_json, reply_to_id, modified_at, list_data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       subject=excluded.subject,
       body=excluded.body,
       recipients_json=excluded.recipients_json,
       reply_to_id=excluded.reply_to_id,
       modified_at=excluded.modified_at,
       list_data_json=excluded.list_data_json`
  ).run(
    row.id,
    requireString('drafts.subject', row.subject),
    requireString('drafts.body', row.body),
    JSON.stringify(row.recipients ?? []),
    nullish(row.replyToId),
    requireString('drafts.modifiedAt', row.modifiedAt),
    JSON.stringify(row.listData ?? null)
  );
}

export function getDraft(id: number): DraftRow | null {
  const { db } = openCache();
  const r = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftDbRow | undefined;
  return r ? draftFromDb(r) : null;
}

export function listDrafts(opts: { page: number; size: number }): DraftRow[] {
  const { db } = openCache();
  const offset = (opts.page - 1) * opts.size;
  const rows = db.prepare(
    'SELECT * FROM drafts ORDER BY modified_at DESC, id DESC LIMIT ? OFFSET ?'
  ).all(opts.size, offset) as unknown as DraftDbRow[];
  return rows.map(draftFromDb);
}

export function deleteDraft(id: number): void {
  const { db } = openCache();
  db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
}

export function listDraftIds(): number[] {
  const { db } = openCache();
  const rows = db.prepare('SELECT id FROM drafts').all() as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

export type FolderName = 'inbox' | 'sent' | 'drafts';

export interface SyncState {
  lastSyncAt: string;
  newestId: number | null;
}

export function getSyncState(folder: FolderName): SyncState | null {
  const { db } = openCache();
  const r = db.prepare('SELECT last_sync_at, newest_id FROM sync_state WHERE folder = ?')
    .get(folder) as { last_sync_at: string; newest_id: number | null } | undefined;
  if (!r) return null;
  return { lastSyncAt: r.last_sync_at, newestId: r.newest_id };
}

export function setSyncState(folder: FolderName, state: SyncState): void {
  const { db } = openCache();
  db.prepare(
    `INSERT INTO sync_state (folder, last_sync_at, newest_id) VALUES (?, ?, ?)
     ON CONFLICT(folder) DO UPDATE SET
       last_sync_at = excluded.last_sync_at,
       newest_id = excluded.newest_id`
  ).run(folder, state.lastSyncAt, state.newestId);
}

export function getMeta(key: string): string | null {
  const { db } = openCache();
  const r = db.prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setMeta(key: string, value: string): void {
  const { db } = openCache();
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value);
}

export function findLatestReplyTip(replyToId: number): number {
  const { db } = openCache();
  const parent = db.prepare(
    'SELECT id, folder, chain_root_id FROM messages WHERE id = ?'
  ).get(replyToId) as { id: number; folder: string; chain_root_id: number | null } | undefined;
  if (!parent) return replyToId;
  const chainRoot = parent.chain_root_id ?? parent.id;
  const tip = db.prepare(
    `SELECT id FROM messages
     WHERE folder = 'sent' AND chain_root_id = ?
     ORDER BY id DESC LIMIT 1`
  ).get(chainRoot) as { id: number } | undefined;
  return tip ? tip.id : replyToId;
}

export interface AttachmentRow {
  fileId: number;
  fileName: string;
  label: string;
  mimeType: string;
  sizeBytes: number | null;
  metadata: unknown;
  messageIds: number[];
  downloadedPath: string | null;
  downloadedAt: string | null;
}

interface AttachmentDbRow {
  file_id: number;
  file_name: string;
  label: string;
  mime_type: string;
  size_bytes: number | null;
  metadata_json: string;
  message_ids_json: string;
  downloaded_path: string | null;
  downloaded_at: string | null;
  fetched_metadata_at: string;
}

function attachmentFromDb(r: AttachmentDbRow): AttachmentRow {
  return {
    fileId: r.file_id,
    fileName: r.file_name,
    label: r.label,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    metadata: JSON.parse(r.metadata_json),
    messageIds: JSON.parse(r.message_ids_json) as number[],
    downloadedPath: r.downloaded_path,
    downloadedAt: r.downloaded_at,
  };
}

export function getAttachment(fileId: number): AttachmentRow | null {
  const { db } = openCache();
  const r = db.prepare('SELECT * FROM attachments WHERE file_id = ?').get(fileId) as AttachmentDbRow | undefined;
  return r ? attachmentFromDb(r) : null;
}

export function listAttachmentsForMessage(messageId: number): AttachmentRow[] {
  const { db } = openCache();
  // SQLite JSON1 contains check
  const rows = db.prepare(
    `SELECT * FROM attachments
     WHERE EXISTS (SELECT 1 FROM json_each(message_ids_json) WHERE value = ?)
     ORDER BY file_id`
  ).all(messageId) as unknown as AttachmentDbRow[];
  return rows.map(attachmentFromDb);
}

export interface UpsertAttachmentInput {
  fileId: number;
  fileName: string;
  label: string;
  mimeType: string;
  sizeBytes: number | null;
  metadata: unknown;
  /** Message id that references this attachment — appended to message_ids_json if not already present. */
  messageId: number;
}

export function upsertAttachmentForMessage(input: UpsertAttachmentInput): void {
  const { db } = openCache();
  const existing = db.prepare('SELECT message_ids_json FROM attachments WHERE file_id = ?')
    .get(input.fileId) as { message_ids_json: string } | undefined;
  // messageId === 0 is the "metadata-only, not yet linked to a message"
  // sentinel used by upload-without-send and download-by-id. Don't
  // pollute the array with it — leave the list empty / unchanged.
  const prior = existing ? (JSON.parse(existing.message_ids_json) as number[]) : [];
  let messageIds: number[];
  if (input.messageId === 0) {
    messageIds = prior;
  } else if (prior.includes(input.messageId)) {
    messageIds = prior;
  } else {
    messageIds = [...prior, input.messageId];
  }
  db.prepare(
    `INSERT INTO attachments (
       file_id, file_name, label, mime_type, size_bytes,
       metadata_json, message_ids_json, fetched_metadata_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       file_name=excluded.file_name,
       label=excluded.label,
       mime_type=excluded.mime_type,
       size_bytes=excluded.size_bytes,
       metadata_json=excluded.metadata_json,
       message_ids_json=excluded.message_ids_json,
       fetched_metadata_at=excluded.fetched_metadata_at`
  ).run(
    input.fileId,
    requireString('attachments.fileName', input.fileName),
    requireString('attachments.label', input.label),
    requireString('attachments.mimeType', input.mimeType),
    nullish(input.sizeBytes),
    JSON.stringify(input.metadata ?? null),
    JSON.stringify(messageIds),
    new Date().toISOString()
  );
}

export function markAttachmentDownloaded(fileId: number, path: string): void {
  const { db } = openCache();
  db.prepare(
    'UPDATE attachments SET downloaded_path = ?, downloaded_at = ? WHERE file_id = ?'
  ).run(path, new Date().toISOString(), fileId);
}
