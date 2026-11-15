import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
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
function mixedHistoricalV13(){
  const root=fixture('mixed-v13'),database=path.join(root,'operations.sqlite3');
  const nativeId='native-after-switch',historicalId='legacy-before-switch';
  const value={...result(historicalId),summary:'legacy Unicode 中文😀'};
  const event={artifact_id:'legacy-events',task_id:historicalId,attempt:1,source_sequence:1,
    event_type:'legacy_completed',at:'2026-11-05T00:00:00Z',summary:'legacy event',details:{retained:true}};
  const artifacts=[
    {artifact_id:'legacy-result',relative_path:`${historicalId}/result.json`,task_id:historicalId,attempt:null,
      kind:'task_result',content:Buffer.from(canonical(value))},
    {artifact_id:'legacy-events',relative_path:`${historicalId}/events.jsonl`,task_id:historicalId,attempt:null,
      kind:'events',content:Buffer.from(JSON.stringify(event)+'\n')},
  ].map(a=>({...a,byte_length:a.content.length,
    sha256:createHash('sha256').update(a.content).digest('hex')}));
  const artifactBytes=artifacts.reduce((total,a)=>total+a.byte_length,0);
  const manifest={files:artifacts.map(({relative_path,sha256,byte_length})=>({relative_path,sha256,byte_length})),
    task_count:1,result_count:1,event_count:1,artifact_count:artifacts.length,artifact_bytes:artifactBytes,
    historical_exceptions:[],historical_exception_count:0,
    historical_exception_digest:historicalResultExceptionSetDigest([])};
  const archiveDirectory=path.join(root,'legacy-archive');
  const sourceTasksRoot=path.join(root,'legacy-source');
  const sourceManifest=canonical(manifest),sourceManifestDigest=digest(sourceManifest);
  const task=taskId=>({task_id:taskId,workspace:root,objective:'mixed authority fixture',
    requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]});
  const db=new DatabaseSync(database);
  try{
    db.exec(readFileSync(new URL('../src/sqlite-candidate/wp6b2b1/schema-v13.sql',import.meta.url),'utf8'));
    db.exec('BEGIN');
    db.prepare(`INSERT INTO authority_metadata(singleton,schema_version,next_event_cursor,policy_version,
      policy_generation,capacity_limit,policy_operation_id) VALUES(1,13,2,1,1,8,'mixed-capacity-policy')`).run();
    db.prepare(`INSERT INTO manager_operations(operation_id,operation_kind,request_digest,revision,phase,
      policy_generation,capacity_limit,created_at) VALUES('mixed-capacity-policy','capacity_policy_change',?,
      1,'policy_change_committed',1,8,'2026-11-05T00:00:00Z')`).run(
      digest({operation_id:'mixed-capacity-policy',capacity_limit:8,expected_generation:0}));
    const policyEvidence=canonical({generation:1,capacity_limit:8});
    db.prepare(`INSERT INTO manager_operation_events(event_cursor,operation_id,sequence,event_type,
      from_phase,to_phase,generation,evidence_json,evidence_digest,at) VALUES(1,'mixed-capacity-policy',
      1,'capacity_policy_committed',NULL,'policy_change_committed',NULL,?,?,'2026-11-05T00:00:00Z')`).run(
      policyEvidence,digest(policyEvidence));
    for(const [taskId,status] of [[nativeId,'queued'],[historicalId,'completed']]){
      db.prepare('INSERT INTO tasks(task_id,task_json,status,current_attempt,created_at) VALUES(?,?,?,?,?)')
        .run(taskId,canonical(task(taskId)),status,1,'2026-11-05T00:00:00Z');
      db.prepare('INSERT INTO attempts(task_id,attempt,generation,status,created_at) VALUES(?,?,NULL,?,?)')
        .run(taskId,1,status,'2026-11-05T00:00:00Z');
    }
    db.prepare(`INSERT INTO migration_runs(migration_id,state,source_root_digest,source_manifest_json,
      source_manifest_digest,source_task_count,source_artifact_count,source_artifact_bytes,source_result_count,
      source_event_count,archive_directory,archive_manifest_digest,archive_source_tasks_root,archive_file_count,
      archive_byte_count,verifier_version,created_at,verified_at)
      VALUES('mixed-migration','verified',?,?,?,1,?,?,1,1,?,?,?,?,?,'wp6-json-cutover-v1',?,?)`).run(
      'd'.repeat(64),sourceManifest,sourceManifestDigest,artifacts.length,artifactBytes,archiveDirectory,
      'c'.repeat(64),sourceTasksRoot,artifacts.length,artifactBytes,
      '2026-11-05T00:00:00Z','2026-11-05T00:00:00Z');
    db.prepare(`INSERT INTO authority_switch(singleton,authority_generation,cutover_id,migration_id,
      source_root_digest,source_manifest_digest,archive_directory,archive_manifest_digest,
      archive_source_tasks_root,archive_file_count,archive_byte_count,schema_version,protocol_version,
      runtime_roster_digest,verifier_version,created_at)
      VALUES(1,1,'mixed-cutover','mixed-migration',?,?,?,?,?,?,?,13,'wp6-stop-world-json-sqlite-v1',?,
      'wp6-json-cutover-v1','2026-11-05T00:00:00Z')`).run(
      'd'.repeat(64),sourceManifestDigest,archiveDirectory,'c'.repeat(64),sourceTasksRoot,artifacts.length,
      artifactBytes,'a'.repeat(64));
    for(const artifact of artifacts){
      db.prepare(`INSERT INTO json_artifacts(artifact_id,migration_id,relative_path,task_id,attempt,kind,
        byte_length,sha256,content,created_at) VALUES(?,'mixed-migration',?,?,?,?,?,?,?,?)`).run(
        artifact.artifact_id,artifact.relative_path,artifact.task_id,artifact.attempt,artifact.kind,
        artifact.byte_length,artifact.sha256,artifact.content,'2026-11-05T00:00:00Z');
    }
    db.prepare('INSERT INTO migrated_task_results(task_id,attempt,result_json,result_digest,artifact_id) VALUES(?,?,?,?,?)')
      .run(historicalId,1,canonical(value),digest(canonical(value)),'legacy-result');
    const details=canonical(event.details);
    db.prepare(`INSERT INTO migrated_task_events(event_cursor,task_id,attempt,source_sequence,event_type,at,
      summary,details_json,details_digest,artifact_id) VALUES(2,?,?,?,?,?,?,?,?,?)`).run(
      historicalId,1,event.source_sequence,event.event_type,event.at,event.summary,details,digest(details),
      'legacy-events');
    db.prepare("UPDATE sqlite_sequence SET seq=2 WHERE name='manager_operation_events'").run();
    db.exec('PRAGMA user_version=13; COMMIT');
  }catch(error){
    try{db.exec('ROLLBACK');}catch{}
    throw error;
  }finally{db.close();}
  writeFileSync(path.join(root,'operations.sqlite3.cutover-published.json'),JSON.stringify({
    schema_version:1,state:'authority_switch_receipt',cutover_id:'mixed-cutover',migration_id:'mixed-migration',
    source_root_digest:'d'.repeat(64),source_manifest_digest:sourceManifestDigest,database_file:'operations.sqlite3',
    archive:{archive_directory:archiveDirectory,source_tasks_root:sourceTasksRoot,manifest_digest:'c'.repeat(64),
      file_count:artifacts.length,byte_count:artifactBytes},
    created_at:'2026-11-05T00:00:00Z',
  }));
  return {root,nativeId,historicalId};
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

