// Pre-flight 5.1 checks 1 and 2 against a deployed Worker: node test/remote-preflight.mjs https://<worker>
const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base.startsWith("https://")) throw new Error("usage: node test/remote-preflight.mjs https://<worker>");
const results = [];
const check = (name, ok, evidence) => results.push({ name, ok, evidence });

const r1 = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const wa = r1.headers.get("www-authenticate");
check("1. /mcp no token -> 401 + WWW-Authenticate resource_metadata", r1.status === 401 && /resource_metadata="https:\/\//.test(wa || ""), { status: r1.status, www_authenticate: wa });

const prmUrl = /resource_metadata="([^"]+)"/.exec(wa || "")?.[1];
const prm = await fetch(prmUrl);
const prmBody = await prm.json();
check("2a. protected-resource metadata 200", prm.status === 200 && prmBody.resource === `${base}/mcp`, { url: prmUrl, status: prm.status, body: prmBody });
const prmRoot = await fetch(`${base}/.well-known/oauth-protected-resource`);
check("2b. root protected-resource alias 200", prmRoot.status === 200, { status: prmRoot.status });
const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
const asBody = await as.json();
check(
  "2c. authorization-server metadata 200, S256, registration endpoint",
  as.status === 200 && asBody.code_challenge_methods_supported?.includes("S256") && asBody.registration_endpoint === `${base}/oauth/register`,
  { status: as.status, body: asBody },
);
const dcrBad = await fetch(`${base}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "preflight-negative", redirect_uris: ["https://not-allowed.example/cb"], token_endpoint_auth_method: "none" }),
});
check("2d. DCR rejects non-allowed redirect host", dcrBad.status === 400, { status: dcrBad.status, body: await dcrBad.json() });
console.log(JSON.stringify({ base, passed: results.every((r) => r.ok), results }, null, 1));
process.exit(results.every((r) => r.ok) ? 0 : 1);
