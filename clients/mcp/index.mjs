#!/usr/bin/env node
/**
 * browser-pool MCP — lazy-acquire a remote Chromium pod from the allocator,
 * drive it via Playwright CDP, optionally offload to a human via the noVNC
 * magic-link.
 *
 * Lifecycle:
 *   - MCP startup: NO pod acquired (lazy).
 *   - First `browser_*` tool call: POST allocator/acquire -> Playwright
 *     connectOverCDP -> ready.
 *   - Idle for BROWSER_POOL_IDLE_RELEASE_MS (default 5 min): auto-release.
 *     Idle timer is PAUSED while a user-help session is open.
 *   - SIGTERM / SIGINT / process exit: release lease (best-effort).
 *
 * Required env (no default — you MUST set one of):
 *   BROWSER_POOL_URL               full allocator URL, e.g. https://allocator.example.com
 *                                  (alias: ALLOCATOR_URL)
 *
 * Auth — pick one (first that resolves wins):
 *   BROWSER_TOKEN                  "<client_id>:<client_secret>" colon-separated
 *   ALLOCATOR_SERVICE_TOKEN_FILE   path to JSON file; default ~/.config/browser-pool/service-token.json
 *                                  shape: {"CF_ACCESS_CLIENT_ID":"…","CF_ACCESS_CLIENT_SECRET":"…"}
 *
 * Optional:
 *   BROWSER_POOL_TIER              default "chrome-vnc"
 *   BROWSER_POOL_ACQUIRE_TTL       default 3600 (seconds)
 *   BROWSER_POOL_IDLE_RELEASE_MS   default 300000 (5 minutes)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --------------------------------------------------------------------------- //
//  Config                                                                     //
// --------------------------------------------------------------------------- //
const ALLOCATOR = process.env.BROWSER_POOL_URL || process.env.ALLOCATOR_URL;
if (!ALLOCATOR) {
  console.error("[browser-pool] FATAL: set BROWSER_POOL_URL (e.g. https://allocator.example.com)");
  process.exit(2);
}
const TOKEN_FILE =
  process.env.ALLOCATOR_SERVICE_TOKEN_FILE ||
  join(homedir(), ".config", "browser-pool", "service-token.json");
const TIER = process.env.BROWSER_POOL_TIER || "chrome-vnc";
const ACQUIRE_TTL = Number(process.env.BROWSER_POOL_ACQUIRE_TTL || 3600);
const IDLE_RELEASE_MS = Number(
  process.env.BROWSER_POOL_IDLE_RELEASE_MS || 5 * 60 * 1000
);
const IDLE_CHECK_MS = 30_000;

// CF Access service-token headers. Resolution order:
//   1. BROWSER_TOKEN env (colon-separated "client_id:client_secret")
//   2. JSON file at ALLOCATOR_SERVICE_TOKEN_FILE / default path
let CF_HEADERS = {};
if (process.env.BROWSER_TOKEN) {
  const colon = process.env.BROWSER_TOKEN.indexOf(":");
  if (colon < 0) {
    console.error("[browser-pool] FATAL: BROWSER_TOKEN must be in '<client_id>:<client_secret>' form");
    process.exit(2);
  }
  CF_HEADERS = {
    "CF-Access-Client-Id": process.env.BROWSER_TOKEN.slice(0, colon),
    "CF-Access-Client-Secret": process.env.BROWSER_TOKEN.slice(colon + 1),
  };
} else if (existsSync(TOKEN_FILE)) {
  try {
    const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    CF_HEADERS = {
      "CF-Access-Client-Id": t.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": t.CF_ACCESS_CLIENT_SECRET,
    };
  } catch (e) {
    console.error(`[browser-pool] failed to read ${TOKEN_FILE}: ${e.message}`);
  }
} else {
  console.error(`[browser-pool] no BROWSER_TOKEN env or token file at ${TOKEN_FILE} — allocator calls will fail with 302 if Access is enforced`);
}

// --------------------------------------------------------------------------- //
//  State                                                                      //
// --------------------------------------------------------------------------- //
let lease = null;           // { lease_id, pod, cdp_url, view_url, expires_at }
let browser = null;         // Playwright Browser (CDP-connected)
let context = null;         // BrowserContext
let page = null;            // currently focused Page
let lastActivityMs = Date.now();
let helpFlags = {};         // help_id -> { reason, started_at, condition }

const log = (msg) => console.error(`[browser-pool ${new Date().toISOString()}] ${msg}`);

const isHelpModeActive = () => Object.keys(helpFlags).length > 0;

// --------------------------------------------------------------------------- //
//  Allocator client                                                           //
// --------------------------------------------------------------------------- //
async function allocatorAcquire(profile) {
  const body = { ttl: ACQUIRE_TTL, tier: TIER };
  if (profile) body.profile = profile;
  const r = await fetch(`${ALLOCATOR}/acquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CF_HEADERS },
    body: JSON.stringify(body),
  });
  if (r.status === 423) {
    const ra = r.headers.get("Retry-After") || "30";
    throw new Error(`pool_exhausted (retry after ${ra}s) — all browsers busy`);
  }
  if (r.status === 404 && profile) {
    throw new Error(`profile not found: ${profile}`);
  }
  if (!r.ok) {
    throw new Error(`allocator/acquire HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.cdp_url) throw new Error(`allocator did not return cdp_url — upgrade allocator to chrome-vnc tier`);
  return j;
}

async function allocatorRelease(leaseId, opts = {}) {
  const body = { lease_id: leaseId };
  if (opts.save_as) body.save_as = opts.save_as;
  if (opts.save_domain_filter) body.save_domain_filter = opts.save_domain_filter;
  if (opts.force) body.force = true;
  try {
    const r = await fetch(`${ALLOCATOR}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...CF_HEADERS },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    // 409 = the allocator refused because a human has the viewer open.
    if (r.status === 409) return { refused: j?.detail ?? { error: "viewer_attached" } };
    return j;
  } catch (e) {
    log(`release of ${leaseId} failed: ${e.message}`);
    return {};
  }
}

// Is a human watching this lease's pod? Returns a count, or -1 when unknown
// (old/unreachable allocator) — callers must treat -1 as "not blocking" so a
// allocator hiccup can never wedge the client into never releasing.
async function allocatorViewers(leaseId) {
  try {
    const r = await fetch(`${ALLOCATOR}/viewers/${encodeURIComponent(leaseId)}`, {
      headers: { ...CF_HEADERS },
    });
    if (!r.ok) return -1;
    const j = await r.json().catch(() => ({}));
    return Number.isFinite(j?.viewers) ? j.viewers : -1;
  } catch {
    return -1;
  }
}

async function allocatorProfilesGet(path = "") {
  const r = await fetch(`${ALLOCATOR}/profiles${path}`, { headers: { ...CF_HEADERS } });
  if (!r.ok) throw new Error(`allocator/profiles${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function allocatorProfileDelete(name) {
  const r = await fetch(`${ALLOCATOR}/profiles/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { ...CF_HEADERS },
  });
  if (!r.ok) throw new Error(`allocator profile DELETE HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// --------------------------------------------------------------------------- //
//  Browser lifecycle                                                          //
// --------------------------------------------------------------------------- //
// Profile-injection hint for the next lazy acquire. Set by browser_load_profile,
// consumed (and cleared) by ensureBrowser. If the lease already exists when
// browser_load_profile is called, we teardown+re-acquire to apply the change.
let pendingProfile = null;

async function ensureBrowser() {
  lastActivityMs = Date.now();
  if (browser) return;
  const useProfile = pendingProfile;
  pendingProfile = null;
  lease = await allocatorAcquire(useProfile);
  log(`acquired pod=${lease.pod} cdp=${lease.cdp_url} view=${lease.view_url}` +
      (lease.profile_injected ? ` profile=${useProfile} (${lease.profile_injected.cookies}c/${lease.profile_injected.origins}o)` : ""));
  // Pass CF Access headers — when cdp_url is a CF Tunnel hostname, the WS
  // upgrade needs the same auth as the REST allocator. (No effect when the
  // operator's NodePort URL is used inside the tailnet.)
  browser = await chromium.connectOverCDP(lease.cdp_url, { headers: CF_HEADERS });
  context = browser.contexts()[0] || (await browser.newContext());
  page = context.pages()[0] || (await context.newPage());
}

// Refuse to tear down a session a human is in the middle of. Two independent
// signals, because either alone has a blind spot: help mode only fires if the
// agent actually called browser_request_user_help, and the viewer count only
// works if the allocator/sidecar are new enough to report it.
//
// Checked BEFORE browser.close() on purpose — closing first and asking after
// would already have destroyed the operator's login by the time we found out.
// After a human closes the viewer tab, cloudflared holds its origin
// connections open on a keep-alive for up to ~90s (measured 2026/08/24: 4
// sockets at +8s, 0 by ~+80s). Socket presence is deliberately the conservative
// signal — a false "someone is watching" only delays a release, while a false
// "nobody is watching" destroys a live login — so an explicit release waits out
// that tail instead of failing the call.
const RELEASE_VIEWER_WAIT_MS = parseInt(process.env.RELEASE_VIEWER_WAIT_MS || "45000", 10);
const VIEWER_POLL_MS = 5_000;

async function teardownBlockedBy(reason, opts) {
  if (opts.force) return null;
  if (isHelpModeActive()) {
    return { error: "help_mode_active", help_ids: Object.keys(helpFlags),
             hint: "a browser_request_user_help session is still open — call browser_wait_for_user_done first, or pass force:true" };
  }
  // Only a caller-driven release waits; the idle reaper returns immediately and
  // retries on its own schedule rather than holding the event loop.
  const deadline = Date.now() + (opts.waitForViewers ? RELEASE_VIEWER_WAIT_MS : 0);
  let n = await allocatorViewers(lease.lease_id);
  while (n > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, VIEWER_POLL_MS));
    n = await allocatorViewers(lease.lease_id);
  }
  if (n > 0) {
    return { error: "viewer_attached", viewers: n,
             hint: "a human has the noVNC viewer open — wait for them and retry, or pass force:true" };
  }
  return null;
}

async function teardown(reason, opts = {}) {
  if (!lease) return;
  const id = lease.lease_id;
  const blocked = await teardownBlockedBy(reason, opts);
  if (blocked) {
    log(`release (${reason}) lease=${id} REFUSED: ${blocked.error}`);
    return { ...lease, refused: blocked };
  }
  log(`release (${reason}) lease=${id}` + (opts.save_as ? ` save_as=${opts.save_as}` : ""));
  try {
    await browser?.close();
  } catch {}
  browser = context = page = null;
  const oldLease = lease;
  lease = null;
  helpFlags = {};
  const releaseResult = await allocatorRelease(id, opts);
  if (releaseResult?.refused) {
    // Server said no after we had already closed our CDP handle. Chromium is
    // relaunched by the pod watchdog; put the lease back so we retry later
    // rather than orphaning it.
    lease = oldLease;
    log(`release (${reason}) lease=${id} REFUSED by allocator: ${releaseResult.refused.error}`);
    return { ...oldLease, refused: releaseResult.refused };
  }
  return { ...oldLease, release_result: releaseResult };
}

// Idle reaper. Never forces: an idle agent is exactly the case where a human
// is quietly logging in through the viewer, so a refusal means wait, not push.
let idleRetryAfterMs = 0;
const IDLE_REFUSAL_BACKOFF_MS = 60_000;
const reaper = setInterval(async () => {
  if (!lease) return;
  if (isHelpModeActive()) return; // user is in the middle of helping — don't yank
  if (Date.now() < idleRetryAfterMs) return;
  if (Date.now() - lastActivityMs > IDLE_RELEASE_MS) {
    const r = await teardown("idle");
    // Lease is kept on refusal; try again later instead of every IDLE_CHECK_MS.
    if (r?.refused) idleRetryAfterMs = Date.now() + IDLE_REFUSAL_BACKOFF_MS;
  }
}, IDLE_CHECK_MS);
reaper.unref();

// Shutdown handlers — best-effort release.
const shutdown = async (sig) => {
  log(`signal ${sig} received`);
  await teardown(sig);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("exit", () => {
  if (lease) {
    // synchronous fire-and-forget (best-effort)
    allocatorRelease(lease.lease_id).catch(() => {});
  }
});

// --------------------------------------------------------------------------- //
//  Tool definitions                                                           //
// --------------------------------------------------------------------------- //
const TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate the current tab to a URL. Triggers lazy acquire on first call.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Absolute URL" },
        wait_until: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          default: "domcontentloaded",
        },
        timeout_ms: { type: "integer", default: 60000 },
      },
    },
  },
  {
    name: "browser_snapshot",
    description: "Return the current page's accessibility tree + URL + title. Token-efficient view of page state — prefer over screenshot when possible.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_take_screenshot",
    description: "Capture a PNG screenshot of the current page. Returns base64. Use when accessibility snapshot is insufficient.",
    inputSchema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string" },
        timeout_ms: { type: "integer", default: 30000 },
      },
    },
  },
  {
    name: "browser_type",
    description: "Type text into an input/textarea by CSS selector. Optionally press Enter to submit.",
    inputSchema: {
      type: "object",
      required: ["selector", "text"],
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", default: false, description: "press Enter after typing" },
      },
    },
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key (e.g. 'Enter', 'Tab', 'Control+A').",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string" } },
    },
  },
  {
    name: "browser_evaluate",
    description: "Run a JavaScript expression in the page and return the result.",
    inputSchema: {
      type: "object",
      required: ["expression"],
      properties: { expression: { type: "string" } },
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait for a condition: a selector to appear, a URL pattern, body text to appear, or a fixed time. Exactly one condition.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        url: { type: "string", description: "URL pattern (regex)" },
        text: { type: "string", description: "text to wait for in the body" },
        time_ms: { type: "integer", description: "fixed sleep" },
        timeout_ms: { type: "integer", default: 30000 },
      },
    },
  },
  {
    name: "browser_get_url",
    description: "Return the current tab's URL.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_get_title",
    description: "Return the current tab's title.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_list_tabs",
    description: "List all open tabs in the current browser context.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_new_tab",
    description: "Open a new tab; optionally navigate it to a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
    },
  },
  {
    name: "browser_switch_tab",
    description: "Switch focus to a different tab by index (0-based).",
    inputSchema: {
      type: "object",
      required: ["index"],
      properties: { index: { type: "integer" } },
    },
  },
  {
    name: "browser_close_tab",
    description: "Close a tab by index (defaults to current).",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer" } },
    },
  },
  {
    name: "browser_get_view_url",
    description: "Return the noVNC viewer URL for the active session (always callable; lazy-acquires if no active session). Share with the user when they need to see/take-over the browser.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_get_session_info",
    description: "Return { active, lease_id, view_url, cdp_url, pod, current_url, idle_seconds, help_mode, viewers }. `viewers` > 0 means a human has the noVNC viewer open right now (-1 = unknown) — check it before releasing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_request_user_help",
    description:
      "Signal that you need a human to interact with the browser (e.g. solve captcha, log in). Returns immediately with a view_url to share with the user. The idle reaper is paused until browser_wait_for_user_done finishes. After calling this, paste view_url to the user (e.g. via your Telegram MCP) and then call browser_wait_for_user_done to sync.",
    inputSchema: {
      type: "object",
      required: ["reason"],
      properties: {
        reason: { type: "string", description: "Human-readable summary of what you need help with" },
        wait_for: {
          type: "object",
          description: "Default condition to use for the subsequent wait (overridable per call).",
          properties: {
            url_matches: { type: "string", description: "regex" },
            selector_present: { type: "string" },
            selector_disappears: { type: "string" },
            text_appears: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "browser_wait_for_user_done",
    description:
      "Block (with polling) until the user has finished helping, signalled by a condition on the page (url change, selector appear/disappear, text). Returns { outcome: satisfied|timeout, final_url, title }. Provide the help_id returned by browser_request_user_help.",
    inputSchema: {
      type: "object",
      required: ["help_id"],
      properties: {
        help_id: { type: "string" },
        condition: {
          type: "object",
          properties: {
            url_matches: { type: "string" },
            selector_present: { type: "string" },
            selector_disappears: { type: "string" },
            text_appears: { type: "string" },
          },
        },
        deadline_seconds: { type: "integer", default: 600 },
        poll_interval_ms: { type: "integer", default: 2000 },
      },
    },
  },
  {
    name: "browser_release",
    description: "Explicitly release the current lease (browser closed, pod returned to the pool). Next browser_* call will lazy-acquire again. Optionally dump the profile to a named store BEFORE the wipe. REFUSED (ok:false) while a human has the noVNC viewer open or a browser_request_user_help session is unfinished — releasing wipes the profile and kills the viewer, so it would destroy a login in progress. Wait for them, or pass force:true if you are certain nobody is using it.",
    inputSchema: {
      type: "object",
      properties: {
        save_as: { type: "string", description: "Save this lease's state as a named profile before releasing (allocator-side persistent store). Skipped on auto-release. Saves the FULL profile tarball — cookies + localStorage + IndexedDB — unless save_domain_filter is also set." },
        save_domain_filter: { type: "string", description: "Only save cookies whose domain contains this substring (e.g. 'facebook.com'). WARNING: this downgrades the save to the thin JSON format (cookies + localStorage ONLY) — IndexedDB is NOT captured, so sites that keep their session there come back logged out. Omit it unless you specifically need to scope the dump to one domain." },
        force: { type: "boolean", default: false, description: "Release even if a human currently has the viewer open / a help session unfinished. Destroys their in-progress session — only pass it when you know they are done." },
      },
    },
  },
  {
    name: "browser_load_profile",
    description: "Acquire a fresh lease with a named profile injected (full profile from the allocator's store: cookies + localStorage + IndexedDB for tarball profiles, cookies + localStorage only for legacy JSON ones). If a lease is already active it is released first — which fails if a human is currently using it. Use this when you need the agent to start out logged-in to a specific account.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name as stored in allocator's /profiles store" },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_list_profiles",
    description: "List named profiles in the allocator's profile store. Returns {profiles: [{name, size, modified}]}.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_delete_profile",
    description: "Delete a named profile from the allocator's profile store. Does NOT affect any active lease.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

// --------------------------------------------------------------------------- //
//  Tool dispatcher                                                            //
// --------------------------------------------------------------------------- //
async function pollCondition(cond, deadline, intervalMs) {
  while (Date.now() < deadline) {
    try {
      if (cond.url_matches && new RegExp(cond.url_matches).test(page.url())) return true;
      if (cond.selector_present && (await page.$(cond.selector_present))) return true;
      if (cond.selector_disappears && !(await page.$(cond.selector_disappears))) return true;
      if (cond.text_appears) {
        const has = await page.evaluate((t) => document.body && document.body.innerText.includes(t), cond.text_appears);
        if (has) return true;
      }
    } catch {
      /* page navigated mid-poll; try again */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function handleTool(name, args) {
  switch (name) {
    // --- navigation + observation -----------------------------------------
    case "browser_navigate": {
      await ensureBrowser();
      await page.goto(args.url, {
        waitUntil: args.wait_until || "domcontentloaded",
        timeout: args.timeout_ms || 60000,
      });
      return { url: page.url(), title: await page.title() };
    }
    case "browser_snapshot": {
      await ensureBrowser();
      let acc = null;
      // Try Playwright's accessibility.snapshot first (older API).
      try {
        if (page.accessibility?.snapshot) {
          acc = await page.accessibility.snapshot({ interestingOnly: true });
        }
      } catch { /* fall through */ }
      // Fallback: lightweight ARIA-aware DOM walk via page.evaluate.
      if (!acc) {
        acc = await page.evaluate(() => {
          const MAX_DEPTH = 30;
          const MAX_TEXT = 200;
          function walk(node, depth = 0) {
            if (!node || depth > MAX_DEPTH) return null;
            if (node.nodeType === Node.TEXT_NODE) {
              const t = (node.textContent || "").trim();
              return t ? { role: "text", text: t.slice(0, MAX_TEXT) } : null;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return null;
            const el = node;
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute("role") || tag;
            const item = { role };
            const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title");
            if (label) item.label = label;
            if (el.id) item.id = el.id;
            if (tag === "input" || tag === "textarea" || tag === "select") {
              if (el.name) item.name = el.name;
              if (el.type) item.input_type = el.type;
              if (el.placeholder) item.placeholder = el.placeholder;
              if (el.value) item.value = String(el.value).slice(0, MAX_TEXT);
            }
            if (tag === "a" && el.href) item.href = el.href;
            if (["button", "a", "label", "h1", "h2", "h3", "h4"].includes(tag)) {
              const t = (el.innerText || "").trim();
              if (t) item.text = t.slice(0, MAX_TEXT);
            }
            const kids = [];
            for (const c of el.childNodes) {
              const r = walk(c, depth + 1);
              if (r) kids.push(r);
            }
            if (kids.length) item.children = kids;
            return item;
          }
          return walk(document.body);
        });
      }
      return {
        url: page.url(),
        title: await page.title(),
        accessibility: acc,
      };
    }
    case "browser_take_screenshot": {
      await ensureBrowser();
      const buf = await page.screenshot({ type: "png", fullPage: !!args.full_page });
      return { format: "png", base64: buf.toString("base64") };
    }
    case "browser_get_url": {
      await ensureBrowser();
      return { url: page.url() };
    }
    case "browser_get_title": {
      await ensureBrowser();
      return { title: await page.title() };
    }

    // --- interaction ------------------------------------------------------
    case "browser_click": {
      await ensureBrowser();
      await page.click(args.selector, { timeout: args.timeout_ms || 30000 });
      return { ok: true };
    }
    case "browser_type": {
      await ensureBrowser();
      await page.fill(args.selector, args.text);
      if (args.submit) await page.press(args.selector, "Enter");
      return { ok: true };
    }
    case "browser_press_key": {
      await ensureBrowser();
      await page.keyboard.press(args.key);
      return { ok: true };
    }
    case "browser_evaluate": {
      await ensureBrowser();
      const v = await page.evaluate(args.expression);
      return { result: v };
    }
    case "browser_wait_for": {
      await ensureBrowser();
      const t = args.timeout_ms || 30000;
      if (args.time_ms != null) { await page.waitForTimeout(args.time_ms); return { ok: true }; }
      if (args.selector) { await page.waitForSelector(args.selector, { timeout: t }); return { ok: true }; }
      if (args.url) { await page.waitForURL(new RegExp(args.url), { timeout: t }); return { ok: true, url: page.url() }; }
      if (args.text) {
        await page.waitForFunction(
          (txt) => document.body && document.body.innerText.includes(txt),
          args.text,
          { timeout: t }
        );
        return { ok: true };
      }
      throw new Error("browser_wait_for: provide one of selector | url | text | time_ms");
    }

    // --- tabs -------------------------------------------------------------
    case "browser_list_tabs": {
      await ensureBrowser();
      const tabs = await Promise.all(
        context.pages().map(async (p, i) => ({
          index: i,
          url: p.url(),
          title: await p.title().catch(() => ""),
          active: p === page,
        }))
      );
      return { tabs };
    }
    case "browser_new_tab": {
      await ensureBrowser();
      page = await context.newPage();
      if (args.url) await page.goto(args.url, { waitUntil: "domcontentloaded" });
      return { index: context.pages().indexOf(page), url: page.url() };
    }
    case "browser_switch_tab": {
      await ensureBrowser();
      const pages = context.pages();
      if (args.index < 0 || args.index >= pages.length) throw new Error(`tab index out of range (0..${pages.length - 1})`);
      page = pages[args.index];
      await page.bringToFront();
      return { active_index: args.index, url: page.url() };
    }
    case "browser_close_tab": {
      await ensureBrowser();
      const pages = context.pages();
      const idx = args.index ?? pages.indexOf(page);
      await pages[idx].close();
      page = context.pages()[0] || null;
      return { ok: true, remaining: context.pages().length };
    }

    // --- session / lease --------------------------------------------------
    case "browser_get_view_url": {
      await ensureBrowser();
      return { view_url: lease.view_url, lease_id: lease.lease_id, pod: lease.pod };
    }
    case "browser_get_session_info": {
      if (!lease) return { active: false };
      return {
        active: true,
        lease_id: lease.lease_id,
        pod: lease.pod,
        view_url: lease.view_url,
        cdp_url: lease.cdp_url,
        expires_at: lease.expires_at,
        current_url: page ? page.url() : null,
        idle_seconds: Math.round((Date.now() - lastActivityMs) / 1000),
        idle_release_seconds: Math.round(IDLE_RELEASE_MS / 1000),
        help_mode: isHelpModeActive(),
        active_help_ids: Object.keys(helpFlags),
        // >0 means a human has the noVNC viewer open right now; -1 = unknown.
        viewers: lease ? await allocatorViewers(lease.lease_id) : 0,
      };
    }

    // --- human-offload ----------------------------------------------------
    case "browser_request_user_help": {
      await ensureBrowser();
      const help_id = `h-${Math.random().toString(36).slice(2, 10)}`;
      helpFlags[help_id] = {
        reason: args.reason,
        started_at: Date.now(),
        condition: args.wait_for || null,
      };
      log(`user help requested (${help_id}): ${args.reason}`);
      return {
        help_id,
        view_url: lease.view_url,
        reason: args.reason,
        instructions:
          `Share this URL with the user: ${lease.view_url}\n` +
          `Then call browser_wait_for_user_done({help_id: "${help_id}", condition: {...}}) to block until the user is done. ` +
          `The idle reaper is paused until then.`,
      };
    }
    case "browser_wait_for_user_done": {
      await ensureBrowser();
      const help = helpFlags[args.help_id];
      if (!help) throw new Error(`unknown help_id: ${args.help_id} (already resolved?)`);
      const cond = args.condition || help.condition || {};
      if (!Object.keys(cond).length) throw new Error("provide a condition (url_matches | selector_present | selector_disappears | text_appears)");
      const deadlineMs = Date.now() + (args.deadline_seconds || 600) * 1000;
      const interval = args.poll_interval_ms || 2000;
      const satisfied = await pollCondition(cond, deadlineMs, interval);
      delete helpFlags[args.help_id];
      lastActivityMs = Date.now();
      const outcome = satisfied ? "satisfied" : "timeout";
      log(`user help (${args.help_id}) -> ${outcome}`);
      return {
        outcome,
        final_url: page ? page.url() : null,
        title: page ? await page.title() : null,
        elapsed_ms: Date.now() - help.started_at,
      };
    }

    case "browser_release": {
      const released = await teardown("explicit", {
        save_as: args?.save_as,
        save_domain_filter: args?.save_domain_filter,
        force: args?.force === true,
        waitForViewers: true,
      });
      if (released?.refused) {
        return {
          ok: false,
          released: false,
          lease_id: released.lease_id,
          view_url: released.view_url,
          ...released.refused,
        };
      }
      return {
        ok: true,
        released_lease_id: released?.lease_id,
        saved_to: released?.release_result?.saved_to || null,
        saved_format: released?.release_result?.saved_format || null,
      };
    }

    case "browser_load_profile": {
      if (!args?.name) throw new Error("name required");
      if (lease) {
        log(`browser_load_profile: tearing down existing lease to switch profile`);
        const r = await teardown("switch-profile", { waitForViewers: true });
        if (r?.refused) {
          throw new Error(
            `cannot switch profile: ${r.refused.error} — ${r.refused.hint}. ` +
            `Release explicitly with force:true if you really mean to discard that session.`
          );
        }
      }
      pendingProfile = args.name;
      await ensureBrowser();
      return {
        loaded: true,
        profile: args.name,
        pod: lease.pod,
        lease_id: lease.lease_id,
        view_url: lease.view_url,
        profile_injected: lease.profile_injected || null,
      };
    }

    case "browser_list_profiles": {
      return await allocatorProfilesGet();
    }

    case "browser_delete_profile": {
      if (!args?.name) throw new Error("name required");
      return await allocatorProfileDelete(args.name);
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// --------------------------------------------------------------------------- //
//  MCP server wiring                                                          //
// --------------------------------------------------------------------------- //
const server = new Server(
  { name: "browser-pool", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [
        {
          type: "text",
          text:
            typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (e) {
    log(`tool ${name} error: ${e.message}`);
    return {
      content: [{ type: "text", text: `ERROR: ${e.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(
  `MCP ready  tier=${TIER}  idle_release=${IDLE_RELEASE_MS / 1000}s  allocator=${ALLOCATOR}`
);
