#!/usr/bin/env bash
# Threadroost: one-command self-host setup.
#
#   cd worker && ./setup.sh            # interactive; safe to re-run any time
#   ./setup.sh --help                  # all options
#
# What it does, in order (each step checks first and skips what is already done):
#   1. checks Node 22+ and npm, installs the pinned dependencies (wrangler included)
#   2. signs you in to Cloudflare (`wrangler login`) unless you already are, picks the account
#   3. picks a Worker name (first run only) and writes it to wrangler.jsonc
#   4. creates the KV namespace (or reuses yours) and writes its id to wrangler.jsonc
#   5. deploys the Worker (`wrangler deploy`, cron trigger included)
#   6. creates the pull token (0600 file, never printed) and stores it as a Worker secret
#   7. asks for your bot's webhook URL and key (key typed hidden) and stores both as Worker secrets
#   8. checks the live Worker, probes the webhook, prints your /mcp URL and next steps
#
# Secrets go to wrangler on stdin, never on the command line, and are never echoed or logged.
# This file contains no secrets and no account-specific values. Works with bash 3.2+ (macOS) and Linux.
# On Windows, use WSL or the Deploy to Cloudflare button in the README.
set -euo pipefail

cd "$(dirname "$0")"
WORKER_DIR="$(pwd)"
CONFIG="wrangler.jsonc"
STATE_DIR=".courier"
STATE="$STATE_DIR/state.json"
TEMPLATE_NAME="threadroost"
KV_BINDING="OAUTH_KV"

# ------------------------------------------------------------------ options
OPT_NAME=""
OPT_BOT_DIR=""
OPT_TOKEN_FILE=""
OPT_ROTATE=0
OPT_SKIP_WEBHOOK=0
OPT_RESET_WEBHOOK=0
OPT_PAIR_ONLY=0
OPT_YES=0
OPT_NO_DEPLOY=0
OPT_URL=""
OPT_REMOVE=0
OPT_DOCTOR=0
OPT_RECLAIM=0

