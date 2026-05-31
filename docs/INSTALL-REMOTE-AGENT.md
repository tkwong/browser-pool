# browser-pool MCP — Install Guide for Remote Agents

**Audience**: a Claude Code agent running headless on a remote machine (typically an EC2 box reached via SSM) that needs to drive a real Chromium browser via the `browser-pool` MCP.

**You will end up with**: 22 new `browser_*` tools available in this Claude Code session, backed by a real headed Chromium pod on ML110 with magic-link viewer URL for the operator to take over when needed.

**Pre-existing pattern reference**: this repo's `tg-agent` MCP was installed via the same shape (user-scope, single-line `claude mcp add`). If you see drift between this guide and how `tg-agent` is registered locally, prefer how `tg-agent` looks and tell the operator.

---

## TL;DR — one-liner (preferred)

If the operator has issued you a Cloudflare Access service token and given you the allocator URL, the entire install collapses to:

```bash
BROWSER_POOL_URL=https://allocator.<operator-domain> \
BROWSER_TOKEN=<client_id>:<client_secret> \
  bash <(curl -fsSL https://raw.githubusercontent.com/tkwong/browser-pool/main/scripts/install-mcp.sh)
```

The installer does prereq checks (Node 22+, claude CLI, network reach), clones the repo to `~/browser-pool`, installs deps, writes the token to `~/.config/browser-pool/service-token.json` (chmod 600), registers the MCP at user scope with `BROWSER_POOL_URL` baked in, then runs the 28-check smoke test. On success you'll see `PASS: 28   FAIL: 0` followed by a green completion box.

After that: start a fresh Claude Code session (or `/mcp reconnect browser-pool` in an existing one) and the 22 `browser_*` tools are live.

Skip directly to **§10. After install — confirm to the operator** to report back.

---

## Full manual path (for the curious or when the one-liner fails)

The one-liner does each of these steps idempotently. Use this section if the one-liner errors out somewhere and you need to debug, or if your environment can't run the script as-is.

---

## 0. Prerequisites — check first, fail fast

```bash
# Node ≥ 22 — required because the control sidecar (and dump/inject client logic)
# uses the global WebSocket added in Node 22. Node 20 will throw "WebSocket is
# not defined" at runtime.
node --version    # expect: v22.x.x or higher

# claude CLI must be installed and at scope=user MCP registry must be writable
which claude
ls -la ~/.claude.json   # exists? writable?

# Outbound network to the allocator (CF Tunnel hostname, public on the internet,
# gated by CF Access). If this curl hangs or times out, ask the operator before
# proceeding — likely a VPC egress / security group issue.
curl -sS -o /dev/null -w "%{http_code}\n" "$BROWSER_POOL_URL/healthz"
# Expect 401 or 302 (no token yet) — anything in 4xx/3xx means reachable.
# 000 or timeout = network blocked, STOP here and report to operator.
```

