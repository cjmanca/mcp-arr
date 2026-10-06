import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runStdioSmoke } from "../scripts/smoke-stdio.mjs";
import { runLiveDiscovery } from "../scripts/live-lidarr-discovery.mjs";

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
