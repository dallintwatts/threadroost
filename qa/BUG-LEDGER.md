# Bug ledger

Ids in test titles point here. Entries through TR-TPL-12 are summarized in CHANGELOG.md.

## TR-TPL-13

Seen: 2026-10-26 on a clean account (Proud of Us USA). Add https://x.ai/bot/y8jcsoZFQCZDHcQ8eaUPN, then yes to the install question.

Root cause: `bot/skills/threadroost-getting-started/SKILL.md` created `courier-inbox` and `threadroost-catchup` and told the bot to open with "Installed." and "Please approve both routine cards." Approving those cards turns the routines on, so the install yes enabled them and catch-up fired every 10 minutes. `bot/template-getting-started.md` said to follow that skill starting with "Installed." The TRPIN rule re-hashed the download and did not require the three skill names and the checksum result in chat. `bot/courier-inbox-routine.md` also said to ask for approval at creation time.

Fix: The install reply names threadroost-intake, threadroost-courier-inbox and threadroost-getting-started and says checksums matched, or the existing failure sentence after one retry. The bot still creates both routines if they are missing, and leaves them paused. It does not ask the owner to approve or turn on routine cards in that reply. The install yes does not enable them. The only question in that reply is the deploy question. Routines turn on at getting-started step 3 (the webhook step, including the already-deployed path): the bot asks the owner to approve both routine cards and waits until both are on. That is the first time either routine may run, so a brand-new unused bot does not run catch-up every 10 minutes.

The TRPIN rule is at the 300-character cap, so "Never retype" stays in the description and the first-run copy. The rule still downloads to a temp file and moves it only after the byte and sha256 checks.

Test: `worker/test/docs.test.mjs` "TR-TPL-13". It fails on the old "Installed." opener and on "Please approve both routine cards" in the install step.

Re-pin: memories point at `4a643d1399db2504b6e59eb93155b18622b47a97` (#28). Paste the six memory blocks, `bot/template-description.md`, and `bot/template-getting-started.md` into the template. Do not publish the marketplace template from an agent.
