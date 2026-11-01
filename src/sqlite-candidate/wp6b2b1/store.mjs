import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCandidateInteractionAcknowledgement, isCandidateInteractionPreparedAcknowledgement } from './interaction-channel.mjs';
import { historicalResultExceptionSetDigest, historicalResultExceptionTaskIds, isCanonicalHistoricalResultExceptionSet } from '../../store/json-history-result-exceptions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const CONSTRUCT = Symbol('construct');
const SCHEMA_VERSION = 13;
// Derive the expected objects from the shipped schema, never from the database
// being checked. SQLite's own autoindexes and sqlite_sequence are excluded.
const SCHEMA_OBJECT_QUERY = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','view','index','trigger') AND substr(lower(name),1,7)<>'sqlite_' ORDER BY type COLLATE BINARY,name COLLATE BINARY";
let expectedSchemaObjects;
function schemaObjects(db) {
  return JSON.stringify(db.prepare(SCHEMA_OBJECT_QUERY).all().map(row=>[row.type,row.name,row.tbl_name,row.sql===null?null:row.sql.trim()]));
}
function assertCandidateSchema(db) {
  if(expectedSchemaObjects===undefined){
    const expected=new DatabaseSync(':memory:');
    try { expected.exec(SCHEMA);expectedSchemaObjects=schemaObjects(expected); }
    finally { expected.close(); }
  }
  if(schemaObjects(db)!==expectedSchemaObjects)fail('candidate_schema_mismatch');
}
const RESULT_CONTRACT_VERSION = 1;
const RESULT_STATUSES = new Set(['completed','failed','cancelled','waiting_for_master']);
const RECOVERY_PHASES = new Set(['running','result_committed','cleanup_pending','cleanup_verified','cleanup_unverified','cleanup_reverified','quarantined']);
const RECOVERY_SOURCES = new Set(['manager_process_probe','manager_launch_probe','manager_cleanup_probe','manager_projection_validator']);
const RECOVERY_REASON_CODES = new Set(['worker_identity_unknown','launch_outcome_unknown','cleanup_identity_unknown','cleanup_incomplete','claim_identity_conflict','operation_projection_conflict']);
const RECOVERY_QUARANTINE_CODES = new Set(['claim_identity_conflict','operation_projection_conflict']);
const RECOVERY_EVIDENCE_KEYS = Object.freeze(['attempt','claim_id','classification','envelope_digest','evidence_digest','evidence_source','expected_revision','reason','reason_code','task_id','worker_identity_digest']);
const RECOVERY_LIMIT = 8;
const RESULT_FIELDS = new Set(['task_id','attempt','status','summary','files_changed','tests','issues','needs_master_decision','zcode_output','exit_code','session_id','started_at','finished_at','error_code','report_candidate','usage','model','timing']);
const REQUIRED_RESULT_FIELDS = ['task_id','attempt','status','summary','files_changed','tests','issues','needs_master_decision','zcode_output','exit_code','session_id','started_at','finished_at'];
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const rawDigest = value => createHash('sha256').update(Buffer.from(value)).digest('hex');
const EVIDENCE_KEYS = Object.freeze({
  capacity_policy_committed: ['capacity_limit','generation'],
  reserved: ['capacity_slot','reservation_id'],
  cancelled_before_launch: ['cancel_id','request_digest'],
  observation_recorded: ['evidence_digest','reason'],
  launch_intent: ['launch_epoch','launch_id','token_digest'],
  launch_receipt: ['launch_epoch','launch_id','receipt_digest','token_digest'],
  claim_committed: ['claim_id','launch_epoch','launch_id','token_digest','worker_identity_digest'],
  result_committed: ['claim_id','outcome','result_commit_ref','result_digest','worker_identity_digest'],
  cleanup_pending: ['claim_id','result_commit_ref','worker_identity_digest'],
  cleanup_verified: ['claim_id','cleanup_digest','evidence_source','launch_receipt_digest','operation_resources_complete','process_tree_digest','resources_digest','result_commit_ref','root_process_id','root_start_fingerprint','worker_identity_digest','worker_tree_complete','workspace_touched'],
  cleanup_unverified: ['claim_id','probe_state','reason','worker_identity_digest'],
  cleanup_reverified: ['attempt','claim_id','cleanup_digest','evidence_source','generation','launch_receipt_digest','operation_id','operation_resources_complete','prior_cleanup_event_digest','process_tree_digest','resolved_recovery_event_digests','resources_digest','result_commit_ref','root_process_id','root_start_fingerprint','task_id','worker_identity_digest','worker_tree_complete','workspace_touched'],
  released: ['claim_id','cleanup_digest','result_commit_ref','worker_identity_digest'],
  interaction_requested: ['claim_id','request_digest','request_id','request_method','worker_identity_digest'],
  interaction_reply_intent: ['answer_digest','claim_id','reply_id','request_id','worker_identity_digest'],
  interaction_reply_prepared: ['answer_digest','claim_id','prepared_digest','reply_id','request_id','worker_identity_digest'],
  interaction_reply_committed: ['answer_digest','claim_id','commit_digest','prepared_digest','reply_id','request_id','worker_identity_digest'],
  interaction_reply_accepted: ['ack_digest','answer_digest','claim_id','commit_digest','reply_id','request_id','worker_identity_digest'],
});
const FUTURE_EVENT_TYPES = new Set(['launch_intent','launch_receipt','launch_unknown','claim_committed','result_committed','cleanup_pending','cleanup_verified','cleanup_unverified','quarantined','released','launch_failed']);
const FUTURE_EVIDENCE_KEYS = new Set(['cancel_verification_digest','claim_id','cleanup_digest','evidence_digest','evidence_source','launch_epoch','launch_id','launch_receipt_digest','operation_resources_complete','outcome','probe_state','process_tree_digest','reason','resources_digest','result_commit_ref','root_process_id','root_start_fingerprint','receipt_digest','result_digest','token_digest','worker_identity_digest','worker_tree_complete','workspace_touched']);
const EVENT_PHASE = Object.freeze({
  capacity_policy_committed:'policy_change_committed', reserved:'reserved', cancelled_before_launch:'cancelled_before_launch', launch_intent:'launch_intent',
  launch_unknown:'launch_unknown', claim_committed:'running', result_committed:'result_committed',
  cleanup_pending:'cleanup_pending', cleanup_verified:'cleanup_verified', cleanup_unverified:'cleanup_unverified', cleanup_reverified:'cleanup_reverified', quarantined:'quarantined',
  released:'released', launch_failed:'launch_failed',
});
function validateEvidence(eventType,value) {
  const keys=EVIDENCE_KEYS[eventType];
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_evidence');
  if(eventType==='observation_recorded') validateObservationEventEvidence(value);
  else if(eventType.startsWith('interaction_')) validateInteractionEvidence(eventType,value);
  else if(eventType==='result_committed'){
    const base=['claim_id','outcome','result_commit_ref','result_digest','worker_identity_digest'];
    const expected=value.outcome==='cancelled'?[...base,'cancel_verification_digest']:base;
    if(Object.keys(value).sort().join('|')!==expected.sort().join('|'))fail('invalid_evidence');
  }
  else if(eventType==='reserved'){
    const fields=Object.keys(value).sort().join('|');
    if(fields!==['capacity_slot','reservation_id'].join('|')
      &&fields!==['authorization_source','capacity_slot','execution_profile_id','policy_digest','policy_revision','reservation_id'].join('|'))fail('invalid_evidence');
  } else if(keys&&Object.keys(value).sort().join('|')!==keys.join('|'))fail('invalid_evidence');
  if(FUTURE_EVENT_TYPES.has(eventType)){
    const ownKeys=Object.keys(value);if(!ownKeys.length||ownKeys.some(k=>!FUTURE_EVIDENCE_KEYS.has(k)))fail('invalid_evidence');
    for(const [k,v] of Object.entries(value)){
      if(k.endsWith('_digest')||k==='token_digest'){if(typeof v!=='string'||!/^[0-9a-f]{64}$/u.test(v))fail('invalid_evidence');}
      else if(k==='launch_epoch'){if(!Number.isInteger(v)||v<1)fail('invalid_evidence');}
      else if(k==='root_process_id'){if(!Number.isSafeInteger(v)||v<1)fail('invalid_evidence');}
      else if(['operation_resources_complete','worker_tree_complete','workspace_touched'].includes(k)){if(typeof v!=='boolean')fail('invalid_evidence');}
      else if(typeof v!=='string'||!validText(v,256))fail('invalid_evidence');
    }
  } else if(!keys) fail('invalid_evidence');
  if(eventType==='capacity_policy_committed'&&(!Number.isInteger(value.capacity_limit)||value.capacity_limit<1||value.capacity_limit>8||!Number.isInteger(value.generation)||value.generation<1))fail('invalid_evidence');
  if(eventType==='reserved'&&(!validText(value.reservation_id,128)||!Number.isInteger(value.capacity_slot)||value.capacity_slot<1||value.capacity_slot>8))fail('invalid_evidence');
  if(eventType==='reserved'&&'authorization_source' in value&&(
    value.authorization_source!=='trusted_local_policy'||!validText(value.policy_revision,64)||!validText(value.execution_profile_id,64)
    ||typeof value.policy_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.policy_digest)))fail('invalid_evidence');
  if(eventType==='observation_recorded'&&(!validText(value.reason,256)||typeof value.evidence_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.evidence_digest)))fail('invalid_evidence');
  if(eventType==='cleanup_reverified'&&(!Array.isArray(value.resolved_recovery_event_digests)||value.resolved_recovery_event_digests.length>RECOVERY_LIMIT
    ||value.resolved_recovery_event_digests.some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/u.test(v))
    ||new Set(value.resolved_recovery_event_digests).size!==value.resolved_recovery_event_digests.length
    ||value.resolved_recovery_event_digests.join('|')!==[...value.resolved_recovery_event_digests].sort().join('|')
    ||!/^([0-9a-f]{64})$/u.test(value.prior_cleanup_event_digest)||!validId(value.operation_id)||!validId(value.task_id)
    ||!Number.isSafeInteger(value.attempt)||value.attempt<1||!Number.isSafeInteger(value.generation)||value.generation<1))fail('invalid_cleanup_reverification');
  for(const key of ['launch_id','claim_id'])if(key in value&&!validText(value[key],128))fail('invalid_evidence');
  if('launch_epoch' in value&&(!Number.isInteger(value.launch_epoch)||value.launch_epoch<1))fail('invalid_evidence');
  const json=canonical(value);if(Buffer.byteLength(json,'utf8')>(eventType==='cleanup_reverified'?2048:1024))fail('invalid_evidence');
  return value;
}
function validateInteractionEvidence(eventType,value){
  const keys=EVIDENCE_KEYS[eventType];
  if(!keys||Object.keys(value).sort().join('|')!==keys.join('|')||!validId(value.request_id)||value.request_id.length>512
    ||!validId(value.claim_id)||typeof value.worker_identity_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.worker_identity_digest))
    fail('invalid_interaction_evidence');
  if(eventType==='interaction_requested'){
    if(!['interaction/requestPermission','interaction/requestUserInput'].includes(value.request_method)
      ||typeof value.request_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.request_digest))fail('invalid_interaction_evidence');
  }else if(!validId(value.reply_id)||typeof value.answer_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.answer_digest)
    ||eventType==='interaction_reply_prepared'&&(typeof value.prepared_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.prepared_digest))
    ||eventType==='interaction_reply_committed'&&([value.prepared_digest,value.commit_digest].some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/u.test(v)))
    ||eventType==='interaction_reply_accepted'&&([value.ack_digest,value.commit_digest].some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/u.test(v))))fail('invalid_interaction_evidence');
  if(Buffer.byteLength(canonical(value),'utf8')>1024)fail('invalid_interaction_evidence');
}
function validateObservationEventEvidence(value){
  const own=Object.keys(value).sort().join('|');
  if(own==='evidence_digest|reason')return;
  if(own==='cancel_id|claim_id|evidence_digest|identity_evidence_digest|identity_state|reason|worker_identity_digest'){
    if(value.reason!=='cancel_requested'||!validId(value.cancel_id)||!validId(value.claim_id)
      ||!['alive','exited'].includes(value.identity_state)
      ||![value.evidence_digest,value.identity_evidence_digest,value.worker_identity_digest].every(v=>typeof v==='string'&&/^[0-9a-f]{64}$/u.test(v)))
      fail('invalid_cancellation_intent');
    return;
  }
  if(own==='cancel_id|claim_id|evidence_digest|intent_event_digest|process_tree_digest|proof_digest|reason|root_process_id|root_start_fingerprint|worker_identity_digest|worker_tree_complete'){
    if(value.reason!=='cancel_tree_verified'||!validId(value.cancel_id)||!validId(value.claim_id)
      ||![value.evidence_digest,value.intent_event_digest,value.process_tree_digest,value.proof_digest,value.worker_identity_digest].every(v=>typeof v==='string'&&/^[0-9a-f]{64}$/u.test(v))
      ||!Number.isSafeInteger(value.root_process_id)||value.root_process_id<1||!validText(value.root_start_fingerprint,256)||value.worker_tree_complete!==true)
      fail('invalid_cancellation_verification');
    return;
  }
  if(own!==[...RECOVERY_EVIDENCE_KEYS].sort().join('|'))fail('invalid_evidence');
  if(!Number.isSafeInteger(value.attempt)||value.attempt<1||!Number.isSafeInteger(value.expected_revision)||value.expected_revision<1
    ||!validId(value.task_id)||!validId(value.claim_id)||!['hold','quarantine'].includes(value.classification)
    ||!['recovery_hold','recovery_quarantine'].includes(value.reason)||value.reason!==`recovery_${value.classification}`
    ||!RECOVERY_REASON_CODES.has(value.reason_code)||!RECOVERY_SOURCES.has(value.evidence_source)
    ||(RECOVERY_QUARANTINE_CODES.has(value.reason_code)!==(value.classification==='quarantine'))
    ||![value.envelope_digest,value.evidence_digest,value.worker_identity_digest].every(v=>typeof v==='string'&&/^[0-9a-f]{64}$/u.test(v))
    ||[value.task_id,value.claim_id,value.reason_code].some(v=>v!==v.normalize('NFC'))){
    fail('invalid_recovery_observation');
  }
}
const RECOVERY_INPUT_KEYS=Object.freeze(['operation_id','task_id','attempt','generation','expected_revision','claim_id','worker_identity_digest','classification','reason_code','evidence_source','evidence_digest']);
function recoveryEnvelope(input){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).sort().join('|')!==[...RECOVERY_INPUT_KEYS].sort().join('|')
    ||![input.operation_id,input.task_id,input.claim_id].every(validId)
    ||![input.attempt,input.generation,input.expected_revision].every(v=>Number.isSafeInteger(v)&&v>=1)
    ||!['hold','quarantine'].includes(input.classification)||!RECOVERY_REASON_CODES.has(input.reason_code)
    ||(RECOVERY_QUARANTINE_CODES.has(input.reason_code)!==(input.classification==='quarantine'))
    ||!RECOVERY_SOURCES.has(input.evidence_source)
    ||![input.worker_identity_digest,input.evidence_digest].every(v=>typeof v==='string'&&/^[0-9a-f]{64}$/u.test(v))
    ||[input.operation_id,input.task_id,input.claim_id,input.reason_code].some(v=>v!==v.normalize('NFC'))){
    fail('invalid_recovery_observation');
  }
  return {contract:'wp6c-c3b-recovery-observation-v1',operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,
    generation:input.generation,expected_revision:input.expected_revision,claim_id:input.claim_id,
    worker_identity_digest:input.worker_identity_digest,classification:input.classification,reason_code:input.reason_code,
    evidence_source:input.evidence_source,evidence_digest:input.evidence_digest};
}
function recoveryEventEvidence(input,envelopeDigest){
  return {attempt:input.attempt,claim_id:input.claim_id,classification:input.classification,envelope_digest:envelopeDigest,
    evidence_digest:input.evidence_digest,evidence_source:input.evidence_source,expected_revision:input.expected_revision,
    reason:`recovery_${input.classification}`,reason_code:input.reason_code,task_id:input.task_id,worker_identity_digest:input.worker_identity_digest};
}
function recoveryEventsFor(events,operationId){
  const operation=typeof operationId==='object'?operationId:null;
  const id=operation?.operation_id??operationId;
  const operationEvents=events.filter(e=>e.operation_id===id);
  const claimSequence=operationEvents.find(e=>e.event_type==='claim_committed')?.sequence;
  const recovery=[];
  for(const event of operationEvents){
    if(event.event_type!=='observation_recorded')continue;
    let evidence;try{evidence=event.evidence??JSON.parse(event.evidence_json);}catch{fail('invalid_evidence');}
    const recoveryMarker=typeof evidence?.reason==='string'&&evidence.reason.startsWith('recovery_')
      ||evidence&&['classification','envelope_digest','expected_revision','reason_code'].some(key=>Object.hasOwn(evidence,key));
    if(!recoveryMarker)continue;
    validateObservationEventEvidence(evidence);
    if(!operation)fail('recovery_operation_binding_required');
    validateRecoveryEventBinding(operation,event,evidence,claimSequence);
    recovery.push({event,evidence});
  }
  const resolved=new Set();
  for(const event of operationEvents){
    if(event.event_type!=='cleanup_reverified')continue;
    let evidence;try{evidence=event.evidence??JSON.parse(event.evidence_json);}catch{fail('cleanup_reverification_history_invalid');}
    validateEvidence('cleanup_reverified',evidence);
    const prior=operationEvents.find(candidate=>candidate.event_type==='cleanup_unverified');
    const priorEvidence=prior&&JSON.parse(prior.evidence_json);
    if(!operation||!prior||prior.evidence_digest!==evidence.prior_cleanup_event_digest||prior.sequence>=event.sequence
      ||event.from_phase!=='cleanup_unverified'||event.to_phase!=='cleanup_reverified'||event.generation!==operation.generation
      ||evidence.operation_id!==operation.operation_id||evidence.task_id!==operation.task_id||evidence.attempt!==operation.attempt
      ||evidence.generation!==operation.generation
      ||evidence.claim_id!==operation.claim_id||evidence.worker_identity_digest!==operation.claim_worker_identity_digest
      ||evidence.launch_receipt_digest!==operation.launch_receipt_digest||evidence.result_commit_ref!==operation.result_commit_ref
      ||!priorEvidence||priorEvidence.claim_id!==evidence.claim_id||priorEvidence.worker_identity_digest!==evidence.worker_identity_digest)
      fail('cleanup_reverification_history_mismatch');
    const between=operationEvents.filter(candidate=>candidate.sequence>prior.sequence&&candidate.sequence<event.sequence);
    const betweenRecovery=recovery.filter(item=>item.event.sequence>prior.sequence&&item.event.sequence<event.sequence);
    if(between.some(candidate=>candidate.event_type!=='observation_recorded')||betweenRecovery.length!==between.length
      ||betweenRecovery.some(item=>item.evidence.classification!=='hold'
        ||!['cleanup_identity_unknown','cleanup_incomplete'].includes(item.evidence.reason_code)))
      fail('cleanup_reverification_intervening_event_mismatch');
    for(const eventDigest of evidence.resolved_recovery_event_digests){
      const held=recovery.find(item=>item.event.evidence_digest===eventDigest);
      if(!held||held.event.sequence>=event.sequence||held.evidence.classification!=='hold'
        ||!['cleanup_identity_unknown','cleanup_incomplete'].includes(held.evidence.reason_code))fail('cleanup_reverification_hold_binding_mismatch');
      resolved.add(eventDigest);
    }
  }
  return recovery.map(item=>({...item,active:!resolved.has(item.event.evidence_digest)}));
}
function foldedRecoveryClassification(operation,events){
  let level=operation.phase==='quarantined'?2:0;
  for(const {evidence,active} of recoveryEventsFor(events,operation))if(active)level=Math.max(level,evidence.classification==='quarantine'?2:1);
  return level===2?'quarantine':level===1?'hold':'normal';
}
function validText(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f]/u.test(value);}
function isNullableText(value,max=4096){return value===null||(typeof value==='string'&&value.length<=max&&!/[\x00-\x1f]/u.test(value));}
function validateStringArray(value,maxItems=256){if(!Array.isArray(value)||value.length>maxItems||value.some(x=>typeof x!=='string'||x.length>4096||/[\x00-\x1f]/u.test(x)))fail('invalid_result_payload');}
function validateResultObject(value,keys,required=[]){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_result_payload');
  const own=Object.keys(value);if(own.some(k=>!keys.has(k))||required.some(k=>!Object.hasOwn(value,k)))fail('invalid_result_payload');
}
function validateTestReports(value){
  if(!Array.isArray(value)||value.length>256)fail('invalid_result_payload');
  for(const report of value){validateResultObject(report,new Set(['command','status','details']),['command','status']);
    if(typeof report.command!=='string'||report.command.length>4096||!['passed','failed','not_run'].includes(report.status)
      ||(Object.hasOwn(report,'details')&&typeof report.details!=='string'))fail('invalid_result_payload');}
}
function validateAgentReport(value){
  validateResultObject(value,new Set(['summary','files_changed','tests','issues','needs_master_decision']));
  if(Object.hasOwn(value,'summary')&&typeof value.summary!=='string')fail('invalid_result_payload');
  if(Object.hasOwn(value,'files_changed'))validateStringArray(value.files_changed);
  if(Object.hasOwn(value,'tests'))validateTestReports(value.tests);
  if(Object.hasOwn(value,'issues'))validateStringArray(value.issues);
  if(Object.hasOwn(value,'needs_master_decision')&&typeof value.needs_master_decision!=='boolean')fail('invalid_result_payload');
}
function validateUsage(value){
  validateResultObject(value,new Set(['source','scope','observed_at','finality','input_tokens','output_tokens','total_tokens','cached_input_tokens','reasoning_tokens','conflicts','dropped_unknown_keys']),
    ['source','scope','observed_at','finality','input_tokens','output_tokens','total_tokens','cached_input_tokens','reasoning_tokens','conflicts','dropped_unknown_keys']);
  if(!isNullableText(value.source)||!isNullableText(value.scope)||!isNullableText(value.observed_at)
    ||!['reported','derived','partial'].includes(value.finality)
    ||['input_tokens','output_tokens','total_tokens','cached_input_tokens','reasoning_tokens'].some(k=>value[k]!==null&&(!Number.isSafeInteger(value[k])||value[k]<0))
    ||!Number.isSafeInteger(value.dropped_unknown_keys)||value.dropped_unknown_keys<0)fail('invalid_result_payload');
  validateStringArray(value.conflicts,64);
}
function validateModel(value){
  validateResultObject(value,new Set(['executor','provider_id','model_id','requested_model','requested_reasoning_level','effective_reasoning_level','effective_reasoning_level_source','selection_source','effective_at','session_id','turn_id']),
    ['executor','provider_id','model_id','requested_model','requested_reasoning_level','effective_reasoning_level','effective_reasoning_level_source','selection_source','effective_at','session_id','turn_id']);
  if(typeof value.executor!=='string'||!['runtime','not_reported'].includes(value.effective_reasoning_level_source)
    ||['provider_id','model_id','requested_model','requested_reasoning_level','effective_reasoning_level','selection_source','effective_at','session_id','turn_id'].some(k=>!isNullableText(value[k])))fail('invalid_result_payload');
}
function validateTiming(value){
  validateResultObject(value,new Set(['queued_ms','execution_ms','turn_ms','finalize_ms','wall_ms','derived','notes']),['queued_ms','execution_ms','turn_ms','finalize_ms','wall_ms','derived','notes']);
  if(['queued_ms','execution_ms','turn_ms','finalize_ms','wall_ms'].some(k=>value[k]!==null&&(!Number.isSafeInteger(value[k])||value[k]<0))
    ||typeof value.derived!=='boolean')fail('invalid_result_payload');
  validateStringArray(value.notes,64);
}
function canonicalTaskResult(result,input){
  validateResultObject(result,RESULT_FIELDS,REQUIRED_RESULT_FIELDS);
  if(result.task_id!==input.task_id||result.attempt!==input.attempt||result.status!==input.result_status||!RESULT_STATUSES.has(result.status)
    ||typeof result.summary!=='string'||typeof result.zcode_output!=='string'||typeof result.needs_master_decision!=='boolean'
    ||(result.exit_code!==null&&!Number.isSafeInteger(result.exit_code))||!isNullableText(result.session_id)
    ||!isNullableText(result.started_at,64)||!isNullableText(result.finished_at,64))fail('invalid_result_payload');
  validateStringArray(result.files_changed);validateStringArray(result.issues);validateTestReports(result.tests);
  if(Object.hasOwn(result,'error_code')&&!validText(result.error_code,128))fail('invalid_result_payload');
  if(Object.hasOwn(result,'report_candidate'))validateAgentReport(result.report_candidate);
  if(Object.hasOwn(result,'usage')&&result.usage!==null)validateUsage(result.usage);
  if(Object.hasOwn(result,'model')&&result.model!==null)validateModel(result.model);
  if(Object.hasOwn(result,'timing')&&result.timing!==null)validateTiming(result.timing);
  return canonical(result);
}
function fixtureLaunchIdentity(value){
  if(value?.source==='manager_os_spawn_observation'){
    const {evidence_digest,...evidence}=value;
    if(Object.getPrototypeOf(value)!==Object.prototype||value.fixture!==false||!validId(value.launch_id)
      ||!Number.isSafeInteger(value.generation)||value.generation<1||!Number.isSafeInteger(value.process_id)||value.process_id<1
      ||!validText(value.start_fingerprint,256)||value.fingerprint_precision!=='exact'||!Number.isSafeInteger(value.identity_version)
      ||value.identity_version<1||value.platform!=='win32'||!validText(value.captured_at,64)
      ||typeof evidence_digest!=='string'||!/^[0-9a-f]{64}$/u.test(evidence_digest)||digest(evidence)!==evidence_digest
      ||Object.keys(value).sort().join('|')!=='captured_at|evidence_digest|fingerprint_precision|fixture|generation|identity_version|launch_id|platform|process_id|source|start_fingerprint')fail('invalid_trusted_launch_identity');
    return value;
  }
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||value.source!=='synthetic_fixture'||value.fixture!==true
    ||!Number.isSafeInteger(value.process_id)||value.process_id<1||!validText(value.start_fingerprint,256)
    ||Object.keys(value).sort().join('|')!=='fixture|process_id|source|start_fingerprint')fail('invalid_synthetic_launch_identity');
  return value;
}
function fixtureWorkerIdentity(value){
  if(value?.source==='manager_verified_process_probe'){
    const {evidence_digest,...evidence}=value;
    if(Object.getPrototypeOf(value)!==Object.prototype||value.fixture!==false||!validId(value.worker_id)
      ||!Number.isSafeInteger(value.process_id)||value.process_id<1||!validText(value.start_fingerprint,256)
      ||value.fingerprint_precision!=='exact'||!Number.isSafeInteger(value.identity_version)||value.identity_version<1
      ||value.platform!=='win32'||!validText(value.captured_at,64)||typeof evidence_digest!=='string'
      ||!/^[0-9a-f]{64}$/u.test(evidence_digest)||digest(evidence)!==evidence_digest
      ||Object.keys(value).sort().join('|')!=='captured_at|evidence_digest|fingerprint_precision|fixture|identity_version|platform|process_id|source|start_fingerprint|worker_id')fail('invalid_trusted_worker_identity');
    return value;
  }
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||value.source!=='synthetic_fixture'||value.fixture!==true
    ||!validText(value.worker_id,128)||!validText(value.incarnation,128)||!Number.isSafeInteger(value.process_id)||value.process_id<1
    ||!validText(value.start_fingerprint,256)
    ||Object.keys(value).sort().join('|')!=='fixture|incarnation|process_id|source|start_fingerprint|worker_id')fail('invalid_synthetic_worker_identity');
  return value;
}
function validLaunchRequest(x){return validId(x?.operation_id)&&validId(x?.task_id)&&Number.isInteger(x?.attempt)&&x.attempt>0
  &&Number.isInteger(x?.generation)&&x.generation>0&&Number.isInteger(x?.revision)&&x.revision>0
  &&validId(x?.launch_id)&&Number.isInteger(x?.launch_epoch)&&x.launch_epoch>0
  &&typeof x?.launch_token==='string'&&Buffer.byteLength(x.launch_token,'utf8')>=16&&Buffer.byteLength(x.launch_token,'utf8')<=4096;}
function validCleanupRequest(x){return validId(x?.operation_id)&&validId(x?.task_id)&&Number.isSafeInteger(x?.attempt)&&x.attempt>0
  &&Number.isSafeInteger(x?.generation)&&x.generation>0&&Number.isSafeInteger(x?.revision)&&x.revision>0
  &&validId(x?.claim_id)&&typeof x?.claim_worker_identity_digest==='string'&&/^[0-9a-f]{64}$/u.test(x.claim_worker_identity_digest);}
function validCancellationFence(x){return !!x&&Object.getPrototypeOf(x)===Object.prototype
  &&Object.keys(x).sort().join('|')==='attempt|claim_id|claim_worker_identity_digest|generation|operation_id|revision|task_id|worker_identity'
  &&validId(x.operation_id)&&validId(x.task_id)&&Number.isSafeInteger(x.attempt)&&x.attempt>0
  &&Number.isSafeInteger(x.generation)&&x.generation>0&&Number.isSafeInteger(x.revision)&&x.revision>0
  &&validId(x.claim_id)&&typeof x.claim_worker_identity_digest==='string'&&/^[0-9a-f]{64}$/u.test(x.claim_worker_identity_digest);}
function normalizeCleanupEvidence(value,input){
  const keys=['attempt','claim_id','fixture','generation','launch_receipt_digest','operation_id','operation_resources_complete','process_tree_digest','resources_digest','result_commit_ref','root_process_id','root_start_fingerprint','source','task_id','worker_identity_digest','worker_tree_complete','workspace_touched'];
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==keys.join('|'))fail('invalid_cleanup_evidence');
  if(!['manager_os_cleanup_verification','synthetic_fixture'].includes(value.source)
    ||typeof value.fixture!=='boolean'||(value.source==='synthetic_fixture')!==value.fixture
    ||value.operation_id!==input.operation_id||value.task_id!==input.task_id||value.attempt!==input.attempt||value.generation!==input.generation
    ||value.claim_id!==input.claim_id||value.worker_identity_digest!==input.claim_worker_identity_digest
    ||!/^([0-9a-f]{64})$/u.test(value.launch_receipt_digest)||!/^([0-9a-f]{64})$/u.test(value.process_tree_digest)
    ||!/^([0-9a-f]{64})$/u.test(value.resources_digest)||!validId(value.result_commit_ref)
    ||!Number.isSafeInteger(value.root_process_id)||value.root_process_id<1||!validText(value.root_start_fingerprint,256)
    ||value.worker_tree_complete!==true||value.operation_resources_complete!==true||value.workspace_touched!==false)fail('invalid_cleanup_evidence');
  if(Buffer.byteLength(canonical(value),'utf8')>4096)fail('cleanup_evidence_too_large');
  return value;
}
function presentOperation(row){return {...row,launch_outcome:row.launch_id===null?'not_requested':row.launch_receipt_digest===null?'unknown_receipt_missing':'receipt_recorded_process_unverified',
  claim_status:row.claim_id===null?'not_claimed':'permanent_claim_recorded'};}
