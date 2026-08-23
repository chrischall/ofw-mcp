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
  cache.ts          node:sqlite cache (messages, drafts, draft_lineage, attachments, sync_state, meta) with typed CRUD + findLatestReplyTip
  sync.ts           resolveFolderIds + syncMessageFolder/syncDrafts/syncAll + attachment-meta fetch
  extract/          format-agnostic content extraction (no deps, runtime-portable)
    zip.ts          minimal ZIP reader (DecompressionStream, not node:zlib)
    xml.ts          scanning XML reader (entity decode, full-tag-name matching)
    ooxml.ts        shared part-path + relationship resolution
    spreadsheet.ts  .xlsx/.xlsm → per-sheet CSV; .csv/.tsv
    document.ts     .docx → text with headings/lists/tables
    presentation.ts .pptx → per-slide text + speaker notes
    pdf.ts          .pdf → text layer (or an explicit "needs OCR" verdict)
    index.ts        extractAttachment(): format detection, part selection, char budget
  tools/
    _shared.ts      recipient mapping, response helpers, path expansion
    delivery.ts     the attachment delivery ladder (image → extracted → raw bytes)
    freshness.ts    buildFreshness() — the `freshness` block every read tool returns (source/asOf/ageSeconds/staleness/warning)
    pagination.ts   paging state that survives a lossy reader: pageState/offsetState/truncationSentinel/withPaginationFirst
    lifecycle.ts    "is this entity still what I think it is?" — classifyState/probeIds/resolveDraftKey/newDraftKey
    user.ts         ofw_get_profile, ofw_get_notifications
    messages.ts     folders, list, get, send, drafts, get_unread_sent, upload/download_attachment, sync_messages, check_freshness, status
    calendar.ts     list/create/update/delete events
    expenses.ts     totals, list, create
    journal.ts      list, create entries
tests/              mirrors src/; mocks OFWClient.request via vi.spyOn; cache tests use OFW_CACHE_DIR + tmp dir
```

Tool files use `server.registerTool(name, schema, handler)` and export `registerXTools(server: McpServer, client: OFWClient)`. `index.ts` passes those registrars to `runMcp({ tools: [...], deps: client })`, which calls each as `registerXTools(server, client)`.

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
OFW_FRESHNESS_TTL_SECONDS Optional. How long a verified-against-OFW folder stays labelled `fresh` in read tools' `freshness` block (default 300). Unusable values fall back to the default — a typo must never widen the window in which stale data reads as current.
OFW_WRITE_MODE            Optional. "none" = no write tools registered; "drafts" = draft-level writes only (ofw_save_draft, ofw_delete_draft, ofw_upload_attachment — never send or calendar/expense/journal writes); "all" = everything (default). Unrecognized values fail closed to "none". Structural gate: gated tools are not registered at all, so no host setting or injected instruction can invoke them.
OFW_ALLOW_MARK_READ       Optional. Default true (= the long-standing behaviour). "0|false|no|off" makes it a deployment-wide CEILING on reads that stamp the record: ofw_get_message refuses a fetch that would mark an unread inbox message read, ofw_check_freshness ignores allowMarkRead:true, ofw_sync_messages ignores fetchUnreadBodies:true. Unrecognized values fail closed to false (a typo must never keep stamping the record while looking configured)
OFW_FETCH_UNREAD_BODIES   Optional. "1|true|yes|on" → ofw_sync_messages fetches unread inbox bodies by default (default false). Capped by OFW_ALLOW_MARK_READ
OFW_AUTO_REFRESH          Optional. "1|true|yes|on" → when a cached read comes back EMPTY from a non-fresh cache, the read tools sync the backing folders and answer from the refreshed cache instead of refusing with UNVERIFIED_EMPTY (default false, i.e. refuse). Per-call `autoRefresh` overrides it. A refresh that does not make the read verifiable still refuses
OFW_CALENDAR_WRITES       Optional. "1|true|yes|on" → in mode "drafts", additionally register the calendar write tools (ofw_create_event, ofw_update_event, ofw_delete_event). Rationale: calendar events have no draft stage but are reversible (editable/deletable), unlike a sent message. Redundant in "all"; never overrides "none" (including the unrecognized-mode fail-closed path)
DISPLAY_TZ                Optional. IANA zone (e.g. America/New_York, the default) for every `<field>Display` value, and the zone a NAIVE source timestamp is assumed to be wall-clock in. OFW's API reports naive local times in the account's own zone, so this must match it. Unrecognized values fall back to the default rather than throwing — a typo degrades a label instead of breaking every tool. Never a fixed offset: DST comes from the IANA database, so a hardcoded -04:00 would be an hour wrong from November through March
```

