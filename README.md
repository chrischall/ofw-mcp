# OurFamilyWizard MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to [OurFamilyWizard](https://www.ourfamilywizard.com), giving you natural-language access to your co-parenting messages, calendar, expenses, and journal.

## What you can do

Ask Claude things like:

- *"Show me my recent OFW messages"*
- *"What's on the kids' calendar next week?"*
- *"List recent expenses and tell me what I owe"*
- *"Add a journal entry about today's pickup"*
- *"Draft a reply to the last message from my co-parent"*

## Requirements

- [Claude Desktop](https://claude.ai/download)
- [Node.js](https://nodejs.org) 18 or later
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

## Credentials

Credentials are read from environment variables, with two ways to provide them:

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

**"OFW_USERNAME and OFW_PASSWORD must be set"** — credentials are missing. Check the `env` block in your Claude Desktop config or your `.env` file.

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
npm test        # run the test suite
npm run build   # compile TypeScript → dist/
```

### Project structure

```
src/
  client.ts       OFW auth and HTTP client
  index.ts        MCP server entry point
  tools/
    user.ts       ofw_get_profile, ofw_get_notifications
    messages.ts   folders, list, get, send
    calendar.ts   list, create, update, delete events
    expenses.ts   totals, list, create
    journal.ts    list, create entries
tests/
  client.test.ts
  tools/
```

### Auth flow

OFW uses Spring Security form login:

1. `GET /ofw/login.form` — establishes a session cookie
2. `POST /ofw/login` — submits credentials, returns `{ auth: "<token>" }`
3. All API calls use `Authorization: Bearer <token>`
4. On 401, re-authenticates automatically and retries once

Tokens are cached for 6 hours.

## License

MIT
