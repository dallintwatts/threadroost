/**
 * Threadroost Worker
 *
 * A small, owner-operated MCP server. A chat client (for example grok.com custom
 * connectors) calls the MCP tools below to hand a conversation over turn by turn.
 * The Worker buffers the chunks in KV, checks that nothing is missing, then sends a
 * small "handoff_ready" notice to the owner's bot webhook. The bot pulls the text
 * over an authenticated API, files it, and acknowledges, which deletes the text.
 *
 * Auth: OAuth 2.1 + PKCE (S256) via @cloudflare/workers-oauth-provider, with dynamic
 * client registration (redirect hosts restricted) and pre-registered clients. The
 * consent page requires a one-time 8-digit pairing code minted by the owner's bot.
 *
 * Two ways in:
 *   - start_handoff / append_turns / finish_handoff: a whole conversation at once.
 *   - sync_turns: one call per turn ("live sync"). The server assigns order, dedupes
 *     re-sent turns, flags likely gaps, and notifies the bot at most once per
 *     SYNC_NOTIFY_INTERVAL_SECONDS per thread (a cron trigger flushes idle threads).
 *
 * Each handoff records which client sent it (OAuth client id) and its source
 * ("grok", "claude" or "other"), derived from the client's registered redirect URI.
 *
 * Privacy: no IP or content logging; one JSON log line per outcome.
 */
import { FONT_SANS_B64, FONT_MONO_B64, LOGO_SVG } from "./brand";
import { OAuthProvider, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers, AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  COURIER_PULL_TOKEN?: string;
  COURIER_ADMIN_TOKEN?: string;
  GROKBOT_WEBHOOK_URL?: string;
  GROKBOT_WEBHOOK_KEY?: string;
  ALLOWED_REDIRECT_HOSTS?: string; // comma list; host or any subdomain of it
  ALLOWED_REDIRECT_URIS?: string; // comma list of exact https redirect URIs (e.g. Claude's hosted callback)
  MAX_HANDOFFS_PER_DAY?: string; // handoffs started + live-sync threads active, per UTC day
  SYNC_NOTIFY_INTERVAL_SECONDS?: string; // min seconds between bot notifications per synced thread
  SYNC_FLUSH_MIN_SECONDS?: string; // min seconds between "flush now" notifications per thread
  SYNC_MAX_CALLS_PER_THREAD_PER_DAY?: string;
  CLAIM_TTL_SECONDS?: string; // optional override for tests, clamped to 5..900
  ABANDONED_HANDOFF_SECONDS?: string; // empty open handoffs older than this are swept by the cron (default 3600, min 1)
  WEBHOOK_RETRY_DELAY_MS?: string; // TR-BUG-32: one quick retry after a transient webhook failure (default 20000)
  ALERT_STUCK_SECONDS?: string; // a sealed handoff still undelivered after this long raises an alert (default 1800)
  ALERT_INTERVAL_SECONDS?: string; // at most one alert per this many seconds (default 3600)
  RENOTIFY_BASE_SECONDS?: string; // first webhook retry delay for queued handoffs (default 600, doubles each try)
  CONNECT_REUSE_SECONDS?: string; // a Connect link asked for again within this window is returned unchanged (default 300)
}

const VERSION = "1.2.2";
const SENTINEL = "[TURN NOT AVAILABLE VERBATIM]";
const CHUNK_MAX_BYTES = 24 * 1024;
const CHUNK_MAX_TURNS = 50;
const MAX_CHUNKS = 200;
const HANDOFF_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PER_DAY = 20;
const CONTENT_TTL = 72 * 3600;
const META_TTL_AFTER_ACK = 30 * 24 * 3600;
const CLIENT_REF_TTL = 24 * 3600;
const PAIR_TTL = 600;
const PAIR_MAX_ATTEMPTS = 5;
const CLAIM_TTL = 900; // claim link lifetime (15 min)
const CLAIM_MAX_ATTEMPTS = 5; // wrong codes before the claim link is burned
const CLAIM_RESEND_SECONDS = 600; // a fresh claim link is sent at most every 10 min until claimed
const CONNECT_TTL = 900; // Connect page link lifetime (15 min)
const CONNECT_REUSE = 300; // asking again within 5 min returns the same unused link instead of replacing it
const FINISH_RECHECKS = 3; // re-reads of missing chunks before finish_handoff answers "incomplete"
const FINISH_RECHECK_MS = 700;
const MCP_AUTH_RETRY_MS = 1200; // a token minted moments ago may not be visible at this location yet (TR-OBS-1)
const RENOTIFY_MAX_ATTEMPTS = 6; // webhook tries per queued handoff (first + 5 cron retries with backoff)
const RENOTIFY_BASE_SECONDS = 600;
const ABANDONED_AFTER = 3600; // an open handoff with zero chunks after 1 h is treated as abandoned and swept
const WEBHOOK_TIMEOUT_MS = 8000;
const DEFAULT_REDIRECT_HOSTS = "grok.com,x.ai";
// Exact redirect URIs (no host/subdomain/path wildcarding). Claude's hosted connector callback,
// used by claude.ai web, Desktop, mobile and Cowork. Claude Code's loopback redirect stays blocked.
const DEFAULT_REDIRECT_URIS = "https://claude.ai/api/mcp/auth_callback";

// Live sync (sync_turns)
const SYNC_MAX_TURNS = 20; // per call; lag-by-one needs 2, the rest is catch-up room
const SYNC_MAX_CALL_BYTES = 64 * 1024; // utf-8 text bytes per call (one long reply fits)
const SYNC_RECENT = 64; // turn hashes remembered per thread for dedupe
const SYNC_REPLAY_MIN_CHARS = 40; // exact repeats of a recent turn at least this long are treated as re-sends
const SYNC_MAX_FLAGS = 50;
const DEFAULT_NOTIFY_INTERVAL = 600; // 10 minutes
const DEFAULT_FLUSH_MIN = 60;
const DEFAULT_MAX_SYNC_CALLS = 300;
const STREAM_TTL = 30 * 24 * 3600;

const K = {
  meta: (id: string) => `courier:m:${id}`,
  metaPrefix: "courier:m:",
  chunk: (id: string, seq: number) => `courier:c:${id}:${String(seq).padStart(4, "0")}`,
  chunkPrefix: (id: string) => `courier:c:${id}:`,
  ref: (h: string) => `courier:ref:${h}`,
  day: (d: string) => `courier:day:${d}`,
  stream: (sid: string) => `courier:s:${sid}`,
  streamPrefix: "courier:s:",
  pair: "courier:pair",
  autoPull: "courier:auto:pull",
  claim: "courier:claim",
  connect: "courier:connect",
  connectOld: "courier:connect:old", // hashes of links replaced by a newer one, so their page can say so
  boot: "courier:boot",
  dcrLog: "courier:dcrlog",
  whHealth: "courier:whhealth", // consecutive webhook failures (no content, no secrets)
  alert: "courier:alert", // last owner alert sent (TR-ALERT-1)
};

type Status = "open" | "delivered" | "queued" | "filed";
type Role = "user" | "assistant";
type Source = "grok" | "claude" | "other";
type SourceBasis = "oauth_client" | "declared" | "unknown";

interface GapFlag {
  kind: "missing_assistant_reply" | "missing_user_message" | "earlier_history_not_synced" | "not_verbatim" | "segment_expired";
  at: number; // stream-wide turn index the flag refers to
  note: string;
}

interface HandoffMeta {
  id: string;
  title: string;
  project: string | null;
  mode: "verbatim" | "summary";
  expected_turns: number;
  client_ref_hash: string | null;
  client_id: string | null;
  source?: Source; // absent on handoffs created before v1.1 (treat as "grok")
  source_basis?: SourceBasis;
  kind?: "handoff" | "stream"; // absent = "handoff"
  // Live-sync segments only:
  stream_id?: string;
  thread_key?: string;
  segment?: number; // 1, 2, 3, ... per thread
  first_index?: number; // stream-wide index of this segment's local turn 1
  gap_flags?: GapFlag[];
  status: Status;
  created_at: string;
  sealed_at?: string;
  total_chunks?: number;
  total_turns?: number;
  bytes?: number;
  sha256?: string; // manifest hash: sha256 of chunk sha256 hex strings joined by "\n", seq order
  chunk_hashes?: string[];
  turns_not_available?: number;
  webhook?: { attempted_at: string; ok: boolean; http_status: number | null; reason?: string; hint?: string; attempts?: number; response_snippet?: string };
  verdict?: string;
  acked_at?: string;
}

// KV metadata stored on each chunk (max 1024 bytes).
interface ChunkMeta {
  h: string; // sha256 hex of canonical chunk JSON
  b: number; // utf-8 text bytes in this chunk
  n: number; // turn count
  r: string; // turn indices as ranges "1-20,22"
  na: number; // sentinel count
}

interface Turn {
  index: number;
  role: Role;
  text: string;
}

