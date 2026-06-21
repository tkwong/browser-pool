"""
browser-pool allocator
======================
Simple FastAPI lease broker for a fixed pool of chrome-vnc browser pods.

State: in-memory (per pod: idle | leased{lease_id, expires_at}).
Reaper thread force-releases expired leases every REAPER_INTERVAL seconds.

API:
  POST /acquire   -> 200 {lease_id, pod, pod_url, expires_at} | 423 pool_exhausted
  POST /release   -> 200 {released, pod}                       | 404 lease_not_found
  GET  /status    -> {pool_size, free, leased[]}
  GET  /healthz   -> {ok, pool}

Auth (optional): if ALLOCATOR_SERVICE_TOKEN is set, every mutating call must
present `Authorization: Bearer <token>`.
"""

import base64
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# Config (env-driven so the same image runs in any environment)               #
# --------------------------------------------------------------------------- #
POOL = [p.strip() for p in os.environ.get("POOL_PODS", "chrome-vnc-0").split(",") if p.strip()]
POD_URL_TPL = os.environ.get("POD_URL_TEMPLATE", "")
POD_INTERNAL_URL_TPL = os.environ.get(
    "POD_INTERNAL_URL_TEMPLATE",
    "http://{pod}.chrome-vnc.browser-pool.svc.cluster.local:9223",
)
# CDP URL handed to agents (e.g. playwright-mcp via browser-pool-mcp). For the
# chrome-vnc tier this is the PUBLIC CF Tunnel hostname (cdp-<pod>.cartforge.net,
# gated by CF Access) so remote agents NOT on the operator's tailnet can reach
# it. NEVER hand agents the Tailscale NodePort (100.x) — that was the v2.5 fix,
# 2026-05-31, after a remote EC2 timed out on the tailnet-only CDP URL. The
# nginx sidecar relays to chromium (which binds CDP to 127.0.0.1 only). Per-pod
# CDP_URL_{POD} env overrides take priority over the global template; in prod
# they are set to the CF Tunnel hostnames in k8s/20-allocator.yaml.
CDP_URL_TPL = os.environ.get("CDP_URL_TEMPLATE", "")  # global fallback; prod sets per-pod CDP_URL_CHROME_VNC_{0,1}=https://cdp-chrome-vnc-{0,1}.cartforge.net
DEFAULT_TIER = os.environ.get("DEFAULT_TIER", "chrome-vnc")
# DNS hostname template the Quick Tunnel cloudflared resolves. chrome-vnc pods
# sit behind a headless Service named "chrome-vnc".
POD_UPSTREAM_HOST_TPL = os.environ.get(
    "POD_UPSTREAM_HOST_TEMPLATE",
    "{pod}.chrome-vnc.browser-pool.svc.cluster.local",
)
# Control sidecar URL template. POST /wipe on release. Empty/None disables.
CONTROL_URL_TPL = os.environ.get(
    "CONTROL_URL_TEMPLATE",
    "http://{pod}.chrome-vnc.browser-pool.svc.cluster.local:9224",
)
CONTROL_WIPE_TIMEOUT = int(os.environ.get("CONTROL_WIPE_TIMEOUT_SECONDS", "45"))
CONTROL_PROFILE_TIMEOUT = int(os.environ.get("CONTROL_PROFILE_TIMEOUT_SECONDS", "60"))

# Named-profile store (Phase 2). One JSON file per profile, name-validated to
# prevent path traversal. Lives on a PVC mounted at this path so it survives
# allocator pod restarts. Empty/None disables the feature.
PROFILES_DIR = Path(os.environ.get("PROFILES_DIR", "/profiles"))
_PROFILE_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{1,64}$")

# Audit log — JSONL on the same PVC as profiles. Append-only; one record per
# acquire / release / exhausted / wipe / inject / dump. Keeps forever; rotate
# manually if needed.
AUDIT_LOG_PATH = Path(os.environ.get("AUDIT_LOG_PATH", str(PROFILES_DIR / "audit.log")))
# Rolling 5-minute exhaustion counters for the admin queue view.
_RECENT_EXHAUSTED: list[tuple[float, str]] = []   # (ts, "423"|"429")
_RECENT_LOCK = threading.Lock()

# Per-token rate limit. Quota key is the CF-Access-Client-Id header (preserved
# by CF Access untouched; falls back to "anonymous" if absent for dev).
# MAX_LEASES_PER_TOKEN caps concurrent active leases for one token —
# prevents a single agent looping acquire+release from starving others.
# Default 0 = disabled (dev). Production sets via k8s env, currently 1.
MAX_LEASES_PER_TOKEN = int(os.environ.get("MAX_LEASES_PER_TOKEN", "0"))
DEFAULT_TTL = int(os.environ.get("DEFAULT_TTL_SECONDS", "600"))   # 10 min
MAX_TTL = int(os.environ.get("MAX_TTL_SECONDS", "3600"))          # 1 hour
REAPER_INTERVAL = int(os.environ.get("REAPER_INTERVAL_SECONDS", "10"))
SERVICE_TOKEN = os.environ.get("ALLOCATOR_SERVICE_TOKEN", "")

