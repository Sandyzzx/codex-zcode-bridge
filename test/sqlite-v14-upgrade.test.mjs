import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {IsolatedAdmissionStore,digest,canonical} from '../src/sqlite-candidate/wp6b2b1/store.mjs';
import {createSqliteLifecyclePort} from '../src/sqlite-candidate/wp6b2b1/lifecycle-port.mjs';
import {historicalResultExceptionSetDigest} from '../src/store/json-history-result-exceptions.mjs';
import {fixture,historicalV13,running,result} from './sqlite-v14-fixture.mjs';
const options={offline:true,expectedV13RuntimeRosterDigest:'a'.repeat(64),runtimeRosterDigest:'b'.repeat(64)};
function oldRoot(){
  const fresh=fixture('seed-v14');const s=IsolatedAdmissionStore.initialize(fresh,{managedDataDirectory:true,freshInstallReceiptId:'r2-historical',verifierVersion:'r2',freshInstallCapacityLimit:2});
  s.createTask({task_id:'old-task',workspace:fresh,objective:'old queued task',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]},'2026-11-05T00:00:00Z');
  s.cancelQueuedAttempt({task_id:'old-task',expected_attempt:1});s.close();
  const source=fixture('v13');historicalV13(fresh,source);return source;
}
test('explicit offline v13 copy upgrade preserves every row/event/digest and source bytes; v14 opens, v13 requires actionable upgrade',()=>{
  const source=oldRoot(),destination=fixture('v14');const before=readFileSync(path.join(source,'operations.sqlite3'));
  assert.throws(()=>IsolatedAdmissionStore.open(source,{managedDataDirectory:true}),e=>e.code==='schema_upgrade_required'&&e.message.includes('upgrade-sqlite-v14'));
  const receipt=IsolatedAdmissionStore.upgradeV13Copy(source,destination,options);
  assert.deepEqual(readFileSync(path.join(source,'operations.sqlite3')),before);
  for(const table of receipt.tables)if(table.table!=='authority_metadata')assert.equal(table.source_digest,table.destination_digest,table.table);
  const s=IsolatedAdmissionStore.open(destination,{managedDataDirectory:true});try{
    assert.equal(s.readTaskLifecycle('old-task').result.status,'cancelled');s.assertAuthorityReady();
  }finally{s.close();}
  assert.ok(existsSync(path.join(destination,'v14-upgrade-receipt.json')));
});
test('upgrade refuses active/unknown lifecycle, marker, schema drift, occupied destination, online invocation and active writer',()=>{
  const active=fixture('active');const {store}=running(active);store.close();
  const old=fixture('active-v13');historicalV13(active,old);
  assert.throws(()=>IsolatedAdmissionStore.upgradeV13Copy(old,fixture('active-dest'),options),e=>e.code==='upgrade_active_operations');
  const source=oldRoot();
  assert.throws(()=>IsolatedAdmissionStore.upgradeV13Copy(source,fixture('online-dest'),{...options,offline:false}),e=>e.code==='offline_upgrade_required');
  writeFileSync(path.join(source,'WRITER_INTENT.json'),'unknown');
  assert.throws(()=>IsolatedAdmissionStore.upgradeV13Copy(source,fixture('blocked-dest'),options),e=>e.code==='upgrade_source_blocked');
  const locked=oldRoot();const db=new DatabaseSync(path.join(locked,'operations.sqlite3'));db.exec('BEGIN IMMEDIATE');
  try{assert.throws(()=>IsolatedAdmissionStore.upgradeV13Copy(locked,fixture('locked-dest'),options),/locked|busy/);}finally{db.exec('ROLLBACK');db.close();}
  const occupied=fixture('occupied');writeFileSync(path.join(occupied,'keep'),'WIP');
  assert.throws(()=>IsolatedAdmissionStore.upgradeV13Copy(oldRoot(),occupied,options),e=>e.code==='upgrade_destination_not_empty');
});
test('failed destination is fenced, source is intact and the CLI can be retried into another empty root',()=>{
  const source=oldRoot(),destination=fixture('injected-failure');const before=readFileSync(path.join(source,'operations.sqlite3'));
  assert.throws(()=>IsolatedAdmissionStore.upgradeV13Copy(source,destination,{...options,onStage(stage){if(stage==='destination_verified')throw new Error('injected publish failure');}}),/injected publish failure/);
  assert.deepEqual(readFileSync(path.join(source,'operations.sqlite3')),before);
  assert.ok(existsSync(path.join(destination,'ROOT_POISONED.json')));assert.ok(existsSync(path.join(destination,'operations.sqlite3.bootstrap-pending.json')));
  assert.throws(()=>IsolatedAdmissionStore.open(destination,{managedDataDirectory:true}),e=>e.code==='sqlite_bootstrap_pending');
  IsolatedAdmissionStore.upgradeV13Copy(source,fixture('retry-destination'),options);
});