test('fresh native v14 Task, Result and Runtime Event facts survive reopen',()=>{
  const root=fixture('native-v14-contract'),{store,fence}=running(root,'native-v14-contract',true);
  try{
    store.appendRuntimeTaskEvent({...fence,worker_sequence:1,event_type:'turn_started',
      at:'2026-11-15T00:00:00.000Z',summary:'native turn started'});
    store.commitResult({...fence,result_status:'completed',result:result('native-v14-contract')});
  }finally{store.close();}
  const reopened=IsolatedAdmissionStore.open(root,{managedDataDirectory:true});
  try{
    const lifecycle=reopened.readTaskLifecycle('native-v14-contract');
    assert.equal(lifecycle.projection.task_id,'native-v14-contract');
    assert.equal(lifecycle.result.summary,'R2 result');
    assert.equal(reopened.readTaskEvents('native-v14-contract').events.some(event=>event.event_type==='turn_started'),true);
  }finally{reopened.close();}
});

test('mixed migrated and native v14 authority preserves native Tasks and keeps retired history non-queryable',()=>{
  const {root,nativeId,historicalId}=mixedHistoricalV13(),target=fixture('mixed-v14');
  IsolatedAdmissionStore.upgradeV13Copy(root,target,options);
  const store=IsolatedAdmissionStore.open(target,{managedDataDirectory:true});
  try{
    assert.equal(store.readTaskLifecycle(nativeId).projection.status,'queued');
    assert.deepEqual(store.readTaskEvents(nativeId),{events:[],nextCursor:0,hasMore:false});
    assert.equal(store.readTaskLifecycle(historicalId),null);
    assert.throws(()=>store.readTaskEvents(historicalId),error=>error.code==='task_not_found');
    assert.equal(typeof store.readMigratedResult,'undefined');
    assert.equal(typeof store.readMigratedEvents,'undefined');
    assert.equal(typeof store.readMigratedArtifact,'undefined');
  }finally{store.close();}
  const db=new DatabaseSync(path.join(target,'operations.sqlite3'),{readOnly:true});
  try{
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrated_task_results').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migrated_task_events').get().n,1);
  }finally{db.close();}
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

