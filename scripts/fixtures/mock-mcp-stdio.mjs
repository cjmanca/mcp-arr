// Mock stdio MCP server for validation-script regressions. Responds to
// initialize / tools/list / tools/call with scenarios driven by env:
//   MOCK_STDIO_TOOLS   JSON array of tool names for tools/list
//   MOCK_STDIO_MODE    ok | rpc-error | exit-early | tool-error | garbage | silent
const TOOLS = JSON.parse(process.env.MOCK_STDIO_TOOLS || JSON.stringify([
  "arr_get_operation",
  "arr_cancel_operation",
  "lidarr_get_manual_import_candidates",
  "sonarr_get_manual_import_candidates",
  "radarr_get_manual_import_candidates",
]));
const MODE = process.env.MOCK_STDIO_MODE || "ok";

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

function handle(msg) {
  if (msg.method === "initialize") {
    if (MODE === "rpc-error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "mock rpc error" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-mcp", version: "0.0.0-mock" } },
    });
    if (MODE === "exit-early") setImmediate(() => process.exit(9));
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOLS.map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: "object", properties: {} } })) },
    });
    return;
  }
  if (msg.method === "tools/call") {
    if (MODE === "garbage") {
      process.stdout.write("this is not json\n");
      return;
    }
    if (MODE === "silent") {
      return; // never answers: the smoke's per-request deadline must fire
    }
    if (MODE === "tool-error") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "mock tool failure" }], isError: true } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify({ sonarr: { configured: true, connected: true, version: "0", appName: "mock" } }) }] },
    });
    return;
  }
}
