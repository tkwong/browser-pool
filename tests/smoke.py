"""
End-to-end smoke test.

Usage:
    pip install httpx playwright
    playwright install-deps chromium  # one-time
    export ALLOCATOR_URL=https://allocator.cartforge.net
    export ALLOCATOR_TOKEN=...        # if you set ALLOCATOR_SERVICE_TOKEN
    python smoke.py

What it does:
    1. POST /acquire   (gets a pod URL + lease_id)
    2. CDP-connects Playwright to that pod, navigates to example.com,
       prints the page title.
    3. POST /release   (returns the pod to the pool)
"""

import asyncio
import os
import sys

import httpx
from playwright.async_api import async_playwright

ALLOCATOR = os.environ.get("ALLOCATOR_URL", "https://allocator.cartforge.net")
TOKEN = os.environ.get("ALLOCATOR_TOKEN", "")


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}


async def main() -> None:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{ALLOCATOR}/acquire", json={"ttl": 120}, headers=_headers())
        if r.status_code == 423:
            print("POOL EXHAUSTED — retry-after:", r.headers.get("Retry-After"))
            sys.exit(2)
        r.raise_for_status()
        lease = r.json()
        print("ACQUIRED:", lease)

        try:
            ws_url = lease["pod_url"].replace("https://", "wss://").rstrip("/") + "/"
            async with async_playwright() as p:
                browser = await p.chromium.connect_over_cdp(ws_url)
                ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                await page.goto("https://example.com", wait_until="domcontentloaded", timeout=30_000)
                print("PAGE:", page.url, "|", await page.title())
        finally:
            rr = await c.post(
                f"{ALLOCATOR}/release",
                json={"lease_id": lease["lease_id"]},
                headers=_headers(),
            )
            print("RELEASED:", rr.json())


if __name__ == "__main__":
    asyncio.run(main())
