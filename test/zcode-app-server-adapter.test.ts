import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { createPlatformProbe, isProcessRunning, verifyProcessTreeClaimantsClean } from "../src/adapters/process-spawn.js";
import { BridgeError } from "../src/runtime/errors.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";
import { makeWorkspace, SESSION_ID, validReport } from "./helpers.js";

const task: TaskPackage = {
  task_id: "model_override_test",
  workspace: "C:\\unused",
  objective: "Return the requested report",
  requirements: [],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: [],
  test_commands: [],
};

// Test-only observation; do not serialize identities, paths, exception messages or process IDs.
function observeScan(correlation: string, scan: typeof verifyProcessTreeClaimantsClean = verifyProcessTreeClaimantsClean) {
  const observation: { correlation_id: string; scan_start: string | null; scan_end: string | null; elapsed_ms: number | null; root_exit_observed: boolean | null; recorded_identity_present: boolean | null; claimant_scan_outcome: string; sanitized_error_class: string | null; final_cleanup_verdict: string; final_bridge_error_code: string | null } = {
    correlation_id: correlation, scan_start: null, scan_end: null, elapsed_ms: null,
    root_exit_observed: null, recorded_identity_present: null, claimant_scan_outcome: "incomplete",
    sanitized_error_class: null, final_cleanup_verdict: "unknown", final_bridge_error_code: null,
  };
  return { observation, verify: async (targets: Parameters<typeof verifyProcessTreeClaimantsClean>[0]) => {
    observation.scan_start = new Date().toISOString();
    observation.recorded_identity_present = targets.length > 0 && targets.every((target) => !!target.fingerprint);
    const started = performance.now();
    try {
      const result = await scan(targets);
      observation.claimant_scan_outcome = result.clean && result.livePids.length === 0 ? "clean" : result.livePids.length ? "live" : "unknown";
      return result;
    } catch (error) {
      observation.claimant_scan_outcome = "threw";
      observation.sanitized_error_class = error instanceof Error ? "Error" : "non_error";
      throw error;
    } finally {
      observation.elapsed_ms = performance.now() - started;
      observation.scan_end = new Date().toISOString();
    }
  } };
}

