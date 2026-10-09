// Invariant: the Claude Code plugin manifest declares its MCP config under
// `mcpServers` — the key Claude Code actually reads — and that file exists.
//
// Why this exists: plugin.json once said `"mcp": "./.mcp.json"`. Claude Code
// ignores an unknown `mcp` key (`claude plugin validate` warns "Unknown field
// 'mcp'"); it only worked here because ./.mcp.json is the default location.
// Sibling repos copied the pattern with a non-default path and their plugin
// installs silently lost their MCP server.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
) as Record<string, unknown>;

describe('plugin manifest', () => {
  it('declares its MCP config under `mcpServers`, not the ignored `mcp` key', () => {
    expect(manifest).not.toHaveProperty('mcp');
    expect(typeof manifest.mcpServers).toBe('string');
  });

  it('points `mcpServers` at a file that exists', () => {
    const path = join(ROOT, manifest.mcpServers as string);
    expect(existsSync(path)).toBe(true);
  });
});
