import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {IsolatedAdmissionStore,digest} from '../src/sqlite-candidate/wp6b2b1/store.mjs';
export function fixture(label){
  const base=process.env.WP6_SCHEMA_TEST_ROOT??path.resolve('.run/r2/tests');mkdirSync(base,{recursive:true});
  const root=mkdtempSync(path.join(base,`${label}-`));
  return root;
}
export function running(root,taskId='result-v14',trusted=false){
  const options={managedDataDirectory:true};
  const store=IsolatedAdmissionStore.initialize(root,{...options,freshInstallReceiptId:'r2-fixture',verifierVersion:'r2-test',freshInstallCapacityLimit:2});
  const workspace=path.join(root,'workspace');mkdirSync(workspace);
  store.createTask({task_id:taskId,workspace,objective:'R2 isolated contract test',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]},'2026-11-05T00:00:00Z');
  const allow=()=>({state:'allow',fixture:true});
  const a=store.admitOperation({operation_id:'op-result',task_id:taskId,attempt:1,workspace_ref:workspace},{workspaceValidator:allow,executionPermissionCheck:allow});
  const launch={operation_id:a.operation_id,task_id:taskId,attempt:1,generation:a.generation,revision:a.revision,launch_id:'r2-launch',launch_epoch:1,launch_token:'r2-fixture-token-0123456789'};
  store.createLaunchIntent(launch);
  function identity(kind){const base={source:kind==='launch'?'manager_os_spawn_observation':'manager_verified_process_probe',fixture:false,
    ...(kind==='launch'?{launch_id:launch.launch_id,generation:a.generation}:{worker_id:'r2-worker'}),process_id:41001,start_fingerprint:'r2-start',fingerprint_precision:'exact',identity_version:1,platform:'win32',captured_at:'2026-11-05T00:00:00Z'};return {...base,evidence_digest:digest(base)};}
  store.recordLaunchReceipt({...launch,revision:launch.revision+1,receipt_id:'r2-receipt',launch_identity:trusted?identity('launch'):{source:'synthetic_fixture',fixture:true,process_id:41001,start_fingerprint:'r2-start'}});
  store.commitPermanentClaim({...launch,revision:launch.revision+2,claim_id:'r2-claim',worker_identity:trusted?identity('worker'):{source:'synthetic_fixture',fixture:true,worker_id:'r2-worker',incarnation:'r2-incarnation',process_id:41001,start_fingerprint:'r2-start'}});
  const o=store.readOperation(a.operation_id);
  const fence={operation_id:o.operation_id,task_id:taskId,attempt:1,generation:o.generation,revision:o.revision,claim_id:o.claim_id,claim_worker_identity_digest:o.claim_worker_identity_digest};
  return {store,fence};
}
export function result(taskId='result-v14') { return {task_id:taskId,attempt:1,status:'completed',summary:'R2 result',files_changed:[],tests:[],issues:[],needs_master_decision:false,zcode_output:'',exit_code:0,session_id:null,started_at:null,finished_at:null}; }
// Materialize genuine frozen v13 DDL with preserved lifecycle rows; no schema
// editing or writable_schema. Used only under a new isolated fixture root.
export function historicalV13(source,destination,{oldRoster=''}={}){
  const from=new DatabaseSync(path.join(source,'operations.sqlite3'),{readOnly:true});
  const to=new DatabaseSync(path.join(destination,'operations.sqlite3'));
  try{
    to.exec(readFileSync(new URL('../src/sqlite-candidate/wp6b2b1/schema-v13.sql',import.meta.url),'utf8'));
    if(from.prepare("SELECT 1 FROM sqlite_schema WHERE name='manager_admin_abandonments'").get())to.exec(readFileSync(new URL('../src/sqlite-candidate/wp6b2b1/admin-abandonment.sql',import.meta.url),'utf8'));
    const triggers=to.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    for(const t of triggers)to.exec(`DROP TRIGGER "${t.name}"`);
    to.exec('BEGIN');
    for(const {name} of from.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7)<>'sqlite_'").all()){
      for(const raw of from.prepare(`SELECT * FROM "${name}"`).all()){
        const row={...raw};if(name==='authority_metadata'||name==='authority_switch')row.schema_version=13;
        if(name==='authority_switch')row.runtime_roster_digest=oldRoster;
        const columns=Object.keys(row);
        to.prepare(`INSERT INTO "${name}" (${columns.map(c=>`"${c}"`).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));
      }
    }
    for(const {name,seq} of from.prepare('SELECT name,seq FROM sqlite_sequence').all()){
      to.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(name);
      to.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(name,seq);
    }
    for(const t of triggers)to.exec(t.sql);
    to.exec('PRAGMA user_version=13; COMMIT');
  }finally{from.close();to.close();}
}
