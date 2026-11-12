import assert from "node:assert/strict";
import test from "node:test";
import {buildTaskResult} from "../src/manager/normalize.js";
import {normalizeUsage} from "../src/usage/normalize.js";
import {sanitizeDiagnostics} from "../src/observation/diagnostics.js";
import {makeTask,validReport} from "./helpers.js";
import type {ZCodeRunOutcome} from "../src/adapters/run-outcome.js";
const report=validReport();
const outcome:ZCodeRunOutcome={exitCode:0,signal:null,stdout:"",stderr:"",sessionId:"sess-result",response:JSON.stringify(report),usage:null,timedOut:false,cancelled:false,stdoutTruncated:false,stderrTruncated:false,attempts:1,agentReport:report,reportCandidate:report,reportError:null,errorCode:null};
const base={task:makeTask(),attempt:1,startedAt:null,finishedAt:"2026-11-07T00:00:00Z"};
test("shared Result normalization preserves report decisions and never repairs missing report evidence",()=>{
  assert.equal(buildTaskResult({...base,outcome}).status,"completed");
  assert.equal(buildTaskResult({...base,outcome:{...outcome,agentReport:{...report,needs_master_decision:true}}}).status,"waiting_for_master");
  const invalid=buildTaskResult({...base,outcome:{...outcome,agentReport:null,reportError:"missing needs_master_decision",errorCode:"invalid_agent_report"}});
  assert.equal(invalid.status,"failed");assert.equal(invalid.needs_master_decision,true);assert.deepEqual(invalid.report_candidate,report);
  const infrastructure=buildTaskResult({...base,outcome:null,failure:{code:"worker_error",message:"Result unavailable"}});
  assert.equal(infrastructure.usage,undefined);assert.equal(infrastructure.needs_master_decision,true);
});
test("cancellation keeps measured usage; infrastructure failure preserves an existing report candidate",()=>{
  const cancelled=buildTaskResult({...base,outcome:{...outcome,cancelled:true},cancelled:true,usage:normalizeUsage({total_tokens:5},{source:"zcode_runtime_turn"})});
  assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.usage?.total_tokens,5);assert.equal(cancelled.needs_master_decision,false);
  const cleanup=buildTaskResult({...base,outcome,failure:{code:"cleanup_failed",message:"tree unverified"}});
  assert.equal(cleanup.status,"failed");assert.deepEqual(cleanup.report_candidate,report);
});
test("public diagnostic helpers omit credentials, hidden reasoning and raw stacks",()=>{
  const secret="SK-PROJECT-SECRET-9f8e7d6c";
  const sanitized=sanitizeDiagnostics({provider_key:secret,reasoning_text:"hidden chain of thought marker",raw_stack:"x".repeat(5000),reason_code:"boom",attempt:1,task_id:"task_1"});
  assert.ok(!JSON.stringify(sanitized.fields).includes(secret));assert.equal(sanitized.dropped_keys>=3,true);
  assert.equal(sanitized.fields.reason_code,"boom");assert.equal(sanitized.fields.attempt,1);
});
