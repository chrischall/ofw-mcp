# ofw-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects Claude to [OurFamilyWizard](https://www.ourfamilywizard.com), giving Claude access to your messages, calendar, expenses, and journal entries.

## What it does

Once installed, you can ask Claude things like:

- "Show me my recent OFW messages"
- "What's on our co-parenting calendar this week?"
- "Summarize my expense history for the last month"
- "Draft a reply to the last message from [co-parent]"
- "What journal entries did I write in February?"

## Prerequisites

- [Claude Desktop](https://claude.ai/download) (Mac or Windows)
- [Node.js](https://nodejs.org) 18 or later
- An active OurFamilyWizard account

## Installation

### Step 1 — Install the package

```bash
npm install -g ofw-mcp
```

Or use it directly with `npx` (no install needed, see Step 2).

### Step 2 — Add to Claude Desktop config

Open your Claude Desktop configuration file:

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `ofw` entry inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "ofw": {
      "command": "npx",
      "args": ["-y", "ofw-mcp"],
      "env": {
        "OFW_EMAIL": "your-ofw-email@example.com",
        "OFW_PASSWORD": "your-ofw-password"
      }
    }
  }
}
```

If `"mcpServers"` doesn't exist yet, add it at the top level. The full file should look like:

```json
{
  "mcpServers": {
    "ofw": {
      "command": "npx",
      "args": ["-y", "ofw-mcp"],
      "env": {
        "OFW_EMAIL": "your-ofw-email@example.com",
        "OFW_PASSWORD": "your-ofw-password"
      }
    }
  }
}
```

### Step 3 — Restart Claude Desktop

Quit Claude Desktop completely (don't just close the window — use **File → Quit** or **Cmd+Q** on Mac) and relaunch it.

### Step 4 — Verify

In a new Claude conversation, ask: *"List my OFW message folders"*. Claude should call the OFW tools and return your folders.

## Available tools

| Tool | Description |
|------|-------------|
| `ofw_get_profile` | Your profile and connected family members |
| `ofw_get_notifications` | Account status and notification counts |
| `ofw_list_message_folders` | Message folders (inbox, sent, etc.) with unread counts |
| `ofw_list_messages` | Messages in a folder |
| `ofw_get_message` | Full content of a single message |
| `ofw_send_message` | Send a message to a co-parent |
| `ofw_list_events` | Calendar events for a date range |
| `ofw_create_event` | Create a calendar event |
| `ofw_update_event` | Update an existing calendar event |
| `ofw_delete_event` | Delete a calendar event |
| `ofw_get_expense_totals` | Expense summary totals |
| `ofw_list_expenses` | Expense history |
| `ofw_create_expense` | Log a new expense |
| `ofw_list_journal_entries` | Journal entries |
| `ofw_create_journal_entry` | Create a journal entry |

## Security notes

- Your credentials are stored only in your local Claude Desktop config file
- They are passed to the MCP server as environment variables and never logged or transmitted anywhere other than the OFW API
- The server authenticates with OFW on your behalf using the same login flow as the web app
- Consider using a strong, unique OFW password

## Troubleshooting

**"OFW connection isn't authenticated"** — This message from Claude means the MCP server failed to start or log in. Check:
1. Your email and password are correct in the config file
2. You fully quit and relaunched Claude Desktop after editing the config
3. Node.js 18+ is installed (`node --version`)

**"0 messages"** — Claude may have read unread counts from folders instead of listing messages. Try asking explicitly: *"List messages in my OFW inbox"*.

**Can't find the config file** — On Mac, press **Cmd+Shift+G** in Finder and paste `~/Library/Application Support/Claude/`.

**MCP server not appearing** — Go to **Claude Desktop → Settings → Developer** to see connected MCP servers and any error output.

## Development

```bash
git clone https://github.com/yourusername/ofw-mcp
cd ofw-mcp
npm install
cp .env.example .env   # add your credentials
npm run build
npm test
```

To run locally against Claude Desktop, set the command to the absolute path of `dist/index.js`:

```json
{
  "mcpServers": {
    "ofw": {
      "command": "node",
      "args": ["/absolute/path/to/ofw-mcp/dist/index.js"],
      "env": {
        "OFW_EMAIL": "your-email@example.com",
        "OFW_PASSWORD": "your-password"
      }
    }
  }
}
```

## License

MIT