// Live-sync thread state (one KV value per thread; segments are ordinary handoffs once sealed).
interface StreamState {
  id: string;
  thread_key: string;
  title: string;
  project: string | null;
  source: Source;
  source_basis: SourceBasis;
  client_id: string | null;
  created_at: string;
  last_at: string;
  day: string; // UTC day this thread last counted against the daily cap
  calls_today: number;
  turns: number; // stream-wide turns stored so far (last index)
  last_role: Role | null;
  recent: { h: string; r: Role; i: number; l: number }[];
  flags: GapFlag[]; // most recent first-to-last, capped
  open_gaps: number;
  last_notified_ms: number;
  segments: number;
  seg: null | {
    id: string;
    created_at: string;
    first_index: number;
    turns: number;
    chunks: number;
    bytes: number;
    na: number;
    hashes: string[];
    flags: GapFlag[];
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function utf8Len(s: string): number {
  return enc.encode(s).length;
}

function log(evt: string, fields: Record<string, unknown> = {}): void {
  // One JSON line per outcome. Never include content, tokens, codes or IPs.
  console.log(JSON.stringify({ evt, ...fields }));
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function newHandoffId(): string {
  const ts = Date.now().toString(36);
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return `h${ts}${[...rnd].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

function toRanges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const start = s[i];
    while (i + 1 < s.length && s[i + 1] === s[i] + 1) i++;
    out.push(start === s[i] ? `${start}` : `${start}-${s[i]}`);
  }
  return out.join(",");
}

function fromRanges(r: string): number[] {
  if (!r) return [];
  const out: number[] = [];
  for (const part of r.split(",")) {
    const [a, b] = part.split("-").map(Number);
    if (b === undefined) out.push(a);
    else for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

function canonicalTurns(turns: Turn[]): string {
  return JSON.stringify(turns.map((t) => ({ index: t.index, role: t.role, text: t.text })));
}

function allowedRedirectHosts(env: Env): string[] {
  return (env.ALLOWED_REDIRECT_HOSTS || DEFAULT_REDIRECT_HOSTS)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function allowedRedirectUris(env: Env): string[] {
  return (env.ALLOWED_REDIRECT_URIS ?? DEFAULT_REDIRECT_URIS)
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

/**
 * A redirect URI is allowed if it is https AND either
 *   (a) equals one of the exact allowed URIs character for character (Claude: only
 *       https://claude.ai/api/mcp/auth_callback; no other path, query, or subdomain), or
 *   (b) its host is an allowed host or a subdomain of one (grok.com, x.ai).
 * Loopback/plain-http redirects (e.g. Claude Code's http://localhost:<port>/callback) are always refused.
 */
function redirectAllowed(uri: string, env: Env): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")) return false;
  if (allowedRedirectUris(env).includes(uri)) return true;
  return allowedRedirectHosts(env).some((h) => host === h || host.endsWith(`.${h}`));
}

function redirectRuleText(env: Env): string {
  return `https on an allowed host (${allowedRedirectHosts(env).join(", ")}) or exactly one of: ${allowedRedirectUris(env).join(", ")}`;
}

/** Which assistant a client is, from its registered redirect URI. */
function sourceFromRedirect(uri: string | undefined): Source {
  if (!uri) return "other";
  try {
    const host = new URL(uri).hostname.toLowerCase();
    if (host === "claude.ai") return "claude";
    if (host === "grok.com" || host.endsWith(".grok.com") || host === "x.ai" || host.endsWith(".x.ai")) return "grok";
  } catch {
    /* fall through */
  }
  return "other";
}

async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && a.length === b.length;
}

// Per-isolate fixed-window rate limiter. Keys are "scope:IP" counters only (no content, tokens or owner data), held in
// memory, never logged. One of the two allowed module-level mutable values (see .cursor/BUGBOT.md and state.test).
const buckets = new Map<string, { n: number; reset: number }>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rateLimited(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    if (buckets.size >= 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    if (buckets.size >= 5000) buckets.delete(buckets.keys().next().value as string); // drop the oldest, not everyone's limits
    buckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n++;
  return b.n > limit;
}
function clientKey(req: Request, scope: string): string {
  return `${scope}:${req.headers.get("cf-connecting-ip") || "local"}`;
}

// ---------------------------------------------------------------------------
// Handoff store (KV)
// ---------------------------------------------------------------------------

async function getMeta(env: Env, id: string): Promise<HandoffMeta | null> {
  if (!/^h[a-z0-9]{6,40}$/.test(id)) return null;
  return env.OAUTH_KV.get<HandoffMeta>(K.meta(id), "json");
}

async function putMeta(env: Env, m: HandoffMeta, ttl: number): Promise<void> {
  await env.OAUTH_KV.put(K.meta(m.id), JSON.stringify(m), {
    expirationTtl: ttl,
    metadata: { s: m.status, t: m.title.slice(0, 80), c: m.created_at, n: m.total_turns ?? null, v: m.verdict ?? null },
  });
}

async function getChunkMeta(env: Env, id: string, seq: number): Promise<ChunkMeta | null> {
  // Stream the value and cancel it: we only need the metadata, which keeps CPU low.
  const r = await env.OAUTH_KV.getWithMetadata<ChunkMeta>(K.chunk(id, seq), "stream");
  if (r.value) await r.value.cancel();
  return r.value === null && r.metadata === null ? null : (r.metadata as ChunkMeta | null);
}

function remainingTtl(m: HandoffMeta): number {
  const age = Math.floor((Date.now() - Date.parse(m.created_at)) / 1000);
  return Math.max(60, CONTENT_TTL - age);
}

type ToolOut = Record<string, unknown>;

/** Who is calling the MCP tools (from the OAuth token), plus the request context. */
interface Caller {
  clientId: string | null;
  source: Source; // derived from the OAuth client's redirect URI; "other" if unknown
  ctx?: ExecutionContext;
}

function resolveSource(caller: Caller, declared?: Source): { source: Source; basis: SourceBasis } {
  if (caller.source !== "other") return { source: caller.source, basis: "oauth_client" };
  if (declared) return { source: declared, basis: "declared" };
  return { source: "other", basis: caller.clientId ? "oauth_client" : "unknown" };
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function maxPerDay(env: Env): number {
  return Number(env.MAX_HANDOFFS_PER_DAY || DEFAULT_MAX_PER_DAY) || DEFAULT_MAX_PER_DAY;
}

function envSeconds(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : dflt;
}

async function startHandoff(
  env: Env,
  caller: Caller,
  a: { title: string; project?: string; mode: "verbatim" | "summary"; expected_turns: number; client_ref?: string; source?: Source },
): Promise<ToolOut> {
  let refHash: string | null = null;
  if (a.client_ref) {
    refHash = await sha256Hex(`ref:${a.client_ref}`);
    const existing = await env.OAUTH_KV.get(K.ref(refHash));
    if (existing) {
      const m = await getMeta(env, existing);
      if (m) {
        log("start_handoff", { outcome: "idempotent", id: m.id });
        return { handoff_id: m.id, status: m.status, existing: true, rules: chunkRules() };
      }
    }
  }
  const day = utcDay();
  const cap = maxPerDay(env);
  const count = Number((await env.OAUTH_KV.get(K.day(day))) || "0");
  if (count >= cap) {
    log("start_handoff", { outcome: "daily_cap" });
    return { error: "daily_cap_reached", message: `Daily limit of ${cap} handoffs reached. Try again tomorrow (UTC).` };
  }
  const src = resolveSource(caller, a.source);
  const m: HandoffMeta = {
    id: newHandoffId(),
    title: a.title,
    project: a.project?.trim() || null,
    mode: a.mode,
    expected_turns: a.expected_turns,
    client_ref_hash: refHash,
    client_id: caller.clientId,
    source: src.source,
    source_basis: src.basis,
    kind: "handoff",
    status: "open",
    created_at: new Date().toISOString(),
  };
  await putMeta(env, m, CONTENT_TTL);
  await env.OAUTH_KV.put(K.day(day), String(count + 1), { expirationTtl: 2 * 24 * 3600 });
  if (refHash) await env.OAUTH_KV.put(K.ref(refHash), m.id, { expirationTtl: CLIENT_REF_TTL });
  log("start_handoff", { outcome: "created", id: m.id, source: m.source });
  return { handoff_id: m.id, status: "open", existing: false, source: m.source, rules: chunkRules() };
}

function chunkRules() {
  return {
    max_turns_per_call: CHUNK_MAX_TURNS,
    suggested_turns_per_call: 20,
    max_text_bytes_per_call: CHUNK_MAX_BYTES,
    max_chunks: MAX_CHUNKS,
    max_handoff_bytes: HANDOFF_MAX_BYTES,
    seq: "Number chunks 1, 2, 3, ... with no gaps. Re-sending an identical chunk is safe.",
    turn_index: "Number turns 1..N across the whole conversation, in order.",
    roles: "user = the person; assistant = you.",
    sentinel: SENTINEL,
    finish: "Call finish_handoff with total_chunks and total_turns when every turn is sent.",
  };
}

async function appendTurns(env: Env, a: { handoff_id: string; seq: number; turns: Turn[] }): Promise<ToolOut> {
  const m = await getMeta(env, a.handoff_id);
  if (!m) return { error: "not_found", message: "Unknown or expired handoff_id. Call start_handoff again." };
  if (m.status !== "open") return { error: "sealed", message: `Handoff is already ${m.status}. It can't be changed.` };
  if (!Number.isInteger(a.seq) || a.seq < 1 || a.seq > MAX_CHUNKS)
    return { error: "cap_exceeded", message: `seq must be an integer from 1 to ${MAX_CHUNKS}.` };
  if (a.turns.length < 1 || a.turns.length > CHUNK_MAX_TURNS)
    return { error: "cap_exceeded", message: `Send 1 to ${CHUNK_MAX_TURNS} turns per call (about 20 is best).` };
  const bytes = a.turns.reduce((s, t) => s + utf8Len(t.text), 0);
  if (bytes > CHUNK_MAX_BYTES)
    return {
      error: "cap_exceeded",
      message: `This chunk has ${bytes} bytes of text and the limit is ${CHUNK_MAX_BYTES}. Split it into smaller append_turns calls.`,
    };
  const idx = a.turns.map((t) => t.index);
  if (new Set(idx).size !== idx.length) return { error: "invalid", message: "Duplicate turn index inside this chunk." };

  const canon = canonicalTurns(a.turns);
  const h = await sha256Hex(canon);
  const existing = await getChunkMeta(env, m.id, a.seq);
  if (existing) {
    if (existing.h === h) {
      log("append_turns", { outcome: "duplicate_noop", id: m.id, seq: a.seq });
      return { ok: true, duplicate: true, seq: a.seq, sha256: h, message: "Identical chunk already stored. Nothing changed." };
    }
    log("append_turns", { outcome: "conflict", id: m.id, seq: a.seq });
    return {
      error: "conflict",
      seq: a.seq,
      message: `A different chunk is already stored for seq ${a.seq}. Chunks can't be rewritten. Send new turns under the next unused seq.`,
    };
  }
  const cm: ChunkMeta = {
    h,
    b: bytes,
    n: a.turns.length,
    r: toRanges(idx),
    na: a.turns.filter((t) => t.text.trim() === SENTINEL).length,
  };
  if (JSON.stringify(cm).length > 1000) return { error: "invalid", message: "Turn indices are too scattered. Send turns in order." };
  await env.OAUTH_KV.put(K.chunk(m.id, a.seq), canon, { expirationTtl: remainingTtl(m), metadata: cm });
  log("append_turns", { outcome: "stored", id: m.id, seq: a.seq, n: cm.n, b: cm.b });
  return { ok: true, duplicate: false, seq: a.seq, turns_stored: cm.n, indices: cm.r, sha256: h };
}

async function finishHandoff(env: Env, a: { handoff_id: string; total_chunks: number; total_turns: number }, caller?: Caller | null): Promise<ToolOut> {
  const m = await getMeta(env, a.handoff_id);
  if (!m) return { error: "not_found", message: "Unknown or expired handoff_id." };
  if (m.status !== "open") {
    return { status: m.status, handoff_id: m.id, already_sealed: true, chunks: m.total_chunks, turns: m.total_turns };
  }
  if (a.total_chunks < 1 || a.total_chunks > MAX_CHUNKS)
    return { error: "cap_exceeded", message: `total_chunks must be 1..${MAX_CHUNKS}.` };
  if (a.total_turns < 1) return { error: "invalid", message: "total_turns must be at least 1." };

  const seqs = Array.from({ length: a.total_chunks }, (_, i) => i + 1);
  const metas = await Promise.all(seqs.map((s) => getChunkMeta(env, m.id, s)));
  // KV is eventually consistent across Cloudflare locations: a chunk the client just stored can be briefly invisible
  // here (TR-OBS-2). Re-check missing chunks a few times before answering "incomplete".
  // Only when a few are missing (the lag case): a client that skipped many chunks gets its answer at once, and
  // the re-reads stay well inside the per-request KV operation limit.
  for (let tries = 0; tries < FINISH_RECHECKS && metas.some((x) => !x) && metas.filter((x) => !x).length <= 10; tries++) {
    await sleep(FINISH_RECHECK_MS);
    await Promise.all(metas.map(async (x, i) => { if (!x) metas[i] = await getChunkMeta(env, m.id, seqs[i]); }));
  }
  const missingChunks: number[] = [];
  const seen = new Map<number, number>();
  const dupTurns = new Set<number>();
  let bytes = 0;
  let na = 0;
  metas.forEach((cm, i) => {
    if (!cm) {
      missingChunks.push(seqs[i]);
      return;
    }
    bytes += cm.b;
    na += cm.na;
    for (const t of fromRanges(cm.r)) {
      if (seen.has(t)) dupTurns.add(t);
      seen.set(t, seqs[i]);
    }
  });
  const missingTurns: number[] = [];
  for (let t = 1; t <= a.total_turns; t++) if (!seen.has(t)) missingTurns.push(t);
  const extraTurns = [...seen.keys()].filter((t) => t > a.total_turns || t < 1);

  if (bytes > HANDOFF_MAX_BYTES) {
    log("finish_handoff", { outcome: "too_large", id: m.id, bytes });
    return { status: "rejected", error: "cap_exceeded", message: `Handoff is ${bytes} bytes and the limit is ${HANDOFF_MAX_BYTES}.` };
  }
  if (missingChunks.length || missingTurns.length || dupTurns.size || extraTurns.length) {
    const missing = [
      ...missingChunks.map((s) => `chunk seq ${s}`),
      ...(missingTurns.length ? [`turn indices ${toRanges(missingTurns)}`] : []),
    ];
    log("finish_handoff", { outcome: "incomplete", id: m.id, mc: missingChunks.length, mt: missingTurns.length });
    return {
      status: "incomplete",
      handoff_id: m.id,
      missing,
      missing_chunks: missingChunks,
      missing_turns: missingTurns,
      duplicate_turn_indices: [...dupTurns].sort((x, y) => x - y),
      out_of_range_turn_indices: extraTurns.sort((x, y) => x - y),
      message:
        "Not sealed. Re-send the missing chunks or turns with append_turns, then call finish_handoff again with the updated totals. If a seq already holds other turns, use a new seq for the re-sent ones.",
    };
  }

  const hashes = (metas as ChunkMeta[]).map((cm) => cm.h);
  m.sha256 = await sha256Hex(hashes.join("\n"));
  m.chunk_hashes = hashes;
  m.total_chunks = a.total_chunks;
  m.total_turns = a.total_turns;
  m.bytes = bytes;
  m.turns_not_available = na;
  m.sealed_at = new Date().toISOString();
  m.status = "queued";
  m.webhook = { ...(await fireWebhook(env, m)), attempts: 1 };
  if (m.webhook.ok) m.status = "delivered";
  await putMeta(env, m, remainingTtl(m));
  if (!m.webhook.ok && webhookRetryable(m.webhook) && caller?.ctx) caller.ctx.waitUntil(retryWebhookSoon(env, m.id));
  log("finish_handoff", { outcome: m.status, id: m.id, chunks: m.total_chunks, turns: m.total_turns, bytes });
  const out: ToolOut = {
    status: m.status,
    handoff_id: m.id,
    chunks: m.total_chunks,
    turns: m.total_turns,
    bytes,
    sha256: m.sha256,
    turns_not_available: na,
  };
  if (m.expected_turns !== a.total_turns)
    out.note = `expected_turns was ${m.expected_turns} but ${a.total_turns} turns were sent.`;
  out.message =
    m.status === "delivered"
      ? "Sealed and delivered to the owner's bot."
      : "Sealed and queued. The owner's bot will pick it up on its next run.";
  return out;
}

// TR-BUG-32: a bot that is busy (or briefly erroring) can answer 400/409/429/5xx or time out. Retry once soon
// instead of waiting for the next cron. Clear "gone" or "bad key" answers are not retried here.
export function webhookRetryable(w: { http_status: number | null; reason?: string; response_snippet?: string }): boolean {
  if (/paused|disabled|not found|deleted|no such|unauthori[sz]ed|forbidden|invalid (api )?key/i.test(w.response_snippet || "")) return false;
  if (w.http_status === null) return w.reason === "timeout" || w.reason === "network_error";
  return [400, 408, 409, 423, 425, 429].includes(w.http_status) || w.http_status >= 500;
}
async function retryWebhookSoon(env: Env, id: string): Promise<void> {
  const delay = Math.min(25000, Math.max(0, Number(env.WEBHOOK_RETRY_DELAY_MS ?? 20000) || 0));
  await new Promise((r) => setTimeout(r, delay));
  const m = await getMeta(env, id);
  if (!m || m.status !== "queued") return;
  const w = await fireWebhook(env, m);
  m.webhook = { ...w, attempts: (m.webhook?.attempts ?? 1) + 1 };
  if (w.ok) m.status = "delivered";
  const cur = await getMeta(env, id);
  if (cur && cur.status === "filed") return;
  await putMeta(env, m, remainingTtl(m));
  log("webhook_retry", { id, ok: w.ok, http_status: w.http_status });
}
async function fireWebhook(env: Env, m: HandoffMeta): Promise<NonNullable<HandoffMeta["webhook"]>> {
  const body: Record<string, unknown> = {
    event: "handoff_ready",
    handoff_id: m.id,
    kind: m.kind ?? "handoff",
    source: m.source ?? "grok",
    title: m.title,
    project: m.project,
    mode: m.mode,
    chunks: m.total_chunks,
    turns: m.total_turns,
    bytes: m.bytes,
    sha256: m.sha256,
    created_at: m.created_at,
    // TR-BUG-33: one id per send, so a bot can tell a repeated notice (retry, cron re-notify) from a new handoff.
    delivery_id: crypto.randomUUID(),
    attempt: (m.webhook?.attempts ?? 0) + 1,
  };
  if (m.kind === "stream") {
    body.stream_id = m.stream_id;
    body.segment = m.segment;
    body.first_index = m.first_index;
    body.gaps = m.gap_flags?.length ?? 0;
  }
  return postWebhook(env, body);
}

/** Plain-words explanation of a rejected webhook. Grok Bot answers 400 when the inbox routine is paused (TR-BUG-14). */
function webhookHint(status: number): string {
  if (status === 400)
    return "Your bot's inbox routine did not start (it may be busy, paused or deleted). Threadroost retries shortly and on every cron run. If it keeps failing, open the bot and check its courier-inbox routine (see response_snippet). Handoffs stay queued until then.";
  if (status === 404 || status === 410)
    return "Your bot's inbox routine rejected the webhook. It may be paused or deleted: open the bot, resume its courier-inbox routine (or recreate it and run ./setup.sh --reset-webhook). Handoffs stay queued until then.";
  if (status === 401 || status === 403)
    return "Your bot refused the webhook key. Ask your bot \"Show my Threadroost webhook\", copy the key again and run ./setup.sh --reset-webhook. Handoffs stay queued until then.";
  if (status === 429) return "Your bot is rate limiting webhooks. Handoffs stay queued and your bot's catch-up routine will collect them.";
  return "Your bot's webhook did not accept the notice. Handoffs stay queued and your bot's catch-up routine will collect them.";
}

// TR-BUG-32: keep the first 300 chars of a webhook reply, with the key and anything token-like removed.
async function readCapped(r: Response, max: number): Promise<string> {
  try {
    const reader = r.body?.getReader();
    if (!reader) return "";
    let out = "";
    const dec = new TextDecoder();
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return out;
  } catch {
    return "";
  }
}
export function redactSnippet(text: string, key?: string): string {
  let t = text;
  if (key) t = t.split(key).join("[redacted]");
  t = t
    .replace(/(bearer\s+)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, "[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return t.slice(0, 300);
}
async function postWebhook(env: Env, body: Record<string, unknown>): Promise<NonNullable<HandoffMeta["webhook"]>> {
  const attempted_at = new Date().toISOString();
  if (!env.GROKBOT_WEBHOOK_URL || !env.GROKBOT_WEBHOOK_KEY)
    return { attempted_at, ok: false, http_status: null, reason: "webhook_not_configured" };
  let url: URL;
  try {
    url = new URL(env.GROKBOT_WEBHOOK_URL);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("not https");
  } catch {
    return { attempted_at, ok: false, http_status: null, reason: "webhook_url_invalid" };
  }
  try {
    const r = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.GROKBOT_WEBHOOK_KEY}`,
        "x-automation-key": env.GROKBOT_WEBHOOK_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const response_snippet = redactSnippet(await readCapped(r, 2048), env.GROKBOT_WEBHOOK_KEY);
    log("webhook", { event: body.event, http_status: r.status, ...(r.ok ? {} : { response_snippet }) });
    if (r.ok) return await noteWebhookHealth(env, { attempted_at, ok: true, http_status: r.status });
    return await noteWebhookHealth(env, { attempted_at, ok: false, http_status: r.status, reason: "non_2xx", hint: webhookHint(r.status), response_snippet });
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error";
    log("webhook", { event: body.event, reason });
    return await noteWebhookHealth(env, { attempted_at, ok: false, http_status: null, reason });
  }
}

// ------------------------------------------------------------------ owner alerts (TR-ALERT-1)
const ALERT_STUCK_SECONDS = 1800;
const ALERT_INTERVAL_SECONDS = 3600;
const ALERT_FAIL_THRESHOLD = 3;
const ALERT_REPEAT_SAME_MS = 24 * 3600 * 1000; // the same problem is re-sent at most once a day
interface WebhookHealth { failures: number; since?: string; last_status?: number | null; last_reason?: string }
interface AlertRecord {
  alert_id: string;
  created_at: string;
  sent_at: number;
  delivered: boolean;
  fingerprint: string;
  kinds: ("stuck_handoffs" | "webhook_failing")[];
  stuck_after_minutes: number;
  stuck_handoffs: { handoff_id: string; minutes: number }[];
  consecutive_failures: number;
  last_failure: { http_status: number | null; reason: string | null } | null;
  message: string;
}

/** Counts consecutive webhook failures across all events. Writes only when the count changes. */
async function noteWebhookHealth(env: Env, w: NonNullable<HandoffMeta["webhook"]>): Promise<NonNullable<HandoffMeta["webhook"]>> {
  try {
    const cur = ((await env.OAUTH_KV.get(K.whHealth, "json")) as WebhookHealth | null) ?? { failures: 0 };
    if (w.ok) {
      if (cur.failures) await env.OAUTH_KV.put(K.whHealth, JSON.stringify({ failures: 0 }));
    } else {
      const next: WebhookHealth = { failures: cur.failures + 1, since: cur.since || w.attempted_at, last_status: w.http_status, last_reason: w.reason || "unknown" };
      await env.OAUTH_KV.put(K.whHealth, JSON.stringify(next));
    }
  } catch {
    /* health tracking must never break a delivery */
  }
  return w;
}

/** Plain-words alert text. No titles, chat text, URLs, tokens or keys. */
export function alertMessage(a: Pick<AlertRecord, "stuck_handoffs" | "consecutive_failures" | "last_failure">, stuckMinutes: number): string {
  const lines: string[] = [];
  if (a.stuck_handoffs.length) {
    const oldest = Math.max(...a.stuck_handoffs.map((h) => h.minutes));
    const n = a.stuck_handoffs.length;
    lines.push(n === 1
      ? `1 finished chat has waited over ${stuckMinutes} minutes to reach your bot (${oldest} minutes so far).`
      : `${n} finished chats have waited over ${stuckMinutes} minutes to reach your bot (oldest: ${oldest} minutes).`);
  }
  if (a.consecutive_failures >= ALERT_FAIL_THRESHOLD) {
    const lf = a.last_failure;
    const why = lf?.http_status ? `HTTP ${lf.http_status}` : lf?.reason === "timeout" ? "timed out" : "no answer";
    lines.push(`Your Worker's last ${a.consecutive_failures} messages to your bot failed (latest: ${why}).`);
  }
  lines.push("Check that your bot's courier-inbox routine is on and approved, then run ./setup.sh --doctor. Waiting chats stay on your Worker for up to 72 hours.");
  return "Threadroost needs a look. " + lines.join(" ");
}

/**
 * Cron: raise one owner alert when a sealed handoff has waited past ALERT_STUCK_SECONDS, or the last 3+ webhooks
 * failed. At most one alert per ALERT_INTERVAL_SECONDS, and the same problem is not re-sent within a day.
 * The alert also stays readable at GET /api/admin/alert, so a bot whose webhook is down still sees it on its pull.
 */
async function checkAlerts(env: Env, now = Date.now()): Promise<"none" | "rate_limited" | "duplicate" | "sent" | "failed"> {
  const stuckSecs = envSeconds(env.ALERT_STUCK_SECONDS, ALERT_STUCK_SECONDS);
  const stuck: { handoff_id: string; minutes: number }[] = [];
  for (const c of (await listMetas(env)).filter((i) => i.s === "queued").reverse().slice(0, 50)) { // oldest first: they are the ones most likely stuck
    const m = await getMeta(env, c.id);
    if (!m || m.status !== "queued") continue;
    const age = now - Date.parse(m.sealed_at || m.created_at);
    if (age >= stuckSecs * 1000) stuck.push({ handoff_id: m.id, minutes: Math.floor(age / 60000) });
  }
  const wh = ((await env.OAUTH_KV.get(K.whHealth, "json")) as WebhookHealth | null) ?? { failures: 0 };
  const failing = wh.failures >= ALERT_FAIL_THRESHOLD;
  if (!stuck.length && !failing) return "none";
  const kinds: AlertRecord["kinds"] = [...(stuck.length ? (["stuck_handoffs"] as const) : []), ...(failing ? (["webhook_failing"] as const) : [])];
  const fingerprint = [...kinds, ...stuck.map((h) => h.handoff_id).sort()].join(",");
  const prev = (await env.OAUTH_KV.get(K.alert, "json")) as AlertRecord | null;
  if (prev && now - prev.sent_at < envSeconds(env.ALERT_INTERVAL_SECONDS, ALERT_INTERVAL_SECONDS) * 1000) return "rate_limited";
  if (prev && prev.delivered && prev.fingerprint === fingerprint && now - prev.sent_at < ALERT_REPEAT_SAME_MS) return "duplicate";
  stuck.sort((a, b) => b.minutes - a.minutes);
  const base = { stuck_handoffs: stuck.slice(0, 20), consecutive_failures: wh.failures, last_failure: failing ? { http_status: wh.last_status ?? null, reason: wh.last_reason ?? null } : null };
  const rec: AlertRecord = {
    alert_id: crypto.randomUUID(),
    created_at: new Date(now).toISOString(),
    sent_at: now,
    delivered: false,
    fingerprint,
    kinds,
    stuck_after_minutes: Math.round(stuckSecs / 60),
    ...base,
    message: alertMessage(base, Math.round(stuckSecs / 60)),
  };
  // Record first, so a crash mid-send can't cause a burst of repeats.
  await env.OAUTH_KV.put(K.alert, JSON.stringify(rec), { expirationTtl: 7 * 24 * 3600 });
  const { fingerprint: _f, sent_at: _s, delivered: _d, ...payload } = rec;
  const r = await postWebhook(env, { event: "threadroost.alert", ...payload });
  rec.delivered = r.ok;
  await env.OAUTH_KV.put(K.alert, JSON.stringify(rec), { expirationTtl: 7 * 24 * 3600 });
  log("alert", { kinds, stuck: stuck.length, failures: wh.failures, delivered: r.ok });
  return r.ok ? "sent" : "failed";
}

function publicMeta(m: HandoffMeta) {
  return {
    handoff_id: m.id,
    kind: m.kind ?? "handoff",
    source: m.source ?? "grok",
    source_basis: m.source_basis ?? "unknown",
    client_id: m.client_id ?? null,
    title: m.title,
    project: m.project,
    ...(m.kind === "stream"
      ? { stream_id: m.stream_id, thread_key: m.thread_key, segment: m.segment, first_index: m.first_index, gap_flags: m.gap_flags ?? [] }
      : {}),
    mode: m.mode,
    status: m.status,
    expected_turns: m.expected_turns,
    chunks: m.total_chunks ?? null,
    turns: m.total_turns ?? null,
    bytes: m.bytes ?? null,
    sha256: m.sha256 ?? null,
    turns_not_available: m.turns_not_available ?? null,
    created_at: m.created_at,
    sealed_at: m.sealed_at ?? null,
    webhook: m.webhook ?? null,
    verdict: m.verdict ?? null,
    acked_at: m.acked_at ?? null,
  };
}

/**
 * A handoff that was started but never got a single chunk (the client crashed, lost its token, or the harness failed)
 * would otherwise sit "open" for 72 h and show up in handoff_status. Delete it once it is older than the threshold.
 * Handoffs with any chunk are left alone: they keep the normal 72 h content TTL.
 */
/**
 * A handoff whose webhook failed (bot paused, network down) stays "queued". Retry the notice from the cron with
 * backoff (10, 20, 40, 80, 160 min) so it reaches the bot once it is back, even without a catch-up routine (TR-BUG-18).
 */
async function renotifyQueued(env: Env): Promise<number> {
  if (!env.GROKBOT_WEBHOOK_URL || !env.GROKBOT_WEBHOOK_KEY) return 0;
  const base = envSeconds(env.RENOTIFY_BASE_SECONDS, RENOTIFY_BASE_SECONDS) * 1000;
  const now = Date.now();
  let sent = 0;
  for (const c of (await listMetas(env)).filter((i) => i.s === "queued").slice(0, 25)) {
    const m = await getMeta(env, c.id);
    if (!m || m.status !== "queued") continue;
    const n = m.webhook?.attempts ?? 1;
    const last = Date.parse(m.webhook?.attempted_at || m.sealed_at || m.created_at);
    if (n >= RENOTIFY_MAX_ATTEMPTS || now - last < base * 2 ** (n - 1)) continue;
    const w = await fireWebhook(env, m);
    m.webhook = { ...w, attempts: n + 1 };
    if (w.ok) m.status = "delivered";
    await putMeta(env, m, remainingTtl(m));
    sent++;
  }
  if (sent) log("renotify", { sent });
  return sent;
}

async function sweepAbandonedHandoffs(env: Env): Promise<number> {
  const after = Math.max(1, envSeconds(env.ABANDONED_HANDOFF_SECONDS, ABANDONED_AFTER)) * 1000;
  const now = Date.now();
  const cands = (await listMetas(env)).filter((i) => i.s === "open" && now - Date.parse(i.c) >= after).slice(0, 50);
  let swept = 0;
  for (const c of cands) {
    const m = await getMeta(env, c.id);
    if (!m || m.status !== "open" || (m.kind ?? "handoff") !== "handoff") continue;
    const chunks = await env.OAUTH_KV.list({ prefix: K.chunkPrefix(m.id), limit: 1 });
    if (chunks.keys.length) continue;
    await env.OAUTH_KV.delete(K.meta(m.id));
    if (m.client_ref_hash) await env.OAUTH_KV.delete(K.ref(m.client_ref_hash));
    swept++;
  }
  if (cands.length) log("abandoned_sweep", { checked: cands.length, swept });
  return swept;
}

async function listMetas(env: Env): Promise<{ id: string; s: Status; t: string; c: string; n: number | null; v: string | null }[]> {
  const out: { id: string; s: Status; t: string; c: string; n: number | null; v: string | null }[] = [];
  let cursor: string | undefined;
  do {
    const r = await env.OAUTH_KV.list<{ s: Status; t: string; c: string; n: number | null; v: string | null }>({
      prefix: K.metaPrefix,
      cursor,
    });
    for (const k of r.keys) if (k.metadata) out.push({ id: k.name.slice(K.metaPrefix.length), ...k.metadata });
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.c < b.c ? 1 : -1));
}

async function handoffStatus(env: Env, caller: Caller, a: { handoff_id?: string; thread_key?: string; source?: Source }): Promise<ToolOut> {
  if (a.thread_key) {
    const { source } = resolveSource(caller, a.source);
    const key = normThreadKey(a.thread_key);
    const st = key ? await env.OAUTH_KV.get<StreamState>(K.stream(await streamId(source, key)), "json") : null;
    if (!st) return { error: "not_found", message: "No synced thread with that thread_key for this client yet." };
    return { thread: streamSummary(st, env) };
  }
  if (a.handoff_id) {
    const m = await getMeta(env, a.handoff_id);
    if (!m) return { error: "not_found", message: "Unknown or expired handoff_id." };
    const out: ToolOut = { handoff: publicMeta(m) };
    if (m.status === "open") {
      // Progress view for resuming a partial handoff (KV list is eventually consistent).
      const r = await env.OAUTH_KV.list<ChunkMeta>({ prefix: K.chunkPrefix(m.id) });
      const seqs = r.keys.map((k) => Number(k.name.split(":").pop()));
      const turns = r.keys.flatMap((k) => (k.metadata ? fromRanges(k.metadata.r) : []));
      out.received = { chunk_seqs: toRanges(seqs), turn_indices: toRanges(turns) };
    }
    return out;
  }
  const items = (await listMetas(env)).slice(0, 10);
  return {
    handoffs: items.map((i) => ({ handoff_id: i.id, title: i.t, status: i.s, turns: i.n, created_at: i.c, verdict: i.v })),
    threads: await listStreams(env),
  };
}

// ---------------------------------------------------------------------------
// Live sync (sync_turns)
//
// One long-lived "thread" per (source, thread_key). Each call appends the turns that
// are new, in arrival order; the server assigns every index. Turns are buffered in an
// open segment; the segment is sealed into an ordinary handoff (kind "stream") and the
// bot is notified at most once per SYNC_NOTIFY_INTERVAL_SECONDS per thread, on the next
// call after the interval or from the cron flush. The bot pulls/acks segments exactly like
// regular handoffs; local turn indices inside a segment run 1..N and first_index maps them
// back to the thread-wide numbering.
//
// KV is not transactional, so calls for one thread are serialized per isolate. Two calls for
// the same thread landing on different isolates at the same instant could still race; clients
// call once per turn, so this is accepted (a Durable Object would remove it).
// ---------------------------------------------------------------------------

// Allowed module-level state #2: in-flight promise chains per stream id, deleted when the last call finishes.
const threadLocks = new Map<string, Promise<unknown>>();
async function withThreadLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadLocks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  threadLocks.set(id, tail);
  try {
    return await run;
  } finally {
    if (threadLocks.get(id) === tail) threadLocks.delete(id);
  }
}

function normThreadKey(k: string): string {
  return k.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 200);
}

