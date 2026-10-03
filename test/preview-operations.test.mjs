import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

// ---------------------------------------------------------------------------
// Preview operation registry tests.
//
// Boots the real MCP server (HTTP transport) against a stub Lidarr (and a
// Sonarr/Radarr pair for the shared-path fast case). The stub's manual-import
// endpoints can be configured to delay, hang, or fail, so the soft synchronous
// budget, the async handle, polling, cancellation, deduplication, per-request
// timeouts, the whole-operation deadline, and result expiry are all exercised
// end to end. Production defaults are never relied on: every test sets small
// PREVIEW_SYNC_BUDGET_MS / PREVIEW_MAX_RUNTIME_MS / *_API_TIMEOUT_MS /
// OPERATION_RESULT_TTL_MS values via the child's environment.
// ---------------------------------------------------------------------------

const LIDARR_DOWNLOAD_ID = "dl-5";
const QUALITY = { quality: { id: 9, name: "FLAC", source: "lossless", resolution: 0 }, revision: { version: 0, real: 0 } };

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
const SONARR_QUALITY = { quality: { id: 9, name: "WEBDL-1080p", source: "web", resolution: 1080 }, revision: { version: 1, real: 0 } };
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
  quality: SONARR_QUALITY,
  languages: [{ id: 3, name: "English" }],
  qualityWeight: 60,
  downloadId: SONARR_DOWNLOAD_ID,
  customFormats: [],
  customFormatScore: 0,
  indexerFlags: 0,
  releaseType: "episode",
  rejections: [],
};
function sonarrReprocess(items) {
  return items.map((it) => ({
    ...SONARR_CANDIDATE,
    id: it.id,
    seriesId: 47,
    seasonNumber: 1,
    episodes: [{ id: 9001, seriesId: 47, seasonNumber: 1, episodeNumber: 1, title: "Pilot" }],
    downloadId: it.downloadId,
  }));
}

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
  quality: SONARR_QUALITY,
  languages: [{ id: 3, name: "English" }],
  qualityWeight: 60,
  downloadId: RADARR_DOWNLOAD_ID,
  customFormats: [],
  customFormatScore: 0,
  indexerFlags: 0,
  rejections: [],
};
function radarrReprocess(items) {
  return items.map((it) => ({ ...RADARR_CANDIDATE, id: it.id, downloadId: it.downloadId }));
}

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

function lidarrRoutes(opts = {}) {
  return {
    "GET /api/v1/manualimport": () => ({ json: [LIDARR_CANDIDATE], delayMs: opts.lidarrDiscoveryDelay }),
    "POST /api/v1/manualimport": (e) => ({
      json: lidarrUpdate(e.body),
      delayMs: opts.lidarrUpdateDelay,
      hang: opts.lidarrUpdateHang,
      status: opts.lidarrUpdateStatus,
    }),
    "GET /api/v1/album/2": () => ({
      json: { id: 2, artistId: 1, releases: [{ id: 3, albumId: 2 }] },
      delayMs: opts.lidarrAlbumDelay,
      hang: opts.lidarrAlbumHang,
      status: opts.lidarrAlbumStatus,
    }),
    "GET /api/v1/track": () => ({ json: [{ id: 10, albumReleaseId: 3, title: "Track", trackNumber: 1 }] }),
  };
}

function sonarrRoutes(opts = {}) {
  return {
    "GET /api/v3/manualimport": () => ({ json: [SONARR_CANDIDATE] }),
    "POST /api/v3/manualimport": (e) => ({ json: sonarrReprocess(e.body), delayMs: opts.sonarrReprocessDelay }),
    "GET /api/v3/queue": () => ({ json: { records: [], totalRecords: 0 }, delayMs: opts.sonarrQueueDelay, hang: opts.sonarrQueueHang }),
    "GET /api/v3/episode": () => ({ json: [{ id: 9001, seriesId: 47, seasonNumber: 1, episodeNumber: 1, title: "Pilot", hasFile: false, episodeFileId: null }] }),
    "GET /api/v3/episodefile": () => ({ json: [] }),
    "GET /api/v3/series/47": () => ({ json: { id: 47, title: "Series", qualityProfileId: 1 } }),
    "GET /api/v3/qualityprofile": () => ({ json: [{ id: 1, name: "HD", formatItems: [] }] }),
  };
}

