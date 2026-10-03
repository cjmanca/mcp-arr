import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

// ---------------------------------------------------------------------------
// Manual-import orchestration tests.
//
// Boots the real MCP server (HTTP transport) against three stub *arr apps
// (Sonarr/Radarr share the /api/v3 namespace, so each service gets its own
// stub with its own request log). The stubs mimic the native manual-import
// endpoints:
//   GET  /api/{v3|v1}/manualimport   -> candidate list scoped to downloadId
//   POST /api/{v3|v1}/manualimport   -> reprocess/update, echoing the request
//                                        items with server-recalculated fields
//                                        (Lidarr recomputes tracks server-side)
//   POST /api/{v3|v1}/command        -> { id } for the ManualImport command
// ---------------------------------------------------------------------------

const SONARR_DOWNLOAD_ID = "abc123";
const LIDARR_DOWNLOAD_ID = "dl-5";

const QUALITY = { quality: { id: 9, name: "WEBDL-1080p", source: "web", resolution: 1080 }, revision: { version: 1, real: 0 } };
const LANGUAGES = [{ id: 3, name: "English" }];

const SONARR_CANDIDATE = {
  id: 123,
  path: "/downloads/complete/The.Good.Fight/The.Good.Fight.S06E03.1080p.mkv",
  relativePath: "The.Good.Fight.S06E03.1080p.mkv",
  folderName: "The.Good.Fight.S06",
  name: "The.Good.Fight.S06E03.1080p",
  size: 123456789,
  series: { id: 47, title: "The Good Fight" },
  seasonNumber: 6,
  episodes: [{ id: 9001, seriesId: 47, seasonNumber: 6, episodeNumber: 3, title: "The End of Football" }],
  episodeFileId: null,
  releaseGroup: "NTb",
  quality: QUALITY,
  languages: LANGUAGES,
  qualityWeight: 60,
  downloadId: SONARR_DOWNLOAD_ID,
  customFormats: [{ id: 1, name: "NTb", score: 10 }],
  customFormatScore: 10,
  indexerFlags: 0,
  releaseType: "episode",
  rejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }],
};

const SONARR_CANDIDATE_2 = {
  ...SONARR_CANDIDATE,
  id: 124,
  path: "/downloads/complete/The.Good.Fight/The.Good.Fight.S06E04.1080p.mkv",
  name: "The.Good.Fight.S06E04.1080p",
  episodes: [{ id: 9002, seriesId: 47, seasonNumber: 6, episodeNumber: 4, title: "The End of Football II" }],
  rejections: [],
};

const RADARR_CANDIDATE = {
  id: 222,
  path: "/downloads/complete/Some.Movie/Some.Movie.2026.1080p.mkv",
  relativePath: "Some.Movie.2026.1080p.mkv",
  folderName: "Some.Movie.2026",
  name: "Some.Movie.2026.1080p",
  size: 500,
  movie: { id: 11, title: "Some Movie", year: 2026 },
  movieFileId: null,
  releaseGroup: "SM",
  quality: QUALITY,
  languages: LANGUAGES,
  qualityWeight: 60,
  downloadId: "dl-11",
  customFormats: [],
  customFormatScore: 0,
  indexerFlags: 0,
  rejections: [],
};

const LIDARR_CANDIDATE = {
  id: 333,
  path: "/downloads/complete/Some.Artist/Some.Artist - Some Album/01 - Track One.flac",
  name: "01 - Track One",
  size: 700,
  artist: { id: 5, artistName: "Some Artist" },
  album: { id: 9, title: "Some Album" },
  albumReleaseId: 77,
  tracks: [{ id: 501, title: "Track One", trackNumber: 1, position: 1, mediumNumber: 1 }],
  quality: QUALITY,
  releaseGroup: "GROUP",
  qualityWeight: 60,
  downloadId: LIDARR_DOWNLOAD_ID,
  indexerFlags: 0,
  rejections: [],
  additionalFile: false,
  replaceExistingFiles: false,
  disableReleaseSwitching: false,
};

