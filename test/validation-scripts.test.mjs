import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runStdioSmoke } from "../scripts/smoke-stdio.mjs";
import { runLiveDiscovery } from "../scripts/live-lidarr-discovery.mjs";
import { trackChildExit, stopOwnedChild } from "../scripts/managed-child.mjs";

// ---------------------------------------------------------------------------
// Regression tests for the validation scripts themselves (no live services,
// no imports). The scripts are importable and take an injected spawn target,
// so these run them against the mock MCP fixtures in scripts/fixtures/.
// (Fixtures live OUTSIDE test/ on purpose: Node's bare `node --test`
// discovery treats every .mjs under a test/ directory as a test file, and a
// mock server that listens forever would hang the suite.)
// ---------------------------------------------------------------------------

const MOCK_STDIO = fileURLToPath(new URL("../scripts/fixtures/mock-mcp-stdio.mjs", import.meta.url));
const MOCK_HTTP = fileURLToPath(new URL("../scripts/fixtures/mock-mcp-http.mjs", import.meta.url));

const ALL_REQUIRED = [
  "arr_get_operation",
  "arr_cancel_operation",
  "lidarr_get_manual_import_candidates",
  "sonarr_get_manual_import_candidates",
  "radarr_get_manual_import_candidates",
];

function smoke(options = {}) {
  let child = null;
  const run = runStdioSmoke({
    spawnCmd: process.execPath,
    spawnArgs: [MOCK_STDIO],
    onChild: (c) => { child = c; },
    ...options,
  });
  return { run, getChild: () => child };
}

function live(options = {}) {
  let child = null;
  const run = runLiveDiscovery({
    spawnCmd: process.execPath,
    spawnArgs: [MOCK_HTTP],
    downloadId: "mock-dl",
    port: String(39900 + Math.floor(Math.random() * 400)),
    onChild: (c) => { child = c; },
    ...options,
  });
  return { run, getChild: () => child };
}

function assertOwnedChildStopped(child) {
  assert.ok(child, "child was spawned");
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    `owned child must be terminated before the script settles (exitCode=${child.exitCode}, signalCode=${child.signalCode})`,
  );
}

// --- A. Missing required polling tool ---------------------------------------

test("smoke fails with a named missing tool when tools/list omits arr_get_operation", async () => {
  const tools = ALL_REQUIRED.filter((n) => n !== "arr_get_operation");
  const { run, getChild } = smoke({ env: { MOCK_STDIO_TOOLS: JSON.stringify(tools) } });
  await assert.rejects(run, /required MCP tools missing from tools\/list: arr_get_operation/);
  assertOwnedChildStopped(getChild());
});

test("smoke fails when a manual-import discovery tool is missing", async () => {
  const tools = ALL_REQUIRED.filter((n) => n !== "lidarr_get_manual_import_candidates");
  const { run, getChild } = smoke({ env: { MOCK_STDIO_TOOLS: JSON.stringify(tools) } });
  await assert.rejects(run, /required MCP tools missing from tools\/list: lidarr_get_manual_import_candidates/);
  assertOwnedChildStopped(getChild());
});

// --- B. MCP errors, premature exit, bounded waits ---------------------------

test("smoke fails on a JSON-RPC error response", async () => {
  const { run, getChild } = smoke({ env: { MOCK_STDIO_MODE: "rpc-error" } });
  await assert.rejects(run, /initialize returned a JSON-RPC error: mock rpc error/);
  assertOwnedChildStopped(getChild());
});

test("smoke fails on a tool-level error from arr_status", async () => {
  const { run, getChild } = smoke({ env: { MOCK_STDIO_MODE: "tool-error" } });
  await assert.rejects(run, /arr_status reported a tool-level error/);
  assertOwnedChildStopped(getChild());
});

test("smoke fails on malformed protocol output", async () => {
  const { run, getChild } = smoke({ env: { MOCK_STDIO_MODE: "garbage" } });
  await assert.rejects(run, /malformed protocol output/);
  assertOwnedChildStopped(getChild());
});

