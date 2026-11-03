import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createWorkerEnv } from "../dist/src/runtime/child-env.js";

const probeModule = fileURLToPath(new URL("../dist/src/runtime/process-probe.js", import.meta.url));
const childSource = [
  `import { createPlatformProbe } from ${JSON.stringify(pathToFileURL(probeModule).href)};`,
  "const failures = [];",
  "const identity = await createPlatformProbe({ timeoutMs: 10_000, onWindowsQueryFailure: reason => failures.push(reason) }).selfIdentity();",
  "console.log(JSON.stringify({ platform: identity.platform, precision: identity.fingerprint_precision, hasFingerprint: Boolean(identity.fingerprint), failures }));",
  "if (identity.platform !== 'win32' || identity.fingerprint_precision !== 'exact' || !identity.fingerprint) process.exitCode = 1;",
].join("\n");
function runProbe(env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  const output = result.stdout?.trim().split(/\r?\n/u).at(-1) ?? "{}";
  let diagnostic;
  try { diagnostic = JSON.parse(output); } catch { diagnostic = { output: "unparseable" }; }
  return { status: result.status, error: result.error?.code ?? null, ...diagnostic };
}

const result = runProbe(createWorkerEnv(process.env));
console.log(JSON.stringify(result));
if (result.status !== 0) process.exitCode = 1;
