// Non-destructive live Lidarr preview validation for the manual-import
// hierarchy fixes. Boots the freshly built server against the real Lidarr
// from .env.local and runs PREVIEW ONLY (never execute — preview never
// imports, moves, or copies files).
//
// Usage: node scripts/live-lidarr-preview.mjs <downloadId> [previewJsonArgs...]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const PORT = process.env.__SMOKE_PORT || "39880";

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, ...env, MCP_TRANSPORT: "http", HOST: "127.0.0.1", PORT },
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

const downloadId = process.argv[2];
const previews = process.argv.slice(3).map((s) => JSON.parse(s));

try {
  if (!(await waitForHealth())) { console.log("server failed to start:", stderr); process.exit(1); }
  await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-validation", version: "0" } } }),
  });

  const disc = await callTool("lidarr_get_manual_import_candidates", { downloadId });
  if (disc.isError) { console.log("discovery failed:", disc.text); process.exit(1); }
  const cands = disc.payload.candidates ?? [];
  console.log(`=== candidates (${cands.length}) ===`);
  for (const c of cands) {
    console.log(JSON.stringify({
      candidateId: c.candidateId, name: c.name,
      artist: c.artist, album: c.album, albumReleaseId: c.albumReleaseId,
      tracks: (c.tracks ?? []).map((t) => t.id),
      rejections: c.rejections,
    }));
  }

  for (const p of previews) {
    console.log(`\n=== preview ${JSON.stringify(p)} ===`);
    const r = await callTool("lidarr_preview_manual_import", { downloadId, items: [p] });
    const item = r.payload?.items?.[0];
    console.log(JSON.stringify({
      isError: r.isError,
      artist: item?.artist, album: item?.album, albumReleaseId: item?.albumReleaseId,
      tracks: item?.tracks?.map((t) => t.id), tracksSource: item?.tracksSource,
      releaseTrackMismatch: item?.releaseTrackMismatch,
      mappingOverridesApplied: item?.mappingOverridesApplied,
      dependencyProblems: item?.dependencyProblems,
      relationshipValidation: item?.relationshipValidation,
      mappingValid: item?.mappingValid,
      rejections: item?.rejections,
    }, null, 1));
    if (r.isError) console.log("error text:", r.text.slice(0, 400));
  }
} finally {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});
}
