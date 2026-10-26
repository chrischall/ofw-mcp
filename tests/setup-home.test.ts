// The suite-wide teardown in tests/_setup.ts must never destroy data it did
// not create (#390). A developer who has run the server locally has a real
// ~/.ofw-mcp/session.json; the old tripwire saw that directory, assumed a test
// had leaked it, deleted it recursively, and only then failed the run.
//
// Reproduced in a SUBPROCESS with a disposable HOME, never against the real
// one: a nested vitest run of one harmless test file, whose shared setup runs
// with a pre-existing `.ofw-mcp` holding a synthetic sentinel.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function runNested(fakeHome: string, file = 'tests/protocol.test.ts') {
  return spawnSync(process.execPath, [VITEST, 'run', file, '--coverage.enabled=false'], {
    cwd: ROOT,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, VITEST: undefined, VITEST_WORKER_ID: undefined },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('tests/_setup.ts teardown', () => {
  it('leaves a pre-existing home session cache untouched, and does not fail the run over it', () => {
    home = mkdtempSync(join(tmpdir(), 'ofw-setup-home-'));
    const dir = join(home, '.ofw-mcp');
    mkdirSync(dir);
    const sentinel = join(dir, 'session.json');
    writeFileSync(sentinel, '{"synthetic":"sentinel"}');

    const run = runNested(home);

    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('{"synthetic":"sentinel"}');
    expect(run.status, run.stdout + run.stderr).toBe(0);
  }, 90_000);

  it('creates nothing under the real home when it starts absent', () => {
    home = mkdtempSync(join(tmpdir(), 'ofw-setup-home-'));

    const run = runNested(home);

    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(existsSync(join(home, '.ofw-mcp'))).toBe(false);
  }, 90_000);

  it('still fails a run whose test leaks into the home directory, without touching the real one', () => {
    home = mkdtempSync(join(tmpdir(), 'ofw-setup-home-'));
    // Written at run time, so the outer run never collects it; removed below.
    const leaky = join(ROOT, 'tests', `.leak-${randomUUID()}.test.ts`);
    writeFileSync(leaky, [
      "import { it } from 'vitest';",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { homedir } from 'node:os';",
      "import { join } from 'node:path';",
      "it('leaks', () => { mkdirSync(join(homedir(), '.ofw-mcp'), { recursive: true });",
      "  writeFileSync(join(homedir(), '.ofw-mcp', 'session.json'), '{}'); });",
    ].join('\n'));
    try {
      const run = runNested(home, leaky);
      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toContain('caught in the sandbox HOME');
      expect(existsSync(join(home, '.ofw-mcp'))).toBe(false);
    } finally {
      rmSync(leaky, { force: true });
    }
  }, 90_000);
});
