// Manual acceptance only. Isolated installed Native Host; never starts a model turn.
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,renameSync,readdirSync,statSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical,MAX_TASK_RESULT_BYTES} from '../../../src/result-contract.mjs';
import {running,result} from '../../../test/sqlite-v14-fixture.mjs';
import {digest} from '../../../src/sqlite-candidate/wp6b2b1/store.mjs';
import {createPlatformProbe} from '../../../dist/src/runtime/process-probe.js';
import {terminateProcessTree} from '../../../dist/src/adapters/process-spawn.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
if(process.cwd()!==project)throw new Error('Run from the acceptance worktree root');
const args=JSON.parse(process.argv[2]??'{}');
const executable=process.env.R2_CODEX_EXE;
if(!executable||!path.isAbsolute(executable))throw new Error('Set R2_CODEX_EXE to the installed engine');
const sha=s=>createHash('sha256').update(s).digest('hex');
const base=path.join(project,'.run/acceptance');mkdirSync(base,{recursive:true});
const root=mkdtempSync(path.join(base,'host-'));
const home=path.join(root,'home'),codexHome=path.join(home,'.codex'),workspace=path.join(root,'workspace');
for(const p of [home,codexHome,workspace,path.join(root,'app'),path.join(root,'temp')])mkdirSync(p,{recursive:true});
const evidence={root,args,source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),executable,
  executable_version:execFileSync(executable,['--version'],{encoding:'utf8'}).trim(),executable_sha256:sha(readFileSync(executable)),
  no_model_turn:true,production_data_access:false,started_at:new Date().toISOString()};
