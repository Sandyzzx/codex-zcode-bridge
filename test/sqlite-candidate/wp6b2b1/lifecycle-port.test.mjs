import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteLifecyclePort, UnsupportedLifecycleOperationError } from '../../../src/sqlite-candidate/wp6b2b1/lifecycle-port.mjs';
import { digest, IsolatedAdmissionStore } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';
import { createPlatformProbe } from '../../../dist/src/runtime/process-probe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMP = process.env.WP6C_TEST_TEMP_ROOT ? path.resolve(process.env.WP6C_TEST_TEMP_ROOT)
  : path.resolve(HERE, `../../../src/sqlite-candidate/wp6b2b1/test-port-temp-${process.pid}-${randomUUID()}`);
mkdirSync(TEMP, { recursive: true });
let serial = 0;
let preserveTemp = false;
const root = label => {
  const value = path.join(TEMP, `${label}-${++serial}`);
  mkdirSync(value, { recursive: true });
  return value;
};
const task = (task_id, workspace) => ({
  task_id,
  workspace,
  objective: 'synthetic lifecycle task',
  requirements: ['synthetic requirement'],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: ['synthetic acceptance'],
  test_commands: [],
});
const allow = () => ({ state: 'allow', fixture: true });
const gates = { workspaceValidator: allow, executionPermissionCheck: allow };
const importedStore = async () => import('../../../src/sqlite-candidate/wp6b2b1/store.mjs');
async function readStreamToEnd(stream, maximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximum) throw new Error('synthetic Worker frame exceeded limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function readSingleLineFrame(stream, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maximum) {
        cleanup();
        reject(new Error('synthetic Worker frame exceeded limit'));
        return;
      }
      chunks.push(bytes);
      const frame = Buffer.concat(chunks, total);
      const newline = frame.indexOf(0x0a);
      if (newline !== -1) {
        if (newline !== frame.length - 1) {
          cleanup();
          reject(new Error('synthetic Worker emitted trailing identity report bytes'));
          return;
        }
        cleanup();
        stream.resume();
        resolve(frame);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('synthetic Worker report pipe closed before a complete frame'));
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

