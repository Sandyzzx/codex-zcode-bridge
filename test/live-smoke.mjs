// Manual live smoke test for the ZCodeAdapter — NOT part of `npm test`.
// It performs exactly one real model invocation and creates exactly one file,
// inside a disposable workspace under the system temp directory.
//
// Prerequisites:
//   1. A build exists (npm run build).
//   2. The environment provides a valid official provider pair
//      (ZCODE_BUILTIN_PROVIDER_CONFIG_FILE + ZCODE_PERSONAL_PROVIDER_CONFIG_FILE),
//      or ZCODE_WINDOWS_APP_INSTALL_DIR / LOCALAPPDATA + ZCODE_DATA_BASE_DIR so
//      the RuntimeResolver can discover them (see docs/ZCODE_RUNTIME.md).
//
// Usage: node test/live-smoke.mjs (legacy CLI path; invokes a real model)
// On configuration or transient release errors this script reports and stops;
// it never retries or bisects environment combinations.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { NodeRuntimeResolver } from "../dist/src/runtime/resolver.js";
import { ZCodeAdapter } from "../dist/src/adapters/zcode-adapter.js";

const workspace = await mkdtemp(path.join(tmpdir(), "zcode-adapter-smoke-"));
const fileName = "zcode-adapter-smoke.txt";
try {
  const resolver = new NodeRuntimeResolver({ env: process.env });
  const config = await resolver.resolve();
  console.log("runtime resolved:", {
    nodeExecutable: config.nodeExecutable,
    zcodeEntrypoint: config.zcodeEntrypoint,
    builtin: config.providerBuiltinConfigFile,
    personal: config.providerPersonalConfigFile,
    dataRoot: config.dataRoot,
  });

  const adapter = new ZCodeAdapter({
    resolver,
    timeoutMs: 300_000,
    promptTmpDir: workspace,
  });
  const task = {
    task_id: "adapter_smoke_1",
    workspace,
    objective:
      `Create exactly one file named ${fileName} in the current directory. Its entire content must be the single line ZCODE_ADAPTER_SMOKE_OK. Do not create, modify, or delete any other file. Do not run tests or install anything.`,
    requirements: ["Exactly one new file", "Exact single-line content"],
    allowed_paths: [fileName],
    forbidden_paths: [],
    acceptance_criteria: [`${fileName} exists with content ZCODE_ADAPTER_SMOKE_OK`],
    test_commands: [],
  };
  const handle = await adapter.startTask({
    task,
    workspace: { requestedPath: workspace, canonicalPath: workspace, mode: "direct" },
    attempt: 1,
  });
  const outcome = await adapter.getResult(handle);
  console.log("outcome:", JSON.stringify({
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    sessionId: outcome.sessionId,
    errorCode: outcome.errorCode,
    reportError: outcome.reportError,
    attempts: outcome.attempts,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    agentReport: outcome.agentReport,
    stderr: outcome.stderr,
  }, null, 2));

  if (outcome.exitCode !== 0 || outcome.errorCode || outcome.reportError) {
    throw new Error(
      `smoke failed: adapter outcome was not successful (exitCode=${String(outcome.exitCode)}, errorCode=${String(outcome.errorCode)}, reportError=${String(outcome.reportError)})`,
    );
  }
  if (!outcome.sessionId || !outcome.agentReport) {
    throw new Error("smoke failed: successful outcome is missing its session id or AgentReport");
  }

  const filePath = path.join(workspace, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`smoke failed: ${fileName} was not created in the workspace`);
  }
  const content = await readFile(filePath, "utf8");
  console.log("file content:", JSON.stringify(content));
  if (content !== "ZCODE_ADAPTER_SMOKE_OK" && content !== "ZCODE_ADAPTER_SMOKE_OK\n") {
    throw new Error("smoke failed: file content does not exactly match the expected single line");
  }
  const workspaceFiles = await (await import("node:fs/promises")).readdir(workspace);
  console.log("workspace files after run:", workspaceFiles);
  if (workspaceFiles.length !== 1 || workspaceFiles[0] !== fileName) {
    throw new Error(`smoke failed: unexpected workspace contents: ${workspaceFiles.join(", ")}`);
  }
  console.log("SMOKE_OK");
} catch (error) {
  console.error("SMOKE_FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}
