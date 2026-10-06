import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { LidarrClient, RadarrClient, SonarrClient } from "../dist/arr-client.js";

// ---------------------------------------------------------------------------
// Client-level test: getQueue() passes native queue records through intact.
// ---------------------------------------------------------------------------

test("ArrClient.getQueue: native records (incl. statusMessages) pass through unmodified", async () => {
  const nativePage = {
    totalRecords: 1,
    records: [
      {
        id: 123,
        title: "The.Good.Fight.S06",
        status: "Completed",
        seriesId: 7,
        episodeId: 456,
        size: 0,
        sizeLeft: 0,
        downloadId: "abc123",
        outputPath: "/downloads/complete/The.Good.Fight",
        indexerId: 3,
        indexer: "ExampleIndexer",
        trackedDownloadStatus: "warning",
        trackedDownloadState: "importPending",
        statusMessages: [
          { title: "S06E02.mkv.partial.mkv", messages: ["Episode file already imported at 9/24/2026 9:52:02AM", "Not a Custom Format upgrade for existing episode file(s). New: [NTB] (600) do not improve on Existing: [NTB, Proper] (610)"] },
          { title: "S06E03.mkv", messages: ["Unable to determine if file is a sample"] },
        ],
      },
    ],
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(nativePage), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const client = new SonarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    const page = await client.getQueue();
    assert.equal(page.totalRecords, 1);
    assert.deepEqual(page.records[0].statusMessages, nativePage.records[0].statusMessages);
    assert.equal(page.records[0].downloadId, "abc123");
    assert.equal(page.records[0].indexer, "ExampleIndexer");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// MCP-level tests: run the real server (HTTP transport) against a stub *arr
// app and call the queue tools end to end. Verifies that the diagnostic
// fields supplied by the native queue API survive the MCP-level mapping.
// ---------------------------------------------------------------------------

// Sonarr and Radarr share the /api/v3/queue path, so the stub answers every
// service with the same superset record set; the mapping must expose the
// identifiers each service's native API supplies.
//
// Shape note: `getQueue()` never requests embedded episode resources, and the
// native Sonarr queue resource carries `seasonNumber` at the TOP level. This
// fixture therefore has no `episode` object — a real Sonarr response does not.
const SONARR_RECORD = {
  id: 123,
  seriesId: 7,
  episodeId: 456,
  seasonNumber: 6,
  status: "Completed",
  size: 0,
  sizeleft: 0,
  title: "The.Good.Fight.S06",
  downloadId: "abc123",
  added: "2026-09-24T09:00:00Z",
  statusMessages: [
    {
      title: "The.Good.Fight.S06E02.1080p.AMZN.WEB-DL-NTb.mkv.partial.mkv",
      messages: [
        "Episode file already imported at 9/24/2026 9:52:02AM",
        "Not a Custom Format upgrade for existing episode file(s). New: [NTB] (600) do not improve on Existing: [NTB, Proper] (610)",
      ],
    },
    {
      title: "The.Good.Fight.S06E03.1080p.AMZN.WEB-DL-NTb.mkv",
      messages: ["Unable to determine if file is a sample"],
    },
  ],
  trackedDownloadStatus: "warning",
  trackedDownloadState: "importPending",
  timeleft: "00:00:00",
  outputPath: "/downloads/complete/The.Good.Fight",
  protocol: "torrent",
  downloadClient: "qBittorrent",
  indexerId: 3,
  indexer: "ExampleIndexer",
  series: { id: 7, title: "The Good Fight" },
};

const DOWNLOADING_RECORD = {
  id: 124,
  seriesId: 7,
  episodeId: 457,
  seasonNumber: 1,
  status: "Downloading",
  size: 1000,
  sizeleft: 250,
  title: "Some.Show.S01E01",
  downloadId: "dl-124",
  statusMessages: [],
  trackedDownloadStatus: "ok",
  trackedDownloadState: "downloading",
  timeleft: "00:10:00",
  outputPath: "",
  protocol: "torrent",
  downloadClient: "qBittorrent",
  indexerId: 4,
  indexer: "OtherIndexer",
};

// Uses the camelCase sizeLeft spelling (Sonarr/Radarr v3) with no `sizeleft`.
const SIZELEFT_CAMEL_RECORD = {
  id: 125,
  status: "Downloading",
  size: 1000,
  sizeLeft: 500,
  title: "Camel.SizeLeft.Show",
  statusMessages: [],
  trackedDownloadStatus: "ok",
  trackedDownloadState: "downloading",
};

// Minimal record: none of the diagnostic fields present at all.
const MINIMAL_RECORD = {
  id: 1,
  title: "Unknown Item",
  status: "Unknown",
  size: 0,
  sizeleft: 0,
  trackedDownloadStatus: "none",
  trackedDownloadState: "completed",
};

function startStubArrApp(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, params: url.searchParams });
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(url)));
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
  });
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
  assert.equal(body.error, undefined, `tools/call ${name} must not error: ${JSON.stringify(body.error)}`);
  assert.notEqual(body.result.isError, true, `tools/call ${name} must not report an MCP error`);
  const payload = JSON.parse(body.result.content[0].text);
  assert.ok(Array.isArray(payload.items), `tools/call ${name} must return queue items: ${body.result.content[0].text}`);
  return payload;
}

