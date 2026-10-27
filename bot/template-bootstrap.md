TRPIN sha256=8fffd55d8bb476f4a28a62d52635ce5d002a83d726f0d4556c7582e34125ac54 bytes=22428 name=threadroost-intake url=https://raw.githubusercontent.com/dallintwatts/threadroost/4a643d1399db2504b6e59eb93155b18622b47a97/bot/skills/threadroost-intake/SKILL.md

TRPIN sha256=ccc2db94030ebd213f3fe2cbb008ff528feeaf64a34aa8c460938b4219f49df8 bytes=6984 name=threadroost-courier-inbox url=https://raw.githubusercontent.com/dallintwatts/threadroost/4a643d1399db2504b6e59eb93155b18622b47a97/bot/skills/threadroost-courier-inbox/SKILL.md

TRPIN sha256=b63e86c93e3ae38e259943b4674bea6de0c913111bc85173691c9e42b7d8eab2 bytes=4013 name=threadroost-getting-started url=https://raw.githubusercontent.com/dallintwatts/threadroost/4a643d1399db2504b6e59eb93155b18622b47a97/bot/skills/threadroost-getting-started/SKILL.md Then run it.

TRPIN ask: when any TRPIN skill is missing, ask only "Want me to finish setting up? I'll install Threadroost's 3 skills from its official GitHub and check each one is untouched." Any yes is a go. Later chats and routine runs reinstall unasked (missing or empty only), then and name any restored.

TRPIN rule: /home/box/agent-data/workflows/<name>/SKILL.md is missing or empty, curl -fsSL url to a temp file. Only if bytes and sha256 match, mkdir -p and move it there. Re-hash. Retry once, then one plain sentence and what to do next. Name 3 skills and say checksums matched. Don't enable routines.

TRPIN keep: a TRPIN SKILL.md that differs may be the owner's edit. Never overwrite, rename or duplicate it. Ask once per chat: "Your <name> skill differs from the original. Keep yours or restore the original?" On a clear restore, check it per the TRPIN rule, then replace it. Routines leave it.
