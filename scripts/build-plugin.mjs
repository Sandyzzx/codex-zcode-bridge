import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins", "codex-zcode-bridge");
const distDir = path.join(pluginRoot, "dist");
const workerDir = path.join(pluginRoot, "worker");
await Promise.all([mkdir(distDir, { recursive: true }), mkdir(workerDir, { recursive: true })]);

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
  build({ ...shared, entryPoints: [path.join(repoRoot, "src", "mcp", "main.ts")], outfile: path.join(distDir, "bridge.mjs") }),
  build({ ...shared, entryPoints: [path.join(repoRoot, "src", "worker", "worker-main.ts")], outfile: path.join(workerDir, "worker-main.mjs") }),
]);

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const bridgeBundlePath = path.join(distDir, "bridge.mjs");
const bridgeBundle = await readFile(bridgeBundlePath, "utf8");
const versionPattern = /var SERVER_VERSION = "[^"]+";/;
if (!versionPattern.test(bridgeBundle)) {
  throw new Error("Could not find the bundled SERVER_VERSION declaration.");
}
await writeFile(
  bridgeBundlePath,
  bridgeBundle.replace(versionPattern, `var SERVER_VERSION = "${packageJson.version}"; // x-release-please-version`),
  "utf8",
);

console.log("Built the self-contained Codex marketplace plugin server and worker.");
