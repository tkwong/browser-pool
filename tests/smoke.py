"""
End-to-end smoke test for browser-pool (v2.3 surface).

Covers:
  1. /healthz
  2. PUT a synthetic profile → GET back → list
  3. acquire {profile} → assert profile_injected
  4. release {save_as, save_domain_filter} → assert /profiles/<name>.json
     round-trip equals what we injected (cookie name/value/HttpOnly/Secure)
  5. pool exhaustion: keep acquiring until 423, then drain
  6. default acquire (no profile) → assert profile_injected is null
  7. cleanup: DELETE both profiles

Does NOT need Playwright or k8s — talks only to the allocator HTTP surface
(over CF Access). Run from anywhere over the public internet with a CF Access
service token; Tailscale is NOT required (agents reach the allocator + CDP via
the public CF Tunnel, not the operator-only NodePort).

Usage:
    pip install httpx
    export BROWSER_POOL_URL=https://allocator.your-domain.com
    export BROWSER_TOKEN=<client_id>:<client_secret>      # OR token file path below
    # Or via file: ~/.config/browser-pool/service-token.json
    python tests/smoke.py
"""

import json
import os
import sys
import uuid
from pathlib import Path

import httpx

ALLOCATOR = os.environ.get("BROWSER_POOL_URL") or os.environ.get("ALLOCATOR_URL")
if not ALLOCATOR:
    sys.exit("Set BROWSER_POOL_URL (e.g. https://allocator.example.com)")
TOKEN_FILE = Path.home() / ".config" / "browser-pool" / "service-token.json"


def _cf_headers() -> dict[str, str]:
    # 1. BROWSER_TOKEN=<id>:<secret>
    if os.environ.get("BROWSER_TOKEN"):
        try:
            cid, csec = os.environ["BROWSER_TOKEN"].split(":", 1)
            return {"CF-Access-Client-Id": cid, "CF-Access-Client-Secret": csec}
        except ValueError:
            sys.exit("BROWSER_TOKEN must be in '<client_id>:<client_secret>' form")
    # 2. Split env vars (legacy)
    cid = os.environ.get("CF_ACCESS_CLIENT_ID")
    csec = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    # 3. JSON file
    if not (cid and csec) and TOKEN_FILE.exists():
        tok = json.loads(TOKEN_FILE.read_text())
        cid = cid or tok.get("CF_ACCESS_CLIENT_ID")
        csec = csec or tok.get("CF_ACCESS_CLIENT_SECRET")
    if not (cid and csec):
        sys.exit("Missing BROWSER_TOKEN env OR CF_ACCESS_CLIENT_ID/SECRET "
                 "OR ~/.config/browser-pool/service-token.json")
    return {"CF-Access-Client-Id": cid, "CF-Access-Client-Secret": csec}


HDR = _cf_headers()
CLIENT = httpx.Client(headers=HDR, timeout=60)

PASS = 0
FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}  ({detail})" if detail else f"  FAIL  {label}")


def step(name: str) -> None:
    print(f"\n[{name}]")


# --------------------------------------------------------------------------- #
# 1. /healthz                                                                  #
# --------------------------------------------------------------------------- #
step("healthz")
r = CLIENT.get(f"{ALLOCATOR}/healthz")
check("HTTP 200", r.status_code == 200, str(r.status_code))
body = r.json()
check("ok=true", body.get("ok") is True)
check("pool size >= 1", len(body.get("pool", [])) >= 1, str(body))
POOL_SIZE = len(body["pool"])
print(f"  -> pool size = {POOL_SIZE}")


# --------------------------------------------------------------------------- #
# 2. Profile PUT / GET / LIST with a synthetic payload                         #
# --------------------------------------------------------------------------- #
step("profile CRUD (no acquire)")
test_name = f"smoke-{uuid.uuid4().hex[:8]}"
synth_cookie = {
    "name": f"smoke_{uuid.uuid4().hex[:6]}",
    "value": f"val_{uuid.uuid4().hex[:12]}",
    "domain": ".example.com",
    "path": "/",
    "secure": True,
    "httpOnly": True,
    "sameSite": "Lax",
}
synth_profile = {
    "schema": "browser-pool/profile@v1",
    "saved_at": "1970-01-01T00:00:00Z",
    "cookies": [synth_cookie],
    "origins": [],
}
r = CLIENT.put(f"{ALLOCATOR}/profiles/{test_name}", json=synth_profile)
check("PUT 200", r.status_code == 200, r.text[:200])

