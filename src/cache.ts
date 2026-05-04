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
