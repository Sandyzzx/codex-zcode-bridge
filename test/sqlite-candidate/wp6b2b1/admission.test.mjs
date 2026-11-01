import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedAdmissionStore, AdmissionError, canonical, digest } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';
import { launchOnce } from '../../../dist-test/src/sqlite-candidate/wp6b2b1/manager-launch.js';
import { verifyHandshakeAndCommitClaim } from '../../../dist-test/src/sqlite-candidate/wp6b2b1/worker-handshake.js';
import { createPlatformProbe } from '../../../dist-test/src/adapters/process-spawn.js';
import { createTrustedLocalPolicyProvider } from '../../../dist-test/src/sqlite-candidate/wp6b2b1/trusted-local-policy.js';
import { createHostTrustedLocalPolicyProvider } from '../../../dist-test/src/runtime/trusted-local-policy-config.js';

const HERE=path.dirname(fileURLToPath(import.meta.url));
// Store root validation requires disposable databases to live below the
// isolated candidate module. The directory is removed by this test's after hook.
const TEMP=path.resolve(HERE,'../../../src/sqlite-candidate/wp6b2b1/.run',`test-temp-b1-${process.pid}-${randomUUID()}`); mkdirSync(TEMP,{recursive:true});
let serial=0;
function root(label){const p=path.join(TEMP,`${label}-${process.pid}-${++serial}`);mkdirSync(p,{recursive:true});return p;}
function workspace(label='shared'){const p=path.join(TEMP,'workspaces',label);mkdirSync(p,{recursive:true});return p;}
function seed(r, rows){const db=new DatabaseSync(path.join(r,'operations.sqlite3'));try{db.exec('PRAGMA foreign_keys=ON');for(const [task,attempt,generation] of rows){db.prepare('INSERT INTO tasks(task_id,current_attempt) VALUES(?,?)').run(task,attempt);db.prepare('INSERT INTO attempts(task_id,attempt,generation,status) VALUES(?,?,?,\'queued\')').run(task,attempt,generation);}db.prepare('UPDATE authority_metadata SET next_generation=?').run(Math.max(0,...rows.map(x=>x[2]??0)));}finally{db.close();}}
function setup(label,capacity=2,rows=[['t1',1,11],['t2',1,21],['t3',1,31]]){const r=root(label);let s=IsolatedAdmissionStore.initialize(r);s.close();seed(r,rows);s=IsolatedAdmissionStore.open(r);s.provisionCapacity({operation_id:'policy-1',capacity_limit:capacity,expected_generation:0,maintenance:{dispatch_blocked:true,writers_drained:true}});return {r,s};}
function input(task='t1',attempt=1,generation=11,op=`op-${task}-${attempt}`,ws=workspace()){return{operation_id:op,task_id:task,attempt,generation,workspace_ref:ws};}
const allow=()=>({state:'allow',fixture:true});
const options={workspaceValidator:allow,executionPermissionCheck:allow};
function admit(store,request,gates=options){
  return Object.hasOwn(request,'generation')
    ?store.admitSyntheticFixtureOperation(request,gates)
    :store.admitOperation(request,gates);
}
function capture(fn,code){assert.throws(fn,e=>e instanceof AdmissionError&&e.code===code);}
function launchInput(store,operationId='op-t1-1',overrides={}){const o=store.readOperation(operationId);return{operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,revision:o.revision,
  launch_id:`launch-${operationId}`,launch_epoch:1,launch_token:`synthetic-token-${operationId}-0123456789`,...overrides};}
function receiptInput(intent,revision=intent.revision+1,overrides={}){return{...intent,revision,receipt_id:`receipt-${intent.launch_id}`,
  launch_identity:{source:'synthetic_fixture',fixture:true,process_id:43210,start_fingerprint:`fixture-start-${intent.launch_id}`},...overrides};}
function claimInput(intent,revision,worker='worker-a',overrides={}){return{...intent,revision,claim_id:`claim-${intent.launch_id}`,
  worker_identity:{source:'synthetic_fixture',fixture:true,worker_id:worker,incarnation:`incarnation-${worker}`,process_id:43210,start_fingerprint:`fixture-start-${intent.launch_id}`},...overrides};}
function fixtureTransition(rootPath,operationId,generation,revision,from,to,eventType,evidence){
  const db=new DatabaseSync(path.join(rootPath,'operations.sqlite3'));try{
    db.exec('BEGIN IMMEDIATE');
    const changed=db.prepare('UPDATE manager_operations SET phase=?,revision=? WHERE operation_id=? AND revision=?').run(to,revision,operationId,revision-1);
    assert.equal(changed.changes,1);
    const cursor=db.prepare('SELECT next_event_cursor FROM authority_metadata WHERE singleton=1').get().next_event_cursor+1;
    const updated=db.prepare('UPDATE authority_metadata SET next_event_cursor=? WHERE singleton=1 AND next_event_cursor=?').run(cursor,cursor-1);
    assert.equal(updated.changes,1);
    const json=canonical(evidence);db.prepare('INSERT INTO manager_operation_events(event_cursor,operation_id,sequence,event_type,from_phase,to_phase,generation,evidence_json,evidence_digest,at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(cursor,operationId,revision,eventType,from,to,generation,json,digest(json),new Date().toISOString());
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
function child(args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(HERE,'worker-process.mjs'),...args],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>{try{resolve({code,out:JSON.parse(out),err});}catch(e){reject(new Error(`child output parse failed: ${out} stderr=${err} (${e})`));}});});}
function lifecycleChild(mode,r,payload){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(HERE,'lifecycle-process.mjs'),mode,r,JSON.stringify(payload)],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>{try{resolve({code,out:JSON.parse(out),err});}catch(e){reject(new Error(`lifecycle child output parse failed: ${out} stderr=${err} (${e})`));}});});}

after(()=>rmSync(TEMP,{recursive:true,force:true}));

test('capacity maintenance, exact policy assertion, idempotency, and controlled update guard',()=>{
  const r=root('policy');let s=IsolatedAdmissionStore.initialize(r);s.close();s=IsolatedAdmissionStore.open(r);
  capture(()=>s.provisionCapacity({operation_id:'p',capacity_limit:1,expected_generation:0,maintenance:true}),'invalid_maintenance_request');
  const p=s.provisionCapacity({operation_id:'p',capacity_limit:1,expected_generation:0,maintenance:{dispatch_blocked:true,writers_drained:true}});
  assert.equal(p.generation,1);assert.deepEqual(s.provisionCapacity({operation_id:'p',capacity_limit:1,expected_generation:0,maintenance:{dispatch_blocked:true,writers_drained:true}}),{duplicate:true,operation_id:'p'});
  s.assertCapacityPolicy(1);capture(()=>s.assertCapacityPolicy(2),'capacity_policy_mismatch');s.close();
});

