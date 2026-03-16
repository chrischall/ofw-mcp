# OurFamilyWizard MCP Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript MCP server that exposes OurFamilyWizard as Claude tools (messages, calendar, expenses, journal, user profile).

**Architecture:** OFWClient handles auth lifecycle (bearer token from env credentials, auto-refresh). Tool modules export definitions + handlers. index.ts wires everything into an MCP stdio server.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `vitest`, `dotenv`, Node.js built-in `fetch` (Node 18+)

**Spec:** `docs/superpowers/specs/2026-03-15-ofw-mcp-plugin-design.md`

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/client.ts` | OFWClient: login, token refresh, request wrapper |
| `src/tools/user.ts` | ofw_get_profile, ofw_get_notifications |
| `src/tools/messages.ts` | ofw_list_message_folders, ofw_list_messages, ofw_get_message, ofw_send_message |
| `src/tools/calendar.ts` | ofw_list_events, ofw_create_event, ofw_update_event, ofw_delete_event |
| `src/tools/expenses.ts` | ofw_get_expense_totals, ofw_list_expenses, ofw_create_expense |
| `src/tools/journal.ts` | ofw_list_journal_entries, ofw_create_journal_entry |
| `src/index.ts` | MCP server, registers all tools, routes calls |
| `tests/client.test.ts` | Auth lifecycle unit tests |
| `tests/tools/user.test.ts` | User tool tests |
| `tests/tools/messages.test.ts` | Message tool tests |
| `tests/tools/calendar.test.ts` | Calendar tool tests |
| `tests/tools/expenses.test.ts` | Expense tool tests |
| `tests/tools/journal.test.ts` | Journal tool tests |

---

## Chunk 1: Setup + Auth Discovery

### Task 1: Discover the login endpoint (manual, do this first)

**Before writing any code**, capture the exact login request payload.

- [ ] **Step 1: Open Chrome DevTools**

  In the browser where OFW is open, press `F12` → Network tab → check "Preserve log". Filter by `Fetch/XHR`.

- [ ] **Step 2: Log out and back in**

  Click the CH avatar → Sign Out. On the login page, enter your OFW credentials and submit.

- [ ] **Step 3: Find the auth request**

  Look for a POST request to a `/pub/` path. Click it → Headers tab to see the request URL and method. Click Payload tab to see the exact JSON body (field names for email/password). Click Response tab to see the token field names.

- [ ] **Step 4: Record findings**

  Note: exact endpoint URL, request body field names, response field names for token and expiry. Create `FINDINGS.md` at the repo root with this template:

  ```markdown
  # OFW Auth Findings

  ## Login endpoint
  - URL: (fill in, e.g. `/pub/v1/auth/login`)
  - Method: POST
  - Request body fields: (e.g. `username`, `password`)
  - Response token field: (e.g. `token`)
  - Response expiry field: (e.g. `tokenExpiry`)
  ```

  You will reference `FINDINGS.md` in Task 3 (Chunk 2) when implementing `src/client.ts`.

---

### Task 2: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env`
- Create: `src/` directory

- [ ] **Step 1: Create package.json**

```bash
cd /Users/chris/git/ofw
```

```json
// package.json
{
  "name": "ofw-mcp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "node --env-file=.env dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
.env
```

- [ ] **Step 4: Create .env**

```
OFW_EMAIL=<your-ofw-email>
OFW_PASSWORD=<your-ofw-password>
```

- [ ] **Step 5: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
mkdir -p src && echo 'export {}' > src/index.ts && npm run build
```

Expected: `dist/index.js` created, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore
git commit -m "chore: scaffold project"
```

---

## Chunk 2: Auth Client

> **Prerequisite:** Complete Task 1 (Chunk 1) before implementing Step 3. The `login()` method uses `POST /pub/v1/auth/login` with request field `username` and response field `tokenExpiry` — check `FINDINGS.md` and update these values if the DevTools capture shows different field names.

### Task 3: OFWClient with auth lifecycle

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OFWClient } from '../src/client.js';

const MOCK_TOKEN = 'test-token-abc';
const MOCK_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let idx = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[idx++] ?? { status: 200, body: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body,
    } as Response;
  });
}

