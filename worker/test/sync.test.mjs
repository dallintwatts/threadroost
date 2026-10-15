// Live sync (sync_turns), Claude redirect allowlist, and role/source tagging, against `wrangler dev`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { startWorker, mcpClient, oauthFlow, sha256Hex } from "./helpers.mjs";

const PULL = crypto.randomBytes(32).toString("base64url");
const TEST_REDIRECT = "https://client.test.example/callback"; // test-only host on instance C
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const GROK_CB = "https://grok.com/connectors-oauth-exchange-code/";
let C, D, mock;
const received = [];
const hooks = (path) => received.filter((x) => x.path === path);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

const api = (base, p, init = {}) =>
  fetch(`${base}${p}`, { ...init, headers: { authorization: `Bearer ${PULL}`, "content-type": "application/json", ...(init.headers || {}) } });
const pairCode = (base) => async () => (await (await api(base, "/api/pair", { method: "POST" })).json()).code;
const U = (text) => ({ role: "user", text });
const A = (text) => ({ role: "assistant", text });

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((r) => mock.listen(8798, "127.0.0.1", r));
  const started = await Promise.allSettled([
    // C: batching window 10 min, "sync now" allowed immediately, daily cap 2 (handoffs + synced threads).
    startWorker({
      port: 8789,
      vars: {
        COURIER_PULL_TOKEN: PULL,
        ALLOWED_REDIRECT_HOSTS: "grok.com,x.ai,client.test.example",
        MAX_HANDOFFS_PER_DAY: "2",
        SYNC_NOTIFY_INTERVAL_SECONDS: "600",
        SYNC_FLUSH_MIN_SECONDS: "0",
        GROKBOT_WEBHOOK_URL: "http://127.0.0.1:8798/hookC",
        GROKBOT_WEBHOOK_KEY: "test-webhook-key",
      },
    }),
    // D: production redirect config from wrangler.jsonc; 2 s batching window; cron route enabled.
    startWorker({
      port: 8793,
      vars: {
        COURIER_PULL_TOKEN: PULL,
        SYNC_NOTIFY_INTERVAL_SECONDS: "2",
        GROKBOT_WEBHOOK_URL: "http://127.0.0.1:8798/hookD",
        GROKBOT_WEBHOOK_KEY: "test-webhook-key",
      },
      extraArgs: ["--test-scheduled"],
    }),
  ]);
  [C, D] = started.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  const failed = started.find((r) => r.status === "rejected");
  if (failed) throw failed.reason; // after() still stops whichever instance did start
});

after(async () => {
  await Promise.all([C?.stop(), D?.stop()]);
  mock?.close();
});

// ---------------------------------------------------------------------------
// Redirect allowlist (instance D runs the wrangler.jsonc values)
// ---------------------------------------------------------------------------

const dcr = (base, uri) =>
  fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "redirect-check", redirect_uris: [uri], token_endpoint_auth_method: "none" }),
  });

test("redirects: Claude's exact callback allowed; grok.com still allowed; near-misses and Claude Code localhost blocked", async () => {
  const allowed = [CLAUDE_CB, GROK_CB];
  const blocked = [
    "https://claude.ai/api/mcp/auth_callback/", // trailing slash
    "https://claude.ai/api/mcp/auth_callback?next=x", // query
    "https://claude.ai/api/mcp/other", // other path on claude.ai
    "https://claude.ai/", // host only
    "https://evil.claude.ai/api/mcp/auth_callback", // subdomain
    "https://claude.ai.evil.example/api/mcp/auth_callback", // suffix trick
    "http://claude.ai/api/mcp/auth_callback", // not https
    "http://localhost:33418/callback", // Claude Code loopback
    "http://127.0.0.1:33418/callback", // Claude Code loopback
    "https://localhost/callback",
    "https://anthropic.com/api/mcp/auth_callback",
  ];
  const res = {};
  for (const u of allowed) res[u] = (await dcr(D.url, u)).status;
  for (const u of blocked) res[u] = (await dcr(D.url, u)).status;
  console.log("  DCR statuses:", JSON.stringify(res));
  for (const u of allowed) assert.equal(res[u], 201, u);
  for (const u of blocked) assert.equal(res[u], 400, u);
  const bad = await (await dcr(D.url, "http://localhost:33418/callback")).json();
  assert.match(bad.error_description ?? JSON.stringify(bad), /claude\.ai\/api\/mcp\/auth_callback/);

  // Pre-registered client path uses the same rule.
  const pre = await api(D.url, "/api/admin/clients", { method: "POST", body: JSON.stringify({ client_name: "claude-pre", redirect_uris: [CLAUDE_CB] }) });
  assert.equal(pre.status, 201);
  const preBad = await api(D.url, "/api/admin/clients", { method: "POST", body: JSON.stringify({ client_name: "cc", redirect_uris: ["http://localhost:4000/callback"] }) });
  assert.equal(preBad.status, 400);
  const body = await preBad.json();
  assert.deepEqual(body.allowed_uris, [CLAUDE_CB]);
  assert.deepEqual(body.allowed_hosts, ["grok.com", "x.ai"]);

  const log = await (await api(D.url, "/api/admin/dcr-log")).json();
  assert.ok(log.registrations.some((e) => e.redirect_uris[0] === CLAUDE_CB && e.allowed === true));
  assert.ok(log.registrations.some((e) => e.redirect_uris[0] === "http://localhost:33418/callback" && e.allowed === false));
});

