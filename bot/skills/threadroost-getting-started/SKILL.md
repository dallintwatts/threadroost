---
name: threadroost-getting-started
description: >-
  Welcome a new Threadroost owner, create the two Threadroost routines paused,
  and walk them through deploying the connector, connecting it, and one test handoff.
  Use on first chat or when the owner asks how to set up.
---
# Getting started with Threadroost

1. Routines first, in your very first reply, before any question (a new copy of this bot may arrive without them). Check your routines and create each one that is missing, paused, with exactly this name, trigger and job:
   - `courier-inbox`, trigger: incoming webhook. Job: "Handle this webhook exactly as the threadroost-courier-inbox skill says."
   - `threadroost-catchup`, trigger: schedule, every 10 minutes. Job: "If memory threadroost_intake_dir is not saved yet, do nothing and post nothing. Otherwise run python3 <threadroost_intake_dir>/intake.py drain. Post only new filings, or an alert's message once, word for word. Otherwise stay silent. Never create routines or ask for approvals from this job."
   Leave both paused. Do not enable either one. Do not ask the owner to approve or turn on a routine card in this reply. The install yes is not approval to run them. A routine that already exists stays as the owner left it. Catch-up must not run every 10 minutes until step 3.
   After a skill install, say this one short line once (skip it if this reply already has it): "Installed threadroost-intake, threadroost-courier-inbox and threadroost-getting-started. Checksums matched."
   If a checksum failed, do not use that line. Say the failure in one plain sentence plus what to do next, then stop.
   Then ask only: "Next step: deploy your free connector. Terminal command or one-click button? (Already deployed? Just say so.)"
   If this reply is not right after a skill install, skip the Installed line and ask only that deploy question.
   Then wait for the answer before the next step.
2. Deploy the connector from INSTALL.md in https://github.com/dallintwatts/threadroost: terminal means ./setup.sh (needs Node 22+), button means the Deploy to Cloudflare button. Already deployed: this bot's webhook is new, so do step 3 (they run ./setup.sh --reset-webhook and then ./setup.sh --reclaim, or update both secrets in Cloudflare and set KV courier:boot to {"reclaim":true}), then step 4. Give one step at a time, never a menu. Any error: one plain sentence, then what to do next.
3. Webhook. This is the first time `courier-inbox` and `threadroost-catchup` may run. They stay paused through install and the deploy question. If either is still paused, ask once: "Please approve both routine cards so the connector can reach me." Wait until both are on. Then, when they are ready to paste it (setup.sh's prompt, or the GROKBOT_WEBHOOK_URL and GROKBOT_WEBHOOK_KEY fields on the Deploy button's setup page), reply with the private in-chat links to the courier-inbox routine's Webhook URL and key. Tell them to paste both only there, never into chat. If the key lands in chat, offer a new key and have them run ./setup.sh --reset-webhook (or update the secret in Cloudflare).
4. Claim: setup.sh starts the claim by itself. On the Deploy-button path, first have them open their Worker URL once in a browser, because that first visit starts the claim. Within a minute the Worker sends a claim. Handle it per the threadroost-courier-inbox skill and confirm "Threadroost is connected." If nothing arrives, suggest ./setup.sh --doctor or ./setup.sh --reclaim (button path: open the Worker URL again).
5. Connect: the Connect link you post after the claim shows the connector URL (their Worker URL plus /mcp, also printed by setup.sh), a pairing code and the SuperGrok instruction. Have them add the connector URL as a custom connector in SuperGrok or Claude and enter the code on the sign-in page.
6. Test: ask them to hand off one short throwaway chat. When it files, tell them its title and where it was saved. If it does not show up, run the intake drain once and report what happened.
