import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { SonarrClient, RadarrClient, LidarrClient } from "../dist/arr-client.js";

// ---------------------------------------------------------------------------
// Client-level tests: stub fetch and inspect the request each client makes.
//
// Serialization contract: an option the caller supplies is transmitted with
// its literal value; an option the caller omits is left out of the query.
// Omission is NOT the same as false — the native apps default removeFromClient
// to true, so an explicit false must appear in the query.
// ---------------------------------------------------------------------------

function stubFetch(status = 204, body = "") {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : body, {
      status,
      body: status === 204 ? null : body,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function queuePathOf(url) {
  return new URL(url).pathname;
}

function paramsOf(url) {
  return new URL(url).searchParams;
}

const CLIENTS = [
  ["sonarr", SonarrClient, "/api/v3/queue"],
  ["radarr", RadarrClient, "/api/v3/queue"],
  ["lidarr", LidarrClient, "/api/v1/queue"],
];

test("sonarr_delete_queue_item: DELETE /api/v3/queue/{id} with all params", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = new SonarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    await client.deleteQueueItem(123, {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: true,
      changeCategory: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(queuePathOf(calls[0].url), "/api/v3/queue/123");
    const params = paramsOf(calls[0].url);
    assert.equal(params.get("removeFromClient"), "true");
    assert.equal(params.get("blocklist"), "true");
    assert.equal(params.get("skipRedownload"), "true");
    assert.equal(params.get("changeCategory"), "true");
    assert.equal(calls[0].init.headers["X-Api-Key"], "test-key");
  } finally {
    restore();
  }
});

test("lidarr_delete_queue_item: DELETE /api/v1/queue/{id} with all params", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = new LidarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    await client.deleteQueueItem(456, {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: true,
      changeCategory: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(queuePathOf(calls[0].url), "/api/v1/queue/456");
    const params = paramsOf(calls[0].url);
    assert.equal(params.get("removeFromClient"), "true");
    assert.equal(params.get("blocklist"), "true");
    assert.equal(params.get("skipRedownload"), "true");
    assert.equal(params.get("changeCategory"), "true");
  } finally {
    restore();
  }
});

test("radarr_delete_queue_item: endpoint and legacy options unchanged", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = new RadarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    await client.deleteQueueItem(789, { removeFromClient: true, blocklist: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(queuePathOf(calls[0].url), "/api/v3/queue/789");
    const params = paramsOf(calls[0].url);
    assert.equal(params.get("removeFromClient"), "true");
    assert.equal(params.get("blocklist"), "true");
    assert.equal(params.get("skipRedownload"), null, "unspecified options stay out of the query");
    assert.equal(params.get("changeCategory"), null);
  } finally {
    restore();
  }
});

test("deleteQueueItem: empty options send no query params (client-level defaults are the app's)", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = new SonarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    await client.deleteQueueItem(42);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:2999/api/v3/queue/42");
  } finally {
    restore();
  }
});

