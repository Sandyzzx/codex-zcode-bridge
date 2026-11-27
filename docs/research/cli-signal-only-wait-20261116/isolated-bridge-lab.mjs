import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const RUNTIME_KEYS = [
  "ZCODE_BRIDGE_NODE",
  "ZCODE_BRIDGE_ZCODE_CJS",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_HOME",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_WINDOWS_APP_INSTALL_DIR",
  "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID",
  "ZCODE_BRIDGE_DEFAULT_MODEL_ID",
  "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL",
  "ZCODE_BRIDGE_PREFER_STARTPLAN",
  "ZCODE_BRIDGE_MODE",
  "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS",
  "ZCODE_BRIDGE_TIMEOUT_MS",
  "ZCODE_BRIDGE_BROWSER_USE",
  "ZCODE_BRIDGE_BROWSER_EXECUTABLE",
];

export async function connectIsolatedBridge(options) {
  const workspace = path.resolve(options.workspace);
  const isolatedRoot = path.resolve(options.isolatedRoot);
  const pluginRoot = path.join(workspace, "plugins", "codex-zcode-bridge");
  const profileRoot = path.join(isolatedRoot, "profile");
  const localAppData = path.join(profileRoot, "AppData", "Local");
  const tempRoot = path.join(isolatedRoot, "temp");
  const bridgeDataRoot = path.join(isolatedRoot, "bridge-data");

  await Promise.all([
    mkdir(localAppData, { recursive: true }),
    mkdir(tempRoot, { recursive: true }),
    mkdir(bridgeDataRoot, { recursive: true }),
  ]);

  const persisted = JSON.parse(await readFile(options.runtimeConfigPath, "utf8"));
  const inherited = {};
  for (const key of RUNTIME_KEYS) {
    if (typeof persisted[key] === "string") inherited[key] = persisted[key];
  }

  const env = {
    ...process.env,
    ...inherited,
    LOCALAPPDATA: localAppData,
    TEMP: tempRoot,
    TMP: tempRoot,
    ZCODE_BRIDGE_DATA_DIR: bridgeDataRoot,
    ZCODE_BRIDGE_PLUGIN_MODE: "1",
  };

  let stderr = "";
  const transport = new StdioClientTransport({
    command: persisted.ZCODE_BRIDGE_NODE || process.execPath,
    args: [path.join(pluginRoot, "launch-node24.mjs")],
    cwd: pluginRoot,
    env,
    stderr: "pipe",
  });
  transport.stderr?.setEncoding?.("utf8");
  transport.stderr?.on?.("data", (chunk) => {
    stderr = (stderr + chunk).slice(-32_768);
  });

  const client = new Client(
    { name: "cli-signal-only-wait-lab", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }

  return {
    client,
    transport,
    isolatedRoot,
    profileRoot,
    stateDir: path.join(localAppData, "CodexZCodeBridge", "state"),
    stderr: () => stderr,
  };
}

export async function callBridgeTool(session, name, args) {
  const result = await session.client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = textContent(result);
    throw new Error(`${name} failed: ${text || "tool error"}`);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textContent(result);
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

export async function closeIsolatedBridge(session) {
  await session.client.close().catch(() => {});
  await session.transport.close().catch(() => {});
}

function textContent(result) {
  return (result.content ?? [])
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}