test('general admission refuses caller-supplied Generation and allocates from SQLite',()=>{
  const {s}=setup('generation-caller-rejected',1,[['generation-caller',1,null]]);
  capture(()=>s.admitOperation({...input('generation-caller',1,999,'caller-generation'),generation:999},options),'caller_generation_forbidden');
  const admitted=s.admitOperation({operation_id:'sqlite-generation',task_id:'generation-caller',attempt:1,workspace_ref:workspace()},options);
  assert.equal(admitted.generation,1);s.close();
});

test('Host local policy is default-off, audited, and cannot be supplied by a task request',()=>{
  const denied=setup('od10-default-off',2,[['od10-off-a',1,null],['od10-off-b',1,null]]);
  const disabled=createTrustedLocalPolicyProvider();
  try{
    capture(()=>denied.s.admitOperation({operation_id:'od10-off',task_id:'od10-off-a',attempt:1,workspace_ref:workspace('od10-off')},{
      workspaceValidator:disabled.validateWorkspace,executionPermissionCheck:disabled.checkPermission,
    }),'workspace_validation_unknown');
    assert.equal(denied.s.readSnapshot().operations.filter(x=>x.operation_kind==='attempt_lifecycle').length,0);
  }finally{denied.s.close();}

  const {s}=setup('od10-enabled',2,[['od10-a',1,null],['od10-b',1,null]]);
  const allowedWorkspace=workspace('od10-host-local');
  const secondWorkspace=workspace('od10-host-local-second');
  const settingsDirectory=path.join(TEMP,'owner-settings'); mkdirSync(settingsDirectory,{recursive:true});
  const policy=createHostTrustedLocalPolicyProvider({name:'candidate-test',settingsDirectory});
  let admitted;
  try{admitted=s.admitOperation({operation_id:'od10-allowed',task_id:'od10-a',attempt:1,workspace_ref:allowedWorkspace,
    permission:'allow',execution_profile_id:'unrestricted',host_authorized:true},{
    workspaceValidator:policy.validateWorkspace,executionPermissionCheck:policy.checkPermission,
  });
  assert.equal(admitted.phase,'reserved');
  let event=s.readLifecycleEvents(admitted.operation_id)[0];
  let audit=JSON.parse(event.evidence_json);
  assert.equal(audit.authorization_source,'trusted_local_policy');
  assert.equal(audit.policy_revision,'single-user-local-v2');
  assert.equal(audit.execution_profile_id,'local-build-v1');
  assert.match(audit.policy_digest,/^[0-9a-f]{64}$/u);

  capture(()=>s.admitOperation({operation_id:'od10-relative',task_id:'od10-b',attempt:1,workspace_ref:'relative/path'},{
    workspaceValidator:policy.validateWorkspace,executionPermissionCheck:policy.checkPermission,
  }),'workspace_not_absolute');
  const second=admit(s,{operation_id:'od10-second',task_id:'od10-b',attempt:1,workspace_ref:secondWorkspace},{
    workspaceValidator:policy.validateWorkspace,executionPermissionCheck:policy.checkPermission,
  });
  assert.equal(second.phase,'reserved');
  policy.disable();
  capture(()=>s.admitOperation({operation_id:'od10-after-disable',task_id:'od10-b',attempt:1,workspace_ref:allowedWorkspace},{
    workspaceValidator:policy.validateWorkspace,executionPermissionCheck:policy.checkPermission,
  }),'workspace_validation_unknown');
  assert.equal(s.readOperation(admitted.operation_id).phase,'reserved');
  assert.equal(s.readSnapshot().operations.filter(x=>x.operation_kind==='attempt_lifecycle').length,2);
  assert.equal(s.readLifecycleEvents(admitted.operation_id).length,1,'policy disable does not mutate or release the existing Operation');
  }finally{s.close();}
});

test('two real child processes race for capacity one; capacity and Attempt uniqueness hold',async()=>{
  const {r,s}=setup('race',1,[['race-a',1,101],['race-b',1,102]]);s.close();const ws=workspace('race-shared');
  const args=[['race-a','1','101'],['race-b','1','102']];const results=await Promise.all(args.map(a=>child([r,...a,ws])));
  assert.equal(results.filter(x=>x.out.ok).length,1,JSON.stringify(results));
  const loser=results.findIndex(x=>!x.out.ok);assert.ok(['capacity_exhausted','root_writer_busy'].includes(results[loser].out.code),JSON.stringify(results));
  let retry=null;if(results[loser].out.code==='root_writer_busy'){retry=await child([r,...args[loser],ws]);assert.equal(retry.out.code,'capacity_exhausted',JSON.stringify(retry));}
  writeFileSync(path.join(r,'process-race-evidence.json'),JSON.stringify({children:results.map((x,i)=>({args:args[i],exit:x.code,result:x.out})),retry:retry&&{exit:retry.code,result:retry.out},workspace:ws},null,2));
  const verify=IsolatedAdmissionStore.open(r);const snap=verify.readSnapshot();assert.equal(snap.operations.filter(x=>x.operation_kind==='attempt_lifecycle').length,1);assert.equal(snap.events.filter(x=>x.event_type==='reserved').length,1);verify.close();
});

test('policy upper bound of eight admits eight Workers and rejects a ninth',()=>{
  const rows=Array.from({length:9},(_,i)=>[`upper-${i+1}`,1,1000+i]);const {s}=setup('upper-bound',8,rows);const ws=workspace('upper-bound-shared');
  for(let i=0;i<8;i++)admit(s,input(rows[i][0],1,rows[i][2],`upper-op-${i+1}`,ws),options);
  capture(()=>admit(s,input(rows[8][0],1,rows[8][2],'upper-op-9',ws),options),'capacity_exhausted');
  assert.equal(s.readSnapshot().operations.filter(x=>x.operation_kind==='attempt_lifecycle').length,8);s.close();
});

test('same Attempt uniqueness, duplicate request idempotency, and operation ID digest conflict',()=>{
  const {r,s}=setup('idempotency');const req=input();const first=admit(s,req,options);assert.equal(first.phase,'reserved');
  assert.equal(admit(s,req,options).operation_id,first.operation_id);
  capture(()=>admit(s,{...req,workspace_ref:workspace('other')},options),'operation_id_conflict');
  capture(()=>admit(s,{...req,operation_id:'other-op'},options),'attempt_already_admitted');
  s.close();
});