describe('OFWClient', () => {
  beforeEach(() => {
    process.env.OFW_EMAIL = 'test@example.com';
    process.env.OFW_PASSWORD = 'testpass';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs in on first request and sets token', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } }, // login
      { status: 200, body: { data: 'ok' } }, // actual request
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    expect(spy).toHaveBeenCalledTimes(2);
    const loginCall = spy.mock.calls[0];
    expect(loginCall[0]).toContain('/pub/v1/auth/login');
  });

  it('reuses token on subsequent requests', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/a');
    await client.request('GET', '/pub/v1/b');

    // login once + 2 requests = 3 calls total
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('retries with fresh login on 401', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } }, // initial login
      { status: 401, body: {} },                                               // request fails
      { status: 200, body: { token: 'new-token', tokenExpiry: MOCK_EXPIRY } }, // re-login
      { status: 200, body: { result: 'ok' } },                                 // retry
    ]);

    const client = new OFWClient();
    const result = await client.request<{ result: string }>('GET', '/pub/v1/test');

    expect(result.result).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('throws on second 401', async () => {
    mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 401, body: {} },
      { status: 200, body: { token: 'new-token', tokenExpiry: MOCK_EXPIRY } },
      { status: 401, body: {} },
    ]);

    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('401');
  });

  it('retries once on 429 after 2s delay', async () => {
    vi.useFakeTimers();
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 429, body: {} },
      { status: 200, body: { ok: true } },
    ]);

    const client = new OFWClient();
    const promise = client.request('GET', '/pub/v1/test');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ ok: true });
    vi.useRealTimers();
  });

  it('throws on second 429', async () => {
    vi.useFakeTimers();
    mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);

    const client = new OFWClient();
    const promise = client.request('GET', '/pub/v1/test');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).rejects.toThrow('Rate limited');
    vi.useRealTimers();
  });

  it('throws if credentials are missing', async () => {
    delete process.env.OFW_EMAIL;
    const client = new OFWClient();
    await expect(client.request('GET', '/pub/v1/test')).rejects.toThrow('OFW_EMAIL');
  });

  it('sends Authorization header with token', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    const requestCall = spy.mock.calls[1];
    const init = requestCall[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${MOCK_TOKEN}`);
  });

  it('sends ofw-client and ofw-version headers', async () => {
    const spy = mockFetch([
      { status: 200, body: { token: MOCK_TOKEN, tokenExpiry: MOCK_EXPIRY } },
      { status: 200, body: {} },
    ]);

    const client = new OFWClient();
    await client.request('GET', '/pub/v1/test');

    const init = spy.mock.calls[1][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h['ofw-client']).toBe('WebApplication');
    expect(h['ofw-version']).toBe('1.0.0');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test
```

Expected: FAIL — `OFWClient` not found.

- [ ] **Step 3: Implement OFWClient**

```typescript
// src/client.ts
import 'dotenv/config';

const BASE_URL = 'https://ofw.ourfamilywizard.com';

const STATIC_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0',
  Accept: 'application/json',
  'Content-Type': 'application/json',
} as const;

interface LoginResponse {
  token: string;
  tokenExpiry?: string; // observed in localStorage; update from FINDINGS.md if different
}

export class OFWClient {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureAuthenticated();
    return this.doRequest<T>(method, path, body, false);
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: unknown,
    isRetry: boolean
  ): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...STATIC_HEADERS,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 401 && !isRetry) {
      this.token = null;
      this.tokenExpiry = null;
      await this.ensureAuthenticated();
      return this.doRequest<T>(method, path, body, true);
    }

    if (response.status === 429) {
      if (!isRetry) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        return this.doRequest<T>(method, path, body, true);
      }
      throw new Error('Rate limited by OFW API');
    }

    if (!response.ok) {
      throw new Error(
        `OFW API error: ${response.status} ${response.statusText} for ${method} ${path}`
      );
    }

    return response.json() as Promise<T>;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.isTokenExpiredSoon()) return;
    await this.login();
  }

  private async login(): Promise<void> {
    const email = process.env.OFW_EMAIL;
    const password = process.env.OFW_PASSWORD;
    if (!email || !password) {
      throw new Error('OFW_EMAIL and OFW_PASSWORD must be set');
    }

    // Endpoint and field names based on localStorage observation. Update from FINDINGS.md if needed.
    const response = await fetch(`${BASE_URL}/pub/v1/auth/login`, {
      method: 'POST',
      headers: STATIC_HEADERS,
      body: JSON.stringify({ username: email, password }),
    });

    if (!response.ok) {
      throw new Error(`OFW login failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as LoginResponse;
    this.token = data.token;
    // Default to 6h if expiry not returned; update field name after Task 1
    this.tokenExpiry = data.tokenExpiry
      ? new Date(data.tokenExpiry)
      : new Date(Date.now() + 6 * 60 * 60 * 1000);
  }

  private isTokenExpiredSoon(): boolean {
    if (!this.token || !this.tokenExpiry) return true;
    return this.tokenExpiry.getTime() - Date.now() < 5 * 60 * 1000;
  }
}

