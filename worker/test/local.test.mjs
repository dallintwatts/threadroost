// End-to-end tests against `wrangler dev` (local workerd + local KV).
// Covers plan 5.1 items 1, 2, 4 plus the full OAuth DCR + PKCE + pairing-code flow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { startWorker, mcpClient, oauthFlow, turns, sha256Hex } from "./helpers.mjs";

const PULL = crypto.randomBytes(32).toString("base64url");
const TEST_REDIRECT = "https://client.test.example/callback"; // allowed only via the test-only host override
let A, B, mock;
const received = [];

const api = (base, p, init = {}) =>
  fetch(`${base}${p}`, { ...init, headers: { authorization: `Bearer ${PULL}`, "content-type": "application/json", ...(init.headers || {}) } });
const pairCode = (base) => async () => (await (await api(base, "/api/pair", { method: "POST" })).json()).code;

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((r) => mock.listen(8799, "127.0.0.1", r));
  const common = { COURIER_PULL_TOKEN: PULL, ALLOWED_REDIRECT_HOSTS: "grok.com,x.ai,client.test.example" };
  [A, B] = await Promise.all([
    startWorker({ port: 8787, vars: { ...common } }),
    startWorker({
      port: 8788,
      vars: { ...common, MAX_HANDOFFS_PER_DAY: "2", GROKBOT_WEBHOOK_URL: "http://127.0.0.1:8799/hook", GROKBOT_WEBHOOK_KEY: "test-webhook-key" },
    }),
  ]);
});

after(async () => {
  await Promise.all([A?.stop(), B?.stop()]);
  mock?.close();
});

test("5.1#1: /mcp without token -> 401 with WWW-Authenticate resource_metadata", async () => {
  const r = await fetch(`${A.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  const h = r.headers.get("www-authenticate");
  console.log("  WWW-Authenticate:", h);
  assert.match(h, /^Bearer /);
  assert.match(h, /resource_metadata="http:\/\/localhost:8787\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("5.1#2: well-known metadata, S256 + registration endpoint", async () => {
  const prm = await fetch(`${A.url}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.status, 200);
  const p = await prm.json();
  assert.equal(p.resource, `${A.url}/mcp`);
  assert.deepEqual(p.authorization_servers, [A.url]);
  const prmRoot = await fetch(`${A.url}/.well-known/oauth-protected-resource`);
  console.log("  root /.well-known/oauth-protected-resource status:", prmRoot.status);
  const as = await fetch(`${A.url}/.well-known/oauth-authorization-server`);
  assert.equal(as.status, 200);
  const m = await as.json();
  console.log("  AS metadata:", JSON.stringify(m));
  assert.ok(m.code_challenge_methods_supported.includes("S256"));
  assert.ok(!m.code_challenge_methods_supported.includes("plain"));
  assert.equal(m.registration_endpoint, `${A.url}/oauth/register`);
  assert.equal(m.authorization_endpoint, `${A.url}/authorize`);
  assert.equal(m.token_endpoint, `${A.url}/oauth/token`);
});

