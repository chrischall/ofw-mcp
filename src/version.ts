// Single source of truth for the server's package name and version. Release-
// please bumps the VERSION literal (listed in release-please-config.json
// `extra-files`), and tests/version-sync.test.ts guards it against
// package.json drift. Importing these instead of package.json keeps the whole
// manifest — npm scripts included — out of dist/bundle.js.
export const SERVER_NAME = 'ofw-mcp';
export const VERSION = '2.20.5'; // x-release-please-version
