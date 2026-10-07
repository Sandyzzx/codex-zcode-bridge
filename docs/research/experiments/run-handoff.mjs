import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Server,native,base,env,cfg,save,snapshot,delay,denyTools,hash} from './probe.mjs';
const cwd=path.join(base,'handoff-workspace');mkdirSync(cwd,{recursive:true});
const out={date:'2026-10-05',mode:'yolo',model:'GLM-5.3-Flash',reasoning:'low'};
const file=path.join(cwd,'handoff.txt');
const terminal=x=>x.events.findLast(e=>e.type==='turn.completed');
const snap=x=>({...snapshot(x),messages:x.messages?.map(m=>({id:m.info?.id,role:m.info?.role,hash:hash(m)}))});
const tryRequest=async(s,m,p)=>{try{return await s.request(m,p);}catch(e){return {error:e.message};}};
writeFileSync(file,'ALPHA_731\nstage=one\n');
out.A={};out.A.native=await native(cwd,'Use Read to read handoff.txt. Remember its first line for the next turn. Reply only that first line. Do not modify files or use other tools.',null);
out.A.sid=out.A.native.summary?.sessionId||out.A.native.events[0]?.sessionId;
let s=new Server(cwd);
try{await s.init();out.A.list=await tryRequest(s,'session/list',{sessionIds:[out.A.sid]});out.A.coldRead=await tryRequest(s,'session/read',{sessionId:out.A.sid});out.A.resumed=snap(await s.resume(out.A.sid,cwd));
out.A.usageBefore=await tryRequest(s,'session/usage',{sessionId:out.A.sid});
out.A.continue=await s.run('State the remembered first line from the previous turn. Then use Edit to replace stage=one with stage=two in handoff.txt without reading the file again. Do not use Bash.');out.A.after=snap(await s.request('session/read',{sessionId:out.A.sid}));out.A.fileAfter=readFileSync(file,'utf8');out.A.usageAfter=await tryRequest(s,'session/usage',{sessionId:out.A.sid});}
catch(e){out.A.error=e.message;}finally{await s.finish();}save('handoff',out);
writeFileSync(file,'BETA_842\nstage=one\n');out.B={};s=new Server(cwd);
try{await s.init();out.B.created=snap(await s.create(cwd));out.B.sid=s.sid;out.B.first=await s.run('Use Read to read handoff.txt. Remember its first line for the next turn. Reply only that first line. Do not modify files or use other tools.');out.B.before=snap(await s.request('session/read',{sessionId:s.sid}));out.B.stop=await s.request('session/stop',{sessionId:s.sid});out.B.close=await s.request('session/close',{sessionId:s.sid});out.B.listAfterClose=await tryRequest(s,'session/list',{sessionIds:[s.sid]});}
catch(e){out.B.error=e.message;}finally{await s.finish();}
if(out.B.sid){out.B.native=await native(cwd,'State the remembered first line from the previous turn. Then use Edit to replace stage=one with stage=two in handoff.txt without reading the file again. Do not use Bash.',out.B.sid);out.B.fileAfter=readFileSync(file,'utf8');s=new Server(cwd);try{await s.init();out.B.after=snap(await s.resume(out.B.sid,cwd));}catch(e){out.B.afterError=e.message;}finally{await s.finish();}}save('handoff',out);
// C: observe an owned disposable Native session. Never cold-resume it live.
out.C={resumeStatus:'NOT RUN — safety stop: no cross-process ownership lease found; resume rehydrates a second runtime'};
writeFileSync(path.join(cwd,'wait.cjs'),`require('node:fs').writeFileSync('running-marker.txt','started');setTimeout(()=>{require('node:fs').writeFileSync('finished-marker.txt','finished');},15000);`);
const pf=path.join(base,'concurrent-prompt.txt');writeFileSync(pf,'Use Bash to run node wait.cjs in the current directory and wait for it to finish. Do not modify or read files. Then reply DONE.');
const loader=fileURLToPath(new URL('../../../src/adapters/zcode-loader.cjs',import.meta.url));
const c=spawn(cfg.nodeExecutable,[loader,cfg.zcodeEntrypoint,pf,'--cwd',cwd,'--mode','yolo','--output-format','stream-json','--disallowed-tools',denyTools.join(',')],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
out.C.pid=c.pid;let sid,raw='',buf='',closed=false;c.stderr.resume();c.stdout.setEncoding('utf8');c.stdout.on('data',chunk=>{raw+=chunk;buf+=chunk;let i;while((i=buf.indexOf('\n'))>=0){let x;try{x=JSON.parse(buf.slice(0,i));}catch{}buf=buf.slice(i+1);if(x?.sessionId)sid=x.sessionId;}});c.on('close',code=>{closed=true;out.C.exitCode=code;});
try{const start=Date.now();while(!closed&&!existsSync(path.join(cwd,'running-marker.txt'))&&Date.now()-start<120000)await delay(100);out.C.sid=sid;out.C.runningConfirmed=!closed&&existsSync(path.join(cwd,'running-marker.txt'));if(out.C.runningConfirmed&&sid){s=new Server(cwd);try{await s.init();out.C.list=await tryRequest(s,'session/list',{sessionIds:[sid]});out.C.read=await tryRequest(s,'session/read',{sessionId:sid});out.C.stopForeign=await tryRequest(s,'session/stop',{sessionId:sid});}finally{await s.finish();}}
const end=Date.now()+120000;while(!closed&&Date.now()<end)await delay(100);out.C.finishedMarker=existsSync(path.join(cwd,'finished-marker.txt'));out.C.nativeCompleted=raw.includes('"type":"turn.completed"');}
finally{if(!closed)execFileSync('taskkill',['/PID',String(c.pid),'/T','/F'],{windowsHide:true});save('handoff',out);}
console.log(JSON.stringify({A:{sid:out.A.sid,reply:terminal(out.A.continue||{events:[]})?.response,file:out.A.fileAfter,error:out.A.error},B:{sid:out.B.sid,reply:terminal(out.B.native||{events:[]})?.response,file:out.B.fileAfter,error:out.B.error},C:out.C},null,2));
