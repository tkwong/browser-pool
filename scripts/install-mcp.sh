#!/usr/bin/env bash
# browser-pool MCP — one-liner installer.
#
# Usage (curl|bash via process substitution, NOT a pipe — so the script can
# stay interactive and the agent host's shell history captures only the URL):
#
#   BROWSER_POOL_URL=https://allocator.example.com \
#   BROWSER_TOKEN=<client_id>:<client_secret> \
#     bash <(curl -fsSL https://raw.githubusercontent.com/tkwong/browser-pool/main/scripts/install-mcp.sh)
#
# Optional env:
#   BROWSER_POOL_REPO       default https://github.com/tkwong/browser-pool.git
#   BROWSER_POOL_BRANCH     default main
#   BROWSER_POOL_HOME       default ~/browser-pool — where to clone
#   BROWSER_POOL_SKIP_SMOKE 1 to skip the post-install smoke run
#
# What it does (idempotent — re-run safely):
#   1. Verify Node ≥ 22 (install via fnm if missing).
#   2. Clone or pull the repo to BROWSER_POOL_HOME.
#   3. npm ci in clients/mcp.
#   4. Write CF Access token to ~/.config/browser-pool/service-token.json (600).
#   5. Register MCP at --scope user (or refresh if already registered).
#   6. Run tests/smoke.py against the live allocator.
#
# Exits non-zero on any failure with a clear "fix this" message.

set -euo pipefail

# --------------------------------------------------------------------------- #
# Constants                                                                   #
# --------------------------------------------------------------------------- #
REPO_URL="${BROWSER_POOL_REPO:-https://github.com/tkwong/browser-pool.git}"
BRANCH="${BROWSER_POOL_BRANCH:-main}"
HOME_DIR="${BROWSER_POOL_HOME:-$HOME/browser-pool}"
CONFIG_DIR="$HOME/.config/browser-pool"
TOKEN_FILE="$CONFIG_DIR/service-token.json"
MCP_NAME="browser-pool"

# --------------------------------------------------------------------------- #
# Pretty-print                                                                #
# --------------------------------------------------------------------------- #
log()  { printf '\033[1;34m[install-mcp]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  ⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------- #
# 0. Validate input                                                            #
# --------------------------------------------------------------------------- #
log "validating env"
[ -n "${BROWSER_POOL_URL:-}" ] || die "BROWSER_POOL_URL not set (e.g. https://allocator.example.com)"
[ -n "${BROWSER_TOKEN:-}"    ] || die "BROWSER_TOKEN not set (<client_id>:<client_secret>)"
case "$BROWSER_TOKEN" in
  *:*) ok "BROWSER_TOKEN shape OK" ;;
  *)   die "BROWSER_TOKEN must be <client_id>:<client_secret> (got no ':')" ;;
esac
case "$BROWSER_POOL_URL" in
  http://*|https://*) ok "BROWSER_POOL_URL = $BROWSER_POOL_URL" ;;
  *) die "BROWSER_POOL_URL must start with http:// or https://" ;;
esac

# --------------------------------------------------------------------------- #
# 1. Node 22+                                                                 #
# --------------------------------------------------------------------------- #
log "checking node"
need_install=0
if command -v node >/dev/null 2>&1; then
  v=$(node --version | sed 's/^v//')
  major=${v%%.*}
  if [ "$major" -ge 22 ]; then
    ok "node v$v"
  else
    warn "node v$v < 22; will install v22 via fnm"
    need_install=1
  fi
else
  warn "node not found; will install via fnm"
  need_install=1
fi

if [ "$need_install" -eq 1 ]; then
  if ! command -v fnm >/dev/null 2>&1; then
    log "installing fnm"
    curl -fsSL https://fnm.vercel.app/install | bash >/dev/null
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env --use-on-cd)"
  fi
  fnm install 22 >/dev/null
  fnm default 22
  hash -r
  ok "installed node $(node --version)"
fi

# Sanity: npm should exist alongside node
command -v npm >/dev/null 2>&1 || die "npm not found alongside node — broken install"

# --------------------------------------------------------------------------- #
# 2. claude CLI                                                                #
# --------------------------------------------------------------------------- #
command -v claude >/dev/null 2>&1 || die "claude CLI not found — install Claude Code first (https://claude.com/claude-code)"
ok "claude $(claude --version 2>/dev/null | head -1)"

# --------------------------------------------------------------------------- #
# 3. allocator reachability sanity-check (before we install anything)         #
# --------------------------------------------------------------------------- #
log "testing allocator reachability"
client_id="${BROWSER_TOKEN%%:*}"
client_secret="${BROWSER_TOKEN#*:}"
code=$(curl -sS -o /tmp/install-mcp.healthz -w "%{http_code}" \
  -H "CF-Access-Client-Id: $client_id" \
  -H "CF-Access-Client-Secret: $client_secret" \
  "$BROWSER_POOL_URL/healthz" || true)
