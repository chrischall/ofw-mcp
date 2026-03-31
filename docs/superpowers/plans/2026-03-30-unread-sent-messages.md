# ofw_get_unread_sent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ofw_get_unread_sent` MCP tool that fetches the user's sent messages and returns only those with at least one recipient who has not read the message.

**Architecture:** The tool makes three types of API calls in sequence: (1) fetch message folders to find the sent folder ID, (2) list sent messages with pagination, (3) fetch each message's detail to check per-recipient read status. It filters to messages where any recipient has not read the message and returns a normalized list.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, vitest

---

## File Map

- **Modify:** `src/tools/messages.ts` — add tool definition + handler case
- **Modify:** `tests/tools/messages.test.ts` — add tests for new tool

---

### Task 1: Write failing tests for `ofw_get_unread_sent`

**Files:**
- Modify: `tests/tools/messages.test.ts`

> **API assumption:** The OFW message detail endpoint returns a `recipients` array where each entry has a `readAt` field (string timestamp or null). A null `readAt` means the recipient has not read the message. If the real API uses a different field name, update the `handleTool` implementation in Task 2 and the mock data here to match.

- [ ] **Step 1: Add the test block at the end of `tests/tools/messages.test.ts`, before the `toolDefinitions` count test**

Add this block after the `ofw_delete_draft` describe block and before the `toolDefinitions` describe block:

```typescript
describe('ofw_get_unread_sent', () => {
  it('fetches sent folder id, lists sent messages, and fetches each for read status', async () => {
    const c = new OFWClient();
    const spy = vi.spyOn(c, 'request')
      .mockResolvedValueOnce([
        { id: 'sent-folder-1', folderType: 'SENT', name: 'Sent' },
        { id: 'inbox-1', folderType: 'INBOX', name: 'Inbox' },
      ])
      .mockResolvedValueOnce({
        items: [
          { id: 101, subject: 'Pickup Tuesday' },
          { id: 102, subject: 'School forms' },
        ],
      })
      .mockResolvedValueOnce({
        id: 101,
        subject: 'Pickup Tuesday',
        createdDate: '2026-03-28T14:00:00Z',
        recipients: [
          { userId: 999, displayName: 'Jane Smith', readAt: null },
        ],
      })
      .mockResolvedValueOnce({
        id: 102,
        subject: 'School forms',
        createdDate: '2026-03-27T09:00:00Z',
        recipients: [
          { userId: 999, displayName: 'Jane Smith', readAt: '2026-03-27T10:00:00Z' },
        ],
      });

    const result = await handleTool('ofw_get_unread_sent', {}, c);

    expect(spy).toHaveBeenNthCalledWith(1, 'GET', '/pub/v1/messageFolders?includeFolderCounts=true');
    expect(spy).toHaveBeenNthCalledWith(2, 'GET', '/pub/v3/messages?folders=sent-folder-1&page=1&size=20&sort=date&sortDirection=desc');
    expect(spy).toHaveBeenNthCalledWith(3, 'GET', '/pub/v3/messages/101');
    expect(spy).toHaveBeenNthCalledWith(4, 'GET', '/pub/v3/messages/102');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: 101,
      subject: 'Pickup Tuesday',
      sentAt: '2026-03-28T14:00:00Z',
      unreadBy: ['Jane Smith'],
    });
  });

  it('returns empty array message when all sent messages have been read', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT', name: 'Sent' }])
      .mockResolvedValueOnce({
        items: [{ id: 200, subject: 'Done' }],
      })
      .mockResolvedValueOnce({
        id: 200,
        subject: 'Done',
        createdDate: '2026-03-20T08:00:00Z',
        recipients: [
          { userId: 999, displayName: 'Jane Smith', readAt: '2026-03-20T09:00:00Z' },
        ],
      });

    const result = await handleTool('ofw_get_unread_sent', {}, c);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ message: 'All scanned sent messages have been read.' });
  });

  it('handles messages with no items in sent folder', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT', name: 'Sent' }])
      .mockResolvedValueOnce({ items: [] });

    const result = await handleTool('ofw_get_unread_sent', {}, c);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ message: 'All scanned sent messages have been read.' });
  });

  it('passes custom page and size', async () => {
    const c = new OFWClient();
    const spy = vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT', name: 'Sent' }])
      .mockResolvedValueOnce({ items: [] });

    await handleTool('ofw_get_unread_sent', { page: 3, size: 10 }, c);

    expect(spy).toHaveBeenNthCalledWith(2, 'GET', '/pub/v3/messages?folders=sent-1&page=3&size=10&sort=date&sortDirection=desc');
  });

  it('throws if no sent folder is found', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request').mockResolvedValueOnce([
      { id: 'inbox-1', folderType: 'INBOX', name: 'Inbox' },
    ]);

    await expect(handleTool('ofw_get_unread_sent', {}, c)).rejects.toThrow('Sent folder not found');
  });

  it('includes all unread recipients when multiple recipients exist', async () => {
    const c = new OFWClient();
    vi.spyOn(c, 'request')
      .mockResolvedValueOnce([{ id: 'sent-1', folderType: 'SENT', name: 'Sent' }])
      .mockResolvedValueOnce({ items: [{ id: 300, subject: 'Group message' }] })
      .mockResolvedValueOnce({
        id: 300,
        subject: 'Group message',
        createdDate: '2026-03-29T10:00:00Z',
        recipients: [
          { userId: 1, displayName: 'Alice', readAt: '2026-03-29T11:00:00Z' },
          { userId: 2, displayName: 'Bob', readAt: null },
          { userId: 3, displayName: 'Carol', readAt: null },
        ],
      });

    const result = await handleTool('ofw_get_unread_sent', {}, c);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].unreadBy).toEqual(['Bob', 'Carol']);
  });
});
```

