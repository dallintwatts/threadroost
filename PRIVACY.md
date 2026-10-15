# Threadroost Privacy Policy
Last updated: October 15, 2026.

## The short version
Threadroost is free, open-source code that you run in your own Cloudflare account. We, the Threadroost project, never see your conversations. We do not run a server that receives them. We collect nothing.

## Who holds your data
When you install Threadroost you deploy your own copy (a Cloudflare Worker) to your own Cloudflare account. Everything it stores lives in a storage space (Cloudflare KV) inside that account. You control it and you can delete it at any time. Cloudflare's own privacy policy covers how Cloudflare runs its platform.

## What your copy stores and for how long
- **Conversation text** that your chat app sends to it. Each piece is kept for at most 72 hours. It is deleted earlier, as soon as your bot confirms it has received it.
- **Thread details without the text**, such as title, project name, turn counts, sizes and checksums. These are kept for up to 30 days so duplicates and gaps can be spotted.
- **Connection records** that let your chat app sign in (standard OAuth data). A list of the last 20 sign-up attempts by chat apps is kept so you can review them.
- **A one-time pairing code** that expires after 10 minutes.

## Where your data goes
Your copy sends a short notice to the bot webhook address you set up. That notice includes the thread title, project, counts and a checksum. It does not include the conversation text. Your bot then fetches the text from your copy using a private token. Only your copy and your bot's Grok Bot computer hold it. Other bots you run on that same computer can read files there, including this token.

## Your bot
Threadroost doesn't change how Grok Bot handles your data. Transcripts your bot files are stored and kept under Grok Bot's own rules. Deleting a bot in Grok Bot doesn't delete its files, so ask it to delete them first.

## Logs
Your copy writes short event records (for example "handoff created" or "sign-in approved"). They never contain conversation text, tokens, pairing codes or IP addresses. Saved logs are switched off by default in the settings we ship.

## What we never do
- We never collect, receive or store your data.
- We never sell data.
- We never use your data to train AI models.
- There are no analytics or trackers in the code.

## This website
threadroost.com is a static page. It sets no cookies and runs no analytics or trackers. Cloudflare, which hosts it, handles the standard request data needed to serve a web page. We do not receive or keep it.

## Removing everything
In the `worker` folder, run `npx wrangler delete` to remove your copy and its secrets. Then run `npx wrangler kv namespace delete --namespace-id <id>` with the id from `wrangler.jsonc` to erase its storage. Then remove the connector in your chat app. Finally, ask your bot to delete its Threadroost files before you delete the bot. Full steps are in README.md under "Update, rotate, remove".

## Contact
support@threadroost.com
