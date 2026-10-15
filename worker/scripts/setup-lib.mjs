#!/usr/bin/env node
// Helpers for setup.sh (Node 22+, no dependencies). Every subcommand is local or talks only to YOUR Worker.
// Secrets are read from files (never argv) and never printed.
//
//   config-get <wrangler.jsonc> name|kv-id
//   config-set-name <wrangler.jsonc> <name>
//   config-set-kv-id <wrangler.jsonc> <namespace-id>
//   whoami-accounts                          (stdin: `wrangler whoami --json`)  -> "id<TAB>name" lines
//   kv-find <title>                          (stdin: `wrangler kv namespace list`) -> id or empty
//   kv-has-id <id>                           (stdin: `wrangler kv namespace list`) -> exit 0 if present
//   kv-id-from-create                        (stdin: `wrangler kv namespace create` output) -> id
//   secret-names                             (stdin: `wrangler secret list`) -> one name per line
//   deploy-url <wrangler-output.ndjson>      -> custom domain if configured, else the workers.dev URL
//   gen-token <file>                         -> writes a new 0600 token file (refuses to overwrite)
//   check-token-file <file>                  -> exit 0 if file holds a usable token (>= 32 chars)
//   preflight <base-url> [--wait SECONDS]    -> public checks (version, OAuth discovery, 401 on /mcp)
//   api <base-url> <token-file> <METHOD> <path>  -> prints {"status":N,"body":...}
//   bot-config <dir> <worker-url> <token-file>   -> writes <dir>/pull_token (0600) + merges <dir>/config.json
//   state-get <state.json> <key> / state-set <state.json> <key> <value>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [cmd, ...args] = process.argv.slice(2);
const die = (msg, code = 1) => {
  process.stderr.write(`setup-lib: ${msg}\n`);
  process.exit(code);
};
const readStdin = () => {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------- JSONC
/** Remove // and /* *\/ comments and trailing commas, leaving strings untouched. */
export function stripJsonc(src) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  // trailing commas (outside strings: strings were copied verbatim, so re-scan carefully)
  let res = "";
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      res += c;
      if (c === "\\") {
        res += out[++j] ?? "";
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }
    res += c;
  }
  return res;
}
export const parseJsonc = (src) => JSON.parse(stripJsonc(src));

/** Index of a top-level key's value start in the raw JSONC text (depth 1), or -1. */
function findKeyAtDepth(src, key, wantDepth, from = 0, to = src.length) {
  let depth = 0;
  let inStr = false;
  let strStart = -1;
  for (let i = from; i < to; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') {
        inStr = false;
        const s = src.slice(strStart + 1, i);
        if (depth === wantDepth && s === key) {
          let k = i + 1;
          while (k < to && /\s/.test(src[k])) k++;
          if (src[k] === ":") return k + 1;
        }
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < to && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e === -1 ? to : e + 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      strStart = i;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return -1;
}

/** Span [start, end) of a JSON string value beginning at/after pos (skipping whitespace). */
function stringSpanAt(src, pos) {
  let i = pos;
  while (/\s/.test(src[i])) i++;
  if (src[i] !== '"') return null;
  let j = i + 1;
  for (; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === '"') break;
  }
  return [i, j + 1];
}

export function setName(src, name) {
  const at = findKeyAtDepth(src, "name", 1);
  if (at < 0) throw new Error('no top-level "name" in config');
  const span = stringSpanAt(src, at);
  if (!span) throw new Error('"name" is not a string');
  const out = src.slice(0, span[0]) + JSON.stringify(name) + src.slice(span[1]);
  if (parseJsonc(out).name !== name) throw new Error("name edit did not verify");
  return out;
}

