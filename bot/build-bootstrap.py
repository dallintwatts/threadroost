#!/usr/bin/env python3
"""Build bot/template-bootstrap.md: the template's skill bootstrap memory, pinned to one commit.
Release step: after a skill change merges to main, run `python3 bot/build-bootstrap.py <merge-sha>`,
commit the result, and paste the memory text into the next template share.
`--check` re-verifies the pins against git (docs.test "TR-TPL-6" runs it)."""
import hashlib, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "template-bootstrap.md")
NAMES = ["threadroost-intake", "threadroost-courier-inbox", "threadroost-getting-started"]
def blob(c, n): return subprocess.run(["git", "-C", ROOT, "show", f"{c}:bot/skills/{n}/SKILL.md"], capture_output=True, check=True).stdout
def text(c):
 lines = "\n".join(f"{n} {len(b)} {hashlib.sha256(b).hexdigest()}" for n in NAMES for b in [blob(c, n)])
 return (f"Threadroost skill check, first in every chat and routine run (imports can drop skills). For each line below (name bytes sha256), "
  f"if /home/box/agent-data/workflows/<name>/SKILL.md is missing or its sha256 differs: curl -fsSL "
  f"https://raw.githubusercontent.com/dallintwatts/threadroost/{c}/bot/skills/<name>/SKILL.md to a temp file, check bytes and sha256, "
  f"and only then move it there (mkdir -p first). Never retype or edit skill text. On a mismatch or download error retry once, then tell the owner "
  f"\"A Threadroost skill could not be installed safely\" and stop. Never run unverified code: intake.py must match the pin in threadroost-intake.\n"
  f"{lines}\nThen follow threadroost-getting-started.")
if __name__ == "__main__":
 if sys.argv[1:2] == ["--check"]:
  cur = open(OUT, encoding="utf-8").read().rstrip("\n")
  c = re.search(r"threadroost/([0-9a-f]{40})/", cur).group(1)
  sys.exit(0 if cur == text(c) else f"{OUT}: pins do not match commit {c}")
 c = subprocess.run(["git", "-C", ROOT, "rev-parse", sys.argv[1]], capture_output=True, check=True, text=True).stdout.strip()
 t = text(c); open(OUT, "w", encoding="utf-8").write(t + "\n"); print(f"wrote {OUT} ({len(t)} chars) pinned to {c}")
