import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedAdmissionStore, AdmissionError, digest } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';
import { createSqliteLifecyclePort } from '../../../src/sqlite-candidate/wp6b2b1/lifecycle-port.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const TEMP=process.env.WP6C_TEST_TEMP_ROOT
  ?path.resolve(process.env.WP6C_TEST_TEMP_ROOT)
  :path.resolve(HERE,'../../../src/sqlite-candidate/wp6b2b1',`test-temp-wp6c-c2-${process.pid}`);
mkdirSync(TEMP,{recursive:true});
let serial=0;
const stores=new Set();
function root(label='cleanup'){const p=path.join(TEMP,`${label}-${++serial}`);mkdirSync(p,{recursive:true});return p;}
function failWith(fn,code){assert.throws(fn,e=>e instanceof AdmissionError&&e.code===code);}
function makeStore(label='cleanup',{capacity=2,fault}={}){
  const r=root(label),store=IsolatedAdmissionStore.initialize(r),workspace=path.join(TEMP,'shared-workspace');stores.add(store);
  mkdirSync(workspace,{recursive:true});
  store.provisionCapacity({operation_id:'policy-c2',capacity_limit:capacity,expected_generation:0,maintenance:{dispatch_blocked:true,writers_drained:true}});
  return {root:r,store,workspace};
}
function addResult(f,suffix,{workspace=f.workspace}={}){
  const taskId=`task-${suffix}`,operationId=`operation-${suffix}`,launchId=`launch-${suffix}`;
  f.store.createTask({task_id:taskId,workspace,objective:'synthetic cleanup/release test',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]},'2026-10-23T00:00:00.000Z');
  const allow=()=>({state:'allow',fixture:true});
  const admitted=f.store.admitOperation({operation_id:operationId,task_id:taskId,attempt:1,workspace_ref:workspace},{workspaceValidator:allow,executionPermissionCheck:allow});
  const launch={operation_id:operationId,task_id:taskId,attempt:1,generation:admitted.generation,revision:admitted.revision,launch_id:launchId,launch_epoch:1,launch_token:`synthetic-cleanup-token-${suffix}-012345`};
  const intent=f.store.createLaunchIntent(launch);
  const processId=41000+serial;
  const receipt=f.store.recordLaunchReceipt({...launch,revision:intent.revision,receipt_id:`receipt-${suffix}`,launch_identity:{source:'synthetic_fixture',fixture:true,process_id:processId,start_fingerprint:`start-${suffix}`}});
  const claim=f.store.commitPermanentClaim({...launch,revision:receipt.revision,claim_id:`claim-${suffix}`,worker_identity:{source:'synthetic_fixture',fixture:true,worker_id:`worker-${suffix}`,incarnation:`incarnation-${suffix}`,process_id:processId,start_fingerprint:`start-${suffix}`}});
  const result={task_id:taskId,attempt:1,status:'completed',summary:'synthetic result',files_changed:[],tests:[],issues:[],needs_master_decision:false,zcode_output:'',exit_code:0,session_id:null,started_at:'2026-10-23T00:00:00.000Z',finished_at:'2026-10-23T00:00:01.000Z'};
  const claimed=f.store.readOperation(operationId);
  f.store.commitResult({operation_id:operationId,task_id:taskId,attempt:1,generation:admitted.generation,revision:claimed.revision,claim_id:claimed.claim_id,
    claim_worker_identity_digest:claimed.claim_worker_identity_digest,result_status:'completed',result});
  const operation=f.store.readOperation(operationId);
  return {operation_id:operationId,task_id:taskId,attempt:1,generation:operation.generation,revision:operation.revision,claim_id:operation.claim_id,
    claim_worker_identity_digest:operation.claim_worker_identity_digest,launch_receipt_digest:operation.launch_receipt_digest,
    result_commit_ref:operation.result_commit_ref,process_id:processId,start_fingerprint:`start-${suffix}`};
}
function verifiedEvidence(ref,overrides={}){
  return {source:'synthetic_fixture',fixture:true,operation_id:ref.operation_id,task_id:ref.task_id,attempt:ref.attempt,generation:ref.generation,
    claim_id:ref.claim_id,worker_identity_digest:ref.claim_worker_identity_digest,launch_receipt_digest:ref.launch_receipt_digest,result_commit_ref:ref.result_commit_ref,
    process_tree_digest:digest({root:ref.process_id,start:ref.start_fingerprint,children:[]}),resources_digest:digest({operation:ref.operation_id,resources:[]}),
    root_process_id:ref.process_id,root_start_fingerprint:ref.start_fingerprint,worker_tree_complete:true,operation_resources_complete:true,workspace_touched:false,...overrides};
}
function begin(f,ref){return f.store.beginCleanup({...ref});}
function verified(f,ref,evidence=verifiedEvidence(ref)){
  const pending=begin(f,ref);
  const outcome=f.store.recordCleanupEvidence({...ref,revision:pending.revision,outcome:'verified',cleanup_evidence:evidence});
  return {pending,outcome};
}
function recoveryHold(f,ref,classification='hold',reasonCode=classification==='hold'?'cleanup_identity_unknown':'operation_projection_conflict'){
  const o=f.store.readOperation(ref.operation_id),evidence={source:'manager_cleanup_probe',operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,
    generation:o.generation,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,probe:'unknown'};
  const input={operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,expected_revision:o.revision,claim_id:o.claim_id,
    worker_identity_digest:o.claim_worker_identity_digest,classification,reason_code:reasonCode,
    evidence_source:'manager_cleanup_probe',evidence_digest:digest(evidence)};
  const port=createSqliteLifecyclePort(f.store,{recoveryEvidenceVerifier:({operation,observation, evidence:actual})=>{
    const valid=actual.source===observation.evidence_source
    &&actual.operation_id===operation.operation_id&&actual.task_id===operation.task_id&&actual.attempt===operation.attempt
    &&actual.generation===operation.generation&&actual.claim_id===operation.claim_id&&actual.worker_identity_digest===operation.worker_identity_digest
    &&observation.evidence_digest===digest(actual);
    return valid?{classification:observation.classification,reason_code:observation.reason_code,evidence_source:observation.evidence_source,evidence_digest:observation.evidence_digest}:false;
  }});
  const result=port.recordRecoveryObservation(input,evidence);
  const persisted=f.store.readLifecycleEvents(o.operation_id).find(event=>event.sequence===result.event_sequence);
  assert.ok(persisted,'Recovery CAS must return an Event sequence that resolves to its immutable Event');
  return {...result,evidence_digest:persisted.evidence_digest};
}
function rows(f,ref){
  const db=new DatabaseSync(path.join(f.root,'operations.sqlite3'),{readOnly:true});
  try{return {operation:db.prepare('SELECT * FROM manager_operations WHERE operation_id=?').get(ref.operation_id),events:db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence').all(ref.operation_id),active:db.prepare("SELECT COUNT(*) AS n FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase<>'released'").get().n};}
  finally{db.close();}
}
function releaseChild(rootPath,request){
  const storeUrl=new URL('../../../src/sqlite-candidate/wp6b2b1/store.mjs',import.meta.url).href;
  const code=`import {IsolatedAdmissionStore} from ${JSON.stringify(storeUrl)};const s=IsolatedAdmissionStore.open(process.argv[1]);try{console.log(JSON.stringify({ok:true,out:s.releaseCapacity(JSON.parse(process.argv[2]))}))}catch(e){console.log(JSON.stringify({ok:false,code:e?.code??'unknown'}));process.exitCode=2}finally{s.close()}`;
  return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,rootPath,JSON.stringify(request)],{stdio:['ignore','pipe','pipe']});let out='',err='';
    p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>{try{resolve({code,out:JSON.parse(out),err})}catch(e){reject(new Error(`child output invalid: ${out}; stderr=${err}; ${e}`))}});});
}
function reverifyChild(rootPath,request){
  const storeUrl=new URL('../../../src/sqlite-candidate/wp6b2b1/store.mjs',import.meta.url).href;
  const code=`import {IsolatedAdmissionStore} from ${JSON.stringify(storeUrl)};const s=IsolatedAdmissionStore.open(process.argv[1]);try{console.log(JSON.stringify({ok:true,out:s.reverifyCleanup(JSON.parse(process.argv[2]))}))}catch(e){console.log(JSON.stringify({ok:false,code:e?.code??'unknown'}));process.exitCode=2}finally{s.close()}`;
  return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,rootPath,JSON.stringify(request)],{stdio:['ignore','pipe','pipe']});let out='',err='';
    p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>{try{resolve({code,out:JSON.parse(out),err})}catch(e){reject(new Error(`child output invalid: ${out}; stderr=${err}; ${e}`))}});});
}
async function retryBusyReverify(rootPath,request){
  let latest;
  for(let i=0;i<8;i++){
    latest=await reverifyChild(rootPath,request);
    if(latest.out.ok||latest.out.code!=='root_writer_busy')return latest;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  return latest;
}
after(()=>{for(const store of stores){try{store.close();}catch{}}});

test('verified cleanup is operation-scoped and release frees only its own slot',()=>{
  const f=makeStore('positive'),a=addResult(f,'a'),b=addResult(f,'b');
  const {pending,outcome}=verified(f,a);assert.equal(pending.phase,'cleanup_pending');assert.equal(outcome.phase,'cleanup_verified');
  const before=rows(f,a);assert.equal(before.operation.phase,'cleanup_verified');assert.equal(before.active,2);
  const release=f.store.releaseCapacity({...a,revision:outcome.revision,cleanup_digest:outcome.cleanup_digest});
  const afterRows=rows(f,a),other=rows(f,b);
  assert.equal(release.phase,'released');assert.equal(afterRows.active,1);assert.equal(other.operation.phase,'result_committed');
  assert.equal(other.operation.capacity_slot,2);assert.equal(existsSync(f.workspace),true);
  assert.deepEqual(afterRows.events.map(e=>e.event_type).slice(-3),['cleanup_pending','cleanup_verified','released']);
  assert.equal(f.store.readOperation(a.operation_id).claim_status,'permanent_claim_recorded');f.store.close();
});

test('Recovery distinguishes verified cleanup awaiting Release from unknown cleanup for a shared Workspace',()=>{
  const f=makeStore('recovery-independent'),a=addResult(f,'recovery-a'),b=addResult(f,'recovery-b');
  verified(f,a);
  f.store.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(f.root),port=createSqliteLifecyclePort(recovery);
  try {
    const snapshot=port.readRecoverySnapshot();
    const recoveredA=snapshot.operations.find(x=>x.operation_id===a.operation_id);
    const recoveredB=snapshot.operations.find(x=>x.operation_id===b.operation_id);
    assert.equal(snapshot.root_status,'consistent_read_only');
    assert.equal(recoveredA.cleanup_state,'verified');assert.equal(recoveredA.phase,'cleanup_verified');
    assert.equal(recoveredA.recovery_decision,'hold');assert.equal(recoveredA.capacity_occupied,true);
    assert.ok(recoveredA.recovery_blockers.includes('operation_release_pending'));
    assert.equal(recoveredB.cleanup_state,'unknown');assert.equal(recoveredB.phase,'result_committed');
    assert.equal(recoveredB.capacity_occupied,true);assert.ok(recoveredB.recovery_blockers.includes('operation_cleanup_unverified'));
    assert.equal(snapshot.cleanup_performed,false);assert.equal(snapshot.operation_release_performed,false);
    assert.equal(rows(f,a).operation.phase,'cleanup_verified');assert.equal(rows(f,b).operation.phase,'result_committed');
  } finally { recovery.close(); }
});

test('Result, Worker exit, or PID absence without verified operation resources cannot release capacity',()=>{
  const f=makeStore('result-is-not-cleanup',{capacity:1}),a=addResult(f,'only');
  failWith(()=>f.store.releaseCapacity({...a,cleanup_digest:'a'.repeat(64)}),'cleanup_not_verified');
  const pending=begin(f,a);
  const unknown=f.store.recordCleanupEvidence({...a,revision:pending.revision,outcome:'unverified',probe_state:'alive',reason:'worker_exited_resources_remain'});
  assert.equal(unknown.phase,'cleanup_unverified');assert.equal(rows(f,a).active,1);
  failWith(()=>f.store.releaseCapacity({...a,revision:unknown.revision,cleanup_digest:'a'.repeat(64)}),'cleanup_not_verified');
  assert.equal(f.store.readOperation(a.operation_id).claim_status,'permanent_claim_recorded');f.store.close();
});

test('unknown OS probe and incomplete cleanup preserve occupancy and permanent Claim',()=>{
  for(const state of ['unknown','identity_mismatch','incomplete']){
    const f=makeStore(`unverified-${state}`,{capacity:1}),a=addResult(f,state),pending=begin(f,a);
    const outcome=f.store.recordCleanupEvidence({...a,revision:pending.revision,outcome:'unverified',probe_state:state,reason:`synthetic_${state}`});
    assert.equal(outcome.cleanup_verified,false);assert.equal(rows(f,a).active,1);assert.equal(f.store.readOperation(a.operation_id).phase,'cleanup_unverified');f.store.close();
  }
});

test('complete new evidence resolves only the exact Cleanup Holds and preserves their immutable history',()=>{
  const f=makeStore('cleanup-reverify-eight-holds',{capacity:1}),a=addResult(f,'reverify-eight-holds'),pending=begin(f,a);
  const unverified=f.store.recordCleanupEvidence({...a,revision:pending.revision,outcome:'unverified',probe_state:'unknown',reason:'prior_probe_unknown'});
  assert.equal(unverified.phase,'cleanup_unverified');
  const holds=[];
  for(let index=0;index<8;index++)recoveryHold(f,a,'hold');
  const recoveryEvents=rows(f,a).events.filter(event=>event.event_type==='observation_recorded')
    .filter(event=>JSON.parse(event.evidence_json).reason==='recovery_hold');
  holds.push(...recoveryEvents.map(event=>event.evidence_digest));
  const before=f.store.readOperation(a.operation_id);
  const request={...a,revision:before.revision,cleanup_evidence:verifiedEvidence(a)};
  const result=f.store.reverifyCleanup(request);
  assert.equal(result.phase,'cleanup_verified');assert.equal(result.cleanup_verified,true);
  assert.equal(result.resolved_recovery_event_digests.length,8);
  const reverifyEvent=rows(f,a).events.find(event=>event.event_type==='cleanup_reverified');
  assert.ok(Buffer.byteLength(reverifyEvent.evidence_json,'utf8')>1024);
  assert.ok(Buffer.byteLength(reverifyEvent.evidence_json,'utf8')<=2048);
  assert.equal(JSON.parse(reverifyEvent.evidence_json).prior_cleanup_event_digest,
    rows(f,a).events.find(event=>event.event_type==='cleanup_unverified').evidence_digest);
  assert.deepEqual(result.resolved_recovery_event_digests,[...holds].sort());
  assert.equal(holds.length,8);
  const release=f.store.releaseCapacity({...a,revision:result.revision,cleanup_digest:result.cleanup_digest});
  assert.equal(release.phase,'released');assert.equal(f.store.readOperation(a.operation_id).claim_status,'permanent_claim_recorded');
  const taskB={...f.store.readTask(a.task_id),task_id:'task-after-reverified-release',objective:'synthetic queued task after verified release'};
  f.store.createTask(taskB,'2026-10-26T00:00:02.000Z');
  const admissionB=f.store.admitOperation({operation_id:'operation-after-reverified-release',task_id:taskB.task_id,attempt:1,workspace_ref:f.workspace},
    {workspaceValidator:()=>({state:'allow',fixture:true}),executionPermissionCheck:()=>({state:'allow',fixture:true})});
  assert.equal(admissionB.capacity_slot,1);
  const queuedB=f.store.readRecoverableQueuedAttempts().find(item=>item.task_id===taskB.task_id);
  assert.equal(queuedB?.dispatchable,true,'the next queued Operation may be dispatched only after A releases verified capacity');
  const operationAEvents=rows(f,a).events;
  assert.equal(operationAEvents.filter(event=>event.event_type==='launch_intent').length,1);
  assert.equal(operationAEvents.filter(event=>event.event_type==='claim_committed').length,1);
  const reopened=IsolatedAdmissionStore.openForRecovery(f.root);
  try {
    const snapshot=reopened.rebuildRecoveryState(),operation=snapshot.operations.find(item=>item.operation_id===a.operation_id);
    assert.equal(snapshot.root_status,'consistent_read_only');assert.equal(operation.phase,'released');
    assert.equal(operation.recovery_classification,'normal');assert.equal(operation.recovery_observation_count,8);
    assert.equal(operation.capacity_occupied,false);assert.equal(operation.claim_permanent,true);
    const events=reopened.readRecoverySnapshot().events.filter(event=>event.operation_id===a.operation_id);
    assert.equal(events.filter(event=>event.event_type==='observation_recorded').length,8);
    assert.deepEqual(events.filter(event=>event.event_type==='cleanup_reverified').map(event=>event.evidence_digest),[reverifyEvent.evidence_digest]);
  } finally { reopened.close();f.store.close(); }
});

test('a non-Cleanup Hold blocks re-verification without changing the Operation or releasing Capacity',()=>{
  const f=makeStore('cleanup-reverify-unrelated-hold',{capacity:1}),a=addResult(f,'unrelated-hold'),pending=begin(f,a);
  const unverified=f.store.recordCleanupEvidence({...a,revision:pending.revision,outcome:'unverified',probe_state:'unknown',reason:'prior_probe_unknown'});
  const unrelated=recoveryHold(f,a,'hold','worker_identity_unknown');
  const before=rows(f,a);
  failWith(()=>f.store.reverifyCleanup({...a,revision:unrelated.revision,cleanup_evidence:verifiedEvidence(a)}),
    'cleanup_reverification_blocked_by_unrelated_hold');
  const afterRows=rows(f,a);
  assert.equal(afterRows.operation.phase,'cleanup_unverified');assert.equal(afterRows.operation.revision,before.operation.revision);
  assert.equal(afterRows.active,1);assert.equal(f.store.readOperation(a.operation_id).claim_status,'permanent_claim_recorded');
  assert.equal(afterRows.events.filter(event=>event.event_type==='cleanup_reverified').length,0);
  assert.equal(afterRows.events.find(event=>event.event_type==='cleanup_unverified').evidence_digest,
    before.events.find(event=>event.event_type==='cleanup_unverified').evidence_digest);
  assert.equal(unverified.phase,'cleanup_unverified');f.store.close();
});

test('known failure after the re-verification Event rolls back both phases and keeps the Hold active',()=>{
  const f=makeStore('cleanup-reverify-known-rollback',{capacity:1}),a=addResult(f,'known-rollback'),pending=begin(f,a);
  f.store.recordCleanupEvidence({...a,revision:pending.revision,outcome:'unverified',probe_state:'unknown',reason:'prior_probe_unknown'});
  const hold=recoveryHold(f,a),before=f.store.readOperation(a.operation_id);f.store.close();
  const faulty=IsolatedAdmissionStore.open(f.root,{fault:'after_cleanup_reverification_event'});
  failWith(()=>faulty.reverifyCleanup({...a,revision:before.revision,cleanup_evidence:verifiedEvidence(a)}),'injected_failure');faulty.close();
  const reopened=IsolatedAdmissionStore.open(f.root);
  try {
    const operation=reopened.readOperation(a.operation_id),events=rows({root:f.root},a).events;
    assert.equal(operation.phase,'cleanup_unverified');assert.equal(operation.revision,before.revision);
    assert.equal(events.filter(event=>event.event_type==='cleanup_reverified').length,0);
    assert.equal(events.filter(event=>event.event_type==='cleanup_verified').length,0);
    assert.equal(events.filter(event=>event.event_type==='released').length,0);
    assert.equal(events.find(event=>event.evidence_digest===hold.evidence_digest).evidence_digest,hold.evidence_digest);
    assert.equal(rows({root:f.root},a).active,1);
  } finally { reopened.close(); }
});

test('two independent Managers re-verifying the same evidence append one remediation chain',async()=>{
  const f=makeStore('cleanup-reverify-two-managers',{capacity:1}),a=addResult(f,'two-managers'),pending=begin(f,a);
  f.store.recordCleanupEvidence({...a,revision:pending.revision,outcome:'unverified',probe_state:'unknown',reason:'prior_probe_unknown'});
  recoveryHold(f,a);const operation=f.store.readOperation(a.operation_id);
  const request={...a,revision:operation.revision,cleanup_evidence:verifiedEvidence(a)};f.store.close();
  const [left,right]=await Promise.all([retryBusyReverify(f.root,request),retryBusyReverify(f.root,request)]);
  assert.equal(left.code,0,JSON.stringify(left));assert.equal(left.out.ok,true);
  assert.equal(right.code,0,JSON.stringify(right));assert.equal(right.out.ok,true);
  assert.equal([left.out.out.duplicate,right.out.out.duplicate].filter(Boolean).length,1);
  const reopened=IsolatedAdmissionStore.open(f.root);
  try {
    const events=rows({root:f.root},a).events;
    assert.equal(reopened.readOperation(a.operation_id).phase,'cleanup_verified');
    assert.equal(events.filter(event=>event.event_type==='cleanup_reverified').length,1);
    assert.equal(events.filter(event=>event.event_type==='cleanup_verified').length,1);
    assert.equal(events.filter(event=>event.event_type==='released').length,0);
    assert.equal(rows({root:f.root},a).active,1);
  } finally { reopened.close(); }
});

test('unknown re-verification commit poisons Root and never treats cleanup as released',()=>{
  const f=makeStore('cleanup-reverify-unknown-commit',{capacity:1}),a=addResult(f,'unknown-commit'),pending=begin(f,a);
  f.store.recordCleanupEvidence({...a,revision:pending.revision,outcome:'unverified',probe_state:'unknown',reason:'prior_probe_unknown'});
  const hold=recoveryHold(f,a),operation=f.store.readOperation(a.operation_id);f.store.close();
  const faulty=IsolatedAdmissionStore.open(f.root,{fault:'commit_ack_lost'});
  failWith(()=>faulty.reverifyCleanup({...a,revision:operation.revision,cleanup_evidence:verifiedEvidence(a)}),'transaction_outcome_unknown');faulty.close();
  failWith(()=>IsolatedAdmissionStore.open(f.root),'root_poisoned');
  const recovery=IsolatedAdmissionStore.openForRecovery(f.root);
  try {
    const snapshot=recovery.rebuildRecoveryState(),current=snapshot.operations.find(item=>item.operation_id===a.operation_id);
    assert.equal(snapshot.root_status,'blocked_read_only');assert.equal(snapshot.writes_allowed,false);
    assert.equal(current.phase,'cleanup_verified');assert.equal(current.capacity_occupied,true);assert.equal(current.claim_permanent,true);
    assert.equal(snapshot.events.filter(event=>event.operation_id===a.operation_id&&event.event_type==='released').length,0);
    assert.ok(snapshot.events.some(event=>event.evidence_digest===hold.evidence_digest));
  } finally { recovery.close(); }
});

test('Schema v11 roots remain untouched and are rejected without automatic migration',()=>{
  const f=makeStore('cleanup-reverify-old-v11'),a=addResult(f,'old-v11');f.store.close();
  const db=new DatabaseSync(path.join(f.root,'operations.sqlite3'));
  try { db.exec('PRAGMA user_version=11'); } finally { db.close(); }
  failWith(()=>IsolatedAdmissionStore.open(f.root),'schema_version_unknown');
  failWith(()=>IsolatedAdmissionStore.openForRecovery(f.root),'schema_version_unknown');
  const verify=new DatabaseSync(path.join(f.root,'operations.sqlite3'),{readOnly:true});
  try {
    assert.equal(verify.prepare('PRAGMA user_version').get().user_version,11);
    assert.equal(verify.prepare('SELECT phase FROM manager_operations WHERE operation_id=?').get(a.operation_id).phase,'result_committed');
  } finally { verify.close(); }
});

test('PID reuse or mismatch with the recorded Receipt/Claim identity refuses verification',()=>{
  const f=makeStore('pid-reuse',{capacity:1}),a=addResult(f,'pid');begin(f,a);
  const pending=f.store.readOperation(a.operation_id).revision;
  failWith(()=>f.store.recordCleanupEvidence({...a,revision:pending,outcome:'verified',cleanup_evidence:verifiedEvidence(a,{root_process_id:a.process_id+1})}),'cleanup_worker_identity_mismatch');
  failWith(()=>f.store.recordCleanupEvidence({...a,revision:pending,outcome:'verified',cleanup_evidence:verifiedEvidence(a,{launch_receipt_digest:'b'.repeat(64)})}),'cleanup_evidence_identity_mismatch');
  assert.equal(f.store.readOperation(a.operation_id).phase,'cleanup_pending');assert.equal(rows(f,a).active,1);f.store.close();
});

test('Workspace mutation and incomplete process/resource evidence are rejected',()=>{
  const f=makeStore('unsafe-evidence',{capacity:1}),a=addResult(f,'unsafe');begin(f,a);const revision=f.store.readOperation(a.operation_id).revision;
  for(const override of [{workspace_touched:true},{worker_tree_complete:false},{operation_resources_complete:false}]){
    failWith(()=>f.store.recordCleanupEvidence({...a,revision,outcome:'verified',cleanup_evidence:verifiedEvidence(a,override)}),'invalid_cleanup_evidence');
  }
  assert.equal(f.store.readOperation(a.operation_id).phase,'cleanup_pending');assert.equal(rows(f,a).active,1);f.store.close();
});

test('stale generation, revision, Attempt, Claim, and Worker identity cannot record Cleanup or release',()=>{
  const f=makeStore('stale-cleanup',{capacity:1}),a=addResult(f,'stale');begin(f,a);const pendingRevision=f.store.readOperation(a.operation_id).revision;
  const wrongGeneration={...a,generation:a.generation+1};
  failWith(()=>f.store.recordCleanupEvidence({...wrongGeneration,revision:pendingRevision,outcome:'verified',cleanup_evidence:verifiedEvidence(wrongGeneration)}),'operation_identity_mismatch');
  failWith(()=>f.store.recordCleanupEvidence({...a,revision:pendingRevision-1,outcome:'verified',cleanup_evidence:verifiedEvidence(a)}),'stale_cleanup_cas');
  const wrongAttempt={...a,attempt:a.attempt+1};
  failWith(()=>f.store.recordCleanupEvidence({...wrongAttempt,revision:pendingRevision,outcome:'verified',cleanup_evidence:verifiedEvidence(wrongAttempt)}),'operation_identity_mismatch');
  const wrongClaim={...a,claim_id:'claim-other'};
  failWith(()=>f.store.recordCleanupEvidence({...wrongClaim,revision:pendingRevision,outcome:'verified',cleanup_evidence:verifiedEvidence(wrongClaim)}),'cleanup_claim_mismatch');
  const wrongWorker={...a,claim_worker_identity_digest:'f'.repeat(64)};
  failWith(()=>f.store.recordCleanupEvidence({...wrongWorker,revision:pendingRevision,outcome:'verified',cleanup_evidence:verifiedEvidence(wrongWorker)}),'cleanup_claim_mismatch');
  assert.equal(f.store.readOperation(a.operation_id).phase,'cleanup_pending');f.store.close();
});

test('begin and verified Cleanup are idempotent without adding duplicate Events',()=>{
  const f=makeStore('cleanup-idempotent'),a=addResult(f,'same');
  const first=begin(f,a),duplicateBegin=begin(f,a);assert.equal(duplicateBegin.duplicate,true);
  const evidence=verifiedEvidence(a),record=f.store.recordCleanupEvidence({...a,revision:first.revision,outcome:'verified',cleanup_evidence:evidence});
  const duplicate=f.store.recordCleanupEvidence({...a,revision:first.revision,outcome:'verified',cleanup_evidence:evidence});
  assert.equal(duplicate.duplicate,true);assert.equal(rows(f,a).events.filter(e=>e.event_type==='cleanup_verified').length,1);
  assert.equal(rows(f,a).events.filter(e=>e.event_type==='cleanup_pending').length,1);assert.equal(record.cleanup_digest,duplicate.cleanup_digest);f.store.close();
});

test('different Cleanup evidence cannot overwrite the first verified evidence',()=>{
  const f=makeStore('cleanup-conflict',{capacity:1}),a=addResult(f,'conflict'),verifiedResult=verified(f,a);
  failWith(()=>f.store.recordCleanupEvidence({...a,revision:verifiedResult.pending.revision,outcome:'verified',cleanup_evidence:verifiedEvidence(a,{resources_digest:'9'.repeat(64)})}),'cleanup_evidence_conflict');
  assert.equal(f.store.readOperation(a.operation_id).phase,'cleanup_verified');assert.equal(rows(f,a).active,1);
  assert.equal(rows(f,a).events.filter(e=>e.event_type==='cleanup_verified').length,1);f.store.close();
});

test('release requires the exact verified digest and is idempotent',()=>{
  const f=makeStore('release-idempotent',{capacity:1}),a=addResult(f,'release'),done=verified(f,a);
  failWith(()=>f.store.releaseCapacity({...a,revision:done.outcome.revision,cleanup_digest:'0'.repeat(64)}),'release_cleanup_evidence_mismatch');
  const request={...a,revision:done.outcome.revision,cleanup_digest:done.outcome.cleanup_digest};
  const first=f.store.releaseCapacity(request),duplicate=f.store.releaseCapacity(request);
  assert.equal(first.capacity_released,true);assert.equal(duplicate.duplicate,true);assert.equal(rows(f,a).active,0);
  assert.equal(rows(f,a).events.filter(e=>e.event_type==='released').length,1);f.store.close();
});

test('two processes racing to release one Operation produce one release Event',async()=>{
  const f=makeStore('release-race',{capacity:1}),a=addResult(f,'race'),done=verified(f,a),request={...a,revision:done.outcome.revision,cleanup_digest:done.outcome.cleanup_digest};
  f.store.close();
  const run=async()=>{for(let attempt=0;attempt<10;attempt++){const result=await releaseChild(f.root,request);if(result.code===0)return result;if(result.out.code!=='root_writer_busy')return result;await new Promise(resolve=>setTimeout(resolve,15));}throw new Error('bounded release race retries exhausted')};
  const results=await Promise.all([run(),run()]);
  assert.ok(results.every(x=>x.code===0&&x.out.ok),JSON.stringify(results));
  const outcomes=results.map(x=>x.out.out);assert.equal(outcomes.filter(x=>x.duplicate===false).length,1);assert.equal(outcomes.filter(x=>x.duplicate===true).length,1);
  assert.equal(rows(f,a).events.filter(e=>e.event_type==='released').length,1);assert.equal(rows(f,a).active,0);
});

test('same Workspace Operations are independent and cleanup never deletes shared Workspace',()=>{
  const f=makeStore('shared-workspace'),a=addResult(f,'share-a'),b=addResult(f,'share-b');
  const done=verified(f,a),released=f.store.releaseCapacity({...a,revision:done.outcome.revision,cleanup_digest:done.outcome.cleanup_digest});
  assert.equal(released.phase,'released');assert.equal(f.store.readOperation(b.operation_id).phase,'result_committed');
  assert.equal(rows(f,b).active,1);assert.equal(existsSync(f.workspace),true);f.store.close();
});

test('known failure after Cleanup projection rolls back both projection and Event',()=>{
  const f=makeStore('cleanup-rollback'),a=addResult(f,'rollback');f.store.close();
  const faulty=IsolatedAdmissionStore.open(f.root,{fault:'after_projection'});
  failWith(()=>faulty.beginCleanup(a),'injected_failure');faulty.close();
  const verify=IsolatedAdmissionStore.open(f.root);assert.equal(verify.readOperation(a.operation_id).phase,'result_committed');
  assert.equal(rows(f,a).events.filter(e=>e.event_type.startsWith('cleanup_')).length,0);verify.close();
});

test('known failure after Cleanup Verified projection rolls back projection and evidence Event',()=>{
  const f=makeStore('verified-rollback'),a=addResult(f,'rollback-verified'),pending=begin(f,a);f.store.close();
  const faulty=IsolatedAdmissionStore.open(f.root,{fault:'after_projection'});
  failWith(()=>faulty.recordCleanupEvidence({...a,revision:pending.revision,outcome:'verified',cleanup_evidence:verifiedEvidence(a)}),'injected_failure');faulty.close();
  const verify=IsolatedAdmissionStore.open(f.root);assert.equal(verify.readOperation(a.operation_id).phase,'cleanup_pending');
  assert.equal(rows(f,a).events.filter(e=>e.event_type==='cleanup_verified').length,0);verify.close();
});

test('known failure after Release projection rolls back capacity release',()=>{
  const f=makeStore('release-rollback',{capacity:1}),a=addResult(f,'rollback-release'),done=verified(f,a);f.store.close();
  const faulty=IsolatedAdmissionStore.open(f.root,{fault:'after_projection'});
  failWith(()=>faulty.releaseCapacity({...a,revision:done.outcome.revision,cleanup_digest:done.outcome.cleanup_digest}),'injected_failure');faulty.close();
  const verify=IsolatedAdmissionStore.open(f.root);assert.equal(verify.readOperation(a.operation_id).phase,'cleanup_verified');assert.equal(rows(f,a).active,1);
  assert.equal(rows(f,a).events.filter(e=>e.event_type==='released').length,0);verify.close();
});

test('unknown Release commit poisons the root and prevents further writes or guessed fallback',()=>{
  const f=makeStore('release-unknown',{capacity:1}),a=addResult(f,'unknown-commit'),done=verified(f,a);f.store.close();
  const faulty=IsolatedAdmissionStore.open(f.root,{fault:'commit_ack_lost'});
  failWith(()=>faulty.releaseCapacity({...a,revision:done.outcome.revision,cleanup_digest:done.outcome.cleanup_digest}),'transaction_outcome_unknown');faulty.close();
  assert.throws(()=>IsolatedAdmissionStore.open(f.root),e=>e.code==='root_poisoned');
  const recovery=IsolatedAdmissionStore.openForRecovery(f.root),snapshot=recovery.rebuildRecoveryState();
  assert.equal(snapshot.root_status,'blocked_read_only');assert.equal(snapshot.writes_allowed,false);
  assert.equal(snapshot.operations.find(x=>x.operation_id===a.operation_id).phase,'released');recovery.close();
});

test('Recovery latch fences C2 Cleanup Pending, Cleanup Evidence, and Release while preserving other Operations',()=>{
  const f=makeStore('recovery-latch',{capacity:4}),pendingRef=addResult(f,'latched-pending'),verifiedRef=addResult(f,'latched-release');
  recoveryHold(f,pendingRef,'quarantine');
  assert.throws(()=>f.store.beginCleanup({...pendingRef}),e=>e instanceof AdmissionError&&e.code==='operation_recovery_latched');
  const pending=begin(f,verifiedRef);recoveryHold(f,verifiedRef);
  assert.throws(()=>f.store.recordCleanupEvidence({...verifiedRef,revision:pending.revision,outcome:'verified',cleanup_evidence:verifiedEvidence(verifiedRef)}),
    e=>e instanceof AdmissionError&&e.code==='operation_recovery_latched');
  const verifiedOp=addResult(f,'latched-verified');const cleanup=verified(f,verifiedOp);recoveryHold(f,verifiedOp);
  assert.throws(()=>f.store.releaseCapacity({...verifiedOp,revision:cleanup.outcome.revision,cleanup_digest:cleanup.outcome.cleanup_digest}),
    e=>e instanceof AdmissionError&&e.code==='operation_recovery_latched');
  const rowsAfter=rows(f,verifiedOp);assert.equal(rowsAfter.operation.phase,'cleanup_verified');assert.equal(rowsAfter.active,3);
  assert.equal(rows(f,pendingRef).operation.phase,'result_committed');
  assert.equal(rows(f,verifiedRef).operation.phase,'cleanup_pending');
  for(const ref of [pendingRef,verifiedRef,verifiedOp])assert.ok(rows(f,ref).operation.claim_id);
});

test('Schema v5 is rejected without migration or mutation',()=>{
  const f=makeStore('no-v5-migration'),a=addResult(f,'schema-v5');f.store.close();
  const db=new DatabaseSync(path.join(f.root,'operations.sqlite3'));try{db.exec('PRAGMA user_version=5')}finally{db.close();}
  failWith(()=>IsolatedAdmissionStore.open(f.root),'schema_version_unknown');
  const verify=new DatabaseSync(path.join(f.root,'operations.sqlite3'),{readOnly:true});try{assert.equal(verify.prepare('PRAGMA user_version').get().user_version,5)}finally{verify.close();}
  void a;
});
