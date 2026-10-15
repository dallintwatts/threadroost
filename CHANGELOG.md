# Changelog

## 1.2.2 (2026-10-15)
- Fix (TR-BUG-32): Grok Bot can answer a webhook with HTTP 400 when its automation run rate limit is reached, not only when the inbox routine is paused. Threadroost now keeps a short redacted reply snippet (`response_snippet`) in handoff_status, probe-webhook and logs, retries a busy or transient failure once about 20 seconds after finish_handoff, and still re-notifies from the cron. Replies that say paused, deleted, not found or bad key are not retried early.
- The 400 hint now says the routine may be busy, paused or deleted and points to the snippet.
- New setting `WEBHOOK_RETRY_DELAY_MS` (default 20000, max 25000).

## 1.2.1 (2026-10-15)
- Cron re-notifies queued handoffs, first call after pairing gets one retry, finish re-checks a just-sent chunk, repeat acks keep their verdict, listing shows current statuses, plain-words webhook hints.
