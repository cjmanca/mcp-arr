import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

// ---------------------------------------------------------------------------
// Manual-import candidate DISCOVERY operation tests.
//
// Extends the preview-operations harness pattern to the standalone
// *_get_manual_import_candidates tools: the expensive native GET /manualimport
// itself is delayed/hung, so the soft budget, running handle, polling,
// stateless-HTTP survival, active dedup with normalized defaults, action/service
// isolation, request timeout, whole-operation deadline, cancellation, fresh
// re-discovery, expiry, and input validation are exercised end to end.
// Production defaults are never relied on: every test sets small
// PREVIEW_SYNC_BUDGET_MS / PREVIEW_MAX_RUNTIME_MS / *_API_TIMEOUT_MS /
// OPERATION_RESULT_TTL_MS values via the child's environment.
// ---------------------------------------------------------------------------

const QUALITY = { quality: { id: 9, name: "FLAC", source: "lossless", resolution: 0 }, revision: { version: 0, real: 0 } };
const VIDEO_QUALITY = { quality: { id: 9, name: "WEBDL-1080p", source: "web", resolution: 1080 }, revision: { version: 1, real: 0 } };

const LIDARR_DOWNLOAD_ID = "dl-5";
const LIDARR_CANDIDATE = {
  id: 5,
  path: "/downloads/complete/Artist/Album/01 - Track.flac",
  name: "01 - Track",
  size: 1000,
  artist: { id: 1, artistName: "Artist" },
  album: { id: 2, title: "Album" },
  albumReleaseId: 3,
  tracks: [{ id: 10, title: "Track", trackNumber: 1, position: 1, mediumNumber: 1 }],
  quality: QUALITY,
  releaseGroup: "RG",
  qualityWeight: 10,
  downloadId: LIDARR_DOWNLOAD_ID,
  indexerFlags: 0,
  rejections: [],
};
function lidarrUpdate(items) {
  return items.map((it) => ({
    id: it.id,
    path: it.path,
    name: it.name,
    artist: { id: 1, artistName: "Artist" },
    album: { id: 2, title: "Album" },
    albumReleaseId: 3,
    tracks: [{ id: 10, title: "Track", trackNumber: 1, position: 1, mediumNumber: 1 }],
    quality: QUALITY,
    releaseGroup: "RG",
    qualityWeight: 10,
    downloadId: it.downloadId,
    indexerFlags: 0,
    rejections: [],
    additionalFile: false,
    replaceExistingFiles: false,
    disableReleaseSwitching: false,
  }));
}

const SONARR_DOWNLOAD_ID = "abc123";
const SONARR_CANDIDATE = {
  id: 123,
  path: "/downloads/complete/S/S.S01E01.mkv",
  relativePath: "S.S01E01.mkv",
  folderName: "S.S01",
  name: "S.S01E01",
  size: 100,
  series: { id: 47, title: "Series" },
  seasonNumber: 1,
  episodes: [{ id: 9001, seriesId: 47, seasonNumber: 1, episodeNumber: 1, title: "Pilot" }],
  episodeFileId: null,
  releaseGroup: "NTb",
  quality: VIDEO_QUALITY,
  languages: [{ id: 3, name: "English" }],
  qualityWeight: 60,
  downloadId: SONARR_DOWNLOAD_ID,
  customFormats: [],
  customFormatScore: 0,
  indexerFlags: 0,
  releaseType: "episode",
  rejections: [],
};

