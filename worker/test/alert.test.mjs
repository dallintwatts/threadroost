// TR-ALERT-1: cron alerting. A handoff stuck undelivered past ALERT_STUCK_SECONDS, or 3+ consecutive webhook failures,
// sends one "threadroost.alert" webhook. At most one an hour, the same problem is not re-sent, and nothing secret is in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { startWorker, oauthFlow, mcpClient } from "./helpers.mjs";

const PULL = crypto.randomBytes(32).toString("base64url");
const KEY = "alertkey-" + "k".repeat(40);
const TITLE = "SECRET-TITLE do not leak";
const api = (base, p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { authorization: `Bearer ${PULL}`, ...(init.headers || {}) } });
const cron = (base) => fetch(`${base}/__scheduled?cron=*/10+*+*+*+*`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hook(statusFor) {
  const got = [];
  const srv = http.createServer((q, s) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      const j = JSON.parse(b || "{}");
      got.push(j);
      s.statusCode = statusFor(j);
      s.end(s.statusCode === 200 ? "ok" : "rate limit");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, srv, url: `http://127.0.0.1:${srv.address().port}/h` };
}

async function sealedHandoff(base) {
  const pair = await (await api(base, "/api/pair", { method: "POST" })).json();
  const flow = await oauthFlow(base, { getPairCode: async () => pair.code, redirectUri: "https://client.test.example/cb" });
  const c = mcpClient(base, flow.tokens.access_token);
  await c.initialize();
  const s = await c.call("start_handoff", { title: TITLE, mode: "verbatim", expected_turns: 1 });
  const id = s.data.handoff_id;
  await c.call("append_turns", { handoff_id: id, seq: 1, turns: [{ role: "user", index: 1, text: "alert test" }] });
  await c.call("finish_handoff", { handoff_id: id, total_chunks: 1, total_turns: 1 });
  return id;
}

function intake(base, root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-intake-"));
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../bot/intake.py"), path.join(dir, "intake.py"));
  fs.writeFileSync(path.join(dir, "pull_token"), PULL, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ worker_url: base, timezone: "UTC", handoffs_root: root }));
  return () => {
    const r = spawnSync("python3", [path.join(dir, "intake.py"), "drain", "--no-ack"], { encoding: "utf8" });
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
}

