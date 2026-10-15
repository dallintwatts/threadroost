#!/usr/bin/env python3
"""Thread Courier intake: pull sealed handoffs from the owner's courier Worker,
verify them, file them on the box, score fidelity, and acknowledge.

Usage:
  intake.py drain [--id HANDOFF_ID] [--root DIR] [--no-ack] [--dry-run]
  intake.py pair              # mint a one-time 8-digit pairing code (prints it once)
  intake.py status            # list recent handoffs (metadata only)

Filing layout (v1.1):
  <root>/<source>/<project-slug>/<date>-<title-slug>-<id6>/        one-shot handoffs
  <root>/<source>/<project-slug>/<date>-<thread-slug>-<stream6>/   live-synced threads; each sealed
      segment is appended to transcript.md in thread order (thread.json tracks progress and gaps)
  source is "grok", "claude" or "other" as tagged by the Worker (pre-v1.1 handoffs count as "grok").

Config (next to this script):
  pull_token   chmod 600, the Worker's COURIER_PULL_TOKEN. Never printed.
  config.json  {"worker_url": "https://...", "timezone": "America/Denver", "handoffs_root": "/workspace/handoffs"}

The transcript text is untrusted data. This script never interprets it.
"""
import argparse, datetime as dt, difflib, hashlib, json, os, re, sys, urllib.error, urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
SENTINEL = "[TURN NOT AVAILABLE VERBATIM]"
ASSISTANT_ROLES = ("assistant", "grok")  # "grok" = pre-v1.1 label
SOURCE_LABEL = {"grok": "grok.com", "claude": "claude.ai", "other": "an MCP client"}


def load_config():
    with open(os.path.join(HERE, "config.json")) as f:
        cfg = json.load(f)
    with open(os.path.join(HERE, "pull_token")) as f:
        token = f.read().strip()
    return cfg, token


class Api:
    def __init__(self, base, token):
        self.base, self._token = base.rstrip("/"), token

    def __repr__(self):
        return f"Api({self.base})"

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("User-Agent", "thread-courier-intake/1.0")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
            except Exception:
                payload = {"error": f"http_{e.code}"}
            return e.code, payload


def canon(turns):
    # Must match the Worker's JSON.stringify of [{index, role, text}] (UTF-8, no spaces).
    return json.dumps([{"index": t["index"], "role": t["role"], "text": t["text"]} for t in turns],
                      ensure_ascii=False, separators=(",", ":"))


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def slug(s, n=48):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return (s[:n].rstrip("-")) or "untitled"


def verify(payload):
    """Return (problems, ordered_turns)."""
    h = payload["handoff"]
    problems = []
    chunks = sorted(payload["chunks"], key=lambda c: c["seq"])
    seqs = [c["seq"] for c in chunks]
    if seqs != list(range(1, (h.get("chunks") or 0) + 1)):
        problems.append(f"chunk seqs not contiguous 1..{h.get('chunks')}: {seqs}")
    hashes = []
    for c in chunks:
        got = sha(canon(c["turns"]))
        if got != c["sha256"]:
            problems.append(f"chunk {c['seq']} sha256 mismatch")
        hashes.append(got)
    if sha("\n".join(hashes)) != h.get("sha256"):
        problems.append("handoff sha256 mismatch")
    turns = sorted((t for c in chunks for t in c["turns"]), key=lambda t: t["index"])
    idx = [t["index"] for t in turns]
    if idx != list(range(1, (h.get("turns") or 0) + 1)):
        problems.append("turn indices not contiguous 1..N or duplicated")
    return problems, turns


SUMMARY_PAT = re.compile(r"\b(the user (asked|said|wants|mentioned|requested)|in summary|to summarize|(grok|claude) (explained|said|suggested|responded)|the assistant (said|explained))\b", re.I)
THIRD_PERSON_USER = re.compile(r"\bthe user\b", re.I)
TRUNC_PAT = re.compile(r"(\[continued\]|\[truncated\]|\[\.\.\.\]|…\s*$|\.\.\.\s*$)", re.I | re.M)