async function makeFakeRuntime(
  selectedModel: { providerId: string; modelId: string; options?: { reasoningLevel: string } } = { providerId: "provider-default", modelId: "model-default" },
  includeRequestedModel = true,
  interactionRequest = false,
  turnFailure?: unknown,
  keepAliveAfterTurn = false,
  exitAfterTurnMs: number | null = null,
  descendantControl?: { readonly pidPath: string; readonly releasePath: string },
  turnDelayMs = 0,
): Promise<{ root: string; config: ZCodeRuntimeConfig; requestLog: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-app-server-test-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const descendantScript = descendantControl === undefined ? "" : [
    "const fs = require('node:fs');",
    `const release = ${JSON.stringify(descendantControl.releasePath)};`,
    "function tick() { if (fs.existsSync(release)) { process.exit(0); return; } setTimeout(tick, 25); }",
    "tick(); setInterval(() => {}, 1000);",
  ].join("\n");
  const script = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const sessionId = ${JSON.stringify(SESSION_ID)};
const requestLog = ${JSON.stringify(requestLog)};
const descendantControl = ${JSON.stringify(descendantControl ?? null)};
let selected = ${JSON.stringify(selectedModel)};
const turnFailure = ${JSON.stringify(turnFailure ?? null)};
if (${keepAliveAfterTurn}) setInterval(() => {}, 1_000);
if (descendantControl) {
  const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore", windowsHide: true, detached: true, cwd: ${JSON.stringify(process.cwd())} });
  descendant.unref();
  fs.writeFileSync(descendantControl.pidPath, String(descendant.pid));
}
const available = [selected, ${includeRequestedModel ? '{ providerId: "provider-123", modelId: "model-x" }, { providerId: "provider-123", modelId: "reasoning-model" }' : ""}];
const report = ${JSON.stringify(validReport())};
let turnFinished = false;
function finishTurn() {
  if (turnFinished) return;
  turnFinished = true;
  const params = turnFailure === null
    ? { seq: 1, type: "turn.completed", payload: { response: JSON.stringify(report), usage: { totalTokens: 4 }, resultType: "success" } }
    : { seq: 1, type: "turn.failed", payload: { error: turnFailure } };
  process.stdout.write(JSON.stringify({ method: "session/event", params }) + "\n");
}
function snapshot() {
  return {
    session: { sessionId },
    settings: { model: { current: selected, available: available.map((ref) => ({ ref, label: "Test Model" })) } },
    runtime: { eventSeq: 0 },
  };
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "session/create") {
    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\n");
  } else if (message.method === "session/setModel") {
    selected = message.params.model;
    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\n");
  } else if (message.method === "session/subscribe") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  } else if (message.method === "session/send") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    const reportTurn = () => {
      if (${interactionRequest}) {
        for (const rpcId of ["interaction-rpc-1", "interaction-rpc-2"]) {
          process.stdout.write(JSON.stringify({ id: rpcId, method: "interaction/requestPermission", params: {
            requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash",
            reason: "Run a build command", input: { command: "npm run build" },
            options: [{ kind: "allow_once" }, { kind: "deny" }]
          }}) + "\n");
        }
      }
      else finishTurn();
      if (${exitAfterTurnMs !== null}) setTimeout(() => process.exit(0), ${exitAfterTurnMs ?? 0});
    };
    if (${turnDelayMs} > 0) setTimeout(reportTurn, ${turnDelayMs}); else reportTurn();
  } else if (message.id === "interaction-rpc-1" || message.id === "interaction-rpc-2") {
    if (message.result && message.result.decision) finishTurn();
  } else {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } }) + "\n");
  }
});
`;
  await writeFile(entrypoint, script, "utf8");
  return {
    root,
    requestLog,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: path.join(root, "builtin.json"),
      providerPersonalConfigFile: path.join(root, "personal.json"),
      dataRoot: root,
    },
  };
}

test("applies a per-task model override, verifies the selection, and does not persist it as the workspace default", async () => {
  const runtime = await makeFakeRuntime(
    { providerId: "provider-default", modelId: "model-default" },
    true,
    false,
    undefined,
    true,
  );
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "provider-123", model_id: "model-x" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.cleanupVerified, true);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const setModel = requests.find((request) => request.method === "session/setModel");
    assert.ok(setModel);
    assert.deepEqual(setModel.params, {
      sessionId: SESSION_ID,
      model: { providerId: "provider-123", modelId: "model-x" },
      persistAsWorkspaceLastUsed: false,
    });
    assert.ok(events.some((event) => event.type === "model_selected" && event.details?.["model_id"] === "model-x"));
    assert.ok(events.some((event) => event.type === "session_ready" && String(event.details?.["selected_model"]).includes("provider-123/model-x")));
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("maps an identity-bound Windows tree receipt into the Adapter outcome", { timeout: 15_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows identity-bound cleanup receipt");
  const runtime = await makeFakeRuntime(undefined, true, false, undefined, true);
  const platformProbe = createPlatformProbe();
  let terminatedPid = 0;
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async (pid, options) => {
        terminatedPid = pid;
        const identity = await platformProbe.identityOf(pid);
        assert.equal(identity.fingerprint_precision, "exact");
        assert.equal(identity.fingerprint, options?.expectedRootFingerprint);
        process.kill(pid, "SIGKILL");
        const deadline = Date.now() + 5_000;
        while (isProcessRunning(pid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(isProcessRunning(pid), false);
        return {
          pid,
          signal: "SIGKILL",
          verified: true,
          windows: {
            rootPid: pid,
            rounds: 1,
            members: [{ pid, fingerprint: identity.fingerprint!, creationFileTime: "test-creation" }],
            kills: [{ pid, status: "killed", exitFileTime: null }],
            signaled: [pid],
          },
        };
      },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupVerified, true);
    assert.equal(result.cleanupError, undefined);
    assert.ok(result.cleanupTreeReceipt, "the injected identity-bound Windows receipt must be preserved");
    assert.equal(result.cleanupTreeReceipt.rootPid, terminatedPid);
    assert.equal(result.cleanupTreeReceipt.members[0]?.pid, terminatedPid);
    assert.ok(result.cleanupTreeReceipt.members[0]?.fingerprint);
  } finally {
    if (terminatedPid > 0 && isProcessRunning(terminatedPid)) {
      process.kill(terminatedPid, "SIGKILL");
    }
    await rm(runtime.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("trusted local execution profile is bound to the actual app-server session mode", async () => {
  const runtime = await makeFakeRuntime();
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      homeDir: runtime.root,
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH, ZCODE_BRIDGE_MODE: "yolo" },
      executionProfileId: "local-build-v1",
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const create = requests.find((request) => request.method === "session/create");
    assert.equal(create?.params?.mode, "build");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("a root-exited termination race is verified only by a clean recorded-tree scan", { timeout: 8_000 }, async () => {
  // Delay the fake turn while the Adapter captures the root identity. The
  // runtime exits naturally on stdin close after that capture settles.
  const runtime = await makeFakeRuntime(undefined, true, false, undefined, false, null, undefined, 1_200);
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async () => {
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
        error.code = "process_tree_root_exited";
        throw error;
      },
      verifyTreeClean: async (targets) => ({ clean: true, livePids: [], observedPids: targets.map((target) => target.pid) }),
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupVerified, true);
    assert.equal(result.cleanupError, null);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("Windows cleanup waits for the caller-bound identity probe before closing a short-lived runtime", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows spawn-generation identity capture is platform-specific");
  const runtime = await makeFakeRuntime(undefined, true, false, undefined, false, null, undefined, 0);
  const platformProbe = createPlatformProbe();
  const probe = {
    ...platformProbe,
    identityOf: async (pid: number) => {
      // Force the adapter close path to overlap the startup identity read.
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      return platformProbe.identityOf(pid);
    },
  };
  const scanned: Array<readonly { pid: number; fingerprint: string | null }[]> = [];
  let terminatorCalls = 0;
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      probe,
      timeoutMs: 8_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async (pid, options) => {
        terminatorCalls += 1;
        assert.equal(isProcessRunning(pid), false, "normal close lets the fake runtime exit before the root-exited scan");
        assert.ok(options?.expectedRootFingerprint, "termination carries the captured spawn-generation identity");
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
        error.code = "process_tree_root_exited";
        throw error;
      },
      verifyTreeClean: async (targets) => {
        assert.ok(targets[0]?.fingerprint, "scanning retains the captured spawn-generation identity");
        assert.equal(isProcessRunning(targets[0]!.pid), false, "the original runtime closed before scanning");
        scanned.push(targets);
        return { clean: true, livePids: [], observedPids: targets.map((target) => target.pid) };
      },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupVerified, true);
    assert.equal(scanned.length, 1);
    assert.equal(terminatorCalls, 0, "an observed original-child exit goes directly to the required claimant scan");
    assert.ok(scanned[0]?.[0]?.fingerprint, "the claimant scan uses the captured root generation");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

for (const missingIdentity of [true, false]) test(`observed Windows child exit stays unverified with ${missingIdentity ? "missing identity" : "a rejected claimant scan"}`, { timeout: 10_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only cleanup identity gate");
  const runtime = await makeFakeRuntime(undefined, true, false, undefined, false, null, undefined, 0);
  let scans = 0;
  const platformProbe = createPlatformProbe();
  const trace = observeScan(missingIdentity ? "missing-identity" : "scan-throws", async () => { scans += 1; throw Object.assign(new Error("fixture scan rejected after observing a descendant"), { memberPids: [987_654] }); });
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      probe: missingIdentity ? { ...platformProbe, identityOf: async () => { throw new Error("fixture identity unavailable"); } } : platformProbe,
      timeoutMs: 5_000,
      childEnvBase: { PATH: process.env.PATH },
      verifyTreeClean: trace.verify,
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    trace.observation.final_cleanup_verdict = result.cleanupVerified ? "verified" : "unverified";
    assert.equal(result.cleanupVerified, false);
    assert.ok(result.cleanupError);
    assert.equal(scans, missingIdentity ? 0 : 1);
    if (!missingIdentity) {
      assert.ok(result.cleanupMemberPids?.some((pid) => pid !== 987_654), "a rejected scan retains the recorded root");
      assert.ok(result.cleanupMemberPids?.includes(987_654), "scan rejection retains already observed descendants for recovery");
    }
  } finally { t.diagnostic(JSON.stringify(trace.observation)); await rm(runtime.root, { recursive: true, force: true }); }
});

test("a naturally exited Windows root with no descendants passes the real claimant scan", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only native process identity and claimant scan");
  const runtime = await makeFakeRuntime(undefined, true, false, undefined, false, null, undefined, 1_200);
  const scanTargets: Array<readonly { pid: number; fingerprint: string | null }[]> = [];
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const trace = observeScan("real-clean");
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async (pid) => {
        assert.equal(isProcessRunning(pid), false, "the direct app-server root has naturally exited");
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
        error.code = "process_tree_root_exited";
        throw error;
      },
      verifyTreeClean: async (targets) => {
        scanTargets.push(targets);
        return trace.verify(targets);
      },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    trace.observation.final_cleanup_verdict = result.cleanupVerified ? "verified" : "unverified";
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupVerified, true, result.cleanupError ?? "recorded-tree scan did not verify clean");
    assert.equal(result.cleanupError, null);
    assert.equal(scanTargets.length, 1, "the natural root exit reaches the native recorded-tree scanner");
    const root = scanTargets[0]?.[0];
    assert.ok(root && root.pid > 0 && root.fingerprint, "the scan is bound to the captured root generation");
    assert.ok(events.some((event) => event.type === "cleanup_verified" && event.details?.["evidence"] === "recorded_tree_claimant_scan"));
  } finally {
    t.diagnostic(JSON.stringify(trace.observation));
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("a root-exited termination race stays failed when claimant scan sees a live descendant", { timeout: 8_000 }, async () => {
  const runtime = await makeFakeRuntime(undefined, true, false, undefined, false, null, undefined, 1_200);
  let appServerPid = 0;
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => {
        if (event.type === "app_server_started" && typeof event.details?.["pid"] === "number") appServerPid = event.details["pid"] as number;
      },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async () => {
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
        error.code = "process_tree_root_exited";
        throw error;
      },
      verifyTreeClean: async (targets) => ({ clean: false, livePids: [987_654], observedPids: [...targets.map((target) => target.pid), 987_654] }),
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupVerified, false);
    assert.match(result.cleanupError ?? "", /process_tree_root_exited/);
    assert.ok(result.cleanupMemberPids?.includes(987_654));
  } finally {
    const deadline = Date.now() + 5_000;
    while (appServerPid > 0 && isProcessRunning(appServerPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (appServerPid > 0 && isProcessRunning(appServerPid)) {
      throw new Error(`Owned fake app-server remains alive after its scheduled exit: ${appServerPid}`);
    }
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("a naturally closed Windows root still scans its live descendant before cleanup succeeds", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only native process identity and claimant scan");
  const controlRoot = await mkdtemp(path.join(tmpdir(), "bridge-adapter-root-exited-"));
  const pidPath = path.join(controlRoot, "descendant.pid");
  const releasePath = path.join(controlRoot, "descendant.release");
  const runtime = await makeFakeRuntime(undefined, true, false, undefined, false, null, { pidPath, releasePath }, 1_200);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const scanTargets: Array<readonly { pid: number; fingerprint: string | null }[]> = [];
  const trace = observeScan("real-live");
  let descendantPid = 0;
  const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${description}`);
  };
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async (pid) => {
        assert.equal(isProcessRunning(pid), false, "the direct app-server root has naturally exited");
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
        error.code = "process_tree_root_exited";
        throw error;
      },
      verifyTreeClean: async (targets) => {
        scanTargets.push(targets);
        return trace.verify(targets);
      },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    descendantPid = Number((await readFile(pidPath, "utf8")).trim());
    trace.observation.final_cleanup_verdict = result.cleanupVerified ? "verified" : "unverified";
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupVerified, false, "a live descendant prevents a successful cleanup outcome");
    assert.ok(result.cleanupMemberPids?.includes(descendantPid), "the live descendant is retained as cleanup evidence");
    assert.equal(scanTargets.length, 1, "natural root exit reaches the real recorded-tree scanner");
    assert.ok(events.some((event) => event.type === "cleanup_unverified"));

    await writeFile(releasePath, "release", "utf8");
    await waitFor(() => !isProcessRunning(descendantPid), "the released descendant to exit");
    const laterScan = await verifyProcessTreeClaimantsClean(scanTargets[0]!);
    assert.equal(laterScan.clean, true, "the later scan observes the naturally exited descendant");
    assert.equal(result.cleanupVerified, false, "later cleanup evidence does not rewrite the original adapter outcome");
  } finally {
    t.diagnostic(JSON.stringify(trace.observation));
    await writeFile(releasePath, "release", "utf8").catch(() => undefined);
    if (descendantPid > 0) await waitFor(() => !isProcessRunning(descendantPid), "owned descendant cleanup").catch(() => undefined);
    if (descendantPid > 0 && isProcessRunning(descendantPid)) throw new Error(`Owned test descendant remains: ${descendantPid}`);
    await rm(runtime.root, { recursive: true, force: true });
    await rm(controlRoot, { recursive: true, force: true });
  }
});