async function streamId(source: Source, normKey: string): Promise<string> {
  return `s${(await sha256Hex(`stream:${source}:${normKey}`)).slice(0, 24)}`;
}

function normText(t: string): string {
  return t.replace(/\r\n?/g, "\n").normalize("NFC").trim();
}

async function turnHash(role: Role, text: string): Promise<string> {
  return (await sha256Hex(`${role}\n${normText(text)}`)).slice(0, 32);
}

/** Largest k such that the last k remembered turns equal the first k incoming turns (role + hash). */
function tailOverlap(recent: StreamState["recent"], incoming: { h: string; r: Role }[]): number {
  const max = Math.min(recent.length, incoming.length);
  for (let k = max; k > 0; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      const a = recent[recent.length - k + j];
      if (a.h !== incoming[j].h || a.r !== incoming[j].r) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

function streamSummary(st: StreamState, env: Env) {
  const interval = envSeconds(env.SYNC_NOTIFY_INTERVAL_SECONDS, DEFAULT_NOTIFY_INTERVAL);
  return {
    stream_id: st.id,
    thread_key: st.thread_key,
    title: st.title,
    project: st.project,
    source: st.source,
    stream_turns: st.turns,
    last_index: st.turns,
    last_role: st.last_role,
    last_hash: st.recent.at(-1)?.h ?? null,
    last_at: st.last_at,
    segments_sealed: st.segments - (st.seg ? 1 : 0),
    pending_turns: st.seg?.turns ?? 0,
    next_notify_after: st.seg ? new Date(st.last_notified_ms + interval * 1000).toISOString() : null,
    possible_gaps: st.open_gaps,
    recent_gaps: st.flags.slice(-5),
  };
}

async function putStream(env: Env, st: StreamState): Promise<void> {
  await env.OAUTH_KV.put(K.stream(st.id), JSON.stringify(st), {
    expirationTtl: STREAM_TTL,
    metadata: { t: st.thread_key.slice(0, 80), src: st.source, n: st.turns, la: st.last_at, seg: st.seg?.id ?? null, ln: st.last_notified_ms },
  });
}

/** Seal the thread's open segment into a regular handoff. Returns the meta (status "queued") or null. */
async function sealSegment(env: Env, st: StreamState): Promise<HandoffMeta | null> {
  const seg = st.seg;
  st.seg = null;
  if (!seg || seg.turns === 0) return null;
  const m: HandoffMeta = {
    id: seg.id,
    title: st.title,
    project: st.project,
    mode: "verbatim",
    expected_turns: seg.turns,
    client_ref_hash: null,
    client_id: st.client_id,
    source: st.source,
    source_basis: st.source_basis,
    kind: "stream",
    stream_id: st.id,
    thread_key: st.thread_key,
    segment: st.segments,
    first_index: seg.first_index,
    gap_flags: seg.flags,
    status: "queued",
    created_at: seg.created_at,
    sealed_at: new Date().toISOString(),
    total_chunks: seg.chunks,
    total_turns: seg.turns,
    bytes: seg.bytes,
    sha256: await sha256Hex(seg.hashes.join("\n")),
    chunk_hashes: seg.hashes,
    turns_not_available: seg.na,
  };
  await putMeta(env, m, remainingTtl(m));
  log("sync_seal", { id: m.id, stream: st.id, turns: m.total_turns, chunks: m.total_chunks });
  return m;
}

/** Notify the bot about a sealed segment and record the outcome on its meta. */
async function notifySegment(env: Env, m: HandoffMeta): Promise<void> {
  m.webhook = { ...(await fireWebhook(env, m)), attempts: 1 };
  if (m.webhook.ok) m.status = "delivered";
  // Do not overwrite a segment the bot already filed in the meantime.
  const cur = await getMeta(env, m.id);
  if (cur && cur.status === "filed") return;
  await putMeta(env, m, remainingTtl(m));
}

function scheduleNotify(caller: Caller | null, env: Env, m: HandoffMeta): Promise<void> {
  const p = notifySegment(env, m).catch((e) => log("sync_notify", { outcome: "error", reason: e instanceof Error ? e.name : "unknown" }));
  if (caller?.ctx) caller.ctx.waitUntil(p);
  return p;
}

async function syncTurns(
  env: Env,
  caller: Caller,
  a: { thread_key: string; title?: string; project?: string; turns: { role: Role; text: string }[]; flush?: boolean; source?: Source },
): Promise<ToolOut> {
  if (a.turns.length < 1 || a.turns.length > SYNC_MAX_TURNS)
    return { error: "cap_exceeded", message: `Send 1 to ${SYNC_MAX_TURNS} turns per sync_turns call (usually 2: your previous reply and the new user message).` };
  const bytes = a.turns.reduce((s, t) => s + utf8Len(t.text), 0);
  if (bytes > SYNC_MAX_CALL_BYTES)
    return {
      error: "cap_exceeded",
      message: `This call has ${bytes} bytes of text and the limit is ${SYNC_MAX_CALL_BYTES}. Send fewer turns per call. If a single turn is longer than the limit, send ${SENTINEL} for it instead of shortening it.`,
    };
  if (a.turns.some((t) => normText(t.text) === "")) return { error: "invalid", message: "A turn has empty text. Send the exact text, or the placeholder if you cannot see it." };
  const key = normThreadKey(a.thread_key);
  if (!key) return { error: "invalid", message: "thread_key must not be empty. Use this chat's title." };

  const src = resolveSource(caller, a.source);
  const sid = await streamId(src.source, key);
  return withThreadLock(sid, async () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const today = utcDay();
    let st = await env.OAUTH_KV.get<StreamState>(K.stream(sid), "json");
    const isNew = !st;

    // Daily cap: a live-sync thread counts once per UTC day, not once per call.
    if (!st || st.day !== today) {
      const count = Number((await env.OAUTH_KV.get(K.day(today))) || "0");
      if (count >= maxPerDay(env)) {
        log("sync_turns", { outcome: "daily_cap", stream: sid });
        return {
          error: "daily_cap_reached",
          message: `Daily limit of ${maxPerDay(env)} handoffs/synced threads reached. Try again tomorrow (UTC).`,
        };
      }
      await env.OAUTH_KV.put(K.day(today), String(count + 1), { expirationTtl: 2 * 24 * 3600 });
    }
    if (!st) {
      st = {
        id: sid,
        thread_key: a.thread_key.trim().slice(0, 200),
        title: (a.title?.trim() || a.thread_key.trim()).slice(0, 200),
        project: a.project?.trim() || null,
        source: src.source,
        source_basis: src.basis,
        client_id: caller.clientId,
        created_at: nowIso,
        last_at: nowIso,
        day: today,
        calls_today: 0,
        turns: 0,
        last_role: null,
        recent: [],
        flags: [],
        open_gaps: 0,
        last_notified_ms: 0,
        segments: 0,
        seg: null,
      };
    }
    if (st.day !== today) {
      st.day = today;
      st.calls_today = 0;
    }
    const callCap = Number(env.SYNC_MAX_CALLS_PER_THREAD_PER_DAY || DEFAULT_MAX_SYNC_CALLS) || DEFAULT_MAX_SYNC_CALLS;
    if (st.calls_today >= callCap) {
      log("sync_turns", { outcome: "thread_call_cap", stream: sid });
      return { error: "cap_exceeded", message: `This thread reached ${callCap} sync calls today (UTC). Sync resumes tomorrow.` };
    }
    st.calls_today++;
    if (a.title?.trim()) st.title = a.title.trim().slice(0, 200);
    if (a.project?.trim()) st.project = a.project.trim().slice(0, 100);
    st.client_id = caller.clientId ?? st.client_id;

    // 1) Dedupe: drop the leading turns that repeat the thread's tail (retries, lag-by-one after
    //    a "sync now"), then drop exact repeats of a recent long turn (re-sends out of order).
    const hashed = await Promise.all(a.turns.map(async (t) => ({ ...t, h: await turnHash(t.role, t.text) })));
    const k = tailOverlap(st.recent, hashed.map((t) => ({ h: t.h, r: t.role })));
    const recent = [...st.recent];
    const fresh: typeof hashed = [];
    const replayed: number[] = [];
    for (const t of hashed.slice(k)) {
      const len = normText(t.text).length;
      const prior = t.text.trim() !== SENTINEL && len >= SYNC_REPLAY_MIN_CHARS ? recent.find((x) => x.h === t.h && x.r === t.role) : undefined;
      if (prior) {
        replayed.push(prior.i);
        continue;
      }
      fresh.push(t);
      recent.push({ h: t.h, r: t.role, i: st.turns + fresh.length, l: len });
    }

    // 2) Gap/overlap detection on what will be stored (indices are thread-wide).
    const newFlags: GapFlag[] = [];
    let prevRole = st.last_role;
    fresh.forEach((t, j) => {
      const i = st!.turns + j + 1;
      if (i === 1 && t.role === "assistant")
        newFlags.push({ kind: "earlier_history_not_synced", at: 1, note: "The first synced turn is an assistant reply. Earlier turns were not synced." });
      if (prevRole && prevRole === t.role)
        newFlags.push(
          t.role === "user"
            ? { kind: "missing_assistant_reply", at: i, note: `Two user turns in a row (${i - 1}, ${i}). The assistant reply between them may be missing.` }
            : { kind: "missing_user_message", at: i, note: `Two assistant turns in a row (${i - 1}, ${i}). A user message between them may be missing.` },
        );
      if (t.text.trim() === SENTINEL) newFlags.push({ kind: "not_verbatim", at: i, note: `Turn ${i} was sent as ${SENTINEL}.` });
      prevRole = t.role;
    });

    let notified: HandoffMeta | null = null;
    const sealedNow: HandoffMeta[] = [];
    if (fresh.length) {
      const freshBytes = fresh.reduce((s, t) => s + utf8Len(t.text), 0);
      // The open segment's content may have expired if it was never flushed (e.g. cron disabled).
      if (st.seg && Date.parse(st.seg.created_at) + CONTENT_TTL * 1000 < now + 3600_000) {
        const lost = st.seg;
        st.seg = null;
        newFlags.unshift({ kind: "segment_expired", at: lost.first_index, note: `Turns ${lost.first_index}-${lost.first_index + lost.turns - 1} were buffered too long and expired before delivery.` });
      }
      // Rotate the segment if this call would push it past the per-handoff caps.
      if (st.seg && (st.seg.chunks + 1 > MAX_CHUNKS || st.seg.bytes + freshBytes > HANDOFF_MAX_BYTES)) {
        const m = await sealSegment(env, st);
        if (m) sealedNow.push(m);
      }
      if (!st.seg) {
        st.segments++;
        st.seg = { id: newHandoffId(), created_at: nowIso, first_index: st.turns + 1, turns: 0, chunks: 0, bytes: 0, na: 0, hashes: [], flags: [] };
      }
      const seg = st.seg;
      const stored: Turn[] = fresh.map((t, j) => ({ index: seg.turns + j + 1, role: t.role, text: t.text }));
      const canon = canonicalTurns(stored);
      const h = await sha256Hex(canon);
      const seq = seg.chunks + 1;
      const cm: ChunkMeta = { h, b: freshBytes, n: stored.length, r: toRanges(stored.map((t) => t.index)), na: stored.filter((t) => t.text.trim() === SENTINEL).length };
      const ttl = Math.max(60, CONTENT_TTL - Math.floor((now - Date.parse(seg.created_at)) / 1000));
      await env.OAUTH_KV.put(K.chunk(seg.id, seq), canon, { expirationTtl: ttl, metadata: cm });
      seg.chunks = seq;
      seg.turns += stored.length;
      seg.bytes += freshBytes;
      seg.na += cm.na;
      seg.hashes.push(h);
      seg.flags.push(...newFlags);
      st.turns += fresh.length;
      st.last_role = fresh.at(-1)!.role;
    }
    st.recent = recent.slice(-SYNC_RECENT);
    st.flags = [...st.flags, ...newFlags].slice(-SYNC_MAX_FLAGS);
    st.open_gaps += newFlags.filter((f) => f.kind !== "not_verbatim").length;
    st.last_at = nowIso;

    // 3) Batched notification: at most once per interval per thread ("flush" = owner asked to sync now).
    const interval = envSeconds(env.SYNC_NOTIFY_INTERVAL_SECONDS, DEFAULT_NOTIFY_INTERVAL);
    const flushMin = envSeconds(env.SYNC_FLUSH_MIN_SECONDS, DEFAULT_FLUSH_MIN);
    const since = (now - st.last_notified_ms) / 1000;
    const due = st.seg && st.seg.turns > 0 && (since >= interval || (a.flush === true && since >= flushMin));
    if (due) {
      const m = await sealSegment(env, st);
      if (m) sealedNow.push(m);
      st.last_notified_ms = now;
      notified = m;
    }
    await putStream(env, st);
    // Rotated-but-not-due segments wait as "queued"; the bot drains all pending ones on its next wake.
    if (notified) scheduleNotify(caller, env, notified);

    const outcome = fresh.length ? "stored" : "duplicate";
    log("sync_turns", { outcome, stream: sid, source: st.source, stored: fresh.length, dup: k + replayed.length, gaps: newFlags.length, notify: !!notified });
    const last = st.recent.at(-1);
    const out: ToolOut = {
      status: fresh.length ? "ok" : "duplicate",
      stream_id: st.id,
      thread_key: st.thread_key,
      source: st.source,
      new_thread: isNew,
      stored: fresh.length,
      stored_indices: fresh.length ? toRanges(fresh.map((_, j) => st!.turns - fresh.length + j + 1)) : "",
      duplicates: k + replayed.length,
      replayed_indices: replayed,
      stream_turns: st.turns,
      last_index: st.turns,
      last_role: st.last_role,
      last_hash: last?.h ?? null,
      gaps: newFlags,
      possible_gaps_total: st.open_gaps,
      delivery: notified ? "notifying_bot" : st.seg ? "batched" : "nothing_pending",
      next_notify_after: st.seg ? new Date(st.last_notified_ms + interval * 1000).toISOString() : null,
    };
    // The model's own context already holds this text; echoing a short excerpt lets it see where
    // the server's copy ends and catch up in order if it skipped calls. Never logged.
    out.server_copy_ends_with = st.last_role ? { index: st.turns, role: st.last_role, starts: lastExcerpt(fresh.length ? fresh : k === a.turns.length ? a.turns : []) } : null;
    out.next =
      st.last_role === "user"
        ? `Next reply: call sync_turns first with your reply to turn ${st.turns}, then the user's new message. If more turns happened after turn ${st.turns} that you did not sync, send them all, in order, in that call.`
        : st.last_role === "assistant"
          ? `Turn ${st.turns} (your reply) is stored. Next call: the user's next message, plus any later turns you have not synced, in order.`
          : "Nothing stored yet.";
    if (newFlags.some((f) => f.kind === "missing_assistant_reply" || f.kind === "missing_user_message"))
      out.action =
        "A turn may be missing (see gaps). Do not re-send older turns out of order. The gap is recorded so the owner can reconcile it from the account export. Keep syncing normally.";
    return out;
  });
}

function lastExcerpt(turns: { text: string }[]): string | null {
  const t = turns.at(-1)?.text;
  if (!t) return null;
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
}

/** Cron: seal and notify threads whose open segment has waited at least one interval. */
async function flushIdleStreams(env: Env): Promise<{ checked: number; flushed: number }> {
  const interval = envSeconds(env.SYNC_NOTIFY_INTERVAL_SECONDS, DEFAULT_NOTIFY_INTERVAL);
  const now = Date.now();
  let cursor: string | undefined;
  const candidates: string[] = [];
  do {
    const r = await env.OAUTH_KV.list<{ seg: string | null; ln: number }>({ prefix: K.streamPrefix, cursor });
    for (const k of r.keys) if (k.metadata?.seg && now - (k.metadata.ln ?? 0) >= interval * 1000) candidates.push(k.name.slice(K.streamPrefix.length));
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  let flushed = 0;
  for (const sid of candidates) {
    await withThreadLock(sid, async () => {
      const st = await env.OAUTH_KV.get<StreamState>(K.stream(sid), "json");
      if (!st?.seg || now - st.last_notified_ms < interval * 1000) return;
      const m = await sealSegment(env, st);
      st.last_notified_ms = now;
      await putStream(env, st);
      if (m) {
        await notifySegment(env, m);
        flushed++;
      }
    });
  }
  log("sync_cron", { checked: candidates.length, flushed });
  return { checked: candidates.length, flushed };
}

async function listStreams(env: Env, limit = 10) {
  const out: { stream_id: string; thread_key: string; source: string; turns: number; last_at: string; pending: boolean }[] = [];
  let cursor: string | undefined;
  do {
    const r = await env.OAUTH_KV.list<{ t: string; src: string; n: number; la: string; seg: string | null }>({ prefix: K.streamPrefix, cursor });
    for (const k of r.keys)
      if (k.metadata)
        out.push({ stream_id: k.name.slice(K.streamPrefix.length), thread_key: k.metadata.t, source: k.metadata.src, turns: k.metadata.n, last_at: k.metadata.la, pending: !!k.metadata.seg });
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.last_at < b.last_at ? 1 : -1)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const VERBATIM_CORE =
  "Copy each turn EXACTLY as it appears in this conversation, word for word, including code, tables and typos. Do not summarize, merge, shorten or paraphrase. Label each turn `user` (the person) or `assistant` (you).";
const VERBATIM_RULES =
  VERBATIM_CORE +
  " Number turns from 1. Send at most ~20 turns or 24 KB per `append_turns` call and keep calling until every turn is sent. If you cannot see an earlier turn verbatim, send `[TURN NOT AVAILABLE VERBATIM]` for it rather than reconstructing it. Set mode=summary only if the user asked for a summary.";
const SYNC_RULES =
  VERBATIM_CORE +
  " Do not number turns or track chunks: the server assigns order and safely ignores turns it already has. If you cannot see a turn verbatim, send `[TURN NOT AVAILABLE VERBATIM]` for it rather than reconstructing it.";

const SOURCE_HINT = z
  .enum(["grok", "claude", "other"])
  .optional()
  .describe("Optional: which assistant you are. The connector's own sign-in identifies the client; this is only used when it cannot.");

function toolResult(out: ToolOut) {
  return { content: [{ type: "text" as const, text: JSON.stringify(out) }], isError: "error" in out };
}

function buildServer(env: Env, caller: Caller): McpServer {
  const server = new McpServer({ name: "threadroost", version: VERSION });

  server.registerTool(
    "start_handoff",
    {
      description:
        "Start handing the current conversation to the owner's bot. Call this first, then append_turns until every turn is sent, then finish_handoff. " +
        VERBATIM_RULES,
      inputSchema: {
        title: z.string().min(1).max(200).describe("Conversation title as shown to the user."),
        project: z.string().max(100).optional().describe("Project or folder name, if the conversation belongs to one."),
        mode: z.enum(["verbatim", "summary"]).describe("verbatim unless the user explicitly asked for a summary."),
        expected_turns: z.number().int().min(1).max(10000).describe("How many turns (user + assistant) you are about to send."),
        client_ref: z
          .string()
          .max(200)
          .optional()
          .describe("Optional idempotency key. Re-using it within 24h returns the same handoff_id."),
        source: SOURCE_HINT,
      },
    },
    async (args) => toolResult(await startHandoff(env, caller, args)),
  );

  server.registerTool(
    "append_turns",
    {
      description:
        "Send the next chunk of turns for a handoff. seq starts at 1 and increases by 1 per call. Re-sending an identical chunk is a safe no-op; a different chunk for an existing seq is rejected. " +
        VERBATIM_RULES,
      inputSchema: {
        handoff_id: z.string().min(1).max(64),
        seq: z.number().int().min(1).max(MAX_CHUNKS).describe("Chunk number: 1, 2, 3, ..."),
        turns: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]).describe("user = the person; assistant = you."),
              text: z.string().describe(`The turn's exact text, or ${SENTINEL} if you cannot see it verbatim.`),
              index: z.number().int().min(1).max(10000).describe("Turn number in the whole conversation, starting at 1."),
            }),
          )
          .min(1)
          .max(CHUNK_MAX_TURNS),
      },
    },
    async (args) => toolResult(await appendTurns(env, args as { handoff_id: string; seq: number; turns: Turn[] })),
  );

  server.registerTool(
    "finish_handoff",
    {
      description:
        "Seal a handoff after every turn has been sent. If anything is missing, nothing is sealed and the response lists the missing chunk seqs and turn indices: re-send them with append_turns and call finish_handoff again. On success returns status delivered or queued.",
      inputSchema: {
        handoff_id: z.string().min(1).max(64),
        total_chunks: z.number().int().min(1).max(MAX_CHUNKS).describe("Number of append_turns chunks (highest seq)."),
        total_turns: z.number().int().min(1).max(10000).describe("Total number of turns sent."),
      },
    },
    async (args) => toolResult(await finishHandoff(env, args, caller)),
  );

  server.registerTool(
    "sync_turns",
    {
      description:
        "Live sync: keep the owner's bot up to date with this conversation, one call per turn. No start/finish and no numbering. " +
        "Lag-by-one pattern: at the start of each reply, before answering, call sync_turns with `turns` = [your previous reply, the user's new message] (on the first message of a chat, just the user's message). " +
        "Use the same `thread_key` every time (this chat's title). Re-sending a turn the server already has is a safe no-op. " +
        "If the response lists `gaps`, keep going; do not re-send older turns out of order. Set flush=true only when the user says \"sync now\". " +
        SYNC_RULES,
      inputSchema: {
        thread_key: z.string().min(1).max(200).describe("Stable name for this chat; use its title and keep it the same on every call."),
        title: z.string().max(200).optional().describe("Conversation title as shown to the user (defaults to thread_key)."),
        project: z.string().max(100).optional().describe("Project or folder name, if the conversation belongs to one."),
        turns: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]).describe("user = the person; assistant = you."),
              text: z.string().describe(`The turn's exact text, or ${SENTINEL} if you cannot see it verbatim.`),
            }),
          )
          .min(1)
          .max(SYNC_MAX_TURNS)
          .describe("Usually two turns, oldest first: your previous reply, then the user's new message."),
        flush: z.boolean().optional().describe("true only when the user asks to sync now: notifies the bot without waiting for the batch window."),
        source: SOURCE_HINT,
      },
    },
    async (args) => toolResult(await syncTurns(env, caller, args as Parameters<typeof syncTurns>[2])),
  );

  server.registerTool(
    "handoff_status",
    {
      description:
        "Show the status of one handoff (with which chunks and turns were received if it is still open), of one live-synced thread (pass thread_key), or of the last 10 handoffs and synced threads. Metadata only, never content.",
      inputSchema: {
        handoff_id: z.string().max(64).optional(),
        thread_key: z.string().max(200).optional().describe("A live-synced thread's thread_key."),
        source: SOURCE_HINT,
      },
    },
    async (args) => toolResult(await handoffStatus(env, caller, args)),
  );

  return server;
}