// Boots the real MCP server (HTTP transport) against a stub *arr app whose
// queue responses are produced by `handler`, runs `fn`, then tears everything down.
async function withServer(handler, fn) {
  const port = String(33000 + Math.floor(Math.random() * 1000));
  const { server: stub, requests } = await startStubArrApp(handler);
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
      SONARR_URL: stubBase,
      SONARR_API_KEY: "sonarr-key",
      RADARR_URL: stubBase,
      RADARR_API_KEY: "radarr-key",
      LIDARR_URL: stubBase,
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
    await fn(port, requests);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    stub.close();
  }
}

function queuePageHandler(records, totalRecords = records.length) {
  return () => ({ records, totalRecords });
}

test("sonarr_get_queue: statusMessages survive mapping with structure intact", async () => {
  await withServer(queuePageHandler([SONARR_RECORD]), async (port) => {
    const result = await callTool(port, "sonarr_get_queue", {});
    const item = result.items[0];

    // Multiple groups, each with its own title; multiple messages under one
    // filename; arrays kept as arrays (not flattened into a string).
    assert.equal(item.statusMessages.length, 2);
    assert.equal(item.statusMessages[0].title, SONARR_RECORD.statusMessages[0].title);
    assert.deepEqual(item.statusMessages[0].messages, SONARR_RECORD.statusMessages[0].messages);
    assert.equal(item.statusMessages[0].messages.length, 2);
    assert.deepEqual(item.statusMessages[1].messages, ["Unable to determine if file is a sample"]);
    assert.ok(Array.isArray(item.statusMessages[0].messages), "messages must stay structured");

    // Diagnostic fields.
    assert.equal(item.downloadId, "abc123");
    assert.equal(item.outputPath, "/downloads/complete/The.Good.Fight");
    assert.equal(item.indexer, "ExampleIndexer");
    assert.equal(item.indexerId, 3);
    assert.equal(item.errorMessage, null, "errorMessage defaults to null when the API omits it");

    // Service-specific identifiers supplied by the native API.
    assert.equal(item.seriesId, 7);
    assert.equal(item.episodeId, 456);
    assert.equal(item.seasonNumber, 6, "seasonNumber comes from the native top-level queue field, with no embedded episode in the response");

    // Existing fields must remain present and unchanged.
    assert.equal(item.id, 123);
    assert.equal(item.title, "The.Good.Fight.S06");
    assert.equal(item.status, "Completed");
    assert.equal(item.timeLeft, "00:00:00");
    assert.equal(item.downloadClient, "qBittorrent");
    assert.equal(item.protocol, "torrent");
    assert.equal(item.trackedDownloadStatus, "warning");
    assert.equal(item.trackedDownloadState, "importPending");
    assert.equal(item.progress, "unknown", "size 0 keeps the existing 'unknown' progress");
  });
});

test("sonarr_get_queue: top-level seasonNumber is preferred, embedded episode is only the fallback", async () => {
  // The native shape: top-level only, no embedded episode.
  await withServer(queuePageHandler([{ ...SONARR_RECORD, seasonNumber: 6 }]), async (port) => {
    const result = await callTool(port, "sonarr_get_queue", {});
    assert.equal(result.items[0].seasonNumber, 6);
  });

  // Compatibility fallback: a response that carries only the nested value.
  await withServer(queuePageHandler([{
    ...SONARR_RECORD,
    seasonNumber: null,
    episode: { id: 456, seriesId: 7, seasonNumber: 3 },
  }]), async (port) => {
    const result = await callTool(port, "sonarr_get_queue", {});
    assert.equal(result.items[0].seasonNumber, 3, "the nested episode value is used when the top-level field is absent");
  });

  // Precedence: when both are present, the top-level native field wins.
  await withServer(queuePageHandler([{
    ...SONARR_RECORD,
    seasonNumber: 6,
    episode: { id: 456, seriesId: 7, seasonNumber: 3 },
  }]), async (port) => {
    const result = await callTool(port, "sonarr_get_queue", {});
    assert.equal(result.items[0].seasonNumber, 6, "the top-level field must win over the embedded fallback");
  });
});