## Timestamps

Every structured response goes through `jsonResponse` (`src/tools/_shared.ts`), which routes the payload through `normalizeTimestampsInValue` (`src/timestamps.ts`). That is the single seam — normalizing there rather than at each call site is what makes it impossible for a tool to reintroduce a naive value.

Each allowlisted timestamp becomes ISO-8601 **with an explicit offset**, paired with a `<field>Display` sibling carrying the weekday:

```json
"sentAt": "2026-07-27T23:31:09-04:00",
"sentAtDisplay": "Mon, Jul 27, 2026, 11:31 PM EDT"
```

Why: `sentAt`/`viewedAt`/`modifiedAt` arrived from OFW as naive local while `fetchedBodyAt`/`freshness.asOf` were stamped UTC with a `Z`, so one object mixed two zones with nothing to tell them apart. A reader assumed one zone for both and was wrong by the offset on half the fields — enough to move a 10:38 PM send onto the next calendar day, which changes which custody day it belongs to.

A field is rewritten only when the key is allowlisted **and** the value matches a timestamp shape, so user content (a message body quoting a date) is never touched. The payload is cloned first: responses carry live cache rows, and rewriting them in place would corrupt the cache.

The allowlist covers the freshness/sync bookkeeping fields (`lastServerSyncAt`, `checkedAt`, `lastVerifiedAt`, `oldestVerifiedAt`, `lastSyncAt`) as well as the message fields — they share an object with `asOf`, so omitting them put two zones back in one payload. Derive additions from a sweep of emitted field names, not from whichever field a bug report happens to name. `startDate`/`endDate` (YYYY-MM-DD) and `startTime`/`endTime` (HH:mm) are deliberately excluded: a date and a wall time are not instants.

`jsonErrorResponse` routes through `jsonResponse`, so a refusal payload carries the same normalized freshness block as the success path.

