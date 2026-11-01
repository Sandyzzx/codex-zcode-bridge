import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AdmissionError, digest, IsolatedAdmissionStore } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';
import { createSqliteLifecyclePort } from '../../../src/sqlite-candidate/wp6b2b1/lifecycle-port.mjs';
import { createTrustedLocalCandidateContext } from '../../../dist-test/src/host/stdio.js';
import { BridgeTaskManager } from '../../../dist-test/src/manager/task-manager.js';
import { SqliteLifecycleMcpAuthority } from '../../../dist-test/src/manager/sqlite-lifecycle-mcp-authority.js';
import { createPlatformProbe } from '../../../dist-test/src/runtime/process-probe.js';
import { parseArgs } from '../../../dist-test/src/cli/admin-abandon-held-operation.js';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT=path.resolve(HERE,'../../..');
const execFileAsync=promisify(execFile);
const ADMIN_SCHEMA_SQL=readFileSync(path.join(PROJECT_ROOT,'src/sqlite-candidate/wp6b2b1/admin-abandonment.sql'),'utf8');
const TEST_ROOT=process.env.WP6C_TEST_TEMP_ROOT
  ?path.resolve(process.env.WP6C_TEST_TEMP_ROOT,`admin-abandonment-${process.pid}`)
  :path.resolve(HERE,'../../../src/sqlite-candidate/wp6b2b1',`test-temp-admin-abandonment-${process.pid}`);
mkdirSync(TEST_ROOT,{recursive:true});
after(()=>{try{rmSync(TEST_ROOT,{recursive:true,force:true});}catch{}});