test('different Attempts can use identical, parent/child, or identity-unknown Workspace references',()=>{
  const {s}=setup('shared-workspace',3);const parent=workspace('parent');const childPath=path.join(parent,'child');mkdirSync(childPath,{recursive:true});
  const a=admit(s,input('t1',1,11,'shared-a',parent),options);
  const b=admit(s,input('t2',1,21,'shared-b',parent),options);
  const c=admit(s,input('t3',1,31,'shared-c',childPath),options);
  assert.deepEqual([a.phase,b.phase,c.phase],['reserved','reserved','reserved']);
  assert.equal(s.readSnapshot().operations.filter(x=>x.operation_kind==='attempt_lifecycle').length,3);s.close();
});

test('Generation is transactionally allocated, idempotent, distinct from Attempt, and durable after reopen',async()=>{
  const rows=[['gen-a',7,null],['gen-b',7,null],['gen-c',1,null]];const {r,s}=setup('generation-authority',3,rows);s.close();
  const ws=workspace('generation-shared');
  const payloads=rows.slice(0,2).map(([task,attempt])=>({operation_id:`allocated-${task}`,task_id:task,attempt,workspace_ref:ws}));
  const results=await Promise.all(payloads.map(async p=>{
    for(let retry=0;retry<6;retry++){
      const result=await lifecycleChild('admit',r,p);
      if(result.out.ok||result.out.code!=='root_writer_busy')return result;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    return lifecycleChild('admit',r,p);
  }));
  assert.deepEqual(results.map(x=>x.out.ok),[true,true],JSON.stringify(results));
  const generations=results.map(x=>x.out.result.generation);
  assert.equal(new Set(generations).size,2);assert.ok(generations.every(g=>g>0));
  assert.ok(generations.every(g=>g!==7),'Attempt number must not stand in for Generation');
  const duplicate=await lifecycleChild('admit',r,payloads[0]);assert.equal(duplicate.out.result.generation,generations[0]);assert.equal(duplicate.out.result.duplicate,true);
  let reopened=IsolatedAdmissionStore.open(r);
  assert.equal(reopened.readOperation(payloads[0].operation_id).generation,generations[0]);
  reopened.close();
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));
  try{assert.equal(db.prepare('SELECT next_generation FROM authority_metadata').get().next_generation,Math.max(...generations));}
  finally{db.close();}
  reopened=IsolatedAdmissionStore.open(r);const next={operation_id:'allocated-gen-c',task_id:'gen-c',attempt:1,workspace_ref:ws};
  const third=admit(reopened,next,options);assert.ok(third.generation>Math.max(...generations));reopened.close();
});

test('trusted Receipt must bind the persisted Launch ID and Generation',()=>{
  const {r,s}=setup('trusted-receipt-binding');const admitted=admit(s,input(),options);
  const intent=launchInput(s,admitted.operation_id);s.createLaunchIntent(intent);
  const receipt=receiptInput(intent,intent.revision+1);
  const identity={source:'manager_os_spawn_observation',fixture:false,launch_id:intent.launch_id,generation:intent.generation,
    process_id:43210,start_fingerprint:'exact-fingerprint',fingerprint_precision:'exact',identity_version:1,platform:'win32',captured_at:new Date().toISOString()};
  identity.evidence_digest=digest(identity);
  const mismatched={...identity,launch_id:'other-launch'};delete mismatched.evidence_digest;mismatched.evidence_digest=digest(mismatched);
  capture(()=>s.recordLaunchReceipt({...receipt,launch_identity:mismatched}),'trusted_launch_identity_binding_mismatch');
  const accepted=s.recordLaunchReceipt({...receipt,launch_identity:identity});assert.equal(accepted.synthetic,false);s.close();
});

