# OurFamilyWizard MCP Server Plugin — Design Spec

**Date:** 2026-03-15
**Status:** Approved
**Owner:** Chris Hall

---

## Overview

A Claude Code plugin that wraps the OurFamilyWizard (OFW) REST API as an MCP server, exposing co-parenting data and actions as Claude tools. Enables Claude to read messages, manage calendar events, track expenses, write journal entries, and more — all from a natural conversation.

---

## Architecture

```
ofw/
├── plugin.json          # Claude Code plugin manifest
├── .mcp.json            # MCP server registration
├── src/
│   ├── index.ts         # MCP server entry point, tool registration
│   ├── client.ts        # OFW HTTP client (auth lifecycle, request wrapper)
│   └── tools/
│       ├── messages.ts  # Message tools
│       ├── calendar.ts  # Calendar tools
│       ├── expenses.ts  # Expense tools
│       ├── journal.ts   # Journal tools
│       └── user.ts      # User/profile tools
├── package.json
├── tsconfig.json
├── .env                 # OFW_EMAIL, OFW_PASSWORD (gitignored)
└── .gitignore
```

---

## API Details

**Base URL:** `https://ofw.ourfamilywizard.com`

### Authentication

- Login endpoint: `POST /pub/v1/auth/login` (to be confirmed during impl — probe common REST patterns)
- Bearer token stored in memory (`localStorage.auth` in browser; equivalent in-memory in the server)
- Token format: base64-encoded `<secret>:<timestamp_ms>:<userId>::WebApplication`
- Token expiry stored alongside token; refresh when within 5 minutes of expiry
- Required headers on all authenticated requests:
  ```
  Authorization: Bearer <token>
  ofw-client: WebApplication
  ofw-version: 1.0.0
  Accept: application/json
  Content-Type: application/json
  ```
- Logout: `GET /ofw/logout`
- Credentials sourced from `OFW_EMAIL` and `OFW_PASSWORD` environment variables

### Known Endpoints

#### User
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/users/useraccountstatus` | Account status |
| GET | `/pub/v1/users/registrations/{userId}` | User registration info |
| GET | `/pub/v1/profiles` | User + co-parent profiles (v1) |
| GET | `/pub/v2/profiles` | User + co-parent profiles (v2) |

#### Messages
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/messageFolders?includeFolderCounts=true` | List folders with unread counts |
| GET | `/pub/v3/messages?folders={id}&page=1&size=50&sort=date&sortDirection=desc` | List messages in folder |
| GET | `/pub/v3/messages/contacts?includeSelf=true` | List message contacts |
| POST | `/pub/v3/messages` | Send message (body TBD via impl) |

#### Calendar
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/calendar/basic?startDate={date}&endDate={date}` | Events (basic) |
| GET | `/pub/v1/calendar/detailed?startDate={date}&endDate={date}` | Events (detailed) |
| GET | `/pub/v1/calendar/preference/weekstartday` | Week start preference |
| POST | `/pub/v1/calendar/events` | Create event (body TBD via impl) |
| PUT | `/pub/v1/calendar/events/{id}` | Update event |
| DELETE | `/pub/v1/calendar/events/{id}` | Delete event |

Calendar event fields (observed from UI):
- `title`, `startDate`, `endDate`, `allDay`, `repeat`
- `location`, `reminder`, `privateEvent`
- `eventFor` (neither/parent1/parent2)
- `dropOffParent`, `pickUpParent`
- `children` (array of child IDs — Erik, Finn, Lucas Hall)

#### Expenses
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v2/expense/expenses/totals` | Summary totals |
| GET | `/pub/v1/expense/payments/accounts?start=0&max=2` | Payment accounts |
| GET | `/pub/v2/expense/expenses` | List expenses (params TBD) |
| POST | `/pub/v2/expense/expenses` | Create expense (body TBD) |

#### Journal
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/journals?start=1&max=10` | List journal entries |
| POST | `/pub/v1/journals` | Create journal entry (body TBD) |

#### Calls
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/calls/features` | Call feature flags |
| GET | `/pub/v1/calls/consent` | Call consent status |

#### Misc
| Method | Path | Description |
|--------|------|-------------|
| POST | `/ofw/keepalive.form?initial=true` | Session keepalive |
| GET | `/pub/v2/tonecheck/features` | ToneCheck feature flags |
| GET | `/pub/v3/tonecheck/features` | ToneCheck feature flags (v3) |

