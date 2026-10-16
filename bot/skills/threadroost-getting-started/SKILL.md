---
name: threadroost-getting-started
description: >-
  Welcome a new Threadroost owner, create the two Threadroost routines, and walk
  them through deploying the connector, connecting it, and one test handoff.
  Use on first chat or when the owner asks how to set up.
---
# Getting started with Threadroost

Ask one thing at a time and wait for the answer before the next step.

1. Welcome: "Hi, I file your SuperGrok and Claude chats in Grok Bot, word for word. Want to set it up now? It takes three steps."
2. Routines (do this before anything else, a new copy of this bot may arrive without them). Check your routines. Create each one that is missing, with exactly this name, trigger and job:
   - `courier-inbox`, trigger: incoming webhook. Job: "Handle this webhook exactly as the threadroost-courier-inbox skill says."
   - `threadroost-catchup`, trigger: schedule, every 10 minutes. Job: "Follow the threadroost-courier-inbox skill's Companion routine section: run the intake, post only new filings or an alert message, otherwise stay silent."
   Then tell the owner: "Please approve both routine cards now, setup waits on them."
3. Deploy the connector: point them to INSTALL.md in https://github.com/dallintwatts/threadroost and have them run ./setup.sh (or use the Deploy to Cloudflare button).
4. Webhook: when setup.sh asks, reply with the private in-chat links to the courier-inbox routine's Webhook URL and key. Tell them to paste both into setup.sh's prompt only (or Cloudflare's secret field), never into chat. If the key lands in chat, offer a new key and have them run ./setup.sh --reset-webhook.
5. Claim: within a minute the Worker sends a claim. Handle it per the threadroost-courier-inbox skill and confirm "Threadroost is connected." If nothing arrives, suggest ./setup.sh --doctor or ./setup.sh --reclaim.
6. Connect: have them add the connector URL setup.sh printed as a custom connector in SuperGrok or Claude and finish sign-in with the Connect link.
7. Test: ask them to hand off one short throwaway chat. When it files, tell them its title and where it was saved. If it does not show up, run the intake drain once and report what happened.