If `node --version` is below 22, install with `fnm` (lightweight, no sudo):

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc   # or ~/.zshrc depending on shell
fnm install 22 && fnm default 22
node --version     # verify v22.x
```

---

## 1. Clone the repo

```bash
cd ~
git clone https://github.com/tkwong/browser-pool.git
cd browser-pool/clients/mcp
```

The upstream repo is public; no git auth needed. If you're cloning a private fork instead, ask the operator for whichever auth pattern that fork uses.

---

## 2. Install MCP client dependencies

```bash
cd ~/browser-pool/clients/mcp
npm ci    # uses lockfile, deterministic; takes ~30s
```

Verify the entrypoint script loads cleanly:

```bash
node --check index.mjs && echo "syntax OK"
```

---

## 3. Service token — operator hand-off required

The MCP authenticates to the allocator via a Cloudflare Access **service token** (`CF-Access-Client-Id` + `CF-Access-Client-Secret`). This is **NOT** the same as any AWS IAM credential. The token is issued by the operator from the Cloudflare Zero Trust dashboard.

**Ask the operator (via the same channel that gave you this guide)** to:

1. Open https://one.dash.cloudflare.com → Access → Service Auth → Service Tokens
2. Create a new token with a descriptive name like `mcp-<agent-name>` (e.g. `mcp-asset-management`, `mcp-polynft`) so per-agent revoke is possible
3. Add this token's id to the CF Access policy on the `allocator.<operator-domain>` application (`Include → Service Auth Token → <new token>`). Both the `allow` policy and the `non_identity` policy must include the token — `allow`-only causes silent 302 redirects.
4. Send you back the JSON, shape:

```json
{
  "CF_ACCESS_CLIENT_ID":     "abc123def456.access",
  "CF_ACCESS_CLIENT_SECRET": "<64-hex-or-longer>"
}
```

**DO NOT share or log the secret. DO NOT commit it.** Treat it like an AWS access key.

Save it to disk with strict perms:

```bash
mkdir -p ~/.config/browser-pool
# Paste the JSON the operator sent you into this heredoc — heredoc avoids the
# secret leaking into shell history vs `echo "$X" > file`
cat > ~/.config/browser-pool/service-token.json <<'EOF'
{
  "CF_ACCESS_CLIENT_ID":     "...replace-with-real...",
  "CF_ACCESS_CLIENT_SECRET": "...replace-with-real..."
}
EOF
chmod 600 ~/.config/browser-pool/service-token.json

# Sanity-check the file is valid JSON with both keys
jq -e '.CF_ACCESS_CLIENT_ID and .CF_ACCESS_CLIENT_SECRET' \
  ~/.config/browser-pool/service-token.json \
  && echo "token file OK"
```

---

## 4. Smoke-test the token + allocator reachability

Before registering the MCP, prove the token works against the live allocator:

```bash
CID=$(jq -r .CF_ACCESS_CLIENT_ID ~/.config/browser-pool/service-token.json)
CSEC=$(jq -r .CF_ACCESS_CLIENT_SECRET ~/.config/browser-pool/service-token.json)

curl -sS "$BROWSER_POOL_URL/healthz" \
  -H "CF-Access-Client-Id: $CID" \
  -H "CF-Access-Client-Secret: $CSEC" \
  | jq .
```

Expected:

```json
{ "ok": true, "pool": ["chrome-vnc-0", "chrome-vnc-1"] }
```

If you get `302` or HTML redirect to a CF login page → service token is not attached to the Access policy. Send the token id back to the operator.

If you get `403` → token is wrong / typo'd / not added to policy.

If you get the JSON → ✅ you are good to register the MCP.

---

## 5. Register the MCP at user scope

```bash
claude mcp add --scope user browser-pool \
  node ~/browser-pool/clients/mcp/index.mjs
```

`--scope user` is critical — without it, `claude mcp add` binds the registration to the current working directory's project key, and the next Claude Code session in a different cwd will not see the MCP. We learned this from `tg-agent` (the project-scope footgun cost the operator real debug time).

Verify:

```bash
claude mcp list 2>&1 | grep browser-pool
# expect: browser-pool: node /home/<user>/browser-pool/clients/mcp/index.mjs - ✓ Connected
```

If status shows `✗ Failed`:
- `node --version` < 22?
- token file missing / wrong perms / wrong shape?
- `node ~/browser-pool/clients/mcp/index.mjs` directly — stderr will tell you

---

## 6. Verify end-to-end inside Claude Code

Start a fresh Claude Code session (or `/mcp reconnect browser-pool` in an existing one). You should see 22 new `browser_*` tools. Test the basic flow:

```
browser_list_profiles
→ {profiles: [...]}

browser_load_profile({name: "fb-benjamin"})
→ {loaded: true, profile_injected: {cookies: 11, origins: 1}, view_url: "https://...trycloudflare.com"}

browser_get_url
→ {url: "..."}

