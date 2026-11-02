import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedAdmissionStore, AdmissionError, digest } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';
import { createSqliteLifecyclePort } from '../../../src/sqlite-candidate/wp6b2b1/lifecycle-port.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const TEMP=process.env.WP6C_TEST_TEMP_ROOT?path.resolve(process.env.WP6C_TEST_TEMP_ROOT)
  :path.resolve(HERE,'../../../src/sqlite-candidate/wp6b2b1',`test-temp-wp6c-1-${process.pid}`);
mkdirSync(TEMP,{recursive:true});
let serial=0;
const openStores=new Set();
function root(label='result'){const p=path.join(TEMP,`${label}-${++serial}`);mkdirSync(p,{recursive:true});return p;}
function child(mode,r,payload={},fault){return new Promise((resolve,reject)=>{
  const args=[path.join(HERE,'../wp6b2b1/lifecycle-process.mjs'),mode,r,JSON.stringify(payload)];if(fault)args.push(fault);
  const p=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let out='',err='';
  p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);
  p.on('close',code=>{try{resolve({code,out:JSON.parse(out),err});}catch(e){reject(new Error(`child output parse failed: ${out}; stderr=${err}; ${e}`));}});
});}
function capture(fn,code){assert.throws(fn,e=>e instanceof AdmissionError&&e.code===code);}
function makeRunning(label='running',{intentOnly=false,reservedOnly=false}={}){
  const r=root(label);const s=IsolatedAdmissionStore.initialize(r);openStores.add(s);
  const taskPackage={task_id:'task-result',workspace:path.join(TEMP,'workspace'),objective:'synthetic WP6C result fixture',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]};
  s.createTask(taskPackage,'2026-10-23T00:00:00.000Z');
  s.provisionCapacity({operation_id:'policy-result',capacity_limit:2,expected_generation:0,maintenance:{dispatch_blocked:true,writers_drained:true}});
  const workspace=path.join(TEMP,'workspace');mkdirSync(workspace,{recursive:true});
  const allow=()=>({state:'allow',fixture:true});
  const admitted=s.admitOperation({operation_id:'operation-result',task_id:'task-result',attempt:1,workspace_ref:workspace},{workspaceValidator:allow,executionPermissionCheck:allow});
  if(reservedOnly)return {root:r,store:s,request:null};
  const launch={operation_id:admitted.operation_id,task_id:'task-result',attempt:1,generation:admitted.generation,revision:admitted.revision,
    launch_id:'launch-result',launch_epoch:1,launch_token:'synthetic-result-token-0123456789'};
  s.createLaunchIntent(launch);
  const intent={...launch,revision:admitted.revision+1};
  if(intentOnly)return {root:r,store:s,request:null};
  const receipt={...intent,revision:intent.revision,receipt_id:'receipt-result',launch_identity:{source:'synthetic_fixture',fixture:true,process_id:41001,start_fingerprint:'synthetic-start-result'}};
  s.recordLaunchReceipt(receipt);
  const claim={...intent,revision:intent.revision+1,claim_id:'claim-result',worker_identity:{source:'synthetic_fixture',fixture:true,worker_id:'worker-result',incarnation:'incarnation-result',process_id:41001,start_fingerprint:'synthetic-start-result'}};
  s.commitPermanentClaim(claim);
  const operation=s.readOperation('operation-result');
  const request={operation_id:operation.operation_id,task_id:operation.task_id,attempt:operation.attempt,generation:operation.generation,
    revision:operation.revision,claim_id:operation.claim_id,claim_worker_identity_digest:operation.claim_worker_identity_digest,
    result_status:'completed',result:resultPayload('completed')};
  return {root:r,store:s,request};
}
function resultPayload(status='completed',overrides={}){return {task_id:'task-result',attempt:1,status,summary:'synthetic result',files_changed:[],tests:[],issues:[],
  needs_master_decision:status==='waiting_for_master',zcode_output:'synthetic output',exit_code:status==='failed'?1:0,session_id:null,
  started_at:'2026-10-23T00:00:00.000Z',finished_at:'2026-10-23T00:00:01.000Z',...overrides};}
function readRows(r){const db=new DatabaseSync(path.join(r,'operations.sqlite3'),{readOnly:true});try{return{
  operation:db.prepare("SELECT * FROM manager_operations WHERE operation_id='operation-result'").get(),
  task:db.prepare("SELECT * FROM tasks WHERE task_id='task-result'").get(),
  attempt:db.prepare("SELECT * FROM attempts WHERE task_id='task-result' AND attempt=1").get(),
  events:db.prepare("SELECT * FROM manager_operation_events WHERE operation_id='operation-result' ORDER BY sequence").all(),
  active:db.prepare("SELECT COUNT(*) AS n FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase<>'released'").get().n,
};}finally{db.close();}}
function resultDigest(request){return digest({result_contract_version:1,result_status:request.result_status,result:request.result});}
function cancellationFixture(store){
  const operation=store.readOperation('operation-result');
  const workerIdentity=JSON.parse(operation.claim_worker_identity_json);
  const identityEvidence={source:'synthetic_manager_probe',operation_id:operation.operation_id,task_id:operation.task_id,
    attempt:operation.attempt,generation:operation.generation,worker_identity_digest:operation.claim_worker_identity_digest,
    process_id:workerIdentity.process_id,start_fingerprint:workerIdentity.start_fingerprint,state:'alive'};
  const cancellationEvidence={source:'synthetic_tree_verifier',operation_id:operation.operation_id,task_id:operation.task_id,
    attempt:operation.attempt,generation:operation.generation,claim_id:operation.claim_id,
    worker_identity_digest:operation.claim_worker_identity_digest,process_tree:[{pid:workerIdentity.process_id,start:workerIdentity.start_fingerprint}],
    root_process_id:workerIdentity.process_id,root_start_fingerprint:workerIdentity.start_fingerprint,worker_tree_complete:true};
  const port=createSqliteLifecyclePort(store,{
    workerIdentityVerifier:({operation:o,worker_identity,evidence})=>evidence?.operation_id===o.operation_id
      &&evidence?.task_id===o.task_id&&evidence?.attempt===o.attempt&&evidence?.generation===o.generation
      &&evidence?.worker_identity_digest===o.claim_worker_identity_digest&&evidence?.process_id===worker_identity.process_id
      &&evidence?.start_fingerprint===worker_identity.start_fingerprint
      ?{state:evidence.state,worker_identity_digest:o.claim_worker_identity_digest,evidence_digest:digest(evidence)}:false,
    cancellationVerifier:({operation:o,cancel_intent,worker_identity,evidence})=>evidence?.operation_id===o.operation_id
      &&evidence?.task_id===o.task_id&&evidence?.attempt===o.attempt&&evidence?.generation===o.generation
      &&evidence?.claim_id===o.claim_id&&evidence?.worker_identity_digest===o.claim_worker_identity_digest
      &&evidence?.root_process_id===worker_identity.process_id&&evidence?.root_start_fingerprint===worker_identity.start_fingerprint
      &&evidence?.worker_tree_complete===true&&cancel_intent?.cancel_id===evidence?.cancel_id
      ?{state:'verified',worker_identity_digest:o.claim_worker_identity_digest,process_tree_digest:digest(evidence.process_tree),
        root_process_id:evidence.root_process_id,root_start_fingerprint:evidence.root_start_fingerprint,worker_tree_complete:true,
        evidence_digest:digest(evidence)}:false,
  });
  return {operation,workerIdentity,identityEvidence,cancellationEvidence,port,
    fence(revision=store.readOperation(operation.operation_id).revision){const current=store.readOperation(operation.operation_id);return {
      operation_id:current.operation_id,task_id:current.task_id,attempt:current.attempt,generation:current.generation,revision,
      claim_id:current.claim_id,claim_worker_identity_digest:current.claim_worker_identity_digest,worker_identity:workerIdentity,
    };}};
}
function cleanupFence(store,request){
  const o=store.readOperation(request.operation_id);
  return {operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,revision:o.revision,
    claim_id:o.claim_id,claim_worker_identity_digest:o.claim_worker_identity_digest};
}
function verifiedCleanupEvidence(store,request){
  const o=store.readOperation(request.operation_id);
  return {source:'synthetic_fixture',fixture:true,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
    claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,launch_receipt_digest:o.launch_receipt_digest,result_commit_ref:o.result_commit_ref,
    process_tree_digest:digest({root:41001,start:'synthetic-start-result',children:[]}),resources_digest:digest({operation:o.operation_id,resources:[]}),
    root_process_id:41001,root_start_fingerprint:'synthetic-start-result',worker_tree_complete:true,operation_resources_complete:true,workspace_touched:false};
}
function recoveryEvidence(input){return {source:input.evidence_source,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,
  generation:input.generation,claim_id:input.claim_id,worker_identity_digest:input.worker_identity_digest,observation:'unknown'}};