function task(taskId,workspace){
  return {task_id:taskId,workspace,objective:'synthetic administrative abandonment fixture',requirements:[],allowed_paths:[],
    forbidden_paths:[],acceptance_criteria:[],test_commands:[]};
}
function trustedIdentity(kind,suffix,processId,fingerprint){
  const base={source:kind==='launch'?'manager_os_spawn_observation':'manager_verified_process_probe',fixture:false,
    ...(kind==='launch'?{launch_id:`launch-${suffix}`,generation:1}:{worker_id:`worker-${suffix}`}),
    process_id:processId,start_fingerprint:fingerprint,fingerprint_precision:'exact',identity_version:1,
    platform:'win32',captured_at:'2026-11-01T00:00:00.000Z'};
  return {...base,evidence_digest:digest(base)};
}
function makeClaimedStore(label,{capacity=1}={}){
  const root=path.join(TEST_ROOT,label),workspace=path.join(root,'workspace');
  mkdirSync(workspace,{recursive:true});
  const store=IsolatedAdmissionStore.initialize(root);
  store.provisionCapacity({operation_id:`policy-${label}`,capacity_limit:capacity,expected_generation:0,
    maintenance:{dispatch_blocked:true,writers_drained:true}});
  const taskId=`task-${label}`,operationId=`operation-${label}`,processId=52000+label.length,fingerprint=`fingerprint-${label}`;
  store.createTask(task(taskId,workspace),'2026-11-01T00:00:00.000Z');
  const allow=()=>({state:'allow',fixture:true});
  const admitted=store.admitOperation({operation_id:operationId,task_id:taskId,attempt:1,workspace_ref:workspace},
    {workspaceValidator:allow,executionPermissionCheck:allow});
  const launch={operation_id:operationId,task_id:taskId,attempt:1,generation:admitted.generation,revision:admitted.revision,
    launch_id:`launch-${label}`,launch_epoch:1,launch_token:`synthetic-admin-token-${label}-012345`};
  const intent=store.createLaunchIntent(launch);
  const receipt=store.recordLaunchReceipt({...launch,revision:intent.revision,receipt_id:`receipt-${label}`,
    launch_identity:trustedIdentity('launch',label,processId,fingerprint)});
  store.commitPermanentClaim({...launch,revision:receipt.revision,claim_id:`claim-${label}`,
    worker_identity:trustedIdentity('worker',label,processId,fingerprint)});
  const operation=store.readOperation(operationId);
  return {root,workspace,store,taskId,operationId,processId,fingerprint,operation};
}
function persistCleanupIncomplete(store,operationId){
  const o=store.readOperation(operationId);
  const evidence={source:'manager_cleanup_probe',operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,
    generation:o.generation,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,probe:'unknown'};
  const input={operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,expected_revision:o.revision,
    claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,classification:'hold',reason_code:'cleanup_incomplete',
    evidence_source:'manager_cleanup_probe',evidence_digest:digest(evidence)};
  const port=createSqliteLifecyclePort(store,{recoveryEvidenceVerifier:({operation,observation,evidence:actual})=>
    actual.source===observation.evidence_source&&actual.operation_id===operation.operation_id
      &&actual.task_id===operation.task_id&&actual.attempt===operation.attempt&&actual.generation===operation.generation
      &&actual.claim_id===operation.claim_id&&actual.worker_identity_digest===operation.worker_identity_digest
      &&observation.evidence_digest===digest(actual)
      ?{classification:observation.classification,reason_code:observation.reason_code,evidence_source:observation.evidence_source,
        evidence_digest:observation.evidence_digest}:false});
  const recorded=port.recordRecoveryObservation(input,evidence);
  const event=store.readLifecycleEvents(o.operation_id).find(value=>value.sequence===recorded.event_sequence);
  assert.ok(event);
  return event;
}
function abandonmentInput(f,hold,overrides={}){
  const operation=f.store.readOperation(f.operationId);
  return {operation_id:operation.operation_id,task_id:operation.task_id,attempt:operation.attempt,generation:operation.generation,
    revision:operation.revision,claim_id:operation.claim_id,claim_worker_identity_digest:operation.claim_worker_identity_digest,
    evidence:{boot_time:new Date(Date.parse(hold.at)+60_000).toISOString(),failed_at:hold.at,
      hosts_closed:true,writer_closed:true,worker_exited:true,claimant_scan_clean:true,
      process_inventory_digest:'a'.repeat(64),platform_probe_digest:'b'.repeat(64),claimant_scan_digest:'c'.repeat(64),
      worker_process_id:f.processId,worker_start_fingerprint:f.fingerprint,
      observed_at:new Date(Date.parse(hold.at)+120_000).toISOString()},...overrides};
}
function failure(fn,code){assert.throws(fn,error=>error instanceof AdmissionError&&error.code===code);}
function rows(f){
  const db=new DatabaseSync(path.join(f.root,'operations.sqlite3'),{readOnly:true});
  try{return {
    operation:db.prepare('SELECT * FROM manager_operations WHERE operation_id=?').get(f.operationId),
    task:db.prepare('SELECT * FROM tasks WHERE task_id=?').get(f.taskId),
    attempt:db.prepare('SELECT * FROM attempts WHERE task_id=? AND attempt=1').get(f.taskId),
    events:db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence').all(f.operationId),
    admin:db.prepare('SELECT * FROM manager_admin_abandonments WHERE operation_id=?').get(f.operationId),
    active:db.prepare("SELECT COUNT(*) AS n FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase NOT IN ('released','cancelled_before_launch')").get().n,
    integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreignKeys:db.prepare('PRAGMA foreign_key_check').all(),
  };}finally{db.close();}
}
function mutateAdminRow(root,sql,value){
  const db=new DatabaseSync(path.join(root,'operations.sqlite3'));
  try{
    db.exec('DROP TRIGGER manager_admin_abandonments_no_update');
    db.prepare(sql).run(...value);
    const start=ADMIN_SCHEMA_SQL.indexOf('CREATE TRIGGER manager_admin_abandonments_no_update');
    const end=ADMIN_SCHEMA_SQL.indexOf('CREATE TRIGGER manager_admin_abandonments_no_delete',start);
    if(start<0||end<0)throw new Error('administrative update trigger missing from schema');
    db.exec(ADMIN_SCHEMA_SQL.slice(start,end).trim().replace(/;\s*$/u,''));
  }finally{db.close();}
}
function fixture(label,capacity=1){
  const value=makeClaimedStore(label,{capacity});
  const hold=persistCleanupIncomplete(value.store,value.operationId);
  return {...value,hold};
}