test("radarr_get_queue: movieId and statusMessages preserved", async () => {
  const radarrRecord = {
    ...SONARR_RECORD,
    id: 222,
    seriesId: null,
    episodeId: null,
    seasonNumber: null,
    movieId: 11,
    title: "Some.Movie.2026",
    episode: null,
    series: null,
    movie: { id: 11, title: "Some Movie" },
  };
  await withServer(queuePageHandler([radarrRecord]), async (port) => {
    const result = await callTool(port, "radarr_get_queue", {});
    const item = result.items[0];
    assert.equal(item.movieId, 11);
    assert.ok(!("seriesId" in item), "null seriesId from the API must not be fabricated");
    assert.ok(!("episodeId" in item), "null episodeId from the API must not be fabricated");
    assert.ok(!("seasonNumber" in item), "Radarr's queue resource supplies no season data, so seasonNumber must not be fabricated");
    assert.deepEqual(item.statusMessages, radarrRecord.statusMessages);
    assert.equal(item.downloadId, "abc123");
    assert.equal(item.indexer, "ExampleIndexer");
    assert.equal(item.trackedDownloadState, "importPending");
  });
});

test("lidarr_get_queue: artistId/albumId and statusMessages preserved", async () => {
  const lidarrRecord = {
    ...SONARR_RECORD,
    id: 333,
    seriesId: null,
    episodeId: null,
    seasonNumber: null,
    artistId: 5,
    albumId: 9,
    title: "Some.Artist.Album",
    episode: null,
    series: null,
    artist: { id: 5, artistName: "Some Artist" },
    album: { id: 9, title: "Some Album" },
  };
  await withServer(queuePageHandler([lidarrRecord]), async (port) => {
    const result = await callTool(port, "lidarr_get_queue", {});
    const item = result.items[0];
    assert.equal(item.artistId, 5);
    assert.equal(item.albumId, 9);
    assert.ok(!("movieId" in item), "movieId must not be fabricated when absent");
    assert.deepEqual(item.statusMessages, lidarrRecord.statusMessages);
    assert.equal(item.outputPath, "/downloads/complete/The.Good.Fight");
    assert.equal(item.downloadClient, "qBittorrent");
  });
});

test("queue mapping tolerates missing diagnostic fields (no errors, null defaults)", async () => {
  await withServer(queuePageHandler([MINIMAL_RECORD]), async (port) => {
    const result = await callTool(port, "sonarr_get_queue", {});
    const item = result.items[0];
    assert.deepEqual(item.statusMessages, []);
    assert.equal(item.errorMessage, null);
    assert.equal(item.downloadId, null);
    assert.equal(item.outputPath, null);
    assert.equal(item.indexer, null);
    assert.equal(item.indexerId, null);
    for (const key of ["seriesId", "episodeId", "seasonNumber", "movieId", "artistId", "albumId"]) {
      assert.ok(!(key in item), `${key} must be absent when the API does not supply it`);
    }
    // Existing fields still work.
    assert.equal(item.id, 1);
    assert.equal(item.title, "Unknown Item");
    assert.equal(item.progress, "unknown");
  });
});

test("queue mapping computes progress from camelCase sizeLeft (Sonarr/Radarr v3 spelling)", async () => {
  await withServer(queuePageHandler([SIZELEFT_CAMEL_RECORD]), async (port) => {
    const result = await callTool(port, "radarr_get_queue", {});
    const item = result.items[0];
    assert.equal(item.progress, "50.0%");
  });
});

