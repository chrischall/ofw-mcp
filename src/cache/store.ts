// Storage-agnostic core for the OFW message cache.
//
// All message reads (list/get/drafts/unread-sent) are served from this cache;
// only ofw_sync_messages walks OFW for new content. The SQL lives here ONCE,
// over a tiny synchronous {@link SqlDriver}, so the same schema/queries back
// both engines: `node:sqlite` on the stdio/desktop server (src/cache/node.ts)
// and a Durable Object's SQLite on the hosted Cloudflare connector (a later
// task). This module imports nothing platform-specific.

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

export interface DraftRow {
  id: number;
  subject: string;
  body: string;
  recipients: Recipient[];
  replyToId: number | null;
  modifiedAt: string;
  listData: unknown;
}

export type FolderName = 'inbox' | 'sent' | 'drafts';

export interface SyncState {
  lastSyncAt: string;
  newestId: number | null;
  /**
   * Deep-backfill resume cursor: the OFW list page a bounded `deep` sync should
   * resume from on its next invocation, or `null` when the walk completed (or
   * was never bounded). A missing/NULL `resume_page` column reads back as null.
   */
  resumePage: number | null;
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

export interface ListMessagesOptions {
  folder?: 'inbox' | 'sent';   // omit to search both
  page: number;
  size: number;
  since?: string;              // ISO date or datetime, inclusive
  until?: string;              // ISO date or datetime, exclusive
  q?: string;                  // substring match on subject and body (case-insensitive)
}

export type MessageFilter = Omit<ListMessagesOptions, 'page' | 'size'>;

export type SqlParam = string | number | null;
type Row = Record<string, unknown>;

/** Minimal synchronous SQLite surface the core needs; both drivers implement it trivially. */
export interface SqlDriver {
  execScript(sql: string): void;
  run(sql: string, params: SqlParam[]): void;
  get(sql: string, params: SqlParam[]): Row | undefined;
  all(sql: string, params: SqlParam[]): Row[];
  transaction(fn: () => void): void;
}

/**
 * The async cache surface the sync logic and MCP tools depend on. Async because
 * the hosted Worker backend answers over a Durable Object RPC boundary; the node
 * backend fulfils it synchronously behind resolved promises.
 */
export interface CacheStore {
  upsertMessage(row: MessageRow): Promise<void>;
  /** Batch upsert in ONE transaction/RPC. Empty array is a no-op. */
  upsertMessages(rows: MessageRow[]): Promise<void>;
  getMessage(id: number): Promise<MessageRow | null>;
  /** Batch read: returns the present rows only (absent ids omitted), in one query/RPC. Empty ids → []. */
  getMessages(ids: number[]): Promise<MessageRow[]>;
  deleteMessage(id: number): Promise<void>;
  listMessages(opts: ListMessagesOptions): Promise<MessageRow[]>;
  countMessages(opts: MessageFilter): Promise<number>;
  upsertDraft(row: DraftRow): Promise<void>;
  /** Batch upsert in ONE transaction/RPC. Empty array is a no-op. */
  upsertDrafts(rows: DraftRow[]): Promise<void>;
  getDraft(id: number): Promise<DraftRow | null>;
  /** Batch read: returns the present drafts only (absent ids omitted), in one query/RPC. Empty ids → []. */
  getDrafts(ids: number[]): Promise<DraftRow[]>;
  listDrafts(opts: { page: number; size: number }): Promise<DraftRow[]>;
  deleteDraft(id: number): Promise<void>;
  listDraftIds(): Promise<number[]>;
  getSyncState(folder: FolderName): Promise<SyncState | null>;
  setSyncState(folder: FolderName, state: SyncState): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  findLatestReplyTip(replyToId: number): Promise<number>;
  getAttachment(fileId: number): Promise<AttachmentRow | null>;
  listAttachmentsForMessage(messageId: number): Promise<AttachmentRow[]>;
  upsertAttachmentForMessage(input: UpsertAttachmentInput): Promise<void>;
  markAttachmentDownloaded(fileId: number, path: string): Promise<void>;
}

// ── DB row shapes ──

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

interface DraftDbRow {
  id: number;
  subject: string;
  body: string;
  recipients_json: string;
  reply_to_id: number | null;
  modified_at: string;
  list_data_json: string;
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

/** Schema statements, split so a driver that only runs one statement per call works. */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS messages (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_folder_sent_at ON messages(folder, sent_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chain_root ON messages(chain_root_id)`,
  `CREATE TABLE IF NOT EXISTS drafts (
     id INTEGER PRIMARY KEY,
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     recipients_json TEXT NOT NULL,
     reply_to_id INTEGER,
     modified_at TEXT NOT NULL,
     list_data_json TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
     folder TEXT PRIMARY KEY,
     last_sync_at TEXT NOT NULL,
     newest_id INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // v2: attachments table. Idempotent — IF NOT EXISTS.
  `CREATE TABLE IF NOT EXISTS attachments (
     file_id INTEGER PRIMARY KEY,
     file_name TEXT NOT NULL,
     label TEXT NOT NULL,
     mime_type TEXT NOT NULL,
     size_bytes INTEGER,
     metadata_json TEXT NOT NULL,
     message_ids_json TEXT NOT NULL,
     downloaded_path TEXT,
     downloaded_at TEXT,
     fetched_metadata_at TEXT NOT NULL
   )`,
];

/**
 * Idempotent post-schema migrations, applied after {@link SCHEMA_STATEMENTS} on
 * every open. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each statement runs
 * inside a try/catch — re-running against an already-migrated DB throws
 * "duplicate column name", which is swallowed. Driver-agnostic: both
 * `node:sqlite` and the Durable Object's SQLite raise synchronously.
 */
export const MIGRATIONS = [
  // Resumable deep-sync cursor. Absent/NULL → SyncState.resumePage null.
  'ALTER TABLE sync_state ADD COLUMN resume_page INTEGER',
];

/** The schema version stamped into the `meta` table on open. */
export const SCHEMA_VERSION = '2';

// Build the WHERE clause + bound params for message queries. listMessages and
// countMessages share this so the filter semantics can't drift.
function buildMessageFilter(opts: MessageFilter): { where: string; params: SqlParam[] } {
  const wheres: string[] = [];
  const params: SqlParam[] = [];
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

/**
 * The OFW cache logic over a synchronous {@link SqlDriver}. The constructor
 * applies the schema (idempotent CREATE IF NOT EXISTS) and stamps the schema
 * version into the `meta` table.
 */
export class OFWCacheCore {
  constructor(private readonly db: SqlDriver) {
    for (const stmt of SCHEMA_STATEMENTS) this.db.execScript(stmt);
    for (const stmt of MIGRATIONS) {
      try {
        this.db.execScript(stmt);
      } catch {
        // Idempotent: the column already exists on a previously-migrated DB.
        // SQLite lacks ADD COLUMN IF NOT EXISTS, so a re-run throws "duplicate
        // column name" — swallow it and move on.
      }
    }
    this.db.run(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ['schema_version', SCHEMA_VERSION],
    );
  }

  upsertMessage(row: MessageRow): void {
    this.db.run(
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
         last_seen_at=excluded.last_seen_at`,
      [
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
        new Date().toISOString(),
      ],
    );
  }

  /**
   * Batch upsert every row in a single transaction — one round-trip's worth of
   * work (crucial on the Durable Object backend, where each RPC is a subrequest).
   * Empty array is a no-op (no transaction opened).
   */
  upsertMessages(rows: MessageRow[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const row of rows) this.upsertMessage(row);
    });
  }

  getMessage(id: number): MessageRow | null {
    const r = this.db.get('SELECT * FROM messages WHERE id = ?', [id]) as MessageDbRow | undefined;
    return r ? rowFromDb(r) : null;
  }

  /**
   * Batch read: one `SELECT ... WHERE id IN (...)` returning the present rows
   * (absent ids are simply omitted — order is not guaranteed). Empty ids returns
   * `[]` without querying.
   */
  getMessages(ids: number[]): MessageRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.all(
      `SELECT * FROM messages WHERE id IN (${placeholders})`,
      ids,
    ) as unknown as MessageDbRow[];
    return rows.map(rowFromDb);
  }

  /**
   * Remove a row from the `messages` table. Used by syncDrafts to evict
   * stale rows that were cached when a draft was previously read through
   * `ofw_get_message` (which would have wrongly classified it as `inbox`)
   * — the drafts table is the authoritative source for that id now.
   */
  deleteMessage(id: number): void {
    this.db.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  listMessages(opts: ListMessagesOptions): MessageRow[] {
    const { where, params } = buildMessageFilter(opts);
    const offset = (opts.page - 1) * opts.size;
    const rows = this.db.all(
      `SELECT * FROM messages ${where}
       ORDER BY sent_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, opts.size, offset],
    ) as unknown as MessageDbRow[];
    return rows.map(rowFromDb);
  }

  countMessages(opts: MessageFilter): number {
    const { where, params } = buildMessageFilter(opts);
    const r = this.db.get(`SELECT COUNT(*) as n FROM messages ${where}`, params) as { n: number } | undefined;
    /* v8 ignore next -- SELECT COUNT(*) always returns exactly one row; the ?./?? are defensive */
    return r?.n ?? 0;
  }

  upsertDraft(row: DraftRow): void {
    this.db.run(
      `INSERT INTO drafts (id, subject, body, recipients_json, reply_to_id, modified_at, list_data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         subject=excluded.subject,
         body=excluded.body,
         recipients_json=excluded.recipients_json,
         reply_to_id=excluded.reply_to_id,
         modified_at=excluded.modified_at,
         list_data_json=excluded.list_data_json`,
      [
        row.id,
        requireString('drafts.subject', row.subject),
        requireString('drafts.body', row.body),
        JSON.stringify(row.recipients ?? []),
        nullish(row.replyToId),
        requireString('drafts.modifiedAt', row.modifiedAt),
        JSON.stringify(row.listData ?? null),
      ],
    );
  }

  /** Batch upsert every draft in a single transaction. Empty array is a no-op. */
  upsertDrafts(rows: DraftRow[]): void {
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const row of rows) this.upsertDraft(row);
    });
  }

