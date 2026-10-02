import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { SonarrClient } from "../dist/arr-client.js";

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
const SONARR_RECORD = {
  id: 123,
  seriesId: 7,
  episodeId: 456,
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
  episode: { id: 456, seriesId: 7, seasonNumber: 6 },
  series: { id: 7, title: "The Good Fight" },
};

const DOWNLOADING_RECORD = {
  id: 124,
  seriesId: 7,
  episodeId: 457,
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
  episode: { id: 457, seriesId: 7, seasonNumber: 1 },
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
    assert.equal(item.seasonNumber, 6, "seasonNumber comes from the embedded episode resource");

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

test("radarr_get_queue: movieId and statusMessages preserved", async () => {
  const radarrRecord = {
    ...SONARR_RECORD,
    id: 222,
    seriesId: null,
    episodeId: null,
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
    assert.ok(!("seasonNumber" in item), "no embedded episode means no seasonNumber");
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