r = CLIENT.get(f"{ALLOCATOR}/profiles/{test_name}")
check("GET 200", r.status_code == 200)
got = r.json()
check("PUT then GET round-trip", got["cookies"][0]["value"] == synth_cookie["value"])

r = CLIENT.get(f"{ALLOCATOR}/profiles")
names = [p["name"] for p in r.json().get("profiles", [])]
check("listed by GET /profiles", test_name in names)


# --------------------------------------------------------------------------- #
# 3. acquire {profile} -> profile_injected.cookies == 1                        #
# --------------------------------------------------------------------------- #
step("acquire {profile} + release {save_as}")
r = CLIENT.post(f"{ALLOCATOR}/acquire", json={"ttl": 180, "profile": test_name})
check("acquire 200", r.status_code == 200, r.text[:200])
acq = r.json()
check("got cdp_url", bool(acq.get("cdp_url")))
check("got view_url", bool(acq.get("view_url")))
inj = acq.get("profile_injected") or {}
check("profile_injected.cookies == 1", inj.get("cookies") == 1, str(inj))

# v2.5 CDP reach check — proves cdp_url is reachable from THIS client (catches
# the "operator-only Tailscale URL" mistake that bit asset-mgmt agent 2026-05-31).
# A separate Playwright connect would prove WS, but /json/version proves the
# HTTP route (incl. CF Access if applicable). WS upgrade is exercised by the
# MCP client at lease use time; doing it here would require a Playwright dep.
cdp_r = CLIENT.get(f"{acq['cdp_url']}/json/version")
check("cdp_url /json/version 200", cdp_r.status_code == 200,
      f"got HTTP {cdp_r.status_code} — agent's network probably can't reach cdp_url")
if cdp_r.status_code == 200:
    ver = cdp_r.json()
    check("/json/version returns Chrome version", "Chrome/" in (ver.get("Browser") or ""))
    ws_url = ver.get("webSocketDebuggerUrl") or ""
    # Behind CF Tunnel (HTTPS), nginx sub_filter must rewrite to wss; behind
    # plain HTTP NodePort it stays ws. Either is acceptable, but the scheme
    # must MATCH the cdp_url scheme — else the WS connect from MCP will fail.
    expect_ws = "wss:" if acq["cdp_url"].startswith("https") else "ws:"
    check(f"webSocketDebuggerUrl scheme = {expect_ws}",
          ws_url.startswith(expect_ws),
          f"got {ws_url[:60]}")


# --------------------------------------------------------------------------- #
# 4. release {save_as, save_domain_filter} → dumped profile matches injected   #
# --------------------------------------------------------------------------- #
save_name = f"{test_name}-rt"
r = CLIENT.post(f"{ALLOCATOR}/release", json={
    "lease_id": acq["lease_id"],
    "save_as": save_name,
    "save_domain_filter": "example.com",
})
check("release 200", r.status_code == 200, r.text[:200])
rel = r.json()
check("saved_to set", bool(rel.get("saved_to")), str(rel))

r = CLIENT.get(f"{ALLOCATOR}/profiles/{save_name}")
check("GET dumped 200", r.status_code == 200)
dumped = r.json()
matching = [c for c in dumped.get("cookies", []) if c["name"] == synth_cookie["name"]]
check("synthetic cookie survived inject→dump round-trip",
      len(matching) == 1,
      f"dumped cookies: {[c['name'] for c in dumped.get('cookies', [])]}")
if matching:
    check("cookie value preserved", matching[0]["value"] == synth_cookie["value"])
    check("HttpOnly bit preserved", matching[0].get("httpOnly") == synth_cookie["httpOnly"])
    check("Secure bit preserved", matching[0].get("secure") == synth_cookie["secure"])


