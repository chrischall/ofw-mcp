# OurFamilyWizard MCP

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

## Available tools

Read-only tools run automatically. Write tools ask for your confirmation first.

| Tool | What it does | Permission |
|------|-------------|------------|
| `ofw_get_profile` | Your profile and co-parent info | Auto |
| `ofw_get_notifications` | Dashboard counts (unread messages, upcoming events, outstanding expenses) | Auto |
| `ofw_list_message_folders` | Folders with unread counts — **get folder IDs here before listing messages** | Auto |
| `ofw_list_messages` | Messages in a folder | Auto |
| `ofw_get_message` | Full content of a single message | Auto |
| `ofw_send_message` | Send a message | Confirm |
| `ofw_list_drafts` | Draft messages | Auto |
| `ofw_save_draft` | Create or update a draft | Confirm |
| `ofw_delete_draft` | Delete a draft | Confirm |
| `ofw_list_events` | Calendar events in a date range | Auto |
| `ofw_create_event` | Create a calendar event | Confirm |
| `ofw_update_event` | Update a calendar event | Confirm |
| `ofw_delete_event` | Delete a calendar event | Confirm |
| `ofw_get_expense_totals` | Expense summary totals | Auto |
| `ofw_list_expenses` | Expense history | Auto |
| `ofw_create_expense` | Log a new expense | Confirm |
| `ofw_list_journal_entries` | Journal entries | Auto |
| `ofw_create_journal_entry` | Create a journal entry | Confirm |

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