usage() {
  cat <<'USAGE'
Usage: ./setup.sh [options]

  --name NAME          Worker name to use on first run (default: suggested threadroost-xxxxxx)
  --bot-dir DIR        Also write DIR/pull_token (0600) and DIR/config.json {"worker_url"} for a bot
                       intake script running on this machine. The token file then lives in DIR.
  --token-file PATH    Where to keep the pull token (default: .courier/pull_token)
  --rotate-token       Make a new pull token and replace the Worker secret (update your bot after)
  --reset-webhook      Ask for the webhook URL and key again even if they are already set
  --skip-webhook       Do not ask for the webhook now (handoffs queue until you re-run)
  --no-deploy          Skip `wrangler deploy` on a re-run (secrets and checks only)
  --pair               Only mint a one-time pairing code and exit (uses the saved setup, or --url)
  --doctor             Check your Worker and explain what is wrong, in plain words
  --reclaim            Send your bot a fresh claim link (if it lost its token)
  --remove             Delete your Worker and its storage from Cloudflare (asks you to confirm by name)
  --url URL            Worker URL for --pair when this machine did not run the setup (e.g. Deploy button)
  -y, --yes            Accept defaults without prompting. Non-interactive webhook values come from
                       GROKBOT_WEBHOOK_URL and GROKBOT_WEBHOOK_KEY_FILE (a file holding the key)
  -h, --help           This help

Environment: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are honored if you prefer an API token
over `wrangler login`. Re-running is safe: finished steps are detected and skipped.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) OPT_NAME="${2:-}"; shift 2 ;;
    --bot-dir) OPT_BOT_DIR="${2:-}"; shift 2 ;;
    --token-file) OPT_TOKEN_FILE="${2:-}"; shift 2 ;;
    --rotate-token) OPT_ROTATE=1; shift ;;
    --reset-webhook) OPT_RESET_WEBHOOK=1; shift ;;
    --skip-webhook) OPT_SKIP_WEBHOOK=1; shift ;;
    --no-deploy) OPT_NO_DEPLOY=1; shift ;;
    --pair) OPT_PAIR_ONLY=1; shift ;;
    --url) OPT_URL="${2:-}"; shift 2 ;;
    --remove) OPT_REMOVE=1; shift ;;
    --doctor) OPT_DOCTOR=1; shift ;;
    --reclaim) OPT_RECLAIM=1; shift ;;
    -y|--yes) OPT_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------ output helpers
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; D=""; N=""; fi
STEP=0
step() { STEP=$((STEP + 1)); printf '\n%s[%s/8] %s%s\n' "$B" "$STEP" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%sSetup stopped:%s %s\n' "$R" "$N" "$1" >&2; exit 1; }

# ask "Question" "default" -> REPLY (plain input)
ask() {
  local q="$1" def="${2:-}"
  if [ "$OPT_YES" = 1 ]; then REPLY="$def"; return 0; fi
  if [ -n "$def" ]; then printf '  %s [%s]: ' "$q" "$def"; else printf '  %s: ' "$q"; fi
  IFS= read -r REPLY || REPLY=""
  [ -n "$REPLY" ] || REPLY="$def"
}
# confirm "Question" Y|N -> exit status 0 for yes
confirm() {
  local q="$1" def="${2:-Y}" hint="[Y/n]"
  [ "$def" = "N" ] && hint="[y/N]"
  if [ "$OPT_YES" = 1 ]; then [ "$def" = "Y" ]; return; fi
  printf '  %s %s ' "$q" "$hint"
  local a=""
  IFS= read -r a || a=""
  [ -n "$a" ] || a="$def"
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

LIB() { node "$WORKER_DIR/scripts/setup-lib.mjs" "$@"; }

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
ERRLOG="$STATE_DIR/last-command.err"
trap 'rm -f "$ERRLOG"' EXIT

# Run wrangler quietly for parsing; on failure show its stderr.
WR=()
wr_capture() { "${WR[@]}" "$@" 2>"$ERRLOG"; }
show_err() { [ -s "$ERRLOG" ] && sed 's/^/    /' "$ERRLOG" >&2 || true; }

TOKEN_FILE="${OPT_TOKEN_FILE:-}"
if [ -z "$TOKEN_FILE" ]; then
  if [ -n "$OPT_BOT_DIR" ]; then TOKEN_FILE="$OPT_BOT_DIR/pull_token"; else TOKEN_FILE="$STATE_DIR/pull_token"; fi
fi

local_time() { node -e 'const d=new Date(process.argv[1]);console.log(isNaN(d)?process.argv[1]:d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit",timeZoneName:"short"}))' "$1"; }

mint_pair_code() {
  local base="$1" res code exp
  res="$(LIB api "$base" "$TOKEN_FILE" POST /api/pair)"
  code="$(printf '%s' "$res" | LIB json-field body.code)"
  exp="$(printf '%s' "$res" | LIB json-field body.expires_at)"
  if [ -n "$code" ]; then
    printf '\n  %sPairing code: %s%s  (single use, expires %s)\n' "$B" "$code" "$N" "$(local_time "$exp")"
    info "Enter it on the Threadroost sign-in page when your chat app connects."
  else
    warn "Could not create a pairing code right now ($(printf '%s' "$res" | LIB json-field status) $(printf '%s' "$res" | LIB json-field body.error)). Wait a minute and run ./setup.sh --pair"
    return 1
  fi
}

# ------------------------------------------------------------------ --doctor / --reclaim
if [ "$OPT_DOCTOR" = 1 ] || [ "$OPT_RECLAIM" = 1 ]; then
  d_url="${OPT_URL:-$(LIB state-get "$STATE" worker_url)}"; d_url="${d_url%/}"; d_url="${d_url%/mcp}"
  [ -n "$d_url" ] || die "I don't know your Worker's address yet. Run ./setup.sh first, or add --url https://<your-worker>"
  if [ "$OPT_RECLAIM" = 1 ]; then
    if [ -n "${WRANGLER:-}" ]; then read -r -a WR <<<"$WRANGLER"; else WR=("$WORKER_DIR/node_modules/.bin/wrangler"); fi
    d_kv="$(LIB config-get "$CONFIG" kv-id)"
    [ -n "$d_kv" ] || die "No storage id in wrangler.jsonc. Deploy button users: in Cloudflare, open Storage, then KV, set the key courier:boot to {\"reclaim\":true}, then open your Worker URL."
    "${WR[@]}" kv key put --namespace-id "$d_kv" --remote "courier:boot" '{"reclaim":true}' >/dev/null || die "Could not reset the claim state (details above)."
    ok "Claim reset. Sending your bot a fresh claim link..."
  fi
  node -e '
const base=process.argv[1];
const say=(ok,m)=>console.log("  "+(ok?"\u2713":"!")+" "+m);
(async()=>{
  let h;
  try{const r=await fetch(base+"/health",{signal:AbortSignal.timeout(15000)});h=await r.json();}catch(e){say(false,"Your Worker did not answer at "+base+". If you just deployed, wait two minutes and try again.");process.exit(1)}
  if(!h||!h.version){say(false,"Your Worker answered, but it is running an older Threadroost without a health check, or an update is still rolling out. Wait a minute and run ./setup.sh --doctor again.");process.exit(2)}
  say(true,"Your Worker is online (version "+h.version+").");
  say(h.webhook_configured, h.webhook_configured?"It knows where your bot is.":"It does not know where your bot is. Run ./setup.sh --reset-webhook.");
  const reclaiming=process.argv[2]==="1"&&h.webhook_configured&&!h.bot_connected;
  if(reclaiming)say(true,"Claim link on its way. Your bot should claim it within a minute. Check with ./setup.sh --doctor.");
  else say(h.bot_connected, h.bot_connected?"Your bot has claimed its token.":(h.webhook_configured?"Your bot has not claimed its token yet. A claim link is sent to it every 10 minutes. If nothing arrives, check the webhook, or run ./setup.sh --reclaim.":"Your bot cannot be connected until the webhook is set. Run ./setup.sh --reset-webhook first."));
  try{const r=await fetch(base+"/.well-known/oauth-authorization-server");say(r.ok, r.ok?"Sign-in for chat apps works.":"Sign-in discovery failed ("+r.status+").")}catch{say(false,"Sign-in discovery did not answer.")}
  process.exit(h.webhook_configured&&(h.bot_connected||reclaiming)?0:2);
})();' "${COURIER_TEST_BASE_URL:-$d_url}" "$OPT_RECLAIM"
  exit $?
fi

# ------------------------------------------------------------------ --remove
if [ "$OPT_REMOVE" = 1 ]; then
  rm_name="$(LIB config-get "$CONFIG" name)"
  rm_kv="$(LIB config-get "$CONFIG" kv-id)"
  [ -n "$rm_name" ] && [ "$rm_name" != "$TEMPLATE_NAME" ] || die "This copy has not been set up yet, so there is nothing to remove. If you deployed with the button, delete the Worker in the Cloudflare dashboard under Workers & Pages."
  if [ -n "${WRANGLER:-}" ]; then read -r -a WR <<<"$WRANGLER"; else WR=("$WORKER_DIR/node_modules/.bin/wrangler"); fi
  printf '%sRemove Threadroost%s
' "$B" "$N"
  info "This deletes from your Cloudflare account:"
  info "  - the Worker '$rm_name' and its secrets"
  [ -n "$rm_kv" ] && info "  - its storage (KV namespace $rm_kv), including any chats not yet collected"
  info "Transcripts your bot already filed stay with your bot."
  if [ "$OPT_YES" != 1 ]; then
    printf '  Type the Worker name to confirm (%s): ' "$rm_name"
    IFS= read -r REPLY || REPLY=""
    [ "$REPLY" = "$rm_name" ] || { info "Nothing was removed."; exit 0; }
  fi
  "${WR[@]}" delete "$rm_name" || die "Cloudflare did not delete the Worker (details above). Check you are signed in (npx wrangler whoami) and run ./setup.sh --remove again."
  ok "Worker deleted"
  if [ -n "$rm_kv" ]; then
    "${WR[@]}" kv namespace delete --namespace-id "$rm_kv" -y || die "The Worker is gone but its storage was not deleted. Run: npx wrangler kv namespace delete --namespace-id $rm_kv"
    ok "Storage deleted"
  fi
  rm -rf "$STATE_DIR"
  ok "Local setup files removed"
  info "Last step: remove the Threadroost connector in grok.com and claude.ai (Connectors), and remove the bot in Grok Bot if you no longer want it."
  exit 0
fi

# ------------------------------------------------------------------ --pair shortcut
if [ "$OPT_PAIR_ONLY" = 1 ]; then
  url="${OPT_URL:-$(LIB state-get "$STATE" worker_url)}"
  url="${url%/}"; url="${url%/mcp}"
  [ -n "$url" ] || die "No finished setup on this machine yet. Run ./setup.sh first. On another machine, run: ./setup.sh --pair --url https://<your-worker>"
  LIB check-token-file "$TOKEN_FILE" || die "No pull token at $TOKEN_FILE (use --token-file or --bot-dir)."
  mint_pair_code "${COURIER_TEST_BASE_URL:-$url}"
  exit 0
fi

printf '%sThreadroost setup%s %s(safe to re-run. Finished steps are skipped.)%s\n' "$B" "$N" "$D" "$N"

# ------------------------------------------------------------------ 1. prerequisites
step "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required: https://nodejs.org (or: nvm install 22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22+ is required (found $(node -v)). Install it from https://nodejs.org or run: nvm install 22"
command -v npm >/dev/null 2>&1 || die "npm is missing. It comes with Node.js, so reinstall Node 22+ from https://nodejs.org and run ./setup.sh again."
ok "Node $(node -v)"
if [ ! -x node_modules/.bin/wrangler ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  info "Installing pinned dependencies (npm ci)..."
  npm ci --no-audit --no-fund --loglevel=error || die "Installing dependencies failed (details above). Check your internet connection, then run ./setup.sh again. If it keeps failing: rm -rf node_modules && ./setup.sh"
fi
if [ -n "${WRANGLER:-}" ]; then
  # Test hook: WRANGLER="node test/fixtures/fake-wrangler.mjs" points the script at a stand-in.
  read -r -a WR <<<"$WRANGLER"
else
  WR=("$WORKER_DIR/node_modules/.bin/wrangler")
fi
WR_VERSION="$("${WR[@]}" --version 2>/dev/null | tail -n 1)" || die "wrangler did not start. Try: rm -rf node_modules && ./setup.sh"
ok "wrangler $WR_VERSION"

# ------------------------------------------------------------------ 2. Cloudflare sign-in
step "Signing in to Cloudflare"
accounts=""
whoami_accounts() { wr_capture whoami --json | LIB whoami-accounts; }
if ! accounts="$(whoami_accounts)"; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then show_err; die "Cloudflare did not accept CLOUDFLARE_API_TOKEN. Create a new token from the \"Edit Cloudflare Workers\" template, or run: unset CLOUDFLARE_API_TOKEN && ./setup.sh to sign in with your browser instead."; fi
  info "Opening your browser for 'wrangler login' (click Allow, then come back here)..."
  "${WR[@]}" login || die "Cloudflare sign-in did not finish. Run ./setup.sh again and click Allow in the browser tab it opens."
  accounts="$(whoami_accounts)" || { show_err; die "Still not signed in to Cloudflare. Run ./setup.sh again. If the browser tab never opened, run: npx wrangler login"; }
fi
[ -n "$accounts" ] || die "This Cloudflare login has no account yet. Finish signing up at https://dash.cloudflare.com/sign-up, then run ./setup.sh again."
n_accounts="$(printf '%s\n' "$accounts" | grep -c .)"
account_id="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$account_id" ]; then
  saved="$(LIB state-get "$STATE" account_id)"
  if [ -n "$saved" ] && printf '%s\n' "$accounts" | cut -f1 | grep -qx "$saved"; then
    account_id="$saved"
  elif [ "$n_accounts" = 1 ]; then
    account_id="$(printf '%s\n' "$accounts" | head -n 1 | cut -f1)"
  else
    info "Your login can reach more than one Cloudflare account:"
    i=0
    while IFS="$(printf '\t')" read -r _aid aname; do i=$((i + 1)); info "  $i) $aname"; done <<<"$accounts"
    ask "Which account should host Threadroost? (number)" "1"
    case "$REPLY" in ''|*[!0-9]*) die "Please enter one of the numbers shown. Run ./setup.sh again to choose." ;; esac
    account_id="$(printf '%s\n' "$accounts" | sed -n "${REPLY}p" | cut -f1)"
    [ -n "$account_id" ] || die "There is no account number $REPLY. Run ./setup.sh again and pick a number from the list."
  fi
fi
export CLOUDFLARE_ACCOUNT_ID="$account_id"
LIB state-set "$STATE" account_id "$account_id"
account_name="$(printf '%s\n' "$accounts" | awk -F '\t' -v id="$account_id" '$1==id{print $2}')"
ok "Signed in (account: ${account_name:-$account_id})"

# ------------------------------------------------------------------ 3. Worker name
step "Choosing the Worker name"
current_name="$(LIB config-get "$CONFIG" name)"
saved_name="$(LIB state-get "$STATE" worker_name)"
if [ -n "$OPT_NAME" ] && [ "$OPT_NAME" != "$current_name" ]; then
  if [ -n "$saved_name" ]; then
    warn "This setup already uses '$current_name'. Renaming would create a second Worker, so the old name is kept. To start fresh on purpose, delete .courier/state.json and run again."
  else
    LIB config-set-name "$CONFIG" "$OPT_NAME" || die "That name will not work. Use lowercase letters, digits and dashes (for example threadroost-k3x9pq)."
    current_name="$OPT_NAME"
  fi
elif [ -z "$saved_name" ] && [ "$current_name" = "$TEMPLATE_NAME" ]; then
  suggestion="$TEMPLATE_NAME-$(node -e 'const a="abcdefghijkmnpqrstuvwxyz23456789";let s="";for(const b of require("crypto").randomBytes(6))s+=a[b%a.length];process.stdout.write(s)')"
  info "The name becomes part of your URL: https://<name>.<your-subdomain>.workers.dev"
  info "A neutral name with a random suffix is suggested. It does not need to match anything else."
  ask "Worker name" "$suggestion"
  LIB config-set-name "$CONFIG" "$REPLY" || die "That name will not work. Use lowercase letters, digits and dashes (for example threadroost-k3x9pq). Run ./setup.sh again."
  current_name="$REPLY"
elif [ -n "$saved_name" ] && [ "$saved_name" != "$current_name" ]; then
  warn "wrangler.jsonc says '$current_name' but the last setup used '$saved_name'. Using '$current_name'."
fi
WORKER_NAME="$current_name"
LIB state-set "$STATE" worker_name "$WORKER_NAME"
ok "Worker name: $WORKER_NAME"

# ------------------------------------------------------------------ 4. KV namespace
step "Creating storage for your Worker"
kv_list="$(wr_capture kv namespace list)" || { show_err; die "Could not read your Cloudflare storage (details above). Check your connection and run ./setup.sh again."; }
kv_id="$(LIB config-get "$CONFIG" kv-id)"
kv_title="$WORKER_NAME-oauth-kv"
if [ -n "$kv_id" ]; then
  printf '%s' "$kv_list" | LIB kv-has-id "$kv_id" \
    || die "wrangler.jsonc points at KV namespace $kv_id, which this account does not have. Remove the \"id\" from the $KV_BINDING entry to let setup create one, or select the right account (CLOUDFLARE_ACCOUNT_ID)."
  ok "Using storage $kv_id (already in wrangler.jsonc)"
else
  kv_id="$(printf '%s' "$kv_list" | LIB kv-find "$kv_title")"
  if [ -n "$kv_id" ]; then
    ok "Found existing storage \"$kv_title\" ($kv_id)"
  else
    create_out="$(wr_capture kv namespace create "$kv_title" --no-update-config </dev/null)" || { show_err; die "Could not create the storage namespace (details above). Free accounts allow many, so this is usually a network hiccup. Run ./setup.sh again."; }
    kv_id="$(printf '%s' "$create_out" | LIB kv-id-from-create)" || die "Created the namespace but could not read its id. Run: npx wrangler kv namespace list"
    ok "Created storage \"$kv_title\" ($kv_id)"
  fi
  LIB config-set-kv-id "$CONFIG" "$kv_id"
  ok "Wrote the id into wrangler.jsonc"
fi
LIB state-set "$STATE" kv_id "$kv_id"

# ------------------------------------------------------------------ 5. deploy
step "Deploying the Worker"
OUT_FILE="$WORKER_DIR/$STATE_DIR/deploy-output.ndjson"
worker_url="$(LIB state-get "$STATE" worker_url)"
if [ "$OPT_NO_DEPLOY" = 1 ] && [ -n "$worker_url" ]; then
  ok "Skipped (--no-deploy); using $worker_url"
else
  rm -f "$OUT_FILE"
  # Attached to your terminal so wrangler can ask to register a workers.dev subdomain on a new account.
  WRANGLER_OUTPUT_FILE_PATH="$OUT_FILE" "${WR[@]}" deploy || die "Deploy failed (details above). Fix what Cloudflare reported, then run ./setup.sh again. Finished steps are skipped."
  deployed_url="$(LIB deploy-url "$OUT_FILE")"
  rm -f "$OUT_FILE"
  if [ -n "$deployed_url" ]; then
    if [ -n "$worker_url" ] && [ "$worker_url" != "${deployed_url%/}" ]; then
      warn "Your Worker URL changed from $worker_url to ${deployed_url%/}."
      warn "Re-add the connector in your chat apps with the new /mcp URL and update your bot's Worker URL."
    fi
    worker_url="${deployed_url%/}"
  elif [ -z "$worker_url" ]; then
    ask "Paste the https://... URL wrangler printed above" ""
    worker_url="${REPLY%/}"
  fi
  case "$worker_url" in https://*) ;; *) die "Need the Worker's https:// URL (got '$worker_url'). Re-run with the URL from the Cloudflare dashboard." ;; esac
  ok "Deployed: $worker_url"
fi
LIB state-set "$STATE" worker_url "$worker_url"
# Test hook only: route HTTP checks to a local stand-in.
BASE="${COURIER_TEST_BASE_URL:-$worker_url}"

secret_names="$(wr_capture secret list | LIB secret-names || true)"
has_secret() { printf '%s\n' "$secret_names" | grep -qx "$1"; }
put_secret_from_file() { "${WR[@]}" secret put "$1" <"$2" >/dev/null 2>"$ERRLOG" || { show_err; die "Could not save $1 to your Worker (details above). Run ./setup.sh again."; }; }

# ------------------------------------------------------------------ 6. pull token
step "Creating the pull token (lets your bot collect threads)"
token_ready=0
token_status() { LIB api "$BASE" "$TOKEN_FILE" GET "/api/handoffs?status=all" | LIB json-field status; }
wait_token() {
  local t=0 s=""
  while [ $t -lt 12 ]; do
    s="$(token_status)"
    [ "$s" = 200 ] && return 0
    sleep 5; t=$((t + 1))
  done
  warn "The Worker has not confirmed the pull token yet (last status $s). Re-run in a minute to re-check."
  return 1
}
# A new token means the bot needs a claim link. Mark the boot record first, so the Worker's v1.1 upgrade path
# (explicit token + no boot record = already claimed) does not skip the claim for a brand-new install (TR-BUG-17).
mark_needs_claim() {
  has_secret COURIER_PULL_TOKEN && return 0
  [ -n "${kv_id:-}" ] || return 0
  "${WR[@]}" kv key put --namespace-id "$kv_id" --remote "courier:boot" '{"setup":"fresh"}' >/dev/null 2>"$ERRLOG" \
    || warn "Could not mark the install as new. If your bot gets no claim link within 10 minutes, run ./setup.sh --reclaim."
}
put_token() { mark_needs_claim; put_secret_from_file COURIER_PULL_TOKEN "$TOKEN_FILE"; ok "Stored COURIER_PULL_TOKEN as a Worker secret"; wait_token && token_ready=1 || true; }

if [ "$OPT_ROTATE" = 1 ] && [ -f "$TOKEN_FILE" ]; then
  mv "$TOKEN_FILE" "$TOKEN_FILE.old"
  LIB gen-token "$TOKEN_FILE"
  rm -f "$TOKEN_FILE.old"
  ok "New pull token written to $TOKEN_FILE (0600)"
  put_token
  warn "Rotated: give the new token to your bot (see next steps)."
elif LIB check-token-file "$TOKEN_FILE"; then
  if has_secret COURIER_PULL_TOKEN; then
    s="$(token_status)"
    case "$s" in
      200) ok "Pull token already set and matches $TOKEN_FILE"; token_ready=1 ;;
      401)
        warn "The Worker holds a different pull token than $TOKEN_FILE."
        if confirm "Replace the Worker's token with the local one (your bot must use this file)?" Y; then put_token; else warn "Left as is."; fi ;;
      503) put_token ;;
      *) warn "Could not verify the pull token right now (status ${s:-none}); keeping it."; token_ready=1 ;;
    esac
  else
    put_token
  fi