function radarrRoutes(opts = {}) {
  return {
    "GET /api/v3/manualimport": () => ({ json: [RADARR_CANDIDATE] }),
    "POST /api/v3/manualimport": (e) => ({ json: radarrReprocess(e.body), delayMs: opts.radarrReprocessDelay }),
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

// Boots the MCP server against the stubs with a given env override set.
async function withServers(env, opts, fn) {
  const port = String(35000 + Math.floor(Math.random() * 1000));
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

const LIDARR_PREVIEW_ARGS = { downloadId: LIDARR_DOWNLOAD_ID, items: [{ candidateId: 5 }] };

// --- A. Fast preview stays synchronous (no operation wrapper) --------------

test("fast Lidarr preview returns the normal preview shape, not an operation handle", async () => {
  await withServers({ PREVIEW_SYNC_BUDGET_MS: "8000" }, {}, async (port) => {
    const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
    assert.equal(payload.status, undefined, "a fast preview must not carry an operation status");
    assert.equal(payload.operationId, undefined, "a fast preview must not carry an operationId");
    assert.ok(Array.isArray(payload.items), "normal preview items array present");
    assert.equal(payload.downloadId, LIDARR_DOWNLOAD_ID);
    assert.ok(payload.verifyBeforeActing, "verify directive preserved");
    assert.equal(payload.count, 1);
  });
});

test("fast Sonarr and Radarr previews keep the shared synchronous path", async () => {
  await withServers({ PREVIEW_SYNC_BUDGET_MS: "8000" }, {}, async (port) => {
    const s = await callTool(port, "sonarr_preview_manual_import", { downloadId: SONARR_DOWNLOAD_ID, items: [{ candidateId: 123 }] });
    assert.equal(s.payload.operationId, undefined);
    assert.equal(s.payload.count, 1);
    const r = await callTool(port, "radarr_preview_manual_import", { downloadId: RADARR_DOWNLOAD_ID, items: [{ candidateId: 222 }] });
    assert.equal(r.payload.operationId, undefined);
    assert.equal(r.payload.count, 1);
  });
});

// --- B/C/D. Slow preview returns a handle, then polls to completion --------

test("slow preview returns a running handle before the operation completes, then polls to the exact normal result", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "300", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateDelay: 1200 },
    async (port) => {
      const started = Date.now();
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      const elapsed = Date.now() - started;
      assert.equal(payload.status, "running", "must return a running handle");
      assert.ok(payload.operationId, "operationId present");
      assert.ok(payload.pollAfterMs, "pollAfterMs present");
      assert.ok(elapsed < 1000, `handle returned before the 1200ms native delay (${elapsed}ms)`);

      // Poll while still running.
      const running = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(running.payload.status, "running");
      assert.ok(running.payload.stage, "stage reported while running");

      // Release the delay, then poll to completion.
      await sleep(1200);
      const done = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(done.payload.status, "completed");

      // The completed result must be the exact normal preview shape (no
      // operation envelope): the same fields the synchronous fast path returns.
      const result = done.payload.result;
      assert.ok(Array.isArray(result.items), "completed result carries the normal preview items");
      assert.equal(result.downloadId, LIDARR_DOWNLOAD_ID);
      assert.ok(result.verifyBeforeActing, "verify directive preserved in the completed result");
      assert.equal(result.count, 1);
      assert.equal(result.operationId, undefined, "completed result is not wrapped in an operation envelope");
    },
  );
});

// --- E. Background operation survives the stateless HTTP request teardown --

test("preview operation survives the per-request server teardown and is pollable from a new request", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateDelay: 1500 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(payload.status, "running");
      // The preview request has fully returned (its request-scoped Server +
      // transport are closed on response close). Poll from a brand-new request.
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "running", "operation outlived the request that started it");
      await sleep(1600);
      const done = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(done.payload.status, "completed");
    },
  );
});