test('isolated Manager harness persists Intent before Spawn, probes Receipt, and gates Claim on OS evidence',{skip:process.platform!=='win32'},async t=>{
  const {r,s}=setup('manager-harness',3,[['manager-e2e',4,null]]);const ws=workspace('manager-e2e');
  const admitted=s.admitOperation({operation_id:'manager-e2e-op',task_id:'manager-e2e',attempt:4,workspace_ref:ws},options);
  const request={operation_id:admitted.operation_id,task_id:'manager-e2e',attempt:4,generation:admitted.generation,revision:admitted.revision,
    launch_id:'manager-e2e-launch',launch_epoch:1,launch_token:'manager-e2e-token-with-sufficient-entropy'};
  const probe=createPlatformProbe({timeoutMs:10000});let spawnCalls=0;let child;
  t.after(()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill();s.close();});
  const launched=await launchOnce(s,request,()=>{
    spawnCalls++;
    assert.equal(s.readOperation(request.operation_id).phase,'launch_intent','Spawn must happen after durable Intent');
    const contender=new DatabaseSync(path.join(r,'operations.sqlite3'));
    try{contender.exec('BEGIN IMMEDIATE; ROLLBACK');}finally{contender.close();}
    child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    return child;
  },probe);
  assert.equal(launched.state,'receipt_persisted');assert.equal(spawnCalls,1);
  assert.equal(launched.identity.launch_id,request.launch_id);assert.equal(launched.identity.generation,request.generation);
  assert.equal(launched.receipt.synthetic,false);
  const persisted=s.readOperation(request.operation_id);assert.equal(persisted.launch_receipt_id!==null,true);
  const report={worker_id:'controlled-node-worker',operation_id:request.operation_id,task_id:request.task_id,attempt:request.attempt,
    launch_id:request.launch_id,launch_epoch:request.launch_epoch,generation:request.generation,
    process_id:child.pid,start_fingerprint:launched.identity.start_fingerprint};
  const untrustedProbe={platform:'win32',identityOf:async()=>{throw new Error('probe denied');},selfIdentity:async()=>{throw new Error('probe denied');},probe:async()=>{throw new Error('probe denied');}};
  const rejected=await verifyHandshakeAndCommitClaim(s,persisted,report,request.launch_token,'claim-untrusted',untrustedProbe);
  assert.deepEqual(rejected,{state:'claim_rejected',reason:'os_identity_unverified'});
  assert.equal(s.readOperation(request.operation_id).claim_id,null);
  const forged={...report,task_id:'another-task'};
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,persisted,forged,request.launch_token,'claim-forged',probe),
    {state:'claim_rejected',reason:'launch_mismatch'});
  assert.equal(s.readOperation(request.operation_id).claim_id,null,'forged task identity must not reach Claim CAS');
  const expectedSnapshot={operation_id:request.operation_id,task_id:request.task_id,attempt:request.attempt,generation:request.generation,
    workspace_ref:ws,authorization_source:'trusted_local_policy',policy_revision:'policy-v1',policy_digest:'a'.repeat(64),
    execution_profile_id:'local-build-v1',policy_snapshot_digest:'b'.repeat(64)};
  let policyProbeCalls=0;
  const countedProbe={...probe,identityOf:async(...args)=>{policyProbeCalls++;return await probe.identityOf(...args);},
    probe:async(...args)=>{policyProbeCalls++;return await probe.probe(...args);}};
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,persisted,report,request.launch_token,'claim-missing-policy',countedProbe,
    expectedSnapshot,'c'.repeat(64)),{state:'claim_rejected',reason:'worker_report_mismatch'});
  const tamperedPolicyReport={...report,authorization_source:'trusted_local_policy',workspace_ref:ws,policy_revision:'policy-v1',
    policy_digest:'a'.repeat(64),execution_profile_id:'local-build-v1',execution_mode:'build',unrestricted:false,
    policy_snapshot_digest:expectedSnapshot.policy_snapshot_digest,provenance_digest:'d'.repeat(64)};
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,persisted,tamperedPolicyReport,request.launch_token,'claim-tampered-policy',countedProbe,
    expectedSnapshot,'c'.repeat(64)),{state:'claim_rejected',reason:'worker_report_mismatch'});
  assert.equal(policyProbeCalls,0,'missing or tampered policy/provenance is rejected before OS probe and Claim');
  assert.equal(s.readOperation(request.operation_id).claim_id,null);
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,persisted,{...report,generation:report.generation+1},request.launch_token,'claim-expired-generation',probe),
    {state:'claim_rejected',reason:'launch_mismatch'});
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,persisted,{...report,launch_epoch:report.launch_epoch+1},request.launch_token,'claim-wrong-epoch',probe),
    {state:'claim_rejected',reason:'launch_mismatch'});
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,{...persisted,launch_receipt_id:null},report,request.launch_token,'claim-no-receipt',probe),
    {state:'claim_rejected',reason:'receipt_missing'});
  const reusedPidProbe={...probe,identityOf:async pid=>({...await probe.identityOf(pid),fingerprint:'reused-pid-generation'})};
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,persisted,report,request.launch_token,'claim-pid-reuse',reusedPidProbe),
    {state:'claim_rejected',reason:'os_identity_unverified'});
  const staleRevision={...persisted,revision:persisted.revision-1};
  assert.deepEqual(await verifyHandshakeAndCommitClaim(s,staleRevision,report,request.launch_token,'claim-stale-revision',probe),
    {state:'claim_rejected',reason:'claim_cas_rejected'});
  const claimed=await verifyHandshakeAndCommitClaim(s,persisted,report,request.launch_token,'claim-manager-probed',probe);
  assert.equal(claimed.state,'claim_committed',JSON.stringify(claimed));
  assert.equal(s.readOperation(request.operation_id).phase,'running');
  const afterClaim=s.readOperation(request.operation_id);
  const repeatedClaim=await verifyHandshakeAndCommitClaim(s,afterClaim,report,request.launch_token,'claim-manager-probed',probe);
  assert.equal(repeatedClaim.state,'claim_committed');assert.equal(repeatedClaim.result.duplicate,true);
  const duplicate=await launchOnce(s,request,()=>{spawnCalls++;throw new Error('must not retry');},probe);
  assert.equal(duplicate.state,'launch_outcome_unknown');assert.equal(duplicate.reason,'duplicate_intent');assert.equal(spawnCalls,1);
  child.kill();await new Promise(resolve=>child.once('close',resolve));
});

test('controlled child that exits immediately leaves Intent occupied and is never automatically respawned',{skip:process.platform!=='win32'},async t=>{
  const {r,s}=setup('manager-early-exit',1,[['early-exit',3,null]]);const ws=workspace('early-exit');
  const admitted=s.admitOperation({operation_id:'early-exit-op',task_id:'early-exit',attempt:3,workspace_ref:ws},options);
  const request={operation_id:admitted.operation_id,task_id:'early-exit',attempt:3,generation:admitted.generation,revision:admitted.revision,
    launch_id:'early-exit-launch',launch_epoch:1,launch_token:'early-exit-token-with-sufficient-entropy'};
  let spawnCalls=0;t.after(()=>s.close());
  const probe=createPlatformProbe({timeoutMs:10000});
  const result=await launchOnce(s,request,async()=>{
    spawnCalls++;const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    return child;
  },probe);
  assert.equal(result.state,'launch_outcome_unknown');assert.equal(result.reason,'identity_unavailable');
  assert.equal(spawnCalls,1);assert.equal(s.readOperation(request.operation_id).launch_receipt_id,null);
  assert.equal(s.readOperation(request.operation_id).phase,'launch_intent');
});

test('projection, initial event, and capacity slot roll back together on known failure',()=>{
  const {r,s}=setup('rollback');s.close();const fault=IsolatedAdmissionStore.open(r,{fault:'after_projection'});
  capture(()=>admit(fault,input(),options),'injected_failure');fault.close();
  const check=IsolatedAdmissionStore.open(r);const snap=check.readSnapshot();assert.equal(snap.operations.filter(x=>x.operation_kind==='attempt_lifecycle').length,0);assert.equal(snap.events.filter(x=>x.event_type==='reserved').length,0);
  const admitted=admit(check,input(),options);assert.equal(admitted.capacity_slot,1);check.close();
});

test('revision CAS rejects stale input and commits same-phase evidence atomically',()=>{
  const {s}=setup('cas');const a=admit(s,input(),options);
  const evidence={reason:'observed',evidence_digest:'a'.repeat(64)};
  assert.equal(s.compareAndSwapObservation({operation_id:a.operation_id,generation:11,revision:1,evidence}).revision,2);
  capture(()=>s.compareAndSwapObservation({operation_id:a.operation_id,generation:11,revision:1,evidence}),'stale_operation_cas');
  capture(()=>s.compareAndSwapObservation({operation_id:a.operation_id,generation:11,revision:2,evidence:{...evidence,extra:'not allowed'}}),'invalid_evidence');
  capture(()=>s.compareAndSwapObservation({operation_id:a.operation_id,generation:11,revision:2,evidence:{reason:'x'.repeat(257),evidence_digest:'b'.repeat(64)}}),'invalid_evidence');
  assert.equal(s.readOperation(a.operation_id).revision,2);s.close();
});

