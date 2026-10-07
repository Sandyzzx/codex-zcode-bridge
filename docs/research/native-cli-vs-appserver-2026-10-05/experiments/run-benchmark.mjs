// Five real model-executed coding workloads in an isolated, runnable fixture.
// These are representative Bridge-domain tasks, not asserted production bugs.
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {Server,native,base,save,snapshot,hash,denyTools} from './probe.mjs';
import {modelIO} from './summarize-model-io.mjs';
const phase=process.env.AUDIT_BENCHMARK_PHASE==='controlled'?'benchmark-controlled':'benchmark';
const cwd=path.join(base,phase,'workspace');mkdirSync(path.join(cwd,'src'),{recursive:true});mkdirSync(path.join(cwd,'test'),{recursive:true});
const files={
 'package.json':JSON.stringify({name:'isolated-executor-benchmark',type:'module',scripts:{test:'node --test'}},null,2),
 'AGENTS.md':'Work only on the files listed in the task. Use built-in Node APIs. Do not install packages, delegate, access network, or commit.\n',
 'src/timeout.mjs':`export const DEFAULT=3600000;\nexport function parseTimeout(raw){const n=Number(raw);return Number.isSafeInteger(n)&&n>=60000&&n<=14400000?n:DEFAULT;}\n`,
 'src/paths.mjs':`import path from 'node:path';\nexport function canonical(raw,windows=false){const p=windows?path.win32:path.posix;const n=p.normalize(raw).replace(/[\\\\/]+$/,'');return windows?n.toLowerCase():n;}\nexport function overlaps(a,b,windows=false){a=canonical(a,windows);b=canonical(b,windows);const sep=windows?'\\\\':'/';return a===b||a.startsWith(b+sep)||b.startsWith(a+sep);}\n`,
 'src/retry.mjs':`export async function withRetry(operation,options={}){throw new Error('not implemented');}\n`,
 'src/ledger.mjs':`export const terminalStatuses=['completed','failed'];\nexport function isTerminal(status){return terminalStatuses.includes(status);}\nexport function transition(current,next){if(isTerminal(current)&&next!==current)throw new Error('terminal');if(current==='queued'&&next==='completed')throw new Error('invalid');return next;}\n`,
 'src/report.mjs':`import {isTerminal} from './ledger.mjs';\nexport function summarize(runs){return {completed:runs.filter(x=>x.status==='completed').length,failed:runs.filter(x=>x.status==='failed').length,active:runs.filter(x=>!isTerminal(x.status)).length};}\n`,
 'src/summary.mjs':`export function summarizeEvents(events){let n=0,input=0,output=0;for(const e of events){if(e.type==='turn.completed'){n++;input+=e.usage?.inputTokens??0;output+=e.usage?.outputTokens??0;}}return {count:n,inputTokens:input,outputTokens:output,totalTokens:input+output};}\nexport function summarizeRuns(runs){let n=0,input=0,output=0;for(const r of runs){if(r.status==='completed'){n++;input+=r.usage?.inputTokens??0;output+=r.usage?.outputTokens??0;}}return {count:n,inputTokens:input,outputTokens:output,totalTokens:input+output};}\n`
};
if(phase==='benchmark-controlled')files['.zcode/config.json']=JSON.stringify({features:{memory:false}},null,2);
if(!existsSync(path.join(cwd,'.git'))){for(const [f,t]of Object.entries(files)){mkdirSync(path.dirname(path.join(cwd,f)),{recursive:true});writeFileSync(path.join(cwd,f),t);}execFileSync('git',['init'],{cwd});execFileSync('git',['add','.'],{cwd});execFileSync('git',['-c','user.name=Executor Audit','-c','user.email=audit@example.invalid','commit','-m','Isolated benchmark baseline'],{cwd});}
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
const common=`Work in this isolated repository. Do not change AGENTS.md/package.json, install packages, access network, delegate, or commit. Run relevant checks with node. End with a concise report of changes and tests.`;
const tasks=[
 {id:'T1',kind:'small bug fix',allowed:['src/timeout.mjs'],prompt:`Fix src/timeout.mjs parseTimeout. Accept only string values containing trimmed decimal digits, and safe integer numbers, in the inclusive range 60000..14400000. Hexadecimal, exponent, fractional, signed string, empty, missing, objects, boolean, Infinity and NaN inputs must return DEFAULT. Preserve exports and DEFAULT. Only edit src/timeout.mjs.`},
 {id:'T2',kind:'add unit tests',allowed:['test/paths.test.mjs'],prompt:`Add meaningful node:test unit tests for canonical and overlaps in src/paths.mjs, only writing test/paths.test.mjs. Cover POSIX normalization, equal and nested overlap both directions, sibling prefix false positives, trailing separators, and Windows case-insensitivity and slash normalization. Include at least 8 independently named test cases. Do not modify implementation. Run node --test test/paths.test.mjs.`},
 {id:'T3',kind:'medium feature',allowed:['src/retry.mjs'],prompt:`Implement withRetry(operation, options={}) in src/retry.mjs using built-in JS. Defaults maxAttempts=3, baseDelayMs=10, maxDelayMs=1000, sleep=ms=>new Promise(r=>setTimeout(r,ms)), shouldRetry=()=>true, onAttempt=()=>{}. Call operation(attempt) with 1-based attempt; return success value. On failure only retry when shouldRetry(error,attempt) returns true and attempts remain. Await sleep(min(maxDelayMs,baseDelayMs*2**(attempt-1))) only between attempts. Call onAttempt(attempt) before each operation. Throw last error unchanged when exhausted or not retryable. Validate maxAttempts positive integer, delay values finite nonnegative, before invoking operation. Preserve export. Only edit src/retry.mjs.`},
 {id:'T4',kind:'multi-file behavior',allowed:['src/ledger.mjs','src/report.mjs'],prompt:`Add cancelled lifecycle state across src/ledger.mjs and src/report.mjs. terminalStatuses and isTerminal must recognize cancelled. transition must implement this exact graph: queued -> queued/running/cancelled; running -> running/completed/failed/cancelled; terminal status -> same status only. Reject unknown current or next statuses and every other transition. summarize must return completed,failed,cancelled,active counts, including cancelled separately and exclude it from active. Only edit these two files. Preserve named exports.`},
 {id:'T5',kind:'refactor',allowed:['src/summary.mjs'],prompt:`Refactor src/summary.mjs to remove duplicate aggregation logic shared by summarizeEvents and summarizeRuns. Preserve exact public exports, accepted inputs and output values: count completed entries, sum inputTokens and outputTokens with missing fields as zero, total as their sum. Inputs must not be mutated. Introduce one internal helper for the common accumulation. Only edit src/summary.mjs.`}
];
function checkScript(id){const pre=`import assert from 'node:assert/strict';\n`;
 if(id==='T1')return pre+`import {parseTimeout,DEFAULT} from './src/timeout.mjs';for(const v of ['0x10000','6e4','60000.0','+60000','-60000','',undefined,null,true,false,{},Infinity,NaN,59999,14400001,60000.1])assert.equal(parseTimeout(v),DEFAULT,String(v));for(const [v,n]of [['60000',60000],[' 60000 ',60000],['00060000',60000],['14400000',14400000],[60000,60000],[14400000,14400000]])assert.equal(parseTimeout(v),n);`;
 if(id==='T3')return pre+`import {withRetry} from './src/retry.mjs';let attempts=[],delays=[];const sentinel=new Error('sentinel');assert.equal(await withRetry(async n=>{attempts.push(n);if(n<4)throw sentinel;return 'ok';},{maxAttempts:4,baseDelayMs:5,maxDelayMs:12,sleep:async x=>delays.push(x)}),'ok');assert.deepEqual(attempts,[1,2,3,4]);assert.deepEqual(delays,[5,10,12]);attempts=[];delays=[];await assert.rejects(withRetry(async n=>{attempts.push(n);throw sentinel;},{shouldRetry:()=>false,sleep:async n=>delays.push(n)}),e=>e===sentinel);assert.deepEqual(attempts,[1]);assert.deepEqual(delays,[]);await assert.rejects(withRetry(()=>{throw sentinel},{maxAttempts:1}),e=>e===sentinel);for(const opts of [{maxAttempts:0},{maxAttempts:1.5},{baseDelayMs:-1},{maxDelayMs:Infinity}])await assert.rejects(withRetry(()=>assert.fail('invoked'),opts));const seen=[];assert.equal(await withRetry(n=>n,{onAttempt:n=>seen.push(n)}),1);assert.deepEqual(seen,[1]);`;
 if(id==='T4')return pre+`import {terminalStatuses,isTerminal,transition} from './src/ledger.mjs';import {summarize} from './src/report.mjs';const ss=['queued','running','completed','failed','cancelled'];const graph={queued:['queued','running','cancelled'],running:['running','completed','failed','cancelled'],completed:['completed'],failed:['failed'],cancelled:['cancelled']};for(const a of ss)for(const b of ss){if(graph[a].includes(b))assert.equal(transition(a,b),b);else assert.throws(()=>transition(a,b));}assert.throws(()=>transition('unknown','running'));assert.throws(()=>transition('running','unknown'));assert.equal(isTerminal('cancelled'),true);assert.ok(terminalStatuses.includes('cancelled'));assert.deepEqual(summarize(ss.map(status=>({status}))),{completed:1,failed:1,cancelled:1,active:2});`;
 if(id==='T5')return pre+`import {summarizeEvents,summarizeRuns} from './src/summary.mjs';for(const [fn,key,val]of [[summarizeEvents,'type','turn.completed'],[summarizeRuns,'status','completed']]){assert.deepEqual(fn([]),{count:0,inputTokens:0,outputTokens:0,totalTokens:0});const entries=Object.freeze([Object.freeze({[key]:val,usage:Object.freeze({inputTokens:3,outputTokens:2})}),Object.freeze({[key]:'ignore',usage:{inputTokens:99}}),Object.freeze({[key]:val})]);assert.deepEqual(fn(entries),{count:2,inputTokens:3,outputTokens:2,totalTokens:5});}`;
}
function verify(t){
 let result;
 if(t.id==='T2'){
  const file=path.join(cwd,'test/paths.test.mjs');if(!existsSync(file)){result={passed:false,testsPassed:0,testsFailed:1,details:'test file missing'};}else{
  const normal=spawnSync(process.execPath,['--test','--test-reporter=tap','test/paths.test.mjs'],{cwd,encoding:'utf8'});const count=Number(normal.stdout.match(/# tests (\d+)/)?.[1]||0);
  const pf=path.join(cwd,'src/paths.mjs');const original=readFileSync(pf,'utf8');const mutants=[original.replace('a.startsWith(b+sep)','a.startsWith(b)').replace('b.startsWith(a+sep)','b.startsWith(a)'),original.replace('return windows?n.toLowerCase():n','return n'),original.replace('a===b||','')];const kills=[];
  try{for(const m of mutants){writeFileSync(pf,m);kills.push(spawnSync(process.execPath,['--test','--test-reporter=tap','test/paths.test.mjs'],{cwd,encoding:'utf8'}).status!==0);}}finally{writeFileSync(pf,original);}
  result={passed:normal.status===0&&count>=8&&kills.every(Boolean),testsPassed:count,testsFailed:Number(normal.stdout.match(/# fail (\d+)/)?.[1]||0),mutantsKilled:kills,details:normal.stdout.slice(-1000)};}
 }else{
  const r=spawnSync(process.execPath,['--input-type=module','-e',checkScript(t.id)],{cwd,encoding:'utf8'});result={passed:r.status===0,testsPassed:r.status===0?1:0,testsFailed:r.status===0?0:1,details:(r.stdout+r.stderr).slice(-1800)};
 }
 const changed=execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'}).trimEnd().split('\n').filter(Boolean).map(l=>l.slice(3));
 // git status may collapse an untracked test directory; independently inspect it.
 if(changed.includes('test/')){changed.splice(changed.indexOf('test/'),1,...readdirSync(path.join(cwd,'test')).map(f=>'test/'+f));}
 result.filesChanged=changed;result.scopePassed=changed.every(f=>t.allowed.includes(f));result.artifactProduced=changed.length>0;result.passed&&=result.scopePassed&&result.artifactProduced;
 const stat=execFileSync('git',['diff','--numstat'],{cwd,encoding:'utf8'}).trim().split('\n').filter(Boolean);
 result.linesAdded=stat.reduce((n,l)=>n+Number(l.split('\t')[0]||0),0);result.linesDeleted=stat.reduce((n,l)=>n+Number(l.split('\t')[1]||0),0);
 for(const f of changed)if(existsSync(path.join(cwd,f))&&spawnSync('git',['ls-files','--error-unmatch',f],{cwd,encoding:'utf8'}).status!==0)result.linesAdded+=readFileSync(path.join(cwd,f),'utf8').trimEnd().split('\n').length;
 result.diff=execFileSync('git',['diff'],{cwd,encoding:'utf8'});result.untracked=changed.filter(f=>!result.diff.includes('b/'+f)).map(f=>({path:f,content:existsSync(path.join(cwd,f))?readFileSync(path.join(cwd,f),'utf8'):null}));return result;
}
export {verify,tasks};
if(!process.env.AUDIT_REVIEW_ONLY){
const ledger={date:'2026-10-05',commit,cwd,phase,kind:'isolated representative coding tasks',pairs:[],controls:{reasoning:'low',mode:'yolo',memory:phase==='benchmark-controlled'?'both disabled by project config':'native default, app-server disabled',tools:'Read Write Edit Bash',denyTools}};
for(const [i,t] of tasks.entries())for(const executor of i%2===0?['native','app-server']:['app-server','native']){
 // Safe: reset only the newly initialized, dedicated fixture checkout above.
 execFileSync('git',['reset','--hard',commit],{cwd});execFileSync('git',['clean','-fd'],{cwd});mkdirSync(path.join(cwd,'test'),{recursive:true});
 const runId=t.id+'-'+executor;const prompt=t.prompt+'\n'+common;console.log('START '+runId);
 const entry={runId,task:t.id,kind:t.kind,executor,prompt,promptHash:hash(prompt),commit,workspace:cwd,acceptanceCriteria:t.prompt,startedAt:new Date().toISOString(),permissionRequestCount:0,retryCount:0};
 let s;
 try{if(executor==='native'){entry.run=await native(cwd,prompt,null,300000,['--disallowed-tools',denyTools.join(',')]);entry.sessionId=entry.run.summary?.sessionId||entry.run.events[0]?.sessionId;}
 else{s=new Server(cwd);await s.init();entry.created=snapshot(await s.create(cwd,true));entry.sessionId=s.sid;console.log(JSON.stringify({runId,sessionId:s.sid,model:entry.created.model,mode:entry.created.mode}));entry.run=await s.run(prompt);entry.after=snapshot(await s.request('session/read',{sessionId:s.sid}));entry.interactions=s.interactions;entry.permissionRequestCount=s.interactions.filter(x=>x.method==='interaction/requestPermission').length;entry.subagents=await s.request('session/subagents',{sessionId:s.sid}).catch(e=>({error:e.message}));}
 entry.acceptance=verify(t);entry.usage=entry.run.events.findLast(e=>e.type==='turn.completed')?.usage;entry.finalStatus=entry.run.events.findLast(e=>['turn.completed','turn.failed'].includes(e.type))?.resultType||entry.run.exit?.code;
 }catch(e){entry.error=e.message;entry.acceptance=verify(t);}finally{if(s)await s.finish();if(entry.sessionId)entry.modelIO=modelIO(entry.sessionId);entry.finishedAt=new Date().toISOString();ledger.pairs.push(entry);save(phase,ledger);}
 console.log(JSON.stringify({runId,sessionId:entry.sessionId,usage:entry.usage,passed:entry.acceptance?.passed,files:entry.acceptance?.filesChanged,error:entry.error}));
}
console.log('BENCHMARK COMPLETE');
}
