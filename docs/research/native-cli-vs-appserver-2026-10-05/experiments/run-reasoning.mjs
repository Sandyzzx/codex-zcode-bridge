import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {Server,native,base,cfg,save,snapshot,denyTools} from './probe.mjs';
import {modelIO} from './summarize-model-io.mjs';
const cwd=path.join(base,'reasoning-workspace');mkdirSync(cwd,{recursive:true});
const personal=JSON.parse(readFileSync(cfg.providerPersonalConfigFile,'utf8'));const original=personal.config.defaultModelSelection;
const out=[];const prompt='Compute the sum of all prime numbers less than 30. Reply with only the integer answer. Do not use tools, delegate, modify files, or access network.';
try{for(const level of ['low','high','max'])for(const executor of ['native','app-server']){
 const r={level,executor};let s;
 try{if(executor==='native'){personal.config.defaultModelSelection={...original,options:{reasoningLevel:level}};writeFileSync(cfg.providerPersonalConfigFile,JSON.stringify(personal),{mode:0o600});r.run=await native(cwd,prompt,null,120000,['--disallowed-tools',denyTools.join(',')]);r.sid=r.run.summary?.sessionId||r.run.events[0]?.sessionId;}
 else{s=new Server(cwd);await s.init();await s.create(cwd,true);const selected=await s.request('session/setThoughtLevel',{sessionId:s.sid,thoughtLevel:level});r.selected=snapshot(selected);r.sid=s.sid;r.run=await s.run(prompt,120000);}
 r.terminal=r.run.events.findLast(e=>e.type==='turn.completed');r.correct=r.terminal?.response?.trim()==='129';r.modelIO=modelIO(r.sid);
 }catch(e){r.error=e.message;}finally{if(s)await s.finish();out.push(r);save('reasoning',out);}
 console.log(JSON.stringify({executor,level,sid:r.sid,selected:r.selected?.thought?.current,correct:r.correct,usage:r.terminal?.usage,error:r.error}));
}}finally{personal.config.defaultModelSelection=original;writeFileSync(cfg.providerPersonalConfigFile,JSON.stringify(personal),{mode:0o600});}
