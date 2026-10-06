// Isolated subprocess fixture for the deadline-acceptance regression.
//
// fetchBounded's cancellation timers are real setTimeouts. A synchronous
// busy-block inside the response-body read keeps the event loop from running
// those timer callbacks, so the ONLY thing that can reject an overdue result is
// fetchBounded's own elapsed-deadline check. Each case prints a classification
// (watchdog / request / success) and per-case path counters; the harness
// asserts exact PASS lines.
//
// Deadlines are RELATIVE durations (validationAfterMs) resolved to absolute
// timestamps inside the loop, immediately before the request. Earlier
// cases (which block synchronously) must never consume a later case's timing
// budget: every case starts with BOTH its request timeout and its validation
// deadline in the future.
import { fetchBounded } from "../live-lidarr-discovery.mjs";

function busyBlock(ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {}
}

const never = new Promise(() => {});

const cases = [
  // validation deadline earlier, body blocks past it -> watchdog
  { name: "validation-earlier", timeoutMs: 200, validationAfterMs: 40, blockMs: 100, expect: "watchdog" },
  // request deadline earlier, body blocks past it -> request timeout
  { name: "request-earlier", timeoutMs: 40, validationAfterMs: 200, blockMs: 100, expect: "request" },
  // both deadlines in the future at request start; the body read blocks
  // past BOTH, timer callbacks never get a turn, and the EARLIER deadline
  // (validation, 40ms < request 120ms) determines the watchdog — not the
  // conditional order inside fetchBounded, and not an already-expired budget.
  { name: "both-earliest-validation", timeoutMs: 120, validationAfterMs: 40, blockMs: 150, expect: "watchdog" },
  // in-time completed body -> accepted
  { name: "on-time", timeoutMs: 500, validationAfterMs: 500, blockMs: 10, expect: "success" },
];

for (const c of cases) {
  const counters = { fetchCalls: 0, bodyReads: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    counters.fetchCalls += 1;
    return {
      status: 200,
      async text() {
        counters.bodyReads += 1;
        busyBlock(c.blockMs);
        return "OK";
      },
    };
  };
  // Resolve this case's absolute deadline at invocation time.
  const deadlineAt = Date.now() + c.validationAfterMs;
  let result = "success";
  let message = "";
  try {
    const r = await fetchBounded(
      "http://127.0.0.1:1/mcp",
      {},
      { timeoutMs: c.timeoutMs, deadlineAt, childExited: never, childFailed: never },
    );
    message = `status=${r.status}`;
  } catch (error) {
    message = String(error?.message ?? error);
    result = /validation watchdog/.test(message)
      ? "watchdog"
      : /request timeout/.test(message)
        ? "request"
        : "other";
  } finally {
    globalThis.fetch = original;
  }
  // A matching label alone is not enough: the intended request + body-read
  // path must actually have run, or the case is FAIL.
  const pathOk = counters.fetchCalls === 1 && counters.bodyReads === 1;
  const ok = result === c.expect && pathOk;
  const status = ok ? "PASS" : "FAIL";
  const note = pathOk ? message : `${message} (path not exercised: fetch=${counters.fetchCalls} body=${counters.bodyReads})`;
  console.log(`${c.name}: ${status} (${result}: fetch=${counters.fetchCalls} body=${counters.bodyReads}: ${note.slice(0, 70)})`);
  if (!ok) process.exitCode = 1;
}