  getDraft(id: number): DraftRow | null {
    const r = this.db.get('SELECT * FROM drafts WHERE id = ?', [id]) as DraftDbRow | undefined;
    return r ? draftFromDb(r) : null;
  }

  /**
   * Batch read: one `SELECT ... WHERE id IN (...)` returning the present drafts
   * (absent ids omitted — order not guaranteed). Empty ids returns `[]` without
   * querying.
   */
  getDrafts(ids: number[]): DraftRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.all(
      `SELECT * FROM drafts WHERE id IN (${placeholders})`,
      ids,
    ) as unknown as DraftDbRow[];
    return rows.map(draftFromDb);
  }

  listDrafts(opts: { page: number; size: number }): DraftRow[] {
    const offset = (opts.page - 1) * opts.size;
    const rows = this.db.all(
      'SELECT * FROM drafts ORDER BY modified_at DESC, id DESC LIMIT ? OFFSET ?',
      [opts.size, offset],
    ) as unknown as DraftDbRow[];
    return rows.map(draftFromDb);
  }

  deleteDraft(id: number): void {
    this.db.run('DELETE FROM drafts WHERE id = ?', [id]);
  }

  listDraftIds(): number[] {
    const rows = this.db.all('SELECT id FROM drafts', []) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  getSyncState(folder: FolderName): SyncState | null {
    const r = this.db.get('SELECT last_sync_at, newest_id, resume_page FROM sync_state WHERE folder = ?', [folder]) as
      | { last_sync_at: string; newest_id: number | null; resume_page: number | null }
      | undefined;
    if (!r) return null;
    // A DB migrated before resume_page existed can still return the row
    // without the column; normalize a missing/NULL value to null.
    return { lastSyncAt: r.last_sync_at, newestId: r.newest_id, resumePage: r.resume_page ?? null };
  }

  setSyncState(folder: FolderName, state: SyncState): void {
    this.db.run(
      `INSERT INTO sync_state (folder, last_sync_at, newest_id, resume_page) VALUES (?, ?, ?, ?)
       ON CONFLICT(folder) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         newest_id = excluded.newest_id,
         resume_page = excluded.resume_page`,
      [folder, state.lastSyncAt, nullish(state.newestId), nullish(state.resumePage)],
    );
  }

  getMeta(key: string): string | null {
    const r = this.db.get('SELECT value FROM meta WHERE key = ?', [key]) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, value],
    );
  }

  findLatestReplyTip(replyToId: number): number {
    const parent = this.db.get('SELECT id, folder, chain_root_id FROM messages WHERE id = ?', [replyToId]) as
      | { id: number; folder: string; chain_root_id: number | null }
      | undefined;
    if (!parent) return replyToId;
    const chainRoot = parent.chain_root_id ?? parent.id;
    const tip = this.db.get(
      `SELECT id FROM messages
       WHERE folder = 'sent' AND chain_root_id = ?
       ORDER BY id DESC LIMIT 1`,
      [chainRoot],
    ) as { id: number } | undefined;
    return tip ? tip.id : replyToId;
  }

  getAttachment(fileId: number): AttachmentRow | null {
    const r = this.db.get('SELECT * FROM attachments WHERE file_id = ?', [fileId]) as AttachmentDbRow | undefined;
    return r ? attachmentFromDb(r) : null;
  }

  listAttachmentsForMessage(messageId: number): AttachmentRow[] {
    // SQLite JSON1 contains check
    const rows = this.db.all(
      `SELECT * FROM attachments
       WHERE EXISTS (SELECT 1 FROM json_each(message_ids_json) WHERE value = ?)
       ORDER BY file_id`,
      [messageId],
    ) as unknown as AttachmentDbRow[];
    return rows.map(attachmentFromDb);
  }

  upsertAttachmentForMessage(input: UpsertAttachmentInput): void {
    const existing = this.db.get('SELECT message_ids_json FROM attachments WHERE file_id = ?', [input.fileId]) as
      | { message_ids_json: string }
      | undefined;
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
    this.db.run(
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
         fetched_metadata_at=excluded.fetched_metadata_at`,
      [
        input.fileId,
        requireString('attachments.fileName', input.fileName),
        requireString('attachments.label', input.label),
        requireString('attachments.mimeType', input.mimeType),
        nullish(input.sizeBytes),
        JSON.stringify(input.metadata ?? null),
        JSON.stringify(messageIds),
        new Date().toISOString(),
      ],
    );
  }

  markAttachmentDownloaded(fileId: number, path: string): void {
    this.db.run('UPDATE attachments SET downloaded_path = ?, downloaded_at = ? WHERE file_id = ?', [
      path,
      new Date().toISOString(),
      fileId,
    ]);
  }
}

/**
 * Adapts a synchronous {@link OFWCacheCore} to the async {@link CacheStore}
 * interface. Used by the in-process node backend; the Durable Object backend
 * implements CacheStore over a real RPC boundary instead.
 */
export class LocalCacheStore implements CacheStore {
  constructor(readonly core: OFWCacheCore) {}
  async upsertMessage(row: MessageRow): Promise<void> {
    this.core.upsertMessage(row);
  }
  async upsertMessages(rows: MessageRow[]): Promise<void> {
    this.core.upsertMessages(rows);
  }
  async getMessage(id: number): Promise<MessageRow | null> {
    return this.core.getMessage(id);
  }
  async getMessages(ids: number[]): Promise<MessageRow[]> {
    return this.core.getMessages(ids);
  }
  async deleteMessage(id: number): Promise<void> {
    this.core.deleteMessage(id);
  }
  async listMessages(opts: ListMessagesOptions): Promise<MessageRow[]> {
    return this.core.listMessages(opts);
  }
  async countMessages(opts: MessageFilter): Promise<number> {
    return this.core.countMessages(opts);
  }
  async upsertDraft(row: DraftRow): Promise<void> {
    this.core.upsertDraft(row);
  }
  async upsertDrafts(rows: DraftRow[]): Promise<void> {
    this.core.upsertDrafts(rows);
  }
  async getDraft(id: number): Promise<DraftRow | null> {
    return this.core.getDraft(id);
  }
  async getDrafts(ids: number[]): Promise<DraftRow[]> {
    return this.core.getDrafts(ids);
  }
  async listDrafts(opts: { page: number; size: number }): Promise<DraftRow[]> {
    return this.core.listDrafts(opts);
  }
  async deleteDraft(id: number): Promise<void> {
    this.core.deleteDraft(id);
  }
  async listDraftIds(): Promise<number[]> {
    return this.core.listDraftIds();
  }
  async getSyncState(folder: FolderName): Promise<SyncState | null> {
    return this.core.getSyncState(folder);
  }
  async setSyncState(folder: FolderName, state: SyncState): Promise<void> {
    this.core.setSyncState(folder, state);
  }
  async getMeta(key: string): Promise<string | null> {
    return this.core.getMeta(key);
  }
  async setMeta(key: string, value: string): Promise<void> {
    this.core.setMeta(key, value);
  }
  async findLatestReplyTip(replyToId: number): Promise<number> {
    return this.core.findLatestReplyTip(replyToId);
  }
  async getAttachment(fileId: number): Promise<AttachmentRow | null> {
    return this.core.getAttachment(fileId);
  }
  async listAttachmentsForMessage(messageId: number): Promise<AttachmentRow[]> {
    return this.core.listAttachmentsForMessage(messageId);
  }
  async upsertAttachmentForMessage(input: UpsertAttachmentInput): Promise<void> {
    this.core.upsertAttachmentForMessage(input);
  }
  async markAttachmentDownloaded(fileId: number, path: string): Promise<void> {
    this.core.markAttachmentDownloaded(fileId, path);
  }
}