async function withinStage(promise, stage, timeoutMs = 12_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${stage} exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function makePriorAttempt(store, taskId, workspace, resultStatus = 'completed', finishCleanup = true) {
  const operationId = `prior-${taskId}`;
  store.createTask(task(taskId, workspace), '2026-10-25T00:00:00.000Z');
  const admitted = store.admitOperation({ operation_id: operationId, task_id: taskId, attempt: 1, workspace_ref: workspace }, gates);
  const launch = { operation_id: operationId, task_id: taskId, attempt: 1, generation: admitted.generation,
    revision: admitted.revision, launch_id: `launch-${taskId}`, launch_epoch: 1, launch_token: `token-${taskId}-0123456789abcdef` };
  const intent = store.createLaunchIntent(launch);
  const processId = 42111;
  const receipt = store.recordLaunchReceipt({ ...launch, revision: intent.revision, receipt_id: `receipt-${taskId}`,
    launch_identity: { source: 'synthetic_fixture', fixture: true, process_id: processId, start_fingerprint: `start-${taskId}` } });
  const workerIdentity = { source: 'synthetic_fixture', fixture: true, worker_id: `worker-${taskId}`, incarnation: `incarnation-${taskId}`,
    process_id: processId, start_fingerprint: `start-${taskId}` };
  const claim = store.commitPermanentClaim({ ...launch, revision: receipt.revision, claim_id: `claim-${taskId}`, worker_identity: workerIdentity });
  let cancelVerificationDigest;
  if(resultStatus==='cancelled'){
    const operation=store.readOperation(operationId),identityEvidence={source:'synthetic_manager_probe',operation_id:operationId,task_id:taskId,
      attempt:1,generation:operation.generation,worker_identity_digest:operation.claim_worker_identity_digest,process_id:processId,
      start_fingerprint:`start-${taskId}`,state:'alive'};
    const fence={operation_id:operationId,task_id:taskId,attempt:1,generation:operation.generation,revision:operation.revision,
      claim_id:operation.claim_id,claim_worker_identity_digest:operation.claim_worker_identity_digest,worker_identity:workerIdentity};
    const requested=store.requestCancellation(fence,identityEvidence,({operation:o,worker_identity,evidence})=>
      evidence.operation_id===o.operation_id&&evidence.worker_identity_digest===o.claim_worker_identity_digest
        &&worker_identity.process_id===processId?{state:'alive',worker_identity_digest:o.claim_worker_identity_digest,evidence_digest:digest(evidence)}:false);
    const treeEvidence={source:'synthetic_tree_verifier',operation_id:operationId,task_id:taskId,attempt:1,generation:operation.generation,
      cancel_id:requested.cancel_id,claim_id:operation.claim_id,worker_identity_digest:operation.claim_worker_identity_digest,
      process_tree:[{pid:processId,start:`start-${taskId}`}],root_process_id:processId,root_start_fingerprint:`start-${taskId}`,worker_tree_complete:true};
    const verified=store.recordCancellationVerification({...fence,revision:requested.revision},treeEvidence,({operation:o,cancel_intent,worker_identity,evidence})=>
      cancel_intent.cancel_id===evidence.cancel_id&&worker_identity.process_id===processId?{state:'verified',worker_identity_digest:o.claim_worker_identity_digest,
        process_tree_digest:digest(evidence.process_tree),root_process_id:processId,root_start_fingerprint:`start-${taskId}`,
        worker_tree_complete:true,evidence_digest:digest(evidence)}:false);
    cancelVerificationDigest=verified.cancellation_verification_digest;
  }
  const result = { task_id: taskId, attempt: 1, status: resultStatus, summary: 'synthetic prior result', files_changed: [], tests: [], issues: [],
    needs_master_decision: resultStatus === 'waiting_for_master', zcode_output: '', exit_code: 0, session_id: null,
    started_at: '2026-10-25T00:00:00.000Z', finished_at: '2026-10-25T00:00:01.000Z' };
  const committed = store.commitResult({ operation_id: operationId, task_id: taskId, attempt: 1, generation: admitted.generation,
    revision: store.readOperation(operationId).revision, claim_id: claim.claim_id, claim_worker_identity_digest: store.readOperation(operationId).claim_worker_identity_digest,
    result_status: resultStatus, result,...(cancelVerificationDigest?{cancel_verification_digest:cancelVerificationDigest}:{}) });
  const current = store.readOperation(operationId);
  const ref = { operation_id: operationId, task_id: taskId, attempt: 1, generation: admitted.generation, revision: committed.revision,
    claim_id: current.claim_id, claim_worker_identity_digest: current.claim_worker_identity_digest };
  if (!finishCleanup) return { ...ref, operation: current, processId, startFingerprint: `start-${taskId}` };
  const pending = store.beginCleanup(ref);
  const cleanupEvidence = { source: 'synthetic_fixture', fixture: true, operation_id: operationId, task_id: taskId, attempt: 1,
    generation: admitted.generation, claim_id: current.claim_id, worker_identity_digest: current.claim_worker_identity_digest,
    launch_receipt_digest: current.launch_receipt_digest, result_commit_ref: current.result_commit_ref,
    process_tree_digest: digest({ processId, children: [] }), resources_digest: digest({ taskId, resources: [] }),
    root_process_id: processId, root_start_fingerprint: `start-${taskId}`, worker_tree_complete: true,
    operation_resources_complete: true, workspace_touched: false };
  const verified = store.recordCleanupEvidence({ ...ref, revision: pending.revision, outcome: 'verified', cleanup_evidence: cleanupEvidence });
  const released = store.releaseCapacity({ ...ref, revision: verified.revision, cleanup_digest: verified.cleanup_digest });
  return { ...ref, revision: released.revision, operation: store.readOperation(operationId), processId, startFingerprint: `start-${taskId}` };
}

function makeCandidateStore(label, capacity = 2) {
  const r = root(label);
  const workspace = path.join(TEMP, `${label}-workspace`);
  mkdirSync(workspace, { recursive: true });
  const store = IsolatedAdmissionStore.initialize(r);
  store.provisionCapacity({ operation_id: `policy-${label}`, capacity_limit: capacity, expected_generation: 0,
    maintenance: { dispatch_blocked: true, writers_drained: true } });
  return { r, workspace, store, port: createSqliteLifecyclePort(store) };
}

async function makeRunningInteraction(label, mode = 'normal') {
  const fixture = makeCandidateStore(label, 1);
  const taskId = `interaction-task-${label}`;
  const operationId = `interaction-operation-${label}`;
  fixture.store.createTask(task(taskId, fixture.workspace));
  const admitted = fixture.store.admitOperation({ operation_id: operationId, task_id: taskId, attempt: 1, workspace_ref: fixture.workspace }, gates);
  const launch = { operation_id: operationId, task_id: taskId, attempt: 1, generation: admitted.generation,
    revision: admitted.revision, launch_id: `interaction-launch-${label}`, launch_epoch: 1,
    launch_token: `interaction-launch-token-${label}-0123456789` };
  const intent = fixture.store.createLaunchIntent(launch);
  const channelUrl = new URL('../../../src/sqlite-candidate/wp6b2b1/interaction-channel.mjs', import.meta.url).href;
  const probeUrl = new URL('../../../dist/src/runtime/process-probe.js', import.meta.url).href;
  const workerProgram = `import {createReadStream,createWriteStream} from 'node:fs';
    const {createCandidateWorkerInteractionChannel}=await import(${JSON.stringify(channelUrl)});
    const {createPlatformProbe}=await import(${JSON.stringify(probeUrl)});
    const probe=createPlatformProbe();
    const channel=await createCandidateWorkerInteractionChannel({
      requestStream:createWriteStream(null,{fd:7,autoClose:false}), replyStream:createReadStream(null,{fd:8,autoClose:false}),
      ackStream:createWriteStream(null,{fd:9,autoClose:false}), processId:process.pid,
      verifySelfIdentity:async({processId,expected})=>{const identity=await probe.identityOf(processId);
        return identity.fingerprint_precision==='exact'&&identity.fingerprint===expected.start_fingerprint
          ?{state:'verified',process_id:identity.pid,start_fingerprint:identity.fingerprint}:false;},
      onStage:stage=>process.stderr.write('[interaction-fixture] '+stage+'\\n')
    });
    process.stderr.write('[interaction-fixture] channel-ready\\n');
    await channel.sendRequest({method:'interaction/requestUserInput',params:{questions:[{question:'Continue?'}]},request_id:'request-${label}'});
    process.stderr.write('[interaction-fixture] request-sent\\n');
    if(process.argv.at(-1)==='drop-after-prepared'){process.stdout.write('prepared\\n',()=>process.exit(0));}
    const reply=await channel.acceptCommittedReply();
    process.stderr.write('[interaction-fixture] reply-accepted\\n');
    process.stdout.write(JSON.stringify(reply)+'\\n');
    await channel.close();
    process.exitCode=0;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerProgram, mode], {
    cwd: path.resolve(HERE, '../../../'), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const workerStderr = [];
  child.stderr.on('data', chunk => workerStderr.push(Buffer.from(chunk)));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const probe = createPlatformProbe();
  const launchIdentity = await probe.identityOf(child.pid);
  if (launchIdentity.fingerprint_precision !== 'exact' || !launchIdentity.fingerprint) {
    child.kill();
    throw new Error('exact OS process identity is required by the interaction channel test');
  }
  const startFingerprint = launchIdentity.fingerprint;
  const receipt = fixture.store.recordLaunchReceipt({ ...launch, revision: intent.revision, receipt_id: `interaction-receipt-${label}`,
    launch_identity: { source: 'synthetic_fixture', fixture: true, process_id: child.pid, start_fingerprint: startFingerprint } });
  const workerIdentity = { source: 'synthetic_fixture', fixture: true, worker_id: `interaction-worker-${label}`,
    incarnation: `interaction-incarnation-${label}`, process_id: child.pid, start_fingerprint: startFingerprint };
  fixture.store.commitPermanentClaim({ ...launch, revision: receipt.revision, claim_id: `interaction-claim-${label}`, worker_identity: workerIdentity });
  const operation = fixture.store.readOperation(operationId);
  const channel = await fixture.port.openInteractionChannel(child, operation, async ({ child: current, expected }) => {
    const observed = await probe.identityOf(current.pid);
    return observed.fingerprint_precision === 'exact' && observed.fingerprint === expected.start_fingerprint
      ? { state: 'verified', process_id: observed.pid, start_fingerprint: observed.fingerprint } : false;
  });
  return { ...fixture, child, channel, operation, taskId, operationId,
    workerStderr: () => Buffer.concat(workerStderr).toString('utf8') };
}

function continueInput(prior, operationId = 'continue-op') {
  return { operation_id: operationId, task_id: prior.task_id, previous_attempt: prior.attempt, previous_operation_id: prior.operation_id,
    expected_generation: prior.generation, expected_revision: prior.revision, claim_id: prior.claim_id,
    claim_worker_identity_digest: prior.claim_worker_identity_digest, feedback: 'please refine the result', additional_requirements: ['keep the same scope'] };
}

after(() => { if (!preserveTemp) rmSync(TEMP, { recursive: true, force: true }); });

test('runtime Schema is self-contained and persists a Task with its initial Attempt', async () => {
  const source = readFileSync(new URL('../../../src/sqlite-candidate/wp6b2b1/store.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /test-fixture-schema/u);
  const { IsolatedAdmissionStore } = await importedStore();
  const r = root('task-projection');
  const workspace = path.join(TEMP, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = IsolatedAdmissionStore.initialize(r);
  try {
    const created = store.createTask(task('task-projection', workspace), '2026-10-23T00:00:00.000Z');
    assert.deepEqual(created, { task_id: 'task-projection', current_attempt: 1, status: 'queued', created_at: '2026-10-23T00:00:00.000Z' });
    assert.deepEqual(store.readTask('task-projection'), task('task-projection', workspace));
    assert.deepEqual({ ...store.readTaskProjection('task-projection') }, {
      task_id: 'task-projection', status: 'queued', current_attempt: 1, created_at: '2026-10-23T00:00:00.000Z',
    });
    assert.equal(store.readAttempt('task-projection', 1).generation, null);
    assert.equal(store.readAttempt('task-projection', 1).status, 'queued');
    assert.equal(store.readAttempt('task-projection', 2), null);
    assert.deepEqual(store.readTaskLifecycle('task-projection'), {
      task: task('task-projection', workspace),
      projection: { task_id: 'task-projection', status: 'queued', current_attempt: 1, created_at: '2026-10-23T00:00:00.000Z' },
      attempt: { task_id: 'task-projection', attempt: 1, generation: null, status: 'queued', created_at: '2026-10-23T00:00:00.000Z' },
      operation: null,
      result: null,
      continuation: null,
    });
    assert.deepEqual(store.readTaskEvents('task-projection'), { events: [], nextCursor: 0, hasMore: false });
    const db = new DatabaseSync(path.join(r, 'operations.sqlite3'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name), [
        'attempts', 'authority_metadata', 'authority_switch', 'fresh_install_receipt', 'json_artifacts',
        'manager_interaction_payloads', 'manager_operation_events', 'manager_operations', 'migrated_task_events',
        'migrated_task_results', 'migration_runs', 'sqlite_sequence', 'tasks',
      ]);
    } finally { db.close(); }
    assert.throws(() => store.createTask(task('task-projection', workspace)), error => error.code === 'task_already_exists');
  } finally { store.close(); }
});

test('Queued Cancel persists a Task-scoped result and cursor without inventing an Operation', () => {
  const fixture = makeCandidateStore('queued-cancel-without-operation');
  const taskId = 'queued-cancel-no-operation';
  let cancelCursor;
  try {
    fixture.port.createTask(task(taskId, fixture.workspace), '2026-10-25T01:00:00.000Z');
    const cancelled = fixture.port.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 });
    cancelCursor = cancelled.event_cursor;
    assert.equal(cancelled.duplicate, false);
    assert.equal(cancelled.operation_id, null);
    assert.equal(fixture.port.readTaskProjection(taskId).status, 'cancelled');
    assert.deepEqual({ ...fixture.port.readAttempt(taskId, 1) }, { task_id: taskId, attempt: 1, generation: null,
      status: 'cancelled', created_at: '2026-10-25T01:00:00.000Z' });
    const snapshot = fixture.port.readTaskLifecycle(taskId);
    assert.equal(snapshot.operation, null);
    assert.equal(snapshot.result.status, 'cancelled');
    assert.equal(snapshot.result.started_at, null);
    assert.ok(Number.isFinite(Date.parse(snapshot.result.finished_at)));
    const page = fixture.port.readTaskEvents(taskId);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].event_type, 'cancelled');
    assert.equal(page.events[0].operation_id, null);
    assert.equal(page.events[0].operation_sequence, null);
    assert.equal(page.events[0].cursor, cancelled.event_cursor);
    const duplicate = fixture.port.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.cancel_id, cancelled.cancel_id);
    assert.equal(fixture.port.readTaskEvents(taskId).events.length, 1);
    assert.throws(() => fixture.port.admitOperation({ operation_id: 'queued-cancel-no-operation-admit', task_id: taskId,
      attempt: 1, workspace_ref: fixture.workspace }, gates), error => error.code === 'task_attempt_not_admissible');
    assert.equal(fixture.port.readTaskLifecycle(taskId).operation, null);
  } finally { fixture.store.close(); }

  const reopened = IsolatedAdmissionStore.open(fixture.r);
  try {
    assert.equal(reopened.readTaskLifecycle(taskId).result.status, 'cancelled');
    assert.equal(reopened.readTaskEvents(taskId).events[0].cursor, cancelCursor);
  } finally { reopened.close(); }
});

test('Queued Cancel atomically terminates a reserved Operation and fences Launch Intent', () => {
  const fixture = makeCandidateStore('queued-cancel-reserved-operation', 1);
  const taskId = 'queued-cancel-reserved';
  try {
    fixture.port.createTask(task(taskId, fixture.workspace));
    const admitted = fixture.port.admitOperation({ operation_id: 'queued-cancel-reserved-op', task_id: taskId,
      attempt: 1, workspace_ref: fixture.workspace }, gates);
    const cancelled = fixture.port.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 });
    assert.equal(cancelled.operation_id, admitted.operation_id);
    assert.equal(fixture.port.readOperation(admitted.operation_id).phase, 'cancelled_before_launch');
    assert.equal(fixture.port.readTaskLifecycle(taskId).attempt.status, 'cancelled');
    assert.equal(fixture.port.readTaskLifecycle(taskId).result.status, 'cancelled');
    assert.throws(() => fixture.port.createLaunchIntent({ operation_id: admitted.operation_id, task_id: taskId,
      attempt: 1, generation: admitted.generation, revision: admitted.revision, launch_id: 'queued-cancel-too-late',
      launch_epoch: 1, launch_token: 'queued-cancel-token-0123456789' }), error => error.code === 'stale_launch_cas');
    const duplicate = fixture.port.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 });
    assert.equal(duplicate.duplicate, true);
    assert.equal(fixture.port.readTaskEvents(taskId).events.filter(event => event.event_type === 'cancelled').length, 1);
    const secondTask = 'queued-cancel-capacity-reused';
    fixture.port.createTask(task(secondTask, fixture.workspace));
    const next = fixture.port.admitOperation({ operation_id: 'queued-cancel-capacity-next-op', task_id: secondTask,
      attempt: 1, workspace_ref: fixture.workspace }, gates);
    assert.equal(next.capacity_slot, admitted.capacity_slot);
  } finally { fixture.store.close(); }
});

test('Queued Cancel refuses after Launch Intent wins and preserves Unknown launch state', () => {
  const fixture = makeCandidateStore('queued-cancel-launch-intent-wins', 1);
  const taskId = 'queued-cancel-launch-wins';
  try {
    fixture.port.createTask(task(taskId, fixture.workspace));
    const admitted = fixture.port.admitOperation({ operation_id: 'queued-cancel-launch-wins-op', task_id: taskId,
      attempt: 1, workspace_ref: fixture.workspace }, gates);
    fixture.port.createLaunchIntent({ operation_id: admitted.operation_id, task_id: taskId, attempt: 1,
      generation: admitted.generation, revision: admitted.revision, launch_id: 'queued-cancel-launch-wins-id',
      launch_epoch: 1, launch_token: 'queued-cancel-launch-token-0123456789' });
    assert.throws(() => fixture.port.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 }),
      error => error.code === 'queued_cancel_launch_already_intended');
    assert.equal(fixture.port.readTaskProjection(taskId).status, 'queued');
    assert.equal(fixture.port.readOperation(admitted.operation_id).phase, 'launch_intent');
    assert.equal(fixture.port.readTaskEvents(taskId).events.some(event => event.event_type === 'cancelled'), false);
  } finally { fixture.store.close(); }
});

test('Queued Cancel uses attempt CAS against Continue and Admission outcomes', () => {
  const fixture = makeCandidateStore('queued-cancel-continue-fence', 1);
  const taskId = 'queued-cancel-continue-fenced-task';
  try {
    const prior = makePriorAttempt(fixture.store, taskId, fixture.workspace, 'completed');
    const next = fixture.port.createNextAttempt(continueInput(prior, 'queued-cancel-continue-key'), gates);
    assert.equal(next.attempt, 2);
    assert.equal(next.status, 'queued');
    assert.throws(() => fixture.port.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 }),
      error => error.code === 'queued_cancel_not_admissible');
    const cancelled = fixture.port.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 2 });
    assert.equal(cancelled.status, 'cancelled');
    assert.throws(() => fixture.port.createNextAttempt(continueInput(prior, 'queued-cancel-after-cancel-key'), gates),
      error => error.code === 'stale_continue_cas');
    assert.equal(fixture.port.readTaskProjection(taskId).current_attempt, 2);
    assert.equal(fixture.port.readTaskProjection(taskId).status, 'cancelled');
  } finally { fixture.store.close(); }
});

test('Queued Cancel rolls back known failure and poisons an unknown commit outcome', () => {
  const fixture = makeCandidateStore('queued-cancel-failure-boundary');
  const taskId = 'queued-cancel-failure-task';
  fixture.port.createTask(task(taskId, fixture.workspace));
  fixture.store.close();
  const rollbackStore = IsolatedAdmissionStore.open(fixture.r, { fault: 'after_projection' });
  try {
    assert.throws(() => rollbackStore.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 }),
      error => error.code === 'injected_failure');
  } finally { rollbackStore.close(); }
  const clean = IsolatedAdmissionStore.open(fixture.r);
  assert.equal(clean.readTaskProjection(taskId).status, 'queued');
  assert.equal(clean.readTaskEvents(taskId).events.length, 0);
  clean.close();

  const unknownStore = IsolatedAdmissionStore.open(fixture.r, { fault: 'commit_ack_lost' });
  try {
    assert.throws(() => unknownStore.cancelQueuedAttempt({ task_id: taskId, expected_attempt: 1 }),
      error => error.code === 'transaction_outcome_unknown');
    assert.equal(unknownStore.poisoned, true);
    assert.equal(unknownStore.readTaskProjection(taskId).status, 'cancelled');
  } finally { unknownStore.close(); }
  assert.throws(() => IsolatedAdmissionStore.open(fixture.r), error => error.code === 'root_poisoned');
});

test('Candidate feedback projects only authoritative Task status and leaves absent observations unobserved', () => {
  const f = makeCandidateStore('feedback-projection');
  try {
    f.port.createTask(task('feedback-projection', f.workspace), '2026-10-25T00:00:00.000Z');
    assert.deepEqual(f.port.readTaskFeedback('feedback-projection'), {
      schema_version: '0.1', task_id: 'feedback-projection', attempt: 1, status: 'queued',
      model: null, phase: null, progress: null, activity: null,
      interaction: { state: 'not_observed', kind: null }, result: null,
    });
    assert.equal(f.port.readTaskFeedback('missing-feedback-task'), null);
  } finally { f.store.close(); }
});

test('Candidate feedback does not relabel a committed result as an Agent report without report_ready evidence', () => {
  const f = makeCandidateStore('feedback-result-evidence');
  try {
    makePriorAttempt(f.store, 'feedback-result-evidence', f.workspace, 'completed', true);
    const snapshot = f.port.readTaskFeedback('feedback-result-evidence');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.attempt, 1);
    assert.equal(snapshot.result, null);
    assert.equal(snapshot.activity, null);
    assert.deepEqual(snapshot.interaction, { state: 'not_observed', kind: null });
  } finally { f.store.close(); }
});

test('Continue creates a fenced next Attempt only after a released eligible result and is idempotent after reopen', async () => {
  for (const resultStatus of ['completed', 'failed', 'waiting_for_master']) {
    const fixture = makeCandidateStore(`continue-${resultStatus}`);
    try {
      const prior = makePriorAttempt(fixture.store, `continue-task-${resultStatus}`, fixture.workspace, resultStatus);
      const request = continueInput(prior, `continue-key-${resultStatus}`);
      if (resultStatus === 'completed') request.feedback = 'please refine the result\nwhile preserving scope';
      const receipt = fixture.port.createNextAttempt(request, gates);
      assert.equal(receipt.duplicate, false);
      assert.equal(receipt.attempt, 2);
      assert.equal(receipt.status, 'queued');
      assert.deepEqual({ ...fixture.port.readTaskProjection(request.task_id) }, {
        task_id: request.task_id, status: 'queued', current_attempt: 2, created_at: '2026-10-25T00:00:00.000Z',
      });
      assert.equal(fixture.port.readAttempt(request.task_id, 1).status, resultStatus);
      assert.equal(fixture.port.readAttempt(request.task_id, 1).generation, prior.generation);
      assert.equal(fixture.port.readAttempt(request.task_id, 2).status, 'queued');
      const snapshot = fixture.port.readTaskLifecycle(request.task_id);
      assert.equal(snapshot.operation, null);
      assert.equal(snapshot.attempt.generation, null);
      assert.equal(snapshot.result, null);
      assert.deepEqual(snapshot.continuation, {
        contract: 'wp6b2b-continue-v1', operation_id: request.operation_id, task_id: request.task_id,
        feedback: request.feedback, additional_requirements: request.additional_requirements,
        previous_attempt: 1, previous_operation_id: prior.operation_id, previous_generation: prior.generation,
        previous_revision: prior.revision, previous_claim_id: prior.claim_id,
        previous_worker_identity_digest: prior.claim_worker_identity_digest,
      });
      assert.equal(fixture.port.readOperation(prior.operation_id).claim_id, prior.claim_id);
      assert.equal(fixture.port.readCommittedResult(prior.operation_id).result.status, resultStatus);
      const eventCount = fixture.store.readSnapshot().events.length;
      assert.equal(fixture.store.readSnapshot().operations.filter(row => row.task_id === request.task_id).length, 1);
      fixture.store.close();
      const reopened = IsolatedAdmissionStore.open(fixture.r);
      const reopenedPort = createSqliteLifecyclePort(reopened);
      try {
        const publicRetry = { operation_id: request.operation_id, task_id: request.task_id, feedback: request.feedback,
          additional_requirements: request.additional_requirements };
        const duplicate = reopenedPort.createNextAttempt(publicRetry, gates);
        assert.equal(duplicate.duplicate, true);
        assert.deepEqual({ ...duplicate }, { ...receipt, duplicate: true });
        const duplicateWithStaleFences = reopenedPort.createNextAttempt({ ...publicRetry, previous_attempt: 88,
          previous_operation_id: 'obsolete-prior-operation', expected_generation: 0, expected_revision: 0,
          claim_id: 'obsolete-claim', claim_worker_identity_digest: '0'.repeat(64) }, gates);
        assert.equal(duplicateWithStaleFences.duplicate, true);
        assert.deepEqual({ ...duplicateWithStaleFences }, { ...receipt, duplicate: true });
        assert.equal(reopened.readSnapshot().events.length, eventCount);
        assert.equal(reopenedPort.readTaskProjection(request.task_id).current_attempt, 2);
        assert.equal(reopened.readAttempt(request.task_id, 3), null);
        assert.equal(reopened.readSnapshot().operations.filter(row => row.task_id === request.task_id).length, 1);
        const admitted = reopenedPort.admitOperation({ operation_id: `scheduled-${resultStatus}`, task_id: request.task_id, attempt: 2,
          workspace_ref: fixture.workspace }, gates);
        assert.ok(admitted.generation > prior.generation);
        assert.equal(reopenedPort.readOperation(admitted.operation_id).phase, 'reserved');
        assert.equal(reopenedPort.readTaskLifecycle(request.task_id).continuation.feedback, request.feedback);
        assert.equal(reopenedPort.createNextAttempt(request, gates).duplicate, true);
      } finally { reopened.close(); }
    } finally { try { fixture.store.close(); } catch {} }
  }
});

test('Candidate Worker interaction persists intent and commit before answer delivery, then accepts one identity-bound ACK', async t => {
  if (process.platform !== 'win32') { t.skip('the Claim/Receipt fixture requires exact Windows process creation identity'); return; }
  const fixture = await makeRunningInteraction('two-phase');
  const output = [];
  fixture.child.stdout.on('data', chunk => output.push(chunk));
  try {
    const request = await withinStage(fixture.port.receiveInteractionRequest(fixture.channel), 'receive interaction request', 30_000)
      .catch(error => { throw new Error(`interaction request failed; pid=${fixture.child.pid}; stderr=${fixture.workerStderr()}`, { cause: error }); });
    assert.equal(request.duplicate, false);
    assert.equal(fixture.store.readInteractionRequest(fixture.taskId, 'request-two-phase').state, 'pending');
    const outcome = await withinStage(fixture.port.replyToInteractionRequest({ task_id: fixture.taskId, request_id: 'request-two-phase',
      decision: 'accept', answers: { 'Continue?': 'yes' } }, fixture.channel), 'reply to interaction request', 30_000)
      .catch(error => { throw new Error(`interaction reply failed; pid=${fixture.child.pid}; exit=${fixture.child.exitCode}; stderr=${fixture.workerStderr()}`, { cause: error }); });
    assert.equal(outcome.state, 'answered');
    assert.equal(outcome.duplicate, false);
    fixture.child.stdio[8]?.end();
    fixture.child.stdio[7]?.destroy();
    fixture.child.stdio[9]?.destroy();
    await withinStage(new Promise(resolve => fixture.child.exitCode !== null ? resolve() : fixture.child.once('exit', resolve)), 'interaction Worker exit', 30_000)
      .catch(error => { throw new Error(`interaction Worker exit failed; pid=${fixture.child.pid}; stderr=${fixture.workerStderr()}`, { cause: error }); });
    assert.deepEqual(JSON.parse(Buffer.concat(output).toString('utf8').trim()), {
      answer: { action: 'accept', content: { answers: { 'Continue?': 'yes' } } },
      reply_id: outcome.reply_id, answer_digest: outcome.answer_digest,
    });
    const events = fixture.store.readSnapshot().events.filter(event => event.operation_id === fixture.operationId);
    assert.deepEqual(events.filter(event => event.event_type.startsWith('interaction_')).map(event => event.event_type), [
      'interaction_requested', 'interaction_reply_intent', 'interaction_reply_prepared',
      'interaction_reply_committed', 'interaction_reply_accepted',
    ]);
    assert.ok(events.every((event, index, all) => index === 0 || event.sequence === all[index - 1].sequence + 1));
    fixture.store.close();
    const reopened = IsolatedAdmissionStore.open(fixture.r);
    try {
      assert.equal(createSqliteLifecyclePort(reopened).readInteractionRequest(fixture.taskId, 'request-two-phase').state, 'answered');
      assert.equal(reopened.readSnapshot().events.filter(event => event.operation_id === fixture.operationId
        && event.event_type.startsWith('interaction_')).length, 5);
    } finally { reopened.close(); }
  } finally {
    if (fixture.child.exitCode === null) { fixture.child.kill(); await new Promise(resolve => fixture.child.once('exit', resolve)); }
    try { fixture.store.close(); } catch {}
  }
});

test('Candidate Worker interaction remains latched after a lost commit ACK and never replays after reopen', async t => {
  if (process.platform !== 'win32') { t.skip('the Claim/Receipt fixture requires exact Windows process creation identity'); return; }
  const fixture = await makeRunningInteraction('lost-ack', 'drop-after-prepared');
  try {
    const request = await fixture.port.receiveInteractionRequest(fixture.channel);
    assert.equal(request.duplicate, false);
    await withinStage(assert.rejects(fixture.port.replyToInteractionRequest({ task_id: fixture.taskId, request_id: 'request-lost-ack',
      decision: 'accept', answers: { 'Continue?': 'yes' } }, fixture.channel)), 'lost interaction ACK rejection', 30_000)
      .catch(error => { throw new Error(`lost interaction ACK path failed; pid=${fixture.child.pid}; stderr=${fixture.workerStderr()}`, { cause: error }); });
    await withinStage(new Promise(resolve => fixture.child.exitCode !== null ? resolve() : fixture.child.once('exit', resolve)), 'lost interaction Worker exit', 30_000)
      .catch(error => { throw new Error(`lost interaction Worker exit failed; pid=${fixture.child.pid}; stderr=${fixture.workerStderr()}`, { cause: error }); });
    const before = fixture.store.readSnapshot().events.filter(event => event.operation_id === fixture.operationId
      && event.event_type.startsWith('interaction_'));
    assert.deepEqual(before.map(event => event.event_type), [
      'interaction_requested', 'interaction_reply_intent', 'interaction_reply_prepared', 'interaction_reply_committed',
    ]);
    fixture.store.close();
    const reopened = IsolatedAdmissionStore.open(fixture.r);
    const port = createSqliteLifecyclePort(reopened);
    try {
      assert.equal(port.readInteractionRequest(fixture.taskId, 'request-lost-ack').state, 'unknown');
      await assert.rejects(port.replyToInteractionRequest({ task_id: fixture.taskId, request_id: 'request-lost-ack',
        decision: 'accept', answers: { 'Continue?': 'yes' } }, fixture.channel), error => error.code === 'interaction_reply_outcome_unknown');
      const operation = reopened.readOperation(fixture.operationId);
      const result = { task_id: fixture.taskId, attempt: 1, status: 'completed', summary: 'must not commit', files_changed: [],
        tests: [], issues: [], needs_master_decision: false, zcode_output: '', exit_code: 0, session_id: null,
        started_at: '2026-10-25T00:00:00.000Z', finished_at: '2026-10-25T00:00:01.000Z' };
      assert.throws(() => reopened.commitResult({ operation_id: fixture.operationId, task_id: fixture.taskId, attempt: 1,
        generation: operation.generation, revision: operation.revision, claim_id: operation.claim_id,
        claim_worker_identity_digest: operation.claim_worker_identity_digest, result_status: 'completed', result }),
      error => error.code === 'interaction_reply_outcome_unknown');
      assert.deepEqual(reopened.readSnapshot().events.filter(event => event.operation_id === fixture.operationId
        && event.event_type.startsWith('interaction_')).map(event => event.event_type), before.map(event => event.event_type));
    } finally { reopened.close(); }
  } finally {
    if (fixture.child.exitCode === null) { fixture.child.kill(); await new Promise(resolve => fixture.child.once('exit', resolve)); }
    try { fixture.store.close(); } catch {}
  }
});

test('claim-only Worker consumes its identity-bound interaction channel before returning a synthetic result', async t => {
  const fixture = makeCandidateStore('interaction-worker-main', 1);
  const taskId = 'interaction-worker-main-task';
  const operationId = 'interaction-worker-main-operation';
  let child;
  let childExited;
  let childClosed;
  let stage = 'fixture setup';
  try {
    fixture.store.createTask(task(taskId, fixture.workspace));
    const admitted = fixture.store.admitOperation({ operation_id: operationId, task_id: taskId, attempt: 1,
      workspace_ref: fixture.workspace }, gates);
    const launch = { operation_id: operationId, task_id: taskId, attempt: 1, generation: admitted.generation,
      revision: admitted.revision, launch_id: 'interaction-worker-main-launch', launch_epoch: 1,
      launch_token: 'interaction-worker-main-token-0123456789' };
    const policy = { operation_id: operationId, task_id: taskId, attempt: 1, generation: admitted.generation,
      workspace_ref: fixture.workspace, authorization_source: 'trusted_local_policy', policy_revision: 'synthetic-policy-v1',
      policy_digest: 'b'.repeat(64), execution_profile_id: 'local-build-v1' };
    const { createLaunchBootstrap, deriveAdmissionPolicySnapshotDigest, encodeLaunchBootstrap } = await import('../../../dist-test/src/sqlite-candidate/wp6b2b1/launch-bootstrap.js');
    const { fingerprintRuntimeArtifact } = await import('../../../dist/src/runtime/build-provenance.js');
    const { spawnClaimOnlyWorker } = await import('../../../dist-test/src/manager/spawn-worker.js');
    const workerPath = path.resolve(process.cwd(), 'dist-test/src/worker/worker-main.js');
    const provenance = { bridge: { path: null, sha256: null }, worker: fingerprintRuntimeArtifact(workerPath) };
    const intent = fixture.store.createLaunchIntent(launch);
    child = spawnClaimOnlyWorker(workerPath, provenance,
      { interactionChannel: true });
    childExited = new Promise(resolve => child.once('exit', (...args) => resolve(args)));
    childClosed = new Promise(resolve => child.once('close', (...args) => resolve(args)));
    const workerStderr = [];
    child.stderr?.on('data', chunk => workerStderr.push(Buffer.from(chunk)));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const bootstrap = createLaunchBootstrap({ ...launch, policy_snapshot: { ...policy,
      policy_snapshot_digest: deriveAdmissionPolicySnapshotDigest(policy) } });
    stage = 'bootstrap delivery';
    child.bootstrapChannel.end(encodeLaunchBootstrap(bootstrap));
    stage = 'identity report';
    const reportBytes = await withinStage(readSingleLineFrame(child.reportChannel, 8_192), 'identity report').catch(error => {
        throw new Error(`identity report stream failed; pid=${child.pid}; exit=${child.exitCode}; signal=${child.signalCode}; stderr=${Buffer.concat(workerStderr).toString('utf8')}`,
          { cause: error });
      });
    assert.ok(reportBytes.length > 0, `claim-only Worker emitted no identity report; stderr=${Buffer.concat(workerStderr).toString('utf8')}`);
    const report = JSON.parse(reportBytes.subarray(0, -1).toString('utf8'));
    assert.equal(report.process_id, child.pid);
    const probe = createPlatformProbe();
    const observed = await probe.identityOf(child.pid);
    assert.equal(observed.fingerprint_precision, 'exact');
    assert.equal(observed.fingerprint, report.start_fingerprint);
    const receipt = fixture.store.recordLaunchReceipt({ ...launch, revision: intent.revision, receipt_id: 'interaction-worker-main-receipt',
      launch_identity: { source: 'synthetic_fixture', fixture: true, process_id: child.pid, start_fingerprint: observed.fingerprint } });
    fixture.store.commitPermanentClaim({ ...launch, revision: receipt.revision, claim_id: 'interaction-worker-main-claim',
      worker_identity: { source: 'synthetic_fixture', fixture: true, worker_id: report.worker_id, incarnation: 'worker-main-incarnation',
        process_id: child.pid, start_fingerprint: observed.fingerprint } });
    stage = 'claim decision and interaction bind';
    const execution = { protocol: 'bridge-sqlite-execution-envelope-v1', operation_id: operationId, task_id: taskId,
      attempt: 1, generation: admitted.generation, workspace_ref: fixture.workspace,
      policy_snapshot_digest: bootstrap.policy_snapshot_digest, execution_profile_id: policy.execution_profile_id,
      adapter_mode: 'test_fake', task: task(taskId, fixture.workspace),
      host_profile: { name: 'synthetic-interaction-fixture', settingsDirectory: fixture.r },
      continuation: null, previous_result: null };
    child.decisionChannel.end(Buffer.from(`${JSON.stringify({ protocol: 'bridge-claim-decision-v1', state: 'claim_committed', execution })}\n`));
    const operation = fixture.store.readOperation(operationId);
    const port = createSqliteLifecyclePort(fixture.store);
    const channel = await port.openInteractionChannel(child, operation, async ({ child: current, expected }) => {
      const identity = await probe.identityOf(current.pid);
      return identity.fingerprint_precision === 'exact' && identity.fingerprint === expected.start_fingerprint
        ? { state: 'verified', process_id: identity.pid, start_fingerprint: identity.fingerprint } : false;
    });
    stage = 'interaction request';
    const received = await withinStage(port.receiveInteractionRequest(channel), 'interaction request').catch(async error => {
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 2_000))]);
      }
      throw new Error(`interaction request failed; pid=${child.pid}; exit=${child.exitCode}; signal=${child.signalCode}; stderr=${Buffer.concat(workerStderr).toString('utf8')}`,
        { cause: error });
    });
    assert.equal(received.request.method, 'interaction/requestUserInput');
    stage = 'persisted reply and worker acknowledgement';
    const answer = await withinStage(port.replyToInteractionRequest({ task_id: taskId, request_id: received.request.request_id,
      decision: 'accept', answers: { 'Synthetic interaction response': 'approved by synthetic fixture' } }, channel), 'interaction reply').catch(error => {
      throw new Error(`interaction reply failed; pid=${child.pid}; exit=${child.exitCode}; signal=${child.signalCode}; stderr=${Buffer.concat(workerStderr).toString('utf8')}`,
        { cause: error });
    });
    assert.equal(answer.state, 'answered');
    const resultBytes = await withinStage(readStreamToEnd(child.resultChannel, 16_384), 'synthetic result').catch(error => {
      throw new Error(`synthetic result failed; pid=${child.pid}; exit=${child.exitCode}; signal=${child.signalCode}; stderr=${Buffer.concat(workerStderr).toString('utf8')}`,
        { cause: error });
    });
    const result = JSON.parse(resultBytes.subarray(0, -1).toString('utf8'));
    assert.equal(result.protocol, 'bridge-sqlite-candidate-result-v1');
    assert.equal(result.operation_id, operationId);
    assert.equal(result.result.status, 'completed');
    // The Manager owns the peer endpoints. Once the Worker result proves it
    // has no further Interaction requests, close the reply writer and readers
    // before waiting for the Worker process to exit.
    child.stdio[8]?.end();
    child.stdio[7]?.destroy();
    child.stdio[9]?.destroy();
    const [exitCode] = await withinStage(childExited, 'Worker exit').catch(error => {
      throw new Error(`Worker exit failed; pid=${child.pid}; exit=${child.exitCode}; signal=${child.signalCode}; stderr=${Buffer.concat(workerStderr).toString('utf8')}`,
        { cause: error });
    });
    assert.equal(exitCode, 0);
    await withinStage(childClosed, 'Worker stdio close');
    const interactionEvents = fixture.store.readLifecycleEvents(operationId).filter(event => event.event_type.startsWith('interaction_'));
    assert.deepEqual(interactionEvents.map(event => event.event_type), ['interaction_requested', 'interaction_reply_intent',
      'interaction_reply_prepared', 'interaction_reply_committed', 'interaction_reply_accepted']);
    const acceptedEvidence = JSON.parse(interactionEvents.at(-1).evidence_json);
    assert.equal(acceptedEvidence.request_id, received.request.request_id);
    assert.equal(acceptedEvidence.reply_id, answer.reply_id);
    assert.equal(acceptedEvidence.answer_digest, answer.answer_digest);
    assert.equal(acceptedEvidence.claim_id, 'interaction-worker-main-claim');
    assert.equal(acceptedEvidence.worker_identity_digest, fixture.store.readOperation(operationId).claim_worker_identity_digest);
    assert.match(acceptedEvidence.ack_digest, /^[0-9a-f]{64}$/u);
    assert.match(acceptedEvidence.commit_digest, /^[0-9a-f]{64}$/u);
  } catch (error) {
    throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      preserveTemp = true;
      const closed = childClosed ?? new Promise(resolve => child.once('close', resolve));
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) preserveTemp = true;
    }
    fixture.store.close();
  }
});

test('Continue rejects cancellation, active execution, stale fences, and unreleased prior Attempts without projection changes', async () => {
  const cancelled = makeCandidateStore('continue-cancelled');
  try {
    const prior = makePriorAttempt(cancelled.store, 'continue-cancelled-task', cancelled.workspace, 'cancelled');
    const before = cancelled.store.readSnapshot();
    assert.throws(() => cancelled.port.createNextAttempt(continueInput(prior, 'continue-cancelled-key'), gates),
      error => error.code === 'continue_cancelled_not_supported');
    assert.equal(cancelled.store.readTaskProjection(prior.task_id).current_attempt, 1);
    assert.equal(cancelled.store.readSnapshot().events.length, before.events.length);
  } finally { cancelled.store.close(); }

  const unreleased = makeCandidateStore('continue-unreleased');
  try {
    const prior = makePriorAttempt(unreleased.store, 'continue-unreleased-task', unreleased.workspace, 'completed', false);
    const before = unreleased.store.readSnapshot();
    assert.throws(() => unreleased.port.createNextAttempt(continueInput(prior, 'continue-unreleased-key'), gates),
      error => error.code === 'continue_prior_not_released');
    assert.equal(unreleased.store.readTaskProjection(prior.task_id).current_attempt, 1);
    assert.equal(unreleased.store.readSnapshot().events.length, before.events.length);
  } finally { unreleased.store.close(); }

  const running = makeCandidateStore('continue-running');
  try {
    const taskId = 'continue-running-task';
    running.store.createTask(task(taskId, running.workspace));
    const admitted = running.store.admitOperation({ operation_id: 'continue-running-op', task_id: taskId, attempt: 1, workspace_ref: running.workspace }, gates);
    const launch = { operation_id: admitted.operation_id, task_id: taskId, attempt: 1, generation: admitted.generation,
      revision: admitted.revision, launch_id: 'continue-running-launch', launch_epoch: 1, launch_token: 'continue-running-token-0123456789' };
    const intent = running.store.createLaunchIntent(launch);
    const receipt = running.store.recordLaunchReceipt({ ...launch, revision: intent.revision, receipt_id: 'continue-running-receipt',
      launch_identity: { source: 'synthetic_fixture', fixture: true, process_id: 42222, start_fingerprint: 'continue-running-start' } });
    const claim = running.store.commitPermanentClaim({ ...launch, revision: receipt.revision, claim_id: 'continue-running-claim',
      worker_identity: { source: 'synthetic_fixture', fixture: true, worker_id: 'continue-running-worker', incarnation: 'continue-running-incarnation',
        process_id: 42222, start_fingerprint: 'continue-running-start' } });
    const op = running.store.readOperation(admitted.operation_id);
    const request = { operation_id: 'continue-running-key', task_id: taskId, previous_attempt: 1, previous_operation_id: op.operation_id,
      expected_generation: op.generation, expected_revision: op.revision, claim_id: claim.claim_id,
      claim_worker_identity_digest: op.claim_worker_identity_digest, feedback: 'continue running task' };
    assert.throws(() => running.port.createNextAttempt(request, gates), error => error.code === 'continue_status_not_eligible');
    assert.equal(running.store.readTaskProjection(taskId).current_attempt, 1);
    assert.equal(running.store.readTaskProjection(taskId).status, 'running');
  } finally { running.store.close(); }

  const stale = makeCandidateStore('continue-stale');
  try {
    const prior = makePriorAttempt(stale.store, 'continue-stale-task', stale.workspace);
    const request = continueInput(prior, 'continue-stale-key');
    request.expected_revision -= 1;
    assert.throws(() => stale.port.createNextAttempt(request, gates), error => error.code === 'stale_continue_cas');
    assert.equal(stale.store.readTaskProjection(prior.task_id).current_attempt, 1);
  } finally { stale.store.close(); }
});

test('Continue operation key binds the canonical request and rejects changed payload or a second key on stale prior state', async () => {
  const fixture = makeCandidateStore('continue-key-conflict');
  try {
    const prior = makePriorAttempt(fixture.store, 'continue-key-conflict-task', fixture.workspace);
    const request = continueInput(prior, 'continue-key-bound');
    fixture.port.createNextAttempt(request, gates);
    assert.throws(() => fixture.port.createNextAttempt({ ...request, feedback: 'different feedback' }, gates),
      error => error.code === 'continue_operation_conflict');
    assert.throws(() => fixture.port.createNextAttempt({ ...request, operation_id: 'continue-second-key' }, gates),
      error => error.code === 'stale_continue_cas');
    assert.equal(fixture.store.readTaskProjection(prior.task_id).current_attempt, 2);
    assert.equal(fixture.store.readSnapshot().operations.filter(row => row.task_id === prior.task_id).length, 1);
  } finally { fixture.store.close(); }
});

test('Continue persists a queued Attempt without reserving Capacity while another Operation occupies the slot', () => {
  const fixture = makeCandidateStore('continue-capacity-queue', 1);
  try {
    const prior = makePriorAttempt(fixture.store, 'continue-capacity-task', fixture.workspace);
    const otherTaskId = 'continue-capacity-other-task';
    fixture.store.createTask(task(otherTaskId, fixture.workspace));
    const occupied = fixture.store.admitOperation({ operation_id: 'continue-capacity-occupied', task_id: otherTaskId, attempt: 1, workspace_ref: fixture.workspace }, gates);
    const queued = fixture.port.createNextAttempt(continueInput(prior, 'continue-capacity-key'), gates);
    assert.equal(queued.status, 'queued');
    assert.equal(fixture.store.readTaskProjection(prior.task_id).current_attempt, 2);
    assert.equal(fixture.store.readAttempt(prior.task_id, 2).generation, null);
    assert.equal(fixture.store.readTaskLifecycle(prior.task_id).operation, null);
    assert.equal(fixture.store.readOperation(occupied.operation_id).phase, 'reserved');
    assert.throws(() => fixture.store.admitOperation({ operation_id: 'continue-capacity-next-op', task_id: prior.task_id, attempt: 2,
      workspace_ref: fixture.workspace }, gates), error => error.code === 'capacity_exhausted');
    assert.equal(fixture.store.readTaskProjection(prior.task_id).current_attempt, 2);
  } finally { fixture.store.close(); }
});

test('concurrent independent processes using one Continue key persist only one queued Attempt', async () => {
  const fixture = makeCandidateStore('continue-concurrent-key');
  try {
    const prior = makePriorAttempt(fixture.store, 'continue-concurrent-task', fixture.workspace);
    const request = continueInput(prior, 'continue-concurrent-idempotency-key');
    const storeUrl = new URL('../../../src/sqlite-candidate/wp6b2b1/store.mjs', import.meta.url).href;
    const script = `import {IsolatedAdmissionStore} from ${JSON.stringify(storeUrl)};
      const store=IsolatedAdmissionStore.open(${JSON.stringify(fixture.r)});
      try { const out=store.createNextAttempt(${JSON.stringify(request)}, {
        workspaceValidator:()=>({state:'allow'}), executionPermissionCheck:()=>({state:'allow'}) });
        process.stdout.write(JSON.stringify({ok:true,out}));
      } catch(error) { process.stdout.write(JSON.stringify({ok:false,code:error?.code??'unknown'})); }
      finally { store.close(); }`;
    fixture.store.close();
    const runChild = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0) return reject(new Error(`continue child exit ${code}: ${stderr}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`invalid continue child output: ${stdout}; ${stderr}`)); }
      });
    });
    const outcomes = await Promise.all([runChild(), runChild()]);
    assert.ok(outcomes.some(outcome => outcome.ok));
    assert.ok(outcomes.every(outcome => outcome.ok || outcome.code === 'root_writer_busy'));
    const verify = IsolatedAdmissionStore.open(fixture.r);
    try {
      const retry = verify.createNextAttempt(request, gates);
      assert.equal(retry.duplicate, true);
      assert.equal(verify.readTaskProjection(request.task_id).current_attempt, 2);
      const db = new DatabaseSync(path.join(fixture.r, 'operations.sqlite3'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND continuation_operation_id=?').get(request.task_id, request.operation_id).n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM manager_operations WHERE task_id=? AND operation_kind='attempt_lifecycle'").get(request.task_id).n, 1);
      } finally { db.close(); }
    } finally { verify.close(); }
  } finally { try { fixture.store.close(); } catch {} }
});

