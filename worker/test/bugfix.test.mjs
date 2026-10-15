// Regression tests for the v1.2.0 real-bot test bugs (see qa/BUG-LEDGER.md, TR-BUG-1..5).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startWorker, oauthFlow, mcpClient, readRpc } from "./helpers.mjs";

const PULL = crypto.randomBytes(32).toString("base64url");
const api = (base, p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { authorization: `Bearer ${PULL}`, ...(init.headers || {}) } });
let B, token;

before(async () => {
  B = await startWorker({
    port: 8821,
    vars: { COURIER_PULL_TOKEN: PULL, ALLOWED_REDIRECT_HOSTS: "client.test.example", ABANDONED_HANDOFF_SECONDS: "2" },
    extraArgs: ["--test-scheduled"],
  });
});
after(async () => {
  await B?.stop();
});

const tOf = (u) => new URL(u).searchParams.get("t");

test("TR-BUG-1: asking twice for a Connect link returns the same unused link, not a replacement", async () => {
  const a = await (await api(B.url, "/api/connect-link", { method: "POST" })).json();
  const b = await (await api(B.url, "/api/connect-link", { method: "POST" })).json();
  assert.equal(b.connect_url, a.connect_url, "second ask within the window reuses the live link");
  assert.equal(b.reused, true);
  assert.equal((await fetch(`${B.url}/connect?t=${tOf(a.connect_url)}`)).status, 200, "the first link still works");
  // fresh=1 is the explicit escape hatch and does replace it
  const c = await (await api(B.url, "/api/connect-link?fresh=1", { method: "POST" })).json();
  assert.notEqual(c.connect_url, a.connect_url);
  assert.equal(c.reused, false);
  assert.equal((await fetch(`${B.url}/connect?t=${tOf(a.connect_url)}`)).status, 410, "one live link at a time");
  // once a link is spent, the next ask mints a new one
  const spent = await fetch(`${B.url}/connect`, { method: "POST", body: new URLSearchParams({ t: tOf(c.connect_url) }) });
  assert.equal(spent.status, 200);
  const d = await (await api(B.url, "/api/connect-link", { method: "POST" })).json();
  assert.notEqual(d.connect_url, c.connect_url);
  assert.equal(d.reused, false);
});

test("TR-BUG-1: the reused link token never reaches the logs", () => {
  assert.ok(B.logs.some((l) => l.includes("connect_link_reused")));
  assert.ok(!B.logs.join("\n").match(/connect\?t=/), "no link in logs");
});

test("TR-BUG-3: Connect page and sign-in errors say the code is single-use and how to get a new one", async () => {
  const l = await (await api(B.url, "/api/connect-link?fresh=1", { method: "POST" })).json();
  const html = await (await fetch(`${B.url}/connect`, { method: "POST", body: new URLSearchParams({ t: tOf(l.connect_url) }) })).text();
  assert.match(html, /The code works once/);
  assert.match(html, /new Connect link/);
  const code = html.match(/id="code" class="code">(\d{4}) (\d{4})</);
  const flow = await oauthFlow(B.url, { getPairCode: async () => code[1] + code[2], redirectUri: "https://client.test.example/cb" });
  assert.equal(flow.ev.tokenStatus, 200);
  token = flow.tokens.access_token;
  // A second client (e.g. a retry after a crash) reusing the spent code gets a clear recovery path
  await assert.rejects(
    oauthFlow(B.url, { getPairCode: async () => code[1] + code[2], redirectUri: "https://client.test.example/cb" }),
    (e) => /approve failed 401/.test(e.message) && /used up or has expired/.test(e.message) && /new Connect link/.test(e.message),
  );
});

test("TR-BUG-5: start_handoff contract: handoff_id lives in the JSON text of content[0], not on the result", async () => {
  const c = mcpClient(B.url, token);
  await c.initialize();
  const raw = await c.rpc("tools/call", { name: "start_handoff", arguments: { title: "contract", mode: "verbatim", expected_turns: 1 } });
  assert.equal(raw.result.isError, false);
  assert.equal(raw.result.content[0].type, "text");
  assert.equal(raw.result.handoff_id, undefined, "no top-level handoff_id");
  const body = JSON.parse(raw.result.content[0].text);
  assert.match(body.handoff_id, /^h[a-z0-9]{6,40}$/);
  assert.equal(body.status, "open");
  assert.equal(body.existing, false);
  assert.equal(typeof body.rules, "object");
  // The test helper unwraps it to .data; harnesses must read s.data.handoff_id
  const s = await c.call("start_handoff", { title: "contract 2", mode: "verbatim", expected_turns: 1 });
  assert.match(s.data.handoff_id, /^h[a-z0-9]{6,40}$/);
  assert.equal(s.handoff_id, undefined);
});

