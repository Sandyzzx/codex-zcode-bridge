// Research only. No production executor changes. Requires npm run build:core.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { NodeRuntimeResolver, loadPersistedRuntimeEnvironment } from '../../../dist/src/runtime/resolver.js';
import { buildAccountProviderPayload, runtimeAuthReply, zcodeDataBaseDir } from '../../../dist/src/runtime/account-provider.js';
const base = process.env.AUDIT_ROOT || 'C:/Users/Sandy/.codex/tmp/zcode-executor-audit-20261005';
mkdirSync(base, {recursive:true});
const realCfg = await new NodeRuntimeResolver().resolve();
// Private, reversible credential materialization using official encryption.
// Never modify the user's provider configs or credential store.
const privateDir=path.join(base,'private-runtime');mkdirSync(path.join(privateDir,'.zcode','v2'),{recursive:true});
const cfg={...realCfg,providerBuiltinConfigFile:path.join(privateDir,'zcode-builtin.json'),providerPersonalConfigFile:path.join(privateDir,'.zcode','v2','provider_config.json')};
copyFileSync(realCfg.providerBuiltinConfigFile,cfg.providerBuiltinConfigFile);
copyFileSync(realCfg.providerPersonalConfigFile,cfg.providerPersonalConfigFile);
const personal=JSON.parse(readFileSync(cfg.providerPersonalConfigFile,'utf8'));
personal.config.defaultModelSelection={providerId:'account:bigmodel-individual-coding-plan',modelId:'GLM-5.3-Flash',options:{reasoningLevel:'low'}};
writeFileSync(cfg.providerPersonalConfigFile,JSON.stringify(personal),{mode:0o600});
const cipherModule=path.join(base,'official/apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts');
const {createZCodeCredentialCipher}=await import(pathToFileURL(cipherModule).href);
const cipher=createZCodeCredentialCipher();
const auth=runtimeAuthReply('account:bigmodel-individual-coding-plan',realCfg);
if(!auth.requestAuth?.apiKey)throw new Error('No authorized coding-plan credential available');
const identity='key-'+createHash('sha256').update(auth.requestAuth.apiKey).digest('hex').slice(0,24);
const providerId='account:bigmodel-individual-coding-plan';
writeFileSync(path.join(privateDir,'.zcode','v2','credentials.json'),JSON.stringify({
  [`account-provider:${providerId}:identity`]:cipher.encrypt(identity),
  [`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`]:cipher.encrypt(auth.requestAuth.apiKey)
}),{mode:0o600});
const persisted = loadPersistedRuntimeEnvironment(process.env);
const env = {...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:cfg.providerBuiltinConfigFile,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:cfg.providerPersonalConfigFile,
  ZCODE_DATA_BASE_DIR:privateDir,ZCODE_STORAGE_DIR:path.join(privateDir,'.zcode','cli'),
  ZCODE_SESSION_DB_PATH:path.join(privateDir,'.zcode','cli','db','sessions.db')};