test('automatic v13 startup upgrade keeps occupied running Attempts and recovery evidence without clearing a Hold',()=>{
  const active=fixture('auto-live');const {store,fence}=running(active,'auto-live-task',true);
  const evidence={source:'manager_cleanup_probe',operation_id:fence.operation_id,task_id:fence.task_id,attempt:1,
    generation:fence.generation,claim_id:fence.claim_id,worker_identity_digest:fence.claim_worker_identity_digest,probe:'unknown'};
  const port=createSqliteLifecyclePort(store,{recoveryEvidenceVerifier:({observation})=>({
    classification:observation.classification,reason_code:observation.reason_code,
    evidence_source:observation.evidence_source,evidence_digest:observation.evidence_digest})});
  port.recordRecoveryObservation({operation_id:fence.operation_id,task_id:fence.task_id,attempt:1,generation:fence.generation,
    expected_revision:fence.revision,claim_id:fence.claim_id,worker_identity_digest:fence.claim_worker_identity_digest,
    classification:'hold',reason_code:'cleanup_incomplete',evidence_source:'manager_cleanup_probe',
    evidence_digest:digest(evidence)},evidence);
  const original=store.readOperation(fence.operation_id);
  const eventDigests=store.readLifecycleEvents(fence.operation_id).map(event=>event.evidence_digest);
  store.close();
  const old=fixture('auto-v13');historicalV13(active,old);
  const opts={databaseFileName:'operations.sqlite3',runtimeRosterDigest:'b'.repeat(64)};
  const before=readFileSync(path.join(old,'operations.sqlite3'));
  const upgraded=IsolatedAdmissionStore.autoUpgradeV13(old,opts);
  assert.equal(upgraded.state,'upgraded');
  assert.equal(upgraded.source_version,13);
  assert.deepEqual(readFileSync(upgraded.backup),before);
  const sourceBackup=new DatabaseSync(upgraded.backup,{readOnly:true});
  try{assert.equal(sourceBackup.prepare('PRAGMA user_version').get().user_version,13);}finally{sourceBackup.close();}
  const checked=IsolatedAdmissionStore.open(old,{managedDataDirectory:true});
  try{
    assert.equal(checked.readOperation(fence.operation_id).phase,original.phase);
    assert.equal(checked.readOperation(fence.operation_id).claim_id,original.claim_id);
    assert.deepEqual(checked.readLifecycleEvents(fence.operation_id).map(event=>event.evidence_digest),eventDigests);
    assert.equal(checked.readTaskLifecycle(fence.task_id).projection.status,'running');
    checked.assertAuthorityReady();
  }finally{checked.close();}
  const recovery=IsolatedAdmissionStore.openForRecovery(old,{managedDataDirectory:true});
  try{
    const snapshot=recovery.readRecoverySnapshot();
    assert.ok(snapshot.operations.some(x=>x.operation_id===fence.operation_id&&x.capacity_occupied===true&&x.recovery_classification==='hold'));
  }finally{recovery.close();}
  assert.equal(IsolatedAdmissionStore.autoUpgradeV13(old,opts).state,'already_v14');
});