else
  if has_secret COURIER_PULL_TOKEN && [ "$OPT_ROTATE" != 1 ]; then
    warn "The Worker already has a pull token, but there is no local copy at $TOKEN_FILE."
    if confirm "Make a new one and replace it? (a bot using the old token must be updated)" N; then
      LIB gen-token "$TOKEN_FILE"; ok "New pull token written to $TOKEN_FILE (0600)"; put_token
    else
      warn "Skipped. Point --token-file at your existing token to verify it, or use --rotate-token."
    fi
  else
    [ -f "$TOKEN_FILE" ] && die "$TOKEN_FILE exists but is not a usable token (32+ characters, no spaces). Fix or delete it, then re-run."
    LIB gen-token "$TOKEN_FILE"
    ok "New pull token written to $TOKEN_FILE (0600, never printed)"
    put_token
  fi
fi

# ------------------------------------------------------------------ 7. webhook
step "Connecting your bot's webhook"
webhook_set=0
if has_secret GROKBOT_WEBHOOK_URL && has_secret GROKBOT_WEBHOOK_KEY; then webhook_set=1; fi
if [ "$OPT_SKIP_WEBHOOK" = 1 ]; then
  warn "Webhook skipped. Threads wait safely until you add it with: ./setup.sh --reset-webhook"