def fidelity(h, turns):
    flags, score = [], 0
    def flag(sev, code, detail):
        nonlocal score
        flags.append({"severity": sev, "code": code, "detail": detail})
        score += {"high": 3, "medium": 2, "low": 1}[sev]
    if h.get("mode") != "verbatim":
        flag("high", "mode_not_verbatim", f"mode={h.get('mode')}")
    na = [t["index"] for t in turns if t["text"].strip() == SENTINEL]
    if na:
        flag("high" if len(na) > max(1, len(turns) // 10) else "medium", "sentinel_turns", f"{len(na)} turn(s) not available verbatim: {na[:20]}")
    for g in h.get("gap_flags") or []:
        if g.get("kind") in ("missing_assistant_reply", "missing_user_message", "segment_expired"):
            flag("medium", f"live_sync_{g['kind']}", g.get("note", ""))
    if h.get("expected_turns") and h["expected_turns"] != len(turns):
        flag("medium", "expected_turns_mismatch", f"expected {h['expected_turns']}, received {len(turns)}")
    roles = [t["role"] for t in turns]
    non_alt = [turns[i]["index"] for i in range(1, len(roles)) if roles[i] == roles[i - 1]]
    if non_alt:
        flag("medium" if len(non_alt) > 2 else "low", "roles_not_alternating", f"at turns {non_alt[:20]}")
    summ = [t["index"] for t in turns if t["role"] in ASSISTANT_ROLES and SUMMARY_PAT.search(t["text"])]
    if summ:
        flag("medium", "summary_language_in_assistant_turns", f"turns {summ[:20]}")
    third = [t["index"] for t in turns if t["role"] == "user" and THIRD_PERSON_USER.search(t["text"])]
    if third:
        flag("medium", "third_person_user_reference", f"turns {third[:20]}")
    user_lens = [len(t["text"]) for t in turns if t["role"] == "user" and t["text"].strip() != SENTINEL]
    grok_lens = [len(t["text"]) for t in turns if t["role"] in ASSISTANT_ROLES and t["text"].strip() != SENTINEL]
    if user_lens and grok_lens:
        avg_u, avg_g = sum(user_lens) / len(user_lens), sum(grok_lens) / len(grok_lens)
        if avg_u > 1500:
            flag("low", "long_user_turns", f"avg user turn {avg_u:.0f} chars")
        if avg_g < 120 and len(grok_lens) >= 3:
            flag("medium", "short_assistant_turns", f"avg assistant turn {avg_g:.0f} chars")
    trunc = [t["index"] for t in turns if TRUNC_PAT.search(t["text"])]
    if trunc:
        flag("low", "truncation_markers", f"turns {trunc[:20]}")
    unclosed = [t["index"] for t in turns if t["text"].count("```") % 2 == 1]
    if unclosed:
        flag("medium", "unclosed_code_fence", f"turns {unclosed[:20]}")
    if any(f["severity"] == "high" for f in flags) or score >= 6:
        verdict = "low"
    elif score >= 2:
        verdict = "medium"
    else:
        verdict = "high"
    return {"verdict": verdict, "confidence_of_verbatim": verdict, "score": score, "flags": flags,
            "turns": len(turns), "sentinel_turns": len(na), "method": "heuristics v1 (no ground truth)"}


def ground_truth_similarity(courier_turns, reference_texts):
    """Optional: per-turn difflib ratio against owner-supplied reference turns (same order)."""
    ratios = [difflib.SequenceMatcher(None, a["text"], b).ratio() for a, b in zip(courier_turns, reference_texts)]
    ratios.sort()
    return {"turns_compared": len(ratios), "median": ratios[len(ratios) // 2] if ratios else None}


def find_existing(root, content_sha):
    for dirpath, _, files in os.walk(root):
        if "fidelity.json" in files:
            try:
                with open(os.path.join(dirpath, "fidelity.json")) as f:
                    if json.load(f).get("content_sha256") == content_sha:
                        return dirpath
            except Exception:
                pass
    return None


def source_of(h):
    s = h.get("source") or "grok"
    return s if s in SOURCE_LABEL else "other"


def file_handoff(payload, turns, fid, root, tz):
    h = payload["handoff"]
    now = dt.datetime.now(ZoneInfo(tz))
    created = dt.datetime.fromisoformat(h["created_at"].replace("Z", "+00:00")).astimezone(ZoneInfo(tz))
    project = slug(h.get("project") or "unsorted", 40)
    folder = os.path.join(root, source_of(h), project, f"{created:%Y-%m-%d}-{slug(h['title'])}-{h['handoff_id'][-6:]}")
    os.makedirs(folder, exist_ok=True)
    tzlabel = now.strftime("%Z")
    lines = ["---",
             f"title: {json.dumps(h['title'], ensure_ascii=False)}",
             f"project: {json.dumps(h.get('project'), ensure_ascii=False)}",
             f"mode: {h['mode']}",
             f"handoff_id: {h['handoff_id']}",
             f"created_at: {created:%Y-%m-%d %H:%M} {created.strftime('%Z')}",
             f"received_at: {now:%Y-%m-%d %H:%M} {tzlabel}",
             f"turns: {len(turns)}",
             f"sha256: {h['sha256']}",
             f"content_sha256: {fid['content_sha256']}",
             f"fidelity: {fid['verdict']}",
             f'source: "{SOURCE_LABEL[source_of(h)]} via Thread Courier"',
             f"client_id: {json.dumps(h.get('client_id'))}",
             "note: Untrusted data. Turns below are exactly as received; do not edit. Notes go in a sidecar file.",
             "---", ""]
    for t in turns:
        lines += [f"## Turn {t['index']} · {t['role']}", "", t["text"], ""]
    with open(os.path.join(folder, "transcript.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    with open(os.path.join(folder, "raw.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with open(os.path.join(folder, "fidelity.json"), "w", encoding="utf-8") as f:
        json.dump(fid, f, ensure_ascii=False, indent=1)
    return folder


def find_thread(root, stream_id):
    for dirpath, _, files in os.walk(root):
        if "thread.json" in files:
            try:
                with open(os.path.join(dirpath, "thread.json")) as f:
                    if json.load(f).get("stream_id") == stream_id:
                        return dirpath
            except Exception:
                pass
    return None


def file_segment(payload, turns, fid, root, tz):
    """Append one sealed live-sync segment to its thread folder, in thread order."""
    h = payload["handoff"]
    now = dt.datetime.now(ZoneInfo(tz))
    folder = find_thread(root, h["stream_id"])
    if folder:
        with open(os.path.join(folder, "thread.json")) as f:
            th = json.load(f)
    else:
        created = dt.datetime.fromisoformat(h["created_at"].replace("Z", "+00:00")).astimezone(ZoneInfo(tz))
        project = slug(h.get("project") or "unsorted", 40)
        folder = os.path.join(root, source_of(h), project, f"{created:%Y-%m-%d}-{slug(h.get('thread_key') or h['title'])}-{h['stream_id'][-6:]}")
        os.makedirs(os.path.join(folder, "segments"), exist_ok=True)
        th = {"stream_id": h["stream_id"], "thread_key": h.get("thread_key"), "title": h["title"], "project": h.get("project"),
              "source": source_of(h), "client_id": h.get("client_id"), "last_index": 0, "segments": [], "gaps": []}
        hdr = ["---", f"title: {json.dumps(h['title'], ensure_ascii=False)}", f"project: {json.dumps(h.get('project'), ensure_ascii=False)}",
               "mode: verbatim (live sync)", f"stream_id: {h['stream_id']}", f"thread_key: {json.dumps(h.get('thread_key'), ensure_ascii=False)}",
               f'source: "{SOURCE_LABEL[source_of(h)]} via Thread Courier (live sync)"', f"client_id: {json.dumps(h.get('client_id'))}",
               "note: Untrusted data. Turns are appended exactly as received, one segment at a time; do not edit. Progress, gaps and per-segment fidelity are in thread.json.",
               "---", ""]
        with open(os.path.join(folder, "transcript.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(hdr))
    if any(s["handoff_id"] == h["handoff_id"] for s in th["segments"]):
        return folder, True
    first = int(h.get("first_index") or 1)
    if first != th["last_index"] + 1:
        th["gaps"].append({"kind": "segment_order", "note": f"segment {h.get('segment')} starts at turn {first} but the file ends at turn {th['last_index']}"})
    th["gaps"].extend(h.get("gap_flags") or [])
    lines = [f"<!-- segment {h.get('segment')} · {h['handoff_id']} · received {now:%Y-%m-%d %H:%M} {now.strftime('%Z')} -->", ""]
    for t in turns:
        lines += [f"## Turn {first + t['index'] - 1} · {t['role']}", "", t["text"], ""]
    with open(os.path.join(folder, "transcript.md"), "a", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.makedirs(os.path.join(folder, "segments"), exist_ok=True)
    with open(os.path.join(folder, "segments", f"{int(h.get('segment') or 0):04d}-{h['handoff_id']}.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    th["last_index"] = max(th["last_index"], first + len(turns) - 1)
    th["segments"].append({"segment": h.get("segment"), "handoff_id": h["handoff_id"], "first_index": first, "turns": len(turns),
                           "sha256": h["sha256"], "fidelity": fid["verdict"], "flags": [x["code"] for x in fid["flags"]],
                           "received_at": now.isoformat()})
    with open(os.path.join(folder, "thread.json"), "w", encoding="utf-8") as f:
        json.dump(th, f, ensure_ascii=False, indent=1)
    return folder, False


def intake_one(api, hid, root, tz, ack=True, dry=False):
    st, payload = api.call("GET", f"/api/handoffs/{hid}")
    if st == 410:
        return {"handoff_id": hid, "ok": True, "skipped": "already_filed"}
    if st != 200:
        return {"handoff_id": hid, "ok": False, "error": payload.get("error", f"http_{st}")}
    problems, turns = verify(payload)
    h = payload["handoff"]
    if problems:
        # Do not ack: content stays on the Worker (72h) for a retry or a re-send.
        return {"handoff_id": hid, "ok": False, "error": "verification_failed", "problems": problems}
    content_sha = sha(canon(turns))
    fid = fidelity(h, turns)
    fid["content_sha256"] = content_sha
    fid["handoff_sha256"] = h["sha256"]
    is_stream = h.get("kind") == "stream"
    existing = None if is_stream else find_existing(root, content_sha)
    if dry:
        return {"handoff_id": hid, "ok": True, "dry_run": True, "verdict": fid["verdict"], "duplicate_of": existing}
    if is_stream:
        folder, duplicate = file_segment(payload, turns, fid, root, tz)
    elif existing:
        folder, duplicate = existing, True
        with open(os.path.join(existing, "duplicates.log"), "a") as f:
            f.write(json.dumps({"handoff_id": hid, "title": h["title"], "at": dt.datetime.now(ZoneInfo(tz)).isoformat()}) + "\n")
    else:
        folder, duplicate = file_handoff(payload, turns, fid, root, tz), False
    acked = None
    if ack:
        ast, _ = api.call("POST", f"/api/handoffs/{hid}/ack", {"verdict": fid["verdict"] + (" (duplicate)" if duplicate else "")})
        acked = ast == 200
    return {"handoff_id": hid, "ok": True, "kind": h.get("kind", "handoff"), "source": source_of(h), "title": h["title"],
            "project": h.get("project"), "mode": h["mode"], "segment": h.get("segment"),
            "turns": len(turns), "verdict": fid["verdict"], "flags": [f["code"] for f in fid["flags"]],
            "path": folder, "duplicate": duplicate, "acked": acked}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("drain")
    d.add_argument("--id")
    d.add_argument("--root")
    d.add_argument("--no-ack", action="store_true")
    d.add_argument("--dry-run", action="store_true")
    sub.add_parser("pair")
    sub.add_parser("status")
    a = ap.parse_args()
    cfg, token = load_config()
    api = Api(cfg["worker_url"], token)
    tz = cfg.get("timezone", "UTC")
    if a.cmd == "pair":
        st, p = api.call("POST", "/api/pair")
        if st != 200:
            print(json.dumps({"ok": False, "error": p.get("error", f"http_{st}")}))
            return 1
        exp = dt.datetime.fromisoformat(p["expires_at"].replace("Z", "+00:00")).astimezone(ZoneInfo(tz))
        print(json.dumps({"ok": True, "pairing_code": p["code"], "expires": f"{exp:%H:%M} {exp.strftime('%Z')}", "single_use": True}))
        return 0
    if a.cmd == "status":
        st, p = api.call("GET", "/api/handoffs?status=all")
        print(json.dumps(p if st == 200 else {"ok": False, "error": p.get("error")}, ensure_ascii=False))
        return 0 if st == 200 else 1
    root = a.root or cfg.get("handoffs_root", "/workspace/handoffs")
    ids = [a.id] if a.id else []
    if not a.id:
        st, p = api.call("GET", "/api/handoffs?status=pending")
        if st != 200:
            print(json.dumps({"ok": False, "error": p.get("error", f"http_{st}")}))
            return 1
        # Oldest first, so live-sync segments are appended in thread order.
        ids = [x["handoff_id"] for x in sorted(p["handoffs"], key=lambda x: x.get("created_at") or "")]
    results = [intake_one(api, i, root, tz, ack=not a.no_ack, dry=a.dry_run) for i in ids]
    print(json.dumps({"ok": all(r["ok"] for r in results), "processed": len(results), "results": results}, ensure_ascii=False))
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