> **Note:** POST/PUT/DELETE request bodies for messages, calendar, expenses, and journal are marked TBD. They will be discovered during implementation by monitoring network traffic for each write action.

---

## MCP Tools

All tools handle auth transparently. On first call, the client logs in using env credentials. Token is refreshed automatically before expiry.

### User Tools (`user.ts`)

**`ofw_get_profile`**
- Returns current user info and co-parent profiles
- Calls: `GET /pub/v2/profiles`

**`ofw_get_notifications`**
- Returns home dashboard summary: unread messages, upcoming events, outstanding expenses
- Calls: `GET /pub/v1/users/useraccountstatus`

### Message Tools (`messages.ts`)

**`ofw_list_message_folders`**
- Returns folders with unread counts
- Calls: `GET /pub/v1/messageFolders?includeFolderCounts=true`

**`ofw_list_messages`**
- Params: `folderId`, `page` (default 1), `size` (default 50), `sort` (default date desc)
- Calls: `GET /pub/v3/messages?folders={folderId}&...`

**`ofw_get_message`**
- Params: `messageId`
- Calls: `GET /pub/v3/messages/{messageId}` (endpoint to confirm)

**`ofw_send_message`**
- Params: `subject`, `body`, `recipients` (array), `folderId`
- Calls: `POST /pub/v3/messages`

### Calendar Tools (`calendar.ts`)

**`ofw_list_events`**
- Params: `startDate`, `endDate`, `detailed` (boolean, default false)
- Calls: `/pub/v1/calendar/basic` or `/pub/v1/calendar/detailed`

**`ofw_create_event`**
- Params: `title`, `startDate`, `endDate`, `allDay?`, `location?`, `reminder?`, `privateEvent?`, `eventFor?`, `dropOffParent?`, `pickUpParent?`, `children?` (array)
- Calls: `POST /pub/v1/calendar/events`

**`ofw_update_event`**
- Params: `eventId`, plus any subset of create params
- Calls: `PUT /pub/v1/calendar/events/{eventId}`

**`ofw_delete_event`**
- Params: `eventId`
- Calls: `DELETE /pub/v1/calendar/events/{eventId}`

### Expense Tools (`expenses.ts`)

**`ofw_get_expense_totals`**
- Returns owed/paid summary
- Calls: `GET /pub/v2/expense/expenses/totals`

**`ofw_list_expenses`**
- Params: `start?`, `max?`
- Calls: `GET /pub/v2/expense/expenses`

**`ofw_create_expense`**
- Params: TBD (to be discovered during impl)
- Calls: `POST /pub/v2/expense/expenses`

### Journal Tools (`journal.ts`)

**`ofw_list_journal_entries`**
- Params: `start` (default 1), `max` (default 10)
- Calls: `GET /pub/v1/journals`

**`ofw_create_journal_entry`**
- Params: TBD (to be discovered during impl)
- Calls: `POST /pub/v1/journals`

---

## Auth Client Design (`client.ts`)

```typescript
class OFWClient {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  async request<T>(method: string, path: string, body?: unknown): Promise<T>
  private async ensureAuthenticated(): Promise<void>
  private async login(): Promise<void>
  private isTokenExpired(): boolean  // true if within 5 min of expiry
}
```

`request()` calls `ensureAuthenticated()` before every API call — transparent to all tools.

---

## Plugin Manifest

**`plugin.json`**
```json
{
  "name": "ofw",
  "version": "1.0.0",
  "description": "OurFamilyWizard co-parenting tools for Claude"
}
```

**`.mcp.json`**
```json
{
  "mcpServers": {
    "ofw": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "OFW_EMAIL": "${OFW_EMAIL}",
        "OFW_PASSWORD": "${OFW_PASSWORD}"
      }
    }
  }
}
```

---

## Error Handling

- 401 responses trigger a re-login (once), then propagate the error if it fails again
- 403 responses returned as descriptive tool errors
- Network errors wrapped with context
- All tools return structured errors Claude can reason about

---

## Testing Strategy

- Unit tests for `client.ts` auth lifecycle (mock HTTP)
- Integration tests for each tool group using recorded fixtures
- Manual smoke test: login → list messages → list calendar events

---

## Out of Scope

- Calls (VoIP — requires WebRTC, not feasible via REST alone)
- Info Bank (legacy `/ofw/` page — no REST API discovered)
- ToneCheck integration (read-only feature flags only)
- Multi-account support
