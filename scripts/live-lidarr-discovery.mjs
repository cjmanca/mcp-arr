// Non-destructive LIVE validation for async manual-import candidate discovery.
// Boots the freshly built server against the real Lidarr from .env.local and
// runs DISCOVERY ONLY (a read-only GET /manualimport — never preview, never
// execute). PREVIEW_SYNC_BUDGET_MS=0 forces the async handle path so the
// handle → poll → completed-result flow is exercised against the live app.
//
// The polling watchdog is derived from the handle's own hardTimeoutAt (plus a
// bounded grace), not a fixed attempt count, and it is enforced THROUGH the
// in-flight request: every poll's HTTP request and response-body read is
// bounded by the earlier of the per-request timeout and the absolute
// validation deadline, and a response obtained after the deadline can never
// turn the validation into a success. Success and failure both clean up the
// child this script spawned before exiting; failures exit nonzero.
//
// Usage: node scripts/live-lidarr-discovery.mjs <downloadId>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { trackChildExit, stopOwnedChild } from "./managed-child.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLocalEnv() {
  try {
    return Object.fromEntries(
      readFileSync(new URL("../.env.local", import.meta.url), "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
  } catch {
    return {};
  }
}

function truncate(text, max = 400) {
  const t = String(text ?? "");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * Bounded HTTP request with composed cancellation, compatible with Node >=18
 * (no AbortSignal.any): one controller is aborted by the FIRST of
 *   - the per-request timeout,
 *   - the absolute validation deadline (when supplied),
 *   - the owned child exiting.
 * The first reason wins and is preserved; the abort covers headers AND the
 * response-body read, and every timer/listener is cleared when the request
 * settles. A losing request is aborted, not abandoned.
 */
async function fetchBounded(url, init, { timeoutMs, deadlineAt, exited }) {
  const controller = new AbortController();
  let failure = null;
  const failWith = (error) => {
    if (failure) return;
    failure = error;
    controller.abort(error);
  };
  const timers = [];
  if (timeoutMs > 0) {
    timers.push(setTimeout(() => failWith(new Error(`request timeout: ${url} did not respond within ${timeoutMs}ms`)), timeoutMs));
  }
  if (deadlineAt !== undefined) {
    timers.push(setTimeout(
      () => failWith(new Error(
        `validation watchdog: no terminal result was obtained before the validation deadline (hardTimeoutAt + grace); the script cannot tell whether the server finished internally`,
      )),
      Math.max(0, deadlineAt - Date.now()),
    ));
  }
  const onChildExit = () => failWith(new Error(`MCP child exited before ${url} responded`));
  if (exited) exited.then(onChildExit);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (failure) throw failure;
    return { status: response.status, text };
  } catch (error) {
    if (failure) throw failure;
    throw error;
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

/**
 * Resolve a poll interval from the handle/poll response. Malformed values get
 * a bounded fallback; the latest advertised interval wins.
 */
function pollIntervalMs(value) {
  return Number.isFinite(value) && value > 0 && value <= 60_000 ? value : 2_000;
}

/**
 * Absolute validation deadline from the operation's own hard deadline plus a
 * grace for observing the server's terminal response. A missing/malformed
 * hardTimeoutAt is a protocol error — never an unbounded loop.
 */
function validationDeadlineMs(hardTimeoutAt, graceMs) {
  const at = typeof hardTimeoutAt === "string" || typeof hardTimeoutAt === "number" ? Date.parse(hardTimeoutAt) : NaN;
  if (!Number.isFinite(at)) {
    throw new Error("protocol error: running handle has no valid hardTimeoutAt; cannot derive a bounded validation deadline");
  }
  return at + graceMs;
}

function watchdogError(operationId, graceMs) {
  return new Error(
    `validation watchdog: no terminal result for operation ${operationId} was obtained before the validation deadline (hardTimeoutAt + ${graceMs}ms grace); the script cannot tell whether the server finished internally`,
  );
}

function parseRpcBody(rawText) {
  const dataLine = rawText.split("\n").find((l) => l.startsWith("data: "));
  let body;
  try {
    body = JSON.parse(dataLine ? dataLine.slice(6) : rawText);
  } catch {
    throw new Error(`malformed MCP response (not JSON): ${truncate(rawText)}`);
  }
  if (body?.error) {
    throw new Error(`JSON-RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  if (!body?.result || typeof body.result !== "object") {
    throw new Error(`MCP response has no result object: ${truncate(rawText)}`);
  }
  return body;
}

/**
 * Send one JSON-RPC request over the stateless HTTP endpoint. Every request
 * (and its body read) is bounded by the per-request timeout and, during
 * polling, by the absolute validation deadline; a child that dies mid-request
 * aborts it.
 */
async function sendRequest(port, method, params, { timeoutMs, deadlineAt, exited }) {
  const request = { jsonrpc: "2.0", id: 3, method, params };
  const raced = await fetchBounded(
    `http://127.0.0.1:${port}/mcp`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(request),
    },
    { timeoutMs, deadlineAt, exited },
  );
  return { body: parseRpcBody(raced.text), text: raced.text };
}

async function callTool(port, name, args, bounds) {
  const { body, text } = await sendRequest(port, "tools/call", { name, arguments: args }, bounds);
  const content = body.result.content;
  if (!Array.isArray(content) || typeof content[0]?.text !== "string") {
    throw new Error(`${name} returned a malformed MCP result (no content[0].text): ${truncate(text)}`);
  }
  if (body.result.isError === true) {
    throw new Error(`${name} reported a tool-level error: ${truncate(content[0].text)}`);
  }
  let payload = null;
  try { payload = JSON.parse(content[0].text); } catch { /* non-JSON tool text */ }
  return { payload, text: content[0].text };
}

async function waitForHealth(port, { timeoutMs, exited, state }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchBounded(
        `http://127.0.0.1:${port}/health`,
        {},
        { timeoutMs: Math.min(2_000, Math.max(100, deadline - Date.now())), exited },
      );
      if (r.status === 200) return;
    } catch (error) {
      if (state.exit || /child exited/.test(String(error?.message))) {
        throw new Error("MCP child exited before becoming healthy");
      }
    }
    await sleep(100);
  }
  throw new Error(`MCP server did not become healthy within ${timeoutMs}ms`);
}

/**
 * Discovery invariants for a completed poll. A zero-candidate result is a
 * successful discovery; a completed discovery is NOT an import.
 */
function validateDiscoveryResult(pollPayload, { operationId, downloadId }) {
  if (pollPayload.operationId !== operationId) {
    throw new Error(`poll returned a different operationId (${pollPayload.operationId})`);
  }
  if (pollPayload.operation !== "lidarr-manual-import-discovery") {
    throw new Error(`poll returned the wrong operation kind: ${pollPayload.operation}`);
  }
  const result = pollPayload.result;
  if (!result || typeof result !== "object") {
    throw new Error("completed poll carries no result payload");
  }
  if (result.status !== undefined || result.operationId !== undefined) {
    throw new Error("completed result is not a plain discovery payload (nested operation envelope)");
  }
  if (result.downloadId !== downloadId) {
    throw new Error(`result downloadId '${result.downloadId}' does not match the requested '${downloadId}'`);
  }
  if (!Array.isArray(result.candidates)) {
    throw new Error("result.candidates is not an array");
  }
  if (result.count !== result.candidates.length) {
    throw new Error(`result.count (${result.count}) disagrees with returned candidates (${result.candidates.length})`);
  }
  return result;
}

/**
 * Run the live discovery validation. Throws on any validation failure; the
 * owned child is stopped on success AND on failure before this settles.
 */
export async function runLiveDiscovery(options = {}) {
  const {
    downloadId,
    spawnCmd = process.execPath,
    spawnArgs = ["dist/index.js"],
    env = loadLocalEnv(),
    port = process.env.__SMOKE_PORT || "39881",
    requestTimeoutMs = 15_000,
    healthTimeoutMs = 10_000,
    graceMs = 10_000,
    onChild = () => {},
  } = options;

  if (typeof downloadId !== "string" || downloadId.trim() === "") {
    throw new Error("usage: node scripts/live-lidarr-discovery.mjs <downloadId>");
  }

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ...env,
      MCP_TRANSPORT: "http",
      HOST: "127.0.0.1",
      PORT: port,
      PREVIEW_SYNC_BUDGET_MS: "0",
      PREVIEW_MAX_RUNTIME_MS: "300000",
      OPERATION_POLL_INTERVAL_MS: "2000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const tracked = trackChildExit(child);
  const { exited, state } = tracked;
  onChild(child);

  let primaryError = null;
  try {
    await waitForHealth(port, { timeoutMs: healthTimeoutMs, exited, state });
    const bounds = { timeoutMs: requestTimeoutMs, exited };
    const init = await sendRequest(port, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "live-validation", version: "0" },
    }, bounds);
    if (!init.body.result.serverInfo?.name) {
      throw new Error(`initialize response has no serverInfo.name: ${truncate(init.text)}`);
    }

    const started = Date.now();
    const disc = await callTool(port, "lidarr_get_manual_import_candidates", { downloadId }, bounds);
    const handle = disc.payload;
    console.log(`=== discovery response (${Date.now() - started}ms) ===`);
    console.log(JSON.stringify({
      status: handle?.status,
      operation: handle?.operation,
      operationId: handle?.operationId,
      stage: handle?.stage,
      pollAfterMs: handle?.pollAfterMs,
      hardTimeoutAt: handle?.hardTimeoutAt,
      countInHandle: handle?.count ?? null,
    }, null, 1));
    if (handle?.status !== "running") {
      throw new Error(`expected a running handle at budget 0; got status '${handle?.status}' with ${handle?.count} candidates`);
    }
    const operationId = handle.operationId;
    if (typeof operationId !== "string" || operationId === "") {
      throw new Error("protocol error: running handle has no operationId");
    }
    if (handle.count !== undefined || handle.candidates !== undefined) {
      throw new Error("protocol error: running handle must not carry count/candidates");
    }

    // Absolute validation deadline: computed ONCE, enforced through every
    // poll's request AND body read, never reset by a later response.
    const deadlineAt = validationDeadlineMs(handle.hardTimeoutAt, graceMs);
    let interval = pollIntervalMs(handle.pollAfterMs);
    let poll = null;
    let polls = 0;
    for (;;) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw watchdogError(operationId, graceMs);
      await sleep(Math.min(interval, remaining));
      const remainingAfterSleep = deadlineAt - Date.now();
      if (remainingAfterSleep <= 0) throw watchdogError(operationId, graceMs);
      poll = await callTool(port, "arr_get_operation", { operationId }, {
        timeoutMs: requestTimeoutMs,
        deadlineAt,
        exited,
      });
      polls += 1;
      const p = poll.payload;
      if (!p || typeof p.status !== "string") {
        throw new Error(`poll returned a malformed response: ${truncate(poll.text)}`);
      }
      console.log(`poll ${polls} (${Date.now() - started}ms): ${p.status}${p.stage ? ` [${p.stage}]` : ""}`);
      if (p.status === "running") {
        interval = pollIntervalMs(p.pollAfterMs);
        continue;
      }
      break;
    }

    if (poll.payload.status !== "completed") {
      throw new Error(`discovery operation ended ${poll.payload.status}${poll.payload.error ? `: ${poll.payload.error}` : ""}`);
    }
    const result = validateDiscoveryResult(poll.payload, { operationId, downloadId });

    console.log(`=== completed discovery (${Date.now() - started}ms total, ${polls} polls) ===`);
    console.log(JSON.stringify({
      downloadId: result.downloadId,
      count: result.count,
      existingFilesPolicy: result.existingFilesPolicy,
      candidateFilterPolicy: result.candidateFilterPolicy,
      hasVerifyDirective: Array.isArray(result.verifyBeforeActing),
      notes: result.notes?.length,
    }, null, 1));
    for (const c of result.candidates.slice(0, 5)) {
      console.log(JSON.stringify({
        candidateId: c.candidateId, name: c.name,
        artist: c.artist, album: c.album, albumReleaseId: c.albumReleaseId,
        rejections: c.rejections,
      }));
    }
    console.log(`(showing ${Math.min(5, result.count)} of ${result.count} candidates; completed discovery means candidate analysis finished — nothing was imported)`);
    return { count: result.count, polls };
  } catch (error) {
    primaryError = error;
    const tail = stderr.trim().split(/\r?\n/).slice(-5).join(" | ");
    if (tail) console.error(`server stderr: ${truncate(tail)}`);
    throw error;
  } finally {
    try {
      await stopOwnedChild(child, tracked);
    } catch (cleanupError) {
      // A validation failure keeps its own reason; cleanup failure is only
      // reported when the run itself succeeded.
      if (!primaryError) throw cleanupError;
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runLiveDiscovery({ downloadId: process.argv[2] }).catch((error) => {
    console.error(`live discovery validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
