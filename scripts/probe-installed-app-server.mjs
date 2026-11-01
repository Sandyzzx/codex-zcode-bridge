import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = resolve(root, ".evidence");
await mkdir(evidenceDir, { recursive: true });
const found = spawnSync("where.exe", ["codex"], { encoding: "utf8" });
if (found.status !== 0) throw new Error("codex_executable_not_found");
const executable = found.stdout.split(/\r?\n/).find(Boolean)?.trim();
if (!executable) throw new Error("codex_executable_not_found");
const versionResult = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
if (versionResult.status !== 0) throw new Error("codex_version_failed");

const child = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
child.stderr.resume();
const timer = setTimeout(() => child.kill(), 30_000);
try {
  const responsePromise = new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => reject(new Error("initialize_timeout")), 25_000);
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        clearTimeout(timeout);
        resolveResponse(message);
      }
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`app_server_exited_${code}`)));
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "thread-token-usage-e2e-probe", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    },
  })}\n`);
  const initialize = await responsePromise;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.end();
  await new Promise(resolveExit => child.once("exit", resolveExit));
  const sanitizedInitialize = structuredClone(initialize);
  if (sanitizedInitialize.result && typeof sanitizedInitialize.result === "object") {
    delete sanitizedInitialize.result.codexHome;
  }
  const evidence = {
    probe: "installed-app-server-initialize",
    classification: "REAL_INSTALLED_BINARY_HANDSHAKE_ONLY",
    executable: "<redacted-install-path>\\codex.exe",
    cliVersion: versionResult.stdout.trim(),
    experimentalApiRequested: false,
    initializeResponse: sanitizedInitialize,
  };
  await writeFile(resolve(evidenceDir, "runtime-initialize.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill();
}