- [ ] **Step 2: Update the `toolDefinitions` count test from 7 to 8**

In the `toolDefinitions` describe block, change:

```typescript
expect(names).toHaveLength(7);
```

to:

```typescript
expect(names).toHaveLength(8);
```

And add:

```typescript
expect(names).toContain('ofw_get_unread_sent');
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
cd /Users/chris/git/ofw-mcp && npm test
```

Expected: multiple failures — `ofw_get_unread_sent` tests fail with "Unknown tool" and the count test fails with "expected 7 to equal 8".

---

### Task 2: Implement `ofw_get_unread_sent`

**Files:**
- Modify: `src/tools/messages.ts`

- [ ] **Step 1: Add the tool definition to the `toolDefinitions` array**

In `src/tools/messages.ts`, add this entry to the `toolDefinitions` array (after `ofw_delete_draft`):

```typescript
{
  name: 'ofw_get_unread_sent',
  description: 'List sent messages that have not been read by one or more recipients. Fetches sent messages page by page and returns only those with unread recipients.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page of sent messages to scan (default 1)' },
      size: { type: 'number', description: 'Number of sent messages per page, max 50 (default 20)' },
    },
    required: [],
  },
},
```

- [ ] **Step 2: Add the handler case to the `handleTool` switch**

In the `switch (name)` block in `handleTool`, add before `default`:

```typescript
case 'ofw_get_unread_sent': {
  const { page = 1, size = 20 } = args as { page?: number; size?: number };

  // Step 1: find the sent folder
  const folders = await client.request<Array<{ id: string; folderType: string; name: string }>>(
    'GET', '/pub/v1/messageFolders?includeFolderCounts=true'
  );
  const sentFolder = folders.find((f) => f.folderType === 'SENT');
  if (!sentFolder) throw new Error('Sent folder not found');

  // Step 2: list sent messages
  const listPath = `/pub/v3/messages?folders=${encodeURIComponent(sentFolder.id)}&page=${page}&size=${size}&sort=date&sortDirection=desc`;
  const listData = await client.request<{ items: Array<{ id: number; subject: string }> }>('GET', listPath);
  const messages = listData.items ?? [];

  // Step 3: fetch each message detail and filter to unread
  const unread: Array<{ id: number; subject: string; sentAt: string; unreadBy: string[] }> = [];
  for (const msg of messages) {
    const detail = await client.request<{
      id: number;
      subject: string;
      createdDate: string;
      recipients: Array<{ displayName: string; readAt: string | null }>;
    }>('GET', `/pub/v3/messages/${msg.id}`);

    const unreadRecipients = (detail.recipients ?? [])
      .filter((r) => !r.readAt)
      .map((r) => r.displayName);

    if (unreadRecipients.length > 0) {
      unread.push({
        id: detail.id,
        subject: detail.subject,
        sentAt: detail.createdDate,
        unreadBy: unreadRecipients,
      });
    }
  }

  if (unread.length === 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'All scanned sent messages have been read.' }, null, 2) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(unread, null, 2) }] };
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd /Users/chris/git/ofw-mcp && npm test
```

Expected: all tests pass. If any fail due to API field name mismatches (e.g. `folderType` is actually `type`, or `createdDate` is `sentDate`), update the field names in both the implementation and the test mocks to match.

- [ ] **Step 4: Commit**

```bash
cd /Users/chris/git/ofw-mcp && git add src/tools/messages.ts tests/tools/messages.test.ts && git commit -m "feat: add ofw_get_unread_sent tool

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Build and verify

**Files:**
- No file changes — build and smoke check only

- [ ] **Step 1: Build the project**

```bash
cd /Users/chris/git/ofw-mcp && npm run build
```

Expected: exits 0, produces `dist/index.js` and `dist/bundle.js` with no TypeScript errors.

- [ ] **Step 2: Verify the new tool appears in the tool list**

```bash
node -e "
import('./dist/index.js').catch(() => {});
" 2>&1 | head -5
```

(The server starts and logs to stderr — this just confirms the module loads cleanly. A full smoke test requires live OFW credentials.)

- [ ] **Step 3: Commit build artifacts if the project tracks them**

```bash
cd /Users/chris/git/ofw-mcp && git status
```

If `dist/` files are tracked (check `.gitignore`), add and commit them:

```bash
git add dist/ && git commit -m "chore: rebuild dist for ofw_get_unread_sent

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

If `dist/` is in `.gitignore`, skip this step.

---

## Post-Implementation Note

The `readAt` field name used in this plan is an assumption. If the real OFW API uses a different field (e.g. `read: boolean`, `dateRead`, `viewedAt`), you will see unread detection silently fail (all messages appear read). To diagnose: call `ofw_get_message` on a known-unread sent message and inspect the `recipients` array in the raw response to find the correct field name, then update the `.filter((r) => !r.readAt)` line in `handleTool` accordingly.