test('administrative abandonment is target-bound, CAS-fenced, auditable, and idempotent',()=>{
  const f=fixture('fixture');
  try{
    const beforeEvents=f.store.readLifecycleEvents(f.operationId).length;
    const request=abandonmentInput(f,f.hold);
    const result=f.store.adminAbandonHeldOperation(request);
    assert.equal(result.phase,'admin_abandoned');assert.equal(result.result_absent,true);assert.equal(result.cleanup_verified,false);
    const operation=f.store.readOperation(f.operationId);
    assert.equal(operation.phase,'admin_abandoned');assert.equal(operation.physical_phase,'released');
    assert.equal(f.store.readTaskProjection(f.taskId).status,'failed');
    assert.equal(f.store.readAttempt(f.taskId,1).status,'failed');
    const state=rows(f);
    assert.equal(state.operation.phase,'released');assert.equal(state.operation.result_digest,null);
    assert.equal(state.task.status,'failed');assert.equal(state.attempt.status,'failed');assert.equal(state.active,0);
    assert.equal(state.events.length,beforeEvents+1);assert.equal(state.events.at(-1).event_type,'observation_recorded');
    assert.equal(JSON.parse(state.events.at(-1).evidence_json).reason,'admin_abandoned');
    assert.equal(state.events.some(event=>['cleanup_verified','released','result_committed'].includes(event.event_type)),false);
    assert.equal(state.admin.outcome,'admin_abandoned');assert.equal(state.admin.result_absent,1);assert.equal(state.admin.cleanup_verified,0);
    assert.equal(state.integrity,'ok');assert.deepEqual(state.foreignKeys,[]);
    const duplicate=f.store.adminAbandonHeldOperation(request);
    assert.equal(duplicate.duplicate,true);assert.equal(rows(f).events.length,beforeEvents+1);
    const conflictingReplay=structuredClone(request);
    conflictingReplay.evidence.observed_at=new Date(Date.parse(request.evidence.observed_at)+1_000).toISOString();
    failure(()=>f.store.adminAbandonHeldOperation(conflictingReplay),'admin_abandonment_evidence_conflict');
    assert.equal(rows(f).events.length,beforeEvents+1);
    const recovery=IsolatedAdmissionStore.openForRecovery(f.root);
    try{
      const snapshot=recovery.readRecoverySnapshot();
      const abandoned=snapshot.operations.find(operation=>operation.operation_id===f.operationId);
      assert.equal(snapshot.root_status,'consistent_read_only');assert.equal(abandoned.phase,'admin_abandoned');
      assert.equal(abandoned.recovery_decision,'complete');assert.equal(abandoned.capacity_occupied,false);
      assert.equal(abandoned.cleanup_state,'not_applicable');assert.deepEqual(abandoned.recovery_blockers,[]);
    }finally{recovery.close();}
    const gates={workspaceValidator:()=>({state:'allow',fixture:true}),executionPermissionCheck:()=>({state:'allow',fixture:true})};
    const abandonedOperation=f.store.readOperation(f.operationId);
    assert.equal(f.store.readRecoverableQueuedAttempts().some(item=>item.task_id===f.taskId),false);
    failure(()=>f.store.admitOperation({operation_id:'operation-after-terminal-abandonment',task_id:f.taskId,attempt:2,
      workspace_ref:f.workspace},gates),'task_attempt_not_admissible');
    failure(()=>f.store.createNextAttempt({operation_id:'continue-after-terminal-abandonment',task_id:f.taskId,
      feedback:'must not run',previous_attempt:1,previous_operation_id:f.operationId,
      expected_generation:abandonedOperation.generation,expected_revision:abandonedOperation.revision,
      claim_id:abandonedOperation.claim_id,claim_worker_identity_digest:abandonedOperation.claim_worker_identity_digest},gates),
    'continue_status_not_eligible');
  }finally{f.store.close();}
});

for(const [label,column,value,expectedBlocker] of [
  ['request-digest','request_digest','0'.repeat(64),'admin_abandonment_projection_mismatch'],
  ['observed-at','abandoned_at','2026-11-01T00:02:00.000Z','admin_abandonment_audit_invalid'],
]){
  test(`recovery rejects tampered administrative ${label}`,()=>{
    const f=fixture(`tamper-${label}`);
    try{
      f.store.adminAbandonHeldOperation(abandonmentInput(f,f.hold));
      f.store.close();
      mutateAdminRow(f.root,`UPDATE manager_admin_abandonments SET ${column}=? WHERE operation_id=?`,[value,f.operationId]);
      const recovery=IsolatedAdmissionStore.openForRecovery(f.root);
      try{
        const snapshot=recovery.readRecoverySnapshot();
        assert.equal(snapshot.root_status,'quarantined_read_only');
        assert.ok(snapshot.root_blockers.includes(expectedBlocker),JSON.stringify(snapshot.root_blockers));
      }finally{recovery.close();}
    }finally{try{f.store.close();}catch{}}
  });
}