test('Task and initial Attempt creation roll back together on a known transaction failure', async () => {
  const { IsolatedAdmissionStore } = await importedStore();
  const r = root('task-create-rollback');
  const workspace = path.join(TEMP, 'workspace-rollback');
  mkdirSync(workspace, { recursive: true });
  IsolatedAdmissionStore.initialize(r).close();
  const store = IsolatedAdmissionStore.open(r, { fault: 'after_projection' });
  try {
    assert.throws(() => store.createTask(task('rollback-task', workspace)), error => error.code === 'injected_failure');
  } finally { store.close(); }
  const verify = IsolatedAdmissionStore.open(r);
  try {
    assert.equal(verify.readTask('rollback-task'), null);
    assert.equal(verify.readAttempt('rollback-task', 1), null);
  } finally { verify.close(); }
});

test('Schema v7 is rejected without automatic migration', async () => {
  const { IsolatedAdmissionStore } = await importedStore();
  const r = root('reject-schema-v7');
  IsolatedAdmissionStore.initialize(r).close();
  const db = new DatabaseSync(path.join(r, 'operations.sqlite3'));
  try { db.exec('PRAGMA user_version=7'); } finally { db.close(); }
  assert.throws(() => IsolatedAdmissionStore.open(r), error => error.code === 'schema_version_unknown');
  const verify = new DatabaseSync(path.join(r, 'operations.sqlite3'), { readOnly: true });
  try { assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 7); }
  finally { verify.close(); }
  assert.throws(() => IsolatedAdmissionStore.openForRecovery(r), error => error.code === 'schema_version_unknown');
});

