// Independent diagnostic consumer, not a change to the installed Codex Host.
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,MAX_TASK_RESULT_BYTES} from '../../../src/result-contract.mjs';
import {createPlatformProbe} from '../../../dist/src/runtime/process-probe.js';
import {terminateProcessTree} from '../../../dist/src/adapters/process-spawn.js';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
if(process.cwd()!==project)throw new Error('Run from worktree root');
const args=JSON.parse(process.argv[2]);
const base=path.join(project,'.run/acceptance');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'sdk-wire-'));
const metrics=path.join(root,'wire-metrics.jsonl');
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./wire-fixture.mjs',import.meta.url))],cwd:project,
  env:{...process.env,R2_WIRE_METRICS:metrics},stderr:'pipe',maxBufferSize:256*1024*1024});
transport.stderr.on('data',()=>{});
const client=new Client({name:'r2-isolated-wire-consumer',version:'1'});const errors=[];client.onerror=e=>errors.push(String(e));
const evidence={root,args,client_buffer_bytes:256*1024*1024,host_engine:false,errors};let identity;
try{
  await client.connect(transport);identity=await createPlatformProbe().identityOf(transport.pid);evidence.identity=identity;
  const start=performance.now();const response=await client.callTool({name:'measure_result',arguments:{...args,canonical_bytes:MAX_TASK_RESULT_BYTES}},undefined,{timeout:60000});
  evidence.round_trip_ms=performance.now()-start;evidence.wire=JSON.parse(readFileSync(metrics,'utf8').trim().split('\n').at(-1));
  const observed=[];
  if(response.structuredContent)observed.push(response.structuredContent);
  for(const item of response.content??[])if(item.type==='text')observed.push(JSON.parse(item.text));
  evidence.receiver_digests=observed.map(value=>{const s=canonical(value);return {bytes:Buffer.byteLength(s),sha256:createHash('sha256').update(s).digest('hex')};});
  if(response.isError||observed.length!==(args.form==='both'?2:1)||evidence.receiver_digests.some(v=>v.bytes!==MAX_TASK_RESULT_BYTES||v.sha256!==evidence.wire.canonical_sha256))throw Error('Full response digest mismatch');
  evidence.received_complete=true;evidence.client_max_rss_kib=process.resourceUsage().maxRSS;
}catch(error){evidence.error=String(error);process.exitCode=1;}
finally{
  if(transport.pid&&identity?.fingerprint){try{evidence.cleanup=await terminateProcessTree(transport.pid,{expectedRootFingerprint:identity.fingerprint,killWaitMs:3000});}catch(error){evidence.cleanup_error=String(error);process.exitCode=1;}}
  // Wait for the SDK's close handler to clear its owned child; no PID-only fallback.
  const limit=Date.now()+5000;while(transport.pid&&Date.now()<limit)await new Promise(r=>setTimeout(r,20));
  if(transport.pid){evidence.close_pending=true;process.exitCode=1;}else await client.close();
  writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}