test("TR-BUG-2: the cron sweeps empty abandoned handoffs and keeps ones with turns", async () => {
  const c = mcpClient(B.url, token);
  await c.initialize();
  const empty = (await c.call("start_handoff", { title: "abandoned", mode: "verbatim", expected_turns: 3, client_ref: "ref-abandon-1" })).data.handoff_id;
  const used = (await c.call("start_handoff", { title: "has turns", mode: "verbatim", expected_turns: 3 })).data.handoff_id;
  const ap = await c.call("append_turns", { handoff_id: used, seq: 1, turns: [{ role: "user", index: 1, text: "kept" }] });
  assert.equal(ap.isError, false, JSON.stringify(ap));
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await fetch(`${B.url}/__scheduled?cron=*/10+*+*+*+*`)).status, 200);
  await new Promise((r) => setTimeout(r, 1000));
  const e = await c.call("handoff_status", { handoff_id: empty });
  assert.equal(e.data.error, "not_found", "empty handoff swept");
  const u = await c.call("handoff_status", { handoff_id: used });
  assert.ok(!u.data.error, "handoff with a chunk is kept: " + JSON.stringify(u.data));
  // its client_ref is released, so a retry starts a fresh handoff instead of resurrecting the swept id
  const again = await c.call("start_handoff", { title: "retry", mode: "verbatim", expected_turns: 3, client_ref: "ref-abandon-1" });
  assert.equal(again.data.existing, false);
  assert.notEqual(again.data.handoff_id, empty);
  assert.ok(B.logs.some((l) => l.includes('"evt":"abandoned_sweep"')));
});

// Static checks on the shipped docs and bot spec (skipped where the files aren't present, e.g. a worker-only repo).
const root = path.resolve(import.meta.dirname, "../..");
const spec = path.join(root, "bot/courier-inbox-routine.md");
test("TR-BUG-1/2/4: bot routine spec posts the claim's link once, stays quiet on empty handoffs, never asks for keys in chat", { skip: !fs.existsSync(spec) && "spec not present" }, () => {
  const s = fs.readFileSync(spec, "utf8");
  assert.match(s, /Do not call `?\/api\/connect-link`? after a claim/i);
  assert.match(s, /open handoffs/i);
  assert.match(s, /never ask the owner to paste/i);
});
test("TR-BUG-4: install docs say how the bot surfaces its webhook URL and key, and never send keys through chat", { skip: !fs.existsSync(path.join(root, "INSTALL.md")) && "docs not present" }, () => {
  for (const f of ["INSTALL.md", "README.md", "worker/package.json", "worker/setup.sh", "docs/index.html"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, "utf8");
    assert.doesNotMatch(s, /routine panel/i, `${f}: the app has no routine panel showing these values`);
  }
  const inst = fs.readFileSync(path.join(root, "INSTALL.md"), "utf8");
  assert.match(inst, /Show my Threadroost webhook/);
  assert.match(inst, /[Nn]ever paste the key into a chat/);
});

test("TR-BUG-6: GET (link previews, prefetch) never spends a Connect link; only the button POST does", async () => {
  const l = await (await api(B.url, "/api/connect-link?fresh=1", { method: "POST" })).json();
  const t = tOf(l.connect_url);
  for (let i = 0; i < 4; i++) {
    const g = await fetch(`${B.url}/connect?t=${t}`, { headers: { purpose: "prefetch", "user-agent": "Slackbot-LinkExpanding 1.0" } });
    assert.equal(g.status, 200);
    assert.doesNotMatch(await g.text(), /id="code"/, "GET never shows or mints a pairing code");
  }
  const p = await fetch(`${B.url}/connect`, { method: "POST", body: new URLSearchParams({ t }) });
  assert.equal(p.status, 200, "still redeemable after previews");
  assert.equal((await fetch(`${B.url}/connect?t=${t}`)).status, 410, "spent after the POST");
  // a wrong token on GET is not shown as live even while another link is live
  await api(B.url, "/api/connect-link?fresh=1", { method: "POST" });
  assert.equal((await fetch(`${B.url}/connect?t=${"w".repeat(32)}`)).status, 410);
});