test('unsupported schema and policy mismatch fail closed',()=>{
  const {r,s}=setup('schema');s.close();let db=new DatabaseSync(path.join(r,'operations.sqlite3'));db.exec('PRAGMA user_version=77');db.close();
  capture(()=>IsolatedAdmissionStore.open(r),'schema_version_unknown');
  const r2=root('policy-mismatch');let x=IsolatedAdmissionStore.initialize(r2);x.close();seed(r2,[['pm',1,1]]);x=IsolatedAdmissionStore.open(r2);x.provisionCapacity({operation_id:'p',capacity_limit:1,maintenance:{dispatch_blocked:true,writers_drained:true}});x.close();
  // Corrupt the policy projection without touching production or accepted artifacts.
  db=new DatabaseSync(path.join(r2,'operations.sqlite3'));db.exec('PRAGMA writable_schema=ON; UPDATE authority_metadata SET capacity_limit=2');db.close();
  capture(()=>IsolatedAdmissionStore.open(r2),'policy_or_schema_mismatch');
});

test('corrupt database fails closed without JSON fallback',()=>{
  const r=root('corrupt');writeFileSync(path.join(r,'operations.sqlite3'),'not a sqlite database');capture(()=>IsolatedAdmissionStore.open(r),'database_unreadable');
});

test('Workspace validation and execution permission deny or unknown fail before operation creation',()=>{
  const {s}=setup('gates');const valid=workspace('gate');
  const nonDirectory=path.join(TEMP,'not-a-directory.txt');writeFileSync(nonDirectory,'fixture');
  for(const [bad,expected] of [[undefined,'workspace_missing'],['','workspace_missing'],['relative/path','workspace_not_absolute'],[path.join(TEMP,'missing'),'workspace_unavailable'],[nonDirectory,'workspace_not_directory']])
    capture(()=>admit(s,{...input('t1',1,11,`bad-${String(bad)}`),workspace_ref:bad},options),expected);
  capture(()=>admit(s,input('t1',1,11,'deny-perm',valid),{workspaceValidator:allow,executionPermissionCheck:()=>({state:'deny'})}),'execution_permission_denied');
  capture(()=>admit(s,input('t1',1,11,'unknown-perm',valid),{workspaceValidator:allow,executionPermissionCheck:()=>({state:'unknown'})}),'execution_permission_unknown');
  capture(()=>admit(s,input('t1',1,11,'unknown-validation',valid),{workspaceValidator:()=>({state:'unknown'}),executionPermissionCheck:allow}),'workspace_validation_unknown');
  assert.equal(s.readSnapshot().operations.filter(x=>x.operation_kind==='attempt_lifecycle').length,0);s.close();
});

test('unknown commit and rollback outcomes poison across connection reopen and child process',async()=>{
  for(const fault of ['commit_ack_lost','rollback_unknown']){
    const {r,s}=setup(`poison-${fault}`);s.close();
    // Keep a peer SQLite connection open before the second connection reaches an unknown outcome.
    const peer=IsolatedAdmissionStore.open(r);const f=IsolatedAdmissionStore.open(r,{fault});
    const code='transaction_outcome_unknown';
    capture(()=>admit(f,input(),options),code);f.close();
    capture(()=>admit(peer,input('t2',1,21,`peer-${fault}`),options),'root_poisoned');peer.close();
    assert.ok(existsSync(path.join(r,'ROOT_POISONED.json')));capture(()=>IsolatedAdmissionStore.open(r),'root_poisoned');
    const result=await child([r,'t2','1','21',workspace('poison-child')]);assert.equal(result.out.ok,false);assert.equal(result.out.code,'root_poisoned');
    const marker=JSON.parse(readFileSync(path.join(r,'ROOT_POISONED.json'),'utf8'));assert.match(marker.reason,/outcome_unknown/);
  }
});

test('interrupted durable writer intent blocks a fresh child after reopen without poison marker or cleanup',async()=>{
  const {r,s}=setup('interrupted-intent');s.close();
  // Simulate the durable on-disk state left by an interrupted process. The test
  // does not claim to kill a process at a particular SQLite instruction.
  const intentPath=path.join(r,'WRITER_INTENT.json');const intent={version:1,token:'interrupted-writer-no-pid-or-timeout-reaping'};
  const fd=openSync(intentPath,'wx',0o600);try{writeFileSync(fd,JSON.stringify(intent));fsyncSync(fd);}finally{closeSync(fd);}
  assert.equal(existsSync(path.join(r,'ROOT_POISONED.json')),false);
  const result=await child([r,'t1','1','11',workspace('interrupted-intent')]);
  assert.equal(result.out.ok,false);assert.equal(result.out.code,'root_writer_busy');
  assert.equal(existsSync(path.join(r,'ROOT_POISONED.json')),false);
  assert.deepEqual(JSON.parse(readFileSync(intentPath,'utf8')),intent);
  const reopened=IsolatedAdmissionStore.open(r);capture(()=>admit(reopened,input(),options),'root_writer_busy');
  assert.deepEqual(JSON.parse(readFileSync(intentPath,'utf8')),intent);reopened.close();
});

