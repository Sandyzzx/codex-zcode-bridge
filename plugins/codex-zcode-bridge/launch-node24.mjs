// Keep this shim within Node 22 syntax so unsupported runtimes can report a
// clear rejection before loading the product bundle. SQLite Authority has its
// own Node 24.16+ gate and is selected only after this entry point starts.
import { fileURLToPath } from "node:url";

const bridgeBundleUrl = new URL("./dist/bridge.mjs", import.meta.url);
const bridgeEntryPath = fileURLToPath(bridgeBundleUrl);
const version = process.versions.node;
const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
const supported = match !== null
  && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 18));

if (!supported) {
  console.error(`Unsupported Node.js runtime ${version}; Zcode Bridge requires Node >=22.18.`);
  process.exitCode = 1;
} else {
  const bridge = await import(bridgeBundleUrl.href);
  if (typeof bridge.runBridgeEntrypoint !== "function") {
    throw new Error("Bridge bundle does not expose its verified entry point.");
  }
  await bridge.runBridgeEntrypoint(bridgeEntryPath);
}