test("TR-BUG-7: a replaced link says a newer link was issued, and clicking it can't burn the live one", async () => {
  const a = await (await api(B.url, "/api/connect-link?fresh=1", { method: "POST" })).json();
  const b = await (await api(B.url, "/api/connect-link?fresh=1", { method: "POST" })).json();
  const g = await fetch(`${B.url}/connect?t=${tOf(a.connect_url)}`);
  assert.equal(g.status, 410);
  assert.match(await g.text(), /A newer link was issued/);
  for (let i = 0; i < 6; i++) {
    const p = await fetch(`${B.url}/connect`, { method: "POST", body: new URLSearchParams({ t: tOf(a.connect_url) }) });
    assert.match(await p.text(), /newer link/);
  }
  const live = await fetch(`${B.url}/connect`, { method: "POST", body: new URLSearchParams({ t: tOf(b.connect_url) }) });
  assert.equal(live.status, 200, "old-link clicks don't count against the live link");
  const never = await fetch(`${B.url}/connect?t=${"q".repeat(32)}`);
  assert.match(await never.text(), /has expired/, "unknown links still get the generic page");
});

test("TR-BUG-8/9: spec runs catch-up on every wake plus a scheduled routine; install doc says approve routines right away", { skip: !fs.existsSync(spec) && "spec not present" }, () => {
  const s = fs.readFileSync(spec, "utf8");
  assert.match(s, /every webhook wake/i);
  assert.match(s, /threadroost-catchup/);
  const inst = fs.readFileSync(path.join(root, "INSTALL.md"), "utf8");
  assert.match(inst, /[Aa]pprove .*right away/);
  assert.match(inst, /threadroost-catchup/);
});

