// Export only already-allowlisted, audit-owned evidence; never raw model I/O.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const base=process.env.AUDIT_ROOT||'C:/Users/Sandy/.codex/tmp/zcode-executor-audit-20261005';
const out=fileURLToPath(new URL('../evidence/',import.meta.url));mkdirSync(out,{recursive:true});
const read=n=>JSON.parse(readFileSync(path.join(base,n+'.json'),'utf8'));
const write=(n,x)=>writeFileSync(path.join(out,n+'.json'),JSON.stringify(x,null,2)+'\n');
const important=e=>e.type!=='model.streaming'&&(e.requestType||e.contextUsageBreakdown||e.tool||e.type?.startsWith('turn.')||e.type?.startsWith('permission.')||e.type==='session.resumed');
function compact(x){
 if(Array.isArray(x))return x.map(compact);
 if(!x||typeof x!=='object')return x;
 const result={};for(const [k,v]of Object.entries(x)){
  if(['requestHeaders','responseHeaders','apiKey','accessToken','refreshToken','credentials','requestAuth','initialAcceptance','killResult'].includes(k))continue;
  if(k==='events'){result.events=Array.isArray(v)?v.filter(important).map(compact):v;continue;}
  result[k]=compact(v);
 }return result;
}
for(const [from,to]of [['benchmark-reviewed','benchmark-observed'],['benchmark-controlled-reviewed','benchmark-controlled-failed'],['handoff','handoff'],['reasoning','reasoning'],['policy','policy'],['process-control','process-control'],['job-object','job-object'],['smoke-isolated','smoke-isolated']])write(to,compact(read(from)));
const source=read('source-task');
write('source-task-summary',{sessionId:source.created?.session?.sessionId||source.sid,created:compact(source.created),terminal:compact(source.run?.terminal),error:source.error||null,independentReview:'Source paths and runtime claims cross-checked by Codex; worker drafts not accepted as authority; runtime ownership absence narrowed to SUPPORTED.'});
const runtimePath='C:/Users/Sandy/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs';
const runtimeSHA256=createHash('sha256').update(readFileSync(runtimePath)).digest('hex');
write('manifest',{date:'2026-10-05',bridgeCommit:'2596759198fa826c2b7ac0478c5682da996e9727',officialCommit:'29628c9acdb81b703bbd4080c207a0e7ce5e276e',runtimeVersion:'0.16.9',runtimePath,runtimeSHA256,nodeVersion:process.version,model:'GLM-5.3-Flash',provider:'account:bigmodel-individual-coding-plan',storageScope:'own private SQLite and fixtures; credential/config copies excluded',exportPolicy:'allowlisted runtime fields; request/header/hidden reasoning/raw prompt logs excluded; benchmark task prompts and fixture diffs intentionally included',observedRuns:10,observedCompleted:10,controlledRuns:10,controlledCompleted:0,controlledDisposition:'network failures/timeout; excluded from coding comparison',notRun:['concurrent mutating session resume','real ZCode Job Object containment','Windows Console Ctrl+C/Ctrl+Break','CPU/RAM accounting','Desktop runtime preferences','full background workflow/subagent performance','existing project memory handoff']});
console.log('Exported audit-owned sanitized evidence.');
