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
OFW_WRITE_MODE            Optional. "none" = no write tools registered; "drafts" = draft-level writes only (ofw_save_draft, ofw_delete_draft, ofw_upload_attachment — never send or calendar/expense/journal writes); "all" = everything (default). Unrecognized values fail closed to "none". Structural gate: gated tools are not registered at all, so no host setting or injected instruction can invoke them.
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
- `ofw_send_message` and `ofw_save_draft` resolve `replyToId` to the latest sent reply in the same chain via the cache (transparency note included in the response when rewritten); after the OFW POST succeeds they immediately `GET /pub/v3/messages/{id}` to repopulate the cache from authoritative state. (OFW's POST response is minimal — typically `{entityId: X}` — so we use the detail GET as the source of truth.) The re-fetched detail is compared to the posted subject/body (`verifyWriteLanded` in `tools/_shared.ts`, containment not equality — replies get the original appended); a `WARNING` is included in the response when the write can't be confirmed. If the POST response carries no id, `ofw_send_message` does NOT delete the source draft (the send is unconfirmed).
- **`ofw_save_draft` replace path**: when the caller passes `messageId`, the tool does NOT call OFW's update-in-place endpoint (POST `/pub/v3/messages` with `messageId` in the payload). That endpoint silently no-ops on subsequent updates while echoing the posted body in the immediate GET — there's no honest way to detect the no-op from the API. Instead `ofw_save_draft` always POSTs without `messageId` (creating a fresh draft), then DELETEs the old draft afterward. The response's `id` is the NEW id; a transparency `NOTE` explains the swap. If the old-draft delete fails, the response carries a `WARNING` and the new draft is still committed.
- **Draft routing in `ofw_get_message`**: drafts and messages share an ID space and the same `/pub/v3/messages/{id}` endpoint. When a caller asks for an id that exists in the drafts cache, `ofw_get_message` returns a synthesized `MessageRow` with `folder: 'drafts'` (alongside the usual `inbox`/`sent`), `fromUser: ''`, and `sentAt`/`fetchedBodyAt` mirroring the draft's `modifiedAt`. The drafts table is the source of truth for that id; any stale row in the messages table is evicted on the next sync (`syncDrafts` calls `deleteMessage` after `upsertDraft`).
- Drafts folder ID is resolved dynamically via `/pub/v1/messageFolders` and persisted in the `meta` table
- `syncDrafts` walks every page of the drafts folder (50/page until a short page). This matters because its reconciliation step deletes any cached draft not seen in the listing — a partial walk would evict real drafts

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

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Driven by **release-please** (`googleapis/release-please-action@v4`). Authoritative state lives in `.release-please-manifest.json`; release-please bumps every file registered in `release-please-config.json`'s `extra-files`:

- `package.json` / `package-lock.json` — handled by `release-type: node`
- `src/index.ts` — the `version: '…'` literal on the line marked `// x-release-please-version`
- `manifest.json` — `$.version`
- `server.json` — `$.version` and `$.packages[*].version`
- `.claude-plugin/plugin.json` — `$.version`
- `.claude-plugin/marketplace.json` — `$.plugins[*].version` and `$.metadata.version`

If you add a new file with a `version` field, register it in `release-please-config.json`. Otherwise it silently drifts — release-please trusts its own bump logic, and there's no in-workflow guard.

### Important

Do NOT manually bump versions or create tags. Conventional-commit PR titles tell release-please what to do: `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE` → major. `chore:`, `docs:`, `ci:`, `test:`, `build:`, `refactor:` don't trigger a release on their own.

### Release workflow

Main is always at the latest released version (not "one ahead" — that was the old `tag-and-bump` model). The whole loop lives in `.github/workflows/release-please.yml`:

1. **release-please-action runs** on every push to main. When it sees commits since the last release that warrant a bump, it opens (or updates) a release PR titled `chore: release v<NEXT>`, bumps every file in `extra-files`, and writes the new entry into `CHANGELOG.md`.
2. **The release PR sits open as your review gate.** Look at the proposed CHANGELOG. When you're ready to ship, either merge it via the GitHub UI, or add the `ready-to-merge` label and `auto-merge.yml` will arm `gh pr merge --auto`. CI gates the merge either way.
3. When the release PR merges, **release-please-action runs again** on the new push, creates the `v<NEXT>` tag, and creates a GitHub Release with the CHANGELOG section as the body. Its `release_created` output flips to `true`.
4. **The `publish` job** in the same workflow runs (gated on `needs.release-please.outputs.release_created == 'true'`): checks out the tag, builds and packages the `.mcpb` bundle and `.skill` archive, publishes to npm (provenance, idempotent), the MCP Registry (OIDC), and ClawHub (gated on `secrets.CLAWHUB_TOKEN`), then attaches the `.mcpb` and `.skill` to the existing release via `gh release upload --clobber`.

To skip a release temporarily, close release-please's PR — it'll re-open with more content the next time something warrants a bump. To force a release for content release-please thinks doesn't warrant one, see release-please's `release-as` / `--release-as` options.

Recovery from a flaky publish step: re-run the failed `release-please.yml` workflow run from the GitHub Actions UI. The publish job's npm step is idempotent (skips if already published); MCP Registry publish is idempotent in practice; `gh release upload --clobber` overwrites any prior uploads.

The branch-and-PR shape is still required because `main` is protected by the *main protection (PR + ci)* ruleset.

<!-- pr-workflow:v4 -->
## Pull requests & release notes

**Default workflow: branch + PR. Direct pushes to `main` are blocked by the *main protection (PR + ci)* ruleset.** The PR mechanism is also how release-please learns what's queued: every merged PR's conventional-commit prefixes (`fix:`, `feat:`, etc.) drive both the next version bump and the CHANGELOG section.

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

PR titles use conventional-commit prefixes — release-please reads them to pick the next version and to write the CHANGELOG entry (see [Conventional Commits](https://www.conventionalcommits.org/)):

| Prefix       | Bumps    | CHANGELOG section            |
|--------------|----------|------------------------------|
| `feat:`      | minor    | Features                     |
| `fix:`       | patch    | Bug Fixes                    |
| `perf:`      | patch    | Performance                  |
| `revert:`    | patch    | Reverts                      |
| `refactor:`  | none     | Refactor                     |
| `docs:`      | none     | Documentation                |
| `test:`      | none     | hidden                       |
| `build:`     | none     | hidden                       |
| `ci:`        | none     | hidden                       |
| `chore:`     | none     | hidden                       |
| `feat!:` / `BREAKING CHANGE:` | major | Features (with ⚠ marker) |

The bullet text in the CHANGELOG is the part after the prefix — write it like a user-facing changelog entry (`ofw_sync_messages: resume from saved cursor`), not internal shorthand (`sync tweaks`).

Open with `gh pr create`; you don't need any labels. Let Claude's review verdict add `ready-to-merge` for you. If you want to skip the review on a trivial chore, add `--label ready-to-merge` at PR-create time and it'll arm immediately. Dependabot PRs auto-arm without it. The repo blocks squash merges (rebase is allowed at the repo level but unused — every workflow calls `gh pr merge --merge` so all PRs land as merge commits); if you call `gh pr merge` manually, don't pass `--squash` or the call will fail.

`main` is protected by two rulesets: *Block force-push and deletion on main* and *main protection (PR + ci)* — the latter requires every change to go through a PR and `ci` to pass (strict mode = branch must be up-to-date with main). No bypass actors; admins are not exempt. See `gh api /repos/chrischall/ofw-mcp/rulesets` to inspect.

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
