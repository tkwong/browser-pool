#!/usr/bin/env node
// browser-pool integration test — exercises the WHOLE client path.
//
// smoke.py (pure httpx) covers allocator REST. This complements it by:
//   - actually opening the CDP WebSocket through CF Tunnel
//   - navigating real pages and asserting content rendered
//   - exercising profile inject -> cookies-in-context
//
// Co-located in clients/mcp/ so playwright-core resolves from the MCP client's
// own node_modules. Run via `make integration` from repo root, or:
//   cd clients/mcp && BROWSER_POOL_URL=... BROWSER_TOKEN=... node test-integration.mjs

import { chromium } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ALLOCATOR = process.env.BROWSER_POOL_URL || process.env.ALLOCATOR_URL;
if (!ALLOCATOR) {
  console.error("Set BROWSER_POOL_URL");
  process.exit(2);
}

// Resolve CF Access headers: BROWSER_TOKEN env (id:secret) or token file.
function cfHeaders() {
  if (process.env.BROWSER_TOKEN) {
    const i = process.env.BROWSER_TOKEN.indexOf(":");
    if (i < 0) throw new Error("BROWSER_TOKEN must be <client_id>:<client_secret>");
    return {
      "CF-Access-Client-Id": process.env.BROWSER_TOKEN.slice(0, i),
      "CF-Access-Client-Secret": process.env.BROWSER_TOKEN.slice(i + 1),
    };
  }
  const f = process.env.ALLOCATOR_SERVICE_TOKEN_FILE
    || join(homedir(), ".config", "browser-pool", "service-token.json");
  if (!existsSync(f)) throw new Error(`no BROWSER_TOKEN env and no token file at ${f}`);
  const t = JSON.parse(readFileSync(f, "utf8"));
  return {
    "CF-Access-Client-Id": t.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": t.CF_ACCESS_CLIENT_SECRET,
  };
}
const HDR = cfHeaders();

let PASS = 0, FAIL = 0;
function check(label, cond, detail = "") {
  if (cond) { PASS++; console.log(`  PASS  ${label}`); }
  else      { FAIL++; console.log(`  FAIL  ${label}${detail ? "  (" + detail + ")" : ""}`); }
}
function step(name) { console.log(`\n[${name}]`); }

async function api(path, opts = {}) {
  const r = await fetch(`${ALLOCATOR}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...HDR, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// --------------------------------------------------------------------------- //
// 1. Acquire a fresh lease (no profile)
// --------------------------------------------------------------------------- //
step("acquire + connect");
const a = await api("/acquire", { method: "POST", body: JSON.stringify({ ttl: 240 }) });
check("acquire 200", a.status === 200, String(a.status));
const lease = a.body;
check("cdp_url is CF Tunnel URL", String(lease.cdp_url || "").startsWith("https://cdp-"),
      lease.cdp_url);
check("view_url is trycloudflare", String(lease.view_url || "").includes("trycloudflare.com"),
      lease.view_url);

let browser;
try {
  browser = await chromium.connectOverCDP(lease.cdp_url, { headers: HDR });
  check("connectOverCDP through CF Tunnel", true);
} catch (e) {
  check("connectOverCDP through CF Tunnel", false, e.message);
  await api("/release", { method: "POST", body: JSON.stringify({ lease_id: lease.lease_id }) });
  process.exit(1);
}
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = ctx.pages()[0] || (await ctx.newPage());

// --------------------------------------------------------------------------- //
// 2. Navigate to example.com — baseline sanity (static page, no anti-bot)
// --------------------------------------------------------------------------- //
step("navigate example.com");
try {
  const resp = await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  check("HTTP 200", resp?.status() === 200, String(resp?.status()));
  const title = await page.title();
  check("title contains 'Example'", /Example/.test(title), title);
  const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0);
  check("body innerText > 100 chars", bodyLen > 100, `got ${bodyLen}`);
} catch (e) {
  check("navigation completed", false, e.message);
}

// --------------------------------------------------------------------------- //
// 3. Navigate to AAStocks — HK financial site, proves our HK IP not geo-blocked
//    and that ordinary HK sites render fully through our pod. Catches anti-bot
//    triggers that would block on real browsers too.
// --------------------------------------------------------------------------- //
step("navigate aastocks.com (HK site, content-render check)");
try {
  const resp = await page.goto("https://www.aastocks.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  check("HTTP 200", resp?.status() === 200, String(resp?.status()));
  const title = await page.title();
  check("title is AAStocks (Chinese)", /AASTOCKS|阿斯達克|阿思達克/i.test(title), title);
  const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0);
  check("body innerText > 1000 chars (not a CF challenge page)", bodyLen > 1000, `got ${bodyLen}`);
} catch (e) {
  check("navigation completed", false, e.message);
}

// --------------------------------------------------------------------------- //
// 4. Release (no save_as) and re-acquire WITH a profile to test inject path
// --------------------------------------------------------------------------- //
step("release + acquire with profile");
await browser.close();
await api("/release", { method: "POST", body: JSON.stringify({ lease_id: lease.lease_id }) });

// Pick the first available profile; if no profiles exist, skip the inject test
const ls = await api("/profiles");
const profileName = (ls.body.profiles || [])[0]?.name;
if (!profileName) {
  console.log("  SKIP  inject test (no profiles in store)");
} else {
  const a2 = await api("/acquire", { method: "POST", body: JSON.stringify({ ttl: 120, profile: profileName }) });
  check(`acquire {profile: ${profileName}} 200`, a2.status === 200, String(a2.status));
  const injected = a2.body.profile_injected || {};
  check("profile_injected.cookies > 0", (injected.cookies || 0) > 0, JSON.stringify(injected));

  const browser2 = await chromium.connectOverCDP(a2.body.cdp_url, { headers: HDR });
  const ctx2 = browser2.contexts()[0];
  const cookies = await ctx2.cookies();
  check("context.cookies() returns >= injected count", cookies.length >= (injected.cookies || 0),
        `got ${cookies.length}, expected >= ${injected.cookies}`);
  await browser2.close();
  await api("/release", { method: "POST", body: JSON.stringify({ lease_id: a2.body.lease_id }) });
}

// --------------------------------------------------------------------------- //
console.log(`\nPASS: ${PASS}   FAIL: ${FAIL}`);
process.exit(FAIL ? 1 : 0);