const RADARR_DOWNLOAD_ID = "dl-11";
const RADARR_CANDIDATE = {
  id: 222,
  path: "/downloads/complete/M/M.2026.mkv",
  relativePath: "M.2026.mkv",
  folderName: "M.2026",
  name: "M.2026",
  size: 100,
  movie: { id: 11, title: "Movie", year: 2026 },
  movieFileId: null,
  releaseGroup: "SM",
  quality: VIDEO_QUALITY,
  languages: [{ id: 3, name: "English" }],
  qualityWeight: 60,
  downloadId: RADARR_DOWNLOAD_ID,
  customFormats: [],
  customFormatScore: 0,
  indexerFlags: 0,
  rejections: [],
};

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// A stub *arr app. Routes may return { json, status } and optionally
// { delayMs } (respond after a delay) or { hang: true } (never respond until
// the client aborts, recording the abort).
function startStub(routes) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry = {
      method: req.method,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      body: raw ? safeJson(raw) : null,
      aborted: false,
    };
    requests.push(entry);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unrouted ${req.method} ${url.pathname}` }));
      return;
    }
    const result = route(entry);
    if (result.hang) {
      await new Promise((resolve) => {
        req.on("aborted", () => { entry.aborted = true; resolve(); });
        req.on("close", () => { entry.aborted = true; resolve(); });
      });
      return;
    }
    if (result.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    }
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.json ?? {}));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

// Discovery GETs are the workload under test: delay/hang them directly.
function lidarrRoutes(opts = {}) {
  return {
    "GET /api/v1/manualimport": () => ({
      json: opts.lidarrEmpty ? [] : [LIDARR_CANDIDATE],
      delayMs: opts.lidarrDiscoveryDelay,
      hang: opts.lidarrDiscoveryHang,
    }),
    "POST /api/v1/manualimport": (e) => ({ json: lidarrUpdate(e.body), delayMs: opts.lidarrUpdateDelay }),
    "GET /api/v1/track": () => ({ json: [{ id: 10, albumReleaseId: 3, title: "Track", trackNumber: 1 }] }),
  };
}

function sonarrRoutes(opts = {}) {
  return {
    "GET /api/v3/manualimport": () => ({
      json: opts.sonarrEmpty ? [] : [SONARR_CANDIDATE],
      delayMs: opts.sonarrDiscoveryDelay,
      hang: opts.sonarrDiscoveryHang,
    }),
    "GET /api/v3/episode": () => ({ json: [{ id: 9001, seriesId: 47, seasonNumber: 1, episodeNumber: 1, title: "Pilot", hasFile: false, episodeFileId: null }] }),
    "GET /api/v3/episodefile": () => ({ json: [] }),
    "GET /api/v3/queue": () => ({ json: { records: [], totalRecords: 0 } }),
    "GET /api/v3/series/47": () => ({ json: { id: 47, title: "Series", qualityProfileId: 1 } }),
    "GET /api/v3/qualityprofile": () => ({ json: [{ id: 1, name: "HD", formatItems: [] }] }),
  };
}

function radarrRoutes(opts = {}) {
  return {
    "GET /api/v3/manualimport": () => ({
      json: opts.radarrEmpty ? [] : [RADARR_CANDIDATE],
      delayMs: opts.radarrDiscoveryDelay,
      hang: opts.radarrDiscoveryHang,
    }),
    "GET /api/v3/movie/11": () => ({ json: { id: 11, title: "Movie", year: 2026 } }),
  };
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not become healthy: ${lastError}`);
}

function postMcp(port, payload) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
}

async function mcpEnvelope(response) {
  const text = await response.text();
  if (/^text\/event-stream/.test(response.headers.get("content-type") || "")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine, `SSE response missing data line: ${text}`);
    return JSON.parse(dataLine.slice("data: ".length));
  }
  return JSON.parse(text);
}

async function callTool(port, name, args) {
  const response = await postMcp(port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.status, 200);
  const body = await mcpEnvelope(response);
  assert.equal(body.error, undefined, `tools/call ${name} must not return a JSON-RPC error: ${JSON.stringify(body.error)}`);
  const text = body.result.content[0].text;
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* error strings are not JSON */
  }
  return { isError: body.result.isError === true, payload, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServers(env, opts, fn) {
  // Distinct port band from preview-operations.test.mjs (35000+): both suites
  // spawn many servers in parallel under `node --test`, and a collision would
  // make one suite's health check attach to the other suite's server.
  const port = String(37000 + Math.floor(Math.random() * 1000));
  const lidarrStub = await startStub(lidarrRoutes(opts));
  const sonarrStub = await startStub(sonarrRoutes(opts));
  const radarrStub = await startStub(radarrRoutes(opts));

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
      SONARR_URL: sonarrStub.base,
      SONARR_API_KEY: "sonarr-key",
      RADARR_URL: radarrStub.base,
      RADARR_API_KEY: "radarr-key",
      LIDARR_URL: lidarrStub.base,
      LIDARR_API_KEY: "lidarr-key",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHealth(port);
    const initResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-arr-test", version: "0.0.0" } },
    });
    assert.equal(initResponse.status, 200);
    await fn(port, { lidarr: lidarrStub.requests, sonarr: sonarrStub.requests, radarr: radarrStub.requests });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    lidarrStub.server.close();
    sonarrStub.server.close();
    radarrStub.server.close();
  }
}

function requestsTo(log, method, path) {
  return log.filter((r) => r.method === method && r.path === path);
}