test("TR-BUG-10: upgrading a v1.1 install (explicit pull token, no boot record) counts as claimed and sends no claim link", async () => {
  const http = await import("node:http");
  const got = [];
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => { got.push(JSON.parse(b || "{}")); s.end("ok"); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const L = await startWorker({ port: 8825, vars: { COURIER_PULL_TOKEN: PULL, GROKBOT_WEBHOOK_URL: `http://127.0.0.1:${srv.address().port}/h`, GROKBOT_WEBHOOK_KEY: "k".repeat(40) } });
  try {
    const h = await (await fetch(`${L.url}/health`)).json();
    assert.equal(h.bot_connected, true, "legacy install is already connected");
    await fetch(`${L.url}/`, { headers: { accept: "text/html" } });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(got.filter((x) => x.event === "threadroost.claim").length, 0, "no claim link sent to the bot");
    const c = await fetch(`${L.url}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"code":"x"}' });
    assert.equal((await c.json()).error, "already_claimed");
    assert.equal((await fetch(`${L.url}/api/handoffs`, { headers: { authorization: `Bearer ${PULL}` } })).status, 200, "existing token still works");
    assert.ok(L.logs.some((l) => l.includes('"evt":"boot_migrated"')));
  } finally {
    await L.stop();
    srv.close();
  }
});

test("TR-BUG-10: --reclaim marks the boot record instead of deleting it, so the legacy migration can't undo a reclaim", () => {
  const s = fs.readFileSync(path.join(import.meta.dirname, "../setup.sh"), "utf8");
  assert.match(s, /kv key put --namespace-id "\$d_kv" --remote "courier:boot" '\{"reclaim":true\}'/);
  assert.doesNotMatch(s, /kv key delete[^\n]*courier:boot/);
});

test("spec/worker contract: every endpoint and response field the bot routine uses exists in the worker", { skip: !fs.existsSync(spec) && "spec not present" }, () => {
  const s = fs.readFileSync(spec, "utf8");
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8");
  for (const ep of ["/api/connect-link", "/api/handoffs"]) {
    assert.ok(s.includes(ep), `spec mentions ${ep}`);
    assert.ok(src.includes(`"${ep}"`), `worker serves ${ep}`);
  }
  assert.ok(src.includes('url.pathname === "/claim"'));
  assert.ok(/\/ack/.test(s) && src.includes("/ack"));
  for (const f of ["pull_token", "worker_url", "connect_url"]) assert.match(src, new RegExp(`${f}[:,]`), `claim response has ${f}`);
  assert.match(src, /reused: (true|false)/);
  assert.match(src, /searchParams\.get\("fresh"\)/);
  for (const e of ["threadroost.claim", "handoff_ready", "probe"]) {
    assert.ok(s.includes(e), `spec handles ${e}`);
    assert.ok(src.includes(`"${e}"`), `worker emits ${e}`);
  }
  for (const e of ["already_claimed", "claim_expired"]) assert.ok(s.includes(e) && src.includes(`"${e}"`), e);
});

async function mockServer(handler) {
  const http = await import("node:http");
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

test("TR-BUG-14: a webhook rejected with 400 (paused routine) says so in plain words", async () => {
  const m = await mockServer((q, s) => { q.resume(); q.on("end", () => { s.statusCode = 400; s.end("paused"); }); });
  const L = await startWorker({ port: 8827, vars: { COURIER_PULL_TOKEN: PULL, GROKBOT_WEBHOOK_URL: `${m.url}/h`, GROKBOT_WEBHOOK_KEY: "k".repeat(40) } });
  try {
    const pr = await (await api(L.url, "/api/admin/probe-webhook", { method: "POST" })).json();
    assert.equal(pr.webhook.ok, false);
    assert.equal(pr.webhook.http_status, 400);
    assert.match(pr.webhook.hint, /inbox routine .*paused/);
    assert.match(pr.webhook.hint, /stay queued/);
  } finally {
    await L.stop();
    m.srv.close();
  }
});

test("TR-BUG-15: --doctor says 'older version or still rolling out' instead of 'version undefined'", async () => {
  const { spawnSync } = await import("node:child_process");
  const m = await mockServer((q, s) => { s.statusCode = q.url === "/health" ? 404 : 200; s.setHeader("content-type", "application/json"); s.end(q.url === "/health" ? '{"error":"not_found"}' : "{}"); });
  try {
    const r = await new Promise((res) => {
      import("node:child_process").then(({ spawn }) => {
        const c = spawn("bash", [path.join(import.meta.dirname, "../setup.sh"), "--doctor", "--url", m.url], { env: { ...process.env, COURIER_TEST_BASE_URL: m.url } });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (out += d));
        c.on("close", (code) => res({ code, out }));
      });
    });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /older Threadroost|still rolling out/);
    assert.doesNotMatch(r.out, /version undefined/);
  } finally {
    m.srv.close();
  }
  void spawnSync;
});

test("TR-BUG-19: --doctor doesn't promise a claim link when there is no webhook to send it", async () => {
  const m = await mockServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(q.url === "/health" ? '{"ok":true,"version":"1.2.0","webhook_configured":false,"bot_connected":false}' : "{}"); });
  try {
    const { spawn } = await import("node:child_process");
    const r = await new Promise((res) => {
      const c = spawn("bash", [path.join(import.meta.dirname, "../setup.sh"), "--doctor", "--url", m.url], { env: { ...process.env, COURIER_TEST_BASE_URL: m.url } });
      let stdout = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.on("close", (status) => res({ status, stdout }));
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /cannot be connected until the webhook is set/);
    assert.doesNotMatch(r.stdout, /claim link is sent/);
  } finally {
    m.srv.close();
  }
});

test("TR-BUG-20: --reclaim reports 'claim link on its way' and exits 0 instead of looking like a failure", async () => {
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");
  const m = await mockServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(q.url === "/health" ? '{"ok":true,"version":"1.2.0","webhook_configured":true,"bot_connected":false}' : "{}"); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-"));
  for (const f of ["setup.sh", "package.json"]) fs.copyFileSync(path.join(import.meta.dirname, "..", f), path.join(dir, f));
  fs.cpSync(path.join(import.meta.dirname, "../scripts"), path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({ name: "threadroost-reclaimtest", main: "src/index.ts", kv_namespaces: [{ binding: "OAUTH_KV", id: "0".repeat(32) }] }));
  try {
    const r = await new Promise((res) => {
      const c = spawn("bash", [path.join(dir, "setup.sh"), "--reclaim", "--url", m.url], { cwd: dir, env: { ...process.env, WRANGLER: "true", COURIER_TEST_BASE_URL: m.url } });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (status) => res({ status, out }));
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Claim link on its way/);
  } finally {
    m.srv.close();
  }
});
