# OurFamilyWizard requests for fpx + curl

Base URL for every call: `https://ofw.ourfamilywizard.com`. Every request
carries these three headers (from `src/protocol.ts` / `src/client.ts`):

```sh
AUTH_HEADERS=(-H "Authorization: Bearer $TOKEN" -H 'ofw-client: WebApplication' -H 'ofw-version: 1.0.0')
```

`$TOKEN` comes from the one-time capture in `SKILL.md`. All paths, params,
and bodies below are transcribed from `src/tools/*.ts`, `src/sync.ts`, and
`src/tools/_shared.ts` — the exact shapes `ofw-mcp` sends.

---

## 1. Profile & dashboard

**Current user + co-parent profile:**

```sh
curl -s 'https://ofw.ourfamilywizard.com/pub/v2/profiles' "${AUTH_HEADERS[@]}" | jq .
```

**Dashboard summary (unread count, upcoming events, outstanding expenses).
Note: this call updates your last-seen status on OFW, same as opening the
web app's dashboard:**

```sh
curl -s 'https://ofw.ourfamilywizard.com/pub/v1/users/useraccountstatus' "${AUTH_HEADERS[@]}" | jq .
```

## 2. Messages — folders, list, detail

**Folder IDs + unread counts** (needed before listing by folder):

```sh
curl -s 'https://ofw.ourfamilywizard.com/pub/v1/messageFolders?includeFolderCounts=true' "${AUTH_HEADERS[@]}" \
  | jq '.systemFolders[] | {id, folderType}'
# folderType is one of INBOX / SENT_MESSAGES / DRAFTS
```

**List messages in a folder** (date-desc, 50/page is what the MCP's sync
uses; unread inbox items carry `showNeverViewed: true` — the reliable
unread signal, per CLAUDE.md):

```sh
FOLDER_ID=<id from above>
curl -s "https://ofw.ourfamilywizard.com/pub/v3/messages?folders=${FOLDER_ID}&page=1&size=50&sort=date&sortDirection=desc" \
  "${AUTH_HEADERS[@]}" \
  | jq '.data[] | {id, subject, sentAt: .date.dateTime, from: .from.name, showNeverViewed}'
```

**Message/draft detail by id** (GETting an unread inbox message marks it
read on OFW):

```sh
curl -s "https://ofw.ourfamilywizard.com/pub/v3/messages/${ID}" "${AUTH_HEADERS[@]}" \
  | jq '{id, subject, body, sentAt: .date.dateTime, from: .from.name, files, recipients: [.recipients[] | {id: .user.userId, name: .user.name, viewedAt: .viewed.dateTime}]}'
```

## 3. Send a message / save a draft (write — confirm-by-re-GET)

Both send and save-draft POST the same shape to `/pub/v3/messages`; only
`draft` (bool) differs. **Never pass `messageId`/an existing id in this
POST** — OFW's update-in-place endpoint silently no-ops on repeat edits
while echoing success. To "replace" a draft: POST a fresh one, confirm it
landed, then bulk-delete the old id (§4).

```sh
BODY=$(jq -n \
  --arg subject 'Pickup time change' \
  --arg body 'Can we move Friday pickup to 5pm instead of 4?' \
  --argjson recipientIds '[12345]' \
  --argjson myFileIDs '[]' \
  --arg draft false \
  --arg includeOriginal false \
  --argjson replyToId null \
  '{subject:$subject, body:$body, recipientIds:$recipientIds,
    attachments:{myFileIDs:$myFileIDs}, draft:($draft=="true"),
    includeOriginal:($includeOriginal=="true"), replyToId:$replyToId}')

RESP=$(curl -s -X POST 'https://ofw.ourfamilywizard.com/pub/v3/messages' \
  "${AUTH_HEADERS[@]}" -H 'Content-Type: application/json' --data "$BODY")

NEW_ID=$(jq -r '.id // .entityId // empty' <<<"$RESP")
[ -n "$NEW_ID" ] || { echo "SEND UNCONFIRMED: no id in response: $RESP" >&2; exit 1; }

# Re-GET immediately — the only honest way to confirm the write landed.
DETAIL=$(curl -s "https://ofw.ourfamilywizard.com/pub/v3/messages/${NEW_ID}" "${AUTH_HEADERS[@]}")
jq -e --arg s 'Pickup time change' --arg b 'Can we move Friday pickup' \
  '(.subject // "" | contains($s)) and (.body // "" | contains($b))' <<<"$DETAIL" >/dev/null \
  && echo "confirmed id=$NEW_ID" || echo "WARNING: re-fetched body/subject does not contain what was sent — verify on ourfamilywizard.com" >&2
```

For a **draft**, set `draft:true`; `subject`/`body` are the only required
fields (`recipientIds` may be `[]`).

To **reply**, set `replyToId` to the parent message id and
`includeOriginal:true` (OFW appends the original message to the body
server-side — that's why containment, not equality, is the right check
above).

## 4. Delete messages/drafts (bulk, multipart)

Same endpoint deletes both sent-message ids and draft ids — pass whichever
you mean:

```sh
curl -s -X DELETE 'https://ofw.ourfamilywizard.com/pub/v1/messages' \
  "${AUTH_HEADERS[@]}" \
  -F 'messageIds=111' -F 'messageIds=222'   # repeat -F per id
```

## 5. Attachments

