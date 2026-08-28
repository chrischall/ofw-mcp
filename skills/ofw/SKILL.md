---
name: ofw
description: This skill should be used when the user asks about OurFamilyWizard (OFW) co-parenting data. Triggers on phrases like "check OFW", "OurFamilyWizard inbox", "OFW messages", "OFW calendar", "OFW expenses", "what did my co-parent say", "log an expense in OFW", "OFW journal", or any request involving co-parenting messages, calendar events, shared expenses, or journal entries.
---

# ofw-mcp

MCP server for OurFamilyWizard — provides read/write access to messages, calendar, expenses, and journal.

- **npm:** [npmjs.com/package/ofw-mcp](https://www.npmjs.com/package/ofw-mcp)
- **Source:** [github.com/chrischall/ofw-mcp](https://github.com/chrischall/ofw-mcp)


## Setup

### Option A — Claude Code (direct MCP, no mcporter)

Add to `.mcp.json` in your project or `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "ofw": {
      "command": "npx",
      "args": ["-y", "ofw-mcp"],
      "env": {
        "OFW_USERNAME": "you@example.com",
        "OFW_PASSWORD": "yourpassword"
      }
    }
  }
}
```

### Option B — mcporter

#### 1. Install

```bash
npm install -g ofw-mcp
```

Or from source:
```bash
git clone https://github.com/chrischall/ofw-mcp
cd ofw-mcp
npm install && npm run build
```

#### 2. Configure credentials

```bash
cp .env.example .env
# Edit .env: set OFW_USERNAME and OFW_PASSWORD
```

#### 3. Register with mcporter

```bash
mcporter config add ofw \
  --command "ofw-mcp" \
  --env "OFW_USERNAME=you@example.com" \
  --env "OFW_PASSWORD=yourpassword" \
  --config ~/.mcporter/mcporter.json
```

#### 4. Verify

```bash
mcporter list --config ~/.mcporter/mcporter.json
mcporter call ofw.ofw_get_profile --config ~/.mcporter/mcporter.json
```

## Calling tools (mcporter)

```bash
mcporter call ofw.<tool_name> [key=value ...] --config ~/.mcporter/mcporter.json
```

Always pass `--config ~/.mcporter/mcporter.json` unless a local `config/mcporter.json` exists.

## Tools

### User
| Tool | Description |
|------|-------------|
| `ofw_get_profile` | Current user + co-parent info (IDs, contact details) |
| `ofw_get_notifications` | Dashboard summary: unread count, upcoming events, outstanding expenses. ⚠️ Updates last-seen status. |

### Messages
| Tool | Notes |
|------|-------|
| `ofw_sync_messages(folders?, deep?, fetchUnreadBodies?)` | Sync OFW → local cache. **Call first if the cache might be stale.** Returns unread inbox hints (bodies not fetched, to avoid mark-as-read). |
| `ofw_list_message_folders` | List OFW folders with unread counts. Most reads use the cache; this is mainly for folder IDs and live unread counts. |
| `ofw_list_messages(folderId?, since?, until?, q?, sort?, page?, size?, autoRefresh?)` | Cache-backed list. Supports folder ("inbox"/"sent"/"both"), date range, and substring search. `sort:"oldest"` starts at the old end of a range instead of paging to it (default `"newest"`). Returns `complete` for the RESULT SET plus **`nextPage`** (null when done) — and the paging keys come FIRST in the JSON, before `messages`. `returned` carries the record count as a scalar, beside `total`. An **empty** result from a non-fresh cache is refused (`UNVERIFIED_EMPTY`) — pass `autoRefresh:true` to sync and answer instead. |
| `ofw_get_message(messageId, allowMarkRead?)` | Read a message OR draft body. Cache-first. Ids in the drafts cache return `folder: "drafts"`. ⚠️ Falls through to OFW for unread inbox messages, which marks them read AND stamps a "First Viewed" time the co-parent can see — irreversible. Pass `allowMarkRead:false` to refuse that fetch instead; cached, sent and already-read messages are unaffected. |
| `ofw_send_message(draftId?, subject?, body?, recipientIds?, replyToId?, expectedRevision?, deleteDraftOnSuccess?, myFileIDs?, force?)` | Send a message — **the one irreversible operation**. Preferred path: pass `draftId` (+ `expectedRevision`) to send an existing draft **as it exists on the server** — the tool re-reads it from OFW first and refuses if it changed since you read it (or was already sent/deleted); `subject`/`body` become optional overrides. `recipientIds` is usually still required: OFW does not store recipients on drafts. After a **confirmed** send the draft is auto-deleted (`deleteDraftOnSuccess:false` to keep it); on any failure or ambiguity it is retained and the response says why (`draftRetained`). Response leads with `sentMessageId`, `draftKey`, `threaded`, `draftDeleted`. Compose from scratch by passing `subject`/`body`/`recipientIds` with no `draftId`. |
| `ofw_get_unread_sent(page?, size?, autoRefresh?)` | Sent messages your co-parent hasn't read yet (from cache). Leads with `complete`/`hasMore`/`nextPage`, then `scanned`/`total`, then `unread`; an empty sent cache that is not fresh is refused rather than reported as "nothing sent". |
| `ofw_list_drafts(page?, size?, verify?, autoRefresh?)` | Leads with `complete`/`hasMore`/`nextPage`; `drafts` comes last. List saved drafts, **auto-verified**: when the cache is not verified-fresh a cheap drafts sync runs first (default `verify:true`), so one call answers server-confirmed. `verify:false` serves straight from cache. Each draft carries `serverConfirmed`, `revision` and `draftKey`. Returns `complete` — **check it before saying "you have N drafts"**. See [Freshness](#freshness). |
| `ofw_save_draft(subject, body, recipientIds?, messageId?, replyToId?, myFileIDs?, expectedRevision?, force?)` | Create a new draft. Pass `messageId` to **replace** an existing draft: the tool creates a fresh draft and deletes the old one (OFW's update-in-place endpoint silently no-ops). The returned `id` is the NEW id; the response leads with `draftKey`, which stays the same across every edit — **track that, not the id**. Note: OFW does **not** store recipients on drafts — `recipientIds` are accepted but come back empty (a one-line NOTE says so; supply them at send time instead). Threading warnings fire only on genuine drops — a draft echoing `inReplyTo`/`showContext` IS threaded. |
| `ofw_delete_draft(messageId)` | Delete a draft. |
| `ofw_upload_attachment(path, shareClass?, label?, description?)` | Upload a local file to My Files; returns a fileId to pass into `myFileIDs`. |
| `ofw_download_attachment(fileId, inline?, saveTo?, force?, extract?, maxChars?, parts?)` | Download an attachment. Inline delivery returns the first rung that works: image → `ImageContent`; .xlsx/.csv/.pdf/.docx/.pptx/text → **extracted content** under `extracted` (per-sheet CSV, per-page/slide text); anything else → raw bytes. Default writes to `~/Downloads/ofw-mcp/` (add `extract:true` for content too). Use `parts:"1-2"` / a sheet name and `maxChars` on large files. |
| `ofw_check_freshness(folders?, messageIds?, allowMarkRead?)` | Cheap live check that the cache still matches OFW — one request for folder counts plus one per id, no bodies, no sync. Each id gets a live `state` (`draft`/`sent`/`received`/`deleted`/`unknown`) plus `folder` and `sentAt`. Probes ids cached as drafts, as sent, or as already-read inbox messages freely; anything else needs `allowMarkRead:true` (it would mark an inbox message read). |
| `ofw_status(ids?, draftKeys?, includeDraftInventory?, allowMarkRead?)` | **The status call.** One live round trip. With no arguments: the full, server-verified draft inventory. With `ids`/`draftKeys`: each one's live lifecycle state. Top-level `complete` is true only when every part was verified live. |

### Calendar
| Tool | Notes |
|------|-------|
| `ofw_list_events(startDate, endDate, detailed?)` | Dates as `YYYY-MM-DD` |
| `ofw_create_event(title, startDate, endDate, ...)` | `startDate`/`endDate` as ISO datetime |
| `ofw_update_event(eventId, ...)` | Partial update — only pass fields to change |
| `ofw_delete_event(eventId)` | Permanent delete |

### Expenses
| Tool | Notes |
|------|-------|
| `ofw_get_expense_totals` | Summary of owed/paid totals |
| `ofw_list_expenses(start?, max?)` | Paginated; default max 20 |
| `ofw_create_expense(amount, description)` | Log a new expense |

### Journal
| Tool | Notes |
|------|-------|
| `ofw_list_journal_entries(start?, max?)` | 1-based offset; default max 10 |
| `ofw_create_journal_entry(title, body)` | Create a new entry |

## Freshness, completeness, and lifecycle

Message and draft reads come from a local cache, so **a result can be stale without looking stale**. Three separate questions, three separate signals — do not substitute one for another:

| Question | Signal |
|---|---|
| How old is this data? | `freshness` — `staleness` (`fresh`/`unverified`/`stale`), `asOf`, `ageSeconds`, a quotable `warning` |
| Is this the WHOLE answer? | `complete` on `ofw_list_messages` / `ofw_list_drafts` / `ofw_get_unread_sent` / `ofw_status` |
| If not, how do I get the rest? | `nextPage` (message tools) or `nextStart` (`ofw_list_expenses` / `ofw_list_journal_entries`) — null means there is no more |
| Is this entity still what I think it is? | `state` from `ofw_status` / `ofw_check_freshness` |

Rules:

- **Verification is cheaper than recollection. Use it.** Any status summary about drafts costs exactly one `ofw_status()` call. There is no situation in which recalling an earlier tool result is the better option.
- **Never state current state from memory.** A draft you saved earlier in the session is not evidence it still exists unsent now — the user may have sent, edited or deleted it in the web app since. This has gone wrong twice: drafts described as "still sitting unsent" that had already been sent.
- **`existsOnServer` does not mean "still a draft".** A draft that was SENT still exists on the server. Only `state` distinguishes them.
- **Check `complete` before quoting a count.** `complete: false` means the result set is a slice, or unverified, or both — `completeNote` says which. "You have 3 drafts" requires `complete: true`.
- **`serverConfirmed: false` means "remembered, not known."** Call `ofw_status` / `ofw_check_freshness` first, or say plainly that you are reporting cached state and give its age.
- **A refusal is a good outcome.** `result: "UNVERIFIED_EMPTY"` means the tool declined to report an absence it could not verify. Do the `remedy` — never re-report it as "nothing found". A wrong "no, that was never sent" is far costlier here than one extra call.
- **`state: "unknown"` is not "fine".** It means the question was not answered.
- OFW does **not** bump a draft's timestamp when it is edited in the web app, which is why freshness is compared by content revision. "Nothing changed" and "we didn't look" are otherwise indistinguishable.
- A missing folder count in `ofw_sync_messages` output means that folder was **not checked** — it is never "no changes". Check `notRefreshed`.

### Draft identity (`draftKey`)

Editing a draft mints a **new OFW id every time** — `ofw_save_draft` replaces by create-then-delete, so one message can burn through ten ids in a session. Track the `draftKey` it returns, not the id:

- `ofw_status(draftKeys: ["dk_…"])` resolves the key to the chain's **current** id and state.
- The key keeps resolving after the draft is sent: `state: "sent"` with `sentMessageId` and `sentAt`.
- `draftKey: null` on a draft means it was authored outside this tool; it is adopted into a chain the first time you save over it.


## Workflows

**Check inbox:**
1. `ofw_list_message_folders` → find inbox folder ID
2. `ofw_list_messages(folderId)` → list messages
3. `ofw_get_message(messageId)` → read a specific message

**Send a message:**
1. `ofw_get_profile` → get co-parent's user ID
2. `ofw_send_message(subject, body, [coParentId])`

**Reply to a message (with thread history):**
1. `ofw_get_message(messageId)` → read the message to reply to
2. `ofw_send_message(subject, body, [coParentId], replyToId: messageId)` — original message is included in the thread

**Draft before sending (sensitive messages):**
1. `ofw_save_draft(subject, body)` → review with user; note the returned `draftKey` and `revision`
2. `ofw_send_message(draftId, recipientIds, expectedRevision)` after approval — sends the **server's** copy of the draft (no body re-supply), refuses if it changed since review, and deletes the draft only after the send is confirmed

**Check what's coming up:**
- `ofw_get_notifications` for a quick summary
- `ofw_list_events(today, +30days)` for calendar detail

## Caution

- **Always confirm before sending messages or deleting anything** — OFW is a legal co-parenting record.
- `ofw_get_notifications` updates last-seen status — avoid calling silently in the background.
- `ofw_get_message` marks messages read — warn the user if they want to keep something unread.
- **Do not narrate cached state as present fact.** Before saying what "is" true on OFW right now, call `ofw_status` — one live round trip that answers drafts, ids and draft keys at once. Never assemble a status summary from earlier tool results in the conversation; re-read.