test('Spoofed sqlite_sequence rows fail closed in writable and read-only validation', async () => {
  const { IsolatedAdmissionStore } = await importedStore();
  const r = root('reject-sequence-spoof');
  IsolatedAdmissionStore.initialize(r).close();
  const db = new DatabaseSync(path.join(r, 'operations.sqlite3'));
  try { db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('unrelated_user_table',9)").run(); }
  finally { db.close(); }
  assert.throws(() => IsolatedAdmissionStore.open(r), error => error.code === 'event_cursor_invalid');
  const recovery = IsolatedAdmissionStore.openForRecovery(r);
  try {
    const snapshot = recovery.readRecoverySnapshot();
    assert.equal(snapshot.root_status, 'quarantined_read_only');
    assert.equal(snapshot.verified_event_projection_consistency, false);
    assert.ok(snapshot.root_blockers.includes('event_cursor_invalid'));
  } finally { recovery.close(); }
});

test('Task event cursor is durable, task-scoped, and spans successive Attempt Operations', async () => {
  const { IsolatedAdmissionStore } = await importedStore();
  const r = root('task-event-cursor');
  const ws = path.join(TEMP, 'workspace-event-cursor');
  mkdirSync(ws, { recursive: true });
  let store = IsolatedAdmissionStore.initialize(r);
  store.createTask(task('cursor-task', ws), '2026-10-23T00:00:00.000Z');
  store.createTask(task('unrelated-cursor-task', ws), '2026-10-23T00:00:00.000Z');
  store.provisionCapacity({ operation_id: 'cursor-policy', capacity_limit: 3, expected_generation: 0,
    maintenance: { dispatch_blocked: true, writers_drained: true } });
  store.admitOperation({ operation_id: 'cursor-op-a1', task_id: 'cursor-task', attempt: 1, workspace_ref: ws }, gates);
  store.close();

  // Synthetic Continue-shaped projection only: Continue behavior itself is not implemented here.
  const db = new DatabaseSync(path.join(r, 'operations.sqlite3'));
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE tasks SET current_attempt=2,status='queued' WHERE task_id='cursor-task'").run();
    db.prepare("INSERT INTO attempts(task_id,attempt,generation,status,created_at) VALUES('cursor-task',2,NULL,'queued','2026-10-23T00:00:01.000Z')").run();
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }

  store = IsolatedAdmissionStore.open(r);
  try {
    store.admitOperation({ operation_id: 'cursor-op-a2', task_id: 'cursor-task', attempt: 2, workspace_ref: ws }, gates);
    store.admitOperation({ operation_id: 'cursor-op-other', task_id: 'unrelated-cursor-task', attempt: 1, workspace_ref: ws }, gates);
    const eventsPage = store.readTaskEvents('cursor-task', { limit: 2 });
    const events = eventsPage.events;
    assert.deepEqual(events.map(event => event.operation_id), ['cursor-op-a1', 'cursor-op-a2']);
    assert.deepEqual(events.map(event => event.operation_attempt), [1, 2]);
    assert.ok(events[1].cursor > events[0].cursor);
    assert.deepEqual(events.map(event => event.sequence), events.map(event => event.cursor));
    assert.deepEqual(events.map(event => event.operation_sequence), [1, 1]);
    assert.deepEqual(events.map(event => event.cursor), [2, 3]);
    assert.equal(eventsPage.hasMore, false, 'a full page with no following task event is not marked as having more');
    assert.equal(eventsPage.nextCursor, events[1].cursor);
    const firstPage = store.readTaskEvents('cursor-task', { limit: 1 });
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextCursor, firstPage.events[0].cursor);
    assert.deepEqual(firstPage.events.map(event => [event.sequence,event.operation_sequence]), [[2,1]]);
    const resumed = store.readTaskEvents('cursor-task', { afterCursor: firstPage.nextCursor, limit: 1 });
    assert.deepEqual(resumed.events.map(event => [event.operation_id,event.sequence,event.operation_sequence]), [['cursor-op-a2',3,1]]);
    assert.equal(resumed.hasMore, false);
    assert.equal(resumed.nextCursor, 3);
    const empty = store.readTaskEvents('cursor-task', { afterCursor: 100, limit: 1 });
    assert.deepEqual(empty, { events: [], nextCursor: 100, hasMore: false });
    assert.equal(store.readTaskEvents('unrelated-cursor-task').events.length, 1);
  } finally { store.close(); }

  const reopened = IsolatedAdmissionStore.open(r);
  try {
    const resumed = reopened.readTaskEvents('cursor-task', { afterCursor: 2 });
    assert.deepEqual(resumed.events.map(event => [event.operation_id, event.sequence, event.operation_sequence]), [['cursor-op-a2', 3, 1]]);
    assert.equal(resumed.nextCursor, 3);
    assert.equal(resumed.hasMore, false);
  } finally { reopened.close(); }
  const recovery = IsolatedAdmissionStore.openForRecovery(r);
  try {
    const snapshot = recovery.readRecoverySnapshot();
    assert.equal(snapshot.root_status, 'consistent_read_only');
    assert.equal(snapshot.events.every(event => Number.isSafeInteger(event.event_cursor) && event.event_cursor > 0), true);
  } finally { recovery.close(); }
});