function recoveryInput(store,{classification='hold',reason_code='cleanup_identity_unknown',evidence_source='manager_process_probe',evidence}={}){
  const o=store.readOperation('operation-result'),ev=evidence??{source:evidence_source,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,
    generation:o.generation,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,observation:'unknown'};
  return {input:{operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,expected_revision:o.revision,claim_id:o.claim_id,
    worker_identity_digest:o.claim_worker_identity_digest,classification,reason_code,evidence_source,evidence_digest:digest(ev)},evidence:ev};
}
function verifiedRecoveryPort(store){return createSqliteLifecyclePort(store,{recoveryEvidenceVerifier:({operation,observation,evidence})=>{
  const valid=evidence?.source===observation.evidence_source&&evidence?.operation_id===operation.operation_id&&evidence?.task_id===operation.task_id
    &&evidence?.attempt===operation.attempt&&evidence?.generation===operation.generation&&evidence?.claim_id===operation.claim_id
    &&evidence?.worker_identity_digest===operation.worker_identity_digest&&observation.evidence_digest===digest(evidence)
    &&(observation.classification==='hold'?observation.reason_code!=='operation_projection_conflict':observation.reason_code==='operation_projection_conflict');
  return valid?{classification:observation.classification,reason_code:observation.reason_code,evidence_source:observation.evidence_source,evidence_digest:observation.evidence_digest}:false;
}});}
async function retryBusyResult(r,request){
  let latest;
  for(let i=0;i<8;i++){
    latest=await child('result',r,request);
    if(latest.out.ok||latest.out.code!=='root_writer_busy')return latest;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  return latest;
}
function recoveryChild(rootPath,input,evidence){
  const storeUrl=new URL('../../../src/sqlite-candidate/wp6b2b1/store.mjs',import.meta.url).href;
  const portUrl=new URL('../../../src/sqlite-candidate/wp6b2b1/lifecycle-port.mjs',import.meta.url).href;
  const code=`import {IsolatedAdmissionStore,digest} from ${JSON.stringify(storeUrl)};import {createSqliteLifecyclePort} from ${JSON.stringify(portUrl)};`+
    `const root=process.argv[1],input=JSON.parse(process.argv[2]),evidence=JSON.parse(process.argv[3]);const s=IsolatedAdmissionStore.open(root);`+
    `try{const p=createSqliteLifecyclePort(s,{recoveryEvidenceVerifier:({operation,observation,evidence})=>{const valid=evidence.source===observation.evidence_source`+
    `&&evidence.operation_id===operation.operation_id&&evidence.task_id===operation.task_id&&evidence.attempt===operation.attempt`+
    `&&evidence.generation===operation.generation&&evidence.claim_id===operation.claim_id&&evidence.worker_identity_digest===operation.worker_identity_digest`+
    `&&observation.evidence_digest===digest(evidence);return valid?{classification:observation.classification,reason_code:observation.reason_code,`+
    `evidence_source:observation.evidence_source,evidence_digest:observation.evidence_digest}:false}});const out=p.recordRecoveryObservation(input,evidence);console.log(JSON.stringify({ok:true,out}));}`+
    `catch(e){console.log(JSON.stringify({ok:false,code:e?.code??'unknown'}));}finally{s.close()}`;
  return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,rootPath,JSON.stringify(input),JSON.stringify(evidence)],
    {stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);
    p.on('close',code=>{try{resolve({exitCode:code,result:JSON.parse(out),stderr:err});}catch(e){reject(new Error(`recovery child output invalid: ${out}; stderr=${err}; ${e}`));}});});
}
after(()=>{for(const store of openStores){try{store.close();}catch{}}rmSync(TEMP,{recursive:true,force:true});});

test('Result, terminal Attempt projection, and one Event commit atomically',()=>{
  const {root:r,store,request}=makeRunning();
  const committed=store.commitResult(request);assert.equal(committed.phase,'result_committed');assert.equal(committed.result_digest,resultDigest(request));
  const rows=readRows(r);assert.equal(rows.operation.phase,'result_committed');assert.equal(rows.operation.revision,request.revision+1);
  assert.equal(rows.operation.result_generation,request.generation);assert.deepEqual(JSON.parse(rows.operation.result_json),request.result);
  assert.equal(rows.attempt.status,'completed');assert.equal(rows.task.status,'completed');assert.equal(rows.events.filter(x=>x.event_type==='result_committed').length,1);
  const event=rows.events.at(-1),evidence=JSON.parse(event.evidence_json);
  assert.equal(event.operation_id,request.operation_id);assert.equal(event.generation,request.generation);
  assert.equal(event.sequence,rows.operation.revision);assert.equal(event.to_phase,rows.operation.phase);
  assert.equal(evidence.claim_id,request.claim_id);assert.equal(evidence.worker_identity_digest,request.claim_worker_identity_digest);
  assert.equal(evidence.outcome,request.result_status);assert.equal(evidence.result_digest,committed.result_digest);
  assert.equal(evidence.result_commit_ref,committed.result_commit_ref);assert.equal(Object.hasOwn(evidence,'result'),false);
  store.close();
});

