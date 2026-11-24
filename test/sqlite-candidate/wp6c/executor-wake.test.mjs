import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedAdmissionStore, AdmissionError, digest } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const TEMP=process.env.WP6C_TEST_TEMP_ROOT
  ?path.resolve(process.env.WP6C_TEST_TEMP_ROOT)
  :path.resolve(HERE,'../../../src/sqlite-candidate/wp6b2b1',`test-temp-wp6c-wake-${process.pid}`);
mkdirSync(TEMP,{recursive:true});
let serial=0;
const stores=new Set();
const OWNER_THREAD_ID='019c0000-0000-7000-8000-000000000001';

function root(label){
  const value=path.join(TEMP,`${label}-${++serial}`);
  mkdirSync(value,{recursive:true});
  return value;
}

function failWith(fn,code){
  assert.throws(fn,error=>error instanceof AdmissionError&&error.code===code);
}

function makeReleased(label='wake',admission){
  const dataRoot=root(label);
  const workspace=path.join(TEMP,`workspace-${label}-${serial}`);
  mkdirSync(workspace,{recursive:true});
  const store=IsolatedAdmissionStore.initialize(dataRoot);
  stores.add(store);
  const taskId=`task-${label}`;
  const operationId=`operation-${label}`;
  const launchId=`launch-${label}`;
  store.provisionCapacity({operation_id:`policy-${label}`,capacity_limit:2,expected_generation:0,
    maintenance:{dispatch_blocked:true,writers_drained:true}});
  store.createTask({task_id:taskId,workspace,objective:'synthetic Executor Wake lifecycle fixture',
    requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]},
    admission??'2026-11-22T00:00:00.000Z');
  const allow=()=>({state:'allow',fixture:true});
  const admitted=store.admitOperation({operation_id:operationId,task_id:taskId,attempt:1,workspace_ref:workspace},
    {workspaceValidator:allow,executionPermissionCheck:allow});
  const launch={operation_id:operationId,task_id:taskId,attempt:1,generation:admitted.generation,
    revision:admitted.revision,launch_id:launchId,launch_epoch:1,launch_token:`synthetic-wake-token-${label}-012345`};
  const intent=store.createLaunchIntent(launch);
  const processId=44000+serial;
  const receipt=store.recordLaunchReceipt({...launch,revision:intent.revision,receipt_id:`receipt-${label}`,
    launch_identity:{source:'synthetic_fixture',fixture:true,process_id:processId,start_fingerprint:`start-${label}`}});
  store.commitPermanentClaim({...launch,revision:receipt.revision,claim_id:`claim-${label}`,
    worker_identity:{source:'synthetic_fixture',fixture:true,worker_id:`worker-${label}`,
      incarnation:`incarnation-${label}`,process_id:processId,start_fingerprint:`start-${label}`}});
  const operation=store.readOperation(operationId);
  const result={task_id:taskId,attempt:1,status:'completed',summary:'synthetic wake result',files_changed:[],tests:[],
    issues:[],needs_master_decision:false,zcode_output:'',exit_code:0,session_id:null,
    started_at:'2026-11-22T00:00:00.000Z',finished_at:'2026-11-22T00:00:01.000Z'};
  store.commitResult({operation_id:operationId,task_id:taskId,attempt:1,generation:admitted.generation,
    revision:operation.revision,claim_id:operation.claim_id,
    claim_worker_identity_digest:operation.claim_worker_identity_digest,result_status:'completed',result});
  const claimed=store.readOperation(operationId);
  const fence={operation_id:operationId,task_id:taskId,attempt:1,generation:claimed.generation,
    revision:claimed.revision,claim_id:claimed.claim_id,claim_worker_identity_digest:claimed.claim_worker_identity_digest};
  const pending=store.beginCleanup(fence);
  const cleanupEvidence={source:'synthetic_fixture',fixture:true,operation_id:operationId,task_id:taskId,attempt:1,
    generation:claimed.generation,claim_id:claimed.claim_id,worker_identity_digest:claimed.claim_worker_identity_digest,
    launch_receipt_digest:claimed.launch_receipt_digest,result_commit_ref:claimed.result_commit_ref,
    process_tree_digest:digest({root:processId,children:[]}),resources_digest:digest({resources:[]}),
    root_process_id:processId,root_start_fingerprint:`start-${label}`,worker_tree_complete:true,
    operation_resources_complete:true,workspace_touched:false};
  const verified=store.recordCleanupEvidence({...fence,revision:pending.revision,outcome:'verified',
    cleanup_evidence:cleanupEvidence});
  const releaseRequest={...fence,revision:verified.revision,cleanup_digest:verified.cleanup_digest};
  const released=store.releaseCapacity(releaseRequest);
  return {dataRoot,store,workspace,ref:{task_id:taskId,operation_id:operationId,attempt:1,
    generation:claimed.generation,revision:released.revision},releaseRequest,cleanupRevision:verified.revision};
}

