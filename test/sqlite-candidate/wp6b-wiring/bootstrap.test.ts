import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createLaunchBootstrap, decodeLaunchBootstrap, deriveAdmissionPolicySnapshotDigest, encodeLaunchBootstrap } from "../../../src/sqlite-candidate/wp6b2b1/launch-bootstrap.js";
import { spawnClaimOnlyWorker } from "../../../src/manager/spawn-worker.js";
import { BRIDGE_WORKER_LAUNCH_MARKER, fingerprintRuntimeArtifact } from "../../../src/runtime/build-provenance.js";
import { createWorkerEnv } from "../../../src/runtime/child-env.js";

const request = {
  operation_id: "op-bootstrap",
  task_id: "task-bootstrap",
  attempt: 1,
  generation: 7,
  revision: 2,
  launch_id: "launch-bootstrap",
  launch_epoch: 1,
  launch_token: "synthetic-token-value-0123456789",
  policy_snapshot: (() => {
    const snapshot = {
      operation_id: "op-bootstrap",
      task_id: "task-bootstrap",
      attempt: 1,
      generation: 7,
      workspace_ref: "C:\\synthetic\\workspace",
      authorization_source: "trusted_local_policy" as const,
      policy_revision: "policy-v1",
      policy_digest: "a".repeat(64),
      execution_profile_id: "local-build-v1",
    };
    return { ...snapshot, policy_snapshot_digest: deriveAdmissionPolicySnapshotDigest(snapshot) };
  })(),
};
const workerEntryPath = path.join(process.cwd(), "dist-test", "src", "worker", "worker-main.js");
const bridgeEntryPath = path.join(process.cwd(), "dist-test", "test", "sqlite-candidate", "wp6b-wiring", "bootstrap.test.js");
const provenance = () => ({ bridge: fingerprintRuntimeArtifact(bridgeEntryPath), worker: fingerprintRuntimeArtifact(workerEntryPath) });

test("private Bootstrap is one bounded frame with strict field validation", () => {
  const value = createLaunchBootstrap(request);
  const frame = encodeLaunchBootstrap(value);
  assert.deepEqual(decodeLaunchBootstrap(frame), value);
  assert.throws(() => decodeLaunchBootstrap(Buffer.concat([frame, frame])), /invalid launch bootstrap frame/u);
  assert.throws(() => decodeLaunchBootstrap(Buffer.from(`${JSON.stringify({ ...value, extra: true })}\n`)), /invalid launch bootstrap fields/u);
});

