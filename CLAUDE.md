# ofw-mcp

MCP server for OurFamilyWizard (OFW). Reads/writes messages, calendar, expenses, and journal; backs message tools with a local SQLite cache. stdio transport.

## Commands

```bash
npm run build        # tsc → dist/, then esbuild bundle → dist/bundle.js
npm test             # vitest run (all tests)
npm run test:watch   # vitest in watch mode
npm run dev          # node --env-file=.env dist/index.js (requires built dist)
```

`dist/` is gitignored — it is produced at build/release time and shipped in the npm package (`package.json` `files`).

## Architecture

```
src/
  index.ts          MCP server entry — McpServer + StdioServerTransport, registers all tools
  client.ts         OFWClient (Bearer token, 401/429 retry, JSON + binary). Delegates auth to ./auth.ts
  auth.ts           resolveAuth(): three-path priority (env vars → fetchproxy fallback → error). Template for sibling MCPs
  auth-password.ts  loginWithPassword(): legacy OFW Spring Security form login (kept as own module so auth.ts can mock it cleanly)
  config.ts         env-driven cache dir + sha256(OFW_CACHE_IDENTITY|OFW_USERNAME|"_default") DB path + attachments dir
  cache.ts          node:sqlite cache (messages, drafts, attachments, sync_state, meta) with typed CRUD + findLatestReplyTip
  sync.ts           resolveFolderIds + syncMessageFolder/syncDrafts/syncAll + attachment-meta fetch
  tools/
    _shared.ts      recipient mapping, response helpers, path expansion
    user.ts         ofw_get_profile, ofw_get_notifications
    messages.ts     folders, list, get, send, drafts, get_unread_sent, upload/download_attachment, sync_messages
    calendar.ts     list/create/update/delete events
    expenses.ts     totals, list, create
    journal.ts      list, create entries
tests/              mirrors src/; mocks OFWClient.request via vi.spyOn; cache tests use OFW_CACHE_DIR + tmp dir
```

Tool files use `server.registerTool(name, schema, handler)`. `index.ts` wires `registerXTools(server, client)` for each domain.

## Environment

```
OFW_USERNAME              Optional. OFW login email (legacy env-var auth path; also serves as cache key)
OFW_PASSWORD              Optional. OFW password (legacy env-var auth path)
OFW_DISABLE_FETCHPROXY    Optional. "1|true|yes|on" → skip the fetchproxy fallback (missing creds become a hard error)
OFW_CACHE_IDENTITY        Optional. Explicit cache-key label; overrides OFW_USERNAME for fetchproxy-only multi-account setups
OFW_CACHE_DIR             Optional. Overrides cache dir (default ~/.cache/ofw-mcp)
OFW_ATTACHMENTS_DIR       Optional. Where ofw_download_attachment writes (default ~/Downloads/ofw-mcp)
OFW_INLINE_ATTACHMENTS    Optional. "1|true|yes|on" → return attachments as MCP content blocks by default
OFW_DEBUG_LOG             Optional. "1|true|yes|on" → log every OFW request/response to stderr (Authorization redacted). Diagnostic only.
```

`auth.ts` ignores blank values, the strings `"undefined"`/`"null"`, and unsubstituted `${VAR}` placeholders — defensive against MCP hosts passing the env block through unexpanded.

`.env` (project root) is loaded by `client.ts` via dynamic `dotenv` import (silently skipped if unavailable, e.g. inside the mcpb bundle). Real env vars take precedence (`override: false`).

## Auth resolution (Pattern A template)

`src/auth.ts` is the canonical "browser-bootstrap + Node-direct" auth shape used across our MCP servers. Six sibling MCPs model their auth on this file — keep the structure flat, the path-selection explicit, the error messages actionable. Three paths in priority order:

