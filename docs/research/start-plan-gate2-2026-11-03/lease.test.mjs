import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {checkLive,createLease} from './lease.mjs';
const scope={account:'fixture-account',provider:'account:bigmodel-start-plan',model:'GLM-5.3-Flash',task:'fixture',attempt:1,session:'fixture-session',turn:'fixture-turn'};
const identity={pid:123,creation:'exact-fixture-time'};
async function fixture(overrides={}){
  const controller=new AbortController();
  const proof=await checkLive(scope,async()=>({status:'eligible',scope}),controller.signal);
  return {controller,lease:createLease({proof,scope,credential:{account:scope.account,jwt:'SYNTHETIC_ONLY',expiresAt:Date.now()+60000},identity,probe:async()=>identity,signal:controller.signal,...overrides})};
}
test('rejects caller-forged entitlement',()=>assert.throws(()=>createLease({proof:{},scope}),/live_proof_required/));
for(const status of ['401','403','429','unusual_activity','quota_exhausted','unknown'])test('entitlement '+status+' stops once',async()=>{let calls=0;await assert.rejects(checkLive(scope,async()=>{calls++;return{status,scope};},new AbortController().signal));assert.equal(calls,1);});
test('one-time delivery and replay',async()=>{const {lease}=await fixture();let n=0;await lease.deliver(scope,async()=>n++);await assert.rejects(lease.deliver(scope,async()=>n++));assert.equal(n,1);});
for(const key of Object.keys(scope))test('scope rejects '+key,async()=>{const {lease}=await fixture();await assert.rejects(lease.deliver({...scope,[key]:'wrong'},()=>assert.fail()),/scope_mismatch/);});
test('PID reuse rejects creation mismatch',async()=>{const {lease}=await fixture({probe:async()=>({...identity,creation:'new-generation'})});await assert.rejects(lease.deliver(scope,()=>assert.fail()),/identity_mismatch/);});
test('unknown OS identity fails closed',async()=>{const {lease}=await fixture({probe:async()=>{throw Error('probe_unknown');}});await assert.rejects(lease.deliver(scope,()=>assert.fail()),/probe_unknown/);});
test('cancel',async()=>{const {lease,controller}=await fixture();controller.abort();await assert.rejects(lease.deliver(scope,()=>assert.fail()));});
test('expiry',async()=>{let now=Date.now();const {lease}=await fixture({now:()=>now});now+=6000;await assert.rejects(lease.deliver(scope,()=>assert.fail()));});
test('cancel while identity check pending',async()=>{let resolve;const {lease,controller}=await fixture({probe:()=>new Promise(r=>resolve=r)});const p=lease.deliver(scope,()=>assert.fail());controller.abort();resolve(identity);await assert.rejects(p);});
test('concurrent delivery has one winner',async()=>{const {lease}=await fixture();const results=await Promise.allSettled([lease.deliver(scope,async()=>{}),lease.deliver(scope,()=>assert.fail())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);});
function windowsIdentity(pid){
  const creation=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.Ticks.ToString()`],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();
  if(!/^\d+$/.test(creation))throw Error('unknown');return {pid,creation};
}
test('Windows Node24 real inherited pipe + PID creation-time revalidation',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const child=spawn(process.execPath,[new URL('./worker.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],{stdio:['ignore','ignore','ignore','pipe'],windowsHide:true});
  const closed=once(child,'close');const stream=child.stdio[3];const lines=createInterface({input:stream});
  try{
    const [readyLine]=await once(lines,'line');const ready=JSON.parse(readyLine);assert.equal(ready.pid,child.pid);
    const observed=windowsIdentity(child.pid);
    const {lease}=await fixture({identity:observed,probe:async pid=>windowsIdentity(pid),ttlMs:5000});
    child.once('exit',()=>lease.revoke());
    const response=once(lines,'line');await lease.deliver(scope,async packet=>stream.write(JSON.stringify(packet)+'\n'));
    const [answer]=await response;assert.equal(JSON.parse(answer).accepted,true);assert.equal(answer.includes('SYNTHETIC_ONLY'),false);
    stream.end();const [code]=await closed;assert.equal(code,0);
  }finally{lines.close();stream.destroy();if(child.exitCode===null)child.kill();await closed;}
});