// --- F. Per-request upstream API timeout aborts a hung request -------------

test("a hung native request is aborted by the per-request API timeout (no forever-pending promise)", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "20000",
      MANUAL_IMPORT_API_TIMEOUT_MS: "250",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrUpdateHang: true },
    async (port, logs) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(payload.status, "running");
      await sleep(600);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "failed", "per-request timeout surfaces as a failed operation");
      assert.match(poll.payload.error, /timed out/, "error describes the request timeout");
      const posts = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport");
      assert.equal(posts.length, 1, "the native request was received and the promise settled (no forever-pending)");
    },
  );
});

// --- G. Whole-operation hard timeout ---------------------------------------

test("a preview exceeding PREVIEW_MAX_RUNTIME_MS is marked timed_out with its stage retained", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "400",
      MANUAL_IMPORT_API_TIMEOUT_MS: "20000",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrUpdateDelay: 2000 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(payload.status, "running");
      // Poll just after the 400ms deadline, well before the 2000ms native
      // response: the deadline must terminalize on its own, not wait for the
      // native request/executor to unwind.
      await sleep(480);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "timed_out", "deadline terminalizes without the native request finishing");
      assert.ok(poll.payload.stage, "stage retained on timeout");
      assert.match(poll.payload.error, /exceeded the configured operation timeout/, "error describes the preview timeout");
      // completedAt is fixed at the deadline, so elapsedMs is stable (~400ms),
      // not the wall-clock time since start.
      assert.ok(poll.payload.elapsedMs >= 380 && poll.payload.elapsedMs <= 600, `elapsedMs reflects the deadline, got ${poll.payload.elapsedMs}`);
    },
  );
});

// --- H. Cancellation -------------------------------------------------------

test("arr_cancel_operation aborts a running preview and the status stays cancelled", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateHang: true },
    async (port, logs) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(payload.status, "running");
      const cancelled = await callTool(port, "arr_cancel_operation", { operationId: payload.operationId });
      assert.equal(cancelled.payload.status, "cancelled");
      await sleep(300);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "cancelled", "a cancelled operation stays cancelled");
      const posts = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport");
      assert.equal(posts.length, 1, "the in-flight native request was received and the operation settled (no hang)");
    },
  );
});

test("arr_cancel_operation on a completed operation leaves it completed", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateDelay: 800 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(payload.status, "running");
      await sleep(1000);
      const done = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(done.payload.status, "completed");
      const cancelled = await callTool(port, "arr_cancel_operation", { operationId: payload.operationId });
      assert.equal(cancelled.payload.status, "completed", "cancel does not mutate a terminal operation");
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "completed", "the operation is still completed after cancel");
    },
  );
});

test("arr_cancel_operation on an unknown id returns expired-or-unknown", async () => {
  await withServers({ PREVIEW_SYNC_BUDGET_MS: "8000" }, {}, async (port) => {
    const res = await callTool(port, "arr_cancel_operation", { operationId: "does-not-exist" });
    assert.equal(res.payload.status, "expired-or-unknown");
  });
});

// --- I. Duplicate active preview deduplication -----------------------------

test("an identical preview while one is running deduplicates to the same operationId with one native workload", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateDelay: 1500 },
    async (port, logs) => {
      const first = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(first.payload.status, "running");
      const second = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(second.payload.status, "running");
      assert.equal(second.payload.operationId, first.payload.operationId, "same operationId");
      assert.equal(second.payload.deduplicated, true, "deduplicated flag set");
      const posts = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport");
      assert.equal(posts.length, 1, "only one native preview workload started");
    },
  );
});

// --- J. Completed preview is NOT reused as fresh authority -----------------

test("a completed preview is not reused: re-running re-fetches native state and starts a new operation", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "200", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateDelay: 800 },
    async (port, logs) => {
      const first = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(first.payload.status, "running");
      await sleep(1000);
      const done = await callTool(port, "arr_get_operation", { operationId: first.payload.operationId });
      assert.equal(done.payload.status, "completed");

      const getsBefore = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length;
      const second = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      const getsAfter = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport").length;
      assert.ok(getsAfter > getsBefore, "fresh native candidate discovery occurred on the re-run");
      if (second.payload.operationId !== undefined) {
        assert.notEqual(second.payload.operationId, first.payload.operationId, "a re-run never reuses the completed operation");
      }
    },
  );
});

