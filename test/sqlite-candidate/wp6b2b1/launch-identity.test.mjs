import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createPlatformProbe } from '../../../dist-test/src/adapters/process-spawn.js';
import { observeTrustedLaunchIdentity, verifyWorkerAgainstLaunchReceipt } from '../../../dist-test/src/sqlite-candidate/wp6b2b1/launch-identity.js';

test('controlled Node child produces an exact Windows launch identity and matching Worker probe', {skip:process.platform!=='win32'}, async t=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  await once(child,'spawn');
  const probe=createPlatformProbe({timeoutMs:10000});
  const launch=await observeTrustedLaunchIdentity(child,probe,'isolated-launch-identity-test',42);
  assert.ok(launch,'missing or uncertain OS identity must not produce a Receipt');
  assert.equal(launch.process_id,child.pid);
  assert.equal(launch.launch_id,'isolated-launch-identity-test');
  assert.equal(launch.generation,42);
  assert.equal(launch.fixture,false);
  const worker=await verifyWorkerAgainstLaunchReceipt('controlled-node-child',child.pid,launch,probe);
  assert.ok(worker);assert.equal(worker.process_id,launch.process_id);assert.equal(worker.fixture,false);
  assert.equal(await verifyWorkerAgainstLaunchReceipt('forged-pid',child.pid+1,launch,probe),null);
  child.kill();await once(child,'close');
  assert.equal(await observeTrustedLaunchIdentity(child,probe,'late-after-exit',43),null);
});

test('unsupported platform, PID mismatch, and failed Probe remain fail-closed',async()=>{
  const child={pid:1234,exitCode:null,signalCode:null};
  const identity={pid:1234,fingerprint:'fingerprint',fingerprint_precision:'exact',identity_version:1,platform:'win32',captured_at:new Date().toISOString()};
  const unsupported={platform:'linux',identityOf:async()=>identity,selfIdentity:async()=>identity,probe:async()=>[{state:'alive',reason_code:'ok',observed_at:new Date().toISOString()}]};
  assert.equal(await observeTrustedLaunchIdentity(child,unsupported,'launch',1),null);
  const failed={...unsupported,platform:'win32',identityOf:async()=>{throw new Error('probe failure');}};
  assert.equal(await observeTrustedLaunchIdentity(child,failed,'launch',1),null);
  const receipt={source:'manager_os_spawn_observation',fixture:false,launch_id:'launch',generation:1,process_id:1234,start_fingerprint:'fingerprint',
    fingerprint_precision:'exact',identity_version:1,platform:'win32',captured_at:new Date().toISOString(),evidence_digest:'0'.repeat(64)};
  assert.equal(await verifyWorkerAgainstLaunchReceipt('worker',1235,receipt,failed),null);
});
