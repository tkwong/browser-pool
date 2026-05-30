# browser-pool

Shared pool of headless Steel browser instances on ML110 (k3s), fronted by a
small lease broker. Agents (Telegram bots, automations, anything) `acquire`
a browser, use it, `release` it. The pool returns the pod to a clean state
for the next caller.

```
┌──────────────────────────────── ML110 / k3s / ns: browser-pool ───────────────────────────────┐
│                                                                                              │
│   StatefulSet steel (3 replicas, ephemeral)                                                  │
│     steel-0   steel-1   steel-2          ← Steel browser-api, one Chrome each                │
│        ▲        ▲        ▲                                                                   │
│        └────────┴────────┘                                                                   │
│                 │                                                                            │
│        ┌────────┴────────┐                                                                   │
│        │ Deployment       │  POST /acquire   -> { lease_id, pod, pod_url, expires_at }       │
│        │ allocator        │  POST /release   -> frees the pod                                │
│        │ (FastAPI, 1×)    │  GET  /status    -> who has what                                 │
│        └────────┬────────┘                                                                   │
│                 │                                                                            │
│        ┌────────┴────────┐                                                                   │
│        │ Deployment       │  in-cluster cloudflared (separate tunnel)                        │
│        │ cloudflared (2×) │  resolves *.svc.cluster.local                                    │
│        └────────┬────────┘                                                                   │
└─────────────────┼────────────────────────────────────────────────────────────────────────────┘
                  ▲ CF Tunnel
                  │
   Cloudflare Zero Trust  +  CF Access (huskydata.io SSO  OR  service token)
                  │
   allocator.cartforge.net    steel-{0,1,2}.cartforge.net
```

## Design decisions (locked)

| Decision | Choice |
|---|---|
| Pool size | 3 replicas (scale via `kubectl scale statefulset steel --replicas=N`) |
| Pod storage | `emptyDir` — wiped on pod restart; no PVCs |
| Login state | **Pool does NOT persist auth.** Agents save their own state (cookies/localStorage) elsewhere (e.g. NocoDB) and re-inject via Steel `sessionContext` on each acquire. |
| Full-pool behaviour | **423 Locked + Retry-After: 30** — fail-fast, the agent retries |
| Allocator state | In-memory (v1). Don't scale allocator past 1 replica. v2: move to NocoDB |
| Auth | CF Access on the public hostname + optional bearer token on the allocator itself |

## Files

```
browser-pool/
├── README.md
├── Makefile                       # bundle + apply + smoke
├── k8s/
│   ├── 00-namespace.yaml          # `browser-pool` ns, no zeabur_* labels
│   ├── 10-steel-statefulset.yaml  # 3× steel pods + headless Service
│   ├── 20-allocator.yaml          # ConfigMap + Deployment + Service (FastAPI from CM)
│   └── 30-cloudflared-tunnel.yaml # in-cluster CF Tunnel connector
├── allocator/
│   └── main.py                    # FastAPI lease broker
└── tests/
    └── smoke.py                   # acquire -> CDP connect -> example.com -> release
```

## Prerequisites

- **kubectl** access to the ML110 k3s cluster (`KUBECONFIG=/etc/rancher/k3s/k3s.yaml` on the host).
- A **Cloudflare Tunnel** created in CF Zero Trust dashboard for this pool —
  copy the connector token before applying `30-cloudflared-tunnel.yaml`.
- DNS for `cartforge.net` already on Cloudflare ✅ (verified).

## Deploy (3 commands)

```bash
# 1. Tunnel secret (paste the token from CF Zero Trust dashboard)
kubectl create namespace browser-pool || true
kubectl -n browser-pool create secret generic cloudflared-tunnel \
  --from-literal=token='PASTE_TOKEN_HERE'

# 2. (Optional) bearer token on the allocator
kubectl -n browser-pool create secret generic allocator-secrets \
  --from-literal=ALLOCATOR_SERVICE_TOKEN="$(openssl rand -hex 32)"

# 3. Render + apply all manifests
make apply
```

For a one-shot deploy from your laptop (rsync + remote apply on ML110):

```bash
make remote-apply         # rsyncs to root@100.108.4.108 + runs `make apply` there
```

## CF Zero Trust dashboard — Public Hostnames to add

In the new tunnel created above, add **4 public hostnames**:

| Hostname | Service | Notes |
|---|---|---|
| `allocator.cartforge.net` | `http://allocator.browser-pool.svc.cluster.local` | Agents hit this to lease |
| `steel-0.cartforge.net` | `http://steel-0.steel.browser-pool.svc.cluster.local:3000` | Per-pod, agents CDP into via SDK |
| `steel-1.cartforge.net` | `http://steel-1.steel.browser-pool.svc.cluster.local:3000` | — |
| `steel-2.cartforge.net` | `http://steel-2.steel.browser-pool.svc.cluster.local:3000` | — |

## CF Access — Applications to create

| Application | Policy | Why |
|---|---|---|
| `allocator.cartforge.net` | huskydata.io SSO **OR** service token (group: `bots`) | Telegram bots use service token; you log in via SSO |
| `steel-*.cartforge.net` (one app per pod, or wildcard `*.cartforge.net` with same policy) | service token only | Agents only; humans don't hit these directly |

