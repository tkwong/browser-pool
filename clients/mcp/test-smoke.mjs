#!/usr/bin/env node
/**
 * End-to-end MCP smoke test: spawn the MCP, run the tool sequence an agent
 * would actually call, prove lazy-acquire + drive + release works.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MCP_PATH = join(dirname(fileURLToPath(import.meta.url)), "index.mjs");

function startMCP() {
  const proc = spawn("node", [MCP_PATH], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });
  let buf = "";
  const waiters = new Map(); // id -> resolve
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      } catch {}
    }
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { proc, call };
}

const dump = (label, val) => {
  const s = JSON.stringify(val, null, 2);
  console.log(`\n=== ${label} ===\n${s.length > 800 ? s.slice(0, 800) + "\n…(truncated)" : s}`);
};

const { proc, call } = startMCP();

// 1) initialize
const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test-smoke", version: "0.0.1" },
});
dump("initialize", init.result);

// 2) tools/list — confirm all 18 tools advertised
const tools = await call("tools/list", {});
console.log(`\n=== tools/list ===  count=${tools.result.tools.length}`);
console.log(tools.result.tools.map((t) => "  - " + t.name).join("\n"));

// helper
const tool = async (name, args) =>
  call("tools/call", { name, arguments: args || {} });

// 3) browser_navigate — triggers lazy acquire
console.log("\n→ browser_navigate https://example.com  (lazy-acquires)");
const nav = await tool("browser_navigate", { url: "https://example.com" });
dump("navigate result", nav.result);

// 4) get_session_info — confirm acquired
const info = await tool("browser_get_session_info", {});
dump("session_info", info.result);

// 5) browser_snapshot — a11y tree (truncated)
const snap = await tool("browser_snapshot", {});
dump("snapshot (truncated)", snap.result);

// 6) browser_get_view_url — for user takeover
const view = await tool("browser_get_view_url", {});
dump("view_url", view.result);

// 7) browser_release
const rel = await tool("browser_release", {});
dump("release", rel.result);

// 8) post-release session_info
const after = await tool("browser_get_session_info", {});
dump("session_info after release", after.result);

proc.kill("SIGTERM");
setTimeout(() => process.exit(0), 500);