test("TR-ALERT-1: stuck handoff + failing webhook sends one plain-words alert, rate-limited, readable by the intake", async () => {
  const h = await hook(() => 400);
  const W = await startWorker({
    port: 8831,
    vars: { COURIER_PULL_TOKEN: PULL, ALLOWED_REDIRECT_HOSTS: "client.test.example", GROKBOT_WEBHOOK_URL: h.url, GROKBOT_WEBHOOK_KEY: KEY, ALERT_STUCK_SECONDS: "1", RENOTIFY_BASE_SECONDS: "99999", WEBHOOK_RETRY_DELAY_MS: "0" },
    extraArgs: ["--test-scheduled"],
  });
  try {
    const id = await sealedHandoff(W.url);
    for (let i = 0; i < 3; i++) await api(W.url, "/api/admin/probe-webhook", { method: "POST" });
    let a0 = await (await api(W.url, "/api/admin/alert")).json();
    assert.ok(a0.webhook_consecutive_failures >= 3, JSON.stringify(a0));
    assert.equal(a0.alert, null);
    await sleep(1200);
    await cron(W.url);
    for (let i = 0; i < 20 && !h.got.some((x) => x.event === "threadroost.alert"); i++) await sleep(250);
    const alerts = h.got.filter((x) => x.event === "threadroost.alert");
    assert.equal(alerts.length, 1, "one alert");
    const al = alerts[0];
    assert.deepEqual(al.kinds, ["stuck_handoffs", "webhook_failing"]);
    assert.equal(al.stuck_handoffs[0].handoff_id, id);
    assert.match(al.message, /^Threadroost needs a look\. 1 finished chat has waited over 0 minutes to reach your bot \(0 minutes so far\)\./);
    assert.match(al.message, /last \d+ messages to your bot failed \(latest: HTTP 400\)/);
    assert.match(al.message, /\.\/setup\.sh --doctor/);
    const raw = JSON.stringify(al);
    for (const bad of [TITLE, KEY, PULL, "undefined", "fingerprint", "http://"]) assert.ok(!raw.includes(bad), `alert must not contain ${bad}`);
    // Rate limit: the next cron sends nothing.
    await cron(W.url);
    await sleep(1500);
    assert.equal(h.got.filter((x) => x.event === "threadroost.alert").length, 1, "rate-limited to one an hour");
    const a1 = await (await api(W.url, "/api/admin/alert")).json();
    assert.equal(a1.alert.alert_id, al.alert_id);
    assert.equal(a1.alert.delivered, false);
    assert.ok(!("fingerprint" in a1.alert) && !JSON.stringify(a1).includes(TITLE));
    // The intake surfaces it once, rebuilt in the bot's own voice, even though the webhook failed.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alert-root-"));
    const run = intake(W.url, root);
    const r1 = run();
    assert.equal(r1.alert.alert_id, al.alert_id);
    assert.match(r1.alert.message, /^Threadroost needs a look\. 1 finished chat has waited over 0 minutes to reach me \(0 minutes so far\)\./);
    assert.match(r1.alert.message, /Your Worker's last \d+ messages to me failed \(latest: HTTP 400\)/);
    assert.ok(!JSON.stringify(r1.alert).includes(TITLE));
    assert.equal(run().alert, undefined, "shown once");
    assert.equal((await (await api(W.url, "/api/admin/alert", { headers: { authorization: "Bearer nope" } })).status), 401);
  } finally {
    await W.stop();
    h.srv.close();
  }
});

test("TR-ALERT-1: a delivered alert isn't repeated for the same problem, a success resets the failure count", async () => {
  let fail = true;
  const h = await hook((j) => (j.event === "threadroost.alert" ? 200 : fail ? 503 : 200));
  const W = await startWorker({
    port: 8833,
    vars: { COURIER_PULL_TOKEN: PULL, ALLOWED_REDIRECT_HOSTS: "client.test.example", GROKBOT_WEBHOOK_URL: h.url, GROKBOT_WEBHOOK_KEY: KEY, ALERT_INTERVAL_SECONDS: "0" },
    extraArgs: ["--test-scheduled"],
  });
  try {
    for (let i = 0; i < 3; i++) await api(W.url, "/api/admin/probe-webhook", { method: "POST" });
    await cron(W.url);
    for (let i = 0; i < 20 && !h.got.some((x) => x.event === "threadroost.alert"); i++) await sleep(250);
    const first = h.got.filter((x) => x.event === "threadroost.alert");
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].kinds, ["webhook_failing"]);
    assert.match(first[0].message, /latest: HTTP 503/);
    assert.doesNotMatch(first[0].message, /finished chat/);
    await cron(W.url);
    await sleep(1500);
    assert.equal(h.got.filter((x) => x.event === "threadroost.alert").length, 1, "same problem, already delivered: not re-sent");
    fail = false;
    await api(W.url, "/api/admin/probe-webhook", { method: "POST" });
    assert.equal((await (await api(W.url, "/api/admin/alert")).json()).webhook_consecutive_failures, 0);
    await cron(W.url);
    await sleep(1500);
    assert.equal(h.got.filter((x) => x.event === "threadroost.alert").length, 1, "healthy: no alert");
  } finally {
    await W.stop();
    h.srv.close();
  }
});

test("TR-ALERT-1: routine and skill surface the alert once, in plain words, and docs describe it", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const r = fs.readFileSync(path.join(root, "bot/courier-inbox-routine.md"), "utf8");
  assert.match(r, /event = "threadroost.alert"/);
  assert.match(r, /word for word/);
  assert.match(r, /Always run the intake \(it also checks for alerts\)/);
  const sk = fs.readFileSync(path.join(root, "bot/skills/threadroost-intake/SKILL.md"), "utf8");
  assert.match(sk, /`alert` \(a Worker problem\)/);
  const src = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8");
  assert.ok(src.includes('"threadroost.alert"') && src.includes('"/api/admin/alert"'));
});