const MCP_ORIGIN_HOSTS = ["grok.com", "www.grok.com", "x.ai", "www.x.ai", "claude.ai", "localhost", "127.0.0.1"];

// TR-STATE-1: looked up per call (one KV read), not cached in a module-level map, so a deleted or revoked client
// leaves nothing behind in the isolate.
async function sourceForClient(env: Env, clientId: string | null, props: { source?: unknown } | undefined): Promise<Source> {
  if (props && (props.source === "grok" || props.source === "claude" || props.source === "other")) return props.source;
  if (!clientId) return "other";
  const c = await env.OAUTH_PROVIDER.lookupClient(clientId).catch(() => null);
  return sourceFromRedirect(c?.redirectUris?.[0]);
}

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (rateLimited(clientKey(request, "mcp"), 240)) return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
    const x = ctx as ExecutionContext & { auth?: { clientId?: string }; props?: { source?: unknown } };
    const clientId = x.auth?.clientId ?? null;
    const caller: Caller = { clientId, source: await sourceForClient(env, clientId, x.props), ctx };
    const handler = createMcpHandler(() => buildServer(env, caller), {
      route: "/mcp",
      allowedOriginHostnames: [...MCP_ORIGIN_HOSTS, new URL(request.url).hostname],
    });
    return handler(request, env, ctx);
  },
};

