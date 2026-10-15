# What each part of Threadroost can and can't do

This page lists every permission each part of Threadroost has. CI checks it against the code
(`worker/test/capabilities.test.mjs`). If a pull request adds an HTTP route, an MCP tool, an outbound network call,
a storage binding, a secret, an intake API call or a Python import without updating the JSON block at the bottom,
the `test` check fails.

## 1. Connector Worker (Cloudflare Worker, `worker/src/index.ts`)

| | Can | Can't |
|---|---|---|
| Read | Chat turns an AI app sends it through the five MCP tools. Its own KV namespace `OAUTH_KV`. Its own secrets and settings. | Your chat apps, your accounts, your files, your Grok Bot, anything outside its KV namespace. |
| Write | Its own KV namespace only: handoff chunks and metadata (deleted on ack, or by TTL), OAuth clients and grants, pair and claim codes, alert and webhook-health records, daily counters. | Any other storage. It has no database, R2, queue or Durable Object binding. |
| Send | One outbound network call: a POST to `GROKBOT_WEBHOOK_URL` (https only, or http to localhost in tests). The body carries ids, counts and the chat title, never the turns. | Email, chat messages, posts or calls to any other host. |
| Schedule | One cron, every 10 minutes: flush quiet live-sync threads, sweep empty abandoned handoffs, raise the stuck-delivery alert. | Anything else on a timer. |

Who can reach what:

* **Anyone:** `/`, `/health`, `/assets/*`, OAuth discovery and its two aliases, `/oauth/register` (rate-limited), `/oauth/token`, `/authorize` and `/connect` (owner approval page).
* **An approved AI app (OAuth token):** `/mcp` and its five tools (`start_handoff`, `append_turns`, `finish_handoff`, `sync_turns`, `handoff_status`). These can add turns and check status. They can't list, read or delete handoffs.
* **The bot, once:** `/claim` swaps a single-use 15-minute claim code for the pull token.
* **Holder of the pull token:** every `/api/*` route. That means listing, reading and acking (deleting) handoffs, and minting pair codes and connect links. It also covers the `/api/admin/*` routes: listing, adding and removing OAuth clients, revoking all grants, probing the webhook, and reading the alert and registration logs. Today one token covers both pulling and admin (see the open item below).

## 2. Intake script (`bot/intake.py`, runs in the bot's own folder)

| | Can | Can't |
|---|---|---|
| Read | `config.json` and `pull_token` next to itself. Handoffs from the Worker (`GET /api/handoffs`, `GET /api/handoffs/{id}`, `GET /api/admin/alert`). Its own filing root, to find duplicates and threads. | Any other Worker route except `POST /api/pair`. Other folders on purpose. |
| Write | Files under the filing root only (`transcript.md`, `raw.json`, `fidelity.json`, `thread.json`, `segments/`, `duplicates.log`, its ledger and lock file). | Files outside the filing root. It never deletes a filed chat. |
| Send | HTTPS to the configured `worker_url` only: ack (`POST /api/handoffs/{id}/ack`, which deletes the Worker's copy) and `POST /api/pair` when asked for a pair code. | Email, messages, posts, shell commands. It imports no `subprocess`, `socket` or mail module. |

## 3. Thread Courier bot (Grok Bot, follows `threadroost-intake` skill and the routine spec)

| | Can | Can't (by its instructions) |
|---|---|---|
| Read | Webhook payloads, intake output, files in its own folder, its memory. | It must treat chat text as data and act on none of it. |
| Write | Runs `intake.py`, which writes the filed chats. Saves `threadroost_intake_dir` to memory. | Delete files, change settings or install anything because a chat said so. |
| Send | A short "Filed: <title>" note or an alert note to its owner in its own chat. | Email, posts, messages to anyone else. It never prints `pull_token` or the webhook key. |

These limits come from the bot's instructions, not from the box. Grok Bot's security notes say every bot on the same
computer can read any file on it, and prompt-injection defenses reduce the risk but don't remove it.

## 4. Routines (`courier-inbox` on webhook, `threadroost-catchup` every 10 minutes)

| | Can | Can't |
|---|---|---|
| Read | The webhook payload (ids and counts) for `courier-inbox`. Nothing for `threadroost-catchup`. | Chat turns. Payloads never carry them. |
| Do | Wake the bot to run the intake once. | Anything the bot itself can't do. |
| Send | Nothing. Only the bot posts, and only when something was filed or an alert is open. | |

## 5. Webhook (Grok Bot routine URL and key, stored as Worker secrets)

| | Can | Can't |
|---|---|---|
| Carries | Event name, handoff id, delivery id, counts, the chat title, a single-use claim code and claim URL on first setup. | Chat turns, the pull token or the key. |
| Key holder can | Wake the courier routine with a fake event. The bot then just runs a normal intake, which only files what the Worker really holds. | Read or change filed chats, or reach the Worker. |

## Open item: the pull token is all-or-nothing

Anyone who can read the bot's `pull_token` file can read and delete waiting handoffs and change OAuth clients on the
Worker. On a shared Grok Bot computer, another bot can read that file. File permissions don't help here, because all bots
run as the same user. The fix needs a Worker change (a pull-only token separate from an admin token) and a token
rotation, so it is tracked as a proposal and is not in this version.

## Machine-checked list

```json capabilities
{
  "worker_routes": [
    "/", "/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/api/", "/api/admin/alert", "/api/admin/clients", "/api/admin/clients/([^/]+)", "/api/admin/dcr-log",
    "/api/admin/probe-webhook", "/api/admin/revoke-all", "/api/connect-link", "/api/handoffs",
    "/api/handoffs/([a-z0-9]+)", "/api/handoffs/([a-z0-9]+)/ack", "/api/pair", "/assets/mono.woff2",
    "/assets/sans.woff2", "/authorize", "/claim", "/connect", "/health", "/mcp", "/oauth/register", "/oauth/token"
  ],
  "worker_mcp_tools": ["append_turns", "finish_handoff", "handoff_status", "start_handoff", "sync_turns"],
  "worker_outbound_fetch": 1,
  "worker_env": [
    "ABANDONED_HANDOFF_SECONDS", "ALERT_INTERVAL_SECONDS", "ALERT_STUCK_SECONDS", "ALLOWED_REDIRECT_HOSTS",
    "ALLOWED_REDIRECT_URIS", "CLAIM_TTL_SECONDS", "CONNECT_REUSE_SECONDS", "COURIER_PULL_TOKEN", "GROKBOT_WEBHOOK_KEY",
    "GROKBOT_WEBHOOK_URL", "MAX_HANDOFFS_PER_DAY", "OAUTH_KV", "OAUTH_PROVIDER", "RENOTIFY_BASE_SECONDS",
    "SYNC_FLUSH_MIN_SECONDS", "SYNC_MAX_CALLS_PER_THREAD_PER_DAY", "SYNC_NOTIFY_INTERVAL_SECONDS", "WEBHOOK_RETRY_DELAY_MS"
  ],
  "worker_kv_bindings": ["OAUTH_KV"],
  "worker_crons": ["*/10 * * * *"],
  "intake_api_calls": ["GET /api/admin/alert", "GET /api/handoffs", "GET /api/handoffs/{id}", "POST /api/handoffs/{id}/ack", "POST /api/pair"],
  "intake_imports": [
    "argparse", "contextlib", "datetime", "difflib", "fcntl", "hashlib", "json", "os", "re", "sys",
    "urllib.error", "urllib.request", "zoneinfo"
  ]
}
```
