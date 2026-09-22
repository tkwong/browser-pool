#!/usr/bin/env python3
"""
Report stale named profiles in the allocator's profile store.

REPORT ONLY — this script never deletes anything. `DELETE /profiles/{name}` is
a hard `Path.unlink()` with no trash routing (unlike a wiped pod profile, which
`_bin_profile_before_wipe` snapshots for TRASH_TTL), so an unattended sweeper
that deletes is a one-way door. The intent is to run this for a few months,
eyeball what it would have removed, and only then decide whether to wire the
delete side up.

"Last activity" is the later of two signals, because neither alone is right:

  * last `acquire` in the audit log — when the profile was last *loaded*.
  * the file mtime from `GET /profiles` — when it was last *saved*.

mtime alone is badly wrong for a profile that is loaded often but rarely
re-saved (2026-09-22: linkedin-benjamin mtime was 8/04, last load 9/03).
The audit log alone misses a profile saved but never loaded since.

The audit log is also a horizon, not a history: `/admin/log` caps at 2000
matching entries and nothing rotates the file, so a profile whose mtime
predates the oldest acquire on record cannot be distinguished from one used
just before the window opened. Those land in a separate "verify" bucket
instead of being reported as stale.

Usage:
    export BROWSER_POOL_URL=https://allocator.your-domain.com
    export BROWSER_TOKEN=<client_id>:<client_secret>   # OR the token file below
    # Or via file: ~/.config/browser-pool/service-token.json
    python3 scripts/profile-sweep.py [--days 90] [--json]

Exit codes: 0 = nothing stale, 10 = stale candidates found, 2 = usage/auth.
Stdlib only, so plain `python3` is enough (no `uv run --with httpx`).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = os.environ.get("BROWSER_POOL_URL", "https://allocator.cartforge.net").rstrip("/")
TOKEN_FILE = Path(
    os.environ.get("ALLOCATOR_SERVICE_TOKEN_FILE",
                   Path.home() / ".config/browser-pool/service-token.json")
)
# Cloudflare's edge WAF answers urllib's default User-Agent with 403 error 1010,
# which looks exactly like a bad service token. Send a browser-ish UA instead.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")
# `/admin/log` clamps limit to this; hitting it means the window is truncated.
LOG_CAP = 2000


def _cf_headers() -> dict:
    if os.environ.get("BROWSER_TOKEN"):
        try:
            cid, csec = os.environ["BROWSER_TOKEN"].split(":", 1)
        except ValueError:
            sys.exit("BROWSER_TOKEN must be in '<client_id>:<client_secret>' form")
    else:
        cid = os.environ.get("CF_ACCESS_CLIENT_ID")
        csec = os.environ.get("CF_ACCESS_CLIENT_SECRET")
        if not (cid and csec) and TOKEN_FILE.exists():
            tok = json.loads(TOKEN_FILE.read_text())
            cid = cid or tok.get("CF_ACCESS_CLIENT_ID")
            csec = csec or tok.get("CF_ACCESS_CLIENT_SECRET")
    if not (cid and csec):
        sys.exit("Missing BROWSER_TOKEN env OR CF_ACCESS_CLIENT_ID/SECRET "
                 f"OR {TOKEN_FILE}")
    return {"CF-Access-Client-Id": cid, "CF-Access-Client-Secret": csec,
            "User-Agent": UA}


def get(path: str, headers: dict) -> dict:
    req = urllib.request.Request(BASE + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        sys.exit(f"GET {path} -> HTTP {exc.code}: {exc.read()[:200].decode(errors='replace')}")
    except urllib.error.URLError as exc:
        sys.exit(f"GET {path} -> {exc.reason}")


def ts(raw) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def classify(rows: list, threshold_days: int) -> tuple[list, list, list]:
    """Split rows into stale / needs-a-human / fresh.

    A row only counts as stale when the audit log can actually prove it: no
    timestamp at all, or an mtime older than the oldest acquire on record, means
    idleness is unprovable and a human has to look.
    """
    stale, verify, fresh = [], [], []
    for r in rows:
        if r["idle_days"] is None or r["before_audit_window"]:
            verify.append(r)
        elif r["idle_days"] < threshold_days:
            fresh.append(r)
        else:
            stale.append(r)
    stale.sort(key=lambda r: -r["idle_days"])
    verify.sort(key=lambda r: -(r["idle_days"] or 0))
    return stale, verify, fresh


def main() -> int:
    ap = argparse.ArgumentParser(description="Report stale named profiles (never deletes).")
    ap.add_argument("--days", type=int, default=90,
                    help="idle threshold in days (default 90)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    hdr = _cf_headers()
    now = datetime.now(timezone.utc)

    log = get(f"/admin/log?action=acquire&limit={LOG_CAP}", hdr)
    acquires = log.get("entries", [])            # newest first
    truncated = len(acquires) >= LOG_CAP
    # Oldest acquire on record: before this we know nothing about loads.
    floor = next((t for t in (ts(e.get("ts")) for e in reversed(acquires)) if t), None)

    last_load: dict[str, datetime] = {}
    for e in acquires:                            # newest first, so first wins
        name, when = e.get("profile"), ts(e.get("ts"))
        if name and when and name not in last_load:
            last_load[name] = when

    rows = []
    for p in get("/profiles", hdr).get("profiles", []):
        name = p["name"]
        saved = ts(p.get("modified"))
        loaded = last_load.get(name)
        last = max([t for t in (saved, loaded) if t], default=None)
        # No load on record and the profile predates the window: "never loaded"
        # and "loaded just before the log starts" are indistinguishable here.
        blind = loaded is None and floor is not None and saved is not None and saved < floor
        rows.append({
            "name": name,
            "format": p.get("format"),
            "size": p.get("size"),
            "saved": saved.isoformat() if saved else None,
            "last_load": loaded.isoformat() if loaded else None,
            "last_activity": last.isoformat() if last else None,
            "idle_days": round((now - last).total_seconds() / 86400, 1) if last else None,
            "source": "load" if last and last == loaded else "save",
            "never_loaded": loaded is None,
            "before_audit_window": blind,
        })

    stale, verify, fresh = classify(rows, args.days)

    if args.json:
        print(json.dumps({
            "generated_at": now.isoformat(),
            "threshold_days": args.days,
            "audit_window_start": floor.isoformat() if floor else None,
            "audit_window_truncated": truncated,
            "total_profiles": len(rows),
            "stale": stale, "verify": verify, "fresh_count": len(fresh),
        }, indent=2))
        return 10 if stale else 0

    print(f"browser-pool profile sweep — {BASE}")
    print(f"  as of {now.isoformat(timespec='seconds')}  ·  threshold {args.days}d  ·  REPORT ONLY")
    print(f"  {len(rows)} profiles  ·  audit window from "
          f"{floor.isoformat(timespec='seconds') if floor else 'n/a'}"
          f"{'  ⚠ TRUNCATED at %d entries' % LOG_CAP if truncated else ''}")

    def table(label: str, items: list) -> None:
        print(f"\n{label} ({len(items)})")
        if not items:
            print("  —")
            return
        print(f"  {'name':<38} {'fmt':<5} {'idle':>7}  {'via':<5} last activity")
        for r in items:
            idle = f"{r['idle_days']:.0f}d" if r["idle_days"] is not None else "?"
            flag = " ⚠ pre-audit-window" if r["before_audit_window"] else ""
            print(f"  {r['name']:<38} {r['format']:<5} {idle:>7}  {r['source']:<5} "
                  f"{(r['last_activity'] or 'unknown')[:19]}{flag}")

    table(f"STALE — idle ≥ {args.days}d, safe to propose for deletion", stale)
    table("VERIFY BY HAND — cannot prove idleness from the audit log", verify)
    print(f"\nFRESH — idle < {args.days}d: {len(fresh)}")
    print("\nNothing was deleted. To remove one: "
          "DELETE /profiles/<name>  (hard unlink, no undo)")
    return 10 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