delete env.ZCODE_HOME;
const model = {providerId:'account:bigmodel-individual-coding-plan',modelId:'GLM-5.3-Flash',options:{reasoningLevel:'low'}};
const denyTools=['Agent','AskUserQuestion','CronCreate','CronDelete','CronList','CronUpdate','EnterPlanMode','ExitPlanMode','Skill','TaskOutput','TaskStop','TodoRead','TodoWrite','WebFetch','WebSearch','SendMessage','ReadSessionContext','CreateWorkflow','AmendWorkflow','SaveWorkflow','EvalWorkflowSnippet','ListWorkflowRuns','GetWorkflowRun','ResumeWorkflowRun','ResolveWorkflowQuestion','ListSavedWorkflows','ListModels','mcp__node_repl__js'];
const hash = x => createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const save = (name, x) => writeFileSync(path.join(base,name+'.json'),JSON.stringify(x,null,2)+'\n');
const delay = ms => new Promise(r=>setTimeout(r,ms));
function snapshot(x) {
  return {session:x?.session, runtime:x?.runtime,
    model:x?.settings?.model?.current, modelSelection:x?.settings?.model?.selection,
    thought:x?.settings?.thoughtLevel, mode:x?.settings?.mode,
    workspace:x?.workspace, messageCount:x?.messages?.length,
    messageShapes:x?.messages?.map(m=>({id:m.id,role:m.role,kind:m.kind,keys:Object.keys(m)})),
    topKeys:Object.keys(x||{}),settingsKeys:Object.keys(x?.settings||{})};
}
function eventSafe(e) {
  const p=e.payload||{};
  const tool=p.toolName||p.name||p.tool?.name;
  return {type:e.type,seq:e.seq,sessionId:e.sessionId,turnId:e.turnId,
    at:new Date().toISOString(),payloadKeys:Object.keys(p),tool,
    toolCallId:p.toolCallId||p.callId,resultType:p.resultType,usage:p.usage,
    response:p.response,workflowCount:p.workflowCount,
    providerId:p.providerId,modelId:p.modelId,toolCount:p.toolCount,iteration:p.iteration,
    requestId:p.requestId,traceId:p.traceId,attempt:p.attempt,modelCall:p.modelCall,
    requestType:p.type,toolCallCount:p.toolCallCount,historyRoundCount:p.historyRoundCount,
    contextUsageBreakdown:p.contextUsageBreakdown,duration:p.duration,
    interruptedToolCount:p.interruptedToolCount,messageCount:p.messageCount,partCount:p.partCount,
    kind:p.kind};
}
export class Server {
  constructor(cwd) {
    this.events=[];this.calls=[];this.interactions=[];this.pending=new Map();this.id=0;this.errorText='';
    this.child=spawn(cfg.nodeExecutable,[cfg.zcodeEntrypoint,'app-server','--stdio'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.closed=false;let buffer='';
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',s=>{this.errorText+=s;});
    this.child.stdout.on('data',s=>{buffer+=s;let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);let m;try{m=JSON.parse(line);}catch{continue;}this.handle(m);}});
    this.child.on('close',(code,signal)=>{this.closed=true;this.exit={code,signal};for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('server exited'));}this.pending.clear();});
  }
  write(m){if(!this.closed)this.child.stdin.write(JSON.stringify(m)+'\n');}
  handle(m){
    if(m.method==='session/event'){this.events.push(eventSafe(m.params));return;}
    if(m.method && m.id!==undefined){
      this.interactions.push({method:m.method,at:new Date().toISOString(),paramKeys:Object.keys(m.params||{})});
      if(m.method==='session/requestRuntimePreferences')this.write({id:m.id,result:{nativeSearchEnhancementsEnabled:false,memoryEnabled:false,askUserQuestionAutoResolutionEnabled:false}});
      else if(m.method==='interaction/requestProviderRuntimeHeaders')this.write({id:m.id,result:runtimeAuthReply(m.params?.modelSelection?.providerId||m.params?.providerId,realCfg)});
      else this.write({id:m.id,error:{code:-32601,message:'Research host does not approve unexpected interactions'}});
      return;
    }
    const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
  }
  request(method,params={}) {
    this.calls.push({method,at:new Date().toISOString()});const id=++this.id;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('RPC timeout '+method));},30000);this.pending.set(id,{resolve,reject,timer});this.write({id,method,params});});
  }
  async init(){const payload=buildAccountProviderPayload(realCfg);if(payload){const a=buildAccountProviderPayload(cfg);payload.basedOnZCodeBuiltinRevision=a.basedOnZCodeBuiltinRevision;this.sync=await this.request('provider/updateAccountConfig',payload);}this.capabilities=await this.request('runtime/capabilities').catch(e=>({error:e.message}));}
  async create(cwd,normalized=false){const s=await this.request('session/create',{workspace:{workspacePath:cwd,workspaceKey:cwd},mode:'yolo',persistence:'immediate',...(normalized?{toolDenylist:denyTools,titleGenerationEnabled:false}: {})});this.sid=s.session.sessionId;return this.request('session/setModel',{sessionId:this.sid,model,persistAsWorkspaceLastUsed:false});}
  async resume(sid,cwd){const x=await this.request('session/resume',{sessionId:sid,workspace:{workspacePath:cwd,workspaceKey:cwd}});this.sid=sid;return x;}
  async run(prompt,timeout=300000){
    const start=Date.now();await this.request('session/subscribe',{sessionId:this.sid,deliveryKind:'desktop-continuous',includeSnapshot:false});
    const from=this.events.length;await this.request('session/send',{sessionId:this.sid,content:prompt});
    while(Date.now()-start<timeout){const end=this.events.slice(from).find(e=>['turn.completed','turn.failed'].includes(e.type));if(end){await delay(1500);return {wallTimeMs:Date.now()-start,terminal:end,events:this.events.slice(from)};}if(this.closed)throw new Error('server exited');await delay(200);}
    await this.request('session/stop',{sessionId:this.sid}).catch(()=>{});throw new Error('turn timeout');
  }
  async finish(){this.child.stdin.end();for(let i=0;i<40&&!this.closed;i++)await delay(100);if(!this.closed)execFileSync('taskkill',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true});return this.exit;}
}
export async function native(cwd,prompt,sid,timeout=300000,extra=[]){
  // Prompt is a synthetic experiment, never credentials. Keep out of argv.
  const pf=path.join(base,'prompt-'+Date.now()+'.txt');writeFileSync(pf,prompt);
  const loader=fileURLToPath(new URL('../../../src/adapters/zcode-loader.cjs',import.meta.url));
  const args=[loader,cfg.zcodeEntrypoint,pf,'--cwd',cwd,'--mode','yolo','--output-format','stream-json',...extra];
  // An explicit experiment mode replaces the default rather than duplicating it.
  const modeAt=extra.indexOf('--mode');
  if(modeAt>=0){args[args.indexOf('--mode')+1]=extra[modeAt+1];args.splice(args.lastIndexOf('--mode'),2);}
  if(sid)args.push('--resume',sid);
  const start=Date.now();const child=spawn(cfg.nodeExecutable,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
  const exit=await new Promise((r,j)=>{const timer=setTimeout(()=>{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});},timeout);child.on('error',j);child.on('close',(code,signal)=>{clearTimeout(timer);r({code,signal});});});
  const parsed=[];for(const line of stdout.split('\n')){try{parsed.push(JSON.parse(line));}catch{}}
  return {executor:'native',wallTimeMs:Date.now()-start,pid:child.pid,exit,
    events:parsed.filter(x=>x.type&&x.type!=='result').map(eventSafe),summary:parsed.findLast(x=>!x.type||x.type==='result'),
    stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr),stderrHash:hash(stderr),
    // Safe diagnostics only, no raw log persistence.
    error:stderr.split('\n').filter(l=>/Error|Unsupported|Unknown|not found|unavailable|No model|No provider|login|required|must be/.test(l)).map(l=>l.slice(0,300)).slice(0,5)};
}
export {base,env,cfg,model,save,snapshot,hash,delay,denyTools};
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const cwd=path.join(base,'smoke-workspace');mkdirSync(cwd,{recursive:true});
  const s=new Server(cwd);let out={runtimeVersion:'0.16.9',model,executor:'smoke'};
  try{await s.init();const created=await s.create(cwd);out.created=snapshot(created);out.sid=s.sid;out.capabilities=s.capabilities;out.seed=await s.run('Reply exactly AUDIT_FLASH_SEED. Do not use tools or modify files.');out.seedAfter=snapshot(await s.request('session/read',{sessionId:s.sid}));await s.finish();
    out.native=await native(cwd,'Reply exactly AUDIT_FLASH_SMOKE. Do not use tools or modify files.',s.sid);
    const t=new Server(cwd);try{await t.init();out.resumed=snapshot(await t.resume(s.sid,cwd));out.app=await t.run('Reply exactly AUDIT_FLASH_CONTINUED. Do not use tools or modify files.');out.after=snapshot(await t.request('session/read',{sessionId:s.sid}));}finally{await t.finish();}
  }catch(e){out.error=e.message;await s.finish();}save('smoke-isolated',out);console.log(JSON.stringify({sid:out.sid,model:out.created?.model,nativeExit:out.native?.exit,nativeError:out.native?.error,nativeSummary:out.native?.summary,appUsage:out.app?.terminal?.usage,error:out.error},null,2));
}
