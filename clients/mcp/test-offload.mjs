#!/usr/bin/env node
/**
 * Comprehensive offload flow test:
 *   1. spawn MCP, navigate to example.com
 *   2. call request_user_help (wait_for: url_matches "example.org")
 *   3. SIMULATE user driving the browser: separately connect Playwright via
 *      same CDP and navigate to example.org
 *   4. wait_for_user_done should poll, detect URL change, return "satisfied"
 *   5. release
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const MCP_PATH = join(dirname(fileURLToPath(import.meta.url)), "index.mjs");

function startMCP() {
  const proc = spawn("node", [MCP_PATH], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const wait = new Map();
  let nid = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const ln = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!ln) continue;
      try {
        const m = JSON.parse(ln);
        if (m.id != null && wait.has(m.id)) {
          wait.get(m.id)(m);
          wait.delete(m.id);
        }
      } catch {}
    }
  });
  const call = (method, params) =>
    new Promise((r) => {
      const id = nid++;
      wait.set(id, r);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const tool = async (name, args) => {
    const r = await call("tools/call", { name, arguments: args || {} });
    if (r.result.isError) throw new Error(r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  };
  return { proc, call, tool };
}

const { proc, call, tool } = startMCP();
const t0 = Date.now();
const ts = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

try {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "offload-test", version: "0" },
  });

  console.log(`${ts()} STEP 1: browser_navigate to example.com (lazy-acquires pod)`);
  const nav = await tool("browser_navigate", { url: "https://example.com" });
  console.log(`${ts()}   ${nav.title} @ ${nav.url}`);

  console.log(`${ts()} STEP 2: get session info — see view_url + cdp_url`);
  const info = await tool("browser_get_session_info", {});
  console.log(`${ts()}   pod=${info.pod}  view_url=${info.view_url}  cdp_url=${info.cdp_url}`);

  console.log(`${ts()} STEP 3: browser_request_user_help (set wait_for url_matches="example.org")`);
  const help = await tool("browser_request_user_help", {
    reason: "Test: please navigate to example.org",
    wait_for: { url_matches: "example.org" },
  });
  console.log(`${ts()}   help_id=${help.help_id}  view_url=${help.view_url}`);

  console.log(`${ts()} STEP 4: SIMULATE user — in 4s, separately drive the browser to example.org via CDP`);
  setTimeout(async () => {
    try {
      const br = await chromium.connectOverCDP(info.cdp_url);
      const page = br.contexts()[0].pages()[0];
      console.log(`${ts()}   [SIM USER] connected to ${page.url()}, navigating to example.org…`);
      await page.goto("https://example.org/", { waitUntil: "domcontentloaded", timeout: 15000 });
      console.log(`${ts()}   [SIM USER] now at ${page.url()}`);
      await br.browser()?.close().catch(() => {});
    } catch (e) {
      console.error(`${ts()}   [SIM USER] FAILED: ${e.message}`);
    }
  }, 4000);

  console.log(`${ts()} STEP 5: browser_wait_for_user_done (deadline 30s) — should detect within ~6-8s`);
  const done = await tool("browser_wait_for_user_done", {
    help_id: help.help_id,
    deadline_seconds: 30,
    poll_interval_ms: 1500,
  });
  console.log(`${ts()}   outcome=${done.outcome}  final_url=${done.final_url}  elapsed_ms=${done.elapsed_ms}`);

  console.log(`${ts()} STEP 6: browser_release`);
  const rel = await tool("browser_release", {});
  console.log(`${ts()}   released=${rel.ok}`);

  console.log(`\n=== RESULT ===`);
  if (done.outcome === "satisfied" && /example\.org/.test(done.final_url)) {
    console.log("✅ offload flow WORKS: agent paused, sim-user navigated, agent resumed on condition match");
  } else {
    console.log(`❌ offload flow FAILED: outcome=${done.outcome}`);
  }
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}