// ---------------------------------------------------------------------------
// Claude + Grok clients: full OAuth, source tagging, separate threads
// ---------------------------------------------------------------------------

let claude, grok;
test("Claude connects via DCR + PKCE + pairing code to the exact callback; Grok still connects", async () => {
  const f1 = await oauthFlow(D.url, { getPairCode: pairCode(D.url), redirectUri: CLAUDE_CB, clientName: "Claude" });
  assert.equal(f1.ev.dcrStatus, 201);
  assert.equal(f1.ev.consentStatus, 200);
  assert.equal(f1.ev.approveStatus, 302);
  assert.equal(f1.ev.redirectLocationHost, "claude.ai"); // never followed by the test
  assert.equal(f1.ev.tokenStatus, 200);
  claude = { c: mcpClient(D.url, f1.tokens.access_token), clientId: f1.clientId };
  const f2 = await oauthFlow(D.url, { getPairCode: pairCode(D.url), redirectUri: GROK_CB, clientName: "Grok" });
  assert.equal(f2.ev.tokenStatus, 200);
  grok = { c: mcpClient(D.url, f2.tokens.access_token), clientId: f2.clientId };
  // Claude's token works on /mcp (claude.ai is also on the origin allowlist).
  const init = await claude.c.initialize();
  assert.ok(init.result?.serverInfo);
});

test("role/source shape: handoffs are tagged with the OAuth client and its source", async () => {
  const out = {};
  for (const [name, who] of [["claude", claude], ["grok", grok]]) {
    // A declared source never overrides the one derived from the client's registered redirect.
    const s = await who.c.call("start_handoff", { title: `Shape ${name}`, mode: "verbatim", expected_turns: 2, source: name === "claude" ? "grok" : "claude" });
    assert.equal(s.isError, false, JSON.stringify(s));
    assert.equal(s.data.source, name);
    const id = s.data.handoff_id;
    const a = await who.c.call("append_turns", { handoff_id: id, seq: 1, turns: [{ index: 1, role: "user", text: "hi" }, { index: 2, role: "assistant", text: "hello" }] });
    assert.equal(a.data.ok, true, JSON.stringify(a));
    const f = await who.c.call("finish_handoff", { handoff_id: id, total_chunks: 1, total_turns: 2 });
    assert.equal(f.data.status, "delivered", JSON.stringify(f));
    const full = await (await api(D.url, `/api/handoffs/${id}`)).json();
    assert.equal(full.handoff.kind, "handoff");
    assert.equal(full.handoff.source, name);
    assert.equal(full.handoff.source_basis, "oauth_client");
    assert.equal(full.handoff.client_id, who.clientId);
    assert.deepEqual(full.chunks[0].turns.map((t) => t.role), ["user", "assistant"]);
    out[name] = id;
  }
  const w = hooks("/hookD").filter((x) => x.body.event === "handoff_ready" && x.body.kind === "handoff");
  assert.deepEqual(w.map((x) => x.body.source).sort(), ["claude", "grok"]);
  // Old label is rejected by the schema.
  const s = await claude.c.call("start_handoff", { title: "x", mode: "verbatim", expected_turns: 1 });
  const bad = await claude.c.call("append_turns", { handoff_id: s.data.handoff_id, seq: 1, turns: [{ index: 1, role: "claude", text: "x" }] });
  assert.ok(bad.isError || bad.rpcError);
  console.log("  tagged:", JSON.stringify(out));
});