const DISCOVERY_CASES = [
  {
    service: "lidarr",
    tool: "lidarr_get_manual_import_candidates",
    kind: "lidarr-manual-import-discovery",
    args: { downloadId: LIDARR_DOWNLOAD_ID },
    log: (logs) => logs.lidarr,
    candidateId: 5,
    verify: (result) => {
      assert.ok(result.existingFilesPolicy, "Lidarr policy fields preserved");
      assert.ok(result.candidateFilterPolicy, "Lidarr candidate filter policy preserved");
    },
  },
  {
    service: "sonarr",
    tool: "sonarr_get_manual_import_candidates",
    kind: "sonarr-manual-import-discovery",
    args: { downloadId: SONARR_DOWNLOAD_ID },
    log: (logs) => logs.sonarr,
    candidateId: 123,
  },
  {
    service: "radarr",
    tool: "radarr_get_manual_import_candidates",
    kind: "radarr-manual-import-discovery",
    args: { downloadId: RADARR_DOWNLOAD_ID },
    log: (logs) => logs.radarr,
    candidateId: 222,
  },
];

// --- A. Fast and empty discovery — all three services -----------------------

test("fast discovery returns the existing candidate payload with no operation envelope", async () => {
  await withServers({ PREVIEW_SYNC_BUDGET_MS: "8000" }, {}, async (port) => {
    for (const c of DISCOVERY_CASES) {
      const { payload, isError } = await callTool(port, c.tool, c.args);
      assert.equal(isError, false, `${c.service}: fast discovery succeeds`);
      assert.equal(payload.status, undefined, `${c.service}: no operation status`);
      assert.equal(payload.operationId, undefined, `${c.service}: no operationId`);
      assert.equal(payload.downloadId, c.args.downloadId);
      assert.equal(payload.count, 1);
      assert.equal(payload.candidates.length, 1);
      assert.equal(payload.candidates[0].candidateId, c.candidateId);
      assert.ok(Array.isArray(payload.verifyBeforeActing) && payload.verifyBeforeActing.length > 0);
      assert.ok(Array.isArray(payload.notes) && payload.notes.length > 0);
      if (c.verify) c.verify(payload);
    }
  });
});

test("an empty native candidate list is a successful discovery (count 0), not a failure", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "8000" },
    { lidarrEmpty: true, sonarrEmpty: true, radarrEmpty: true },
    async (port) => {
      for (const c of DISCOVERY_CASES) {
        const { payload, isError } = await callTool(port, c.tool, c.args);
        assert.equal(isError, false, `${c.service}: empty discovery is a success`);
        assert.equal(payload.status, undefined);
        assert.equal(payload.count, 0);
        assert.deepEqual(payload.candidates, []);
        if (c.verify) c.verify(payload);
      }
    },
  );
});

// --- B. Slow discovery → handle → poll → complete (shared path) -------------

for (const c of DISCOVERY_CASES) {
  test(`slow ${c.service} discovery returns a running handle, then polls to the exact normal payload`, async () => {
    const delayKey = `${c.service}DiscoveryDelay`;
    await withServers(
      { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
      { [delayKey]: 1200 },
      async (port, logs) => {
        const started = Date.now();
        const { payload } = await callTool(port, c.tool, c.args);
        const elapsed = Date.now() - started;
        assert.equal(payload.status, "running", "must return a running handle");
        assert.equal(payload.operation, c.kind, "operation kind is discovery for the correct service");
        assert.equal(payload.stage, "discovering-candidates", "truthful stage while the GET is pending");
        assert.equal(payload.count, undefined, "a running handle must not imply an empty candidate list");
        assert.equal(payload.candidates, undefined, "a running handle carries no candidates");
        assert.ok(payload.pollAfterMs, "pollAfterMs present");
        assert.ok(elapsed < 1000, `handle returned before the 1200ms native delay (${elapsed}ms)`);

        const running = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
        assert.equal(running.payload.status, "running", "polling while the GET is pending reports running");

        await sleep(1300);
        const done = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
        assert.equal(done.payload.status, "completed");
        const result = done.payload.result;
        assert.equal(result.status, undefined, "completed result is the discovery payload itself, not a double envelope");
        assert.equal(result.operationId, undefined, "no nested operation envelope");
        assert.equal(result.downloadId, c.args.downloadId);
        assert.equal(result.count, 1);
        assert.equal(result.candidates[0].candidateId, c.candidateId);
        assert.ok(result.verifyBeforeActing, "verify directive preserved in the completed result");
        if (c.verify) c.verify(result);

        // Standalone discovery is a GET-only workload.
        const log = c.log(logs);
        assert.equal(requestsTo(log, "POST", "/manualimport").length + requestsTo(log, "POST", "/api/v1/manualimport").length + requestsTo(log, "POST", "/api/v3/manualimport").length, 0, "discovery sent no POST /manualimport");
        assert.equal(requestsTo(log, "POST", "/api/v1/command").length + requestsTo(log, "POST", "/api/v3/command").length, 0, "discovery sent no POST /command");
        assert.equal(log.filter((r) => r.method === "DELETE").length, 0, "discovery sent no DELETE");
      },
    );
  });
}

// --- C. Stateless HTTP survival ---------------------------------------------

test("a discovery handle survives the per-request teardown and completes on a later request", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrDiscoveryDelay: 1500 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(payload.status, "running");
      // The discovery request has fully returned (its request-scoped Server +
      // transport are closed). Poll from a brand-new request.
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "running", "discovery outlived the request that started it");
      await sleep(1600);
      const done = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(done.payload.status, "completed");
      assert.equal(done.payload.result.count, 1);
    },
  );
});

