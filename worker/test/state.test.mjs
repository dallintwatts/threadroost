// TR-STATE-1: no module-level mutable state that could carry data between requests, owners or sessions in one isolate.
// Only two in-memory maps are allowed: the rate-limit counters ("scope:IP" -> count) and per-stream in-flight locks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8");
const ALLOWED = new Set(["buckets", "threadLocks"]);

test("TR-STATE-1: only the allow-listed module-level mutable values exist", () => {
  const found = [];
  for (const line of src.split("\n")) {
    const m = line.match(/^(?:export\s+)?(let|var|const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/);
    if (!m) continue;
    const [, kind, name, rhs] = m;
    if (kind !== "const") found.push(`${kind} ${name}`);
    else if (/^new (Map|Set|WeakMap|WeakSet|Array)\b|^\[\s*\]|^\[\s*$/.test(rhs) && !ALLOWED.has(name)) found.push(name);
  }
  assert.deepEqual(found, [], `module-level mutable state found: ${found.join(", ")}`);
  for (const gone of ["clientSources", "providers"]) assert.ok(!new RegExp(`\\b${gone}\\b`).test(src), `${gone} cache must stay removed`);
});

test("TR-STATE-1: the OAuth provider is built per request and the rate limiter never wipes every limit at once", () => {
  assert.doesNotMatch(src, /providers\.(get|set)\(/);
  assert.match(src, /function providerFor\(origin: string, env: Env\): OAuthProvider<Env> \{\n(?:\s*\/\/.*\n)*\s*const p = new OAuthProvider/);
  assert.doesNotMatch(src, /buckets\.clear\(\)/);
});

test("TR-CI-6: worker/node_modules is never a committed symlink (it pointed a fresh clone's npm ci at another folder)", () => {
  const nm = path.join(import.meta.dirname, "../node_modules");
  assert.ok(!(fs.existsSync(nm) || fs.lstatSync(nm, { throwIfNoEntry: false })) || !fs.lstatSync(nm).isSymbolicLink(), "node_modules must be a real folder or absent");
  const gi = fs.readFileSync(path.join(import.meta.dirname, "../.gitignore"), "utf8");
  assert.match(gi, /^node_modules$/m, ".gitignore must ignore node_modules as a file or a folder");
});
