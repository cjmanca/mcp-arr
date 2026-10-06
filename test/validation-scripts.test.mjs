import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
  const stub = { exitCode: null, signalCode: null, killed: false, kill: () => true, on: () => {}, once: () => {} };
  const tracked = trackChildExit(stub);
  await assert.rejects(
    stopOwnedChild(stub, tracked, { graceMs: 40, killMs: 40 }),
    /cleanup failure/,
  );
});

// ---------------------------------------------------------------------------
// Child-lifecycle regressions. No live services, no privileged kills.
// ---------------------------------------------------------------------------

const onceP = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

function killSpy(child) {
  const calls = [];
  const realKill = child.kill.bind(child);
  child.kill = (sig) => { calls.push(sig); return realKill(sig); };
  return calls;
}

// A realistic child double that separates spawn, runtime error, signalling
// error, and confirmed exit — the exact distinction the old `exited` promise
// collapsed.
class FakeChild extends EventEmitter {
  constructor({ exitAfterKillMs = 30 } = {}) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killSignals = [];
    this._exitAfterKillMs = exitAfterKillMs;
  }
  kill(signal) {
    this.killSignals.push(signal);
    if (signal === "SIGTERM") {
      // A signalling error with NO exit — must not be treated as termination.
      this.emit("error", new Error("simulated signalling error on SIGTERM"));
      return true;
    }
    if (signal === "SIGKILL") {
      this.killed = true;
      setTimeout(() => {
        this.signalCode = "SIGKILL";
        this.emit("exit", null, "SIGKILL");
      }, this._exitAfterKillMs);
      return true;
    }
    return true;
  }
}

// --- A. Runtime error AFTER a successful spawn ------------------------------

test("an error from an already-started child never means 'nothing to clean up'", async () => {
  // Real disposable child, kept alive by a timer, with an IPC channel to break.
  const child = spawn(process.execPath, ["-e", "process.on('message', () => {}); setInterval(() => {}, 10_000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const tracked = trackChildExit(child);
  try {
    await onceP(child, "spawn");
    assert.ok(child.pid > 0, "child started successfully (has a pid)");
    assert.equal(child.exitCode, null, "child is running");
    // Induce a controlled post-start child-process error: closing the IPC channel
    // then sending emits ERR_IPC_CHANNEL_CLOSED on the child WITHOUT exiting it.
    child.disconnect();
    child.send("mcp-arr-trigger-ipc-error");
    await onceP(child, "error");
    assert.ok(tracked.state.spawned, "spawn was recorded");
    assert.equal(tracked.state.exit, null, "the child errored but did NOT exit");
    assert.equal(tracked.state.spawnFailed, false, "a started child is not a spawn failure");
    await stopOwnedChild(child, tracked, { graceMs: 2_000, killMs: 2_000 });
    // Regression: the old code returned "success" here while the child lived.
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      "cleanup must not report success while a started child is still alive (it must drive the child to a confirmed exit)",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

// --- B. Signalling error, then a delayed forced-exit ----------------------------

test("cleanup waits for the real exit when a signalling error precedes a delayed SIGKILL", async () => {
  const child = new FakeChild({ exitAfterKillMs: 30 });
  const tracked = trackChildExit(child); // attach lifecycle listeners BEFORE emitting
  child.emit("spawn");
  assert.ok(tracked.state.spawned, "spawn recorded");
  const started = Date.now();
  // Must RESOLVE: SIGTERM's signalling error resolves nothing, cleanup escalates
  // to SIGKILL, then the real exit arrives inside the forced-exit budget.
  await stopOwnedChild(child, tracked, { graceMs: 80, killMs: 300 });
  const elapsed = Date.now() - started;
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"], "escalation must run SIGTERM then SIGKILL");
  assert.equal(child.signalCode, "SIGKILL", "termination confirmed by the exit event, not the signalling error");
  assert.ok(elapsed < 400, `must succeed within the configured budget, not reject immediately (${elapsed}ms)`);
});

// --- C. Genuine spawn failure --------------------------------------------------

test("a verified spawn failure cleans up without signalling a process that never started", async () => {
  const child = spawn("mcp-arr-not-a-real-executable", [], { stdio: "ignore" });
  const killSignals = killSpy(child);
  const tracked = trackChildExit(child);
  await onceP(child, "error");
  assert.ok(tracked.state.spawnFailed, "spawn failure recorded");
  assert.equal(tracked.state.spawned, false, "no process ever started");
  await stopOwnedChild(child, tracked, { graceMs: 100, killMs: 100 });
  assert.deepEqual(killSignals, [], "cleanup must not signal a process that never started");
});

test("stdio smoke fails promptly on a startup spawn error (bounded, not the request timeout)", async () => {
  const started = Date.now();
  const { run } = smoke({ spawnCmd: "mcp-arr-not-a-real-executable", spawnArgs: [] });
  await assert.rejects(run, /child process error|spawn|ENOENT|ENOENT/i);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8_000, `startup failure must fail promptly via the child error, not after requestTimeoutMs (${elapsed}ms)`);
});

// --- D. Already-exited child ---------------------------------------------------

test("stopOwnedChild returns immediately for a child that already exited, without signalling", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const killSignals = killSpy(child);
  const tracked = trackChildExit(child);
  await onceP(child, "exit");
  await stopOwnedChild(child, tracked, { graceMs: 100, killMs: 100 });
  assert.deepEqual(killSignals, [], "an already-exited child must not be signalled");
});

// --- Deadline acceptance: overdue results are rejected, not accepted -----------

test("fetchBounded rejects an overdue response even when its timeout callback has not run", async () => {
  // Isolated subprocess: a synchronous busy-block in the response-body read
  // prevents fetchBounded's cancellation timers from firing, so only its own
  // elapsed-deadline check can reject the result. Classification, not ms.
  const fixture = fileURLToPath(new URL("../scripts/fixtures/fetch-deadline.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));
  const code = await onceP(child, "exit");
  assert.equal(code, 0, `deadline-acceptance fixture reported failures (exit ${code}):\n${out}${err}`);
  // Each PASS line must show the intended request + body-read path actually ran
  // (fetch=1 body=1), so a case cannot pass by rejecting a deadline that expired
  // before its own request started.
  assert.match(out, /validation-earlier: PASS \(watchdog: fetch=1 body=1/, "validation deadline earlier -> watchdog, request+body path exercised");
  assert.match(out, /request-earlier: PASS \(request: fetch=1 body=1/, "request deadline earlier -> request timeout, request+body path exercised");
  assert.match(out, /both-earliest-validation: PASS \(watchdog: fetch=1 body=1/, "both deadlines expire DURING the request; earliest (validation) wins, request+body path exercised");
  assert.match(out, /on-time: PASS \(success: fetch=1 body=1/, "an in-time completed result is accepted, request+body path exercised");
});
