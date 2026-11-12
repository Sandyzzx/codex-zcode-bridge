import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import fs, {statSync,existsSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {canonical,canonicalTaskResult,MAX_TASK_RESULT_BYTES as MAX,MAX_WORKER_RESULT_FRAME_BYTES as FRAME,prepareWorkerResultFrame,validateAgentReport} from '../src/result-contract.mjs';
import {IsolatedAdmissionStore,digest} from '../src/sqlite-candidate/wp6b2b1/store.mjs';
import {fixture,running,result} from './sqlite-v14-fixture.mjs';

function sized(bytes,unit='x'){
  const value=result();const overhead=Buffer.byteLength(canonical(value));
  const encoded=Buffer.byteLength(JSON.stringify(unit))-2;
  const count=Math.floor((bytes-overhead)/encoded);
  value.zcode_output=unit.repeat(count)+'x'.repeat(bytes-overhead-count*encoded);
  assert.equal(Buffer.byteLength(canonical(value)),bytes);return value;
}
const frame=value=>({protocol:'bridge-sqlite-candidate-result-v1',operation_id:'op-result',task_id:value.task_id,attempt:1,generation:1,workspace_ref:'workspace',policy_snapshot_digest:'a'.repeat(64),execution_cleanup_verified:false,execution_cleanup:null,result:value});

test('canonical contract counts UTF-8 after escaping; exact 32 MiB boundary for ASCII, Chinese, emoji, quotes, NUL and lone surrogate',()=>{
  for(const unit of ['x','中','😀','"','\u0000','\ud800'])for(const delta of [-1,0,1]){
    const value=sized(MAX+delta,unit);
    if(delta===1)assert.throws(()=>canonicalTaskResult(value,{task_id:value.task_id,attempt:1,result_status:value.status}),e=>e.code==='result_too_large'&&e.message.includes(String(MAX+1)));
    else assert.equal(Buffer.byteLength(canonicalTaskResult(value,{task_id:value.task_id,attempt:1,result_status:value.status})),MAX+delta);
  }
});
test('report text, arrays and partial report_candidate share semantics; identity metadata remains bounded',()=>{
  const value=result();value.summary='a\n\u0000😀';value.files_changed=Array.from({length:257},(_,i)=>'x'.repeat(4097)+i);value.issues=['\n\u0000'];value.tests=[{command:'\n\u0000',status:'passed',details:'😀'}];value.report_candidate={summary:'',issues:['\u0000']};
  assert.equal(validateAgentReport(value).ok,true);
  canonicalTaskResult(value,{task_id:value.task_id,attempt:1,result_status:value.status});
  assert.throws(()=>canonicalTaskResult({...value,session_id:'\u0000'},{task_id:value.task_id,attempt:1,result_status:value.status}),e=>e.code==='invalid_result_payload');
});
test('frame budget is Result bytes + exactly 256 KiB envelope; deterministic rejection produces explicit failure, not clipped success',()=>{
  const value=sized(MAX);
  const f=frame(value);let json=prepareWorkerResultFrame(f);
  assert.deepEqual(JSON.parse(json).result,value);
  f.workspace_ref+='x'.repeat(FRAME-Buffer.byteLength(json));
  json=prepareWorkerResultFrame(f);assert.equal(Buffer.byteLength(json),FRAME);
  assert.throws(()=>prepareWorkerResultFrame({...f,workspace_ref:f.workspace_ref+'x'}),e=>e.code==='result_envelope_too_large');
  const rejected=JSON.parse(prepareWorkerResultFrame(frame(sized(MAX+1))));
  assert.equal(rejected.result.status,'failed');assert.equal(rejected.result.error_code,'result_too_large');
  assert.match(rejected.result.summary,/33554433.*original report not committed/);
  const bad=JSON.parse(prepareWorkerResultFrame(frame({...result(),tests:[{command:'x',status:'unknown'}]})));
  assert.equal(bad.result.error_code,'invalid_result_payload');assert.equal(bad.execution_cleanup,null);
});
test('32 MiB canonical bytes persist unchanged, SQL rejects +1, digest/duplicate/CAS and Recovery preserve one commit',()=>{
  const root=fixture('result-boundary');const {store,fence}=running(root);
  const value=sized(MAX,'\u0000');const json=canonicalTaskResult(value,{...fence,result_status:'completed'});const start=performance.now();
  try{
    const committed=store.commitResult({...fence,result_status:'completed',result:value});
    assert.equal(committed.result_digest,digest({result_contract_version:1,result_status:'completed',result:value}));
    assert.equal(store.readCommittedResult(fence.operation_id).result.zcode_output,value.zcode_output);
    assert.equal(store.commitResult({...fence,result_status:'completed',result:value}).duplicate,true);
    const db=new DatabaseSync(path.join(root,'operations.sqlite3'));
    try{
      assert.equal(db.prepare('SELECT result_json FROM manager_operations WHERE operation_id=?').get(fence.operation_id).result_json,json);
      const columns=db.prepare('PRAGMA table_info(manager_operations)').all().map(x=>x.name);
      const row=db.prepare('SELECT * FROM manager_operations WHERE operation_id=?').get(fence.operation_id);
      // Isolate the SQL CHECK in an exact table clone without lifecycle triggers.
      const memory=new DatabaseSync(':memory:');try{
        memory.exec('PRAGMA foreign_keys=OFF');
        memory.exec(db.prepare("SELECT sql FROM sqlite_schema WHERE name='manager_operations'").get().sql);
        row.result_json=json+' ';row.operation_id='sql-over-limit';
        assert.throws(()=>memory.prepare('INSERT INTO manager_operations('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(c=>row[c])),/CHECK constraint failed/);
      }finally{memory.close();}
    }finally{db.close();}
    const recovery=IsolatedAdmissionStore.openForRecovery(root,{managedDataDirectory:true});try{
      const snapshot=recovery.readRecoverySnapshot();assert.equal(snapshot.root_status,'consistent_read_only');
      assert.equal(snapshot.operations.find(o=>o.operation_id===fence.operation_id).phase,'result_committed');
    }finally{recovery.close();}
    console.log('R2_BOUNDARY_RESOURCE',JSON.stringify({elapsed_ms:performance.now()-start,rss_bytes:process.memoryUsage().rss,max_rss_kib:process.resourceUsage().maxRSS,database_bytes:statSync(path.join(root,'operations.sqlite3')).size,wal_bytes:statSync(path.join(root,'operations.sqlite3-wal')).size}));
  }finally{store.close();}
});
test('no-result rejection is durable and Claim-fenced; it never releases a live or unknown Worker',()=>{
  const root=fixture('result-diagnostic');const {store,fence}=running(root);
  try{
    assert.throws(()=>store.recordResultSubmissionFailure({...fence,claim_id:'different'},'private_report_too_large'),e=>e.code==='stale_operation_cas');
    store.recordResultSubmissionFailure(fence,'private_report_too_large');
    assert.equal(store.readTaskLifecycle(fence.task_id).result_submission_error,'private_report_too_large');
    assert.equal(store.readOperation(fence.operation_id).phase,'running');assert.equal(store.readCommittedResult(fence.operation_id),null);
    assert.throws(()=>store.recordResultSubmissionFailure(fence,'private_report_too_large'),e=>e.code==='stale_operation_cas');
  }finally{store.close();}
  const reopened=IsolatedAdmissionStore.open(root,{managedDataDirectory:true});try{assert.equal(reopened.readTaskLifecycle('result-v14').result_submission_error,'private_report_too_large');}finally{reopened.close();}
});

test('repeated reads cannot mask an external WAL write or restored-trigger tampering',()=>{
  const root=fixture('snapshot-validation');const {store,fence}=running(root);
  try{
    for(let i=0;i<4;i++)assert.equal(store.readOperation(fence.operation_id).phase,'running');
    const other=IsolatedAdmissionStore.open(root,{managedDataDirectory:true});
    try{other.recordResultSubmissionFailure(fence,'test_external_failure');}finally{other.close();}
    assert.equal(store.readTaskLifecycle(fence.task_id).result_submission_error,'test_external_failure');
    const db=new DatabaseSync(path.join(root,'operations.sqlite3'));
    try{
      const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='events_no_update'").get().sql;
      db.exec('BEGIN IMMEDIATE; DROP TRIGGER events_no_update');
      db.prepare("UPDATE manager_operation_events SET evidence_digest=? WHERE operation_id=? AND sequence=1").run('0'.repeat(64),fence.operation_id);
      db.exec(trigger);db.exec('COMMIT');
    }finally{db.close();}
    assert.throws(()=>store.readTaskLifecycle(fence.task_id),e=>e.code==='projection_event_mismatch');
  }finally{store.close();}
});

test('lost COMMIT ACK remains uncertain when an ENOSPC fault prevents the poison file; original digest and writer fence survive',()=>{
  const root=fixture('commit-unknown-enospc');const {store,fence}=running(root);store.close();
  const fault=IsolatedAdmissionStore.open(root,{managedDataDirectory:true,fault:'commit_ack_lost'});
  const original=fs.openSync;
  fs.openSync=(file,...args)=>{
    if(String(file).startsWith(path.join(root,'ROOT_POISONED.json.')))throw Object.assign(new Error('isolated ENOSPC fault'),{code:'ENOSPC'});
    return original(file,...args);
  };
  syncBuiltinESMExports();
  try{
    assert.throws(()=>fault.commitResult({...fence,result_status:'completed',result:result()}),e=>e.code==='transaction_outcome_unknown');
    assert.equal(fault.poisoned,true);
  }finally{fs.openSync=original;syncBuiltinESMExports();fault.close();}
  assert.ok(existsSync(path.join(root,'WRITER_INTENT.json')));assert.ok(!existsSync(path.join(root,'ROOT_POISONED.json')));
  const reader=IsolatedAdmissionStore.openForRecovery(root,{managedDataDirectory:true});
  try{
    assert.equal(reader.readRecoverySnapshot().root_status,'blocked_read_only');
    assert.deepEqual(reader.readCommittedResult(fence.operation_id).result,result());
  }finally{reader.close();}
});
