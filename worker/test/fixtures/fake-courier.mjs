// Minimal stand-in for a deployed Threadroost, used ONLY by test/setup.test.mjs.
// Reads the secrets the fake wrangler stored in $FAKE_CF_DIR/secrets.json on every request.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export function startFakeCourier(dir, port) {
  const secrets = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8"));
    } catch {
      return {};
    }
  };
  const server = http.createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    const url = new URL(req.url, base);
    const send = (status, body, headers = {}) => {
      const isText = typeof body === "string";
      res.writeHead(status, { "content-type": isText ? "text/plain" : "application/json", ...headers });
      res.end(isText ? body : JSON.stringify(body));
    };
    if (url.pathname === "/" && req.method === "GET") return send(200, `Threadroost 1.1.0. MCP endpoint: ${base}/mcp\n`);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return send(200, { issuer: base, registration_endpoint: `${base}/oauth/register`, code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/mcp")
      return send(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    if (url.pathname.startsWith("/api/")) {
      const s = secrets();
      if (!s.COURIER_PULL_TOKEN || s.COURIER_PULL_TOKEN.length < 32) return send(503, { error: "server_not_configured" });
      if (req.headers.authorization !== `Bearer ${s.COURIER_PULL_TOKEN}`) return send(401, { error: "unauthorized" });
      if (url.pathname === "/api/handoffs") return send(200, { handoffs: [] });
      if (url.pathname === "/api/pair") return send(200, { code: "12345678", expires_at: new Date(Date.now() + 600000).toISOString() });
      if (url.pathname === "/api/admin/probe-webhook") {
        const ok = !!(s.GROKBOT_WEBHOOK_URL && s.GROKBOT_WEBHOOK_KEY);
        // TR-CI-1: $dir/probe-busy holds how many probes should get a busy bot's HTTP 400 first.
        const busyFile = path.join(dir, "probe-busy");
        const busy = fs.existsSync(busyFile) ? Number(fs.readFileSync(busyFile, "utf8")) : 0;
        if (ok && busy > 0) {
          fs.writeFileSync(busyFile, String(busy - 1));
          return send(200, { webhook: { ok: false, http_status: 400, reason: "non_2xx", response_snippet: "Automation run rate limit reached. Try again later." } });
        }
        return send(200, { webhook: { ok, http_status: ok ? 200 : null, reason: ok ? undefined : "webhook_not_configured" } });
      }
    }
    send(404, { error: "not_found" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })));
}