# Quick Tunnel (CF Cloudflare Tunnel "trycloudflare.com" mode) — per-lease
# magic-link viewer URL. The cloudflared subprocess is spawned on acquire and
# killed on release; the random subdomain URL dies with it.
CLOUDFLARED_BIN = os.environ.get("CLOUDFLARED_BIN", "/usr/local/bin/cloudflared")
QUICK_TUNNEL_ENABLED = os.environ.get("QUICK_TUNNEL_ENABLED", "true").lower() == "true"
QUICK_TUNNEL_READY_TIMEOUT = int(os.environ.get("QUICK_TUNNEL_READY_TIMEOUT", "30"))  # seconds to wait for URL in stdout
QUICK_TUNNEL_TARGET_PORT = int(os.environ.get("QUICK_TUNNEL_TARGET_PORT", "80"))   # 80=UI sidecar, 3000=raw API
_QT_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# --------------------------------------------------------------------------- #
app = FastAPI(title="browser-pool allocator", version="0.1.0")
log = logging.getLogger("allocator")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

_lock = threading.Lock()
_state: dict[str, Optional[dict]] = {pod: None for pod in POOL}   # pod -> None or {lease_id, expires_at, leased_at, qt_proc, view_url}
_lease_to_pod: dict[str, str] = {}


# --------------------------------------------------------------------------- #
# Quick Tunnel helpers                                                         #
# --------------------------------------------------------------------------- #
def _spawn_quick_tunnel(pod: str) -> tuple[Optional[subprocess.Popen], Optional[str]]:
    """Spawn a per-lease cloudflared Quick Tunnel pointing at the pod.

    Returns (proc, view_url). On failure returns (None, None) and logs.
    The cloudflared process is daemonless: when we kill it the trycloudflare.com
    subdomain stops resolving / proxying (the magic-link dies with the lease).
    """
    if not QUICK_TUNNEL_ENABLED:
        return (None, None)
    if not shutil.which(CLOUDFLARED_BIN) and not os.path.exists(CLOUDFLARED_BIN):
        log.warning("cloudflared not found at %s; view_url disabled", CLOUDFLARED_BIN)
        return (None, None)

    upstream = f"http://{POD_UPSTREAM_HOST_TPL.format(pod=pod)}:{QUICK_TUNNEL_TARGET_PORT}"
    cmd = [
        CLOUDFLARED_BIN, "tunnel",
        "--url", upstream,
        # NOTE: do NOT set --http-host-header here. Forwarding the real Host
        # (e.g. xxx.trycloudflare.com) is required so the UI sidecar's nginx
        # sub_filter can rewrite session URLs to `wss://<real-host>/api/`.
        # Chrome's anti-DNS-rebinding check is satisfied INSIDE Steel API's
        # internal proxy to port 9223 (it sends Host: localhost there), not
        # at this hop, so we don't need to override Host here in v1.5.
        "--no-autoupdate",
        "--logfile", "/dev/stderr",
    ]
    log.info("spawning quick tunnel for %s: %s", pod, " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,                        # line-buffered
        )
    except Exception as e:                                            # noqa: BLE001
        log.error("failed to spawn cloudflared for %s: %s", pod, e)
        return (None, None)

    # Phase 1: wait for the trycloudflare URL to be assigned.
    deadline = time.time() + QUICK_TUNNEL_READY_TIMEOUT
    url: Optional[str] = None
    while time.time() < deadline:
        if proc.poll() is not None:                                   # exited early
            break
        line = proc.stdout.readline() if proc.stdout else ""
        if not line:
            time.sleep(0.2)
            continue
        m = _QT_URL_RE.search(line)
        if m:
            url = m.group(0)
            break
    if not url:
        log.error("quick tunnel for %s: URL not found in %ss; killing", pod, QUICK_TUNNEL_READY_TIMEOUT)
        try:
            proc.terminate()
        except Exception:                                             # noqa: BLE001
            pass
        return (None, None)

    # Phase 2: wait for the connector to actually register with CF edge. Without
    # this, ~20% of the time the URL is dead because cloudflared logged the URL
    # before the connection completed. The "Registered tunnel connection" log
    # line is the reliable readiness signal.
    registered = False
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        line = proc.stdout.readline() if proc.stdout else ""
        if not line:
            time.sleep(0.2)
            continue
        if "Registered tunnel connection" in line:
            registered = True
            break
    if not registered:
        log.warning(
            "quick tunnel for %s: URL %s assigned but no 'Registered tunnel connection' within %ds — URL may be dead",
            pod, url, QUICK_TUNNEL_READY_TIMEOUT,
        )

    # detach a thread to drain stdout (otherwise pipe fills and cloudflared blocks)
    def _drain():
        try:
            for _ in iter(proc.stdout.readline, ""):                  # type: ignore[union-attr]
                pass
        except Exception:                                             # noqa: BLE001
            pass
    threading.Thread(target=_drain, daemon=True, name=f"qt-drain-{pod}").start()

    log.info("quick tunnel for %s ready: %s (pid=%s, registered=%s)", pod, url, proc.pid, registered)
    return (proc, url)


