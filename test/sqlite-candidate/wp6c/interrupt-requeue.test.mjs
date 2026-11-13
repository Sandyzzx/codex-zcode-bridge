import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdmissionError, digest, IsolatedAdmissionStore } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../../..');
const TEST_ROOT = path.join(PROJECT_ROOT, 'src/sqlite-candidate/wp6b2b1', `test-temp-interrupt-requeue-${process.pid}`);
mkdirSync(TEST_ROOT, { recursive: true });
after(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

let serial = 0;

function task(taskId, workspace) {
  return {
    task_id: taskId,
    workspace,
    objective: 'synthetic interruption and requeue fixture',
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  };
}

function trustedIdentity(kind, suffix, processId, fingerprint) {
  const base = {
    source: kind === 'launch' ? 'manager_os_spawn_observation' : 'manager_verified_process_probe',
    fixture: false,
    ...(kind === 'launch' ? { launch_id: `launch-${suffix}`, generation: 1 } : { worker_id: `worker-${suffix}` }),
    process_id: processId,
    start_fingerprint: fingerprint,
    fingerprint_precision: 'exact',
    identity_version: 1,
    platform: 'win32',
    captured_at: '2026-11-13T00:00:00.000Z',
  };
  return { ...base, evidence_digest: digest(base) };
}

function makeRunning(label) {
  const root = path.join(TEST_ROOT, `${label}-${++serial}`);
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = IsolatedAdmissionStore.initialize(root);
  const taskId = `task-${label}`;
  const operationId = `operation-${label}`;
  store.provisionCapacity({
    operation_id: `policy-${label}`,
    capacity_limit: 1,
    expected_generation: 0,
    maintenance: { dispatch_blocked: true, writers_drained: true },
  });
  store.createTask(task(taskId, workspace), '2026-11-13T00:00:00.000Z');
  const allow = () => ({ state: 'allow', fixture: true });
  const admitted = store.admitOperation(
    { operation_id: operationId, task_id: taskId, attempt: 1, workspace_ref: workspace },
    { workspaceValidator: allow, executionPermissionCheck: allow },
  );
  const launch = {
    operation_id: operationId,
    task_id: taskId,
    attempt: 1,
    generation: admitted.generation,
    revision: admitted.revision,
    launch_id: `launch-${label}`,
    launch_epoch: 1,
    launch_token: `synthetic-interruption-token-${label}-012345`,
  };
  const processId = 54000 + serial;
  const fingerprint = `fingerprint-${label}`;
  const intent = store.createLaunchIntent(launch);
  const receipt = store.recordLaunchReceipt({
    ...launch,
    revision: intent.revision,
    receipt_id: `receipt-${label}`,
    launch_identity: trustedIdentity('launch', label, processId, fingerprint),
  });
  store.commitPermanentClaim({
    ...launch,
    revision: receipt.revision,
    claim_id: `claim-${label}`,
    worker_identity: trustedIdentity('worker', label, processId, fingerprint),
  });
  return {
    root,
    store,
    taskId,
    operationId,
    processId,
    fingerprint,
    continuationOperationId: `continuation-${label}`,
  };
}

function interruptionInput(fixture, overrides = {}) {
  const operation = fixture.store.readOperation(fixture.operationId);
  const processTreeDigest = overrides.process_tree_digest ?? digest({
    contract: 'synthetic-interruption-tree-v1',
    operation_id: operation.operation_id,
    root_process_id: fixture.processId,
    observed_pids: [fixture.processId],
  });
  const resourcesDigest = overrides.resources_digest ?? digest({
    contract: 'synthetic-interruption-resources-v1',
    operation_id: operation.operation_id,
    worker_exited: true,
  });
  const adapterCleanup = overrides.adapter_cleanup ?? {
    contract: 'adapter-cleanup-v1',
    close: { stage: 'direct_close', status: 'resolved', treeScanStatus: 'verified' },
    treeScanStatus: 'verified',
  };
  const interruptionEvidence = overrides.interruption_evidence ?? {
    contract: 'sqlite-candidate-recovery-interruption-v1',
    reason: 'worker_exited_without_result',
    operation_id: operation.operation_id,
    task_id: operation.task_id,
    attempt: operation.attempt,
    generation: operation.generation,
    claim_id: operation.claim_id,
    worker_identity_digest: operation.claim_worker_identity_digest,
    initial_identity_state: 'exited',
    final_identity_state: 'exited',
    probe_reason: 'not_found',
    process_tree_digest: processTreeDigest,
    resources_digest: resourcesDigest,
    host_worker_handle_present: false,
    worker_stdio_closed: true,
  };
  return {
    operation_id: operation.operation_id,
    task_id: operation.task_id,
    attempt: operation.attempt,
    generation: operation.generation,
    revision: operation.revision,
    claim_id: operation.claim_id,
    claim_worker_identity_digest: operation.claim_worker_identity_digest,
    reason: interruptionEvidence.reason,
    interruption_evidence: interruptionEvidence,
    process_tree_digest: processTreeDigest,
    resources_digest: resourcesDigest,
    adapter_cleanup: adapterCleanup,
    continuation_operation_id: fixture.continuationOperationId,
    ...overrides,
  };
}

function gates() {
  return {
    workspaceValidator: () => ({ state: 'allow', fixture: true }),
    executionPermissionCheck: () => ({ state: 'allow', fixture: true }),
  };
}

function failure(fn, code) {
  assert.throws(fn, error => error instanceof AdmissionError && error.code === code);
}

function lifecycleRows(root, fixture) {
  const db = new DatabaseSync(path.join(root, 'operations.sqlite3'), { readOnly: true });
  try {
    return {
      operation: db.prepare('SELECT * FROM manager_operations WHERE operation_id=?').get(fixture.operationId),
      task: db.prepare('SELECT * FROM tasks WHERE task_id=?').get(fixture.taskId),
      attempts: db.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY attempt').all(fixture.taskId),
      events: db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence').all(fixture.operationId),
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally {
    db.close();
  }
}

test('interruptAndRequeue preserves Attempt history and is idempotent', () => {
  const fixture = makeRunning('preserve');
  try {
    const before = lifecycleRows(fixture.root, fixture);
    const operationBefore = fixture.store.readOperation(fixture.operationId);
    const outcome = fixture.store.interruptAndRequeue(interruptionInput(fixture), gates());
    assert.equal(outcome.duplicate, false);
    assert.equal(outcome.previous_attempt, 1);
    assert.equal(outcome.attempt, 2);
    assert.equal(outcome.status, 'queued');
    assert.match(outcome.cleanup_digest, /^[0-9a-f]{64}$/u);

    const after = lifecycleRows(fixture.root, fixture);
    assert.equal(after.operation.phase, 'released');
    assert.equal(after.task.task_id, fixture.taskId);
    assert.equal(after.task.status, 'queued');
    assert.equal(after.task.current_attempt, 2);
    assert.equal(after.attempts.length, 2);
    assert.equal(after.attempts[0].status, 'failed');
    assert.equal(after.attempts[0].generation, operationBefore.generation);
    assert.equal(after.attempts[1].status, 'queued');
    assert.deepEqual(after.events.map(event => event.event_type), [
      ...before.events.map(event => event.event_type),
      'observation_recorded',
      'result_committed',
      'cleanup_pending',
      'cleanup_verified',
      'released',
    ]);
    assert.equal(after.integrity, 'ok');
    assert.deepEqual(after.foreignKeys, []);

    const replay = fixture.store.interruptAndRequeue(interruptionInput(fixture, {
      interruption_evidence: {
        ...interruptionInput(fixture).interruption_evidence,
        probe_reason: 'different_but_identity_match',
      },
      process_tree_digest: 'c'.repeat(64),
      resources_digest: 'd'.repeat(64),
    }), gates());
    assert.equal(replay.duplicate, true);
    assert.equal(replay.evidence_digest, outcome.evidence_digest);
    assert.equal(replay.cleanup_digest, outcome.cleanup_digest);
    assert.equal(lifecycleRows(fixture.root, fixture).attempts.length, 2);

    fixture.store.close();
    const reopened = IsolatedAdmissionStore.openForRecovery(fixture.root);
    assert.ok(reopened);
    try {
      const snapshot = reopened.readRecoverySnapshot();
      assert.equal(snapshot.root_status, 'consistent_read_only');
      assert.equal(snapshot.operations.find(operation => operation.operation_id === fixture.operationId)?.phase, 'released');
    } finally {
      reopened.close();
    }
  } finally {
    try { fixture.store.close(); } catch {}
  }
});

test('interruptAndRequeue requires complete verified Adapter cleanup evidence', () => {
  const fixture = makeRunning('adapter-proof-required');
  try {
    const before = lifecycleRows(fixture.root, fixture);
    failure(() => fixture.store.interruptAndRequeue({
      ...interruptionInput(fixture),
      adapter_cleanup: undefined,
    }, gates()), 'invalid_interruption_request');
    failure(() => fixture.store.interruptAndRequeue(interruptionInput(fixture, {
      adapter_cleanup: {
        contract: 'adapter-cleanup-v1',
        close: { stage: 'direct_close', status: 'resolved', treeScanStatus: 'incomplete' },
        treeScanStatus: 'incomplete',
      },
    }), gates()), 'invalid_interruption_request');
    const after = lifecycleRows(fixture.root, fixture);
    assert.deepEqual(after.operation, before.operation);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.events, before.events);
  } finally {
    fixture.store.close();
  }
});

test('interruptAndRequeue stale CAS and transaction faults leave no partial history', () => {
  const staleFixture = makeRunning('stale');
  try {
    const before = lifecycleRows(staleFixture.root, staleFixture);
    failure(() => staleFixture.store.interruptAndRequeue(interruptionInput(staleFixture, {
      revision: before.operation.revision - 1,
    }), gates()), 'stale_interruption_cas');
    const after = lifecycleRows(staleFixture.root, staleFixture);
    assert.deepEqual(after.operation, before.operation);
    assert.deepEqual(after.task, before.task);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.events, before.events);
  } finally {
    staleFixture.store.close();
  }

  const rollbackFixture = makeRunning('rollback');
  let faulty;
  try {
    const before = lifecycleRows(rollbackFixture.root, rollbackFixture);
    rollbackFixture.store.close();
    faulty = IsolatedAdmissionStore.open(rollbackFixture.root, { fault: 'after_projection' });
    failure(() => faulty.interruptAndRequeue(
      interruptionInput({ ...rollbackFixture, store: faulty }),
      gates(),
    ), 'injected_failure');
    faulty.close();
    faulty = null;
    const after = lifecycleRows(rollbackFixture.root, rollbackFixture);
    assert.deepEqual(after.operation, before.operation);
    assert.deepEqual(after.task, before.task);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.events, before.events);
  } finally {
    try { rollbackFixture.store.close(); } catch {}
    try { faulty?.close(); } catch {}
  }
});