test("Bootstrap token has no argv/env transport site and is sent only through the private frame", () => {
  const frame = encodeLaunchBootstrap(createLaunchBootstrap(request));
  assert.ok(frame.includes(Buffer.from(request.launch_token)));
  const spawner = readFileSync(path.join(process.cwd(), "src", "manager", "spawn-worker.ts"), "utf8");
  assert.match(spawner, /const args = \[workerPath,.*BRIDGE_WORKER_LAUNCH_MARKER\]/su);
  assert.match(spawner, /spawn\(process\.execPath, args,/u);
  assert.doesNotMatch(spawner, /launch_token|bootstrap\.launch_token/u);
});

test("formal SQLite Host selects only the real Adapter unless a test-only driver capability is explicit", () => {
  const host = readFileSync(path.join(process.cwd(), "src", "host", "stdio.ts"), "utf8");
  const gate = readFileSync(path.join(process.cwd(), "src", "store", "lifecycle-gate.ts"), "utf8");
  const worker = readFileSync(path.join(process.cwd(), "src", "worker", "worker-main.ts"), "utf8");
  assert.doesNotMatch(host, /testOnlyFakeAdapter|fake-result-adapter/u);
  assert.match(gate, /adapter_mode:\s*options\.testOnlyFakeAdapter\s*\?\s*"test_fake"\s*:\s*"zcode_app_server"/u);
  assert.match(worker, /execution\.adapter_mode === "test_fake"\s*\?\s*await runExplicitFakeAdapter\(bootstrap, execution, candidateInteraction\)\s*:\s*await runZCodeAdapter\(bootstrap, execution, candidateInteraction\)/u);
  assert.match(worker, /if \(execution\.adapter_mode !== "test_fake"\) throw new Error\("fake Adapter is restricted to explicit test mode"\)/u);
});

test("claim-only Worker rejects a mismatched artifact provenance before handshake", { timeout: 20_000 }, async () => {
  const worker = fingerprintRuntimeArtifact(workerEntryPath);
  assert.ok(worker.path && worker.sha256);
  const child = spawnClaimOnlyWorker(workerEntryPath, {
    bridge: { path: null, sha256: null },
    worker: { path: worker.path, sha256: "0".repeat(64) },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  child.bootstrapChannel?.on("error", () => undefined);
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  const frame = encodeLaunchBootstrap(createLaunchBootstrap(request));
  try { child.bootstrapChannel?.end(frame); } catch { /* child may reject provenance before consuming fd 3 */ }
  const [code] = await close;
  assert.equal(code, 3);
  assert.match(stderr, /claim-only handshake rejected/u);
  assert.equal(child.spawnargs?.includes(request.launch_token), false, "token must not appear in argv");
});

test("claim-only Worker fails closed when the private fd 3 Bootstrap is absent", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [workerEntryPath, BRIDGE_WORKER_LAUNCH_MARKER], {
    detached: false,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    cwd: path.dirname(workerEntryPath),
    env: {
      ...createWorkerEnv(process.env),
      ZCODE_BRIDGE_RUNTIME_PROVENANCE: JSON.stringify(provenance()),
    },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  assert.equal(code, 3);
  assert.match(stderr, /claim-only handshake rejected/u);
});

test("claim-only Worker exits closed when the Manager rejects the permanent Claim", { timeout: 20_000 }, async () => {
  const child = spawnClaimOnlyWorker(workerEntryPath, provenance());
  let stderr = "";
  let resultBytes = 0;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  child.resultChannel?.on("data", (chunk: Buffer | string) => { resultBytes += Buffer.byteLength(chunk); });
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  child.bootstrapChannel?.end(encodeLaunchBootstrap(createLaunchBootstrap(request)));

  const report = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    child.reportChannel?.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.reportChannel?.once("end", () => resolve(Buffer.concat(chunks)));
    child.reportChannel?.once("error", reject);
  });
  assert.equal(report.at(-1), 0x0a);
  assert.equal(JSON.parse(report.subarray(0, -1).toString("utf8")).operation_id, request.operation_id);

  child.decisionChannel?.end(Buffer.from(`${JSON.stringify({ protocol: "bridge-claim-decision-v1", state: "claim_rejected" })}\n`, "utf8"));
  const [code] = await close;
  assert.equal(code, 3);
  assert.match(stderr, /claim-only handshake rejected/u);
  assert.equal(resultBytes, 0, "a rejected Claim must not produce a synthetic or real Result frame");
});

test("claim-only Worker rejects a committed Claim without a valid execution envelope and emits no Result", { timeout: 20_000 }, async () => {
  const child = spawnClaimOnlyWorker(workerEntryPath, provenance());
  let stderr = "";
  let resultBytes = 0;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  child.resultChannel?.on("data", (chunk: Buffer | string) => { resultBytes += Buffer.byteLength(chunk); });
  const close = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  child.bootstrapChannel?.end(encodeLaunchBootstrap(createLaunchBootstrap(request)));

  await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    child.reportChannel?.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.reportChannel?.once("end", () => resolve(Buffer.concat(chunks)));
    child.reportChannel?.once("error", reject);
  });
  child.decisionChannel?.end(Buffer.from(`${JSON.stringify({ protocol: "bridge-claim-decision-v1", state: "claim_committed" })}\n`, "utf8"));
  const [code] = await close;
  assert.equal(code, 3);
  assert.match(stderr, /claim-only handshake rejected/u);
  assert.equal(resultBytes, 0, "missing execution authorization must fail closed without a completed Result");
});
