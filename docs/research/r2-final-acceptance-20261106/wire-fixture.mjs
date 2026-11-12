// Diagnostic tools only. Production zcode_result and its envelope are unchanged.
import {McpServer} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical,MAX_TASK_RESULT_BYTES} from '../../../src/result-contract.mjs';

const forms=['both','structured','text'];
const records=new Map();let lastRequestId;
let input='';process.stdin.on('data',chunk=>{
  input+=chunk.toString();let end;
  while((end=input.indexOf('\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);try{const msg=JSON.parse(line);if(msg.method==='tools/call')lastRequestId=msg.id;}catch{}}
});
const hash=value=>createHash('sha256').update(value).digest('hex');
const basic=()=>({task_id:'r2-native-wire',attempt:1,status:'completed',summary:'完整字段诊断',files_changed:[],tests:[],issues:[],needs_master_decision:false,zcode_output:'',exit_code:0,session_id:null,started_at:null,finished_at:null});
function envelope(value,form){
  if(form==='structured')return {content:[],structuredContent:value};
  if(form==='text')return {content:[{type:'text',text:JSON.stringify(value,null,2)}]};
  return {content:[{type:'text',text:JSON.stringify(value,null,2)}],structuredContent:value};
}
const server=new McpServer({name:'r2-native-wire-fixture',version:'1'});
server.registerTool('measure_result',{inputSchema:z.object({form:z.enum(forms),canonical_bytes:z.number().int().min(1024).max(MAX_TASK_RESULT_BYTES),unit:z.enum(['ascii','nul','array']).default('ascii'),wire_target:z.number().int().min(1024).optional()})},async(args,extra)=>{
  const value=basic();const overhead=Buffer.byteLength(canonical(value));
  const unit=args.unit==='nul'?'\u0000':'x',unitBytes=args.unit==='nul'?6:1;
  const copies=Math.floor((args.canonical_bytes-overhead)/unitBytes);
  value.zcode_output=unit.repeat(copies)+'x'.repeat(args.canonical_bytes-overhead-copies*unitBytes);
  if(args.unit==='array'){
    value.zcode_output='';
    const count=Math.floor((args.canonical_bytes-overhead+1)/3);
    value.files_changed=Array(count).fill('');
    value.zcode_output='x'.repeat(args.canonical_bytes-Buffer.byteLength(canonical(value)));
  }
  records.set(extra.requestId??lastRequestId,{...args,value,created_at:Date.now()});
  return envelope(value,args.form);
});
const transport=new StdioServerTransport();const send=transport.send.bind(transport);
transport.send=async message=>{
  const record=records.get(message.id);
  if(record&&message.result){
    if(record.wire_target){
      record.value.zcode_output='';message.result=envelope(record.value,record.form);
      const baseBytes=Buffer.byteLength(JSON.stringify(message))+1;
      const multiplier=record.form==='both'?2:1;
      const count=(record.wire_target-baseBytes)/multiplier;
      if(!Number.isInteger(count)||count<0)throw new Error('Cannot represent requested wire size');
      record.value.zcode_output='x'.repeat(count);message.result=envelope(record.value,record.form);
    }
    const json=JSON.stringify(message)+'\n';const resultJson=canonical(record.value);
    const proof={request_id:message.id,form:record.form,unit:record.unit,canonical_bytes:Buffer.byteLength(resultJson),canonical_sha256:hash(resultJson),wire_bytes:Buffer.byteLength(json),wire_sha256:hash(json),requested_wire_target:record.wire_target??null,
      encoding_ms:Date.now()-record.created_at,rss_bytes:process.memoryUsage().rss,max_rss_kib:process.resourceUsage().maxRSS};
    appendFileSync(process.env.R2_WIRE_METRICS,JSON.stringify(proof)+'\n');
    records.delete(message.id);
  }
  return send(message);
};
await server.connect(transport);