**`DISPLAY_TZ` is deployment-wide, not per-tenant.** OFW reports naive times in the *account's* zone, so a tenant outside `DISPLAY_TZ` gets the wrong offset on those values.

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
- **Send-by-draft sends the SERVER's draft, guarded like a write.** `ofw_send_message(draftId)` (or `messageId` — synonyms) runs the same stale-overwrite guard as `ofw_save_draft` (`expectedRevision` honored, cache-vs-server compare when omitted, `force:true` the only bypass), then defaults subject/body/replyToId from the **server copy the guard just read** — the artifact sent is the artifact on OFW, not what the session remembers. A draft that changed since it was read, or that is gone (it may already have been SENT — refusing prevents a double-send), refuses with the server content echoed back. The guard is skipped only when every content field is overridden AND `deleteDraftOnSuccess:false` (nothing is trusted or destroyed). Draft cleanup is automatic but strictly conditional: the draft is deleted only after a CONFIRMED send (new id returned, `verifyWriteLanded` clean, and any non-empty recipient echo covers the requested ids); on any failure/ambiguity — or `deleteDraftOnSuccess:false` — the response carries `draftRetained: true` with the reason. The response leads with `sentMessageId`, `draftKey`, `threaded`, `draftDeleted`. Attachments carry over from the server draft's `files` automatically (an explicit `myFileIDs` overrides); recipients usually must still be supplied at send time (see the draft-recipients note below).
- **The threading echo has two spellings; read both** (`threadedReplyTo`/`reportsThreaded` in `tools/_shared.ts`). OFW reports a message's reply target as top-level `replyToId` on some payloads and as `inReplyTo` (+`showContext: true`) on others — observed live: threaded draft saves came back `replyToId: null` while the same payload carried `inReplyTo`. Reading only `replyToId` fired a false "OurFamilyWizard did not thread this draft" warning on nearly every threaded save, which trains callers to skim warnings. Every reader of the echo — `ofw_save_draft`'s audit, `ofw_send_message`'s `threaded` verdict, `syncDrafts`' row mapping, `fetchMessageSnapshot` — derives one value through `threadedReplyTo`, so top-level `replyToId`/`inReplyTo` always agree with `listData` and the revision hashed from a save matches the one the next sync computes. Threading warnings fire only on POSITIVE evidence of a drop (`reportsUnthreaded`): `inReplyTo`/`showContext` present and negative. A bare `replyToId: null` is NOT evidence — OFW emits that on items that ARE threaded — and total absence of the echo fields is "not echoed", never "dropped".
- **OFW does not persist recipients on drafts.** Every draft save comes back with `recipients: []` no matter what was posted. That is documented behavior, surfaced once per save as a `recipientsNote` (NOT a per-call warning — it fired on every single save and desensitized the caller); a PARTIAL echo that differs from the request still warns. Consequence: `ofw_send_message(draftId)` requires `recipientIds` whenever neither the server draft nor the cached row carries a non-empty set — it never defaults to `[]`, which would "send" to nobody. The upside is a structural accidental-send guard: a draft alone cannot name a recipient.
- **Stale-overwrite guard on destructive draft ops** (`src/tools/draft-freshness.ts`): `ofw_save_draft` (with `messageId`), `ofw_delete_draft` and `ofw_send_message` (with `draftId`) re-read the draft from OFW *before* touching anything and refuse unless the caller is provably current with it. Refusals are `isError` payloads (`STALE_DRAFT` / `MISSING_DRAFT` / `FRESHNESS_CHECK_FAILED`) that always carry `serverBody`, so the content we declined to destroy is recoverable from the tool result. `force: true` is the only bypass; it logs to stderr and echoes the discarded server version. A freshness check that *fails* aborts — never falls back to a blind overwrite.
  - **The token is a content revision, NOT a timestamp.** OFW's draft `date.dateTime` is not a modification time — editing a draft in the web app does not bump it (this is why `syncDrafts` fetches every draft's detail unconditionally, and why commit 8295e72 removed the old modifiedAt check). An `expectedModifiedAt` precondition would compare *equal* across exactly the edit it exists to catch. `draftRevision()` hashes subject + body + replyToId + the sorted recipient-id set instead; reads expose it as `revision`, writes accept it as `expectedRevision`. Omitting it never means "force" — the tool falls back to comparing the server against the cached base.
  - **The conflict decision turns on SUBSTANTIVE fields, not on any revision delta.** `checkDraftFreshness` (via `SUBSTANTIVE_FIELDS` = subject/body/recipients) refuses only when the *content* diverged. OFW normalizes `replyToId` server-side *after* a draft is saved (dropping it, or re-targeting it to the thread tip) — that is our own post-save mutation resurfacing on a later read, not third-party interference, so a `replyToId`-only drift is FRESH with `metadataOnly: true` (the guard adds a NOTE, and the write proceeds). Treating that delta as `STALE` was a false positive that fired even when `serverBody === cachedBody`, and it trains callers to distrust — or `force:true` past — a guard that has prevented real data loss. The fail-safe direction is untouched: the instant subject/body/recipients differ, it still refuses. This applies on BOTH the `expectedRevision` and the no-token (cache-vs-server) paths.
  - **A successful save returns the post-normalization `revision`.** The stored `replyToId` (and the returned `revision`) come from the re-fetched detail truthfully (`detail.replyToId ?? null`) — NOT the old `?? resolvedReplyTo`, which masked OFW's drop with the value we *intended* to post, producing a `revision` that was stale on arrival (a self-inflicted `STALE_DRAFT` on the caller's very next edit) and hiding a dropped reply link. So `revision` from `ofw_save_draft` matches what a following `ofw_get_message` / `ofw_check_freshness` observes.
  - **No silent field drops on save/replace (Defect 3).** After the POST + detail GET, `ofw_save_draft` audits every field the caller supplied against what actually landed: a requested `replyToId`, `recipientIds`, or `myFileIDs` that OFW did not carry over becomes a `warnings[]` entry (and a visible `WARNING` line), never a silent null. The response echoes the effective threading as `replyToId` + `inReplyTo`. Recipients/attachments are only audited when the detail actually *reported* them (an omitted array is "not echoed", not "dropped" — crying wolf there would desensitize the caller). The replace-path `NOTE` lists which fields were carried over to the new id and points at the warnings when any were lost.