test("DCR rejects non-allowed redirect hosts and logs redirect_uris", async () => {
  const r = await fetch(`${A.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(r.status, 400);
  const plainHttp = await fetch(`${A.url}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "x", redirect_uris: ["http://grok.com/cb"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(plainHttp.status, 400);
  const log = await (await api(A.url, "/api/admin/dcr-log")).json();
  assert.ok(log.registrations.some((e) => e.redirect_uris[0] === "https://evil.example/cb" && e.allowed === false));
  assert.ok(A.logs.some((l) => l.includes('"evt":"dcr"') && l.includes("evil.example")));
});

test("bot API requires the pull token", async () => {
  for (const p of ["/api/pair", "/api/handoffs", "/api/admin/revoke-all"]) {
    const r = await fetch(`${A.url}${p}`, { method: p === "/api/handoffs" ? "GET" : "POST", headers: { authorization: "Bearer wrong" } });
    assert.equal(r.status, 401, p);
  }
});

let tokA;
test("full OAuth: DCR + PKCE + pairing code (wrong code first, single use, code replay fails, refresh works)", async () => {
  const flow = await oauthFlow(A.url, { getPairCode: pairCode(A.url), redirectUri: TEST_REDIRECT, wrongCodeFirst: true });
  console.log("  evidence:", JSON.stringify(flow.ev));
  assert.equal(flow.ev.unauthStatus, 401);
  assert.equal(flow.ev.dcrStatus, 201);
  assert.equal(flow.ev.dcr.token_endpoint_auth_method, "none");
  assert.equal(flow.ev.consentStatus, 200);
  assert.ok(flow.ev.consentHasCodeField);
  assert.equal(flow.ev.wrongCodeStatus, 401);
  assert.equal(flow.ev.approveStatus, 302);
  assert.equal(flow.ev.redirectLocationHost, "client.test.example");
  assert.ok(flow.ev.stateRoundTrip);
  assert.equal(flow.ev.tokenStatus, 200);
  assert.ok(flow.tokens.access_token && flow.tokens.refresh_token);
  tokA = flow.tokens.access_token;

  // Pairing code is single use: a second authorization with the same code fails.
  await assert.rejects(
    oauthFlow(A.url, { getPairCode: async () => flow.pairCodeUsed, redirectUri: TEST_REDIRECT, clientName: "second" }),
    /approve failed 401/,
  );

  // Refresh token grant.
  const rr = await fetch(flow.asm.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: flow.tokens.refresh_token, client_id: flow.clientId }).toString(),
  });
  assert.equal(rr.status, 200);
  tokA = (await rr.json()).access_token;

  // Without PKCE the authorize request is refused for a public client.
  const noPkce = await fetch(
    `${A.url}/authorize?` + new URLSearchParams({ response_type: "code", client_id: flow.clientId, redirect_uri: TEST_REDIRECT, state: "x" }),
    { redirect: "manual" },
  );
  assert.notEqual(noPkce.status, 200);
});

test("auth code replay fails and revokes the grant", async () => {
  const flow = await oauthFlow(A.url, { getPairCode: pairCode(A.url), redirectUri: TEST_REDIRECT, clientName: "replay", replayCheck: true });
  assert.equal(flow.ev.codeReplayStatus, 400);
  const r = await mcpClient(A.url, flow.tokens.access_token).call("handoff_status", {});
  assert.equal(r.httpStatus, 401, "tokens from a replayed code are revoked");
});

test("5 wrong pairing codes cancel the code", async () => {
  const code = await pairCode(A.url)();
  let last;
  for (let i = 0; i < 5; i++) {
    last = await oauthFlow(A.url, { getPairCode: async () => (code === "00000000" ? "11111111" : "00000000"), redirectUri: TEST_REDIRECT, clientName: `bf${i}` }).catch((e) => e);
    assert.match(String(last), /approve failed 401/);
  }
  await assert.rejects(oauthFlow(A.url, { getPairCode: async () => code, redirectUri: TEST_REDIRECT, clientName: "late" }), /approve failed 401/);
});