test("pagination semantics unchanged: limit/offset slice MCP-side over full native fetch", async () => {
  const records = [SONARR_RECORD, DOWNLOADING_RECORD, MINIMAL_RECORD];
  await withServer(queuePageHandler(records), async (port) => {
    const first = await callTool(port, "sonarr_get_queue", { limit: 2, offset: 0 });
    assert.equal(first.total, 3);
    assert.equal(first.returned, 2);
    assert.equal(first.offset, 0);
    assert.equal(first.limit, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 2);
    assert.deepEqual(first.items.map((i) => i.id), [123, 124]);

    const last = await callTool(port, "sonarr_get_queue", { limit: 2, offset: 2 });
    assert.equal(last.total, 3);
    assert.equal(last.returned, 1);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextOffset, null);
    assert.equal(last.items[0].id, 1);
  });
});

test("pagination fetches every native page before slicing", async () => {
  const makeRecord = (n) => ({
    ...MINIMAL_RECORD,
    id: n,
    title: `Item ${n}`,
    statusMessages: [{ title: `file-${n}.mkv`, messages: [`message ${n}`] }],
  });
  const handler = (url) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    const totalRecords = 150;
    const start = (page - 1) * 100;
    const count = Math.min(100, totalRecords - start);
    return {
      records: Array.from({ length: count }, (_, i) => makeRecord(start + i + 1)),
      totalRecords,
    };
  };
  await withServer(handler, async (port, requests) => {
    const result = await callTool(port, "sonarr_get_queue", { limit: 10, offset: 100 });
    assert.equal(result.total, 150);
    assert.equal(result.returned, 10);
    assert.deepEqual(result.items.map((i) => i.id), Array.from({ length: 10 }, (_, i) => 101 + i));
    assert.deepEqual(result.items[0].statusMessages, [{ title: "file-101.mkv", messages: ["message 101"] }]);
    const queueGets = requests.filter((r) => r.method === "GET" && r.path.endsWith("/queue"));
    assert.equal(queueGets.length, 2, "both native pages must be fetched");
  });
});

test("queue results never leak API keys", async () => {
  await withServer(queuePageHandler([SONARR_RECORD, DOWNLOADING_RECORD]), async (port) => {
    const result = await callTool(port, "sonarr_get_queue", {});
    assert.doesNotMatch(JSON.stringify(result), /sonarr-key|radarr-key|lidarr-key/);
  });
});

// ---------------------------------------------------------------------------
// Native-filtering regressions: service-specific queue inclusion flags.
//
// Each native queue API hides tracked downloads it has not matched to a
// series/movie/artist UNLESS its service-specific inclusion flag is sent, and
// the filter runs BEFORE pagination and before totalRecords. The stubs below
// reproduce that native filter, so omitting the flag makes the unidentified
// records disappear — exactly the defect this patch fixes. Sonarr and Radarr
// share /api/v3/queue, so each service gets its own stub/base URL and reads
// ONLY its own predetermined flag: a Sonarr flag can never satisfy a Radarr
// stub (or vice versa).
// ---------------------------------------------------------------------------

const FLAG_BY_SERVICE = {
  sonarr: "includeUnknownSeriesItems",
  radarr: "includeUnknownMovieItems",
  lidarr: "includeUnknownArtistItems",
};
const SERVICES = ["sonarr", "radarr", "lidarr"];

const SERVICE_QUEUE_CONTRACT = [
  { label: "SonarrClient", Client: SonarrClient, endpoint: "/api/v3/queue", flag: "includeUnknownSeriesItems", foreignFlags: ["includeUnknownMovieItems", "includeUnknownArtistItems"] },
  { label: "RadarrClient", Client: RadarrClient, endpoint: "/api/v3/queue", flag: "includeUnknownMovieItems", foreignFlags: ["includeUnknownSeriesItems", "includeUnknownArtistItems"] },
  { label: "LidarrClient", Client: LidarrClient, endpoint: "/api/v1/queue", flag: "includeUnknownArtistItems", foreignFlags: ["includeUnknownSeriesItems", "includeUnknownMovieItems"] },
];

