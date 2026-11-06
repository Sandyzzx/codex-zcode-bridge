// Acceptance instrumentation around the unchanged 904f457 resource probe.
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
if(process.cwd()!==project)throw new Error('Run from the project root');
const base=path.join(project,'.run/acceptance');mkdirSync(base,{recursive:true});
const matrixRoot=mkdtempSync(path.join(base,'resource-matrix-'));
const original=readFileSync(path.join(project,'scripts/probe-result-resources.mjs'),'utf8');
const sourceSha256=createHash('sha256').update(original).digest('hex');
let instrumented=original.replace(/from '(\.\.\/(?:src|dist)\/[^']+)'/gu,(_,specifier)=>`from ${JSON.stringify(pathToFileURL(path.resolve(project,'scripts',specifier)).href)}`);
instrumented=instrumented.replace("const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');",`const project=${JSON.stringify(project)};`);
instrumented=instrumented.replace('mkdirSync(data);mkdirSync(settings);',`mkdirSync(data);mkdirSync(settings);
const inventory=process.env.R2_ACCEPTANCE_INVENTORY;
writeFileSync(path.join(inventory,'manager.json'),JSON.stringify({pid:process.pid,role:'manager',data_root:data,run_root:root}),{flag:'wx'});`);
instrumented=instrumented.replace("onChildSpawn(child){let pending='';",`onChildSpawn(child){writeFileSync(path.join(inventory,'worker-'+child.pid+'.json'),JSON.stringify({pid:child.pid,role:'worker'}),{flag:'wx'});let pending='';`);
const entry=path.join(matrixRoot,'instrumented-probe.mjs');writeFileSync(entry,instrumented);
const summaries=[];
for(const workers of [1,2,4,8]){
  const caseRoot=path.join(matrixRoot,String(workers));mkdirSync(caseRoot);const inventory=path.join(caseRoot,'inventory');mkdirSync(inventory);
  const samplePath=path.join(caseRoot,'samples.jsonl'),stop=path.join(caseRoot,'stop');
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  const samplerProgram=readFileSync(new URL('./sample-owned-processes.ps1',import.meta.url),'utf8').replace(/^param\([^\n]+\)\r?\n/u,
    `$Inventory=${literal(inventory)}; $Output=${literal(samplePath)}; $StopFile=${literal(stop)};\n`);
  const sampler=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',samplerProgram],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const samplerClosed=once(sampler,'close');
  let sampleErr='';sampler.stdout.resume();sampler.stderr.on('data',c=>sampleErr+=String(c));
  const begin=Date.now();
  const child=spawn(process.execPath,[entry,String(workers),'33554432'],{cwd:project,env:{...process.env,R2_ACCEPTANCE_INVENTORY:inventory},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=String(c));child.stderr.on('data',c=>stderr+=String(c));
  const [code,signal]=await once(child,'close');writeFileSync(stop,'finished',{flag:'wx'});const [sampleCode]=await samplerClosed;
  writeFileSync(path.join(caseRoot,'stdout.log'),stdout);writeFileSync(path.join(caseRoot,'stderr.log'),stderr);writeFileSync(path.join(caseRoot,'sampler-stderr.log'),sampleErr);
  if(code!==0||sampleCode!==0)throw new Error(`Probe/sampler failed: ${code}/${sampleCode}; ${stderr}; ${sampleErr}`);
  const evidence=JSON.parse(stdout.trim().split('\n').at(-1));
  const samples=readFileSync(samplePath,'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line));
  const sum=items=>items.reduce((n,v)=>n+v,0);
  const summary={workers,result_bytes:33554432,exit_code:code,signal,sampler_exit_code:sampleCode,wall_ms:Date.now()-begin,probe_elapsed_ms:evidence.elapsed_ms,
    manager_high_water_kib:evidence.manager_max_rss_kib,worker_high_water_kib:evidence.worker_metrics.map(w=>w.max_rss_kib),
    sampled_working_set_sum_peak:Math.max(...samples.map(s=>sum(s.processes.map(p=>p.working_set_bytes)))),
    sampled_private_commit_sum_peak:Math.max(...samples.map(s=>sum(s.processes.map(p=>p.private_bytes)))),
    sampled_max_process_count:Math.max(...samples.map(s=>s.processes.length)),sample_count:samples.length,
    disk_peak_bytes:Math.max(...samples.map(s=>sum(Object.values(s.files)))),
    final_database_bytes:evidence.database_bytes,final_wal_bytes:evidence.wal_bytes,
    outcomes:evidence.outcomes,source_probe_sha256:sourceSha256,caseRoot,probeRoot:evidence.root};
  summaries.push(summary);writeFileSync(path.join(matrixRoot,'summary.json'),JSON.stringify({source_commit:'904f45770f21a423ba683cd0a91d9b1dd5fca6b8',sampling_interval_ms:500,summaries},null,2));
  console.log(JSON.stringify(summary));
  if(code!==0||sampleCode!==0||summary.sampled_max_process_count!==workers+1)process.exitCode=1;
}
console.log('MATRIX_ROOT '+matrixRoot);
