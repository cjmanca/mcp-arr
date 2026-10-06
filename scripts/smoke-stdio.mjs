import { spawn} from "node:child_process";
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const child = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, ...env, MCP_TRANSPORT: "stdio", PREVIEW_SYNC_BUDGET_MS: process.env.PREVIEW_SYNC_BUDGET_MS || "8000" },
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));

function send(method, params, id) {
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify(payload) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } }, 1);
console.log("initialize:", init.result.serverInfo.name, init.result.serverInfo.version);
notify("notifications/initialized", {});
const tools = await send("tools/list", {}, 2);
const names = tools.result.tools.map((t) => t.name);
console.log("tools/list count:", names.length);
for (const n of ["arr_get_operation", "arr_cancel_operation", "lidarr_get_manual_import_candidates", "sonarr_get_manual_import_candidates", "radarr_get_manual_import_candidates"]) {
  console.log(`registered ${n}:`, names.includes(n));
}
const status = await send("tools/call", { name: "arr_status", arguments: {} }, 3);
console.log("arr_status ok:", !status.result.isError);
child.kill("SIGTERM");
process.exit(0);