elif [ "$webhook_set" = 1 ] && [ "$OPT_RESET_WEBHOOK" = 0 ] && confirm "Webhook URL and key are already set. Keep them?" Y; then
  ok "Keeping the existing webhook settings"
else
  info "In your bot's chat, say: Show my Threadroost webhook. Open the two links it sends and copy the URL and key. Never paste the key into a chat."
  hook_url="${GROKBOT_WEBHOOK_URL:-}"
  if [ -z "$hook_url" ]; then ask "Webhook URL (https://...)" ""; hook_url="$REPLY"; fi
  hook_key=""
  if [ -n "${GROKBOT_WEBHOOK_KEY_FILE:-}" ]; then
    hook_key="$(cat "$GROKBOT_WEBHOOK_KEY_FILE")"
  elif [ "$OPT_YES" = 0 ] && [ -n "$hook_url" ]; then
    printf '  Webhook key (typing is hidden): '
    IFS= read -r -s hook_key || hook_key=""
    printf '\n'
  fi
  if [ -z "$hook_url" ] || [ -z "$hook_key" ]; then
    warn "No webhook entered; skipped. Re-run ./setup.sh --reset-webhook when you have it."
  else
    case "$hook_url" in https://*) ;; *) hook_key=""; die "The webhook URL must start with https:// . Ask your bot \"Show my Threadroost webhook\" to copy it again, then run ./setup.sh --reset-webhook" ;; esac
    printf '%s' "$hook_url" | "${WR[@]}" secret put GROKBOT_WEBHOOK_URL >/dev/null 2>"$ERRLOG" || { hook_key=""; show_err; die "Could not save the webhook URL to your Worker (details above). Run ./setup.sh --reset-webhook to try again."; }
    printf '%s' "$hook_key" | "${WR[@]}" secret put GROKBOT_WEBHOOK_KEY >/dev/null 2>"$ERRLOG" || { hook_key=""; show_err; die "Could not save the webhook key to your Worker (details above). Run ./setup.sh --reset-webhook to try again."; }
    hook_key=""; unset hook_key hook_url
    ok "Stored GROKBOT_WEBHOOK_URL and GROKBOT_WEBHOOK_KEY as Worker secrets"
    webhook_set=1
  fi
