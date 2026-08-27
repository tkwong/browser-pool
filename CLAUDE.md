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

## Never yank a session a human is in

`/release` wipes the pod's profile and kills the viewer tunnel. Doing that while
the operator is mid-login destroys their work (the 2026-08-24 incident: a login
finished, then the agent released and the session vanished).

The sidecar's `GET /viewers` counts durable ESTABLISHED sockets on the noVNC
ports (3000/3001) — it samples twice, so the kubelet's `tcpSocket: 3000`
readiness probe can't false-positive. The allocator refuses `/release` with
**409 `viewer_attached`** when that count is > 0, and exposes
`GET /viewers/{lease_id}` so a client can preflight *before* it closes its own
browser handle. `force: true` overrides; `viewers: -1` means unknown and never
blocks, so a sidecar outage can't strand a lease.

The TTL reaper does not go through `/release`, so for a long time nothing
protected *it* — on 2026-08-27 the hour ran out while an operator was mid-login
and the reaper wiped the pod under them. It is now viewer-aware too: an expired
lease with a live viewer is deferred `VIEWER_HOLD_GRACE` (60s) at a time instead
of wiped. **`MAX_SESSION` (default 4h) is the hard backstop now** — no viewer and
no heartbeat can push a lease past it, so a pod always comes back.

## Lease lifetime: heartbeat, not wall clock

`ttl` on `/acquire` is capped at `MAX_TTL` (1h), which used to be an absolute
death sentence. `POST /extend` makes it a rolling window: each call grants up to
`MAX_TTL` **from now**, so a client that checks in lives on and a client that
goes silent still dies within its last granted ttl. The MCP client heartbeats
from its existing 30s timer whenever the lease has under 5 min left.

Two independent reapers, and they are not the same thing — the 2026-08-27
post-mortem turned on telling them apart:

| | client idle reaper (`clients/mcp/index.mjs`) | allocator TTL reaper (`allocator/main.py`) |
|---|---|---|
| Trigger | no `browser_*` call for `IDLE_RELEASE_MS` (**25 min**) | `expires_at` passed |
| Path | `POST /release` → viewer guard applies (409 → backoff) | direct wipe → its own `_viewer_hold()` check |
| Paused by | `help_mode`, `browser_hold`, or `IDLE_RELEASE_MS=0` | a live viewer, up to `MAX_SESSION` |

`browser_hold({minutes})` is the agent-facing knob: it pauses the client idle
reaper *and* keeps the lease renewed. Use it before handing out a `view_url`
yourself — `browser_request_user_help` already implies it, a bare
`browser_get_view_url` does not.

Note the tail: after the human closes the tab, cloudflared holds origin
keep-alives for up to ~90s (measured: 4 sockets at +8s, 0 by ~+80s), so the
count decays rather than dropping instantly. The MCP client waits that out
(`RELEASE_VIEWER_WAIT_MS`, default 45s) on an explicit release. Socket presence
is deliberately the conservative signal — a false "someone is watching" only
delays a release; a false "nobody is watching" destroys a login.

## Tests

- `make smoke` — fast, allocator **REST surface only** (no CDP). **Green smoke does
  NOT prove CDP is reachable** — that gap is exactly what hid the Tailscale bug.
- `make integration` — Playwright; actually connects CDP + navigates. This is the
  one that catches the "operator-only Tailscale URL" reach failure.
- Smoke needs `httpx`, which is not in the system python3: run it as
  `BROWSER_POOL_URL=https://allocator.cartforge.net uv run --with httpx python tests/smoke.py`.
- Smoke only covers the "nobody is watching" half of the viewer guard. The
  positive case needs a real noVNC socket — hold one from inside the pod
  (`node -e "require('net').connect(3000,'127.0.0.1')"`) or open the lease's
  `view_url` in a browser, then assert `/release` returns 409.