test("classifies explicit provider usage exhaustion without publishing its raw error", async () => {
  const privateMarker = "PRIVATE_PROVIDER_DETAIL_7f4b";
  const runtime = await makeFakeRuntime(undefined, true, false, {
    code: "insufficient_quota",
    type: "usage_limit_error",
    message: `Account usage quota exhausted; ${privateMarker}`,
  }, false, null, undefined, 1_200);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async (pid) => {
        assert.equal(isProcessRunning(pid), false, "the fake app-server naturally closed before the recorded-tree scan");
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
        error.code = "process_tree_root_exited";
        throw error;
      },
      verifyTreeClean: async (targets) => ({ clean: true, livePids: [], observedPids: targets.map((target) => target.pid) }),
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "zcode_usage_exhausted");
      assert.match(error.message, /额度已耗尽；当前执行已中断/);
      assert.match(error.message, /立即停止当前任务并告知用户/);
      assert.match(error.message, /不要继续工作、自动重试或续作/);
      assert.match(error.message, /等待用户确认额度恢复后再继续/);
      return true;
    });
    const failureEvents = events.filter((event) => event.type === "turn_failed" || event.type === "error");
    assert.equal(failureEvents.length, 2);
    assert.ok(failureEvents.every((event) => event.details?.error_code === "zcode_usage_exhausted"), JSON.stringify(failureEvents.map(({ type, details }) => ({ type, error_code: details?.error_code }))));
    assert.ok(events.some((event) => event.type === "cleanup_verified" && event.details?.evidence === "recorded_tree_claimant_scan"));
    assert.equal(events.some((event) => event.type === "cleanup_unverified"), false);
    assert.match(failureEvents[0]!.summary, /用量额度已耗尽/);
    assert.match(failureEvents[0]!.summary, /当前执行已中断/);
    assert.match(failureEvents[0]!.summary, /立即停止当前任务并告知用户/);
    assert.match(failureEvents[0]!.summary, /等待用户确认额度恢复/);
    assert.doesNotMatch(JSON.stringify({ events, message: failureEvents.map((event) => event.summary) }), new RegExp(privateMarker));
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("does not misclassify request rate limits or generic 429s as exhausted usage", async () => {
  const cases = [
    { code: "rate_limit_exceeded", message: "Rate limit exceeded; retry after 60 seconds" },
    { code: "429", message: "Too many requests" },
  ];
  for (const providerError of cases) {
    const runtime = await makeFakeRuntime(undefined, true, false, providerError, false, null, undefined, 1_200);
    const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
    try {
      const adapter = new ZCodeAppServerAdapter({
        resolver: { resolve: async () => runtime.config },
        onEvent: (event) => events.push(event),
        timeoutMs: 10_000,
        childEnvBase: { PATH: process.env.PATH },
        terminateProcessTreeImpl: async (pid) => {
          assert.equal(isProcessRunning(pid), false, "the fake app-server naturally closed before the recorded-tree scan");
          const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
          error.code = "process_tree_root_exited";
          throw error;
        },
        verifyTreeClean: async (targets) => ({ clean: true, livePids: [], observedPids: targets.map((target) => target.pid) }),
      });
      const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
      await assert.rejects(adapter.getResult(handle), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, "zcode_nonzero_exit");
        assert.equal(error.message, "ZCode turn failed");
        return true;
      });
      const failureEvents = events.filter((event) => event.type === "turn_failed" || event.type === "error");
      assert.equal(failureEvents.length, 2);
      assert.ok(failureEvents.every((event) => event.details?.error_code === "zcode_nonzero_exit"));
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
    }
  }
});