1. **Env-var credentials** (`OFW_USERNAME` + `OFW_PASSWORD`) → `src/auth-password.ts` does the legacy Spring Security form login. Unchanged from pre-fetchproxy behavior.
2. **fetchproxy fallback** → `@fetchproxy/bootstrap` snapshots `localStorage["auth"]` + `localStorage["tokenExpiry"]` from a signed-in `ourfamilywizard.com` tab in ~one round-trip, then closes the bridge. All subsequent OFW API calls go out via direct Node fetch — fetchproxy is NOT in the hot path.
3. **Error** → tells the user how to fix it (set creds, OR install the extension and sign in).

The split into `auth.ts` + `auth-password.ts` is deliberate: tests mock `auth-password.js` and `@fetchproxy/bootstrap` at the module boundary, so path-selection logic in `resolveAuth()` stays independent of either implementation. Sibling MCPs should copy this split.

## Message Cache

- SQLite at `~/.cache/ofw-mcp/<sha256(OFW_USERNAME).slice(0,16)>.db`. Requires Node ≥22.5 for `node:sqlite` (an `ExperimentalWarning` for SQLite is suppressed in `src/index.ts`)
- All message reads (`ofw_list_messages`, `ofw_get_message`, `ofw_list_drafts`, `ofw_get_unread_sent`) are served from the cache. `ofw_sync_messages` is the only path that walks OFW for new content
- `ofw_send_message` and `ofw_save_draft` resolve `replyToId` to the latest sent reply in the same chain via the cache (transparency note included in the response when rewritten); after the OFW POST succeeds they immediately `GET /pub/v3/messages/{id}` to repopulate the cache from authoritative state. (OFW's POST response is minimal — typically `{entityId: X}` — so we use the detail GET as the source of truth.)
- **`ofw_save_draft` replace path**: when the caller passes `messageId`, the tool does NOT call OFW's update-in-place endpoint (POST `/pub/v3/messages` with `messageId` in the payload). That endpoint silently no-ops on subsequent updates while echoing the posted body in the immediate GET — there's no honest way to detect the no-op from the API. Instead `ofw_save_draft` always POSTs without `messageId` (creating a fresh draft), then DELETEs the old draft afterward. The response's `id` is the NEW id; a transparency `NOTE` explains the swap. If the old-draft delete fails, the response carries a `WARNING` and the new draft is still committed.
- **Draft routing in `ofw_get_message`**: drafts and messages share an ID space and the same `/pub/v3/messages/{id}` endpoint. When a caller asks for an id that exists in the drafts cache, `ofw_get_message` returns a synthesized `MessageRow` with `folder: 'drafts'` (alongside the usual `inbox`/`sent`), `fromUser: ''`, and `sentAt`/`fetchedBodyAt` mirroring the draft's `modifiedAt`. The drafts table is the source of truth for that id; any stale row in the messages table is evicted on the next sync (`syncDrafts` calls `deleteMessage` after `upsertDraft`).
- Drafts folder ID is resolved dynamically via `/pub/v1/messageFolders` and persisted in the `meta` table

## OFW API Notes

- List endpoints (e.g. `/pub/v3/messages?folders=...`) return rich data including nested `recipients[].viewed` status — prefer list data over N+1 detail calls
- `showNeverViewed` (boolean on list items) is the reliable unread-sent indicator; the detail endpoint's `viewed` field is inconsistent (returns `null` for read messages instead of the epoch sentinel the list endpoint uses)
- `ofw-version: 1.0.0` header is required on all API requests — this is the OFW protocol version, not our package version
- Auth: `GET /ofw/login.form` to capture SESSION cookie, then `POST /ofw/login` (form-urlencoded) returns `{ auth: "<bearer>" }`. Tokens cached for 6h; 401 triggers one re-auth+replay, 429 waits 2s and replays once

## Testing

```bash
npm test           # vitest run
```

`vitest.config.ts` enforces 100% line/branch/function/statement coverage on `src/**` (excluding `src/index.ts`, the stdio entry point). Failing coverage fails CI. No real API calls — `OFWClient.request` is mocked via `vi.spyOn`.

## Versioning

Version appears in SEVEN places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → `npm install --package-lock-only` after changing package.json (or `npm version` does it automatically)
3. `src/index.ts` → `McpServer` constructor `version` field
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version` (two entries)
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `plugins[].version` and `metadata.version`

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by the **Tag & Bump** GitHub Action (`.github/workflows/tag-and-bump.yml`).

### Release workflow

Main is always one version ahead of the latest tag. Releases are zero-touch — kicking off **Tag & Bump** drives the whole loop:

1. **Tag & Bump** (`.github/workflows/tag-and-bump.yml`, manual `workflow_dispatch`): branches `release/v<NEXT>` off main, bumps every version field (see the list above), rebuilds, pushes the branch, opens a PR titled `chore: release v<CURRENT> (bump main to v<NEXT>)` labeled `ignore-for-release`, then follows up with `gh pr edit --add-label ready-to-merge` to arm auto-merge.
2. **Auto-merge** (`auto-merge.yml`, `arm-owner-on-ready-label` job): sees `ready-to-merge` on an owner PR and calls `gh pr merge --auto --merge` via `RELEASE_PAT`. (The PAT, not `GITHUB_TOKEN`, so the resulting merge fires downstream workflows.)
3. **Tag on release merge** (`tag-on-release-merge.yml`, `push: branches: [main]`): compares `HEAD`'s `package.json` version to `HEAD~1`'s. When they differ, tags `HEAD~1` with `v<HEAD~1's version>` — i.e. the released code, before the bump — and pushes the tag via `RELEASE_PAT`. Idempotent: skips if the tag already exists.
4. **Release** (`release.yml`, `push: tags: ['v*']`): rebuilds, publishes to npm with provenance, publishes to the MCP Registry, publishes the skill to ClawHub (if `CLAWHUB_TOKEN` is set), creates a GitHub Release with the `.mcpb` + `.skill` assets and `generate_release_notes: true`.

The branch-and-PR shape is required because `main` is protected: direct pushes are blocked, `ci` is a required status check, and admin enforcement is on. The release bot has no escape hatch — every change to main goes through a PR.

<!-- pr-workflow:v3 -->
## Pull requests & release notes

**Default workflow: branch + PR. Direct pushes to `main` are blocked by branch protection** (required status check `ci`, required PR flow, admin enforcement on). The PR mechanism is also the only way release notes get generated — `generate_release_notes` (configured in `.github/release.yml`) picks up merged PRs.

PR handling is **source-aware**:

| PR author                          | `auto-review` (Claude verdict + Copilot) | Auto-merge                                                                                       |
|------------------------------------|-------------------------------------------|--------------------------------------------------------------------------------------------------|
| **You / same-repo collaborators**  | Yes                                       | Yes when Claude verdict = `pass` AND CI is green. `warn` / `fail` → manual `ready-to-merge`.     |
| **External fork PRs**              | No (workflow skips — fork PRs can't see secrets). Manual: `@claude review this` in a comment triggers `claude.yml`. | No — you merge manually after reviewing |
| **Dependabot / bots**              | No (skipped to keep noise down)           | Yes, armed immediately; merges when CI is green                                                  |

`pr-auto-review.yml` runs `claude-code-action` on `pull_request` events with a JSON-schema-bound verdict (`pass` / `warn` / `fail`). Claude (posting as `claude[bot]` via the installed Claude GitHub App) leaves inline comments on specific lines plus a top-level summary, and emits the verdict to `structured_output`. On `verdict == pass` the workflow adds `ready-to-merge` via RELEASE_PAT and `auto-merge.yml` arms `gh pr merge --auto`. Required status check `ci` still gates the actual merge.

The workflow uses `pull_request` (not `pull_request_target`) because Anthropic's GitHub App OIDC backend doesn't accept `pull_request_target` events (see [anthropics/claude-code-action#713](https://github.com/anthropics/claude-code-action/issues/713)). The tradeoff is that fork PRs are skipped entirely — for those, mention `@claude` in a PR comment to invoke the ad-hoc dispatch in `claude.yml`.

Verdict semantics (Claude follows the official `code-review` plugin's severity model with confidence ≥80 to count):
- `pass` — no 🔴 Important findings.
- `warn` — at least one 🟡 Nit but no 🔴 Important.
- `fail` — at least one 🔴 Important finding.

Override: if you want to merge through a `warn` or `fail`, add `ready-to-merge` by hand — it still arms auto-merge. To suppress auto-merge on a `pass`, remove the label or close-and-reopen the PR draft.

For every PR, apply exactly one label so it lands in the right release-notes section:

| Label                | Section in release notes |
|----------------------|--------------------------|
| `enhancement`        | Features                 |
| `bug`                | Bug Fixes                |
| `security`           | Security                 |
| `refactor`           | Refactor                 |
| `documentation`      | Documentation            |
| `test`               | Tests                    |
| `dependencies`       | Dependencies             |
| `ci` / `github_actions` | CI & Build            |
| *(none / unmatched)* | Other Changes            |
| `ignore-for-release` | Hidden from notes        |

The **PR title** becomes the bullet — write it like a user-facing changelog entry (`ofw_sync_messages: resume from saved cursor`), not internal shorthand (`sync tweaks`). Conventional-commit prefixes (`feat:`, `fix:`, `chore:`) are still fine in commit messages, but the PR title should read clean.

Open with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a line). You generally don't need to pre-add `ready-to-merge` anymore — let Claude's review verdict do it. If you want to skip the review (e.g. for a trivial chore you've eyeballed yourself), add `ready-to-merge` at PR-create time and it'll arm immediately. Dependabot PRs auto-arm without `ready-to-merge`. The repo allows merge commits only (no squash, no rebase) — if you ever do call `gh pr merge` manually, don't pass `--squash`/`--rebase` or the call will fail.

## Plugin / Distribution

```
.claude-plugin/
  plugin.json       Claude Code plugin manifest (points at .mcp.json and skills/)
  marketplace.json  Marketplace catalog entry
.mcp.json           Claude Code MCP server config (npx -y ofw-mcp)
manifest.json       mcpb manifest (server.entry_point=dist/bundle.js, user_config for credentials)
server.json         MCP Registry manifest (npm package, env var schema)
skills/ofw/SKILL.md Claude Code skill describing when/how to use the tools
```

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` sources (e.g. `import { client } from './client.js'`)
- **Node ≥22.5 required**: `node:sqlite` is the cache backend. The startup `ExperimentalWarning` for SQLite is suppressed by a `process.emit` shim at the top of `src/index.ts`
- **stdio transport**: stdout is reserved for JSON-RPC. All logging goes to **stderr** (`console.error`). `dotenv` is loaded inside a try/catch and the entry point shim filters warnings
- **Cache refresh from GET**: `ofw_send_message` and `ofw_save_draft` GET `/pub/v3/messages/{id}` after the POST returns and populate the cache from the detail response — OFW's POST response is minimal (typically `{entityId: X}`). `ofw_delete_draft` updates the cache directly after the OFW DELETE succeeds (no GET needed)
- **`ofw_save_draft` with `messageId` is create-then-delete, not update-in-place**: OFW's POST `/pub/v3/messages` with `messageId` in the payload silently no-ops while echoing the body in the immediate GET. The tool sidesteps the broken endpoint by always POSTing without `messageId` (fresh draft) and DELETEing the old one. Response carries a `NOTE`; the new `id` is different from the input `messageId`
- **replyToId rewriting**: send/save_draft transparently re-target stale `replyToId`s to the latest sent reply in the chain (via `findLatestReplyTip`) and include a transparency note in the response
- **Attachment download paths**: in sandboxed MCP hosts (Claude Desktop) the model often can't read files written under `~/.cache`. Default download dir is `~/Downloads/ofw-mcp/`; set `OFW_INLINE_ATTACHMENTS=true` (or per-call `inline: true`) to return bytes as MCP content blocks instead
- **AI-maintained**: README warns this codebase is built and maintained by Claude; `src/index.ts` prints the same notice to stderr on startup