test('completed lifecycle history remains structurally readable; released history does not block controlled policy maintenance',()=>{
  const {r,s}=setup('future-phase-enum',2);const a=admit(s,input(),options);s.close();
  const store=IsolatedAdmissionStore.open(r);const intent=launchInput(store,a.operation_id);store.createLaunchIntent(intent);
  const receipt=receiptInput(intent,intent.revision+1);store.recordLaunchReceipt(receipt);
  const claim=claimInput(intent,intent.revision+2);store.commitPermanentClaim(claim);
  const running=store.readOperation(a.operation_id);store.commitResult({operation_id:a.operation_id,task_id:running.task_id,attempt:running.attempt,
    generation:running.generation,revision:running.revision,claim_id:claim.claim_id,claim_worker_identity_digest:running.claim_worker_identity_digest,
    result_status:'completed',result:{task_id:running.task_id,attempt:running.attempt,status:'completed',summary:'fixture result',files_changed:[],tests:[],issues:[],
      needs_master_decision:false,zcode_output:'',exit_code:0,session_id:null,started_at:'2026-10-23T00:00:00.000Z',finished_at:'2026-10-23T00:00:01.000Z'}});
  const resultCommitted=store.readOperation(a.operation_id);
  const cleanupRequest={operation_id:a.operation_id,task_id:resultCommitted.task_id,attempt:resultCommitted.attempt,generation:resultCommitted.generation,
    revision:resultCommitted.revision,claim_id:resultCommitted.claim_id,claim_worker_identity_digest:resultCommitted.claim_worker_identity_digest};
  const cleanupPending=store.beginCleanup(cleanupRequest);
  const worker=JSON.parse(resultCommitted.claim_worker_identity_json);
  const cleanupEvidence={source:'synthetic_fixture',fixture:true,operation_id:a.operation_id,task_id:resultCommitted.task_id,attempt:resultCommitted.attempt,
    generation:resultCommitted.generation,claim_id:resultCommitted.claim_id,worker_identity_digest:resultCommitted.claim_worker_identity_digest,
    launch_receipt_digest:resultCommitted.launch_receipt_digest,result_commit_ref:resultCommitted.result_commit_ref,
    process_tree_digest:digest({operation_id:a.operation_id,root_process_id:worker.process_id,root_start_fingerprint:worker.start_fingerprint,children:[]}),
    resources_digest:digest({operation_id:a.operation_id,resources:[]}),root_process_id:worker.process_id,root_start_fingerprint:worker.start_fingerprint,
    worker_tree_complete:true,operation_resources_complete:true,workspace_touched:false};
  const cleanupVerified=store.recordCleanupEvidence({...cleanupRequest,revision:cleanupPending.revision,outcome:'verified',cleanup_evidence:cleanupEvidence});
  const released=store.releaseCapacity({...cleanupRequest,revision:cleanupVerified.revision,cleanup_digest:cleanupVerified.cleanup_digest});
  assert.equal(cleanupPending.phase,'cleanup_pending');assert.equal(cleanupVerified.phase,'cleanup_verified');assert.equal(released.phase,'released');
  store.close();
  const reopened=IsolatedAdmissionStore.open(r);assert.equal(reopened.readOperation(a.operation_id).phase,'released');
  assert.deepEqual(reopened.readLifecycleEvents(a.operation_id).map(event=>event.event_type),
    ['reserved','launch_intent','launch_receipt','claim_committed','result_committed','cleanup_pending','cleanup_verified','released']);
  assert.equal(reopened.provisionCapacity({operation_id:'policy-2',capacity_limit:3,expected_generation:1,maintenance:{dispatch_blocked:true,writers_drained:true}}).generation,2);
  reopened.assertCapacityPolicy(3);reopened.close();
});

test('launch_failed phase/event remains structurally readable without adding a retry or transition API',()=>{
  const {r,s}=setup('launch-failed-enum');const a=admit(s,input(),options);const intent=launchInput(s,a.operation_id);s.createLaunchIntent(intent);s.close();
  fixtureTransition(r,a.operation_id,11,3,'launch_intent','launch_failed','launch_failed',{reason:'synthetic evidence only',evidence_digest:'5'.repeat(64)});
  const reopened=IsolatedAdmissionStore.open(r);assert.equal(reopened.readOperation(a.operation_id).phase,'launch_failed');reopened.close();
});

test('reopened connections enforce foreign keys and policy history remains generation-CAS complete',()=>{
  const {r,s}=setup('fk-policy-history');s.close();
  const reopened=IsolatedAdmissionStore.open(r);
  assert.equal(reopened.foreignKeysEnabled,true);
  reopened.provisionCapacity({operation_id:'policy-2',capacity_limit:2,expected_generation:1,maintenance:{dispatch_blocked:true,writers_drained:true}});
  reopened.close();
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));
  try { db.exec('UPDATE authority_metadata SET policy_generation=3'); } finally { db.close(); }
  capture(()=>IsolatedAdmissionStore.open(r),'policy_or_schema_mismatch');
});

test('integrity validation rejects active slot count above the current policy',()=>{
  const {r,s}=setup('active-capacity-overrun',1);admit(s,input('t1',1,11,'overrun-1'),options);s.close();
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    db.prepare("INSERT INTO manager_operations(operation_id,operation_kind,request_digest,task_id,attempt,generation,reservation_id,revision,phase,capacity_slot,workspace_ref,workspace_identity_json,created_at) VALUES(?,'attempt_lifecycle',?, ?,1,21,?,1,'reserved',2,?,NULL,?)")
      .run('overrun-2',digest({fixture:true}),'t2','overrun-reservation-2',workspace('overrun'),'2026-10-22T00:00:00.000Z');
    const evidence={reservation_id:'overrun-reservation-2',capacity_slot:2};const json=canonical(evidence);
    const cursor=db.prepare('SELECT next_event_cursor FROM authority_metadata WHERE singleton=1').get().next_event_cursor+1;
    const updated=db.prepare('UPDATE authority_metadata SET next_event_cursor=? WHERE singleton=1 AND next_event_cursor=?').run(cursor,cursor-1);
    assert.equal(updated.changes,1);
    db.prepare('INSERT INTO manager_operation_events(event_cursor,operation_id,sequence,event_type,from_phase,to_phase,generation,evidence_json,evidence_digest,at) VALUES(?, ?,1,\'reserved\',NULL,\'reserved\',21,?,?,?)').run(cursor,'overrun-2',json,digest(json),'2026-10-22T00:00:00.000Z');db.exec('COMMIT');
  } catch(e){try{db.exec('ROLLBACK');}catch{}throw e;} finally {db.close();}
  capture(()=>IsolatedAdmissionStore.open(r),'active_capacity_invariant');
});

test('SQLite busy lock is classified as retryable and does not poison the root',()=>{
  const {r,s}=setup('sqlite-busy');
  const blocker=new DatabaseSync(path.join(r,'operations.sqlite3'));blocker.exec('BEGIN IMMEDIATE');
  capture(()=>admit(s,input(),options),'root_writer_busy');
  blocker.exec('ROLLBACK');blocker.close();
  assert.equal(existsSync(path.join(r,'ROOT_POISONED.json')),false);
  assert.equal(admit(s,input(),options).phase,'reserved');s.close();
});

test('synthetic database and poison links are rejected before SQLite open',t=>{
  for(const entry of ['operations.sqlite3','operations.sqlite3-wal','operations.sqlite3-shm','ROOT_POISONED.json','WRITER_INTENT.json']){
    const r=root(`root-link-${entry}`);const target=path.join(r,'target.txt');writeFileSync(target,'fixture');
    try { symlinkSync(target,path.join(r,entry),'file'); }
    catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip(`file symlink unsupported: ${e.code}`);return;}throw e;}
    capture(()=>IsolatedAdmissionStore.open(r),'unsafe_root_entry');
  }
});