test("a Windows provider failure preserves its code only after a real root-exited claimant scan", { timeout: 90_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only native process identity and claimant scan");
  const runtime = await makeFakeRuntime(undefined, true, false, { code: "provider_error", message: "safe synthetic provider failure" }, false, null, undefined, 1_200);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const trace = observeScan("provider-failure-real-scan");
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 60_000,
      childEnvBase: { PATH: process.env.PATH },
      onCleanupDecisionTrace: () => { trace.observation.root_exit_observed = true; },
      verifyTreeClean: trace.verify,
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => {
      trace.observation.final_bridge_error_code = error instanceof BridgeError ? error.code : "non_bridge_error";
      trace.observation.final_cleanup_verdict = events.some((event) => event.type === "cleanup_verified") ? "verified" : events.some((event) => event.type === "cleanup_unverified") ? "unverified" : "unknown";
      return error instanceof BridgeError && error.code === "zcode_nonzero_exit";
    });
    assert.ok(events.some((event) => event.type === "cleanup_verified" && event.details?.evidence === "recorded_tree_claimant_scan"));
    assert.equal(trace.observation.root_exit_observed, true);
    assert.equal(trace.observation.claimant_scan_outcome, "clean");
    assert.equal(events.some((event) => event.type === "cleanup_unverified"), false);
  } finally {
    t.diagnostic(JSON.stringify(trace.observation));
    await rm(runtime.root, { recursive: true, force: true });
  }
});