test('all four OD-7 Result statuses persist without merging status or releasing capacity',()=>{
  for(const status of ['completed','failed','cancelled','waiting_for_master']){
    const {root:r,store,request}=makeRunning(`status-${status}`);
    let cancellation;
    if(status==='cancelled'){
      cancellation=cancellationFixture(store);const intent=cancellation.port.requestCancellation(cancellation.fence(),cancellation.identityEvidence);
      const verification=cancellation.port.recordCancellationVerification(cancellation.fence(intent.revision),
        {...cancellation.cancellationEvidence,cancel_id:intent.cancel_id});
      cancellation={...cancellation,verification};
    }
    const input={...request,...(cancellation?{revision:cancellation.verification.revision,cancel_verification_digest:cancellation.verification.cancellation_verification_digest}:{}),
      result_status:status,result:resultPayload(status)};
    const committed=store.commitResult(input);
    assert.equal(committed.result_status,status);
    assert.equal(committed.phase,'result_committed');
    const rows=readRows(r);
    assert.equal(rows.operation.result_status,status);
    assert.equal(rows.attempt.status,status);
    assert.equal(rows.task.status,status);
    const resultEvents=rows.events.filter(x=>x.event_type==='result_committed');
    assert.equal(resultEvents.length,1);
    assert.equal(JSON.parse(resultEvents[0].evidence_json).outcome,status);
    assert.equal(resultEvents[0].generation,input.generation);
    assert.equal(resultEvents[0].sequence,committed.revision);
    assert.equal(store.readLifecycleEvents(input.operation_id,{afterSequence:committed.revision-1,limit:1}).length,1);
    assert.equal(store.readCommittedResult(input.operation_id).result.status,status);
    assert.deepEqual(store.readTaskLifecycle(input.task_id).result,input.result);
    assert.equal(store.readTaskLifecycle(input.task_id).operation.operation_id,input.operation_id);
    assert.equal(store.readAttempt(input.task_id,2),null);
    assert.equal(store.readSnapshot().capacity.capacity_limit,2);
    assert.equal(store.readOperation(input.operation_id).phase,'result_committed');
    store.close();
  }
});

test('running cancellation persists exact Worker identity, is idempotent, and binds verified tree before cancelled Result',()=>{
  const {root:r,store,request}=makeRunning('cancel-running'),cancel=cancellationFixture(store);
  const before=readRows(r);const rejected={...cancel.fence(),worker_identity:{...cancel.workerIdentity,process_id:41002}};
  assert.throws(()=>cancel.port.requestCancellation(rejected,cancel.identityEvidence),e=>e instanceof AdmissionError&&e.code==='cancellation_worker_identity_mismatch');
  assert.deepEqual(readRows(r).events,before.events);
  const intent=cancel.port.requestCancellation(cancel.fence(),cancel.identityEvidence);
  assert.equal(intent.duplicate,false);assert.equal(intent.phase,'running');assert.equal(intent.revision,cancel.operation.revision+1);
  const duplicate=cancel.port.requestCancellation(cancel.fence(intent.revision),cancel.identityEvidence);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.cancel_id,intent.cancel_id);
  assert.equal(readRows(r).events.filter(e=>JSON.parse(e.evidence_json).reason==='cancel_requested').length,1);
  const verification=cancel.port.recordCancellationVerification(cancel.fence(intent.revision),
    {...cancel.cancellationEvidence,cancel_id:intent.cancel_id});
  assert.equal(verification.phase,'running');assert.equal(verification.revision,intent.revision+1);
  const retry=cancel.port.recordCancellationVerification(cancel.fence(verification.revision),
    {...cancel.cancellationEvidence,cancel_id:intent.cancel_id});
  assert.equal(retry.duplicate,true);assert.equal(retry.cancellation_verification_digest,verification.cancellation_verification_digest);
  const input={...request,revision:verification.revision,result_status:'cancelled',result:resultPayload('cancelled'),
    cancel_verification_digest:verification.cancellation_verification_digest};
  const committed=store.commitResult(input);assert.equal(committed.result_status,'cancelled');
  const rows=readRows(r);assert.equal(rows.task.status,'cancelled');assert.equal(rows.attempt.status,'cancelled');assert.equal(rows.active,1);
  const resultEvent=rows.events.find(e=>e.event_type==='result_committed');
  assert.equal(JSON.parse(resultEvent.evidence_json).cancel_verification_digest,verification.cancellation_verification_digest);
  const cleanup=cleanupFence(store,input),pending=store.beginCleanup(cleanup),unverified=store.recordCleanupEvidence({...cleanup,
    revision:pending.revision,outcome:'unverified',probe_state:'unknown',reason:'synthetic_cancel_cleanup_unknown'});
  assert.equal(unverified.phase,'cleanup_unverified');assert.equal(readRows(r).active,1);
  assert.throws(()=>store.releaseCapacity({...cleanup,revision:unverified.revision,cleanup_digest:'f'.repeat(64)}),
    e=>e instanceof AdmissionError&&e.code==='cleanup_not_verified');
  assert.equal(readRows(r).active,1);store.close();
  const reopened=IsolatedAdmissionStore.open(r);assert.equal(reopened.readOperation('operation-result').phase,'cleanup_unverified');reopened.close();
});

test('cancellation identity and tree verification fail closed; unverified cancellation cannot commit Result',()=>{
  const {root:r,store,request}=makeRunning('cancel-unverified');const cancel=cancellationFixture(store);
  const noIdentityVerifier=createSqliteLifecyclePort(store);
  assert.throws(()=>noIdentityVerifier.requestCancellation(cancel.fence(),cancel.identityEvidence),e=>e instanceof AdmissionError&&e.code==='cancellation_identity_verifier_required');
  const denied=createSqliteLifecyclePort(store,{workerIdentityVerifier:()=>false});
  assert.throws(()=>denied.requestCancellation(cancel.fence(),cancel.identityEvidence),e=>e instanceof AdmissionError&&e.code==='cancellation_identity_unknown');
  assert.equal(store.readOperation(request.operation_id).revision,cancel.operation.revision);
  const intent=cancel.port.requestCancellation(cancel.fence(),cancel.identityEvidence);
  const badEvidence={...cancel.cancellationEvidence,cancel_id:intent.cancel_id,root_process_id:41002};
  assert.throws(()=>cancel.port.recordCancellationVerification(cancel.fence(intent.revision),badEvidence),e=>e instanceof AdmissionError&&e.code==='cancellation_verification_unverified');
  assert.throws(()=>store.commitResult({...request,revision:intent.revision,result_status:'cancelled',result:resultPayload('cancelled'),cancel_verification_digest:'f'.repeat(64)}),
    e=>e instanceof AdmissionError&&e.code==='cancel_verification_required');
  assert.equal(store.readOperation(request.operation_id).phase,'running');assert.equal(readRows(r).active,1);store.close();
});

