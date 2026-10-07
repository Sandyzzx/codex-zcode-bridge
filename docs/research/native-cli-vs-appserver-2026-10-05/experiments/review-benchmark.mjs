import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import path from 'node:path';
process.env.AUDIT_REVIEW_ONLY='1';
const {verify,tasks}=await import('./run-benchmark.mjs');
const base=process.env.AUDIT_ROOT||'C:/Users/Sandy/.codex/tmp/zcode-executor-audit-20261005';
const phase=process.env.AUDIT_BENCHMARK_PHASE==='controlled'?'benchmark-controlled':'benchmark';
const ledger=JSON.parse(readFileSync(path.join(base,phase+'.json'),'utf8'));
const cwd=ledger.cwd;
for(const r of ledger.pairs){
 execFileSync('git',['reset','--hard',ledger.commit],{cwd});execFileSync('git',['clean','-fd'],{cwd});mkdirSync(path.join(cwd,'test'),{recursive:true});
 if(r.acceptance.diff)execFileSync('git',['apply','--ignore-space-change','-'],{cwd,input:r.acceptance.diff});
 for(const f of r.acceptance.untracked||[])if(f.content!==null){mkdirSync(path.dirname(path.join(cwd,f.path)),{recursive:true});writeFileSync(path.join(cwd,f.path),f.content);}
 r.initialAcceptance=r.acceptance;
 r.acceptance=verify(tasks.find(t=>t.id===r.task));
 r.acceptance.reviewer='Codex independent replay of stored candidate diff, corrected path and TAP parsing';
 const events=r.run.events;
 const tools=new Map();for(const e of events)if(e.toolCallId&&e.tool&&!tools.has(e.toolCallId))tools.set(e.toolCallId,e.tool);
 const terminal=events.findLast(e=>['turn.completed','turn.failed'].includes(e.type));
 r.executionCompleted=terminal?.type==='turn.completed'&&terminal.resultType==='success'&&(r.executor!=='native'||r.run.exit?.code===0);
 r.metrics={executor:r.executor,sessionId:r.sessionId,runId:r.runId,
 traceId:events.find(e=>e.traceId)?.traceId||r.created?.session?.traceId||r.run.summary?.traceId||null,
 model:[...new Set(events.filter(e=>e.modelId).map(e=>e.modelId))],provider:[...new Set(events.filter(e=>e.providerId).map(e=>e.providerId))],
 reasoningLevel:r.created?.model?.options?.reasoningLevel||r.modelIO?.records?.[0]?.outputConfig?.effort||'low (private configured default; request verification tracked separately)',mode:'yolo',
 wallTimeMs:r.run.wallTimeMs,wallTimeInterval:r.executor==='native'?'CLI spawn to exit':'session/send to turn.completed plus 1.5s observation',
 runtimeTurnDurationMs:events.findLast(e=>e.type==='turn.completed')?.duration||null,
 turnCount:events.filter(e=>e.type==='turn.started').length,modelRequestCount:r.usage?.modelRequestCount||null,
 inputTokens:r.usage?.inputTokens??null,cachedInputTokens:r.usage?.cacheReadTokens??null,outputTokens:r.usage?.outputTokens??null,totalTokens:r.usage?.totalTokens??null,
 toolCallCount:tools.size,toolSequence:[...tools.values()],permissionRequestCount:r.executor==='app-server'?r.permissionRequestCount:events.filter(e=>e.type==='permission.requested').length,
 subagentCount:r.subagents?.childSessionIds?.length??null,workflowCount:null,filesChanged:r.acceptance.filesChanged,
 linesAdded:r.acceptance.linesAdded,linesDeleted:r.acceptance.linesDeleted,testsPassed:r.acceptance.testsPassed,testsFailed:r.acceptance.testsFailed,
 acceptanceCriteriaPassed:r.acceptance.passed,retryCount:events.filter(e=>e.attempt>1&&e.requestType?.includes('started')).length,
 finalStatus:terminal?.type==='turn.failed'?'failed':r.finalStatus??null,qualityScore:r.executionCompleted&&r.acceptance.passed?4:null,qualityReview:r.executionCompleted&&r.acceptance.passed?'independent acceptance and scoped diff review; non-blinded; 4=good, not proof of executor superiority':'execution failed/incomplete; no coding quality inference',cpuTimeMs:null,peakWorkingSetBytes:null,
 contextUsageBreakdown:events.filter(e=>e.contextUsageBreakdown).map(e=>e.contextUsageBreakdown)};
 console.log(JSON.stringify({runId:r.runId,passed:r.acceptance.passed,tests:r.acceptance.testsPassed,mutants:r.acceptance.mutantsKilled,files:r.acceptance.filesChanged}));
}
writeFileSync(path.join(base,phase+'-reviewed.json'),JSON.stringify(ledger,null,2));