test("5.1#4: tools — start/append/finish, seq gap -> missing, duplicate -> no-op, conflict -> rejected, caps", async () => {
  const c = mcpClient(A.url, tokA);
  const init = await c.initialize();
  assert.ok(init.result?.serverInfo, JSON.stringify(init));
  const tl = await c.listTools();
  const names = tl.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["append_turns", "finish_handoff", "handoff_status", "start_handoff", "sync_turns"]);
  const append = tl.result.tools.find((t) => t.name === "append_turns");
  assert.ok(append.description.includes("Copy each turn EXACTLY as it appears in this conversation, word for word"));
  assert.ok(append.description.includes("[TURN NOT AVAILABLE VERBATIM]"));

  const s1 = await c.call("start_handoff", { title: "Synthetic test", project: "Test Project", mode: "verbatim", expected_turns: 6, client_ref: "ref-1" });
  assert.equal(s1.isError, false, JSON.stringify(s1));
  const id = s1.data.handoff_id;
  const s2 = await c.call("start_handoff", { title: "Synthetic test", mode: "verbatim", expected_turns: 6, client_ref: "ref-1" });
  assert.equal(s2.data.handoff_id, id, "client_ref idempotency");
  assert.equal(s2.data.existing, true);

  const rich = (i) =>
    i === 2
      ? 'Here is code:\n```js\nconsole.log("hi\\n")\n```\n| a | b |\n|---|---|\n| é | 😀 |\tend\u2028x'
      : i === 4
        ? "[TURN NOT AVAILABLE VERBATIM]"
        : `turn ${i} text`;
  let r = await c.call("append_turns", { handoff_id: id, seq: 1, turns: turns(1, 2, rich) });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.duplicate, false);
  r = await c.call("append_turns", { handoff_id: id, seq: 1, turns: turns(1, 2, rich) });
  assert.equal(r.data.duplicate, true, "duplicate -> no-op");
  r = await c.call("append_turns", { handoff_id: id, seq: 1, turns: turns(1, 2, (i) => `changed ${i}`) });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, "conflict", "conflict -> rejected");
  r = await c.call("append_turns", { handoff_id: id, seq: 3, turns: turns(5, 6) });
  assert.equal(r.data.ok, true);

  let f = await c.call("finish_handoff", { handoff_id: id, total_chunks: 3, total_turns: 6 });
  assert.equal(f.data.status, "incomplete");
  assert.deepEqual(f.data.missing_chunks, [2]);
  assert.deepEqual(f.data.missing_turns, [3, 4]);
  console.log("  gap response:", JSON.stringify(f.data.missing));

  const st = await c.call("handoff_status", { handoff_id: id });
  assert.equal(st.data.handoff.status, "open");
  assert.equal(st.data.received.chunk_seqs, "1,3");

  // caps
  r = await c.call("append_turns", { handoff_id: id, seq: 2, turns: [{ role: "user", index: 3, text: "x".repeat(24 * 1024 + 1) }] });
  assert.equal(r.data.error, "cap_exceeded", "24 KB cap");
  r = await c.call("append_turns", { handoff_id: id, seq: 2, turns: turns(1, 51) });
  assert.ok(r.isError || r.rpcError, "51 turns rejected");
  r = await c.call("append_turns", { handoff_id: id, seq: 201, turns: turns(3, 3) });
  assert.ok(r.isError || r.rpcError, "seq 201 rejected");
  r = await c.call("append_turns", { handoff_id: id, seq: 2, turns: [{ role: "grok", index: 3, text: "x" }] });
  assert.ok(r.isError || r.rpcError, "old role label 'grok' rejected (roles are user/assistant)");

  r = await c.call("append_turns", { handoff_id: id, seq: 2, turns: turns(3, 4, rich) });
  assert.equal(r.data.ok, true);
  f = await c.call("finish_handoff", { handoff_id: id, total_chunks: 3, total_turns: 6 });
  assert.equal(f.data.status, "queued", "no webhook secrets -> queued, not an error");
  assert.equal(f.isError, false);
  assert.equal(f.data.turns_not_available, 1);
  const again = await c.call("finish_handoff", { handoff_id: id, total_chunks: 3, total_turns: 6 });
  assert.equal(again.data.already_sealed, true);
  r = await c.call("append_turns", { handoff_id: id, seq: 4, turns: turns(7, 7) });
  assert.equal(r.data.error, "sealed");

  // Overlapping turn indices across chunks are reported.
  const s3 = await c.call("start_handoff", { title: "Overlap", mode: "verbatim", expected_turns: 3 });
  const id3 = s3.data.handoff_id;
  await c.call("append_turns", { handoff_id: id3, seq: 1, turns: turns(1, 2) });
  await c.call("append_turns", { handoff_id: id3, seq: 2, turns: turns(2, 3) });
  f = await c.call("finish_handoff", { handoff_id: id3, total_chunks: 2, total_turns: 3 });
  assert.equal(f.data.status, "incomplete");
  assert.deepEqual(f.data.duplicate_turn_indices, [2]);

  const list = await c.call("handoff_status", {});
  assert.ok(list.data.handoffs.length >= 2);
  assert.ok(!JSON.stringify(list.data).includes("turn 1 text"), "status never returns content");

  // Bot-side API: list pending, fetch, verify hashes, ack.
  const pend = await (await api(A.url, "/api/handoffs?status=pending")).json();
  assert.ok(pend.handoffs.some((h) => h.handoff_id === id));
  const full = await (await api(A.url, `/api/handoffs/${id}`)).json();
  const chunkHashes = full.chunks.map((ch) => sha256Hex(JSON.stringify(ch.turns)));
  assert.deepEqual(chunkHashes, full.chunks.map((ch) => ch.sha256));
  assert.equal(sha256Hex(chunkHashes.join("\n")), full.handoff.sha256);
  assert.equal(full.chunks[0].turns[1].text, rich(2), "verbatim round trip");
  const ack = await api(A.url, `/api/handoffs/${id}/ack`, { method: "POST", body: JSON.stringify({ verdict: "medium" }) });
  assert.equal(ack.status, 200);
  const gone = await api(A.url, `/api/handoffs/${id}`);
  assert.equal(gone.status, 410);
  const filed = await c.call("handoff_status", { handoff_id: id });
  assert.equal(filed.data.handoff.status, "filed");
  assert.equal(filed.data.handoff.verdict, "medium");
});

