# ofw-mcp

MCP server for OurFamilyWizard (OFW) — provides read/write access to messages, calendar, expenses, and journal.

## Build & Test

```bash
npm run build        # tsc + esbuild bundle
npm test             # vitest run (all tests)
npm run test:watch   # vitest in watch mode
```

`dist/bundle.js` is committed (it's the npm-published artifact). Always rebuild before committing.

## Versioning

Version appears in FOUR places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → run `npm install --package-lock-only` after changing package.json
3. `src/index.ts` → `Server` constructor `version` field (MCP server version reported to clients)
4. `manifest.json` → `"version"` (mcpb manifest, synced at release time too)

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by the **Cut & Bump** GitHub Action.

### Release workflow

Main is always one version ahead of the latest tag. To release, run the **Cut & Bump** GitHub Action (`cut-and-bump.yml`) which:

1. Runs CI (build + test)
2. Tags the current commit with the current version
3. Bumps patch in all four files
4. Rebuilds, commits, and pushes main + tag
5. The tag push triggers the **Release** workflow (CI + npm publish + GitHub release)

## Architecture

- `src/index.ts` — MCP server setup, tool routing
- `src/client.ts` — OFW API client (auth, request/retry logic). `ofw-version` header is the OFW API protocol version (not our version)
- `src/tools/` — one file per domain (messages, calendar, expenses, journal, user). Each exports `toolDefinitions` and `handleTool`
- `tests/tools/` — mirrors `src/tools/`, mocks `OFWClient.request` via `vi.spyOn`

## OFW API Notes

- List endpoints (e.g. `/pub/v3/messages?folders=...`) return rich data including nested `recipients[].viewed` status — prefer using list data over making N+1 detail calls
- `showNeverViewed` (boolean on message list items) is the reliable indicator for unread sent messages. The detail endpoint's `viewed` field is inconsistent (returns `null` for read messages instead of the epoch sentinel the list endpoint uses)
- `ofw-version: 1.0.0` header is required on all API requests — this is the OFW protocol version, not our package version
- Auth uses Spring Security session cookie + login POST, tokens expire ~6h
- Drafts folder ID is hardcoded (`13471259`) in `ofw_list_drafts` — this is the system folder ID for the authenticated account