// --- stub *arr apps -------------------------------------------------------

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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
    };
    requests.push(entry);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unrouted ${req.method} ${url.pathname}` }));
      return;
    }
    const result = route(entry);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.json ?? {}));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

// Sonarr/Radarr reprocess: the native controller returns the SAME items with
// recalculated fields; the stub echoes request fields and applies scripted
// rejections, exactly the shape the MCP layer consumes.
function sonarrReprocess(items, opts) {
  // Sonarr computes qualityWeight/customFormatScore server-side from the
  // release during reprocess; the stub echoes the discovery candidate's
  // values (the reprocess payload does not carry them).
  const byId = Object.fromEntries((opts.sonarrCandidates ?? [SONARR_CANDIDATE]).map((c) => [c.id, c]));
  return items.map((item) => ({
    ...item,
    episodes: (item.episodeIds ?? []).map((id) => ({
      id,
      seriesId: item.seriesId,
      seasonNumber: item.seasonNumber,
      episodeNumber: 3,
      title: `Episode ${id}`,
    })),
    rejections: opts.reprocessRejections ?? [],
    customFormats: byId[item.id]?.customFormats ?? [],
    customFormatScore: byId[item.id]?.customFormatScore ?? 0,
    qualityWeight: byId[item.id]?.qualityWeight ?? 0,
    episodeIds: null,
  }));
}

function radarrReprocess(items, opts) {
  return items.map((item) => ({
    ...item,
    movie: item.movieId > 0 ? { id: item.movieId, title: `Movie ${item.movieId}`, year: 2026 } : null,
    rejections: opts.reprocessRejections ?? [],
    customFormats: [],
    customFormatScore: 0,
  }));
}

// Lidarr UpdateItems: the native ManualImportUpdateResource has NO trackIds
// field — the backend re-runs the import decision with the artist/album/release
// overrides and RECOMPUTES tracks server-side. Track selection is validated
// against the selected album RELEASE's track list (GET /track?albumReleaseId=
// → GetTracksByRelease), mirroring the native Interactive Import selector.
// Album 9 has release 77 (tracks 501, 502) and release 78 (track 503).
function lidarrReleaseTracks(opts) {
  return opts.lidarrReleaseTracks ?? { 77: [501, 502], 78: [503] };
}

function lidarrTrackResourcesForRelease(releaseId, opts) {
  return (lidarrReleaseTracks(opts)[releaseId] ?? []).map((id) => ({
    id,
    artistId: 5,
    albumId: 9,
    albumReleaseId: releaseId,
    title: `Track ${id}`,
    trackNumber: 1,
    position: 1,
    mediumNumber: 1,
  }));
}

function lidarrUpdate(items, opts) {
  // The update response's tracks are Lidarr's server-side recomputation.
  // opts.lidarrRecomputedTracks can inject a recomputed set that differs from
  // the release's track query (the native mapping/release-list inconsistency
  // the MCP layer must surface, not authorize).
  const recomputedFor = (releaseId) =>
    (opts.lidarrRecomputedTracks ?? lidarrReleaseTracks(opts))[releaseId] ?? lidarrReleaseTracks(opts)[releaseId] ?? [];
  return items.map((item) => ({
    id: item.id,
    path: item.path,
    name: item.name,
    size: 700,
    artist: item.artistId ? { id: item.artistId, artistName: `Artist ${item.artistId}` } : null,
    album: item.albumId ? { id: item.albumId, title: `Album ${item.albumId}` } : null,
    albumReleaseId: item.albumReleaseId ?? 0,
    tracks: recomputedFor(item.albumReleaseId ?? 0).map((id) => ({
      id,
      artistId: 5,
      albumId: item.albumId ?? 0,
      title: `Track ${id}`,
      trackNumber: 1,
      position: 1,
      mediumNumber: 1,
    })),
    quality: item.quality,
    releaseGroup: item.releaseGroup,
    qualityWeight: 60,
    downloadId: item.downloadId,
    indexerFlags: item.indexerFlags,
    rejections: opts.reprocessRejections ?? [],
    additionalFile: item.additionalFile ?? false,
    replaceExistingFiles: item.replaceExistingFiles ?? false,
    disableReleaseSwitching: item.disableReleaseSwitching ?? false,
  }));
}

function buildRoutes(opts) {
  const sonarr = {
    "GET /api/v3/manualimport": (e) => ({
      json: e.params.downloadId === SONARR_DOWNLOAD_ID ? (opts.sonarrCandidates ?? [SONARR_CANDIDATE]) : [],
    }),
    "POST /api/v3/manualimport": (e) => ({ json: sonarrReprocess(e.body, opts) }),
    "POST /api/v3/command": () => ({ json: { id: opts.commandId ?? 987, name: "ManualImport", status: "queued" } }),
    "GET /api/v3/episode": () => ({ json: opts.sonarrEpisodesWithFiles ?? [] }),
    "GET /api/v3/episodefile": () => ({ json: opts.sonarrEpisodeFilesList ?? [] }),
    "GET /api/v3/queue": () => ({ json: { records: [], totalRecords: 0 } }),
  };
  const radarr = {
    "GET /api/v3/manualimport": (e) => ({
      json: e.params.downloadId === "dl-11" ? (opts.radarrCandidates ?? [RADARR_CANDIDATE]) : [],
    }),
    "POST /api/v3/manualimport": (e) => ({ json: radarrReprocess(e.body, opts) }),
    "POST /api/v3/command": () => ({ json: { id: opts.radarrCommandId ?? 777, name: "ManualImport", status: "queued" } }),
    "GET /api/v3/queue": () => ({ json: { records: [], totalRecords: 0 } }),
  };
  const lidarr = {
    "GET /api/v1/manualimport": (e) => ({
      json: e.params.downloadId === LIDARR_DOWNLOAD_ID ? (opts.lidarrCandidates ?? [LIDARR_CANDIDATE]) : [],
    }),
    "POST /api/v1/manualimport": (e) => ({ json: lidarrUpdate(e.body, opts) }),
    "POST /api/v1/command": () => ({ json: { id: opts.lidarrCommandId ?? 654, name: "ManualImport", status: "queued" } }),
    "GET /api/v1/track": (e) => ({ json: lidarrTrackResourcesForRelease(Number(e.params.albumReleaseId), opts) }),
    "GET /api/v1/queue": () => ({ json: { records: [], totalRecords: 0 } }),
  };
  return { sonarr, radarr, lidarr };
}

// --- MCP harness ----------------------------------------------------------

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
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
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
  const response = await postMcp(port, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
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

// Boots the MCP server against three stub apps; `fn` receives the MCP port
// and the per-service request logs.
async function withServers(opts, fn) {
  const port = String(34000 + Math.floor(Math.random() * 1000));
  const routes = buildRoutes(opts);
  const sonarrStub = await startStub(routes.sonarr);
  const radarrStub = await startStub(routes.radarr);
  const lidarrStub = await startStub(routes.lidarr);

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
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHealth(port);
    const initResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-arr-test", version: "0.0.0" },
      },
    });
    assert.equal(initResponse.status, 200);
    await fn(port, {
      sonarr: sonarrStub.requests,
      radarr: radarrStub.requests,
      lidarr: lidarrStub.requests,
    });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    sonarrStub.server.close();
    radarrStub.server.close();
    lidarrStub.server.close();
  }
}

function requestsTo(log, method, path) {
  return log.filter((r) => r.method === method && r.path === path);
}

// --- 1/2. candidate discovery --------------------------------------------

test("sonarr_get_manual_import_candidates: native GET /api/v3/manualimport scoped to downloadId", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "sonarr_get_manual_import_candidates", { downloadId: SONARR_DOWNLOAD_ID });
    assert.equal(result.isError, false, result.text);

    const gets = requestsTo(logs.sonarr, "GET", "/api/v3/manualimport");
    assert.equal(gets.length, 1, "discovery must use the native manualimport endpoint");
    assert.equal(gets[0].params.downloadId, SONARR_DOWNLOAD_ID, "discovery must be constrained to downloadId");
    assert.ok(!("path" in gets[0].params) && !("folder" in gets[0].params), "no caller-supplied path/folder is sent");

    assert.equal(result.payload.count, 1);
    assert.ok(Array.isArray(result.payload.verifyBeforeActing) && result.payload.verifyBeforeActing.length >= 2, "discovery leads with the verify-before-acting directive");
    assert.match(JSON.stringify(result.payload.verifyBeforeActing), /PARSE GUESSES/i, "directive states mappings/rejections are not facts");
    const c = result.payload.candidates[0];
    assert.equal(c.candidateId, 123, "candidateId is the native resource id");
    assert.equal(c.path, SONARR_CANDIDATE.path, "path is returned for display only");
    assert.deepEqual(c.series, { id: 47, title: "The Good Fight" }, "compact series identity");
    assert.deepEqual(c.episodes, [{ id: 9001, seasonNumber: 6, episodeNumber: 3, title: "The End of Football" }]);
    assert.deepEqual(c.rejections, [{ reason: "Unable to determine if file is a sample", type: "temporary" }], "rejections kept structured");
    assert.deepEqual(c.quality, QUALITY);
    assert.deepEqual(c.languages, LANGUAGES);
    assert.equal(c.releaseType, "episode");
  });
});

test("radarr/lidarr discovery: correct native endpoints and params", async () => {
  await withServers({}, async (port, logs) => {
    const radarr = await callTool(port, "radarr_get_manual_import_candidates", { downloadId: "dl-11", movieId: 11 });
    assert.equal(radarr.isError, false, radarr.text);
    const rGets = requestsTo(logs.radarr, "GET", "/api/v3/manualimport");
    assert.equal(rGets[0].params.downloadId, "dl-11");
    assert.equal(rGets[0].params.movieId, "11", "movie hint passed to native endpoint");
    assert.equal(radarr.payload.candidates[0].movie.id, 11);

    const lidarr = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID, artistId: 5 });
    assert.equal(lidarr.isError, false, lidarr.text);
    const lGets = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport");
    assert.equal(lGets.length, 1);
    assert.equal(lGets[0].params.downloadId, LIDARR_DOWNLOAD_ID);
    assert.equal(lGets[0].params.artistId, "5");
    assert.equal(lGets[0].params.replaceExistingFiles, "false", "discovery defaults to the safer non-destructive mode");
    const c = lidarr.payload.candidates[0];
    assert.deepEqual(c.artist, { id: 5, artistName: "Some Artist" });
    assert.deepEqual(c.album, { id: 9, title: "Some Album" });
    assert.equal(c.albumReleaseId, 77);
    assert.equal(c.tracks[0].id, 501);
  });
});

test("discovery for an untracked downloadId yields zero candidates; preview/execute refuse", async () => {
  await withServers({}, async (port) => {
    const get = await callTool(port, "sonarr_get_manual_import_candidates", { downloadId: "not-tracked" });
    assert.equal(get.isError, false);
    assert.equal(get.payload.count, 0);

    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: "not-tracked",
      items: [{ candidateId: 123 }],
    });
    assert.equal(preview.isError, true);
    assert.match(preview.text, /no manual-import candidates/i);

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: "not-tracked",
      items: [{ candidateId: 123 }],
    });
    assert.equal(exec.isError, true);
    assert.match(exec.text, /no manual-import candidates/i);
  });
});

// --- 5/8. preview merges overrides and never imports ----------------------

test("sonarr_preview_manual_import: merges overrides onto fresh candidate values, never sends a command", async () => {
  await withServers({ reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 47, seasonNumber: 6, episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);

    const posts = requestsTo(logs.sonarr, "POST", "/api/v3/manualimport");
    assert.equal(posts.length, 1, "preview must reprocess through the native endpoint");
    const sent = posts[0].body[0];
    assert.equal(sent.id, 123);
    assert.equal(sent.path, SONARR_CANDIDATE.path, "path comes from the native candidate");
    assert.equal(sent.seriesId, 47, "override merged");
    assert.equal(sent.seasonNumber, 6, "override merged");
    assert.deepEqual(sent.episodeIds, [9001], "override merged");
    assert.deepEqual(sent.quality, QUALITY, "quality preserved from candidate, not required from caller");
    assert.deepEqual(sent.languages, LANGUAGES, "languages preserved from candidate");
    assert.equal(sent.releaseGroup, "NTb", "release group preserved when not overridden");
    assert.equal(sent.releaseType, "episode", "release type preserved from candidate");
    assert.equal(sent.downloadId, SONARR_DOWNLOAD_ID);

    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "preview must never send a ManualImport command");

    assert.ok(Array.isArray(result.payload.verifyBeforeActing), "preview leads with the verify-before-acting directive");
    assert.match(JSON.stringify(result.payload.verifyBeforeActing), /NOT verified facts/i, "directive tells agents to verify the mapping, not trust it");

    const item = result.payload.items[0];
    assert.equal(item.candidateId, 123);
    assert.equal(item.seasonNumber, 6);
    assert.equal(item.episodes[0].id, 9001);
    assert.deepEqual(item.rejections, [{ reason: "Unable to determine if file is a sample", type: "temporary" }]);
    assert.equal(item.mappingValid, true);
    assert.equal(item.canExecuteWithoutOverride, false, "remaining rejections mean execute needs allowRejected");
  });
});

test("preview with overrides on an unmapped candidate: mapping becomes valid after reprocess", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 125, series: null, seasonNumber: null, episodes: [], rejections: [{ reason: "Invalid release", type: "permanent" }] };
  await withServers({ sonarrCandidates: [unmapped], reprocessRejections: [{ reason: "Invalid release", type: "permanent" }] }, async (port) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 125, seriesId: 47, seasonNumber: 6, episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);
    const item = result.payload.items[0];
    assert.equal(item.series.id, 47);
    assert.equal(item.episodes[0].id, 9001);
    assert.equal(item.mappingValid, true);
    assert.equal(item.canExecuteWithoutOverride, false, "stub reprocess echoes the scripted rejection");
  });
});

test("preview refuses a candidateId that is not in the fresh native list", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 999 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /candidateId 999/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "unresolved candidate must not be reprocessed");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

// --- 3/4/9/12/13/15/16. execute orchestration -----------------------------

test("sonarr_execute_manual_import: fresh GET -> resolve -> reprocess -> command with explicit importMode=auto", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 47, seasonNumber: 6, episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);

    // Order: discovery, reprocess, command — reprocess happens immediately
    // before command submission, on every execute.
    const methods = logs.sonarr.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(methods, [
      "GET /api/v3/manualimport",
      "POST /api/v3/manualimport",
      "POST /api/v3/command",
    ]);

    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.name, "ManualImport");
    assert.equal(command.importMode, "auto", "importMode is always sent explicitly; default auto");
    const file = command.files[0];
    assert.equal(file.path, SONARR_CANDIDATE.path, "path comes from the native candidate");
    assert.equal(file.folderName, SONARR_CANDIDATE.folderName);
    assert.equal(file.seriesId, 47);
    assert.deepEqual(file.episodeIds, [9001]);
    assert.deepEqual(file.quality, QUALITY);
    assert.deepEqual(file.languages, LANGUAGES);
    assert.equal(file.releaseType, "episode");
    assert.equal(file.downloadId, SONARR_DOWNLOAD_ID);

    assert.equal(result.payload.commandId, 987, "returns the command id");
    assert.equal(result.payload.status, "queued", "acceptance is queued, not completed");
    assert.match(result.payload.message, /asynchronously/, "response describes async completion");
    assert.equal(requestsTo(logs.sonarr, "DELETE", "/api/v3/queue/123").length, 0, "no automatic queue deletion");
    assert.equal(logs.sonarr.filter((r) => r.method === "DELETE").length, 0, "no queue removal of any kind");
  });
});

test("execute never imports a caller-supplied path: extra path fields are ignored", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, path: "/some/arbitrary/evil.mkv", episodeIds: [9001] }],
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.files[0].path, SONARR_CANDIDATE.path, "only the native candidate path is imported");
    assert.ok(!command.files.some((f) => f.path.includes("evil")), "caller path must not reach the command");
  });
});

test("execute re-resolves candidateIds against the fresh list; stale ids fail before any command", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 999 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /candidateId 999/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("execute honors an explicit importMode (copy)", async () => {
  await withServers({ reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
      importMode: "copy",
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.importMode, "copy");
  });
});

// --- 10/11. rejection gating ----------------------------------------------

test("remaining rejections block execute by default and are returned with guidance", async () => {
  await withServers({ reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }] }, async (port, logs) => {
    // Stub candidate has no rejections at discovery; the reprocess response
    // (the authoritative decision) carries the sample-indeterminate rejection.
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(result.isError, true, "rejections must block execution without opt-in");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "blocked execute must not submit a command");
    assert.equal(result.payload.blocked[0].candidateId, 123);
    assert.deepEqual(result.payload.blocked[0].rejections, [
      { reason: "Unable to determine if file is a sample", type: "temporary" },
    ]);
    assert.match(JSON.stringify(result.payload.guidance), /allowRejected=true/);
  });
});

test("item-level allowRejected=true permits the manual override and reports overridden rejections", async () => {
  await withServers({ reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, allowRejected: true }],
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.files.length, 1);
    assert.equal(result.payload.overriddenRejections.length, 1);
    assert.equal(result.payload.overriddenRejections[0].rejections[0].reason, "Unable to determine if file is a sample");
  });
});

test("per-candidate rejection authorization: allowRejected=true on B does not authorize rejected A", async () => {
  await withServers(
    {
      sonarrCandidates: [SONARR_CANDIDATE, SONARR_CANDIDATE_2],
      reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }],
    },
    async (port, logs) => {
      const result = await callTool(port, "sonarr_execute_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [
          { candidateId: 123 }, // rejected, NOT authorized
          { candidateId: 124, allowRejected: true }, // rejected, authorized
        ],
      });
      assert.equal(result.isError, true, "a non-authorized rejected candidate must block the command");
      const blockedIds = result.payload.blocked.map((b) => b.candidateId);
      assert.deepEqual(blockedIds, [123], "only the non-authorized candidate is blocked; B's authorization must not leak to A");
      assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0, "no command while a blocked candidate remains");
    },
  );
});

test("per-candidate allowRejected=true on every rejected item permits the multi-file command", async () => {
  await withServers(
    {
      sonarrCandidates: [SONARR_CANDIDATE, SONARR_CANDIDATE_2],
      reprocessRejections: [{ reason: "Unable to determine if file is a sample", type: "temporary" }],
    },
    async (port, logs) => {
      const result = await callTool(port, "sonarr_execute_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [
          { candidateId: 123, allowRejected: true },
          { candidateId: 124, allowRejected: true },
        ],
      });
      assert.equal(result.isError, false, result.text);
      const command = requestsTo(logs.sonarr, "POST", "/api/v3/command")[0].body;
      assert.equal(command.files.length, 2);
      assert.equal(result.payload.overriddenRejections.length, 2);
    },
  );
});

// --- native UI safeguards -------------------------------------------------

test("sonarr duplicate-episode safeguard: two files mapped to the same episode are refused", async () => {
  await withServers({ sonarrCandidates: [SONARR_CANDIDATE, SONARR_CANDIDATE_2], reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [
        { candidateId: 123, episodeIds: [9001] },
        { candidateId: 124, episodeIds: [9001] },
      ],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /Episode 9001 is mapped to both/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("sonarr execute refuses a candidate with no episode mapping", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 126, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [unmapped], reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 126 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /no valid series mapping|no episode mapping/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

// --- 6. Radarr -------------------------------------------------------------

test("radarr_execute_manual_import: movie override merged, native command shape, importMode explicit", async () => {
  await withServers({}, async (port, logs) => {
    const preview = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 11 }],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/command").length, 0, "preview never imports");
    assert.equal(preview.payload.items[0].movie.id, 11);
    assert.equal(preview.payload.items[0].canExecuteWithoutOverride, true);

    const result = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 11 }],
    });
    assert.equal(result.isError, false, result.text);

    const methods = logs.radarr.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(methods.slice(-3), [
      "GET /api/v3/manualimport",
      "POST /api/v3/manualimport",
      "POST /api/v3/command",
    ]);

    const command = requestsTo(logs.radarr, "POST", "/api/v3/command")[0].body;
    assert.equal(command.name, "ManualImport");
    assert.equal(command.importMode, "auto");
    const file = command.files[0];
    assert.equal(file.path, RADARR_CANDIDATE.path);
    assert.equal(file.folderName, RADARR_CANDIDATE.folderName);
    assert.equal(file.movieId, 11);
    assert.deepEqual(file.quality, QUALITY);
    assert.deepEqual(file.languages, LANGUAGES);
    assert.equal(file.releaseGroup, "SM", "release group preserved from the reprocessed candidate");
    assert.equal(result.payload.commandId, 777);
    assert.equal(result.payload.status, "queued");
  });
});

test("radarr execute refuses an unmapped candidate before command submission", async () => {
  const unmapped = { ...RADARR_CANDIDATE, id: 223, movie: null };
  await withServers({ radarrCandidates: [unmapped] }, async (port, logs) => {
    const result = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 223 }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /no valid movie mapping/);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/command").length, 0);
  });
});

// --- 7/14. Lidarr ----------------------------------------------------------

test("lidarr_preview_manual_import: update payload follows native UpdateItems semantics; tracks come from the server", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(result.isError, false, result.text);

    const posts = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport");
    assert.equal(posts.length, 1, "preview uses the native update endpoint");
    const sent = posts[0].body[0];
    assert.equal(sent.id, 333);
    assert.equal(sent.path, LIDARR_CANDIDATE.path, "path from the native candidate");
    assert.equal(sent.artistId, 5, "artist override merged");
    assert.equal(sent.albumId, 9, "album override merged");
    assert.equal(sent.albumReleaseId, 77, "release override merged");
    assert.equal(sent.trackIds, undefined, "native ManualImportUpdateResource has no trackIds field — caller tracks are never sent to the update endpoint");
    assert.equal(sent.replaceExistingFiles, false, "defaults to the safer non-destructive mode");
    assert.equal(sent.disableReleaseSwitching, false);
    assert.equal(sent.downloadId, LIDARR_DOWNLOAD_ID);

    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0, "preview never imports");

    const item = result.payload.items[0];
    assert.equal(item.artist.id, 5);
    assert.equal(item.album.id, 9);
    assert.equal(item.albumReleaseId, 77);
    assert.equal(item.tracks[0].id, 501, "tracks are the server-recomputed result");
    assert.equal(item.mappingValid, true);
    assert.equal(item.canExecuteWithoutOverride, true);
  });
});

test("lidarr_execute_manual_import: command consumes reprocessed tracks with importMode + replaceExistingFiles explicit", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
    });
    assert.equal(result.isError, false, result.text);

    const methods = logs.lidarr.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(methods, [
      "GET /api/v1/manualimport",
      "POST /api/v1/manualimport",
      "GET /api/v1/track",
      "POST /api/v1/command",
    ]);

    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.name, "ManualImport");
    assert.equal(command.importMode, "auto", "explicit importMode, default auto");
    assert.equal(command.replaceExistingFiles, false, "default matches the Interactive Import UI (non-destructive)");
    const file = command.files[0];
    assert.equal(file.path, LIDARR_CANDIDATE.path);
    assert.equal(file.artistId, 5);
    assert.equal(file.albumId, 9);
    assert.equal(file.albumReleaseId, 77);
    assert.deepEqual(file.trackIds, [501], "trackIds taken from the reprocessed response");
    assert.deepEqual(file.quality, QUALITY);
    assert.equal(file.downloadId, LIDARR_DOWNLOAD_ID);
    assert.equal(file.disableReleaseSwitching, false);

    assert.equal(result.payload.commandId, 654);
    assert.equal(result.payload.status, "queued");
    assert.equal(logs.lidarr.filter((r) => r.method === "DELETE").length, 0, "no automatic queue deletion");
  });
});

test("lidarr replaceExistingFiles=true is passed through to discovery, update, and command", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
      replaceExistingFiles: true,
    });
    assert.equal(result.isError, false, result.text);
    const get = requestsTo(logs.lidarr, "GET", "/api/v1/manualimport")[0];
    assert.equal(get.params.replaceExistingFiles, "true");
    const update = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport")[0].body[0];
    assert.equal(update.replaceExistingFiles, true);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.equal(command.replaceExistingFiles, true);
  });
});

test("lidarr rejections ({reason, type} shape, per native Rejection.cs) block execute by default; per-item allowRejected proceeds", async () => {
  await withServers({ reprocessRejections: [{ reason: "Not a quality upgrade for existing track file(s)", type: "permanent" }] }, async (port, logs) => {
    const blocked = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
    });
    assert.equal(blocked.isError, true);
    assert.deepEqual(blocked.payload.blocked[0].rejections, [{ reason: "Not a quality upgrade for existing track file(s)", type: "permanent" }]);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);

    const allowed = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, allowRejected: true }],
    });
    assert.equal(allowed.isError, false, allowed.text);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 1);
    assert.equal(allowed.payload.overriddenRejections[0].rejections[0].reason, "Not a quality upgrade for existing track file(s)");
  });
});

test("lidarr empty rejections ({} — null reason + default type, as live Lidarr serializes) are preserved structurally", async () => {
  await withServers({ lidarrCandidates: [{ ...LIDARR_CANDIDATE, rejections: [{}, { reason: "Has missing tracks", type: "permanent" }] }] }, async (port) => {
    const result = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId: LIDARR_DOWNLOAD_ID });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(result.payload.candidates[0].rejections, [
      { reason: null, type: null },
      { reason: "Has missing tracks", type: "permanent" },
    ]);
  });
});

test("lidarr duplicate-track safeguard: two files mapping the same track are refused", async () => {
  const second = { ...LIDARR_CANDIDATE, id: 334, path: "/downloads/complete/Some.Artist/Some.Artist - Some Album/01 - Track One copy.flac" };
  await withServers({ lidarrCandidates: [LIDARR_CANDIDATE, second] }, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [
        { candidateId: 333, trackIds: [501] },
        { candidateId: 334, trackIds: [501] },
      ],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /Track 501 is mapped to both/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

// --- upgrade assessment (existing-file quality comparison) ----------------

test("preview upgradeAssessment: no existing file -> no-existing-file", async () => {
  await withServers({}, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(result.isError, false, result.text);
    const a = result.payload.items[0].upgradeAssessment;
    assert.equal(a.verdict, "no-existing-file");
    const gets = requestsTo(logs.sonarr, "GET", "/api/v3/episode");
    assert.equal(gets.length, 1, "assessment queries the native episode endpoint (the only shape mapping files to episodes)");
    assert.equal(gets[0].params.seasonNumber, "6", "queries the mapped season");
  });
});

test("preview upgradeAssessment: Sonarr's 'not an upgrade' rejection is authoritative -> not-an-upgrade", async () => {
  await withServers(
    {
      sonarrEpisodesWithFiles: [{ id: 9001, hasFile: true, episodeFileId: 1 }],
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 0 }],
      reprocessRejections: [{ reason: "Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p. New Quality HDTV-720p.", type: "permanent" }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "not-an-upgrade");
      assert.match(a.note, /Do not import/);
    },
  );
});

test("preview upgradeAssessment: existing file + no upgrade rejection -> no-upgrade-rejection with file data (equal CF — Letterkenny case)", async () => {
  // Candidate 123: CF 10. Existing file: CF 10 (equal) — Sonarr surfaces no warning.
  await withServers(
    { sonarrEpisodesWithFiles: [{ id: 9001, hasFile: true, episodeFileId: 1 }], sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 10, qualityCutoffNotMet: false }] },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123 }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "no-upgrade-rejection");
      assert.equal(a.existingFiles.length, 1);
      assert.equal(a.existingFiles[0].customFormatScore, 10);
      assert.equal(a.existingFiles[0].quality, "WEBDL-1080p");
      assert.match(a.note, /NO upgrade rejection/);
    },
  );
});

test("preview upgradeAssessment: higher existing CF + 'Not a Custom Format upgrade' rejection -> not-an-upgrade (Link Click case)", async () => {
  await withServers(
    {
      sonarrEpisodesWithFiles: [{ id: 9001, hasFile: true, episodeFileId: 1 }],
      sonarrEpisodeFilesList: [{ id: 1, quality: QUALITY, customFormatScore: 100 }],
      reprocessRejections: [{ reason: "Not a Custom Format upgrade for existing episode file(s). New: [Bad Metadata] (-50) do not improve on Existing: [Original filesize, Proper] (10)", type: "permanent" }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 123 }],
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.payload.items[0].upgradeAssessment.verdict, "not-an-upgrade");
    },
  );
});

test("preview upgradeAssessment: multi-episode special file is found via the episode resource", async () => {
  const specialCandidate = {
    ...SONARR_CANDIDATE,
    id: 129,
    seasonNumber: 0,
    episodes: [{ id: 62640, seasonNumber: 0, episodeNumber: 22, title: "The Haunting of MoDean's II" }],
  };
  await withServers(
    {
      sonarrCandidates: [specialCandidate],
      sonarrEpisodesWithFiles: [{ id: 62640, hasFile: true, episodeFileId: 55 }],
      sonarrEpisodeFilesList: [{ id: 55, quality: QUALITY, customFormatScore: 600 }],
    },
    async (port) => {
      const result = await callTool(port, "sonarr_preview_manual_import", {
        downloadId: SONARR_DOWNLOAD_ID,
        items: [{ candidateId: 129, seasonNumber: 0, episodeIds: [62640] }],
      });
      assert.equal(result.isError, false, result.text);
      const a = result.payload.items[0].upgradeAssessment;
      assert.equal(a.verdict, "no-upgrade-rejection", "special's existing file found; no upgrade rejection");
      assert.equal(a.existingFiles[0].episodeId, 62640);
      assert.equal(a.existingFiles[0].customFormatScore, 600);
    },
  );
});

// --- 1. Sonarr/Radarr missing mapping: mappingRequired, never seriesId=0 --

test("sonarr preview of an unmapped candidate: mappingRequired, no native reprocess request", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 127, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [unmapped] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 127 }],
    });
    assert.equal(result.isError, false, result.text);
    const item = result.payload.items[0];
    assert.equal(item.canPreview, false);
    assert.equal(item.mappingRequired, true);
    assert.deepEqual(item.missing, ["seriesId"]);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "unmapped candidate must not be POSTed to /manualimport");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("sonarr execute of an unmapped candidate: refuses before any native request", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 127, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [unmapped] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 127 }],
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.payload.mappingRequired[0].missing, ["seriesId"]);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "no reprocess with a fabricated 0 seriesId");
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

test("sonarr preview mixes mapped and unmapped candidates: only mapped items are reprocessed", async () => {
  const unmapped = { ...SONARR_CANDIDATE, id: 128, series: null, seasonNumber: null, episodes: [] };
  await withServers({ sonarrCandidates: [SONARR_CANDIDATE, unmapped], reprocessRejections: [] }, async (port, logs) => {
    const result = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }, { candidateId: 128 }],
    });
    assert.equal(result.isError, false, result.text);
    const posts = requestsTo(logs.sonarr, "POST", "/api/v3/manualimport");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body.map((i) => i.id), [123], "only the mapped candidate is sent to the native endpoint");
    assert.ok(posts[0].body.every((i) => i.seriesId > 0), "no 0 seriesId in the payload");
    const byId = Object.fromEntries(result.payload.items.map((i) => [i.candidateId, i]));
    assert.equal(byId[123].canPreview, true);
    assert.equal(byId[128].mappingRequired, true);
  });
});

test("radarr preview/execute of an unmapped candidate: mappingRequired, no native reprocess", async () => {
  const unmapped = { ...RADARR_CANDIDATE, id: 224, movie: null };
  await withServers({ radarrCandidates: [unmapped] }, async (port, logs) => {
    const preview = await callTool(port, "radarr_preview_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 224 }],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.payload.items[0].canPreview, false);
    assert.deepEqual(preview.payload.items[0].missing, ["movieId"]);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/manualimport").length, 0);

    const exec = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 224 }],
    });
    assert.equal(exec.isError, true);
    assert.deepEqual(exec.payload.mappingRequired[0].missing, ["movieId"]);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/manualimport").length, 0, "no 0 movieId reprocess");
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/command").length, 0);
  });
});

test("a 0 seriesId/movieId override is refused at parse time", async () => {
  await withServers({}, async (port, logs) => {
    const s = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123, seriesId: 0 }],
    });
    assert.equal(s.isError, true);
    assert.match(s.text, /positive integer/);

    const r = await callTool(port, "radarr_execute_manual_import", {
      downloadId: "dl-11",
      items: [{ candidateId: 222, movieId: 0 }],
    });
    assert.equal(r.isError, true);
    assert.match(r.text, /positive integer/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0);
    assert.equal(requestsTo(logs.radarr, "POST", "/api/v3/manualimport").length, 0);
  });
});

// --- 2. Lidarr explicit track overrides survive reprocessing ---------------

test("lidarr explicit trackIds override is validated against the selected release and preserved into the command", async () => {
  // Lidarr maps the file to Track 501; the caller corrects it to Track 502,
  // a track of the SAME selected release (77).
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [502] }],
    });
    assert.equal(preview.isError, false, preview.text);
    const item = preview.payload.items[0];
    assert.equal(item.tracksSource, "caller-override");
    assert.deepEqual(item.tracks.map((t) => t.id), [502], "preview shows the corrected track, not Lidarr's recomputed 501");

    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [502] }],
    });
    assert.equal(result.isError, false, result.text);
    const command = requestsTo(logs.lidarr, "POST", "/api/v1/command")[0].body;
    assert.deepEqual(command.files[0].trackIds, [502], "the validated override reaches the native ManualImport command unchanged");
    const update = requestsTo(logs.lidarr, "POST", "/api/v1/manualimport")[0].body[0];
    assert.equal(update.trackIds, undefined, "tracks are not smuggled through the update endpoint");
    const trackGets = requestsTo(logs.lidarr, "GET", "/api/v1/track");
    assert.equal(trackGets.length, 2, "override validated against the release track list in preview and again in execute");
    assert.equal(trackGets[0].params.albumReleaseId, "77", "validation queries the selected album release, not the album");
  });
});

test("lidarr trackIds from a DIFFERENT release of the same album are refused before any command", async () => {
  // Track 503 belongs to album 9's release 78; the selected release is 77.
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [503] }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /not tracks of album release 77/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr trackIds from an unrelated album are refused before any command", async () => {
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const result = await callTool(port, "lidarr_execute_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [999] }],
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /not tracks of album release 77/);
    assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
  });
});

test("lidarr surfaces (does not authorize) candidate tracks outside the selected release's track query", async () => {
  // Release 77's track list is [501]; Lidarr's recomputed mapping includes
  // 502, which the release query does not contain. A valid override [501]
  // proceeds, and the inconsistency is reported — 502 is NOT added to the
  // caller allowlist.
  await withServers(
    { lidarrReleaseTracks: { 77: [501], 78: [503] }, lidarrRecomputedTracks: { 77: [501, 502] } },
    async (port, logs) => {
      const preview = await callTool(port, "lidarr_preview_manual_import", {
        downloadId: LIDARR_DOWNLOAD_ID,
        items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [501] }],
      });
      assert.equal(preview.isError, false, preview.text);
      assert.deepEqual(preview.payload.items[0].releaseTrackMismatch, [502], "candidate track outside the release query is surfaced");
      assert.match(JSON.stringify(preview.payload.notes), /Inconsistency surfaced/);

      // The surfaced track is not an authorization target: overriding to 502
      // is refused even though Lidarr's recomputed mapping contains it.
      const bad = await callTool(port, "lidarr_execute_manual_import", {
        downloadId: LIDARR_DOWNLOAD_ID,
        items: [{ candidateId: 333, artistId: 5, albumId: 9, albumReleaseId: 77, trackIds: [502] }],
      });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /not tracks of album release 77/);
      assert.equal(requestsTo(logs.lidarr, "POST", "/api/v1/command").length, 0);
    },
  );
});

test("lidarr without trackIds uses Lidarr's recomputed mapping (tracksSource=lidarr-recomputed)", async () => {
  await withServers({ lidarrReleaseTracks: { 77: [501, 502], 78: [503] } }, async (port, logs) => {
    const preview = await callTool(port, "lidarr_preview_manual_import", {
      downloadId: LIDARR_DOWNLOAD_ID,
      items: [{ candidateId: 333 }],
    });
    assert.equal(preview.isError, false, preview.text);
    assert.equal(preview.payload.items[0].tracksSource, "lidarr-recomputed");
    assert.deepEqual(preview.payload.items[0].tracks.map((t) => t.id), [501, 502], "server-recomputed release tracks shown as-is");
  });
});

// --- 4. candidate id ambiguity ---------------------------------------------

test("ambiguous candidateId (hash collision: two current candidates share an id) is refused", async () => {
  const twin = { ...SONARR_CANDIDATE, path: "/downloads/complete/The.Good.Fight/The.Good.Fight.S06E05.1080p.mkv", name: "The.Good.Fight.S06E05.1080p" };
  await withServers({ sonarrCandidates: [SONARR_CANDIDATE, twin] }, async (port, logs) => {
    const preview = await callTool(port, "sonarr_preview_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(preview.isError, true);
    assert.match(preview.text, /matches 2 current manual-import candidates/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/manualimport").length, 0, "ambiguous id must not be reprocessed");

    const exec = await callTool(port, "sonarr_execute_manual_import", {
      downloadId: SONARR_DOWNLOAD_ID,
      items: [{ candidateId: 123 }],
    });
    assert.equal(exec.isError, true);
    assert.match(exec.text, /matches 2 current manual-import candidates/);
    assert.equal(requestsTo(logs.sonarr, "POST", "/api/v3/command").length, 0);
  });
});

// --- 17. queue functionality unaffected -----------------------------------

test("queue tools keep working alongside the manual-import tools", async () => {
  await withServers({}, async (port) => {
    const queue = await callTool(port, "sonarr_get_queue", {});
    assert.equal(queue.isError, false, queue.text);
    assert.ok(Array.isArray(queue.payload.items));

    const status = await callTool(port, "arr_status", {});
    assert.equal(status.isError, false, status.text);
  });
});
