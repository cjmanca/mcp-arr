/**
 * Small child-process lifecycle helper shared by the validation scripts.
 *
 * It manages ONLY the child the calling script spawned: track its lifecycle from
 * the moment of spawn (so an already-exited, spawn-failed, or crashed child
 * never leaves the script waiting), and stop it with a bounded,
 * escalating SIGTERM → SIGKILL sequence. Spawn success, spawn
 * failure, a runtime process error, and confirmed termination are tracked as
 * SEPARATE facts: termination is confirmed ONLY by the exit event, and a child
 * 'error' is never proof the process is gone. Cleanup waits on the termination
 * promise, never on a promise an earlier error settled. Race timers are cleared
 * when the awaited side settles, so a successfully stopped child never leaves a
 * timer keeping the parent CLI alive.
 *
 * This is deliberately not a process-management framework: no name-based
 * kills, no port-based kills, no exit-event handlers doing async work.
 */

/**
 * Track the owned child's lifecycle from spawn as SEPARATE facts, never
 * collapsed into one signal:
 *   state.spawned     — the child successfully started (spawn event / pid)
 *   state.spawnFailed   — an error arrived before the process ever started (nothing to kill)
 *   state.error         — a runtime/process error (informational; NOT termination)
 *   state.exit          — confirmed termination, set ONLY by the exit event
 * Returns:
 *   terminated — promise resolving ONLY on confirmed termination (the exit event)
 *   failed     — promise resolving on the first process error, so active
 *                HTTP/stdio requests can fail promptly
 * Cleanup waits on `terminated`, never on a promise an arbitrary error settled.
 * The error listener stays active for the whole lifecycle (plain `on`, not
 * `once`), so a signalling error during cleanup cannot consume the only slot.
 */
export function trackChildExit(child) {
  const state = { spawned: false, spawnFailed: false, error: null, exit: null };

  let markTerminated = () => {};
  const terminated = new Promise((resolve) => { markTerminated = resolve; });

  let markFailed = () => {};
  const failed = new Promise((resolve) => { markFailed = resolve; });

  child.on("spawn", () => { state.spawned = true; });
  child.on("exit", (code, signal) => {
    state.exit = { code, signal };
    markTerminated(state.exit);
  });
  child.on("error", (error) => {
    state.error = error;
    if (!state.spawned && !state.exit) state.spawnFailed = true;
    markFailed(error);
  });

  return { terminated, failed, state };
}

export function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function raceTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Stop the owned child: SIGTERM, wait up to graceMs for the confirmed exit,
 * then escalate to SIGKILL and wait up to killMs. Every wait is against the
 * `terminated` promise, which resolves ONLY on the exit event — never on a
 * process error. Returns once termination is confirmed: a `kill()` return value
 * or `child.killed` is never treated as proof. It never hangs on a child
 * that already exited, and a verified spawn failure (no process ever existed)
 * returns without signalling anything. A child that started and then hit a
 * runtime error WITHOUT exiting still goes through the full escalation; if the
 * final wait ends without a confirmed exit, cleanup FAILS loudly
 * instead of pretending the child stopped.
 */
export async function stopOwnedChild(child, tracked, { graceMs = 5000, killMs = 3000 } = {}) {
  const { terminated, state } = tracked;
  if (childExited(child) || state.exit) return; // already terminated
  if (state.spawnFailed) return; // spawn failed: no process was ever created
  child.kill("SIGTERM");
  const term = await raceTimeout(terminated, graceMs);
  if (!term.timedOut) return; // terminated resolved = confirmed exit
  child.kill("SIGKILL");
  const forced = await raceTimeout(terminated, killMs);
  if (!forced.timedOut) return; // confirmed exit after the forced escalation
  throw new Error("cleanup failure: the owned child did not confirm termination after SIGTERM and SIGKILL");
}