test('Result wins cancellation race and verified cancellation still requires Cleanup before Release',()=>{
  const {root:r,store,request}=makeRunning('cancel-result-race');const cancel=cancellationFixture(store);
  const intent=cancel.port.requestCancellation(cancel.fence(),cancel.identityEvidence);
  const completed=store.commitResult({...request,revision:intent.revision,result_status:'completed',result:resultPayload('completed')});
  assert.equal(completed.result_status,'completed');
  const cancellationLost=cancel.port.requestCancellation(cancel.fence(intent.revision),cancel.identityEvidence);
  assert.equal(cancellationLost.result_won,true);assert.equal(cancellationLost.result_status,'completed');
  const verification=cancel.port.recordCancellationVerification(cancel.fence(intent.revision),
    {...cancel.cancellationEvidence,cancel_id:intent.cancel_id});
  assert.equal(verification.result_won,true);assert.equal(store.readOperation(request.operation_id).result_status,'completed');
  const cleanup=cleanupFence(store,request);store.beginCleanup(cleanup);
  const pending=cleanupFence(store,request);store.recordCleanupEvidence({...pending,outcome:'unverified',probe_state:'unknown',reason:'synthetic_unknown'});
  const unverified=store.readOperation(request.operation_id);
  assert.equal(unverified.phase,'cleanup_unverified');assert.equal(readRows(r).active,1);
  assert.throws(()=>store.releaseCapacity({...pending,revision:unverified.revision,cleanup_digest:'f'.repeat(64)}),
    e=>e instanceof AdmissionError&&e.code==='cleanup_not_verified');
  assert.equal(readRows(r).active,1);store.close();
});

test('Result rejects status projection mismatches, unknown fields, and payloads over the byte limit',()=>{
  const {root:r,store,request}=makeRunning('invalid-result-boundaries');
  capture(()=>store.commitResult({...request,result_status:'cancelled',cancel_verification_digest:'f'.repeat(64)}),'invalid_result_payload');
  capture(()=>store.commitResult({...request,result:{...request.result,status:'failed'}}),'invalid_result_payload');
  capture(()=>store.commitResult({...request,result:{...request.result,unexpected:'field'}}),'invalid_result_payload');
  capture(()=>store.commitResult({...request,result:{...request.result,zcode_output:'x'.repeat(66000)}}),'result_too_large');
  assert.equal(store.readOperation(request.operation_id).phase,'running');
  assert.equal(readRows(r).events.filter(x=>x.event_type==='result_committed').length,0);
  store.close();
});

test('mid-transaction fault rolls back Result, Event, and Attempt projection together',()=>{
  const {root:r,store,request}=makeRunning();store.close();
  const faulty=IsolatedAdmissionStore.open(r,{fault:'after_projection'});
  capture(()=>faulty.commitResult(request),'injected_failure');faulty.close();
  const reopened=IsolatedAdmissionStore.open(r);const rows=readRows(r);
  assert.equal(rows.operation.phase,'running');assert.equal(rows.operation.result_digest,null);assert.equal(rows.attempt.status,'running');
  assert.equal(rows.events.filter(x=>x.event_type==='result_committed').length,0);reopened.close();
});

test('same Result Digest is idempotent across close/reopen with no duplicate Event',()=>{
  const {root:r,store,request}=makeRunning();const first=store.commitResult(request);store.close();
  const reopened=IsolatedAdmissionStore.open(r);const duplicate=reopened.commitResult(request);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.result_digest,first.result_digest);
  assert.equal(readRows(r).events.filter(x=>x.event_type==='result_committed').length,1);reopened.close();
});

test('Result canonicalization sorts object fields and preserves optional absence versus null',()=>{
  const {root:r,store,request}=makeRunning('result-canonicalization');
  const first=store.commitResult(request);
  const reordered={...request,result:Object.fromEntries(Object.entries(request.result).reverse())};
  const duplicate=store.commitResult(reordered);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.result_digest,first.result_digest);
  const withOptionalNull={...request,result:{...request.result,usage:null}};
  const conflict=store.commitResult(withOptionalNull);
  assert.equal(conflict.conflict,true);assert.equal(conflict.quarantined,true);
  const rows=readRows(r);assert.equal(rows.operation.result_digest,first.result_digest);
  assert.equal(rows.events.filter(x=>x.event_type==='result_committed').length,1);
  assert.equal(rows.events.filter(x=>x.event_type==='quarantined').length,1);store.close();
});

test('different Result Digest persists one bounded quarantine and preserves the original Result and capacity',()=>{
  const {root:r,store,request}=makeRunning();store.commitResult(request);
  const conflict={...request,result:resultPayload('completed',{summary:'conflicting result'})};
  const first=store.commitResult(conflict);assert.equal(first.quarantined,true);assert.equal(first.conflict,true);
  const second=store.commitResult(conflict);assert.equal(second.duplicate,true);assert.equal(second.conflict,true);
  const rows=readRows(r);assert.equal(rows.operation.result_digest,resultDigest(request));assert.equal(rows.operation.phase,'quarantined');
  assert.equal(rows.events.filter(x=>x.event_type==='result_committed').length,1);assert.equal(rows.events.filter(x=>x.event_type==='quarantined').length,1);
  assert.equal(rows.events.filter(x=>x.event_type==='quarantined')[0].evidence_json.includes('conflicting result'),false);
  assert.equal(store.readSnapshot().capacity.capacity_limit,2);assert.equal(store.readOperation(request.operation_id).phase,'quarantined');store.close();
});

test('stale Revision, wrong Generation, Attempt, or Claim cannot commit Result',()=>{
  const {store,request}=makeRunning();
  capture(()=>store.commitResult({...request,revision:request.revision-1}),'stale_result_cas');
  capture(()=>store.commitResult({...request,generation:request.generation+1}),'operation_identity_mismatch');
  capture(()=>store.commitResult({...request,attempt:request.attempt+1,result:{...request.result,attempt:request.attempt+1}}),'operation_identity_mismatch');
  capture(()=>store.commitResult({...request,claim_id:'claim-other'}),'result_claim_mismatch');
  capture(()=>store.commitResult({...request,claim_worker_identity_digest:'0'.repeat(64)}),'result_claim_mismatch');
  assert.equal(store.readOperation(request.operation_id).phase,'running');store.close();
});

