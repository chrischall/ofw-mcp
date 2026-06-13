// The plugin .mcp.json maps creds from optional `${user_config.*}` values.
// When a user leaves a field blank, the host may inject the key as an empty
// string (or the literal unexpanded "${user_config.x}") into the server's
// env. Because the server loads `.env` with dotenv `override:false`, such a
// blank value would SHADOW the user's `.env`/shell value and break the
// credential-file path. clearBlankInjectedEnv() removes those blanks before
// dotenv runs, so the `.env`/shell path keeps working when the UI field is
// empty — while a real, user-provided value is left untouched.
import { describe, it, expect } from 'vitest';
import { clearBlankInjectedEnv, USER_CONFIG_KEYS } from '../src/env-bootstrap.js';

describe('clearBlankInjectedEnv', () => {
  it('deletes empty-string and whitespace-only values', () => {
    const env: NodeJS.ProcessEnv = { OFW_USERNAME: '', OFW_PASSWORD: '   ' };
    clearBlankInjectedEnv(env, ['OFW_USERNAME', 'OFW_PASSWORD']);
    expect('OFW_USERNAME' in env).toBe(false);
    expect('OFW_PASSWORD' in env).toBe(false);
  });

  it('deletes unexpanded ${user_config.*} placeholders', () => {
    const env: NodeJS.ProcessEnv = {
      OFW_USERNAME: '${user_config.ofw_username}',
    };
    clearBlankInjectedEnv(env, ['OFW_USERNAME']);
    expect('OFW_USERNAME' in env).toBe(false);
  });

  it('keeps real user-provided values intact', () => {
    const env: NodeJS.ProcessEnv = {
      OFW_USERNAME: 'parent@example.com',
      OFW_PASSWORD: 'hunter2',
    };
    clearBlankInjectedEnv(env, ['OFW_USERNAME', 'OFW_PASSWORD']);
    expect(env.OFW_USERNAME).toBe('parent@example.com');
    expect(env.OFW_PASSWORD).toBe('hunter2');
  });

  it('leaves absent keys absent (no-op)', () => {
    const env: NodeJS.ProcessEnv = {};
    clearBlankInjectedEnv(env, ['OFW_USERNAME']);
    expect('OFW_USERNAME' in env).toBe(false);
  });

  it('covers every credential/config key the .mcp.json maps', () => {
    expect(USER_CONFIG_KEYS).toEqual([
      'OFW_USERNAME',
      'OFW_PASSWORD',
      'OFW_INLINE_ATTACHMENTS',
      'OFW_ATTACHMENTS_DIR',
      'OFW_WRITE_MODE',
    ]);
  });
});