test('Launch Intent is exact-CAS, replay-safe, and does not assert that a process started',()=>{
  const {r,s}=setup('launch-intent',1);const admitted=admit(s,input(),options);const intent=launchInput(s,admitted.operation_id);
  const first=s.createLaunchIntent(intent);assert.equal(first.phase,'launch_intent');assert.equal(first.revision,2);assert.equal(first.process_started,'unknown');
  assert.equal(s.createLaunchIntent(intent).duplicate,true);
  capture(()=>s.createLaunchIntent({...intent,launch_id:'different-launch'}),'launch_intent_conflict');
  capture(()=>s.createLaunchIntent({...intent,revision:0}),'invalid_launch_intent');
  capture(()=>s.createLaunchIntent({...intent,generation:intent.generation+1}),'operation_identity_mismatch');
  const current=s.readOperation(admitted.operation_id);assert.equal(current.revision,2);assert.equal(current.launch_outcome,'unknown_receipt_missing');
  capture(()=>admit(s,input('t2',1,21,'blocked-by-intent'),options),'capacity_exhausted');s.close();
  const reopened=IsolatedAdmissionStore.open(r);assert.equal(reopened.readSnapshot().operations[0].launch_outcome,'unknown_receipt_missing');reopened.close();
});

test('Launch Receipt validates Intent identity/token/epoch, supports delayed and exact duplicate receipt',()=>{
  const {r,s}=setup('launch-receipt',2);const a=admit(s,input(),options);const b=admit(s,input('t2',1,21,'op-t2-1'),options);
  const intent=launchInput(s,a.operation_id);s.createLaunchIntent(intent);const delayed=receiptInput(intent);
  const missing=s.readOperation(a.operation_id);assert.equal(missing.launch_outcome,'unknown_receipt_missing');
  capture(()=>s.recordLaunchReceipt({...delayed,launch_id:'other-launch'}),'launch_receipt_intent_mismatch');
  capture(()=>s.recordLaunchReceipt({...delayed,launch_epoch:delayed.launch_epoch+1}),'launch_receipt_intent_mismatch');
  capture(()=>s.recordLaunchReceipt({...delayed,launch_token:'wrong-token-for-this-launch'}),'launch_receipt_intent_mismatch');
  capture(()=>s.recordLaunchReceipt({...delayed,launch_identity:{source:'os',fixture:false,process_id:43210,start_fingerprint:'unverified'}}),'invalid_synthetic_launch_identity');
  capture(()=>s.recordLaunchReceipt({...delayed,task_id:'t2',attempt:1}),'operation_identity_mismatch');
  capture(()=>s.recordLaunchReceipt({...delayed,revision:1}),'stale_launch_cas');
  const receipt=s.recordLaunchReceipt(delayed);assert.equal(receipt.phase,'launch_intent');assert.equal(receipt.process_started,'not_independently_verified');assert.equal(receipt.synthetic,true);
  assert.equal(s.recordLaunchReceipt(delayed).duplicate,true);
  capture(()=>s.recordLaunchReceipt({...delayed,launch_identity:{...delayed.launch_identity,process_id:43211}}),'launch_receipt_conflict');
  const o=s.readOperation(a.operation_id);assert.equal(o.revision,3);assert.equal(o.launch_outcome,'receipt_recorded_process_unverified');
  assert.equal(s.readOperation(b.operation_id).launch_outcome,'not_requested');s.close();
});

test('Permanent Claim requires matching Receipt and atomically sets Task, Attempt, and Operation running',()=>{
  const {r,s}=setup('permanent-claim',1);const a=admit(s,input(),options);const intent=launchInput(s,a.operation_id);s.createLaunchIntent(intent);
  const claim=claimInput(intent,2);capture(()=>s.commitPermanentClaim(claim),'launch_receipt_required');
  const receipt=receiptInput(intent);s.recordLaunchReceipt(receipt);
  capture(()=>s.commitPermanentClaim({...claim,revision:2}),'stale_claim_cas');
  capture(()=>s.commitPermanentClaim({...claim,task_id:'t2',attempt:1}),'operation_identity_mismatch');
  capture(()=>s.commitPermanentClaim({...claim,generation:claim.generation+1}),'operation_identity_mismatch');
  capture(()=>s.commitPermanentClaim({...claim,launch_token:'different-launch-token-000000000'}),'claim_launch_mismatch');
  capture(()=>s.commitPermanentClaim({...claim,worker_identity:{...claim.worker_identity,process_id:99999}}),'claim_worker_launch_identity_mismatch');
  capture(()=>s.commitPermanentClaim({...claim,worker_identity:{...claim.worker_identity,source:'worker-self-report'}}),'invalid_synthetic_worker_identity');
  const committed=s.commitPermanentClaim({...claim,revision:3});assert.equal(committed.phase,'running');assert.equal(committed.claim_permanent,true);assert.equal(committed.synthetic,true);
  assert.equal(s.readOperation(a.operation_id).claim_status,'permanent_claim_recorded');
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));try{
    assert.equal(db.prepare('SELECT status FROM tasks WHERE task_id=?').get('t1').status,'running');
    assert.equal(db.prepare('SELECT status FROM attempts WHERE task_id=? AND attempt=1').get('t1').status,'running');
    assert.equal(db.prepare('SELECT phase FROM manager_operations WHERE operation_id=?').get(a.operation_id).phase,'running');
    assert.equal(db.prepare("SELECT event_type FROM manager_operation_events WHERE operation_id=? ORDER BY sequence DESC LIMIT 1").get(a.operation_id).event_type,'claim_committed');
  }finally{db.close();}
  capture(()=>admit(s,input('t2',1,21,'slot-stays-occupied'),options),'capacity_exhausted');s.close();
  const reopened=IsolatedAdmissionStore.open(r);assert.equal(reopened.readOperation(a.operation_id).claim_id,claim.claim_id);
  assert.equal(reopened.commitPermanentClaim({...claim,revision:3}).duplicate,true);
  capture(()=>reopened.commitPermanentClaim({...claim,worker_identity:{...claim.worker_identity,worker_id:'different-worker'}}),'claim_conflict');
  assert.equal(typeof reopened.releaseClaim,'undefined');reopened.close();
});

test('two child processes compete for one Launch Intent; winner is unique and retry is idempotent',async()=>{
  const {r,s}=setup('intent-process-race',2);const a=admit(s,input(),options);s.close();
  const store=IsolatedAdmissionStore.open(r),intent=launchInput(store,a.operation_id);store.close();
  const results=await Promise.all([lifecycleChild('intent',r,intent),lifecycleChild('intent',r,intent)]);
  assert.equal(results.filter(x=>x.out.ok&&!x.out.result.duplicate).length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>x.out.ok&&x.out.result.duplicate).length+results.filter(x=>x.out.code==='root_writer_busy').length,1,JSON.stringify(results));
  const retry=await lifecycleChild('intent',r,intent);assert.equal(retry.out.ok,true);assert.equal(retry.out.result.duplicate,true);
  const verify=IsolatedAdmissionStore.open(r);assert.equal(verify.readOperation(a.operation_id).revision,2);verify.close();
});

