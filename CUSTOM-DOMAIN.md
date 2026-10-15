# Optional: use your own domain

By default your connector lives at `https://<worker>.<your-account-subdomain>.workers.dev/mcp`, so your Cloudflare
account subdomain shows up in the URL. To hide it, serve the Worker from a hostname you own, such as
`https://mcp.example.com/mcp`.

This is optional. Skip it unless you want a shorter address or want to hide your account name.

You need a domain that is **already active on Cloudflare in the same account** as the Worker. If you bought it elsewhere,
add it first: in the Cloudflare dashboard choose **Add a domain**, pick the Free plan, then at your registrar replace the
nameservers with the two Cloudflare shows you. Continue once Cloudflare marks the domain **Active**, usually within a few
hours. The hostname you pick must not already have a DNS record. Cloudflare creates the DNS record and
the TLS certificate for you.

> Tip: choose a neutral subdomain. Every new TLS certificate is published in public Certificate Transparency logs, so
> `mcp.example.com` says less about you than `my-private-chats.example.com`.

## Option 1: in `wrangler.jsonc` (works with `setup.sh`)

1. Add a `routes` entry to `worker/wrangler.jsonc`:
   ```jsonc
   "routes": [
     { "pattern": "mcp.example.com", "custom_domain": true }
   ],
   ```
2. Run `./setup.sh` again. It deploys and notices the custom domain (deploy output shows `mcp.example.com (custom
   domain)`). From then on it uses `https://mcp.example.com` as your Worker URL and warns you that the URL changed.
   If you run it with `--bot-dir`, it also updates your bot's `config.json`.

## Option 2: in the Cloudflare dashboard (Deploy button installs)

1. Open **Workers & Pages** and select your Worker.
2. Go to **Settings → Domains & Routes → Add → Custom domain**.
3. Enter `mcp.example.com` and click **Add domain**. The hostname takes a minute or two to go live.

Dashboard changes can be overwritten by the next deploy from your repo if `wrangler.jsonc` disagrees. If you redeploy
from Git, add the same `routes` entry from Option 1 to your copy of the repo.

## After the domain is live

The Worker answers on both hostnames at once. OAuth discovery is built from whichever hostname a request uses, so
nothing breaks while you switch over.

1. **Check it:** `npm run preflight -- https://mcp.example.com` should pass every check.
2. **Reconnect your chat apps.** A connector is tied to the URL you entered when you added it. In grok.com and/or
   claude.ai, add the connector again with `https://mcp.example.com/mcp` and a fresh pairing code from
   `./setup.sh --pair`. Then remove the old workers.dev connector.
3. **Update your bot's Worker URL** to `https://mcp.example.com`. `setup.sh --bot-dir` does this for you. Otherwise,
   tell your bot.
4. **(Optional) Turn off the workers.dev address** once everything uses the new URL. Set `"workers_dev": false` in
   `wrangler.jsonc` and deploy again (`./setup.sh`). After that, only your domain answers.

To undo, remove the `routes` entry (or the custom domain in the dashboard), make sure `"workers_dev": true` is set,
deploy, and reconnect with the workers.dev URL.
