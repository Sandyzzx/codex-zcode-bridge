import { Socket } from 'node:net';
import { writeSync } from 'node:fs';
import { sameScope } from './lease.mjs';
writeSync(3,JSON.stringify({ready:true,pid:process.pid})+'\n');
const pipe=new Socket({fd:3,readable:true,writable:true});
let bytes=0,buffer='',accepted=false;
const timer=setTimeout(()=>{pipe.destroy();process.exitCode=2;},30000);
pipe.on('data',chunk=>{
  bytes+=chunk.length;
  if(bytes>16384){pipe.destroy();process.exitCode=2;return;}
  buffer+=chunk.toString('utf8');
  const end=buffer.indexOf('\n');if(end<0)return;
  try {
    const packet=JSON.parse(buffer.slice(0,end));buffer='';
    if(accepted||Date.now()>=packet.expiresAt||!sameScope(packet.scope,expected))throw Error('rejected');
    accepted=true;
    // Synthetic material stays local and is never echoed. Production would
    // install a lease checked again at each runtime-header callback.
    if(packet.jwt!=='SYNTHETIC_ONLY')throw Error('synthetic_only');
    packet.jwt=null;
    pipe.end(JSON.stringify({accepted:true,scope:packet.scope})+'\n');
  }catch{pipe.destroy();process.exitCode=2;}
});
pipe.on('close',()=>clearTimeout(timer));
pipe.on('error',()=>{process.exitCode=2;});
const expected={account:'fixture-account',provider:'account:bigmodel-start-plan',model:'GLM-5.3-Flash',task:'fixture',attempt:1,session:'fixture-session',turn:'fixture-turn'};