export const client = new OFWClient();
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: add OFWClient with auth lifecycle"
```

---

## Chunk 3: User + Message Tools

### Task 4: User tools

**Files:**
- Create: `src/tools/user.ts`
- Create: `tests/tools/user.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tools/user.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/user.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_get_profile', () => {
  it('calls /pub/v2/profiles', async () => {
    const profiles = { user: { id: 1, name: 'Chris' }, coParent: { id: 2, name: 'Jane' } };
    const client = makeClient(profiles);

    const result = await handleTool('ofw_get_profile', {}, client);

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/profiles');
    expect(result.content[0].text).toContain('Chris');
  });
});

describe('ofw_get_notifications', () => {
  it('calls /pub/v1/users/useraccountstatus', async () => {
    const status = { unreadMessages: 3, upcomingEvents: 1, outstandingExpenses: 2 };
    const client = makeClient(status);

    const result = await handleTool('ofw_get_notifications', {}, client);

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/users/useraccountstatus');
    expect(result.content[0].text).toContain('3');
  });
});

describe('toolDefinitions', () => {
  it('exports ofw_get_profile and ofw_get_notifications', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain('ofw_get_profile');
    expect(names).toContain('ofw_get_notifications');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test tests/tools/user.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement user tools**

```typescript
// src/tools/user.ts
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_get_profile',
    description: 'Get current user and co-parent profile information from OurFamilyWizard',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ofw_get_notifications',
    description:
      'Get OurFamilyWizard dashboard summary: unread message count, upcoming events, outstanding expenses',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_get_profile': {
      const data = await client.request('GET', '/pub/v2/profiles');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_get_notifications': {
      const data = await client.request('GET', '/pub/v1/users/useraccountstatus');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test tests/tools/user.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/user.ts tests/tools/user.test.ts
git commit -m "feat: add user tools (get_profile, get_notifications)"
```

---

### Task 5: Message tools

**Files:**
- Create: `src/tools/messages.ts`
- Create: `tests/tools/messages.test.ts`

> **Before implementing `ofw_send_message`:** Open OFW Messages → compose a new message → submit while watching DevTools Network tab → record the exact POST body fields. Update the tool implementation below with actual field names.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tools/messages.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/messages.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_list_message_folders', () => {
  it('calls messageFolders with includeFolderCounts=true', async () => {
    const folders = [{ id: 1, name: 'Inbox', unreadCount: 2 }];
    const client = makeClient(folders);

    const result = await handleTool('ofw_list_message_folders', {}, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/messageFolders?includeFolderCounts=true'
    );
    expect(result.content[0].text).toContain('Inbox');
  });
});

describe('ofw_list_messages', () => {
  it('calls messages endpoint with folderId and defaults', async () => {
    const messages = { items: [{ id: 1, subject: 'Hello' }] };
    const client = makeClient(messages);

    await handleTool('ofw_list_messages', { folderId: '42' }, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v3/messages?folders=42&page=1&size=50&sort=date&sortDirection=desc'
    );
  });

  it('passes custom page and size', async () => {
    const client = makeClient({ items: [] });

    await handleTool('ofw_list_messages', { folderId: '5', page: 2, size: 10 }, client);

    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v3/messages?folders=5&page=2&size=10&sort=date&sortDirection=desc'
    );
  });
});

