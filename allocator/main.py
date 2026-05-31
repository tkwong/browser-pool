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
from fastapi import FastAPI, Header, HTTPException
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
# CDP URL handed to agents (e.g. playwright-mcp via browser-pool-mcp). For
# chrome-vnc tier this points at the Tailscale-reachable NodePort relayed by
# the nginx sidecar (modern Chromium binds CDP to 127.0.0.1 only). Per-pod
# CDP_URL_{POD} env overrides take priority over the global template.
CDP_URL_TPL = os.environ.get("CDP_URL_TEMPLATE", "")  # e.g. "http://100.108.4.108:30922"
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
    cf_access_client_id: Optional[str] = Header(default=None, alias="CF-Access-Client-Id"),
):
    _check_auth(authorization)
    ttl = req.ttl or DEFAULT_TTL
    quota_key = cf_access_client_id or "anonymous"
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
                _lease_to_pod[lease_id] = pod
                break

    if claimed_pod is None:
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
def release(req: ReleaseReq, authorization: Optional[str] = Header(default=None)):
    _check_auth(authorization)
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

    if old_state:
        _kill_quick_tunnel(old_state)
    _wipe_pod_profile(pod)
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
            _kill_quick_tunnel(st)
            _wipe_pod_profile(pod)


threading.Thread(target=_reaper, daemon=True, name="reaper").start()