fi
if [ "$webhook_set" = 1 ] && [ "$token_ready" = 1 ]; then
  probe=""; reason=""
  for _ in 1 2 3 4 5 6; do
    probe="$(LIB api "$BASE" "$TOKEN_FILE" POST /api/admin/probe-webhook)"
    reason="$(printf '%s' "$probe" | LIB json-field body.webhook.reason)"
    [ "$reason" = "webhook_not_configured" ] || break
    sleep 5
  done
  # TR-CI-1: a bot that is busy (for example right after the first claim link) can answer 400 for a moment.
  # Try once more after 20 s (SETUP_PROBE_RETRY_SECONDS in tests) unless the reply clearly says the key or routine is wrong.
  if [ "$(printf '%s' "$probe" | LIB json-field body.webhook.ok)" != "true" ] && [ "$reason" = "non_2xx" ] \
     && ! printf '%s' "$probe" | LIB json-field body.webhook.response_snippet | grep -qiE 'paused|disabled|not found|deleted|unauthori[sz]ed|forbidden|invalid (api )?key'; then
    info "Your bot didn't accept the test message yet (it may be busy). Trying again in ${SETUP_PROBE_RETRY_SECONDS:-20} seconds..."
    sleep "${SETUP_PROBE_RETRY_SECONDS:-20}"
    probe="$(LIB api "$BASE" "$TOKEN_FILE" POST /api/admin/probe-webhook)"
    reason="$(printf '%s' "$probe" | LIB json-field body.webhook.reason)"
  fi
  if [ "$(printf '%s' "$probe" | LIB json-field body.webhook.ok)" = "true" ]; then
    ok "Webhook test passed: a test message reached your bot (HTTP $(printf '%s' "$probe" | LIB json-field body.webhook.http_status)). Bots ignore test messages."
  else
    hs="$(printf '%s' "$probe" | LIB json-field body.webhook.http_status)"
    if [ -n "$hs" ]; then warn "Webhook test failed: your bot answered HTTP $hs. Handoffs still queue safely."
    else warn "Webhook test failed: no answer from your bot (${reason:-unknown}). Handoffs still queue safely."; fi
    snip="$(printf '%s' "$probe" | LIB json-field body.webhook.response_snippet)"
    if [ -n "$snip" ]; then info "Your bot replied: $snip"; fi
    info "What to do:"
    info "  - Busy or rate limited: wait a few minutes, then run ./setup.sh --no-deploy to test again."
    info "  - Paused: approve the courier-inbox routine card in your bot's chat, then run ./setup.sh --no-deploy."
    info "  - Anything else: re-copy both values from your bot's links, then run ./setup.sh --reset-webhook."
  fi