function wakeInput(ref,state,overrides={}){
  return {operation_id:ref.operation_id,task_id:ref.task_id,attempt:ref.attempt,generation:ref.generation,
    state,thread_id:OWNER_THREAD_ID,delivery_id:digest({
      contract:'executor-wake-delivery-v1',task_id:ref.task_id,attempt:ref.attempt,
      operation_id:ref.operation_id,result_digest:'result-bound-by-store',
    }),policy_digest:digest({policy:'test-v1',model:'flash',provider:'deepseek',effort:'low'}),
    authorization_digest:digest({authorization:'explicit-one-turn',revision:1}),
    reason_code:'loaded_idle_exact_config',...overrides};
}

function wakeEvents(store,operationId){
  return store.readLifecycleEvents(operationId).filter(event=>event.event_type==='observation_recorded'
    &&JSON.parse(event.evidence_json).reason==='executor_wake');
}

after(()=>{
  for(const store of stores){
    try{store.close();}catch{}
  }
});

test('Wake intent, Queue acknowledgement, and observed Turn are bounded release facts',()=>{
  const f=makeReleased('sequence');
  try{
    const before=f.store.readTaskLifecycle(f.ref.task_id);
    const intent=f.store.recordExecutorWakeObservation(wakeInput(f.ref,'intent'));
    const queued=f.store.recordExecutorWakeObservation(wakeInput(f.ref,'queued',{
      queue_message_id:'019c0000-0000-7000-8000-000000000099',
    }));
    const turn=f.store.recordExecutorWakeObservation(wakeInput(f.ref,'turn_started'));
    assert.equal(intent.event_sequence,f.cleanupRevision+2);
    assert.equal(queued.event_sequence,intent.event_sequence+1);
    assert.equal(turn.event_sequence,queued.event_sequence+1);
    assert.equal(intent.desktop_visible,'UNKNOWN');
    assert.deepEqual(wakeEvents(f.store,f.ref.operation_id).map(event=>JSON.parse(event.evidence_json).state),
      ['intent','queued','turn_started']);
    assert.equal(JSON.parse(wakeEvents(f.store,f.ref.operation_id)[1].evidence_json).queue_message_id,
      '019c0000-0000-7000-8000-000000000099');
    const after=f.store.readTaskLifecycle(f.ref.task_id);
    assert.deepEqual(after.result,before.result);
    assert.equal(after.projection.status,'completed');
    assert.equal(after.operation.phase,'released');
    assert.equal(f.store.readSnapshot().operations.find(operation=>operation.operation_id===f.ref.operation_id).capacity_slot,1);
    assert.equal(f.store.readTaskEvents(f.ref.task_id,{afterCursor:0,limit:200}).events
      .filter(event=>JSON.parse(event.evidence_json).reason==='executor_wake').length,3);
  }finally{
    f.store.close();
    stores.delete(f.store);
  }
  const reopened=IsolatedAdmissionStore.open(f.dataRoot);
  stores.add(reopened);
  assert.equal(wakeEvents(reopened,f.ref.operation_id).length,3);
  reopened.close();
  stores.delete(reopened);
  const recovery=IsolatedAdmissionStore.openForRecovery(f.dataRoot);
  try{
    const snapshot=recovery.readRecoverySnapshot();
    const operation=snapshot.operations.find(value=>value.operation_id===f.ref.operation_id);
    assert.equal(snapshot.root_status,'consistent_read_only');
    assert.equal(operation.recovery_decision,'complete');
    assert.equal(operation.capacity_occupied,false);
    assert.equal(operation.cleanup_state,'verified');
  }finally{
    recovery.close();
  }
});

