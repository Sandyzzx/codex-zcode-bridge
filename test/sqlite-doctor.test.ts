import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runBridgeDoctor } from "../src/runtime/doctor.js";
import { buildSqliteDoctorChecks } from "../src/runtime/sqlite-doctor.js";
import { loadLifecycleCandidateModules } from "../src/store/lifecycle-gate.js";

const snapshot = (changes: Record<string, unknown> = {}) => ({
  root_status: "consistent_read_only", verified_event_projection_consistency: true,
  writes_allowed: false, cleanup_performed: false, claim_release_performed: false,
  operation_release_performed: false, operations: [], task_projections: [], ...changes,
});

test("SQLite doctor reads queued tasks without an Operation, and preserves database bytes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-doctor-"));
  try {
    const modules = await loadLifecycleCandidateModules();
    const writer = modules.Store.initialize(root, { managedDataDirectory: true });
    try {
      modules.createPort(writer).createTask({ task_id: "queued-task", workspace: root, objective: "diagnostic fixture",
        requirements: [], allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [] });
      writer.checkpoint();
    } finally { writer.close(); }
    const database = path.join(root, "operations.sqlite3");
    const hash = () => createHash("sha256").update(readFileSync(database)).digest("hex");
    const before = hash();
    const reader = modules.Store.openForRecovery(root, { managedDataDirectory: true });
    assert.ok(reader);
    try {
      const checks = buildSqliteDoctorChecks(reader.readRecoverySnapshot(), null);
      assert.equal(checks[0]?.status, "warning");
      assert.match(checks[0]!.summary, /1 queued.*queued-task#1: queued \(no Operation\)/u);
      assert.equal(checks[1]?.status, "ok");
    } finally { reader.close(); }
    assert.equal(hash(), before, "diagnostics must not modify business database bytes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persisted Hold and running projection are reported together without manufacturing cleanup", () => {
  const checks = buildSqliteDoctorChecks(snapshot({
    task_projections: [{ task_id: "task78", current_attempt: 1, status: "running" }],
    operations: [{ operation_id: "operation78", task_id: "task78", attempt: 1, phase: "running",
      capacity_occupied: true, cleanup_state: "unknown", result_digest: null, recovery_classification: "hold" }],
  }), "operation operation78 is held: recovery_latch_persisted");
  assert.equal(checks[0]?.status, "warning");
  assert.match(checks[0]!.summary, /1 running.*1 occupied.*1 recovery-held.*result absent, cleanup unknown/u);
  assert.equal(checks[1]?.status, "error");
  assert.match(checks[1]!.summary, /operation78: hold/u);
});

test("Manager-only recovery fence is visible even without a persisted Hold", () => {
  const checks = buildSqliteDoctorChecks(snapshot(), "worker_identity_unknown_managed_elsewhere");
  assert.equal(checks[0]?.status, "warning");
  assert.equal(checks[1]?.status, "warning");
  assert.match(checks[1]!.summary, /worker_identity_unknown_managed_elsewhere/u);
});

test("corrupt or incomplete SQLite snapshot never reports a healthy empty root", () => {
  for (const change of [{ root_status: "quarantined_read_only", root_blockers: ["projection_event_mismatch"] },
    { task_projections: undefined }, { verified_event_projection_consistency: false }]) {
    const checks = buildSqliteDoctorChecks(snapshot(change), null);
    assert.equal(checks[0]?.status, "unknown");
    assert.equal(checks[1]?.status, "error");
  }
});

test("empty verified SQLite root and terminal cleanup occupancy are distinguished", () => {
  assert.deepEqual(buildSqliteDoctorChecks(snapshot(), null).map((check) => check.status), ["ok", "ok"]);
  const checks = buildSqliteDoctorChecks(snapshot({
    task_projections: [{ task_id: "terminal", current_attempt: 1, status: "failed" }],
    operations: [{ task_id: "terminal", attempt: 1, phase: "cleanup_unverified", capacity_occupied: true }],
  }), null);
  assert.equal(checks[0]?.status, "warning");
  assert.match(checks[0]!.summary, /1 cleanup-pending.*terminal#1: failed/u);
  const abandoned = buildSqliteDoctorChecks(snapshot({ operations: [{ operation_id: "historical-hold",
    phase: "admin_abandoned", capacity_occupied: false, recovery_classification: "hold" }] }), null);
  assert.deepEqual(abandoned.map((check) => check.status), ["ok", "ok"], "retained Hold history on an administratively closed Operation must not block the root again");
});

test("doctor uses the bound SQLite Authority instead of misleading JSON state, including on failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-doctor-binding-"));
  try {
    mkdirSync(path.join(root, ".tasks"));
    writeFileSync(path.join(root, "bridge.sqlite"), "unopened sentinel");
    const options = { env: {}, resolver: { homeDir: root, packageRoot: root }, dataRoot: root };
    const expected = buildSqliteDoctorChecks(snapshot(), "persisted recovery_latch_persisted");
    const report = await runBridgeDoctor({ ...options, lifecycleChecks: () => expected });
    assert.deepEqual(report.checks.filter((check) => ["active_tasks", "recovery_lock"].includes(check.name)), expected);
    const failed = await runBridgeDoctor({ ...options, lifecycleChecks: () => { throw new Error("database_unreadable"); } });
    assert.deepEqual(failed.checks.filter((check) => ["active_tasks", "recovery_lock"].includes(check.name)).map((check) => check.status), ["unknown", "unknown"]);
    const unbound = await runBridgeDoctor(options);
    assert.deepEqual(unbound.checks.filter((check) => ["active_tasks", "recovery_lock"].includes(check.name)).map((check) => check.status), ["unknown", "unknown"]);
    assert.equal(readFileSync(path.join(root, "bridge.sqlite"), "utf8"), "unopened sentinel");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
