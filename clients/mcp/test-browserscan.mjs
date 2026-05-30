import { spawn } from "node:child_process";
const proc = spawn("node", ["index.mjs"], { stdio: ["pipe","pipe","inherit"] });
let buf = ""; const wait = new Map(); let nid = 1;
proc.stdout.on("data", d => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const ln = buf.slice(0,i).trim(); buf = buf.slice(i+1);
    if (!ln) continue;
    try { const m = JSON.parse(ln); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } } catch {}
  }
});
const call = (method, params) => new Promise(r => {
  const id = nid++; wait.set(id, r);
  proc.stdin.write(JSON.stringify({jsonrpc:"2.0", id, method, params}) + "\n");
});
const tool = async (n, a) => {
  const r = await call("tools/call", { name: n, arguments: a || {} });
  return JSON.parse(r.result.content[0].text);
};

await call("initialize", { protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"t",version:"0"} });

console.log("\n=== STEP 1: browser_navigate to browserscan.net/browser-checker ===");
const nav = await tool("browser_navigate", { url: "https://browserscan.net/browser-checker", wait_until: "networkidle", timeout_ms: 60000 });
console.log(JSON.stringify(nav, null, 2));

// give the page's JS time to run the fingerprint detection
console.log("\n=== waiting 10s for the fingerprint JS to finish ===");
await new Promise(r => setTimeout(r, 10000));

console.log("\n=== STEP 2: browser_snapshot (a11y tree, looking for fingerprint results) ===");
const snap = await tool("browser_snapshot", {});
console.log("URL :", snap.url);
console.log("TITLE:", snap.title);
// dump first 2500 chars of accessibility tree
const txt = JSON.stringify(snap.accessibility, null, 2);
console.log("--- a11y tree (first 2500 chars) ---");
console.log(txt.slice(0, 2500));
console.log("--- total tree size:", txt.length, "chars ---");

console.log("\n=== STEP 3: browser_get_view_url (open this to SEE the live page) ===");
const view = await tool("browser_get_view_url", {});
console.log(JSON.stringify(view, null, 2));

console.log("\n=== session_info ===");
const info = await tool("browser_get_session_info", {});
console.log(JSON.stringify(info, null, 2));

console.log("\n🎯 Open this in your Mac browser to SEE the live page:");
console.log("   " + view.view_url);
console.log("\n(MCP stays alive until you tell me to release. Pool will auto-release after 5 min idle.)");

// keep MCP alive in background (don't kill — let user open viewer)
// detach: write the lease id to file so we can release later
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/browser-pool-test.lease", info.lease_id);
console.log("\n(lease id saved to /tmp/browser-pool-test.lease for later release)");
process.exit(0);  // killing MCP subprocess will also trigger release via SIGTERM trap