test('administrative abandonment rejects stale identity, invalid generation evidence, and present Result',()=>{
  for(const [label,mutate,code] of [
    ['revision',(input)=>{input.revision-=1;},'admin_abandonment_identity_mismatch'],
    ['claim',(input)=>{input.claim_id='different-claim';},'admin_abandonment_identity_mismatch'],
    ['boot',(input)=>{input.evidence.boot_time=input.evidence.failed_at;},'admin_abandonment_generation_boundary_unverified'],
    ['worker-live',(input)=>{input.evidence.worker_exited=false;},'invalid_admin_abandonment_evidence'],
    ['host-open',(input)=>{input.evidence.hosts_closed=false;},'invalid_admin_abandonment_evidence'],
  ]){
    const f=fixture(`reject-${label}`);
    try{const input=abandonmentInput(f,f.hold);mutate(input);failure(()=>f.store.adminAbandonHeldOperation(input),code);}
    finally{f.store.close();}
  }
  const resultFixture=makeClaimedStore('result-present');
  try{
    const operation=resultFixture.store.readOperation(resultFixture.operationId);
    resultFixture.store.commitResult({operation_id:operation.operation_id,task_id:operation.task_id,attempt:operation.attempt,
      generation:operation.generation,revision:operation.revision,claim_id:operation.claim_id,
      claim_worker_identity_digest:operation.claim_worker_identity_digest,result_status:'completed',
      result:{task_id:operation.task_id,attempt:1,status:'completed',summary:'synthetic result',files_changed:[],tests:[],issues:[],
        needs_master_decision:false,zcode_output:'',exit_code:0,session_id:null,started_at:'2026-11-01T00:00:00.000Z',
        finished_at:'2026-11-01T00:00:01.000Z'}});
    const committed=resultFixture.store.readOperation(resultFixture.operationId);
    const pending=resultFixture.store.beginCleanup({operation_id:committed.operation_id,task_id:committed.task_id,attempt:committed.attempt,
      generation:committed.generation,revision:committed.revision,claim_id:committed.claim_id,
      claim_worker_identity_digest:committed.claim_worker_identity_digest});
    resultFixture.store.recordCleanupEvidence({operation_id:committed.operation_id,task_id:committed.task_id,attempt:committed.attempt,
      generation:committed.generation,revision:pending.revision,claim_id:committed.claim_id,
      claim_worker_identity_digest:committed.claim_worker_identity_digest,outcome:'unverified',probe_state:'unknown',
      reason:'synthetic_cleanup_unknown'});
    const hold=persistCleanupIncomplete(resultFixture.store,resultFixture.operationId);
    failure(()=>resultFixture.store.adminAbandonHeldOperation(abandonmentInput(resultFixture,hold)),
      'admin_abandonment_result_or_phase_invalid');
  }finally{resultFixture.store.close();}
});

test('administrative abandonment frees exactly one capacity slot and does not mutate another Task',()=>{
  const f=fixture('capacity',1);
  try{
    const otherId='task-untouched';f.store.createTask(task(otherId,f.workspace),'2026-11-01T00:00:02.000Z');
    const otherBefore=f.store.readTaskProjection(otherId);
    f.store.adminAbandonHeldOperation(abandonmentInput(f,f.hold));
    assert.deepEqual(f.store.readTaskProjection(otherId),otherBefore);
    const allow=()=>({state:'allow',fixture:true});
    const admitted=f.store.admitOperation({operation_id:'operation-after-abandon',task_id:otherId,attempt:1,workspace_ref:f.workspace},
      {workspaceValidator:allow,executionPermissionCheck:allow});
    assert.equal(admitted.phase,'reserved');assert.equal(admitted.capacity_slot,1);
    const active=rows(f).active;assert.equal(active,1);
  }finally{f.store.close();}
});

