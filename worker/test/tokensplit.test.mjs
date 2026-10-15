// TR-SEC-3: with COURIER_ADMIN_TOKEN set, the pull token can only list, read and ack handoffs and read the alert.
// Every admin route and pair/connect-link minting answers 403 to it, while the admin token keeps full access.
// The intake still works end to end with only the pull token, and an unknown token gets 401.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startWorker, oauthFlow, mcpClient } from "./helpers.mjs";

const PULL = crypto.randomBytes(32).toString("base64url");
const ADMIN = crypto.randomBytes(32).toString("base64url");
const OLD = crypto.randomBytes(32).toString("base64url");
const call = (base, tok, p, method = "GET", body) =>
  fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

const ADMIN_ROUTES = [
  ["POST", "/api/pair"],
  ["POST", "/api/connect-link"],
  ["GET", "/api/admin/clients"],
  ["POST", "/api/admin/clients", { client_name: "x", redirect_uris: ["https://client.test.example/cb"] }],
  ["DELETE", "/api/admin/clients/some-client"],
  ["POST", "/api/admin/revoke-all"],
  ["POST", "/api/admin/probe-webhook"],
  ["GET", "/api/admin/dcr-log"],
];

test("TR-SEC-3: pull token refused on admin routes and pair codes, admin token allowed, intake works with the pull token", async () => {
  const W = await startWorker({ port: 8841, vars: { COURIER_PULL_TOKEN: PULL, COURIER_ADMIN_TOKEN: ADMIN, ALLOWED_REDIRECT_HOSTS: "client.test.example" } });
  try {
    assert.equal((await (await fetch(`${W.url}/health`)).json()).admin_token_split, true);
    for (const [m, p, b] of ADMIN_ROUTES) {
      const r = await call(W.url, PULL, p, m, b);
      assert.equal(r.status, 403, `pull token must get 403 on ${m} ${p}`);
      assert.equal((await r.json()).error, "admin_token_required");
    }
    for (const [m, p] of [["GET", "/api/handoffs"], ["POST", "/api/pair"], ["GET", "/api/admin/clients"]]) {
      assert.equal((await call(W.url, OLD, p, m)).status, 401, `unknown/old token must get 401 on ${m} ${p}`);
      assert.equal((await fetch(`${W.url}${p}`, { method: m })).status, 401);
    }
    assert.equal((await call(W.url, ADMIN, "/api/admin/clients")).status, 200);
    assert.equal((await call(W.url, ADMIN, "/api/admin/dcr-log")).status, 200);
    assert.equal((await call(W.url, ADMIN, "/api/handoffs")).status, 200);
    assert.equal((await call(W.url, PULL, "/api/admin/alert")).status, 200, "intake reads the alert with the pull token");

    // End to end: admin mints the pair code, the AI app sends a chat, the intake files it with only the pull token.
    const pair = await (await call(W.url, ADMIN, "/api/pair", "POST")).json();
    const flow = await oauthFlow(W.url, { getPairCode: async () => pair.code, redirectUri: "https://client.test.example/cb" });
    const c = mcpClient(W.url, flow.tokens.access_token);
    await c.initialize();
    const turns = [
      { role: "user", index: 1, text: "Token split test  \n```js\nconst a = 1;\n```\n" },
      { role: "assistant", index: 2, text: "ok \u{1F44B} caf\u00e9" },
    ];
    const s = await c.call("start_handoff", { title: "TR-SEC-3 split test", mode: "verbatim", expected_turns: 2 });
    const id = s.data.handoff_id;
    await c.call("append_turns", { handoff_id: id, seq: 1, turns });
    const f = await c.call("finish_handoff", { handoff_id: id, total_chunks: 1, total_turns: 2 });
    assert.ok(!f.isError, JSON.stringify(f.data));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-intake-"));
    const root = path.join(dir, "out");
    fs.copyFileSync(path.resolve(import.meta.dirname, "../../bot/intake.py"), path.join(dir, "intake.py"));
    fs.writeFileSync(path.join(dir, "pull_token"), PULL, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ worker_url: W.url, timezone: "UTC", handoffs_root: root }));
    const r = spawnSync("python3", [path.join(dir, "intake.py"), "drain"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const raws = spawnSync("find", [root, "-name", "raw.json"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    assert.equal(raws.length, 1);
    const raw = JSON.parse(fs.readFileSync(raws[0], "utf8"));
    const texts = [];
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { if (typeof o.text === "string" && o.role) texts.push(o.text); Object.values(o).forEach(walk); } };
    walk(raw);
    const got = turns.every((t) => texts.includes(t.text));
    assert.ok(got, "both turns filed word for word");
    const after = await (await call(W.url, PULL, "/api/handoffs?status=all")).json();
    assert.equal(after.handoffs.find((h) => h.handoff_id === id)?.status, "filed", "acked with the pull token");
    // intake.py pair now reports the refusal plainly instead of a code.
    const pr = spawnSync("python3", [path.join(dir, "intake.py"), "pair"], { encoding: "utf8" });
    assert.notEqual(pr.status, 0);
    assert.equal(JSON.parse(pr.stdout.trim()).error, "admin_token_required");
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    await W.stop();
  }
});

test("TR-SEC-3: without an admin token (older installs) the pull token keeps full access", async () => {
  const W = await startWorker({ port: 8843, vars: { COURIER_PULL_TOKEN: PULL } });
  try {
    assert.equal((await (await fetch(`${W.url}/health`)).json()).admin_token_split, false);
    assert.equal((await call(W.url, PULL, "/api/admin/clients")).status, 200);
    assert.equal((await call(W.url, ADMIN, "/api/admin/clients")).status, 401);
  } finally {
    await W.stop();
  }
});
