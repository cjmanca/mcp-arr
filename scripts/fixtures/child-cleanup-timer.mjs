// Fixture for the cleanup-timer regression: spawn an owned child, wait for its
// readiness signal, call stopOwnedChild(), then exit NATURALLY (no
// process.exit()). If stopOwnedChild leaves a scheduled race timer behind, the
// Node event loop stays alive until that timer fires — the parent's total
// runtime reveals the leak.
import { spawn } from "node:child_process";
import { trackChildExit, stopOwnedChild } from "../managed-child.mjs";

const graceMs = Number(process.env.CLEANUP_GRACE_MS || "3000");

const child = spawn(
  process.execPath,
  ["-e", "console.log('ready'); setInterval(() => {}, 10_000);"],
  { stdio: ["ignore", "pipe", "ignore"] },
);
const tracked = trackChildExit(child);

await new Promise((resolve, reject) => {
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    if (buf.includes("ready")) resolve();
  });
  child.once("error", reject);
  child.once("exit", () => reject(new Error("child exited before readiness")));
});

const started = Date.now();
await stopOwnedChild(child, tracked, { graceMs });
console.log(`cleanup-ms=${Date.now() - started}`);
// Natural exit: nothing keeps the loop alive when cleanup cleared its timers.
