# Design: ofw_get_unread_sent

**Date:** 2026-03-30

## Goal

Add a new MCP tool that scans the user's sent messages and reports which ones have not been read by which recipients.

## Tool Interface

```
ofw_get_unread_sent(page?: number, size?: number)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page of sent messages to scan |
| `size` | number | 20 | Number of sent messages to fetch per page |

**Returns:** A filtered list of sent messages where at least one recipient has not read the message.

```json
[
  {
    "id": 12345,
    "subject": "Schedule change for Tuesday",
    "sentAt": "2026-03-28T14:00:00Z",
    "unreadBy": ["Jane Smith"]
  }
]
```

If all scanned messages have been read by all recipients, returns an empty array with a human-readable note.

## Execution Flow

1. Call `GET /pub/v1/messageFolders?includeFolderCounts=true` to find the sent folder ID (folder with `folderType: SENT` or name matching "Sent").
2. Call `GET /pub/v3/messages?folders={sentFolderId}&page={page}&size={size}&sort=date&sortDirection=desc` to list sent messages.
3. For each message in the list, call `GET /pub/v3/messages/{id}` to retrieve full detail including per-recipient read status.
4. Filter to messages where any recipient lacks a read timestamp (field TBD — expected to be `recipients[].readAt` or `recipients[].read`; handle absence gracefully).
5. Return the normalized unread list.

## Open Question: API Read Receipt Field

The exact field name for per-recipient read status is not yet confirmed. The implementation should:
- Inspect `recipients` array on the message detail response
- Treat a recipient as "unread" if `readAt` is null/undefined, or `read === false`, or equivalent
- If no read-status field is present on any recipient, return the raw recipients data so the caller can investigate

## Architecture

- New case `ofw_get_unread_sent` added to `src/tools/messages.ts` (`toolDefinitions` array + `handleTool` switch)
- No new files needed — follows the existing pattern exactly
- `src/index.ts` requires no changes (message tools are registered dynamically)

## Testing

Follow the existing mock pattern in `tests/tools/messages.test.ts`:

- Mock three sequential `client.request` calls: folders → list sent → get message (×N)
- Test: messages with all recipients read are excluded
- Test: messages with any unread recipient are included, listing only unread recipients by name
- Test: empty result when all sent messages are read
- Test: `page` and `size` params are forwarded correctly
- Test: `toolDefinitions` count increases from 7 to 8

## Constraints

- No new files
- No changes to existing tool behavior
- `size` should be capped at a reasonable limit (50) in description/docs to keep API call count bounded
- Tool is read-only (`readOnlyHint: true`) — it does not mark messages as read