export function setKvId(src, id, binding = "OAUTH_KV") {
  const arrAt = findKeyAtDepth(src, "kv_namespaces", 1);
  if (arrAt < 0) throw new Error('no top-level "kv_namespaces" in config');
  // Find the object containing "binding": "<binding>".
  const re = new RegExp(`"binding"\\s*:\\s*"${binding}"`, "g");
  re.lastIndex = arrAt;
  const m = re.exec(src);
  if (!m) throw new Error(`no kv binding ${binding}`);
  const objStart = src.lastIndexOf("{", m.index);
  // matching close brace (objects here are flat)
  let depth = 0;
  let objEnd = -1;
  let inStr = false;
  for (let i = objStart; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      objEnd = i;
      break;
    }
  }
  if (objEnd < 0) throw new Error("unterminated kv binding object");
  const idAt = findKeyAtDepth(src, "id", 0, objStart + 1, objEnd); // depth 0 = directly inside this object
  let out;
  if (idAt >= 0) {
    const span = stringSpanAt(src, idAt);
    if (!span) throw new Error('"id" is not a string');
    out = src.slice(0, span[0]) + JSON.stringify(id) + src.slice(span[1]);
  } else {
    const end = m.index + m[0].length;
    out = src.slice(0, end) + `, "id": ${JSON.stringify(id)}` + src.slice(end);
  }
  const kv = (parseJsonc(out).kv_namespaces || []).find((k) => k.binding === binding);
  if (!kv || kv.id !== id) throw new Error("kv id edit did not verify");
  return out;
}

// ---------------------------------------------------------------- misc parsing
function firstJson(text) {
  // wrangler may print banners before JSON; take from the first [ or {.
  const i = text.search(/[\[{]/);
  if (i < 0) throw new Error("no JSON in input");
  return JSON.parse(text.slice(i));
}

export function deployUrl(ndjson) {
  // wrangler's deploy targets look like "https://<name>.<sub>.workers.dev", "mcp.example.com (custom domain)",
  // "example.com/path/* (zone name: example.com)" or "schedule: */10 * * * *".
  const targets = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "deploy" && Array.isArray(o.targets)) targets.push(...o.targets.map(String));
    } catch {}
  }
  // A custom domain means the owner chose it on purpose: prefer it (see CUSTOM-DOMAIN.md).
  for (const t of targets) {
    const m = t.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s+\(custom domain/i);
    if (m) return `https://${m[1].toLowerCase()}`;
  }
  return targets.find((t) => /^https:\/\/[a-z0-9.-]+\.workers\.dev\/?$/i.test(t))?.replace(/\/$/, "") || "";
}

const VALID_TOKEN = (t) => typeof t === "string" && t.length >= 32 && !/\s/.test(t);

async function http(url, init = {}, timeoutMs = 15000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  const text = await r.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, body, text };
}