def _kill_quick_tunnel(state_entry: dict) -> None:
    proc = state_entry.get("qt_proc")
    if proc is None:
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception as e:                                            # noqa: BLE001
        log.warning("kill quick tunnel failed: %s", e)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _check_auth(authz: Optional[str]) -> None:
    if not SERVICE_TOKEN:
        return
    if not authz or not authz.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authz[7:].strip() != SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid bearer token")


# --------------------------------------------------------------------------- #
# Named-profile helpers                                                        #
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Request identity                                                            #
# --------------------------------------------------------------------------- #
# CF Access consumes CF-Access-Client-Id/Secret at the edge — they do NOT reach
# the origin. Instead Access forwards a signed JWT in `Cf-Access-Jwt-Assertion`
# whose `common_name` claim is the service-token client_id (or `email` for SSO).
# CF-Connecting-IP is also absent over this tunnel; the real client IP arrives
# in `X-Forwarded-For`. Verified live 2026-06-19 via /admin/whoami.
def _decode_cf_identity(jwt_assertion: Optional[str]) -> Optional[str]:
    """Pull the caller identity from the CF Access JWT. We do NOT verify the
    signature — Access already validated it at the edge before forwarding; we
    only need a stable bucket key for quota + audit. Returns None if absent."""
    if not jwt_assertion:
        return None
    try:
        payload_b64 = jwt_assertion.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)            # restore padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return payload.get("common_name") or payload.get("email") or payload.get("sub")
    except Exception:                                                 # noqa: BLE001
        return None


def _caller_identity(
    cf_jwt: Optional[str],
    cf_access_client_id: Optional[str],
    x_forwarded_for: Optional[str],
    cf_connecting_ip: Optional[str],
) -> tuple[str, str]:
    """Returns (quota_key, source_ip). quota_key buckets the rate-limit and
    labels audit rows; source_ip is the real visitor IP."""
    quota_key = (
        _decode_cf_identity(cf_jwt)
        or cf_access_client_id            # if a future tunnel does forward it
        or "anonymous"
    )
    source_ip = "unknown"
    if x_forwarded_for:
        source_ip = x_forwarded_for.split(",")[0].strip()   # first hop = client
    elif cf_connecting_ip:
        source_ip = cf_connecting_ip
    return quota_key, source_ip


# --------------------------------------------------------------------------- #
# Audit log                                                                   #
# --------------------------------------------------------------------------- #
def _audit(action: str, **fields: Any) -> None:
    """Append one JSONL audit record. Never raises (best-effort)."""
    try:
        AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        entry = {"ts": _now().isoformat(timespec="seconds"), "action": action, **fields}
        with AUDIT_LOG_PATH.open("a") as fh:
            fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception as e:                                            # noqa: BLE001
        log.warning("audit write failed: %s", e)


def _track_exhausted(kind: str) -> None:
    """Slide a 5-min window of exhaustion events for the queue widget."""
    now = time.time()
    cutoff = now - 300
    with _RECENT_LOCK:
        _RECENT_EXHAUSTED.append((now, kind))
        # Drop entries older than 5 min
        while _RECENT_EXHAUSTED and _RECENT_EXHAUSTED[0][0] < cutoff:
            _RECENT_EXHAUSTED.pop(0)


def _recent_exhausted_summary() -> dict[str, int]:
    cutoff = time.time() - 300
    with _RECENT_LOCK:
        items = [k for ts, k in _RECENT_EXHAUSTED if ts >= cutoff]
    return {
        "exhausted_attempts_5min": len(items),
        "recent_423_pool_5min": items.count("423"),
        "recent_429_quota_5min": items.count("429"),
    }


# --------------------------------------------------------------------------- #
# Profile helpers                                                              #
# --------------------------------------------------------------------------- #
def _profile_path(name: str) -> Path:
    if not _PROFILE_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="invalid profile name")
    return PROFILES_DIR / f"{name}.json"


def _profiles_enabled() -> bool:
    try:
        PROFILES_DIR.mkdir(parents=True, exist_ok=True)
        return True
    except Exception:                                                 # noqa: BLE001
        return False


def _inject_profile_into_pod(pod: str, profile: dict) -> dict:
    url = f"{CONTROL_URL_TPL.format(pod=pod)}/inject-profile"
    with httpx.Client(timeout=CONTROL_PROFILE_TIMEOUT) as c:
        r = c.post(url, json=profile)
        r.raise_for_status()
        return r.json()


def _dump_profile_from_pod(pod: str, domain_filter: Optional[str] = None) -> dict:
    url = f"{CONTROL_URL_TPL.format(pod=pod)}/dump-profile"
    body: dict = {}
    if domain_filter:
        body["domain_filter"] = domain_filter
    with httpx.Client(timeout=CONTROL_PROFILE_TIMEOUT) as c:
        r = c.post(url, json=body)
        r.raise_for_status()
        return r.json()


