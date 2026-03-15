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
├── package.json         # includes build script: "build": "tsc"
├── tsconfig.json        # outDir: "./dist"
├── .env                 # OFW_EMAIL, OFW_PASSWORD (gitignored)
└── .gitignore
```

---

## API Details

**Base URL:** `https://ofw.ourfamilywizard.com`

### Authentication

**Login flow (confirmed via browser network monitoring):**

1. `POST /ofw/login.form` with `Content-Type: application/x-www-form-urlencoded` and body `username=<email>&password=<password>` — returns session cookie, redirects to `/ofw/appv2/home.form` (HTTP 200)
2. The REST `POST /pub/v1/auth/login` endpoint also exists (returns same response shape) but the exact credential encoding is **the first thing to confirm during implementation** by:
   - Running the browser login while monitoring network traffic in DevTools
   - Checking whether password is plain text, MD5, or SHA256
   - Checking exact JSON field names used by the React form

**Token format:** base64-encoded string, decoded structure: `<secret>:<timestamp_ms>:<userId>::WebApplication`

**Token expiry:** returned as a separate ISO-8601 field alongside the token in the login response (observed in localStorage as `tokenExpiry`). Refresh when within 5 minutes of expiry.

**Login response shape** (keys observed, values TBD from live login capture):
```json
{
  "token": "<bearer token>",
  "renewToken": "<refresh token or null>",
  "status": "...",
  "title": "...",
  "message": "..."
}
```

**Required headers on all authenticated requests:**
```
Authorization: Bearer <token>
ofw-client: WebApplication
ofw-version: 1.0.0
Accept: application/json
Content-Type: application/json
```

> **Note on `ofw-version`:** Value `1.0.0` observed from live browser traffic. If API calls start failing silently, this may need updating to match whatever the current web client sends.

**Logout:** `GET /ofw/logout`

**Credentials:** sourced from `OFW_EMAIL` and `OFW_PASSWORD` environment variables.

### Known Endpoints

#### User
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/users/useraccountstatus` | Account status + notification counts |
| GET | `/pub/v1/users/registrations/{userId}` | User registration info |
| GET | `/pub/v1/profiles` | User + co-parent profiles (v1) |
| GET | `/pub/v2/profiles` | User + co-parent profiles (v2, preferred) |

#### Messages
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/messageFolders?includeFolderCounts=true` | List folders with unread counts |
| GET | `/pub/v3/messages?folders={id}&page={n}&size={n}&sort=date&sortDirection=desc` | List messages in folder |
| GET | `/pub/v3/messages/contacts?includeSelf=true` | List message contacts |
| GET | `/pub/v3/messages/{messageId}` | Get single message (endpoint to confirm) |
| POST | `/pub/v3/messages` | Send message (body TBD — discover by submitting form in browser with DevTools) |

> **Note on `ofw_send_message` folderId param:** In OFW, messages are organized into named folders (e.g. "Inbox", "Sent"). The `folderId` in the send tool refers to the destination folder for threading/filing, not a recipient group. Confirm exact field name in POST body during impl.

#### Calendar
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/calendar/basic?startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}` | Events (summary) |
| GET | `/pub/v1/calendar/detailed?startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}` | Events (full detail) |
| GET | `/pub/v1/calendar/preference/weekstartday` | Week start preference |
| POST | `/pub/v1/calendar/events` | Create event (body TBD — discover via DevTools) |
| PUT | `/pub/v1/calendar/events/{id}` | Update event |
| DELETE | `/pub/v1/calendar/events/{id}` | Delete event |

Calendar event fields (observed from browser UI — exact JSON keys TBD via DevTools):
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
| GET | `/pub/v2/expense/expenses?start={n}&max={n}` | List expenses (pagination params to confirm) |
| POST | `/pub/v2/expense/expenses` | Create expense (body TBD — discover via DevTools) |

#### Journal
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/journals?start={n}&max={n}` | List journal entries (paginated) |
| POST | `/pub/v1/journals` | Create journal entry (body TBD — discover via DevTools) |

#### Calls
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pub/v1/calls/features` | Call feature flags |
| GET | `/pub/v1/calls/consent` | Call consent status |

> **Note:** POST/PUT/DELETE request bodies marked TBD are to be discovered by opening Chrome DevTools → Network tab, performing each action in the browser UI, and reading the request payload. Do this for calendar create, message send, expense create, and journal create before implementing those tools.

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
- Params: `folderId`, `page` (default 1), `size` (default 50)
- Calls: `GET /pub/v3/messages?folders={folderId}&page={page}&size={size}&sort=date&sortDirection=desc`

**`ofw_get_message`**
- Params: `messageId`
- Calls: `GET /pub/v3/messages/{messageId}` (confirm endpoint exists during impl)

**`ofw_send_message`**
- Params: `subject`, `body`, `recipients` (array of contact IDs)
- Calls: `POST /pub/v3/messages` (exact body to confirm via DevTools)

### Calendar Tools (`calendar.ts`)

**`ofw_list_events`**
- Params: `startDate` (YYYY-MM-DD), `endDate` (YYYY-MM-DD), `detailed` (boolean, default false)
- Calls: `/pub/v1/calendar/basic` or `/pub/v1/calendar/detailed`

**`ofw_create_event`**
- Params: `title`, `startDate`, `endDate`, `allDay?`, `location?`, `reminder?`, `privateEvent?`, `eventFor?`, `dropOffParent?`, `pickUpParent?`, `children?` (array of child IDs)
- Calls: `POST /pub/v1/calendar/events` (body to confirm via DevTools)

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
- Params: `start` (default 0), `max` (default 20)
- Calls: `GET /pub/v2/expense/expenses`

**`ofw_create_expense`**
- Params: to be determined via DevTools capture
- Calls: `POST /pub/v2/expense/expenses`

### Journal Tools (`journal.ts`)

**`ofw_list_journal_entries`**
- Params: `start` (default 1), `max` (default 10)
- Calls: `GET /pub/v1/journals`

**`ofw_create_journal_entry`**
- Params: to be determined via DevTools capture
- Calls: `POST /pub/v1/journals`

---

## Auth Client Design (`client.ts`)

```typescript
class OFWClient {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  async request<T>(method: string, path: string, body?: unknown): Promise<T>
  private async ensureAuthenticated(): Promise<void>
  private async login(): Promise<void>          // sets this.token + this.tokenExpiry
  private isTokenExpiredSoon(): boolean         // true if null or within 5 min of expiry
}
```

`request()` calls `ensureAuthenticated()` before every API call — transparent to all tools.

`tokenExpiry` is parsed from the login response (ISO-8601 string field). The exact response field name (`tokenExpiry`, `expiry`, `expiresAt`) is to be confirmed when the login flow is captured.

On 401 from any non-login endpoint: clear token and retry once via `ensureAuthenticated()`. Propagate error on second failure.

---

## Plugin Manifest

**`plugin.json`**
```json
{
  "name": "ofw",
  "version": "1.0.0",
  "description": "OurFamilyWizard co-parenting tools for Claude",
  "type": "mcp"
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

> **Build requirement:** `dist/index.js` is produced by `npm run build` (`tsc`). The `.mcp.json` will fail silently on a fresh checkout if `dist/` doesn't exist. Run `npm install && npm run build` before registering the plugin.

---

## Error Handling

- 401 responses trigger a single re-login attempt; propagate error on second failure
- 403 responses returned as descriptive tool errors
- Network errors wrapped with context
- Rate limiting: on 429, retry once after a 2-second delay; surface error to Claude on second failure
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