test("sync_turns: same thread_key from Claude and Grok files as two separate threads", async () => {
  const a = await claude.c.call("sync_turns", { thread_key: "Shared Title", turns: [U("claude side")] });
  const b = await grok.c.call("sync_turns", { thread_key: "Shared Title", turns: [U("grok side")] });
  assert.equal(a.data.source, "claude");
  assert.equal(b.data.source, "grok");
  assert.notEqual(a.data.stream_id, b.data.stream_id);
  assert.equal(a.data.new_thread, true);
  assert.equal(b.data.new_thread, true);
  assert.ok(await waitFor(() => hooks("/hookD").filter((x) => x.body.kind === "stream").length >= 2));
  const seg = hooks("/hookD").filter((x) => x.body.kind === "stream");
  assert.deepEqual(seg.map((x) => x.body.source).sort(), ["claude", "grok"]);
});

test("cron flush: a quiet thread's batched turns are sealed and notified by the scheduled handler", async () => {
  const before = hooks("/hookD").length;
  // Thread "Shared Title" (claude) was notified moments ago, so this turn is batched.
  const r = await claude.c.call("sync_turns", { thread_key: "Shared Title", turns: [A("reply one"), U("second message")] });
  assert.equal(r.data.delivery, "batched", JSON.stringify(r.data));
  await sleep(400);
  assert.equal(hooks("/hookD").length, before, "no webhook inside the batch window");
  await sleep(2200); // window is 2 s on instance D
  const sch = await fetch(`${D.url}/__scheduled?cron=*/10+*+*+*+*`);
  assert.equal(sch.status, 200);
  assert.ok(await waitFor(() => hooks("/hookD").length > before), "cron flushed the quiet thread");
  const w = hooks("/hookD").at(-1).body;
  assert.equal(w.kind, "stream");
  assert.equal(w.source, "claude");
  assert.equal(w.segment, 2);
  assert.equal(w.first_index, 2);
  assert.equal(w.turns, 2);
  const full = await (await api(D.url, `/api/handoffs/${w.handoff_id}`)).json();
  assert.equal(full.handoff.status, "delivered");
  assert.deepEqual(full.chunks.flatMap((c) => c.turns), [
    { index: 1, role: "assistant", text: "reply one" },
    { index: 2, role: "user", text: "second message" },
  ]);
  // Nothing left to flush: a second cron run sends nothing.
  const n = hooks("/hookD").length;
  await fetch(`${D.url}/__scheduled?cron=*/10+*+*+*+*`);
  await sleep(500);
  assert.equal(hooks("/hookD").length, n);
});

// ---------------------------------------------------------------------------
// sync_turns semantics (instance C: 10-min window, cap 2/day)
// ---------------------------------------------------------------------------

let c;
test("sync_turns schema: one call per turn, roles user/assistant, verbatim rules kept, no seq/index", async () => {
  const flow = await oauthFlow(C.url, { getPairCode: pairCode(C.url), redirectUri: TEST_REDIRECT });
  c = mcpClient(C.url, flow.tokens.access_token);
  const tl = await c.listTools();
  const tools = Object.fromEntries(tl.result.tools.map((t) => [t.name, t]));
  const sync = tools.sync_turns;
  assert.ok(sync);
  for (const t of Object.values(tools)) assert.ok(!/`grok`/.test(t.description), `${t.name} still says \`grok\``);
  for (const name of ["sync_turns", "start_handoff", "append_turns"]) {
    assert.ok(tools[name].description.includes("Copy each turn EXACTLY as it appears in this conversation, word for word"), name);
    assert.ok(tools[name].description.includes("[TURN NOT AVAILABLE VERBATIM]"), name);
    assert.ok(tools[name].description.includes("`assistant`"), name);
  }
  const item = sync.inputSchema.properties.turns.items;
  assert.deepEqual(item.properties.role.enum, ["user", "assistant"]);
  assert.deepEqual(Object.keys(item.properties).sort(), ["role", "text"]);
  assert.ok(!("seq" in sync.inputSchema.properties));
  assert.deepEqual(tools.append_turns.inputSchema.properties.turns.items.properties.role.enum, ["user", "assistant"]);
  assert.match(sync.description, /previous reply/);
});