def _wipe_pod_profile(pod: str) -> None:
    """POST to the pod's control sidecar to wipe Chromium profile.

    Default behaviour on /release: ephemeral. Prevents the next leaseholder
    (potentially a different user / friend) from seeing the previous one's
    login state. For sticky session reuse, dump the profile BEFORE /release
    via scripts/dump-profile.mjs (Phase 1 — manual) or pass save_as=name
    when Phase 2 named profiles land.

    Best-effort: if the sidecar is unreachable we log and continue so a
    flaky control plane doesn't pin pods in leased state.
    """
    if not CONTROL_URL_TPL:
        return
    url = f"{CONTROL_URL_TPL.format(pod=pod)}/wipe"
    try:
        with httpx.Client(timeout=CONTROL_WIPE_TIMEOUT) as c:
            r = c.post(url)
            log.info("wipe pod=%s status=%s body=%s", pod, r.status_code, r.text[:300])
    except Exception as e:                                            # noqa: BLE001
        log.warning("wipe pod=%s failed (release continues): %s", pod, e)


# --------------------------------------------------------------------------- #
# Schemas                                                                     #
# --------------------------------------------------------------------------- #
class AcquireReq(BaseModel):
    ttl: Optional[int] = Field(default=None, ge=10, le=MAX_TTL, description=f"seconds, default {DEFAULT_TTL}, max {MAX_TTL}")
    tier: Optional[str] = Field(default=None, description=f"browser tier, default '{DEFAULT_TIER}'. Currently advisory only — pool is homogenous.")
    profile: Optional[str] = Field(default=None, description="Named profile to inject into the lease (cookies + localStorage). 404 if not found.")


class AcquireResp(BaseModel):
    lease_id: str
    pod: str
    pod_url: str
    expires_at: str
    view_url: Optional[str] = None    # per-lease magic link (CF Quick Tunnel); dies on release
    cdp_url: Optional[str] = None     # Chrome DevTools Protocol endpoint (chrome-vnc tier)
    tier: str = DEFAULT_TIER
    profile_injected: Optional[dict] = None   # populated when AcquireReq.profile was honoured


class ReleaseReq(BaseModel):
    lease_id: str
    save_as: Optional[str] = Field(default=None, description="Dump the pod's cookies+storage to /profiles/<name>.json before wiping.")
    save_domain_filter: Optional[str] = Field(default=None, description="Limit save_as to cookies whose domain contains this substring (e.g. 'facebook.com').")


# --------------------------------------------------------------------------- #
# Routes                                                                      #
# --------------------------------------------------------------------------- #
@app.post("/acquire", response_model=AcquireResp)
def acquire(
    req: AcquireReq,
    authorization: Optional[str] = Header(default=None),
    cf_jwt: Optional[str] = Header(default=None, alias="Cf-Access-Jwt-Assertion"),
    cf_access_client_id: Optional[str] = Header(default=None, alias="CF-Access-Client-Id"),
    x_forwarded_for: Optional[str] = Header(default=None, alias="X-Forwarded-For"),
    cf_connecting_ip: Optional[str] = Header(default=None, alias="CF-Connecting-IP"),
):
    _check_auth(authorization)
    ttl = req.ttl or DEFAULT_TTL
    quota_key, source_ip = _caller_identity(cf_jwt, cf_access_client_id, x_forwarded_for, cf_connecting_ip)
    # Atomically check per-token quota + claim a pod slot. quota check is
    # inside the lock so a burst of concurrent acquires from one token can't
    # all slip through.
    claimed_pod: Optional[str] = None
    lease_id = str(uuid.uuid4())
    exp = _now() + timedelta(seconds=ttl)
    with _lock:
        if MAX_LEASES_PER_TOKEN > 0:
            active_for_token = sum(
                1 for st in _state.values()
                if st is not None and st.get("quota_key") == quota_key
            )
            if active_for_token >= MAX_LEASES_PER_TOKEN:
                _track_exhausted("429")
                _audit("exhausted_429", quota_key=quota_key, source_ip=source_ip,
                       active_leases=active_for_token, max=MAX_LEASES_PER_TOKEN)
                return JSONResponse(
                    status_code=429,
                    headers={"Retry-After": "30"},
                    content={
                        "error": "token_quota_exceeded",
                        "retry_after": 30,
                        "active_leases": active_for_token,
                        "max_leases_per_token": MAX_LEASES_PER_TOKEN,
                    },
                )
        for pod in POOL:
            if _state[pod] is None:
                claimed_pod = pod
                _state[pod] = {
                    "lease_id": lease_id,
                    "expires_at": exp,
                    "leased_at": _now(),
                    "qt_proc": None,
                    "view_url": None,
                    "quota_key": quota_key,
                }
                # Track source for the admin view (not used for auth)
                _state[pod]["source_ip"] = source_ip
                _state[pod]["profile"] = req.profile
                _lease_to_pod[lease_id] = pod
                break

    if claimed_pod is None:
        _track_exhausted("423")
        _audit("exhausted_423", quota_key=quota_key, source_ip=source_ip,
               pool_size=len(POOL))
        return JSONResponse(
            status_code=423,
            headers={"Retry-After": "30"},
            content={"error": "pool_exhausted", "retry_after": 30, "pool_size": len(POOL)},
        )

    # Best-effort quick tunnel spawn (failure does not block the acquire — agent
    # just gets view_url=null and can fall back to allocator-mediated viewing).
    qt_proc, view_url = _spawn_quick_tunnel(claimed_pod)
    with _lock:
        st = _state.get(claimed_pod)
        if st is not None and st.get("lease_id") == lease_id:
            st["qt_proc"] = qt_proc
            st["view_url"] = view_url

    # Per-pod override > global template > none.
    cdp_url = (
        os.environ.get(f"CDP_URL_{claimed_pod.upper().replace('-', '_')}")
        or (CDP_URL_TPL.format(pod=claimed_pod) if CDP_URL_TPL else None)
    )
    tier = req.tier or DEFAULT_TIER

    # Named-profile injection (Phase 2). If the file is missing we 404 but
    # leave the lease intact so the agent can retry without a fresh acquire.
    injected: Optional[dict] = None
    if req.profile:
        if not _profiles_enabled():
            raise HTTPException(status_code=503, detail="profiles store unavailable")
        path = _profile_path(req.profile)
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"profile not found: {req.profile}")
        try:
            profile = json.loads(path.read_text())
            injected = _inject_profile_into_pod(claimed_pod, profile)
            log.info("injected profile=%s into pod=%s result=%s", req.profile, claimed_pod, injected)
        except HTTPException:
            raise
        except Exception as e:                                        # noqa: BLE001
            log.error("inject profile=%s pod=%s failed: %s", req.profile, claimed_pod, e)
            raise HTTPException(status_code=502, detail=f"inject failed: {e}") from e

    _audit("acquire", lease_id=lease_id, pod=claimed_pod,
           quota_key=quota_key, source_ip=source_ip,
           ttl=ttl, profile=req.profile,
           injected_cookies=(injected or {}).get("cookies") if injected else None)
    log.info("acquired pod=%s lease=%s tier=%s ttl=%s view_url=%s cdp_url=%s profile=%s",
             claimed_pod, lease_id, tier, ttl, view_url or "(none)", cdp_url or "(none)", req.profile or "(none)")
    return AcquireResp(
        lease_id=lease_id,
        pod=claimed_pod,
        pod_url=POD_URL_TPL.format(pod=claimed_pod),
        expires_at=exp.isoformat(),
        view_url=view_url,
        cdp_url=cdp_url,
        tier=tier,
        profile_injected=injected,
    )


