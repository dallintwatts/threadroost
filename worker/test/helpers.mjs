// Shared helpers for Threadroost tests (Node 22+, no extra deps).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const sha256Hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
export const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Start `wrangler dev` on a port with --var overrides; resolves with {url, stop}. */
export async function startWorker({ port, vars = {}, extraArgs = [], cwd = path.resolve(import.meta.dirname, "..") }) {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "courier-dev-"));
  const args = ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--inspector-port", String(port + 1000), "--log-level", "log"];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  args.push(...extraArgs);
  const child = spawn("npx", args, { cwd, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const killTree = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  let out = "";
  const logs = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + out)), 90_000);
    const onData = (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split("\n")) if (line.includes('{"evt"')) logs.push(line.slice(line.indexOf("{")));
      if (/Ready on/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (c) => {
      killTree("SIGKILL");
      reject(new Error(`wrangler exited ${c}:\n${out}`));
    });
  });
  child.removeAllListeners("exit");
  return {
    url: `http://localhost:${port}`,
    logs,
    output: () => out,
    stop: () =>
      new Promise((r) => {
        child.once("exit", () => {
          fs.rmSync(persist, { recursive: true, force: true });
          r();
        });
        killTree("SIGTERM");
        setTimeout(() => killTree("SIGKILL"), 5000);
      }),
  };
}

/** Parse a JSON-RPC response that may come back as JSON or SSE. */
export async function readRpc(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    const datas = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .map((d) => JSON.parse(d));
    return datas.find((d) => "result" in d || "error" in d) ?? datas.at(-1);
  }
  return text ? JSON.parse(text) : null;
}

let rpcId = 1;
/** Minimal MCP client over Streamable HTTP (2025-06-18 stateless style, like most hosted clients). */
export function mcpClient(baseUrl, token) {
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const rpc = async (method, params) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    });
    if (res.status !== 200) return { httpStatus: res.status, body: await res.text(), headers: res.headers };
    return await readRpc(res);
  };
  return {
    rpc,
    async initialize() {
      return rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "courier-test", version: "0" },
      });
    },
    async listTools() {
      return rpc("tools/list", {});
    },
    /** Returns {isError, data} where data is the parsed JSON tool output, or {rpcError}. */
    async call(name, args) {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r?.httpStatus) return { httpStatus: r.httpStatus, body: r.body };
      if (r?.error) return { rpcError: r.error };
      const text = r.result?.content?.[0]?.text ?? "";
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { isError: !!r.result?.isError, data };
    },
  };
}

function cookieJar() {
  const jar = new Map();
  return {
    take(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
    },
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

/**
 * Full OAuth: discovery -> (DCR or given client) -> PKCE authorize -> pairing code -> token.
 * getPairCode: async () => code. Returns tokens plus intermediate evidence.
 */
export async function oauthFlow(baseUrl, { getPairCode, client, redirectUri, clientName = "courier-test-client", wrongCodeFirst = false, replayCheck = false }) {
  const ev = {};
  const unauth = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ev.unauthStatus = unauth.status;
  ev.wwwAuthenticate = unauth.headers.get("www-authenticate");
  const rm = /resource_metadata="([^"]+)"/.exec(ev.wwwAuthenticate || "")?.[1];
  ev.resourceMetadataUrl = rm;
  const prm = await (await fetch(rm)).json();
  ev.protectedResource = prm;
  const asUrl = `${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`;
  const asm = await (await fetch(asUrl)).json();
  ev.authServer = asm;

  let clientId = client?.client_id;
  if (!clientId) {
    const reg = await fetch(asm.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    ev.dcrStatus = reg.status;
    const regBody = await reg.json();
    clientId = regBody.client_id;
    ev.dcr = { client_id: clientId, token_endpoint_auth_method: regBody.token_endpoint_auth_method };
  }

  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(12));
  const jar = cookieJar();
  const authUrl = new URL(asm.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "courier",
    resource: prm.resource,
  }).toString();
  const consent = await fetch(authUrl, { redirect: "manual" });
  ev.consentStatus = consent.status;
  jar.take(consent);
  const html = await consent.text();
  ev.consentHasCodeField = /name="code"/.test(html);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  if (!handle) throw new Error(`no consent handle (status ${consent.status}): ${html.slice(0, 300)}`);

  const code = await getPairCode();
  const post = async (pairCode) => {
    const r = await fetch(`${new URL(asm.authorization_endpoint).origin}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: new URLSearchParams({ handle, decision: "approve", code: pairCode, client_name: clientName, redirect_host: "" }).toString(),
    });
    jar.take(r);
    return r;
  };
  if (wrongCodeFirst) {
    const wrong = code === "00000000" ? "11111111" : "00000000";
    const w = await post(wrong);
    ev.wrongCodeStatus = w.status;
    await w.text();
  }
  const ok = await post(code);
  ev.approveStatus = ok.status;
  const loc = ok.headers.get("location");
  ev.redirectLocationHost = loc ? new URL(loc).host : null;
  if (!loc) throw new Error(`approve failed ${ok.status}: ${(await ok.text()).slice(0, 4000)}`);
  const cb = new URL(loc);
  ev.stateRoundTrip = cb.searchParams.get("state") === state;
  const authCode = cb.searchParams.get("code");

  const tokRes = await fetch(asm.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: prm.resource,
    }).toString(),
  });
  ev.tokenStatus = tokRes.status;
  const tokens = await tokRes.json();
  // Replay of the same code must fail (and, per OAuth 2.1, revokes the grant).
  if (!replayCheck) return { clientId, tokens, ev, asm, prm, pairCodeUsed: code };
  const replay = await fetch(asm.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
  });
  ev.codeReplayStatus = replay.status;
  return { clientId, tokens, ev, asm, prm, pairCodeUsed: code };
}

export function turns(from, to, mk = (i) => `turn ${i} text`) {
  const out = [];
  for (let i = from; i <= to; i++) out.push({ role: i % 2 ? "user" : "assistant", text: mk(i), index: i });
  return out;
}