// --- K. Result expiry ------------------------------------------------------

test("a completed operation expires after OPERATION_RESULT_TTL_MS", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "100", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "1000" },
    { lidarrUpdateDelay: 600 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(payload.status, "running");
      await sleep(700);
      const completed = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(completed.payload.status, "completed", "result is retrievable before expiry");
      await sleep(1200);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "expired-or-unknown", "terminal result expired past its TTL");
    },
  );
});

// --- L. Failure preservation -----------------------------------------------

test("a native 500 from the app surfaces as a failed operation with the error retained", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "8000", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateStatus: 500 },
    async (port) => {
      const { payload, isError, text } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(isError, true, "fast-path failure keeps the existing error shape");
      assert.match(text, /lidarr API error: 500/i, "native error message preserved");
    },
  );
});

// --- N. Stage reporting around the native reprocess ------------------------

test("Lidarr preview reports native-reprocess before the update and resolving-tracks after it", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "150", PREVIEW_MAX_RUNTIME_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrUpdateDelay: 1200 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_PREVIEW_ARGS);
      assert.equal(payload.status, "running");
      // During the native update the stage is native-reprocess.
      const during = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(during.payload.stage, "native-reprocess");
      await sleep(1300);
      const done = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(done.payload.status, "completed");
    },
  );
});

// --- O/P. Hard deadline during a best-effort Lidarr lookup (the race) ------

// The deadline fires while validating-mappings is inside GET /album/{id}, a
// helper that normally swallows lookup failures into a null/unverifiable
// result. The operation-level abort must NOT be converted into a completed
// diagnostic preview — the deadline is authoritative.
const LIDARR_RELATIONSHIP_ARGS = { downloadId: LIDARR_DOWNLOAD_ID, items: [{ candidateId: 5, albumId: 2 }] };

test("hard deadline during a swallowed Lidarr album lookup is timed_out, never a completed preview", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "400",
      MANUAL_IMPORT_API_TIMEOUT_MS: "20000",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrAlbumDelay: 1500 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_RELATIONSHIP_ARGS);
      assert.equal(payload.status, "running");
      await sleep(480);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "timed_out", "deadline during the fallback lookup terminalizes as timed_out");
      assert.equal(poll.payload.result, undefined, "no completed diagnostic preview is produced");
    },
  );
});

test("a late native response after the deadline cannot overwrite timed_out", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "400",
      MANUAL_IMPORT_API_TIMEOUT_MS: "20000",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrAlbumDelay: 1200 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_RELATIONSHIP_ARGS);
      assert.equal(payload.status, "running");
      await sleep(480);
      const first = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(first.payload.status, "timed_out");
      // Let the delayed native lookup finally respond, then poll again.
      await sleep(1000);
      const second = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(second.payload.status, "timed_out", "timed_out stays terminal after the native work resolves");
    },
  );
});

// --- Q. Sonarr swallowed-abort path (findSonarrReleaseContext) -------------

test("hard deadline during a Sonarr queue-context lookup is timed_out, not a completed preview", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "400",
      MANUAL_IMPORT_API_TIMEOUT_MS: "20000",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { sonarrQueueDelay: 1500 },
    async (port) => {
      const { payload } = await callTool(port, "sonarr_preview_manual_import", { downloadId: SONARR_DOWNLOAD_ID, items: [{ candidateId: 123 }] });
      assert.equal(payload.status, "running");
      await sleep(480);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "timed_out", "deadline during the best-effort queue lookup terminalizes as timed_out");
      assert.equal(poll.payload.result, undefined, "no completed preview with an unavailable release context is produced");
    },
  );
});

// --- R. Fingerprint is reusable after a timeout ----------------------------