@app.post("/release")
def release(
    req: ReleaseReq,
    authorization: Optional[str] = Header(default=None),
    cf_jwt: Optional[str] = Header(default=None, alias="Cf-Access-Jwt-Assertion"),
    cf_access_client_id: Optional[str] = Header(default=None, alias="CF-Access-Client-Id"),
    x_forwarded_for: Optional[str] = Header(default=None, alias="X-Forwarded-For"),
    cf_connecting_ip: Optional[str] = Header(default=None, alias="CF-Connecting-IP"),
):
    _check_auth(authorization)
    rel_quota_key, rel_source_ip = _caller_identity(cf_jwt, cf_access_client_id, x_forwarded_for, cf_connecting_ip)
    with _lock:
        pod = _lease_to_pod.pop(req.lease_id, None)
        if not pod:
            raise HTTPException(status_code=404, detail="lease_not_found")
        old_state = _state[pod]
        _state[pod] = None

    saved_to: Optional[str] = None
    # Order: save_as BEFORE wipe (else there's nothing to dump).
    if req.save_as:
        if not _profiles_enabled():
            log.warning("save_as requested but PROFILES_DIR unavailable; skipped")
        else:
            try:
                profile = _dump_profile_from_pod(pod, req.save_domain_filter)
                path = _profile_path(req.save_as)
                path.write_text(json.dumps(profile, indent=2))
                saved_to = str(path)
                log.info("saved profile=%s pod=%s cookies=%d origins=%d → %s",
                         req.save_as, pod, len(profile.get("cookies", [])),
                         len(profile.get("origins", [])), path)
            except HTTPException:
                raise
            except Exception as e:                                    # noqa: BLE001
                log.error("save_as=%s pod=%s failed: %s — wipe still proceeds", req.save_as, pod, e)

    # Snapshot tabs + nav history BEFORE wipe (wipe navigates tabs to about:blank).
    tabs = _sidecar_tabs(pod)
    if old_state:
        _kill_quick_tunnel(old_state)
    _wipe_pod_profile(pod)
    duration = None
    if old_state and old_state.get("leased_at"):
        duration = int((_now() - old_state["leased_at"]).total_seconds())
    _audit("release", lease_id=req.lease_id, pod=pod,
           quota_key=(rel_quota_key if rel_quota_key != "anonymous"
                      else (old_state or {}).get("quota_key", "anonymous")),
           source_ip=rel_source_ip,
           save_as=req.save_as, duration_s=duration, tabs=tabs)
    log.info("released pod=%s lease=%s save_as=%s", pod, req.lease_id, req.save_as or "(none)")
    return {"released": True, "pod": pod, "saved_to": saved_to}