test('two independent processes compete to commit one Result; winner is unique and loser conflicts',async()=>{
  const {root:r,store,request}=makeRunning('multi-process-result');store.close();
  const candidates=[request,{...request,result:resultPayload('completed',{summary:'other process result'})}];
  const results=await Promise.all(candidates.map(x=>retryBusyResult(r,x)));
  assert.ok(results.every(x=>x.out.ok),JSON.stringify(results));
  assert.equal(results.filter(x=>x.out.ok&&!x.out.result.conflict&&!x.out.result.duplicate).length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>x.out.ok&&x.out.result.conflict&&x.out.result.quarantined).length,1,JSON.stringify(results));
  const rows=readRows(r);assert.equal(rows.events.filter(x=>x.event_type==='result_committed').length,1);
  assert.equal(rows.events.filter(x=>x.event_type==='quarantined').length,1);assert.equal(rows.operation.phase,'quarantined');
});

test('commit acknowledgement loss is simulated, poisons writes, and Recovery reads the durable Digest',async()=>{
  const {root:r,store,request}=makeRunning('commit-ack-loss');store.close();
  const response=await child('result',r,request,'commit_ack_lost');
  assert.equal(response.code,2);assert.equal(response.out.code,'transaction_outcome_unknown');
  assert.throws(()=>IsolatedAdmissionStore.open(r),e=>e instanceof AdmissionError&&e.code==='root_poisoned');
  const recovery=IsolatedAdmissionStore.openForRecovery(r);
  const snapshot=recovery.rebuildRecoveryState();assert.equal(snapshot.root_status,'blocked_read_only');
  assert.ok(snapshot.root_blockers.includes('root_poisoned'));assert.ok(snapshot.root_blockers.includes('writer_intent_present_outcome_unknown'));
  const operation=snapshot.operations.find(x=>x.operation_id===request.operation_id);
  assert.equal(operation.result_digest,resultDigest(request));assert.equal(operation.phase,'result_committed');assert.equal(operation.capacity_occupied,true);
  assert.equal(operation.claim_permanent,true);capture(()=>recovery.commitResult(request),'recovery_read_only');recovery.close();
});

test('Recovery reconstructs missing Receipt, unknown OS identity, and unverified Cleanup conservatively',()=>{
  const missing=makeRunning('missing-receipt',{intentOnly:true});missing.store.close();
  const s=IsolatedAdmissionStore.openForRecovery(missing.root);const snap=s.rebuildRecoveryState();const op=snap.operations.find(x=>x.operation_id==='operation-result');
  assert.ok(op.recovery_blockers.includes('launch_outcome_unknown_receipt_missing'));assert.equal(op.capacity_occupied,true);s.close();

  const running=makeRunning('unknown-os-identity');running.store.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(running.root);const state=recovery.rebuildRecoveryState();const runningOp=state.operations.find(x=>x.operation_id==='operation-result');
  assert.ok(runningOp.recovery_blockers.includes('manager_os_identity_probe_required'));
  assert.ok(runningOp.recovery_blockers.includes('execution_result_unknown'));assert.ok(runningOp.recovery_blockers.includes('capacity_and_workspace_occupancy_retained'));
  assert.equal(runningOp.claim_permanent,true);assert.equal(runningOp.cleanup_state,'unknown');recovery.close();
});

test('Recovery Port reads a read-only snapshot and never spawns, retries, cleans, or releases',()=>{
  const {root:r,store,request}=makeRunning('recovery-read-only-port');store.commitResult(request);store.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(r),port=createSqliteLifecyclePort(recovery);
  try {
    const before=readRows(r),snapshot=port.readRecoverySnapshot(),after=readRows(r);
    const op=snapshot.operations.find(x=>x.operation_id===request.operation_id);
    assert.equal(snapshot.root_status,'consistent_read_only');assert.equal(snapshot.writes_allowed,false);
    assert.equal(snapshot.cleanup_performed,false);assert.equal(snapshot.claim_release_performed,false);assert.equal(snapshot.operation_release_performed,false);
    assert.equal(op.recovery_decision,'hold');assert.equal(op.cleanup_state,'unknown');assert.equal(op.capacity_occupied,true);
    assert.ok(op.recovery_blockers.includes('operation_cleanup_unverified'));
    assert.equal(op.phase,'result_committed');assert.equal(after.operation.phase,before.operation.phase);
    assert.equal(after.events.length,before.events.length);assert.equal(after.events.some(x=>x.event_type==='released'),false);
    assert.throws(()=>port.recoverOperation({operation_id:request.operation_id}),e=>e.code==='lifecycle_operation_unsupported');
    assert.throws(()=>recovery.commitResult(request),e=>e instanceof AdmissionError&&e.code==='recovery_read_only');
  } finally { recovery.close(); }
});

test('Recovery snapshot fence cannot commit stale Cleanup evidence after another writer advances Revision',()=>{
  const {root:r,store,request}=makeRunning('recovery-stale-fence');store.commitResult(request);store.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(r),port=createSqliteLifecyclePort(recovery);
  const snapshot=port.readRecoverySnapshot(),op=snapshot.operations.find(x=>x.operation_id===request.operation_id);
  const staleFence={operation_id:op.operation_id,task_id:op.task_id,attempt:op.attempt,generation:op.generation,revision:op.revision,
    claim_id:op.claim_id,claim_worker_identity_digest:op.claim_worker_identity_digest};
  recovery.close();
  const writer=IsolatedAdmissionStore.open(r);
  try {
    const pending=writer.beginCleanup(staleFence);assert.equal(pending.revision,staleFence.revision+1);
    assert.throws(()=>writer.recordCleanupEvidence({...staleFence,outcome:'verified',cleanup_evidence:verifiedCleanupEvidence(writer,request)}),
      e=>e instanceof AdmissionError&&e.code==='stale_cleanup_cas');
    const rows=readRows(r);assert.equal(rows.operation.phase,'cleanup_pending');
    assert.equal(rows.events.filter(x=>x.event_type==='cleanup_verified').length,0);
    assert.equal(rows.events.filter(x=>x.event_type==='released').length,0);
  } finally { writer.close(); }
});

test('committed Result does not prove Cleanup or release Claim/Capacity after restart',()=>{
  const {root:r,store,request}=makeRunning('result-cleanup-unknown');store.commitResult(request);store.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(r);const snap=recovery.rebuildRecoveryState();const op=snap.operations.find(x=>x.operation_id===request.operation_id);
  assert.ok(op.recovery_blockers.includes('operation_cleanup_unverified'));assert.equal(op.cleanup_state,'unknown');
  assert.equal(op.claim_permanent,true);assert.equal(op.capacity_occupied,true);assert.equal(op.phase,'result_committed');recovery.close();
});

