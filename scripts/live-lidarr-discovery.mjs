// Non-destructive LIVE validation for async manual-import candidate discovery.
// Boots the freshly built server against the real Lidarr from .env.local and
// runs DISCOVERY ONLY (a read-only GET /manualimport — never preview, never
// execute). PREVIEW_SYNC_BUDGET_MS=0 forces the async handle path so the
// handle → poll → completed-result flow is exercised against the live app.
//
// Usage: node scripts/live-lidarr-discovery.mjs <downloadId>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const PORT = process.env.__SMOKE_PORT || "39881";
const downloadId = process.argv[2];
if (!downloadId) {
  console.log("usage: node scripts/live-lidarr-discovery.mjs <downloadId>");
  process.exit(1);
}

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    ...env,
    MCP_TRANSPORT: "http",
    HOST: "127.0.0.1",
    PORT,
    PREVIEW_SYNC_BUDGET_MS: "0",
    PREVIEW_MAX_RUNTIME_MS: "300000",
    OPERATION_POLL_INTERVAL_MS: "2000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

async function callTool(name, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(dataLine ? dataLine.slice(6) : text);
  const t = body.result.content[0].text;
  let payload = null;
  try { payload = JSON.parse(t); } catch {}
  return { isError: body.result.isError === true, payload, text };
}

try {
  if (!(await waitForHealth())) { console.log("server failed to start:", stderr); process.exit(1); }
  await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-validation", version: "0" } } }),
  });

  const started = Date.now();
  const disc = await callTool("lidarr_get_manual_import_candidates", { downloadId });
  if (disc.isError) { console.log("discovery failed:", disc.text); process.exit(1); }
  console.log(`=== discovery response (${Date.now() - started}ms) ===`);
  console.log(JSON.stringify({
    status: disc.payload.status,
    operation: disc.payload.operation,
    operationId: disc.payload.operationId,
    stage: disc.payload.stage,
    pollAfterMs: disc.payload.pollAfterMs,
    countInHandle: disc.payload.count ?? null,
  }, null, 1));
  if (disc.payload.status !== "running") {
    console.log("expected a running handle at budget 0; got the fast path:", disc.payload.count, "candidates");
    process.exit(1);
  }

  const id = disc.payload.operationId;
  let poll = null;
  for (let i = 0; i < 60; i++) {
    await sleep(disc.payload.pollAfterMs || 2000);
    poll = await callTool("arr_get_operation", { operationId: id });
    console.log(`poll ${i + 1} (${Date.now() - started}ms): ${poll.payload.status}${poll.payload.stage ? ` [${poll.payload.stage}]` : ""}`);
    if (poll.payload.status !== "running") break;
  }
  if (poll.payload.status !== "completed") {
    console.log("terminal status:", poll.payload.status, poll.payload.error ?? "");
    process.exit(1);
  }
  const result = poll.payload.result;
  console.log(`=== completed result (${Date.now() - started}ms total) ===`);
  console.log(JSON.stringify({
    downloadId: result.downloadId,
    count: result.count,
    existingFilesPolicy: result.existingFilesPolicy,
    candidateFilterPolicy: result.candidateFilterPolicy,
    hasVerifyDirective: Array.isArray(result.verifyBeforeActing),
    notes: result.notes?.length,
  }, null, 1));
  for (const c of (result.candidates ?? []).slice(0, 5)) {
    console.log(JSON.stringify({
      candidateId: c.candidateId, name: c.name,
      artist: c.artist, album: c.album, albumReleaseId: c.albumReleaseId,
      rejections: c.rejections,
    }));
  }
  console.log(`(showing ${Math.min(5, result.count)} of ${result.count} candidates)`);
} finally {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});
}
