/**
 * Small child-process lifecycle helper shared by the validation scripts.
 *
 * It manages ONLY the child the calling script spawned: track its exit from
 * the moment of spawn (so an already-exited, spawn-failed, or crashed child
 * never leaves the script waiting), and stop it with a bounded, escalating
 * SIGTERM → SIGKILL sequence. Termination is confirmed ONLY by the exit event;
 * a child-process 'error' event is not treated as proof the process is gone.
 * Race timers are cleared when the awaited side settles, so a successfully
 * stopped child never leaves a timer keeping the parent CLI alive.
 *
 * This is deliberately not a process-management framework: no name-based
 * kills, no port-based kills, no exit-event handlers doing async work.
 */

/**
 * Track the owned child's terminal events from spawn. Returns:
 *   exited — promise resolving on the first of exit/error
 *   state  — { exit: {code, signal} | null, error: Error | null }
 * `state.exit` is the only confirmed-termination signal.
 */
export function trackChildExit(child) {
  const state = { exit: null, error: null };
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      state.exit = { code, signal };
      resolve(state.exit);
    });
    child.once("error", (error) => {
      state.error = error;
      resolve({ error });
    });
  });
  return { exited, state };
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
 * then escalate to SIGKILL and wait up to killMs. Returns once termination is
 * confirmed — it never hangs on a child that already exited, crashed, or
 * failed to spawn (a spawn-failed child never started, so there is nothing to
 * stop). If the final escalation wait ends without a confirmed exit, cleanup
 * FAILS loudly instead of pretending the child stopped.
 */
export async function stopOwnedChild(child, tracked, { graceMs = 5000, killMs = 3000 } = {}) {
  const { exited, state } = tracked;
  if (childExited(child)) return;
  if (state.error && !state.exit) return; // spawn failed: the child never started
  child.kill("SIGTERM");
  const term = await raceTimeout(exited, graceMs);
  if (!term.timedOut && state.exit) return;
  child.kill("SIGKILL");
  const forced = await raceTimeout(exited, killMs);
  if (!forced.timedOut && state.exit) return;
  throw new Error("cleanup failure: the owned child did not confirm termination after SIGTERM and SIGKILL");
}
