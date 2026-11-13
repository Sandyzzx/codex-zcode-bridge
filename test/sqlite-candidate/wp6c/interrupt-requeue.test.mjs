import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdmissionError, digest, IsolatedAdmissionStore } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../../..');
const TEST_ROOT = process.env.WP6C_TEST_TEMP_ROOT
  ? path.resolve(process.env.WP6C_TEST_TEMP_ROOT, `interrupt-requeue-${process.pid}`)
  : path.join(PROJECT_ROOT, 'src/sqlite-candidate/wp6b2b1', `test-temp-interrupt-requeue-${process.pid}`);
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

function trustedIdentity(kind, suffix, processId, fingerprint, generation = 1) {
  const base = {
    source: kind === 'launch' ? 'manager_os_spawn_observation' : 'manager_verified_process_probe',
    fixture: false,
    ...(kind === 'launch' ? { launch_id: `launch-${suffix}`, generation } : { worker_id: `worker-${suffix}` }),
    process_id: processId,
    start_fingerprint: fingerprint,
    fingerprint_precision: 'exact',
    identity_version: 1,
    platform: 'win32',
    captured_at: '2026-11-13T00:00:00.000Z',
  };
  return { ...base, evidence_digest: digest(base) };
}

function makeRunning(label, { capacity = 1 } = {}) {
  const root = path.join(TEST_ROOT, `${label}-${++serial}`);
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = IsolatedAdmissionStore.initialize(root);
  const taskId = `task-${label}`;
  const operationId = `operation-${label}`;
  store.provisionCapacity({
    operation_id: `policy-${label}`,
    capacity_limit: capacity,
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
    launch_identity: trustedIdentity('launch', label, processId, fingerprint, admitted.generation),
  });
  store.commitPermanentClaim({
    ...launch,
    revision: receipt.revision,
    claim_id: `claim-${label}`,
    worker_identity: trustedIdentity('worker', label, processId, fingerprint),
  });
  return {
    root,
    workspace,
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

test('interruptAndRequeue preserves the old Attempt and atomically creates exactly one queued continuation', () => {
  const fixture = makeRunning('preserve');
  try {
    const before = lifecycleRows(fixture.root, fixture);
    const operationBefore = fixture.store.readOperation(fixture.operationId);
    const outcome = fixture.store.interruptAndRequeue(interruptionInput(fixture), gates());
    assert.equal(outcome.duplicate, false);
    assert.equal(outcome.operation_id, fixture.operationId);
    assert.equal(outcome.previous_attempt, 1);
    assert.equal(outcome.attempt, 2);
    assert.equal(outcome.status, 'queued');
    assert.equal(outcome.interruption_reason, 'worker_exited_without_result');
    assert.match(outcome.result_digest, /^[0-9a-f]{64}$/u);
    assert.match(outcome.cleanup_digest, /^[0-9a-f]{64}$/u);

    const after = lifecycleRows(fixture.root, fixture);
    assert.equal(after.operation.phase, 'released');
    assert.equal(after.operation.result_status, 'failed');
    const result = JSON.parse(after.operation.result_json);
    assert.equal(result.error_code, 'worker_exited_without_result');
    assert.deepEqual(result.issues, [`interruption_evidence:${outcome.evidence_digest}`]);
    assert.equal(after.task.task_id, fixture.taskId, 'requeue must preserve the Task ID');
    assert.equal(after.task.status, 'queued');
    assert.equal(after.task.current_attempt, 2);
    assert.equal(after.attempts.length, 2);
    assert.equal(after.attempts[0].attempt, 1);
    assert.equal(after.attempts[0].status, 'failed');
    assert.equal(after.attempts[0].generation, operationBefore.generation);
    assert.equal(after.attempts[1].attempt, 2);
    assert.equal(after.attempts[1].status, 'queued');
    assert.equal(after.attempts[1].generation, null);
    const continuation = JSON.parse(after.attempts[1].continuation_json);
    assert.equal(continuation.previous_operation_id, fixture.operationId);
    assert.equal(continuation.previous_attempt, 1);
    assert.equal(continuation.previous_revision, after.operation.revision);
    assert.deepEqual(after.events.map(event => event.event_type), [
      ...before.events.map(event => event.event_type),
      'observation_recorded',
      'result_committed',
      'cleanup_pending',
      'cleanup_verified',
      'released',
    ]);
    assert.equal(after.events.filter(event => event.event_type === 'result_committed').length, 1);
    assert.equal(after.events.filter(event => event.event_type === 'cleanup_verified').length, 1);
    assert.equal(after.events.filter(event => event.event_type === 'released').length, 1);
    assert.equal(after.integrity, 'ok');
    assert.deepEqual(after.foreignKeys, []);
    assert.ok(fixture.store.readRecoverableQueuedAttempts().some(candidate =>
      candidate.task_id === fixture.taskId && candidate.attempt === 2 && candidate.dispatchable === true));

    const replayInput = interruptionInput(fixture, {
      interruption_evidence: {
        ...interruptionInput(fixture).interruption_evidence,
        probe_reason: 'different_but_identity_match',
      },
      process_tree_digest: 'c'.repeat(64),
      resources_digest: 'd'.repeat(64),
    });
    const replay = fixture.store.interruptAndRequeue(replayInput, gates());
    assert.equal(replay.duplicate, true);
    assert.equal(replay.evidence_digest, outcome.evidence_digest,
      'idempotent Recovery must return the persisted interruption evidence');
    assert.equal(replay.cleanup_digest, outcome.cleanup_digest,
      'idempotent Recovery must return the persisted Cleanup digest');
    assert.equal(lifecycleRows(fixture.root, fixture).attempts.length, 2,
      'a repeated Recovery must not create another Attempt');

    fixture.store.close();
    const reopened = IsolatedAdmissionStore.openForRecovery(fixture.root);
    assert.ok(reopened);
    try {
      const snapshot = reopened.readRecoverySnapshot();
      assert.equal(snapshot.root_status, 'consistent_read_only');
      const previous = snapshot.operations.find(operation => operation.operation_id === fixture.operationId);
      assert.equal(previous.phase, 'released');
      assert.equal(previous.capacity_occupied, false);
    } finally {
      reopened.close();
    }
  } finally {
    try { fixture.store.close(); } catch {}
  }
});

test('interruptAndRequeue refuses to manufacture Cleanup without verified Adapter proof', () => {
  const fixture = makeRunning('adapter-proof-required');
  try {
    const before = lifecycleRows(fixture.root, fixture);
    failure(
      () => fixture.store.interruptAndRequeue({
        ...interruptionInput(fixture),
        adapter_cleanup: undefined,
      }, gates()),
      'invalid_interruption_request',
    );
    failure(
      () => fixture.store.interruptAndRequeue(interruptionInput(fixture, {
        adapter_cleanup: {
          contract: 'adapter-cleanup-v1',
          close: { stage: 'direct_close', status: 'resolved', treeScanStatus: 'incomplete' },
          treeScanStatus: 'incomplete',
        },
      }), gates()),
      'invalid_interruption_request',
    );
    const after = lifecycleRows(fixture.root, fixture);
    assert.deepEqual(after.operation, before.operation);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.events, before.events);
  } finally {
    fixture.store.close();
  }
});

test('interruptAndRequeue rejects stale CAS without any projection or event change', () => {
  const fixture = makeRunning('stale');
  try {
    const before = lifecycleRows(fixture.root, fixture);
    failure(() => fixture.store.interruptAndRequeue(interruptionInput(fixture, {
      revision: before.operation.revision - 1,
    }), gates()), 'stale_interruption_cas');
    const after = lifecycleRows(fixture.root, fixture);
    assert.deepEqual(after.operation, before.operation);
    assert.deepEqual(after.task, before.task);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.events, before.events);
  } finally {
    fixture.store.close();
  }
});

