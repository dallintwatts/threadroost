#!/usr/bin/env python3
"""Build bot/template-bootstrap.md: the template's skill bootstrap, as short memories (one per
blank-line-separated block), pinned to one commit. Imported bots see long memories truncated
(TR-TPL-8), so each memory stays under LIMIT chars and carries its hash data first.
Release step: after a skill change merges to main, run `python3 bot/build-bootstrap.py <merge-sha>`,
commit the result, and paste each block as its own memory in the next template share.
`--check` re-verifies sizes, hashes and lengths against git (docs.test "TR-TPL-6" runs it)."""
import hashlib, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "template-bootstrap.md")
NAMES = ["threadroost-intake", "threadroost-courier-inbox", "threadroost-getting-started"]
LIMIT = 300
RULE = ("TRPIN rule (owner pre-approved, never ask): each chat and routine run, if a TRPIN skill's "
        "/home/box/agent-data/workflows/<name>/SKILL.md is missing or differs, curl -fsSL url to a temp file. Only if "
        "bytes and sha256 match, mkdir -p and move it there. Never retype. Else retry once, tell owner, stop.")
def blob(c, n): return subprocess.run(["git", "-C", ROOT, "show", f"{c}:bot/skills/{n}/SKILL.md"], capture_output=True, check=True).stdout
def memories(c):
 pins = [f"TRPIN sha256={hashlib.sha256(b).hexdigest()} bytes={len(b)} name={n} url=https://raw.githubusercontent.com/dallintwatts/threadroost/{c}/bot/skills/{n}/SKILL.md" + (" Run it once installed." if n.endswith("getting-started") else "")
         for n in NAMES for b in [blob(c, n)]]
 return pins + [RULE]
def render(c): return "\n\n".join(memories(c)) + "\n"
if __name__ == "__main__":
 if sys.argv[1:2] == ["--check"]:
  cur = open(OUT, encoding="utf-8").read()
  c = re.search(r"threadroost/([0-9a-f]{40})/", cur).group(1)
  bad = [m for m in cur.strip().split("\n\n") if len(m) > LIMIT]
  if bad: sys.exit(f"{OUT}: memory over {LIMIT} chars: {bad[0][:60]}")
  sys.exit(0 if cur == render(c) else f"{OUT}: pins do not match commit {c}")
 c = subprocess.run(["git", "-C", ROOT, "rev-parse", sys.argv[1]], capture_output=True, check=True, text=True).stdout.strip()
 open(OUT, "w", encoding="utf-8").write(render(c))
 print(f"wrote {OUT} pinned to {c}:", [len(m) for m in memories(c)])