// ---------------------------------------------------------------------------
// Pairing code
// ---------------------------------------------------------------------------

interface PairRecord {
  hash: string;
  expires_at: number;
  attempts: number;
}

function newPairCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1e8) * 1e8;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % 1e8).padStart(8, "0");
}

async function mintPairCode(env: Env): Promise<{ code: string; expires_at: string }> {
  const code = newPairCode();
  const rec: PairRecord = { hash: await sha256Hex(`pair:${code}`), expires_at: Date.now() + PAIR_TTL * 1000, attempts: 0 };
  await env.OAUTH_KV.put(K.pair, JSON.stringify(rec), { expirationTtl: PAIR_TTL });
  log("pair_minted");
  return { code, expires_at: new Date(rec.expires_at).toISOString() };
}

async function consumePairCode(env: Env, code: string): Promise<"ok" | "invalid" | "none"> {
  const rec = await env.OAUTH_KV.get<PairRecord>(K.pair, "json");
  if (!rec || rec.expires_at < Date.now()) return "none";
  const clean = code.replace(/\D/g, "");
  if (clean.length === 8 && (await timingSafeEqualStr(await sha256Hex(`pair:${clean}`), rec.hash))) {
    await env.OAUTH_KV.delete(K.pair); // single use
    return "ok";
  }
  rec.attempts++;
  if (rec.attempts >= PAIR_MAX_ATTEMPTS) await env.OAUTH_KV.delete(K.pair);
  else
    await env.OAUTH_KV.put(K.pair, JSON.stringify(rec), {
      expirationTtl: Math.max(60, Math.ceil((rec.expires_at - Date.now()) / 1000)),
    });
  return "invalid";
}

