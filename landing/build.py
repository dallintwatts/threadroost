#!/usr/bin/env python3
"""Build landing/dist. Without REPO_URL, any <a ... data-soon="..."> pointing at <REPO_URL> becomes plain 'soon' text."""
import os, re, shutil, pathlib
here = pathlib.Path(__file__).parent; dist = here / "dist"
shutil.rmtree(dist, ignore_errors=True); dist.mkdir(); shutil.copytree(here / "img", dist / "img"); shutil.copytree(here / "fonts", dist / "fonts")
s = (here / "index.html").read_text(); repo = os.environ.get("REPO_URL")
if repo:
    s = s.replace("<REPO_URL>", repo.rstrip("/"))
    s = re.sub(r' data-soon="[^"]*"', "", s)
else:
    s = s.replace(',"sameAs":["<REPO_URL>"]', "").replace(',"softwareHelp":"<REPO_URL>/blob/main/INSTALL.md"', "")
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
<meta name="theme-color" content="#FBF8F3" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0C1211" media="(prefers-color-scheme: dark)">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'">
<title>{title} · Threadroost, the self-hosted chat filer</title><meta name="description" content="{desc}">
<link rel="canonical" href="https://threadroost.com/{slug}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Threadroost"><meta property="og:url" content="https://threadroost.com/{slug}">
<meta property="og:title" content="{title} · Threadroost"><meta property="og:description" content="{desc}">
<meta property="og:image" content="https://threadroost.com/img/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Threadroost. Your SuperGrok and Claude chats, filed in your Grok Bot, word for word.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title} · Threadroost"><meta name="twitter:description" content="{desc}"><meta name="twitter:image" content="https://threadroost.com/img/og.png">
<link rel="llms" href="/llms.txt">
<link rel="preload" href="/fonts/InstrumentSans-latin-wght.woff2" as="font" type="font/woff2" crossorigin>
<script type="application/ld+json">{ld}</script>
<link rel="icon" type="image/svg+xml" href="/img/threadroost-logo-v3-small.svg"><link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png"><link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<style>
@font-face{{font-family:"Instrument Sans";src:url(/fonts/InstrumentSans-latin-wght.woff2) format("woff2");font-weight:400 700;font-stretch:75% 100%;font-display:swap}}
:root{{--bg:#FBF8F3;--ink:#14201F;--soft:#4A5754;--line:#E3DDD2;--teal:#0F6E66;--code:#EFEAE0}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0C1211;--ink:#EEF3F2;--soft:#A9B6B3;--line:#24302E;--teal:#5FE0CF;--code:#1A2221}}}}
:root{{color-scheme:light dark}}
body{{margin:0;background:var(--bg);color:var(--ink);font:400 18px/1.6 "Instrument Sans",system-ui,sans-serif}}
.wrap{{max-width:720px;margin:0 auto;padding:0 22px 64px}}
header{{display:flex;align-items:center;gap:10px;padding:24px 0 8px;font-weight:680;font-size:19px}}header a{{color:inherit;text-decoration:none;display:flex;gap:10px;align-items:center;min-height:44px}}
h1{{font-size:44px;line-height:1.1;letter-spacing:-.03em;font-weight:650;margin:32px 0 8px;text-wrap:balance}}h2{{font-size:24px;line-height:1.25;letter-spacing:-.01em;margin:36px 0 8px;text-wrap:balance}}
a{{color:var(--teal)}}code{{font-size:15px;background:var(--code);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}}li{{margin:6px 0}}p,li{{text-wrap:pretty}}
.skip{{position:absolute;left:-9999px}}.skip:focus{{left:12px;top:12px;background:var(--bg);padding:8px 12px;z-index:9}}
:focus-visible{{outline:3px solid var(--teal);outline-offset:3px;border-radius:6px}}
footer{{border-top:1px solid var(--line);margin-top:48px;padding-top:12px;font-size:15px;color:var(--soft)}}footer a{{display:inline-block;padding:10px 2px}}footer .sep{{margin:0 4px}}.btn{{display:inline-block;margin-top:12px;padding:14px 22px;border-radius:12px;background:var(--teal);color:var(--bg);font-weight:650;text-decoration:none}}
@media (max-width:600px){{h1{{font-size:34px}}body{{font-size:17px}}footer .last{{display:none}}footer .mail{{display:block;padding-top:0}}}}
</style></head><body><a class="skip" href="#main">Skip to content</a><div class="wrap">
<header><a href="/"><img src="/img/threadroost-logo-v3-small.svg" alt="" width="32" height="32" fetchpriority="high">Threadroost</a></header>
<main id="main"><article>
{body}
</article></main>
<footer><nav aria-label="Site"><a href="/">Home</a><span class="sep" aria-hidden="true">·</span><a href="/privacy">Privacy</a><span class="sep" aria-hidden="true">·</span><a href="/terms">Terms</a><span class="sep last" aria-hidden="true">·</span><a class="mail" href="mailto:support@threadroost.com">support@threadroost.com</a></nav></footer>
</div></body></html>
"""
import json as _json
DESCS = {
    "privacy": "How Threadroost handles your chats. It runs in your own Cloudflare account, keeps chat text 72 hours at most and collects nothing.",
    "terms": "Threadroost terms of use. Free, MIT-licensed software you run in your own Cloudflare account, provided as is with no warranty.",
}
def _ld(slug, title, desc):
    return _json.dumps({"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "name": f"{title} · Threadroost", "url": f"https://threadroost.com/{slug}", "description": desc, "inLanguage": "en",
         "isPartOf": {"@type": "WebSite", "@id": "https://threadroost.com/#site", "name": "Threadroost", "url": "https://threadroost.com/"}},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Threadroost", "item": "https://threadroost.com/"},
            {"@type": "ListItem", "position": 2, "name": title, "item": f"https://threadroost.com/{slug}"}]}]}, ensure_ascii=False, separators=(",", ":"))
for name, title in (("PRIVACY", "Privacy Policy"), ("TERMS", "Terms of Use")):
    src = (here.parent / f"{name}.md").read_text(); slug = name.lower(); desc = DESCS[slug]
    assert 120 <= len(desc) <= 160, (slug, len(desc))
    body = _md(src).replace("Threadroost Privacy Policy", "Privacy Policy").replace("Threadroost Terms of Use", "Terms of Use")
    if repo:  # link the references the legal text makes, without changing its words
        r = repo.rstrip("/")
        body = body.replace("INSTALL.md", f'<a href="{r}/blob/main/INSTALL.md">INSTALL.md</a>', 1)
        body = body.replace("GitHub Issues on the public code repository", f'<a href="{r}/issues">GitHub Issues</a> on the <a href="{r}">public code repository</a>')
        body = body.replace("posted in the public code repository", f'posted in the <a href="{r}">public code repository</a>')
    (dist / f"{slug}.html").write_text(PAGE.format(title=title, body=body, slug=slug, desc=_h.escape(desc), ld=_ld(slug, title, desc)))
NOT_FOUND = PAGE.replace('<link rel="canonical" href="https://threadroost.com/{slug}">', '<meta name="robots" content="noindex">').replace('<script type="application/ld+json">{ld}</script>', '')
(dist / "404.html").write_text(NOT_FOUND.format(title="Page not found", slug="", desc="This page does not exist. Threadroost files your SuperGrok and Claude chats in your own Grok Bot, word for word, from your own Cloudflare account.", ld="",
    body='<h1>Page not found.</h1>\n<p>That page does not exist. Threadroost files your SuperGrok and Claude chats in your own Grok Bot, word for word.</p>\n<p><a class="btn" href="/">Go to the home page</a></p>'))
print("legal pages built")
import datetime as _dt
def _lastmod(p):
    f = here / "index.html" if not p else here.parent / f"{p.upper()}.md"
    return _dt.datetime.fromtimestamp(f.stat().st_mtime, _dt.timezone.utc).date().isoformat()
(dist / "robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: https://threadroost.com/sitemap.xml\n")
(dist / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"<url><loc>https://threadroost.com/{p}</loc><lastmod>{_lastmod(p)}</lastmod></url>\n" for p in ("", "privacy", "terms")) + "</urlset>\n")
_qa = [(_h.unescape(q), _h.unescape(x)) for q, x in re.findall(r'<details><summary>(.*?)</summary><p>(.*?)</p></details>', s)]
_facts = [(_h.unescape(q), re.sub(r"<[^>]+>", "", _h.unescape(x))) for q, x in re.findall(r'<h3>(.*?)</h3><p>(.*?)</p>', s.split('class="tech"', 1)[1])]
_lim = [_h.unescape(x) for x in re.findall(r'<li>(.*?)</li>', s.split('class="lim"', 1)[1].split("</ul>", 1)[0])]
_llms = ["# Threadroost", "", "> Your SuperGrok and Claude chats, filed in your Grok Bot, word for word. Free, open-source (MIT) software that runs in your own Cloudflare account.", "",
    "Threadroost is an MCP connector you deploy to your own Cloudflare account. SuperGrok sends each chat to it automatically, and Claude sends a chat when you say \u201clog this\u201d. Your Grok Bot then files the full conversation, so your bots can keep working from it.", "",
    "## Pages", "", "- [Home](https://threadroost.com/): what it does and how to add it", "- [Privacy](https://threadroost.com/privacy): self-hosted, no data collected by us, no analytics", "- [Terms](https://threadroost.com/terms): MIT licensed, no cost, no warranty"]
if repo: _llms += [f"- [Code]({repo.rstrip('/')}): source and license", f"- [Install guide]({repo.rstrip('/')}/blob/main/INSTALL.md): how to add it to Grok Bot"]
_llms += ["", "## Answers", ""] + [f"- **{q}** {x}" for q, x in _qa] + ["", "## How it works", ""] + [f"- **{q}:** {x}" for q, x in _facts if q != "Code"] + ["", "## Honest limits", ""] + [f"- {x}" for x in _lim]
assert len(_qa) == 7 and _lim
(dist / "llms.txt").write_text("\n".join(_llms) + "\n")
# Web Analytics (RUM) is off for the zone (Oct 15), so no no-transform: Cloudflare may compress with br or gzip.
_sec = ("  Strict-Transport-Security: max-age=31536000\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n"
        "  Referrer-Policy: no-referrer\n  Cross-Origin-Opener-Policy: same-origin\n"
        "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()\n"
        "  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'\n")
(dist / "_headers").write_text("/*\n  Cache-Control: public, max-age=0, must-revalidate\n" + _sec +
    "\n/fonts/*\n  ! Cache-Control\n  Cache-Control: public, max-age=2592000\n"
    "\n/img/*\n  ! Cache-Control\n  Cache-Control: public, max-age=604800\n")
