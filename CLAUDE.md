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
@chrischall/mcp-connector  npm dependency (devDep) — the shared OAuth + streamable-HTTP connector harness, its own repo/tests; worker.ts imports createConnector from it. Peer deps (agents, @cloudflare/workers-oauth-provider, @modelcontextprotocol/sdk) are devDeps here so the Worker bundles one copy
wrangler.jsonc       Worker config (bindings: OAUTH_KV, CACHE_DO Durable Object; sets OFW_INLINE_ATTACHMENTS=true; OFW_WRITE_MODE defaults to "all"; OFW_SYNC_MAX_REQUESTS="40" bounds sync under the subrequest cap)
```

**Bounded, resumable sync on the Worker.** Cloudflare caps subrequests per request (50 Free / 1000 Paid); each OFW API fetch and each `OFWCacheDO` cache RPC counts. `getSyncMaxRequests()` (from `OFW_SYNC_MAX_REQUESTS`, set to `"40"` in `wrangler.jsonc`) caps how many OFW requests one `ofw_sync_messages` call makes before pausing; the walk resumes on the next call, so a large backfill runs over repeated calls. On the Workers Paid plan raise it (~900). Unset (the local stdio default) → unbounded, walks fully in one call. See [`docs/DEPLOY-CONNECTOR.md`](docs/DEPLOY-CONNECTOR.md#sync--the-subrequest-limit).

**Two-pass sync: forward then backfill.** `syncMessageFolder` runs two passes over one shared budget (`walkPages` is the shared walker):

1. **FORWARD** — always from page 1, on *every* call, no matter how deep a backfill is parked. Stops at the first page holding no new messages (OFW sorts date-desc, so that page is where cached history begins). Once caught up it costs a single request. This is what guarantees a just-sent/just-received message is cached by the next ordinary sync.
2. **BACKFILL** — resumes `SyncState.resumePage` (or, for `deep`, walks on past where the forward pass stopped) with the *remaining* budget, and re-parks the cursor if it pauses again. It always walks to an empty page, never stopping at an all-cached one: a backfill runs below cached history by construction, so "this page is all cached" says nothing about what is underneath.

The forward pass draws on the budget first — the newest messages are what callers need, and history that has waited months can wait one more call. **`resumePage` must never gate the forward pass.** It once did (a single shared cursor for both concerns), and the result was that a long backfill *starved new messages indefinitely*: every call resumed deep in old history, page 1 was never re-fetched, and a message sent after the backfill began stayed invisible until the entire backfill finished. If the forward pass itself pauses, the cursor moves *up* to its pause point (`min` with any saved cursor) — it never reached cached history, so the pages below it are unverified.

Two vitest configs: `vitest.config.ts` (node pool, 100% gate on `src/**`, excludes `src/index.ts` + the Worker-only files `src/worker.ts`/`src/cache/durable.ts`) and `vitest.workers.config.ts` (Workers runtime pool for `tests/worker*.test.ts`). Scripts: `npm run worker:dev` (wrangler dev), `npm run worker:deploy` (wrangler deploy), `npm run worker:test` (Workers-pool suite). **Deploy is manual** — a one-time-per-operator process with no CI/CD path; see [`docs/DEPLOY-CONNECTOR.md`](docs/DEPLOY-CONNECTOR.md). Worker-only files MUST stay in `vitest.config.ts`'s `coverage.exclude` and must never be imported by a node (`tests/**`) test, or the node pool will fail to load `cloudflare:workers`.

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

- **Recipient view status has two sources that disagree** (verified against live payloads): the LIST endpoint (`/pub/v3/messages?folders=...`) carries the reliable `showNeverViewed` boolean but only an **epoch-zero placeholder** (`recipients[].viewed.dateTime === "1970-01-01T00:00:00"`) for the timestamp — even on read messages. The **DETAIL endpoint** (`/pub/v3/messages/{id}`) carries the **real "First Viewed" timestamp** in `recipients[].viewed.dateTime` (plus top-level `read` / `firstView`). Use `showNeverViewed` (list) for the read/unread boolean, and the DETAIL endpoint for the actual view time. `mapRecipients` maps the epoch placeholder → `null`; `syncMessageFolder` and `ofw_get_message` re-fetch detail to fill in the real timestamp once a sent message flips to read (older code trusted the list `viewed` field, so sent messages were stuck reporting "never viewed"). For the same reason `syncMessageFolder`'s **new-message** path takes `recipients` from the detail response it already fetches for the body, falling back to the list item only when detail omits them — a message that was already read by the time we first cached it would otherwise be stored `viewedAt: null` and report "never viewed" until a later sync's refresh healed it. The recipient id lives at `recipients[].user.userId` (verified live, e.g. `3039201`) — NOT `user.id`, which is absent; `mapRecipients` reads `userId` (with `id` as a legacy fallback), so a "find my own recipient entry" match resolves instead of collapsing every recipient to `userId: 0`.
- **Read state is derived, never trusted from the frozen list flags.** The list-endpoint `read` / `showNeverViewed` flags are captured once, when a message is first scraped, and go stale the moment it's read afterward — most often when a body fetch (`ofw_get_message`) marks an inbox message read on OFW, populating `fetchedBodyAt` and the recipient's `viewedAt` but leaving `read: false` behind. `deriveRead` / `withReadState` (`tools/_shared.ts`) recompute an authoritative `read` at read time from the record's own signals and force the returned `listData.read` / `showNeverViewed` to agree, so a single response can't contradict itself. The derivation is **monotonic** (every signal only turns read ON), so a resync that re-scrapes the stale flags can never flip a read message back to unread. It is folder-aware: for INBOX the account holder is the recipient (matched by `selfUserId` when known, else any recipient) and `fetchedBodyAt` counts as read; for SENT "read" means a *recipient* viewed it (via their `viewedAt`) — our own body fetch, always set for sent, never counts. `ofw_list_messages` and `ofw_get_message` surface the reconciled `read`.
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

**The `skill-path` input is mandatory here.** `chrischall/workflows`' `mcp-publish` action auto-discovers the skill to package as the `.skill` artifact (and to push to ClawHub): an explicit `skill-path`, else a root `SKILL.md`, else a *single* `skills/*/SKILL.md`. This repo has TWO (`skills/ofw` + `skills/ofw-fpx`), so auto-discovery hard-fails the publish job with `Multiple skills/*/SKILL.md found — set the skill-path input`. `.github/workflows/release-please.yml` therefore pins `skill-path: skills/ofw/SKILL.md`. If you add or rename a skill directory, that pin is what keeps releases publishing — don't drop it.

This bit once: v2.6.0/2.6.1/2.6.2 were all tagged and had GitHub Releases created, but their publish jobs failed, so **npm sat at 2.5.0 while three releases looked done**. The release-please job and the publish job are separate — a green tag does not mean a green publish. After any release, confirm with `npm view ofw-mcp version`.

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

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.

Repo-specific: PR handling here is **source-aware**.

| PR author | `auto-review` | Auto-merge |
|---|---|---|
| You / same-repo collaborators | Yes | Yes on `pass` OR `warn` + green CI |
| External fork PRs | No — the workflow skips them (fork PRs can't see secrets). Comment `@claude review this` to trigger `claude.yml`. | No — merge manually after review |
| Dependabot / bots | No (skipped to keep noise down) | Yes, armed immediately; merges on green CI |

The fork gap is structural: the workflow uses `pull_request`, not
`pull_request_target`, because Anthropic's GitHub App OIDC backend rejects
`pull_request_target` ([claude-code-action#713](https://github.com/anthropics/claude-code-action/issues/713)).

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
