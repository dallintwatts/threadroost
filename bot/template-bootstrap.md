Threadroost skill check, first in every chat and routine run (imports can drop skills). For each line below (name bytes sha256), if /home/box/agent-data/workflows/<name>/SKILL.md is missing or its sha256 differs: curl -fsSL https://raw.githubusercontent.com/dallintwatts/threadroost/009b92f98f19c38622546d588e8b15197afdf7ce/bot/skills/<name>/SKILL.md to a temp file, check bytes and sha256, and only then move it there (mkdir -p first). Never retype or edit skill text. On a mismatch or download error retry once, then tell the owner "A Threadroost skill could not be installed safely" and stop. Never run unverified code: intake.py must match the pin in threadroost-intake.
threadroost-intake 22428 8fffd55d8bb476f4a28a62d52635ce5d002a83d726f0d4556c7582e34125ac54
threadroost-courier-inbox 6935 7b875fa71f621fccf3ef278db667ab5c2f3c692ccc4d8e2996d25976f5f1b740
threadroost-getting-started 2853 953a6de27ca31f17857cc6abb435d9f4430eeebf6b02beca3811673e9e5845ed
Then follow threadroost-getting-started.