test('Event cursor allocation rolls back atomically and unknown commit leaves one poisoned event', async () => {
  const { IsolatedAdmissionStore } = await importedStore();
  const ws = path.join(TEMP, 'workspace-event-commit');
  mkdirSync(ws, { recursive: true });
  const rollbackRoot = root('event-cursor-rollback');
  let store = IsolatedAdmissionStore.initialize(rollbackRoot);
  store.close();
  store = IsolatedAdmissionStore.open(rollbackRoot, { fault: 'after_event_insert' });
  assert.throws(() => store.provisionCapacity({ operation_id: 'rollback-policy', capacity_limit: 1, expected_generation: 0,
    maintenance: { dispatch_blocked: true, writers_drained: true } }), error => error.code === 'injected_failure');
  store.close();
  store = IsolatedAdmissionStore.open(rollbackRoot);
  try {
    const committed = store.provisionCapacity({ operation_id: 'rollback-policy', capacity_limit: 1, expected_generation: 0,
      maintenance: { dispatch_blocked: true, writers_drained: true } });
    assert.equal(committed.generation, 1);
  } finally { store.close(); }
  let verify = new DatabaseSync(path.join(rollbackRoot, 'operations.sqlite3'), { readOnly: true });
  try { assert.deepEqual(verify.prepare('SELECT event_cursor FROM manager_operation_events').all().map(row => row.event_cursor), [1]); }
  finally { verify.close(); }

  const unknownRoot = root('event-cursor-unknown-commit');
  store = IsolatedAdmissionStore.initialize(unknownRoot);
  store.createTask(task('unknown-cursor-task', ws));
  store.provisionCapacity({ operation_id: 'unknown-cursor-policy', capacity_limit: 1, expected_generation: 0,
    maintenance: { dispatch_blocked: true, writers_drained: true } });
  store.close();
  store = IsolatedAdmissionStore.open(unknownRoot, { fault: 'commit_ack_lost' });
  assert.throws(() => store.admitOperation({ operation_id: 'unknown-cursor-op', task_id: 'unknown-cursor-task', attempt: 1, workspace_ref: ws }, gates),
    error => error.code === 'transaction_outcome_unknown');
  store.close();
  verify = new DatabaseSync(path.join(unknownRoot, 'operations.sqlite3'), { readOnly: true });
  try {
    assert.deepEqual(verify.prepare("SELECT event_cursor,operation_id FROM manager_operation_events WHERE operation_id='unknown-cursor-op'").all()
      .map(row => [row.event_cursor, row.operation_id]), [[2, 'unknown-cursor-op']]);
  } finally { verify.close(); }
  assert.throws(() => IsolatedAdmissionStore.open(unknownRoot), error => error.code === 'root_poisoned');
});