// --- D. Active discovery dedup and normalized defaults (Lidarr) -------------

const DEDUP_TABLE = [
  {
    name: "omitted filterExistingFiles deduplicates against explicit true",
    first: {},
    second: { filterExistingFiles: true },
    same: true,
  },
  {
    name: "filterExistingFiles=false is a distinct discovery",
    first: {},
    second: { filterExistingFiles: false },
    same: false,
  },
  {
    name: "omitted replaceExistingFiles deduplicates against explicit false",
    first: {},
    second: { replaceExistingFiles: false },
    same: true,
  },
  {
    name: "replaceExistingFiles=true is a distinct discovery",
    first: {},
    second: { replaceExistingFiles: true },
    same: false,
  },
];

for (const t of DEDUP_TABLE) {
  test(`lidarr discovery dedup: ${t.name}`, async () => {
    await withServers(
      { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
      { lidarrDiscoveryDelay: 1500 },
      async (port, logs) => {
        const first = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID, ...t.first });
        assert.equal(first.payload.status, "running");
        const second = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID, ...t.second });
        assert.equal(second.payload.status, "running");
        const gets = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length;
        if (t.same) {
          assert.equal(second.payload.operationId, first.payload.operationId, "semantically identical discovery shares the operationId");
          assert.equal(second.payload.deduplicated, true, "deduplicated flag set");
          assert.equal(gets, 1, "only one native discovery GET ran");
        } else {
          assert.notEqual(second.payload.operationId, first.payload.operationId, "distinct policy starts a new operation");
          assert.notEqual(second.payload.deduplicated, true, "distinct policy does not deduplicate");
          assert.equal(gets, 2, "the distinct discovery ran its own native GET");
        }
      },
    );
  });
}

// --- E. Discovery/preview and service isolation -----------------------------

test("discovery and preview for the same download are separate operations; cancelling discovery does not cancel the preview", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrDiscoveryDelay: 1500, lidarrUpdateDelay: 300 },
    async (port) => {
      const discovery = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(discovery.payload.status, "running");
      assert.equal(discovery.payload.operation, "lidarr-manual-import-discovery");

      const preview = await callTool(port, "lidarr_preview_manual_import", { downloadId: LIDARR_DOWNLOAD_ID, items: [{ candidateId: 5 }] });
      assert.equal(preview.payload.status, "running");
      assert.equal(preview.payload.operation, "lidarr-manual-import-preview");
      assert.notEqual(preview.payload.operationId, discovery.payload.operationId, "discovery and preview never share an operationId");

      const cancelled = await callTool(port, "arr_cancel_operation", { operationId: discovery.payload.operationId });
      assert.equal(cancelled.payload.status, "cancelled");

      await sleep(1700);
      const pollDiscovery = await callTool(port, "arr_get_operation", { operationId: discovery.payload.operationId });
      assert.equal(pollDiscovery.payload.status, "cancelled", "cancelling discovery does not touch the preview");
      const pollPreview = await callTool(port, "arr_get_operation", { operationId: preview.payload.operationId });
      assert.equal(pollPreview.payload.status, "completed", "the preview completed independently of the cancelled discovery");
      assert.ok(Array.isArray(pollPreview.payload.result.items), "preview result is a preview result");
      assert.equal(pollPreview.payload.result.candidates, undefined, "preview never receives the discovery payload");
      assert.equal(pollDiscovery.payload.result, undefined, "cancelled discovery has no result");
    },
  );
});

