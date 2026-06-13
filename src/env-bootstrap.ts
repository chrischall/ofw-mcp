// Credentials + config the plugin's .mcp.json maps from `${user_config.*}`.
// These are the keys whose host-injected values we sanity-check before
// loading .env.
export const USER_CONFIG_KEYS = [
  'OFW_USERNAME',
  'OFW_PASSWORD',
  'OFW_INLINE_ATTACHMENTS',
  'OFW_ATTACHMENTS_DIR',
  'OFW_WRITE_MODE',
] as const;

// A host that maps an UNSET optional `${user_config.x}` into the server env
// may inject the key as an empty string or the literal, unexpanded
// "${user_config.x}". Either one SHADOWS the user's `.env`/shell value,
// because the server loads .env with dotenv `override:false` (it won't
// replace a key that's already present). Clearing those blanks first lets the
// `.env`/shell credential path keep working when the Connectors field is left
// empty — while a real, user-provided value is left untouched (so the desktop
// userConfig path still wins when set).
export function clearBlankInjectedEnv(
  env: NodeJS.ProcessEnv = process.env,
  keys: readonly string[] = USER_CONFIG_KEYS
): void {
  for (const key of keys) {
    const value = env[key];
    if (value === undefined) continue;
    if (value.trim() === '' || value.includes('${')) {
      delete env[key];
    }
  }
}