test('Lifecycle Port exposes only read-only C3 Recovery while rejecting recovery mutations', async () => {
  const { IsolatedAdmissionStore } = await importedStore();
  assert.throws(() => createSqliteLifecyclePort({}), /IsolatedAdmissionStore required/u);
  const r = root('port-surface');
  const workspace = path.join(TEMP, 'workspace-port');
  mkdirSync(workspace, { recursive: true });
  const store = IsolatedAdmissionStore.initialize(r);
  const port = createSqliteLifecyclePort(store);
  try {
    assert.equal(Object.isFrozen(port), true);
    assert.equal(port.createTask(task('port-task', workspace)).task_id, 'port-task');
    port.provisionCapacity({ operation_id: 'policy-port', capacity_limit: 1, expected_generation: 0,
      maintenance: { dispatch_blocked: true, writers_drained: true } });
    const admitted = port.admitOperation({ operation_id: 'op-port', task_id: 'port-task', attempt: 1, workspace_ref: workspace }, gates);
    assert.equal(admitted.generation, 1);
    assert.equal(port.readAttempt('port-task', 1).generation, 1);
    const launch = {
      operation_id: admitted.operation_id, task_id: 'port-task', attempt: 1, generation: admitted.generation,
      revision: admitted.revision, launch_id: 'launch-port', launch_epoch: 1,
      launch_token: 'synthetic-port-token-with-entropy-123',
    };
    const intent = port.createLaunchIntent(launch);
    const receipt = port.recordLaunchReceipt({
      ...launch, revision: intent.revision, receipt_id: 'receipt-port',
      launch_identity: { source: 'synthetic_fixture', fixture: true, process_id: 43210, start_fingerprint: 'port-start' },
    });
    const claim = port.commitPermanentClaim({
      ...launch, revision: receipt.revision, claim_id: 'claim-port',
      worker_identity: { source: 'synthetic_fixture', fixture: true, worker_id: 'port-worker', incarnation: 'port-worker-incarnation', process_id: 43210, start_fingerprint: 'port-start' },
    });
    assert.equal(claim.phase, 'running');
    assert.equal(port.readTaskProjection('port-task').status, 'running');
    assert.equal(port.readAttempt('port-task', 1).status, 'running');
    assert.equal(port.readOperation('op-port').phase, 'running');
    assert.deepEqual(port.readTaskLifecycle('port-task').operation, port.readOperation('op-port'));
    assert.equal(typeof port.readRecoverySnapshot, 'function');
    assert.throws(() => port.readRecoverySnapshot(), error => error.code === 'recovery_read_only');
    assert.equal(typeof port.createNextAttempt, 'function');
    for (const operation of ['appendLifecycleEvent', 'readLifecycleStatus', 'writeLifecycleStatus',
      'recoverOperation']) {
      assert.throws(() => port[operation](), error => error instanceof UnsupportedLifecycleOperationError
        && error.code === 'lifecycle_operation_unsupported' && error.operation === operation);
    }
    assert.deepEqual(port.readLifecycleEvents('op-port').map(event => event.event_type), ['reserved','launch_intent','launch_receipt','claim_committed']);
    const taskEventPage = port.readTaskEvents('port-task', { limit: 200 });
    const taskEvents = taskEventPage.events;
    assert.deepEqual(taskEvents.map(event => event.event_type), ['reserved','launch_intent','launch_receipt','claim_committed']);
    assert.equal(new Set(taskEvents.map(event => event.cursor)).size, taskEvents.length);
    assert.ok(taskEvents.every((event, index) => index === 0 || event.cursor > taskEvents[index - 1].cursor));
    assert.ok(taskEvents.every(event => event.task_id === 'port-task' && event.operation_id === 'op-port' && event.operation_attempt === 1));
    assert.equal(taskEventPage.hasMore, false);
    assert.equal(taskEventPage.nextCursor, taskEvents.at(-1).cursor);
    assert.deepEqual(port.readTaskEvents('port-task', { afterCursor: taskEvents[1].cursor, limit: 2 }).events.map(event => event.cursor),
      taskEvents.slice(2, 4).map(event => event.cursor));
    assert.throws(() => port.readTaskEvents('missing-task'), error => error.code === 'task_not_found');
    assert.throws(() => port.readTaskEvents('port-task', { afterCursor: Number.MAX_SAFE_INTEGER + 1 }), error => error.code === 'invalid_event_read');
    assert.equal(port.readCommittedResult('op-port'), null);
    assert.equal(typeof port.commitResult, 'function');
    assert.equal(typeof port.beginCleanup, 'function');
    assert.equal(typeof port.recordCleanupEvidence, 'function');
    assert.equal(typeof port.releaseCapacity, 'function');
    assert.equal(typeof port.requestCancellation, 'function');
    assert.equal(typeof port.recordCancellationVerification, 'function');
    assert.throws(() => store.rebuildRecoveryState(), error => error.code === 'recovery_read_only');
    assert.equal(existsSync(path.join(r, 'ROOT_POISONED.json')), false);
  } finally { store.close(); }
});