# --------------------------------------------------------------------------- #
# Named profiles                                                              #
# --------------------------------------------------------------------------- #
@app.get("/profiles")
def list_profiles(authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    if not _profiles_enabled():
        raise HTTPException(status_code=503, detail="profiles store unavailable")
    items: list[dict[str, Any]] = []
    for p in sorted(PROFILES_DIR.glob("*.json")):
        try:
            stat = p.stat()
            items.append({
                "name": p.stem,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })
        except Exception:                                             # noqa: BLE001
            continue
    return {"profiles": items}


@app.get("/profiles/{name}")
def get_profile(name: str, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    if not _profiles_enabled():
        raise HTTPException(status_code=503, detail="profiles store unavailable")
    path = _profile_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"profile not found: {name}")
    return json.loads(path.read_text())


@app.put("/profiles/{name}")
def put_profile(name: str, profile: dict, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    if not _profiles_enabled():
        raise HTTPException(status_code=503, detail="profiles store unavailable")
    if not isinstance(profile.get("cookies"), list):
        raise HTTPException(status_code=400, detail="profile.cookies must be a list")
    path = _profile_path(name)
    existed = path.exists()
    path.write_text(json.dumps(profile, indent=2))
    log.info("uploaded profile=%s cookies=%d origins=%d existed=%s",
             name, len(profile.get("cookies", [])), len(profile.get("origins", [])), existed)
    return {"saved": True, "name": name, "replaced": existed}


@app.delete("/profiles/{name}")
def delete_profile(name: str, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
    if not _profiles_enabled():
        raise HTTPException(status_code=503, detail="profiles store unavailable")
    path = _profile_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"profile not found: {name}")
    path.unlink()
    log.info("deleted profile=%s", name)
    return {"deleted": True, "name": name}


@app.get("/status")
def status():
    with _lock:
        leased: list[dict] = []
        free = 0
        for pod, st in _state.items():
            if st is None:
                free += 1
            else:
                leased.append(
                    {
                        "pod": pod,
                        "lease_id": st["lease_id"],
                        "expires_at": st["expires_at"].isoformat(),
                        "leased_at": st["leased_at"].isoformat(),
                        "view_url": st.get("view_url"),
                    }
                )
        return {"pool_size": len(POOL), "free": free, "leased": leased}


@app.get("/healthz")
def healthz():
    return {"ok": True, "pool": POOL}


@app.get("/admin/whoami")
def whoami(request: Request, authorization: Optional[str] = Header(default=None)):
    """Operator probe: echo the CF/identity-relevant request headers the origin
    actually receives, so we can wire quota_key/source_ip to the right source.
    Values are truncated; never returns full secrets."""
    _check_auth(authorization)
    interesting = {}
    for k, v in request.headers.items():
        kl = k.lower()
        if kl.startswith("cf-") or kl.startswith("x-forwarded") or kl in ("true-client-ip",):
            # Truncate long values (JWTs) so we see presence + shape, not full token
            interesting[kl] = v if len(v) <= 48 else f"{v[:24]}…({len(v)} chars)"
    return {"client_host": request.client.host if request.client else None,
            "cf_headers": interesting}


# --------------------------------------------------------------------------- #
# Admin                                                                        #
# --------------------------------------------------------------------------- #
def _sidecar_status(pod: str) -> dict[str, Any]:
    """Best-effort fetch of the sidecar's /status (live chromium counters)."""
    if not CONTROL_URL_TPL:
        return {}
    url = f"{CONTROL_URL_TPL.format(pod=pod)}/status"
    try:
        with httpx.Client(timeout=3.0) as c:
            r = c.get(url)
            if r.status_code != 200:
                return {}
            return r.json()
    except Exception:                                                 # noqa: BLE001
        return {}


def _sidecar_tabs(pod: str) -> list[dict]:
    """Best-effort snapshot of the pod's open tabs + per-tab nav history, taken
    BEFORE wipe so the audit log records where the lease went. Tolerant of an
    old sidecar without /tabs (404 -> []). Size-capped to keep audit lines sane.
    """
    if not CONTROL_URL_TPL:
        return []
    url = f"{CONTROL_URL_TPL.format(pod=pod)}/tabs"
    try:
        with httpx.Client(timeout=8.0) as c:
            r = c.get(url)
            if r.status_code != 200:
                return []
            tabs = r.json().get("tabs", [])
    except Exception:                                                 # noqa: BLE001
        return []
    # Cap: at most 20 tabs, each history at most 25 most-recent URLs.
    out = []
    for t in tabs[:20]:
        hist = [u for u in (t.get("history") or []) if u][-25:]
        out.append({"url": t.get("url"), "title": (t.get("title") or "")[:120], "history": hist})
    return out


@app.get("/admin/status")
def admin_status(authorization: Optional[str] = Header(default=None)):
    """Detailed pool snapshot: per-pod lease + chromium sidecar info + queue.
    Reused by both the HTML dashboard and direct API users."""
    _check_auth(authorization)
    with _lock:
        snap = {pod: (st.copy() if st else None) for pod, st in _state.items()}
    pods = []
    for pod, st in snap.items():
        side = _sidecar_status(pod)
        if st is None:
            pods.append({
                "pod": pod, "free": True,
                "chromium": side,
            })
        else:
            age = int((_now() - st["leased_at"]).total_seconds()) if st.get("leased_at") else None
            pods.append({
                "pod": pod, "free": False,
                "lease_id": st["lease_id"],
                "leased_at": st["leased_at"].isoformat(),
                "expires_at": st["expires_at"].isoformat(),
                "age_seconds": age,
                "quota_key": st.get("quota_key"),
                "source_ip": st.get("source_ip"),
                "profile": st.get("profile"),
                "view_url": st.get("view_url"),
                "chromium": side,
            })
    return {
        "pool_size": len(POOL),
        "free": sum(1 for p in pods if p["free"]),
        "pods": pods,
        "queue": _recent_exhausted_summary(),
        "max_leases_per_token": MAX_LEASES_PER_TOKEN,
    }


@app.get("/admin/log")
def admin_log(
    limit: int = 200,
    action: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
):
    """Tail of the JSONL audit log. Newest first. Optional action= filter."""
    _check_auth(authorization)
    if not AUDIT_LOG_PATH.exists():
        return {"entries": []}
    # Cheap-ish: read up to N*512 bytes from end, parse last N entries.
    cap = max(1, min(limit, 2000))
    raw = AUDIT_LOG_PATH.read_text().splitlines()
    entries: list[dict] = []
    for line in reversed(raw):
        try:
            e = json.loads(line)
            if action and e.get("action") != action:
                continue
            entries.append(e)
            if len(entries) >= cap:
                break
        except Exception:                                             # noqa: BLE001
            continue
    return {"entries": entries, "total_in_file": len(raw)}


_ADMIN_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>browser-pool · admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root {
      --bg:#0c0e10; --bg2:#15181c; --bg3:#1d2126;
      --fg:#e6e8eb; --muted:#9aa0a6; --border:#2a2f36;
      --green:#34d399; --yellow:#fbbf24; --red:#f87171; --blue:#60a5fa;
      --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,system-ui,Inter,sans-serif}
    header{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--border)}
    header h1{margin:0;font-size:14px;font-weight:600;letter-spacing:.02em}
    header .meta{color:var(--muted);font-size:12px}
    .stat-row{display:flex;gap:10px;padding:14px 22px;border-bottom:1px solid var(--border);background:var(--bg2)}
    .stat{flex:1;padding:10px 14px;background:var(--bg3);border-radius:6px;border:1px solid var(--border)}
    .stat .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
    .stat .val{font-size:22px;font-weight:600;margin-top:4px;font-family:var(--mono)}
    .stat.green .val{color:var(--green)}
    .stat.yellow .val{color:var(--yellow)}
    .stat.red .val{color:var(--red)}
    nav.tabs{display:flex;border-bottom:1px solid var(--border);padding:0 22px;background:var(--bg)}
    nav.tabs button{background:transparent;color:var(--muted);border:none;padding:14px 18px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
    nav.tabs button.active{color:var(--fg);border-bottom-color:var(--fg)}
    main{padding:18px 22px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border)}
    th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:var(--bg2)}
    td.mono{font-family:var(--mono);font-size:12px}
    td .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--mono)}
    .badge.live{background:rgba(52,211,153,.15);color:var(--green)}
    .badge.free{background:var(--bg3);color:var(--muted)}
    .badge.release{background:var(--bg3);color:var(--muted)}
    .badge.expire{background:rgba(248,113,113,.15);color:var(--red)}
    .badge.exhausted{background:rgba(251,191,36,.15);color:var(--yellow)}
    .badge.acquire{background:rgba(96,165,250,.15);color:var(--blue)}
    .badge.wipe,.badge.inject,.badge.dump{background:var(--bg3);color:var(--muted)}
    a{color:var(--blue);text-decoration:none}
    a:hover{text-decoration:underline}
    .empty{color:var(--muted);padding:24px;text-align:center}
    .pill{padding:1px 6px;background:var(--bg3);border-radius:3px;font-family:var(--mono);font-size:11px}
  </style>
