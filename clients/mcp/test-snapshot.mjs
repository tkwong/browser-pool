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
await call("initialize", { protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"t",version:"0"} });
await call("tools/call", { name:"browser_navigate", arguments:{ url:"https://example.com" } });
const r = await call("tools/call", { name:"browser_snapshot", arguments:{} });
const body = JSON.parse(r.result.content[0].text);
console.log("URL :", body.url);
console.log("TITLE:", body.title);
console.log("a11y root role:", body.accessibility?.role);
console.log("a11y body children count:", body.accessibility?.children?.length);
console.log("a11y dump (truncated 600 chars):");
console.log(JSON.stringify(body.accessibility, null, 2).slice(0, 600));
await call("tools/call", { name:"browser_release", arguments:{} });
proc.kill("SIGTERM");
setTimeout(()=>process.exit(0), 300);
