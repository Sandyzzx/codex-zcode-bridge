// Read-only artifact validation. Does not import probe or call a model.
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.AUDIT_ROOT||'C:/Users/Sandy/.codex/tmp/zcode-executor-audit-20261005';
const official=path.join(base,'official');
const required=['ZCODE_CLI_VS_APPSERVER.md','ZCODE_RUNTIME_CALLCHAIN.md','ZCODE_SESSION_HANDOFF.md','ZCODE_EXECUTOR_BENCHMARK.md','ZCODE_EXECUTOR_ARCHITECTURE_RECOMMENDATION.md'];
const files=required.map(f=>path.join(root,f));files.push(path.join(root,'experiments/README.md'));
let links=0;
for(const file of files){const text=readFileSync(file,'utf8');assert.ok(text.length>500,file);
 for(const m of text.matchAll(/\]\(([^)]+)\)/g)){
  const target=m[1];if(target.startsWith('https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/')){
   const relative=target.split('29628c9acdb81b703bbd4080c207a0e7ce5e276e/')[1].split('#')[0];const source=path.join(official,relative);assert.ok(existsSync(source),'missing source '+relative);
   const line=Number(target.match(/#L(\d+)/)?.[1]||0);if(line)assert.ok(readFileSync(source,'utf8').split('\n').length>=line,'invalid anchor '+target);links++;
  }else if(!/^(https?:|#)/.test(target)){assert.ok(existsSync(path.resolve(path.dirname(file),target.split('#')[0])),'missing local link '+target);links++;}
 }
}
const metrics=['executor','sessionId','runId','traceId','model','provider','reasoningLevel','mode','wallTimeMs','turnCount','modelRequestCount','inputTokens','cachedInputTokens','outputTokens','totalTokens','toolCallCount','toolSequence','permissionRequestCount','subagentCount','workflowCount','filesChanged','linesAdded','linesDeleted','testsPassed','testsFailed','acceptanceCriteriaPassed','retryCount','finalStatus','qualityScore'];
for(const [name,completed]of [['benchmark-observed',10],['benchmark-controlled-failed',0]]){
 const ledger=JSON.parse(readFileSync(path.join(root,'evidence',name+'.json'),'utf8'));assert.equal(ledger.pairs.length,10);assert.equal(ledger.pairs.filter(r=>r.executionCompleted).length,completed);
 for(const r of ledger.pairs){for(const k of metrics)assert.ok(k in r.metrics,r.runId+' missing '+k);assert.equal(r.commit,ledger.commit);assert.equal(r.workspace,ledger.cwd);if(completed){assert.equal(r.acceptance.passed,true);assert.equal(r.metrics.qualityScore,4);assert.equal(r.metrics.model[0],'GLM-5.3-Flash');}}
 for(const id of ['T1','T2','T3','T4','T5']){const pairs=ledger.pairs.filter(r=>r.task===id);assert.equal(pairs.length,2);assert.equal(pairs[0].promptHash,pairs[1].promptHash);}
}
let objects=0;
const prohibited=new Set(['requestHeaders','responseHeaders','apiKey','accessToken','refreshToken','requestAuth','credentials']);
function walk(x){if(!x||typeof x!=='object')return;objects++;for(const[k,v]of Object.entries(x)){assert.ok(!prohibited.has(k),'sensitive key exported '+k);walk(v);}}
for(const name of readdirSync(path.join(root,'evidence'))){if(name.endsWith('.json'))walk(JSON.parse(readFileSync(path.join(root,'evidence',name),'utf8')));}
console.log(JSON.stringify({requiredDocuments:required.length,sourceAndLocalLinksChecked:links,observedRuns:10,controlledFailedRuns:10,privacyObjectsChecked:objects,result:'PASS'}));
