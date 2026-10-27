# Install Threadroost

Three steps: add the bot, deploy your Worker, connect your chat app. The setup script itself took 22 seconds on a
fresh clone in our timed run (2026-10-16). The rest is copy and paste in Grok Bot, Cloudflare and grok.com, so your
time depends mostly on whether you already have a Cloudflare account and Node.js.

You need:
- A **SuperGrok** plan (for custom connectors) and/or **Claude** (custom connectors work on every plan, and Free allows only one).
- A free **Cloudflare** account ([sign up](https://dash.cloudflare.com/sign-up)).
- **Grok Bot** with the Threadroost bot template, to receive and file the threads.
- For the one-command path: **Node.js 22+** and a terminal on macOS, Linux or WSL.
- For the Deploy button instead: a free **GitHub or GitLab** account, since Cloudflare copies the code into it. No terminal needed.

## 1. Install the bot template and copy its webhook

1. Open the Threadroost bot template link (https://x.ai/bot/y8jcsoZFQCZDHcQ8eaUPN) and tap **Add to Grok Bot**.
   The template brings the bot's persona (its description) and its memories. It does not bring its skills or
   instructions. The bot installs its skills itself after one yes in the next step.
2. Say hi to the new bot. Its first reply is only this question:
   "Want me to finish setting up? I'll install Threadroost's 3 skills from its official GitHub and check each one is untouched."
   It doesn't mention routines or deploying, and turns nothing on, before you answer. Say yes.
   The bot downloads its 3 skills (`threadroost-intake`, `threadroost-courier-inbox` and
   `threadroost-getting-started`) from this repo, pinned at commit `4a643d1`. It checks each file's byte count and
   sha256 against the pins in its memories before saving it. It never retypes a skill.
   Its next reply names those three skills and says the checksums matched. It checks for its two routines and creates any that are missing, and leaves both paused:
   `courier-inbox` (webhook) and `threadroost-catchup` (every 10 minutes, files anything a missed webhook left behind).
   It does not ask you to approve them in that reply, so catch-up does not run every 10 minutes yet.
   In the same reply the bot asks **"Terminal command or one-click button? (Already deployed? Just say so.)"**
   Terminal means Option A in step 2 below. Button means Option B. The bot walks you through the one you pick.
3. When you're ready to paste the webhook values (in `setup.sh` or on the Deploy button's form), **approve both routine cards right away.** Setup can't finish
   until you do. An unapproved card just waits, which stalled one test setup for about 45 minutes.
   The bot then sends the webhook values.
   You can also ask for them any time: say **"Show my Threadroost webhook"**. The Grok Bot app doesn't show a
   routine's webhook in the Routines pane, so the bot replies with two private in-chat links instead:
   - **Webhook URL**
   - **Webhook key** (treat it like a password)
   When your Worker is up, the bot claims its token by itself and installs its intake in its own folder
   (`<agent folder>/courier/` with `intake.py`, `config.json` and `pull_token`). You don't copy anything.
4. Open each link when step 3 asks for it and copy the value. Never paste the key into a chat, including the bot's
   own chat. Paste it only into `setup.sh`'s hidden prompt or Cloudflare's secret field. If a key ever lands in a
   chat, ask the bot to make a new webhook key, then run `./setup.sh --reset-webhook`.

## 2. Deploy your Worker

Pick **A** or **B**. Both end with the same Worker on your own Cloudflare account.
Have Node 22+ and a terminal? Use **A**. No terminal? Use **B**.

### Option A: one command (recommended)

```bash
git clone https://github.com/dallintwatts/threadroost threadroost
cd threadroost/worker
./setup.sh
```

What happens:

| Step | What the script does | Your part |
|---|---|---|
| 1 | Checks Node 22+ and npm, installs the pinned dependencies (wrangler included) | Nothing |
| 2 | Runs `wrangler login` if you're not signed in, and asks which account if you have several | Approve in the browser |
| 3 | Suggests a neutral Worker name such as `threadroost-k3x9pq` (first run only) | Press Enter |
| 4 | Creates storage for the Worker (a KV namespace) and records its id in `wrangler.jsonc` | Nothing |
| 5 | Deploys the Worker and its 10-minute cron trigger | On a brand-new account, pick a workers.dev subdomain when wrangler asks |
| 6 | Creates the pull token your bot uses to collect threads. It is saved in `.courier/pull_token` with owner-only file permissions and never shown. On the bot side, any bot on the same Grok Bot computer can read it (see the README security model) | Nothing |
| 7 | Asks for the webhook URL and key, stores both as Worker secrets, and sends a test probe | Paste the URL, then paste the key (typing is hidden) |
| 8 | Checks the live Worker, prints your **connector URL** and next steps, and offers a pairing code | Press Enter |

Re-run `./setup.sh` whenever you like. It detects what's already done and skips it: no second login, KV namespace,
token or webhook prompt. Useful options:

| Option | Use |
|---|---|
| `--pair` | Mint a fresh pairing code later (add `--url https://<worker>` on a machine that didn't run setup) |
| `--reset-webhook` | Enter a new webhook URL and key |
| `--rotate-token` | Replace the pull token (then give your bot the new one) |
| `--bot-dir DIR` | If your bot's intake runs on this same machine, also write `DIR/pull_token` and `DIR/config.json` |
| `--no-deploy` | Re-check secrets and health without redeploying |
| `--doctor` | Plain-word health check of your Worker and bot link |
| `--reclaim` | Send your bot a fresh claim link (if it missed the first one) |
| `--remove` | Delete your Worker and its storage from Cloudflare. Asks you to type the Worker name first |
| `--yes` | No prompts (webhook from `GROKBOT_WEBHOOK_URL` plus `GROKBOT_WEBHOOK_KEY_FILE`) |

Prefer an API token over the browser login? Create one from Cloudflare's **Edit Cloudflare Workers** token template,
then export `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) before running the script.

### Option B: Deploy to Cloudflare button

1. Click **Deploy to Cloudflare** in the [README](README.md) (`https://deploy.workers.cloudflare.com/?url=https://github.com/dallintwatts/threadroost/tree/main/worker`).
2. Sign in to Cloudflare and connect GitHub or GitLab. Cloudflare copies the repo into your account so you can update it later.
3. On the setup page:
   - **Worker name:** something neutral, e.g. `threadroost-k3x9pq`. It becomes part of your URL.
   - **KV namespace (`OAUTH_KV`):** keep the suggested name. It's created for you.
   - **`GROKBOT_WEBHOOK_URL`** and **`GROKBOT_WEBHOOK_KEY`:** paste them from the two links your bot sent ("Show my Threadroost webhook"). Cloudflare stores the key as a secret.
   - There is no token field. Your Worker makes its own pull token on first start and hands it only to your bot.
4. Click **Create and deploy**. When it finishes, copy the Worker URL (`https://<name>.<subdomain>.workers.dev`).
5. Open that Worker URL once in your browser. That first visit is what tells your Worker its address and sends your bot the claim link.

## 3. Open the Connect link your bot sends you

Within a minute of deploying, your Worker sends your bot a one-time claim link through the webhook. The bot claims
its pull token by itself (you never see or copy it), then sends you a **Connect link**.

Open it and click **Show my pairing code**. The page works once and gives you three things to copy:
1. The **connector URL**. In grok.com go to **Connectors → New Connector → Custom** and paste it.
2. The **pairing code** (expires in 10 minutes). grok.com opens the Threadroost sign-in page. Type it and click **Approve**.
3. The **live sync instruction**. Paste it into a SuperGrok Project's Instructions (details in step 5).

Nothing arrived? Run `./setup.sh --doctor` for a plain-word health check, or `./setup.sh --reclaim` to send a fresh claim.
Need another code later? Ask your bot for a new Connect link, or run `./setup.sh --pair`.

If the grok.com form asks for fields instead of discovering them:
- Authorization endpoint: `https://<worker>/authorize`
- Token endpoint: `https://<worker>/oauth/token`
- Auth method: none (PKCE)
- Scope: `courier`

## 4. (Optional) Pair Claude

1. Ask your bot for a new Connect link (or run `./setup.sh --pair`) to get a fresh code.
2. claude.ai → **Customize → Connectors → Add custom connector** → paste the same `/mcp` URL → enter the code on the
   sign-in page and Approve.
3. In the connector's tool permissions, set **`sync_turns`** to **Always allow**.
4. On Claude, **use the per-chat "log this" command** in [README.md](README.md#copy-paste-blocks) when you want a chat
   captured. Claude's safeguards pause a standing auto-sync instruction (see the limits below).

## 5. Turn on live sync in SuperGrok

1. Create a SuperGrok **Project** (for example "Synced").
2. Paste the **SuperGrok standing instruction** from [README.md](README.md#copy-paste-blocks) into its instructions.
3. Start chats **inside that Project** with the connector enabled. Each turn syncs itself, and your bot files one
   transcript per chat.
4. Test it first: run a throwaway chat for a dozen turns, then check that your bot filed it cleanly before you trust it
   with anything important.

Say **"sync now"** before you walk away to push the last reply immediately. Otherwise it arrives within about 10 to 20 minutes.

## Honest limits

- **Best-effort fidelity.** The model re-types each turn. Fresh turns usually arrive verbatim, but a model can skip a
  turn or trim a very long answer. The Worker flags the gaps it can detect. It can't detect a skipped call when roles
  still alternate. Plan on "live sync plus an occasional export check".
- **About double the output tokens.** Each reply is typed twice: once to you, once into the tool call. That counts
  against your SuperGrok or Claude usage limits.
- **History comes from an export.** Anything before you turned sync on comes from the account data export
  (grok.com: Settings → Data Controls. claude.ai: Settings → Privacy → Export data.). The export is emailed and the link
  expires.
- **Claude is user-triggered, not automatic.** Claude's safeguards block standing auto-sync. On Claude, use the
  per-chat command or the export. SuperGrok is the auto-sync path.
- **Your account name is in the URL.** `workers.dev` addresses include your account subdomain. Add a
  [custom domain](CUSTOM-DOMAIN.md) to hide it.
- **Free-plan limit:** Cloudflare's free plan allows 1,000 storage writes a day, and every synced turn uses some. Heavy use can need Workers Paid.
- **No background sync is possible.** Neither app has a read API or webhook for consumer chats, and scraping the web
  app breaks their terms. Only the model in the chat can send turns.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `error code: 1042` or 404 right after the first deploy | New workers.dev names take a minute or two. Run `./setup.sh --no-deploy` to re-check |
| Sign-in page says the code is invalid or expired | Codes last 10 minutes and work once, even if the sign-in failed afterwards. 5 wrong tries cancel them. Ask your bot for a new Connect link (or run `./setup.sh --pair`), then add the connector again |
| Claude or grok.com says the redirect isn't allowed | Ask your bot to show the connector's registration log (`GET /api/admin/dcr-log`). It shows which address the app tried. Include that line when you ask for help (see Support below) |
| Webhook test failed | Read the line under it, "Your bot replied: ...". Busy or rate limited: wait a few minutes, then run `./setup.sh --no-deploy`. Paused: approve the `courier-inbox` routine card in the bot's chat. Anything else: ask your bot "Show my Threadroost webhook", re-copy both values, then run `./setup.sh --reset-webhook`. Handoffs queue safely meanwhile |
| "More than one account" | Choose when asked, or export `CLOUDFLARE_ACCOUNT_ID` |
| Your bot says "Threadroost needs a look" | A finished chat hasn't reached your bot for 30 minutes, or several messages to it failed in a row. Open the bot, check that its `courier-inbox` routine is on and approved, then run `./setup.sh --doctor`. Waiting chats stay on your Worker for up to 72 hours |
| Free plan cron limit reached | Each account has a few scheduled-job slots. Free one up, or remove `triggers` from `wrangler.jsonc` (quiet threads then send on the next turn or "sync now") |
| grok.com doesn't see `sync_turns` after an update | Refresh the connector, or remove and re-add it |

## Remove Threadroost

1. In `worker/`, run `./setup.sh --remove` and type the Worker name to confirm. It deletes the Worker, its secrets and its storage. (Deploy button users: delete the Worker in the Cloudflare dashboard under Workers & Pages, then its KV namespace under Storage.)
2. Remove the Threadroost connector in grok.com and claude.ai.
3. Ask your bot to delete its `courier/` folder and any transcripts you don't want to keep, then pause or delete its Threadroost routine.
4. Delete the bot in Grok Bot if you no longer want it. Deleting a bot doesn't delete its files or logins on the computer, so do step 3 first.

## Support

Still stuck? Run `./setup.sh` again first, since every error it prints ends with the next step. Then open an issue at
`https://github.com/dallintwatts/threadroost/issues`. Include what you ran and the last lines it printed. Never share your pull token, webhook key or
pairing code.
