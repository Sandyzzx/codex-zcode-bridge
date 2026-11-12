import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {statSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {IsolatedAdmissionStore} from '../src/sqlite-candidate/wp6b2b1/store.mjs';
import {fixture,running,result} from './sqlite-v14-fixture.mjs';
const exec=promisify(execFile);
const storeUrl=new URL('../src/sqlite-candidate/wp6b2b1/store.mjs',import.meta.url).href;
const task=(id,workspace)=>({task_id:id,workspace,objective:'SQLite bounded resource matrix',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]});
const size=file=>existsSync(file)?statSync(file).size:0;

test('SQLite v14 history growth keeps reads bounded and checkpoint preserves all facts',{timeout:120000},()=>{
  const root=fixture('sqlite-history');
  const store=IsolatedAdmissionStore.initialize(root,{managedDataDirectory:true,freshInstallReceiptId:'stress-history',verifierVersion:'stress-v1',freshInstallCapacityLimit:8});
  const metrics=[];
  try{
    let count=0;
    for(const target of [0,32,256]){
      const start=performance.now();
      for(;count<target;count++){
        const id='history-'+count;
        store.createTask(task(id,root));store.cancelQueuedAttempt({task_id:id,expected_attempt:1});
      }
      const samples=[];
      if(target)for(let i=0;i<25;i++){
        const at=performance.now();const snapshot=store.readTaskLifecycle('history-'+(i%target));
        assert.equal(snapshot.projection.status,'cancelled');assert.equal(snapshot.result.status,'cancelled');
        samples.push(performance.now()-at);
      }
      const p95=samples.sort((a,b)=>a-b)[Math.floor(samples.length*.95)]??0;
      assert.ok(p95<250,'SQLite current-task read p95 must stay below 250ms');
      metrics.push({tasks:target,setup_ms:performance.now()-start,read_p95_ms:p95,db_bytes:size(path.join(root,'operations.sqlite3')),wal_bytes:size(path.join(root,'operations.sqlite3-wal'))});
    }
    const reader=new DatabaseSync(path.join(root,'operations.sqlite3'),{readOnly:true});
    try{
      reader.exec('BEGIN');assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,256);
      store.createTask(task('concurrent-wal',root));
      assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,256,'WAL reader retains its snapshot across an independent writer');
      reader.exec('COMMIT');assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,257);
    }finally{reader.close();}
    store.checkpoint();
    assert.equal(size(path.join(root,'operations.sqlite3-wal')),0);
    const reopened=IsolatedAdmissionStore.openForRecovery(root,{managedDataDirectory:true});
    try{assert.equal(reopened.readTaskLifecycle('history-255').result.status,'cancelled');}finally{reopened.close();}
    console.log('SQLITE_HISTORY_RESOURCE '+JSON.stringify({metrics,checkpoint_wal_bytes:0,max_rss_kib:process.resourceUsage().maxRSS}));
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('four independent processes compete on one Result CAS without replaying Claim',{timeout:120000},async()=>{
  const root=fixture('sqlite-cas-stress');const {store,fence}=running(root);
  store.close();
  const request={...fence,result_status:'completed',result:result()};
  const code=`import {IsolatedAdmissionStore} from ${JSON.stringify(storeUrl)};let store;try{store=IsolatedAdmissionStore.open(process.argv[1],{managedDataDirectory:true});const out=store.commitResult(JSON.parse(process.argv[2]));console.log(JSON.stringify({ok:true,duplicate:out.duplicate}));}catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}finally{store?.close();}`;
  try{
    const outcomes=await Promise.all(Array.from({length:4},async()=>JSON.parse((await exec(process.execPath,['--input-type=module','-e',code,root,JSON.stringify(request)],{windowsHide:true})).stdout)));
    assert.equal(outcomes.filter(o=>o.ok&&!o.duplicate).length,1);
    for(const o of outcomes)if(!o.ok)assert.ok(['root_writer_busy','stale_result_cas'].includes(o.code),o.code);
    const recovery=IsolatedAdmissionStore.openForRecovery(root,{managedDataDirectory:true});
    try{
      const operation=recovery.readOperation(fence.operation_id);assert.equal(operation.phase,'result_committed');assert.equal(operation.claim_status,'permanent_claim_recorded');
      const events=recovery.readLifecycleEvents(fence.operation_id,{limit:200});
      assert.equal(events.filter(e=>e.event_type==='claim_committed').length,1);assert.equal(events.filter(e=>e.event_type==='result_committed').length,1);
    }finally{recovery.close();}
    console.log('SQLITE_CAS_RESOURCE '+JSON.stringify(outcomes));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('eight concurrent independent admissions preserve capacity and same-path exclusion',{timeout:120000},async()=>{
  const root=fixture('sqlite-admission-stress');
  const store=IsolatedAdmissionStore.initialize(root,{managedDataDirectory:true,freshInstallReceiptId:'stress-admission',verifierVersion:'stress-v1',freshInstallCapacityLimit:8});
  try{
    const allow=()=>({state:'allow',fixture:true});
    const gates={workspaceValidator:allow,executionPermissionCheck:allow};
    for(let i=0;i<9;i++){const workspace=path.join(root,'workspace-'+i);mkdirSync(workspace);store.createTask(task('admit-'+i,workspace));}
    const code=`import {IsolatedAdmissionStore} from ${JSON.stringify(storeUrl)};let s;try{s=IsolatedAdmissionStore.open(process.argv[1],{managedDataDirectory:true});const allow=()=>({state:'allow',fixture:true});console.log(JSON.stringify({ok:true,out:s.admitOperation(JSON.parse(process.argv[2]),{workspaceValidator:allow,executionPermissionCheck:allow})}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}finally{s?.close();}`;
    const requests=Array.from({length:8},(_,i)=>({operation_id:'admission-'+i,task_id:'admit-'+i,attempt:1,workspace_ref:path.join(root,'workspace-'+i)}));
    const outputs=await Promise.all(requests.map(async req=>JSON.parse((await exec(process.execPath,['--input-type=module','-e',code,root,JSON.stringify(req)],{windowsHide:true})).stdout)));
    // A writer-intent collision is a defined refusal, not a reason to relax CAS.
    // Retry only untouched synthetic Admission, never a Launch/Claim.
    for(let i=0;i<outputs.length;i++)if(!outputs[i].ok){assert.equal(outputs[i].code,'root_writer_busy');store.admitOperation(requests[i],gates);}
    assert.throws(()=>store.admitOperation({operation_id:'ninth',task_id:'admit-8',attempt:1,workspace_ref:path.join(root,'workspace-8')},gates),e=>e.code==='capacity_exhausted');
    const recovery=IsolatedAdmissionStore.openForRecovery(root,{managedDataDirectory:true});
    try{const operations=recovery.readRecoverySnapshot().operations.filter(o=>o.operation_kind==='attempt_lifecycle');assert.equal(operations.length,8);assert.equal(new Set(operations.map(o=>o.capacity_slot)).size,8);}finally{recovery.close();}
    const db=new DatabaseSync(path.join(root,'operations.sqlite3'),{readOnly:true});
    try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}
    console.log('SQLITE_ADMISSION_RESOURCE '+JSON.stringify({processes:8,initial_outcomes:outputs.map(o=>o.ok?'reserved':o.code)}));
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
