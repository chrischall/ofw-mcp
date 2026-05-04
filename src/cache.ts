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

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_V1);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)').run('schema_version', '1');
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
    row.folder,
    row.subject,
    row.fromUser,
    row.sentAt,
    JSON.stringify(row.recipients),
    row.body,
    row.fetchedBodyAt,
    row.replyToId,
    row.chainRootId,
    JSON.stringify(row.listData),
    new Date().toISOString()
  );
}

export function getMessage(id: number): MessageRow | null {
  const { db } = openCache();
  const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageDbRow | undefined;
  return r ? rowFromDb(r) : null;
}

export function listMessages(opts: { folder: 'inbox' | 'sent'; page: number; size: number }): MessageRow[] {
  const { db } = openCache();
  const offset = (opts.page - 1) * opts.size;
  const rows = db.prepare(
    `SELECT * FROM messages WHERE folder = ?
     ORDER BY sent_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).all(opts.folder, opts.size, offset) as MessageDbRow[];
  return rows.map(rowFromDb);
}
