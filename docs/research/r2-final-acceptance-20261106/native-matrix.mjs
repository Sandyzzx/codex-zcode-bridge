import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
const cases=[];
for(const form of ['structured','text'])for(const wire_target of [16777215,16777216,16777217,16777218])cases.push({form,unit:'ascii',canonical_bytes:1024,wire_target});
for(const form of ['structured','text','both'])for(const unit of ['ascii','nul'])cases.push({form,unit,canonical_bytes:33554432});
const results=[];
for(const args of cases){const child=spawn(process.execPath,['docs/research/r2-final-acceptance-20261106/native-host-probe.mjs',JSON.stringify(args)],{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=String(c));child.stderr.on('data',c=>stderr+=String(c));const [code]=await once(child,'close');results.push({args,code,stdout,stderr});writeFileSync('.run/acceptance/native-matrix-summary.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)));if(code)process.exitCode=1;}
