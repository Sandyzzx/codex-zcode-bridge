import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const start=process.hrtime.bigint();const log=(event,extra={})=>console.log(JSON.stringify({ms:Number(process.hrtime.bigint()-start)/1e6,event,...extra}));
const child=spawn(process.execPath,[fileURLToPath(new URL('./pipe-min-child.mjs',import.meta.url))],{stdio:['ignore','ignore','pipe','pipe'],windowsHide:true});log('spawn',{pid:child.pid});
child.stderr.on('data',d=>log('stderr',{text:d.toString()}));
child.stdio[3].on('data',d=>{log('pipe_read',{text:d.toString()});child.stdio[3].write('ack\n',()=>log('pipe_write_done'));});
child.on('exit',(code,signal)=>log('exit',{code,signal}));child.on('close',(code,signal)=>log('close',{code,signal}));
setTimeout(()=>{log('deadline');child.stdio[3].destroy();if(child.exitCode===null)child.kill();},5000).unref();