for (const scenario of ["unknown", "threw", "callback-throws"] as const) test(`root-exited decision trace ${scenario}`, { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only native process identity");
  const runtime = await makeFakeRuntime(undefined, true, false, { code: "provider_error", message: "safe synthetic provider failure" }, false, null, undefined, 1_200);
  const trace = observeScan(`fault-${scenario}`, scenario === "unknown"
    ? async (targets) => ({ clean: false, livePids: [], observedPids: targets.map((target) => target.pid) })
    : scenario === "threw" ? async () => { throw new Error("synthetic scan failure"); } : verifyProcessTreeClaimantsClean);
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config }, timeoutMs: 60_000,
      childEnvBase: { PATH: process.env.PATH }, verifyTreeClean: trace.verify,
      onCleanupDecisionTrace: () => { trace.observation.root_exit_observed = true; if (scenario === "callback-throws") throw new Error("synthetic trace failure"); },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => {
      trace.observation.final_bridge_error_code = error instanceof BridgeError ? error.code : "non_bridge_error";
      trace.observation.final_cleanup_verdict = error instanceof BridgeError && error.code === "cleanup_failed" ? "unverified" : "verified";
      return error instanceof BridgeError && error.code === (scenario === "callback-throws" ? "zcode_nonzero_exit" : "cleanup_failed");
    });
    assert.equal(trace.observation.root_exit_observed, true);
    assert.equal(trace.observation.claimant_scan_outcome, scenario === "callback-throws" ? "clean" : scenario);
  } finally { t.diagnostic(JSON.stringify(trace.observation)); await rm(runtime.root, { recursive: true, force: true }); }
});