async function preflight(base, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let last = "";
  // A brand-new workers.dev hostname can answer 1042 / 404 for a minute or two.
  for (;;) {
    try {
      const root = await http(`${base}/`);
      if (root.status === 200 && /^(Threadroost|Thread Courier) /.test(root.text)) {
        const as = await http(`${base}/.well-known/oauth-authorization-server`);
        const mcp = await http(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const wa = mcp.headers.get("www-authenticate") || "";
        const res = {
          ok: as.status === 200 && as.body?.registration_endpoint === `${base}/oauth/register` && mcp.status === 401 && /resource_metadata=/.test(wa),
          root: root.text.trim().split("\n")[0],
          discovery_status: as.status,
          mcp_unauthenticated_status: mcp.status,
        };
        if (res.ok) return res;
        // A new hostname can serve / before every route is reachable. Keep waiting, then say which check failed.
        last = res.discovery_status !== 200 ? `sign-in discovery answered ${res.discovery_status}` : `the /mcp lock check answered ${res.mcp_unauthenticated_status}`;
        if (Date.now() > deadline) return { ...res, error: `${last}` };
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      last = `GET / -> ${root.status} ${String(root.text).slice(0, 60)}`;
    } catch (e) {
      last = String(e?.cause?.code || e?.message || e);
    }
    if (Date.now() > deadline) return { ok: false, error: `Worker not answering yet (${last})` };
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---------------------------------------------------------------- dispatch
async function main() {
  switch (cmd) {
    case "config-get": {
      const [file, what] = args;
      const cfg = parseJsonc(fs.readFileSync(file, "utf8"));
      if (what === "name") process.stdout.write(String(cfg.name || ""));
      else if (what === "kv-id") process.stdout.write(String((cfg.kv_namespaces || []).find((k) => k.binding === "OAUTH_KV")?.id || ""));
      else die(`unknown key ${what}`);
      return;
    }
    case "config-set-name": {
      const [file, name] = args;
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name || "")) die("Worker name must be lowercase letters, digits and dashes (max 63, no leading/trailing dash)");
      fs.writeFileSync(file, setName(fs.readFileSync(file, "utf8"), name));
      return;
    }
    case "config-set-kv-id": {
      const [file, id] = args;
      if (!/^[0-9a-f]{32}$/.test(id || "")) die("KV namespace id must be 32 hex characters");
      fs.writeFileSync(file, setKvId(fs.readFileSync(file, "utf8"), id));
      return;
    }
    case "whoami-accounts": {
      const o = firstJson(readStdin());
      if (!o.loggedIn) process.exit(2);
      for (const a of o.accounts || []) process.stdout.write(`${a.id}\t${a.name}\n`);
      return;
    }
    case "kv-find": {
      const list = firstJson(readStdin());
      const hit = list.find((n) => n.title === args[0]);
      process.stdout.write(hit ? hit.id : "");
      return;
    }
    case "kv-has-id": {
      const list = firstJson(readStdin());
      process.exit(list.some((n) => n.id === args[0]) ? 0 : 1);
    }
    case "kv-id-from-create": {
      const text = readStdin();
      const m = text.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/) || text.match(/\b([0-9a-f]{32})\b/);
      if (!m) die("could not find the new namespace id in wrangler output");
      process.stdout.write(m[1]);
      return;
    }
    case "secret-names": {
      const text = readStdin().trim();
      if (!text) return;
      let list;
      try {
        list = firstJson(text);
      } catch {
        return; // no secrets / worker not found
      }
      for (const s of list) if (s?.name) process.stdout.write(`${s.name}\n`);
      return;
    }
    case "deploy-url": {
      const f = args[0];
      process.stdout.write(fs.existsSync(f) ? deployUrl(fs.readFileSync(f, "utf8")) : "");
      return;
    }
    case "gen-token": {
      const f = args[0];
      if (fs.existsSync(f)) die(`${f} already exists; not overwriting`);
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(f, "wx", 0o600);
      fs.writeSync(fd, crypto.randomBytes(32).toString("base64url"));
      fs.closeSync(fd);
      fs.chmodSync(f, 0o600);
      return;
    }
    case "check-token-file": {
      const f = args[0];
      if (!fs.existsSync(f)) process.exit(1);
      process.exit(VALID_TOKEN(fs.readFileSync(f, "utf8").trim()) ? 0 : 1);
    }
    case "preflight": {
      const base = String(args[0] || "").replace(/\/$/, "");
      const wi = args.indexOf("--wait");
      const res = await preflight(base, wi >= 0 ? Number(args[wi + 1]) : 0);
      process.stdout.write(JSON.stringify(res) + "\n");
      process.exit(res.ok ? 0 : 1);
    }
    case "api": {
      const [baseRaw, tokenFile, method, p] = args;
      const base = String(baseRaw).replace(/\/$/, "");
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      try {
        const r = await http(`${base}${p}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: method === "GET" ? undefined : "{}",
        });
        process.stdout.write(JSON.stringify({ status: r.status, body: r.body }) + "\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ status: 0, error: String(e?.cause?.code || e?.message || e) }) + "\n");
      }
      return;
    }
    case "json-field": {
      // json-field <dotted.path>  (stdin JSON) -> value as text
      const o = firstJson(readStdin());
      let v = o;
      for (const k of String(args[0]).split(".")) v = v?.[k];
      process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
      return;
    }
    case "bot-config": {
      const [dir, workerUrl, tokenFile] = args;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dest = path.join(dir, "pull_token");
      if (path.resolve(dest) !== path.resolve(tokenFile)) {
        fs.writeFileSync(dest, fs.readFileSync(tokenFile, "utf8").trim(), { mode: 0o600 });
        fs.chmodSync(dest, 0o600);
      }
      const cfgPath = path.join(dir, "config.json");
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch {}
      cfg.worker_url = workerUrl;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
      return;
    }
    case "state-get": {
      const [file, key] = args;
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8"))[key];
        process.stdout.write(v === undefined || v === null ? "" : String(v));
      } catch {}
      return;
    }
    case "state-set": {
      const [file, key, value] = args;
      let o = {};
      try {
        o = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      o[key] = value;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
      return;
    }
    default:
      die(`unknown command ${cmd ?? "(none)"}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("setup-lib.mjs")) {
  main().catch((e) => die(e?.message || String(e)));
}