case "$code" in
  200) ok "/healthz 200 — $(cat /tmp/install-mcp.healthz)" ;;
  302|401|403) die "got HTTP $code — token rejected; check it was added to the Access policy as a service_token include" ;;
  000) die "could not reach $BROWSER_POOL_URL — check DNS / outbound network" ;;
  *)   die "unexpected HTTP $code from $BROWSER_POOL_URL/healthz" ;;
esac
rm -f /tmp/install-mcp.healthz

# --------------------------------------------------------------------------- #
# 4. Clone or pull the repo                                                    #
# --------------------------------------------------------------------------- #
log "fetching repo → $HOME_DIR"
if [ -d "$HOME_DIR/.git" ]; then
  (cd "$HOME_DIR" && git fetch --quiet origin "$BRANCH" && git checkout --quiet "$BRANCH" && git pull --quiet --ff-only)
  ok "pulled latest $BRANCH"
else
  git clone --quiet --depth 1 -b "$BRANCH" "$REPO_URL" "$HOME_DIR"
  ok "cloned"
fi

# --------------------------------------------------------------------------- #
# 5. Install MCP dependencies                                                  #
# --------------------------------------------------------------------------- #
log "npm ci"
(cd "$HOME_DIR/clients/mcp" && npm ci --silent >/dev/null)
ok "deps installed"
node --check "$HOME_DIR/clients/mcp/index.mjs"
ok "syntax check"

# --------------------------------------------------------------------------- #
# 6. Write token file (mode 600)                                              #
# --------------------------------------------------------------------------- #
log "writing token file"
mkdir -p "$CONFIG_DIR"
umask_orig=$(umask)
umask 077
cat > "$TOKEN_FILE" <<JSON
{
  "CF_ACCESS_CLIENT_ID":     "$client_id",
  "CF_ACCESS_CLIENT_SECRET": "$client_secret"
}
JSON
umask "$umask_orig"
chmod 600 "$TOKEN_FILE"
ok "$TOKEN_FILE (chmod 600)"

# --------------------------------------------------------------------------- #
# 7. Register MCP at user scope                                                #
# --------------------------------------------------------------------------- #
log "registering MCP $MCP_NAME (user scope)"
# Remove pre-existing user-scope entry if any (idempotent re-run)
claude mcp remove "$MCP_NAME" --scope user >/dev/null 2>&1 || true
# Add with BROWSER_POOL_URL baked in as env so the client picks it up reliably
# regardless of which shell spawns Claude Code
claude mcp add --scope user "$MCP_NAME" \
  -e "BROWSER_POOL_URL=$BROWSER_POOL_URL" \
  -- node "$HOME_DIR/clients/mcp/index.mjs" \
  >/dev/null
ok "registered"

# --------------------------------------------------------------------------- #
# 8. Smoke test                                                                #
# --------------------------------------------------------------------------- #
if [ "${BROWSER_POOL_SKIP_SMOKE:-0}" = "1" ]; then
  warn "BROWSER_POOL_SKIP_SMOKE=1 — skipping smoke"
else
  log "running smoke test against live allocator"
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found; cannot run tests/smoke.py — skipping"
  elif ! python3 -c "import httpx" >/dev/null 2>&1; then
    warn "python3 httpx missing; install with 'pip install httpx' then re-run 'python3 $HOME_DIR/tests/smoke.py'"
  else
    BROWSER_POOL_URL="$BROWSER_POOL_URL" BROWSER_TOKEN="$BROWSER_TOKEN" \
      python3 "$HOME_DIR/tests/smoke.py" || die "smoke test failed — see output above"
    ok "smoke PASS"
  fi
fi

# --------------------------------------------------------------------------- #
# 9. Done                                                                      #
# --------------------------------------------------------------------------- #
cat <<EOF

$(printf '\033[1;32m===============================================================\033[0m')
  browser-pool MCP installed.

  Repo:        $HOME_DIR
  Token:       $TOKEN_FILE  (chmod 600)
  MCP scope:   user — every Claude Code session inherits

  Next: start a fresh Claude Code session OR \`/mcp reconnect $MCP_NAME\`.
  You'll have 22 new browser_* tools.

  Quick test from Claude Code:
    browser_list_profiles
    browser_load_profile({name: "fb-benjamin"})    # if such a profile exists
    browser_navigate({url: "https://example.com"})
    browser_release

$(printf '\033[1;32m===============================================================\033[0m')
EOF