test("real live claimant preserves cleanup_failed on provider failure", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only native claimant scan");
  const controlRoot = await mkdtemp(path.join(tmpdir(), "bridge-live-provider-"));
  const pidPath = path.join(controlRoot, "descendant.pid");
  const releasePath = path.join(controlRoot, "descendant.release");
  const runtime = await makeFakeRuntime(undefined, true, false, { code: "provider_error", message: "safe synthetic provider failure" }, false, null, { pidPath, releasePath }, 1_200);
  const trace = observeScan("real-live-provider");
  let descendantPid = 0;
  let scanIncludesDescendant = false;
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config }, timeoutMs: 60_000,
      childEnvBase: { PATH: process.env.PATH },
      onCleanupDecisionTrace: () => { trace.observation.root_exit_observed = true; },
      verifyTreeClean: async (targets) => {
        descendantPid = Number((await readFile(pidPath, "utf8")).trim());
        assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
        const result = await trace.verify(targets);
        scanIncludesDescendant = result.livePids.includes(descendantPid);
        return result;
      },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => {
      trace.observation.final_bridge_error_code = error instanceof BridgeError ? error.code : "non_bridge_error";
      trace.observation.final_cleanup_verdict = error instanceof BridgeError && error.code === "cleanup_failed" ? "unverified" : "unknown";
      return error instanceof BridgeError && error.code === "cleanup_failed" && !!error.memberPids?.includes(descendantPid);
    });
    assert.equal(trace.observation.root_exit_observed, true);
    assert.equal(trace.observation.claimant_scan_outcome, "live");
    assert.equal(scanIncludesDescendant, true, "the real scan identified the controlled live descendant");
  } finally {
    t.diagnostic(JSON.stringify({ ...trace.observation, scan_includes_controlled_descendant: scanIncludesDescendant }));
    await writeFile(releasePath, "release", "utf8").catch(() => undefined);
    if (descendantPid > 0) {
      const deadline = Date.now() + 12_000;
      while (isProcessRunning(descendantPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(isProcessRunning(descendantPid), false, "controlled descendant must exit cooperatively");
    }
    await rm(runtime.root, { recursive: true, force: true });
    await rm(controlRoot, { recursive: true, force: true });
  }
});

