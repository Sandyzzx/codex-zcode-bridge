import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "dist", "src", "mcp", "main.js");
const pluginRoot = path.join(repoRoot, "plugins", "codex-zcode-bridge");
const configPath = path.join(pluginRoot, ".mcp.json");
const builtinConfig = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
const personalConfig = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
const unrestrictedExecution = process.env.ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION?.trim();

try {
  await access(entry);
} catch {
  console.error("Bridge 尚未构建，请先运行 npm run build。");
  process.exit(1);
}

if (Boolean(builtinConfig) !== Boolean(personalConfig)) {
  console.error("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 和 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 必须同时设置。");
  process.exit(1);
}

if (unrestrictedExecution !== "1") {
  console.error("此 Bridge 使用 ZCode yolo 模式；生成 Codex 插件配置前，必须显式设置 ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION=1 并确认已审查工作区与任务权限。");
  process.exit(1);
}

if (builtinConfig && personalConfig) {
  for (const [label, configPath] of [["builtin", builtinConfig], ["personal", personalConfig]]) {
    if (!path.isAbsolute(configPath)) {
      console.error(`${label} provider config 路径必须是绝对路径：${configPath}`);
      process.exit(1);
    }
    try {
      await access(configPath);
    } catch {
      console.error(`${label} provider config 文件不可读：${configPath}`);
      process.exit(1);
    }
  }
}

const config = {
  mcpServers: {
    zcode_bridge: {
      command: process.execPath,
      args: [entry],
      cwd: repoRoot,
      ...(builtinConfig && personalConfig
        ? { env: {
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfig,
            ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalConfig,
            ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION: "1",
          } }
        : { env: { ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION: "1" } }),
    },
  },
};

await mkdir(pluginRoot, { recursive: true });
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
console.log("已生成本机 Codex MCP 配置：" + configPath);