test('two child processes racing distinct Launch IDs cannot create two launch permits',async()=>{
  const {r,s}=setup('intent-distinct-process-race',2);const a=admit(s,input(),options);s.close();
  const store=IsolatedAdmissionStore.open(r),first=launchInput(store,a.operation_id);store.close();
  const second={...first,launch_id:`${first.launch_id}-challenger`,launch_token:`${first.launch_token}-challenger`};
  const requests=[first,second],results=await Promise.all(requests.map(req=>lifecycleChild('intent',r,req)));
  assert.equal(results.filter(x=>x.out.ok&&!x.out.result.duplicate).length,1,JSON.stringify(results));
  const loser=results.findIndex(x=>!x.out.ok);assert.ok(loser>=0,JSON.stringify(results));
  if(results[loser].out.code==='root_writer_busy'){
    const retry=await lifecycleChild('intent',r,requests[loser]);assert.equal(retry.out.code,'launch_intent_conflict');
  } else assert.equal(results[loser].out.code,'launch_intent_conflict');
  const verify=IsolatedAdmissionStore.open(r);assert.equal(verify.readSnapshot().events.filter(e=>e.event_type==='launch_intent').length,1);verify.close();
});

test('two child processes compete for one permanent Claim; same identity retry stays permanent',async()=>{
  const {r,s}=setup('claim-process-race',2);const a=admit(s,input(),options),intent=launchInput(s,a.operation_id);s.createLaunchIntent(intent);s.recordLaunchReceipt(receiptInput(intent));s.close();
  const store=IsolatedAdmissionStore.open(r),claim=claimInput(intent,3);store.close();
  const results=await Promise.all([lifecycleChild('claim',r,claim),lifecycleChild('claim',r,claim)]);
  assert.equal(results.filter(x=>x.out.ok&&!x.out.result.duplicate).length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>x.out.ok&&x.out.result.duplicate).length+results.filter(x=>x.out.code==='root_writer_busy').length,1,JSON.stringify(results));
  const retry=await lifecycleChild('claim',r,claim);assert.equal(retry.out.ok,true);assert.equal(retry.out.result.duplicate,true);
  const verify=IsolatedAdmissionStore.open(r);assert.equal(verify.readOperation(a.operation_id).phase,'running');verify.close();
});

test('same Workspace permits distinct Attempts to hold independent Launch and Claim facts',()=>{
  const {r,s}=setup('shared-workspace-launch',2);const ws=workspace('same-workspace-launch');
  const a=admit(s,input('t1',1,11,'shared-launch-a',ws),options),b=admit(s,input('t2',1,21,'shared-launch-b',ws),options);
  for(const aop of [a,b]){const intent=launchInput(s,aop.operation_id);s.createLaunchIntent(intent);s.recordLaunchReceipt(receiptInput(intent));s.commitPermanentClaim(claimInput(intent,3,`worker-${aop.operation_id}`));}
  assert.equal(s.readSnapshot().operations.filter(o=>o.phase==='running').length,2);s.close();
});

test('known rollback keeps Intent, Receipt, Claim, Task status, and event projection unchanged',()=>{
  const {r,s}=setup('lifecycle-known-rollback',2);const a=admit(s,input(),options);const intent=launchInput(s,a.operation_id);s.close();
  let fault=IsolatedAdmissionStore.open(r,{fault:'after_projection'});capture(()=>fault.createLaunchIntent(intent),'injected_failure');fault.close();
  let check=IsolatedAdmissionStore.open(r);assert.equal(check.readOperation(a.operation_id).phase,'reserved');assert.equal(check.readSnapshot().events.filter(e=>e.event_type==='launch_intent').length,0);check.createLaunchIntent(intent);check.close();
  const delayed=receiptInput(intent);fault=IsolatedAdmissionStore.open(r,{fault:'after_projection'});capture(()=>fault.recordLaunchReceipt(delayed),'injected_failure');fault.close();
  check=IsolatedAdmissionStore.open(r);assert.equal(check.readOperation(a.operation_id).launch_receipt_digest,null);check.recordLaunchReceipt(delayed);check.close();
  const claim=claimInput(intent,3);fault=IsolatedAdmissionStore.open(r,{fault:'after_projection'});capture(()=>fault.commitPermanentClaim(claim),'injected_failure');fault.close();
  check=IsolatedAdmissionStore.open(r);assert.equal(check.readOperation(a.operation_id).phase,'launch_intent');
  const db=new DatabaseSync(path.join(r,'operations.sqlite3'));try{
    assert.equal(db.prepare('SELECT status FROM tasks WHERE task_id=?').get('t1').status,'queued');
    assert.equal(db.prepare('SELECT status FROM attempts WHERE task_id=?').get('t1').status,'queued');
  }finally{db.close();}
  assert.equal(check.readSnapshot().events.filter(e=>e.event_type==='claim_committed').length,0);assert.equal(check.commitPermanentClaim(claim).phase,'running');check.close();
});

test('unknown Launch Intent commit and Claim rollback poison the root across reopen',()=>{
  for(const faultName of ['commit_ack_lost','rollback_unknown']){
    const {r,s}=setup(`lifecycle-${faultName}`,1);const a=admit(s,input(),options),intent=launchInput(s,a.operation_id);s.close();
    let store;
    if(faultName==='commit_ack_lost'){store=IsolatedAdmissionStore.open(r,{fault:faultName});capture(()=>store.createLaunchIntent(intent),'transaction_outcome_unknown');}
    else {store=IsolatedAdmissionStore.open(r);store.createLaunchIntent(intent);store.close();const receiptStore=IsolatedAdmissionStore.open(r);receiptStore.recordLaunchReceipt(receiptInput(intent));receiptStore.close();store=IsolatedAdmissionStore.open(r,{fault:'rollback_unknown'});capture(()=>store.commitPermanentClaim(claimInput(intent,3)),'transaction_outcome_unknown');}
    store.close();assert.ok(existsSync(path.join(r,'ROOT_POISONED.json')));capture(()=>IsolatedAdmissionStore.open(r),'root_poisoned');
  }
});

test('SQLite BUSY while persisting Launch Intent is retryable after lock release',()=>{
  const {r,s}=setup('launch-busy',1);const a=admit(s,input(),options),intent=launchInput(s,a.operation_id);
  const blocker=new DatabaseSync(path.join(r,'operations.sqlite3'));blocker.exec('BEGIN IMMEDIATE');
  capture(()=>s.createLaunchIntent(intent),'root_writer_busy');blocker.exec('ROLLBACK');blocker.close();
  assert.equal(s.createLaunchIntent(intent).phase,'launch_intent');s.close();
});
