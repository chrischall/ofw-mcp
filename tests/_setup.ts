// Suite-wide guard: no test may touch the developer's real session cache.
//
// `createSessionCache` resolves its path from MCP_DATA_DIR/HOME, so any test
// that happens to have OFW_USERNAME + OFW_PASSWORD set would read and write
// ~/.ofw-mcp/session.json — making the suite non-hermetic, order-dependent, and
// (worse) able to leave a real file behind. An earlier run of this branch did
// exactly that before this file existed.
//
// Three independent guards, deliberately belt-and-braces:
//   1. The cache is OFF by default, so the ordinary suite never constructs one.
//   2. The path is pinned into a temp dir anyway, so a test that turns the cache
//      ON to exercise it still cannot reach $HOME.
//   3. HOME itself is a temp dir for the whole process, so even a path resolved
//      from os.homedir() lands in a sandbox this run owns.
//
// A cache test opts in with `process.env.OFW_SESSION_CACHE = 'true'` and gets
// the temp path for free.
import { beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resetCredentialRejections } from '../src/auth-password.js';

const CACHE_DIR = mkdtempSync(join(tmpdir(), 'ofw-test-cache-'));

// The developer's real ~/.ofw-mcp is THEIR data — a locally-run server keeps
// its live session there. Fingerprint it before any test runs and compare
// afterwards; never delete it. Its existence proves nothing about this run: the
// old tripwire treated it as a leak and removed it recursively (#390).
const REAL_HOME = homedir();
const REAL_CACHE = join(REAL_HOME, '.ofw-mcp');
function fingerprint(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      entries.push(`${p.slice(dir.length)}:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return entries.join('\n');
}
const REAL_CACHE_BEFORE = fingerprint(REAL_CACHE);

// os.homedir() reads HOME (USERPROFILE on Windows) on every call, so pointing
// it at a sandbox redirects the one fallback no OFW_* variable can reach.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'ofw-test-home-'));
const PREV_HOME = process.env.HOME;
const PREV_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

beforeEach(() => {
  process.env.OFW_SESSION_CACHE = 'false';
  process.env.OFW_SESSION_FILE = join(CACHE_DIR, 'session.json');
  // The confirm gate reads MCP_CONFIRM_MODE / _TTL_SECONDS / _SECRET. Tests
  // exercise the fleet DEFAULTS (ask-user, 600 s, a per-process key); a
  // developer's shell exporting one of these must not change the outcome.
  delete process.env.MCP_CONFIRM_MODE;
  delete process.env.MCP_CONFIRM_TTL_SECONDS;
  delete process.env.MCP_CONFIRM_SECRET;
  // The login rejection latch is process-wide; one test's rejected fixture
  // credentials must not refuse the next test's login.
  resetCredentialRejections();
});

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });

  // The tripwire, and why the env guards above are not enough on their own:
  // they work through process.env, and a client that reads an INJECTED env
  // bypasses them completely — the path resolver then falls back to
  // os.homedir(). Fixing exactly that plumbing in schoolpass-mcp is what
  // created a real file under $HOME. So assert the outcome, in the sandbox
  // HOME: anything there was written by this run, and deleting it is safe.
  const leaked = join(TEST_HOME, '.ofw-mcp');
  const leakedInSandbox = existsSync(leaked);
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (PREV_HOME === undefined) delete process.env.HOME; else process.env.HOME = PREV_HOME;
  if (PREV_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = PREV_USERPROFILE;

  if (leakedInSandbox) {
    throw new Error(
      'A test wrote a session cache under the home directory (caught in the sandbox ' +
        'HOME and removed). The suite must never touch the real home directory — inject ' +
        'OFW_SESSION_CACHE=false (or a temp OFW_SESSION_FILE) into the env that test hands the client.',
    );
  }
  // Something reached the REAL home anyway (a path captured before HOME was
  // redirected). Fail loudly and leave it exactly as it is: the directory may
  // hold the developer's own session, and only they can tell which it is.
  if (fingerprint(REAL_CACHE) !== REAL_CACHE_BEFORE) {
    throw new Error(
      `${REAL_CACHE} changed during this test run. Nothing was deleted — inspect it ` +
        'yourself. The suite must never touch the real home directory.',
    );
  }
});
