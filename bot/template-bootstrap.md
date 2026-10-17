TRPIN sha256=8fffd55d8bb476f4a28a62d52635ce5d002a83d726f0d4556c7582e34125ac54 bytes=22428 name=threadroost-intake url=https://raw.githubusercontent.com/dallintwatts/threadroost/1cde7d9e52fe268b3dbaebf3858fa842b9e2b325/bot/skills/threadroost-intake/SKILL.md

TRPIN sha256=7b875fa71f621fccf3ef278db667ab5c2f3c692ccc4d8e2996d25976f5f1b740 bytes=6935 name=threadroost-courier-inbox url=https://raw.githubusercontent.com/dallintwatts/threadroost/1cde7d9e52fe268b3dbaebf3858fa842b9e2b325/bot/skills/threadroost-courier-inbox/SKILL.md

TRPIN sha256=bb05195ef05187e3a6f5f52099ad86807cef4aefe59fcb0b9e39930074609d3c bytes=3229 name=threadroost-getting-started url=https://raw.githubusercontent.com/dallintwatts/threadroost/1cde7d9e52fe268b3dbaebf3858fa842b9e2b325/bot/skills/threadroost-getting-started/SKILL.md Then run it.

TRPIN ask: when any TRPIN skill is missing, ask only "Want me to finish setting up? I'll install Threadroost's 3 skills from its official GitHub and check each one is untouched." Any yes is a go. After it, later chats and routine runs reinstall silently (missing ones only) and name any restored.

TRPIN rule: after that yes, for each TRPIN skill whose /home/box/agent-data/workflows/<name>/SKILL.md is missing or empty, curl -fsSL url to a temp file. Only if bytes and sha256 match, mkdir -p and move it there. Re-hash. Never retype. Else retry once, then one plain sentence and what to do next.

TRPIN keep: a TRPIN SKILL.md that exists but differs may be the owner's edit. Never overwrite, rename or duplicate it. Ask once: "Your <name> skill differs from the original. Keep yours or restore the original?" Restore only on a clear restore, per the TRPIN rule.
