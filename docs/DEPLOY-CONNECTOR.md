# Deploying the OurFamilyWizard remote connector

This is the operator runbook for standing up `ofw-mcp` as a hosted Cloudflare
Worker — a "remote connector" that anyone you share the URL with can add to
claude.ai (web, desktop, or mobile), each logging in with their own
OurFamilyWizard account. It's a manual, one-time (per operator) process; there
is no CI/CD path for it, and none of the steps below can be done by an agent
since they require your own Cloudflare account.

If you just want the server on your own machine talking only to your own OFW
account, you don't need any of this — see the main [README](../README.md) for
the local stdio / `.mcpb` install instead, which is the desktop-only
alternative to running a shared connector.

## Prerequisites

- A Cloudflare account (free tier is fine).
- Node and this repo checked out with dependencies installed (`npm install`).
- **No app-level OFW API keys are required.** Unlike some connectors, OFW has
  no operator-shared `client_id` / `client_secret`. Each user authenticates
  with their own OFW email + password, collected by the connector's own OAuth
  login page (step 5) — you never handle anyone's OFW credentials.

## Steps

### 1. Log in to Cloudflare

```sh
npx wrangler login
```

This opens a browser to authorize the CLI against your Cloudflare account.

### 2. Create the OAuth KV namespace

The connector stores OAuth state and per-user session data in a KV namespace
bound as `OAUTH_KV` (see `wrangler.jsonc`).

```sh
npx wrangler kv namespace create OAUTH_KV
```

The command prints something like:

```
{ "binding": "OAUTH_KV", "id": "abcd1234..." }
```

Copy the returned `id` into `wrangler.jsonc`, replacing the
`"REPLACE_WITH_OAUTH_KV_NAMESPACE_ID"` value:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "abcd1234..." }],
```

### 3. (Optional) Set the write-mode and calendar-write policy

By default `wrangler.jsonc` deploys with `OFW_WRITE_MODE: "all"` — every tool,
including sends and calendar/expense/journal writes, is registered. If you want
a more conservative hosted deployment, change the `vars` block in
`wrangler.jsonc` before deploying, or override at deploy time as a secret:

- `OFW_WRITE_MODE`
  - `"none"` — read-only: no write tools registered at all.
  - `"drafts"` — draft-level message writes only (`ofw_save_draft`,
    `ofw_delete_draft`, `ofw_upload_attachment`); never sends or
    calendar/expense/journal writes. Keeps a human in the OFW web UI between
    model output and the court-visible record.
  - `"all"` — everything (the default).
  - Any unrecognized value fails closed to `"none"`.
- `OFW_CALENDAR_WRITES` — set to `"true"` alongside `OFW_WRITE_MODE: "drafts"`
  to additionally register the calendar write tools (`ofw_create_event`,
  `ofw_update_event`, `ofw_delete_event`). Calendar events have no draft stage
  but are reversible (editable/deletable), unlike a sent message. Redundant in
  `"all"`; it never overrides `"none"`.

The gate is **structural** — gated tools are not registered on the Worker at
all, so no host setting or injected instruction can invoke them. To set either
as a secret instead of a committed `var` (a secret overrides the `var` of the
same name):

```sh
npx wrangler secret put OFW_WRITE_MODE
npx wrangler secret put OFW_CALENDAR_WRITES
```

Under `nodejs_compat` these populate `process.env`, so `src/config.ts`'s
write-mode gate reads them exactly as it does for the stdio server.

### 4. Deploy

```sh
npm run worker:deploy
```

This runs `wrangler deploy`, which builds and pushes `src/worker.ts` (plus the
`OFWMcpAgent` per-session agent and `OFWCacheDO` per-operator message-cache
Durable Object bindings, and the `OAUTH_KV` namespace from step 2). On success
it prints the deployed URL:

```
https://ofw-connector.<your-subdomain>.workers.dev
```

Because `wrangler.jsonc` also declares a custom-domain route
(`connector.ofw.nullnet.app`, matching untappd-mcp's
`connector.untappd.nullnet.app`), the connector is additionally served at:

```
https://connector.ofw.nullnet.app
```

Use the custom domain as the stable production URL you share. (The zone must be
in the deploying Cloudflare account; if it isn't, remove the `routes` entry from
`wrangler.jsonc` and use the `*.workers.dev` URL instead.) Note whichever URL you
use — it's what gets added as a connector, with `/mcp` appended.

> **Message-cache Durable Object.** The connector's `ofw_sync_messages` /
> message-read tools store each user's synced OFW message history in an
> `OFWCacheDO` Durable Object with SQLite storage, keyed by the logged-in OFW
> username so it persists across their conversations and is isolated from other
> users. Its binding and SQLite migrations (`v1` for `OFWMcpAgent`, `v2` for
> `OFWCacheDO`) are declared in `wrangler.jsonc` and applied automatically by
> `wrangler deploy` — no extra setup. **If you are upgrading an existing
> deployment** that predates the cache DO, this deploy adds the `v2` migration
> (`new_sqlite_classes: ["OFWCacheDO"]`); it applies on the next deploy with no
> action needed.

Before deploying to production, you can sanity-check the Worker locally with:

```sh
npm run worker:dev
```

confirm it bundles without deploying:

```sh
npx wrangler deploy --dry-run
```

and run the Worker-specific test suite (Miniflare / real Workers runtime) with:

```sh
npm run worker:test
```

### 5. Add it as a connector in claude.ai

1. Go to claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Paste the deployed URL with `/mcp` appended — the custom domain
   `https://connector.ofw.nullnet.app/mcp` (or, without a custom domain,
   `https://ofw-connector.<your-subdomain>.workers.dev/mcp`).
