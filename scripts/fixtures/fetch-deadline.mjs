// Isolated subprocess fixture for the deadline-acceptance regression.
//
// fetchBounded's cancellation timers are real setTimeouts. A synchronous
// busy-block inside the response-body read keeps the event loop from running
// those timer callbacks, so the ONLY thing that can reject an overdue result is
// fetchBounded's own elapsed-deadline check. Each case prints a classification
// (watchdog / request / success); the harness asserts exact PASS lines.
import { fetchBounded } from "../live-lidarr-discovery.mjs";

function busyBlock(ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {}
}

function mockFetch({ blockMs, status = 200, body = "OK" }) {
  return async () => ({
    status,
    async text() {
      busyBlock(blockMs);
      return body;
    },
  });
}

const never = new Promise(() => {});

const cases = [
  // validation deadline earlier, body blocks past it -> watchdog
  { name: "validation-earlier", timeoutMs: 200, deadlineAt: Date.now() + 40, blockMs: 100, expect: "watchdog" },
  // request deadline earlier, body blocks past it -> request timeout
  { name: "request-earlier", timeoutMs: 40, deadlineAt: Date.now() + 200, blockMs: 100, expect: "request" },
  // both deadlines elapsed, validation earlier -> earliest wins (not
  // the order of the checks inside fetchBounded)
  { name: "both-earliest-validation", timeoutMs: 120, deadlineAt: Date.now() + 40, blockMs: 150, expect: "watchdog" },
  // in-time completed body -> accepted
  { name: "on-time", timeoutMs: 500, deadlineAt: Date.now() + 500, blockMs: 10, expect: "success" },
];

for (const c of cases) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch({ blockMs: c.blockMs });
  let result = "success";
  let message = "";
  try {
    const r = await fetchBounded(
      "http://127.0.0.1:1/mcp",
      {},
      { timeoutMs: c.timeoutMs, deadlineAt: c.deadlineAt, childExited: never, childFailed: never },
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
  const ok = result === c.expect;
  console.log(`${c.name}: ${ok ? "PASS" : "FAIL"} (${result}: ${message.slice(0, 90)})`);
  if (!ok) process.exitCode = 1;
}