test('restarted Manager skips the abandoned Task and dispatches a new Task',{timeout:90_000},async()=>{
  const f=fixture('manager-restart');
  let manager=null;
  try{
    f.store.adminAbandonHeldOperation(abandonmentInput(f,f.hold));
    f.store.close();
    const settingsDirectory=path.join(f.root,'settings');
    mkdirSync(settingsDirectory,{recursive:true});
    const authority=await SqliteLifecycleMcpAuthority.create({
      dataRoot:f.root,
      workerEntryPath:path.join(PROJECT_ROOT,'dist-test','src','worker','worker-main.js'),
      bridgeEntryPath:fileURLToPath(import.meta.url),
      trustedLocalContext:createTrustedLocalCandidateContext({
        name:'admin-abandonment-manager-restart',
        settingsDirectory,
      }),
      processProbe:createPlatformProbe({timeoutMs:5_000}),
      loadModules:async()=>({Store:IsolatedAdmissionStore,createPort:createSqliteLifecyclePort}),
      testOnlyFakeAdapter:true,
    });
    manager=new BridgeTaskManager({lifecycleAuthority:authority});
    const abandoned=await manager.getStatus(f.taskId);
    assert.equal(abandoned.status,'failed');
    assert.equal(abandoned.worker_pid,null);
    await assert.rejects(()=>manager.getResult(f.taskId),/no committed SQLite Result/u);

    const nextTaskId='task-after-admin-abandonment';
    const receipt=await manager.createTask(task(nextTaskId,f.workspace));
    assert.equal(receipt.status,'queued');
    const deadline=Date.now()+30_000;
    let nextStatus;
    while(Date.now()<deadline){
      nextStatus=await manager.getStatus(nextTaskId);
      if(['completed','failed','cancelled','waiting_for_master'].includes(nextStatus.status))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(nextStatus?.status,'completed');
    const result=await manager.getResult(nextTaskId);
    assert.equal(result.status,'completed');

    const recovery=IsolatedAdmissionStore.openForRecovery(f.root);
    try{
      const snapshot=recovery.readRecoverySnapshot();
      const abandonedProjection=snapshot.operations.find(operation=>operation.operation_id===f.operationId);
      assert.equal(snapshot.root_status,'consistent_read_only');
      assert.equal(abandonedProjection.phase,'admin_abandoned');
      assert.equal(abandonedProjection.recovery_decision,'complete');
      assert.equal(snapshot.operations.some(operation=>operation.phase==='running'),false);
    }finally{recovery.close();}
  }finally{
    await manager?.shutdown().catch(()=>undefined);
    try{f.store.close();}catch{}
  }
});

test('the compiled operator CLI succeeds in a child process and performs the exact CAS',async()=>{
  const f=fixture('cli-success');
  try{
    const operation=f.store.readOperation(f.operationId);
    const argv=[
      '--execute','--confirmation',`ADMIN-ABANDON:${f.operationId}`,
      '--data-root',f.root,'--database','operations.sqlite3','--operation-id',f.operationId,'--task-id',f.taskId,
      '--attempt','1','--generation',String(operation.generation),'--revision',String(operation.revision),
      '--claim-id',operation.claim_id,'--worker-identity-digest',operation.claim_worker_identity_digest,
    ];
    const invalidArgv=argv.slice();invalidArgv[2]='WRONG';
    assert.throws(()=>parseArgs(invalidArgv),/confirmation_mismatch/u);
    f.store.close();
    const cliModuleUrl=pathToFileURL(path.join(PROJECT_ROOT,'dist-test/src/cli/admin-abandon-held-operation.js')).href;
    const childScript=path.join(TEST_ROOT,`cli-success-${process.pid}.mjs`);
    writeFileSync(childScript,`
import { executeCli } from ${JSON.stringify(cliModuleUrl)};
const result=await executeCli(${JSON.stringify(argv)},{
  windowsBootTime:async()=>${JSON.stringify(new Date(Date.parse(f.hold.at)+1).toISOString())},
  processInventory:async()=>[],
  probeWorkerExit:async()=>({count:1,state:'exited',reason:null}),
  claimantScan:async()=>({clean:true,livePids:[],observedPids:[]}),
});
process.stdout.write(JSON.stringify(result));
`,'utf8');
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const execution=await execFileAsync(process.execPath,[childScript],{cwd:PROJECT_ROOT,env,windowsHide:true,maxBuffer:1_000_000});
    assert.equal(execution.stderr,'');
    const result=JSON.parse(execution.stdout);
    assert.equal(result.phase,'admin_abandoned');assert.equal(result.result_absent,true);assert.equal(result.cleanup_verified,false);
    assert.match(String(result.process_inventory_digest),/^[0-9a-f]{64}$/u);
    assert.match(String(result.platform_probe_digest),/^[0-9a-f]{64}$/u);
    assert.match(String(result.claimant_scan_digest),/^[0-9a-f]{64}$/u);
    const reopened=IsolatedAdmissionStore.open(f.root);
    try{
      const after=reopened.readOperation(f.operationId);
      assert.equal(after.phase,'admin_abandoned');
      assert.equal(after.physical_phase,'released');
      assert.equal(after.result_absent,true);
      assert.equal(after.cleanup_verified,false);
      assert.equal(reopened.readTaskProjection(f.taskId).status,'failed');
      assert.equal(reopened.readAttempt(f.taskId,1).status,'failed');
    }finally{reopened.close();}
  }finally{try{f.store.close();}catch{}}
});