3. Claude will open the connector's login page (served by the Worker at
   `/authorize`) and prompt for an **OFW email or username** and **OFW
   password**. Complete that login — this is the individual user's own
   OurFamilyWizard account.

This connector is unlisted: it only shows up for people you've explicitly
shared the URL with, not in any public directory. Anyone with the URL who
completes their own OFW login can use it under their own account.

### 6. Verify on the mobile Claude app

Connectors added on claude.ai sync to all clients for that account, including
the **mobile Claude app**. On mobile:

1. Confirm the connector appears (Settings → Connectors) and shows as
   connected.
2. Run a read, e.g. ask Claude to `ofw_get_profile` or `ofw_list_messages`
   (run `ofw_sync_messages` first if the cache is empty).
3. If you deployed with writes enabled, run a low-stakes write to confirm the
   write tools are wired up — e.g. `ofw_save_draft` (a draft, not a send).

If both work, the deploy is verified end-to-end.

## How auth works

- There are **no operator-level OFW credentials.** OFW has no shared app
  `client_id` / `client_secret`; the connector authenticates each user
  individually.
- Each **user** who adds the connector logs in with their *own* OFW email or
  username and password, via the login page the Worker serves at `/authorize`.
- Those credentials are stored **encrypted at rest** in the OAuth provider's
  KV-backed "props" (`OAUTH_KV`), scoped to that user's session. OFW bearer
  tokens expire in ~6h with no refresh token, so — unlike a connector that
  keeps only a long-lived access token — the stored password is needed to
  re-run the OFW Spring-Security form login (`loginWithPassword`) whenever the
  per-user client's token expires. It is used only to sign in to OFW on that
  user's behalf, never for anything else.

## Attachments on the hosted connector

The hosted Worker has **no local filesystem**, so attachments are
**inline-only**: `wrangler.jsonc` sets `OFW_INLINE_ATTACHMENTS: "true"`, and
`ofw_download_attachment` returns the file bytes as MCP content blocks in the
response instead of writing them to disk. Path-based operations are
unavailable — `ofw_upload_attachment` from a local file path and
disk-write/read of downloads both return an actionable error directing you to
the stdio/desktop server for path-based attachment work.

## Sync & the subrequest limit

Cloudflare Workers cap the number of **subrequests** a single request may make —
**50 on the Free plan, 1000 on the Workers Paid plan**. On this connector every
OFW API call *and* every `OFWCacheDO` cache RPC counts against that cap, so a
naive deep sync of a large mailbox would blow through it mid-request.

`ofw_sync_messages` is therefore **bounded and resumable** on the hosted
connector: `wrangler.jsonc` sets `OFW_SYNC_MAX_REQUESTS` (default `"40"`, safely
under the Free-plan cap), and each call makes at most that many OFW requests
before pausing and saving its place. A large backfill (`deep: true`) is done by
**calling `ofw_sync_messages` repeatedly** — each call resumes where the last one
left off until the walk completes. Tune the var to your plan: raise it (e.g.
`"900"`) on the Workers Paid plan for fewer resume round-trips, or override it as
a secret (`npx wrangler secret put OFW_SYNC_MAX_REQUESTS`). Leaving it unset makes
sync unbounded, which is only safe for the local stdio server — keep it set on the
Worker. Under `nodejs_compat` it populates `process.env`, so `getSyncMaxRequests()`
in `src/config.ts` picks it up exactly as on the stdio server.

## Rotation / teardown

There are no operator secrets to rotate for OFW auth (users manage their own
OFW passwords). If you set `OFW_WRITE_MODE` / `OFW_CALENDAR_WRITES` as secrets
(step 3), `secret put` overwrites the existing value — no separate delete step
is needed to change them. Remove one entirely with:

```sh
npx wrangler secret delete OFW_WRITE_MODE
```

Tear down the whole connector:

```sh
npx wrangler kv namespace delete --namespace-id <id-from-step-2>
```

then delete the Worker itself from the Cloudflare dashboard (Workers &
Pages → `ofw-connector` → Settings → Delete), or via:

```sh
npx wrangler delete
```

Deleting the KV namespace invalidates every stored user session — everyone who
had added the connector will need to log in again if it's redeployed. It also
drops the encrypted per-user OFW credentials from `OAUTH_KV` (the `OFWCacheDO`
message caches are separate Durable Object storage and are removed when the
Worker itself is deleted).
