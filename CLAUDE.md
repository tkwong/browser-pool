# browser-pool — agent guidance

A pool of real headed Chromium pods (Xvfb + noVNC, authentic fingerprint) that
remote agents **lease over HTTP** to drive a browser. `allocator/main.py`
(FastAPI) hands out leases; `clients/mcp/` wraps it as the `browser_*` MCP tools.

## ⚠️ CDP reach — the #1 thing agents get wrong

There are TWO ways to reach a pod's CDP endpoint. Pick the right one:

| Path | URL shape | Who | Tailscale? |
|------|-----------|-----|-----------|
| **Published (agents)** | `https://cdp-chrome-vnc-N.cartforge.net` — public CF Tunnel, gated by CF Access service token | any remote agent, anywhere | **NO** |
| Operator-only | `http://100.108.4.108:3092N` — Tailscale NodePort | operator on the tailnet, for low-latency / `scripts/dump-profile.mjs` | yes (operator's own box) |

**Rule: a remote agent NEVER needs Tailscale.** The allocator returns the public
CF Tunnel `cdp_url` from `POST /acquire`. If an agent is ever told to "enable
Tailscale" to reach CDP, that is the bug fixed in **v2.5 (2026-05-31)**: the
allocator used to hand out the `100.x` Tailscale NodePort, which a remote EC2
(not on the tailnet) couldn't reach — `connectOverCDP` timed out. The fix routes
CDP through CF Tunnel.

`100.108.4.108` is a Tailscale (CGNAT `100.x`) address = operator infra only.
Never put it in agent-facing config, `cdp_url`, or docs.

## Deploy / render — never hand-edit `build/`

`build/` is **gitignored generated output**. `make bundle` inlines
`allocator/main.py` into `k8s/20-allocator.yaml` → `build/k8s/*.rendered.yaml`.

- Deploy via `make apply` (local) or `make remote-apply` (rsync to the node,
  re-renders there — excludes `build/`, so it's always fresh on the node).
- **Do NOT edit `build/k8s/*.rendered.yaml`** — edit the source (`allocator/main.py`
  or `k8s/*.yaml`) then `make bundle`, else the change is lost on next render.
- A stale local `build/` once still held the old `100.x` NodePort env. If you see
  `100.108.4.108:3092N` as a `CDP_URL_*` *value* anywhere, the artifact is stale —
  re-render. (Comments mentioning it as the operator path are fine.)

## Source of truth for CDP env

`k8s/20-allocator.yaml` → `CDP_URL_CHROME_VNC_{0,1}` are the published CF Tunnel
hostnames. That file is authoritative; the rendered artifact is derived.

## Tests

- `make smoke` — fast, allocator **REST surface only** (no CDP). **Green smoke does
  NOT prove CDP is reachable** — that gap is exactly what hid the Tailscale bug.
- `make integration` — Playwright; actually connects CDP + navigates. This is the
  one that catches the "operator-only Tailscale URL" reach failure.