test("a provider failure remains cleanup_failed when the root-exited scan retains a live claimant", { timeout: 15_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("the Adapter's spawn identity capture is Windows-specific");
  const runtime = await makeFakeRuntime(undefined, true, false, { code: "provider_error", message: "safe synthetic provider failure" }, false, null, undefined, 1_200);
  const claimantPid = 98_765;
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async (pid) => {
        assert.equal(isProcessRunning(pid), false);
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string; memberPids: number[] };
        error.code = "process_tree_root_exited";
        error.memberPids = [pid];
        throw error;
      },
      verifyTreeClean: async (targets) => ({
        clean: false,
        livePids: [claimantPid],
        observedPids: [...targets.map((target) => target.pid), claimantPid],
      }),
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "cleanup_failed");
      assert.ok(error.memberPids?.includes(claimantPid));
      return true;
    });
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("lets the app-server resolve a requested model omitted from the initial catalog", async () => {
  const runtime = await makeFakeRuntime({ providerId: "provider-default", modelId: "model-default" }, false);
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "account:zai-start-plan", model_id: "GLM-5.3-Flash" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    assert.equal((await adapter.getResult(handle)).exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.some((request) => request.method === "session/setModel"), true);
    assert.equal(requests.some((request) => request.method === "session/send"), true);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("resolves an unprefixed provider from the runtime catalog without losing the caller request", async () => {
  const runtime = await makeFakeRuntime({ providerId: "account:plan", modelId: "flash", options: { reasoningLevel: "high" } }, false);
  try {
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => runtime.config }, timeoutMs: 10_000, childEnvBase: { PATH: process.env.PATH }, homeDir: runtime.root });
    const handle = await adapter.startTask({ task: { ...task, model: { provider_id: "plan", model_id: "flash", reasoning_level: "high" } }, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const outcome = await adapter.getResult(handle);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.modelProfile?.provider_id, "account:plan");
    assert.equal(outcome.modelProfile?.requested_model, "plan/flash");
    const requests = (await readFile(runtime.requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const selection = requests.find((request) => request.method === "session/setModel");
    assert.equal(selection.params.model.providerId, "account:plan");
    assert.equal(selection.params.persistAsWorkspaceLastUsed, false);
  } finally { await rm(runtime.root, { recursive: true, force: true }); }
});

test("omitting model leaves the ZCode session default untouched", async () => {
  const runtime = await makeFakeRuntime();
  try {
    // homeDir points at an empty directory so the machine's runtime-config.json
    // (which may carry a real user default model) cannot leak into the run.
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.some((request) => request.method === "session/setModel"), false);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("starts ZCode runtime without a Bridge-specific execution opt-in", async () => {
  const runtime = await makeFakeRuntime();
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      childEnvBase: { PATH: process.env.PATH, PRIVATE_API_TOKEN: "not-forwarded" },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("passes an explicit reasoning level when selecting a model that requires it", async () => {
  const runtime = await makeFakeRuntime();
  try {
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => runtime.config }, timeoutMs: 10_000, childEnvBase: { PATH: process.env.PATH } });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "provider-123", model_id: "reasoning-model", reasoning_level: "high" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((request) => JSON.parse(request) as Record<string, unknown>);
    const setModel = requests.find((request) => request.method === "session/setModel");
    assert.deepEqual((setModel?.params as Record<string, unknown>)?.["model"], {
      providerId: "provider-123",
      modelId: "reasoning-model",
      options: { reasoningLevel: "high" },
    });
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("keeps the runtime-selected reasoning options when the requested model is already active", async () => {
  const runtime = await makeFakeRuntime({ providerId: "provider-123", modelId: "model-x", options: { reasoningLevel: "high" } });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "provider-123", model_id: "model-x" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    assert.equal((await adapter.getResult(handle)).exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((request) => JSON.parse(request) as Record<string, unknown>);
    assert.equal(requests.some((request) => request.method === "session/setModel"), false);
    assert.ok(events.some((event) => event.type === "model_selected" && event.details?.["model_id"] === "model-x"));
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("cancels a pending permission with one verified runtime cleanup", { timeout: 5_000 }, async () => {
  const runtime = await makeFakeRuntime(undefined, true, true, undefined, false, null, undefined, 1_200);
  let ready!: () => void;
  const interactionReady = new Promise<void>((resolve) => { ready = resolve; });
  let runtimePid: number | undefined;
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "app_server_started") runtimePid = event.details?.["pid"] as number;
      },
      resolveInteraction: async (_request, signal) => {
        ready();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { decision: "deny" };
      },
      timeoutMs: 3_000,
      childEnvBase: { PATH: process.env.PATH },
      terminateProcessTreeImpl: async (pid) => {
        assert.equal(isProcessRunning(pid), false, "the fake app-server naturally closed after cancellation");
        const error = new Error("process_tree_root_exited: process tree cleanup refused") as Error & { code: string };
        error.code = "process_tree_root_exited";
        throw error;
      },
      verifyTreeClean: async (targets) => ({ clean: true, livePids: [], observedPids: targets.map((target) => target.pid) }),
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = assert.rejects(adapter.getResult(handle), (error: unknown) => error instanceof BridgeError && error.code === "cancelled");
    await interactionReady;
    await Promise.all([adapter.cancelTask(handle), adapter.cancelTask(handle)]);
    await result;
    assert.ok(runtimePid);
    assert.equal(isProcessRunning(runtimePid), false);
    assert.ok(events.some((event) => event.type === "cleanup_verified" && event.details?.evidence === "recorded_tree_claimant_scan"));
  } finally { await rm(runtime.root, { recursive: true, force: true }); }
});

test("forwards a permission decision to ZCode and resolves duplicate request IDs once", async () => {
  const runtime = await makeFakeRuntime(undefined, true, true);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const requests: Array<{ request_id: string; method: string }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      resolveInteraction: async (request) => {
        requests.push({ request_id: request.request_id, method: request.method });
        return { decision: "deny", reason: "Not authorized" };
      },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    assert.equal((await adapter.getResult(handle)).exitCode, 0);
    assert.deepEqual(requests, [{ request_id: "permission-1", method: "interaction/requestPermission" }]);
    assert.equal(events.filter((event) => event.type === "interaction_replied").length, 1);
    const messages = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const replies = messages.filter((message) => message.id === "interaction-rpc-1" || message.id === "interaction-rpc-2");
    assert.deepEqual(replies, [
      { id: "interaction-rpc-1", result: { decision: "deny", reason: "Not authorized" } },
      { id: "interaction-rpc-2", result: { decision: "deny", reason: "Not authorized" } },
    ]);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});
