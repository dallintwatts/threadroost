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

test("TR-TPL-1: getting-started creates both routines on first run, and INSTALL says the bot creates them", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const gs = fs.readFileSync(path.join(root, "bot/skills/threadroost-getting-started/SKILL.md"), "utf8");
  const inst = fs.readFileSync(path.join(root, "INSTALL.md"), "utf8");
  assert.match(gs, /`courier-inbox`, trigger: incoming webhook/);
  assert.match(gs, /`threadroost-catchup`, trigger: schedule, every 10 minutes/);
  assert.match(gs, /approve both routine cards/i);
  assert.match(gs, /threadroost-courier-inbox skill/);
  // Bugbot PR #16: routines come before any question, catch-up is self-contained, and the button path is covered.
  assert.ok(gs.indexOf("`courier-inbox`") < gs.indexOf("Want to set it up now?"), "routines before the welcome question");
  assert.match(gs, /before any question/);
  assert.match(gs, /If memory threadroost_intake_dir is not saved yet, do nothing/);
  assert.match(gs, /Never create routines or ask for approvals from this job/);
  assert.doesNotMatch(gs, /Companion routine section/);
  assert.match(gs, /GROKBOT_WEBHOOK_URL/);
  assert.doesNotMatch(gs, /when setup\.sh asks/);
  // Bugbot PR #17: on the Deploy-button path the first visit to the Worker URL starts the claim.
  assert.match(gs, /open their Worker URL once in a browser, because that first visit starts the claim/);
  assert.match(inst, /Open that Worker URL once in your browser/);
  assert.doesNotMatch(gs, /about 5 minutes/);
  const inbox = fs.readFileSync(path.join(root, "bot/skills/threadroost-courier-inbox/SKILL.md"), "utf8");
  assert.match(inbox, /^---\nname: threadroost-courier-inbox\n/);
  assert.ok(inbox.endsWith(fs.readFileSync(path.join(root, "bot/courier-inbox-routine.md"), "utf8")), "routine skill matches the spec");
  assert.doesNotMatch(inst, /The template adds two routines/);
  assert.match(inst, /creates any that are missing/);
  assert.match(inst, /threadroost-catchup/);
});

test("TR-TPL-5: docs carry the published template link, no placeholder left", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const url = "https://x.ai/bot/y8jcsoZFQCZDHcQ8eaUPN";
  for (const f of ["INSTALL.md", "README.md", "docs/index.html"]) {
    const s = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(s, /<BOT_TEMPLATE_URL>/, f);
    assert.ok(s.includes(url), `${f} links the template`);
  }
});

test("TR-TPL-7: shipped skills and config example carry a timezone placeholder, not a real zone", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const ex = JSON.parse(fs.readFileSync(path.join(root, "bot/config.example.json"), "utf8"));
  assert.match(ex.timezone, /^<.*>$/, "config.example.json timezone must be a <placeholder>");
  for (const f of ["bot/config.example.json", "bot/build-skill.py", ...fs.readdirSync(path.join(root, "bot/skills")).map((d) => `bot/skills/${d}/SKILL.md`)]) {
    const s = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(s, /"timezone":\s*"[A-Za-z]+\/[A-Za-z_]+"/, `${f}: hard-coded timezone`);
    assert.doesNotMatch(s, /America\/Denver/, `${f}: owner's timezone leaked`);
  }
  assert.match(fs.readFileSync(path.join(root, "bot/skills/threadroost-intake/SKILL.md"), "utf8"), /Never guess: if you don't know it yet/);
});

test("TR-TPL-6/8: the template bootstrap's pinned SKILL.md sizes and hashes match the files at its pinned commit", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = path.resolve(import.meta.dirname, "../..");
  const memo = fs.readFileSync(path.join(root, "bot/template-bootstrap.md"), "utf8");
  const mems = memo.trim().split("\n\n");
  assert.equal(mems.length, 4, "three pin memories plus one rule memory");
  for (const m of mems) assert.ok(m.length <= 300, `TR-TPL-8: memory is ${m.length} chars (imports truncate long memories)`);
  for (const m of mems.slice(0, 3)) assert.match(m, /^TRPIN sha256=[0-9a-f]{64} bytes=\d+ name=threadroost-[a-z-]+ url=https:\/\/raw\.githubusercontent\.com\/dallintwatts\/threadroost\/[0-9a-f]{40}\/bot\/skills\/threadroost-[a-z-]+\/SKILL\.md( Run it once installed\.)?$/, "TR-TPL-8: hash data first, one self-contained line");
  assert.match(mems[2], /name=threadroost-getting-started .* Run it once installed\.$/, "bootstrap still hands off to getting-started");
  assert.match(mems[3], /pre-approved, never ask/);
  assert.match(mems[3], /Only if bytes and sha256 match, mkdir -p and move it there/);
  const r = spawnSync("python3", [path.join(root, "bot/build-bootstrap.py"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