function isBusy(error){return [5,6].includes(error?.errcode)||/SQLITE_(BUSY|LOCKED)/u.test(String(error?.code??''))||/database is (busy|locked)/iu.test(String(error?.message??''));}
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  throw new AdmissionError('invalid_json_value');
}
function containsNonNfcString(value,depth=0){
  if(depth>32)return true;
  if(typeof value==='string')return value!==value.normalize('NFC');
  if(Array.isArray(value))return value.length>256||value.some(v=>containsNonNfcString(v,depth+1));
  if(value&&Object.getPrototypeOf(value)===Object.prototype){
    const keys=Object.keys(value);return keys.length>256||keys.some(k=>k!==k.normalize('NFC')||containsNonNfcString(value[k],depth+1));
  }
  return false;
}
function validateRecoveryEventBinding(operation,event,evidence,claimSequence){
  if(!RECOVERY_REASON_CODES.has(evidence.reason_code)||!RECOVERY_SOURCES.has(evidence.evidence_source)
    ||event.event_type!=='observation_recorded'||event.operation_id!==operation.operation_id
    ||event.from_phase!==event.to_phase||!RECOVERY_PHASES.has(event.to_phase)
    ||event.sequence!==evidence.expected_revision+1||event.generation!==operation.generation
    ||event.sequence>operation.revision
    ||event.evidence_digest!==digest(event.evidence_json??canonical(evidence))
    ||evidence.task_id!==operation.task_id||evidence.attempt!==operation.attempt||evidence.claim_id!==operation.claim_id
    ||evidence.worker_identity_digest!==operation.claim_worker_identity_digest||!operation.claim_id
    ||operation.claim_generation!==operation.generation||claimSequence===undefined||event.sequence<=claimSequence){
    fail('recovery_event_binding_mismatch');
  }
  if(event.to_phase==='quarantined'&&evidence.classification!=='quarantine')fail('recovery_classification_downgrade');
  const input={operation_id:operation.operation_id,task_id:evidence.task_id,attempt:evidence.attempt,generation:event.generation,
    expected_revision:evidence.expected_revision,claim_id:evidence.claim_id,worker_identity_digest:evidence.worker_identity_digest,
    classification:evidence.classification,reason_code:evidence.reason_code,evidence_source:evidence.evidence_source,evidence_digest:evidence.evidence_digest};
  if(digest(recoveryEnvelope(input))!==evidence.envelope_digest)fail('recovery_envelope_digest_mismatch');
}
export class AdmissionError extends Error { constructor(code, message = code) { super(message); this.code = code; } }
const fail = (code, message) => { throw new AdmissionError(code, message); };
function parseHistoricalExceptionManifest(sourceManifestJson, sourceManifestDigest) {
  let manifest;
  try { manifest=JSON.parse(sourceManifestJson); }
  catch { fail('invalid_source_manifest'); }
  if(!manifest||Object.getPrototypeOf(manifest)!==Object.prototype
    ||typeof sourceManifestDigest!=='string'||digest(sourceManifestJson)!==sourceManifestDigest
    ||!Array.isArray(manifest.files))fail('invalid_source_manifest');
  const exceptions=manifest.historical_exceptions;
  if(!Array.isArray(exceptions)||(exceptions.length!==0&&!isCanonicalHistoricalResultExceptionSet(exceptions))
    ||manifest.historical_exception_count!==exceptions.length
    ||manifest.historical_exception_digest!==historicalResultExceptionSetDigest(exceptions))fail('invalid_historical_exception_policy');
  return {manifest,exceptions,exceptionTaskIds:historicalResultExceptionTaskIds(exceptions)};
}
function parseAuthoritySourceManifest(sourceManifestJson, sourceManifestDigest) {
  const parsed=parseHistoricalExceptionManifest(sourceManifestJson,sourceManifestDigest);
  const {manifest}=parsed;
  if(manifest.kind===undefined)return {...parsed,kind:'historical_projection'};
  if(manifest.kind!=='raw_json_archive_cutover'
    ||typeof manifest.source_tasks_root!=='string'||!path.isAbsolute(manifest.source_tasks_root)
    ||typeof manifest.archive_manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(manifest.archive_manifest_digest)
    ||typeof manifest.source_files_digest!=='string'||!/^[0-9a-f]{64}$/u.test(manifest.source_files_digest)
    ||manifest.task_count!==0||manifest.result_count!==0||manifest.event_count!==0
    ||!Number.isSafeInteger(manifest.artifact_count)||manifest.artifact_count<0
    ||!Number.isSafeInteger(manifest.artifact_bytes)||manifest.artifact_bytes<0
    ||!Number.isSafeInteger(manifest.archive_file_count)||manifest.archive_file_count!==manifest.artifact_count
    ||!Number.isSafeInteger(manifest.archive_byte_count)||manifest.archive_byte_count!==manifest.artifact_bytes
    ||parsed.exceptions.length!==0||!Array.isArray(manifest.files)||manifest.files.length!==0)
    fail('invalid_raw_json_archive_cutover_manifest');
  return {...parsed,kind:'raw_json_archive_cutover'};
}
function validateHistoricalExceptionSnapshot(snapshot, sourceManifest) {
  const {manifest,exceptions,exceptionTaskIds}=sourceManifest;
  const expectedTaskCount=snapshot.tasks.length+exceptionTaskIds.length;
  const artifactBytes=snapshot.artifacts.reduce((total,artifact)=>total+artifact.byte_length,0);
  if(manifest.task_count!==expectedTaskCount||manifest.artifact_count!==snapshot.artifacts.length
    ||manifest.artifact_bytes!==artifactBytes||manifest.result_count!==snapshot.results.length
    ||manifest.event_count!==snapshot.events.length
    ||manifest.historical_exception_count!==exceptions.length
    ||manifest.historical_exception_digest!==historicalResultExceptionSetDigest(exceptions))fail('invalid_source_manifest');
  for(const taskId of exceptionTaskIds){
    if(snapshot.tasks.some(task=>task.task_id===taskId)
      ||snapshot.results.some(result=>result.task_id===taskId)
      ||snapshot.events.some(event=>event.task_id===taskId)
      ||snapshot.artifacts.some(artifact=>artifact.relative_path.startsWith(`${taskId}/`)
        &&(artifact.task_id!==null||artifact.attempt!==null)))fail('historical_exception_promoted_to_online_authority');
  }
  for(const exception of exceptions){
    const artifact=snapshot.artifacts.find(candidate=>candidate.relative_path===exception.relative_path);
    if(!artifact||artifact.artifact_id!==exception.artifact_id||artifact.sha256!==exception.sha256
      ||artifact.byte_length!==exception.byte_length||artifact.task_id!==null||artifact.attempt!==null
      ||snapshot.results.some(result=>result.artifact_id===exception.artifact_id))fail('invalid_historical_exception_artifact');
  }
}
function pathsFor(root, { databaseFileName = 'operations.sqlite3', managedDataDirectory = false, allowCutoverPending = false, allowUnpublishedCutover = false } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('invalid_data_root');
  if (typeof databaseFileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(databaseFileName)
    || databaseFileName==='.' || databaseFileName==='..') fail('invalid_database_file_name');
  const resolved = realpathSync.native(root);
  if (!managedDataDirectory) {
    const relative = path.relative(HERE, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('data_root_outside_candidate');
  }
  const db=path.join(resolved,databaseFileName);
  const files={ root: resolved, db, cutoverPending: `${db}.cutover-pending.json`,
    cutoverPublished: `${db}.cutover-published.json`,
    poison: path.join(resolved, 'ROOT_POISONED.json'), intent: path.join(resolved, 'WRITER_INTENT.json') };
  for(const file of [files.db,`${files.db}-wal`,`${files.db}-shm`,files.cutoverPending,files.cutoverPublished,files.poison,files.intent]) {
    try { const st=lstatSync(file); if(st.isSymbolicLink()||!st.isFile()) fail('unsafe_root_entry'); }
    catch(e) { if(e instanceof AdmissionError) throw e; if(e?.code!=='ENOENT') fail('unsafe_root_entry'); }
  }
  return { ...files, allowCutoverPending, allowUnpublishedCutover };
}
function readPublishedCutoverReceipt(file) {
  let value;
  try { value=JSON.parse(readFileSync(file,'utf8')); }
  catch { fail('cutover_publication_receipt_unreadable'); }
  const keys=['archive','created_at','cutover_id','database_file','migration_id','schema_version','source_manifest_digest','source_root_digest','state'];
  const archiveKeys=['archive_directory','byte_count','file_count','manifest_digest','source_tasks_root'];
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==keys.join('|')
    ||value.schema_version!==1||value.state!=='authority_switch_receipt'
    ||!validText(value.migration_id,128)||!validText(value.cutover_id,128)
    ||typeof value.source_root_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.source_root_digest)
    ||typeof value.source_manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.source_manifest_digest)
    ||!validText(value.database_file,96)||!validText(value.created_at,64)||Number.isNaN(Date.parse(value.created_at))
    ||!value.archive||Object.getPrototypeOf(value.archive)!==Object.prototype
    ||Object.keys(value.archive).sort().join('|')!==archiveKeys.join('|')
    ||!validText(value.archive.archive_directory,32767)||!path.isAbsolute(value.archive.archive_directory)
    ||!validText(value.archive.source_tasks_root,32767)||!path.isAbsolute(value.archive.source_tasks_root)
    ||typeof value.archive.manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(value.archive.manifest_digest)
    ||!Number.isSafeInteger(value.archive.file_count)||value.archive.file_count<0
    ||!Number.isSafeInteger(value.archive.byte_count)||value.archive.byte_count<0)fail('cutover_publication_receipt_invalid');
  return value;
}
function assertCutoverPublicationGate(db, paths) {
  const switched=db.prepare('SELECT * FROM authority_switch').all();
  if(switched.length===0)return;
  if(switched.length!==1)fail('authority_receipt_missing_or_ambiguous');
  const pending=existsSync(paths.cutoverPending);
  const published=existsSync(paths.cutoverPublished);
  if(pending&&published)fail('cutover_publication_receipt_ambiguous');
  if(pending){
    if(!paths.allowCutoverPending)fail('cutover_publish_pending');
    return;
  }
  if(!published){
    if(paths.allowUnpublishedCutover)return;
    fail('cutover_publication_receipt_missing');
  }
  const receipt=switched[0];
  const publication=readPublishedCutoverReceipt(paths.cutoverPublished);
  if(publication.database_file!==path.basename(paths.db)
    ||publication.migration_id!==receipt.migration_id||publication.cutover_id!==receipt.cutover_id
    ||publication.source_root_digest!==receipt.source_root_digest
    ||publication.source_manifest_digest!==receipt.source_manifest_digest
    ||publication.archive.archive_directory!==receipt.archive_directory
    ||publication.archive.manifest_digest!==receipt.archive_manifest_digest
    ||publication.archive.source_tasks_root!==receipt.archive_source_tasks_root
    ||publication.archive.file_count!==receipt.archive_file_count
    ||publication.archive.byte_count!==receipt.archive_byte_count)fail('cutover_publication_receipt_mismatch');
}
function writePoison(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch (error) { if (!existsSync(file)) throw error; try { unlinkSync(tmp); } catch {} }
}

