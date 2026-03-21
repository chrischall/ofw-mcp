---
name: ofw-mcp
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
| `ofw_list_message_folders` | Get folder IDs (inbox, sent, etc.) — call this first |
| `ofw_list_messages(folderId)` | List messages in a folder |
| `ofw_get_message(messageId)` | Read a message. ⚠️ Marks unread messages as read. |
| `ofw_send_message(subject, body, recipientIds[], replyToId?, draftId?)` | Send a message. Pass `replyToId` to thread the original message history (like email reply). Pass `draftId` to auto-delete the draft after sending. |
| `ofw_list_drafts` | List saved drafts |
| `ofw_save_draft(subject, body, recipientIds?, messageId?, replyToId?)` | Create or update a draft |
| `ofw_delete_draft(messageId)` | Delete a draft |

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
1. `ofw_save_draft(subject, body)` → review with user
2. `ofw_send_message(..., draftId)` after approval — draft is auto-deleted on send

**Check what's coming up:**
- `ofw_get_notifications` for a quick summary
- `ofw_list_events(today, +30days)` for calendar detail

## Caution

- **Always confirm before sending messages or deleting anything** — OFW is a legal co-parenting record.
- `ofw_get_notifications` updates last-seen status — avoid calling silently in the background.
- `ofw_get_message` marks messages read — warn the user if they want to keep something unread.