test("pre-registered client + revoke-all invalidates tokens", async () => {
  const bad = await api(A.url, "/api/admin/clients", { method: "POST", body: JSON.stringify({ client_name: "x", redirect_uris: ["https://evil.example/cb"] }) });
  assert.equal(bad.status, 400);
  const created = await (
    await api(A.url, "/api/admin/clients", {
      method: "POST",
      body: JSON.stringify({ client_name: "pre-registered", redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"] }),
    })
  ).json();
  assert.ok(created.client_id);
  const flow = await oauthFlow(A.url, {
    getPairCode: pairCode(A.url),
    client: created,
    redirectUri: "https://grok.com/connectors-oauth-exchange-code/",
  });
  assert.equal(flow.ev.tokenStatus, 200);
  assert.equal(flow.ev.redirectLocationHost, "grok.com"); // never followed by the test
  const c = mcpClient(A.url, flow.tokens.access_token);
  assert.equal((await c.call("handoff_status", {})).isError, false);

  const rv = await (await api(A.url, "/api/admin/revoke-all", { method: "POST" })).json();
  assert.ok(rv.clients_deleted >= 2);
  const after = await c.call("handoff_status", {});
  assert.equal(after.httpStatus, 401, "token dead after revoke-all");
  const afterA = await mcpClient(A.url, tokA).call("handoff_status", {});
  assert.equal(afterA.httpStatus, 401);
  const clients = await (await api(A.url, "/api/admin/clients")).json();
  assert.equal(clients.clients.length, 0);
});

test("webhook: delivered with Bearer + X-Automation-Key and small JSON; daily cap", async () => {
  const flow = await oauthFlow(B.url, { getPairCode: pairCode(B.url), redirectUri: TEST_REDIRECT });
  const c = mcpClient(B.url, flow.tokens.access_token);
  const s = await c.call("start_handoff", { title: "Webhook test", mode: "verbatim", expected_turns: 2 });
  const id = s.data.handoff_id;
  await c.call("append_turns", { handoff_id: id, seq: 1, turns: turns(1, 2) });
  const f = await c.call("finish_handoff", { handoff_id: id, total_chunks: 1, total_turns: 2 });
  assert.equal(f.data.status, "delivered", JSON.stringify(f));
  const hookB = received.filter((x) => x.path === "/hook");
  assert.equal(hookB.length, 1);
  const w = hookB[0];
  assert.equal(w.headers.authorization, "Bearer test-webhook-key");
  assert.equal(w.headers["x-automation-key"], "test-webhook-key");
  assert.deepEqual(Object.keys(w.body).sort(), ["bytes", "chunks", "created_at", "event", "handoff_id", "kind", "mode", "project", "sha256", "source", "title", "turns"].sort());
  assert.equal(w.body.kind, "handoff");
  assert.equal(w.body.source, "other", "test client redirects to a non-grok/claude host");
  assert.equal(w.body.event, "handoff_ready");
  assert.equal(w.body.handoff_id, id);
  assert.ok(!JSON.stringify(w.body).includes("turn 1 text"), "webhook carries no content");
  // probe goes through the same webhook path
  const pr = await (await api(B.url, "/api/admin/probe-webhook", { method: "POST" })).json();
  assert.equal(pr.webhook.ok, true);
  assert.deepEqual(received.at(-1).body, { event: "probe" });
  assert.equal(received.at(-1).headers["x-automation-key"], "test-webhook-key");
  // cap = 2 per day on instance B
  const s2 = await c.call("start_handoff", { title: "2", mode: "verbatim", expected_turns: 1 });
  assert.equal(s2.isError, false);
  const s3 = await c.call("start_handoff", { title: "3", mode: "verbatim", expected_turns: 1 });
  assert.equal(s3.data.error, "daily_cap_reached");
});

test("logs carry no content, tokens, or pairing codes", async () => {
  const all = A.logs.join("\n") + B.logs.join("\n");
  assert.ok(all.length > 0);
  assert.ok(!all.includes("turn 1 text"));
  assert.ok(!all.includes(PULL));
  assert.ok(!/"code":"\d{8}"/.test(all));
});