export class IsolatedAdmissionStore {
  #db; #paths; #closed=false; #poisoned=false; #fault; #recoveryOnly=false;
  constructor(key, db, paths, fault, recoveryOnly=false) { if (key !== CONSTRUCT) fail('private_constructor'); this.#db=db; this.#paths=paths; this.#fault=fault; this.#recoveryOnly=recoveryOnly; }
  static initialize(root, options = {}) {
    const p=pathsFor(root, options);
    if (existsSync(p.db) || existsSync(p.cutoverPending) || existsSync(p.cutoverPublished) || existsSync(p.poison) || existsSync(p.intent)) fail('root_not_empty');
    const db=new DatabaseSync(p.db, { timeout: 5000 });
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      db.exec(SCHEMA);
      db.prepare('INSERT INTO authority_metadata(singleton,schema_version,next_generation) VALUES(1,?,0)').run(SCHEMA_VERSION);
      if (options.freshInstallReceiptId !== undefined) {
        if (!validText(options.freshInstallReceiptId,128) || !validText(options.verifierVersion,128)) fail('invalid_fresh_install_receipt');
        db.prepare('INSERT INTO fresh_install_receipt(singleton,receipt_id,verifier_version,created_at) VALUES(1,?,?,?)')
          .run(options.freshInstallReceiptId,options.verifierVersion,new Date().toISOString());
      }
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
    }
    catch(e) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw e; }
    return new IsolatedAdmissionStore(CONSTRUCT,db,p);
  }
  static open(root,{fault, ...pathOptions}={}) {
    const p=pathsFor(root, pathOptions);
    if(existsSync(p.cutoverPending)) fail('cutover_publish_pending');
    if(existsSync(p.poison)) fail('root_poisoned');
    if(!existsSync(p.db)) fail('database_missing');
    const db=new DatabaseSync(p.db,{timeout:5000});
    db.exec('PRAGMA foreign_keys=ON');
    const s=new IsolatedAdmissionStore(CONSTRUCT,db,p,fault);
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(manager_operations)').all().map(x=>x.name));
      if(!['result_status','result_generation','result_digest','result_json','result_commit_ref'].every(x=>columns.has(x)))fail('candidate_schema_mismatch');
      if(!db.prepare("SELECT 1 FROM pragma_table_info('manager_operation_events') WHERE name='event_cursor'").get())fail('candidate_schema_mismatch');
      s.#validate();
      assertCutoverPublicationGate(db,p);
    } catch(e) { db.close(); if(e instanceof AdmissionError)throw e; fail('database_unreadable',String(e)); }
    return s;
  }
  /** Open only the current candidate schema read-only for conservative recovery inspection. */
  static openForRecovery(root, options = {}) {
    const p=pathsFor(root, options);
    if(existsSync(p.cutoverPending)&&!p.allowCutoverPending) fail('cutover_publish_pending');
    if(!existsSync(p.db))fail('database_missing');
    const db=new DatabaseSync(p.db,{timeout:5000,readOnly:true});
    try {
      if(db.prepare('PRAGMA user_version').get().user_version!==SCHEMA_VERSION)fail('schema_version_unknown');
      const columns=new Set(db.prepare('PRAGMA table_info(manager_operations)').all().map(x=>x.name));
      if(!['result_status','result_generation','result_digest','result_json','result_commit_ref'].every(x=>columns.has(x)))fail('candidate_schema_mismatch');
      if(!db.prepare("SELECT 1 FROM pragma_table_info('manager_operation_events') WHERE name='event_cursor'").get())fail('candidate_schema_mismatch');
      db.exec('PRAGMA foreign_keys=ON');
      assertCutoverPublicationGate(db,p);
      return new IsolatedAdmissionStore(CONSTRUCT,db,p,undefined,true);
    } catch(e) { db.close(); if(e instanceof AdmissionError)throw e; fail('database_unreadable',String(e)); }
  }
  close(){if(!this.#closed){this.#closed=true;this.#db.close();}}
  checkpoint(){this.#assertOpen();this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
  get poisoned(){return this.#poisoned||existsSync(this.#paths.poison);}
  get foreignKeysEnabled(){this.#assertOpen();return this.#db.prepare('PRAGMA foreign_keys').get().foreign_keys===1;}
  /** Production startup requires exactly one durable reason for this root. */
  assertAuthorityReady(expectedRuntimeRosterDigest) {
    return this.#readConsistent(()=>{
      const fresh=this.#db.prepare('SELECT * FROM fresh_install_receipt').all();
      const switched=this.#db.prepare('SELECT * FROM authority_switch').all();
      if(fresh.length+switched.length!==1)fail('authority_receipt_missing_or_ambiguous');
      if(fresh.length){
        if(this.#db.prepare('SELECT COUNT(*) AS n FROM migration_runs').get().n!==0
          ||this.#db.prepare('SELECT COUNT(*) AS n FROM json_artifacts').get().n!==0
          ||this.#db.prepare('SELECT COUNT(*) AS n FROM migrated_task_results').get().n!==0
          ||this.#db.prepare('SELECT COUNT(*) AS n FROM migrated_task_events').get().n!==0)fail('fresh_install_contains_legacy_data');
        return {kind:'fresh_install',receipt_id:fresh[0].receipt_id,verifier_version:fresh[0].verifier_version};
      }
      const receipt=switched[0];
      const migration=this.#db.prepare('SELECT source_manifest_json,source_manifest_digest FROM migration_runs WHERE migration_id=?').get(receipt.migration_id);
      if(!migration)fail('migration_receipt_missing');
      const policy=parseAuthoritySourceManifest(migration.source_manifest_json,migration.source_manifest_digest);
      if(typeof expectedRuntimeRosterDigest!=='string'||!/^[0-9a-f]{64}$/u.test(expectedRuntimeRosterDigest)
        ||receipt.runtime_roster_digest!==expectedRuntimeRosterDigest)fail('authority_runtime_roster_mismatch');
      assertCutoverPublicationGate(this.#db,this.#paths);
      return {kind:'authority_switch',authority_generation:receipt.authority_generation,cutover_id:receipt.cutover_id,
        migration_id:receipt.migration_id,source_root_digest:receipt.source_root_digest,
        source_manifest_digest:receipt.source_manifest_digest,archive_directory:receipt.archive_directory,
        archive_manifest_digest:receipt.archive_manifest_digest,archive_source_tasks_root:receipt.archive_source_tasks_root,
        archive_file_count:receipt.archive_file_count,archive_byte_count:receipt.archive_byte_count,
        historical_exception_count:policy.exceptions.length,
        historical_exception_digest:policy.manifest.historical_exception_digest,
        source_kind:policy.kind,
        verifier_version:receipt.verifier_version};
    });
  }
  /**
   * Record a stop-the-world cutover to a new empty SQLite Task Authority.
   * Legacy history remains solely in the separately verified raw archive.
   */
  recordRawJsonArchiveCutover(snapshot) {
    this.#assertWritable();
    if(!snapshot||Object.getPrototypeOf(snapshot)!==Object.prototype||snapshot.schema_version!==1)fail('invalid_raw_cutover_snapshot');
    const topKeys=['archive','cutover_id','migration_id','protocol_version','runtime_roster_digest','schema_version','source','verifier_version'];
    const source=snapshot.source;
    const sourceKeys=['manifest_digest','manifest_json','root_digest'];
    const archive=snapshot.archive;
    const archiveKeys=['archive_directory','byte_count','file_count','manifest_digest','source_tasks_root'];
    if(Object.keys(snapshot).sort().join('|')!==topKeys.join('|')
      ||!source||Object.getPrototypeOf(source)!==Object.prototype||Object.keys(source).sort().join('|')!==sourceKeys.join('|')
      ||!archive||Object.getPrototypeOf(archive)!==Object.prototype||Object.keys(archive).sort().join('|')!==archiveKeys.join('|')
      ||!validId(snapshot.migration_id)||!validId(snapshot.cutover_id)||!validText(snapshot.verifier_version,128)
      ||!validText(snapshot.protocol_version,128)||typeof snapshot.runtime_roster_digest!=='string'||!/^[0-9a-f]{64}$/u.test(snapshot.runtime_roster_digest)
      ||typeof source.root_digest!=='string'||!/^[0-9a-f]{64}$/u.test(source.root_digest)
      ||typeof source.manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(source.manifest_digest)
      ||typeof source.manifest_json!=='string'||digest(source.manifest_json)!==source.manifest_digest
      ||!validText(archive.archive_directory,32767)||!path.isAbsolute(archive.archive_directory)
      ||!validText(archive.source_tasks_root,32767)||!path.isAbsolute(archive.source_tasks_root)
      ||typeof archive.manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(archive.manifest_digest)
      ||!Number.isSafeInteger(archive.file_count)||archive.file_count<0
      ||!Number.isSafeInteger(archive.byte_count)||archive.byte_count<0)fail('invalid_raw_cutover_snapshot');
    const policy=parseAuthoritySourceManifest(source.manifest_json,source.manifest_digest);
    if(policy.kind!=='raw_json_archive_cutover'
      ||policy.manifest.source_tasks_root!==archive.source_tasks_root
      ||policy.manifest.archive_manifest_digest!==archive.manifest_digest
      ||policy.manifest.archive_file_count!==archive.file_count
      ||policy.manifest.archive_byte_count!==archive.byte_count)fail('raw_cutover_archive_identity_mismatch');
    const at=new Date().toISOString();
    return this.#transaction(()=>{
      if(this.#db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM migration_runs').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM fresh_install_receipt').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM authority_switch').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM manager_operations').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM json_artifacts').get().n!==0)fail('migration_target_not_empty');
      this.#db.prepare(`INSERT INTO migration_runs(migration_id,state,source_root_digest,source_manifest_json,source_manifest_digest,
        source_task_count,source_artifact_count,source_artifact_bytes,source_result_count,source_event_count,
        archive_directory,archive_manifest_digest,archive_source_tasks_root,archive_file_count,archive_byte_count,
        verifier_version,created_at,verified_at)
        VALUES(?,'verified',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        snapshot.migration_id,source.root_digest,source.manifest_json,source.manifest_digest,
        0,archive.file_count,archive.byte_count,0,0,
        archive.archive_directory,archive.manifest_digest,archive.source_tasks_root,
        archive.file_count,archive.byte_count,snapshot.verifier_version,at,at);
      const inserted=this.#db.prepare(`INSERT INTO authority_switch(singleton,authority_generation,cutover_id,migration_id,source_root_digest,
        source_manifest_digest,archive_directory,archive_manifest_digest,archive_source_tasks_root,archive_file_count,
        archive_byte_count,schema_version,protocol_version,runtime_roster_digest,verifier_version,created_at)
        VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        snapshot.cutover_id,snapshot.migration_id,source.root_digest,source.manifest_digest,
        archive.archive_directory,archive.manifest_digest,archive.source_tasks_root,
        archive.file_count,archive.byte_count,SCHEMA_VERSION,snapshot.protocol_version,
        snapshot.runtime_roster_digest,snapshot.verifier_version,at);
      if(inserted.changes!==1)fail('authority_switch_insert_failed');
      return {migration_id:snapshot.migration_id,cutover_id:snapshot.cutover_id,event_cursor:0,
        task_count:0,artifact_count:0,result_count:0,historical_exception_count:0};
    });
  }
  /**
   * Import one already parsed and path-validated sealed JSON snapshot.
   * This method never scans the source. The caller must reverify source and
   * independently read the staging database before publishing the file.
   */
  importJsonAuthoritySnapshot(snapshot) {
    this.#assertWritable();
    if(!snapshot||Object.getPrototypeOf(snapshot)!==Object.prototype||snapshot.schema_version!==1)fail('invalid_migration_snapshot');
    const topKeys=['archive','artifacts','cutover_id','events','historical_exceptions','migration_id','protocol_version','results','runtime_roster_digest','schema_version','source','tasks','verifier_version'];
    if(Object.keys(snapshot).sort().join('|')!==topKeys.join('|'))fail('invalid_migration_snapshot');
    const source=snapshot.source;
    const sourceKeys=['artifact_bytes','artifact_count','event_count','historical_exception_count','historical_exception_digest','manifest_digest','manifest_json','result_count','root_digest','task_count'];
    const archive=snapshot.archive;
    const archiveKeys=['archive_directory','byte_count','file_count','manifest_digest','source_tasks_root'];
    if(!source||Object.getPrototypeOf(source)!==Object.prototype||Object.keys(source).sort().join('|')!==sourceKeys.join('|')
      ||!archive||Object.getPrototypeOf(archive)!==Object.prototype||Object.keys(archive).sort().join('|')!==archiveKeys.join('|')
      ||!validId(snapshot.migration_id)||!validId(snapshot.cutover_id)||!validText(snapshot.verifier_version,128)
      ||!validText(snapshot.protocol_version,128)||typeof snapshot.runtime_roster_digest!=='string'||!/^[0-9a-f]{64}$/u.test(snapshot.runtime_roster_digest)
      ||typeof source.root_digest!=='string'||!/^[0-9a-f]{64}$/u.test(source.root_digest)
      ||typeof source.manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(source.manifest_digest)
      ||typeof source.manifest_json!=='string'||digest(source.manifest_json)!==source.manifest_digest
      ||!validText(archive.archive_directory,32767)||!path.isAbsolute(archive.archive_directory)
      ||!validText(archive.source_tasks_root,32767)||!path.isAbsolute(archive.source_tasks_root)
      ||typeof archive.manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(archive.manifest_digest)
      ||!Number.isSafeInteger(archive.file_count)||archive.file_count<0
      ||!Number.isSafeInteger(archive.byte_count)||archive.byte_count<0
      ||archive.file_count!==source.artifact_count||archive.byte_count!==source.artifact_bytes
      ||!Array.isArray(snapshot.tasks)||!Array.isArray(snapshot.artifacts)||!Array.isArray(snapshot.results)||!Array.isArray(snapshot.events)
      ||!Array.isArray(snapshot.historical_exceptions)
      ||![source.task_count,source.artifact_count,source.artifact_bytes,source.result_count,source.event_count].every(v=>Number.isSafeInteger(v)&&v>=0)
      ||!Number.isSafeInteger(source.historical_exception_count)||source.historical_exception_count<0
      ||typeof source.historical_exception_digest!=='string'||!/^[0-9a-f]{64}$/u.test(source.historical_exception_digest)
      ||source.historical_exception_count!==snapshot.historical_exceptions.length
      ||source.historical_exception_digest!==historicalResultExceptionSetDigest(snapshot.historical_exceptions)
      ||source.artifact_count!==snapshot.artifacts.length
      ||source.result_count!==snapshot.results.length||source.event_count!==snapshot.events.length)fail('invalid_migration_snapshot');
    const sourceManifest=parseHistoricalExceptionManifest(source.manifest_json,source.manifest_digest);
    if(sourceManifest.manifest.task_count!==source.task_count
      ||sourceManifest.manifest.artifact_count!==source.artifact_count
      ||sourceManifest.manifest.artifact_bytes!==source.artifact_bytes
      ||sourceManifest.manifest.result_count!==source.result_count
      ||sourceManifest.manifest.event_count!==source.event_count
      ||sourceManifest.manifest.historical_exception_count!==source.historical_exception_count
      ||sourceManifest.manifest.historical_exception_digest!==source.historical_exception_digest
      ||canonical(sourceManifest.exceptions)!==canonical(snapshot.historical_exceptions))fail('invalid_source_manifest');
    validateHistoricalExceptionSnapshot(snapshot,sourceManifest);
    const at=new Date().toISOString();
    return this.#transaction(()=>{
      if(this.#db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM migration_runs').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM fresh_install_receipt').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM authority_switch').get().n!==0
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM manager_operations').get().n!==0)fail('migration_target_not_empty');
      const tasksById=new Map();
      for(const task of snapshot.tasks){
        const taskKeys=['attempts','created_at','current_attempt','status','task','task_id'];
        if(!task||Object.getPrototypeOf(task)!==Object.prototype||Object.keys(task).sort().join('|')!==taskKeys.join('|')
          ||!validId(task.task_id)||!task.task||Object.getPrototypeOf(task.task)!==Object.prototype
          ||task.task.task_id!==task.task_id||!validText(task.created_at,64)
          ||Number.isNaN(Date.parse(task.created_at))||!Number.isSafeInteger(task.current_attempt)||task.current_attempt<1
          ||!['queued','running','completed','failed','cancelled','waiting_for_master'].includes(task.status)
          ||!Array.isArray(task.attempts)||tasksById.has(task.task_id))fail('invalid_migrated_task');
        try{validateTaskPackage(task.task);}catch{fail('invalid_migrated_task');}
        if(task.status==='running')fail('running_task_not_migratable');
        this.#db.prepare('INSERT INTO tasks(task_id,task_json,status,current_attempt,created_at) VALUES(?,?,?,?,?)')
          .run(task.task_id,canonical(task.task),task.status,task.current_attempt,task.created_at);
        const seen=new Set();
        for(const attempt of task.attempts){
          const attemptKeys=['attempt','created_at','status'];
          if(!attempt||Object.getPrototypeOf(attempt)!==Object.prototype||Object.keys(attempt).sort().join('|')!==attemptKeys.join('|')
            ||!Number.isSafeInteger(attempt.attempt)||attempt.attempt<1||seen.has(attempt.attempt)
            ||!validText(attempt.created_at,64)||Number.isNaN(Date.parse(attempt.created_at))
            ||!['queued','completed','failed','cancelled','waiting_for_master'].includes(attempt.status))fail('invalid_migrated_attempt');
          seen.add(attempt.attempt);
          this.#db.prepare("INSERT INTO attempts(task_id,attempt,generation,status,created_at) VALUES(?,?,NULL,?,?)")
            .run(task.task_id,attempt.attempt,attempt.status,attempt.created_at);
        }
        const current=[...task.attempts].find(a=>a.attempt===task.current_attempt);
        if(!current||current.status!==task.status)fail('migrated_task_attempt_mismatch');
        for(let n=1;n<=task.current_attempt;n++)if(!seen.has(n))fail('migrated_attempt_gap');
        tasksById.set(task.task_id,task);
      }
      this.#db.prepare(`INSERT INTO migration_runs(migration_id,state,source_root_digest,source_manifest_json,source_manifest_digest,
        source_task_count,source_artifact_count,source_artifact_bytes,source_result_count,source_event_count,
        archive_directory,archive_manifest_digest,archive_source_tasks_root,archive_file_count,archive_byte_count,
        verifier_version,created_at,verified_at)
        VALUES(?,'verified',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.migration_id,source.root_digest,source.manifest_json,source.manifest_digest,
        source.task_count,source.artifact_count,source.artifact_bytes,source.result_count,source.event_count,
        archive.archive_directory,archive.manifest_digest,archive.source_tasks_root,archive.file_count,archive.byte_count,
        snapshot.verifier_version,at,at);
      let artifactBytes=0;
      const artifactsById=new Map();
      for(const artifact of snapshot.artifacts){
        const keys=['artifact_id','attempt','byte_length','content','kind','relative_path','sha256','task_id'];
        if(!artifact||Object.getPrototypeOf(artifact)!==Object.prototype||Object.keys(artifact).sort().join('|')!==keys.join('|')
          ||!validId(artifact.artifact_id)||!validText(artifact.relative_path,1024)||artifact.relative_path.includes('\\')
          ||artifact.relative_path.startsWith('/')||artifact.relative_path.split('/').some(v=>!v||v==='.'||v==='..')
          ||!validText(artifact.kind,64)||!Number.isSafeInteger(artifact.byte_length)||artifact.byte_length<0||artifact.byte_length>67108864
          ||typeof artifact.sha256!=='string'||!/^[0-9a-f]{64}$/u.test(artifact.sha256)
          ||!(artifact.content instanceof Uint8Array)||artifact.content.byteLength!==artifact.byte_length
          ||rawDigest(artifact.content)!==artifact.sha256
          ||(artifact.task_id!==null&&!tasksById.has(artifact.task_id))
          ||(artifact.attempt!==null&&(!Number.isSafeInteger(artifact.attempt)||artifact.attempt<1))
          ||(artifact.attempt!==null&&artifact.task_id===null)
          ||artifactsById.has(artifact.artifact_id)
          ||[...artifactsById.values()].some(existing=>existing.relative_path===artifact.relative_path))fail('invalid_migrated_artifact');
        if(artifact.attempt!==null&&!this.#db.prepare('SELECT 1 FROM attempts WHERE task_id=? AND attempt=?').get(artifact.task_id,artifact.attempt))
          fail('invalid_migrated_artifact_attempt');
        const content=Buffer.from(artifact.content);
        this.#db.prepare('INSERT INTO json_artifacts(artifact_id,migration_id,relative_path,task_id,attempt,kind,byte_length,sha256,content,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(artifact.artifact_id,snapshot.migration_id,artifact.relative_path,artifact.task_id,artifact.attempt,artifact.kind,artifact.byte_length,artifact.sha256,content,at);
        artifactsById.set(artifact.artifact_id,artifact);
        artifactBytes+=artifact.byte_length;
      }
      if(artifactBytes!==source.artifact_bytes)fail('migration_artifact_bytes_mismatch');
      for(const result of snapshot.results){
        const keys=['artifact_id','attempt','result','task_id'];
        if(!result||Object.getPrototypeOf(result)!==Object.prototype||Object.keys(result).sort().join('|')!==keys.join('|')
          ||!tasksById.has(result.task_id)||!Number.isSafeInteger(result.attempt)||result.attempt<1
          ||!validId(result.artifact_id))fail('invalid_migrated_result');
        const task=tasksById.get(result.task_id);
        const artifact=artifactsById.get(result.artifact_id);
        const expectedPath=result.attempt===task.current_attempt
          ? `${result.task_id}/result.json`
          : `${result.task_id}/attempts/${result.attempt}/result.json`;
        const currentResultArtifact=artifact?.attempt===null&&artifact?.kind==='task_result'&&expectedPath===`${result.task_id}/result.json`;
        if(!task.attempts.some(value=>value.attempt===result.attempt)||!artifact
          ||artifact.task_id!==result.task_id||(artifact.attempt!==result.attempt&&!currentResultArtifact)||artifact.relative_path!==expectedPath)
          fail('migrated_result_artifact_mismatch');
        let canonicalResult;
        try{canonicalResult=canonicalTaskResult(result.result,{task_id:result.task_id,attempt:result.attempt,result_status:result.result?.status});}
        catch{fail('invalid_migrated_result');}
        this.#db.prepare('INSERT INTO migrated_task_results(task_id,attempt,result_json,result_digest,artifact_id) VALUES(?,?,?,?,?)')
          .run(result.task_id,result.attempt,canonicalResult,digest(canonicalResult),result.artifact_id);
      }
      let cursor=0;
      for(const event of snapshot.events){
        const keys=['artifact_id','at','attempt','details','event_type','source_sequence','summary','task_id'];
        if(!event||Object.getPrototypeOf(event)!==Object.prototype||Object.keys(event).sort().join('|')!==keys.join('|')
          ||!tasksById.has(event.task_id)||!Number.isSafeInteger(event.source_sequence)||event.source_sequence<1
          ||!validText(event.event_type,128)||!validText(event.at,64)||Number.isNaN(Date.parse(event.at))
          ||!validText(event.summary,4096)||!validId(event.artifact_id)
          ||(event.attempt!==null&&(!Number.isSafeInteger(event.attempt)||event.attempt<1))
          ||(event.details!==null&&(Object.getPrototypeOf(event.details)!==Object.prototype)))fail('invalid_migrated_event');
        const artifact=artifactsById.get(event.artifact_id);
        if(!artifact||artifact.task_id!==event.task_id||artifact.attempt!==null||artifact.relative_path!==`${event.task_id}/events.jsonl`)
          fail('migrated_event_artifact_mismatch');
        const detailsJson=event.details===null?null:canonical(event.details);
        if(detailsJson!==null&&Buffer.byteLength(detailsJson,'utf8')>1048576)fail('invalid_migrated_event');
        cursor+=1;
        this.#db.prepare(`INSERT INTO migrated_task_events(event_cursor,task_id,attempt,source_sequence,event_type,at,summary,details_json,details_digest,artifact_id)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(cursor,event.task_id,event.attempt,event.source_sequence,event.event_type,event.at,event.summary,
          detailsJson,detailsJson===null?null:digest(detailsJson),event.artifact_id);
      }
      const changed=this.#db.prepare('UPDATE authority_metadata SET next_event_cursor=? WHERE singleton=1 AND next_event_cursor=0').run(cursor);
      if(changed.changes!==1)fail('event_cursor_authority_not_initial');
      if(cursor>0){
        const sequence=this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name='manager_operation_events'").get();
        if(sequence)this.#db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='manager_operation_events'").run(cursor);
        else this.#db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('manager_operation_events',?)").run(cursor);
      }
      const inserted=this.#db.prepare(`INSERT INTO authority_switch(singleton,authority_generation,cutover_id,migration_id,source_root_digest,
        source_manifest_digest,archive_directory,archive_manifest_digest,archive_source_tasks_root,archive_file_count,
        archive_byte_count,schema_version,protocol_version,runtime_roster_digest,verifier_version,created_at)
        VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.cutover_id,snapshot.migration_id,source.root_digest,source.manifest_digest,
        archive.archive_directory,archive.manifest_digest,archive.source_tasks_root,archive.file_count,archive.byte_count,
        SCHEMA_VERSION,snapshot.protocol_version,snapshot.runtime_roster_digest,snapshot.verifier_version,at);
      if(inserted.changes!==1)fail('authority_switch_insert_failed');
      return {migration_id:snapshot.migration_id,cutover_id:snapshot.cutover_id,event_cursor:cursor,
        task_count:snapshot.tasks.length,artifact_count:snapshot.artifacts.length,result_count:snapshot.results.length,
        historical_exception_count:snapshot.historical_exceptions.length};
    });
  }
  /** Persist a TaskPackage and its initial queued Attempt in this candidate authority. */
  createTask(task, createdAt = new Date().toISOString()) {
    this.#assertWritable();
    validateTaskPackage(task);
    if(!validText(createdAt,64)||Number.isNaN(Date.parse(createdAt)))fail('invalid_task_created_at');
    const taskJson=canonical(task);
    return this.#transaction(()=>{
      if(this.#db.prepare('SELECT task_id FROM tasks WHERE task_id=?').get(task.task_id))fail('task_already_exists');
      this.#db.prepare("INSERT INTO tasks(task_id,task_json,status,current_attempt,created_at) VALUES(?,?,'queued',1,?)").run(task.task_id,taskJson,createdAt);
      this.#db.prepare("INSERT INTO attempts(task_id,attempt,generation,status,created_at) VALUES(?,1,NULL,'queued',?)").run(task.task_id,createdAt);
      this.#faultPoint('after_projection');
      return {task_id:task.task_id,current_attempt:1,status:'queued',created_at:createdAt};
    });
  }
  readTask(taskId) {
    return this.#readConsistent(()=>{
      const row=this.#db.prepare('SELECT task_json FROM tasks WHERE task_id=?').get(taskId);
      if(!row)return null;
      let task;try{task=JSON.parse(row.task_json);}catch{fail('task_projection_invalid');}
      validateTaskPackage(task);
      if(task.task_id!==taskId)fail('task_projection_identity_mismatch');
      return task;
    });
  }
  readTaskProjection(taskId) {
    return this.#readConsistent(()=>this.#db.prepare('SELECT task_id,status,current_attempt,created_at FROM tasks WHERE task_id=?').get(taskId)??null);
  }
  /** Return only the current queued Attempt for each queued Task, with an explicit safe-to-dispatch classification. */
  readRecoverableQueuedAttempts() {
    return this.#readConsistent(()=>{
      const rows=this.#db.prepare(`SELECT t.task_id,t.status AS task_status,t.current_attempt,t.created_at,t.task_json,
          a.attempt,a.generation,a.status AS attempt_status,
          o.operation_id,o.task_id AS operation_task_id,o.attempt AS operation_attempt,o.generation AS operation_generation,
          o.revision AS operation_revision,o.phase,o.reservation_id,o.capacity_slot,
          o.launch_id,o.launch_epoch,o.launch_token_digest,o.launch_intent_digest,
          o.launch_receipt_id,o.launch_receipt_digest,o.launch_identity_json,
          o.claim_id,o.claim_request_digest,o.claim_worker_identity_json,o.claim_worker_identity_digest,
          o.claim_launch_id,o.claim_generation,o.claim_token_digest,
          o.result_status,o.result_generation,o.result_digest,o.result_json,o.result_commit_ref
        FROM tasks t JOIN attempts a ON a.task_id=t.task_id AND a.attempt=t.current_attempt
        LEFT JOIN manager_operations o ON o.operation_kind='attempt_lifecycle' AND o.task_id=t.task_id AND o.attempt=a.attempt
        WHERE t.status='queued' AND a.status='queued' ORDER BY t.created_at,t.task_id`).all();
      return rows.map(row=>{
        let task;try{task=JSON.parse(row.task_json);}catch{fail('task_projection_invalid');}
        validateTaskPackage(task);
        if(task.task_id!==row.task_id||row.attempt!==row.current_attempt)fail('task_attempt_projection_mismatch');
        const hasOperation=row.operation_id!==null;
        if(!hasOperation&&row.generation!==null)fail('queued_attempt_generation_without_operation');
        if(hasOperation&&(row.operation_task_id!==row.task_id||row.operation_attempt!==row.attempt
          ||row.operation_generation!==row.generation||row.generation===null))fail('queued_operation_identity_mismatch');
        let dispatchable=!hasOperation;
        let reason=hasOperation?'operation_requires_recovery':null;
        if(hasOperation&&row.phase==='reserved'&&row.operation_revision===1
          &&row.launch_id===null&&row.launch_epoch===null&&row.launch_token_digest===null&&row.launch_intent_digest===null
          &&row.launch_receipt_id===null&&row.launch_receipt_digest===null&&row.launch_identity_json===null
          &&row.claim_id===null&&row.claim_request_digest===null&&row.claim_worker_identity_json===null
          &&row.claim_worker_identity_digest===null&&row.claim_launch_id===null&&row.claim_generation===null&&row.claim_token_digest===null
          &&row.result_status===null&&row.result_generation===null&&row.result_digest===null&&row.result_json===null&&row.result_commit_ref===null){
          const events=this.#db.prepare('SELECT operation_id,event_cursor,sequence,event_type,from_phase,to_phase,generation,evidence_json FROM manager_operation_events WHERE operation_id=? ORDER BY sequence').all(row.operation_id);
          if(events.length!==1||events[0].sequence!==1||events[0].event_type!=='reserved'||events[0].from_phase!==null
            ||events[0].operation_id!==row.operation_id||!Number.isSafeInteger(events[0].event_cursor)||events[0].event_cursor<1
            ||events[0].to_phase!=='reserved'||events[0].generation!==row.generation)fail('reserved_operation_history_invalid');
          let evidence;try{evidence=JSON.parse(events[0].evidence_json);}catch{fail('reserved_operation_history_invalid');}
          if(evidence.reservation_id!==row.reservation_id||evidence.capacity_slot!==row.capacity_slot)fail('reserved_operation_history_invalid');
          dispatchable=true;reason=null;
        }
        return {task,task_id:row.task_id,attempt:row.attempt,generation:row.generation,
          operation_id:row.operation_id,phase:row.phase??null,dispatchable,reason};
      });
    });
  }
  readAttempt(taskId, attempt) {
    if(!validId(taskId)||!Number.isSafeInteger(attempt)||attempt<1)fail('invalid_attempt_identity');
    return this.#readConsistent(()=>this.#db.prepare('SELECT task_id,attempt,generation,status,created_at FROM attempts WHERE task_id=? AND attempt=?').get(taskId,attempt)??null);
  }
  /** Read one imported historical Result without treating JSON as online authority. */
  readMigratedResult(taskId, attempt) {
    if(!validId(taskId)||!Number.isSafeInteger(attempt)||attempt<1)fail('invalid_result_identity');
    return this.#readConsistent(()=>{
      const row=this.#db.prepare('SELECT task_id,attempt,result_json,result_digest,artifact_id FROM migrated_task_results WHERE task_id=? AND attempt=?').get(taskId,attempt);
      if(!row)return null;
      let result;
      try{result=JSON.parse(row.result_json);}
      catch{fail('migrated_result_projection_invalid');}
      if(digest(row.result_json)!==row.result_digest)fail('migrated_result_digest_mismatch');
      return {task_id:row.task_id,attempt:row.attempt,result,artifact_id:row.artifact_id};
    });
  }
  /** Read the immutable, archive-only Result exceptions bound into the source Manifest. */
  readMigratedHistoryExceptions() {
    return this.#readConsistent(()=>{
      const migration=this.#db.prepare('SELECT source_manifest_json,source_manifest_digest FROM migration_runs').get();
      if(!migration)return [];
      return parseHistoricalExceptionManifest(migration.source_manifest_json,migration.source_manifest_digest).exceptions;
    });
  }
  /** Read the Task, current Attempt, bound Operation and verified Result in one snapshot. */
  readTaskLifecycle(taskId) {
    if(!validId(taskId))fail('invalid_task_id');
    return this.#readConsistent(()=>{
      const taskRow=this.#db.prepare('SELECT task_id,status,current_attempt,created_at,task_json FROM tasks WHERE task_id=?').get(taskId);
      if(!taskRow)return null;
      let task;try{task=JSON.parse(taskRow.task_json);}catch{fail('task_projection_invalid');}
      validateTaskPackage(task);if(task.task_id!==taskId)fail('task_projection_identity_mismatch');
      const attemptRow=this.#db.prepare('SELECT task_id,attempt,generation,status,created_at,continuation_operation_id,continuation_json,continuation_digest,queued_cancel_result_json FROM attempts WHERE task_id=? AND attempt=?').get(taskId,taskRow.current_attempt);
      const attempt=attemptRow?{task_id:attemptRow.task_id,attempt:attemptRow.attempt,generation:attemptRow.generation,status:attemptRow.status,created_at:attemptRow.created_at}:null;
      if(!attempt)fail('task_attempt_projection_mismatch');
      const operationRow=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND task_id=? AND attempt=?").get(taskId,taskRow.current_attempt);
      const operation=operationRow?presentOperation(operationRow):null;
      let result=null;
      if(operationRow?.result_json!==null&&operationRow?.result_json!==undefined){try{result=JSON.parse(operationRow.result_json);}catch{fail('result_projection_invalid');}}
      else if(attemptRow.queued_cancel_result_json!==null){try{result=JSON.parse(attemptRow.queued_cancel_result_json);}catch{fail('result_projection_invalid');}}
      else {
        const migrated=this.#db.prepare('SELECT result_json FROM migrated_task_results WHERE task_id=? AND attempt=?').get(taskId,taskRow.current_attempt);
        if(migrated){try{result=JSON.parse(migrated.result_json);}catch{fail('result_projection_invalid');}}
      }
      const continuation=attemptRow.continuation_json===null?null:JSON.parse(attemptRow.continuation_json);
      return {task,projection:{task_id:taskRow.task_id,status:taskRow.status,current_attempt:taskRow.current_attempt,created_at:taskRow.created_at},attempt,operation,result,continuation};
    });
  }
  /** Conservative Candidate feedback projection. No runtime observation or
   * report_ready event is currently persisted by the SQLite lifecycle path. */
  readTaskFeedback(taskId) {
    const snapshot=this.readTaskLifecycle(taskId);
    if(!snapshot)return null;
    if(snapshot.projection.status!==snapshot.attempt.status)fail('task_attempt_projection_mismatch');
    return {
      schema_version:'0.1',
      task_id:snapshot.projection.task_id,
      attempt:snapshot.attempt.attempt,
      status:snapshot.projection.status,
      model:null,
      phase:null,
      progress:null,
      activity:null,
      interaction:{state:'not_observed',kind:null},
      // Candidate results do not yet carry the distinct report_ready runtime
      // fact required by the frozen feedback contract.
      result:null,
    };
  }
  /** Persist a request received from the currently claimed Worker channel. */
  recordInteractionRequest(input) {
    this.#assertWritable();
    const request=input?.request;
    if(!validateInteractionRequest(request))fail('invalid_interaction_request');
    if(!validInteractionFence(input)||typeof input.worker_identity_digest!=='string'||!/^[0-9a-f]{64}$/u.test(input.worker_identity_digest))fail('invalid_interaction_fence');
    const requestJson=interactionCanonical(request);
    if(Buffer.byteLength(requestJson,'utf8')>1048576)fail('interaction_request_too_large');
    const requestDigest=interactionDigest({interaction_contract_version:1,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,
      generation:input.generation,claim_id:input.claim_id,worker_identity_digest:input.worker_identity_digest,request});
    return this.#transaction(()=>{
      const existing=this.#db.prepare('SELECT * FROM manager_interaction_payloads WHERE operation_id=? AND request_id=?').get(input.operation_id,request.request_id);
      if(existing){if(existing.request_digest!==requestDigest||existing.task_id!==input.task_id||existing.attempt!==input.attempt
          ||existing.generation!==input.generation||existing.claim_id!==input.claim_id||existing.worker_identity_digest!==input.worker_identity_digest)
          fail('interaction_request_conflict');
        const event=this.#db.prepare("SELECT sequence FROM manager_operation_events WHERE operation_id=? AND event_type='interaction_requested' AND json_extract(evidence_json,'$.request_id')=?").get(input.operation_id,request.request_id);
        if(!event)fail('interaction_history_mismatch');
        return {duplicate:true,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,generation:input.generation,
          request_id:request.request_id,revision:this.#db.prepare('SELECT revision FROM manager_operations WHERE operation_id=?').get(input.operation_id).revision,
          event_sequence:event.sequence,request_digest:requestDigest};
      }
      const o=this.#attemptOperation(input);
      this.#assertRecoveryNotLatched(o.operation_id);
      this.#assertInteractionRunning(o,input);
      if(o.revision!==input.expected_revision)fail('stale_interaction_cas');
      const priorCount=this.#db.prepare('SELECT COUNT(*) AS n FROM manager_interaction_payloads WHERE operation_id=?').get(o.operation_id).n;
      if(priorCount>=128)fail('interaction_request_limit');
      const changed=this.#db.prepare("UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='running' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?")
        .run(o.operation_id,o.task_id,o.attempt,o.generation,o.revision,o.claim_id,o.generation,o.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_interaction_cas');
      this.#faultPoint('after_projection');
      this.#db.prepare('INSERT INTO manager_interaction_payloads(operation_id,request_id,task_id,attempt,generation,claim_id,worker_identity_digest,request_method,request_json,request_digest) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(o.operation_id,request.request_id,o.task_id,o.attempt,o.generation,o.claim_id,o.claim_worker_identity_digest,request.method,requestJson,requestDigest);
      this.#faultPoint('after_interaction_payload');
      const at=new Date().toISOString();
      this.#event(o.operation_id,o.revision+1,'interaction_requested','running','running',o.generation,
        {claim_id:o.claim_id,request_digest:requestDigest,request_id:request.request_id,request_method:request.method,worker_identity_digest:o.claim_worker_identity_digest},at);
      return {duplicate:false,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,
        worker_identity_digest:o.claim_worker_identity_digest,request_id:request.request_id,request_digest:requestDigest,
        revision:o.revision+1,event_sequence:o.revision+1};
    });
  }
  /** Read the current Attempt's request and derive state only from immutable events. */
  readInteractionRequest(taskId,requestId) {
    if(!validId(taskId)||typeof requestId!=='string'||!validId(requestId)||requestId.length>512)fail('invalid_interaction_request_id');
    return this.#readConsistent(()=>{
      const task=this.#db.prepare('SELECT current_attempt FROM tasks WHERE task_id=?').get(taskId);if(!task)fail('task_not_found');
      const payload=this.#db.prepare('SELECT * FROM manager_interaction_payloads WHERE task_id=? AND attempt=? AND request_id=?').get(taskId,task.current_attempt,requestId);
      if(!payload)return null;
      const events=this.#db.prepare("SELECT sequence,event_type,evidence_json,evidence_digest FROM manager_operation_events WHERE operation_id=? AND json_extract(evidence_json,'$.request_id')=? AND event_type IN ('interaction_requested','interaction_reply_intent','interaction_reply_prepared','interaction_reply_committed','interaction_reply_accepted') ORDER BY sequence")
        .all(payload.operation_id,requestId).map(e=>({...e,evidence:JSON.parse(e.evidence_json)}));
      const requestEvent=events.find(e=>e.event_type==='interaction_requested');
      const intent=events.find(e=>e.event_type==='interaction_reply_intent');
      const prepared=events.find(e=>e.event_type==='interaction_reply_prepared');
      const committed=events.find(e=>e.event_type==='interaction_reply_committed');
      const accepted=events.find(e=>e.event_type==='interaction_reply_accepted');
      if(!requestEvent||events.filter(e=>e.event_type==='interaction_requested').length!==1||events.filter(e=>e.event_type==='interaction_reply_intent').length>1
        ||events.filter(e=>e.event_type==='interaction_reply_prepared').length>1||events.filter(e=>e.event_type==='interaction_reply_committed').length>1
        ||events.filter(e=>e.event_type==='interaction_reply_accepted').length>1||accepted&&!committed
        ||events.some(e=>e.evidence_digest!==digest(e.evidence_json))
        ||requestEvent.evidence.request_digest!==payload.request_digest||requestEvent.evidence.request_method!==payload.request_method
        ||intent&&(intent.sequence<=requestEvent.sequence||intent.evidence.reply_id!==payload.reply_id||intent.evidence.answer_digest!==payload.answer_digest)
        ||prepared&&(!intent||prepared.sequence!==intent.sequence+1||prepared.evidence.reply_id!==payload.reply_id
          ||prepared.evidence.answer_digest!==payload.answer_digest)
        ||committed&&(!prepared||committed.sequence!==prepared.sequence+1||committed.evidence.reply_id!==payload.reply_id
          ||committed.evidence.answer_digest!==payload.answer_digest||committed.evidence.prepared_digest!==prepared.evidence.prepared_digest)
        ||accepted&&(!committed||accepted.sequence!==committed.sequence+1||accepted.evidence.reply_id!==payload.reply_id
          ||accepted.evidence.answer_digest!==payload.answer_digest||accepted.evidence.commit_digest!==committed.evidence.commit_digest))fail('interaction_history_mismatch');
      const request=JSON.parse(payload.request_json);
      if(!validateInteractionRequest(request)||interactionCanonical(request)!==payload.request_json
        ||request.request_id!==requestId||request.method!==payload.request_method
        ||payload.request_digest!==interactionDigest({interaction_contract_version:1,operation_id:payload.operation_id,task_id:payload.task_id,
          attempt:payload.attempt,generation:payload.generation,claim_id:payload.claim_id,worker_identity_digest:payload.worker_identity_digest,request}))
        fail('interaction_history_mismatch');
      if(intent){const answer=JSON.parse(payload.answer_json);
        if(interactionCanonical(answer)!==payload.answer_json||!validPersistedInteractionAnswer(request,answer)
          ||payload.answer_digest!==interactionDigest({interaction_reply_contract_version:1,operation_id:payload.operation_id,task_id:payload.task_id,
            attempt:payload.attempt,generation:payload.generation,claim_id:payload.claim_id,worker_identity_digest:payload.worker_identity_digest,request_id:requestId,answer}))
          fail('interaction_history_mismatch');}
      return {operation_id:payload.operation_id,task_id:payload.task_id,attempt:payload.attempt,generation:payload.generation,
        claim_id:payload.claim_id,worker_identity_digest:payload.worker_identity_digest,request,
        request_digest:payload.request_digest,state:accepted?'answered':intent?'unknown':'pending',
        ...(intent?{reply_id:intent.evidence.reply_id,answer_digest:intent.evidence.answer_digest}:{}),
        ...(accepted?{answer:JSON.parse(payload.answer_json),ack_digest:accepted.evidence.ack_digest}:{})};
    });
  }
  /** Persist reply intent before any channel write. An intent without accepted ack is never replayed. */
  beginInteractionReply(input) {
    this.#assertWritable();
    if(!validInteractionReplyInput(input))fail('invalid_interaction_reply');
    return this.#transaction(()=>{
      const task=this.#db.prepare('SELECT status,current_attempt FROM tasks WHERE task_id=?').get(input.task_id);if(!task)fail('task_not_found');
      const o=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND task_id=? AND attempt=?").get(input.task_id,task.current_attempt);
      if(!o)fail('interaction_operation_missing');
      const p=this.#db.prepare('SELECT * FROM manager_interaction_payloads WHERE operation_id=? AND request_id=?').get(o.operation_id,input.request_id);
      if(!p)fail('interaction_request_not_found');
      const ev=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='interaction_requested' AND json_extract(evidence_json,'$.request_id')=?").get(o.operation_id,input.request_id);
      if(!ev||ev.evidence_digest!==digest(ev.evidence_json)||JSON.parse(ev.evidence_json).request_digest!==p.request_digest)fail('interaction_history_mismatch');
      const previous=this.#db.prepare("SELECT event_type,evidence_json FROM manager_operation_events WHERE operation_id=? AND json_extract(evidence_json,'$.request_id')=? AND event_type IN ('interaction_reply_intent','interaction_reply_accepted') ORDER BY sequence").all(o.operation_id,input.request_id);
      if(previous.some(e=>e.event_type==='interaction_reply_accepted'))fail('interaction_already_answered');
      if(previous.some(e=>e.event_type==='interaction_reply_intent'))fail('interaction_reply_outcome_unknown');
      if(task.status!=='running'||o.phase!=='running'||o.task_id!==p.task_id||o.attempt!==p.attempt||o.generation!==p.generation
        ||o.claim_id!==p.claim_id||o.claim_worker_identity_digest!==p.worker_identity_digest)fail('stale_interaction_identity');
      this.#assertRecoveryNotLatched(o.operation_id);
      this.#assertNoCancellationIntent(o.operation_id);
      this.#assertInteractionRunning(o,{task_id:p.task_id,attempt:p.attempt,generation:p.generation,claim_id:p.claim_id,
        claim_worker_identity_digest:p.worker_identity_digest,worker_identity_digest:p.worker_identity_digest});
      const request=JSON.parse(p.request_json);const answer=buildInteractionAnswer(request,input);const answerJson=interactionCanonical(answer);
      if(Buffer.byteLength(answerJson,'utf8')>20000)fail('interaction_answer_too_large');
      const answerDigest=interactionDigest({interaction_reply_contract_version:1,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,
        generation:o.generation,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,request_id:input.request_id,answer});
      const replyId=randomUUID();
      const changed=this.#db.prepare("UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='running' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?")
        .run(o.operation_id,o.task_id,o.attempt,o.generation,o.revision,o.claim_id,o.generation,o.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_interaction_cas');
      const saved=this.#db.prepare('UPDATE manager_interaction_payloads SET answer_json=?,answer_digest=?,reply_id=? WHERE operation_id=? AND request_id=? AND answer_json IS NULL')
        .run(answerJson,answerDigest,replyId,o.operation_id,input.request_id);
      if(saved.changes!==1)fail('interaction_reply_conflict');
      this.#faultPoint('after_projection');
      this.#event(o.operation_id,o.revision+1,'interaction_reply_intent','running','running',o.generation,
        {answer_digest:answerDigest,claim_id:o.claim_id,reply_id:replyId,request_id:input.request_id,worker_identity_digest:o.claim_worker_identity_digest},new Date().toISOString());
      return {operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,
        worker_identity_digest:o.claim_worker_identity_digest,request_id:input.request_id,reply_id:replyId,answer,answer_digest:answerDigest,
        process_id:JSON.parse(o.claim_worker_identity_json).process_id,start_fingerprint:JSON.parse(o.claim_worker_identity_json).start_fingerprint,
        revision:o.revision+1,event_sequence:o.revision+1};
    });
  }
  /** Persist the Worker prepared acknowledgement and the one-way commit fact
   * before allowing the caller to send the commit frame. */
  commitInteractionReply(preparedAck) {
    this.#assertWritable();
    if(!isCandidateInteractionPreparedAcknowledgement(preparedAck)||!validInteractionPreparedAcknowledgement(preparedAck))fail('invalid_interaction_prepared_ack');
    return this.#transaction(()=>{
      const o=this.#attemptOperation({...preparedAck,expected_revision:preparedAck.revision});
      const p=this.#db.prepare('SELECT * FROM manager_interaction_payloads WHERE operation_id=? AND request_id=?').get(o.operation_id,preparedAck.request_id);
      const intent=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='interaction_reply_intent' AND json_extract(evidence_json,'$.request_id')=?").get(o.operation_id,preparedAck.request_id);
      if(!p||!intent)fail('interaction_reply_intent_missing');const ie=JSON.parse(intent.evidence_json);
      if(p.reply_id!==preparedAck.reply_id||p.answer_digest!==preparedAck.answer_digest||ie.reply_id!==preparedAck.reply_id
        ||ie.answer_digest!==preparedAck.answer_digest||o.claim_id!==preparedAck.claim_id
        ||o.claim_worker_identity_digest!==preparedAck.worker_identity_digest||o.claim_generation!==o.generation
        ||o.phase!=='running'||o.revision!==intent.sequence||preparedAck.revision!==intent.sequence
        ||preparedAck.process_id!==JSON.parse(o.claim_worker_identity_json).process_id
        ||preparedAck.start_fingerprint!==JSON.parse(o.claim_worker_identity_json).start_fingerprint)fail('interaction_prepared_ack_identity_mismatch');
      const events=this.#db.prepare("SELECT event_type FROM manager_operation_events WHERE operation_id=? AND json_extract(evidence_json,'$.request_id')=? AND event_type IN ('interaction_reply_prepared','interaction_reply_committed','interaction_reply_accepted')").all(o.operation_id,preparedAck.request_id);
      if(events.length)fail('interaction_reply_outcome_unknown');
      this.#assertRecoveryNotLatched(o.operation_id);this.#assertNoCancellationIntent(o.operation_id);
      for(const [offset,eventType,evidence] of [
        [1,'interaction_reply_prepared',{answer_digest:p.answer_digest,claim_id:o.claim_id,prepared_digest:preparedAck.ack_digest,
          reply_id:p.reply_id,request_id:p.request_id,worker_identity_digest:o.claim_worker_identity_digest}],
        [2,'interaction_reply_committed',{answer_digest:p.answer_digest,claim_id:o.claim_id,commit_digest:'',prepared_digest:preparedAck.ack_digest,
          reply_id:p.reply_id,request_id:p.request_id,worker_identity_digest:o.claim_worker_identity_digest}],
      ]){
        const changed=this.#db.prepare("UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='running' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?")
          .run(o.operation_id,o.task_id,o.attempt,o.generation,o.revision+offset-1,o.claim_id,o.generation,o.claim_worker_identity_digest);
        if(changed.changes!==1)fail('stale_interaction_prepared_ack');
        if(eventType==='interaction_reply_committed')evidence.commit_digest=interactionCommitDigest({operation_id:o.operation_id,task_id:o.task_id,
          attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest},
          {request_id:p.request_id,reply_id:p.reply_id,revision:o.revision+offset,answer_digest:p.answer_digest,prepared_digest:preparedAck.ack_digest});
        this.#event(o.operation_id,o.revision+offset,eventType,'running','running',o.generation,evidence,new Date().toISOString());
      }
      return {state:'committed',operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
        claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,process_id:preparedAck.process_id,
        start_fingerprint:preparedAck.start_fingerprint,request_id:p.request_id,reply_id:p.reply_id,answer_digest:p.answer_digest,
        prepared_digest:preparedAck.ack_digest,commit_digest:JSON.parse(this.#db.prepare("SELECT evidence_json FROM manager_operation_events WHERE operation_id=? AND event_type='interaction_reply_committed' AND json_extract(evidence_json,'$.request_id')=?").get(o.operation_id,p.request_id).evidence_json).commit_digest,
        revision:o.revision+2};
    });
  }
  /** Confirm only an ack already validated by the bound private Worker channel. */
  completeInteractionReply(input) {
    this.#assertWritable();
    if(!isCandidateInteractionAcknowledgement(input)||!validInteractionAcknowledgement(input))fail('invalid_interaction_ack');
    return this.#transaction(()=>{
      const o=this.#attemptOperation({...input,expected_revision:input.revision});this.#assertRecoveryNotLatched(o.operation_id);this.#assertNoCancellationIntent(o.operation_id);
      const p=this.#db.prepare('SELECT * FROM manager_interaction_payloads WHERE operation_id=? AND request_id=?').get(o.operation_id,input.request_id);
      const intent=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='interaction_reply_intent' AND json_extract(evidence_json,'$.request_id')=?").get(o.operation_id,input.request_id);
      const committed=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='interaction_reply_committed' AND json_extract(evidence_json,'$.request_id')=?").get(o.operation_id,input.request_id);
      if(!p||!intent)fail('interaction_reply_intent_missing');const evidence=JSON.parse(intent.evidence_json);
      if(evidence.reply_id!==input.reply_id||evidence.answer_digest!==input.answer_digest||evidence.claim_id!==input.claim_id
        ||evidence.worker_identity_digest!==input.worker_identity_digest||p.reply_id!==input.reply_id||p.answer_digest!==input.answer_digest
        ||o.claim_id!==input.claim_id||o.claim_worker_identity_digest!==input.worker_identity_digest||!committed
        ||JSON.parse(committed.evidence_json).commit_digest!==input.commit_digest)fail('interaction_ack_identity_mismatch');
      const priorAccepted=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='interaction_reply_accepted' AND json_extract(evidence_json,'$.request_id')=?").get(o.operation_id,input.request_id);
      if(priorAccepted){const priorEvidence=JSON.parse(priorAccepted.evidence_json);
        if(priorEvidence.ack_digest!==input.ack_digest||priorAccepted.evidence_digest!==digest(priorAccepted.evidence_json))fail('interaction_ack_conflict');
        return {duplicate:true,task_id:o.task_id,request_id:input.request_id,reply_id:p.reply_id,answer_digest:p.answer_digest,
          state:'answered',operation_id:o.operation_id,generation:o.generation,revision:priorAccepted.sequence};}
      if(o.phase!=='running'||o.revision!==input.revision)fail('stale_interaction_ack');
      const changed=this.#db.prepare("UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='running' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?")
        .run(o.operation_id,o.task_id,o.attempt,o.generation,o.revision,o.claim_id,o.generation,o.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_interaction_ack');
      this.#faultPoint('after_projection');
      this.#event(o.operation_id,o.revision+1,'interaction_reply_accepted','running','running',o.generation,
        {ack_digest:input.ack_digest,answer_digest:p.answer_digest,claim_id:o.claim_id,commit_digest:input.commit_digest,reply_id:input.reply_id,request_id:input.request_id,
          worker_identity_digest:o.claim_worker_identity_digest},new Date().toISOString());
      return {duplicate:false,task_id:o.task_id,request_id:input.request_id,reply_id:p.reply_id,answer_digest:p.answer_digest,
        state:'answered',operation_id:o.operation_id,generation:o.generation,revision:o.revision+1};
    });
  }
  /** Atomically persist a queued continuation Attempt without reserving lifecycle Capacity. */
  createNextAttempt(input,{workspaceValidator,executionPermissionCheck}={}) {
    this.#assertWritable();
    const operationId=input?.operation_id===undefined?randomUUID():input.operation_id;
    if(!validId(operationId)||operationId!==operationId.trim()||!validId(input?.task_id)
      ||typeof input?.feedback!=='string'||!input.feedback.trim()
      ||(input.additional_requirements!==undefined&&(!Array.isArray(input.additional_requirements)||input.additional_requirements.some(value=>typeof value!=='string'))))fail('invalid_continue_request');
    const additionalRequirements=input.additional_requirements??[];
    const publicRequest={task_id:input.task_id,feedback:input.feedback,additional_requirements:additionalRequirements};
    const publicRequestJson=canonical(publicRequest);
    if(Buffer.byteLength(publicRequestJson,'utf8')>1048576)fail('continue_request_too_large');
    const duplicateReceipt=priorAttempt=>{
      if(priorAttempt.task_id!==input.task_id)fail('continue_operation_conflict');
      let stored;try{stored=JSON.parse(priorAttempt.continuation_json);}catch{fail('continue_history_mismatch');}
      if(!stored||Object.getPrototypeOf(stored)!==Object.prototype||priorAttempt.continuation_operation_id!==operationId
        ||priorAttempt.continuation_digest!==digest(priorAttempt.continuation_json)||stored.contract!=='wp6b2b-continue-v1'
        ||stored.operation_id!==operationId||stored.task_id!==priorAttempt.task_id)fail('continue_history_mismatch');
      if(canonical({task_id:stored.task_id,feedback:stored.feedback,additional_requirements:stored.additional_requirements})!==publicRequestJson)
        fail('continue_operation_conflict');
      return {duplicate:true,operation_id:operationId,task_id:input.task_id,attempt:priorAttempt.attempt,status:'queued',created_at:priorAttempt.created_at};
    };
    const existing=this.#readConsistent(()=>{
      const priorAttempt=this.#db.prepare('SELECT task_id,attempt,continuation_operation_id,continuation_json,continuation_digest,created_at FROM attempts WHERE continuation_operation_id=?').get(operationId);
      return priorAttempt?duplicateReceipt(priorAttempt):null;
    });
    if(existing)return existing;
    if(!Number.isSafeInteger(input.previous_attempt)||input.previous_attempt<1||!validId(input.previous_operation_id)
      ||!Number.isSafeInteger(input.expected_generation)||input.expected_generation<1||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1
      ||!validId(input.claim_id)||typeof input.claim_worker_identity_digest!=='string'||!/^[0-9a-f]{64}$/u.test(input.claim_worker_identity_digest))
      fail('continue_cas_required');
    const continuation={contract:'wp6b2b-continue-v1',operation_id:operationId,task_id:input.task_id,feedback:input.feedback,
      additional_requirements:additionalRequirements,previous_attempt:input.previous_attempt,previous_operation_id:input.previous_operation_id,
      previous_generation:input.expected_generation,previous_revision:input.expected_revision,previous_claim_id:input.claim_id,
      previous_worker_identity_digest:input.claim_worker_identity_digest};
    const continuationJson=canonical(continuation);
    if(Buffer.byteLength(continuationJson,'utf8')>1048576)fail('continue_request_too_large');
    const continuationDigest=digest(continuationJson);
    const prior=this.readOperation(input.previous_operation_id);
    if(!prior)fail('continue_prior_operation_missing');
    const task=this.readTask(input.task_id);
    if(!task)fail('task_not_found');
    const workspace=validateWorkspace(prior.workspace_ref,workspaceValidator);
    if(workspace!==prior.workspace_ref)fail('continue_workspace_mismatch');
    const permission=callDecision(executionPermissionCheck,workspace,{operation_id:operationId,task_id:input.task_id,attempt:input.previous_attempt+1,task});
    if(permission.state!=='allow')fail(permission.state==='deny'?'execution_permission_denied':'execution_permission_unknown');
    const createdAt=new Date().toISOString();
    return this.#transaction(()=>{
      const raced=this.#db.prepare('SELECT task_id,attempt,continuation_operation_id,continuation_json,continuation_digest,created_at FROM attempts WHERE continuation_operation_id=?').get(operationId);
      if(raced)return duplicateReceipt(raced);
      const taskRow=this.#db.prepare('SELECT task_id,status,current_attempt FROM tasks WHERE task_id=?').get(input.task_id);
      const previousAttempt=this.#db.prepare('SELECT task_id,attempt,generation,status FROM attempts WHERE task_id=? AND attempt=?').get(input.task_id,input.previous_attempt);
      const previous=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(input.previous_operation_id);
      if(!taskRow||!previousAttempt||!previous||previous.task_id!==input.task_id||previous.attempt!==input.previous_attempt
        ||taskRow.current_attempt!==input.previous_attempt||previousAttempt.generation!==input.expected_generation
        ||previous.revision!==input.expected_revision||previous.claim_id!==input.claim_id
        ||previous.claim_generation!==input.expected_generation||previous.claim_worker_identity_digest!==input.claim_worker_identity_digest)
        fail('stale_continue_cas');
      const eligible=new Set(['completed','failed','waiting_for_master']);
      if(!eligible.has(taskRow.status)||taskRow.status!==previousAttempt.status||taskRow.status!==previous.result_status)
        fail(taskRow.status==='cancelled'?'continue_cancelled_not_supported':'continue_status_not_eligible');
      if(previous.phase!=='released'||!previous.result_digest||!previous.result_commit_ref||!previous.claim_id
        ||!this.#db.prepare("SELECT 1 FROM manager_operation_events WHERE operation_id=? AND event_type='released'").get(previous.operation_id))
        fail('continue_prior_not_released');
      this.#assertRecoveryNotLatched(previous.operation_id);
      const nextAttempt=input.previous_attempt+1;
      const changedTask=this.#db.prepare("UPDATE tasks SET status='queued',current_attempt=? WHERE task_id=? AND current_attempt=? AND status=?")
        .run(nextAttempt,input.task_id,input.previous_attempt,taskRow.status);
      if(changedTask.changes!==1)fail('stale_continue_cas');
      const insertedAttempt=this.#db.prepare("INSERT INTO attempts(task_id,attempt,generation,status,created_at,continuation_operation_id,continuation_json,continuation_digest) VALUES(?,?,NULL,'queued',?,?,?,?)")
        .run(input.task_id,nextAttempt,createdAt,operationId,continuationJson,continuationDigest);
      if(insertedAttempt.changes!==1)fail('continue_attempt_conflict');
      this.#faultPoint('after_projection');
      return {duplicate:false,operation_id:operationId,task_id:input.task_id,attempt:nextAttempt,status:'queued',created_at:createdAt};
    });
  }
  provisionCapacity({operation_id,capacity_limit,expected_generation=0,maintenance}) {
    this.#assertWritable();
    if(!validId(operation_id)||!Number.isInteger(capacity_limit)||capacity_limit<1||capacity_limit>8||maintenance?.dispatch_blocked!==true||maintenance?.writers_drained!==true) fail('invalid_maintenance_request');
    return this.#transaction(()=>{
      const req={operation_id,capacity_limit,expected_generation}; const d=digest(req);
      const old=this.#db.prepare('SELECT * FROM manager_operations WHERE operation_id=?').get(operation_id);
      if(old){if(old.request_digest!==d)fail('operation_id_conflict');return {duplicate:true,operation_id};}
      const meta=this.#db.prepare('SELECT * FROM authority_metadata WHERE singleton=1').get();
      if(meta.policy_generation!==expected_generation) fail('stale_policy_generation');
      const n=this.#db.prepare("SELECT COUNT(*) AS n FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase NOT IN ('released','cancelled_before_launch')").get().n;
      if(n!==0) fail('active_occupancy');
      const generation=expected_generation+1; const at=new Date().toISOString();
      this.#db.prepare("INSERT INTO manager_operations(operation_id,operation_kind,request_digest,revision,phase,policy_generation,capacity_limit,created_at) VALUES(?,'capacity_policy_change',?,1,'policy_change_committed',?,?,?)").run(operation_id,d,generation,capacity_limit,at);
      this.#faultPoint('after_projection');
      this.#event(operation_id,1,'capacity_policy_committed',null,'policy_change_committed',null,{generation,capacity_limit},at);
      this.#db.prepare('UPDATE authority_metadata SET policy_version=1,policy_generation=?,capacity_limit=?,policy_operation_id=? WHERE singleton=1').run(generation,capacity_limit,operation_id);
      return {duplicate:false,operation_id,generation,capacity_limit};
    });
  }
  assertCapacityPolicy(expected) {
    this.#assertWritable(); const m=this.#db.prepare('SELECT * FROM authority_metadata WHERE singleton=1').get();
    if(!m||m.policy_version!==1||m.policy_generation<1||m.capacity_limit!==expected)fail('capacity_policy_mismatch');
    return {capacity_limit:m.capacity_limit,policy_generation:m.policy_generation};
  }
  admitOperation(input, gates) {
    if(input&&Object.hasOwn(input,'generation'))fail('caller_generation_forbidden');
    return this.#admitOperation(input,gates,false);
  }
  /** Explicitly synthetic compatibility path for inherited fixture-only regressions. */
  admitSyntheticFixtureOperation(input, gates) {
    if(!Number.isSafeInteger(input?.generation)||input.generation<1)fail('invalid_fixture_generation');
    return this.#admitOperation(input,gates,true);
  }
  #admitOperation(input,{workspaceValidator,executionPermissionCheck},fixtureGenerationAuthority) {
    this.#assertWritable();
    const w=validateWorkspace(input?.workspace_ref,workspaceValidator);
    const permission=callDecision(executionPermissionCheck,w,input);
    if(permission.state!=='allow') fail(permission.state==='deny'?'execution_permission_denied':'execution_permission_unknown');
    const requested={operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,workspace_ref:w};
    const fixtureGeneration=fixtureGenerationAuthority?input.generation:undefined;
    if(!validId(requested.operation_id)||!validId(requested.task_id)||!Number.isInteger(requested.attempt)||requested.attempt<1
      ||(fixtureGeneration!==undefined&&(!Number.isInteger(fixtureGeneration)||fixtureGeneration<1)))fail('invalid_request');
    const d=digest(fixtureGeneration===undefined?requested:{...requested,generation:fixtureGeneration}); const at=new Date().toISOString();
    return this.#transaction(()=>{
      const prior=this.#db.prepare('SELECT * FROM manager_operations WHERE operation_id=?').get(requested.operation_id);
      if(prior){if(prior.request_digest!==d)fail('operation_id_conflict');return {duplicate:true,operation_id:prior.operation_id,generation:prior.generation,revision:prior.revision,phase:prior.phase};}
      const same=this.#db.prepare("SELECT operation_id FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND task_id=? AND attempt=?").get(requested.task_id,requested.attempt);
      if(same)fail('attempt_already_admitted');
      const meta=this.#db.prepare('SELECT * FROM authority_metadata WHERE singleton=1').get();
      if(!meta||meta.policy_version!==1||meta.policy_generation<1)fail('capacity_policy_missing');
      const active=this.#db.prepare("SELECT COUNT(*) AS n FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase NOT IN ('released','cancelled_before_launch')").get().n;
      if(active>=meta.capacity_limit)fail('capacity_exhausted');
      const row=this.#db.prepare('SELECT a.status,a.generation,t.current_attempt FROM attempts a JOIN tasks t ON t.task_id=a.task_id WHERE a.task_id=? AND a.attempt=?').get(requested.task_id,requested.attempt);
      if(!row||row.current_attempt!==requested.attempt||row.status!=='queued')fail('task_attempt_not_admissible');
      let generation=fixtureGeneration;
      if(generation===undefined){
        if(row.generation!==null)fail('attempt_generation_already_assigned');
        const highest=this.#db.prepare('SELECT MAX(generation) AS n FROM attempts WHERE generation IS NOT NULL').get().n??0;
        generation=Math.max(meta.next_generation,highest)+1;
        const assigned=this.#db.prepare("UPDATE attempts SET generation=? WHERE task_id=? AND attempt=? AND generation IS NULL AND status='queued'").run(generation,requested.task_id,requested.attempt);
        if(assigned.changes!==1)fail('attempt_generation_cas_conflict');
        const generationChanged=this.#db.prepare('UPDATE authority_metadata SET next_generation=? WHERE singleton=1 AND next_generation=?').run(generation,meta.next_generation);
        if(generationChanged.changes!==1)fail('generation_authority_cas_conflict');
      } else if(row.generation!==generation) fail('attempt_generation_mismatch');
      const normalized={...requested,generation};
      const slot=this.#db.prepare("SELECT n FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8) WHERE n<=? AND n NOT IN (SELECT capacity_slot FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase NOT IN ('released','cancelled_before_launch')) ORDER BY n LIMIT 1").get(meta.capacity_limit);
      if(!slot)fail('capacity_exhausted');
      const reservation_id=randomUUID();
      this.#db.prepare("INSERT INTO manager_operations(operation_id,operation_kind,request_digest,task_id,attempt,generation,reservation_id,revision,phase,capacity_slot,workspace_ref,workspace_identity_json,created_at) VALUES(?,'attempt_lifecycle',?,?,?,?,?,1,'reserved',?,?,NULL,?)")
        .run(normalized.operation_id,d,normalized.task_id,normalized.attempt,normalized.generation,reservation_id,slot.n,w,at);
      this.#faultPoint('after_projection');
      this.#event(normalized.operation_id,1,'reserved',null,'reserved',normalized.generation,{
        reservation_id,capacity_slot:slot.n,...(permission.audit??{}),
      },at);
      return {duplicate:false,operation_id:normalized.operation_id,reservation_id,revision:1,event_sequence:1,capacity_slot:slot.n,phase:'reserved',generation:normalized.generation};
    });
  }
  readOperation(operationId) { return this.#readConsistent(()=>{const row=this.#db.prepare('SELECT * FROM manager_operations WHERE operation_id=?').get(operationId);return row?presentOperation(row):null;}); }
  readLifecycleEvents(operationId,{afterSequence=0,limit=100}={}) {
    this.#assertOpen();
    if(!validId(operationId)||!Number.isSafeInteger(afterSequence)||afterSequence<0||!Number.isInteger(limit)||limit<1||limit>200)fail('invalid_event_read');
    return this.#readConsistent(()=>{
      if(!this.#db.prepare('SELECT operation_id FROM manager_operations WHERE operation_id=?').get(operationId))fail('operation_not_found');
      return this.#db.prepare('SELECT event_cursor,operation_id,sequence,event_type,from_phase,to_phase,generation,evidence_json,evidence_digest,at FROM manager_operation_events WHERE operation_id=? AND sequence>? ORDER BY sequence LIMIT ?')
        .all(operationId,afterSequence,limit);
    });
  }
  /** Read persisted lifecycle facts for one Task across all its Operations and Attempts. */
  readTaskEvents(taskId,{afterCursor=0,limit=100}={}) {
    this.#assertOpen();
    if(!validId(taskId)||!Number.isSafeInteger(afterCursor)||afterCursor<0||!Number.isInteger(limit)||limit<1||limit>200)fail('invalid_event_read');
    return this.#readConsistent(()=>{
      if(!this.#db.prepare('SELECT task_id FROM tasks WHERE task_id=?').get(taskId))fail('task_not_found');
      const operationRows=this.#db.prepare(`SELECT e.event_cursor AS cursor,e.event_cursor AS sequence,e.sequence AS operation_sequence,
          e.operation_id,e.event_type,e.from_phase,e.to_phase,e.generation,
          e.evidence_json,e.evidence_digest,e.at,o.task_id,o.attempt AS operation_attempt
        FROM manager_operation_events e JOIN manager_operations o ON o.operation_id=e.operation_id
        WHERE o.operation_kind='attempt_lifecycle' AND o.task_id=? AND e.event_cursor>? ORDER BY e.event_cursor LIMIT ?`)
        .all(taskId,afterCursor,limit+1);
      const taskCancelRows=this.#db.prepare(`SELECT queued_cancel_event_cursor AS cursor,queued_cancel_event_cursor AS sequence,
          NULL AS operation_sequence,queued_cancel_operation_id AS operation_id,'cancelled' AS event_type,
          NULL AS from_phase,'cancelled' AS to_phase,generation,
          queued_cancel_id,queued_cancel_request_digest,queued_cancelled_at AS at,task_id,attempt AS operation_attempt
        FROM attempts WHERE task_id=? AND queued_cancel_event_cursor>? AND queued_cancel_operation_id IS NULL ORDER BY queued_cancel_event_cursor LIMIT ?`)
        .all(taskId,afterCursor,limit+1)
        .map(row=>{
          const evidence_json=canonical({cancel_id:row.queued_cancel_id,request_digest:row.queued_cancel_request_digest});
          const {queued_cancel_id,queued_cancel_request_digest,...event}=row;
          return {...event,evidence_json,evidence_digest:digest(evidence_json)};
        });
      const migratedRows=this.#db.prepare(`SELECT event_cursor AS cursor,event_cursor AS sequence,NULL AS operation_sequence,
          NULL AS operation_id,event_type,NULL AS from_phase,NULL AS to_phase,NULL AS generation,
          COALESCE(details_json,'{}') AS evidence_json,COALESCE(details_digest,?) AS evidence_digest,at,task_id,attempt AS operation_attempt
        FROM migrated_task_events WHERE task_id=? AND event_cursor>? ORDER BY event_cursor LIMIT ?`)
        .all(digest('{}'),taskId,afterCursor,limit+1);
      const rows=[...operationRows.map(row=>row.event_type==='cancelled_before_launch'?{...row,event_type:'cancelled',from_phase:null,to_phase:'cancelled'}:row),...taskCancelRows,...migratedRows]
        .sort((a,b)=>a.cursor-b.cursor).slice(0,limit+1);
      const hasMore=rows.length>limit;
      const events=hasMore?rows.slice(0,limit):rows;
      return {events,nextCursor:events.at(-1)?.cursor??afterCursor,hasMore};
    });
  }
  /** Read only the imported historical Event rows for one Task. */
  readMigratedEvents(taskId) {
    if(!validId(taskId))fail('invalid_task_id');
    return this.#readConsistent(()=>{
      if(!this.#db.prepare('SELECT task_id FROM tasks WHERE task_id=?').get(taskId))fail('task_not_found');
      return this.#db.prepare(`SELECT event_cursor,task_id,attempt,source_sequence,event_type,at,summary,
        details_json,details_digest,artifact_id FROM migrated_task_events WHERE task_id=? ORDER BY event_cursor`)
        .all(taskId);
    });
  }
  /** Read imported source bytes by their source-relative path. */
  readMigratedArtifact(relativePath) {
    this.#assertOpen();
    if(!validText(relativePath,1024)||relativePath.includes('\\')||relativePath.startsWith('/')
      ||relativePath.split('/').some(part=>!part||part==='.'||part==='..'))fail('invalid_artifact_path');
    return this.#readConsistent(()=>{
      const row=this.#db.prepare('SELECT artifact_id,relative_path,task_id,attempt,kind,byte_length,sha256,content FROM json_artifacts WHERE relative_path=?').get(relativePath);
      return row?{...row,content:Buffer.from(row.content)}:null;
    });
  }
  /** Persist cancellation of the current queued Attempt without inventing an Operation or Worker. */
  cancelQueuedAttempt({task_id,expected_attempt}={}) {
    this.#assertWritable();
    if(!validId(task_id)||!Number.isSafeInteger(expected_attempt)||expected_attempt<1)fail('invalid_queued_cancel');
    const requestDigest=digest({contract:'wp6a-queued-cancel-v1',task_id,attempt:expected_attempt});
    return this.#transaction(()=>{
      const task=this.#db.prepare('SELECT task_id,status,current_attempt FROM tasks WHERE task_id=?').get(task_id);
      if(!task)fail('task_not_found');
      const attempt=this.#db.prepare('SELECT * FROM attempts WHERE task_id=? AND attempt=?').get(task_id,expected_attempt);
      if(!attempt)fail('task_attempt_not_found');
      if(attempt.queued_cancel_id!==null){
        if(attempt.queued_cancel_request_digest!==requestDigest||attempt.status!=='cancelled'||task.status!=='cancelled'
          ||task.current_attempt!==expected_attempt)fail('queued_cancel_history_mismatch');
        return {duplicate:true,task_id,attempt:expected_attempt,status:'cancelled',cancel_id:attempt.queued_cancel_id,
          event_cursor:attempt.queued_cancel_event_cursor,operation_id:attempt.queued_cancel_operation_id};
      }
      if(task.current_attempt!==expected_attempt||task.status!=='queued'||attempt.status!=='queued')fail('queued_cancel_not_admissible');
      const operation=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND task_id=? AND attempt=?").get(task_id,expected_attempt);
      if(operation&&operation.phase!=='reserved')fail(operation.launch_id!==null?'queued_cancel_launch_already_intended':'queued_cancel_operation_not_cancellable');
      if(operation&&(operation.generation!==attempt.generation||operation.launch_id!==null||operation.claim_id!==null||operation.result_digest!==null))
        fail('queued_cancel_operation_mismatch');
      if(!operation&&attempt.generation!==null)fail('queued_cancel_generation_without_operation');
      const cancelId=randomUUID(),at=new Date().toISOString(),next=this.#nextEventCursor();
      const result={task_id,attempt:expected_attempt,status:'cancelled',summary:'cancelled by request before the task started',files_changed:[],tests:[],issues:[],
        needs_master_decision:false,zcode_output:'',exit_code:null,session_id:null,started_at:null,finished_at:at};
      canonicalTaskResult(result,{task_id,attempt:expected_attempt,result_status:'cancelled'});
      const resultJson=canonical(result),resultDigest=digest(resultJson);
      const changedAttempt=this.#db.prepare("UPDATE attempts SET status='cancelled',queued_cancel_id=?,queued_cancel_request_digest=?,queued_cancel_event_cursor=?,queued_cancelled_at=?,queued_cancel_operation_id=?,queued_cancel_result_digest=?,queued_cancel_result_json=? WHERE task_id=? AND attempt=? AND generation IS ? AND status='queued' AND queued_cancel_id IS NULL")
        .run(cancelId,requestDigest,next,at,operation?.operation_id??null,resultDigest,resultJson,task_id,expected_attempt,attempt.generation);
      const changedTask=this.#db.prepare("UPDATE tasks SET status='cancelled' WHERE task_id=? AND current_attempt=? AND status='queued'")
        .run(task_id,expected_attempt);
      if(changedAttempt.changes!==1||changedTask.changes!==1)fail('queued_cancel_cas_conflict');
      if(operation){
        const changedOperation=this.#db.prepare("UPDATE manager_operations SET phase='cancelled_before_launch',revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='reserved' AND revision=? AND launch_id IS NULL AND claim_id IS NULL AND result_digest IS NULL")
          .run(operation.operation_id,task_id,expected_attempt,attempt.generation,operation.revision);
        if(changedOperation.changes!==1)fail('queued_cancel_operation_cas_conflict');
        this.#event(operation.operation_id,operation.revision+1,'cancelled_before_launch','reserved','cancelled_before_launch',operation.generation,
          {cancel_id:cancelId,request_digest:requestDigest},at,next);
      }
      this.#faultPoint('after_projection');
      return {duplicate:false,task_id,attempt:expected_attempt,status:'cancelled',cancel_id:cancelId,
        event_cursor:next,operation_id:operation?.operation_id??null};
    });
  }
  readCommittedResult(operationId) {
    this.#assertOpen();
    if(!validId(operationId))fail('invalid_operation_id');
    return this.#readConsistent(()=>{
      const o=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(operationId);
      if(!o)fail('operation_not_found');
      if(o.result_json===null)return null;
      let result;try{result=JSON.parse(o.result_json);}catch{fail('result_projection_invalid');}
      return {operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,revision:o.revision,phase:o.phase,
        claim_id:o.claim_id,claim_worker_identity_digest:o.claim_worker_identity_digest,result_status:o.result_status,
        result_generation:o.result_generation,result_digest:o.result_digest,result_commit_ref:o.result_commit_ref,result};
    });
  }
  /** Persist one cancellation intent for a claimed running Operation after exact identity verification. */
  requestCancellation(input,identityEvidence,identityVerifier) {
    this.#assertWritable();
    if(!validCancellationFence(input))fail('invalid_cancellation_request');
    const snapshot=this.#readConsistent(()=>{
      const operation=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(input.operation_id);
      if(!operation)fail('operation_not_found');
      this.#assertNoUnknownInteraction(input.operation_id);
      const observations=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(input.operation_id)
        .map(event=>({...event,evidence:JSON.parse(event.evidence_json)}));
      return {operation,observations};
    });
    if(snapshot.operation.task_id!==input.task_id||snapshot.operation.attempt!==input.attempt||snapshot.operation.generation!==input.generation)
      fail('operation_identity_mismatch');
    const worker=this.#cancellationWorker(input,snapshot.operation);
    const existing=snapshot.observations.find(event=>event.evidence.reason==='cancel_requested');
    if(snapshot.operation.result_digest!==null||['result_committed','cleanup_pending','cleanup_verified','cleanup_unverified','released','quarantined'].includes(snapshot.operation.phase))
      return {duplicate:!!existing&&snapshot.operation.result_status==='cancelled',result_won:snapshot.operation.result_status!=='cancelled',
        operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,generation:input.generation,
        revision:snapshot.operation.revision,phase:snapshot.operation.phase,result_status:snapshot.operation.result_status,...(existing?{cancel_id:existing.evidence.cancel_id}:{})};
    if(existing)return {duplicate:true,result_won:false,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,
      generation:input.generation,revision:snapshot.operation.revision,phase:snapshot.operation.phase,cancel_id:existing.evidence.cancel_id};
    if(snapshot.operation.phase!=='running'||snapshot.operation.revision!==input.revision)fail('stale_cancellation_cas');
    if(typeof identityVerifier!=='function')fail('cancellation_identity_verifier_required');
    let identityVerdict;
    try{identityVerdict=identityVerifier({operation:presentOperation(snapshot.operation),worker_identity:worker,evidence:identityEvidence});}
    catch(error){fail('cancellation_identity_unknown',String(error));}
    if(!identityVerdict||!['alive','exited'].includes(identityVerdict.state)
      ||identityVerdict.worker_identity_digest!==snapshot.operation.claim_worker_identity_digest
      ||typeof identityVerdict.evidence_digest!=='string'||!/^[0-9a-f]{64}$/u.test(identityVerdict.evidence_digest))fail('cancellation_identity_unknown');
    if(identityVerdict.evidence_digest!==digest(identityEvidence))fail('cancellation_identity_evidence_mismatch');
    const cancelId=randomUUID();
    return this.#transaction(()=>{
      const current=this.#attemptOperation(input);
      if(current.result_digest!==null||['result_committed','cleanup_pending','cleanup_verified','cleanup_unverified','released','quarantined'].includes(current.phase))
        return {duplicate:false,result_won:current.result_status!=='cancelled',operation_id:input.operation_id,generation:input.generation,revision:current.revision,
          phase:current.phase,result_status:current.result_status};
      this.#cancellationWorker(input,current);
      const raced=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(input.operation_id)
        .map(event=>({...event,evidence:JSON.parse(event.evidence_json)})).find(event=>event.evidence.reason==='cancel_requested');
      if(raced)return {duplicate:true,result_won:false,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,
        generation:input.generation,revision:current.revision,phase:current.phase,cancel_id:raced.evidence.cancel_id};
      if(current.phase!=='running'||current.revision!==input.revision)fail('stale_cancellation_cas');
      this.#assertRecoveryNotLatched(input.operation_id);
      this.#assertNoUnknownInteraction(input.operation_id);
      const intent={contract:'wp6c-cancel-intent-v1',cancel_id:cancelId,operation_id:current.operation_id,task_id:current.task_id,
        attempt:current.attempt,generation:current.generation,claim_id:current.claim_id,worker_identity_digest:current.claim_worker_identity_digest,
        identity_state:identityVerdict.state,identity_evidence_digest:identityVerdict.evidence_digest};
      const evidence={reason:'cancel_requested',cancel_id:cancelId,claim_id:current.claim_id,worker_identity_digest:current.claim_worker_identity_digest,
        identity_state:identityVerdict.state,identity_evidence_digest:identityVerdict.evidence_digest,evidence_digest:digest(intent)};
      const changed=this.#db.prepare("UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='running' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?")
        .run(input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.claim_id,input.generation,input.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_cancellation_cas');
      this.#faultPoint('after_projection');
      const at=new Date().toISOString();this.#event(input.operation_id,input.revision+1,'observation_recorded','running','running',input.generation,evidence,at);
      return {duplicate:false,result_won:false,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,generation:input.generation,
        revision:input.revision+1,phase:'running',cancel_id:cancelId,identity_state:identityVerdict.state};
    });
  }
  /** Persist verified Worker-tree exit evidence without marking Result, Cleanup, or Release complete. */
  recordCancellationVerification(input,treeEvidence,cancellationVerifier) {
    this.#assertWritable();
    if(!validCancellationFence(input))fail('invalid_cancellation_verification');
    const snapshot=this.#readConsistent(()=>{
      const operation=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(input.operation_id);
      if(!operation)fail('operation_not_found');
      this.#assertNoUnknownInteraction(input.operation_id);
      const observations=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(input.operation_id)
        .map(event=>({...event,evidence:JSON.parse(event.evidence_json)}));
      return {operation,observations};
    });
    if(snapshot.operation.task_id!==input.task_id||snapshot.operation.attempt!==input.attempt||snapshot.operation.generation!==input.generation)
      fail('operation_identity_mismatch');
    const worker=this.#cancellationWorker(input,snapshot.operation);
    const intent=snapshot.observations.find(event=>event.evidence.reason==='cancel_requested');
    if(!intent)fail('cancel_intent_required');
    const prior=snapshot.observations.find(event=>event.evidence.reason==='cancel_tree_verified');
    if(snapshot.operation.result_digest!==null||snapshot.operation.phase!=='running'){
      if(prior&&prior.evidence.proof_digest===digest(treeEvidence)&&snapshot.operation.result_status==='cancelled')return {duplicate:true,result_won:false,
        operation_id:input.operation_id,generation:input.generation,revision:snapshot.operation.revision,phase:snapshot.operation.phase,
        cancellation_verification_digest:prior.evidence_digest};
      return {duplicate:false,result_won:snapshot.operation.result_status!=='cancelled',operation_id:input.operation_id,generation:input.generation,
        revision:snapshot.operation.revision,phase:snapshot.operation.phase,result_status:snapshot.operation.result_status};
    }
    if(prior&&prior.evidence.proof_digest===digest(treeEvidence))return {duplicate:true,result_won:false,operation_id:input.operation_id,
      generation:input.generation,revision:snapshot.operation.revision,phase:snapshot.operation.phase,cancellation_verification_digest:prior.evidence_digest};
    if(snapshot.operation.revision!==input.revision)fail('stale_cancellation_cas');
    if(typeof cancellationVerifier!=='function')fail('cancellation_verifier_required');
    let verdict;
    try{verdict=cancellationVerifier({operation:presentOperation(snapshot.operation),cancel_intent:intent.evidence,worker_identity:worker,evidence:treeEvidence});}
    catch(error){fail('cancellation_verification_unknown',String(error));}
    const launchIdentity=JSON.parse(snapshot.operation.launch_identity_json);
    if(!verdict||verdict.state!=='verified'||verdict.worker_identity_digest!==snapshot.operation.claim_worker_identity_digest
      ||typeof verdict.process_tree_digest!=='string'||!/^[0-9a-f]{64}$/u.test(verdict.process_tree_digest)
      ||verdict.root_process_id!==worker.process_id||verdict.root_process_id!==launchIdentity.process_id
      ||verdict.root_start_fingerprint!==worker.start_fingerprint||verdict.root_start_fingerprint!==launchIdentity.start_fingerprint
      ||verdict.worker_tree_complete!==true||typeof verdict.evidence_digest!=='string'||!/^[0-9a-f]{64}$/u.test(verdict.evidence_digest)
      ||verdict.evidence_digest!==digest(treeEvidence))fail('cancellation_verification_unverified');
    return this.#transaction(()=>{
      const current=this.#attemptOperation(input);
      if(current.result_digest!==null||current.phase!=='running')return {duplicate:false,result_won:current.result_status!=='cancelled',operation_id:input.operation_id,
        generation:input.generation,revision:current.revision,phase:current.phase,result_status:current.result_status};
      if(current.revision!==input.revision)fail('stale_cancellation_cas');
      this.#cancellationWorker(input,current);
      const persistedIntent=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(input.operation_id)
        .map(event=>({...event,evidence:JSON.parse(event.evidence_json)})).find(event=>event.evidence.reason==='cancel_requested');
      if(!persistedIntent||persistedIntent.evidence.cancel_id!==intent.evidence.cancel_id)fail('cancel_intent_mismatch');
      const existing=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(input.operation_id)
        .map(event=>({...event,evidence:JSON.parse(event.evidence_json)})).find(event=>event.evidence.reason==='cancel_tree_verified');
      if(existing){if(existing.evidence.proof_digest===verdict.evidence_digest)return {duplicate:true,result_won:false,operation_id:input.operation_id,
          generation:input.generation,revision:current.revision,phase:current.phase,cancellation_verification_digest:existing.evidence_digest};
        fail('cancellation_verification_conflict');}
      this.#assertRecoveryNotLatched(input.operation_id);
      this.#assertNoUnknownInteraction(input.operation_id);
      const unsigned={reason:'cancel_tree_verified',cancel_id:intent.evidence.cancel_id,claim_id:current.claim_id,
        worker_identity_digest:current.claim_worker_identity_digest,intent_event_digest:persistedIntent.evidence_digest,
        process_tree_digest:verdict.process_tree_digest,proof_digest:verdict.evidence_digest,root_process_id:verdict.root_process_id,
        root_start_fingerprint:verdict.root_start_fingerprint,worker_tree_complete:true};
      const evidence={...unsigned,evidence_digest:digest({cancel_verification_contract_version:1,...unsigned})};
      const changed=this.#db.prepare("UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='running' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?")
        .run(input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.claim_id,input.generation,input.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_cancellation_cas');
      this.#faultPoint('after_projection');
      const at=new Date().toISOString();this.#event(input.operation_id,input.revision+1,'observation_recorded','running','running',input.generation,evidence,at);
      const event=this.#db.prepare("SELECT evidence_digest FROM manager_operation_events WHERE operation_id=? AND sequence=?").get(input.operation_id,input.revision+1);
      return {duplicate:false,result_won:false,operation_id:input.operation_id,generation:input.generation,revision:input.revision+1,
        phase:'running',cancel_id:intent.evidence.cancel_id,cancellation_verification_digest:event.evidence_digest};
    });
  }
  readSnapshot(){
    const snapshot=this.#readConsistent(()=>({capacity:this.#db.prepare('SELECT * FROM authority_metadata').get(),
      operations:this.#db.prepare('SELECT * FROM manager_operations ORDER BY operation_id').all().map(presentOperation),
      events:this.#db.prepare('SELECT * FROM manager_operation_events ORDER BY operation_id,sequence').all()}));
    return {...snapshot,root_poisoned:this.poisoned||existsSync(this.#paths.intent)};
  }
  /** Read-only recovery entry point. Writable Stores cannot be used as Recovery authority. */
  readRecoverySnapshot() {
    this.#assertOpen();
    if(!this.#recoveryOnly)fail('recovery_read_only');
    return this.rebuildRecoveryState();
  }
  /** Reconstruct only from persisted facts. Any inconsistency blocks the whole root; no repair or release occurs. */
  rebuildRecoveryState() {
    this.#assertOpen();
    if(!this.#recoveryOnly)fail('recovery_read_only');
    let transaction=false;
    try {
      this.#db.exec('BEGIN'); transaction=true;
      const userVersion=this.#db.prepare('PRAGMA user_version').get().user_version;
      if(userVersion!==SCHEMA_VERSION)fail('schema_version_unknown');
      const columns=new Set(this.#db.prepare('PRAGMA table_info(manager_operations)').all().map(x=>x.name));
      if(!['result_status','result_generation','result_digest','result_json','result_commit_ref'].every(x=>columns.has(x)))fail('candidate_schema_mismatch');
      const meta=this.#db.prepare('SELECT * FROM authority_metadata').all();
      const operations=this.#db.prepare('SELECT * FROM manager_operations ORDER BY operation_id').all();
      const events=this.#db.prepare('SELECT * FROM manager_operation_events ORDER BY operation_id,sequence').all();
      let integrityError=null;
      try { this.#validateContents(); } catch(e) { integrityError=e?.code??'projection_event_mismatch'; }
      this.#db.exec('COMMIT'); transaction=false;
      const poisoned=this.poisoned,writerIntent=existsSync(this.#paths.intent);
      const rootBlocked=Boolean(integrityError||meta.length!==1||poisoned||writerIntent);
      const operationsWithRecovery=operations.map(row=>{
        const active=row.operation_kind==='attempt_lifecycle'&&!['released','cancelled_before_launch'].includes(row.phase);
        const operationEvents=events.filter(e=>e.operation_id===row.operation_id);
        const recoveryEvents=recoveryEventsFor(operationEvents,row);
        const recoveryClassification=foldedRecoveryClassification(row,operationEvents);
        const cleanupState=row.phase==='cleanup_verified'||row.phase==='released'?'verified'
          :row.phase==='cleanup_unverified'?'unverified'
          :row.phase==='result_committed'||row.phase==='cleanup_pending'||row.phase==='quarantined'||active&&row.claim_id!==null?'unknown':'not_applicable';
        const blockers=[];
        if(integrityError)blockers.push(integrityError);
        if(row.operation_kind==='attempt_lifecycle'){
          if(row.launch_id!==null&&row.launch_receipt_digest===null)blockers.push('launch_outcome_unknown_receipt_missing');
          if(row.claim_id!==null&&active&&cleanupState!=='verified')blockers.push('manager_os_identity_probe_required');
          if(row.result_digest===null&&row.claim_id!==null&&active)blockers.push('execution_result_unknown');
          if(row.phase==='result_committed'||row.phase==='cleanup_pending'||row.phase==='cleanup_unverified')blockers.push('operation_cleanup_unverified');
          if(row.phase==='cleanup_verified')blockers.push('operation_release_pending');
          if(row.phase==='quarantined')blockers.push('result_conflict_quarantined');
          if(hasUnresolvedInteraction(operationEvents))blockers.push('interaction_reply_outcome_unknown');
          if(recoveryClassification==='hold')blockers.push('recovery_hold');
          if(recoveryClassification==='quarantine')blockers.push('recovery_quarantine');
          if(active)blockers.push('capacity_and_workspace_occupancy_retained');
        }
        if(poisoned)blockers.push('root_poisoned');
        if(writerIntent)blockers.push('writer_intent_present_outcome_unknown');
        const recoveryDecision=integrityError?'quarantine_read_only'
          :poisoned||writerIntent||meta.length!==1?'blocked_read_only'
          :row.operation_kind==='attempt_lifecycle'&&['released','cancelled_before_launch'].includes(row.phase)?'complete'
          :recoveryClassification==='quarantine'?'quarantine_read_only':'hold';
        return { ...presentOperation(row), recovery_decision:recoveryDecision, recovery_blockers:[...new Set(blockers)],
          recovery_classification:recoveryClassification,recovery_observation_count:recoveryEvents.length,
          claim_permanent:row.claim_id!==null, capacity_occupied:active, cleanup_state:cleanupState };
      });
      return { schema_version:3, root_status:integrityError?'quarantined_read_only':rootBlocked?'blocked_read_only':'consistent_read_only',
        root_blockers:[...new Set([...(integrityError?[integrityError]:[]),...(poisoned?['root_poisoned']:[]),...(writerIntent?['writer_intent_present_outcome_unknown']:[]),...(meta.length!==1?['authority_metadata_invalid']:[])])],
        capacity:meta.length===1?meta[0]:null, operations:operationsWithRecovery, events,
        verified_event_projection_consistency:!integrityError, writes_allowed:false, cleanup_performed:false, claim_release_performed:false, operation_release_performed:false };
    } catch(e) {
      if(transaction){try{this.#db.exec('ROLLBACK');}catch{}}
      return { schema_version:3, root_status:'unavailable_read_only', root_blockers:[e?.code??'recovery_read_failed'], capacity:null, operations:[], events:[],
        verified_event_projection_consistency:false, writes_allowed:false, cleanup_performed:false, claim_release_performed:false, operation_release_performed:false };
    }
  }
  compareAndSwapObservation({operation_id,generation,revision,evidence}) {
    if(!Number.isInteger(generation)||!Number.isInteger(revision))fail('invalid_cas');
    validateEvidence('observation_recorded',evidence);
    return this.#transaction(()=>{
      if(evidence.reason==='recovery_hold'||evidence.reason==='recovery_quarantine')fail('reserved_recovery_reason');
      if(evidence.reason==='cancel_requested'||evidence.reason==='cancel_tree_verified')fail('reserved_cancellation_reason');
      const o=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(operation_id);
      if(!o||o.generation!==generation||o.revision!==revision||o.phase!=='reserved')fail('stale_operation_cas');
      const at=new Date().toISOString(); const changed=this.#db.prepare('UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND generation=? AND revision=?').run(operation_id,generation,revision);
      if(changed.changes!==1)fail('stale_operation_cas');
      this.#faultPoint('after_projection');
      const evidenceJson=canonical(evidence); this.#event(operation_id,revision+1,'observation_recorded','reserved','reserved',generation,evidence,at);
      return {revision:revision+1,phase:'reserved'};
    });
  }
  /** Persist only a verified, operation-scoped Recovery classification; no external action is performed. */
  compareAndSwapRecoveryObservation(input,evidence,verifyEvidence) {
    this.#assertWritable();
    if(typeof verifyEvidence!=='function')fail('recovery_evidence_verifier_required');
    const envelope=recoveryEnvelope(input),envelopeDigest=digest(envelope);
    let evidenceJson;try{evidenceJson=canonical(evidence);}catch{fail('recovery_evidence_invalid');}
    if(Buffer.byteLength(evidenceJson,'utf8')>4096||!evidence||Object.getPrototypeOf(evidence)!==Object.prototype
      ||containsNonNfcString(evidence)||digest(evidenceJson)!==input.evidence_digest)fail('recovery_evidence_invalid');
    const eventEvidence=recoveryEventEvidence(input,envelopeDigest);
    validateEvidence('observation_recorded',eventEvidence);
    return this.#transaction(()=>{
      const o=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(input.operation_id);
      if(!o)fail('operation_not_found');
      if(o.task_id!==input.task_id||o.attempt!==input.attempt||o.generation!==input.generation)fail('operation_identity_mismatch');
      if(o.claim_id===null||o.claim_generation!==input.generation||!o.claim_worker_identity_digest)fail('recovery_claim_missing');
      if(o.claim_id!==input.claim_id||o.claim_worker_identity_digest!==input.worker_identity_digest)fail('recovery_claim_identity_mismatch');
      if(!RECOVERY_PHASES.has(o.phase))fail('recovery_phase_not_allowed');
      let verified=null;
      try{verified=verifyEvidence({operation:{operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
        phase:o.phase,revision:o.revision,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest},observation:input,evidence});}catch{verified=null;}
      if(!verified||Object.getPrototypeOf(verified)!==Object.prototype||Object.keys(verified).sort().join('|')!=='classification|evidence_digest|evidence_source|reason_code'
        ||verified.classification!==input.classification||verified.evidence_digest!==input.evidence_digest||verified.evidence_source!==input.evidence_source
        ||verified.reason_code!==input.reason_code)fail('recovery_evidence_unverified');
      const history=this.#db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence')
        .all(input.operation_id).map(e=>({...e,evidence:JSON.parse(e.evidence_json)}));
      const existing=history.filter(e=>e.event_type==='observation_recorded');
      const same=existing.find(e=>e.evidence?.envelope_digest===envelopeDigest);
      if(same)return {duplicate:true,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
        revision:same.sequence,event_sequence:same.sequence,expected_revision:input.expected_revision,phase:o.phase,
        classification:input.classification,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest};
      const sameRevision=existing.find(e=>e.evidence?.reason?.startsWith('recovery_')&&e.evidence.expected_revision===input.expected_revision);
      if(sameRevision)fail('recovery_observation_conflict');
      if(o.revision!==input.expected_revision)fail('stale_recovery_cas');
      if(o.phase==='quarantined'&&input.classification!=='quarantine')fail('recovery_classification_downgrade');
      const recoveryEvents=existing.filter(e=>e.evidence?.reason==='recovery_hold'||e.evidence?.reason==='recovery_quarantine');
      if(recoveryEvents.length>=RECOVERY_LIMIT)fail('recovery_observation_limit');
      const currentClass=foldedRecoveryClassification(o,history);
      if(currentClass==='quarantine'&&input.classification!=='quarantine')fail('recovery_classification_downgrade');
      const at=new Date().toISOString();
      const changed=this.#db.prepare('UPDATE manager_operations SET revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase=? AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?')
        .run(o.operation_id,o.task_id,o.attempt,o.generation,o.phase,input.expected_revision,input.claim_id,input.generation,input.worker_identity_digest);
      if(changed.changes!==1)fail('stale_recovery_cas');
      this.#faultPoint('after_projection');
      this.#event(o.operation_id,input.expected_revision+1,'observation_recorded',o.phase,o.phase,o.generation,eventEvidence,at);
      return {duplicate:false,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
        revision:input.expected_revision+1,event_sequence:input.expected_revision+1,expected_revision:input.expected_revision,
        phase:o.phase,classification:input.classification,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest};
    });
  }
  createLaunchIntent(input) {
    this.#assertWritable();
    if(!validLaunchRequest(input))fail('invalid_launch_intent');
    const tokenDigest=digest(input.launch_token);
    const intentDigest=digest({operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,generation:input.generation,
      launch_id:input.launch_id,launch_epoch:input.launch_epoch,token_digest:tokenDigest});
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      if(o.launch_id!==null){
        if(o.launch_id!==input.launch_id||o.launch_epoch!==input.launch_epoch||o.launch_token_digest!==tokenDigest||o.launch_intent_digest!==intentDigest)fail('launch_intent_conflict');
        return {duplicate:true,operation_id:o.operation_id,launch_id:o.launch_id,launch_epoch:o.launch_epoch,revision:o.revision,phase:o.phase,process_started:'unknown'};
      }
      if(this.#db.prepare('SELECT operation_id FROM manager_operations WHERE launch_id=?').get(input.launch_id))fail('launch_id_already_used');
      if(o.phase!=='reserved'||o.revision!==input.revision)fail('stale_launch_cas');
      const current=this.#db.prepare('SELECT t.current_attempt,t.status AS task_status,a.status AS attempt_status,a.generation FROM tasks t JOIN attempts a ON a.task_id=t.task_id AND a.attempt=? WHERE t.task_id=?').get(input.attempt,input.task_id);
      if(!current||current.current_attempt!==input.attempt||current.task_status!=='queued'||current.attempt_status!=='queued'||current.generation!==input.generation)
        fail('launch_task_attempt_not_queued');
      const at=new Date().toISOString();
      const changed=this.#db.prepare("UPDATE manager_operations SET phase='launch_intent',revision=revision+1,launch_id=?,launch_epoch=?,launch_token_digest=?,launch_intent_digest=? WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='reserved' AND revision=?")
        .run(input.launch_id,input.launch_epoch,tokenDigest,intentDigest,input.operation_id,input.task_id,input.attempt,input.generation,input.revision);
      if(changed.changes!==1)fail('stale_launch_cas');
      this.#faultPoint('after_projection');
      this.#event(input.operation_id,input.revision+1,'launch_intent','reserved','launch_intent',input.generation,
        {launch_id:input.launch_id,launch_epoch:input.launch_epoch,token_digest:tokenDigest},at);
      return {duplicate:false,operation_id:input.operation_id,launch_id:input.launch_id,launch_epoch:input.launch_epoch,
        generation:input.generation,revision:input.revision+1,event_sequence:input.revision+1,phase:'launch_intent',intent_digest:intentDigest,
        process_started:'unknown'};
    });
  }
  recordLaunchReceipt(input) {
    this.#assertWritable();
    if(!validLaunchRequest(input)||!validId(input.receipt_id))fail('invalid_launch_receipt');
    fixtureLaunchIdentity(input.launch_identity);
    if(input.launch_identity.source==='manager_os_spawn_observation'
      &&(input.launch_identity.launch_id!==input.launch_id||input.launch_identity.generation!==input.generation))
      fail('trusted_launch_identity_binding_mismatch');
    const tokenDigest=digest(input.launch_token),identityJson=canonical(input.launch_identity);
    const receiptDigest=digest({receipt_id:input.receipt_id,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,
      generation:input.generation,launch_id:input.launch_id,launch_epoch:input.launch_epoch,token_digest:tokenDigest,launch_identity:input.launch_identity});
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      if(!o.launch_id)fail('launch_intent_missing');
      if(o.launch_id!==input.launch_id||o.launch_epoch!==input.launch_epoch||o.launch_token_digest!==tokenDigest)fail('launch_receipt_intent_mismatch');
      if(o.launch_receipt_digest!==null){
        if(o.launch_receipt_digest!==receiptDigest||o.launch_identity_json!==identityJson)fail('launch_receipt_conflict');
        return {duplicate:true,operation_id:o.operation_id,launch_id:o.launch_id,revision:o.revision,phase:o.phase,process_started:'not_independently_verified',synthetic:input.launch_identity.source==='synthetic_fixture'};
      }
      if(this.#db.prepare('SELECT operation_id FROM manager_operations WHERE launch_receipt_id=?').get(input.receipt_id))fail('launch_receipt_id_already_used');
      if(o.phase!=='launch_intent'||o.revision!==input.revision)fail('stale_launch_cas');
      const at=new Date().toISOString();
      const changed=this.#db.prepare("UPDATE manager_operations SET revision=revision+1,launch_receipt_id=?,launch_receipt_digest=?,launch_identity_json=? WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='launch_intent' AND revision=? AND launch_id=? AND launch_epoch=? AND launch_token_digest=?")
        .run(input.receipt_id,receiptDigest,identityJson,input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.launch_id,input.launch_epoch,tokenDigest);
      if(changed.changes!==1)fail('stale_launch_cas');
      this.#faultPoint('after_projection');
      this.#event(input.operation_id,input.revision+1,'launch_receipt','launch_intent','launch_intent',input.generation,
        {launch_id:input.launch_id,launch_epoch:input.launch_epoch,token_digest:tokenDigest,receipt_digest:receiptDigest},at);
      return {duplicate:false,operation_id:input.operation_id,launch_id:input.launch_id,launch_epoch:input.launch_epoch,
        generation:input.generation,revision:input.revision+1,event_sequence:input.revision+1,phase:'launch_intent',receipt_digest:receiptDigest,
        process_started:'not_independently_verified',synthetic:input.launch_identity.source==='synthetic_fixture'};
    });
  }
  commitPermanentClaim(input) {
    this.#assertWritable();
    if(!validLaunchRequest(input)||!validId(input.claim_id))fail('invalid_claim');
    fixtureWorkerIdentity(input.worker_identity);
    const tokenDigest=digest(input.launch_token),workerJson=canonical(input.worker_identity),workerDigest=digest(workerJson);
    const claimDigest=digest({claim_id:input.claim_id,operation_id:input.operation_id,task_id:input.task_id,attempt:input.attempt,
      generation:input.generation,launch_id:input.launch_id,launch_epoch:input.launch_epoch,token_digest:tokenDigest,worker_identity:input.worker_identity});
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      if(o.claim_id!==null){
        if(o.claim_id!==input.claim_id||o.claim_request_digest!==claimDigest||o.claim_worker_identity_json!==workerJson)fail('claim_conflict');
        return {duplicate:true,operation_id:o.operation_id,claim_id:o.claim_id,revision:o.revision,phase:o.phase,claim_permanent:true,synthetic:input.worker_identity.source==='synthetic_fixture'};
      }
      if(this.#db.prepare('SELECT operation_id FROM manager_operations WHERE claim_id=?').get(input.claim_id))fail('claim_id_already_used');
      if(o.phase!=='launch_intent'||o.launch_receipt_digest===null)fail('launch_receipt_required');
      if(o.launch_id!==input.launch_id||o.launch_epoch!==input.launch_epoch||o.launch_token_digest!==tokenDigest)fail('claim_launch_mismatch');
      const launchIdentity=JSON.parse(o.launch_identity_json);
      if(input.worker_identity.process_id!==launchIdentity.process_id||input.worker_identity.start_fingerprint!==launchIdentity.start_fingerprint)fail('claim_worker_launch_identity_mismatch');
      if(o.revision!==input.revision)fail('stale_claim_cas');
      const current=this.#db.prepare('SELECT t.current_attempt,t.status AS task_status,a.status AS attempt_status FROM tasks t JOIN attempts a ON a.task_id=t.task_id WHERE t.task_id=? AND a.attempt=? AND a.generation=?').get(input.task_id,input.attempt,input.generation);
      if(!current||current.current_attempt!==input.attempt||current.task_status!=='queued'||current.attempt_status!=='queued')fail('claim_attempt_not_current');
      const at=new Date().toISOString();
      const changed=this.#db.prepare("UPDATE manager_operations SET phase='running',revision=revision+1,claim_id=?,claim_request_digest=?,claim_worker_identity_json=?,claim_worker_identity_digest=?,claim_launch_id=?,claim_generation=?,claim_token_digest=? WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='launch_intent' AND revision=? AND launch_id=? AND launch_epoch=? AND launch_token_digest=? AND launch_receipt_digest IS NOT NULL AND claim_id IS NULL")
        .run(input.claim_id,claimDigest,workerJson,workerDigest,input.launch_id,input.generation,tokenDigest,input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.launch_id,input.launch_epoch,tokenDigest);
      if(changed.changes!==1)fail('stale_claim_cas');
      const attemptChanged=this.#db.prepare("UPDATE attempts SET status='running' WHERE task_id=? AND attempt=? AND generation=? AND status='queued'").run(input.task_id,input.attempt,input.generation);
      if(attemptChanged.changes!==1)fail('claim_attempt_status_conflict');
      const taskChanged=this.#db.prepare("UPDATE tasks SET status='running' WHERE task_id=? AND current_attempt=? AND status='queued'").run(input.task_id,input.attempt);
      if(taskChanged.changes!==1)fail('claim_task_status_conflict');
      this.#faultPoint('after_projection');
      this.#event(input.operation_id,input.revision+1,'claim_committed','launch_intent','running',input.generation,
        {claim_id:input.claim_id,launch_id:input.launch_id,launch_epoch:input.launch_epoch,token_digest:tokenDigest,worker_identity_digest:workerDigest},at);
      return {duplicate:false,operation_id:input.operation_id,claim_id:input.claim_id,launch_id:input.launch_id,
        generation:input.generation,revision:input.revision+1,event_sequence:input.revision+1,phase:'running',claim_permanent:true,synthetic:input.worker_identity.source==='synthetic_fixture'};
    });
  }
  commitResult(input) {
    this.#assertWritable();
    if(!validId(input?.operation_id)||!validId(input?.task_id)||!Number.isSafeInteger(input?.attempt)||input.attempt<1
      ||!Number.isSafeInteger(input?.generation)||input.generation<1||!Number.isSafeInteger(input?.revision)||input.revision<1
      ||!validId(input?.claim_id)||!RESULT_STATUSES.has(input?.result_status)
      ||typeof input?.claim_worker_identity_digest!=='string'||!/^[0-9a-f]{64}$/u.test(input.claim_worker_identity_digest))fail('invalid_result_commit');
    if(input.result_status==='cancelled'
      ?(typeof input.cancel_verification_digest!=='string'||!/^[0-9a-f]{64}$/u.test(input.cancel_verification_digest))
      :Object.hasOwn(input,'cancel_verification_digest'))fail('invalid_result_commit');
    const resultJson=canonicalTaskResult(input.result,input);
    if(Buffer.byteLength(resultJson,'utf8')>65536)fail('result_too_large');
    const resultDigest=digest({result_contract_version:RESULT_CONTRACT_VERSION,result_status:input.result_status,result:JSON.parse(resultJson)});
    const commitRef=`result-${resultDigest}`;
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      this.#assertRecoveryNotLatched(o.operation_id);
      this.#assertNoUnknownInteraction(o.operation_id);
      if(o.claim_id!==input.claim_id||o.claim_generation!==input.generation||o.claim_worker_identity_digest!==input.claim_worker_identity_digest)fail('result_claim_mismatch');
      if(o.result_digest!==null){
        if(o.result_generation!==input.generation)fail('result_generation_mismatch');
        const resultEvent=this.#db.prepare("SELECT sequence FROM manager_operation_events WHERE operation_id=? AND event_type='result_committed'").get(input.operation_id);
        if(!resultEvent||input.revision!==resultEvent.sequence-1)fail('stale_result_cas');
        if(o.result_digest===resultDigest&&o.result_status===input.result_status&&o.result_json===resultJson&&o.result_commit_ref===commitRef){
          if(input.result_status==='cancelled'){
            const persisted=this.#db.prepare("SELECT evidence_json FROM manager_operation_events WHERE operation_id=? AND sequence=?").get(input.operation_id,resultEvent.sequence);
            if(!persisted||JSON.parse(persisted.evidence_json).cancel_verification_digest!==input.cancel_verification_digest)fail('result_cancellation_evidence_mismatch');
          }
          return {duplicate:true,conflict:false,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,
            revision:o.revision,phase:o.phase,result_status:o.result_status,result_digest:o.result_digest,result_commit_ref:o.result_commit_ref};
        }
        if(input.result_status==='cancelled'&&o.result_status!=='cancelled'){
          const cancelIntent=this.#db.prepare("SELECT evidence_json FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(input.operation_id)
            .some(row=>JSON.parse(row.evidence_json).reason==='cancel_requested');
          if(cancelIntent)return {duplicate:false,conflict:false,cancellation_lost_to_result:true,operation_id:o.operation_id,
            task_id:o.task_id,attempt:o.attempt,generation:o.generation,revision:o.revision,phase:o.phase,result_status:o.result_status,
            result_digest:o.result_digest,result_commit_ref:o.result_commit_ref};
        }
        const quarantineEvent=this.#db.prepare("SELECT sequence,evidence_json FROM manager_operation_events WHERE operation_id=? AND event_type='quarantined' ORDER BY sequence").all(input.operation_id)
          .map(row=>({...row,evidence:JSON.parse(row.evidence_json)})).find(row=>row.evidence.reason==='result_conflict');
        if(o.phase==='quarantined'){
          if(quarantineEvent?.evidence.result_digest===resultDigest)return {duplicate:true,conflict:true,quarantined:true,operation_id:o.operation_id,
            generation:o.generation,revision:o.revision,result_digest:o.result_digest,conflict_evidence_digest:quarantineEvent.evidence.evidence_digest};
          fail('result_quarantine_exists');
        }
        if(o.phase==='released'){
          this.#poison('result_conflict_after_release',digest({operation_id:o.operation_id,claim_id:o.claim_id,generation:o.generation,existing_result_digest:o.result_digest,conflicting_result_digest:resultDigest}));
          fail('result_conflict_after_release');
        }
        const quarantineDigest=digest({result_contract_version:RESULT_CONTRACT_VERSION,reason:'result_conflict',operation_id:o.operation_id,
          claim_id:o.claim_id,generation:o.generation,existing_result_digest:o.result_digest,conflicting_result_digest:resultDigest});
        const at=new Date().toISOString();
        const changed=this.#db.prepare("UPDATE manager_operations SET phase='quarantined',revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase=? AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=? AND result_digest=?")
          .run(o.operation_id,o.task_id,o.attempt,o.generation,o.phase,o.revision,input.claim_id,input.generation,input.claim_worker_identity_digest,o.result_digest);
        if(changed.changes!==1)fail('stale_result_cas');
        this.#faultPoint('after_projection');
        this.#event(o.operation_id,o.revision+1,'quarantined',o.phase,'quarantined',o.generation,
          {claim_id:o.claim_id,reason:'result_conflict',result_digest:resultDigest,result_commit_ref:commitRef,evidence_digest:quarantineDigest},at);
        return {duplicate:false,conflict:true,quarantined:true,operation_id:o.operation_id,generation:o.generation,revision:o.revision+1,
          result_digest:o.result_digest,conflict_evidence_digest:quarantineDigest};
      }
      if(o.phase!=='running'||o.revision!==input.revision)fail('stale_result_cas');
      if(input.result_status==='cancelled'){
        const observations=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(input.operation_id)
          .map(event=>({...event,evidence:JSON.parse(event.evidence_json)}));
        const intent=observations.find(event=>event.evidence.reason==='cancel_requested');
        const verification=observations.find(event=>event.evidence.reason==='cancel_tree_verified');
        if(!intent||!verification||verification.sequence<=intent.sequence
          ||verification.evidence.cancel_id!==intent.evidence.cancel_id||verification.evidence.claim_id!==input.claim_id
          ||verification.evidence.worker_identity_digest!==input.claim_worker_identity_digest
          ||verification.evidence_digest!==input.cancel_verification_digest)fail('cancel_verification_required');
      }
      const current=this.#db.prepare('SELECT t.status AS task_status,t.current_attempt,a.status AS attempt_status FROM tasks t JOIN attempts a ON a.task_id=t.task_id WHERE t.task_id=? AND a.attempt=? AND a.generation=?').get(input.task_id,input.attempt,input.generation);
      if(!current||current.current_attempt!==input.attempt||current.task_status!=='running'||current.attempt_status!=='running')fail('result_attempt_not_running');
      const at=new Date().toISOString();
      const changed=this.#db.prepare("UPDATE manager_operations SET phase='result_committed',revision=revision+1,result_status=?,result_generation=?,result_digest=?,result_json=?,result_commit_ref=? WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='running' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=? AND result_digest IS NULL")
        .run(input.result_status,input.generation,resultDigest,resultJson,commitRef,input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.claim_id,input.generation,input.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_result_cas');
      const attempt=this.#db.prepare("UPDATE attempts SET status=? WHERE task_id=? AND attempt=? AND generation=? AND status='running'").run(input.result_status,input.task_id,input.attempt,input.generation);
      if(attempt.changes!==1)fail('result_attempt_status_conflict');
      const task=this.#db.prepare("UPDATE tasks SET status=? WHERE task_id=? AND current_attempt=? AND status='running'").run(input.result_status,input.task_id,input.attempt);
      if(task.changes!==1)fail('result_task_status_conflict');
      this.#faultPoint('after_projection');
      this.#event(input.operation_id,input.revision+1,'result_committed','running','result_committed',input.generation,
        {claim_id:input.claim_id,outcome:input.result_status,result_commit_ref:commitRef,result_digest:resultDigest,
          worker_identity_digest:input.claim_worker_identity_digest,...(input.result_status==='cancelled'?{cancel_verification_digest:input.cancel_verification_digest}:{})},at);
      return {duplicate:false,conflict:false,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,
        revision:input.revision+1,event_sequence:input.revision+1,phase:'result_committed',result_status:input.result_status,result_digest:resultDigest,result_commit_ref:commitRef};
    });
  }
  /** Persist an operation-scoped cleanup intent before any external OS cleanup is attempted. */
  beginCleanup(input) {
    this.#assertWritable();
    if(!validCleanupRequest(input))fail('invalid_cleanup_request');
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      this.#assertRecoveryNotLatched(o.operation_id);
      this.#assertNoUnknownInteraction(o.operation_id);
      if(o.claim_id!==input.claim_id||o.claim_generation!==input.generation||o.claim_worker_identity_digest!==input.claim_worker_identity_digest)fail('cleanup_claim_mismatch');
      if(o.phase==='cleanup_pending'){
        const prior=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='cleanup_pending'").get(input.operation_id);
        const evidence=prior&&JSON.parse(prior.evidence_json);
        if(prior&&prior.sequence===input.revision+1&&evidence.claim_id===input.claim_id&&evidence.result_commit_ref===o.result_commit_ref
          &&evidence.worker_identity_digest===input.claim_worker_identity_digest)return {duplicate:true,operation_id:o.operation_id,generation:o.generation,revision:o.revision,phase:o.phase};
        fail('cleanup_pending_conflict');
      }
      if(o.phase!=='result_committed'||o.revision!==input.revision||o.result_digest===null||o.result_commit_ref===null)fail('cleanup_result_not_committed');
      const changed=this.#db.prepare("UPDATE manager_operations SET phase='cleanup_pending',revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='result_committed' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=? AND result_digest IS NOT NULL")
        .run(input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.claim_id,input.generation,input.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_cleanup_cas');
      const at=new Date().toISOString();
      this.#faultPoint('after_projection');
      this.#event(input.operation_id,input.revision+1,'cleanup_pending','result_committed','cleanup_pending',input.generation,
        {claim_id:input.claim_id,result_commit_ref:o.result_commit_ref,worker_identity_digest:input.claim_worker_identity_digest},at);
      return {duplicate:false,operation_id:o.operation_id,generation:o.generation,revision:input.revision+1,event_sequence:input.revision+1,phase:'cleanup_pending'};
    });
  }
  /** Persist only evidence supplied after an external, operation-scoped cleanup attempt. */
  recordCleanupEvidence(input) {
    this.#assertWritable();
    if(!validCleanupRequest(input)||!['verified','unverified'].includes(input?.outcome))fail('invalid_cleanup_request');
    let normalized=null,cleanupDigest=null;
    if(input.outcome==='verified'){
      normalized=normalizeCleanupEvidence(input.cleanup_evidence,input);
      cleanupDigest=digest({cleanup_contract_version:1,evidence:normalized});
    } else if(!['alive','unknown','identity_mismatch','incomplete'].includes(input?.probe_state)||!validText(input?.reason,128))fail('invalid_cleanup_outcome');
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      this.#assertRecoveryNotLatched(o.operation_id);
      this.#assertNoUnknownInteraction(o.operation_id);
      if(o.claim_id!==input.claim_id||o.claim_generation!==input.generation||o.claim_worker_identity_digest!==input.claim_worker_identity_digest)fail('cleanup_claim_mismatch');
      if(o.launch_receipt_digest===null||o.result_commit_ref===null||o.result_digest===null)fail('cleanup_prerequisite_missing');
      if(input.outcome==='verified'&&(normalized.launch_receipt_digest!==o.launch_receipt_digest||normalized.result_commit_ref!==o.result_commit_ref))fail('cleanup_evidence_identity_mismatch');
      if(input.outcome==='verified'){
        const worker=JSON.parse(o.claim_worker_identity_json),launchIdentity=JSON.parse(o.launch_identity_json);
        if(normalized.root_process_id!==worker.process_id||normalized.root_start_fingerprint!==worker.start_fingerprint
          ||normalized.root_process_id!==launchIdentity.process_id||normalized.root_start_fingerprint!==launchIdentity.start_fingerprint)fail('cleanup_worker_identity_mismatch');
      }
      const finalType=input.outcome==='verified'?'cleanup_verified':'cleanup_unverified';
      const final=this.#db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type IN (\'cleanup_verified\',\'cleanup_unverified\')').get(input.operation_id);
      if(final){
        const evidence=JSON.parse(final.evidence_json);
        const same=input.outcome==='verified'
          ? final.event_type==='cleanup_verified'&&evidence.cleanup_digest===cleanupDigest
          : final.event_type==='cleanup_unverified'&&evidence.probe_state===input.probe_state&&evidence.reason===input.reason;
        if(same&&final.sequence===input.revision+1&&(o.phase===finalType||o.phase==='released'))return {duplicate:true,operation_id:o.operation_id,generation:o.generation,
          revision:final.sequence,phase:o.phase,cleanup_verified:input.outcome==='verified',cleanup_digest:input.outcome==='verified'?evidence.cleanup_digest:undefined};
        if(o.phase==='released'){this.#poison('cleanup_evidence_conflict_after_release',digest({operation_id:o.operation_id,generation:o.generation,cleanup_digest:cleanupDigest??null}));fail('cleanup_result_conflict_after_release');}
        fail('cleanup_evidence_conflict');
      }
      if(o.phase!=='cleanup_pending'||o.revision!==input.revision)fail('stale_cleanup_cas');
      const at=new Date().toISOString();
      const next=input.outcome==='verified'?'cleanup_verified':'cleanup_unverified';
      const changed=this.#db.prepare('UPDATE manager_operations SET phase=?,revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase=\'cleanup_pending\' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=? AND result_commit_ref=?')
        .run(next,input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.claim_id,input.generation,input.claim_worker_identity_digest,o.result_commit_ref);
      if(changed.changes!==1)fail('stale_cleanup_cas');
      this.#faultPoint('after_projection');
      if(input.outcome==='verified'){
        const eventEvidence={claim_id:input.claim_id,cleanup_digest:cleanupDigest,evidence_source:normalized.source,launch_receipt_digest:normalized.launch_receipt_digest,
          operation_resources_complete:normalized.operation_resources_complete,process_tree_digest:normalized.process_tree_digest,resources_digest:normalized.resources_digest,
          result_commit_ref:normalized.result_commit_ref,root_process_id:normalized.root_process_id,root_start_fingerprint:normalized.root_start_fingerprint,
          worker_identity_digest:input.claim_worker_identity_digest,worker_tree_complete:normalized.worker_tree_complete,
          workspace_touched:normalized.workspace_touched};
        this.#event(input.operation_id,input.revision+1,'cleanup_verified','cleanup_pending','cleanup_verified',input.generation,eventEvidence,at);
      } else {
        this.#event(input.operation_id,input.revision+1,'cleanup_unverified','cleanup_pending','cleanup_unverified',input.generation,
          {claim_id:input.claim_id,probe_state:input.probe_state,reason:input.reason,worker_identity_digest:input.claim_worker_identity_digest},at);
      }
      return {duplicate:false,operation_id:o.operation_id,generation:o.generation,revision:input.revision+1,event_sequence:input.revision+1,phase:next,
        cleanup_verified:input.outcome==='verified',cleanup_digest:cleanupDigest};
    });
  }
  /** Replace a prior cleanup-unknown outcome only with fresh, complete, operation-bound evidence.
   * The re-verification event, exact cleanup-Hold resolution, and normal verified projection are atomic.
   */
  reverifyCleanup(input) {
    this.#assertWritable();
    if(!validCleanupRequest(input)||!input.cleanup_evidence)fail('invalid_cleanup_reverification');
    const normalized=normalizeCleanupEvidence(input.cleanup_evidence,input);
    const cleanupDigest=digest({cleanup_contract_version:1,evidence:normalized});
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      this.#assertNoUnknownInteraction(o.operation_id);
      if(o.claim_id!==input.claim_id||o.claim_generation!==input.generation||o.claim_worker_identity_digest!==input.claim_worker_identity_digest
        ||o.launch_receipt_digest!==normalized.launch_receipt_digest||o.result_commit_ref!==normalized.result_commit_ref
        ||o.result_digest===null)fail('cleanup_reverification_identity_mismatch');
      const history=this.#db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence')
        .all(o.operation_id).map(event=>({...event,evidence:JSON.parse(event.evidence_json)}));
      const unverified=history.filter(event=>event.event_type==='cleanup_unverified');
      if(unverified.length!==1||unverified[0].evidence.claim_id!==o.claim_id
        ||unverified[0].evidence.worker_identity_digest!==o.claim_worker_identity_digest)fail('cleanup_unverified_event_missing_or_conflicting');
      const priorReverification=history.find(event=>event.event_type==='cleanup_reverified');
      if(priorReverification&&(o.phase==='cleanup_verified'||o.phase==='released')&&o.revision>=input.revision+2
        &&priorReverification.from_phase==='cleanup_unverified'&&priorReverification.to_phase==='cleanup_reverified'
        &&priorReverification.evidence.prior_cleanup_event_digest===unverified[0].evidence_digest
        &&priorReverification.evidence.cleanup_digest===cleanupDigest
        &&history.some(event=>event.event_type==='cleanup_verified'&&event.evidence.cleanup_digest===cleanupDigest
          &&event.sequence===priorReverification.sequence+1)){
        const verified=history.find(event=>event.event_type==='cleanup_verified'&&event.evidence.cleanup_digest===cleanupDigest);
        return {duplicate:true,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
          claim_id:o.claim_id,revision:verified.sequence,event_sequence:verified.sequence,phase:o.phase,cleanup_verified:true,cleanup_digest:cleanupDigest,
          resolved_recovery_event_digests:priorReverification.evidence.resolved_recovery_event_digests};
      }
      if(o.phase!=='cleanup_unverified'||o.revision!==input.revision)fail('stale_cleanup_reverification_cas');
      if(priorReverification)fail('cleanup_reverification_already_committed');
      const recovery=recoveryEventsFor(history,o);
      const active=recovery.filter(event=>event.active);
      if(active.some(event=>event.evidence.classification!=='hold'
        ||!['cleanup_identity_unknown','cleanup_incomplete'].includes(event.evidence.reason_code)))fail('cleanup_reverification_blocked_by_unrelated_hold');
      const resolvedDigests=active.map(event=>event.event.evidence_digest).sort();
      if(resolvedDigests.length>RECOVERY_LIMIT)fail('cleanup_reverification_hold_limit');
      const changed=this.#db.prepare("UPDATE manager_operations SET phase='cleanup_reverified',revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='cleanup_unverified' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=? AND result_commit_ref=?")
        .run(o.operation_id,o.task_id,o.attempt,o.generation,input.revision,o.claim_id,o.generation,o.claim_worker_identity_digest,o.result_commit_ref);
      if(changed.changes!==1)fail('stale_cleanup_reverification_cas');
      const baseEvidence={claim_id:o.claim_id,cleanup_digest:cleanupDigest,evidence_source:normalized.source,
        launch_receipt_digest:normalized.launch_receipt_digest,operation_resources_complete:true,
        process_tree_digest:normalized.process_tree_digest,resources_digest:normalized.resources_digest,
        result_commit_ref:o.result_commit_ref,root_process_id:normalized.root_process_id,
        root_start_fingerprint:normalized.root_start_fingerprint,worker_identity_digest:o.claim_worker_identity_digest,
        worker_tree_complete:true,workspace_touched:false};
      const reverifiedEvidence={...baseEvidence,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
        prior_cleanup_event_digest:unverified[0].evidence_digest,
        resolved_recovery_event_digests:resolvedDigests};
      validateEvidence('cleanup_reverified',reverifiedEvidence);
      const at=new Date().toISOString();
      this.#event(o.operation_id,input.revision+1,'cleanup_reverified','cleanup_unverified','cleanup_reverified',o.generation,reverifiedEvidence,at);
      this.#faultPoint('after_cleanup_reverification_event');
      const finalized=this.#db.prepare("UPDATE manager_operations SET phase='cleanup_verified',revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='cleanup_reverified' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=?")
        .run(o.operation_id,o.task_id,o.attempt,o.generation,input.revision+1,o.claim_id,o.generation,o.claim_worker_identity_digest);
      if(finalized.changes!==1)fail('stale_cleanup_reverification_finalize');
      this.#event(o.operation_id,input.revision+2,'cleanup_verified','cleanup_reverified','cleanup_verified',o.generation,baseEvidence,at);
      return {duplicate:false,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,
        claim_id:o.claim_id,revision:input.revision+2,event_sequence:input.revision+2,phase:'cleanup_verified',cleanup_verified:true,cleanup_digest:cleanupDigest,
        resolved_recovery_event_digests:resolvedDigests};
    });
  }
  /** Release only this operation's capacity slot after persisted verified cleanup evidence. */
  releaseCapacity(input) {
    this.#assertWritable();
    if(!validCleanupRequest(input)||typeof input.cleanup_digest!=='string'||!/^[0-9a-f]{64}$/u.test(input.cleanup_digest))fail('invalid_release_request');
    return this.#transaction(()=>{
      const o=this.#attemptOperation(input);
      this.#assertRecoveryNotLatched(o.operation_id);
      this.#assertNoUnknownInteraction(o.operation_id);
      if(o.claim_id!==input.claim_id||o.claim_generation!==input.generation||o.claim_worker_identity_digest!==input.claim_worker_identity_digest)fail('release_claim_mismatch');
      const verified=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='cleanup_verified'").get(input.operation_id);
      const release=this.#db.prepare("SELECT * FROM manager_operation_events WHERE operation_id=? AND event_type='released'").get(input.operation_id);
      if(o.phase==='released'){
        const e=release&&JSON.parse(release.evidence_json);
        if(release&&release.sequence===input.revision+1&&e.claim_id===input.claim_id&&e.cleanup_digest===input.cleanup_digest
          &&e.worker_identity_digest===input.claim_worker_identity_digest)return {duplicate:true,operation_id:o.operation_id,generation:o.generation,
            revision:release.sequence,phase:'released',capacity_released:true};
        this.#poison('release_conflict_after_release',digest({operation_id:o.operation_id,generation:o.generation,cleanup_digest:input.cleanup_digest}));
        fail('release_conflict_after_release');
      }
      if(o.phase!=='cleanup_verified'||o.revision!==input.revision||!verified)fail('cleanup_not_verified');
      const evidence=JSON.parse(verified.evidence_json);
      if(evidence.cleanup_digest!==input.cleanup_digest||evidence.claim_id!==input.claim_id||evidence.worker_identity_digest!==input.claim_worker_identity_digest
        ||evidence.launch_receipt_digest!==o.launch_receipt_digest||evidence.result_commit_ref!==o.result_commit_ref)fail('release_cleanup_evidence_mismatch');
      const projection=this.#db.prepare('SELECT t.status AS task_status,t.current_attempt,a.status AS attempt_status FROM tasks t JOIN attempts a ON a.task_id=t.task_id WHERE t.task_id=? AND a.attempt=? AND a.generation=?')
        .get(o.task_id,o.attempt,o.generation);
      if(!projection||projection.current_attempt!==o.attempt||projection.task_status!==o.result_status||projection.attempt_status!==o.result_status
        ||o.result_generation!==o.generation||o.result_digest===null)fail('release_result_projection_mismatch');
      const changed=this.#db.prepare("UPDATE manager_operations SET phase='released',revision=revision+1 WHERE operation_id=? AND task_id=? AND attempt=? AND generation=? AND phase='cleanup_verified' AND revision=? AND claim_id=? AND claim_generation=? AND claim_worker_identity_digest=? AND result_digest IS NOT NULL")
        .run(input.operation_id,input.task_id,input.attempt,input.generation,input.revision,input.claim_id,input.generation,input.claim_worker_identity_digest);
      if(changed.changes!==1)fail('stale_release_cas');
      this.#faultPoint('after_projection');
      this.#event(input.operation_id,input.revision+1,'released','cleanup_verified','released',input.generation,
        {claim_id:input.claim_id,cleanup_digest:input.cleanup_digest,result_commit_ref:o.result_commit_ref,worker_identity_digest:input.claim_worker_identity_digest},new Date().toISOString());
      return {duplicate:false,operation_id:o.operation_id,generation:o.generation,revision:input.revision+1,event_sequence:input.revision+1,phase:'released',capacity_released:true};
    });
  }
  #cancellationWorker(input,o){
    if(!o.claim_id||o.claim_id!==input.claim_id||o.claim_generation!==input.generation
      ||o.claim_worker_identity_digest!==input.claim_worker_identity_digest||!o.claim_worker_identity_json||!o.launch_identity_json)
      fail('cancellation_claim_mismatch');
    fixtureWorkerIdentity(input.worker_identity);
    const workerJson=canonical(input.worker_identity);
    if(workerJson!==o.claim_worker_identity_json||digest(workerJson)!==o.claim_worker_identity_digest)fail('cancellation_worker_identity_mismatch');
    let launchIdentity;try{launchIdentity=JSON.parse(o.launch_identity_json);}catch{fail('launch_identity_invalid');}
    if(input.worker_identity.process_id!==launchIdentity.process_id||input.worker_identity.start_fingerprint!==launchIdentity.start_fingerprint)
      fail('cancellation_worker_identity_mismatch');
    return input.worker_identity;
  }
  #attemptOperation(input){
    const o=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(input.operation_id);
    if(!o)fail('operation_not_found');
    if(o.task_id!==input.task_id||o.attempt!==input.attempt||o.generation!==input.generation)fail('operation_identity_mismatch');
    return o;
  }
  #assertRecoveryNotLatched(operationId){
    const operation=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=?").get(operationId);
    if(!operation)fail('operation_not_found');
    const events=this.#db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence').all(operationId);
    if(recoveryEventsFor(events,operation).some(event=>event.active))fail('operation_recovery_latched');
  }
  #assertInteractionRunning(o,input){
    if(o.operation_kind!=='attempt_lifecycle'||o.phase!=='running'||o.task_id!==input.task_id||o.attempt!==input.attempt
      ||o.generation!==input.generation||o.claim_id!==input.claim_id||o.claim_generation!==o.generation
      ||o.claim_worker_identity_digest!==input.worker_identity_digest)fail('interaction_identity_mismatch');
    const projection=this.#db.prepare('SELECT t.current_attempt,t.status AS task_status,a.status AS attempt_status,a.generation FROM tasks t JOIN attempts a ON a.task_id=t.task_id AND a.attempt=? WHERE t.task_id=?').get(o.attempt,o.task_id);
    if(!projection||projection.current_attempt!==o.attempt||projection.task_status!=='running'||projection.attempt_status!=='running'
      ||projection.generation!==o.generation)fail('interaction_task_projection_mismatch');
  }
  #assertNoUnknownInteraction(operationId){
    const rows=this.#db.prepare("SELECT event_type,evidence_json FROM manager_operation_events WHERE operation_id=? AND event_type IN ('interaction_reply_intent','interaction_reply_accepted') ORDER BY sequence").all(operationId);
    const pending=new Set();
    for(const row of rows){const requestId=JSON.parse(row.evidence_json).request_id;
      if(row.event_type==='interaction_reply_intent')pending.add(requestId);else pending.delete(requestId);}
    if(pending.size)fail('interaction_reply_outcome_unknown');
  }
  #assertNoCancellationIntent(operationId){
    const rows=this.#db.prepare("SELECT evidence_json FROM manager_operation_events WHERE operation_id=? AND event_type='observation_recorded'").all(operationId);
    if(rows.some(row=>{try{return JSON.parse(row.evidence_json).reason==='cancel_requested';}catch{fail('database_unreadable');}}))
      fail('interaction_cancel_intent_present');
  }
  #readConsistent(read){
    this.#assertOpen();this.#db.exec('BEGIN');
    try{this.#validateContents();const result=read();this.#db.exec('COMMIT');return result;}
    catch(e){try{this.#db.exec('ROLLBACK');}catch{}throw e;}
  }
  #nextEventCursor(){
    const row=this.#db.prepare('UPDATE authority_metadata SET next_event_cursor=next_event_cursor+1 WHERE singleton=1 AND next_event_cursor<9007199254740991 RETURNING next_event_cursor').get();
    if(!row||!Number.isSafeInteger(row.next_event_cursor)||row.next_event_cursor<1)fail('event_cursor_exhausted');
    const sequence=this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name='manager_operation_events'").get();
    if(sequence&&(!Number.isSafeInteger(sequence.seq)||sequence.seq<0||sequence.seq>row.next_event_cursor))fail('event_cursor_invalid');
    const changed=this.#db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='manager_operation_events'").run(row.next_event_cursor);
    if(changed.changes===0)this.#db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('manager_operation_events',?)").run(row.next_event_cursor);
    else if(changed.changes!==1)fail('event_cursor_invalid');
    return row.next_event_cursor;
  }
  #event(id,seq,type,from,to,generation,evidence,at,cursor){
    const eventCursor=cursor??this.#nextEventCursor(),j=canonical(validateEvidence(type,evidence));
    this.#db.prepare('INSERT INTO manager_operation_events(event_cursor,operation_id,sequence,event_type,from_phase,to_phase,generation,evidence_json,evidence_digest,at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(eventCursor,id,seq,type,from,to,generation,j,digest(j),at);
    this.#faultPoint('after_event_insert');
    return eventCursor;
  }
  #assertOpen(){if(this.#closed)fail('store_closed');}
  #assertWritable(){this.#assertOpen();if(this.#recoveryOnly)fail('recovery_read_only');if(this.poisoned)fail('root_poisoned');this.#validate();}
  #faultPoint(name){if(this.#fault===name||this.#fault==='rollback_unknown'&&name==='after_projection')fail('injected_failure',`injected ${name}`);}
  #transaction(fn){
    this.#assertWritable(); let began=false,commitStarted=false,settled=false;const token=randomUUID();
    try {const fd=openSync(this.#paths.intent,'wx',0o600);try{writeFileSync(fd,JSON.stringify({version:1,token,started_at:new Date().toISOString()}));fsyncSync(fd);}finally{closeSync(fd);}}
    catch(e){if(e?.code==='EEXIST')fail('root_writer_busy');throw e;}
    try {this.#db.exec('BEGIN IMMEDIATE');began=true;assertCandidateSchema(this.#db);const v=fn();this.#validate(false);commitStarted=true;this.#db.exec('COMMIT');settled=true;if(this.#fault==='commit_ack_lost')throw new Error('injected lost commit acknowledgment');return v;}
    catch(e){
      if(commitStarted&&isBusy(e)){
        try { this.#db.exec('ROLLBACK'); settled=true; fail('root_writer_busy'); }
        catch(re){ if(re instanceof AdmissionError&&re.code==='root_writer_busy')throw re; this.#poison('commit_busy_rollback_unknown',String(re));fail('transaction_outcome_unknown',String(re)); }
      }
      if(commitStarted){this.#poison('commit_outcome_unknown',String(e));fail('transaction_outcome_unknown',String(e));}
      if(began){try{if(this.#fault==='rollback_unknown')throw new Error('injected rollback outcome unknown');this.#db.exec('ROLLBACK');settled=true;}catch(re){this.#poison('rollback_outcome_unknown',String(re));fail('transaction_outcome_unknown',String(re));}}
      else {settled=true;if(isBusy(e))fail('root_writer_busy');}
      throw e;
    } finally {
      if(settled&&!this.#poisoned&&!existsSync(this.#paths.poison)){try{const intent=JSON.parse(readFileSync(this.#paths.intent,'utf8'));if(intent.token!==token)fail('writer_intent_identity_mismatch');unlinkSync(this.#paths.intent);}catch(e){this.#poison('writer_intent_release_unknown',String(e));fail('transaction_outcome_unknown',String(e));}}
    }
  }
  #poison(reason,detail){this.#poisoned=true;writePoison(this.#paths.poison,{version:1,reason,detail,at:new Date().toISOString()});}
  #validate(integrity=true){
    if(!integrity){
      if(this.#db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('foreign_keys_disabled');
      if(this.#db.prepare('PRAGMA user_version').get().user_version!==SCHEMA_VERSION)fail('schema_version_unknown');
      return;
    }
    this.#readConsistent(()=>undefined);
  }
  #validateContents(){
    try {
      if(this.#db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('foreign_keys_disabled');
      if(this.#db.prepare('PRAGMA user_version').get().user_version!==SCHEMA_VERSION)fail('schema_version_unknown');
      assertCandidateSchema(this.#db);
      if(this.#db.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('database_corrupt');
      if(this.#db.prepare('PRAGMA foreign_key_check').all().length)fail('database_inconsistent');
      const m=this.#db.prepare('SELECT * FROM authority_metadata').all();if(m.length!==1||m[0].schema_version!==SCHEMA_VERSION)fail('policy_or_schema_mismatch');
      const freshReceipts=this.#db.prepare('SELECT * FROM fresh_install_receipt').all();
      const authoritySwitches=this.#db.prepare('SELECT * FROM authority_switch').all();
      const migrationRuns=this.#db.prepare('SELECT * FROM migration_runs').all();
      const migratedResultsCount=this.#db.prepare('SELECT COUNT(*) AS n FROM migrated_task_results').get().n;
      const migratedEventsCount=this.#db.prepare('SELECT COUNT(*) AS n FROM migrated_task_events').get().n;
      if(freshReceipts.length>1||authoritySwitches.length>1||migrationRuns.length>1
        ||freshReceipts.length&&authoritySwitches.length)fail('authority_receipt_missing_or_ambiguous');
      if(freshReceipts.length){
        if(migrationRuns.length||migratedResultsCount||migratedEventsCount
          ||this.#db.prepare('SELECT COUNT(*) AS n FROM json_artifacts').get().n)fail('fresh_install_contains_legacy_data');
      }else if(authoritySwitches.length){
        const receipt=authoritySwitches[0],migration=migrationRuns[0];
        if(!migration||migration.state!=='verified'||migration.migration_id!==receipt.migration_id
          ||migration.source_root_digest!==receipt.source_root_digest
          ||migration.source_manifest_digest!==receipt.source_manifest_digest
          ||digest(migration.source_manifest_json)!==migration.source_manifest_digest
          ||!validText(migration.archive_directory,32767)||!path.isAbsolute(migration.archive_directory)
          ||!validText(receipt.archive_directory,32767)||!path.isAbsolute(receipt.archive_directory)
          ||migration.archive_directory!==receipt.archive_directory
          ||typeof migration.archive_manifest_digest!=='string'||!/^[0-9a-f]{64}$/u.test(migration.archive_manifest_digest)
          ||migration.archive_manifest_digest!==receipt.archive_manifest_digest
          ||!validText(migration.archive_source_tasks_root,32767)||!path.isAbsolute(migration.archive_source_tasks_root)
          ||migration.archive_source_tasks_root!==receipt.archive_source_tasks_root
          ||!Number.isSafeInteger(migration.archive_file_count)||migration.archive_file_count<0
          ||migration.archive_file_count!==migration.source_artifact_count
          ||migration.archive_file_count!==receipt.archive_file_count
          ||!Number.isSafeInteger(migration.archive_byte_count)||migration.archive_byte_count<0
          ||migration.archive_byte_count!==migration.source_artifact_bytes
          ||migration.archive_byte_count!==receipt.archive_byte_count
          ||receipt.schema_version!==SCHEMA_VERSION||!validText(receipt.protocol_version,128)
          ||typeof receipt.runtime_roster_digest!=='string'||!/^[0-9a-f]{64}$/u.test(receipt.runtime_roster_digest)
          ||!validText(receipt.verifier_version,128)
          ||!validText(migration.verifier_version,128)||receipt.verifier_version!==migration.verifier_version
          ||!validText(receipt.cutover_id,128)||!validText(receipt.created_at,64)||Number.isNaN(Date.parse(receipt.created_at))
          ||!validText(migration.created_at,64)||!validText(migration.verified_at,64)
          ||Number.isNaN(Date.parse(migration.created_at))||Number.isNaN(Date.parse(migration.verified_at)))fail('authority_switch_invalid');
        const policy=parseAuthoritySourceManifest(migration.source_manifest_json,migration.source_manifest_digest);
        if(policy.manifest.task_count!==migration.source_task_count
          ||policy.manifest.artifact_count!==migration.source_artifact_count
          ||policy.manifest.artifact_bytes!==migration.source_artifact_bytes
          ||policy.manifest.result_count!==migration.source_result_count
          ||policy.manifest.event_count!==migration.source_event_count)fail('authority_switch_invalid');
      }else if(migrationRuns.length||migratedResultsCount||migratedEventsCount
        ||this.#db.prepare('SELECT COUNT(*) AS n FROM json_artifacts').get().n){
        fail('migration_receipt_missing');
      }
      const artifacts=this.#db.prepare('SELECT * FROM json_artifacts ORDER BY artifact_id').all();
      const artifactById=new Map(),artifactPathById=new Map();
      let artifactBytes=0;
      for(const artifact of artifacts){
        const content=Buffer.from(artifact.content);
        if(!validText(artifact.relative_path,1024)||artifact.relative_path.includes('\\')
          ||artifact.relative_path.startsWith('/')||artifact.relative_path.split('/').some(part=>!part||part==='.'||part==='..')
          ||!validText(artifact.kind,64)||!Number.isSafeInteger(artifact.byte_length)||artifact.byte_length<0
          ||content.length!==artifact.byte_length||rawDigest(content)!==artifact.sha256
          ||artifactPathById.has(artifact.relative_path))fail('migrated_artifact_invalid');
        if(artifact.task_id!==null&&!this.#db.prepare('SELECT 1 FROM tasks WHERE task_id=?').get(artifact.task_id))
          fail('migrated_artifact_task_mismatch');
        if(artifact.attempt!==null&&(artifact.task_id===null
          ||!this.#db.prepare('SELECT 1 FROM attempts WHERE task_id=? AND attempt=?').get(artifact.task_id,artifact.attempt)))
          fail('migrated_artifact_attempt_mismatch');
        artifactById.set(artifact.artifact_id,artifact);
        artifactPathById.set(artifact.relative_path,artifact);
        artifactBytes+=artifact.byte_length;
      }
      if(authoritySwitches.length){
        const migration=migrationRuns[0];
        const policy=parseAuthoritySourceManifest(migration.source_manifest_json,migration.source_manifest_digest);
        if(policy.kind==='raw_json_archive_cutover'){
          if(artifacts.length!==0||migratedResultsCount!==0||migratedEventsCount!==0
            ||migration.source_task_count!==0||migration.source_result_count!==0||migration.source_event_count!==0
            ||migration.source_artifact_count!==migration.archive_file_count
            ||migration.source_artifact_bytes!==migration.archive_byte_count)
            fail('raw_cutover_contains_legacy_projection',JSON.stringify({
              artifact_count:artifacts.length,
              migrated_result_count:migratedResultsCount,migrated_event_count:migratedEventsCount,
              source_task_count:migration.source_task_count,source_result_count:migration.source_result_count,
              source_event_count:migration.source_event_count,source_artifact_count:migration.source_artifact_count,
              archive_file_count:migration.archive_file_count,source_artifact_bytes:migration.source_artifact_bytes,
              archive_byte_count:migration.archive_byte_count
            }));
        }else{
          const migratedOnlineTaskIds=new Set(artifacts
            .map(artifact=>artifact.task_id)
            .filter(taskId=>taskId!==null));
          if(!Number.isSafeInteger(migration.source_task_count)||migration.source_task_count<0
            ||!Number.isSafeInteger(migration.source_artifact_count)||migration.source_artifact_count<0
            ||!Number.isSafeInteger(migration.source_artifact_bytes)||migration.source_artifact_bytes<0
            ||!Number.isSafeInteger(migration.source_result_count)||migration.source_result_count<0
            ||!Number.isSafeInteger(migration.source_event_count)||migration.source_event_count<0
            ||migration.source_task_count!==migratedOnlineTaskIds.size+policy.exceptionTaskIds.length
            ||migration.source_artifact_count!==artifacts.length||migration.source_artifact_bytes!==artifactBytes
            ||migration.source_result_count!==migratedResultsCount||migration.source_event_count!==migratedEventsCount
            ||migration.archive_file_count!==artifacts.length||migration.archive_byte_count!==artifactBytes)
            fail('migration_counts_mismatch');
        }
        for(const taskId of policy.exceptionTaskIds){
          if(this.#db.prepare('SELECT 1 FROM tasks WHERE task_id=?').get(taskId)
            ||this.#db.prepare('SELECT 1 FROM migrated_task_results WHERE task_id=?').get(taskId)
            ||this.#db.prepare('SELECT 1 FROM migrated_task_events WHERE task_id=?').get(taskId)
            ||artifacts.some(artifact=>artifact.relative_path.startsWith(`${taskId}/`)
              &&(artifact.task_id!==null||artifact.attempt!==null)))fail('historical_exception_promoted_to_online_authority');
        }
        for(const exception of policy.exceptions){
          const artifact=artifactById.get(exception.artifact_id);
          if(!artifact||artifact.relative_path!==exception.relative_path||artifact.sha256!==exception.sha256
            ||artifact.byte_length!==exception.byte_length||artifact.task_id!==null||artifact.attempt!==null
            ||this.#db.prepare('SELECT 1 FROM migrated_task_results WHERE artifact_id=?').get(exception.artifact_id))
            fail('invalid_historical_exception_artifact');
        }
      }
      const migratedResults=this.#db.prepare('SELECT * FROM migrated_task_results ORDER BY task_id,attempt').all();
      for(const resultRow of migratedResults){
        const task=this.#db.prepare('SELECT current_attempt FROM tasks WHERE task_id=?').get(resultRow.task_id);
        const artifact=artifactById.get(resultRow.artifact_id);
        const expectedPath=resultRow.attempt===task?.current_attempt
          ? `${resultRow.task_id}/result.json`
          : `${resultRow.task_id}/attempts/${resultRow.attempt}/result.json`;
        const currentResultArtifact=artifact?.attempt===null&&artifact?.kind==='task_result'&&expectedPath===`${resultRow.task_id}/result.json`;
        let result;
        try{result=JSON.parse(resultRow.result_json);canonicalTaskResult(result,{task_id:resultRow.task_id,attempt:resultRow.attempt,result_status:result.status});}
        catch{fail('migrated_result_invalid');}
        if(!task||!artifact||artifact.task_id!==resultRow.task_id||(artifact.attempt!==resultRow.attempt&&!currentResultArtifact)
          ||artifact.relative_path!==expectedPath||canonical(result)!==resultRow.result_json
          ||digest(resultRow.result_json)!==resultRow.result_digest)fail('migrated_result_artifact_mismatch');
      }
      const migratedEvents=this.#db.prepare('SELECT * FROM migrated_task_events ORDER BY event_cursor').all();
      const seenSourceEvents=new Set();
      const seenEventCursors=new Set();
      for(const event of migratedEvents){
        const artifact=artifactById.get(event.artifact_id);
        const sourceKey=`${event.task_id}\0${event.source_sequence}`;
        const expectedDetails=event.details_json===null?null:digest(event.details_json);
        if(!Number.isSafeInteger(event.event_cursor)||event.event_cursor<1||seenEventCursors.has(event.event_cursor)
          ||!Number.isSafeInteger(event.source_sequence)||event.source_sequence<1||seenSourceEvents.has(sourceKey)
          ||!validText(event.event_type,128)||!validText(event.at,64)||Number.isNaN(Date.parse(event.at))
          ||!validText(event.summary,4096)||!artifact||artifact.task_id!==event.task_id||artifact.attempt!==null
          ||artifact.relative_path!==`${event.task_id}/events.jsonl`||expectedDetails!==event.details_digest)
          fail('migrated_event_invalid');
        seenEventCursors.add(event.event_cursor);
        seenSourceEvents.add(sourceKey);
      }
      const maxAssigned=this.#db.prepare('SELECT MAX(generation) AS n FROM attempts WHERE generation IS NOT NULL').get().n??0;
      if(m[0].next_generation<maxAssigned)fail('generation_authority_regressed');
      const eventCursorState=this.#db.prepare('SELECT COUNT(*) AS n,MIN(event_cursor) AS min_cursor,MAX(event_cursor) AS max_cursor FROM manager_operation_events').get();
      if(eventCursorState.max_cursor!==null&&(!Number.isSafeInteger(eventCursorState.max_cursor)||eventCursorState.max_cursor<1)
        ||eventCursorState.n>0&&(!Number.isSafeInteger(eventCursorState.min_cursor)||eventCursorState.min_cursor<1))fail('event_cursor_invalid');
      const invalidCursor=this.#db.prepare('SELECT event_cursor FROM manager_operation_events WHERE event_cursor<=0 LIMIT 1').get();if(invalidCursor)fail('event_cursor_invalid');
      const eventSchema=this.#db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='manager_operation_events'").get()?.sql;
      if(typeof eventSchema!=='string'||!/event_cursor\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/iu.test(eventSchema))fail('event_cursor_schema_mismatch');
      const sequenceRows=this.#db.prepare('SELECT name,seq FROM sqlite_sequence').all();
      const unlinkedCancelCursorState=this.#db.prepare('SELECT COUNT(*) AS n,MIN(queued_cancel_event_cursor) AS min_cursor,MAX(queued_cancel_event_cursor) AS max_cursor FROM attempts WHERE queued_cancel_id IS NOT NULL AND queued_cancel_operation_id IS NULL').get();
      const logicalCursorState=this.#db.prepare(`SELECT COUNT(*) AS n,MIN(cursor) AS min_cursor,MAX(cursor) AS max_cursor FROM (
        SELECT event_cursor AS cursor FROM manager_operation_events
        UNION ALL SELECT queued_cancel_event_cursor AS cursor FROM attempts WHERE queued_cancel_id IS NOT NULL AND queued_cancel_operation_id IS NULL
        UNION ALL SELECT event_cursor AS cursor FROM migrated_task_events)`).get();
      if(unlinkedCancelCursorState.n&&(!Number.isSafeInteger(unlinkedCancelCursorState.min_cursor)||unlinkedCancelCursorState.min_cursor<1
        ||!Number.isSafeInteger(unlinkedCancelCursorState.max_cursor)||unlinkedCancelCursorState.max_cursor<1)
        ||logicalCursorState.n!==m[0].next_event_cursor
        ||m[0].next_event_cursor===0&&(logicalCursorState.min_cursor!==null||logicalCursorState.max_cursor!==null)
        ||m[0].next_event_cursor>0&&(logicalCursorState.min_cursor!==1||logicalCursorState.max_cursor!==m[0].next_event_cursor))fail('event_cursor_invalid');
      if(sequenceRows.some(row=>row.name!=='manager_operation_events')
        ||logicalCursorState.n===0&&sequenceRows.length!==0
        ||logicalCursorState.n>0&&(sequenceRows.length!==1||sequenceRows[0].seq!==logicalCursorState.max_cursor
          ||!Number.isSafeInteger(sequenceRows[0].seq)||sequenceRows[0].seq<1))fail('event_cursor_invalid');
      if(this.#db.prepare(`SELECT a.task_id FROM attempts a JOIN manager_operation_events e ON e.event_cursor=a.queued_cancel_event_cursor
        WHERE a.queued_cancel_id IS NOT NULL AND (a.queued_cancel_operation_id IS NULL OR e.operation_id<>a.queued_cancel_operation_id
          OR e.event_type<>'cancelled_before_launch') LIMIT 1`).get())fail('queued_cancel_event_mismatch');
      const queuedCancels=this.#db.prepare('SELECT * FROM attempts WHERE queued_cancel_id IS NOT NULL ORDER BY task_id,attempt').all();
      for(const a of queuedCancels){
        const task=this.#db.prepare('SELECT current_attempt,status FROM tasks WHERE task_id=?').get(a.task_id);
        let result;try{result=JSON.parse(a.queued_cancel_result_json);}catch{fail('queued_cancel_result_invalid');}
        const requestDigest=digest({contract:'wp6a-queued-cancel-v1',task_id:a.task_id,attempt:a.attempt});
        canonicalTaskResult(result,{task_id:a.task_id,attempt:a.attempt,result_status:'cancelled'});
        if(a.status!=='cancelled'||task?.status!=='cancelled'||task.current_attempt!==a.attempt
          ||!validId(a.queued_cancel_id)||a.queued_cancel_request_digest!==requestDigest
          ||!Number.isSafeInteger(a.queued_cancel_event_cursor)||a.queued_cancel_event_cursor<1
          ||!validText(a.queued_cancelled_at,64)||Number.isNaN(Date.parse(a.queued_cancelled_at))
          ||canonical(result)!==a.queued_cancel_result_json||a.queued_cancel_result_digest!==digest(a.queued_cancel_result_json)
          ||result.task_id!==a.task_id||result.attempt!==a.attempt||result.status!=='cancelled'||result.finished_at!==a.queued_cancelled_at
          ||result.started_at!==null||result.needs_master_decision!==false)fail('queued_cancel_projection_mismatch');
        if(a.queued_cancel_operation_id===null){
          if(this.#db.prepare("SELECT operation_id FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND task_id=? AND attempt=?").get(a.task_id,a.attempt))fail('queued_cancel_operation_missing');
        }else{
          const o=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(a.queued_cancel_operation_id);
          const e=this.#db.prepare("SELECT * FROM manager_operation_events WHERE event_cursor=? AND operation_id=? AND event_type='cancelled_before_launch'").get(a.queued_cancel_event_cursor,a.queued_cancel_operation_id);
          let evidence;try{evidence=e?JSON.parse(e.evidence_json):null;}catch{fail('queued_cancel_event_mismatch');}
          if(!o||o.task_id!==a.task_id||o.attempt!==a.attempt||o.generation!==a.generation||o.phase!=='cancelled_before_launch'
            ||o.launch_id!==null||o.claim_id!==null||o.result_digest!==null||!e||e.sequence!==o.revision
            ||evidence.cancel_id!==a.queued_cancel_id||evidence.request_digest!==requestDigest)fail('queued_cancel_operation_mismatch');
        }
      }
      if(this.#db.prepare("SELECT t.task_id FROM tasks t LEFT JOIN attempts a ON a.task_id=t.task_id AND a.attempt=t.current_attempt WHERE a.task_id IS NULL").all().length)fail('task_attempt_projection_mismatch');
      const malformedContinuations=this.#db.prepare("SELECT task_id,attempt FROM attempts WHERE NOT ((continuation_operation_id IS NULL AND continuation_json IS NULL AND continuation_digest IS NULL) OR (attempt>1 AND continuation_operation_id IS NOT NULL AND continuation_json IS NOT NULL AND continuation_digest IS NOT NULL))").all();
      if(malformedContinuations.length)fail('continue_history_mismatch');
      const continuationRows=this.#db.prepare('SELECT * FROM attempts WHERE continuation_operation_id IS NOT NULL ORDER BY task_id,attempt').all();
      for(const a of continuationRows){
        let c;try{c=JSON.parse(a.continuation_json);}catch{fail('continue_history_mismatch');}
        const continuationKeys=['additional_requirements','contract','feedback','operation_id','previous_attempt','previous_claim_id','previous_generation',
          'previous_operation_id','previous_revision','previous_worker_identity_digest','task_id'];
        if(!c||Object.getPrototypeOf(c)!==Object.prototype||Object.keys(c).sort().join('|')!==continuationKeys.join('|')
          ||c.contract!=='wp6b2b-continue-v1'||canonical(c)!==a.continuation_json||a.continuation_digest!==digest(a.continuation_json)
          ||c.operation_id!==a.continuation_operation_id||c.task_id!==a.task_id||c.previous_attempt!==a.attempt-1
          ||!validId(c.operation_id)||c.operation_id!==c.operation_id.trim()||!validId(c.previous_operation_id)
          ||typeof c.feedback!=='string'||!c.feedback.trim()||c.feedback.includes('\0')
          ||!Array.isArray(c.additional_requirements)||c.additional_requirements.some(value=>typeof value!=='string')
          ||!Number.isSafeInteger(c.previous_generation)||c.previous_generation<1||!Number.isSafeInteger(c.previous_revision)||c.previous_revision<1
          ||!validId(c.previous_claim_id)||typeof c.previous_worker_identity_digest!=='string'||!/^[0-9a-f]{64}$/u.test(c.previous_worker_identity_digest))fail('continue_history_mismatch');
        const prior=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_id=? AND operation_kind='attempt_lifecycle'").get(c.previous_operation_id);
        const op=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND task_id=? AND attempt=?").get(a.task_id,a.attempt);
        const priorAttempt=this.#db.prepare('SELECT status,generation FROM attempts WHERE task_id=? AND attempt=?').get(a.task_id,c.previous_attempt);
        if(!prior||prior.task_id!==a.task_id||prior.attempt!==c.previous_attempt||prior.generation!==c.previous_generation
          ||prior.revision!==c.previous_revision||prior.claim_id!==c.previous_claim_id||prior.claim_worker_identity_digest!==c.previous_worker_identity_digest
          ||prior.phase!=='released'||!['completed','failed','waiting_for_master'].includes(prior.result_status)
          ||priorAttempt?.status!==prior.result_status)fail('continue_history_mismatch');
        const current=this.#db.prepare('SELECT current_attempt,status FROM tasks WHERE task_id=?').get(a.task_id);
        const cancelledCurrent=current?.status==='cancelled'&&a.status==='cancelled'&&a.queued_cancel_id!==null;
        if(op?(op.generation!==a.generation||a.generation===null):a.generation!==null||current?.current_attempt!==a.attempt
          ||!(current.status==='queued'&&a.status==='queued')&&!cancelledCurrent)fail('continue_history_mismatch');
      }
      if(m[0].policy_generation===0){if(m[0].policy_version!==null||m[0].capacity_limit!==null||m[0].policy_operation_id!==null)fail('policy_or_schema_mismatch');}
      else {
        const ps=this.#db.prepare("SELECT * FROM manager_operations WHERE operation_kind='capacity_policy_change' ORDER BY policy_generation").all();
        if(m[0].policy_version!==1||ps.length!==m[0].policy_generation)fail('policy_or_schema_mismatch');
        for(let i=0;i<ps.length;i++){const p=ps[i],ev=this.#db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence').all(p.operation_id);if(p.policy_generation!==i+1||!p.capacity_limit||p.capacity_limit>8||p.request_digest!==digest({operation_id:p.operation_id,capacity_limit:p.capacity_limit,expected_generation:i})||ev.length!==1||ev[0].event_type!=='capacity_policy_committed'||ev[0].generation!==null||ev[0].evidence_digest!==digest(ev[0].evidence_json))fail('policy_or_schema_mismatch');const e=JSON.parse(ev[0].evidence_json);if(e.generation!==i+1||e.capacity_limit!==p.capacity_limit)fail('policy_or_schema_mismatch');}
        const current=ps.at(-1);if(!current||current.operation_id!==m[0].policy_operation_id||current.capacity_limit!==m[0].capacity_limit)fail('policy_or_schema_mismatch');
      }
      const slots=this.#db.prepare("SELECT capacity_slot,COUNT(*) n FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase NOT IN ('released','cancelled_before_launch') GROUP BY capacity_slot HAVING COUNT(*)>1").all();
      const active=this.#db.prepare("SELECT COUNT(*) n,MAX(capacity_slot) max_slot FROM manager_operations WHERE operation_kind='attempt_lifecycle' AND phase NOT IN ('released','cancelled_before_launch')").get();
      if(slots.length||active.n>m[0].capacity_limit||active.max_slot>m[0].capacity_limit)fail('active_capacity_invariant');
      const os=this.#db.prepare('SELECT * FROM manager_operations').all();for(const o of os){
        if(o.operation_kind==='attempt_lifecycle'&&o.phase==='running'){
          const running=this.#db.prepare("SELECT t.status AS task_status,t.current_attempt,a.status AS attempt_status FROM tasks t JOIN attempts a ON a.task_id=t.task_id AND a.attempt=t.current_attempt WHERE t.task_id=? AND a.attempt=? AND a.generation=?").get(o.task_id,o.attempt,o.generation);
          if(!running||running.task_status!=='running'||running.attempt_status!=='running')fail('claim_task_projection_mismatch');
        }
        const es=this.#db.prepare('SELECT * FROM manager_operation_events WHERE operation_id=? ORDER BY sequence').all(o.operation_id);
        if(es.length!==o.revision||es.at(-1)?.to_phase!==o.phase)fail('projection_event_mismatch');
        if(o.operation_kind==='attempt_lifecycle'&&o.phase==='cancelled_before_launch'){
          const a=this.#db.prepare('SELECT status,queued_cancel_id,queued_cancel_operation_id FROM attempts WHERE task_id=? AND attempt=? AND generation=?').get(o.task_id,o.attempt,o.generation);
          const task=this.#db.prepare('SELECT current_attempt,status FROM tasks WHERE task_id=?').get(o.task_id);
          const evidence=es.at(-1)?.event_type==='cancelled_before_launch'?JSON.parse(es.at(-1).evidence_json):null;
          if(!a||a.status!=='cancelled'||!a.queued_cancel_id||a.queued_cancel_operation_id!==o.operation_id
            ||task?.current_attempt!==o.attempt||task.status!=='cancelled'||o.launch_id!==null||o.claim_id!==null||o.result_digest!==null
            ||es.length!==2||es.at(-1)?.from_phase!=='reserved'||evidence?.cancel_id!==a.queued_cancel_id)fail('queued_cancel_operation_mismatch');
        }
        const launchEvents={launch_intent:[],launch_receipt:[],claim_committed:[]};
        const cleanupEvents={cleanup_pending:[],cleanup_verified:[],cleanup_unverified:[],cleanup_reverified:[],released:[]};
        const resultEvents=[];
        const recoveryEvents=[],cancellationIntents=[],cancellationVerifications=[];
        for(let i=0;i<es.length;i++){
          const e=es[i];if(e.sequence!==i+1||e.evidence_digest!==digest(e.evidence_json)||(i===0?e.from_phase!==null:e.from_phase!==es[i-1].to_phase))fail('projection_event_mismatch');
          let parsed;try{parsed=JSON.parse(e.evidence_json);}catch{fail('invalid_evidence');}validateEvidence(e.event_type,parsed);
          if(e.event_type in launchEvents)launchEvents[e.event_type].push({event:e,evidence:parsed});
          if(e.event_type in cleanupEvents)cleanupEvents[e.event_type].push({event:e,evidence:parsed});
          if(e.event_type==='result_committed')resultEvents.push({event:e,evidence:parsed});
          if(e.event_type==='observation_recorded'&&(parsed.reason==='recovery_hold'||parsed.reason==='recovery_quarantine'))recoveryEvents.push({event:e,evidence:parsed});
          if(e.event_type==='observation_recorded'&&parsed.reason==='cancel_requested')cancellationIntents.push({event:e,evidence:parsed});
          if(e.event_type==='observation_recorded'&&parsed.reason==='cancel_tree_verified')cancellationVerifications.push({event:e,evidence:parsed});
          if(i>0&&e.from_phase!==es[i-1].to_phase)fail('projection_event_mismatch');
          if(e.event_type==='launch_receipt'&&(e.from_phase!=='launch_intent'||e.to_phase!=='launch_intent'))fail('invalid_event_phase');
          if(e.event_type==='claim_committed'&&(e.from_phase!=='launch_intent'||e.to_phase!=='running'))fail('invalid_event_phase');
          if(e.event_type==='result_committed'&&(e.from_phase!=='running'||e.to_phase!=='result_committed'))fail('invalid_event_phase');
          if(e.event_type==='cleanup_pending'&&(e.from_phase!=='result_committed'||e.to_phase!=='cleanup_pending'))fail('invalid_event_phase');
          if(e.event_type==='cleanup_verified'&&(!(e.from_phase==='cleanup_pending'||e.from_phase==='cleanup_reverified')||e.to_phase!=='cleanup_verified'))fail('invalid_event_phase');
          if(e.event_type==='cleanup_unverified'&&(e.from_phase!=='cleanup_pending'||e.to_phase!=='cleanup_unverified'))fail('invalid_event_phase');
          if(e.event_type==='cleanup_reverified'&&(e.from_phase!=='cleanup_unverified'||e.to_phase!=='cleanup_reverified'))fail('invalid_event_phase');
          if(e.event_type==='released'&&(e.from_phase!=='cleanup_verified'||e.to_phase!=='released'))fail('invalid_event_phase');
          if(e.event_type==='launch_intent'&&(e.from_phase!=='reserved'||e.to_phase!=='launch_intent'))fail('invalid_event_phase');
          if(e.event_type==='observation_recorded'&&e.from_phase!==e.to_phase)fail('invalid_event_phase');
          if(e.event_type!=='launch_receipt'&&e.event_type!=='claim_committed'&&e.event_type!=='launch_intent'&&e.event_type!=='observation_recorded'
            &&!e.event_type.startsWith('interaction_')&&EVENT_PHASE[e.event_type]!==e.to_phase)fail('invalid_event_phase');
          if(e.event_type.startsWith('interaction_')&&(e.from_phase!=='running'||e.to_phase!=='running'))fail('invalid_event_phase');
          if(o.operation_kind==='attempt_lifecycle'&&e.generation!==o.generation)fail('invalid_event_phase');
          if(o.operation_kind==='capacity_policy_change'&&(e.generation!==null||e.event_type!=='capacity_policy_committed'||e.to_phase!=='policy_change_committed'))fail('invalid_event_phase');
        }
        if(o.operation_kind==='attempt_lifecycle'){
          const intents=launchEvents.launch_intent,receipts=launchEvents.launch_receipt,claims=launchEvents.claim_committed;
          if(cancellationIntents.length>1||cancellationVerifications.length>1
            ||cancellationVerifications.length>0&&cancellationIntents.length!==1)fail('cancellation_history_unbounded');
          if(cancellationIntents.length||cancellationVerifications.length){
            if(claims.length!==1||!o.claim_id||o.claim_generation!==o.generation||!o.claim_worker_identity_json||!o.launch_identity_json)fail('cancellation_claim_missing');
            const worker=JSON.parse(o.claim_worker_identity_json),launchIdentity=JSON.parse(o.launch_identity_json);
            if(cancellationIntents.length){
              const {event,evidence}=cancellationIntents[0];
              const intent={contract:'wp6c-cancel-intent-v1',cancel_id:evidence.cancel_id,operation_id:o.operation_id,task_id:o.task_id,
                attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,worker_identity_digest:o.claim_worker_identity_digest,
                identity_state:evidence.identity_state,identity_evidence_digest:evidence.identity_evidence_digest};
              if(event.sequence<=claims[0].event.sequence||event.from_phase!=='running'||event.to_phase!=='running'
                ||evidence.claim_id!==o.claim_id||evidence.worker_identity_digest!==o.claim_worker_identity_digest
                ||evidence.evidence_digest!==digest(intent))fail('cancellation_intent_history_mismatch');
              const identityJson=canonical(worker);
              if(digest(identityJson)!==o.claim_worker_identity_digest||worker.process_id!==launchIdentity.process_id
                ||worker.start_fingerprint!==launchIdentity.start_fingerprint)fail('cancellation_identity_history_mismatch');
            }
            if(cancellationVerifications.length){
              const {event,evidence}=cancellationVerifications[0],intent=cancellationIntents[0];
              const unsigned={reason:'cancel_tree_verified',cancel_id:intent.evidence.cancel_id,claim_id:o.claim_id,
                worker_identity_digest:o.claim_worker_identity_digest,intent_event_digest:intent.event.evidence_digest,
                process_tree_digest:evidence.process_tree_digest,proof_digest:evidence.proof_digest,root_process_id:evidence.root_process_id,
                root_start_fingerprint:evidence.root_start_fingerprint,worker_tree_complete:true};
              if(event.sequence<=intent.event.sequence||event.from_phase!=='running'||event.to_phase!=='running'
                ||evidence.cancel_id!==intent.evidence.cancel_id||evidence.claim_id!==o.claim_id
                ||evidence.worker_identity_digest!==o.claim_worker_identity_digest||evidence.intent_event_digest!==intent.event.evidence_digest
                ||evidence.evidence_digest!==digest({cancel_verification_contract_version:1,...unsigned})
                ||evidence.root_process_id!==worker.process_id||evidence.root_process_id!==launchIdentity.process_id
                ||evidence.root_start_fingerprint!==worker.start_fingerprint||evidence.root_start_fingerprint!==launchIdentity.start_fingerprint)
                fail('cancellation_verification_history_mismatch');
            }
          }
          if(recoveryEvents.length>RECOVERY_LIMIT)fail('recovery_observation_limit');
          const seenRecoveryEnvelopes=new Set(),seenRecoveryRevisions=new Set();let recoveryLevel=o.phase==='quarantined'?2:0;
          for(const {event,evidence} of recoveryEvents){
            validateRecoveryEventBinding(o,event,evidence,claims[0]?.event.sequence);
            if(seenRecoveryEnvelopes.has(evidence.envelope_digest)||seenRecoveryRevisions.has(evidence.expected_revision))fail('recovery_event_duplicate');
            seenRecoveryEnvelopes.add(evidence.envelope_digest);seenRecoveryRevisions.add(evidence.expected_revision);
            const level=evidence.classification==='quarantine'?2:1;if(level<recoveryLevel)fail('recovery_classification_downgrade');recoveryLevel=level;
          }
          if(intents.length>1||receipts.length>1||claims.length>1)fail('launch_claim_history_mismatch');
          if((intents.length===0)!==(o.launch_id===null))fail('launch_claim_history_mismatch');
          if(intents.length){const i=intents[0],v=i.evidence;if(i.event.sequence<2||v.launch_id!==o.launch_id||v.launch_epoch!==o.launch_epoch||v.token_digest!==o.launch_token_digest
            ||o.launch_intent_digest!==digest({operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,launch_id:o.launch_id,launch_epoch:o.launch_epoch,token_digest:o.launch_token_digest}))fail('launch_claim_history_mismatch');}
          if((receipts.length===0)!==(o.launch_receipt_digest===null)||receipts.length!==(o.launch_identity_json===null?0:1)||receipts.length!==(o.launch_receipt_id===null?0:1))fail('launch_claim_history_mismatch');
          if(receipts.length){const r=receipts[0],v=r.evidence,identity=JSON.parse(o.launch_identity_json);if(r.event.sequence<=intents[0].event.sequence||v.launch_id!==o.launch_id||v.launch_epoch!==o.launch_epoch||v.token_digest!==o.launch_token_digest||v.receipt_digest!==o.launch_receipt_digest||o.launch_receipt_digest!==digest({receipt_id:o.launch_receipt_id,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,launch_id:o.launch_id,launch_epoch:o.launch_epoch,token_digest:o.launch_token_digest,launch_identity:identity}))fail('launch_claim_history_mismatch');fixtureLaunchIdentity(identity);}
          if((claims.length===0)!==(o.claim_id===null)||claims.length!==(o.claim_worker_identity_json===null?0:1))fail('launch_claim_history_mismatch');
          if(claims.length){const c=claims[0],v=c.evidence,worker=JSON.parse(o.claim_worker_identity_json);if(!receipts.length||c.event.sequence<=receipts[0].event.sequence||v.claim_id!==o.claim_id||v.launch_id!==o.launch_id||v.launch_epoch!==o.launch_epoch||v.token_digest!==o.launch_token_digest||v.worker_identity_digest!==o.claim_worker_identity_digest||o.claim_launch_id!==o.launch_id||o.claim_generation!==o.generation||o.claim_token_digest!==o.launch_token_digest||o.claim_worker_identity_digest!==digest(o.claim_worker_identity_json)||o.claim_request_digest!==digest({claim_id:o.claim_id,operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,launch_id:o.launch_id,launch_epoch:o.launch_epoch,token_digest:o.launch_token_digest,worker_identity:worker}))fail('launch_claim_history_mismatch');fixtureWorkerIdentity(worker);const task=this.#db.prepare('SELECT status FROM attempts WHERE task_id=? AND attempt=? AND generation=?').get(o.task_id,o.attempt,o.generation);const allowed=o.phase==='running'?task?.status==='running':['running','completed','failed','cancelled','waiting_for_master'].includes(task?.status);if(!allowed)fail('launch_claim_task_mismatch');}
          if(o.launch_id===null&&(o.launch_receipt_id!==null||o.launch_receipt_digest!==null||o.launch_identity_json!==null||o.claim_id!==null))fail('launch_claim_history_mismatch');
          if((resultEvents.length===0)!==(o.result_digest===null)||resultEvents.length!==(o.result_json===null?0:1)
            ||resultEvents.length!==(o.result_commit_ref===null?0:1)||resultEvents.length!==(o.result_status===null?0:1))fail('result_event_projection_mismatch');
          const resultConflictEvents=es.filter(e=>e.event_type==='quarantined'&&JSON.parse(e.evidence_json).reason==='result_conflict');
          if(resultConflictEvents.length>1)fail('result_conflict_quarantine_unbounded');
          if(resultEvents.length){
            const r=resultEvents[0],v=r.evidence,result=JSON.parse(o.result_json);
            if(claims.length!==1||r.event.sequence<=claims[0].event.sequence||v.claim_id!==o.claim_id||v.outcome!==o.result_status
              ||v.worker_identity_digest!==o.claim_worker_identity_digest||v.result_digest!==o.result_digest||v.result_commit_ref!==o.result_commit_ref
              ||o.result_generation!==o.generation||result.task_id!==o.task_id||result.attempt!==o.attempt||result.status!==o.result_status
              ||!RESULT_STATUSES.has(o.result_status)||o.result_digest!==digest({result_contract_version:RESULT_CONTRACT_VERSION,result_status:o.result_status,result})
              ||o.result_commit_ref!==`result-${o.result_digest}`)fail('result_event_projection_mismatch');
            const projection=this.#db.prepare('SELECT t.status AS task_status,t.current_attempt,a.status AS attempt_status FROM tasks t JOIN attempts a ON a.task_id=t.task_id WHERE t.task_id=? AND a.attempt=? AND a.generation=?').get(o.task_id,o.attempt,o.generation);
             if(projection?.current_attempt<o.attempt||projection?.attempt_status!==o.result_status
               ||projection.current_attempt===o.attempt&&projection.task_status!==o.result_status)fail('result_task_attempt_projection_mismatch');
          }
          if(resultConflictEvents.length){const q=resultConflictEvents[0],e=JSON.parse(q.evidence_json);
            if(!resultEvents.length||q.to_phase!=='quarantined'||e.claim_id!==o.claim_id||!validText(e.reason,256)
              ||!/^[0-9a-f]{64}$/u.test(e.result_digest)||!/^[0-9a-f]{64}$/u.test(e.evidence_digest)||!validText(e.result_commit_ref,128))fail('result_conflict_quarantine_mismatch');}
          const pending=cleanupEvents.cleanup_pending,verified=cleanupEvents.cleanup_verified,unverified=cleanupEvents.cleanup_unverified,
            reverified=cleanupEvents.cleanup_reverified,released=cleanupEvents.released;
          if(pending.length>1||verified.length>1||unverified.length>1||reverified.length>1||released.length>1
            ||verified.length&&unverified.length&&!reverified.length
            ||reverified.length&&(verified.length!==reverified.length||unverified.length!==reverified.length))fail('cleanup_history_unbounded');
          if((pending.length===0&&(verified.length!==0||unverified.length!==0||reverified.length!==0||released.length!==0))
            ||(pending.length===1&&resultEvents.length!==1))fail('cleanup_history_mismatch');
          if(pending.length){
            const p=pending[0],pe=p.evidence,resultEvent=resultEvents[0];
            if(!resultEvent||p.event.sequence<=resultEvent.event.sequence||pe.claim_id!==o.claim_id||pe.result_commit_ref!==o.result_commit_ref
              ||pe.worker_identity_digest!==o.claim_worker_identity_digest)fail('cleanup_pending_mismatch');
            if(unverified.length){const u=unverified[0],ue=u.evidence;
              if(u.event.sequence!==p.event.sequence+1||ue.claim_id!==o.claim_id||ue.worker_identity_digest!==o.claim_worker_identity_digest
                ||!['alive','unknown','identity_mismatch','incomplete'].includes(ue.probe_state)||!validText(ue.reason,128))fail('cleanup_unverified_mismatch');}
            if(reverified.length){const rv=reverified[0],rve=rv.evidence;
              if(unverified.length!==1||rv.event.sequence<=unverified[0].event.sequence||!Array.isArray(rve.resolved_recovery_event_digests)
                ||rve.prior_cleanup_event_digest!==unverified[0].event.evidence_digest||rve.claim_id!==o.claim_id
                ||rve.operation_id!==o.operation_id||rve.task_id!==o.task_id||rve.attempt!==o.attempt||rve.generation!==o.generation
                ||rve.worker_identity_digest!==o.claim_worker_identity_digest)fail('cleanup_reverification_history_mismatch');
              const between=es.filter(event=>event.sequence>unverified[0].event.sequence&&event.sequence<rv.event.sequence);
              const betweenRecovery=recoveryEventsFor(es,o).filter(item=>item.event.sequence>unverified[0].event.sequence&&item.event.sequence<rv.event.sequence);
              if(between.some(event=>event.event_type!=='observation_recorded')||betweenRecovery.length!==between.length)
                fail('cleanup_reverification_intervening_event_mismatch');
              const priorRecovery=recoveryEventsFor(es,o).filter(item=>item.event.sequence<rv.event.sequence);
              if(priorRecovery.some(item=>item.evidence.classification!=='hold'
                ||!['cleanup_identity_unknown','cleanup_incomplete'].includes(item.evidence.reason_code)))fail('cleanup_reverification_unrelated_hold');
              const eligible=priorRecovery
                .map(item=>item.event.evidence_digest).sort();
              if(rve.resolved_recovery_event_digests.join('|')!==eligible.join('|'))fail('cleanup_reverification_hold_set_mismatch');
            } else if(unverified.length&&verified.length)fail('cleanup_reverification_event_missing');
            if(verified.length){
              const v=verified[0],ve=v.evidence;
              const expectedVerifiedSequence=reverified.length?reverified[0].event.sequence+1:p.event.sequence+1;
              if(v.event.sequence!==expectedVerifiedSequence||ve.claim_id!==o.claim_id||ve.launch_receipt_digest!==o.launch_receipt_digest
                ||ve.result_commit_ref!==o.result_commit_ref||ve.worker_identity_digest!==o.claim_worker_identity_digest
                ||ve.workspace_touched!==false||ve.worker_tree_complete!==true||ve.operation_resources_complete!==true
                ||!['synthetic_fixture','manager_os_cleanup_verification'].includes(ve.evidence_source)
                ||!/^[0-9a-f]{64}$/u.test(ve.process_tree_digest)||!/^[0-9a-f]{64}$/u.test(ve.resources_digest))fail('cleanup_verified_mismatch');
              const worker=JSON.parse(o.claim_worker_identity_json),launchIdentity=JSON.parse(o.launch_identity_json);
              if(ve.root_process_id!==worker.process_id||ve.root_start_fingerprint!==worker.start_fingerprint
                ||ve.root_process_id!==launchIdentity.process_id||ve.root_start_fingerprint!==launchIdentity.start_fingerprint)fail('cleanup_worker_identity_mismatch');
              const normalized={operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,
                worker_identity_digest:o.claim_worker_identity_digest,launch_receipt_digest:o.launch_receipt_digest,result_commit_ref:o.result_commit_ref,
                process_tree_digest:ve.process_tree_digest,resources_digest:ve.resources_digest,root_process_id:ve.root_process_id,
                root_start_fingerprint:ve.root_start_fingerprint,worker_tree_complete:ve.worker_tree_complete,
                operation_resources_complete:ve.operation_resources_complete,workspace_touched:ve.workspace_touched,
                source:ve.evidence_source,fixture:ve.evidence_source==='synthetic_fixture'};
              if(ve.cleanup_digest!==digest({cleanup_contract_version:1,evidence:normalized}))fail('cleanup_digest_mismatch');
              if(reverified.length){const rve=reverified[0].evidence;
                const paired=['claim_id','cleanup_digest','evidence_source','launch_receipt_digest','operation_resources_complete','process_tree_digest','resources_digest',
                  'result_commit_ref','root_process_id','root_start_fingerprint','worker_identity_digest','worker_tree_complete','workspace_touched'];
                if(paired.some(key=>rve[key]!==ve[key]))fail('cleanup_reverification_evidence_mismatch');}
            }
            if(released.length){const r=released[0],re= r.evidence,ve=verified[0]?.evidence;
              if(!ve||r.event.sequence!==verified[0].event.sequence+1||re.claim_id!==o.claim_id||re.cleanup_digest!==ve.cleanup_digest
                ||re.result_commit_ref!==o.result_commit_ref||re.worker_identity_digest!==o.claim_worker_identity_digest)fail('release_history_mismatch');}
            const expected=o.phase==='quarantined'?'quarantined':released.length?'released':verified.length?'cleanup_verified':unverified.length?'cleanup_unverified':'cleanup_pending';
            if(o.phase!==expected)fail('cleanup_projection_mismatch');
          } else if(['cleanup_pending','cleanup_verified','cleanup_unverified','cleanup_reverified','released'].includes(o.phase))fail('cleanup_projection_mismatch');
          validateInteractionHistory(this.#db,o,es);
        }
      }
    } catch(e) {if(e instanceof AdmissionError)throw e;fail('database_unreadable',String(e));}
  }
}
function validateInteractionHistory(db,operation,events){
  const payloads=db.prepare('SELECT * FROM manager_interaction_payloads WHERE operation_id=? ORDER BY request_id').all(operation.operation_id);
  const interactionEvents=events.filter(event=>event.event_type.startsWith('interaction_'));
  if(payloads.length>128)fail('interaction_request_limit');
  const grouped=new Map();
  for(const event of interactionEvents){
    let evidence;try{evidence=JSON.parse(event.evidence_json);}catch{fail('interaction_history_mismatch');}
    const requestId=evidence.request_id;
    if(!validId(requestId)||event.evidence_digest!==digest(event.evidence_json))fail('interaction_history_mismatch');
    const list=grouped.get(requestId)??[];list.push({event,evidence});grouped.set(requestId,list);
  }
  const seen=new Set();
  for(const payload of payloads){
    if(!validId(payload.request_id)||seen.has(payload.request_id)||payload.task_id!==operation.task_id||payload.attempt!==operation.attempt
      ||payload.generation!==operation.generation||payload.claim_id!==operation.claim_id
      ||payload.worker_identity_digest!==operation.claim_worker_identity_digest||!operation.claim_id
      ||operation.claim_generation!==operation.generation)fail('interaction_payload_identity_mismatch');
    seen.add(payload.request_id);
    let request;try{request=JSON.parse(payload.request_json);}catch{fail('interaction_history_mismatch');}
    if(!validateInteractionRequest(request)||request.request_id!==payload.request_id||request.method!==payload.request_method
      ||interactionCanonical(request)!==payload.request_json||Buffer.byteLength(payload.request_json,'utf8')>1048576
      ||payload.request_digest!==interactionDigest({interaction_contract_version:1,operation_id:payload.operation_id,task_id:payload.task_id,
        attempt:payload.attempt,generation:payload.generation,claim_id:payload.claim_id,worker_identity_digest:payload.worker_identity_digest,request}))
      fail('interaction_history_mismatch');
    const rows=grouped.get(payload.request_id)??[];
    const requested=rows.filter(row=>row.event.event_type==='interaction_requested');
    const intents=rows.filter(row=>row.event.event_type==='interaction_reply_intent');
    const prepared=rows.filter(row=>row.event.event_type==='interaction_reply_prepared');
    const committed=rows.filter(row=>row.event.event_type==='interaction_reply_committed');
    const accepted=rows.filter(row=>row.event.event_type==='interaction_reply_accepted');
    if(requested.length!==1||intents.length>1||prepared.length>1||committed.length>1||accepted.length>1
      ||accepted.length&&!committed.length||committed.length&&!prepared.length||prepared.length&&!intents.length
      ||rows.length!==requested.length+intents.length+prepared.length+committed.length+accepted.length)fail('interaction_history_unbounded');
    const req=requested[0];
    if(req.event.sequence>operation.revision||req.evidence.claim_id!==payload.claim_id||req.evidence.request_digest!==payload.request_digest
      ||req.evidence.request_method!==payload.request_method||req.evidence.worker_identity_digest!==payload.worker_identity_digest
      ||req.event.from_phase!=='running'||req.event.to_phase!=='running'||req.event.generation!==payload.generation)fail('interaction_request_event_mismatch');
    if(intents.length){
      const intent=intents[0];let answer;
      try{answer=JSON.parse(payload.answer_json);}catch{fail('interaction_history_mismatch');}
      const answerDigest=interactionDigest({interaction_reply_contract_version:1,operation_id:payload.operation_id,task_id:payload.task_id,
        attempt:payload.attempt,generation:payload.generation,claim_id:payload.claim_id,worker_identity_digest:payload.worker_identity_digest,
        request_id:payload.request_id,answer});
      if(intent.event.sequence<=req.event.sequence||intent.evidence.claim_id!==payload.claim_id
        ||intent.evidence.worker_identity_digest!==payload.worker_identity_digest||intent.evidence.reply_id!==payload.reply_id
        ||intent.evidence.answer_digest!==payload.answer_digest||payload.answer_digest!==answerDigest
        ||interactionCanonical(answer)!==payload.answer_json||!validPersistedInteractionAnswer(request,answer))fail('interaction_reply_intent_mismatch');
      if(prepared.length){const prep=prepared[0];
        if(prep.event.sequence!==intent.event.sequence+1||prep.evidence.claim_id!==payload.claim_id
          ||prep.evidence.worker_identity_digest!==payload.worker_identity_digest||prep.evidence.reply_id!==payload.reply_id
          ||prep.evidence.answer_digest!==payload.answer_digest||!/^[0-9a-f]{64}$/u.test(prep.evidence.prepared_digest))fail('interaction_reply_prepared_mismatch');}
      if(committed.length){const commit=committed[0],prep=prepared[0];
        if(!prep||commit.event.sequence!==prep.event.sequence+1||commit.evidence.claim_id!==payload.claim_id
          ||commit.evidence.worker_identity_digest!==payload.worker_identity_digest||commit.evidence.reply_id!==payload.reply_id
          ||commit.evidence.answer_digest!==payload.answer_digest||commit.evidence.prepared_digest!==prep.evidence.prepared_digest
          ||commit.evidence.commit_digest!==interactionCommitDigest({operation_id:operation.operation_id,task_id:operation.task_id,
            attempt:operation.attempt,generation:operation.generation,claim_id:payload.claim_id,worker_identity_digest:payload.worker_identity_digest},
            {request_id:payload.request_id,reply_id:payload.reply_id,revision:commit.event.sequence,answer_digest:payload.answer_digest,
              prepared_digest:prep.evidence.prepared_digest}))fail('interaction_reply_commit_mismatch');}
      if(accepted.length){const ack=accepted[0];
        if(!committed.length||ack.event.sequence!==committed[0].event.sequence+1||ack.evidence.claim_id!==payload.claim_id
          ||ack.evidence.worker_identity_digest!==payload.worker_identity_digest||ack.evidence.reply_id!==payload.reply_id
          ||ack.evidence.answer_digest!==payload.answer_digest||ack.evidence.commit_digest!==committed[0].evidence.commit_digest
          ||!/^([0-9a-f]{64})$/u.test(ack.evidence.ack_digest))fail('interaction_reply_acceptance_mismatch');}
      else if(!['running','quarantined'].includes(operation.phase))fail('interaction_reply_outcome_unknown');
    } else if(payload.answer_json!==null||payload.answer_digest!==null||payload.reply_id!==null)fail('interaction_payload_reply_without_intent');
  }
  for(const requestId of grouped.keys())if(!seen.has(requestId))fail('interaction_event_without_payload');
  if(hasUnresolvedInteraction(events)&&!['running','quarantined'].includes(operation.phase))fail('interaction_reply_outcome_unknown');
}
function hasUnresolvedInteraction(events){
  const pending=new Set();
  for(const event of events){
    if(event.event_type!=='interaction_reply_intent'&&event.event_type!=='interaction_reply_accepted')continue;
    let evidence;try{evidence=JSON.parse(event.evidence_json);}catch{return true;}
    if(event.event_type==='interaction_reply_intent')pending.add(evidence.request_id);else pending.delete(evidence.request_id);
  }
  return pending.size>0;
}
function validateInteractionRequest(value){
  return !!value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join('|')==='method|params|request_id'
    &&validId(value.request_id)&&value.request_id.length<=512
    &&['interaction/requestPermission','interaction/requestUserInput'].includes(value.method)
    &&!!value.params&&Object.getPrototypeOf(value.params)===Object.prototype
    &&validInteractionJson(value);
}
function validInteractionJson(value){try{interactionCanonical(value);return true;}catch{return false;}}
function interactionCanonical(value,depth=0){
  if(depth>32)fail('interaction_json_too_deep');
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value)){if(value.length>256)fail('interaction_json_too_large');return `[${value.map(item=>interactionCanonical(item,depth+1)).join(',')}]`;}
  if(value&&Object.getPrototypeOf(value)===Object.prototype){const keys=Object.keys(value);if(keys.length>256||keys.some(key=>key!==key.normalize('NFC')))fail('interaction_json_invalid');
    return `{${keys.sort().map(key=>`${JSON.stringify(key)}:${interactionCanonical(value[key],depth+1)}`).join(',')}}`;}
  fail('interaction_json_invalid');
}
function interactionDigest(value){return digest(interactionCanonical(value));}
function interactionCommitDigest(binding,commit){return interactionDigest({interaction_commit_contract_version:1,operation_id:binding.operation_id,
  task_id:binding.task_id,attempt:binding.attempt,generation:binding.generation,claim_id:binding.claim_id,
  worker_identity_digest:binding.worker_identity_digest,request_id:commit.request_id,reply_id:commit.reply_id,
  revision:commit.revision,answer_digest:commit.answer_digest,prepared_digest:commit.prepared_digest});}
function validInteractionFence(value){
  return !!value&&Object.getPrototypeOf(value)===Object.prototype
    &&Object.keys(value).sort().join('|')==='attempt|claim_id|expected_revision|generation|operation_id|request|task_id|worker_identity_digest'
    &&validId(value.operation_id)&&validId(value.task_id)&&Number.isSafeInteger(value.attempt)&&value.attempt>0
    &&Number.isSafeInteger(value.generation)&&value.generation>0&&Number.isSafeInteger(value.expected_revision)&&value.expected_revision>0
    &&validId(value.claim_id)&&typeof value.worker_identity_digest==='string'&&/^[0-9a-f]{64}$/u.test(value.worker_identity_digest);
}
function validInteractionReplyInput(value){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||!['answers','decision','reason','request_id','task_id'].every(key=>Object.hasOwn(value,key)?true:['answers','reason'].includes(key))
    ||Object.keys(value).some(key=>!['task_id','request_id','decision','answers','reason'].includes(key))
    ||!validId(value.task_id)||!validId(value.request_id)||value.request_id.length>512||!['allow','deny','accept','decline'].includes(value.decision)
    ||('reason'in value&&typeof value.reason!=='string')||('answers'in value&&(!value.answers||Object.getPrototypeOf(value.answers)!==Object.prototype
      ||Object.values(value.answers).some(answer=>typeof answer!=='string'))))return false;
  return true;
}
function buildInteractionAnswer(request,input){
  const params=request.params;
  if(request.method==='interaction/requestPermission'){
    if(!['allow','deny'].includes(input.decision))fail('invalid_interaction_decision');
    if(input.decision==='allow'&&!(Array.isArray(params.options)&&params.options.some(option=>option&&Object.getPrototypeOf(option)===Object.prototype
      &&typeof option.kind==='string'&&option.kind.startsWith('allow'))))fail('interaction_allow_not_offered');
    return input.decision==='allow'?{decision:'allow'}:{decision:'deny',reason:(input.reason?.trim()||'the calling host declined this request').slice(0,2000)};
  }
  if(!['accept','decline'].includes(input.decision))fail('invalid_interaction_decision');
  if(input.decision==='decline')return {action:'decline'};
  if(params.schema&&Object.getPrototypeOf(params.schema)===Object.prototype&&params.schema.interaction==='plan_approval')return {action:'accept',content:{answer_0:'approve'}};
  const nested=params.input&&Object.getPrototypeOf(params.input)===Object.prototype?params.input:{};
  const raw=Array.isArray(params.questions)?params.questions:Array.isArray(nested.questions)?nested.questions:[];
  const questions=raw.filter(question=>question&&Object.getPrototypeOf(question)===Object.prototype&&typeof question.question==='string').map(question=>question.question);
  if(!questions.length)fail('interaction_questions_missing');
  const answers=input.answers??{};const keys=Object.keys(answers);
  if(!keys.length||keys.some(key=>!questions.includes(key)))fail('interaction_answer_question_mismatch');
  for(const [question,answer] of Object.entries(answers))if(!answer.trim()||answer.length>4000)fail('invalid_interaction_answer');
  if(Buffer.byteLength(JSON.stringify(answers),'utf8')>16000)fail('interaction_answers_too_large');
  return {action:'accept',content:{answers}};
}
function validPersistedInteractionAnswer(request,answer){
  if(!answer||Object.getPrototypeOf(answer)!==Object.prototype)return false;
  if(request.method==='interaction/requestPermission'){
    const keys=Object.keys(answer).sort().join('|');
    if(answer.decision==='allow')return keys==='decision'&&Array.isArray(request.params.options)
      &&request.params.options.some(option=>option&&Object.getPrototypeOf(option)===Object.prototype&&typeof option.kind==='string'&&option.kind.startsWith('allow'));
    return answer.decision==='deny'&&keys==='decision|reason'&&typeof answer.reason==='string'&&answer.reason.length<=2000;
  }
  if(answer.action==='decline')return Object.keys(answer).join('|')==='action';
  if(answer.action!=='accept'||Object.keys(answer).sort().join('|')!=='action|content'||!answer.content||Object.getPrototypeOf(answer.content)!==Object.prototype)return false;
  if(request.params.schema&&Object.getPrototypeOf(request.params.schema)===Object.prototype&&request.params.schema.interaction==='plan_approval')
    return Object.keys(answer.content).join('|')==='answer_0'&&answer.content.answer_0==='approve';
  if(Object.keys(answer.content).join('|')!=='answers'||!answer.content.answers||Object.getPrototypeOf(answer.content.answers)!==Object.prototype)return false;
  const nested=request.params.input&&Object.getPrototypeOf(request.params.input)===Object.prototype?request.params.input:{};
  const raw=Array.isArray(request.params.questions)?request.params.questions:Array.isArray(nested.questions)?nested.questions:[];
  const questions=raw.filter(question=>question&&Object.getPrototypeOf(question)===Object.prototype&&typeof question.question==='string').map(question=>question.question);
  const entries=Object.entries(answer.content.answers);
  return entries.length>0&&entries.every(([key,value])=>questions.includes(key)&&typeof value==='string'&&!!value.trim()&&value.length<=4000)
    &&Buffer.byteLength(JSON.stringify(answer.content.answers),'utf8')<=16000;
}
function validInteractionAcknowledgement(value){
  const keys=['ack_digest','answer_digest','attempt','claim_id','commit_digest','generation','operation_id','process_id','reply_id','request_id','revision','start_fingerprint','task_id','worker_identity_digest'];
  return Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join('|')===keys.sort().join('|')
    &&validId(value.operation_id)&&validId(value.task_id)&&validId(value.claim_id)&&validId(value.request_id)&&validId(value.reply_id)
    &&Number.isSafeInteger(value.attempt)&&value.attempt>0&&Number.isSafeInteger(value.generation)&&value.generation>0
    &&Number.isSafeInteger(value.revision)&&value.revision>0&&Number.isSafeInteger(value.process_id)&&value.process_id>0
    &&validText(value.start_fingerprint,256)&&[value.worker_identity_digest,value.answer_digest,value.commit_digest,value.ack_digest].every(item=>typeof item==='string'&&/^[0-9a-f]{64}$/u.test(item));
}
function validInteractionPreparedAcknowledgement(value){
  const keys=['ack_digest','answer_digest','attempt','claim_id','generation','operation_id','process_id','reply_id','request_id','revision','start_fingerprint','task_id','worker_identity_digest'];
  return Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join('|')===keys.sort().join('|')
    &&validId(value.operation_id)&&validId(value.task_id)&&validId(value.claim_id)&&validId(value.request_id)&&validId(value.reply_id)
    &&Number.isSafeInteger(value.attempt)&&value.attempt>0&&Number.isSafeInteger(value.generation)&&value.generation>0
    &&Number.isSafeInteger(value.revision)&&value.revision>0&&Number.isSafeInteger(value.process_id)&&value.process_id>0
    &&validText(value.start_fingerprint,256)&&[value.worker_identity_digest,value.answer_digest,value.ack_digest].every(item=>typeof item==='string'&&/^[0-9a-f]{64}$/u.test(item));
}
function validId(v){return typeof v==='string'&&v.length>0&&v.length<=128&&!/[\x00-\x1f]/u.test(v);}
function validateTaskPackage(task){
  if(!task||Object.getPrototypeOf(task)!==Object.prototype||!validId(task.task_id)||typeof task.workspace!=='string'||!task.workspace
    ||typeof task.objective!=='string'||!['requirements','allowed_paths','forbidden_paths','acceptance_criteria','test_commands'].every(k=>Array.isArray(task[k])&&task[k].every(v=>typeof v==='string'))
    ||(task.worktree_path!==undefined&&typeof task.worktree_path!=='string')
    ||(task.context!==undefined&&typeof task.context!=='string')
    ||(task.timeout_ms!==undefined&&(!Number.isSafeInteger(task.timeout_ms)||task.timeout_ms<60000||task.timeout_ms>14400000))
    ||(task.model!==undefined&&(!task.model||Object.getPrototypeOf(task.model)!==Object.prototype||typeof task.model.provider_id!=='string'||!task.model.provider_id||typeof task.model.model_id!=='string'||!task.model.model_id)))
    fail('invalid_task_package');
  const json=canonical(task);if(Buffer.byteLength(json,'utf8')>1048576)fail('task_package_too_large');
  return task;
}
export function validateWorkspace(input,validator) {
  if(typeof input!=='string'||!input.trim())fail('workspace_missing');
  if(!path.isAbsolute(input))fail('workspace_not_absolute');
  if(input.replace(/\//g,'\\').startsWith('\\\\'))fail('workspace_unsupported_path_form');
  let st,canonicalPath;try{st=statSync(input);canonicalPath=realpathSync(input);}catch{fail('workspace_unavailable');}
  if(!st.isDirectory())fail('workspace_not_directory');
  if(!validator)fail('workspace_validator_missing');
  let result;try{result=validator({requestedPath:input,canonicalPath});}catch{fail('workspace_validation_unknown');}
  if(result==='deny'||result?.state==='deny')fail('workspace_validation_denied');
  if(result!=='allow'&&result?.state!=='allow')fail('workspace_validation_unknown');
  return canonicalPath;
}
function callDecision(fn,workspace,input){if(typeof fn!=='function')fail('execution_permission_unknown');try{const r=fn({workspace,task:input});const state=r==='allow'||r?.state==='allow'?'allow':r==='deny'||r?.state==='deny'?'deny':'unknown';if(state!=='allow')return{state};if(r?.source==='trusted_local_policy')return{state,audit:{authorization_source:r.source,policy_revision:r.policy_revision,execution_profile_id:r.execution_profile_id,policy_digest:r.policy_digest}};return{state};}catch{return{state:'unknown'};}}
