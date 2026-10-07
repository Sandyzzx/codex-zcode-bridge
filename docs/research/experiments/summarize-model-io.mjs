// Allowlisted digest of this audit's owned model-I/O files. Never export headers,
// raw requests, reasoning text, prompts, or unrelated sessions.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const base=process.env.AUDIT_ROOT||'C:/Users/Sandy/.codex/tmp/zcode-executor-audit-20261005';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export function modelIO(sid){
 const candidates=[path.join(base,'private-runtime','.zcode','cli','rollout',`model-io-${sid}.jsonl`),path.join(base,'private-runtime','.zcode','cli','cli','rollout',`model-io-${sid}.jsonl`),path.join('C:/Users/Sandy/.zcode/cli/rollout',`model-io-${sid}.jsonl`)];
 const f=candidates.find(x=>existsSync(x));if(!f)return {available:false,reason:'owned model-I/O file not found, possibly rotated'};
 const records=[];for(const line of readFileSync(f,'utf8').split('\n')){if(!line.trim())continue;let x;try{x=JSON.parse(line);}catch{continue;}if(x.sessionId!==sid)continue;const b=x.request?.body||{};const msgs=x.request?.messages||[];
 records.push({sessionId:sid,traceId:x.traceId,turnId:x.turnId,requestId:x.requestId,attempt:x.attempt,querySource:x.querySource,model:x.model,
  bodyKeys:Object.keys(b),modelInBody:b.model,thinking:b.thinking,outputConfig:b.output_config,maxTokens:b.max_tokens,
  systemHash:b.system?hash(b.system):null,systemLength:b.system?JSON.stringify(b.system).length:null,
  systemSegmentDigests:Array.isArray(b.system)?b.system.map(s=>({type:s.type,hash:hash(s.text||''),length:s.text?.length||0})):null,
  toolsHash:b.tools?hash(b.tools):null,toolNames:x.request?.toolNames||null,messageCount:x.request?.messageCount,
  messagesKind:x.request?.messagesKind,messageOffset:x.request?.messageOffset,
  messageDigests:msgs.map(m=>({role:m.role,hash:hash(m.content),length:JSON.stringify(m.content)?.length||0})),usage:x.response?.usage||null});}
 return {available:true,records};
}
if(process.argv[2]){const value=modelIO(process.argv[2]);if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(value,null,2));else console.log(JSON.stringify(value,null,2));}