test('event/projection conflict is quarantined read-only without repairing or releasing occupancy',()=>{
  const {root:r,store,request}=makeRunning('event-projection-conflict');store.commitResult(request);store.close();
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));
  try{db.exec('DROP TRIGGER events_no_update; DROP TRIGGER event_projection_binding; UPDATE manager_operation_events SET to_phase=\'running\' WHERE operation_id=\'operation-result\' AND event_type=\'result_committed\';')}
  finally{db.close();}
  const recovery=IsolatedAdmissionStore.openForRecovery(r);const snap=recovery.rebuildRecoveryState();const op=snap.operations.find(x=>x.operation_id===request.operation_id);
  assert.equal(snap.root_status,'quarantined_read_only');assert.equal(snap.verified_event_projection_consistency,false);
  assert.equal(op.recovery_decision,'quarantine_read_only');assert.equal(op.capacity_occupied,true);assert.equal(op.claim_permanent,true);
  assert.equal(readRows(r).operation.phase,'result_committed');recovery.close();
});

test('Recovery refuses old/unknown schema without rebuilding or migrating it',()=>{
  const {root:r,store}=makeRunning('unknown-schema');store.close();
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));try{db.exec('PRAGMA user_version=2')}finally{db.close();}
  assert.throws(()=>IsolatedAdmissionStore.openForRecovery(r),e=>e instanceof AdmissionError&&e.code==='schema_version_unknown');
  const verify=new DatabaseSync(path.join(r,'operations.sqlite3'),{readOnly:true});try{assert.equal(verify.prepare('PRAGMA user_version').get().user_version,2)}finally{verify.close();}
});

test('Recovery refuses an older v3 table shape without adding Result columns',()=>{
  const r=root('old-v3-shape');const db=new DatabaseSync(path.join(r,'operations.sqlite3'));
  try{db.exec('CREATE TABLE manager_operations(operation_id TEXT); PRAGMA user_version=3')}finally{db.close();}
  assert.throws(()=>IsolatedAdmissionStore.openForRecovery(r),e=>e instanceof AdmissionError&&e.code==='schema_version_unknown');
  const verify=new DatabaseSync(path.join(r,'operations.sqlite3'),{readOnly:true});
  try{assert.deepEqual(verify.prepare('PRAGMA table_info(manager_operations)').all().map(x=>x.name),['operation_id'])}finally{verify.close();}
});

test('C3B Recovery CAS records a verified phase-preserving Hold and fences Result without releasing Claim or Capacity',()=>{
  const {root:r,store,request}=makeRunning('c3b-hold');const port=verifiedRecoveryPort(store);const {input,evidence}=recoveryInput(store);
  const result=port.recordRecoveryObservation(input,evidence);assert.equal(result.duplicate,false);assert.equal(result.phase,'running');assert.equal(result.revision,input.expected_revision+1);
  const rows=readRows(r),event=rows.events.at(-1),eventEvidence=JSON.parse(event.evidence_json);
  assert.equal(event.event_type,'observation_recorded');assert.equal(event.from_phase,'running');assert.equal(event.to_phase,'running');
  assert.equal(eventEvidence.classification,'hold');assert.equal(eventEvidence.claim_id,input.claim_id);assert.equal(eventEvidence.task_id,input.task_id);
  assert.equal(eventEvidence.worker_identity_digest,input.worker_identity_digest);assert.equal(eventEvidence.expected_revision,input.expected_revision);
  assert.equal(rows.operation.phase,'running');assert.equal(rows.operation.claim_id,input.claim_id);assert.equal(rows.active,1);
  assert.equal(rows.task.status,'running');assert.equal(rows.attempt.status,'running');assert.equal(rows.operation.result_digest,null);
  capture(()=>store.commitResult(request),'operation_recovery_latched');
  const recovery=IsolatedAdmissionStore.openForRecovery(r);try{const op=recovery.readRecoverySnapshot().operations.find(x=>x.operation_id===input.operation_id);
    assert.equal(op.recovery_classification,'hold');assert.equal(op.recovery_observation_count,1);assert.equal(op.capacity_occupied,true);assert.equal(op.claim_permanent,true);
  }finally{recovery.close();}
  const repeated=port.recordRecoveryObservation(input,evidence);assert.equal(repeated.duplicate,true);
  assert.equal(readRows(r).events.filter(x=>x.event_type==='observation_recorded').length,1);store.close();
});

test('generic observation CAS rejects Recovery-reserved reasons before mutation and leaves the Store usable',()=>{
  for(const reason of ['recovery_hold','recovery_quarantine']){
    const {store}=makeRunning(`generic-recovery-reason-${reason}`,{reservedOnly:true});
    const before=store.readOperation('operation-result');
    const beforeEvents=store.readLifecycleEvents('operation-result');
    const classification=reason==='recovery_quarantine'?'quarantine':'hold';
    const reason_code=classification==='quarantine'?'operation_projection_conflict':'cleanup_identity_unknown';
    const recoveryEvidence=[
      {reason,evidence_digest:'a'.repeat(64)},
      {attempt:1,claim_id:'unbound-claim',classification,envelope_digest:'d'.repeat(64),evidence_digest:'e'.repeat(64),
        evidence_source:classification==='quarantine'?'manager_projection_validator':'manager_cleanup_probe',expected_revision:1,
        reason,reason_code,task_id:'task-result',worker_identity_digest:'f'.repeat(64)},
    ];
    for(const evidence of recoveryEvidence){
      assert.throws(()=>store.compareAndSwapObservation({operation_id:before.operation_id,generation:before.generation,
        revision:before.revision,evidence}),e=>e instanceof AdmissionError&&e.code==='reserved_recovery_reason');
      assert.deepEqual(store.readOperation('operation-result'),before);
      assert.deepEqual(store.readLifecycleEvents('operation-result'),beforeEvents);
    }
    const forgedCancellation={cancel_id:'forged-cancel',claim_id:'forged-claim',evidence_digest:'c'.repeat(64),
      identity_evidence_digest:'d'.repeat(64),identity_state:'alive',reason:'cancel_requested',worker_identity_digest:'e'.repeat(64)};
    assert.throws(()=>store.compareAndSwapObservation({operation_id:before.operation_id,generation:before.generation,
      revision:before.revision,evidence:forgedCancellation}),e=>e instanceof AdmissionError&&e.code==='reserved_cancellation_reason');
    assert.deepEqual(store.readOperation('operation-result'),before);assert.deepEqual(store.readLifecycleEvents('operation-result'),beforeEvents);
    const validGeneric={reason:'ordinary_observation',evidence_digest:'b'.repeat(64)};
    const committed=store.compareAndSwapObservation({operation_id:before.operation_id,generation:before.generation,
      revision:before.revision,evidence:validGeneric});
    assert.equal(committed.revision,before.revision+1);
    assert.equal(store.readOperation('operation-result').revision,before.revision+1);
    assert.equal(store.readLifecycleEvents('operation-result').filter(e=>e.event_type==='observation_recorded').length,1);
    store.close();
  }
});

