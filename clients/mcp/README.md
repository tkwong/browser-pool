# browser-pool MCP

A Model Context Protocol server that lets Claude (or any MCP-compatible
agent) drive a remote Chromium browser from the [browser-pool](../../) ML110
pool — with lazy acquire, idle release, and a noVNC magic-link for
human takeover.

## How it differs from `playwright-mcp`

| | `playwright-mcp` | `browser-pool` (this) |
|---|---|---|
| Browser | Spawns local Chrome | Connects to a remote pool pod over CDP |
| CDP endpoint | Static, fixed at `--cdp-endpoint` startup arg | Dynamic, fetched from allocator on first tool call |
| Lifecycle | Browser open for entire MCP lifetime | **Lazy acquire** on first call + **idle release** after 5 min idle |
| Human takeover | Not built-in | `browser_request_user_help` → noVNC magic-link → `browser_wait_for_user_done` polls page state |
| Anti-bot | Whatever local Chrome does | Real headed Chromium in Xvfb (real OS X11 events); passes Cloudflare Turnstile when user clicks via noVNC |

## Install

### 1. Save the CF Access service token

The MCP authenticates to the allocator with a Cloudflare Access service token.
Save it to `~/.config/browser-pool/service-token.json` (chmod 600):

```json
{
  "CF_ACCESS_CLIENT_ID": "e0b51d…access",
  "CF_ACCESS_CLIENT_SECRET": "…"
}
```

If you don't have one, generate via:
```bash
# (one-off, requires CF API access)
curl -X POST -H "X-Auth-Email: $EMAIL" -H "X-Auth-Key: $CF_KEY" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/service_tokens" \
  -d '{"name":"browser-pool-bot","duration":"8760h"}' \
  | jq '.result | {CF_ACCESS_CLIENT_ID: .client_id, CF_ACCESS_CLIENT_SECRET: .client_secret}' \
  > ~/.config/browser-pool/service-token.json
chmod 600 ~/.config/browser-pool/service-token.json
```

### 2. Install dependencies

```bash
cd ~/Projects/browser-pool/clients/mcp
npm install
```

### 3. Register the MCP with Claude Code

```bash
claude mcp add browser-pool -- node /Users/benjaminwong/Projects/browser-pool/clients/mcp/index.mjs
```

Start a new Claude Code session — `mcp__browser-pool__browser_*` tools should
appear.

## Tools

### Navigation & observation
| tool | purpose |
|---|---|
| `browser_navigate(url, wait_until?, timeout_ms?)` | go to URL — triggers lazy acquire on first call |
| `browser_snapshot()` | a11y tree + URL + title — token-efficient page view |
| `browser_take_screenshot(full_page?)` | base64 PNG — for when a11y isn't enough |
| `browser_get_url()` / `browser_get_title()` | scalars |

### Interaction
| tool | purpose |
|---|---|
| `browser_click(selector, timeout_ms?)` | CSS click |
| `browser_type(selector, text, submit?)` | fill input; submit=true presses Enter |
| `browser_press_key(key)` | Playwright key syntax (`Enter`, `Control+A`, …) |
| `browser_evaluate(expression)` | JS in page context |
| `browser_wait_for({selector | url | text | time_ms}, timeout_ms?)` | wait for condition |

### Tabs
`browser_list_tabs()`, `browser_new_tab(url?)`, `browser_switch_tab(index)`, `browser_close_tab(index?)`

### Session / lease
| tool | purpose |
|---|---|
| `browser_get_view_url()` | noVNC viewer URL (shareable any time) |
| `browser_get_session_info()` | full lease state |
| `browser_release()` | explicit release (next browser_* will lazy-re-acquire) |

### Human offload
| tool | purpose |
|---|---|
| `browser_request_user_help({reason, wait_for?})` | returns `{help_id, view_url, instructions}`. Pauses the idle reaper. |
| `browser_wait_for_user_done({help_id, condition, deadline_seconds?})` | polls page until `condition` matches; returns `{outcome, final_url, title}` |

#### Typical offload pattern

```ts
// Agent script (pseudocode)
await mcp.browser_navigate("https://www.facebook.com/")
const snap = await mcp.browser_snapshot()
if (snap.contains_login_form) {
  const help = await mcp.browser_request_user_help({
    reason: "Need login to Facebook",
    wait_for: { url_matches: "/home|/feed" }
  })
  // help.view_url is e.g. https://random.trycloudflare.com
  await mcp_telegram.reply({ chat_id, text: `Please login: ${help.view_url}` })
  const done = await mcp.browser_wait_for_user_done({
    help_id: help.help_id,
    deadline_seconds: 600,
  })
  if (done.outcome !== "satisfied") throw new Error("login timed out")
}
// proceed with logged-in browser
```

## Configuration (env)

| env | default | meaning |
|---|---|---|
| `ALLOCATOR_URL` | `https://allocator.cartforge.net` | allocator base URL |
| `ALLOCATOR_SERVICE_TOKEN_FILE` | `~/.config/browser-pool/service-token.json` | CF Access service-token JSON |
| `BROWSER_POOL_TIER` | `chrome-vnc` | which pool tier to request |
| `BROWSER_POOL_ACQUIRE_TTL` | `3600` | lease TTL in seconds |
| `BROWSER_POOL_IDLE_RELEASE_MS` | `300000` | auto-release after this many ms of no tool calls (paused during help) |

## Lifecycle

```
MCP startup ─→ NO browser, NO lease.

First browser_* call ─→ POST allocator/acquire ─→ chromium.connectOverCDP
                                                  ↓
                                              [browser ready]

… tool calls update lastActivityMs …

Idle > IDLE_RELEASE_MS  (and no active help) ─→ teardown, lease returned.

Next browser_* call    ─→ lazy re-acquire (may get a different pod).

SIGTERM / SIGINT / process exit ─→ teardown, lease returned (best-effort).
```

## Troubleshooting

- **`pool_exhausted`**: all pods leased. Wait for one to free, or scale the pool: `kubectl scale statefulset chrome-vnc --replicas=N -n browser-pool`.
- **`allocator did not return cdp_url`**: allocator is on an older version; redeploy from `k8s/20-allocator.yaml` (it now reads `CDP_URL_<POD_UPPERCASE>` env).
- **CDP connect fails**: pod's socat sidecar must be running. `kubectl -n browser-pool get pod chrome-vnc-0 -o jsonpath='{.status.containerStatuses[*].name}{": "}{.status.containerStatuses[*].ready}'` should show `chromium cdp-relay: true true`.
- **noVNC viewer says `WebCodecs require HTTPS`**: the view_url MUST be `https://`. If you're hitting the NodePort 30930 directly, that's HTTP — use the trycloudflare URL from the lease instead.