test('unsupported WP6C methods do not mutate the SQLite lifecycle projection', async () => {
  const { IsolatedAdmissionStore } = await importedStore();
  const r = root('unsupported-noop');
  const workspace = path.join(TEMP, 'workspace-unsupported');
  mkdirSync(workspace, { recursive: true });
  const store = IsolatedAdmissionStore.initialize(r);
  const port = createSqliteLifecyclePort(store);
  try {
    port.createTask(task('unsupported-task', workspace));
    port.provisionCapacity({ operation_id: 'policy-unsupported', capacity_limit: 1, expected_generation: 0,
      maintenance: { dispatch_blocked: true, writers_drained: true } });
    const admission = port.admitOperation({ operation_id: 'op-unsupported', task_id: 'unsupported-task', attempt: 1, workspace_ref: workspace }, gates);
    const before = store.readSnapshot();
    assert.throws(()=>port.requestCancellation({operation_id:admission.operation_id,task_id:'unsupported-task',attempt:1,
      generation:admission.generation,revision:admission.revision,claim_id:'no-claim',claim_worker_identity_digest:'a'.repeat(64),
      worker_identity:{source:'synthetic_fixture',fixture:true,worker_id:'none',incarnation:'none',process_id:43211,start_fingerprint:'none'}},{}),
      error=>error.code==='cancellation_claim_mismatch');
    assert.throws(() => port.appendLifecycleEvent({}), UnsupportedLifecycleOperationError);
    assert.throws(() => port.writeLifecycleStatus({}), UnsupportedLifecycleOperationError);
    assert.throws(() => port.beginCleanup({}), error => error.code === 'invalid_cleanup_request');
    assert.throws(() => port.recordCleanupEvidence({}), error => error.code === 'invalid_cleanup_request');
    assert.throws(() => port.releaseCapacity({}), error => error.code === 'invalid_release_request');
    const after = store.readSnapshot();
    assert.equal(after.operations.find(row => row.operation_id === admission.operation_id).phase, 'reserved');
    assert.deepEqual(after.events, before.events);
    assert.equal(store.readTaskProjection('unsupported-task').status, 'queued');
    assert.equal(store.readAttempt('unsupported-task', 1).status, 'queued');
    assert.deepEqual(port.readLifecycleEvents(admission.operation_id).map(event => event.event_type), ['reserved']);
    assert.equal(port.readCommittedResult(admission.operation_id), null);
  } finally { store.close(); }
});

test('candidate Port has no production JSON Store or Adapter dependency', () => {
  for (const relative of [
    '../../../src/sqlite-candidate/wp6b2b1/lifecycle-port.mjs',
    '../../../src/sqlite-candidate/wp6b2b1/store.mjs',
  ]) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /store\/task-store|BridgeTaskManager|zcode-adapter|run-task/u, relative);
  }
});
