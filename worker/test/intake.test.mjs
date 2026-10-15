// intake.py argument handling, against a recording HTTP server (no Worker needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const INTAKE = process.env.INTAKE_PY || path.resolve(import.meta.dirname, "../../bot/intake.py");

test("TR-BUG-34: drain --id '' is refused as invalid_handoff_id and never drains everything pending", async () => {
  const seen = [];
  const srv = http.createServer((q, s) => {
    seen.push(`${q.method} ${q.url}`);
    s.setHeader("content-type", "application/json");
    s.end(q.url.startsWith("/api/handoffs?") ? JSON.stringify({ handoffs: [{ handoff_id: "habcdef123456", created_at: "2026-01-01T00:00:00Z" }] }) : JSON.stringify({ alert: null }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-args-"));
  fs.copyFileSync(INTAKE, path.join(dir, "intake.py"));
  fs.writeFileSync(path.join(dir, "pull_token"), "t".repeat(40), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ worker_url: `http://127.0.0.1:${srv.address().port}`, timezone: "UTC", handoffs_root: path.join(dir, "out") }));
  try {
    const r = await new Promise((resolve) => {
      const ch = spawn("python3", [path.join(dir, "intake.py"), "drain", "--id", "", "--delivery", "d-1"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      ch.stdout.on("data", (d) => (out += d));
      ch.on("close", (status) => resolve({ status, out }));
    });
    const res = JSON.parse(r.out.trim().split("\n").at(-1));
    assert.notEqual(r.status, 0);
    assert.equal(res.processed, 1);
    assert.equal(res.results[0].error, "invalid_handoff_id");
    assert.deepEqual(seen, [], "no request reached the Worker (no listing, no alert check)");
  } finally {
    srv.close();
  }
});