</head>
<body>
<header>
  <h1>🪴 browser-pool · admin</h1>
  <div class="meta">refreshes every 5 s · <span id="meta">…</span></div>
</header>
<div class="stat-row" id="stats"></div>
<nav class="tabs">
  <button data-tab="live" class="active">Live Sessions</button>
  <button data-tab="all">All Sessions</button>
  <button data-tab="settings">Settings</button>
</nav>
<main id="content"></main>
<script>
const $ = s => document.querySelector(s);
let cur = 'live';
const fmtAge = s => {
  if (s == null) return '—';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
};
const tail10 = s => s ? s.slice(-10) : '—';
const fmtDate = ts => new Date(ts).toLocaleString();
const short = id => id ? id.slice(0,8) : '—';
const sitesSummary = tabs => {
  if (!Array.isArray(tabs) || !tabs.length) return '—';
  const hosts = new Set();
  for (const t of tabs) {
    const urls = [t.url, ...(t.history || [])];
    for (const u of urls) {
      try { const h = new URL(u).hostname; if (h) hosts.add(h); } catch {}
    }
  }
  if (!hosts.size) return '—';
  const arr = [...hosts];
  const shown = arr.slice(0, 4).join(', ');
  return arr.length > 4 ? shown + ` +${arr.length - 4}` : shown;
};

async function fetchStatus() {
  const r = await fetch('/admin/status', {credentials:'include'});
  return r.json();
}
async function fetchLog(limit=100) {
  const r = await fetch('/admin/log?limit=' + limit, {credentials:'include'});
  return r.json();
}

