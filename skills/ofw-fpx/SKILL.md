---
name: ofw-fpx
description: >-
  Access OurFamilyWizard (OFW) — messages, calendar, expenses, journal —
  from a shell with the fpx CLI (@fetchproxy/cli) instead of running the
  ofw-mcp server: capture the signed-in web app's Bearer token once via the
  browser bridge, then curl the REST API directly. Use when you want OFW
  data without the MCP, in a script, or on a machine where the MCP isn't
  installed.
---

# OurFamilyWizard via fpx + curl (no MCP)

OFW's app (`ofw.ourfamilywizard.com`) has no API key a script can request —
the only credential is the Bearer token the web app itself mints on login
and stores in `localStorage["auth"]` (with `localStorage["tokenExpiry"]`
alongside). Once you have that token the API itself has **no bot wall** —
`ofw-mcp`'s own `src/client.ts` calls it with plain Node `fetch` for every
request. So this skill is **hybrid**: `fpx` captures the token from a
signed-in browser tab ONCE, then plain `curl` does every read/write from
then on. fetchproxy never touches the actual API calls.

**This is a shared family-court record.** Every write here (`send`,
`create_event`, `create_expense`, `create_journal_entry`,
`upload_attachment`, the `delete_*`/bulk-delete calls) lands on the same
record the MCP's `OFW_WRITE_MODE` gate exists to protect. There is no
dry-run/confirm here — curl just does it. Treat every write like the MCP's
`all` mode: real, permanent, and visible to your co-parent.

## One-time setup

```sh
npm install -g @fetchproxy/cli                                       # provides `fpx`
fpx profile add ofw --domain ourfamilywizard.com
fpx profile declare ofw --local-storage auth --local-storage tokenExpiry
fpx pair -p ofw                                                       # prints a pair code → approve in Transporter
```

Requirements: the **Transporter** browser extension installed, with an
open, signed-in `ofw.ourfamilywizard.com` (or `www.ourfamilywizard.com`)
tab, and its Chrome **Site access** allowing `ourfamilywizard.com`. Pairing
persists across invocations.

## Capture the token (once per shell / whenever it goes stale)

```sh
LS=$(fpx local-storage auth tokenExpiry -p ofw)
TOKEN=$(jq -r '.auth' <<<"$LS")
EXPIRES=$(jq -r '.tokenExpiry' <<<"$LS")
```

If `auth` comes back empty, sign into OFW in the browser tab first — the
same precondition `ofw-mcp`'s own fetchproxy fallback documents in
`src/auth.ts`.

## Core call

Every request needs the bearer token plus OFW's two protocol headers
(sent on every call, not just login):

```sh
curl -s 'https://ofw.ourfamilywizard.com/pub/v2/profiles' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'ofw-client: WebApplication' \
  -H 'ofw-version: 1.0.0' \
  | jq .
```

`ofw-version` is OFW's wire-protocol version (see `src/protocol.ts`),
unrelated to any package version — send it as-is. Writes add
`-H 'Content-Type: application/json' --data '...'` for JSON bodies, or
`-F` multipart fields for uploads/deletes — both shown per-endpoint in
`references/requests.md`.

## The one rule: re-GET after every message POST to confirm it landed

OFW's `POST /pub/v3/messages` response is minimal (`{"entityId": <id>}` or
legacy `{"id": <id>}`) and — worse — its draft-*replace* path silently
no-ops while still echoing success. Never trust the POST status alone for
a send or draft save: immediately `GET /pub/v3/messages/{id}` with the
returned id and check the body/subject actually match what you sent. See
§2/§3 in `references/requests.md`.

## Auth-error handling

- **401** — the token expired or was invalidated. OFW has no refresh-token
  flow; re-mint by reloading/re-signing-in on the `ourfamilywizard.com`
  tab, then re-run the capture step above.
- **429** — OFW's own client waits 2s and retries exactly once
  (`src/client.ts`); do the same: `sleep 2` and resend the identical
  request. A second 429 is a real rate-limit — back off further.
- Any other non-2xx is a real upstream error — surface the response body.

All 20 endpoint operations, request bodies, and `jq` projections are in
`references/requests.md`, transcribed from `src/tools/*.ts`, `src/sync.ts`,
and `src/tools/_shared.ts` — nothing here is guessed.

## Notes

- Base URL is `https://ofw.ourfamilywizard.com` for every endpoint (the
  `www.` host serves the web app UI, not the API).
- `ofw-mcp` maintains a local SQLite message cache for fast list/search;
  this skill has no cache — every list call here goes straight to OFW, and
  `GET /pub/v3/messages/{id}` on an **unread inbox message marks it read**
  on OFW, exactly as it does for the MCP.
- This project is developed and maintained by AI (Claude).
