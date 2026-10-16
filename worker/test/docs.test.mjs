// The copy-paste blocks in docs/index.html must match README.md exactly (skipped when the docs aren't present,
// e.g. in a repo created by the Deploy to Cloudflare button from the worker/ folder only).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const readmePath = path.join(root, "README.md");
const htmlPath = path.join(root, "docs/index.html");
const have = fs.existsSync(readmePath) && fs.existsSync(htmlPath);
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("docs page blocks match README blocks", { skip: !have && "docs not present" }, () => {
  const readme = fs.readFileSync(readmePath, "utf8");
  const html = fs.readFileSync(htmlPath, "utf8");
  const block = (heading) => {
    const i = readme.indexOf(heading);
    assert.ok(i >= 0, heading);
    return /```text\n([\s\S]*?)\n```/.exec(readme.slice(i))[1];
  };
  const pre = (id) => unescape(new RegExp(`<pre id="${id}">([\\s\\S]*?)</pre>`).exec(html)[1]);
  assert.equal(pre("grok"), block("**SuperGrok standing instruction**"));
  assert.equal(pre("logthis"), block('**Claude per-chat "log this" command**'));
  assert.equal(pre("notebook"), block('**Claude "personal notebook" standing instruction**'));
  assert.equal(pre("oneshot"), block("**One-shot handoff**"));
});

test("published docs carry no owner-specific values", { skip: !have && "docs not present" }, () => {
  for (const f of ["README.md", "INSTALL.md", "CUSTOM-DOMAIN.md", "docs/index.html", "worker/wrangler.jsonc", "worker/setup.sh", "bot/intake.py", "bot/config.example.json", "bot/courier-inbox-routine.md", "bot/skills/threadroost-intake/SKILL.md", "bot/build-skill.py"]) {
    let s = fs.readFileSync(path.join(root, f), "utf8");
    // The skill pins intake.py by its sha256 (a content hash, not an owner value).
    if (f.endsWith("SKILL.md")) s = s.replace(/sha256=[0-9a-f]{64}/g, "").replace(/`[0-9a-f]{64}`/g, "");
    assert.doesNotMatch(s, /[0-9a-f]{32}/, `${f}: looks like a resource id`);
    assert.doesNotMatch(s, /workers\.dev\/(?!mcp)[^\s)`'"]*[a-z0-9]{6,}/, `${f}: concrete workers.dev URL`);
  }
});

test("TR-SIZE-1: the intake skill keeps at least 1,500 bytes of headroom under the 24,000-byte cap", () => {
  const p = path.resolve(import.meta.dirname, "../../bot/skills/threadroost-intake/SKILL.md");
  const n = fs.statSync(p).size;
  assert.ok(n <= 22500, `skill is ${n} bytes`);
});
