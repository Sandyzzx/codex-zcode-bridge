// Manual isolated ADR-026 resource probe; no installed configuration or data.
// Run after build:core: node scripts/probe-result-resources.mjs [workers=8] [bytes=33554432]
import {build} from 'esbuild';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {IsolatedAdmissionStore} from '../src/sqlite-candidate/wp6b2b1/store.mjs';
import {MAX_TASK_RESULT_BYTES} from '../src/result-contract.mjs';
import {openClaimOnlyDriver} from '../dist/src/store/lifecycle-gate.js';
import {createTrustedLocalCandidateContext} from '../dist/src/host/stdio.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.cwd()!==project)throw new Error('Run from the project root');
const workers=Number(process.argv[2]??8),bytes=Number(process.argv[3]??MAX_TASK_RESULT_BYTES);
if(!Number.isInteger(workers)||workers<1||workers>8||!Number.isInteger(bytes)||bytes<4096||bytes>MAX_TASK_RESULT_BYTES)throw new Error('Invalid probe bounds');
mkdirSync(path.join(project,'.run'),{recursive:true});
const root=mkdtempSync(path.join(project,'.run','r2-resources-'));
const data=path.join(root,'state'),settings=path.join(root,'settings'),gate=path.join(root,'all-claims-ready');
mkdirSync(data);mkdirSync(settings);
const workerEntry=path.join(root,'worker.mjs');
await build({entryPoints:[path.join(project,'src/worker/worker-main.ts')],outfile:workerEntry,bundle:true,platform:'node',format:'esm',target:'node22.18',packages:'external',logLevel:'silent',plugins:[{name:'controlled-resource-result',setup(b){
  b.onLoad({filter:/fake-result-adapter\.ts$/},async args=>{
    let source=readFileSync(args.path,'utf8').replace(/\r\n?/gu,'\n');
    source=`import {canonical} from ${JSON.stringify(path.join(project,'src/result-contract.mjs'))};\nimport {existsSync} from 'node:fs';\n`+source;
    source=source.replace('export function executeFakeResultAdapter','export async function executeFakeResultAdapter').replace('): CandidateWorkerResultFrame {',`): Promise<CandidateWorkerResultFrame> {\nconst deadline=Date.now()+60000;while(!existsSync(${JSON.stringify(gate)})){if(Date.now()>deadline)throw new Error('probe Claim barrier timed out');await new Promise(r=>setTimeout(r,20));}`);
    source=source.replace('  return {\n    protocol:',`  (result as any).zcode_output='x'.repeat(${bytes}-Buffer.byteLength(canonical({...result,zcode_output:''})));\n  return {\n    protocol:`);
    return {contents:source,loader:'ts',resolveDir:path.dirname(args.path)};
  });
  b.onLoad({filter:/worker-main\.ts$/},async args=>({contents:readFileSync(args.path,'utf8').replace('options.onStage?.("adapter result frame written");',`process.stderr.write('R2_WORKER_RESOURCE '+JSON.stringify({rss:process.memoryUsage().rss,max_rss_kib:process.resourceUsage().maxRSS})+'\\n');\noptions.onStage?.("adapter result frame written");`),loader:'ts',resolveDir:path.dirname(args.path)}));
}}]});
const s=IsolatedAdmissionStore.initialize(data,{managedDataDirectory:true,freshInstallReceiptId:'r2-resource-probe',verifierVersion:'r2-isolated',freshInstallCapacityLimit:8});s.close();
let claims=0;const childMetrics=[];const start=performance.now();
const host={name:'r2-resource-probe',settingsDirectory:settings};
const driver=await openClaimOnlyDriver({dataRoot:data,managedDataDirectory:true,requireAuthorityReceipt:true,workerEntryPath:workerEntry,bridgeEntryPath:fileURLToPath(import.meta.url),hostProfile:host,trustedLocalContext:createTrustedLocalCandidateContext(host),testOnlyFakeAdapter:true,
  onStage(stage){if(stage==='claim_continue_sent'&&++claims===workers)writeFileSync(gate,'ready',{flag:'wx'});},
  onChildSpawn(child){let pending='';child.stderr?.on('data',chunk=>{pending+=String(chunk);let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line.startsWith('R2_WORKER_RESOURCE '))childMetrics.push(JSON.parse(line.slice('R2_WORKER_RESOURCE '.length)));}});},
});
try{
  const inputs=Array.from({length:workers},(_,i)=>{
    const workspace=path.join(root,`workspace-${i}`);mkdirSync(workspace);
    const task={task_id:`r2-resource-${i}`,workspace,objective:'isolated maximum Result resource probe',requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[]};
    driver.createTask(task);
    return {task,attempt:1,operationId:`r2-resource-op-${i}`,launchId:`r2-resource-launch-${i}`,launchToken:`r2-resource-token-${i}-0123456789`};
  });
  const outcomes=await Promise.all(inputs.map(input=>driver.run(input).then(run=>({state:run.state,reason:run.reason,cleanup:run.cleanupState,spawn_count:run.spawnCount,digest:run.resultDigest}))));
  const evidence={contract:'adr026-isolated-concurrent-result-cost-v1',workers,result_bytes:bytes,elapsed_ms:performance.now()-start,claims,
    manager_max_rss_kib:process.resourceUsage().maxRSS,manager_final_rss:process.memoryUsage().rss,worker_metrics:childMetrics,
    summed_process_high_water_kib:process.resourceUsage().maxRSS+childMetrics.reduce((n,x)=>n+x.max_rss_kib,0),
    database_bytes:statSync(path.join(data,'operations.sqlite3')).size,wal_bytes:existsSync(path.join(data,'operations.sqlite3-wal'))?statSync(path.join(data,'operations.sqlite3-wal')).size:0,outcomes};
  writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({root,...evidence}));
  if(outcomes.some(x=>x.state!=='result_committed'||x.cleanup!=='released')||claims!==workers||childMetrics.length!==workers)process.exitCode=1;
}finally{driver.close();}