- **`ofw_save_draft` replace path**: when the caller passes `messageId`, the tool does NOT call OFW's update-in-place endpoint (POST `/pub/v3/messages` with `messageId` in the payload). That endpoint silently no-ops on subsequent updates while echoing the posted body in the immediate GET — there's no honest way to detect the no-op from the API. Instead `ofw_save_draft` always POSTs without `messageId` (creating a fresh draft), then DELETEs the old draft afterward. The response's `id` is the NEW id; a transparency `NOTE` explains the swap. If the old-draft delete fails, the response carries a `WARNING` and the new draft is still committed.
- **Draft routing in `ofw_get_message`**: drafts and messages share an ID space and the same `/pub/v3/messages/{id}` endpoint. When a caller asks for an id that exists in the drafts cache, `ofw_get_message` returns a synthesized `MessageRow` with `folder: 'drafts'` (alongside the usual `inbox`/`sent`), `fromUser: ''`, and `sentAt`/`fetchedBodyAt` mirroring the draft's `modifiedAt`. The drafts table is the source of truth for that id; any stale row in the messages table is evicted on the next sync (`syncDrafts` calls `deleteMessage` after `upsertDraft`).
- Drafts folder ID is resolved dynamically via `/pub/v1/messageFolders` and persisted in the `meta` table
- `syncDrafts` walks every page of the drafts folder (50/page until a short page). This matters because its reconciliation step deletes any cached draft not seen in the listing — a partial walk would evict real drafts
- **Every read announces its own freshness** (`src/tools/freshness.ts`). `ofw_list_messages`, `ofw_list_drafts`, `ofw_get_message`, `ofw_list_message_folders` and `ofw_sync_messages` all return a `freshness` block (`source`, `asOf`, `ageSeconds`, `staleness`, `lastServerSyncAt`, `syncComplete`, `historyComplete`, `warning`). This exists because an assistant asserted "both drafts are still sitting unsent" from its own session memory, never re-reading — cached data that *looks* authoritative with nothing marking its age. `staleness` is `fresh` only when fetched live or verified inside `getFreshnessTtlSeconds()`; non-`fresh` always carries a `warning` naming the age and reason. Downgrade-only on uncertainty: a false `unverified` costs a call, a false `fresh` reproduces the bug.
  - **Two clocks, not one.** `sync_state.last_sync_at` is written on every call *including a paused one*, so it means "we tried", never "we're current". The `folder_verified_at:<folder>` meta key (`markFolderVerified`/`getFolderVerifiedAt`) advances only when the folder was actually diffed: for inbox/sent when the FORWARD pass completed, for drafts when the full walk + reconciliation ran. `buildFreshness` compares them — `lastSyncAt > verifiedAt` means a sync ran and skipped this folder, which downgrades to `unverified` no matter how recent the older stamp is.
  - **A parked backfill does NOT downgrade staleness.** It sets `historyComplete: false` and adds a warning line, but leaves `staleness` alone. The forward pass runs from page 1 on every call, so the present is current even mid-backfill — and letting a months-long backfill mark every read `unverified` would train the caller to ignore the warning entirely, reproducing the bug by another route.
  - **`serverConfirmed` is the draft-specific answer.** True only when a completed drafts walk verified inside the TTL. `ofw_list_drafts`/`ofw_get_message` reconcile the reported `cacheStatus` with `freshness.staleness` (downgrade-only, `draftsFreshness` in `tools/messages.ts`) so one payload can never contradict itself — the same rule `withReadState` applies to read flags.
  - **`ofw_list_drafts` auto-verifies by default** (`verify: true`): when the drafts cache is not verified-fresh, it runs the (cheap — one list page + one detail per draft) drafts sync first and answers server-confirmed in one call. `autoVerified: true` is derived from the POST-sync cache status — a budget-paused walk never claims it — and a sync that cannot reach OFW degrades to the labelled cache answer with a `verifyNote` instead of erroring the read. Drafts change rarely but INVISIBLY (a web-app edit bumps no timestamp), so the old behavior — a 12-minute-old cache answering "unverified, don't state a count" — forced a second call on every ordinary read. `verify:false` restores the pure cache read; a sync the budget pauses leaves the response honestly unverified.
  - **`ofw_check_freshness`** is the cheap re-verification primitive: one request for folder counts + one per id, no bodies, no sync, decoupled from the attachment path. Ids are compared by `draftRevision()` content hash, NOT `modifiedAt` — OFW's draft timestamp doesn't move on a web-app edit, so a timestamp precondition would compare equal across exactly the edit it exists to catch. It probes only ids present in the drafts cache unless `allowMarkRead: true`: any other id means a detail GET, which marks an unread inbox message read on OFW. Folder verdicts stay `inSync: null` while `historyComplete` is false or OFW reports no count — a partially backfilled folder legitimately holds fewer rows, and crying wolf for the whole backfill would desensitize the caller.