test("deleteQueueItem: removeFromClient=false is transmitted as false, never omitted", async () => {
  for (const [name, Client, path] of CLIENTS) {
    const { calls, restore } = stubFetch();
    try {
      const client = new Client({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
      await client.deleteQueueItem(7, { removeFromClient: false });
      assert.equal(calls.length, 1, `${name}: exactly one request`);
      assert.equal(queuePathOf(calls[0].url), `${path}/7`);
      const params = paramsOf(calls[0].url);
      assert.equal(
        params.get("removeFromClient"),
        "false",
        `${name}: removeFromClient=false must reach the app as an explicit false; omitting it means the app's true default and deletes the client-side download`,
      );
    } finally {
      restore();
    }
  }
});

test("deleteQueueItem: removeFromClient=true is transmitted as true", async () => {
  for (const [name, Client] of CLIENTS) {
    const { calls, restore } = stubFetch();
    try {
      const client = new Client({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
      await client.deleteQueueItem(7, { removeFromClient: true });
      const params = paramsOf(calls[0].url);
      assert.equal(params.get("removeFromClient"), "true", `${name}: explicit true must be sent as true`);
    } finally {
      restore();
    }
  }
});

test("deleteQueueItem: every supplied option keeps its own value; unspecified ones stay omitted", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = new RadarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    await client.deleteQueueItem(7, {
      removeFromClient: false,
      blocklist: true,
      skipRedownload: false,
      changeCategory: true,
    });
    const params = paramsOf(calls[0].url);
    assert.equal(params.get("removeFromClient"), "false");
    assert.equal(params.get("blocklist"), "true");
    assert.equal(params.get("skipRedownload"), "false");
    assert.equal(params.get("changeCategory"), "true");
  } finally {
    restore();
  }
});

test("deleteQueueItem: all-false is transmitted as all-false", async () => {
  const { calls, restore } = stubFetch();
  try {
    const client = new LidarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    await client.deleteQueueItem(7, {
      removeFromClient: false,
      blocklist: false,
      skipRedownload: false,
      changeCategory: false,
    });
    const params = paramsOf(calls[0].url);
    for (const key of ["removeFromClient", "blocklist", "skipRedownload", "changeCategory"]) {
      assert.equal(params.get(key), "false", `${key} must be sent as an explicit false`);
    }
  } finally {
    restore();
  }
});

test("request(): empty 204 response body does not throw (queue DELETE shape)", async () => {
  const { calls, restore } = stubFetch(204);
  try {
    const client = new SonarrClient({ url: "http://127.0.0.1:2999", apiKey: "test-key" });
    await assert.doesNotReject(client.deleteQueueItem(1, { removeFromClient: true }));
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// MCP-level tests: run the real server (HTTP transport) against a stub *arr
// app and call the tools end to end. Verifies tool registration, handler
// routing to the right client, MCP-level defaults, param propagation, and that
// the native request never disagrees with what the MCP response reports.
// ---------------------------------------------------------------------------

function startStubArrApp() {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, params: url.searchParams });
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        records: [{ id: 123, title: "Item", status: "downloading", size: 100, sizeleft: 50 }],
        totalRecords: 1,
      }));
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
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

// The streamable-HTTP transport answers with either JSON or an SSE stream
// depending on the Accept header; normalize both to the JSON-RPC envelope.
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
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.success, true);
  return payload;
}

// Boots the real MCP server against the stub *arr app, runs `fn`, then tears
// everything down. `requests` records every HTTP call the stub received.
async function withServer(fn) {
  const port = String(33000 + Math.floor(Math.random() * 1000));
  const { server: stub, requests } = await startStubArrApp();
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

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

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

  assert.doesNotMatch(stderr, /Fatal error/);
}

function lastDelete(requests) {
  return requests.filter((r) => r.method === "DELETE").at(-1);
}

