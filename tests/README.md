# browser-pool tests

## 點 run

```bash
pip install httpx
make smoke
# 或
python3 tests/smoke.py
```

需要 `BROWSER_POOL_URL` env(allocator base URL)。Credentials 三條 path 任揀其一:

```bash
# 1. one-line BROWSER_TOKEN env (推 — 同 install-mcp.sh 一樣 shape):
BROWSER_POOL_URL=https://allocator.example.com \
BROWSER_TOKEN=<client_id>:<client_secret> \
make smoke

# 2. JSON file (default): ~/.config/browser-pool/service-token.json
BROWSER_POOL_URL=https://allocator.example.com make smoke

# 3. split env vars (legacy)
BROWSER_POOL_URL=... CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... make smoke
```

成功收尾係 `PASS: 31   FAIL: 0`,exit code 0。

## 31 個 check 涵蓋

| Step | 確認 |
|---|---|
| healthz | allocator 起咗;pool size ≥ 1 |
| profile CRUD | PUT / GET / LIST 三 verb 對 1 個 synthetic cookie 嘅 profile work |
| acquire {profile} | 200 + `cdp_url` + `view_url` + `profile_injected.cookies == 1` |
| **CDP reach from this client** | `{cdp_url}/json/version` 200 + Chrome version + `webSocketDebuggerUrl` scheme matches cdp_url scheme (`wss:` for `https:`, `ws:` for `http:`). 抓返 2026-05-31 嗰個 "operator-only Tailscale URL" mistake — agent network 唔通就即刻 fail |
| release {save_as, save_domain_filter} | `saved_to` 寫返;dumped profile 入面個 synthetic cookie name/value/HttpOnly/Secure 全部 preserved |
| 池 exhaustion | 順序 acquire 到爆滿;next acquire = `423` + `Retry-After` + `error=pool_exhausted` |
| Default acquire | 冇 profile param 嗰陣 `profile_injected` 係 null |
| Cleanup | 兩個 synthetic profile DELETE 走 |

## 點 fail 嗰陣 debug

| 症狀 | 多數係 |
|---|---|
| `PUT 200 (502 …)` | allocator 容器仲未 rollout 完。等 30s 再試,或者 `kubectl -n browser-pool rollout status deploy/allocator` |
| `profile_injected.cookies == 1 (None)` | sidecar `/inject-profile` fail。`kubectl logs <pod> -c control` 睇 |
| `synthetic cookie survived inject→dump round-trip ([])` | 大機會 Chrome 嘅 cookie store 唔肯 accept 我哋嘅 cookie record(domain prefix、SameSite 衝突)。比較 PUT body 同 dumped 嘅 diff |
| `acquire #N == 423 (200)` | pool 比預期大。check `kubectl -n browser-pool get sts/chrome-vnc -o jsonpath="{.spec.replicas}"` 同 allocator env `POOL_PODS` 對齊冇 |
| `Missing CF_ACCESS_…` | service token file 唔見;`ls ~/.config/browser-pool/` 確認;或者 env override |

## 唔 cover 嘅(下一輪 add)

- MCP integration(spawn `node clients/mcp/index.mjs`,stdio dispatch 22 tools)
- 真實 browser navigate(會打網,要 Playwright)
- 並發 lease lifetime / reaper expiry timing
- Allocator unit tests(pure logic — profile name regex、auth header parsing)
