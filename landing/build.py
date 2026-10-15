#!/usr/bin/env python3
"""Build landing/dist. Without REPO_URL, any <a ... data-soon="..."> pointing at <REPO_URL> becomes plain 'soon' text."""
import os, re, shutil, pathlib
here = pathlib.Path(__file__).parent; dist = here / "dist"
shutil.rmtree(dist, ignore_errors=True); dist.mkdir(); shutil.copytree(here / "img", dist / "img"); shutil.copytree(here / "fonts", dist / "fonts")
s = (here / "index.html").read_text(); repo = os.environ.get("REPO_URL")
if repo:
    s = s.replace("<REPO_URL>", repo.rstrip("/"))
else:
    def soon(m):
        cls = re.search(r'class="([^"]*)"', m.group(0))
        c = (cls.group(1) + " soon") if cls else "soon-text"
        return f'<span class="{c}">{m.group(1)}</span>'
    s = re.sub(r'<a [^>]*href="<REPO_URL>[^"]*"[^>]*data-soon="([^"]*)"[^>]*>.*?</a>', soon, s)
assert "<REPO_URL>" not in s and "BOT_TEMPLATE_URL" not in s
(dist / "index.html").write_text(s)
print("built", dist, "mode:", "published" if repo else "prelaunch")

# Privacy and terms pages, rendered from the repo's PRIVACY.md and TERMS.md (one source of truth).
import html as _h
def _inline(t):
    t = _h.escape(t, quote=False)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    return re.sub(r"([\w.+-]+@threadroost\.com)", r'<a href="mailto:\1">\1</a>', t)
def _md(src):
    out, lst = [], None
    for line in src.splitlines():
        m = re.match(r"^(#{1,3}) (.*)", line); li = re.match(r"^(?:- |\d+\. )(.*)", line)
        kind = "ol" if re.match(r"^\d+\. ", line) else "ul"
        if lst and not li: out.append(f"</{lst}>"); lst = None
        if m: out.append(f"<h{len(m.group(1))}>{_inline(m.group(2))}</h{len(m.group(1))}>")
        elif li:
            if not lst: lst = kind; out.append(f"<{kind}>")
            out.append(f"<li>{_inline(li.group(1))}</li>")
        elif line.strip(): out.append(f"<p>{_inline(line)}</p>")
    if lst: out.append(f"</{lst}>")
    return "\n".join(out)
PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'">
<title>{title} · Threadroost</title><meta name="description" content="{title} for Threadroost, free open-source software you run in your own Cloudflare account.">
<link rel="icon" href="/img/favicon-32.png">
<style>
@font-face{{font-family:"Instrument Sans";src:url(/fonts/InstrumentSans-latin-wght.woff2) format("woff2");font-weight:400 700;font-stretch:75% 100%;font-display:swap}}
body{{margin:0;background:#FBFAF7;color:#14201F;font:400 18px/1.6 "Instrument Sans",system-ui,sans-serif}}
.wrap{{max-width:720px;margin:0 auto;padding:0 22px 64px}}
header{{display:flex;align-items:center;gap:10px;padding:24px 0 8px;font-weight:680;font-size:19px}}header a{{color:inherit;text-decoration:none;display:flex;gap:10px;align-items:center}}
h1{{font-size:44px;line-height:1.05;letter-spacing:-.03em;font-weight:650;margin:32px 0 8px}}h2{{font-size:24px;letter-spacing:-.01em;margin:36px 0 8px}}
a{{color:#0F6E66}}code{{font-size:15px;background:#EFEDE6;padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}}li{{margin:6px 0}}
footer{{border-top:1px solid #E3E0D7;margin-top:48px;padding-top:20px;font-size:15px;color:#4A5755}}
@media (max-width:600px){{h1{{font-size:34px}}body{{font-size:17px}}}}
</style></head><body><div class="wrap">
<header><a href="/"><img src="/img/threadroost-logo-v3-small.svg" alt="" width="32" height="32">Threadroost</a></header>
<main>
{body}
</main>
<footer><a href="/">Home</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · support@threadroost.com</footer>
</div></body></html>
"""
for name, title in (("PRIVACY", "Privacy Policy"), ("TERMS", "Terms of Use")):
    src = (here.parent / f"{name}.md").read_text()
    body = _md(src).replace("Threadroost Privacy Policy", "Privacy Policy").replace("Threadroost Terms of Use", "Terms of Use")
    (dist / f"{name.lower()}.html").write_text(PAGE.format(title=title, body=body))
print("legal pages built")
(dist / "robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: https://threadroost.com/sitemap.xml\n")
(dist / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"<url><loc>https://threadroost.com/{p}</loc></url>\n" for p in ("", "privacy", "terms")) + "</urlset>\n")
(dist / "llms.txt").write_text("# Threadroost\n\n> Free, open-source connector that files your SuperGrok and Claude chats in your own Grok Bot, word for word. It runs in your own Cloudflare account.\n\n## Pages\n\n- [Home](https://threadroost.com/): what it does and how to add it\n- [Privacy](https://threadroost.com/privacy): self-hosted, no data collected by us, no analytics\n- [Terms](https://threadroost.com/terms): MIT licensed, no cost, no warranty\n" + (f"- [Code]({repo.rstrip('/')}): source, install guide and license\n" if repo else ""))
# no-transform stops the zone's Web Analytics beacon from being injected. The site promises no analytics.
(dist / "_headers").write_text("/*\n  Cache-Control: public, max-age=0, must-revalidate, no-transform\n")
