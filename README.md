# OurFamilyWizard MCP

[![CI](https://github.com/chrischall/ofw-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/ofw-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ofw-mcp)](https://www.npmjs.com/package/ofw-mcp)
[![license](https://img.shields.io/npm/l/ofw-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to [OurFamilyWizard](https://www.ourfamilywizard.com), giving you natural-language access to your co-parenting messages, calendar, expenses, and journal.

> [!WARNING]
> **AI-developed project.** This codebase was entirely built and is actively maintained by [Claude Sonnet 4.6](https://www.anthropic.com/claude). No human has audited the implementation. Review all code and tool permissions before use.

## What you can do

Ask Claude things like:

- *"Show me my recent OFW messages"*
- *"What's on the kids' calendar next week?"*
- *"List recent expenses and tell me what I owe"*
- *"Add a journal entry about today's pickup"*
- *"Draft a reply to the last message from my co-parent"*

## Requirements

- [Claude Desktop](https://claude.ai/download)
- [Node.js](https://nodejs.org) 22.5 or later (`node:sqlite` is the cache backend)
- An active OurFamilyWizard account

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. This server accesses your own OurFamilyWizard account.** Auth happens via your own credentials. It does not — and cannot — access your co-parent's account, your children's accounts, or anyone else's.

**2. [OurFamilyWizard's Terms](https://www.ourfamilywizard.com/legal/terms) govern your use of this server**, just as they govern your direct use of OFW. There is no explicit anti-scraping clause; the governing language is broader:

> Users may not obtain or attempt to obtain any materials or information through any means not intentionally made available.

And on credentials: *"You are solely responsible for (1) maintaining the strict confidentiality of assigned Authentication Methods, (2) instructing any individual to whom the assigned Authentication Method is shared ('Authorized User') to not allow another person to use the Authentication Method."* OFW does contemplate "Authorized Users" and third-party-enabled integrations — but the account holder remains responsible.

You are agreeing to those terms — read by the maintainer 2026-05-23 — every time you invoke a tool in this server.

**3. Personal, family use only.** This project is not affiliated with, endorsed by, sponsored by, or in partnership with OurFamilyWizard, LLC or its parent. It is a personal automation tool for the named account holder. Do not use it on behalf of a co-parent without their consent, do not share credentials with anyone, and do not use it to bulk-extract another family's data.

**4. OFW is a court-of-record platform.** Messages, expenses, calendar entries, and journal entries on OFW may be entered into legal proceedings — including custody, divorce, and parenting-plan-modification cases. Anything this server writes to OFW (drafts you save, events you create, expenses you log) will appear with the same legal weight as if you had typed it yourself. **Do not let this MCP send a message, create an event, or log an expense that you have not read and approved.** Review every write operation before confirming.

**5. You accept full responsibility** for any consequences — both technical (account warnings, suspension) and legal (anything OFW records about your account activity). The MCP author is not your attorney; if you're using OFW in connection with an active legal matter, talk to your actual attorney before automating anything.

This section is the maintainer's good-faith summary of the terms — it is not legal advice and does not modify or supersede OurFamilyWizard's actual ToS.

## Installation

### 1. Clone and build

```bash
git clone https://github.com/chrischall/ofw-mcp.git
cd ofw-mcp
npm install
npm run build
```

### 2. Add to Claude Desktop

Edit your Claude Desktop config file:

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `ofw` entry inside `"mcpServers"` (create the key if it doesn't exist):

```json
{
  "mcpServers": {
    "ofw": {
      "command": "node",
      "args": ["/absolute/path/to/ofw-mcp/dist/index.js"],
      "env": {
        "OFW_USERNAME": "your-email@example.com",
        "OFW_PASSWORD": "your-ofw-password"
      }
    }
  }
}
```

Replace `/absolute/path/to/ofw-mcp` with the actual path where you cloned the repo. On Mac, run `pwd` inside the cloned directory to get it.

### 3. Restart Claude Desktop

Quit completely (Cmd+Q on Mac, not just close the window) and relaunch.

### 4. Verify

Ask Claude: *"What does my OFW dashboard look like?"* — it should show your unread message count, upcoming events, and outstanding expenses.

## Authentication

`ofw-mcp` tries three auth paths in order; whichever succeeds first is used. Existing setups keep working unchanged.

1. **Env-var credentials (legacy, recommended for Claude Desktop).** Set `OFW_USERNAME` + `OFW_PASSWORD` and the server logs in via OFW's form endpoint. This is the path shown in the Claude Desktop config above.
2. **fetchproxy fallback (no env vars needed).** When the credentials are absent, the server reads `localStorage["auth"]` once at startup from your already-signed-in `ourfamilywizard.com` tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) browser extension. After that one read, all OFW API calls go directly from Node — the extension is **not** in the request hot path. Install the fetchproxy extension (Chrome Web Store / Safari `.dmg`), sign into OurFamilyWizard once, and the MCP just works. If you have multiple OFW accounts and want them to use separate caches, set `OFW_CACHE_IDENTITY` to a label per profile.
3. **Error.** If neither path is available, the server tells you exactly which fix to apply. Set `OFW_DISABLE_FETCHPROXY=1` to skip the fetchproxy fallback entirely (turns missing credentials into a hard error — useful in headless CI).

### Credential options (env-var path)

**Option A — env block in Claude Desktop config** (shown above, recommended):

```json
"env": {
  "OFW_USERNAME": "your-email@example.com",
  "OFW_PASSWORD": "your-ofw-password"
}
```

**Option B — `.env` file** in the project directory:

```bash
cp .env.example .env
# edit .env and fill in your credentials
```

Environment variables always take priority over the `.env` file. You can also pass them directly on the command line:

```bash
OFW_USERNAME=you@example.com OFW_PASSWORD=yourpass node dist/index.js
```

## Hosted connector (Cloudflare Worker)

Instead of running `ofw-mcp` locally, you can add it to [claude.ai](https://claude.ai) as a **remote MCP connector** — a hosted Cloudflare Worker you reach from Settings → Connectors on Claude web, desktop, or mobile (connectors sync across all three). The same tool registrars back both targets, so the tools and behaviour are identical to the local stdio install; the Worker just wraps them with [`@chrischall/mcp-connector`](https://www.npmjs.com/package/@chrischall/mcp-connector) (the shared OAuth + streamable-HTTP harness) and a per-user [Durable Object](src/cache/durable.ts) cache in place of the local SQLite file.

- **How you connect.** Each person you share the connector URL with logs in through the connector's own OAuth page with their **own** OurFamilyWizard email and password. Those credentials are stored (encrypted at rest) per user because OFW bearer tokens expire after ~6h with no refresh token, so the connector must be able to re-login on its own. One user can never see another's account or cache.
- **Attachments are inline-only.** The Worker has no local filesystem, so `ofw_download_attachment` always returns bytes as MCP content blocks (`OFW_INLINE_ATTACHMENTS=true`) rather than writing to disk.
- **Write mode defaults to `all`.** The hosted connector registers every tool by default, configurable per deployment via `OFW_WRITE_MODE` / `OFW_CALENDAR_WRITES` in `wrangler.jsonc` — see [Write protection](#write-protection-ofw_write_mode).
- **Message sync is bounded and resumable.** To stay under Cloudflare's per-request subrequest cap, `ofw_sync_messages` on the hosted connector caps how many OFW requests one call makes (`OFW_SYNC_MAX_REQUESTS` in `wrangler.jsonc`, default `40`) and resumes across calls, so a large mailbox backfills over multiple `ofw_sync_messages` calls rather than one; the local stdio server is unbounded. See [`docs/DEPLOY-CONNECTOR.md`](docs/DEPLOY-CONNECTOR.md#sync--the-subrequest-limit).

Standing this up requires a Cloudflare account and is a one-time setup for whoever hosts it; after that the `deploy-connector` job in `release-please.yml` deploys each release automatically (and **Actions → deploy-connector → Run workflow** deploys any ref on demand) — see [`docs/DEPLOY-CONNECTOR.md`](docs/DEPLOY-CONNECTOR.md) for the full runbook. `wrangler.jsonc` serves the Worker at a custom domain (`https://connector.ofw.nullnet.app/mcp`) plus the account's `*.workers.dev` URL; whoever hosts it uses their own domain. The local stdio / `.mcpb` install above remains the desktop-only alternative if you'd rather run it against just your own account.

## Available tools

Read-only tools run automatically. Write tools ask for your confirmation first. The *Write mode* column shows the minimum `OFW_WRITE_MODE` a tool needs to be available at all — see [Write protection](#write-protection-ofw_write_mode) below.

| Tool | What it does | Permission | Write mode |
|------|-------------|------------|------------|
| `ofw_get_profile` | Your profile and co-parent info | Auto | any |
| `ofw_get_notifications` | Dashboard counts (unread messages, upcoming events, outstanding expenses) | Auto | any |
| `ofw_list_message_folders` | Folders with unread counts — **get folder IDs here before listing messages** | Auto | any |
| `ofw_list_messages` | Messages in a folder | Auto | any |
| `ofw_get_message` | Full content of a single message | Auto | any |
| `ofw_sync_messages` | Sync messages into the local cache (unread bodies left unfetched to avoid read receipts) | Auto | any |
| `ofw_get_unread_sent` | Sent messages a recipient hasn't read yet (from local cache) | Auto | any |
| `ofw_check_freshness` | Cheap live check that the cache still matches OFW — confirm a draft still exists unsent, without a full sync | Auto | any |
| `ofw_download_attachment` | Download a message attachment to disk (or inline as MCP content) | Auto | any |
| `ofw_send_message` | Send a message | Confirm | `all` |
| `ofw_list_drafts` | Draft messages | Auto | any |
| `ofw_save_draft` | Create or update a draft | Confirm | `drafts` |
| `ofw_delete_draft` | Delete a draft | Confirm | `drafts` |
| `ofw_upload_attachment` | Upload a local file to My Files; returns a fileId to attach via `ofw_send_message`/`ofw_save_draft` | Auto | `drafts` |
| `ofw_list_events` | Calendar events in a date range | Auto | any |
| `ofw_create_event` | Create a calendar event | Confirm | `all` (or `drafts` + `OFW_CALENDAR_WRITES`) |
| `ofw_update_event` | Update a calendar event | Confirm | `all` (or `drafts` + `OFW_CALENDAR_WRITES`) |
| `ofw_delete_event` | Delete a calendar event | Confirm | `all` (or `drafts` + `OFW_CALENDAR_WRITES`) |
| `ofw_get_expense_totals` | Expense summary totals | Auto | any |
| `ofw_list_expenses` | Expense history | Auto | any |
| `ofw_create_expense` | Log a new expense | Confirm | `all` |
| `ofw_list_journal_entries` | Journal entries | Auto | any |
| `ofw_create_journal_entry` | Create a journal entry | Confirm | `all` |

### Data freshness (`OFW_FRESHNESS_TTL_SECONDS`)

Message and draft reads are served from the local cache, which means a result can look authoritative while being minutes or months out of date. The cache also cannot detect some changes on its own: **editing a draft in the OFW web app bumps no timestamp at all**, so "nothing changed" and "we didn't look" are indistinguishable unless the server says which happened.

So every read tool (`ofw_list_messages`, `ofw_list_drafts`, `ofw_get_message`, `ofw_list_message_folders`, `ofw_sync_messages`) returns a `freshness` block alongside its data:

```json
"freshness": {
  "source": "cache",
  "asOf": "2026-07-20T12:40:00.000Z",
  "ageSeconds": 5231,
  "staleness": "unverified",
  "lastServerSyncAt": "2026-07-20T13:59:00.000Z",
  "syncComplete": false,
  "historyComplete": true,
  "warning": "Served from cache last verified 87 min ago; the last sync did not finish checking drafts. Re-read before asserting current state — call ofw_check_freshness for a cheap live confirmation, or ofw_sync_messages to refresh."
}
```

`staleness` is `fresh` only when the data was fetched live in that call, or verified against OFW within the threshold by a sync that actually reached that folder. It degrades to `unverified` when it ages out or a sync skipped the folder, and `stale` when the folder has never been checked at all. Anything other than `fresh` always carries a human-readable `warning` stating the age and the reason. The bias is deliberate and one-directional: a false `unverified` costs one extra call, whereas a false `fresh` lets remembered state be narrated as present fact.

Drafts additionally carry per-item `cacheStatus`, `asOf`, and **`serverConfirmed`** — true only when a completed drafts walk verified them inside the threshold. `serverConfirmed: false` means a draft's existence and unsent status are *remembered*, not known, and should not be stated as current fact without calling `ofw_check_freshness` first.

`ofw_check_freshness` is the cheap way to re-verify: one request for a folder count comparison plus one per message id, no bodies, no full sync. Draft ids are compared by **content revision**, not timestamp, for the reason above. By default it only probes ids that are in the drafts cache — fetching any other id would mark an unread inbox message as read on OurFamilyWizard, an irreversible change to a court-visible record, so those are skipped unless you pass `allowMarkRead: true`.

Set `OFW_FRESHNESS_TTL_SECONDS` to tune the threshold (default `300`, i.e. 5 minutes). Unusable values fall back to the default rather than widening the window.

### Write protection (`OFW_WRITE_MODE`)

The "Confirm" permission above is a *hint* to the MCP host — a host configured to auto-approve tools (or a user who clicked "always allow" once) would leave nothing between model output and a sent message. Because OurFamilyWizard is a court-of-record platform, the server also supports a structural gate: set `OFW_WRITE_MODE` in the server's `env` block and tools above your chosen level are **never registered**, so no host setting or prompt-injected instruction can invoke them.

| `OFW_WRITE_MODE` | What's available |
|------------------|------------------|
| `none` | **Default.** Read/sync/search only. No write tools exist. |
| `drafts` | Adds draft-level writes: `ofw_save_draft`, `ofw_delete_draft`, `ofw_upload_attachment`. Nothing that lands on the court-visible record — the AI prepares, only a human signed into the OFW web UI can send. |
| `all` | Everything (send, calendar/expense/journal writes). Opt in deliberately — on a court-of-record account, prefer `drafts`. |

Unrecognized values fail closed to `none`, with a warning on stderr — a typo never silently grants write access.

#### Calendar opt-in (`OFW_CALENDAR_WRITES`)

Calendar events sit between the two message tiers: they have no draft stage (a created event is immediately visible on the shared record), but unlike a sent message they are reversible — an event can be edited or deleted afterward. If you run in `drafts` mode but are comfortable with direct calendar writes, set `OFW_CALENDAR_WRITES=true` to additionally register `ofw_create_event`, `ofw_update_event`, and `ofw_delete_event`. The flag is redundant in `all` mode and never overrides `none`.

### Egress allowlist

Every outbound request is passed through a hard host check before `fetch` — the server refuses to contact any host other than `ofw.ourfamilywizard.com` (including URL userinfo-splice tricks). It's a structural backstop: a future code change or a compromised dependency that tried to reach another host throws instead of exfiltrating your bearer token or messages.

## Troubleshooting

**"0 messages"** — Claude may have read the notification counts rather than the actual messages. Ask explicitly: *"List the messages in my OFW inbox"* or *"Use ofw_list_message_folders then ofw_list_messages"*.

**"OFW auth: set OFW_USERNAME + OFW_PASSWORD, or install the fetchproxy extension…"** — neither auth path is configured. Either fill in the `env` block in your Claude Desktop config, or install the [fetchproxy extension](https://github.com/chrischall/fetchproxy) and sign into `ourfamilywizard.com` in your browser.

**"fetchproxy fallback failed"** — the env-var path wasn't configured and the extension couldn't be reached. Confirm the fetchproxy extension is installed, signed into OFW, and that it's running (open the extension popup). If you want to disable the fallback entirely, set `OFW_DISABLE_FETCHPROXY=1`.

**403 Forbidden** — wrong credentials. Verify your username/password at [ofw.ourfamilywizard.com](https://ofw.ourfamilywizard.com).

**Tools not appearing in Claude** — go to **Claude Desktop → Settings → Developer** to see connected servers and any error output. Make sure you fully quit and relaunched after editing the config.

**Can't find the config file on Mac** — in Finder press Cmd+Shift+G and paste `~/Library/Application Support/Claude/`.

## Security

- Credentials live only in your local config file or `.env`
- They are passed to the server as environment variables and never logged
- The server authenticates with OFW using the same login flow as the web app
- Use a strong, unique OFW password
- Outbound requests are host-allowlisted to `ofw.ourfamilywizard.com` (see [Egress allowlist](#egress-allowlist))

## Development

```bash
npm test         # run the vitest suite
npm run build    # tsc → dist/, then esbuild bundle → dist/bundle.js
npm run dev      # node --env-file=.env dist/index.js (requires built dist)
```

Main is protected. All changes land via PR — open with `gh pr create --label <release-notes-label>` and add `ready-to-merge` once you're satisfied with the auto-review feedback. See `CLAUDE.md` for the full PR + release flow.

### Project structure

```
src/
  index.ts          MCP server entry (McpServer + StdioServerTransport)
  client.ts         OFW HTTP client with Bearer token + 401/429 retry
  auth.ts           resolveAuth(): env-var creds → fetchproxy → error
  auth-password.ts  Spring Security form login (legacy env-var path)
  cache.ts          SQLite cache (messages, drafts, attachments, sync state)
  sync.ts           Folder ID resolution + per-folder sync logic
  config.ts         Cache dir, attachment dir, env parsing
  tools/
    _shared.ts      Recipient mapping, response helpers, path expansion
    user.ts         ofw_get_profile, ofw_get_notifications
    messages.ts     Folders, list, get, send, drafts, sync, attachments
    calendar.ts     List, create, update, delete events
    expenses.ts     Totals, list, create
    journal.ts      List, create entries
tests/              Mirrors src/; mocks OFWClient.request via vi.spyOn
```

### Auth flow

Auth resolution lives in `src/auth.ts`. Three paths, in priority order:

1. **Env vars present** → `src/auth-password.ts` does the legacy OFW Spring Security form login:
   1. `GET /ofw/login.form` — establishes a session cookie
   2. `POST /ofw/login` — submits credentials, returns `{ auth: "<token>" }`
2. **Env vars absent (and `OFW_DISABLE_FETCHPROXY` unset)** → `@fetchproxy/bootstrap` reads `localStorage["auth"]` + `localStorage["tokenExpiry"]` once from the user's signed-in `ourfamilywizard.com` tab, then closes the bridge.
3. **Nothing configured** → throws with both fixes spelled out.

Either path returns a Bearer token to `OFWClient`, which then operates from Node with `Authorization: Bearer <token>` — fetchproxy is **not** in the request hot path. On 401 the client re-resolves auth and replays once. Tokens are cached for 6h (env-var path) or until `tokenExpiry` (fetchproxy path).

Also see the [fetchproxy README](https://github.com/chrischall/fetchproxy) for extension install instructions.

## License

MIT
