// TR-CAP-1: docs/CAPABILITIES.md must list every capability the code has. The test pulls a fingerprint
// (HTTP routes, MCP tools, outbound fetch calls, storage bindings, secrets, intake API calls and imports)
// out of the source and compares it with the JSON block in the doc. A new route, tool, network call or
// import fails CI until the matrix is updated in the same pull request.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const docPath = path.join(root, "docs/CAPABILITIES.md");
const have = fs.existsSync(docPath) && fs.existsSync(path.join(root, "bot/intake.py"));
const all = (re, s, g = 1) => [...s.matchAll(re)].map((m) => m[g]);
const uniq = (a) => [...new Set(a)].sort();

export function fingerprint(ts, py, wrangler) {
  const env = /export interface Env \{([\s\S]*?)\n\}/.exec(ts)[1];
  return {
    worker_routes: uniq([
      ...all(/url\.pathname(?: === |\.startsWith\()"([^"]+)"/g, ts),
      ...all(/\bp === "([^"]+)"/g, ts),
      ...all(/\b(?:apiRoute|[a-zA-Z]+Endpoint): "(\/[^"]*)"/g, ts), // OAuthProvider routes (TR-CAP-1, Bugbot PR #6)
      ...all(/"(\/\.well-known\/[^"]+)"/g, ts), // discovery URLs and their aliases
      ...all(/\bp\.match\(\/\^(.+?)\$\/\)/g, ts).map((r) => r.replace(/\\\//g, "/")),
    ]),
    worker_mcp_tools: uniq(all(/registerTool\(\s*"([a-z_]+)"/g, ts)),
    worker_outbound_fetch: all(/await fetch\(/g, ts, 0).length,
    worker_env: uniq(all(/^\s+([A-Z_]+)\??:/gm, env)),
    worker_kv_bindings: uniq(all(/"binding":\s*"([A-Z_]+)"/g, wrangler)),
    worker_crons: uniq(all(/"crons":\s*\[([^\]]*)\]/g, wrangler).flatMap((s) => all(/"([^"]+)"/g, s))),
    intake_api_calls: uniq(all(/api\.call\("([A-Z]+)", f?"([^"?]+)/g, py, 0).map((m) => {
      const [, meth, p] = /api\.call\("([A-Z]+)", f?"([^"?]+)/.exec(m);
      return `${meth} ${p.replace(/\{[a-z_]+\}/g, "{id}")}`;
    })),
    intake_imports: uniq(all(/^(?:import|from) ([^\n]+)/gm, py).flatMap((l) => l.split(" import ")[0].split(",").map((x) => x.trim().split(" ")[0]))),
  };
}

test("capability matrix lists exactly what the code can do", { skip: !have && "docs not present" }, () => {
  const ts = fs.readFileSync(path.join(root, "worker/src/index.ts"), "utf8");
  const py = fs.readFileSync(path.join(root, "bot/intake.py"), "utf8");
  const wr = fs.readFileSync(path.join(root, "worker/wrangler.jsonc"), "utf8");
  const doc = fs.readFileSync(docPath, "utf8");
  const block = /```json capabilities\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(block, "docs/CAPABILITIES.md needs a ```json capabilities block");
  const listed = JSON.parse(block[1]);
  const actual = fingerprint(ts, py, wr);
  for (const k of Object.keys(actual)) {
    const a = Array.isArray(actual[k]) ? [...actual[k]].sort() : actual[k];
    const l = Array.isArray(listed[k]) ? [...listed[k]].sort() : listed[k];
    assert.deepEqual(l, a, `${k}: code and docs/CAPABILITIES.md disagree. Update the matrix (and its tables) in the same PR.`);
  }
  assert.deepEqual(Object.keys(listed).sort(), Object.keys(actual).sort(), "matrix has unknown or missing sections");
});

test("fingerprint catches a new capability (regression for TR-CAP-1)", () => {
  const ts = 'export interface Env {\n  A: string;\n}\nif (p === "/api/x") 1\nawait fetch(u)\nregisterTool(\n "t"';
  const base = fingerprint(ts, 'import os\napi.call("GET", "/api/x")', '"binding": "KV"');
  const more = fingerprint(ts + '\nif (p === "/api/new") 1\nawait fetch(v)', 'import os, socket\napi.call("GET", "/api/x")', '"binding": "KV"');
  assert.notDeepEqual(more.worker_routes, base.worker_routes);
  assert.equal(more.worker_outbound_fetch, 2);
  assert.ok(more.intake_imports.includes("socket"));
  const oauth = fingerprint(ts + '\n tokenEndpoint: "/oauth/token",\n "/.well-known/x": "/.well-known/y",', "import os", "");
  for (const r of ["/oauth/token", "/.well-known/x", "/.well-known/y"]) assert.ok(oauth.worker_routes.includes(r), r);
});
