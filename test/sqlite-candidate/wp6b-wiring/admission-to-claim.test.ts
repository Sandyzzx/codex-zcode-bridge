import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openClaimOnlyDriver, initializeIsolatedCandidateRoot, loadLifecycleCandidateModules } from "../../../src/store/lifecycle-gate.js";
import { createTrustedLocalCandidateContext } from "../../../src/host/stdio.js";
import { deriveAdmissionPolicySnapshotDigest } from "../../../src/sqlite-candidate/wp6b2b1/launch-bootstrap.js";
import type { CandidateTaskPackage } from "../../../src/store/lifecycle-gate.js";

const root = process.cwd();
const compiledCandidate = path.join(root, "dist-test", "src", "sqlite-candidate", "wp6b2b1");
const sourceSchema = path.join(root, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
const compiledSchema = path.join(compiledCandidate, "schema.sql");
const runRoot = path.join(compiledCandidate, `.wp6b-b2-${randomUUID()}`);
const executionRoot = path.join(root, ".run", "wp6-execution-20261024", `admission-to-claim-${randomUUID()}`);
const diagnosticsRoot = path.join(root, ".run", "wp6-execution-20261024", "logs");
const workspace = path.join(executionRoot, "workspace");
const settingsDirectory = path.join(executionRoot, "settings");
const stageLogPath = path.join(diagnosticsRoot, `admission-to-claim-${path.basename(executionRoot)}.stages.jsonl`);
const childStderrPath = path.join(diagnosticsRoot, `admission-to-claim-${path.basename(executionRoot)}.worker-stderr.log`);
const workerEntryPath = path.join(root, "dist-test", "src", "worker", "worker-main.js");
const bridgeEntryPath = path.join(root, "dist-test", "test", "sqlite-candidate", "wp6b-wiring", "admission-to-claim.test.js");
const task = (taskId: string): CandidateTaskPackage => ({
  task_id: taskId,
  workspace,
  objective: "Synthetic Claim-only lifecycle test",
  requirements: ["synthetic"],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: ["stop after permanent claim"],
  test_commands: [],
});

const unknownCommitOperationId = "operation-b2-e2e-d";
let unknownCommitCalls = 0;

// node:test reports a failed subtest without rejecting the parent await.
async function verifiedSubtestThen(run: (body: (signal: AbortSignal) => Promise<void>) => Promise<void>, body: () => Promise<void>, dependent: () => Promise<void>): Promise<boolean> {
  let verified = false;
  await run(async (signal) => { await body(); signal.throwIfAborted(); verified = true; });
  if (verified) await dependent();
  return verified;
}

test("failed prerequisite prevents the dependent operation from starting", async () => {
  let cStarted = false;
  const verified = await verifiedSubtestThen(async (body) => {
    try { await body(new AbortController().signal); } catch { /* simulate node:test reporting a failed subtest */ }
  }, async () => { throw new Error("injected duplicate failure"); }, async () => { cStarted = true; });
  assert.equal(verified, false);
  assert.equal(cStarted, false);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await verifiedSubtestThen(async (body) => {
    try { await body(controller.signal); } catch { /* simulate node:test reporting cancellation */ }
  }, async () => {}, async () => { cStarted = true; });
  assert.equal(cancelled, false);
  assert.equal(cStarted, false);
});

test("real detached child lifecycle scenarios", async (t) => {
  mkdirSync(executionRoot, { recursive: true });
  mkdirSync(diagnosticsRoot, { recursive: true });
  mkdirSync(compiledCandidate, { recursive: true });
  if (existsSync(compiledSchema)) {
    assert.equal(readFileSync(compiledSchema, "utf8"), readFileSync(sourceSchema, "utf8"), "preserve and verify any prior schema fixture");
  } else {
    copyFileSync(sourceSchema, compiledSchema);
  }
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(settingsDirectory, { recursive: true });
  writeFileSync(path.join(settingsDirectory, "trusted-local-policy.json"), JSON.stringify({
    schema_version: 1,
    enabled: true,
    policy_revision: "od10-test-v1",
    workspace_roots: [executionRoot],
    execution_profile_id: "local-build-v1",
    allowed_operation_kinds: ["attempt_lifecycle"],
    unrestricted: false,
  }));
  await initializeIsolatedCandidateRoot(runRoot);
  const driver = await openClaimOnlyDriver({
    dataRoot: runRoot,
    workerEntryPath,
    bridgeEntryPath,
    testOnlyFakeAdapter: true,
    loadModules: async () => {
      const modules = await loadLifecycleCandidateModules();
      return {
        ...modules,
        createPort(store) {
          const port = modules.createPort(store);
          return Object.freeze({
            ...port,
            commitPermanentClaim(input: Parameters<typeof port.commitPermanentClaim>[0]) {
              // Exercise the real Store CAS with a stale revision without altering the protected schema.
              if (input.operation_id === "operation-b2-e2e-c") return port.commitPermanentClaim({ ...input, revision: input.revision - 1 });
              return port.commitPermanentClaim(input);
            },
            commitResult(input: Parameters<typeof port.commitResult>[0]) {
              if (input.operation_id !== unknownCommitOperationId) return port.commitResult(input);
              unknownCommitCalls += 1;
              port.commitResult(input);
              throw Object.assign(new Error("synthetic Result commit acknowledgement loss"), { code: "transaction_outcome_unknown" });
            },
          });
        },
      };
    },
    trustedLocalContext: createTrustedLocalCandidateContext({ name: "candidate-test", settingsDirectory }),
    onStage: (stage, detail) => appendFileSync(stageLogPath, `${JSON.stringify({ at: new Date().toISOString(), elapsed_ms: performance.now(), stage, ...detail })}\n`),
    onChildSpawn: (child) => {
      appendFileSync(stageLogPath, `${JSON.stringify({ at: new Date().toISOString(), elapsed_ms: performance.now(), stage: "child_spawned", pid: child.pid ?? null })}\n`);
      child.stderr?.on("data", (chunk: Buffer | string) => appendFileSync(childStderrPath, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
  });
  let completed = false;
  try {
    driver.provisionCapacity({
      operation_id: "policy-b2-e2e",
      capacity_limit: 4,
      expected_generation: 0,
      maintenance: { dispatch_blocked: true, writers_drained: true },
    });
    const firstTask = task("task-b2-e2e-a");
    const secondTask = task("task-b2-e2e-b");
    const rejectedTask = task("task-b2-e2e-c");
    const unknownCommitTask = task("task-b2-e2e-d");
    driver.createTask(firstTask);
    driver.createTask(secondTask);
    driver.createTask(rejectedTask);
    driver.createTask(unknownCommitTask);
    let first: Awaited<ReturnType<typeof driver.run>> | undefined;
    let second: Awaited<ReturnType<typeof driver.run>> | undefined;
    let firstVerified = false;
    let secondVerified = false;
    let unknownCommitVerified = false;
    let rejectedClaimVerified = false;
    const assertSuccessfulLifecycle = (result: Awaited<ReturnType<typeof driver.run>>) => {
      assert.equal(result.state, "result_committed");
      assert.equal(result.workerExitCode, 0);
      assert.equal(result.spawnCount, 1);
      assert.equal(result.stopBoundary, "result");
      assert.equal(result.resultStatus, "completed");
      assert.equal((result.result as { status: string }).status, "completed");
      const operation = result.operation as { operation_id: string;
        phase: string; claim_status: string; claim_id: string | null; result_status: string; capacity_slot: number | null;
      };
      assert.equal(operation.phase, "released");
      assert.equal(operation.claim_status, "permanent_claim_recorded");
      assert.equal(typeof operation.claim_id, "string");
      assert.equal(operation.result_status, "completed");
      assert.notEqual(operation.capacity_slot, null, "the assigned slot remains in the historical Operation projection");
      assert.match(result.resultDigest ?? "", /^[0-9a-f]{64}$/u);
      const lifecycleDb = new DatabaseSync(path.join(runRoot, "operations.sqlite3"), { readOnly: true });
      try {
        const lifecycleEvents = lifecycleDb.prepare("SELECT event_type, from_phase, to_phase FROM manager_operation_events WHERE operation_id=? ORDER BY sequence").all(String(operation.operation_id));
        const resultIndex = lifecycleEvents.findIndex((event) => event.event_type === "result_committed");
        const activeCount = lifecycleDb.prepare("SELECT COUNT(*) AS n FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase NOT IN ('released','cancelled_before_launch')").get()?.n;
        assert.equal(activeCount, 0, "a released Operation no longer occupies Capacity");
        const pendingIndex = lifecycleEvents.findIndex((event) => event.event_type === "cleanup_pending");
        const verifiedIndex = lifecycleEvents.findIndex((event) => event.event_type === "cleanup_verified");
        const releasedIndex = lifecycleEvents.findIndex((event) => event.event_type === "released");
        assert.ok(resultIndex >= 0 && pendingIndex > resultIndex && verifiedIndex > pendingIndex && releasedIndex > verifiedIndex,
          "Result must precede verified Cleanup and Release in the durable lifecycle event chain");
        assert.equal(lifecycleEvents[resultIndex]?.to_phase, "result_committed");
        assert.equal(lifecycleEvents[verifiedIndex]?.to_phase, "cleanup_verified");
        assert.equal(lifecycleEvents[releasedIndex]?.to_phase, "released");
      } finally { lifecycleDb.close(); }
      assert.equal((result.task as { status: string }).status, "completed");
      assert.equal((result.attempt as { status: string }).status, "completed");
    };

    await t.test("A reaches a permanent Claim and commits a Result", { timeout: 45_000 }, async (scenario) => {
      const result = await driver.run({
        task: firstTask,
        operationId: "operation-b2-e2e-a",
        launchId: "launch-b2-e2e-a",
        launchToken: "synthetic-manager-token-a-0123456789",
        attempt: 1,
      });
      scenario.signal.throwIfAborted();
      assertSuccessfulLifecycle(result);
      first = result;
      firstVerified = true;
    });
    if (!firstVerified) return;

    await t.test("B reaches a permanent Claim, commits a Result and preserves A's completed history", { timeout: 45_000 }, async (scenario) => {
      const result = await driver.run({
        task: secondTask,
        operationId: "operation-b2-e2e-b",
        launchId: "launch-b2-e2e-b",
        launchToken: "synthetic-manager-token-b-0123456789",
        attempt: 1,
      });
      scenario.signal.throwIfAborted();
      assertSuccessfulLifecycle(result);
      second = result;
      secondVerified = true;
    });
    if (!secondVerified) return;

    await t.test("D preserves an unknown Result acknowledgement without Cleanup or Release", { timeout: 45_000 }, async (scenario) => {
      const unknownCommit = await driver.run({
        task: unknownCommitTask,
        operationId: unknownCommitOperationId,
        launchId: "launch-b2-e2e-d",
        launchToken: "synthetic-manager-token-d-0123456789",
        attempt: 1,
      });
      scenario.signal.throwIfAborted();
      assert.equal(unknownCommit.state, "result_outcome_unknown");
      assert.equal(unknownCommit.reason, "transaction_outcome_unknown");
      assert.equal(unknownCommit.result, undefined, "unknown commit acknowledgement must not be reported as a confirmed Result");
      assert.equal(unknownCommit.resultStatus, undefined);
      assert.equal(unknownCommit.resultDigest, undefined);
      assert.equal(unknownCommit.spawnCount, 1, "an unknown Result commit must not cause a second Spawn");
      assert.equal(unknownCommit.workerExitCode, 0);
      assert.equal(unknownCommitCalls, 1, "the Result Store call must not be retried");
      assert.equal((unknownCommit.operation as { phase: string }).phase, "result_committed",
        "the durable projection may exist even though its acknowledgement was lost");
      const unknownCommitDb = new DatabaseSync(path.join(runRoot, "operations.sqlite3"), { readOnly: true });
      try {
        const events = unknownCommitDb.prepare("SELECT event_type,from_phase,to_phase FROM manager_operation_events WHERE operation_id=? ORDER BY sequence").all(unknownCommitOperationId);
        assert.equal(events.filter((event) => event.event_type === "result_committed").length, 1,
          "the committed Result must have exactly one durable event despite the lost acknowledgement");
        assert.equal(events.at(-1)?.event_type, "result_committed");
        assert.equal(events.at(-1)?.from_phase, "running");
        assert.equal(events.at(-1)?.to_phase, "result_committed");
        assert.equal(events.some((event) => typeof event.event_type === "string"
          && ["cleanup_pending", "cleanup_verified", "released"].includes(event.event_type)), false,
          "unknown acknowledgement must not advance the Operation into Cleanup or Release");
      } finally { unknownCommitDb.close(); }
      unknownCommitVerified = true;
    });
    if (!unknownCommitVerified) return;

    const duplicateVerified = await verifiedSubtestThen(async (body) => {
      await t.test("repeating A after Unknown D refuses a second Spawn", { timeout: 45_000 }, async (scenario) => {
        await body(scenario.signal);
      });
    }, async () => {
      const duplicate = await driver.run({
        task: firstTask,
        operationId: "operation-b2-e2e-a",
        launchId: "launch-b2-e2e-a",
        launchToken: "synthetic-manager-token-a-0123456789",
        attempt: 1,
      });
      assert.equal(duplicate.spawnCount, 0, "existing Intent must never authorize a second Spawn");
      assert.notEqual(duplicate.state, "result_committed");
    }, async () => {
    await t.test("C exercises a real SQLite Claim CAS rejection", { timeout: 45_000 }, async (scenario) => {
      const rejected = await driver.run({
        task: rejectedTask,
        operationId: "operation-b2-e2e-c",
        launchId: "launch-b2-e2e-c",
        launchToken: "synthetic-manager-token-c-0123456789",
        attempt: 1,
      });
      scenario.signal.throwIfAborted();
      assert.equal(rejected.state, "claim_rejected");
      assert.equal(rejected.reason, "claim_cas_rejected");
      assert.equal(rejected.stopBoundary, "claim_only");
      assert.equal(rejected.result, undefined, "a rejected Claim must not produce a Worker Result");
      assert.equal(rejected.workerExitCode, 3);
      assert.equal(rejected.spawnCount, 1);
      assert.equal((rejected.operation as { phase: string }).phase, "launch_intent");
      assert.equal((rejected.operation as { claim_id: string | null }).claim_id, null);
      assert.equal((rejected.task as { status: string }).status, "queued");
      assert.equal((rejected.attempt as { status: string }).status, "queued");
      assert.equal(existsSync(path.join(runRoot, ".tasks")), false, "failed Claim must not touch JSON TaskStore state");
      const rejectedDb = new DatabaseSync(path.join(runRoot, "operations.sqlite3"), { readOnly: true });
      try {
        const events = rejectedDb.prepare("SELECT event_type FROM manager_operation_events WHERE operation_id=? ORDER BY sequence").all("operation-b2-e2e-c");
        assert.equal(events.at(-1)?.event_type, "launch_receipt", "failed Claim transaction must roll back projection and event");
        assert.equal(events.some((event) => event.event_type === "result_committed"), false, "failed Claim must not commit a Result");
      } finally { rejectedDb.close(); }
      rejectedClaimVerified = true;
    });
    });
    if (!duplicateVerified) return;
    if (!rejectedClaimVerified) return;

    await t.test("shared lifecycle invariants remain true across A, B, D and C", { timeout: 45_000 }, async (scenario) => {
      scenario.signal.throwIfAborted();
      assert.ok(first);
      assert.ok(second);
      const stageRecords = readFileSync(stageLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
        stage: string; pid?: number; exitCode?: number | null; operation_id?: string; policy_snapshot_digest?: string;
        workspace_ref?: string; policy_revision?: string; policy_digest?: string; execution_profile_id?: string;
      });
      for (const required of ["admission_start", "admission_complete", "reserved_snapshot_read_complete", "intent_start", "intent_complete",
        "spawn_bootstrap_start", "child_spawned", "spawn_bootstrap_complete", "receipt_identity_start", "receipt_complete",
        "preflight_complete", "worker_report_read_start", "worker_report_read_complete", "worker_policy_snapshot_verified",
        "worker_os_identity_verified", "claim_commit_start", "claim_commit_complete", "claim_committed",
        "claim_continue_sent", "worker_result_verified", "result_commit_start", "result_commit_ack", "result_projection_verified",
        "result_commit_failed", "worker_close", "run_complete"]) {
        assert.ok(stageRecords.some((record) => record.stage === required), `missing lifecycle stage record: ${required}`);
      }
      const successfulPids = stageRecords.filter((record) => record.stage === "worker_close" && record.exitCode === 0).map((record) => record.pid);
      assert.equal(successfulPids.length, 3, "all successful child PIDs must have a recorded close with exit 0");
      assert.equal((first.operation as { workspace_identity_json: string | null }).workspace_identity_json, null);
      assert.equal((second.operation as { workspace_identity_json: string | null }).workspace_identity_json, null);
      assert.equal(existsSync(path.join(runRoot, ".tasks")), false, "SQLite path must not create JSON TaskStore state");
      assert.equal(readFileSync(compiledSchema, "utf8"), readFileSync(sourceSchema, "utf8"));
      const db = new DatabaseSync(path.join(runRoot, "operations.sqlite3"), { readOnly: true });
      try {
        for (const operationId of ["operation-b2-e2e-a", "operation-b2-e2e-b"]) {
          const events = db.prepare("SELECT event_type,from_phase,to_phase,evidence_json FROM manager_operation_events WHERE operation_id=? ORDER BY sequence").all(operationId);
          const admission = JSON.parse(String(events[0]?.evidence_json ?? "{}"));
          const identity = db.prepare("SELECT task_id,attempt,generation,workspace_ref FROM manager_operations WHERE operation_id=?").get(operationId) as {
            task_id: string; attempt: number; generation: number; workspace_ref: string;
          };
          assert.equal(admission.authorization_source, "trusted_local_policy");
          assert.equal(admission.policy_revision, "od10-test-v1");
          assert.equal(admission.execution_profile_id, "local-build-v1");
          assert.match(admission.policy_digest, /^[0-9a-f]{64}$/u);
          const claimIndex = events.findIndex((event) => event.event_type === "claim_committed");
          const resultIndex = events.findIndex((event) => event.event_type === "result_committed");
          const cleanupPendingIndex = events.findIndex((event) => event.event_type === "cleanup_pending");
          const cleanupVerifiedIndex = events.findIndex((event) => event.event_type === "cleanup_verified");
          const releaseIndex = events.findIndex((event) => event.event_type === "released");
          assert.ok(claimIndex >= 0 && resultIndex > claimIndex && cleanupPendingIndex > resultIndex
            && cleanupVerifiedIndex > cleanupPendingIndex && releaseIndex > cleanupVerifiedIndex,
            "Claim, Result, verified Cleanup and Release must follow the durable lifecycle order");
          assert.equal(events[claimIndex]?.from_phase, "launch_intent");
          assert.equal(events[claimIndex]?.to_phase, "running");
          assert.equal(events[resultIndex]?.from_phase, "running");
          assert.equal(events[resultIndex]?.to_phase, "result_committed");
          assert.equal(events[cleanupPendingIndex]?.from_phase, "result_committed");
          assert.equal(events[cleanupVerifiedIndex]?.from_phase, "cleanup_pending");
          assert.equal(events[cleanupVerifiedIndex]?.to_phase, "cleanup_verified");
          assert.equal(events[releaseIndex]?.from_phase, "cleanup_verified");
          assert.equal(events[releaseIndex]?.to_phase, "released");
          assert.equal(events.at(-1)?.event_type, "released");
          assert.equal(events.filter((event) => event.event_type === "result_committed").length, 1);
          const expectedDigest = deriveAdmissionPolicySnapshotDigest({
            operation_id: operationId,
            task_id: identity.task_id,
            attempt: identity.attempt,
            generation: identity.generation,
            workspace_ref: identity.workspace_ref,
            authorization_source: admission.authorization_source,
            policy_revision: admission.policy_revision,
            policy_digest: admission.policy_digest,
            execution_profile_id: admission.execution_profile_id,
          });
          const workerReport = stageRecords.find((record) => record.stage === "worker_report_read_complete" && record.operation_id === operationId);
          assert.ok(workerReport, "Manager must receive the controlled Worker policy report");
          assert.equal(workerReport.policy_snapshot_digest, expectedDigest, "Worker report must match the snapshot derived from persisted reserved evidence");
          assert.equal(workerReport.workspace_ref, identity.workspace_ref);
          assert.equal(workerReport.policy_revision, admission.policy_revision);
          assert.equal(workerReport.policy_digest, admission.policy_digest);
          assert.equal(workerReport.execution_profile_id, admission.execution_profile_id);
        }
      } finally { db.close(); }
    });
    const finalStages = readFileSync(stageLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { stage: string; pid?: number; exitCode?: number | null });
    const allClosedPids = finalStages.filter((record) => record.stage === "worker_close").map((record) => record.pid);
    assert.equal(allClosedPids.length, 4, "all four exact child PIDs must have a close record");
    assert.equal(new Set(allClosedPids).size, 4, "each spawned child PID must be observed exactly once");
    assert.equal(finalStages.filter((record) => record.stage === "worker_close" && record.exitCode === 3).length, 1,
      "the rejected Claim child must also be observed exited with code 3");
    assert.equal(finalStages.filter((record) => record.stage === "worker_close" && record.exitCode === 0).length, 3,
      "both confirmed Results and the unknown commit child must exit cleanly");
    completed = true;
  } finally {
    driver.close();
    if (completed) {
      rmSync(runRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(settingsDirectory, { recursive: true, force: true });
      rmSync(compiledSchema, { force: true });
      rmSync(executionRoot, { recursive: true, force: true });
    }
  }
});
