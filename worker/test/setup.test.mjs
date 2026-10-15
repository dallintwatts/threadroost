// Tests for setup.sh and scripts/setup-lib.mjs. Fully local: a fake wrangler (test/fixtures/fake-wrangler.mjs)
// and a fake Worker (test/fixtures/fake-courier.mjs). Nothing here talks to Cloudflare.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setName, setKvId, parseJsonc, deployUrl } from "../scripts/setup-lib.mjs";
import { startFakeCourier } from "./fixtures/fake-courier.mjs";

const WORKER = path.resolve(import.meta.dirname, "..");
const TEMPLATE_CFG = fs.readFileSync(path.join(WORKER, "wrangler.jsonc"), "utf8");
const KEY = "wh-key-SHOULD-NEVER-APPEAR-9f8e7d";
const HOOK = "https://hooks.example.test/routine/abc";
let courier;
let PORT = 18990;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courier-setup-"));
  const w = path.join(root, "worker");
  const cf = path.join(root, "cf");
  fs.mkdirSync(path.join(w, "scripts"), { recursive: true });
  fs.mkdirSync(cf);
  for (const f of ["setup.sh", "wrangler.jsonc", "package.json", "package-lock.json", "scripts/setup-lib.mjs"])
    fs.copyFileSync(path.join(WORKER, f), path.join(w, f));
  fs.symlinkSync(path.join(WORKER, "node_modules"), path.join(w, "node_modules"));
  const old = new Date("2020-01-01");
  fs.utimesSync(path.join(w, "package-lock.json"), old, old); // so setup.sh does not re-run npm ci
  return { root, w, cf };
}

