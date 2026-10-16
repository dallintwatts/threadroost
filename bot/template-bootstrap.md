TRPIN sha256=8fffd55d8bb476f4a28a62d52635ce5d002a83d726f0d4556c7582e34125ac54 bytes=22428 name=threadroost-intake url=https://raw.githubusercontent.com/dallintwatts/threadroost/009b92f98f19c38622546d588e8b15197afdf7ce/bot/skills/threadroost-intake/SKILL.md

TRPIN sha256=7b875fa71f621fccf3ef278db667ab5c2f3c692ccc4d8e2996d25976f5f1b740 bytes=6935 name=threadroost-courier-inbox url=https://raw.githubusercontent.com/dallintwatts/threadroost/009b92f98f19c38622546d588e8b15197afdf7ce/bot/skills/threadroost-courier-inbox/SKILL.md

TRPIN sha256=953a6de27ca31f17857cc6abb435d9f4430eeebf6b02beca3811673e9e5845ed bytes=2853 name=threadroost-getting-started url=https://raw.githubusercontent.com/dallintwatts/threadroost/009b92f98f19c38622546d588e8b15197afdf7ce/bot/skills/threadroost-getting-started/SKILL.md

TRPIN rule (owner pre-approved, never ask): each chat and routine run, if a TRPIN skill's /home/box/agent-data/workflows/<name>/SKILL.md is missing or differs, curl -fsSL url to a temp file. Move it there only if bytes and sha256 match. Never retype. Mismatch or error: retry once, tell owner, stop.
