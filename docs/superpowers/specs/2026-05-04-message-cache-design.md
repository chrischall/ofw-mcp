# Design: Local message cache

**Date:** 2026-05-04

## Goal

Cache OFW messages locally so the MCP server only contacts OFW for:

1. Checking for new messages (explicit sync).
2. Sending messages.
3. Saving, editing, or deleting drafts.

All read operations (list, get, search) are served from a local SQLite database. This eliminates per-call latency, removes the unwanted "mark-as-read on OFW" side effect of `ofw_get_message` for messages already cached, and unlocks a thread-continuity feature that requires a queryable view of the sent folder.

## Scope

**In scope:** inbox messages, sent messages, drafts.

**Out of scope (v1):** archive folder, user-created custom folders, calendar/expenses/journal data. These continue to hit OFW directly via existing tools.

## Storage

- **Engine:** `node:sqlite` (built into Node ≥22.5).
- **Bundling:** `node:sqlite` is marked external in the esbuild bundle (no native dep ships).
- **Path:** `~/.cache/ofw-mcp/<hash>.db` where `<hash> = sha256(OFW_USERNAME).slice(0, 16)`. Hashing prevents cross-account contamination if credentials change. Directory is created lazily on first sync.
- **Override:** `OFW_CACHE_DIR` env var overrides the cache directory (used by tests).
- **Engine bump:** `manifest.json` `engines.node` is raised from `>=18.0.0` to `>=22.5.0`.

## Schema

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,           -- OFW message id (unique across folders)
  folder TEXT NOT NULL,             -- 'inbox' | 'sent'
  subject TEXT NOT NULL,
  from_user TEXT NOT NULL,          -- sender display name
  sent_at TEXT NOT NULL,            -- ISO 8601
  recipients_json TEXT NOT NULL,    -- JSON array of {userId, name, viewedAt|null}
  body TEXT,                        -- NULL = metadata only (unread inbox, lazy)
  fetched_body_at TEXT,             -- ISO 8601 when body was fetched
  reply_to_id INTEGER,              -- the message this is a reply to (we set on send)
  chain_root_id INTEGER,            -- root inbox message of the thread
  list_data_json TEXT NOT NULL,     -- raw list-endpoint payload for forward compat
  last_seen_at TEXT NOT NULL        -- ISO 8601 when sync last saw this row
);
CREATE INDEX idx_messages_folder_sent_at ON messages(folder, sent_at DESC);
CREATE INDEX idx_messages_chain_root ON messages(chain_root_id);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,           -- OFW draft id
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  reply_to_id INTEGER,
  modified_at TEXT NOT NULL,        -- ISO 8601 from OFW list payload
  list_data_json TEXT NOT NULL
);