// Async on purpose: the fake Worker runs in this process, so a blocking spawnSync would deadlock it.
function run(sb, args = [], input = "", env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [path.join(sb.w, "setup.sh"), ...args], {
      cwd: sb.w,
      env: {
        ...process.env,
        WRANGLER: `node ${path.join(WORKER, "test/fixtures/fake-wrangler.mjs")}`,
        FAKE_CF_DIR: sb.cf,
        COURIER_TEST_BASE_URL: courier.url,
        CLOUDFLARE_ACCOUNT_ID: "",
        CLOUDFLARE_API_TOKEN: "",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("setup.sh timed out:\n" + out));
    }, 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.end(input);
  });
}
const j = (sb, f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(sb.cf, f), "utf8"));
  } catch {
    return d;
  }
};
const calls = (sb) => fs.readFileSync(path.join(sb.cf, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const count = (sb, pred) => calls(sb).filter(pred).length;

before(async () => {
  courier = await startFakeCourier(fs.mkdtempSync(path.join(os.tmpdir(), "courier-unused-")), PORT);
});
after(async () => courier?.close());

// The fake Worker reads secrets from the sandbox's fake Cloudflare dir; restart it per sandbox.
async function bind(sb) {
  await courier.close();
  courier = await startFakeCourier(sb.cf, ++PORT);
}

test("config edits preserve comments and verify", () => {
  const a = setName(TEMPLATE_CFG, "threadroost-ab12cd");
  assert.equal(parseJsonc(a).name, "threadroost-ab12cd");
  assert.ok(a.includes("// The Worker name becomes part of your URL"), "comments kept");
  const b = setKvId(a, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(parseJsonc(b).kv_namespaces, [{ binding: "OAUTH_KV", id: "0123456789abcdef0123456789abcdef" }]);
  const c = setKvId(b, "fedcba9876543210fedcba9876543210");
  assert.equal(parseJsonc(c).kv_namespaces[0].id, "fedcba9876543210fedcba9876543210", "replaces an existing id");
  assert.equal(parseJsonc(c).vars.ALLOWED_REDIRECT_URIS, "https://claude.ai/api/mcp/auth_callback", "other values untouched");
  assert.equal(c.split("\n").length, TEMPLATE_CFG.split("\n").length, "no reformatting");
});

test("template config is generic", () => {
  const cfg = parseJsonc(TEMPLATE_CFG);
  assert.equal(cfg.name, "threadroost");
  assert.equal(cfg.kv_namespaces[0].id, undefined, "no KV id in the template");
  assert.deepEqual(cfg.triggers.crons, ["*/10 * * * *"]);
});

test("deployUrl picks the custom domain, else workers.dev, never schedules or zone routes", () => {
  const nd = (targets) => [JSON.stringify({ type: "wrangler-session" }), JSON.stringify({ type: "deploy", targets })].join("\n");
  assert.equal(deployUrl(nd(["https://x.sub.workers.dev", "schedule: */10 * * * *"])), "https://x.sub.workers.dev");
  assert.equal(deployUrl(nd(["https://x.sub.workers.dev", "mcp.example.com (custom domain)"])), "https://mcp.example.com");
  assert.equal(deployUrl(nd(["example.com/c/* (zone name: example.com)", "schedule: */10 * * * *"])), "");
  assert.equal(deployUrl(""), "");
});

test("first run: login, name, KV, deploy, secrets, checks, pairing; nothing secret printed", async () => {
  const sb = sandbox();
  await bind(sb);
  // answers: name (default), webhook URL, webhook key; then EOF -> defaults (no clipboard, bot claims its own token)
  const r = await run(sb, [], `\n${HOOK}\n${KEY}\n`);
  assert.equal(r.code, 0, r.out);
  const cfg = parseJsonc(fs.readFileSync(path.join(sb.w, "wrangler.jsonc"), "utf8"));
  assert.match(cfg.name, /^threadroost-[a-z0-9]{6}$/);
  assert.match(cfg.kv_namespaces[0].id, /^[0-9a-f]{32}$/);
  assert.equal(j(sb, "kv.json")[0].title, `${cfg.name}-oauth-kv`);
  const secrets = j(sb, "secrets.json", {});
  assert.deepEqual(Object.keys(secrets).sort(), ["COURIER_PULL_TOKEN", "GROKBOT_WEBHOOK_KEY", "GROKBOT_WEBHOOK_URL"]);
  assert.equal(secrets.GROKBOT_WEBHOOK_KEY, KEY);
  assert.equal(secrets.GROKBOT_WEBHOOK_URL, HOOK);
  const tokenFile = path.join(sb.w, ".courier/pull_token");
  const token = fs.readFileSync(tokenFile, "utf8");
  assert.equal(secrets.COURIER_PULL_TOKEN, token);
  assert.ok(token.length >= 32);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(sb.w, ".courier")).mode & 0o777, 0o700);
  assert.ok(r.out.includes(`https://${cfg.name}.example-sub.workers.dev/mcp`), "prints the /mcp URL");
  assert.ok(r.out.includes("Connect link") && !r.out.includes("Pairing code"), r.out); // v1.2: pairing moved to the Connect page
  assert.ok(r.out.includes("Webhook probe delivered"), r.out);
  assert.ok(!r.out.includes(KEY) && !r.out.includes(token), "no secret in output");
  const log = fs.readFileSync(path.join(sb.cf, "calls.log"), "utf8");
  assert.ok(!log.includes(KEY) && !log.includes(token), "no secret in any wrangler argv");
  assert.equal(count(sb, (c) => c.argv[0] === "login"), 1);
  assert.equal(count(sb, (c) => c.argv.join(" ").startsWith("kv namespace create")), 1);
  assert.equal(j(sb, "deploys.json"), 1);
  assert.ok(calls(sb).filter((c) => c.argv[0] === "deploy").every((c) => c.account === "acc1".padEnd(32, "0")), "account pinned");
  const state = JSON.parse(fs.readFileSync(path.join(sb.w, ".courier/state.json"), "utf8"));
  assert.equal(state.worker_url, `https://${cfg.name}.example-sub.workers.dev`);
  assert.ok(!JSON.stringify(state).includes(token));

  // ---- re-run with no input: everything detected, nothing re-created or re-set
  const before = fs.readFileSync(path.join(sb.w, "wrangler.jsonc"), "utf8");
  const puts = j(sb, "puts.json").length;
  const r2 = await run(sb, [], "");
  assert.equal(r2.code, 0, r2.out);
  assert.equal(fs.readFileSync(path.join(sb.w, "wrangler.jsonc"), "utf8"), before, "config unchanged on re-run");
  assert.equal(count(sb, (c) => c.argv[0] === "login"), 1, "no second login");
  assert.equal(count(sb, (c) => c.argv.join(" ").startsWith("kv namespace create")), 1, "no second KV");
  assert.equal(j(sb, "puts.json").length, puts, "no secret re-set");
  assert.equal(fs.readFileSync(tokenFile, "utf8"), token, "token kept");
  assert.ok(r2.out.includes("matches"), r2.out);
  assert.ok(r2.out.includes("Keeping the existing webhook"), r2.out);

  // ---- --no-deploy re-run skips deploy
  const r3 = await run(sb, ["--no-deploy", "--skip-webhook"], "");
  assert.equal(r3.code, 0, r3.out);
  assert.equal(j(sb, "deploys.json"), 2);

  // ---- --pair
  const rp = await run(sb, ["--pair"], "");
  assert.equal(rp.code, 0, rp.out);
  assert.ok(rp.out.includes("Pairing code: 12345678"));

  // ---- --pair from another machine/dir: explicit --url and --token-file, no saved state
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "courier-pair-"));
  fs.mkdirSync(path.join(other, "scripts"));
  fs.copyFileSync(path.join(WORKER, "setup.sh"), path.join(other, "setup.sh"));
  fs.copyFileSync(path.join(WORKER, "scripts/setup-lib.mjs"), path.join(other, "scripts/setup-lib.mjs"));
  const rp2 = await run({ w: other, cf: sb.cf }, ["--pair", "--url", "https://whatever.example/mcp", "--token-file", tokenFile], "");
  assert.equal(rp2.code, 0, rp2.out);
  assert.ok(rp2.out.includes("Pairing code: 12345678"));

  // ---- lost local token: default is NOT to rotate
  fs.rmSync(tokenFile);
  const r4 = await run(sb, ["--no-deploy"], "");
  assert.equal(r4.code, 0, r4.out);
  assert.equal(j(sb, "secrets.json").COURIER_PULL_TOKEN, token, "remote token untouched");
  assert.ok(r4.out.includes("no local copy"), r4.out);

  // ---- explicit rotation
  const r5 = await run(sb, ["--no-deploy", "--rotate-token"], "");
  assert.equal(r5.code, 0, r5.out);
  const t2 = fs.readFileSync(tokenFile, "utf8");
  assert.notEqual(t2, token);
  assert.equal(j(sb, "secrets.json").COURIER_PULL_TOKEN, t2);

  // ---- local token differs from the Worker's: confirm replaces (default yes)
  fs.writeFileSync(tokenFile, "x".repeat(40), { mode: 0o600 });
  const r6 = await run(sb, ["--no-deploy", "--skip-webhook"], "\n");
  assert.equal(r6.code, 0, r6.out);
  assert.equal(j(sb, "secrets.json").COURIER_PULL_TOKEN, "x".repeat(40));
});

