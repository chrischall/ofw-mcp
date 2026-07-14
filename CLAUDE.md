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
  index.ts          MCP server entry — SQLite-warning shim, then runMcp() from @chrischall/mcp-utils (builds McpServer, applies registrars with client as deps, prints banner, wires shutdown + stdio transport)
  protocol.ts       Wire-level constants (BASE_URL, OFW_PROTOCOL_HEADERS, token TTL). Leaf module to break the client→auth→auth-password import cycle
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

Tool files use `server.registerTool(name, schema, handler)` and export `registerXTools(server: McpServer, client: OFWClient)`. `index.ts` passes those registrars to `runMcp({ tools: [...], deps: client })`, which calls each as `registerXTools(server, client)`.

### Hosted connector (Cloudflare Worker)

`ofw-mcp` is **dual-target**: the same tool registrars back both the local stdio entry (`src/index.ts`) and a hosted Cloudflare Worker "remote connector" for claude.ai (mirrors the sibling [`untappd-mcp`](https://github.com/chrischall/untappd-mcp) connector). The Worker files are node-incompatible (they import `cloudflare:workers` / `agents`), so they run under the Workers vitest pool, never the node pool.

```
src/worker.ts        Worker entry — createConnector() from @chrischall/mcp-connector wraps the SAME registrars (user/messages/calendar/expenses/journal); builds a per-client OFWClient and threads a Durable-Object cache provider via a WeakMap keyed on the client instance. Attachments are inline-only (no filesystem)
src/ofw-auth.ts      ConnectorAuth impl — the OAuth login form collects each user's OFW email+password (loginWithPassword). OFWProps stores BOTH username AND password because OFW bearer tokens expire in ~6h with no refresh token; encrypted at rest in OAUTH_KV
src/cache/durable.ts OFWCacheDO (Durable Object, SQLite-backed CacheStore) + durableCacheProvider — the remote equivalent of the local node cache; one durable cache per authenticated user
packages/mcp-connector  Vendored OAuth + streamable-HTTP connector harness (has its own test suite). Its src/ is excluded from ofw's coverage gate
wrangler.jsonc       Worker config (bindings: OAUTH_KV, CACHE_DO Durable Object; sets OFW_INLINE_ATTACHMENTS=true; OFW_WRITE_MODE defaults to "all")
```

Two vitest configs: `vitest.config.ts` (node pool, 100% gate on `src/**`, excludes `src/index.ts` + the Worker-only files `src/worker.ts`/`src/cache/durable.ts` + `packages/mcp-connector/src`) and `vitest.workers.config.ts` (Workers runtime pool for `tests/worker*.test.ts`). Scripts: `npm run worker:dev` (wrangler dev), `npm run worker:deploy` (wrangler deploy), `npm run worker:test` (Workers-pool suite). **Deploy is manual** — a one-time-per-operator process with no CI/CD path; see [`docs/DEPLOY-CONNECTOR.md`](docs/DEPLOY-CONNECTOR.md). Worker-only files MUST stay in `vitest.config.ts`'s `coverage.exclude` and must never be imported by a node (`tests/**`) test, or the node pool will fail to load `cloudflare:workers`.

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
OFW_CALENDAR_WRITES       Optional. "1|true|yes|on" → in mode "drafts", additionally register the calendar write tools (ofw_create_event, ofw_update_event, ofw_delete_event). Rationale: calendar events have no draft stage but are reversible (editable/deletable), unlike a sent message. Redundant in "all"; never overrides "none" (including the unrecognized-mode fail-closed path)
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

## Response validation (issue #83)

Every JSON response is validated with zod at the call site via `parseLenient(schema, raw, { label, context, mode })` from `@chrischall/mcp-utils` (the fleet helper that consolidated ofw's old `parseOFW`). Schemas are `z.looseObject(...)` covering ONLY the fields the code reads — unknown keys pass through (and survive into cached `listData`/`metadata`). Pass `label: 'ofw-mcp'` and a per-call `context` string. Two modes:

- **lenient** (default) — all read/sync paths. Mismatch → structured stderr warning (`[ofw-mcp] WARNING: unexpected <context> shape …`) naming the endpoint and fields, then the RAW response flows on through the existing `??` fallbacks. An OFW backend change degrades gracefully but never silently.
- **strict** (`mode: 'strict'`) — write boundaries (`postMessageAndRefetch`'s POST + detail GET, `ofw_upload_attachment`). Mismatch → throw an `McpToolError`: proceeding on an unverifiable response risks deleting a draft, mis-reporting a send, or caching an unusable fileId. Absence of optional fields stays legal (handled by `verifyWriteLanded` WARNINGs); a present-but-mistyped field throws.

When adding a new endpoint call, define a loose schema next to the call site and wrap the `client.request` in `parseLenient`. Sibling MCPs copy this pattern.

## OFW API Notes

- **Recipient view status has two sources that disagree** (verified against live payloads): the LIST endpoint (`/pub/v3/messages?folders=...`) carries the reliable `showNeverViewed` boolean but only an **epoch-zero placeholder** (`recipients[].viewed.dateTime === "1970-01-01T00:00:00"`) for the timestamp — even on read messages. The **DETAIL endpoint** (`/pub/v3/messages/{id}`) carries the **real "First Viewed" timestamp** in `recipients[].viewed.dateTime` (plus top-level `read` / `firstView`). Use `showNeverViewed` (list) for the read/unread boolean, and the DETAIL endpoint for the actual view time. `mapRecipients` maps the epoch placeholder → `null`; `syncMessageFolder` and `ofw_get_message` re-fetch detail to fill in the real timestamp once a sent message flips to read (older code trusted the list `viewed` field, so sent messages were stuck reporting "never viewed").
- **Calendar event writes live at `/pub/v3/events`** (verified live 2026-07-10; the old guessed `/pub/v1/calendar/events` path 404s). POST creates (201 + full event object), `GET|PUT|DELETE /pub/v3/events/{eventRecurrenceId}` — the URL id is `eventRecurrenceId` (what listings expose as `id`), NOT the response's `eventId`. Payload is form-shaped: `startDate`/`endDate` as `YYYY-MM-DD` plus `startTime`/`endTime` as 24h `HH:mm` (all-day events still send `01:00`/`02:00` placeholders like the web form); privacy is `publicFlag` (true = shared); `reminderMinutes` and parent ids are strings; parent ids must be OMITTED when unset — sending the web form's `"0"` placeholder draws `409 {"validationErrors":[{"field":"...","text":"Must be a parent"}]}`. PUT is full-payload (no partial update) — `ofw_update_event` GETs the detail, merges changes, PUTs, then re-GETs as authoritative state. Exception: `children` behaves patch-like (verified live 2026-07-13) — omitting it from a PUT PRESERVES existing child tags, while an explicit `children: []` CLEARS them (POST also accepts `[]`); `buildEventPayload` therefore sends `children` whenever it's defined, including empty. DELETE takes `?includeFuture=<bool>` for repeating events.
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
| **You / same-repo collaborators**  | Yes                                       | Yes when Claude verdict = `pass` OR `warn` AND CI is green. Only `fail` requires a manual `ready-to-merge`. |
| **External fork PRs**              | No (workflow skips — fork PRs can't see secrets). Manual: `@claude review this` in a comment triggers `claude.yml`. | No — you merge manually after reviewing |
| **Dependabot / bots**              | No (skipped to keep noise down)           | Yes, armed immediately; merges when CI is green                                                  |

`pr-auto-review.yml` is a thin stub that calls `chrischall/workflows/.github/workflows/reusable-pr-auto-review.yml@main` on `pull_request` events; the reusable pipeline runs `claude-code-action` with a JSON-schema-bound verdict (`pass` / `warn` / `fail`). Claude (posting as `claude[bot]` via the installed Claude GitHub App) leaves inline comments on specific lines plus a top-level summary, and emits the verdict to `structured_output`. On `verdict == pass` OR `warn` the pipeline adds `ready-to-merge` via RELEASE_PAT and `auto-merge.yml` (also a stub → `reusable-auto-merge.yml@main`) arms `gh pr merge --auto`. Required status check `ci` still gates the actual merge.

The workflow uses `pull_request` (not `pull_request_target`) because Anthropic's GitHub App OIDC backend doesn't accept `pull_request_target` events (see [anthropics/claude-code-action#713](https://github.com/anthropics/claude-code-action/issues/713)). The tradeoff is that fork PRs are skipped entirely — for those, mention `@claude` in a PR comment to invoke the ad-hoc dispatch in `claude.yml`.

Verdict semantics (Claude follows the official `code-review` plugin's severity model with confidence ≥80 to count):
- `pass` — no 🔴 Important findings. Arms auto-merge.
- `warn` — at least one 🟡 Nit but no 🔴 Important. Still arms auto-merge; the nits are carried forward to an `auto-review-followup` issue (see below).
- `fail` — at least one 🔴 Important finding. Blocks: opens/updates the follow-up issue and does NOT arm `ready-to-merge`.

Override: only a `fail` needs a manual override — add `ready-to-merge` by hand and it still arms auto-merge. To suppress auto-merge on a `pass`/`warn`, remove the label or close-and-reopen the PR draft.

### Auto-review follow-up issues

When a PR's auto-review verdict is `warn` or `fail`, the `chrischall/workflows` pipeline opens or updates a single `auto-review-followup` issue ("Auto-review follow-ups for PR #N") whose checklist captures every finding, and links it from the PR's `<!-- auto-review-verdict -->` comment (`📋 Tracking follow-ups: #N`). `warn` (nits only) still auto-merges — the issue carries the nits forward, so most nits are fixed in a *later* PR; `fail` blocks until the important findings are addressed on the PR itself.

When asked to address the auto-review comments / review findings on a PR:

1. Read the verdict comment, open the linked `auto-review-followup` issue, and treat its checklist as the work list (alongside any inline review comments).
2. Resolve each item, checking off only what you've **verified** is genuinely fixed.
3. If every item is resolved on the current PR, add `Closes #<issue>` to that PR's body so the merge closes it; if some are deferred, check off only the resolved ones and leave the issue open.
4. For nits whose `warn` PR already auto-merged, address them in a follow-up PR that references `Closes #<issue>`.

(Mirrors the fleet-wide convention in `~/.claude/CLAUDE.md`.)

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

**Exception for first-party dependency bumps.** When bumping a package we own (`@chrischall/mcp-utils`, `@chrischall/realty-core`, `@fetchproxy/server` — anything published from a chrischall-owned repo), use a `feat:` or `fix:` prefix instead of `chore:`/`build(deps):` (and if you're labeling the PR, `enhancement`/`bug` instead of `dependencies`). Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden as an invisible `chore`/under "Dependencies" (which doesn't trigger a release).

Open with `gh pr create`; you don't need any labels. Let Claude's review verdict add `ready-to-merge` for you. If you want to skip the review on a trivial chore, add `--label ready-to-merge` at PR-create time and it'll arm immediately. Dependabot PRs auto-arm without it. The repo is squash-only (merge commits and rebase are blocked — `auto-merge.yml` calls `gh pr merge --auto --squash`, so every PR lands as a single squash commit whose subject is the PR title); if you call `gh pr merge` manually, don't pass `--merge`/`--rebase` or the call will fail.

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
