import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertSupportedNodeRuntime, isSupportedNodeVersion, SUPPORTED_NODE_RANGE } from "../src/runtime/node-runtime.js";

test("SQLite runtime gate accepts Node 24.16+ and rejects Node 22, early 24, prerelease, and Node 25", () => {
  for (const version of ["24.16.0", "24.16.1", "24.99.999"]) assert.equal(isSupportedNodeVersion(version), true, version);
  for (const version of ["22.18.0", "23.0.0", "24.15.99", "24.16.0-rc.1", "25.0.0", "v24.16.0", "unknown"]) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
  assert.doesNotThrow(() => assertSupportedNodeRuntime("24.16.0"));
  assert.throws(() => assertSupportedNodeRuntime("22.18.0"), new RegExp(SUPPORTED_NODE_RANGE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("marketplace launcher preserves the Node 22.18+ product gate before loading the Bridge bundle", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "bridge-node24-launcher-"));
  const plugin = path.join(fixture, "plugin");
  const dist = path.join(plugin, "dist");
  const marker = path.join(fixture, "bundle-loaded.txt");
  mkdirSync(dist, { recursive: true });
  try {
    const launcher = readFileSync(path.resolve("plugins/codex-zcode-bridge/launch-node24.mjs"), "utf8");
    writeFileSync(path.join(plugin, "launch-node24.mjs"), launcher);
    writeFileSync(path.join(dist, "bridge.mjs"), `import { writeFileSync } from "node:fs"; export async function runBridgeEntrypoint() { writeFileSync(${JSON.stringify(marker)}, process.versions.node); }`);
    const result = spawnSync(process.execPath, [path.join(plugin, "launch-node24.mjs")], { cwd: plugin, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, "utf8"), process.versions.node);

    for (const supportedVersion of ["22.18.0", "22.18.1", "24.15.3", "25.0.0"]) {
      rmSync(marker, { force: true });
      writeFileSync(path.join(plugin, "launch-node24.mjs"), launcher.replace(
        "const version = process.versions.node;",
        `const version = ${JSON.stringify(supportedVersion)};`,
      ));
      const accepted = spawnSync(process.execPath, [path.join(plugin, "launch-node24.mjs")], { cwd: plugin, encoding: "utf8", windowsHide: true });
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(readFileSync(marker, "utf8"), process.versions.node);
    }

    for (const unsupportedVersion of ["22.17.9", "21.99.0", "not-a-version"]) {
      rmSync(marker, { force: true });
      writeFileSync(path.join(plugin, "launch-node24.mjs"), launcher.replace(
        "const version = process.versions.node;",
        `const version = ${JSON.stringify(unsupportedVersion)};`,
      ));
      const rejected = spawnSync(process.execPath, [path.join(plugin, "launch-node24.mjs")], { cwd: plugin, encoding: "utf8", windowsHide: true });
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /requires Node >=22\.18/u);
      assert.equal(existsSync(marker), false, `bundle loaded for unsupported ${unsupportedVersion}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("marketplace launcher starts the actual built Bridge bundle and completes an isolated MCP initialize", { timeout: 45_000, skip: process.platform !== "win32" }, async () => {
  assert.equal(process.versions.node, "24.16.0", "this R1 launcher acceptance run uses the pinned Node runtime");
  const pluginRoot = path.resolve("plugins/codex-zcode-bridge");
  const launcherPath = realpathSync(path.join(pluginRoot, "launch-node24.mjs"));
  const bundlePath = realpathSync(path.join(pluginRoot, "dist/bridge.mjs"));
  assert.ok(existsSync(launcherPath));
  assert.ok(existsSync(bundlePath));

  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "wp6-r1-real-launcher-"));
  const dataRoot = path.join(fixtureRoot, "data-root");
  const isolatedHome = path.join(fixtureRoot, "home");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    PSModulePath: process.env.PSModulePath,
    USERPROFILE: isolatedHome,
    HOME: isolatedHome,
    APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
    ZCODE_BRIDGE_PLUGIN_MODE: "1",
    ZCODE_BRIDGE_DATA_DIR: dataRoot,
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let passed = false;
  const evidencePath = process.env["WP6_R1_LAUNCHER_EVIDENCE_FILE"];
  const evidence: Record<string, unknown> = {
    command: process.execPath,
    argv: ["./launch-node24.mjs"],
    cwd: pluginRoot,
    runtime: process.versions.node,
    launcherPath,
    launcherSha256: createHash("sha256").update(readFileSync(launcherPath)).digest("hex").toUpperCase(),
    bridgeBundlePath: bundlePath,
    bridgeBundleSha256: createHash("sha256").update(readFileSync(bundlePath)).digest("hex").toUpperCase(),
    isolatedDataRoot: dataRoot,
    providerInvocation: false,
    taskInvocation: false,
  };

  try {
    const spawned = spawn(process.execPath, ["./launch-node24.mjs"], {
      cwd: pluginRoot,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = spawned;
    const childStdin = spawned.stdin;
    const childStdout = spawned.stdout;
    const childStderr = spawned.stderr;
    assert.ok(childStdin && childStdout && childStderr, "launcher child must expose the configured stdio pipes");
    evidence["pid"] = spawned.pid;
    evidence["parentPid"] = process.pid;
    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: string) => stdout.push(chunk));
    childStderr.on("data", (chunk: string) => stderr.push(chunk));

    type RpcResponse = { id?: number; result?: { tools?: Array<{ name?: string }> }; error?: unknown };
    const waiters = new Map<number, { resolve: (message: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let protocolBuffer = "";
    childStdout.on("data", (chunk: string) => {
      protocolBuffer += chunk;
      for (;;) {
        const newline = protocolBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = protocolBuffer.slice(0, newline).trim();
        protocolBuffer = protocolBuffer.slice(newline + 1);
        if (!line) continue;
        let message: RpcResponse;
        try {
          message = JSON.parse(line) as RpcResponse;
        } catch (error) {
          const failure = new Error(`real launcher wrote non-JSON stdout: ${String(error)}; ${line}`);
          for (const waiter of waiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(failure);
          }
          waiters.clear();
          return;
        }
        if (typeof message.id === "number") {
          const waiter = waiters.get(message.id);
          if (waiter) {
            clearTimeout(waiter.timer);
            waiters.delete(message.id);
            waiter.resolve(message);
          }
        }
      }
    });
    const requestResponse = (id: number, request: Record<string, unknown>): Promise<RpcResponse> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`real launcher MCP request ${id} timed out`));
      }, 10_000);
      waiters.set(id, { resolve, reject, timer });
      childStdin.write(`${JSON.stringify(request)}\n`);
    });
    child.once("error", (error) => {
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      waiters.clear();
    });

    const initialize = await requestResponse(1, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wp6-r1-real-launcher-probe", version: "1.0.0" } },
    });
    assert.ok(initialize.result, "actual Bridge must acknowledge MCP initialize before the client continues");
    assert.equal(initialize.error, undefined, "MCP initialize must not return an error");
    childStdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await requestResponse(2, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listedTools = listed.result?.tools ?? [];
    assert.ok(listedTools.some((tool) => tool.name === "zcode_task"), "the actual Bridge Bundle must answer tools/list");

    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const processId = child.pid;
    assert.ok(processId, "launcher child must have an OS process id");
    const inspectCommand = `$target = Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}' | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine; $children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${processId}' | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); [ordered]@{target=$target;children=$children} | ConvertTo-Json -Compress -Depth 4`;
    const processObservation = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", inspectCommand], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
      env: childEnv,
    });
    assert.equal(processObservation.status, 0, `process identity query failed: ${processObservation.stderr}`);
    const processTree = JSON.parse(processObservation.stdout) as {
      target?: { ProcessId?: number; ParentProcessId?: number; Name?: string; ExecutablePath?: string; CommandLine?: string };
      children?: Array<{ ProcessId?: number; ParentProcessId?: number; Name?: string; ExecutablePath?: string; CommandLine?: string }>;
    };
    evidence["processTree"] = processTree;
    assert.equal(processTree.target?.ProcessId, processId, "OS observation must identify the exact Bridge PID");
    assert.equal(processTree.target?.ParentProcessId, process.pid, "Bridge PID must be a child of this test process");
    assert.match(processTree.target?.CommandLine ?? "", /launch-node24\.mjs/u);
    const children = processTree.children ?? [];
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const expectedConsoleHostPath = path.win32.normalize(path.join(systemRoot, "System32", "conhost.exe")).toLowerCase();
    assert.ok(children.length <= 1, "initialize/tools-list must not start a Worker or arbitrary child process");
    for (const processInfo of children) {
      assert.equal(processInfo.ParentProcessId, processId, "every observed child must belong directly to the Bridge process");
      assert.equal(processInfo.Name?.toLowerCase(), "conhost.exe", "only the Windows console host helper may be a direct child");
      assert.equal(
        path.win32.normalize(processInfo.ExecutablePath ?? "").toLowerCase(),
        expectedConsoleHostPath,
        "the permitted console host must be the System32 executable",
      );
    }

    childStdin.end();
    close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("real launcher did not exit after stdio EOF")), 8_000);
      child!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(close, { code: 0, signal: null }, `Bridge exit must be clean; stderr: ${stderr.join("")}`);
    assert.ok(stderr.join("").includes(`data root: ${dataRoot}`), "Bridge must use the isolated synthetic data root");
    assert.doesNotMatch(stderr.join(""), /fatal:|Unsupported Node/u);
    assert.ok(!stdout.join("").includes("[bridge]"), "stdout must remain JSON-RPC only");

    const dataFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(item);
        else dataFiles.push(path.relative(dataRoot, item));
      }
    };
    visit(dataRoot);
    assert.equal(dataFiles.some((name) => /\.(?:db|sqlite|sqlite3)(?:$|-)/iu.test(name)), false, "JSON initialize must not create SQLite storage");
    evidence["dataFiles"] = dataFiles;
    evidence["stdout"] = stdout.join("");
    evidence["stderr"] = stderr.join("");
    evidence["exit"] = close;
    evidence["status"] = "PASS";
    passed = true;
  } catch (error) {
    evidence["stdout"] = stdout.join("");
    evidence["stderr"] = stderr.join("");
    evidence["exit"] = close ?? (child ? { code: child.exitCode, signal: child.signalCode } : undefined);
    evidence["error"] = error instanceof Error ? error.stack ?? error.message : String(error);
    evidence["status"] = "BLOCKED";
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child.kill();
      let killDeadlineTimer: NodeJS.Timeout | undefined;
      const killDeadline = new Promise<void>((resolve) => {
        killDeadlineTimer = setTimeout(resolve, 3_000);
      });
      const closeObserved = await Promise.race([closed.then(() => true), killDeadline.then(() => false)]);
      if (killDeadlineTimer) clearTimeout(killDeadlineTimer);
      if (!closeObserved) evidence["cleanupError"] = "owned launcher child did not close within the 3-second cleanup bound";
      else evidence["cleanupExit"] = { code: child.exitCode, signal: child.signalCode };
    }
    if (evidencePath) {
      const evidenceRoot = path.resolve(".run/wp6-r1-fix01-20261024");
      const resolvedEvidence = path.resolve(evidencePath);
      assert.ok(resolvedEvidence.startsWith(`${evidenceRoot}${path.sep}`), "launcher evidence must remain under the isolated project run root");
      writeFileSync(resolvedEvidence, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    if (passed) rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