CREATE TABLE sync_state (
  folder TEXT PRIMARY KEY,          -- 'inbox' | 'sent' | 'drafts'
  last_sync_at TEXT NOT NULL,
  newest_id INTEGER                 -- highest message id seen (for incremental walk)
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- meta rows: schema_version, drafts_folder_id (cached resolution of /pub/v1/messageFolders)
```

`reply_to_id` and `chain_root_id` are populated:

- On send/save-draft: the tool computes `chain_root_id` from the parent's row (or sets it to `replyToId` if the parent is itself an inbox root) and writes it on the new row.
- For pre-existing inbox messages discovered during sync: `reply_to_id` and `chain_root_id` remain NULL. The OFW list/detail endpoints don't expose threading metadata for inbound messages, so we can only chain forward through messages we ourselves sent. This is sufficient for the thread-tip feature (see below).

## Module structure

- `src/cache.ts` — owns the DB, migrations, and typed read/write helpers. No HTTP.
- `src/sync.ts` — coordinates list/detail fetches and writes through the cache. Imports `OFWClient` and the cache.
- `src/tools/messages.ts` — handlers updated to read/write through cache and sync.
- `src/client.ts` — unchanged.

`getCache()` is a lazy singleton that opens the DB and runs migrations on first use.

## Sync semantics

### New tool: `ofw_sync_messages`

```
ofw_sync_messages({
  folders?: ('inbox' | 'sent' | 'drafts')[],   // default: all three
  fetchUnreadBodies?: boolean                   // default: false
})
```

Returns:

```json
{
  "synced": { "inbox": 12, "sent": 3, "drafts": 1 },
  "unreadInbox": [
    { "id": 12345, "subject": "...", "from": "...", "sentAt": "..." }
  ],
  "note": "2 unread inbox messages cached without bodies. Call ofw_get_message(id) to read them — this will mark them as read on OFW."
}
```

`note` is omitted when `unreadInbox` is empty.

### Initial (empty cache) sync

1. Resolve folder IDs by calling `/pub/v1/messageFolders?includeFolderCounts=true`. Persist the drafts folder ID into `meta` for reuse (replaces the hardcoded `13471259` in the existing code).
2. For each requested folder, walk pages of size 50 in date-desc order until an empty page is returned. Insert metadata rows for every message.
3. Fetch bodies inline for: all `sent` rows; all `inbox` rows that the list payload reports as already viewed; all `drafts` rows.
4. For unread `inbox` rows, leave `body` NULL.
5. Update `sync_state` for each folder.

### Incremental sync

- **inbox / sent:** walk page 1. For each message ID not in the cache, insert metadata + (conditionally) fetch body. Stop after the first page on which no new IDs are found. If page 1 is entirely new, walk forward until a page yields zero new rows. This handles bursts since last sync without re-walking history.
- **drafts:** the drafts folder is small. Re-fetch the full first page. Insert new rows, update changed rows (compare `modified_at`), delete cache rows whose ID no longer appears (sent/deleted via web UI).

### `fetchUnreadBodies: true`

Fetches bodies for unread inbox rows in the current sync. The escape hatch when the model wants everything ready for offline review.

## Thread continuity

When `replyToId` is provided to `ofw_send_message` or `ofw_save_draft`, the tool resolves the **chain tip** before posting:

```
findLatestReplyTip(replyToId):
  parent = messages[replyToId]
  if parent is missing: return replyToId      // cache miss, fail open
  chainRoot = parent.chain_root_id ?? parent.id
  tip = SELECT id FROM messages
        WHERE folder = 'sent'
          AND chain_root_id = chainRoot
        ORDER BY id DESC LIMIT 1
  return tip ?? replyToId
```

The OFW POST uses the resolved tip ID. When the tip differs from the requested `replyToId`, the tool response includes a note:

```
"replyToId rewritten from 100 to 142 (later reply in same thread found in sent cache)"
```

so the model can surface the rewrite to the user.

When the new sent message is inserted into the cache, its `chain_root_id` is set to the resolved chain root.

## Tool surface changes

| Tool | Behavior |
|------|----------|
| `ofw_list_message_folders` | Unchanged — hits OFW (cheap, source of folder IDs). |
| `ofw_list_messages` | Cache-only. `folderId` accepts an OFW numeric ID **or** the strings `'inbox'`, `'sent'`, `'drafts'` (resolved via `meta`/`sync_state`). If the cache is empty for the requested folder, returns an empty result with a note suggesting `ofw_sync_messages`. |
| `ofw_get_message` | Cache-first. If `body` is present, return cached row. If row is missing or `body` is NULL, fetch from OFW (this is the unread-inbox case), update the cache, return the fresh row. |
| `ofw_send_message` | Posts to OFW. Resolves `replyToId` to the chain tip before posting. On 200, inserts the new sent message into the cache (using the response payload; if response lacks the new ID, triggers a quick sent-folder incremental sync). Notes any `replyToId` rewrite in the response. |
| `ofw_save_draft` | Posts to OFW. Resolves `replyToId` to the chain tip. Upserts into the drafts cache from the response. Notes any rewrite. |
| `ofw_delete_draft` | Deletes on OFW + removes the row from the drafts cache. |
| `ofw_list_drafts` | Cache-only, mirrors `ofw_list_messages`. |
| `ofw_get_unread_sent` | Reads from the cache (sent folder rows + `recipients_json` viewed status). No OFW round trip after the cache is populated. Empty cache returns a hint to sync first. |
| **new** `ofw_sync_messages` | As described above. |

## Error handling and invariants

- DB writes for a single sync run happen inside a transaction per folder. Partial failures roll back that folder; other folders that completed remain persisted.
- `last_seen_at` is updated for every row touched during sync, even if its content is unchanged. Useful for debugging stale caches; never read by tool handlers.
- The cache never serves a row whose `body` is NULL when the model asks for body content; it falls through to OFW.
- `ofw_send_message` and `ofw_save_draft` insert into the cache **after** the OFW POST succeeds. A failed POST never produces a cache row.
- Cache schema migrations: a `meta.schema_version` row gates upgrades. v1 ships at version 1; future migrations bump and run idempotent ALTER scripts.

## Testing

- Cache module is tested directly against a temporary DB created in `tmpdir()` via `OFW_CACHE_DIR`.
- Sync module is tested by stubbing `OFWClient.request` (existing pattern via `vi.spyOn`) and asserting on cache state plus the sequence of HTTP calls.
- Tool handlers are tested as today, with the cache pre-seeded as appropriate. Tests that previously asserted on raw OFW HTTP behavior for `ofw_list_messages` / `ofw_get_message` are split into "cache hit" and "cache miss" cases.
- New test files: `tests/cache.test.ts`, `tests/sync.test.ts`, `tests/tools/sync.test.ts`. Existing test files updated.

## Versioning

The Cut & Bump GitHub Action handles version bumps. This change bumps `manifest.json` `engines.node` to `>=22.5.0` (a minor compat note for the release notes), but does not require manual version edits.

## Out of scope / non-goals

- Full-text search across cached bodies. The schema can be extended with FTS5 later (`node:sqlite` includes FTS5) but it's not part of v1.
- Caching message attachments — only the JSON metadata and body text are stored.
- Cross-device sync (the cache is local; running on a second machine starts with an empty cache).
- Conflict resolution for drafts edited concurrently on the OFW web UI and via the MCP — the incremental drafts sync's "compare modified_at" handles the common case but doesn't resolve simultaneous edits.