// ---------------------------------------------------------------------------
// Consent page (/authorize)
// ---------------------------------------------------------------------------

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self' https:; frame-ancestors 'none'");
  h.set("referrer-policy", "no-referrer");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>@font-face{font-family:"Instrument Sans";src:url(/assets/sans.woff2) format("woff2");font-weight:400 700;font-stretch:75% 100%;font-display:swap}
:root{--bg:#FBF8F3;--surface:#fff;--ink:#14201F;--soft:#4A5754;--line:#E3DDD2;--teal:#0F6E66;--teal-ink:#fff;--err:#A3261B}
@media (prefers-color-scheme:dark){:root{--bg:#0C1211;--surface:#141C1B;--ink:#EEF3F2;--soft:#A9B6B3;--line:#24302E;--teal:#5FE0CF;--teal-ink:#0C1211;--err:#FF8A80}}
body{font:400 17px/1.55 "Instrument Sans",system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:48px auto;padding:0 20px;color:var(--ink);background:var(--bg)}
.card{border:1px solid var(--line);border-radius:20px;padding:28px;background:var(--surface)}h1{font-size:28px;line-height:1.1;letter-spacing:-.02em;font-weight:650;margin:0 0 12px}.muted{color:var(--soft);font-size:15px}
label{font-weight:600}input[type=text]{font:28px/1.2 ui-monospace,Menlo,monospace;letter-spacing:6px;width:100%;box-sizing:border-box;padding:10px 12px;margin:8px 0 16px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--ink)}
button{font:600 16px "Instrument Sans",system-ui,sans-serif;min-height:44px;padding:10px 18px;border-radius:12px;border:0;background:var(--teal);color:var(--teal-ink);cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}.err{color:var(--err)}:focus-visible{outline:3px solid var(--teal);outline-offset:3px}</style></head>
<body><div class="card">${body}</div></body></html>`;
  return new Response(html, { status, headers: h });
}

function consentForm(handle: string, clientName: string, redirectHost: string, error?: string): string {
  return `<h1>Connect to Threadroost</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants to send conversations to this connector. Access will be sent to <strong>${escapeHtml(redirectHost)}</strong>.</p>
<p class="muted">The client registered itself, so its name is not verified. Only continue if you started this connection yourself.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="client_name" value="${escapeHtml(clientName)}">
<input type="hidden" name="redirect_host" value="${escapeHtml(redirectHost)}">
<label for="code">Pairing code from your bot (8 digits)</label>
<input id="code" type="text" name="code" inputmode="numeric" pattern="[0-9 ]{8,9}" maxlength="9" required autofocus>
<button name="decision" value="approve">Approve</button> <button class="secondary" name="decision" value="deny" formnovalidate>Deny</button>
</form>`;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authReq: AuthRequest = await oauth.parseAuthRequest(request);
      if (!redirectAllowed(authReq.redirectUri, env)) {
        log("authorize", { outcome: "redirect_host_blocked" });
        return page("Not allowed", "<h1>Not allowed</h1><p>This client's redirect address is not on the allowed list.</p>", 400);
      }
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      log("authorize", { outcome: "consent_shown" });
      return page("Connect to Threadroost", consentForm(consent.handle, details.clientName, details.redirectHost), 200, consent.headers);
    }
    if (request.method === "POST") {
      if (rateLimited(clientKey(request, "authorize"), 20)) return page("Slow down", "<h1>Too many attempts</h1><p>Wait a minute.</p>", 429);
      const form = await request.formData();
      const handle = String(form.get("handle") || "");
      const decision = String(form.get("decision") || "");
      if (decision !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        log("authorize", { outcome: "denied" });
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const result = await consumePairCode(env, String(form.get("code") || ""));
      if (result !== "ok") {
        log("authorize", { outcome: result === "none" ? "no_active_code" : "bad_code" });
        const msg =
          result === "none"
            ? `This code is used up or has expired. Each code works once, even if the sign-in failed afterwards, and lasts 10 minutes. ${newLinkHint(env)}, then start the connection again in your app and enter the new code.`
            : "That code is not right. Check it and try again. After 5 wrong tries the code is cancelled.";
        // The consent handle is not consumed, so the user can retry on the same page.
        return page(
          "Connect to Threadroost",
          consentForm(handle, String(form.get("client_name") || "This client"), String(form.get("redirect_host") || ""), msg),
          401,
        );
      }
      const approved = await oauth.approveConsent(request, handle);
      if (!redirectAllowed(approved.request.redirectUri, env)) {
        return page("Not allowed", "<h1>Not allowed</h1><p>Redirect address not allowed.</p>", 400);
      }
      const client = await oauth.lookupClient(approved.request.clientId);
      const scope = approved.request.scope.length ? approved.request.scope : ["courier"];
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: { label: "Threadroost", clientName: client?.clientName ?? "unknown", approved_at: new Date().toISOString() },
        scope,
        props: { owner: true, source: sourceFromRedirect(approved.request.redirectUri) },
      });
      approved.headers.set("location", redirectTo);
      log("authorize", { outcome: "approved" });
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const msg = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      log("authorize", { outcome: "auth_error" });
      return page("Authorization error", `<h1>Authorization error</h1><p>${escapeHtml(msg)}</p><p class="muted">Start the connection again from your client.</p>`, 400);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Bot-side API (pull token)
// ---------------------------------------------------------------------------

/** TR-SEC-3: what the pull token may still do once a separate admin token is set. Exactly what intake.py needs:
 * list, read and ack handoffs, and read the last owner alert. Every other /api/* route needs COURIER_ADMIN_TOKEN. */
const PULL_ROUTES: readonly { method: string; re: RegExp }[] = Object.freeze([
  { method: "GET", re: /^\/api\/handoffs$/ },
  { method: "GET", re: /^\/api\/handoffs\/[a-z0-9]+$/ },
  { method: "POST", re: /^\/api\/handoffs\/[a-z0-9]+\/ack$/ },
  { method: "GET", re: /^\/api\/admin\/alert$/ },
]);

function adminToken(env: Env): string | null {
  return env.COURIER_ADMIN_TOKEN && env.COURIER_ADMIN_TOKEN.length >= 32 ? env.COURIER_ADMIN_TOKEN : null;
}

/** TR-SEC-3 (Bugbot PR #7): after the split the bot can't mint links, so pages point the owner at setup.sh instead. */
function newLinkHint(env: Env): string {
  return adminToken(env)
    ? "Run ./setup.sh --pair on your computer, with --token-file pointing at your admin token, for a new pairing code"
    : "Ask your bot for a new Connect link";
}

/** null = allowed. With no admin token set (older installs), the pull token keeps full access as before. */
async function requireApiToken(request: Request, env: Env, url: URL): Promise<Response | null> {
  const pull = await currentPullToken(env);
  const admin = adminToken(env);
  if (!pull && !admin) return json({ error: "server_not_configured" }, 503);
  const h = request.headers.get("authorization") || "";
  const got = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (got && admin && (await timingSafeEqualStr(got, admin))) return null;
  if (got && pull && (await timingSafeEqualStr(got, pull))) {
    if (!admin) return null;
    if (PULL_ROUTES.some((r) => r.method === request.method && r.re.test(url.pathname))) return null;
    log("api_auth", { outcome: "pull_token_on_admin_route" });
    return json({ error: "admin_token_required", hint: "This route needs the admin token. The pull token can only list, read and ack handoffs." }, 403);
  }
  log("api_auth", { outcome: "denied" });
  return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="courier-api"' });
}

function clientSummary(c: ClientInfo) {
  return {
    client_id: c.clientId,
    client_name: c.clientName ?? null,
    redirect_uris: c.redirectUris,
    token_endpoint_auth_method: c.tokenEndpointAuthMethod,
    registered_at: c.registrationDate ? new Date(c.registrationDate * 1000).toISOString() : null,
  };
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (rateLimited(clientKey(request, "api"), 120)) return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
  const denied = await requireApiToken(request, env, url);
  if (denied) return denied;
  const p = url.pathname;
  const oauth = env.OAUTH_PROVIDER;

  if (p === "/api/pair" && request.method === "POST") return json(await mintPairCode(env));
  if (p === "/api/connect-link" && request.method === "POST") {
    const st = await readBoot(env);
    return json(await mintConnectLink(env, st.origin || url.origin, { fresh: url.searchParams.get("fresh") === "1" }));
  }

  if (p === "/api/handoffs" && request.method === "GET") {
    const want = url.searchParams.get("status") || "pending";
    const all = await listMetas(env);
    let items = all.filter((i) =>
      want === "all" ? true : want === "pending" ? i.s === "queued" || i.s === "delivered" : i.s === want,
    );
    // KV list metadata lags behind writes. Confirm each candidate's current status (status=all included, so a
    // just-filed handoff never shows as "open").
    const fresh = await Promise.all(items.slice(0, 50).map((i) => getMeta(env, i.id)));
    const ok = (m: HandoffMeta | null) =>
      !!m && (want === "all" ? true : want === "pending" ? m.status === "queued" || m.status === "delivered" : m.status === want);
    items = items
      .slice(0, 50)
      .map((i, n) => (fresh[n] ? { ...i, s: fresh[n]!.status, n: fresh[n]!.total_turns ?? null } : i))
      .filter((_, n) => ok(fresh[n]));
    return json({ handoffs: items.map((i) => ({ handoff_id: i.id, title: i.t, status: i.s, turns: i.n, created_at: i.c })) });
  }

  const mGet = p.match(/^\/api\/handoffs\/([a-z0-9]+)$/);
  if (mGet && request.method === "GET") {
    const m = await getMeta(env, mGet[1]);
    if (!m) return json({ error: "not_found" }, 404);
    if (m.status === "open") return json({ error: "not_sealed", handoff: publicMeta(m) }, 409);
    if (m.status === "filed") return json({ error: "already_filed", handoff: publicMeta(m) }, 410);
    // Concatenate stored chunk JSON without re-parsing (keeps CPU low for large handoffs).
    const raws = await Promise.all(
      Array.from({ length: m.total_chunks! }, (_, i) => env.OAUTH_KV.get(K.chunk(m.id, i + 1), "text")),
    );
    const missing = raws.map((r, i) => (r === null ? i + 1 : 0)).filter(Boolean);
    if (missing.length) return json({ error: "content_missing", missing_chunks: missing, handoff: publicMeta(m) }, 500);
    const chunks = raws.map((r, i) => `{"seq":${i + 1},"sha256":${JSON.stringify(m.chunk_hashes![i])},"turns":${r}}`);
    const body = `{"handoff":${JSON.stringify(publicMeta(m))},"hash_scheme":"chunk sha256 = sha256(utf8(turns JSON as stored)); handoff sha256 = sha256(chunk sha256 hex joined by \\n)","chunks":[${chunks.join(",")}]}`;
    log("api_get", { id: m.id });
    return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }

  const mAck = p.match(/^\/api\/handoffs\/([a-z0-9]+)\/ack$/);
  if (mAck && request.method === "POST") {
    const m = await getMeta(env, mAck[1]);
    if (!m) return json({ error: "not_found" }, 404);
    if (m.status === "open") return json({ error: "not_sealed" }, 409);
    // Already filed: a repeat ack (bot retry, two intake runs) changes nothing, so the first verdict and time stand.
    if (m.status === "filed") return json({ ok: true, handoff: publicMeta(m), content_deleted: true, already_filed: true });
    let verdict = "unspecified";
    try {
      const b = (await request.json()) as { verdict?: unknown };
      if (typeof b.verdict === "string") verdict = b.verdict.slice(0, 40);
    } catch {
      /* empty body is fine */
    }
    const keys = new Set<string>();
    for (let i = 1; i <= (m.total_chunks ?? 0); i++) keys.add(K.chunk(m.id, i));
    const listed = await env.OAUTH_KV.list({ prefix: K.chunkPrefix(m.id) });
    for (const k of listed.keys) keys.add(k.name);
    await Promise.all([...keys].map((k) => env.OAUTH_KV.delete(k)));
    m.status = "filed";
    m.verdict = verdict;
    m.acked_at = new Date().toISOString();
    delete m.chunk_hashes;
    await putMeta(env, m, META_TTL_AFTER_ACK);
    log("api_ack", { id: m.id, deleted: keys.size });
    return json({ ok: true, handoff: publicMeta(m), content_deleted: true });
  }

  if (p === "/api/admin/clients" && request.method === "GET") {
    const out: ReturnType<typeof clientSummary>[] = [];
    let cursor: string | undefined;
    do {
      const r = await oauth.listClients({ cursor, limit: 100 });
      out.push(...r.items.map(clientSummary));
      cursor = r.cursor;
    } while (cursor);
    return json({ clients: out });
  }

  if (p === "/api/admin/clients" && request.method === "POST") {
    // Pre-registered client, for clients that ask for a Client ID instead of using DCR.
    let b: { client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string };
    try {
      b = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every((u) => redirectAllowed(u, env)))
      return json({ error: "redirect_uri_not_allowed", allowed_hosts: allowedRedirectHosts(env), allowed_uris: allowedRedirectUris(env) }, 400);
    const method = b.token_endpoint_auth_method || "none";
    if (!["none", "client_secret_basic", "client_secret_post"].includes(method))
      return json({ error: "unsupported_token_endpoint_auth_method" }, 400);
    const c = await oauth.createClient({
      clientName: String(b.client_name || "Pre-registered client").slice(0, 100),
      redirectUris: uris,
      tokenEndpointAuthMethod: method,
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    log("admin_client_created", { method });
    // client_secret (confidential clients only) is returned once here and never again.
    return json({ ...clientSummary(c), client_secret: c.clientSecret ?? null }, 201);
  }

  const mDel = p.match(/^\/api\/admin\/clients\/([^/]+)$/);
  if (mDel && request.method === "DELETE") {
    const id = decodeURIComponent(mDel[1]);
    const c = await oauth.lookupClient(id);
    if (!c) return json({ error: "not_found" }, 404);
    await oauth.deleteClient(id);
    log("admin_client_deleted");
    return json({ ok: true, deleted: id });
  }

  if (p === "/api/admin/revoke-all" && request.method === "POST") {
    let n = 0;
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const r = await oauth.listClients({ cursor, limit: 100 });
      ids.push(...r.items.map((c) => c.clientId));
      cursor = r.cursor;
    } while (cursor);
    for (const id of ids) {
      await oauth.deleteClient(id); // also revokes that client's grants and tokens
      n++;
    }
    await env.OAUTH_KV.delete(K.pair);
    log("admin_revoke_all", { clients: n });
    return json({ ok: true, clients_deleted: n, pairing_code_cleared: true });
  }

  if (p === "/api/admin/probe-webhook" && request.method === "POST") {
    // Sends {"event":"probe"} through the same path as handoff notices; the bot should stay silent.
    return json({ webhook: await postWebhook(env, { event: "probe" }) });
  }

  if (p === "/api/admin/alert" && request.method === "GET") {
    // Last owner alert (metadata and plain-words message only). The intake reads it on every pull.
    const a = (await env.OAUTH_KV.get(K.alert, "json")) as AlertRecord | null;
    const wh = ((await env.OAUTH_KV.get(K.whHealth, "json")) as WebhookHealth | null) ?? { failures: 0 };
    const pub = a ? (({ fingerprint: _f, sent_at: _s, ...rest }) => rest)(a) : null;
    return json({ alert: pub, webhook_consecutive_failures: wh.failures });
  }

  if (p === "/api/admin/dcr-log" && request.method === "GET") {
    return json({ registrations: (await env.OAUTH_KV.get(K.dcrLog, "json")) ?? [] });
  }

  return json({ error: "not_found" }, 404);
}


// ---------------------------------------------------------------------------
// Zero-copy setup: auto pull token, bot claim link, Connect page
// ---------------------------------------------------------------------------
// Trust model: the only channel the owner already secured is the bot webhook (URL + key pasted at deploy).
// So the Worker sends a single-use claim code there; the bot redeems it for the pull token. The Connect page
// link is minted only with the pull token, so only the bot can hand it to the owner.

interface BootState {
  origin?: string;
  claimed_at?: string;
  claim_sent_at?: number;
  claimed_via?: "claim" | "legacy_token";
  reclaim?: boolean;
}
interface SecretRecord {
  hash: string;
  expires_at: number;
  attempts: number;
  minted_at?: number;
  t?: string; // Connect links only: kept so a repeat request inside the reuse window returns the same link
}

function randomSecret(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The pull token in force: an explicit secret (setup.sh, older installs) wins, else the auto-generated one. */
async function currentPullToken(env: Env): Promise<string | null> {
  if (env.COURIER_PULL_TOKEN && env.COURIER_PULL_TOKEN.length >= 32) return env.COURIER_PULL_TOKEN;
  const t = await env.OAUTH_KV.get(K.autoPull);
  return t && t.length >= 32 ? t : null;
}

async function ensurePullToken(env: Env): Promise<string> {
  const have = await currentPullToken(env);
  if (have) return have;
  const t = randomSecret(32); // 256 bits, never logged
  await env.OAUTH_KV.put(K.autoPull, t);
  return t;
}

async function readBoot(env: Env): Promise<BootState> {
  const st = (await env.OAUTH_KV.get(K.boot, "json")) as BootState | null;
  if (st) return st;
  // Upgrade from v1.1 or earlier: no boot record, but an explicit COURIER_PULL_TOKEN secret means the owner already gave
  // the bot its token. Treat the install as claimed so the bot is not sent a claim link and /health stays green.
  // (./setup.sh --reclaim writes {"reclaim":true} rather than deleting the key, so a deliberate reclaim still works.)
  if (env.COURIER_PULL_TOKEN && env.COURIER_PULL_TOKEN.length >= 32) {
    const migrated: BootState = { claimed_at: new Date().toISOString(), claimed_via: "legacy_token" };
    await env.OAUTH_KV.put(K.boot, JSON.stringify(migrated));
    log("boot_migrated", { from: "legacy_token" });
    return migrated;
  }
  return {};
}

/** First-boot work: make the pull token and send the bot a claim link. Cheap no-op once claimed. */
async function ensureBootstrap(env: Env, origin?: string): Promise<void> {
  const st = await readBoot(env);
  let dirty = false;
  if (origin && st.origin !== origin && /^https:\/\//.test(origin)) {
    st.origin = origin;
    dirty = true;
  }
  const o = st.origin || (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : undefined);
  const now = Date.now();
  if (st.claimed_at || !o || !env.GROKBOT_WEBHOOK_URL || !env.GROKBOT_WEBHOOK_KEY || (st.claim_sent_at && now - st.claim_sent_at < CLAIM_RESEND_SECONDS * 1000)) {
    if (dirty) await env.OAUTH_KV.put(K.boot, JSON.stringify(st));
    return;
  }
  await ensurePullToken(env);
  const code = randomSecret(32);
  const ttl = Math.min(CLAIM_TTL, Math.max(5, Number(env.CLAIM_TTL_SECONDS) || CLAIM_TTL));
  const rec: SecretRecord = { hash: await sha256Hex(`claim:${code}`), expires_at: now + ttl * 1000, attempts: 0 };
  await env.OAUTH_KV.put(K.claim, JSON.stringify(rec), { expirationTtl: Math.max(60, ttl) });
  st.claim_sent_at = now;
  await env.OAUTH_KV.put(K.boot, JSON.stringify(st));
  const r = await postWebhook(env, {
    event: "threadroost.claim",
    worker_url: o,
    claim_url: `${o}/claim`,
    claim_code: code,
    expires_at: new Date(rec.expires_at).toISOString(),
    how: 'POST {"code": claim_code} as JSON to claim_url within 15 minutes. Single use. The response holds your pull_token and a connect_url to send your owner.',
  });
  log("claim_sent", { ok: r.ok, http_status: r.http_status });
  if (!r.ok) {
    st.claim_sent_at = now - (CLAIM_RESEND_SECONDS - 60) * 1000; // retry in about a minute
    await env.OAUTH_KV.put(K.boot, JSON.stringify(st));
  }
}

async function checkSecret(env: Env, key: string, prefix: string, given: string, maxAttempts: number, consume: boolean): Promise<"ok" | "invalid" | "none"> {
  const rec = (await env.OAUTH_KV.get(key, "json")) as SecretRecord | null;
  if (!rec || rec.expires_at < Date.now()) return "none";
  if (given.length >= 16 && given.length <= 128 && (await timingSafeEqualStr(await sha256Hex(`${prefix}:${given}`), rec.hash))) {
    if (consume) await env.OAUTH_KV.delete(key);
    return "ok";
  }
  rec.attempts++;
  if (rec.attempts >= maxAttempts) await env.OAUTH_KV.delete(key);
  else await env.OAUTH_KV.put(key, JSON.stringify(rec), { expirationTtl: Math.max(60, Math.ceil((rec.expires_at - Date.now()) / 1000)) });
  return "invalid";
}

/**
 * One live Connect link at a time. A repeat request inside the reuse window returns the same unused link, so a bot
 * (or a retry) asking twice can't silently invalidate the link the owner is about to open. fresh=true forces a new one.
 */
async function mintConnectLink(
  env: Env,
  origin: string,
  opts: { fresh?: boolean } = {},
): Promise<{ connect_url: string; expires_at: string; reused: boolean }> {
  const now = Date.now();
  if (!opts.fresh) {
    const cur = (await env.OAUTH_KV.get(K.connect, "json")) as SecretRecord | null;
    const win = envSeconds(env.CONNECT_REUSE_SECONDS, CONNECT_REUSE) * 1000;
    if (cur && cur.t && cur.attempts === 0 && cur.minted_at && now - cur.minted_at < win && cur.expires_at - now > 120_000) {
      log("connect_link_reused");
      return { connect_url: `${origin}/connect?t=${cur.t}`, expires_at: new Date(cur.expires_at).toISOString(), reused: true };
    }
  }
  const prev = (await env.OAUTH_KV.get(K.connect, "json")) as SecretRecord | null;
  if (prev && prev.expires_at > now) {
    const old = ((await env.OAUTH_KV.get(K.connectOld, "json")) as string[] | null) ?? [];
    await env.OAUTH_KV.put(K.connectOld, JSON.stringify([prev.hash, ...old].slice(0, 5)), { expirationTtl: CONNECT_TTL });
  }
  const t = randomSecret(24);
  const rec: SecretRecord = { hash: await sha256Hex(`connect:${t}`), expires_at: now + CONNECT_TTL * 1000, attempts: 0, minted_at: now, t };
  await env.OAUTH_KV.put(K.connect, JSON.stringify(rec), { expirationTtl: CONNECT_TTL });
  log("connect_link_minted");
  return { connect_url: `${origin}/connect?t=${t}`, expires_at: new Date(rec.expires_at).toISOString(), reused: false };
}

async function handleClaim(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed", hint: "POST {\"code\": \"...\"} as JSON." }, 405);
  if (rateLimited(clientKey(request, "claim"), 10)) return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
  let code = "";
  try {
    const b = (await request.json()) as { code?: unknown };
    code = typeof b.code === "string" ? b.code.trim() : "";
  } catch {
    /* empty or bad JSON */
  }
  const st = await readBoot(env);
  if (st.claimed_at) {
    log("claim", { outcome: "already_claimed" });
    return json({ error: "already_claimed", hint: "This Worker's token was already claimed. To start over, run ./setup.sh --reclaim." }, 410);
  }
  const r = await checkSecret(env, K.claim, "claim", code, CLAIM_MAX_ATTEMPTS, true);
  if (r === "none") {
    log("claim", { outcome: "expired" });
    return json({ error: "claim_expired", hint: "A fresh claim link is sent to your bot within 10 minutes." }, 410);
  }
  if (r === "invalid") {
    log("claim", { outcome: "denied" });
    return json({ error: "invalid_code" }, 401);
  }
  st.claimed_at = new Date().toISOString();
  await env.OAUTH_KV.put(K.boot, JSON.stringify(st));
  const token = await ensurePullToken(env);
  const origin = st.origin || url.origin;
  const link = await mintConnectLink(env, origin, { fresh: true });
  log("claim", { outcome: "ok" });
  return json({ pull_token: token, worker_url: origin, mcp_url: `${origin}/mcp`, ...link });
}

const SYNC_INSTRUCTION = `Threadroost live sync is on for this project. At the start of every reply, before you answer, call the Threadroost tool sync_turns:
- thread_key: on the first message of a chat, make one up: 3–5 words about the topic plus 4 random letters (for example "garden layout ideas qmvt"). Use exactly the same thread_key for every later call in this chat. Copy it from your previous sync_turns call. If the first call's response says new_thread: false, pick a different thread_key and call again.
- turns: (1) your previous reply, then (2) my new message, each copied exactly, character for character, including code blocks, tables and formatting. On the first message of a chat, send only my message.

Never summarize, shorten or fix anything you send. If you cannot see a turn exactly, send [TURN NOT AVAILABLE VERBATIM] for it instead. Don't mention the sync in your answer unless a call fails. Then say so in one line and keep going. If the response says turns are missing after its last stored turn, include those turns, in order, in your next call. When I say "sync now", call sync_turns with your latest reply and flush set to true.`;

function brandPage(title: string, body: string, nonce: string, status = 200): Response {
  const h = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src 'self'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  });
  const logo = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Threadroost</title><link rel="icon" href="${logo}">
<style>
@font-face{font-family:"Instrument Sans";src:url(/assets/sans.woff2) format("woff2");font-weight:400 700;font-stretch:75% 100%;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/assets/mono.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{--bg:#FBF8F3;--surface:#fff;--ink:#14201F;--soft:#4A5754;--line:#E3DDD2;--teal:#0F6E66;--teal-ink:#fff;--wash:#E8F3F1;--sand:#F3EDE3;--warn:#8A4B0F}
@media (prefers-color-scheme:dark){:root{--bg:#0C1211;--surface:#141C1B;--ink:#EEF3F2;--soft:#A9B6B3;--line:#24302E;--teal:#5FE0CF;--teal-ink:#0C1211;--wash:#11302B;--sand:#1A2221;--warn:#F2B66D}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:400 18px/1.55 "Instrument Sans",ui-sans-serif,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 24px 64px}
header{display:flex;align-items:center;gap:10px;font-weight:650;font-size:18px;margin-bottom:48px}header img{width:28px;height:28px;border-radius:7px}
h1{font-size:44px;line-height:1;letter-spacing:-.03em;font-weight:650;font-stretch:88%;margin:0 0 16px}
.lede{color:var(--soft);font-size:20px;margin:0 0 32px}
.mono{font-family:"Geist Mono",ui-monospace,Menlo,monospace}
.step{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:24px;margin:0 0 16px}
.step h2{font-size:18px;margin:0 0 8px;display:flex;gap:12px;align-items:center}
.n{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--teal);color:var(--teal-ink);font-size:15px}
.step p{margin:0 0 16px;color:var(--soft);font-size:16px}
.code{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:44px;letter-spacing:.12em;font-weight:500;margin:4px 0 8px}
.field{display:flex;gap:8px;align-items:stretch}
.field output,.field pre{flex:1;min-width:0;margin:0;padding:12px 14px;border-radius:12px;background:var(--sand);font:14px/1.5 "Geist Mono",ui-monospace,monospace;overflow-wrap:anywhere;white-space:pre-wrap}
pre{max-height:140px;overflow:auto}
.field output.code{font-size:40px;letter-spacing:.12em;font-weight:500;padding:10px 16px}
.field button{align-self:flex-start}
button,.btn{font:600 16px "Instrument Sans",system-ui,sans-serif;padding:12px 18px;border-radius:12px;border:0;background:var(--teal);color:var(--teal-ink);cursor:pointer;min-height:44px}
button.ghost{background:transparent;color:var(--teal);border:2px solid var(--teal)}
:focus-visible{outline:3px solid var(--teal);outline-offset:3px}
.timer{font-size:15px;color:var(--soft)}.timer.low{color:var(--warn);font-weight:600}
.note{font-size:15px;color:var(--soft)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:520px){h1{font-size:36px}.field output.code{font-size:34px}.field{flex-direction:column}.field button{align-self:stretch}}
</style></head><body><main><header><img src="${logo}" alt="">Threadroost</header>${body}</main></body></html>`;
  return new Response(html, { status, headers: h });
}

function fontResponse(b64: string): Response {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
}

function copyScript(nonce: string, expiresAt?: number, hint = "Ask your bot for a new Connect link"): string {
  return `<script nonce="${nonce}">
document.querySelectorAll("[data-copy]").forEach(function(b){b.addEventListener("click",function(){var t=document.getElementById(b.getAttribute("data-copy")).textContent;navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent="Copied";document.getElementById("live").textContent="Copied to clipboard";setTimeout(function(){b.textContent=o},1600)})})});
${expiresAt ? `(function(){var end=${expiresAt},el=document.getElementById("timer"),live=document.getElementById("live"),warned=false;function tick(){var s=Math.max(0,Math.round((end-Date.now())/1000));if(s===0){el.textContent=${JSON.stringify(`This code has expired. ${hint}.`)};el.className="timer low";live.textContent=el.textContent;document.getElementById("code").style.opacity=".35";return}var m=Math.floor(s/60),r=("0"+s%60).slice(-2);el.textContent="Expires in "+m+":"+r;if(s<=60){el.className="timer low";if(!warned){warned=true;live.textContent="One minute left on your pairing code"}}setTimeout(tick,1000)}tick()})();` : ""}
</script>`;
}

async function handleConnect(request: Request, env: Env, url: URL): Promise<Response> {
  const nonce = randomSecret(16);
  if (rateLimited(clientKey(request, "connect"), 20)) return brandPage("Slow down", `<h1>Too many tries.</h1><p class="lede">Wait a minute, then open your Connect link again.</p>`, nonce, 429);
  const expired = brandPage("Link expired", `<h1>This link has expired.</h1><p class="lede">Connect links work once and last 15 minutes. ${newLinkHint(env)}.</p>`, nonce, 410);
  const superseded = brandPage("Newer link issued", `<h1>A newer link was issued.</h1><p class="lede">Your bot sent a newer Connect link, which replaced this one. Use the latest link in your bot's chat.</p>`, nonce, 410);
  const isSuperseded = async (t: string) => {
    if (!t) return false;
    const old = ((await env.OAUTH_KV.get(K.connectOld, "json")) as string[] | null) ?? [];
    const h = await sha256Hex(`connect:${t}`);
    for (const o of old) if (await timingSafeEqualStr(o, h)) return true;
    return false;
  };
  if (request.method === "GET") {
    // GET never spends the token (link previews and prefetchers only GET). Only the button's POST redeems it.
    const t = url.searchParams.get("t") || "";
    const rec = (await env.OAUTH_KV.get(K.connect, "json")) as SecretRecord | null;
    const live = !!t && !!rec && rec.expires_at >= Date.now() && (await timingSafeEqualStr(await sha256Hex(`connect:${t}`), rec.hash));
    if (!live) return (await isSuperseded(t)) ? superseded : expired;
    // No secret is spent on GET, so link previews can't burn it. The button below does.
    return brandPage("Connect", `<h1>Connect SuperGrok.</h1><p class="lede">One click shows a pairing code that works once, for 10 minutes. Have grok.com open.</p>
<form method="post" action="/connect"><input type="hidden" name="t" value="${escapeHtml(t)}"><button>Show my pairing code</button></form>`, nonce);
  }
  if (request.method !== "POST") return expired;
  const form = await request.formData().catch(() => null);
  const t = String(form?.get("t") ?? "");
  if (await isSuperseded(t)) {
    log("connect", { outcome: "superseded" });
    return superseded;
  }
  const r = await checkSecret(env, K.connect, "connect", t, 5, true);
  if (r !== "ok") {
    log("connect", { outcome: r === "none" ? "expired" : "denied" });
    return expired;
  }
  const st = await readBoot(env);
  const origin = st.origin || url.origin;
  const pair = await mintPairCode(env);
  const exp = Date.parse(pair.expires_at);
  log("connect", { outcome: "ok" });
  const code = `${pair.code.slice(0, 4)} ${pair.code.slice(4)}`;
  return brandPage("Connect", `<h1>Connect SuperGrok.</h1><p class="lede">Three copies and you’re live. This page works once, so keep it open.</p>
<p id="live" class="sr" aria-live="polite"></p>
<section class="step"><h2><span class="n">1</span>Add the connector</h2><p>In grok.com, open Connectors, then New Connector, then Custom. Paste this link.</p>
<div class="field"><output id="mcp">${escapeHtml(origin)}/mcp</output><button data-copy="mcp">Copy</button></div></section>
<section class="step"><h2><span class="n">2</span>Enter your pairing code</h2><p>Grok opens a Threadroost sign-in page. Type this code there and click Approve.</p>
<div class="field"><output id="code" class="code">${code}</output><button data-copy="code">Copy</button></div><p id="timer" class="timer">Expires in 10:00</p></section>
<section class="step"><h2><span class="n">3</span>Turn on live sync</h2><p>Make a SuperGrok Project, open its Instructions and paste this. Chats in that Project now reach your bot.</p>
<div class="field"><pre id="ins">${escapeHtml(SYNC_INSTRUCTION)}</pre><button data-copy="ins">Copy</button></div></section>
<p class="note">Using Claude too? Add the same link in Claude under Connectors, then say “log this” in any chat you want kept. </p>
<p class="note"><b>The code works once.</b> If the sign-in fails or you close the window after entering it, the code is used up. ${adminToken(env) ? newLinkHint(env) : "Ask your bot for a new Connect link (for example: “send me a new Threadroost link”)"}, then add the connector again.</p>
${copyScript(nonce, exp, newLinkHint(env))}`, nonce);
}

function runningPage(): Response {
  const nonce = randomSecret(16);
  return brandPage("Running", `<h1>Threadroost is running.</h1><p class="lede">Your bot gets a setup message within a minute. It will send you a Connect link to finish.</p><p class="note">Nothing to do here. You can close this tab.</p>`, nonce);
}

// ---------------------------------------------------------------------------
// Default handler (everything except /mcp and the provider's own endpoints)
// ---------------------------------------------------------------------------

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (url.pathname === "/claim") return handleClaim(request, env, url);
    if (url.pathname === "/connect") return handleConnect(request, env, url);
    if (url.pathname === "/assets/sans.woff2") return fontResponse(FONT_SANS_B64);
    if (url.pathname === "/assets/mono.woff2") return fontResponse(FONT_MONO_B64);
    if (url.pathname === "/health" && request.method === "GET") {
      await ensureBootstrap(env, url.origin);
      const st = await readBoot(env);
      return json({ ok: true, version: VERSION, webhook_configured: !!(env.GROKBOT_WEBHOOK_URL && env.GROKBOT_WEBHOOK_KEY), bot_connected: !!st.claimed_at, admin_token_split: !!adminToken(env) });
    }
    if (url.pathname === "/" && request.method === "GET") await ensureBootstrap(env, url.origin);
    if (url.pathname === "/" && request.method === "GET" && (request.headers.get("accept") || "").includes("text/html")) return runningPage();
    if (url.pathname === "/" && request.method === "GET")
      return new Response(`Threadroost ${VERSION}. MCP endpoint: ${url.origin}/mcp\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    return json({ error: "not_found" }, 404);
  },
};

// ---------------------------------------------------------------------------
// OAuth provider (built per origin so the same code runs on any hostname)
// ---------------------------------------------------------------------------

async function recordDcr(env: Env, meta: Record<string, unknown>, allowed: boolean): Promise<void> {
  const entry = {
    at: new Date().toISOString(),
    allowed,
    redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris.map(String).slice(0, 10) : [],
    client_name: typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : null,
    token_endpoint_auth_method: meta.token_endpoint_auth_method ?? null,
    grant_types: meta.grant_types ?? null,
    response_types: meta.response_types ?? null,
    scope: meta.scope ?? null,
  };
  console.log(JSON.stringify({ evt: "dcr", ...entry }));
  const prev = ((await env.OAUTH_KV.get(K.dcrLog, "json")) as unknown[] | null) ?? [];
  await env.OAUTH_KV.put(K.dcrLog, JSON.stringify([...prev, entry].slice(-20)));
}

// TR-STATE-1: built per request. A cached provider kept the first request's env in its registration callback
// and grew one entry per Host header the isolate ever saw.
function providerFor(origin: string, env: Env): OAuthProvider<Env> {
  const p = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["courier"],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "Threadroost",
    },
    clientRegistrationCallback: async ({ clientMetadata }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris.map(String) : [];
      const allowed = uris.length > 0 && uris.every((u) => redirectAllowed(u, env));
      await recordDcr(env, clientMetadata, allowed);
      if (!allowed)
        return {
          code: "invalid_redirect_uri",
          description: `redirect_uris must be ${redirectRuleText(env)}.`,
        };
    },
    onError: ({ code, status }) => {
      log("oauth_error", { code, status });
    },
  });
  return p;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/oauth/register" && rateLimited(clientKey(request, "dcr"), 20))
      return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
    // Compatibility aliases: some clients probe origin-level or path-suffixed discovery URLs.
    const alias: Record<string, string> = {
      "/.well-known/oauth-protected-resource": "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/mcp": "/.well-known/oauth-authorization-server",
    };
    if (request.method === "GET" && alias[url.pathname]) {
      const target = new URL(alias[url.pathname], url.origin);
      return providerFor(url.origin, env).fetch(new Request(target, request), env, ctx);
    }
    if (url.pathname.startsWith("/mcp") && /^Bearer\s+\S{20,}/i.test(request.headers.get("authorization") || "")) {
      // A grant written at another Cloudflare location can take a moment to reach this one, so the very first call
      // after pairing may see the token as unknown (TR-OBS-1). Retry once, briefly, before answering 401.
      const second = request.clone();
      const res = await providerFor(url.origin, env).fetch(request, env, ctx);
      if (res.status !== 401) return res;
      await res.body?.cancel();
      await sleep(MCP_AUTH_RETRY_MS);
      const again = await providerFor(url.origin, env).fetch(second, env, ctx);
      log("mcp_auth_retry", { ok: again.status !== 401 });
      return again;
    }
    return providerFor(url.origin, env).fetch(request, env, ctx);
  },
  // Cron trigger (wrangler.jsonc "triggers.crons"): flush live-sync threads that went quiet, sweep abandoned handoffs.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(flushIdleStreams(env));
    ctx.waitUntil(sweepAbandonedHandoffs(env));
    ctx.waitUntil(renotifyQueued(env).then(() => checkAlerts(env)).catch((e) => log("alert_error", { error: String(e).slice(0, 120) })));
    ctx.waitUntil(ensureBootstrap(env));
  },
} satisfies ExportedHandler<Env>;
