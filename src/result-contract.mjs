// ADR-026: canonical Result bytes, report semantics and bounded private envelope.
export const MAX_TASK_RESULT_BYTES=32*1024*1024;
export const MAX_RESULT_ENVELOPE_BYTES=256*1024;
export const MAX_WORKER_RESULT_FRAME_BYTES=MAX_TASK_RESULT_BYTES+MAX_RESULT_ENVELOPE_BYTES;
export class ResultContractError extends Error { constructor(code,message=code){super(message);this.code=code;} }
const fail=(code,message=code)=>{throw new ResultContractError(code,message);};
const RESULT_STATUSES=new Set(['completed','failed','cancelled','waiting_for_master']);
const RESULT_FIELDS = new Set(['task_id','attempt','status','summary','files_changed','tests','issues','needs_master_decision','zcode_output','exit_code','session_id','started_at','finished_at','error_code','report_candidate','usage','model','timing']);
const REQUIRED_RESULT_FIELDS = ['task_id','attempt','status','summary','files_changed','tests','issues','needs_master_decision','zcode_output','exit_code','session_id','started_at','finished_at'];
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  throw new ResultContractError('invalid_json_value');
}

// Report data are JSON text, not filesystem arguments. Metadata keeps its own bounds.
export function isStringArray(value) { return Array.isArray(value) && value.every(x=>typeof x==='string'); }
export function validateTestReport(value) {
  if(!value || Object.getPrototypeOf(value)!==Object.prototype)return {ok:false,error:'entry is not an object'};
  if(typeof value.command!=='string')return {ok:false,error:'command must be a string'};
  if(!['passed','failed','not_run'].includes(value.status))return {ok:false,error:'status must be one of passed|failed|not_run'};
  if(value.details!==undefined && typeof value.details!=='string')return {ok:false,error:'details must be a string when present'};
  return {ok:true,test:{command:value.command,status:value.status,...(value.details===undefined?{}:{details:value.details})}};
}
export function validateReportFields(value,partial=false) {
  if(!value || Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_result_payload','report is not a JSON object');
  for(const key of ['summary','files_changed','tests','issues','needs_master_decision']){
    if(partial && !Object.hasOwn(value,key))continue;
    const v=value[key];
    if(key==='tests'){
      if(!Array.isArray(v))fail('invalid_result_payload','report.tests must be an array');
      for(const entry of v){const parsed=validateTestReport(entry);if(!parsed.ok)fail('invalid_result_payload',`report.tests entry invalid: ${parsed.error}`);}
    }else if(key==='summary' ? typeof v!=='string' : key==='needs_master_decision' ? typeof v!=='boolean' : !isStringArray(v)){
      fail('invalid_result_payload',`report.${key} must be ${key==='summary'?'a string':key==='needs_master_decision'?'a boolean':'an array of strings'}`);
    }
  }
}
export function validateAgentReport(value) {
  try { validateReportFields(value); } catch(error) { return {ok:false,error:error.message}; }
  if(!value.summary.trim())return {ok:false,error:'report.summary must be a non-empty string'};
  return {ok:true,report:{summary:value.summary,files_changed:value.files_changed,tests:value.tests.map(x=>validateTestReport(x).test),issues:value.issues,needs_master_decision:value.needs_master_decision}};
}
export function submissionFailure(result, error) {
  const code=error?.code==='result_too_large'?'result_too_large':'invalid_result_payload';
  const summary=code==='result_too_large'?error.message:`Result schema invalid (${String(error?.message??'invalid_result_payload').slice(0,512)}); original report not committed`;
  return {task_id:result.task_id,attempt:result.attempt,status:'failed',summary,files_changed:[],tests:[],issues:[summary],
    needs_master_decision:true,zcode_output:'',exit_code:null,session_id:null,started_at:null,finished_at:new Date().toISOString(),error_code:code};
}
export function assertWorkerResultEnvelope(frame) {
  const bytes=Buffer.byteLength(canonical({...frame,result:null}),'utf8')-4;
  if(bytes>MAX_RESULT_ENVELOPE_BYTES)throw new ResultContractError('result_envelope_too_large',`Worker Result envelope ${bytes} bytes exceeds ${MAX_RESULT_ENVELOPE_BYTES}`);
}
export function prepareWorkerResultFrameParts(frame) {
  assertWorkerResultEnvelope(frame);
  let resultJson;
  try { resultJson=canonicalTaskResult(frame.result,{task_id:frame.task_id,attempt:frame.attempt,result_status:frame.result?.status}); }
  catch(error) {
    const result=submissionFailure({task_id:frame.task_id,attempt:frame.attempt},error);
    resultJson=canonicalTaskResult(result,{task_id:frame.task_id,attempt:frame.attempt,result_status:'failed'});
  }
  // Reuse the encoded result: never stringify it as a nested JSON string and
  // never allocate another serialization of the large report for the envelope.
  const parts=['{'];
  for(const key of Object.keys(frame).sort()){
    if(parts.length>1)parts.push(',');
    parts.push(JSON.stringify(key),':',key==='result'?resultJson:canonical(frame[key]));
  }
  parts.push('}');
  const bytes=parts.reduce((sum,part)=>sum+Buffer.byteLength(part,'utf8'),0);
  if(bytes-Buffer.byteLength(resultJson,'utf8')>MAX_RESULT_ENVELOPE_BYTES||bytes>MAX_WORKER_RESULT_FRAME_BYTES)
    throw new ResultContractError('result_envelope_too_large', 'Worker Result envelope exceeds 256 KiB allowance');
  return parts;
}
export function prepareWorkerResultFrame(frame) { return prepareWorkerResultFrameParts(frame).join(''); }
function validText(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f]/u.test(value);}
function isNullableText(value,max=4096){return value===null||(typeof value==='string'&&value.length<=max&&!/[\x00-\x1f]/u.test(value));}
function validateStringArray(value,maxItems=256){if(!Array.isArray(value)||value.length>maxItems||value.some(x=>typeof x!=='string'||x.length>4096||/[\x00-\x1f]/u.test(x)))fail('invalid_result_payload');}
function validateResultObject(value,keys,required=[]){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_result_payload');
  const own=Object.keys(value);if(own.some(k=>!keys.has(k))||required.some(k=>!Object.hasOwn(value,k)))fail('invalid_result_payload');
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
export function canonicalTaskResult(result,input){
  validateResultObject(result,RESULT_FIELDS,REQUIRED_RESULT_FIELDS);
  if(result.task_id!==input.task_id||result.attempt!==input.attempt||result.status!==input.result_status||!RESULT_STATUSES.has(result.status)
    ||typeof result.summary!=='string'||typeof result.zcode_output!=='string'||typeof result.needs_master_decision!=='boolean'
    ||(result.exit_code!==null&&!Number.isSafeInteger(result.exit_code))||!isNullableText(result.session_id)
    ||!isNullableText(result.started_at,64)||!isNullableText(result.finished_at,64))fail('invalid_result_payload');
  validateReportFields(result);
  if(Object.hasOwn(result,'error_code')&&!validText(result.error_code,128))fail('invalid_result_payload');
  if(Object.hasOwn(result,'report_candidate')){
    validateResultObject(result.report_candidate,new Set(['summary','files_changed','tests','issues','needs_master_decision']));
    validateReportFields(result.report_candidate, true);
  }
  if(Object.hasOwn(result,'usage')&&result.usage!==null)validateUsage(result.usage);
  if(Object.hasOwn(result,'model')&&result.model!==null)validateModel(result.model);
  if(Object.hasOwn(result,'timing')&&result.timing!==null)validateTiming(result.timing);
  const json=canonical(result);
  const bytes=Buffer.byteLength(json,'utf8');
  if(bytes>MAX_TASK_RESULT_BYTES)throw new ResultContractError('result_too_large', `canonical TaskResult ${bytes} bytes exceeds ${MAX_TASK_RESULT_BYTES}; original report not committed`);
  return json;
}
