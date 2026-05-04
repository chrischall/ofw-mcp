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
- `src/config.ts` — env-driven cache directory + per-username DB path
- `src/cache.ts` — `node:sqlite` cache (messages, drafts, sync_state, meta) with typed CRUD + `findLatestReplyTip`
- `src/sync.ts` — folder ID resolution + `syncMessageFolder` / `syncDrafts` / `syncAll`
- `src/tools/` — one file per domain (messages, calendar, expenses, journal, user). Each exports `toolDefinitions` and `handleTool`. Message tools are cache-backed (see Message Cache section below)
- `tests/tools/` — mirrors `src/tools/`, mocks `OFWClient.request` via `vi.spyOn`. Cache-aware tests use `OFW_CACHE_DIR` env override + a per-test temp dir

## Message Cache

- Local SQLite at `~/.cache/ofw-mcp/<sha256(OFW_USERNAME)/16>.db`. `OFW_CACHE_DIR` env overrides the directory (used in tests). Requires Node ≥22.5 for `node:sqlite`
- All message reads (`ofw_list_messages`, `ofw_get_message`, `ofw_list_drafts`, `ofw_get_unread_sent`) are served from the cache. `ofw_sync_messages` is the only path that walks OFW for new content
- `ofw_send_message` and `ofw_save_draft` resolve `replyToId` to the latest sent reply in the same chain via the cache (transparency note included in the response when rewritten); they write the new sent/draft row through to the cache after the OFW POST succeeds
- The drafts folder ID is no longer hardcoded — `resolveFolderIds` looks it up via `/pub/v1/messageFolders` and persists it in the `meta` table

## OFW API Notes

- List endpoints (e.g. `/pub/v3/messages?folders=...`) return rich data including nested `recipients[].viewed` status — prefer using list data over making N+1 detail calls
- `showNeverViewed` (boolean on message list items) is the reliable indicator for unread sent messages. The detail endpoint's `viewed` field is inconsistent (returns `null` for read messages instead of the epoch sentinel the list endpoint uses)
- `ofw-version: 1.0.0` header is required on all API requests — this is the OFW protocol version, not our package version
- Auth uses Spring Security session cookie + login POST, tokens expire ~6h
