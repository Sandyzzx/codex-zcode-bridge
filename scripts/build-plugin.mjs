import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins", "codex-zcode-bridge");
const serverDir = path.join(pluginRoot, "server");
const workerDir = path.join(pluginRoot, "worker");
await Promise.all([mkdir(serverDir, { recursive: true }), mkdir(workerDir, { recursive: true })]);

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.18",
  sourcemap: false,
  packages: "bundle",
  logLevel: "info",
};

await Promise.all([
  build({ ...shared, entryPoints: [path.join(repoRoot, "src", "mcp", "main.ts")], outfile: path.join(serverDir, "bridge.mjs") }),
  build({ ...shared, entryPoints: [path.join(repoRoot, "src", "worker", "worker-main.ts")], outfile: path.join(workerDir, "worker-main.mjs") }),
]);
console.log("Built the self-contained Codex marketplace plugin server and worker.");