test('interruptAndRequeue rolls back every lifecycle write when the transaction faults', () => {
  const fixture = makeRunning('rollback');
  let faulty;
  try {
    const before = lifecycleRows(fixture.root, fixture);
    fixture.store.close();
    faulty = IsolatedAdmissionStore.open(fixture.root, { fault: 'after_projection' });
    failure(() => faulty.interruptAndRequeue(interruptionInput({ ...fixture, store: faulty }), gates()), 'injected_failure');
    faulty.close();
    faulty = null;
    const after = lifecycleRows(fixture.root, fixture);
    assert.deepEqual(after.operation, before.operation);
    assert.deepEqual(after.task, before.task);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.integrity, 'ok');
    assert.deepEqual(after.foreignKeys, []);
  } finally {
    try { fixture.store.close(); } catch {}
    try { faulty?.close(); } catch {}
  }
});

test('interruptAndRequeue refuses unresolved interaction and cancellation intents', () => {
  const interactionFixture = makeRunning('interaction-intent');
  try {
    const operation = interactionFixture.store.readOperation(interactionFixture.operationId);
    interactionFixture.store.recordInteractionRequest({
      operation_id: operation.operation_id,
      task_id: operation.task_id,
      attempt: operation.attempt,
      generation: operation.generation,
      expected_revision: operation.revision,
      claim_id: operation.claim_id,
      worker_identity_digest: operation.claim_worker_identity_digest,
      request: {
        request_id: 'request-interrupt',
        method: 'interaction/requestPermission',
        params: { options: [{ kind: 'allow_once', label: 'Allow' }] },
      },
    });
    failure(() => interactionFixture.store.interruptAndRequeue(
      interruptionInput(interactionFixture), gates(),
    ), 'interaction_reply_outcome_unknown');
    assert.equal(interactionFixture.store.readOperation(interactionFixture.operationId).phase, 'running');
    interactionFixture.store.beginInteractionReply({
      task_id: interactionFixture.taskId,
      request_id: 'request-interrupt',
      decision: 'deny',
      reason: 'synthetic unresolved reply',
    });
    failure(() => interactionFixture.store.interruptAndRequeue(
      interruptionInput(interactionFixture), gates(),
    ), 'interaction_reply_outcome_unknown');
    assert.equal(interactionFixture.store.readOperation(interactionFixture.operationId).phase, 'running');
  } finally {
    interactionFixture.store.close();
  }

  const cancellationFixture = makeRunning('cancellation-intent');
  try {
    const operation = cancellationFixture.store.readOperation(cancellationFixture.operationId);
    const workerIdentity = JSON.parse(operation.claim_worker_identity_json);
    const identityEvidence = {
      source: 'manager_process_probe',
      operation_id: operation.operation_id,
      task_id: operation.task_id,
      attempt: operation.attempt,
      generation: operation.generation,
      worker_identity_digest: operation.claim_worker_identity_digest,
      process_id: workerIdentity.process_id,
      start_fingerprint: workerIdentity.start_fingerprint,
      state: 'alive',
    };
    cancellationFixture.store.requestCancellation({
      operation_id: operation.operation_id,
      task_id: operation.task_id,
      attempt: operation.attempt,
      generation: operation.generation,
      revision: operation.revision,
      claim_id: operation.claim_id,
      claim_worker_identity_digest: operation.claim_worker_identity_digest,
      worker_identity: workerIdentity,
    }, identityEvidence, ({ operation: current, worker_identity, evidence }) =>
      evidence.worker_identity_digest === current.claim_worker_identity_digest
        && evidence.process_id === worker_identity.process_id
        && evidence.start_fingerprint === worker_identity.start_fingerprint
        ? {
            state: evidence.state,
            worker_identity_digest: current.claim_worker_identity_digest,
            evidence_digest: digest(evidence),
          }
        : false);
    failure(() => cancellationFixture.store.interruptAndRequeue(
      interruptionInput(cancellationFixture), gates(),
    ), 'interaction_cancel_intent_present');
    assert.equal(cancellationFixture.store.readOperation(cancellationFixture.operationId).phase, 'running');
  } finally {
    cancellationFixture.store.close();
  }
});
