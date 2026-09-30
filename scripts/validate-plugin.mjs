import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "codex-zcode-bridge");

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const pkg = await readJson(path.join(root, "package.json"), "package.json");
const plugin = await readJson(path.join(pluginRoot, "plugin.json"), "plugin.json");
const codexPlugin = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), ".codex-plugin/plugin.json");
const mcp = await readJson(path.join(pluginRoot, ".mcp.json"), ".mcp.json");

for (const [label, manifest] of [["plugin.json", plugin], [".codex-plugin/plugin.json", codexPlugin]]) {
  const hasLocalCachebuster =
    label === ".codex-plugin/plugin.json" &&
    typeof manifest.version === "string" &&
    manifest.version.startsWith(`${pkg.version}+codex.`) &&
    /^[a-z0-9-]+$/.test(manifest.version.slice(`${pkg.version}+codex.`.length));
  if (manifest.name !== pkg.name || (manifest.version !== pkg.version && !hasLocalCachebuster)) {
    throw new Error(`${label} identity/version must match package.json (${pkg.name}@${pkg.version})`);
  }
}
const server = mcp.mcpServers?.zcode_bridge;
if (server?.command !== "node" || !Array.isArray(server.args) || server.args[0] !== "./dist/bridge.mjs") {
  throw new Error(".mcp.json must launch ./dist/bridge.mjs with node");
}
if (server.env?.ZCODE_BRIDGE_PLUGIN_MODE !== "1") {
  throw new Error(".mcp.json must set ZCODE_BRIDGE_PLUGIN_MODE=1");
}

for (const relativePath of [
  "dist/bridge.mjs",
  "worker/worker-main.mjs",
  "hooks/hooks.json",
  "hooks/session-start.mjs",
  "hooks/configure-runtime.ps1",
  "skills/zcode-bridge/SKILL.md",
]) {
  await access(path.join(pluginRoot, relativePath));
}

console.log(`Plugin package is structurally valid (${plugin.name}@${plugin.version}).`);

