// TEST-ONLY process that keeps one isolated Bridge MCP stdio session alive
// across short control-script invocations. It is not part of the product path.
import { writeFile } from "node:fs/promises";
import net from "node:net";
import {
  callBridgeTool,
  closeIsolatedBridge,
  connectIsolatedBridge,
} from "./isolated-bridge-lab.mjs";

const options = parseArgs(process.argv.slice(2));
const session = await connectIsolatedBridge(options);
let closing = false;
let commandChain = Promise.resolve();

const server = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      commandChain = commandChain
        .then(() => handleCommand(line, socket))
        .catch((error) => send(socket, { ok: false, error: safeError(error) }));
    }
  });
});

server.on("error", async (error) => {
  process.stderr.write(`broker: ${safeError(error)}\n`);
  await shutdown();
  process.exitCode = 2;
});

server.listen(options.pipe, async () => {
  await writeFile(options.readyFile, JSON.stringify({
    schema: "cli-signal-only-wait-broker/v1",
    pid: process.pid,
    pipe: options.pipe,
    isolated_root: session.isolatedRoot,
    state_dir: session.stateDir,
    started_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
});

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

async function handleCommand(line, socket) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send(socket, { ok: false, error: "invalid_json" });
    return;
  }

  if (request.command === "health") {
    send(socket, {
      ok: true,
      state_dir: session.stateDir,
      stderr_tail: session.stderr().slice(-500),
    });
    return;
  }

  if (request.command === "call") {
    if (typeof request.tool !== "string" || !request.tool) {
      send(socket, { ok: false, error: "missing_tool" });
      return;
    }
    if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
      send(socket, { ok: false, error: "arguments_must_be_object" });
      return;
    }
    try {
      const result = await callBridgeTool(session, request.tool, request.arguments);
      send(socket, { ok: true, result });
    } catch (error) {
      send(socket, { ok: false, error: safeError(error) });
    }
    return;
  }

  if (request.command === "close") {
    send(socket, { ok: true, closing: true });
    await shutdown(0);
    return;
  }

  send(socket, { ok: false, error: "unknown_command" });
}

function send(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(resolve));
  await closeIsolatedBridge(session);
  process.exitCode = exitCode;
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/gu, " ")
    .slice(0, 500);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    values[key.replace(/^--/u, "")] = value;
  }
  for (const required of ["workspace", "isolated-root", "runtime-config", "pipe", "ready-file"]) {
    if (!values[required]) throw new Error(`missing --${required}`);
  }
  return {
    workspace: values.workspace,
    isolatedRoot: values["isolated-root"],
    runtimeConfigPath: values["runtime-config"],
    pipe: values.pipe,
    readyFile: values["ready-file"],
  };
}