test("MCP handlers route to the correct client, apply defaults, propagate params", async () => {
  await withServer(async (port, requests) => {
    const toolsResponse = await postMcp(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(toolsResponse.status, 200);
    const tools = (await mcpEnvelope(toolsResponse)).result.tools.map((t) => t.name);
    for (const name of ["sonarr_delete_queue_item", "radarr_delete_queue_item", "lidarr_delete_queue_item"]) {
      assert.ok(tools.includes(name), `${name} must be registered`);
    }

    // Defaults: only queueId provided → removeFromClient=true, the rest false.
    // The handler passes its explicit defaults through, so the native request
    // carries all four parameters with exactly the values the response reports.
    const sonarrDefaults = await callTool(port, "sonarr_delete_queue_item", { queueId: 123 });
    assert.deepEqual(
      { removedFromClient: sonarrDefaults.removedFromClient, blocklisted: sonarrDefaults.blocklisted, skipRedownload: sonarrDefaults.skipRedownload, changeCategory: sonarrDefaults.changeCategory },
      { removedFromClient: true, blocklisted: false, skipRedownload: false, changeCategory: false },
    );
    let deleteReq = lastDelete(requests);
    assert.equal(deleteReq.path, "/api/v3/queue/123", "sonarr handler must hit the Sonarr (v3) endpoint");
    assert.equal(deleteReq.params.get("removeFromClient"), "true");
    assert.equal(deleteReq.params.get("blocklist"), "false");
    assert.equal(deleteReq.params.get("skipRedownload"), "false");
    assert.equal(deleteReq.params.get("changeCategory"), "false");

    // Lidarr handler must hit the Lidarr (v1) endpoint with all params propagated.
    const lidarrResult = await callTool(port, "lidarr_delete_queue_item", {
      queueId: 123, removeFromClient: false, blocklist: true, skipRedownload: true, changeCategory: true,
    });
    assert.deepEqual(
      { removedFromClient: lidarrResult.removedFromClient, blocklisted: lidarrResult.blocklisted, skipRedownload: lidarrResult.skipRedownload, changeCategory: lidarrResult.changeCategory },
      { removedFromClient: false, blocklisted: true, skipRedownload: true, changeCategory: true },
    );
    deleteReq = lastDelete(requests);
    assert.equal(deleteReq.path, "/api/v1/queue/123", "lidarr handler must hit the Lidarr (v1) endpoint");
    assert.equal(deleteReq.params.get("removeFromClient"), "false", "the app must receive the false the caller asked for");
    assert.equal(deleteReq.params.get("blocklist"), "true");
    assert.equal(deleteReq.params.get("skipRedownload"), "true");
    assert.equal(deleteReq.params.get("changeCategory"), "true");

    // Radarr keeps working and forwards every option.
    const radarrResult = await callTool(port, "radarr_delete_queue_item", {
      queueId: 123, removeFromClient: true, blocklist: true, skipRedownload: true, changeCategory: false,
    });
    assert.equal(radarrResult.blocklisted, true);
    assert.equal(radarrResult.skipRedownload, true);
    deleteReq = lastDelete(requests);
    assert.equal(deleteReq.path, "/api/v3/queue/123", "radarr handler must hit the Radarr (v3) endpoint");
    assert.equal(deleteReq.params.get("removeFromClient"), "true");
    assert.equal(deleteReq.params.get("blocklist"), "true");
    assert.equal(deleteReq.params.get("skipRedownload"), "true");
    assert.equal(deleteReq.params.get("changeCategory"), "false");

    // No API keys leak into the MCP tool responses.
    const allText = JSON.stringify([sonarrDefaults, lidarrResult, radarrResult]);
    assert.doesNotMatch(allText, /sonarr-key|radarr-key|lidarr-key/);
  });
});

test("MCP removeFromClient=false reaches the native app end to end (lidarr)", async () => {
  await withServer(async (port, requests) => {
    const result = await callTool(port, "lidarr_delete_queue_item", {
      queueId: 123,
      removeFromClient: false,
      blocklist: true,
    });

    // The MCP response says what the caller asked for…
    assert.deepEqual(
      { removedFromClient: result.removedFromClient, blocklisted: result.blocklisted },
      { removedFromClient: false, blocklisted: true },
    );

    // …and the native HTTP request agrees with it.
    const deleteReq = lastDelete(requests);
    assert.equal(deleteReq.method, "DELETE");
    assert.equal(deleteReq.path, "/api/v1/queue/123");
    assert.equal(deleteReq.params.get("removeFromClient"), "false");
    assert.equal(deleteReq.params.get("blocklist"), "true");

    // Response and request cannot disagree on any reported flag.
    assert.equal(deleteReq.params.get("skipRedownload"), String(result.skipRedownload));
    assert.equal(deleteReq.params.get("changeCategory"), String(result.changeCategory));
  });
});
