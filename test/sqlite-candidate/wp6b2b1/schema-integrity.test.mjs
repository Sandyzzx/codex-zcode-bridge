import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IsolatedAdmissionStore } from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';

const fixtureRoot=process.env.WP6_SCHEMA_TEST_ROOT;
if(!fixtureRoot || !path.isAbsolute(fixtureRoot)) throw new Error('WP6_SCHEMA_TEST_ROOT must be an isolated absolute path');
mkdirSync(fixtureRoot,{recursive:true});
function fresh() {
  const root=mkdtempSync(path.join(fixtureRoot,'schema-'));
  const store=IsolatedAdmissionStore.initialize(root,{managedDataDirectory:true});
  return {root,store,dbPath:path.join(root,'operations.sqlite3')};
}
function alter(dbPath,sql) {const db=new DatabaseSync(dbPath);try{db.exec(sql);}finally{db.close();}}
function mismatch(fn) {assert.throws(fn,error=>error.code==='candidate_schema_mismatch');}

test('unmodified v12 database reopens writable and read-only',()=>{
  const f=fresh();f.store.close();
  const writer=IsolatedAdmissionStore.open(f.root,{managedDataDirectory:true});writer.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(f.root,{managedDataDirectory:true});recovery.close();
});
test('line-ending differences in persisted schema SQL are not schema drift',()=>{
  const f=fresh();f.store.close();
  const adminSchema=readFileSync(new URL('../../../src/sqlite-candidate/wp6b2b1/admin-abandonment.sql',import.meta.url),'utf8');
  const normalized=adminSchema.replace(/\r\n?/gu,'\n');
  const alternateLineEndings=adminSchema.includes('\r\n')?normalized:normalized.replace(/\n/gu,'\r\n');
  alter(f.dbPath,alternateLineEndings);
  const writer=IsolatedAdmissionStore.open(f.root,{managedDataDirectory:true});writer.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(f.root,{managedDataDirectory:true});recovery.close();
});
for(const [name,sql] of [
  ['missing trigger','DROP TRIGGER events_no_delete'],
  ['replaced trigger',"DROP TRIGGER events_no_delete; CREATE TRIGGER events_no_delete BEFORE DELETE ON manager_operation_events WHEN 0 BEGIN SELECT RAISE(ABORT,'append-only events'); END"],
  ['extra trigger','CREATE TRIGGER extra_guard AFTER INSERT ON manager_operation_events BEGIN SELECT 1; END'],
  ['extra index','CREATE INDEX extra_index ON tasks(status)'],
  ['extra view','CREATE VIEW extra_view AS SELECT task_id FROM tasks'],
  ['extra table','CREATE TABLE extra_table(id INTEGER)'],
  ['sqlite-prefixed lookalike','CREATE TABLE sqliteXhidden(id INTEGER)'],
]) test(`${name} rejects writable reopen and quarantines the recovery snapshot`,()=>{
  const f=fresh();f.store.close();alter(f.dbPath,sql);
  mismatch(()=>IsolatedAdmissionStore.open(f.root,{managedDataDirectory:true}));
  const recovery=IsolatedAdmissionStore.openForRecovery(f.root,{managedDataDirectory:true});
  try {const snapshot=recovery.readRecoverySnapshot();assert.equal(snapshot.root_status,'quarantined_read_only');assert.ok(snapshot.root_blockers.includes('candidate_schema_mismatch'));}
  finally {recovery.close();}
});

test('recovery opened before schema drift reports a blocked root',()=>{
  const f=fresh();f.store.close();
  const recovery=IsolatedAdmissionStore.openForRecovery(f.root,{managedDataDirectory:true});
  try {alter(f.dbPath,'DROP TRIGGER events_no_delete');const snapshot=recovery.readRecoverySnapshot();assert.equal(snapshot.root_status,'quarantined_read_only');assert.ok(snapshot.root_blockers.includes('candidate_schema_mismatch'));}
  finally {recovery.close();}
});

test('concurrent schema drift between precheck and write lock is rejected',async()=>{
  const f=fresh();f.store.close();
  const holder=new DatabaseSync(f.dbPath);holder.exec('BEGIN IMMEDIATE');
  const storeUrl=new URL('../../../src/sqlite-candidate/wp6b2b1/store.mjs',import.meta.url).href;
  const code=`import {IsolatedAdmissionStore} from ${JSON.stringify(storeUrl)};const s=IsolatedAdmissionStore.open(process.argv[1],{managedDataDirectory:true});try{s.createTask({task_id:'race',workspace:'fixture',objective:'fixture',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]},'2026-10-27T00:00:00.000Z');console.log('unexpected_success');process.exitCode=2}catch(e){console.log(e.code??'unknown');if(e.code!=='candidate_schema_mismatch')process.exitCode=3}finally{s.close()}`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,f.root],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
  try {
    const deadline=Date.now()+4000;
    while(!existsSync(path.join(f.root,'WRITER_INTENT.json'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync(path.join(f.root,'WRITER_INTENT.json')),'child must pass precheck before schema change');
    holder.exec('DROP TRIGGER events_no_delete; COMMIT');
    const exit=await done;assert.equal(exit,0,errors);assert.match(output,/candidate_schema_mismatch/);
    const db=new DatabaseSync(f.dbPath,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);}finally{db.close();}
  } finally {try{holder.exec('ROLLBACK');}catch{}holder.close();await done;}
});

test('schema changed after open is rejected before a lifecycle write',()=>{
  const f=fresh();
  try {
    alter(f.dbPath,'DROP TRIGGER events_no_delete');
    mismatch(()=>f.store.createTask({task_id:'synthetic',workspace:'fixture',objective:'fixture',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]},'2026-10-27T00:00:00.000Z'));
    const db=new DatabaseSync(f.dbPath,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);}finally{db.close();}
  } finally {f.store.close();}
});