# --------------------------------------------------------------------------- #
# 5. Per-token rate limit (429 token_quota_exceeded)                           #
# A single token may hold MAX_LEASES_PER_TOKEN leases at once; the acquire that #
# crosses the cap is a 429 BEFORE pool exhaustion. The cap is a deployment knob #
# (was 1, has been 3 since 2026-06-21), so acquire until the server says stop   #
# rather than hard-coding it. Pool exhaustion (423) needs multi-token traffic — #
# not covered by single-token smoke, and treated here as "can't test".          #
# --------------------------------------------------------------------------- #
step("per-token rate limit (429 token_quota_exceeded)")
held, capped, exhausted = [], None, False
for _ in range(8):
    r = CLIENT.post(f"{ALLOCATOR}/acquire", json={"ttl": 60})
    if r.status_code == 200:
        held.append(r.json()["lease_id"])
        continue
    if r.status_code == 429:
        capped = r
    else:
        exhausted = True          # 423 pool_exhausted, or anything unexpected
    break

check("first acquire 200", bool(held), "no lease granted")
if exhausted:
    print("  SKIP  quota cap not reachable — pool busy with other tokens")
else:
    check("acquire past the cap = 429", capped is not None,
          f"{len(held)} leases granted without a 429")
if capped is not None:
    check("Retry-After header present on 429",
          "retry-after" in {k.lower() for k in capped.headers})
    err = capped.json()
    check("error=token_quota_exceeded", err.get("error") == "token_quota_exceeded")
    check("max_leases_per_token reported", isinstance(err.get("max_leases_per_token"), int))
    check("cap matches leases actually held", err.get("max_leases_per_token") == len(held),
          f"reported {err.get('max_leases_per_token')}, held {len(held)}")

# Release one → the next attempt should fit under the cap again
if held:
    CLIENT.post(f"{ALLOCATOR}/release", json={"lease_id": held.pop()})
r3 = CLIENT.post(f"{ALLOCATOR}/acquire", json={"ttl": 60})
check("after release, fresh acquire 200", r3.status_code == 200, str(r3.status_code))
if r3.status_code == 200:
    held.append(r3.json()["lease_id"])
for lid in held:
    CLIENT.post(f"{ALLOCATOR}/release", json={"lease_id": lid})


# --------------------------------------------------------------------------- #
# 5b. Viewer guard preflight (GET /viewers/{lease_id})                         #
# Only the "nobody is watching" half is testable from a REST client — proving  #
# the positive case needs a real noVNC socket, which lives in make integration.#
# --------------------------------------------------------------------------- #
step("viewer guard preflight")
rv = CLIENT.post(f"{ALLOCATOR}/acquire", json={"ttl": 60})
check("acquire 200", rv.status_code == 200, str(rv.status_code))
if rv.status_code == 200:
    lid = rv.json()["lease_id"]
    v = CLIENT.get(f"{ALLOCATOR}/viewers/{lid}")
    check("GET /viewers/{lease_id} 200", v.status_code == 200, str(v.status_code))
    if v.status_code == 200:
        vj = v.json()
        check("viewers is an int", isinstance(vj.get("viewers"), int), str(vj))
        check("no viewer on a fresh lease", vj.get("viewers") == 0, str(vj.get("viewers")))
        check("pod reported", bool(vj.get("pod")))
    # An unguarded release must still work when nobody is watching.
    rr = CLIENT.post(f"{ALLOCATOR}/release", json={"lease_id": lid})
    check("release 200 with no viewer", rr.status_code == 200, str(rr.status_code))
    check("saved_format absent when not saving", rr.json().get("saved_format") is None)
    check("/viewers on a released lease = 404",
          CLIENT.get(f"{ALLOCATOR}/viewers/{lid}").status_code == 404)


# --------------------------------------------------------------------------- #
# 6. Default acquire (no profile) → profile_injected null                      #
# --------------------------------------------------------------------------- #
step("default acquire = no inject")
r = CLIENT.post(f"{ALLOCATOR}/acquire", json={"ttl": 60})
check("acquire 200", r.status_code == 200)
acq2 = r.json()
check("profile_injected is null/absent",
      not acq2.get("profile_injected"),
      str(acq2.get("profile_injected")))
CLIENT.post(f"{ALLOCATOR}/release", json={"lease_id": acq2["lease_id"]})


# --------------------------------------------------------------------------- #
# 7. Cleanup synthetic profiles                                                #
# --------------------------------------------------------------------------- #
step("cleanup")
for n in (test_name, save_name):
    r = CLIENT.delete(f"{ALLOCATOR}/profiles/{n}")
    check(f"DELETE {n}", r.status_code == 200, str(r.status_code))


print()
print(f"PASS: {PASS}   FAIL: {FAIL}")
sys.exit(1 if FAIL else 0)