describe('ofw_get_message', () => {
  it('calls /pub/v3/messages/{id}', async () => {
    const msg = { id: 99, subject: 'Test', body: 'Hello' };
    const client = makeClient(msg);

    const result = await handleTool('ofw_get_message', { messageId: '99' }, client);

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v3/messages/99');
    expect(result.content[0].text).toContain('Hello');
  });
});

describe('ofw_send_message', () => {
  it('posts to /pub/v3/messages with subject, body, recipients', async () => {
    const client = makeClient({ id: 200, status: 'sent' });

    await handleTool('ofw_send_message', {
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipients: [123],
    }, client);

    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/messages', expect.objectContaining({
      subject: 'Re: pickup',
      body: 'I will be there at 3pm',
      recipients: [123],
    }));
  });
});

describe('toolDefinitions', () => {
  it('exports 4 message tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain('ofw_list_message_folders');
    expect(names).toContain('ofw_list_messages');
    expect(names).toContain('ofw_get_message');
    expect(names).toContain('ofw_send_message');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test tests/tools/messages.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement message tools**

```typescript
// src/tools/messages.ts
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_list_message_folders',
    description: 'List OurFamilyWizard message folders with unread counts',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ofw_list_messages',
    description: 'List messages in an OurFamilyWizard folder',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder ID (get from ofw_list_message_folders)' },
        page: { type: 'number', description: 'Page number (default 1)' },
        size: { type: 'number', description: 'Messages per page (default 50)' },
      },
      required: ['folderId'],
    },
  },
  {
    name: 'ofw_get_message',
    description: 'Get a single OurFamilyWizard message by ID',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message ID' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'ofw_send_message',
    description: 'Send a message via OurFamilyWizard',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Message subject' },
        body: { type: 'string', description: 'Message body text' },
        recipients: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of recipient contact IDs (get from ofw_get_profile)',
        },
      },
      required: ['subject', 'body', 'recipients'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_list_message_folders': {
      const data = await client.request('GET', '/pub/v1/messageFolders?includeFolderCounts=true');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_list_messages': {
      const { folderId, page = 1, size = 50 } = args as {
        folderId: string;
        page?: number;
        size?: number;
      };
      const path = `/pub/v3/messages?folders=${folderId}&page=${page}&size=${size}&sort=date&sortDirection=desc`;
      const data = await client.request('GET', path);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_get_message': {
      const { messageId } = args as { messageId: string };
      const data = await client.request('GET', `/pub/v3/messages/${messageId}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_send_message': {
      const { subject, body, recipients } = args as {
        subject: string;
        body: string;
        recipients: number[];
      };
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v3/messages', { subject, body, recipients });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test tests/tools/messages.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/messages.ts tests/tools/messages.test.ts
git commit -m "feat: add message tools"
```

---

## Chunk 4: Calendar + Expense + Journal Tools

### Task 6: Calendar tools

**Files:**
- Create: `src/tools/calendar.ts`
- Create: `tests/tools/calendar.test.ts`

> **Before implementing write tools:** Open OFW Calendar → New → Event → fill in and submit → capture POST body in DevTools. Record field names. Update `ofw_create_event` body below.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tools/calendar.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/calendar.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_list_events', () => {
  it('calls calendar/basic by default', async () => {
    const client = makeClient([]);
    await handleTool('ofw_list_events', { startDate: '2026-03-01', endDate: '2026-03-31' }, client);
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/calendar/basic?startDate=2026-03-01&endDate=2026-03-31'
    );
  });

  it('calls calendar/detailed when detailed=true', async () => {
    const client = makeClient([]);
    await handleTool('ofw_list_events', {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      detailed: true,
    }, client);
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/calendar/detailed?startDate=2026-03-01&endDate=2026-03-31'
    );
  });
});

describe('ofw_create_event', () => {
  it('posts to calendar/events with required fields', async () => {
    const client = makeClient({ id: 55 });
    await handleTool('ofw_create_event', {
      title: 'Doctor appointment',
      startDate: '2026-03-20T10:00:00',
      endDate: '2026-03-20T11:00:00',
    }, client);
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v1/calendar/events',
      expect.objectContaining({ title: 'Doctor appointment' })
    );
  });
});

describe('ofw_update_event', () => {
  it('puts to calendar/events/{id}', async () => {
    const client = makeClient({ id: 55 });
    await handleTool('ofw_update_event', { eventId: '55', title: 'Updated' }, client);
    expect(client.request).toHaveBeenCalledWith(
      'PUT',
      '/pub/v1/calendar/events/55',
      expect.objectContaining({ title: 'Updated' })
    );
  });
});

describe('ofw_delete_event', () => {
  it('deletes calendar/events/{id}', async () => {
    const client = makeClient({});
    await handleTool('ofw_delete_event', { eventId: '55' }, client);
    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v1/calendar/events/55');
  });
});

describe('toolDefinitions', () => {
  it('exports 4 calendar tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test tests/tools/calendar.test.ts
```

- [ ] **Step 3: Implement calendar tools**

```typescript
// src/tools/calendar.ts
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_list_events',
    description: 'List OurFamilyWizard calendar events in a date range',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date YYYY-MM-DD' },
        endDate: { type: 'string', description: 'End date YYYY-MM-DD' },
        detailed: { type: 'boolean', description: 'Return full event details (default false)' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'ofw_create_event',
    description: 'Create a calendar event in OurFamilyWizard',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startDate: { type: 'string', description: 'ISO datetime string' },
        endDate: { type: 'string', description: 'ISO datetime string' },
        allDay: { type: 'boolean' },
        location: { type: 'string' },
        reminder: { type: 'string', description: 'Reminder setting (e.g. "1 hour before")' },
        privateEvent: { type: 'boolean' },
        eventFor: { type: 'string', description: 'neither | parent1 | parent2' },
        dropOffParent: { type: 'string' },
        pickUpParent: { type: 'string' },
        children: { type: 'array', items: { type: 'number' }, description: 'Array of child IDs' },
      },
      required: ['title', 'startDate', 'endDate'],
    },
  },
  {
    name: 'ofw_update_event',
    description: 'Update an existing OurFamilyWizard calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        title: { type: 'string' },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        allDay: { type: 'boolean' },
        location: { type: 'string' },
        reminder: { type: 'string' },
        privateEvent: { type: 'boolean' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'ofw_delete_event',
    description: 'Delete an OurFamilyWizard calendar event',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string', description: 'Event ID to delete' } },
      required: ['eventId'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_list_events': {
      const { startDate, endDate, detailed = false } = args as {
        startDate: string;
        endDate: string;
        detailed?: boolean;
      };
      const variant = detailed ? 'detailed' : 'basic';
      const data = await client.request(
        'GET',
        `/pub/v1/calendar/${variant}?startDate=${startDate}&endDate=${endDate}`
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_create_event': {
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v1/calendar/events', args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_update_event': {
      const { eventId, ...updateData } = args as { eventId: string } & Record<string, unknown>;
      const data = await client.request('PUT', `/pub/v1/calendar/events/${eventId}`, updateData);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_delete_event': {
      const { eventId } = args as { eventId: string };
      await client.request('DELETE', `/pub/v1/calendar/events/${eventId}`);
      return { content: [{ type: 'text', text: `Event ${eventId} deleted` }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test tests/tools/calendar.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/calendar.ts tests/tools/calendar.test.ts
git commit -m "feat: add calendar tools"
```

---

### Task 7: Expense tools

**Files:**
- Create: `src/tools/expenses.ts`
- Create: `tests/tools/expenses.test.ts`

> **Before implementing `ofw_create_expense`:** Open OFW Expenses → Log Expense → fill in and submit → capture POST body in DevTools. Update the tool body below.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tools/expenses.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/expenses.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_get_expense_totals', () => {
  it('calls /pub/v2/expense/expenses/totals', async () => {
    const totals = { owed: 100, paid: 50 };
    const client = makeClient(totals);
    const result = await handleTool('ofw_get_expense_totals', {}, client);
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/expense/expenses/totals');
    expect(result.content[0].text).toContain('100');
  });
});

describe('ofw_list_expenses', () => {
  it('calls expenses with default pagination', async () => {
    const client = makeClient([]);
    await handleTool('ofw_list_expenses', {}, client);
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=0&max=20'
    );
  });

  it('passes custom start and max', async () => {
    const client = makeClient([]);
    await handleTool('ofw_list_expenses', { start: 20, max: 10 }, client);
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=20&max=10'
    );
  });
});