- **Paging state is emitted BEFORE the data array, and a truncated array carries a marker inside it** (`src/tools/pagination.ts`). A correct response is not the same as a response that survives being read. Three wide date-range reads returned `complete:false` with a `note` AND a `completeNote` spelling out "60 of 391, increase page" — every signal working — and the caller still reported a month as unreachable, because the responses were big enough that the client spilled them to a JSON file and a script pulled out only `total` and `messages`, discarding every field that said "slice". So:
  - **Key order is load-bearing, not cosmetic.** `ofw_list_messages`, `ofw_list_drafts` and `ofw_get_unread_sent` emit `complete`/`hasMore`/`nextPage`/`total`/`page`/`size`, then the notes, then `freshness`, and the data array (`messages`/`drafts`/`unread`) LAST. A `head`, a truncated preview or a first-N-keys read then reaches "this is a slice" before it reaches the first message body. An object literal's insertion order is what `JSON.stringify` emits, so this costs nothing — and `tests/tools/messages.test.ts` asserts it on the serialized text, because rebuilding one of those literals undoes it silently.
  - **`nextPage` states the remedy; `complete:false` only implies one.** Null when nothing remains. It is derived from the OFFSET (`page * size < total`), never from `returned < total` — on a page past the end those disagree, and the naive form advertises a next page that returns nothing forever.
  - **The sentinel rides inside `messages`, and only there.** A truncated `ofw_list_messages` array ends with `{_truncated:true, shown, total, nextPage, hint}` — iterating or slicing the array is exactly what a field-extracting consumer does, so it is the one code path guaranteed to touch it. It carries no `id`/`subject`/`sentAt`, so an id-keyed consumer skips it. NOT in `drafts[]`: those elements' `id`/`draftKey`/`revision` are what `ofw_save_draft`/`ofw_delete_draft`/`ofw_send_message` are called with, so a non-record there can reach a destructive call site. NOT in `unread[]`: that is a verdict list, routinely empty while the scan is truncated, and a marker would turn "nobody has unread mail" into a count of 1.
  - **`ofw_list_expenses`/`ofw_list_journal_entries` get the same treatment through `withPaginationFirst`**, with `nextStart` rather than `nextPage` because they are `start`/`max` offset tools — it is always the literal value to pass back. Their upstream shape is an unvalidated passthrough, so an object payload is spread in behind the paging keys (every upstream key preserved, only the order changes) while a bare-array payload is nested under a named key with a `dataShapeNote` saying so — an array cannot carry sibling keys. With no upstream total, a FULL page is reported as probably-more: a wasted call beats a hidden page. `ofw_list_events` is a date-range read with no paging at all and is untouched.

- **Freshness answers "how old?"; it never answered "is this still what I think it is?"** (the sent-draft failure). An assistant tracked three draft ids across many turns and recited them as current; one had been SENT the night before. Every existing signal was working — it just was not re-read. Three closures, all of them structural:
  - **`state` in the cheap check** (`src/tools/lifecycle.ts`). `ofw_check_freshness` and `ofw_status` return a LIVE `state` per id — `draft` | `sent` | `received` | `deleted` | `unknown` — derived from the folder id in OFW's own detail payload (mapped through `inbox_folder_id`/`sent_folder_id`/`drafts_folder_id` in `meta`, which `resolveFolderIds` persists; `ensureFolderIdMap` resolves them live for one request when the cache has never held them). When the id is unreported or unmapped, the folder NAME OFW itself put on the payload ("Drafts"/"Sent"/"Sent Messages"/"Inbox", case-insensitive) is a fallback with the same authority — every live probe once answered `unknown` while echoing `it reported "Drafts"`, a refusal to read OFW's own answer. Only a folder unmappable by BOTH id and name is `unknown`. **`existsOnServer` cannot answer this and never could**: a draft that was sent still exists, as a sent message, so `existsOnServer: true` came back for exactly the id the whole question was about. For the same reason a cached draft whose state is no longer `draft` reports `inSync: false` even when its subject and body are byte-identical — a revision-only comparison votes "in sync" on precisely the case that matters. `inSync: null` means NOT COMPARED (no cached draft, or content matches but OFW reported no mappable folder) — never `false`, which claims a drift was detected. `unknown` is a refusal to answer, not a synonym for "fine".
  - **Probing is gated exactly like a body read, and plans its skips first.** A probe is `GET /pub/v3/messages/{id}`, which stamps an unread INBOX message. `probeWouldStamp` waves through what cannot stamp — a cached draft (no read state), a cached SENT message (view times belong to the recipient), an already-read inbox message (`deriveRead` is monotonic) — and refuses an id with no cached row, because whether it would stamp is what cannot be known without making the request that stamps it. `probeIds` decides every skip BEFORE fetching anything, so a call whose ids are all refused spends zero requests, including the folder-map resolve.
  - **No read reports an absence it cannot verify** (`guardedCacheRead` / `unverifiedEmptyResponse`). `ofw_list_messages`, `ofw_list_drafts` and `ofw_get_unread_sent` refuse an EMPTY result whenever the backing cache is not `fresh`, returning `result: "UNVERIFIED_EMPTY"` with a `remedy` instead of `[]`. An empty list carrying a 207-minute-old freshness warning is shaped identically to a verified "nothing there", and the natural next sentence off one is a false negative stated as fact. A false negative is worse than a refusal precisely because it reads as definitive. Non-empty results are never touched — a stale cache that DID find something is evidence of presence. `autoRefresh: true` (or `OFW_AUTO_REFRESH`) turns the refusal into sync-then-retry; a refresh that does not make the read verifiable still refuses. An invalid `folderId` is likewise an `INVALID_FOLDER` error with NO `messages` key, not an empty list with a note.
  - **`complete` describes the RESULT SET, not the sync.** `syncComplete`/`historyComplete` live in `freshness` and describe the walk that filled the cache; neither answers "have I now seen all of them?". `complete: true` means "this payload holds every matching item on OFW as of `asOf`" — full slice AND verified AND no parked backfill — so a caller has ONE boolean to check before saying "you have N drafts". `completeNote` names which condition failed.
