// TR-OPS-2: Workers KV LIST is capped at 1,000 a day on the free plan. These tests count every KV list the Worker
// makes (KV_TEST_HOOKS=count logs one {"evt":"kv_list"} line per call) so a regression that adds lists fails CI,
// and prove that when every list fails with 429 nothing is lost and the owner gets an alert.
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
const KEY = "kvlistkey-" + "k".repeat(40);
const api = (base, p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { authorization: `Bearer ${PULL}`, ...(init.headers || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wrangler dev can't set the cron clock, so with KV_TEST_HOOKS the cron string picks the slot: "test-off" is a
// normal 10-minute run, "test-on" the top-of-the-hour backstop run.
const OFF_HOUR = "test-off";
const ON_HOUR = "test-on";

async function hook(statusFor = () => 200) {
  const got = [];
  const srv = http.createServer((q, s) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      got.push(JSON.parse(b || "{}"));
      s.statusCode = statusFor();
      s.end("ok");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, srv, url: `http://127.0.0.1:${srv.address().port}/h` };
}

const lists = (W) => W.logs.map((l) => JSON.parse(l)).filter((e) => e.evt === "kv_list");
const doneCount = (W) => W.logs.filter((l) => l.includes('"evt":"cron_done"')).length;

/** Run one cron at a fixed time and return the KV lists it made. */
async function cronLists(W, time) {
  const before = lists(W).length;
  const done = doneCount(W);
  const r = await fetch(`${W.url}/__scheduled?cron=${time}`);
  assert.equal(r.status, 200);
  for (let i = 0; i < 80 && doneCount(W) === done; i++) await sleep(100);
  assert.ok(doneCount(W) > done, "cron did not finish");
  return lists(W).slice(before);
}

async function client(base) {
  const pair = await (await api(base, "/api/pair", { method: "POST" })).json();
  const flow = await oauthFlow(base, { getPairCode: async () => pair.code, redirectUri: "https://client.test.example/cb" });
  const c = mcpClient(base, flow.tokens.access_token);
  await c.initialize();
  return c;
}

async function sealed(c, text) {
  const s = await c.call("start_handoff", { title: "kv list test", mode: "verbatim", expected_turns: 2 });
  const id = s.data.handoff_id;
  await c.call("append_turns", { handoff_id: id, seq: 1, turns: [{ role: "user", index: 1, text }] });
  await c.call("append_turns", { handoff_id: id, seq: 2, turns: [{ role: "assistant", index: 2, text: text + " (reply)" }] });
  const f = await c.call("finish_handoff", { handoff_id: id, total_chunks: 2, total_turns: 2 });
  assert.ok(["queued", "delivered"].includes(f.data.status), JSON.stringify(f.data));
  return id;
}

test("TR-OPS-2: KV lists per cron run and per ack are measured, not estimated", async () => {
  const h = await hook();
  const W = await startWorker({
    port: 8851,
    vars: { COURIER_PULL_TOKEN: PULL, ALLOWED_REDIRECT_HOSTS: "client.test.example", GROKBOT_WEBHOOK_URL: h.url, GROKBOT_WEBHOOK_KEY: KEY, KV_TEST_HOOKS: "count", SYNC_NOTIFY_INTERVAL_SECONDS: "2", WEBHOOK_RETRY_DELAY_MS: "0" },
    extraArgs: ["--test-scheduled"],
  });
  const report = {};
  try {
    // Idle Worker (no synced thread pending): exactly one list, the shared handoff list.
    let l = await cronLists(W, OFF_HOUR);
    report.idle_cron = l.length;
    assert.deepEqual(l.map((x) => x.prefix), ["courier:m:"], "idle cron must list handoffs once and skip threads");
    // Top of the hour: the backstop also lists threads once.
    l = await cronLists(W, ON_HOUR);
    report.idle_cron_top_of_hour = l.length;
    assert.deepEqual(l.map((x) => x.prefix).sort(), ["courier:m:", "courier:s:"]);

    // A queued handoff: sweep, renotify and alerts share the one list.
    const c = await client(W.url);
    const id = await sealed(c, "count my lists");
    l = await cronLists(W, OFF_HOUR);
    report.cron_with_waiting_chat = l.length;
    assert.equal(l.length, 1, JSON.stringify(l));

    // Ack deletes the known chunk keys without listing, and the content is gone.
    const got = await (await api(W.url, `/api/handoffs/${id}`)).json();
    assert.equal(got.chunks.length, 2);
    const before = lists(W).length;
    const ack = await (await api(W.url, `/api/handoffs/${id}/ack`, { method: "POST", body: JSON.stringify({ verdict: "filed" }) })).json();
    assert.equal(ack.content_deleted, true);
    report.ack = lists(W).length - before;
    assert.equal(report.ack, 0, "ack must not list");
    assert.equal((await api(W.url, `/api/handoffs/${id}`)).status, 410);

    // A synced thread with unsent turns: the marker turns thread listing on, and the cron flushes it.
    // The first call notifies at once, the second within the interval is batched and leaves turns pending.
    const s1 = await c.call("sync_turns", { thread_key: "kv-list thread", turns: [{ role: "user", text: "synced turn" }] });
    assert.ok(!s1.data.error, JSON.stringify(s1.data));
    const s2 = await c.call("sync_turns", { thread_key: "kv-list thread", turns: [{ role: "assistant", text: "synced reply" }] });
    assert.equal(s2.data.delivery, "batched", JSON.stringify(s2.data));
    await sleep(2200);
    l = await cronLists(W, OFF_HOUR);
    report.cron_with_pending_thread = l.length;
    assert.deepEqual(l.map((x) => x.prefix).sort(), ["courier:m:", "courier:s:"]);
    // After the flush, once the marker is older than 2 intervals, the cron clears it and goes back to one list.
    await sleep(4500);
    await cronLists(W, OFF_HOUR);
    l = await cronLists(W, OFF_HOUR);
    report.cron_after_thread_flushed = l.length;
    assert.deepEqual(l.map((x) => x.prefix), ["courier:m:"]);
    console.log("TR-OPS-2 measured KV lists", JSON.stringify(report));
  } finally {
    await W.stop();
    h.srv.close();
  }
});

test("TR-OPS-2: every KV list failing with 429 loses nothing, keeps the ack working and raises the alert", async () => {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "kvlist-429-"));
  const base = { COURIER_PULL_TOKEN: PULL, ALLOWED_REDIRECT_HOSTS: "client.test.example", GROKBOT_WEBHOOK_KEY: KEY, WEBHOOK_RETRY_DELAY_MS: "0", RENOTIFY_BASE_SECONDS: "1" };
  const down = await hook(() => 500); // the bot is unreachable, so the chat stays queued
  let id;
  let W = await startWorker({ port: 8853, vars: { ...base, GROKBOT_WEBHOOK_URL: down.url }, persistTo: persist, extraArgs: ["--test-scheduled"] });
  try {
    id = await sealed(await client(W.url), "keep me safe");
  } finally {
    await W.stop();
    down.srv.close();
  }
  const h = await hook();
  W = await startWorker({ port: 8855, vars: { ...base, GROKBOT_WEBHOOK_URL: h.url, KV_TEST_HOOKS: "429" }, persistTo: persist, extraArgs: ["--test-scheduled"] });
  try {
    await sleep(1100);
    const l = await cronLists(W, ON_HOUR);
    assert.ok(l.length >= 1 && l.every((x) => x.failed), "lists were attempted and failed");
    for (let i = 0; i < 20 && !h.got.some((x) => x.event === "threadroost.alert"); i++) await sleep(250);
    const alert = h.got.find((x) => x.event === "threadroost.alert");
    assert.ok(alert, "owner alert raised");
    assert.ok(alert.kinds.includes("storage_list_limited"), JSON.stringify(alert.kinds));
    assert.match(alert.message, /Nothing was deleted/);
    assert.ok(!JSON.stringify(alert).includes("keep me safe"), "no chat text in the alert");
    // The bot's intake still surfaces the alert when the pending list is unavailable (Bugbot, PR #8).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kvlist-intake-"));
    fs.copyFileSync(path.resolve(import.meta.dirname, "../../bot/intake.py"), path.join(dir, "intake.py"));
    fs.writeFileSync(path.join(dir, "pull_token"), PULL, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ worker_url: W.url, timezone: "UTC", handoffs_root: path.join(dir, "h") }));
    const run = spawnSync("python3", [path.join(dir, "intake.py"), "drain"], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    const drained = JSON.parse(run.stdout.trim().split("\n").pop());
    assert.equal(run.status, 1);
    assert.equal(drained.ok, false);
    assert.equal(drained.error, "storage_list_limited");
    assert.match(drained.alert.message, /KV list limit/);
    // The pending list degrades to 503 + retry-after instead of a 500.
    const r = await api(W.url, "/api/handoffs");
    assert.equal(r.status, 503);
    assert.ok(Number(r.headers.get("retry-after")) >= 60);
    assert.equal((await r.json()).error, "storage_list_limited");
    // The chat is intact, readable by id and ackable with no list at all.
    const got = await (await api(W.url, `/api/handoffs/${id}`)).json();
    assert.deepEqual(got.chunks.map((c) => c.turns[0].text), ["keep me safe", "keep me safe (reply)"]);
    const ack = await (await api(W.url, `/api/handoffs/${id}/ack`, { method: "POST", body: JSON.stringify({ verdict: "filed" }) })).json();
    assert.equal(ack.content_deleted, true);
    assert.equal((await api(W.url, `/api/handoffs/${id}`)).status, 410);
    // The alert route still answers.
    const a = await (await api(W.url, "/api/admin/alert")).json();
    assert.ok(a.alert.kinds.includes("storage_list_limited"));
  } finally {
    await W.stop();
    h.srv.close();
    fs.rmSync(persist, { recursive: true, force: true });
  }
});
