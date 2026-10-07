import {mkdirSync,existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {Server,native,base,save,snapshot,denyTools,delay} from './probe.mjs';
import {modelIO} from './summarize-model-io.mjs';
const out={};const permissionDir=path.join(base,'permission-workspace');mkdirSync(permissionDir,{recursive:true});
const prompt='Use Write exactly once to create approval.txt containing APPROVED_TEST. Do not use Bash or Edit, do not retry denied tools. If permission is denied, report DENIED. Otherwise reply DONE.';
// Native build mode: ordinary ask decisions reach a deny broker.
out.nativeBuild=await native(permissionDir,prompt,null,120000,['--mode','build','--disallowed-tools',denyTools.join(',')]);
// Duplicate --mode flags are rejected by some parsers; handle explicitly below.
if(out.nativeBuild.events.length===0){out.nativeBuild.errorNote='Duplicate mode option probe failed; see corrected invocation below';}
const s=new Server(permissionDir);try{
 await s.init();out.appCreated=snapshot(await s.create(permissionDir,true));await s.request('session/setMode',{sessionId:s.sid,mode:'build'});
 const original=s.handle.bind(s);s.handle=m=>{
  if(m.method==='interaction/requestPermission'&&m.id!==undefined){const p=m.params||{};const f=p.input?.file_path||p.input?.filePath||p.input?.path;const allowed=p.toolName==='Write'&&typeof f==='string'&&path.resolve(permissionDir,f)===path.join(permissionDir,'approval.txt');s.interactions.push({method:m.method,tool:p.toolName,path:f,decision:allowed?'allow':'deny',authorizedScope:'requested permission roundtrip experiment, owned approval.txt only'});s.write({id:m.id,result:{decision:allowed?'allow':'deny',reason:allowed?'User-authorized isolated permission experiment':'Outside experiment scope'}});return;}original(m);};
 out.appBuild=await s.run(prompt,120000);out.appInteractions=s.interactions;out.appFile=existsSync(path.join(permissionDir,'approval.txt'))?readFileSync(path.join(permissionDir,'approval.txt'),'utf8'):null;
}catch(e){out.appError=e.message;}finally{await s.finish();}save('policy',out);
const memoryDir=path.join(base,'memory-workspace');mkdirSync(memoryDir,{recursive:true});
const memoryPrompt='For this disposable project, remember the agreed convention: session files use UTC timestamps. Reply ACK only. Do not use tools or modify project files.';
out.nativeMemory=await native(memoryDir,memoryPrompt,null,180000,['--memory-bench','--disallowed-tools',denyTools.join(',')]);
out.nativeMemory.sid=out.nativeMemory.summary?.sessionId||out.nativeMemory.events[0]?.sessionId;out.nativeMemory.modelIO=modelIO(out.nativeMemory.sid);
const t=new Server(memoryDir);try{const original=t.handle.bind(t);t.handle=m=>{if(m.method==='session/requestRuntimePreferences'&&m.id!==undefined){t.write({id:m.id,result:{nativeSearchEnhancementsEnabled:false,memoryEnabled:true,askUserQuestionAutoResolutionEnabled:false}});return;}original(m);};await t.init();out.appMemoryCreated=snapshot(await t.create(memoryDir,true));out.appMemory=await t.run(memoryPrompt,120000);await delay(8000);out.appMemoryClose=await t.request('session/close',{sessionId:t.sid}).catch(e=>({error:e.message}));out.appMemoryIO=modelIO(t.sid);
}catch(e){out.appMemoryError=e.message;}finally{await t.finish();save('policy',out);}
console.log(JSON.stringify({nativeBuild:out.nativeBuild.exit,nativeBuildTools:out.nativeBuild.events.filter(e=>e.tool).map(e=>e.tool),appRequests:out.appInteractions?.filter(x=>x.method==='interaction/requestPermission'),appFile:out.appFile,nativeMemoryCalls:out.nativeMemory.modelIO,appMemoryCalls:out.appMemoryIO},null,2));