function renderStats(s) {
  const q = s.queue || {};
  $('#stats').innerHTML = `
    <div class="stat green"><div class="label">Free / Pool</div><div class="val">${s.free} / ${s.pool_size}</div></div>
    <div class="stat"><div class="label">Quota cap (per token)</div><div class="val">${s.max_leases_per_token || '∞'}</div></div>
    <div class="stat yellow"><div class="label">Pool exhaustions (5 min)</div><div class="val">${q.recent_423_pool_5min || 0}</div></div>
    <div class="stat yellow"><div class="label">Quota rejections (5 min)</div><div class="val">${q.recent_429_quota_5min || 0}</div></div>
  `;
}

function renderLive(s) {
  if (!s.pods.length) return '<div class="empty">no pods</div>';
  const rows = s.pods.map(p => {
    const c = p.chromium || {};
    return `<tr>
      <td class="mono">${p.pod}</td>
      <td>${p.free ? '<span class="badge free">free</span>' : '<span class="badge live">live</span>'}</td>
      <td class="mono">${short(p.lease_id)}</td>
      <td class="mono"><span class="pill">${tail10(p.quota_key)}</span></td>
      <td class="mono">${p.source_ip || '—'}</td>
      <td>${p.profile || '—'}</td>
      <td class="mono">${fmtAge(p.age_seconds)}</td>
      <td class="mono">${c.chromium_alive ? '✓' : '✗'} ${c.cookie_count != null ? c.cookie_count + 'c' : ''} ${c.target_count != null ? c.target_count + 't' : ''}</td>
      <td>${p.view_url ? '<a href="' + p.view_url + '" target="_blank">open</a>' : '—'}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>Pod</th><th>Status</th><th>Lease ID</th><th>Token</th><th>Source IP</th>
      <th>Profile</th><th>Age</th><th>Chromium</th><th>Viewer</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAll(log) {
  const entries = log.entries || [];
  if (!entries.length) return '<div class="empty">no audit entries yet</div>';
  const rows = entries.map(e => `<tr>
    <td class="mono">${fmtDate(e.ts)}</td>
    <td><span class="badge ${e.action.split('_')[0]}">${e.action}</span></td>
    <td class="mono">${short(e.lease_id)}</td>
    <td class="mono">${e.pod || '—'}</td>
    <td class="mono"><span class="pill">${tail10(e.quota_key)}</span></td>
    <td class="mono">${e.source_ip || '—'}</td>
    <td class="mono">${e.duration_s != null ? fmtAge(e.duration_s) : '—'}</td>
    <td title="${(e.tabs||[]).flatMap(t=>[t.url,...(t.history||[])]).filter(Boolean).join('\\n')}">${sitesSummary(e.tabs)}</td>
    <td>${e.profile || e.save_as || '—'}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr>
      <th>When</th><th>Action</th><th>Lease ID</th><th>Pod</th>
      <th>Token</th><th>Source IP</th><th>Duration</th><th>Sites</th><th>Profile</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div class="empty">showing ${entries.length} of ${log.total_in_file} total entries · hover Sites for full URLs</div>`;
}

function renderSettings(s) {
  return `<div class="empty">
    <p>Read-only snapshot for v1.</p>
    <table style="max-width:600px;margin:0 auto">
      <tr><td>Pool size</td><td class="mono">${s.pool_size}</td></tr>
      <tr><td>MAX_LEASES_PER_TOKEN</td><td class="mono">${s.max_leases_per_token || 'disabled'}</td></tr>
    </table>
    <p style="margin-top:24px">Future: profile mgmt UI, lease force-release, rate-limit tune, alert rules.</p>
  </div>`;
}

async function refresh() {
  try {
    const s = await fetchStatus();
    renderStats(s);
    if (cur === 'live') $('#content').innerHTML = renderLive(s);
    else if (cur === 'all') $('#content').innerHTML = renderAll(await fetchLog(200));
    else $('#content').innerHTML = renderSettings(s);
    $('#meta').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('#meta').textContent = 'ERR: ' + e.message;
  }
}

document.querySelectorAll('nav.tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('nav.tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    cur = b.dataset.tab;
    refresh();
  };
});
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>"""


@app.get("/admin")
def admin_html():
    from fastapi.responses import HTMLResponse
    return HTMLResponse(_ADMIN_HTML)


# --------------------------------------------------------------------------- #
# Background reaper                                                           #
# --------------------------------------------------------------------------- #
def _reaper() -> None:
    while True:
        time.sleep(REAPER_INTERVAL)
        expired: list[tuple[str, dict]] = []
        with _lock:
            now = _now()
            for pod, st in list(_state.items()):
                if st and st["expires_at"] <= now:
                    log.info("expiring lease pod=%s lease=%s", pod, st["lease_id"])
                    _lease_to_pod.pop(st["lease_id"], None)
                    _state[pod] = None
                    expired.append((pod, st))
        for pod, st in expired:
            tabs = _sidecar_tabs(pod)               # before wipe
            _kill_quick_tunnel(st)
            _wipe_pod_profile(pod)
            duration = int((_now() - st["leased_at"]).total_seconds()) if st.get("leased_at") else None
            _audit("expire", lease_id=st["lease_id"], pod=pod,
                   quota_key=st.get("quota_key", "anonymous"),
                   source_ip=st.get("source_ip", "unknown"),
                   duration_s=duration, tabs=tabs)


threading.Thread(target=_reaper, daemon=True, name="reaper").start()
