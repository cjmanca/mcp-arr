/**
 * Small child-process lifecycle helper shared by the validation scripts.
 *
 * It manages ONLY the child the calling script spawned: track its exit from
 * the moment of spawn (so an already-exited or spawn-failed child never leaves
 * the script waiting), and stop it with a bounded, escalating
 * SIGTERM → SIGKILL sequence. This is deliberately not a process-management
 * framework: no name-based kills, no port-based kills, no exit-event handlers
 * doing async work.
 */

export function trackChildExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
}

export function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function raceTimeout(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ]);
}

/**
 * Stop the owned child: SIGTERM, wait up to graceMs for the tracked exit, then
 * escalate to SIGKILL and wait up to killMs. Returns once the child is gone or
 * the bounded waits are exhausted — it never hangs on a child that already
 * exited, crashed, or failed to spawn.
 */
export async function stopOwnedChild(child, exited, { graceMs = 5000, killMs = 3000 } = {}) {
  if (childExited(child)) return;
  child.kill("SIGTERM");
  const term = await raceTimeout(exited, graceMs);
  if (!term.timedOut) return;
  child.kill("SIGKILL");
  await raceTimeout(exited, killMs);
}