test("--bot-dir writes intake config; multi-account asks once and remembers", async () => {
  const sb = sandbox();
  await bind(sb);
  const bot = path.join(sb.root, "bot", "courier");
  const r = await run(sb, ["--bot-dir", bot, "--name", "courier-test-1", "--skip-webhook"], "2\n", { FAKE_ACCOUNTS: "2" });
  assert.equal(r.code, 0, r.out);
  assert.equal(parseJsonc(fs.readFileSync(path.join(sb.w, "wrangler.jsonc"), "utf8")).name, "courier-test-1");
  assert.ok(calls(sb).filter((c) => c.argv[0] === "deploy").every((c) => c.account === "acc2".padEnd(32, "0")));
  const tok = fs.readFileSync(path.join(bot, "pull_token"), "utf8");
  assert.equal(fs.statSync(path.join(bot, "pull_token")).mode & 0o777, 0o600);
  assert.equal(j(sb, "secrets.json").COURIER_PULL_TOKEN, tok);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bot, "config.json"), "utf8")), { worker_url: "https://courier-test-1.example-sub.workers.dev" });
  assert.ok(!fs.existsSync(path.join(sb.w, ".courier/pull_token")), "token lives only in the bot dir");
  // re-run without input: account remembered (no prompt needed), still exit 0
  const r2 = await run(sb, ["--bot-dir", bot, "--skip-webhook"], "", { FAKE_ACCOUNTS: "2" });
  assert.equal(r2.code, 0, r2.out);
  assert.ok(calls(sb).filter((c) => c.argv[0] === "deploy").every((c) => c.account === "acc2".padEnd(32, "0")));
});