test('malformed stored Recovery-looking observation stays fail-closed without repair or release',()=>{
  const {root:r,store}=makeRunning('malformed-recovery-history',{reservedOnly:true});store.close();
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));
  const evidenceJson=JSON.stringify({evidence_digest:'c'.repeat(64),reason:'recovery_quarantine'});
  try{
    const operation=db.prepare("SELECT * FROM manager_operations WHERE operation_id='operation-result'").get();
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE manager_operations SET revision=revision+1 WHERE operation_id=?').run(operation.operation_id);
    const cursor=db.prepare('SELECT next_event_cursor FROM authority_metadata WHERE singleton=1').get().next_event_cursor+1;
    const updated=db.prepare('UPDATE authority_metadata SET next_event_cursor=? WHERE singleton=1 AND next_event_cursor=?').run(cursor,cursor-1);
    assert.equal(updated.changes,1);
    db.prepare('INSERT INTO manager_operation_events(event_cursor,operation_id,sequence,event_type,from_phase,to_phase,generation,evidence_json,evidence_digest,at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(cursor,operation.operation_id,operation.revision+1,
      'observation_recorded',operation.phase,operation.phase,operation.generation,evidenceJson,digest(evidenceJson),'2026-10-23T00:00:02.000Z');
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}finally{db.close()}

  assert.throws(()=>IsolatedAdmissionStore.open(r),e=>e instanceof AdmissionError&&e.code==='recovery_event_binding_mismatch');
  const recovery=IsolatedAdmissionStore.openForRecovery(r);
  try{
    const snapshot=recovery.readRecoverySnapshot();
    assert.equal(snapshot.root_status,'unavailable_read_only');
    assert.equal(snapshot.verified_event_projection_consistency,false);
    assert.equal(snapshot.cleanup_performed,false);assert.equal(snapshot.claim_release_performed,false);
    assert.equal(snapshot.operation_release_performed,false);
  }finally{recovery.close()}
  const verify=new DatabaseSync(path.join(r,'operations.sqlite3'),{readOnly:true});
  try{
    const operation=verify.prepare("SELECT phase,revision FROM manager_operations WHERE operation_id='operation-result'").get();
    const events=verify.prepare("SELECT sequence,evidence_json FROM manager_operation_events WHERE operation_id='operation-result' ORDER BY sequence").all();
    assert.equal(operation.phase,'reserved');assert.equal(operation.revision,2);
    assert.equal(events.length,2);assert.equal(events.at(-1).evidence_json,evidenceJson);
  }finally{verify.close()}
});

test('C3B Recovery verifier, Claim, identity, generation, and revision fences reject untrusted or stale input',()=>{
  const {store}=makeRunning('c3b-fences');const {input,evidence}=recoveryInput(store);
  const noVerifier=createSqliteLifecyclePort(store);assert.throws(()=>noVerifier.recordRecoveryObservation(input,evidence),e=>e.code==='recovery_evidence_verifier_required');
  const reject=createSqliteLifecyclePort(store,{recoveryEvidenceVerifier:()=>false});assert.throws(()=>reject.recordRecoveryObservation(input,evidence),e=>e instanceof AdmissionError&&e.code==='recovery_evidence_unverified');
  const port=verifiedRecoveryPort(store);
  for(const [key,value,code] of [['task_id','other-task','operation_identity_mismatch'],['attempt',2,'operation_identity_mismatch'],
    ['generation',input.generation+1,'operation_identity_mismatch'],['claim_id','other-claim','recovery_claim_identity_mismatch'],
    ['worker_identity_digest','0'.repeat(64),'recovery_claim_identity_mismatch'],['expected_revision',input.expected_revision-1,'stale_recovery_cas']]){
    const mutated={...input,[key]:value};
    assert.throws(()=>port.recordRecoveryObservation(mutated,evidence),e=>e instanceof AdmissionError&&e.code===code,`${key} must be fenced`);
  }
  store.close();
});

test('C3B cannot persist an observation before permanent Claim and trusted Worker identity exist',()=>{
  const {store}=makeRunning('c3b-no-claim',{intentOnly:true});const o=store.readOperation('operation-result');
  const evidence={source:'manager_process_probe',operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,observation:'unknown'};
  const input={operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,expected_revision:o.revision,claim_id:'synthetic-missing-claim',
    worker_identity_digest:'a'.repeat(64),classification:'hold',reason_code:'worker_identity_unknown',evidence_source:'manager_process_probe',evidence_digest:digest(evidence)};
  const port=createSqliteLifecyclePort(store,{recoveryEvidenceVerifier:()=>({classification:'hold',reason_code:'worker_identity_unknown',
    evidence_source:'manager_process_probe',evidence_digest:input.evidence_digest})});
  assert.throws(()=>port.recordRecoveryObservation(input,evidence),e=>e instanceof AdmissionError&&e.code==='recovery_claim_missing');
  assert.equal(store.readOperation('operation-result').revision,o.revision);
  assert.equal(store.readLifecycleEvents('operation-result').some(e=>e.event_type==='observation_recorded'),false);store.close();
});

test('C3B Recovery classification is monotonic, quarantine cannot downgrade, and the per-operation cap is bounded',()=>{
  const {root:r,store,request}=makeRunning('c3b-monotonic');const port=verifiedRecoveryPort(store);
  const first=recoveryInput(store);const one=port.recordRecoveryObservation(first.input,first.evidence);
  const second=recoveryInput(store,{classification:'quarantine',reason_code:'operation_projection_conflict',evidence_source:'manager_projection_validator'});
  second.input.expected_revision=one.revision;
  second.input.evidence_digest=digest(second.evidence);const two=port.recordRecoveryObservation(second.input,second.evidence);
  assert.equal(two.classification,'quarantine');assert.equal(store.poisoned,false);
  capture(()=>store.commitResult(request),'operation_recovery_latched');
  const lower=recoveryInput(store,{classification:'hold',reason_code:'cleanup_identity_unknown'});
  lower.input.expected_revision=two.revision;lower.input.evidence_digest=digest(lower.evidence);
  assert.throws(()=>port.recordRecoveryObservation(lower.input,lower.evidence),e=>e instanceof AdmissionError&&e.code==='recovery_classification_downgrade');
  let current=two;
  for(let i=2;i<8;i++){
    const next=recoveryInput(store,{classification:'quarantine',reason_code:'operation_projection_conflict',evidence_source:'manager_projection_validator',
      evidence:{source:'manager_projection_validator',operation_id:'operation-result',task_id:'task-result',attempt:1,generation:current.generation,
        claim_id:current.claim_id,worker_identity_digest:current.worker_identity_digest,observation:`conflict-${i}`}});
    next.input.expected_revision=current.revision;next.input.evidence_digest=digest(next.evidence);current=port.recordRecoveryObservation(next.input,next.evidence);
  }
  const ninth=recoveryInput(store,{classification:'quarantine',reason_code:'operation_projection_conflict',evidence_source:'manager_projection_validator',
    evidence:{source:'manager_projection_validator',operation_id:'operation-result',task_id:'task-result',attempt:1,generation:current.generation,
      claim_id:current.claim_id,worker_identity_digest:current.worker_identity_digest,observation:'ninth'}});
  ninth.input.expected_revision=current.revision;ninth.input.evidence_digest=digest(ninth.evidence);
  assert.throws(()=>port.recordRecoveryObservation(ninth.input,ninth.evidence),e=>e instanceof AdmissionError&&e.code==='recovery_observation_limit');
  const recovery=IsolatedAdmissionStore.openForRecovery(r);try{const op=recovery.readRecoverySnapshot().operations[0];
    assert.equal(op.recovery_classification,'quarantine');assert.equal(op.recovery_observation_count,8);assert.equal(op.capacity_occupied,true);assert.equal(op.claim_permanent,true);
  }finally{recovery.close();store.close();}
});