**Upload a file to "My Files"** (multipart; `shareClass` is `PRIVATE` or
`SHARED`; matches the web UI's upload request in `src/tools/messages.ts`):

```sh
curl -s -X POST 'https://ofw.ourfamilywizard.com/pub/v3/myfiles/multipart' \
  "${AUTH_HEADERS[@]}" \
  -F "file=@/path/to/file.pdf;type=application/pdf" \
  -F 'source=message' \
  -F 'description=file.pdf' \
  -F 'label=file.pdf' \
  -F 'fileName=file.pdf' \
  -F 'shareClass=PRIVATE' \
  | jq '{fileId, fileName, fileType, sizeInBytes}'
```

The response's `fileId` is what you pass as `myFileIDs` in §3's POST body
(`attachments.myFileIDs`) to attach it to a message/draft.

**Attachment metadata:**

```sh
curl -s "https://ofw.ourfamilywizard.com/pub/v1/myfiles/${FILE_ID}" "${AUTH_HEADERS[@]}" \
  | jq '{fileId, fileName, fileType, fileSize, label}'
```

**Download attachment bytes** (binary — write straight to a file, don't
pipe through `jq`):

```sh
curl -s "https://ofw.ourfamilywizard.com/pub/v1/myfiles/${FILE_ID}/data" \
  "${AUTH_HEADERS[@]}" -o "./${FILE_ID}-download"
```

## 6. Calendar

**List events** (`basic` or `detailed`; dates are `YYYY-MM-DD`):

```sh
curl -s "https://ofw.ourfamilywizard.com/pub/v1/calendar/basic?startDate=2026-07-01&endDate=2026-07-31" \
  "${AUTH_HEADERS[@]}" | jq .
# swap "basic" for "detailed" for full event details
```

**Create an event** (write — court-visible; `eventFor` is
`neither|parent1|parent2`):

```sh
BODY=$(jq -n '{
  title: "Soccer practice",
  startDate: "2026-07-20T16:00:00",
  endDate: "2026-07-20T17:30:00",
  allDay: false,
  location: "Community field",
  reminder: "1 hour before",
  privateEvent: false,
  eventFor: "neither",
  children: [67890]
}')
curl -s -X POST 'https://ofw.ourfamilywizard.com/pub/v1/calendar/events' \
  "${AUTH_HEADERS[@]}" -H 'Content-Type: application/json' --data "$BODY" | jq .
```

**Update an event** (send only the fields you're changing):

```sh
curl -s -X PUT "https://ofw.ourfamilywizard.com/pub/v1/calendar/events/${EVENT_ID}" \
  "${AUTH_HEADERS[@]}" -H 'Content-Type: application/json' \
  --data '{"title":"Soccer practice (moved)","startDate":"2026-07-20T17:00:00"}' | jq .
```

**Delete an event:**

```sh
curl -s -X DELETE "https://ofw.ourfamilywizard.com/pub/v1/calendar/events/${EVENT_ID}" "${AUTH_HEADERS[@]}"
```

## 7. Expenses

**Totals (owed/paid):**

```sh
curl -s 'https://ofw.ourfamilywizard.com/pub/v2/expense/expenses/totals' "${AUTH_HEADERS[@]}" | jq .
```

**List expenses** (offset-based, 0-indexed `start`):

```sh
curl -s 'https://ofw.ourfamilywizard.com/pub/v2/expense/expenses?start=0&max=20' "${AUTH_HEADERS[@]}" | jq .
```

**Create an expense** (write):

```sh
curl -s -X POST 'https://ofw.ourfamilywizard.com/pub/v2/expense/expenses' \
  "${AUTH_HEADERS[@]}" -H 'Content-Type: application/json' \
  --data '{"amount": 45.00, "description": "Cleats for soccer"}' | jq .
```

## 8. Journal

**List entries** (offset-based, but **1-indexed** `start` — unlike
expenses):

```sh
curl -s 'https://ofw.ourfamilywizard.com/pub/v1/journals?start=1&max=10' "${AUTH_HEADERS[@]}" | jq .
```

**Create an entry** (write — journal entries are a permanent court record):

```sh
curl -s -X POST 'https://ofw.ourfamilywizard.com/pub/v1/journals' \
  "${AUTH_HEADERS[@]}" -H 'Content-Type: application/json' \
  --data '{"title": "Missed pickup", "body": "Co-parent arrived 45 min late without notice."}' | jq .
```

---

## Auth-error / retry recipe (wrap any of the above)

```sh
RESP_FILE=$(mktemp /tmp/ofw-resp.XXXXXX.json)
trap 'rm -f "$RESP_FILE"' EXIT

call() { curl -s -o "$RESP_FILE" -w '%{http_code}' "$@" "${AUTH_HEADERS[@]}"; }

STATUS=$(call 'https://ofw.ourfamilywizard.com/pub/v2/profiles')
if [ "$STATUS" = "429" ]; then
  sleep 2
  STATUS=$(call 'https://ofw.ourfamilywizard.com/pub/v2/profiles')
fi
if [ "$STATUS" = "401" ]; then
  echo "token expired — reload/sign in on the ourfamilywizard.com tab, then re-run the fpx local-storage capture" >&2
  exit 1
fi
[ "$STATUS" -lt 300 ] || { echo "OFW API error: $STATUS $(cat "$RESP_FILE")" >&2; exit 1; }
jq . "$RESP_FILE"
```
