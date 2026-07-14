import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSqlDriver, OFWCache } from '../../src/cache/node.js';
import type { MessageRow } from '../../src/cache/store.js';

// The OFW core only issues single-statement writes, so NodeSqlDriver.transaction
// isn't reached through the store surface. It's part of the SqlDriver contract
// (and the later Durable Object backend / batch writes will use it), so cover
// the commit and rollback paths here directly.

describe('NodeSqlDriver', () => {
  let db: DatabaseSync;

  afterEach(() => {
    db.close();
  });

  it('commits a transaction and supports execScript/run/get/all', () => {
    db = new DatabaseSync(':memory:');
    const driver = new NodeSqlDriver(db);
    driver.execScript('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    driver.transaction(() => {
      driver.run('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
      driver.run('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'b']);
    });
    expect(driver.get('SELECT v FROM t WHERE id = ?', [1])).toEqual({ v: 'a' });
    expect(driver.all('SELECT id FROM t ORDER BY id', [])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('rolls back and rethrows when the transaction body throws', () => {
    db = new DatabaseSync(':memory:');
    const driver = new NodeSqlDriver(db);
    driver.execScript('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(() =>
      driver.transaction(() => {
        driver.run('INSERT INTO t (id) VALUES (?)', [1]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // The insert was rolled back.
    expect(driver.all('SELECT id FROM t', [])).toEqual([]);
  });
});

// The `:memory:` path (store.test.ts) skips the on-disk file handling entirely,
// so exercise the disk-backed open here: it creates parent dirs, locks the dir
// and db down to 0700/0600, and re-asserts permissions on the WAL siblings the
// schema write creates.
describe('OFWCache.open (disk-backed)', () => {
  let dir: string;
  let disk: OFWCache;

  afterEach(() => {
    disk.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the db, locks down dir/db/WAL-sibling permissions, and round-trips a row', () => {
    dir = mkdtempSync(join(tmpdir(), 'ofw-cache-disk-'));
    const dbPath = join(dir, 'nested', 'cache.db');
    disk = OFWCache.open(dbPath);

    // A write forces the WAL sibling to exist so the second enforce pass chmods it.
    const row: MessageRow = {
      id: 1, folder: 'inbox', subject: 'S', fromUser: 'A', sentAt: '2026-05-04T12:00:00Z',
      recipients: [], body: 'b', fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    };
    disk.core.upsertMessage(row);
    expect(disk.core.getMessage(1)?.subject).toBe('S');

    // 0700 dir, 0600 db (mode bits masked out of the full st_mode).
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    if (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })) {
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
    }
  });
});

describe('OFWCacheCore requireString guard', () => {
  let disk: OFWCache;
  afterEach(() => disk.close());

  it('throws a descriptive error when a required string column is undefined or null', () => {
    disk = OFWCache.open(':memory:');
    // folder is a NOT NULL string column — undefined and null must both throw
    // with the value named, covering both ternary branches of requireString.
    const base: MessageRow = {
      id: 1, folder: 'inbox', subject: 'S', fromUser: 'A', sentAt: '2026-05-04T12:00:00Z',
      recipients: [], body: 'b', fetchedBodyAt: null, replyToId: null, chainRootId: null, listData: {},
    };
    expect(() => disk.core.upsertMessage({ ...base, folder: undefined as never }))
      .toThrow(/cache: messages\.folder is required \(got undefined\)/);
    expect(() => disk.core.upsertMessage({ ...base, subject: null as never }))
      .toThrow(/cache: messages\.subject is required \(got null\)/);
  });
});