test("discovery fingerprints are service-scoped: the same downloadId on two services never collides", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrDiscoveryDelay: 1500, sonarrDiscoveryDelay: 1500 },
    async (port) => {
      const lidarr = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: "shared-dl" });
      const sonarr = await callTool(port, "sonarr_get_manual_import_candidates", { downloadId: "shared-dl" });
      assert.equal(lidarr.payload.status, "running");
      assert.equal(sonarr.payload.status, "running");
      assert.notEqual(lidarr.payload.operationId, sonarr.payload.operationId, "different services cannot collide on a fingerprint");
      assert.equal(lidarr.payload.operation, "lidarr-manual-import-discovery");
      assert.equal(sonarr.payload.operation, "sonarr-manual-import-discovery");
    },
  );
});

// --- F. Discovery request timeout -------------------------------------------

test("a hung discovery GET fails with the request timeout — no empty success, no retry", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "20000",
      MANUAL_IMPORT_API_TIMEOUT_MS: "250",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrDiscoveryHang: true },
    async (port, logs) => {
      const { payload } = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(payload.status, "running");
      await sleep(600);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "failed", "per-request timeout surfaces as a failed operation");
      assert.match(poll.payload.error, /timed out/, "error identifies the request timeout");
      assert.equal(poll.payload.result, undefined, "a timeout never becomes an empty successful discovery");
      assert.equal(requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length, 1, "no automatic retry");
    },
  );
});

// --- G. Whole-operation deadline and cancellation ---------------------------

test("a discovery exceeding the operation deadline is timed_out and stays timed_out after the native response lands", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "400",
      MANUAL_IMPORT_API_TIMEOUT_MS: "20000",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrDiscoveryDelay: 2000 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(payload.status, "running");
      await sleep(480);
      const first = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(first.payload.status, "timed_out", "deadline terminalizes without the native request finishing");
      assert.equal(first.payload.stage, "discovering-candidates", "stage retained on timeout");
      assert.match(first.payload.error, /exceeded the configured operation timeout/);
      assert.ok(first.payload.elapsedMs >= 380 && first.payload.elapsedMs <= 700, `elapsedMs reflects the deadline, got ${first.payload.elapsedMs}`);
      // Release the delayed native result, then poll again.
      await sleep(1700);
      const second = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(second.payload.status, "timed_out", "a delayed native result cannot overwrite the terminal status");
    },
  );
});

test("arr_cancel_operation cancels a running discovery and it stays cancelled", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrDiscoveryHang: true },
    async (port, logs) => {
      const { payload } = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(payload.status, "running");
      const cancelled = await callTool(port, "arr_cancel_operation", { operationId: payload.operationId });
      assert.equal(cancelled.payload.status, "cancelled");
      await sleep(300);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "cancelled", "a cancelled discovery stays cancelled");
      assert.equal(requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length, 1, "the in-flight request settled (no forever-pending)");
    },
  );
});

// --- H. Fresh calls and expiry ----------------------------------------------

test("a fresh discovery after a completed one re-runs the native GET (no result cache)", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "8000", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    {},
    async (port, logs) => {
      const first = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(first.payload.count, 1);
      assert.equal(requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length, 1);
      const second = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(second.payload.count, 1);
      assert.equal(requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length, 2, "the completed discovery payload is not reused as a cache");
    },
  );
});

test("an expired discovery handle reports expired-or-unknown", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "100", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "1000" },
    { lidarrDiscoveryDelay: 600 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
      assert.equal(payload.status, "running");
      await sleep(700);
      const completed = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(completed.payload.status, "completed", "result is retrievable before expiry");
      await sleep(1200);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "expired-or-unknown", "terminal result expired past its TTL");
      assert.match(poll.payload.guidance, /discovery/, "expired guidance covers discovery, not only preview");
    },
  );
});

// --- I. Invalid discovery input (soft budget zero) --------------------------

const INVALID_CASES = [
  { name: "missing downloadId", service: "lidarr", args: {} },
  { name: "empty downloadId", service: "lidarr", args: { downloadId: "   " } },
  { name: "non-string downloadId", service: "sonarr", args: { downloadId: 123 } },
  { name: "seriesId 0", service: "sonarr", args: { downloadId: SONARR_DOWNLOAD_ID, seriesId: 0 } },
  { name: "negative seasonNumber", service: "sonarr", args: { downloadId: SONARR_DOWNLOAD_ID, seasonNumber: -1 } },
  { name: "fractional seasonNumber", service: "sonarr", args: { downloadId: SONARR_DOWNLOAD_ID, seasonNumber: 1.5 } },
  { name: "movieId 0", service: "radarr", args: { downloadId: RADARR_DOWNLOAD_ID, movieId: 0 } },
  { name: "artistId 0", service: "lidarr", args: { downloadId: LIDARR_DOWNLOAD_ID, artistId: 0 } },
];