test("smoke fails bounded when the child exits before responding", async () => {
  const started = Date.now();
  const { run, getChild } = smoke({ env: { MOCK_STDIO_MODE: "exit-early" }, requestTimeoutMs: 8_000 });
  await assert.rejects(run, /MCP child exited before responding \(code=9/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6_000, `failure must arrive via the exit event, not the request timeout (${elapsed}ms)`);
  assertOwnedChildStopped(getChild());
});

test("smoke fails bounded when a response never arrives", async () => {
  const { run, getChild } = smoke({ env: { MOCK_STDIO_MODE: "silent" }, requestTimeoutMs: 400 });
  await assert.rejects(run, /no response to tools\/call within 400ms/);
  assertOwnedChildStopped(getChild());
});

// --- C. Live-script failure after spawning ----------------------------------

test("live script fails and cleans up when the operation ends failed", async () => {
  const { run, getChild } = live({ env: { MOCK_HTTP_SCENARIO: "failed" } });
  await assert.rejects(run, /discovery operation ended failed: mock request timed out/);
  assertOwnedChildStopped(getChild());
});

test("live script fails and cleans up when the child crashes at startup", async () => {
  const { run, getChild } = live({ env: { MOCK_HTTP_SCENARIO: "crash" }, healthTimeoutMs: 4_000 });
  await assert.rejects(run, /MCP child exited before becoming healthy/);
  assertOwnedChildStopped(getChild());
});

test("live script rejects a running handle with no valid hardTimeoutAt", async () => {
  const { run, getChild } = live({ env: { MOCK_HTTP_SCENARIO: "bad-handle" } });
  await assert.rejects(run, /no valid hardTimeoutAt/);
  assertOwnedChildStopped(getChild());
});

// --- D. Legitimately slow completion (past the old fixed poll-count cutoff) --

test("live script keeps polling the same handle past 60 polls and succeeds on completion", async () => {
  const { run, getChild } = live({
    env: { MOCK_HTTP_SCENARIO: "complete", MOCK_OP_MS: "30000", MOCK_POLL_MS: "10", MOCK_RUNNING_POLLS: "70" },
    graceMs: 1_000,
  });
  const summary = await run;
  assert.equal(summary.count, 1);
  assert.ok(summary.polls > 60, `must outlive the old fixed 60-attempt cutoff (got ${summary.polls} polls)`);
  assertOwnedChildStopped(getChild());
});

// --- E. Validation watchdog --------------------------------------------------

test("live script reports a validation watchdog (not a fabricated server terminal state) when polling outlives hardTimeoutAt + grace", async () => {
  const { run, getChild } = live({
    env: { MOCK_HTTP_SCENARIO: "watchdog", MOCK_OP_MS: "800", MOCK_POLL_MS: "40" },
    graceMs: 200,
  });
  const started = Date.now();
  await assert.rejects(run, /validation watchdog/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `watchdog must be bounded (${elapsed}ms)`);
  assertOwnedChildStopped(getChild());
});

// --- F. Happy paths ----------------------------------------------------------

test("smoke succeeds against a fully registered stdio server", async () => {
  const { run, getChild } = smoke();
  const summary = await run;
  assert.equal(summary.toolCount, ALL_REQUIRED.length);
  assertOwnedChildStopped(getChild());
});

test("live script succeeds on handle → poll → completed, and a zero-candidate result is a success", async () => {
  const one = live({ env: { MOCK_HTTP_SCENARIO: "complete", MOCK_OP_MS: "30000", MOCK_POLL_MS: "10", MOCK_RUNNING_POLLS: "2" }, graceMs: 1_000 });
  const summary = await one.run;
  assert.equal(summary.count, 1);
  assertOwnedChildStopped(one.getChild());

  const zero = live({ env: { MOCK_HTTP_SCENARIO: "zero", MOCK_OP_MS: "30000", MOCK_POLL_MS: "10", MOCK_RUNNING_POLLS: "2" }, graceMs: 1_000 });
  const zeroSummary = await zero.run;
  assert.equal(zeroSummary.count, 0, "an empty candidate list is a successful discovery");
  assertOwnedChildStopped(zero.getChild());
});

// --- A/B. The absolute validation deadline bounds in-flight polls -----------

const STALL_ENV = {
  MOCK_HTTP_SCENARIO: "complete",
  MOCK_OP_MS: "250",
  MOCK_POLL_MS: "10",
  MOCK_RUNNING_POLLS: "0",
  MOCK_POLL1_DELAY_MS: "1000",
};

test("a poll stalling past the validation deadline fails as watchdog near the deadline, not at requestTimeoutMs (headers phase)", async () => {
  const { run, getChild } = live({ env: STALL_ENV, requestTimeoutMs: 2_000, graceMs: 50 });
  const started = Date.now();
  // The mock's completed response arrives at ~1000ms — after the ~300ms
  // validation deadline. Accepting it would be the old bug.
  await assert.rejects(run, /validation watchdog/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250, `watchdog must not fire before the deadline (${elapsed}ms)`);
  assert.ok(elapsed < 1_200, `watchdog must fire near the deadline, not at requestTimeoutMs (${elapsed}ms)`);
  assertOwnedChildStopped(getChild());
});

test("a delayed response BODY is bounded by the validation deadline too", async () => {
  const { run, getChild } = live({
    env: { ...STALL_ENV, MOCK_DELAY_PHASE: "body" },
    requestTimeoutMs: 2_000,
    graceMs: 50,
  });
  const started = Date.now();
  await assert.rejects(run, /validation watchdog/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_200, `body-read stall must be cut off at the deadline (${elapsed}ms)`);
  assertOwnedChildStopped(getChild());
});

test("a request timeout before the validation deadline stays a request failure, not watchdog", async () => {
  const { run, getChild } = live({
    env: { ...STALL_ENV, MOCK_OP_MS: "5000" },
    requestTimeoutMs: 300,
    graceMs: 1_000,
  });
  await assert.rejects(run, /request timeout/);
  assertOwnedChildStopped(getChild());
});

// --- C. Fatal stdout errors survive gaps between pending requests -----------

test("malformed stdout after a valid tools/list response cannot be forgotten", async () => {
  const { run, getChild } = smoke({ env: { MOCK_STDIO_MODE: "garbage-after-list" } });
  await assert.rejects(run, /malformed protocol output/);
  assertOwnedChildStopped(getChild());
});

test("malformed stdout in the same chunk as the final valid arr_status response fails the run", async () => {
  const { run, getChild } = smoke({ env: { MOCK_STDIO_MODE: "garbage-after-status" } });
  await assert.rejects(run, /malformed protocol output/);
  assertOwnedChildStopped(getChild());
});

// --- D. Successful cleanup leaves no timer keeping the CLI alive ------------

test("stopOwnedChild clears its race timers: the parent process exits promptly after cleanup", async () => {
  const fixture = fileURLToPath(new URL("../scripts/fixtures/child-cleanup-timer.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, CLEANUP_GRACE_MS: "3000" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  let cleanupAt = null;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (d) => {
    out += d.toString();
    if (cleanupAt === null && /cleanup-ms=/.test(out)) cleanupAt = Date.now();
  });
  let capTimer;
  const raced = await Promise.race([
    done.then(() => ({ exited: true })),
    new Promise((resolve) => { capTimer = setTimeout(() => resolve({ exited: false }), 10_000); }),
  ]);
  clearTimeout(capTimer);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  assert.ok(raced.exited, "fixture subprocess must exit on its own");
  assert.ok(cleanupAt !== null, `fixture must report cleanup completion (stdout: ${out})`);
  const cleanupMs = Number(/cleanup-ms=(\d+)/.exec(out)[1]);
  assert.ok(cleanupMs < 1_000, `stopOwnedChild itself resolved promptly (${cleanupMs}ms)`);
  const linger = Date.now() - cleanupAt;
  // Generous margin: a leaked 3000ms grace timer would keep the parent alive
  // for ~3s after the cleanup line.
  assert.ok(linger < 1_500, `parent lingered ${linger}ms after cleanup — a cleanup timer is still scheduled`);
});

test("unconfirmed termination is reported as cleanup failure, not successful cleanup", async () => {
  // Stub child: kill() is a no-op and no exit event ever fires.
  const stub = { exitCode: null, signalCode: null, killed: false, kill: () => true, once: () => {} };
  const tracked = trackChildExit(stub);
  await assert.rejects(
    stopOwnedChild(stub, tracked, { graceMs: 40, killMs: 40 }),
    /cleanup failure/,
  );
});
