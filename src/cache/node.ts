import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { OFWCacheCore, LocalCacheStore, type SqlDriver, type SqlParam } from './store.js';

// The `node:sqlite` backend for the OFW message cache — a local on-disk SQLite
// file used by the stdio/desktop server. The query logic lives in OFWCacheCore
// (src/cache/store.ts); this file only adapts `node:sqlite` to the SqlDriver
// surface and manages the file handle + permissions. (The hosted Cloudflare
// connector uses a Durable Object backend instead — a later task.)

/** Adapts a `node:sqlite` DatabaseSync to the driver surface the core needs. */
export class NodeSqlDriver implements SqlDriver {
  constructor(private readonly db: DatabaseSync) {}
  execScript(sql: string): void {
    this.db.exec(sql);
  }
  run(sql: string, params: SqlParam[]): void {
    this.db.prepare(sql).run(...params);
  }
  get(sql: string, params: SqlParam[]): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  }
  all(sql: string, params: SqlParam[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
  }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

// The cache holds full co-parenting message history — keep it private to the
// owning user. Modes are asserted on every open (not just creation): mkdirSync
// `mode` and SQLite's default file mode only apply when the path is first
// created, so a pre-existing dir/db keeps whatever (world-readable) mode it
// had. The -wal/-shm siblings appear and disappear with WAL checkpoints, hence
// the existence check.
export function enforceCachePermissions(dbPath: string): void {
  chmodSync(dirname(dbPath), 0o700);
  chmodSync(dbPath, 0o600);
  for (const sibling of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sibling)) chmodSync(sibling, 0o600);
  }
}

/**
 * A file-backed OFW message cache. `open()` creates parent dirs, locks the dir
 * and DB down to 0700/0600, enables WAL, and applies the schema. Pass
 * `:memory:` for an ephemeral in-memory cache (tests) — no dirs or chmod.
 */
export class OFWCache extends LocalCacheStore {
  private constructor(
    readonly db: DatabaseSync,
    core: OFWCacheCore,
  ) {
    super(core);
  }

  static open(path: string): OFWCache {
    const memory = path === ':memory:';
    if (!memory) mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // First pass: lock down dir + db before WAL siblings exist.
    if (!memory) enforceCachePermissions(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // Constructing the core applies the schema (and writes the -wal/-shm files).
    const core = new OFWCacheCore(new NodeSqlDriver(db));
    // Second pass: lock down the -wal/-shm the schema writes created.
    if (!memory) enforceCachePermissions(path);
    return new OFWCache(db, core);
  }

  close(): void {
    this.db.close();
  }
}