fi

# ------------------------------------------------------------------ 8. checks + next steps
step "Checking the live Worker"
if pf="$(LIB preflight "$BASE" --wait 120)"; then
  ok "$(printf '%s' "$pf" | LIB json-field root | sed 's/\. MCP endpoint.*//') is live. Sign-in works, and the connector stays locked until you pair an app."
else
  warn "Checks did not pass yet: $(printf '%s' "$pf" | LIB json-field error). New workers.dev names can take a few minutes; re-run ./setup.sh --no-deploy to re-check."
fi

if [ -n "$OPT_BOT_DIR" ] && LIB check-token-file "$TOKEN_FILE"; then
  LIB bot-config "$OPT_BOT_DIR" "$worker_url" "$TOKEN_FILE"
  ok "Bot intake config written to $OPT_BOT_DIR (pull_token 0600, config.json)"
fi

MCP_URL="$worker_url/mcp"
printf '\n%sDone. Your connector URL:%s\n\n    %s\n\n' "$B" "$N" "$MCP_URL"
printf '%sNext steps%s\n' "$B" "$N"
info "1. Nothing to copy to your bot. It gets a one-time claim link by itself within a minute and"
info "   collects its own token. Then it sends you a Connect link."
info "2. Open the Connect link. It shows your connector URL, a pairing code and the SuperGrok"
info "   instruction, each with a Copy button."
if [ -n "$OPT_BOT_DIR" ]; then info "   (Bot intake config is also in place at $OPT_BOT_DIR.)"; fi
info "   Check progress any time: ./setup.sh --doctor"
info "   Prefer to do it by hand? The pull token is in $TOKEN_FILE. ./setup.sh --pair makes a pairing code."
printf '\n  %sRe-run ./setup.sh any time. It only fixes what is missing.%s\n' "$D" "$N"