// A. Client request contract — table-driven, one assertion set per client.
for (const contract of SERVICE_QUEUE_CONTRACT) {
  test(`${contract.label}.getQueue sends ${contract.flag}="true" on every page and omits the other services' flags`, async () => {
    const original = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(new URL(url.toString()));
      return new Response(JSON.stringify({ records: [], totalRecords: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const client = new contract.Client({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
      await client.getQueue(2, 50); // non-default page/pageSize
      await client.getQueue(); // the default page (1 / 100)
      assert.equal(requested.length, 2, "both native pages must have been requested");
      for (const u of requested) {
        assert.equal(u.pathname, contract.endpoint, `${contract.label} must hit ${contract.endpoint}`);
        assert.equal(u.searchParams.get(contract.flag), "true", `${contract.flag} must literally equal "true" on every page`);
        for (const foreign of contract.foreignFlags) {
          assert.equal(u.searchParams.get(foreign), null, `${contract.label} must not send ${foreign}`);
        }
      }
      assert.equal(requested[0].searchParams.get("page"), "2");
      assert.equal(requested[0].searchParams.get("pageSize"), "50");
      assert.equal(requested[1].searchParams.get("page"), "1");
      assert.equal(requested[1].searchParams.get("pageSize"), "100");
    } finally {
      globalThis.fetch = original;
    }
  });
}

// Emulate the native queue filter: unidentified records are dropped (from the
// page AND from totalRecords) when the service's own inclusion flag is absent.
function filteringHandler({ flag, pool }) {
  return (url) => {
    const includeUnknown = url.searchParams.get(flag) === "true";
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("pageSize") ?? "100");
    const visible = (includeUnknown ? pool : pool.filter((e) => e.identified)).map((e) => e.record);
    const totalRecords = visible.length;
    const start = (page - 1) * pageSize;
    return { records: visible.slice(start, start + pageSize), totalRecords };
  };
}

// Boot the real MCP server with one distinct stub per service so each stub
// enforces only its own service's flag.
async function withPerServiceServer(handlers, fn) {
  const port = String(33000 + Math.floor(Math.random() * 1000));
  const stubs = {};
  const requestLogs = {};
  for (const svc of SERVICES) {
    const { server, requests } = await startStubArrApp(handlers[svc]);
    stubs[svc] = server;
    requestLogs[svc] = requests;
  }
  const base = (svc) => `http://127.0.0.1:${stubs[svc].address().port}`;

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
      SONARR_URL: base("sonarr"),
      SONARR_API_KEY: "sonarr-key",
      RADARR_URL: base("radarr"),
      RADARR_API_KEY: "radarr-key",
      LIDARR_URL: base("lidarr"),
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
    await fn(port, requestLogs);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
    for (const svc of SERVICES) stubs[svc].close();
  }
}

function handlersFor(targetService, targetPool) {
  const handlers = {};
  for (const svc of SERVICES) {
    handlers[svc] = filteringHandler({ flag: FLAG_BY_SERVICE[svc], pool: svc === targetService ? targetPool : [] });
  }
  return handlers;
}

const RECOGNIZED_IDENTITY = {
  sonarr: { seriesId: 7, episodeId: 456, seasonNumber: 6 },
  radarr: { movieId: 11 },
  lidarr: { artistId: 5, albumId: 9 },
};
const RECOGNIZED_EXPECT = {
  sonarr: { seriesId: 7, episodeId: 456 },
  radarr: { movieId: 11 },
  lidarr: { artistId: 5, albumId: 9 },
};
const ALL_ENTITY_KEYS = ["seriesId", "episodeId", "seasonNumber", "movieId", "artistId", "albumId"];

function unidentifiedRecord(id, title, downloadId, message) {
  return {
    id,
    title,
    status: "Completed",
    size: 2000,
    sizeleft: 0,
    downloadId,
    statusMessages: [{ title: `${title}.mkv`, messages: [message] }],
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importPending",
    timeleft: "00:00:00",
    outputPath: `/downloads/${downloadId}`,
    protocol: "torrent",
    downloadClient: "qBittorrent",
    seriesId: null,
    episodeId: null,
    seasonNumber: null,
    movieId: null,
    artistId: null,
    albumId: null,
    series: null,
    episode: null,
    movie: null,
    artist: null,
    album: null,
  };
}

function visibilityPool(service) {
  const recognized = {
    id: 10,
    title: `Recognized.${service}`,
    status: "Completed",
    size: 1000,
    sizeleft: 0,
    downloadId: `DL-REC-${service}`,
    statusMessages: [{ title: "recognized.mkv", messages: ["Already imported"] }],
    trackedDownloadStatus: "ok",
    trackedDownloadState: "completed",
    timeleft: "00:00:00",
    outputPath: "/downloads/recognized",
    protocol: "torrent",
    downloadClient: "qBittorrent",
    ...RECOGNIZED_IDENTITY[service],
  };
  return [
    { record: recognized, identified: true },
    { record: unidentifiedRecord(11, "Unidentified.Release.Alpha", "DL-UNK-A", "Unable to determine if file is a sample"), identified: false },
    { record: unidentifiedRecord(12, "Unidentified.Release.Beta", "DL-UNK-B", "Release not matched to any library item"), identified: false },
  ];
}

// B. MCP-level visibility — table-driven across all three services.
for (const service of SERVICES) {
  test(`${service}_get_queue: unidentified tracked downloads are included by default (native filter emulated)`, async () => {
    await withPerServiceServer(handlersFor(service, visibilityPool(service)), async (port) => {
      const result = await callTool(port, `${service}_get_queue`, {});
      assert.equal(result.total, 3, `${service}: the two unidentified records must be counted when the flag is sent`);
      assert.equal(result.returned, 3, `${service}: the requested window includes all three records`);
      assert.deepEqual([...result.items.map((i) => i.id)].sort((a, b) => a - b), [10, 11, 12]);

      const byId = Object.fromEntries(result.items.map((i) => [i.id, i]));
      for (const [id, downloadId, title, message] of [
        [11, "DL-UNK-A", "Unidentified.Release.Alpha", "Unable to determine if file is a sample"],
        [12, "DL-UNK-B", "Unidentified.Release.Beta", "Release not matched to any library item"],
      ]) {
        const item = byId[id];
        assert.ok(item, `unidentified queue id ${id} must be present`);
        assert.equal(item.downloadId, downloadId, "unidentified downloadId must survive unchanged");
        assert.equal(item.title, title, "unidentified release title must survive unchanged");
        assert.deepEqual(item.statusMessages[0].messages, [message], "unidentified diagnostics must survive unchanged");
        assert.equal(item.trackedDownloadState, "importPending");
        assert.equal(item.outputPath, `/downloads/${downloadId}`);
        for (const key of ALL_ENTITY_KEYS) {
          assert.ok(!(key in item), `${key} must not be fabricated for an unidentified entry`);
        }
      }

      // The recognized entry stays correctly mapped.
      const rec = byId[10];
      for (const [key, value] of Object.entries(RECOGNIZED_EXPECT[service])) {
        assert.equal(rec[key], value, `recognized ${key} must remain mapped`);
      }
      assert.equal(rec.downloadId, `DL-REC-${service}`);
    });
  });
}

function crossPagePool(service) {
  const pool = Array.from({ length: 100 }, (_, i) => ({
    record: {
      id: i + 1,
      title: `Recognized.${i + 1}`,
      status: "Completed",
      size: 0,
      sizeleft: 0,
      downloadId: `REC-${i + 1}`,
      statusMessages: [],
      trackedDownloadStatus: "ok",
      trackedDownloadState: "completed",
      ...RECOGNIZED_IDENTITY[service],
    },
    identified: true,
  }));
  pool.push({ record: unidentifiedRecord(101, "Unidentified.Page2.Alpha", "DL-P2-A", "Not matched on page two"), identified: false });
  pool.push({ record: unidentifiedRecord(102, "Unidentified.Page2.Beta", "DL-P2-B", "Artist not found (page two)"), identified: false });
  return pool;
}

// C. Unidentified entries beyond native page 1 — exercise the native page
// boundary with filtering applied before pagination.
for (const service of SERVICES) {
  test(`${service}_get_queue: unidentified entries on native page 2 survive cross-page pagination`, async () => {
    await withPerServiceServer(handlersFor(service, crossPagePool(service)), async (port, requestLogs) => {
      const result = await callTool(port, `${service}_get_queue`, { offset: 99, limit: 3 });
      assert.equal(result.total, 102, "the native total includes the two unidentified records");
      assert.equal(result.returned, 3);
      assert.deepEqual([...result.items.map((i) => i.id)].sort((a, b) => a - b), [100, 101, 102], "one recognized plus both page-2 unidentified entries");
      assert.equal(result.hasMore, false);
      assert.equal(result.nextOffset, null);

      const byId = Object.fromEntries(result.items.map((i) => [i.id, i]));
      assert.equal(byId[101].downloadId, "DL-P2-A");
      assert.equal(byId[102].downloadId, "DL-P2-B");
      assert.equal(byId[100].downloadId, "REC-100", "the recognized boundary record stays mapped");

      const queueGets = requestLogs[service].filter((r) => r.method === "GET" && r.path.endsWith("/queue"));
      assert.equal(queueGets.length, 2, "both native pages must be requested");
      for (const r of queueGets) {
        assert.equal(r.params.get(FLAG_BY_SERVICE[service]), "true", "every native page must carry the service-specific flag");
      }
    });
  });
}