A 5th hostname `viewer.cartforge.net` (admin live-view) can be added later;
for now use `kubectl port-forward svc/steel 3000:3000 -n browser-pool` and
hit `http://localhost:3000/v1/devtools/inspector.html` for manual debug.

## Agent code (the working template — copy/paste)

Every HTTP/WS hop is fronted by CF Access, so the **service token headers must
be sent on EVERY call** — allocator, Steel SDK, AND the Playwright CDP
WebSocket. Credentials sit in `/tmp/browser_pool_service_token.json`
(`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`); move them into Keychain /
1Password / a Kubernetes Secret for production.

```js
import { chromium } from 'playwright-core';
import Steel from 'steel-sdk';
import fs from 'fs';

const ALLOCATOR = 'https://allocator.cartforge.net';
const { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } =
  JSON.parse(fs.readFileSync('/path/to/service_token.json','utf8'));
const CF_HEADERS = {
  'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
};

// 1. lease a browser
const lease = await (await fetch(`${ALLOCATOR}/acquire`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...CF_HEADERS },
  body: JSON.stringify({ ttl: 600 }),
})).json();

try {
  // 2. create a LIVE session (launches Chrome inside the pod)
  const steel = new Steel({
    baseURL: lease.pod_url,
    steelAPIKey: 'self-host',
    defaultHeaders: CF_HEADERS,   // CF Access on every Steel SDK call
  });
  const session = await steel.sessions.create({
    userAgent: 'Mozilla/5.0 ...',
    skipFingerprintInjection: true,   // avoids Steel fingerprint-gen bug
    sessionContext: mySavedAuthState, // optional: re-inject prior cookies
  });

  // 3. CDP-connect Playwright with the CF Access headers on the WebSocket
  const ws = lease.pod_url.replace(/^https/,'wss').replace(/\/$/,'') + '/';
  const browser = await chromium.connectOverCDP(ws, { headers: CF_HEADERS });
  const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
  await page.goto('https://example.com');
  // ... do work ...
  await browser.close();                // disconnect client; does not kill remote browser
  // DO NOT call steel.sessions.release() — it triggers a Steel fingerprint-gen
  // bug. The allocator's /release endpoint cleans up server-side instead.
} finally {
  // 4. always release back to the pool
  await fetch(`${ALLOCATOR}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CF_HEADERS },
    body: JSON.stringify({ lease_id: lease.lease_id }),
  });
}
```

## Hard-won lessons (deploy 2026-05-28)

These all bit us in production; without them the deploy doesn't work. Keep
them in the README so the next session doesn't re-derive.

1. **Tunnel ingress needs Host header rewrite** for steel-* hostnames:
   `originRequest.httpHostHeader: "localhost"`. Chrome's DevTools Protocol
   rejects WS upgrades when `Host:` is not an IP or `localhost` (anti-DNS-
   rebinding). Without this you get `500 — Host header is specified and is
   not an IP address or localhost`.
2. **CF Access service-token policies must use `decision: "non_identity"`**,
   not `"allow"`. Service tokens have no user identity; `allow` policies are
   intended for IDP-backed users and silently ignore the `CF-Access-Client-*`
   headers. With the wrong decision you get 302 redirect to login even with
   correct credentials, and the JWT meta logs `service_token_status: false`.
3. **Session creation order matters.** Steel pods boot with an `idle` session
   placeholder; Chrome isn't running. `connectOverCDP` against `idle` fails
   with WS EOF / 502. Always `client.sessions.create()` first to transition
   the session to `live` (Chrome launches), THEN open the CDP WS.
4. **Pass `skipFingerprintInjection: true` on `sessions.create()`** and
   **skip `steel.sessions.release()`**. Steel's fingerprint-generator
   dependency intermittently fails ("Fingerprint error during generation:
   Failed to generate a consistent fingerprint after 10 attempts") on both
   arm64 (Apple Silicon) and on the ML110 Xeon. Skipping fingerprint
   injection avoids the create-side hit; letting the allocator do server-side
   cleanup avoids the release-side hit.
5. **CDP WebSocket needs the same CF Access headers** as REST calls. Use
   `chromium.connectOverCDP(ws, { headers: CF_HEADERS })`. Forgetting this
   silently 302s the WS upgrade.

## Operations

```bash
make status     # all pods + services
make logs       # tail allocator
kubectl -n browser-pool exec steel-1 -- curl -s localhost:3000/v1/sessions  # what's that pod doing?
kubectl -n browser-pool rollout restart statefulset/steel                   # full pool reset
```

## Roadmap / known limits (v1)

- Allocator state is in-memory: restart loses leases. TTLs are short so impact is bounded; agents must handle 404 on release.
- No quota per agent (anyone with the service token can drain all 3). Add per-token quota in v2.
- No request-level metering. Add Prometheus in v2.
- Pool is fixed-size; not autoscaled. ML110 RAM is the limiter (~6 GB free today → 3 pods comfy; upgrade to 32 GB and scale to ~8-12).
- Concurrent agents pinning the same pod via direct hostname (bypassing allocator) is possible — CF Access service-token scoping mitigates but doesn't prevent. Reasonable for internal trust.