test('C3B known rollback preserves projection and Unknown Commit poisons the root',()=>{
  const a=makeRunning('c3b-rollback'),requestA=recoveryInput(a.store);a.store.close();
  const rollback=IsolatedAdmissionStore.open(a.root,{fault:'after_projection'});try{
    const port=verifiedRecoveryPort(rollback);assert.throws(()=>port.recordRecoveryObservation(requestA.input,requestA.evidence),e=>e.code==='injected_failure');
    const after=rollback.readOperation('operation-result');assert.equal(after.phase,'running');assert.equal(after.revision,requestA.input.expected_revision);
    assert.equal(readRows(a.root).events.some(x=>x.event_type==='observation_recorded'),false);
  }finally{rollback.close();}
  const b=makeRunning('c3b-unknown-commit'),requestB=recoveryInput(b.store);b.store.close();
  const unknown=IsolatedAdmissionStore.open(b.root,{fault:'commit_ack_lost'});try{
    const port=verifiedRecoveryPort(unknown);assert.throws(()=>port.recordRecoveryObservation(requestB.input,requestB.evidence),e=>e.code==='transaction_outcome_unknown');
    assert.equal(unknown.poisoned,true);assert.throws(()=>unknown.compareAndSwapRecoveryObservation(requestB.input,requestB.evidence,()=>true),e=>e.code==='root_poisoned');
    const ro=IsolatedAdmissionStore.openForRecovery(b.root);try{const snap=ro.readRecoverySnapshot();assert.equal(snap.root_status,'blocked_read_only');
      assert.equal(snap.operations[0].capacity_occupied,true);assert.equal(snap.operations[0].claim_permanent,true);
    }finally{ro.close();}
  }finally{unknown.close();}
});

test('C3B same-Workspace Operations remain independent after one Operation is latched',()=>{
  const {root:r,store}=makeRunning('c3b-workspace-isolation'),workspace=path.join(TEMP,'workspace');
  const otherTask={task_id:'task-other',workspace,objective:'synthetic second operation',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]};
  store.createTask(otherTask,'2026-10-23T00:00:00.000Z');const allow=()=>({state:'allow',fixture:true});
  const admitted=store.admitOperation({operation_id:'operation-other',task_id:'task-other',attempt:1,workspace_ref:workspace},{workspaceValidator:allow,executionPermissionCheck:allow});
  const launch={operation_id:'operation-other',task_id:'task-other',attempt:1,generation:admitted.generation,revision:admitted.revision,
    launch_id:'launch-other',launch_epoch:1,launch_token:'synthetic-other-token-0123456789'};
  const intent=store.createLaunchIntent(launch);const receipt=store.recordLaunchReceipt({...launch,revision:intent.revision,receipt_id:'receipt-other',
    launch_identity:{source:'synthetic_fixture',fixture:true,process_id:41002,start_fingerprint:'synthetic-start-other'}});
  store.commitPermanentClaim({...launch,revision:receipt.revision,claim_id:'claim-other',worker_identity:{source:'synthetic_fixture',fixture:true,worker_id:'worker-other',
    incarnation:'incarnation-other',process_id:41002,start_fingerprint:'synthetic-start-other'}});
  const first=recoveryInput(store);const port=verifiedRecoveryPort(store);port.recordRecoveryObservation(first.input,first.evidence);
  const other=store.readOperation('operation-other');const otherRequest={operation_id:other.operation_id,task_id:other.task_id,attempt:other.attempt,generation:other.generation,
    revision:other.revision,claim_id:other.claim_id,claim_worker_identity_digest:other.claim_worker_identity_digest,result_status:'completed',
    result:resultPayload('completed',{task_id:'task-other'})};
  const committed=store.commitResult(otherRequest);assert.equal(committed.phase,'result_committed');
  assert.equal(store.readOperation('operation-result').phase,'running');assert.equal(store.readOperation('operation-result').claim_id,first.input.claim_id);
  assert.equal(readRows(r).active,2);store.close();
});

test('C3B two independent Managers produce one Recovery CAS winner without overwriting stale evidence',async()=>{
  const {root:r,store}=makeRunning('c3b-manager-race'),base=recoveryInput(store);store.close();
  const secondEvidence={...base.evidence,observation:'manager-b-different-observation'};
  const secondInput={...base.input,evidence_digest:digest(secondEvidence)};
  const [a,b]=await Promise.all([recoveryChild(r,base.input,base.evidence),recoveryChild(r,secondInput,secondEvidence)]);
  const successes=[a,b].filter(x=>x.exitCode===0&&x.result.ok);assert.equal(successes.length,1,JSON.stringify([a,b]));
  const failed=[a,b].filter(x=>x.exitCode===0&&!x.result.ok);assert.equal(failed.length,1,JSON.stringify([a,b]));
  assert.ok(['recovery_observation_conflict','stale_recovery_cas','root_writer_busy'].includes(failed[0].result.code));
  const writer=IsolatedAdmissionStore.open(r);try{
    const loser=failed[0]===a?{input:base.input,evidence:base.evidence}:{input:secondInput,evidence:secondEvidence};
    const port=verifiedRecoveryPort(writer);
    if(failed[0].result.code==='root_writer_busy')assert.throws(()=>port.recordRecoveryObservation(loser.input,loser.evidence),e=>e.code==='recovery_observation_conflict');
    const rows=readRows(r);assert.equal(rows.events.filter(x=>x.event_type==='observation_recorded'&&JSON.parse(x.evidence_json).reason.startsWith('recovery_')).length,1);
    assert.equal(rows.operation.phase,'running');assert.equal(rows.operation.claim_id,base.input.claim_id);assert.equal(rows.active,1);
  }finally{writer.close();}
});
