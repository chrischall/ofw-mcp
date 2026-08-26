// Suite-wide guard: no test may touch the developer's real session cache.
//
// `createSessionCache` resolves its path from MCP_DATA_DIR/HOME, so any test
// that happens to have OFW_USERNAME + OFW_PASSWORD set would read and write
// ~/.ofw-mcp/session.json — making the suite non-hermetic, order-dependent, and
// (worse) able to leave a real file behind. An earlier run of this branch did
// exactly that before this file existed.
//
// Two independent guards, deliberately belt-and-braces:
//   1. The cache is OFF by default, so the ordinary suite never constructs one.
//   2. The path is pinned into a temp dir anyway, so a test that turns the cache
//      ON to exercise it still cannot reach $HOME.
//
// A cache test opts in with `process.env.OFW_SESSION_CACHE = 'true'` and gets
// the temp path for free.
import { beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = mkdtempSync(join(tmpdir(), 'ofw-test-cache-'));

beforeEach(() => {
  process.env.OFW_SESSION_CACHE = 'false';
  process.env.OFW_SESSION_FILE = join(CACHE_DIR, 'session.json');
});

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
});