- **A draft's identity is `draftKey`, not its id** (`draft_lineage` table, schema v3). `ofw_save_draft` replaces by create-then-delete, so every edit mints a new OFW id — one real session burned ten ids on one message, with nothing linking them. A `draftKey` is minted on first save, carried across every replacement, retroactively adopted for a draft that predates the mechanism, and extended onto the SENT message by `ofw_send_message`. Without that last step the chain would dead-end at the final draft id and `ofw_status` would answer `deleted` — true of that id, and the exact wrong impression. `resolveDraftKey` returns the chain tip (ordered `recorded_at, id` — same-millisecond links tie-break on id, and OFW mints ids monotonically, so the replacement always sorts last).
- **`ofw_status` is the call that backs a status summary.** One round trip: bare `ofw_status()` returns the full server-verified draft inventory; `ids`/`draftKeys` return live lifecycle states (deduped — a key and a bare id naming the same message are probed once). Top-level `complete` is true only when EVERY part was verified live, and `incompleteReasons` says what wasn't. The design goal is that verification is cheaper than recollection: if confirming a summary costs one call and returns an unambiguous answer, there is no incentive to narrate remembered state.
- **Drafts sync FIRST, and its count never lies.** `syncAll` reorders the requested folders to put `drafts` ahead of inbox/sent. Drafts are the only folder a destructive tool reads as its base, and they're cheap (one list page + one detail each); running them last meant a bounded call (`OFW_SYNC_MAX_REQUESTS`) spent its whole budget backfilling history and deferred drafts on *every* call. A deferred walk now reports **no** `drafts` key at all rather than `drafts: 0` — reporting 0 reads as "verified, no changes", and that lie is what let a web-app draft edit be silently overwritten. `drafts: 0` is emitted only after a complete walk actually diffed against OFW. The `drafts_cache_status` meta key (`fresh` | `unverified`, via `getDraftsCacheStatus`) records which happened; `ofw_list_drafts` / `ofw_get_message` surface it per draft as `cacheStatus`.
  - **That rule now covers every folder, not just drafts.** `syncAll` reports `refreshed` / `notRefreshed` / `syncComplete`, and omits the `synced` key for any folder it didn't diff — `inbox: 0` was the same lie as `drafts: 0`, just less noticed. A folder is "refreshed" when its FORWARD pass completed (`MessageSyncResult.verified`), which is distinct from `done`: a call can verify the present while still owing old history

## Response validation (issue #83)

