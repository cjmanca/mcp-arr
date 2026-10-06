// Stdio registration smoke for the MCP server: initialize, tools/list, and one
// tool call over the stdio transport. Required tools are ASSERTED (a missing
// tool fails the script with a nonzero exit), every protocol response is
// validated (JSON-RPC error vs missing result vs tool-level error vs
// malformed output), all waits are bounded, and the child this script spawned
// is cleaned up on success AND failure before the script exits.
//
// arr_status establishes that the server answers a tool call over stdio; it is
// NOT proof that every configured service is connected. Per-service connection
// status is reported from the payload, and unconfigured optional services are
// not a smoke failure.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { trackChildExit, stopOwnedChild } from "./managed-child.mjs";

const REQUIRED_TOOLS = [
  "arr_get_operation",
  "arr_cancel_operation",
  "lidarr_get_manual_import_candidates",
  "sonarr_get_manual_import_candidates",
  "radarr_get_manual_import_candidates",
];

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

function assertRpcResult(message, label) {
  if (message.error) {
    throw new Error(`${label} returned a JSON-RPC error: ${message.error.message ?? JSON.stringify(message.error)}`);
  }
  if (!message.result || typeof message.result !== "object") {
    throw new Error(`${label} returned no result object`);
  }
  return message.result;
}

function describeServices(payload) {
  if (!payload || typeof payload !== "object") return "payload not JSON (connectivity not reported)";
  const parts = Object.entries(payload).map(([service, info]) => {
    if (!info || typeof info !== "object") return `${service}=?`;
    return `${service}=${info.connected === true ? "connected" : info.configured === true ? "NOT connected" : "unconfigured"}`;
  });
  return parts.length > 0 ? parts.join(", ") : "no services reported";
}

/**
 * Run the stdio smoke. Throws on any failed assertion; the owned child is
 * stopped before the returned promise settles, on success and on failure.
 */
export async function runStdioSmoke(options = {}) {
  const {
    spawnCmd = process.execPath,
    spawnArgs = ["dist/index.js"],
    env = loadLocalEnv(),
    requestTimeoutMs = 15_000,
    onChild = () => {},
  } = options;

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env, MCP_TRANSPORT: "stdio" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = trackChildExit(child);
  onChild(child);

  const pending = new Map();
  const failPending = (reason) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  };
  child.once("exit", (code, signal) => failPending(`MCP child exited before responding (code=${code ?? "null"}, signal=${signal ?? "none"})`));
  child.once("error", (error) => failPending(`MCP child process error: ${error.message}`));
  child.stdin.on("error", (error) => failPending(`stdin write failed: ${error.message}`));

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        failPending(`malformed protocol output: non-JSON line on stdout: ${truncate(line)}`);
        return;
      }
      if (message?.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  });

  function send(method, params, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to ${method} within ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            clearTimeout(entry.timer);
            entry.reject(new Error(`stdin write failed: ${error.message}`));
          }
        }
      });
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  try {
    const init = assertRpcResult(await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    }, 1), "initialize");
    if (!init.serverInfo?.name) throw new Error("initialize response has no serverInfo.name");
    console.log("initialize:", init.serverInfo.name, init.serverInfo.version ?? "?");
    notify("notifications/initialized", {});

    const listed = assertRpcResult(await send("tools/list", {}, 2), "tools/list");
    if (!Array.isArray(listed.tools)) throw new Error("tools/list returned no tools array");
    const names = new Set(listed.tools.map((t) => t?.name).filter(Boolean));
    const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`required MCP tools missing from tools/list: ${missing.join(", ")}`);
    }
    console.log(`tools/list: ${names.size} tools registered; all ${REQUIRED_TOOLS.length} required tools present`);

    const status = assertRpcResult(await send("tools/call", { name: "arr_status", arguments: {} }, 3), "arr_status");
    const statusText = Array.isArray(status.content) ? status.content[0]?.text : undefined;
    if (typeof statusText !== "string") throw new Error("arr_status returned a malformed MCP result (no content[0].text)");
    if (status.isError === true) {
      throw new Error(`arr_status reported a tool-level error: ${truncate(statusText)}`);
    }
    let statusPayload = null;
    try { statusPayload = JSON.parse(statusText); } catch { /* reported below as unparsable */ }
    console.log(`arr_status: server answered a tool call over stdio; per-service status: ${describeServices(statusPayload)}`);
    console.log("stdio smoke passed");
    return { toolCount: names.size };
  } catch (error) {
    const tail = stderr.trim().split(/\r?\n/).slice(-5).join(" | ");
    if (tail) console.error(`server stderr: ${truncate(tail)}`);
    throw error;
  } finally {
    await stopOwnedChild(child, exited);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runStdioSmoke().catch((error) => {
    console.error(`stdio smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