browser_release
→ {ok: true, released_lease_id: "..."}
```

(Substitute `fb-benjamin` with whatever profile names the operator told you to use. `browser_list_profiles` shows what's available.)

---

## 7. Tool surface quick-reference

| Category | Tools |
|---|---|
| Lifecycle | `browser_load_profile {name}`, `browser_release {save_as?, save_domain_filter?}`, `browser_get_session_info`, `browser_get_view_url` |
| Navigation | `browser_navigate {url}`, `browser_get_url`, `browser_get_title` |
| Interaction | `browser_click`, `browser_type`, `browser_press_key`, `browser_evaluate {expression}` |
| Observation | `browser_snapshot`, `browser_take_screenshot`, `browser_wait_for` |
| Tabs | `browser_list_tabs`, `browser_new_tab`, `browser_switch_tab`, `browser_close_tab` |
| Human offload | `browser_request_user_help {reason, wait_for?}`, `browser_wait_for_user_done {help_id, condition}` |
| Profile mgmt | `browser_list_profiles`, `browser_delete_profile {name}` |

Full details: each tool's schema is in the MCP server registration; call `tool_schema(name)` if uncertain.

---

## 8. Operating notes (read once before you start using)

- **Lazy acquire**: the first `browser_*` call leases a pod. No allocation until then.
- **Idle release**: 5 min of no `browser_*` calls auto-releases the pod. Reset by any tool call. Paused during `help_mode` (between `browser_request_user_help` and `browser_wait_for_user_done`).
- **Per-token concurrent cap**: pool enforces `MAX_LEASES_PER_TOKEN=1` (production default). If you try to hold 2 leases at once on the same service token, the 2nd `acquire` returns 429 `token_quota_exceeded`. Release before re-acquiring.
- **Pool exhaustion**: pool size is 2 pods total (shared across ALL agents/operators using the same allocator). When full, your `acquire` returns 423 `pool_exhausted` + `Retry-After: 30`. Retry with backoff or release any active leases.
- **Profile inject = sticky session**: `browser_load_profile` injects cookies into a freshly-wiped pod. To save updated state back (e.g. FB rotates session token), call `browser_release {save_as: <name>}`. Without `save_as`, the pod is wiped on release — anything you did is lost.
- **View URL**: every lease gets a magic-link `https://<random>.trycloudflare.com` viewer URL. Share with the operator when (a) you hit a CAPTCHA, (b) you need login that requires fingerprint/passkey, (c) anything visual the operator needs to confirm. The URL dies when the lease ends.
- **Real OS X11 events**: when the operator clicks via the view URL, it's a real X11 event from Selkies, NOT a CDP synthetic event. This passes Cloudflare Turnstile / BrowserScan etc. CDP `browser_click` from you is detectable by mature anti-bot — prefer human-offload for any anti-bot-protected click.

---

## 9. If something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| `claude mcp list` shows ✗ Failed | Node < 22 or syntax error from a corrupted git checkout | `node --version`; `cd ~/browser-pool && git status && git pull` |
| Every `browser_*` errors `pool_exhausted` | Real exhaustion (someone else holds both pods) or your own token already has an active lease (429 surfaces as pool_exhausted in some client wrappers) | `curl "$BROWSER_POOL_URL/status" -H ...` to see actual state; release any held lease |
| `browser_navigate` returns but page is blank | Chromium crashed mid-tab; liveness probe will restart container within ~90s | retry; if persistent, tell operator |
| Token suddenly 401s | Operator rotated / revoked it | request new token, replace file |
| View URL `DNS_PROBE_FINISHED_NXDOMAIN` | DNS propagation lag for trycloudflare subdomain (10-30s) | wait 30s, refresh |
| Smoke test script available? | `cd ~/browser-pool && python3 tests/smoke.py` runs 28 assertions against the live allocator using your token | if 28/28 PASS, the install is good end-to-end |

---

## 10. After install — confirm to the operator

DM the operator back with:

- `node --version`
- `claude mcp list 2>&1 | grep browser-pool` output
- `python3 ~/browser-pool/tests/smoke.py 2>&1 | tail -5` (the PASS/FAIL summary line)
- Which profiles you can see via `browser_list_profiles`

If all green, you're ready to use the pool. Operator can now ask you to do things like "log into FB via the browser pool and check messages" and you have the tools.