test("refuses a KV id from another account; reuses an existing namespace by title", async () => {
  const sb = sandbox();
  await bind(sb);
  fs.writeFileSync(path.join(sb.cf, "logged_in"), "1");
  fs.writeFileSync(path.join(sb.w, "wrangler.jsonc"), setKvId(setName(TEMPLATE_CFG, "courier-x"), "ab".repeat(16)));
  const r = await run(sb, ["--skip-webhook"], "");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not have/);
  // existing namespace with the conventional title (e.g. made by the Deploy button) is reused
  fs.writeFileSync(path.join(sb.w, "wrangler.jsonc"), setName(TEMPLATE_CFG, "courier-x"));
  fs.writeFileSync(path.join(sb.cf, "kv.json"), JSON.stringify([{ id: "cd".repeat(16), title: "courier-x-oauth-kv" }]));
  const r2 = await run(sb, ["--skip-webhook"], "");
  assert.equal(r2.code, 0, r2.out);
  assert.equal(parseJsonc(fs.readFileSync(path.join(sb.w, "wrangler.jsonc"), "utf8")).kv_namespaces[0].id, "cd".repeat(16));
  assert.equal(count(sb, (c) => c.argv.join(" ").startsWith("kv namespace create")), 0);
});

test("non-interactive --yes with webhook from env + key file", async () => {
  const sb = sandbox();
  await bind(sb);
  fs.writeFileSync(path.join(sb.cf, "logged_in"), "1");
  const keyFile = path.join(sb.root, "key");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  const r = await run(sb, ["--yes"], "", { GROKBOT_WEBHOOK_URL: HOOK, GROKBOT_WEBHOOK_KEY_FILE: keyFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(j(sb, "secrets.json").GROKBOT_WEBHOOK_KEY, KEY);
  assert.ok(!r.out.includes(KEY));
  assert.ok(!r.out.includes("Pairing code"), "--yes does not mint codes");
});

test("rejects a non-https webhook URL without storing anything", async () => {
  const sb = sandbox();
  await bind(sb);
  fs.writeFileSync(path.join(sb.cf, "logged_in"), "1");
  const r = await run(sb, ["--name", "courier-y"], `http://insecure.example/hook\n${KEY}\n`);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /must start with https/);
  assert.equal(j(sb, "secrets.json").GROKBOT_WEBHOOK_KEY, undefined);
  assert.ok(!r.out.includes(KEY));
});

test("TR-BUG-17: a fresh install marks courier:boot before storing its token, so the bot still gets a claim link", async () => {
  const sb = sandbox();
  await bind(sb);
  const r = await run(sb, [], `\n${HOOK}\n${KEY}\n`);
  assert.equal(r.code, 0, r.out);
  assert.equal(j(sb, "kvdata.json", {})["courier:boot"], '{"setup":"fresh"}');
  const cl = calls(sb).map((c) => (Array.isArray(c) ? c : c.argv || []).join(" "));
  const iBoot = cl.findIndex((c) => c.includes("kv key put") && c.includes("courier:boot"));
  const iTok = cl.findIndex((c) => c.includes("secret put COURIER_PULL_TOKEN"));
  assert.ok(iBoot >= 0 && iTok > iBoot, `boot mark (${iBoot}) before token (${iTok})`);
  // a re-run with the token already set does not reset the claim state
  const n = cl.length;
  const r2 = await run(sb, ["--no-deploy"], "");
  assert.equal(r2.code, 0, r2.out);
  const after = calls(sb).slice(n).map((c) => (Array.isArray(c) ? c : c.argv || []).join(" "));
  assert.ok(!after.some((c) => c.includes("courier:boot")), "re-run leaves courier:boot alone");
});