test('Wake duplicate is idempotent while conflicting evidence and ACK states fail closed',()=>{
  const f=makeReleased('conflict');
  try{
    const intent=wakeInput(f.ref,'intent');
    const first=f.store.recordExecutorWakeObservation(intent);
    const duplicate=f.store.recordExecutorWakeObservation({...intent});
    assert.equal(duplicate.duplicate,true);
    assert.equal(duplicate.event_sequence,first.event_sequence);
    assert.equal(wakeEvents(f.store,f.ref.operation_id).length,1);
    failWith(()=>f.store.recordExecutorWakeObservation({...intent,reason_code:'different_binding'}),
      'executor_wake_observation_conflict');
    f.store.recordExecutorWakeObservation(wakeInput(f.ref,'queued'));
    failWith(()=>f.store.recordExecutorWakeObservation(wakeInput(f.ref,'submission_unknown')),
      'executor_wake_ack_transition_invalid');
    failWith(()=>f.store.recordExecutorWakeObservation(wakeInput(f.ref,'queued',{reason_code:'second_ack'})),
      'executor_wake_observation_conflict');
    assert.equal(wakeEvents(f.store,f.ref.operation_id).length,2);
  }finally{
    f.store.close();
    stores.delete(f.store);
  }
});

test('Web Notify fallback needs no Thread binding and is terminal for one delivery',()=>{
  const f=makeReleased('fallback');
  try{
    const fallback=wakeInput(f.ref,'web_notify',{thread_id:null,reason_code:'app_server_unavailable'});
    const first=f.store.recordExecutorWakeObservation(fallback);
    const duplicate=f.store.recordExecutorWakeObservation(fallback);
    assert.equal(first.duplicate,false);
    assert.equal(duplicate.duplicate,true);
    assert.equal(JSON.parse(wakeEvents(f.store,f.ref.operation_id)[0].evidence_json).thread_id,null);
    failWith(()=>f.store.recordExecutorWakeObservation(wakeInput(f.ref,'intent')),
      'executor_wake_intent_not_first');
    failWith(()=>f.store.recordExecutorWakeObservation(wakeInput(f.ref,'web_notify',{
      thread_id:null,reason_code:'second_fallback',delivery_id:'a'.repeat(64),
    })),'executor_wake_delivery_conflict');
  }finally{
    f.store.close();
    stores.delete(f.store);
  }
});

test('Late Wake Compensation is a separate auditable fact and never rewrites web_notify',()=>{
  const f=makeReleased('late-compensation',{owner_thread_id:OWNER_THREAD_ID,source:'mcp_meta'});
  try{
    const fallback=wakeInput(f.ref,'web_notify',{reason_code:'owner_thread_unavailable'});
    f.store.recordExecutorWakeObservation(fallback);
    const before=f.store.readTaskLifecycle(f.ref.task_id);
    const compensationDelivery=digest({contract:'late-wake-compensation-v1',operation_id:f.ref.operation_id});
    const intent=wakeInput(f.ref,'intent',{delivery_id:compensationDelivery,reason_code:'late_wake_compensation_intent'});
    const first=f.store.recordLateWakeCompensation(intent);
    const queued=f.store.recordLateWakeCompensation({...intent,state:'queued',reason_code:'queue_command_accepted',
      queue_message_id:'019c0000-0000-7000-8000-000000000099'});
    assert.equal(first.duplicate,false);
    assert.equal(queued.state,'queued');
    const after=f.store.readTaskLifecycle(f.ref.task_id);
    assert.deepEqual(after.result,before.result);
    assert.equal(after.projection.status,before.projection.status);
    assert.equal(after.attempt.attempt,before.attempt.attempt);
    assert.equal(after.attempt.status,before.attempt.status);
    assert.equal(after.operation.claim_worker_identity_json,before.operation.claim_worker_identity_json);
    assert.equal(after.operation.phase,'released');
    const events=f.store.readLifecycleEvents(f.ref.operation_id)
      .filter(event=>event.event_type==='observation_recorded')
      .map(event=>JSON.parse(event.evidence_json));
    assert.deepEqual(events.map(event=>event.state),['web_notify','intent','queued']);
    assert.equal(events[0].reason,'executor_wake');
    assert.equal(events[1].reason,'executor_late_wake_compensation');
    assert.equal(events[2].queue_message_id,'019c0000-0000-7000-8000-000000000099');
    failWith(()=>f.store.recordExecutorWakeObservation(wakeInput(f.ref,'queued',{
      delivery_id:fallback.delivery_id,reason_code:'rewrite_attempt',
    })),'executor_wake_ack_transition_invalid');
    failWith(()=>f.store.recordLateWakeCompensation({...intent,state:'intent',reason_code:'second_intent',
      delivery_id:digest({contract:'late-wake-compensation-v2',operation_id:f.ref.operation_id})}),
      'late_wake_intent_not_first');
  }finally{
    f.store.close();
    stores.delete(f.store);
  }
  const reopened=IsolatedAdmissionStore.open(f.dataRoot);
  try{
    assert.equal(reopened.readTaskLifecycle(f.ref.task_id).operation.phase,'released');
    assert.equal(reopened.readLifecycleEvents(f.ref.operation_id)
      .filter(event=>JSON.parse(event.evidence_json).reason==='executor_late_wake_compensation').length,2);
  }finally{
    reopened.close();
  }
});