const long1 = "Here is a longer assistant answer that easily clears the replay threshold of forty characters.";
const rich = 'Code:\n```js\nconsole.log("hi\\n")\n```\n| a | b |\n|---|---|\n| é | 😀 |\tend\u2028x';

test("sync_turns: lag-by-one ordering, server-assigned indices, dedupe, gaps, batched notify", async () => {
  // 1) first message of a chat: just the user's message. First call notifies immediately.
  let r = await c.call("sync_turns", { thread_key: "Weekend Plan", title: "Weekend Plan", project: "Trips", turns: [U("yes")] });
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.equal(r.data.status, "ok");
  assert.equal(r.data.stored_indices, "1");
  assert.equal(r.data.stream_turns, 1);
  assert.equal(r.data.new_thread, true);
  assert.equal(r.data.delivery, "notifying_bot");
  assert.deepEqual(r.data.gaps, []);
  assert.deepEqual(r.data.server_copy_ends_with, { index: 1, role: "user", starts: "yes" });
  assert.match(r.data.next, /your reply to turn 1/);
  assert.ok(await waitFor(() => hooks("/hookC").length === 1));
  const w1 = hooks("/hookC")[0];
  assert.equal(w1.headers["x-automation-key"], "test-webhook-key");
  assert.equal(w1.body.kind, "stream");
  assert.equal(w1.body.segment, 1);
  assert.equal(w1.body.turns, 1);
  assert.ok(!JSON.stringify(w1.body).includes('"yes"'), "webhook carries no content");
  const seg1 = w1.body.handoff_id;

  // 2) lag-by-one: previous reply + new user message, inside the window -> batched, no webhook.
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A(long1), U(rich)] });
  assert.equal(r.data.stored_indices, "2-3");
  assert.equal(r.data.delivery, "batched");
  assert.ok(r.data.next_notify_after);
  // 3) exact retry of the same call -> no-op, never an error (the old seq-reuse bounce).
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A(long1), U(rich)] });
  assert.equal(r.isError, false);
  assert.equal(r.data.status, "duplicate");
  assert.equal(r.data.stored, 0);
  assert.equal(r.data.duplicates, 2);
  assert.equal(r.data.stream_turns, 3);
  // thread_key is matched case/whitespace-insensitively.
  r = await c.call("sync_turns", { thread_key: "  weekend   PLAN ", turns: [A(long1), U(rich)] });
  assert.equal(r.data.new_thread, false);
  assert.equal(r.data.status, "duplicate");
  await sleep(300);
  assert.equal(hooks("/hookC").length, 1, "batched: still one webhook");

  // 4) "sync now": the latest reply alone, flush=true -> notifies now.
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A("Sure.")], flush: true });
  assert.equal(r.data.stored_indices, "4");
  assert.equal(r.data.delivery, "notifying_bot");
  assert.ok(await waitFor(() => hooks("/hookC").length === 2));
  const w2 = hooks("/hookC")[1].body;
  assert.equal(w2.segment, 2);
  assert.equal(w2.first_index, 2);
  assert.equal(w2.turns, 3);
  // 5) next lag-by-one call repeats that reply: it overlaps the tail and is skipped; a short user
  //    message that repeats an earlier one ("yes") is still stored (only the tail overlap is a re-send).
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A("Sure."), U("yes")] });
  assert.equal(r.data.duplicates, 1);
  assert.equal(r.data.stored_indices, "5");
  // 6) an older long turn re-sent out of order is skipped as a replay; the user turn is stored,
  //    and two user turns in a row are flagged as a possible missing reply.
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A(long1), U("what about Sunday?")] });
  assert.deepEqual(r.data.replayed_indices, [2]);
  assert.equal(r.data.stored_indices, "6");
  assert.deepEqual(r.data.gaps.map((g) => [g.kind, g.at]), [["missing_assistant_reply", 6]]);
  assert.ok(r.data.action);
  // 7) two assistant turns in a row, plus a placeholder turn.
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A("Sunday: hike."), A("[TURN NOT AVAILABLE VERBATIM]")] });
  assert.deepEqual(r.data.gaps.map((g) => g.kind), ["missing_user_message", "not_verbatim"]);
  assert.equal(r.data.stream_turns, 8);
  assert.equal(r.data.possible_gaps_total, 2);

  // Status by thread_key: metadata only.
  const st = await c.call("handoff_status", { thread_key: "Weekend Plan" });
  assert.equal(st.data.thread.stream_turns, 8);
  assert.equal(st.data.thread.pending_turns, 4);
  assert.equal(st.data.thread.segments_sealed, 2);
  assert.equal(st.data.thread.project, "Trips");
  assert.ok(!JSON.stringify(st.data).includes("Sunday"), "status never returns content");
  const list = await c.call("handoff_status", {});
  assert.ok(list.data.threads.some((t) => t.thread_key === "Weekend Plan" && t.turns === 8 && t.pending));

  // Bot side: both sealed segments are pending, verify with the existing hash scheme, verbatim round trip, ack.
  const pend = await (await api(C.url, "/api/handoffs?status=pending")).json();
  assert.ok(pend.handoffs.some((h) => h.handoff_id === seg1));
  const full = await (await api(C.url, `/api/handoffs/${w2.handoff_id}`)).json();
  const hashes = full.chunks.map((ch) => sha256Hex(JSON.stringify(ch.turns)));
  assert.deepEqual(hashes, full.chunks.map((ch) => ch.sha256));
  assert.equal(sha256Hex(hashes.join("\n")), full.handoff.sha256);
  const all = full.chunks.flatMap((ch) => ch.turns);
  assert.deepEqual(all.map((t) => t.index), [1, 2, 3], "segment-local indices 1..N");
  assert.equal(full.handoff.first_index, 2);
  assert.equal(all[1].text, rich, "verbatim round trip");
  assert.equal(full.handoff.kind, "stream");
  assert.equal(full.handoff.thread_key, "Weekend Plan");
  assert.equal(full.handoff.project, "Trips");
  assert.equal(full.handoff.source, "other");
  for (const id of [seg1, w2.handoff_id]) assert.equal((await api(C.url, `/api/handoffs/${id}/ack`, { method: "POST", body: '{"verdict":"high"}' })).status, 200);
  assert.equal((await api(C.url, `/api/handoffs/${seg1}`)).status, 410);
});

