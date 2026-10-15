#!/usr/bin/env node
// Stand-in for wrangler used ONLY by test/setup.test.mjs. Never talks to Cloudflare.
// State lives in $FAKE_CF_DIR: logged_in, kv.json, secrets.json, deploys, calls.log (argv only).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseJsonc } from "../../scripts/setup-lib.mjs";

const dir = process.env.FAKE_CF_DIR;
if (!dir) {
  console.error("FAKE_CF_DIR not set");
  process.exit(9);
}
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ argv, account: process.env.CLOUDFLARE_ACCOUNT_ID || null }) + "\n");
const read = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  } catch {
    return d;
  }
};
const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2));
const loggedIn = () => fs.existsSync(path.join(dir, "logged_in"));
const needAuth = () => {
  if (!loggedIn()) {
    console.error("You are not authenticated. Please run `wrangler login`.");
    process.exit(1);
  }
  const n = Number(process.env.FAKE_ACCOUNTS || 1);
  if (n > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error("More than one account available but unable to select one in non-interactive mode.");
    process.exit(1);
  }
};
const cmd = argv.filter((a) => !a.startsWith("-")).slice(0, 3).join(" ");

if (argv[0] === "--version") {
  console.log("4.148.0");
} else if (argv[0] === "login") {
  fs.writeFileSync(path.join(dir, "logged_in"), "1");
  console.log("Successfully logged in.");
} else if (argv[0] === "whoami" && argv.includes("--json")) {
  if (!loggedIn()) {
    console.log(JSON.stringify({ loggedIn: false }));
    process.exit(1);
  }
  const n = Number(process.env.FAKE_ACCOUNTS || 1);
  const accounts = Array.from({ length: n }, (_, i) => ({ id: `acc${i + 1}`.padEnd(32, "0"), name: `Account ${i + 1}` }));
  console.log(JSON.stringify({ loggedIn: true, authType: "OAuth Token", accounts }));
} else if (cmd === "kv namespace list") {
  needAuth();
  console.log(JSON.stringify(read("kv.json", []), null, "  "));
} else if (cmd.startsWith("kv namespace create")) {
  needAuth();
  const title = argv[3];
  if (!argv.includes("--no-update-config")) {
    console.error("fake-wrangler: setup.sh must pass --no-update-config (otherwise wrangler may prompt)");
    process.exit(1);
  }
  const kv = read("kv.json", []);
  if (kv.some((k) => k.title === title)) {
    console.error(`A KV namespace with the title "${title}" already exists.`);
    process.exit(1);
  }
  const id = crypto.randomBytes(16).toString("hex");
  kv.push({ id, title });
  write("kv.json", kv);
  console.log(`🌀 Creating namespace with title "${title}"\n✨ Success!\nTo access your new KV Namespace in your Worker, add the following snippet to your configuration file:\n{\n  "kv_namespaces": [\n    {\n      "binding": "${title.replace(/-/g, "_")}",\n      "id": "${id}"\n    }\n  ]\n}`);
} else if (cmd === "kv key put" || cmd === "kv key delete") {
  needAuth();
  const data = read("kvdata.json", {});
  const key = argv.find((x, i) => i > 2 && !x.startsWith("--") && argv[i - 1] !== "--namespace-id");
  if (cmd === "kv key put") data[key] = argv[argv.indexOf(key) + 1];
  else delete data[key];
  write("kvdata.json", data);
} else if (argv[0] === "deploy") {
  needAuth();
  const cfg = parseJsonc(fs.readFileSync("wrangler.jsonc", "utf8"));
  const kvId = cfg.kv_namespaces?.[0]?.id;
  if (!kvId || !read("kv.json", []).some((k) => k.id === kvId)) {
    console.error("KV namespace id not found");
    process.exit(1);
  }
  const n = read("deploys.json", 0) + 1;
  write("deploys.json", n);
  write("worker.json", { name: cfg.name });
  const url = `https://${cfg.name}.example-sub.workers.dev`;
  console.log(`Uploaded ${cfg.name}\nDeployed ${cfg.name} triggers\n  ${url}\n  schedule: */10 * * * *`);
  if (process.env.WRANGLER_OUTPUT_FILE_PATH)
    fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: "deploy", version: 1, worker_name: cfg.name, targets: [url] }) + "\n");
} else if (cmd === "secret list") {
  needAuth();
  if (!fs.existsSync(path.join(dir, "worker.json"))) {
    console.error("This Worker does not exist on your account.");
    process.exit(1);
  }
  console.log(JSON.stringify(Object.keys(read("secrets.json", {})).map((name) => ({ name, type: "secret_text" }))));
} else if (cmd.startsWith("secret put")) {
  needAuth();
  const name = argv[2];
  if (process.stdin.isTTY) {
    console.error("fake-wrangler: refusing interactive secret entry in tests");
    process.exit(1);
  }
  const value = fs.readFileSync(0, "utf8").replace(/\s+$/, "");
  const s = read("secrets.json", {});
  s[name] = value;
  write("secrets.json", s);
  write("puts.json", [...read("puts.json", []), name]);
  console.log(`✨ Success! Uploaded secret ${name}`);
} else {
  console.error(`fake-wrangler: unsupported: ${argv.join(" ")}`);
  process.exit(1);
}