test('Queue acknowledgement remains durable before an unverified Turn falls back to Web visibility',()=>{
  const f=makeReleased('ack-fallback');
  try{
    f.store.recordExecutorWakeObservation(wakeInput(f.ref,'intent'));
    f.store.recordExecutorWakeObservation(wakeInput(f.ref,'queued',{
      queue_message_id:'019c0000-0000-7000-8000-000000000099',
    }));
    f.store.recordExecutorWakeObservation(wakeInput(f.ref,'web_notify',{
      reason_code:'trusted_local_turn_start_unverified',
    }));
    const events=wakeEvents(f.store,f.ref.operation_id).map(event=>JSON.parse(event.evidence_json));
    assert.deepEqual(events.map(event=>event.state),['intent','queued','web_notify']);
    assert.equal(events[1].queue_message_id,'019c0000-0000-7000-8000-000000000099');
    assert.equal(f.store.readTaskLifecycle(f.ref.task_id).operation.phase,'released');
    failWith(()=>f.store.recordExecutorWakeObservation(wakeInput(f.ref,'intent',{
      queue_message_id:'019c0000-0000-7000-8000-000000000098',
    })),'invalid_executor_wake_request');
  }finally{
    f.store.close();
    stores.delete(f.store);
  }
});

test('later Wake revisions do not break Release retry or Continue history',()=>{
  const f=makeReleased('compatibility');
  try{
    f.store.recordExecutorWakeObservation(wakeInput(f.ref,'intent'));
    const duplicate=f.store.releaseCapacity(f.releaseRequest);
    assert.equal(duplicate.duplicate,true);
    assert.equal(duplicate.phase,'released');
    const current=f.store.readOperation(f.ref.operation_id);
    const currentRevisionRetry=f.store.releaseCapacity({...f.releaseRequest,revision:current.revision});
    assert.equal(currentRevisionRetry.duplicate,true);
    const continuation=f.store.createNextAttempt({operation_id:'continue-after-wake',task_id:f.ref.task_id,
      previous_attempt:1,previous_operation_id:f.ref.operation_id,expected_generation:f.ref.generation,
      expected_revision:f.cleanupRevision+1,claim_id:f.releaseRequest.claim_id,
      claim_worker_identity_digest:f.releaseRequest.claim_worker_identity_digest,
      feedback:'continue after a wake fact',additional_requirements:[]},
    {workspaceValidator:()=>({state:'allow',fixture:true}),executionPermissionCheck:()=>({state:'allow',fixture:true})});
    assert.equal(continuation.attempt,2);
    assert.equal(f.store.readTaskProjection(f.ref.task_id).current_attempt,2);
  }finally{
    f.store.close();
    stores.delete(f.store);
  }
  const reopened=IsolatedAdmissionStore.open(f.dataRoot);
  try{
    const continued=reopened.readTaskLifecycle(f.ref.task_id).continuation;
    assert.equal(continued.previous_revision,f.cleanupRevision+1);
    assert.equal(wakeEvents(reopened,f.ref.operation_id).length,1);
  }finally{
    reopened.close();
  }
});