describe('ofw_create_expense', () => {
  it('posts to /pub/v2/expense/expenses', async () => {
    const client = makeClient({ id: 99 });
    await handleTool('ofw_create_expense', { amount: 50, description: 'School supplies' }, client);
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense/expenses',
      expect.objectContaining({ amount: 50 })
    );
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test tests/tools/expenses.test.ts
```

- [ ] **Step 3: Implement expense tools**

```typescript
// src/tools/expenses.ts
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_get_expense_totals',
    description: 'Get OurFamilyWizard expense summary totals (owed/paid)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ofw_list_expenses',
    description: 'List OurFamilyWizard expenses with pagination',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', description: 'Start offset (default 0)' },
        max: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'ofw_create_expense',
    description: 'Log a new expense in OurFamilyWizard',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Expense amount' },
        description: { type: 'string', description: 'Expense description' },
        // Additional fields TBD — add after DevTools capture (see pre-task note)
      },
      required: ['amount', 'description'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_get_expense_totals': {
      const data = await client.request('GET', '/pub/v2/expense/expenses/totals');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_list_expenses': {
      const { start = 0, max = 20 } = args as { start?: number; max?: number };
      const data = await client.request('GET', `/pub/v2/expense/expenses?start=${start}&max=${max}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_create_expense': {
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v2/expense/expenses', args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test tests/tools/expenses.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/expenses.ts tests/tools/expenses.test.ts
git commit -m "feat: add expense tools"
```

---

### Task 8: Journal tools

**Files:**
- Create: `src/tools/journal.ts`
- Create: `tests/tools/journal.test.ts`

> **Before implementing `ofw_create_journal_entry`:** Open OFW Journal → New Entry → fill in and submit → capture POST body in DevTools.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tools/journal.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/journal.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_list_journal_entries', () => {
  it('calls /pub/v1/journals with default pagination', async () => {
    const client = makeClient({ entries: [] });
    await handleTool('ofw_list_journal_entries', {}, client);
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/journals?start=1&max=10');
  });

  it('passes custom start and max', async () => {
    const client = makeClient({ entries: [] });
    await handleTool('ofw_list_journal_entries', { start: 11, max: 5 }, client);
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/journals?start=11&max=5');
  });
});

describe('ofw_create_journal_entry', () => {
  it('posts to /pub/v1/journals', async () => {
    const client = makeClient({ id: 1 });
    await handleTool('ofw_create_journal_entry', { title: 'Today', body: 'Good day' }, client);
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v1/journals',
      expect.objectContaining({ title: 'Today' })
    );
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test tests/tools/journal.test.ts
```

- [ ] **Step 3: Implement journal tools**

```typescript
// src/tools/journal.ts
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_list_journal_entries',
    description: 'List OurFamilyWizard journal entries',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', description: 'Start offset (default 1)' },
        max: { type: 'number', description: 'Max results (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'ofw_create_journal_entry',
    description: 'Create a new journal entry in OurFamilyWizard',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Entry title' },
        body: { type: 'string', description: 'Entry text content' },
        // Additional fields TBD — add after DevTools capture (see pre-task note)
      },
      required: ['title', 'body'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_list_journal_entries': {
      const { start = 1, max = 10 } = args as { start?: number; max?: number };
      const data = await client.request('GET', `/pub/v1/journals?start=${start}&max=${max}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_create_journal_entry': {
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v1/journals', args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test tests/tools/journal.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/journal.ts tests/tools/journal.test.ts
git commit -m "feat: add journal tools"
```

---

## Chunk 5: MCP Server + Plugin + Smoke Test

### Task 9: MCP server entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement index.ts**

```typescript
// src/index.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { client } from './client.js';
import { toolDefinitions as userTools, handleTool as handleUser } from './tools/user.js';
import { toolDefinitions as messageTools, handleTool as handleMessages } from './tools/messages.js';
import { toolDefinitions as calendarTools, handleTool as handleCalendar } from './tools/calendar.js';
import { toolDefinitions as expenseTools, handleTool as handleExpenses } from './tools/expenses.js';
import { toolDefinitions as journalTools, handleTool as handleJournal } from './tools/journal.js';

const allTools = [
  ...userTools,
  ...messageTools,
  ...calendarTools,
  ...expenseTools,
  ...journalTools,
];

const handlers: Record<string, (name: string, args: Record<string, unknown>) => Promise<unknown>> = {};

for (const tool of userTools) handlers[tool.name] = (n, a) => handleUser(n, a, client);
for (const tool of messageTools) handlers[tool.name] = (n, a) => handleMessages(n, a, client);
for (const tool of calendarTools) handlers[tool.name] = (n, a) => handleCalendar(n, a, client);
for (const tool of expenseTools) handlers[tool.name] = (n, a) => handleExpenses(n, a, client);
for (const tool of journalTools) handlers[tool.name] = (n, a) => handleJournal(n, a, client);

const server = new Server(
  { name: 'ofw', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await handler(name, args as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Build and verify no TypeScript errors**

```bash
npm run build
```

Expected: `dist/index.js` created, zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add MCP server entry point"
```

---

### Task 10: Plugin manifests

**Files:**
- Create: `plugin.json`
- Create: `.mcp.json`

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "ofw",
  "version": "1.0.0",
  "description": "OurFamilyWizard co-parenting tools for Claude",
  "type": "mcp"
}
```

- [ ] **Step 2: Create .mcp.json**

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

- [ ] **Step 3: Commit**

```bash
git add plugin.json .mcp.json
git commit -m "chore: add plugin manifests"
```

---

### Task 11: Run all tests + smoke test

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass (8 client + 3 user + 6 message + 5 calendar + 4 expense + 3 journal = ~29 tests).

- [ ] **Step 2: Build final dist**

```bash
npm run build
```

- [ ] **Step 3: Smoke test — list profiles**

  Credentials are loaded from `.env` via `dotenv`. Source it into your shell first:

  ```bash
  export $(grep -v '^#' .env | xargs)
  ```

  Then run:

  ```bash
  node -e "
  import('./dist/tools/user.js').then(async m => {
    const { OFWClient } = await import('./dist/client.js');
    const c = new OFWClient();
    const r = await m.handleTool('ofw_get_profile', {}, c);
    console.log(r.content[0].text);
  });
  "
  ```

Expected: JSON profile data printed, no errors.

  > If login fails: complete Task 1 (DevTools capture) first, then update the `login()` method in `src/client.ts` with the correct endpoint/field names, rebuild, and retest.

- [ ] **Step 4: Smoke test — list calendar events**

  (Ensure `OFW_EMAIL` and `OFW_PASSWORD` are still set from Step 3.)

  ```bash
  node -e "
  import('./dist/tools/calendar.js').then(async m => {
    const { OFWClient } = await import('./dist/client.js');
    const c = new OFWClient();
    const r = await m.handleTool('ofw_list_events', { startDate: '2026-03-01', endDate: '2026-03-31' }, c);
    console.log(r.content[0].text);
  });
  "
  ```

Expected: JSON array of March 2026 calendar events.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete OFW MCP plugin v1.0.0"
```

---

## Post-Implementation: Confirm TBD endpoints

After the smoke test passes, do these DevTools captures to finalize write tools:

1. **Send message:** Compose a message in OFW → submit → capture POST body → update `src/tools/messages.ts` `ofw_send_message` handler
2. **Create calendar event:** New Event → submit → capture POST body → update `src/tools/calendar.ts` `ofw_create_event` handler
3. **Create expense:** Log Expense → submit → capture → update `src/tools/expenses.ts`
4. **Create journal entry:** New Journal Entry → submit → capture → update `src/tools/journal.ts`

For each: update the handler, update the test to assert on the correct fields, run `npm test`, commit.
