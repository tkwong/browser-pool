# browser-pool

Self-hosted shared pool of real headed Chromium browsers, leasable over HTTP +
drivable over CDP, with magic-link viewer URLs for human takeover. Built for
agent use-cases that need authentic browser fingerprints (passes Cloudflare
Turnstile, BrowserScan ≈100% authentic) and a way for a human operator to
take over mid-flow to clear a captcha or log in.

```
┌──────────────────────────────────────────────────────────────────────┐
│  k3s namespace: browser-pool                                         │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  StatefulSet chrome-vnc (N replicas, per-pod PVC)              │  │
│  │   ┌──────────────────────┐ ┌──────────────────────┐            │  │
│  │   │ chrome-vnc-0         │ │ chrome-vnc-1         │  ...       │  │
│  │   │  ├ chromium (Xvfb)   │ │  ├ chromium (Xvfb)   │            │  │
│  │   │  ├ cdp-relay (nginx) │ │  ├ cdp-relay (nginx) │            │  │
│  │   │  └ control (Node)    │ │  └ control (Node)    │            │  │
│  │   └──────────────────────┘ └──────────────────────┘            │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                ▲                                     │
│  ┌─────────────────────────────┴────────────────────────────────┐    │
│  │  Deployment: allocator (FastAPI)                             │    │
│  │   /acquire {profile?} → {cdp_url, view_url, lease_id, …}     │    │
│  │   /release {lease_id, save_as?} → wipes pod via sidecar      │    │
│  │   /profiles ← named profile store (1Gi PVC)                  │    │
│  └─────────────────────────────┬────────────────────────────────┘    │
│                                │                                     │
│  ┌─────────────────────────────┴────────────────────────────────┐    │
│  │  cloudflared (named tunnel, 1 public hostname)               │    │
│  └─────────────────────────────┬────────────────────────────────┘    │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │
                  Cloudflare Zero Trust (Access service token)
                                 │
       allocator.<yourdomain>  ←  one DNS, every lease muxed via /acquire
```

Plus a per-lease ephemeral Quick Tunnel (random `*.trycloudflare.com`) that
points at the leased pod's Selkies WebRTC viewer — share this with a human
to live-watch and click into the browser without auth friction.

## What you get

| Capability | How |
|---|---|
| Real browser fingerprint | linuxserver/chromium in Xvfb desktop — passes CF Turnstile, BrowserScan |
| Agent-driven via CDP | nginx sidecar relays `9223 → 127.0.0.1:9222` past Chrome 148's anti-DNS-rebinding |
| Human takeover | per-lease magic-link Quick Tunnel (`https://random.trycloudflare.com`) to a Selkies WebRTC viewer; real X11 events bypass CDP synthetic detection |
| Sticky named profiles | `/acquire {profile: name}` injects cookies + localStorage; `/release {save_as: name}` dumps back to allocator-side PVC |
| Friend-share safe | every release wipes via sidecar CDP (`Storage.clearCookies`, per-origin `Storage.clearDataForOrigin`, close non-blank tabs) — next leaseholder gets a clean Chromium |
| Per-token rate limit | `MAX_LEASES_PER_TOKEN=1` keyed off `CF-Access-Client-Id` — one looping agent can't starve the others |
| Magic-link dies on release | `cloudflared` subprocess killed → random subdomain instantly stops resolving |

## Two audiences

### 👤 Agent / client user — install the MCP only

You have a Cloudflare Access service token from someone running an existing
pool. Add the 22 `browser_*` tools to your Claude Code (or any MCP host) with
the one-liner:

```bash
BROWSER_POOL_URL=https://allocator.example.com \
BROWSER_TOKEN=<client_id>:<client_secret> \
  bash <(curl -fsSL https://raw.githubusercontent.com/tkwong/browser-pool/main/scripts/install-mcp.sh)
```

Full guide for remote / headless setups (EC2 via SSM, etc):
**[docs/INSTALL-REMOTE-AGENT.md](docs/INSTALL-REMOTE-AGENT.md)**.

### 🏗️ Operator — run your own pool

You want to deploy the whole stack on your own k3s cluster, behind your own
Cloudflare Access. See **[k8s/](k8s/)** and the **[Makefile](Makefile)**.
Short version:

1. Cloudflare Zero Trust → create Tunnel "browser-pool"; create Access
   application with a non-identity service-token policy on
   `allocator.<yourdomain>`.
2. `kubectl -n browser-pool create secret generic cloudflared-tunnel
   --from-literal=token='<connector-token>'`
3. Edit the manifests' example hostnames (`cartforge.net`) and node IP
   (`Makefile`'s `ML110` var) to your own.
4. `make remote-apply` — rsyncs to the node and runs `make apply` there.
5. Issue a service token, then `bash <(curl …)` the client install above
   from your laptop to smoke-test.

## Repo layout

```
allocator/                FastAPI lease broker (Python, single-file)
clients/mcp/              MCP client (Node, talks to allocator over HTTP+CDP)
k8s/                      Manifests: namespace, chrome-vnc STS, allocator, tunnel
scripts/
  control-sidecar.mjs       per-pod sidecar (source-of-truth, inlined to ConfigMap by Makefile)
  dump-profile.mjs          standalone profile dump (Playwright, runs from your laptop)
  install-mcp.sh            curl|bash one-liner for end-users
tests/smoke.py            28-check smoke against a live allocator
docs/
  INSTALL-REMOTE-AGENT.md   guide for remote Claude Code agents (EC2/SSM)
```

## Tool surface (MCP client)

22 tools across 7 categories — see
[docs/INSTALL-REMOTE-AGENT.md §7](docs/INSTALL-REMOTE-AGENT.md#7-tool-surface-quick-reference)
for the full table. Highlights:

- `browser_load_profile {name}` — sticky session inject
- `browser_release {save_as?, save_domain_filter?}` — dump → wipe
- `browser_request_user_help` + `browser_wait_for_user_done` — human offload
  flow over the magic-link viewer URL
- `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_evaluate`
  — standard browse + drive

## Smoke test

```bash
pip install httpx
BROWSER_POOL_URL=https://allocator.example.com \
BROWSER_TOKEN=<client_id>:<client_secret> \
  python3 tests/smoke.py
# expect: PASS: 28   FAIL: 0
```

## Why "browser pool" instead of headless cloud

A 6-month detour through Steel.dev and Browserless taught the punchline:
hosted browser APIs send `Input.dispatchMouseEvent` over CDP, which Cloudflare
Turnstile detects in ~100ms with a click loop. Real headed Chromium driven by
**real OS X11 events** (Selkies WebRTC viewer doing the human click) passes
every challenge. CDP automation from the agent side works fine on non-bot-
gated sites, and humans take over for the captcha gates. This pool is the
minimum viable infra to do that pattern at multi-tenant scale.

## License

MIT.