test("malformed discovery input fails immediately with zero native requests, even at a zero soft budget", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "0", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    {},
    async (port, logs) => {
      for (const c of INVALID_CASES) {
        const tool = `${c.service}_get_manual_import_candidates`;
        const { payload, isError, text } = await callTool(port, tool, c.args);
        assert.equal(isError, true, `${c.name}: must be a tool error`);
        assert.notEqual(payload?.status, "running", `${c.name}: no running handle for an invalid request`);
        assert.equal(payload?.operationId, undefined, `${c.name}: no operation created`);
        assert.match(text, /required|positive integer|non-negative integer/, `${c.name}: existing error style retained`);
      }
      for (const log of [logs.lidarr, logs.sonarr, logs.radarr]) {
        assert.equal(requestsTo(log, "GET", "/api/v1/manualimport").length, 0);
        assert.equal(requestsTo(log, "GET", "/api/v3/manualimport").length, 0);
      }
    },
  );
});

test("valid hints (positive ids, Sonarr season 0) are accepted and start a discovery operation at a zero budget", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "0", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { sonarrDiscoveryDelay: 1000 },
    async (port, logs) => {
      const s = await callTool(port, "sonarr_get_manual_import_candidates", { downloadId: SONARR_DOWNLOAD_ID, seriesId: 47, seasonNumber: 0 });
      assert.equal(s.payload.status, "running", "season 0 is a valid hint, not a validation failure");
      assert.equal(s.payload.operation, "sonarr-manual-import-discovery");
      const r = await callTool(port, "radarr_get_manual_import_candidates", { downloadId: RADARR_DOWNLOAD_ID, movieId: 11 });
      assert.equal(r.payload.status, "running");
      const l = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID, artistId: 1 });
      assert.equal(l.payload.status, "running");
      const sonarrGet = requestsTo(logs.sonarr, "GET", "/api/v3/manualimport")[0];
      assert.equal(sonarrGet.params.seasonNumber, "0", "season 0 is forwarded to the native request and fingerprinted");
    },
  );
});

// --- J. Internal discovery stays awaited (no nested operations) -------------

test("preview awaits its internal discovery and returns a preview result, never a nested discovery handle", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "8000", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    {},
    async (port, logs) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", { downloadId: LIDARR_DOWNLOAD_ID, items: [{ candidateId: 5 }] });
      assert.equal(payload.operationId, undefined, "fast preview returns the normal preview shape");
      assert.equal(payload.status, undefined);
      assert.ok(Array.isArray(payload.items), "preview items present — internal discovery was awaited inline");
      assert.equal(payload.candidates, undefined, "no discovery payload leaked into the preview result");
      assert.equal(requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length, 1, "preview ran its own internal discovery GET");
      assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/manualimport").length, 1, "preview reprocessed inside the same operation");
    },
  );
});

// --- K. Tool registration and descriptions ----------------------------------

test("poll/cancel tools are registered and their descriptions cover discovery as well as preview", async () => {
  await withServers({ PREVIEW_SYNC_BUDGET_MS: "8000" }, {}, async (port) => {
    const response = await postMcp(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(response.status, 200);
    const body = await mcpEnvelope(response);
    const byName = new Map(body.result.tools.map((t) => [t.name, t]));

    for (const name of ["arr_get_operation", "arr_cancel_operation"]) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} must remain registered`);
      assert.match(tool.description, /discovery/i, `${name} description covers discovery`);
      assert.match(tool.description, /preview/i, `${name} description covers preview`);
      const idDesc = tool.inputSchema.properties.operationId.description;
      assert.match(idDesc, /_get_manual_import_candidates/, `${name} operationId mentions discovery handles`);
    }

    for (const c of DISCOVERY_CASES) {
      const tool = byName.get(c.tool);
      assert.ok(tool, `${c.tool} registered`);
      assert.match(tool.description, /running operationId handle/, `${c.tool} describes the running handle`);
      assert.match(tool.description, /arr_get_operation/, `${c.tool} tells callers how to poll`);
    }
  });
});