Every JSON response is validated with zod at the call site via `parseLenient(schema, raw, { label, context, mode })` from `@chrischall/mcp-utils` (the fleet helper that consolidated ofw's old `parseOFW`). Schemas are `z.looseObject(...)` covering ONLY the fields the code reads — unknown keys pass through (and survive into cached `listData`/`metadata`). Pass `label: 'ofw-mcp'` and a per-call `context` string. Two modes:

- **lenient** (default) — all read/sync paths. Mismatch → structured stderr warning (`[ofw-mcp] WARNING: unexpected <context> shape …`) naming the endpoint and fields, then the RAW response flows on through the existing `??` fallbacks. An OFW backend change degrades gracefully but never silently.
- **strict** (`mode: 'strict'`) — write boundaries (`postMessageAndRefetch`'s POST + detail GET, `ofw_upload_attachment`). Mismatch → throw an `McpToolError`: proceeding on an unverifiable response risks deleting a draft, mis-reporting a send, or caching an unusable fileId. Absence of optional fields stays legal (handled by `verifyWriteLanded` WARNINGs); a present-but-mistyped field throws.

When adding a new endpoint call, define a loose schema next to the call site and wrap the `client.request` in `parseLenient`. Sibling MCPs copy this pattern.

## OFW API Notes

- **Recipient view status has two sources that disagree** (verified against live payloads): the LIST endpoint (`/pub/v3/messages?folders=...`) carries the reliable `showNeverViewed` boolean but only an **epoch-zero placeholder** (`recipients[].viewed.dateTime === "1970-01-01T00:00:00"`) for the timestamp — even on read messages. The **DETAIL endpoint** (`/pub/v3/messages/{id}`) carries the **real "First Viewed" timestamp** in `recipients[].viewed.dateTime` (plus top-level `read` / `firstView`). Use `showNeverViewed` (list) for the read/unread boolean, and the DETAIL endpoint for the actual view time. `mapRecipients` maps the epoch placeholder → `null`; `syncMessageFolder` and `ofw_get_message` re-fetch detail to fill in the real timestamp once a sent message flips to read (older code trusted the list `viewed` field, so sent messages were stuck reporting "never viewed"). For the same reason `syncMessageFolder`'s **new-message** path takes `recipients` from the detail response it already fetches for the body, falling back to the list item only when detail omits them — a message that was already read by the time we first cached it would otherwise be stored `viewedAt: null` and report "never viewed" until a later sync's refresh healed it. The recipient id lives at `recipients[].user.userId` (verified live, e.g. `3039201`) — NOT `user.id`, which is absent; `mapRecipients` reads `userId` (with `id` as a legacy fallback), so a "find my own recipient entry" match resolves instead of collapsing every recipient to `userId: 0`.
- **Reading is a WRITE to the record, and it is gated separately from `OFW_WRITE_MODE`** (issue #192). Fetching a message body marks it read on OFW and stamps a "First Viewed" timestamp the co-parent can see — court-visible, irreversible, and produced as a side effect of an ordinary read, so nothing about the caller's intent signals it. `OFW_WRITE_MODE` does not model this: `ofw_get_message`, `ofw_sync_messages` and `ofw_check_freshness` are registered in every mode including `none`, so even the strictest write setting permits stamping. `markReadVerdict` (`tools/messages.ts`) gates the ONE path that stamps — the live body fetch for an unread INBOX message — and waves through everything that cannot: a cached body (the cache already served it), a SENT message (its view times belong to the recipient), and an already-read message (`deriveRead` is monotonic, so the stamp exists and cannot be added twice). An id with no cached row is refused rather than guessed at: whether it would stamp is exactly what cannot be known without making the request that stamps it, and `ofw_sync_messages` walks list pages, not bodies, so syncing first resolves it without cost. Defaults are unchanged in every direction — `allowMarkRead` defaults to true and `OFW_ALLOW_MARK_READ` unset means true — so this adds a gate without moving anyone through it. `OFW_ALLOW_MARK_READ=false` is a CEILING, not a default: a per-call `allowMarkRead:true` (or an instruction injected into one) cannot raise it, the same structural posture `OFW_WRITE_MODE` takes for writes.
- **Read state is derived, never trusted from the frozen list flags.** The list-endpoint `read` / `showNeverViewed` flags are captured once, when a message is first scraped, and go stale the moment it's read afterward — most often when a body fetch (`ofw_get_message`) marks an inbox message read on OFW, populating `fetchedBodyAt` and the recipient's `viewedAt` but leaving `read: false` behind. `deriveRead` / `withReadState` (`tools/_shared.ts`) recompute an authoritative `read` at read time from the record's own signals and force the returned `listData.read` / `showNeverViewed` to agree, so a single response can't contradict itself. The derivation is **monotonic** (every signal only turns read ON), so a resync that re-scrapes the stale flags can never flip a read message back to unread. It is folder-aware: for INBOX any recipient's `viewedAt` counts (co-parent threads are 1:1, so the sole inbox recipient is the account holder) and `fetchedBodyAt` counts as read; for SENT "read" means a *recipient* viewed it (via their `viewedAt`) — our own body fetch, always set for sent, never counts. It deliberately does not match the account holder's own `userId`: no non-mutating endpoint exposes it (`/pub/v2/profiles` has no numeric id; `useraccountstatus` updates last-seen as a side effect), and rows cached before the `user.userId` parse fix hold `userId: 0`, so an id match would silently fail on historical data. See the `deriveRead` docstring before reintroducing one. `ofw_list_messages` and `ofw_get_message` surface the reconciled `read`.
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

The branch-and-PR shape is still required because `main` is protected by **two** rulesets: *Block force-push and deletion on main* and *main protection (PR + ci)* — the latter requires every change to go through a PR and `ci` to pass (strict mode: the branch must be up to date with `main`). No bypass actors; admins are not exempt. Inspect with `gh api /repos/chrischall/ofw-mcp/rulesets`.

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
- **Attachment MIME is always normalized to a bare media type** (`src/tools/attachments.ts`: `normalizeMimeType` / `sniffImageMime` / `resolveDownloadMime`). OFW returns `image/png;charset=UTF-8` on binary attachments, and a host's image renderer rejects any `;`-parameter suffix (`Image format 'image/png;charset=UTF-8' is not currently supported`). `ofw_download_attachment` resolves the type in priority order — magic-number sniff (PNG/JPEG/GIF/WEBP; bytes never lie) → parameter-stripped `Content-Type` header → filename extension — so no returned `mimeType` ever carries a parameter.
- **A successful fetch always produces readable content — the delivery ladder** (`src/tools/delivery.ts`, `src/extract/`). Rendering is a DISPLAY concern; content is a DATA concern, and the first must never decide the second. Inline delivery returns the first rung that works: (1) host-renderable image → `ImageContent`; (2) extractable file → its TEXT (`extracted`, see below); (3) anything else → an `EmbeddedResource` blob of the raw bytes. `deliveredVia` names the rung; when it falls to (3), `deliveryAttempts` says why by name. The bug this closes: a host renders four image types and rejects every other embedded resource outright (`Resources of type 'application/vnd.…spreadsheetml.sheet' are not currently supported`), so a 10 KB custody-schedule .xlsx was fetched successfully and was unreadable by any route — rung (3) had existed all along and was never the problem.
  - **Extraction is dependency-free and runtime-portable** (`src/extract/`): a ZIP reader over `DecompressionStream` (NOT `node:zlib`, so the extractors stay runtime-portable), a scanning XML reader, then per-format extractors — `.xlsx/.xlsm` (per-sheet CSV, shared strings, cached formula values, ISO dates from serials + styles), `.csv/.tsv`, `.docx` (headings/lists/tables), `.pptx` (per-slide text + speaker notes via the slide's rels, NOT by matching file numbers), `.pdf` (text layer from content-stream operators), and text formats.
  - **Decompression is capped on the bytes that ARRIVE, not on the size the file declares** (`src/extract/inflate.ts`, 32 MiB). Attachments are co-parent-supplied, and both container formats let the file describe itself: a ZIP central directory can claim 1 KB in front of a member that expands to a gigabyte, and a PDF stream dictionary declares no inflated length at all. The declared size is still pre-checked — it rejects an HONEST oversized member without inflating anything — but it is an optimization, and a comment claiming it was the guarantee was the actual defect (#186). `DecompressionLimitError` is distinct from a decode failure on purpose: `pdf.ts` swallows a corrupt stream (that page just has no text) and RETHROWS a cap breach, because quietly returning a document with pages missing is the worse answer for a hostile file.
  - **A `<tag …/>` must not swallow its sibling.** `elements()`' attribute run is LAZY and stops short of the closing `/`. A greedy `[^>]*` eats that slash, the `>` arm then matches, and the scan runs on to the NEXT element's closing tag — merging two siblings into one. Every `<xf/>` style index in a real workbook shifted by one, and a General-formatted `2026` printed as `1905-07-18`. Fixture tests missed it (a self-closing tag with NO attributes backtracks correctly); the real attachment caught it.
  - **A truncated extraction always says so.** `maxChars` (default 50k) clips on a row/line boundary, sets `truncated`, and lists whatever was dropped whole in `extracted.omitted`; `parts` (`"1-3,5"`, or a sheet name — a bare number matches EITHER a position or a name, because spreadsheet tabs are routinely named for a year) filters BEFORE a part is decompressed, so a ranged request over a large file is cheap. Silence about a partial custody schedule reads as the whole schedule.
  - Extraction and raw bytes are mutually exclusive by design: when content is extracted the blob is NOT also attached (it is the payload the host rejects, at double the response size). `extract:false` gets the bytes back; in disk mode `extract:true` returns the saved path AND the content.
- **Where there is no disk, inline is the ONLY channel** and must never dead-end. `AttachmentIO.supportsDisk` is `true` on `NodeAttachmentIO`; a filesystem-free implementation reports `false`. `ofw_download_attachment` computes `inline = requestedInline || !supportsDisk`: an explicit `inline:false` on a no-disk deployment is *forced* to inline (bytes still returned) rather than erroring on a disk write, and the response's meta block carries `forcedInline: true` so the override is honest rather than silently ignored. The old failure — reject disk AND fail inline (bad MIME) → attachment unreadable by any route — is now structurally impossible. A `saveTo` on a no-disk deployment therefore never costs the caller the content: it is forced inline and still walks the delivery ladder.
- **AI-maintained**: README warns this codebase is built and maintained by Claude; `src/index.ts` prints the same notice to stderr on startup