let expected,db,dbBefore;
if(args.marketplace){
  const appRoot=path.join(root,'data'),data=path.join(appRoot,'state');mkdirSync(data,{recursive:true});
  const {store,fence}=running(data,'r2-host-result');
  const value=result('r2-host-result');const bytes=args.canonical_bytes??4096;
  value.zcode_output='x'.repeat(bytes-Buffer.byteLength(canonical(value)));
  store.commitResult({...fence,result_status:'completed',result:value});
  const current=()=>{const o=store.readOperation(fence.operation_id);return {...fence,revision:o.revision};};
  store.beginCleanup(current());
  const o=store.readOperation(fence.operation_id);
  const cleanup=store.recordCleanupEvidence({...current(),outcome:'verified',cleanup_evidence:{source:'synthetic_fixture',fixture:true,
    operation_id:o.operation_id,task_id:o.task_id,attempt:o.attempt,generation:o.generation,claim_id:o.claim_id,
    worker_identity_digest:o.claim_worker_identity_digest,launch_receipt_digest:o.launch_receipt_digest,result_commit_ref:o.result_commit_ref,
    process_tree_digest:digest({root:41001,start:'r2-start',children:[]}),resources_digest:digest({resources:[]}),root_process_id:41001,
    root_start_fingerprint:'r2-start',worker_tree_complete:true,operation_resources_complete:true,workspace_touched:false}});
  store.releaseCapacity({...current(),cleanup_digest:cleanup.cleanup_digest});store.close();
  renameSync(path.join(data,'operations.sqlite3'),path.join(data,'bridge.sqlite'));db=path.join(data,'bridge.sqlite');dbBefore=sha(readFileSync(db));
  const settings=path.join(codexHome,'codex-zcode-bridge');mkdirSync(settings,{recursive:true});
  writeFileSync(path.join(settings,'authority.json'),JSON.stringify({schema_version:1,authority:'sqlite',data_root:appRoot}));
  expected={canonical_bytes:bytes,canonical_sha256:sha(canonical(value))};evidence.fixture_cleanup='synthetic evidence only; no actual worker';
}else{
  const fixture=path.join(project,'docs/research/r2-final-acceptance-20261106/wire-fixture.mjs');
  const toml=JSON.stringify;
  writeFileSync(path.join(codexHome,'config.toml'),`[mcp_servers.r2_wire]\ncommand=${toml(process.execPath)}\nargs=[${toml(fixture)}]\ncwd=${toml(project)}\n[mcp_servers.r2_wire.env]\nR2_WIRE_METRICS=${toml(path.join(root,'wire-metrics.jsonl'))}\n`);
}
const env={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{CODEX_HOME:codexHome,HOME:home,USERPROFILE:home,APPDATA:path.join(root,'app'),LOCALAPPDATA:path.join(root,'app'),TEMP:path.join(root,'temp'),TMP:path.join(root,'temp')});
const child=spawn(executable,['--disable','plugin_discovery_prefetch','app-server'],{cwd:workspace,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
evidence.pid=child.pid;let sequence=0,pending=new Map(),buffer='',stderr='',discarded=false;
const protocol=path.join(root,'protocol-summary.jsonl');
function note(v){appendFileSync(protocol,JSON.stringify(v)+'\n');}
child.stderr.on('data',chunk=>{const s=String(chunk);stderr+=s;appendFileSync(path.join(root,'stderr.log'),s);
  if(stderr.includes('Incoming message exceeded the maximum line length')){discarded=true;for(const [id,p] of pending)if(p.method==='mcpServer/tool/call'){clearTimeout(p.timer);pending.delete(id);p.reject(new Error('PROBE_OBSERVED_NATIVE_LINE_DISCARD'));}}
});
child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg;try{msg=JSON.parse(line);}catch{note({invalid_json_bytes:Buffer.byteLength(line)});continue;}
  const p=pending.get(msg.id);note({id:msg.id,method:msg.method,bytes:Buffer.byteLength(line)+1,error:msg.error});
  if(p){pending.delete(msg.id);clearTimeout(p.timer);if(msg.error)p.reject(new Error(JSON.stringify(msg.error)));else p.resolve(msg.result);}
  else if(msg.id!==undefined&&msg.method)child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'Probe never grants interactive requests'}})+'\n');
}});
child.on('error',error=>{for(const p of pending.values())p.reject(error);});
function rpc(method,params,timeout=60000){const id=++sequence;note({outgoing_id:id,method});return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('PROBE_TIMEOUT '+method));},timeout);pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
let identity;
try{
  identity=await createPlatformProbe().identityOf(child.pid);evidence.process_identity=identity;
  if(!identity.fingerprint)throw new Error('Cannot bind owned Host generation');
  evidence.initialize=await rpc('initialize',{clientInfo:{name:'r2_acceptance',title:'R2 isolated acceptance',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  if(args.marketplace)evidence.install=await rpc('plugin/install',{marketplacePath:path.join(project,'.agents/plugins/marketplace.json'),pluginName:'codex-zcode-bridge'});
  const thread=await rpc('thread/start',{cwd:workspace,ephemeral:true});const threadId=thread.thread.id;
  const list=await rpc('mcpServerStatus/list',{threadId,limit:100});evidence.mcp_inventory=list;
  const servers=list.data??list.servers??[];
  const server=args.marketplace?servers.find(s=>JSON.stringify(s).includes('zcode_result')):servers.find(s=>s.name==='r2_wire');
  if(!server)throw new Error('Expected MCP server missing');
  const response=await rpc('mcpServer/tool/call',{threadId,server:server.name,tool:args.marketplace?'zcode_result':'measure_result',arguments:args.marketplace?{task_id:'r2-host-result'}:args});
  const out=response.result??response;
  evidence.response_keys=Object.keys(response);evidence.return_bytes=Buffer.byteLength(JSON.stringify(response));
  const structured=out.structuredContent,txt=out.content?.find(c=>c.type==='text')?.text;
  evidence.structured=structured?{canonical_bytes:Buffer.byteLength(canonical(structured)),sha256:sha(canonical(structured))}:null;
  evidence.text=txt?{bytes:Buffer.byteLength(txt),canonical_bytes:Buffer.byteLength(canonical(JSON.parse(txt))),sha256:sha(canonical(JSON.parse(txt)))}:null;
  if(!args.marketplace){const metrics=readFileSync(path.join(root,'wire-metrics.jsonl'),'utf8').trim().split('\n').map(JSON.parse);evidence.wire=metrics.at(-1);expected={canonical_sha256:evidence.wire.canonical_sha256};}
  evidence.expected=expected;
  const observed=[evidence.structured,evidence.text].filter(Boolean);
  if(out.isError||observed.length===0||observed.some(v=>v.sha256!==expected.canonical_sha256))throw new Error('Returned content failed full canonical digest verification');
  evidence.outcome='received_complete';
}catch(error){evidence.outcome=discarded?'native_line_discard':'probe_error';evidence.error=String(error);}
finally{
  if(db)evidence.database={before_sha256:dbBefore,after_sha256:sha(readFileSync(db)),unchanged:dbBefore===sha(readFileSync(db))};
  if(args.marketplace){
    const cache=path.join(codexHome,'plugins/cache');const found=[];
    function visit(p){for(const name of readdirSync(p)){const f=path.join(p,name);if(statSync(f).isDirectory())visit(f);else if(name==='bridge.mjs'||name==='worker-main.mjs')found.push({path:f,sha256:sha(readFileSync(f))});}}
    try{visit(cache);}catch{}evidence.cached_artifacts=found;
  }else{try{evidence.wire=readFileSync(path.join(root,'wire-metrics.jsonl'),'utf8').trim().split('\n').map(JSON.parse).at(-1);}catch{}}
  if(identity?.fingerprint){try{evidence.cleanup=await terminateProcessTree(child.pid,{expectedRootFingerprint:identity.fingerprint,killWaitMs:3000});}catch(error){evidence.cleanup_error=String(error);}}
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Probe teardown'));}pending.clear();
  evidence.finished_at=new Date().toISOString();writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({root,outcome:evidence.outcome,error:evidence.error,wire:evidence.wire,structured:evidence.structured,text:evidence.text,cleanup_verified:evidence.cleanup?.verified}));
  if(evidence.outcome==='probe_error'||!evidence.cleanup?.verified)process.exitCode=1;
}
