# Setup security notes (zero-copy claim, v1.2.0)

Trust anchor: the bot webhook (URL + key) that the owner pastes at deploy. It is the only channel already secured by the owner, so the claim code travels only there.

| Threat | Control | Test |
|---|---|---|
| Replay of claim | Claim is single use. After success `courier:boot.claimed_at` is set and every later POST /claim returns 410 | claim.test: single use and replay |
| Replay of Connect link | GET only renders a button (link previews cannot burn it). POST consumes it, later use returns 410 | claim.test: Connect GET/POST replay |
| Expiry | Claim link 15 min (then re-sent at most every 10 min). Connect link 15 min. Pairing code 10 min | claim.test: expiry |
| Brute force | 5 wrong codes burn the claim. IP rate limit 10/min on /claim, 20/min on /connect (429). Codes compared in constant time | claim.test: burn + 429 |
| Token leakage | Pull token is generated in the Worker (crypto.getRandomValues), stored in its own KV, returned once in the claim response only. Never in the webhook, the Connect page, URLs or logs. Pages send no-store, no-referrer and a nonce CSP | claim.test: no secrets in logs, e2e: claimHasToken=false, pageHasToken=false |
| Minting Connect links | /api/connect-link requires the pull token | claim.test: connect-link auth |

Residual risks
- KV is not transactional, so two simultaneous first boots could race on token creation. Low impact: the claim reads back the stored value.
- Rate limits are per isolate, not global.
- The claim code is visible in the bot's routine logs. It is single use and expires in 15 min.
- Trust on first use: anyone holding the webhook key at first boot can claim. Same exposure as the webhook itself.
- If someone else claims first, `./setup.sh --reclaim` resets the claim (the owner's Cloudflare login is required).


## Decision: `global_fetch_strictly_public` is ON by default

| Webhook target | Flag off | Flag on |
|---|---|---|
| Outside Cloudflare (Grok Bot routines today) | Works | Works |
| A Worker on the same Cloudflare account (workers.dev) | 404, so handoffs stay queued | Works |
| A route on the same zone as the connector | Can skip the zone's public route | Goes through the public route |
| Local tests (127.0.0.1 mock under `wrangler dev`) | Works | Works (53+ tests pass with it on) |

It never makes things worse and fixes the same-account case, so it ships on. Turn it off only if a future
Cloudflare change breaks a webhook target you rely on. Run `./setup.sh --doctor` and the webhook probe after any change.

## Known limits (accepted)
- Rate limits are counted per Worker instance, not globally. Brute force is still bounded by the stored attempt counters
  (pairing code: 5 tries, claim: 5 tries, Connect link: 5 tries) and short lifetimes (10 to 15 minutes).
- Two finish_handoff calls at the same moment can both seal and both notify the bot. The checksum is identical, and the
  bot's intake skips duplicates by checksum.
- The pull token and the current Connect link token are stored in your own KV namespace so the Worker can use them.
  They are never logged. Anyone with access to your Cloudflare account can read them.
