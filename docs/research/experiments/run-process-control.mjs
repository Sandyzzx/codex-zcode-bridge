import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Server,base,env,cfg,save,delay,denyTools} from './probe.mjs';
const cwd=path.join(base,'process-workspace');mkdirSync(cwd,{recursive:true});
writeFileSync(path.join(cwd,'wait.cjs'),`require('node:fs').writeFileSync('child-pid.txt',String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('done.txt','done'),60000);`);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const out={};const prompt='Use Bash to run node wait.cjs in this directory, wait for it, then reply DONE. Do not modify or read any files.';
for(const executor of ['native','app-server']){
  for(const f of ['child-pid.txt','done.txt'])if(existsSync(path.join(cwd,f)))unlinkSync(path.join(cwd,f));
  let server,child,closed=false,runPromise;const r={executor};let lines='';
  if(executor==='native'){const pf=path.join(base,'process-prompt.txt');writeFileSync(pf,prompt);const loader=fileURLToPath(new URL('../../../src/adapters/zcode-loader.cjs',import.meta.url));child=spawn(cfg.nodeExecutable,[loader,cfg.zcodeEntrypoint,pf,'--cwd',cwd,'--mode','yolo','--output-format','stream-json','--disallowed-tools',denyTools.join(',')],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',s=>lines+=s);child.stderr.resume();child.on('close',code=>{closed=true;r.exitCode=code;});}
  else{server=new Server(cwd);await server.init();await server.create(cwd,true);r.sessionId=server.sid;child=server.child;runPromise=server.run(prompt,120000).catch(e=>({error:e.message}));}
  r.pid=child.pid;const start=Date.now();while(!existsSync(path.join(cwd,'child-pid.txt'))&&!closed&&Date.now()-start<60000)await delay(100);
  r.toolStarted=existsSync(path.join(cwd,'child-pid.txt'));if(r.toolStarted){r.toolPid=Number(readFileSync(path.join(cwd,'child-pid.txt'),'utf8'));r.childAliveBefore=alive(r.toolPid);const stopAt=Date.now();if(server){r.stopReply=await server.request('session/stop',{sessionId:server.sid});r.stopAckMs=Date.now()-stopAt;r.run=await runPromise;r.parentAliveAfterStop=alive(child.pid);}else{r.killResult=execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});for(let i=0;i<30&&!closed;i++)await delay(100);r.treeKillMs=Date.now()-stopAt;}
  await delay(1000);r.childAliveAfter=alive(r.toolPid);r.doneMarker=existsSync(path.join(cwd,'done.txt'));if(r.childAliveAfter){r.cleanup='owned helper child explicitly terminated after observation';execFileSync('taskkill',['/PID',String(r.toolPid),'/T','/F'],{windowsHide:true});}}
  if(server){r.parentExit=await server.finish();r.parentAliveAfterFinish=alive(child.pid);}else if(!closed)execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
  out[executor]=r;save('process-control',out);console.log(JSON.stringify({executor,sessionId:r.sessionId,toolStarted:r.toolStarted,childAliveAfter:r.childAliveAfter,parentAliveAfterStop:r.parentAliveAfterStop,stopAckMs:r.stopAckMs,treeKillMs:r.treeKillMs}));
}
