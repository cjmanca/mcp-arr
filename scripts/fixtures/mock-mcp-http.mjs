// Mock HTTP MCP server for validation-script regressions. Implements the
// stateless /health + /mcp endpoints the live discovery script talks to, with
// scenarios driven by env:
//   MOCK_HTTP_SCENARIO  complete | zero | watchdog | failed | bad-handle | crash
//   MOCK_OP_MS          operation hardTimeoutAt horizon (default 5000)
//   MOCK_POLL_MS        advertised pollAfterMs (default 10)
//   MOCK_RUNNING_POLLS  running polls before completion (default 70)
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || "39885");
const SCENARIO = process.env.MOCK_HTTP_SCENARIO || "complete";
const OP_MS = Number(process.env.MOCK_OP_MS || "5000");
const POLL_MS = Number(process.env.MOCK_POLL_MS || "10");
const RUNNING_POLLS = Number(process.env.MOCK_RUNNING_POLLS || "70");

if (SCENARIO === "crash") process.exit(7);

let polls = 0;
let requestedDownloadId = null;

function envelope(id, payload) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const msg = JSON.parse(raw);
  const reply = (obj) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (msg.method === "initialize") {
    return reply({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-http", version: "0.0.0-mock" } },
    });
  }
  if (msg.method === "tools/list") {
    return reply({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: ["lidarr_get_manual_import_candidates", "arr_get_operation"].map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: "object", properties: {} } })) },
    });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "lidarr_get_manual_import_candidates") {
      requestedDownloadId = args.downloadId;
      const handle = {
        status: "running",
        operationId: "op-1",
        operation: "lidarr-manual-import-discovery",
        stage: "discovering-candidates",
        startedAt: new Date().toISOString(),
        hardTimeoutAt: SCENARIO === "bad-handle" ? undefined : new Date(Date.now() + OP_MS).toISOString(),
        elapsedMs: 1,
        pollAfterMs: POLL_MS,
        guidance: "mock handle",
      };
      return reply(envelope(msg.id, handle));
    }
    if (name === "arr_get_operation") {
      polls += 1;
      if (SCENARIO === "watchdog") {
        return reply(envelope(msg.id, {
          operationId: "op-1",
          status: "running",
          operation: "lidarr-manual-import-discovery",
          stage: "discovering-candidates",
          elapsedMs: polls * POLL_MS,
          pollAfterMs: POLL_MS,
        }));
      }
      if (SCENARIO === "failed") {
        return reply(envelope(msg.id, {
          operationId: "op-1",
          status: "failed",
          operation: "lidarr-manual-import-discovery",
          error: "mock request timed out",
        }));
      }
      if (polls > RUNNING_POLLS) {
        const count = SCENARIO === "zero" ? 0 : 1;
        return reply(envelope(msg.id, {
          operationId: "op-1",
          status: "completed",
          operation: "lidarr-manual-import-discovery",
          result: {
            verifyBeforeActing: ["mock verify directive"],
            downloadId: requestedDownloadId,
            existingFilesPolicy: { replaceExistingFiles: false, lidarrUiMode: "Combine with existing files", albumWidePreDelete: false },
            candidateFilterPolicy: { filterExistingFiles: true, lidarrUiMode: "Unmapped Files Only" },
            count,
            candidates: count === 0 ? [] : [{
              candidateId: 5,
              path: "/downloads/complete/Artist/Album/01 - Track.flac",
              name: "01 - Track",
              artist: { id: 1, artistName: "Artist" },
              album: { id: 2, title: "Album" },
              albumReleaseId: 3,
              tracks: [{ id: 10, title: "Track", trackNumber: 1 }],
              rejections: [],
            }],
            notes: ["mock note"],
          },
        }));
      }
      return reply(envelope(msg.id, {
        operationId: "op-1",
        status: "running",
        operation: "lidarr-manual-import-discovery",
        stage: "discovering-candidates",
        elapsedMs: polls * POLL_MS,
        pollAfterMs: POLL_MS,
      }));
    }
  }
  return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `mock: unsupported ${msg.method}` } });
});

server.listen(PORT, "127.0.0.1");
