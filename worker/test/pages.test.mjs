// Customer-facing HTML pages: accessible markup and docs that match the real button labels (TR-A11Y-1, TR-DOC-2).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/index.ts"), "utf8");
const installPath = path.resolve(import.meta.dirname, "../../INSTALL.md");

test("every HTML page declares its language", () => {
  const docs = src.match(/<!doctype html><html[^>]*>/g) ?? [];
  assert.ok(docs.length >= 2, "expected the consent and brand page shells");
  for (const d of docs) assert.match(d, /lang="en"/, d);
});

test("pairing-code errors are announced and tied to the input", () => {
  assert.match(src, /<p id="code-err" class="err" role="alert">/);
  assert.match(src, /aria-invalid="true" aria-describedby="code-err"/);
});

test("error pages say what to do next", () => {
  assert.doesNotMatch(src, /<p>Redirect address not allowed\.<\/p>/);
  assert.doesNotMatch(src, /<p>Wait a minute\.<\/p>/);
  const m = /const NOT_ALLOWED = `([\s\S]*?)`;/.exec(src);
  assert.ok(m, "NOT_ALLOWED page");
  assert.match(m[1], /nothing was shared/);
  assert.match(m[1], /close this page/);
});

test("INSTALL.md names the Connect page button exactly", { skip: !fs.existsSync(installPath) && "docs not present" }, () => {
  const label = /<form method="post" action="\/connect">[\s\S]*?<button>([^<]+)<\/button>/.exec(src)[1];
  const install = fs.readFileSync(installPath, "utf8");
  assert.ok(install.includes(`click **${label}**`), `INSTALL.md should say click **${label}**`);
});

test("TR-COPY-2: the sign-in error page is plain words, says nothing was shared and what to do", () => {
  assert.doesNotMatch(src, /<h1>Authorization error<\/h1>/);
  const m = /return page\("Sign-in didn't start", `([\s\S]*?)`, 400\)/.exec(src);
  assert.ok(m, "plain-words sign-in error page");
  assert.match(m[1], /Nothing was shared/);
  assert.match(m[1], /add the connector again/);
  assert.match(m[1], /Details for support/);
});

test("TR-COPY-4: the rate-limit page does not ask for a code it has no field for", () => {
  const m = /return page\("Slow down", "([\s\S]*?)", 429\)/.exec(src);
  assert.ok(m, "rate-limit page");
  assert.doesNotMatch(m[1], /on this page/);
  assert.doesNotMatch(m[1], /<input/);
  assert.match(m[1], /start the connection again/);
  assert.match(m[1], /Nothing was shared/);
});
