// v1.2 zero-copy setup: auto pull token, bot claim link, Connect page. Security: replay, expiry, brute force, leakage.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startWorker, oauthFlow } from "./helpers.mjs";

const KEY = "hook-key-" + "k".repeat(30);
let hookPort, hookServer;
const hooks = [];
let W, X; // W: normal flow. X: brute force + expiry (short TTL)

function waitHook(pred, ms = 15000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const h = hooks.find(pred);
      if (h) { clearInterval(iv); res(h); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error("no webhook")); }
    }, 100);
  });
}
const claim = (base, code, ip = "1.1.1.1") =>
  fetch(`${base}/claim`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ code }) });

before(async () => {
  hookServer = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      hooks.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(b || "{}") });
      res.end("ok");
    });
  });
  await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
  hookPort = hookServer.address().port;
  const common = { GROKBOT_WEBHOOK_KEY: KEY, ALLOWED_REDIRECT_HOSTS: "grok.com,x.ai,client.test.example" };
  W = await startWorker({ port: 8811, vars: { ...common, GROKBOT_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/w` } });
  X = await startWorker({ port: 8813, vars: { ...common, GROKBOT_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/x`, CLAIM_TTL_SECONDS: "5" } });
});
after(async () => {
  await W?.stop();
  await X?.stop();
  hookServer?.close();
});

let pull, connectUrl, claimCode;
test("first visit sends the bot a claim link over the authenticated webhook only", async () => {
  const h0 = await (await fetch(`${W.url}/health`)).json();
  assert.equal(h0.bot_connected, false);
  const r = await fetch(`${W.url}/`, { headers: { accept: "text/html" } });
  assert.equal(r.status, 200);
  const page = await r.text();
  assert.match(page, /Threadroost is running/);
  const h = await waitHook((x) => x.path === "/w" && x.body.event === "threadroost.claim");
  assert.equal(h.auth, `Bearer ${KEY}`);
  assert.ok(h.body.claim_code.length >= 40);
  assert.ok(!("pull_token" in h.body), "webhook never carries the token itself");
  claimCode = h.body.claim_code;
  // A second visit does not mint a second claim (resend window)
  await fetch(`${W.url}/`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(hooks.filter((x) => x.path === "/w").length, 1);
});

test("no API access before the claim, and a wrong code is refused", async () => {
  assert.equal((await fetch(`${W.url}/api/handoffs`, { headers: { authorization: "Bearer " + "z".repeat(43) } })).status, 401);
  assert.equal((await claim(W.url, "wrong-" + "a".repeat(40))).status, 401);
  assert.equal((await claim(W.url, "")).status, 401);
  assert.equal((await fetch(`${W.url}/claim`)).status, 405);
});

test("claim works once; replay is refused; the token then unlocks the API", async () => {
  const r = await claim(W.url, claimCode);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.pull_token.length >= 40);
  assert.match(j.connect_url, /\/connect\?t=/);
  pull = j.pull_token;
  connectUrl = j.connect_url;
  const again = await claim(W.url, claimCode);
  assert.equal(again.status, 410);
  assert.equal((await again.json()).error, "already_claimed");
  assert.equal((await fetch(`${W.url}/api/handoffs`, { headers: { authorization: `Bearer ${pull}` } })).status, 200);
  assert.equal((await (await fetch(`${W.url}/health`)).json()).bot_connected, true);
});

test("Connect page: GET does not spend the link, POST shows one pairing code once, replay fails", async () => {
  const t = new URL(connectUrl).searchParams.get("t");
  const g1 = await fetch(`${W.url}/connect?t=${t}`);
  const g2 = await fetch(`${W.url}/connect?t=${t}`);
  assert.equal(g1.status, 200);
  assert.equal(g2.status, 200, "link previews can't burn it");
  assert.match(g1.headers.get("content-security-policy"), /script-src 'nonce-/);
  const post = () => fetch(`${W.url}/connect`, { method: "POST", body: new URLSearchParams({ t }) });
  const p1 = await post();
  assert.equal(p1.status, 200);
  const html = await p1.text();
  const code = html.match(/id="code" class="code">(\d{4}) (\d{4})</);
  assert.ok(code, "pairing code shown");
  assert.ok(html.includes(`${W.url}/mcp`) || html.includes("/mcp"));
  assert.ok(!html.includes(pull), "page never shows the pull token");
  assert.equal((await post()).status, 410, "single use");
  assert.equal((await fetch(`${W.url}/connect?t=nope${"x".repeat(30)}`)).status, 410);
  // The shown code really pairs a client
  const flow = await oauthFlow(W.url, { getPairCode: async () => code[1] + code[2], redirectUri: "https://client.test.example/cb" });
  assert.equal(flow.ev.tokenStatus, 200);
});

test("the bot can mint a fresh Connect link with its token, nobody else can", async () => {
  assert.equal((await fetch(`${W.url}/api/connect-link`, { method: "POST" })).status, 401);
  const r = await fetch(`${W.url}/api/connect-link`, { method: "POST", headers: { authorization: `Bearer ${pull}` } });
  assert.equal(r.status, 200);
  assert.match((await r.json()).connect_url, /\/connect\?t=[\w-]{30,}/);
});

test("brute force burns the claim after 5 wrong codes, and the rate limit trips", async () => {
  await fetch(`${X.url}/`);
  const h = await waitHook((x) => x.path === "/x");
  for (let i = 0; i < 5; i++) assert.equal((await claim(X.url, "guess-" + i + "b".repeat(40), "2.2.2.2")).status, 401);
  const r = await claim(X.url, h.body.claim_code, "2.2.2.2");
  assert.equal(r.status, 410, "the right code no longer works");
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await claim(X.url, "x".repeat(40), "3.3.3.3")).status);
  assert.ok(statuses.includes(429), "rate limited: " + statuses);
});

test("expired claim codes are refused", async () => {
  // X uses a 5 s claim TTL. Its first code was burned. Force a resend window? Use a fresh worker state instead:
  const Y = await startWorker({ port: 8815, vars: { GROKBOT_WEBHOOK_KEY: KEY, GROKBOT_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/y`, CLAIM_TTL_SECONDS: "5" } });
  try {
    await fetch(`${Y.url}/`);
    const h = await waitHook((x) => x.path === "/y");
    await new Promise((r) => setTimeout(r, 6000));
    const r = await claim(Y.url, h.body.claim_code, "4.4.4.4");
    assert.equal(r.status, 410);
    assert.equal((await r.json()).error, "claim_expired");
  } finally {
    await Y.stop();
  }
});

test("no secret ever reaches the logs", async () => {
  const all = [...W.logs, ...X.logs].join("\n");
  assert.ok(!all.includes(pull));
  assert.ok(!all.includes(claimCode));
  assert.ok(!all.includes(new URL(connectUrl).searchParams.get("t")));
  assert.ok(W.logs.some((l) => l.includes('"evt":"claim"') && l.includes('"outcome":"ok"')));
});
