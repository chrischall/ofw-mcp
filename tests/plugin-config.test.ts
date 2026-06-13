// Invariant: the Claude Code PLUGIN config (.claude-plugin/plugin.json +
// .mcp.json) must declare its credentials as `userConfig` and reference them
// via `${user_config.*}` — NOT bare `${OFW_*}` env references.
//
// Why this exists: a bare `${OFW_USERNAME}` in .mcp.json renders as a
// READ-ONLY field in the Claude Desktop Connectors UI (the host only tries to
// resolve it from the environment — there's nothing for the user to fill in).
// The `.mcpb` manifest.json already uses the `user_config` mechanism; the
// plugin path drifted and never adopted it, so desktop users couldn't enter
// their OFW credentials. This test keeps the plugin path in lockstep with the
// mcpb manifest so the fields stay editable.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

describe('plugin user_config', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const mcp = readJson('.mcp.json');
  const manifest = readJson('manifest.json');

  it('plugin.json declares userConfig for the credentials', () => {
    expect(plugin.userConfig).toBeDefined();
    expect(plugin.userConfig.ofw_username).toMatchObject({ type: 'string' });
    expect(plugin.userConfig.ofw_password).toMatchObject({
      type: 'string',
      sensitive: true,
    });
  });

  it("plugin.json userConfig matches the .mcpb manifest's user_config", () => {
    expect(plugin.userConfig).toEqual(manifest.user_config);
  });

  it('.mcp.json env references ${user_config.*}, not bare env vars', () => {
    const env = mcp.mcpServers.ofw.env as Record<string, string>;
    for (const [key, value] of Object.entries(env)) {
      expect(value, `${key} must reference user_config`).toMatch(
        /^\$\{user_config\.[a-z_]+\}$/
      );
    }
    expect(env.OFW_USERNAME).toBe('${user_config.ofw_username}');
    expect(env.OFW_PASSWORD).toBe('${user_config.ofw_password}');
  });
});