test('v13 published raw-cutover receipt and archive identity survive upgrade; runtime roster is explicitly rebound',()=>{
  const seed=fixture('cutover-seed');const s=IsolatedAdmissionStore.initialize(seed,{managedDataDirectory:true});
  const archive={archive_directory:fixture('archive'),source_tasks_root:fixture('legacy-archive-source'),manifest_digest:'c'.repeat(64),file_count:0,byte_count:0};
  const manifest={kind:'raw_json_archive_cutover',files:[],task_count:0,result_count:0,event_count:0,artifact_count:0,artifact_bytes:0,
    source_tasks_root:archive.source_tasks_root,source_files_digest:digest([]),archive_manifest_digest:archive.manifest_digest,archive_file_count:0,archive_byte_count:0,
    historical_exceptions:[],historical_exception_count:0,historical_exception_digest:historicalResultExceptionSetDigest([])};
  const source={root_digest:'d'.repeat(64),manifest_json:canonical(manifest),manifest_digest:digest(canonical(manifest))};
  const receipt={schema_version:1,state:'authority_switch_receipt',cutover_id:'r2-cutover',migration_id:'r2-migration',source_root_digest:source.root_digest,
    source_manifest_digest:source.manifest_digest,database_file:'operations.sqlite3',archive,created_at:'2026-11-05T00:00:00Z'};
  try{
    s.recordRawJsonArchiveCutover({schema_version:1,cutover_id:receipt.cutover_id,migration_id:receipt.migration_id,source,archive,protocol_version:'wp6-stop-world-json-sqlite-v1',runtime_roster_digest:'b'.repeat(64),verifier_version:'wp6-json-cutover-v1'});
    writeFileSync(path.join(seed,'operations.sqlite3.cutover-published.json'),JSON.stringify(receipt));
    s.provisionCapacity({operation_id:'r2-policy',capacity_limit:8,expected_generation:0,maintenance:{dispatch_blocked:true,writers_drained:true}});
  }finally{s.close();}
  const old=fixture('cutover-v13');historicalV13(seed,old,{oldRoster:'a'.repeat(64)});
  writeFileSync(path.join(old,'operations.sqlite3.cutover-published.json'),JSON.stringify(receipt));
  const target=fixture('cutover-v14');const upgraded=IsolatedAdmissionStore.upgradeV13Copy(old,target,options);
  const check=IsolatedAdmissionStore.open(target,{managedDataDirectory:true});try{assert.equal(check.assertAuthorityReady('b'.repeat(64)).cutover_id,receipt.cutover_id);}finally{check.close();}
  assert.equal(readFileSync(path.join(target,'operations.sqlite3.cutover-published.json'),'utf8'),JSON.stringify(receipt));
  assert.ok(upgraded.tables.find(x=>x.table==='authority_switch').source_digest!==upgraded.tables.find(x=>x.table==='authority_switch').destination_digest);
  assert.throws(()=>IsolatedAdmissionStore.upgradeV13Copy(old,fixture('wrong-roster'),{...options,expectedV13RuntimeRosterDigest:'e'.repeat(64)}),e=>e.code==='authority_runtime_roster_mismatch');
});

test('previously authorized administrative abandonment migrates unchanged and is not converted to a Result or Cleanup Verified',()=>{
  const seed=fixture('admin-seed');const {store,fence}=running(seed,'result-v14',true);
  const evidence={source:'manager_cleanup_probe',operation_id:fence.operation_id,task_id:fence.task_id,attempt:1,generation:fence.generation,claim_id:fence.claim_id,worker_identity_digest:fence.claim_worker_identity_digest,probe:'unknown'};
  const port=createSqliteLifecyclePort(store,{recoveryEvidenceVerifier:({observation})=>({classification:observation.classification,reason_code:observation.reason_code,evidence_source:observation.evidence_source,evidence_digest:observation.evidence_digest})});
  try{
    const recorded=port.recordRecoveryObservation({operation_id:fence.operation_id,task_id:fence.task_id,attempt:1,generation:fence.generation,expected_revision:fence.revision,claim_id:fence.claim_id,worker_identity_digest:fence.claim_worker_identity_digest,classification:'hold',reason_code:'cleanup_incomplete',evidence_source:'manager_cleanup_probe',evidence_digest:digest(evidence)},evidence);
    const event=store.readLifecycleEvents(fence.operation_id).find(e=>e.sequence===recorded.event_sequence);
    store.adminAbandonHeldOperation({...fence,revision:recorded.revision,evidence:{boot_time:new Date(Date.parse(event.at)+60000).toISOString(),failed_at:event.at,
      hosts_closed:true,writer_closed:true,worker_exited:true,claimant_scan_clean:true,process_inventory_digest:'a'.repeat(64),platform_probe_digest:'b'.repeat(64),claimant_scan_digest:'c'.repeat(64),worker_process_id:41001,worker_start_fingerprint:'r2-start',observed_at:new Date(Date.parse(event.at)+120000).toISOString()}});
  }finally{store.close();}
  const old=fixture('admin-v13');historicalV13(seed,old);const target=fixture('admin-v14');
  const receipt=IsolatedAdmissionStore.upgradeV13Copy(old,target,options);
  assert.equal(receipt.tables.find(x=>x.table==='manager_admin_abandonments').source_digest,receipt.tables.find(x=>x.table==='manager_admin_abandonments').destination_digest);
  const checked=IsolatedAdmissionStore.open(target,{managedDataDirectory:true});try{
    assert.equal(checked.readOperation(fence.operation_id).phase,'admin_abandoned');assert.equal(checked.readCommittedResult(fence.operation_id),null);
  }finally{checked.close();}
});

test('shipped standalone upgrade command validates an isolated copy and leaves the source version unchanged',()=>{
  const old=oldRoot(),target=fixture('packaged-upgrade');
  const command=path.resolve('plugins/codex-zcode-bridge/dist/upgrade-sqlite-v14.mjs');
  const output=execFileSync(process.execPath,[command,'--source',old,'--destination',target,'--database','operations.sqlite3','--offline'],{encoding:'utf8',timeout:30000});
  assert.equal(JSON.parse(output).destination_version,14);
  const source=new DatabaseSync(path.join(old,'operations.sqlite3'),{readOnly:true}),destination=new DatabaseSync(path.join(target,'operations.sqlite3'),{readOnly:true});
  try{assert.equal(source.prepare('PRAGMA user_version').get().user_version,13);assert.equal(destination.prepare('PRAGMA user_version').get().user_version,14);}finally{source.close();destination.close();}
});