test("an identical preview after a timeout starts a fresh operation, not a dedup against the timed-out one", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "400",
      MANUAL_IMPORT_API_TIMEOUT_MS: "20000",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrAlbumHang: true },
    async (port) => {
      const a = await callTool(port, "lidarr_preview_manual_import", LIDARR_RELATIONSHIP_ARGS);
      assert.equal(a.payload.status, "running");
      await sleep(480);
      const pollA = await callTool(port, "arr_get_operation", { operationId: a.payload.operationId });
      assert.equal(pollA.payload.status, "timed_out");
      const b = await callTool(port, "lidarr_preview_manual_import", LIDARR_RELATIONSHIP_ARGS);
      assert.equal(b.payload.status, "running");
      assert.notEqual(b.payload.operationId, a.payload.operationId, "a new identical preview starts fresh after the prior one timed out");
      assert.notEqual(b.payload.deduplicated, true, "the timed-out operation is not treated as an active fingerprint");
    },
  );
});

// --- S. Per-request timeout inside a best-effort lookup is a real failure --

// A configured native request timeout must NOT be swallowed as a null /
// "unverifiable" metadata fallback: it is a real API stall and the operation
// must fail with the timeout, not complete diagnostically.
test("a per-request timeout during a best-effort Lidarr album lookup fails the preview (not a fallback)", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "20000",
      ARR_API_TIMEOUT_MS: "250",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { lidarrAlbumDelay: 1500 },
    async (port) => {
      const { payload } = await callTool(port, "lidarr_preview_manual_import", LIDARR_RELATIONSHIP_ARGS);
      assert.equal(payload.status, "running");
      await sleep(600);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "failed", "request timeout surfaces as a failed operation, not a completed diagnostic preview");
      assert.match(poll.payload.error, /request timed out/, "error names the request timeout");
      assert.equal(poll.payload.result, undefined, "no unverifiable-relationship preview result is produced");
    },
  );
});

test("a per-request timeout during a best-effort Sonarr queue-context lookup fails the preview", async () => {
  await withServers(
    {
      PREVIEW_SYNC_BUDGET_MS: "100",
      PREVIEW_MAX_RUNTIME_MS: "20000",
      ARR_API_TIMEOUT_MS: "250",
      OPERATION_RESULT_TTL_MS: "600000",
    },
    { sonarrQueueDelay: 1500 },
    async (port) => {
      const { payload } = await callTool(port, "sonarr_preview_manual_import", { downloadId: SONARR_DOWNLOAD_ID, items: [{ candidateId: 123 }] });
      assert.equal(payload.status, "running");
      await sleep(600);
      const poll = await callTool(port, "arr_get_operation", { operationId: payload.operationId });
      assert.equal(poll.payload.status, "failed", "request timeout fails the preview rather than degrading to queue-unavailable");
      assert.match(poll.payload.error, /request timed out/, "error names the request timeout");
    },
  );
});

// --- T. Ordinary (non-timeout) lookup failure still degrades safely --------

test("an ordinary HTTP 500 on a best-effort album lookup still falls back to a diagnostic preview", async () => {
  await withServers(
    { PREVIEW_SYNC_BUDGET_MS: "8000", PREVIEW_MAX_RUNTIME_MS: "20000", ARR_API_TIMEOUT_MS: "20000", OPERATION_RESULT_TTL_MS: "600000" },
    { lidarrAlbumStatus: 500 },
    async (port) => {
      const { payload, isError } = await callTool(port, "lidarr_preview_manual_import", LIDARR_RELATIONSHIP_ARGS);
      assert.equal(isError, false, "a 500 on an optional lookup is not fatal — the preview completes diagnostically");
      assert.equal(payload.operationId, undefined, "fast path returns the normal preview shape");
      assert.equal(payload.count, 1);
      assert.equal(payload.items[0].canPreview, false, "the candidate is reported as not previewable");
      assert.equal(payload.items[0].relationshipValidation.ok, false, "relationship is unverifiable, not a hard failure");
      assert.match(payload.items[0].relationshipValidation.problems.join(" "), /could not be fetched/, "the fallback reason is reported");
    },
  );
});
