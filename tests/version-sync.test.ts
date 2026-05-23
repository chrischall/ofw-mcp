// Invariant: every `// x-release-please-version` annotation in src/
// must hold a version string that matches package.json's `version`.
//
// Why this exists: a recurring class of bug where a VERSION constant
// (used as the MCP server's self-reported version + as the fetchproxy
// bridge identity) drifts from package.json because release-please's
// `extra-files` registration lacks the marker — so release-please
// silently skips bumping it on each release. resy-mcp v0.2.0 and
// opentable-mcp every release since v0.9.1 hit this.
//
// This test catches it at CI time. If a future contributor registers
// a new version-bearing constant, just add the `x-release-please-version`
// comment to the line — this test starts asserting it automatically.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
) as { version: string };

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('version sync', () => {
  it('every `x-release-please-version` annotation matches package.json', () => {
    const files = walkTs(join(ROOT, 'src'));
    const mismatches: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('x-release-please-version')) return;
        const match = line.match(
          /['"]([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?)['"]/
        );
        // Lines that mention the marker but carry no version literal
        // (e.g. a docstring explaining the convention) are not real
        // declarations — skip them.
        if (!match) return;
        const ver = match[1];
        if (ver !== pkg.version) {
          mismatches.push(
            `${relative(ROOT, f)}:${i + 1} → ${ver} (expected ${pkg.version})`
          );
        }
      });
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