test("sync_turns caps: per-call turns/bytes, empty text, and the daily cap counts a thread once per day", async () => {
  let r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: Array.from({ length: 21 }, (_, i) => U(`m${i}`)) });
  assert.ok(r.isError || r.rpcError, "21 turns rejected");
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A("x".repeat(64 * 1024 + 1))] });
  assert.equal(r.data.error, "cap_exceeded");
  r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [U("   ")] });
  assert.equal(r.data.error, "invalid");
  r = await c.call("sync_turns", { thread_key: "   ", turns: [U("x")] });
  assert.equal(r.data.error, "invalid");

  // Instance C allows 2 per day. "Weekend Plan" already counted once despite ~10 calls.
  r = await c.call("sync_turns", { thread_key: "Second thread", turns: [U("hello")] });
  assert.equal(r.data.status, "ok", JSON.stringify(r.data));
  r = await c.call("sync_turns", { thread_key: "Third thread", turns: [U("hello")] });
  assert.equal(r.data.error, "daily_cap_reached");
  const s = await c.call("start_handoff", { title: "x", mode: "verbatim", expected_turns: 1 });
  assert.equal(s.data.error, "daily_cap_reached", "handoffs and synced threads share the daily cap");
  for (let i = 0; i < 5; i++) {
    r = await c.call("sync_turns", { thread_key: "Weekend Plan", turns: [A(`reply ${i}`), U(`message ${i}`)] });
    assert.equal(r.data.status, "ok", "an already-counted thread keeps syncing all day");
  }
});

test("logs carry no content, tokens, or pairing codes", async () => {
  const all = C.logs.join("\n") + D.logs.join("\n");
  assert.ok(all.includes('"evt":"sync_turns"'));
  assert.ok(all.includes('"evt":"sync_cron"'));
  for (const s of ["Weekend", "Sunday", "claude side", long1, PULL]) assert.ok(!all.includes(s), s);
  assert.ok(!/"code":"\d{8}"/.test(all));
});