test('automatic upgrade restores a v13 database after interrupted first rename and retries idempotently',()=>{
  const old=oldRoot(),database='operations.sqlite3',token=randomUUID();
  const stage=path.join(old,database+'.v14-stage-'+token);
  const backup=path.join(old,database+'.v13-backup-'+token);
  const marker=path.join(old,database+'.v13-v14-pending.json');
  mkdirSync(stage);
  renameSync(path.join(old,database),backup);
  writeFileSync(marker,JSON.stringify({contract:'sqlite-v13-v14-auto-upgrade-v1',database_file:database,token}));
  const upgraded=IsolatedAdmissionStore.autoUpgradeV13(old,{databaseFileName:database,runtimeRosterDigest:'b'.repeat(64)});
  assert.equal(upgraded.state,'upgraded');
  assert.ok(existsSync(upgraded.backup));
  const s=IsolatedAdmissionStore.open(old,{managedDataDirectory:true});
  try{assert.equal(s.readTaskLifecycle('old-task').result.status,'cancelled');}finally{s.close();}
  assert.equal(existsSync(marker),false);
});

test('automatic upgrade recovers successful publication after crash before clearing the marker',()=>{
  const old=oldRoot(),database='operations.sqlite3',token=randomUUID();
  const stage=path.join(old,database+'.v14-stage-'+token);
  const backup=path.join(old,database+'.v13-backup-'+token);
  const marker=path.join(old,database+'.v13-v14-pending.json');
  mkdirSync(stage);
  IsolatedAdmissionStore.upgradeV13Copy(old,stage,options);
  renameSync(path.join(old,database),backup);
  renameSync(path.join(stage,database),path.join(old,database));
  writeFileSync(marker,JSON.stringify({contract:'sqlite-v13-v14-auto-upgrade-v1',database_file:database,token}));
  const recovered=IsolatedAdmissionStore.autoUpgradeV13(old,{databaseFileName:database,runtimeRosterDigest:'b'.repeat(64)});
  assert.equal(recovered.state,'upgraded');
  assert.equal(recovered.backup,backup);
  assert.ok(existsSync(backup));
  assert.equal(existsSync(marker),false);
  assert.equal(IsolatedAdmissionStore.autoUpgradeV13(old,{databaseFileName:database,runtimeRosterDigest:'b'.repeat(64)}).state,'already_v14');
});

test('automatic upgrade refuses a blocked v13 root without modifying its SQLite bytes or removing its Hold',()=>{
  const live=fixture('auto-blocked-live');const {store}=running(live);store.close();
  const old=fixture('auto-blocked-v13');historicalV13(live,old);
  const db=path.join(old,'operations.sqlite3'),before=readFileSync(db);
  writeFileSync(path.join(old,'WRITER_INTENT.json'),'unknown');
  assert.throws(()=>IsolatedAdmissionStore.autoUpgradeV13(old,{databaseFileName:'operations.sqlite3',runtimeRosterDigest:'b'.repeat(64)}),e=>e.code==='upgrade_source_blocked');
  assert.deepEqual(readFileSync(db),before);
  assert.equal(existsSync(db+'.v13-v14-pending.json'),false);
});
