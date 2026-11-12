// Manual acceptance: project-owned QEMU TCG, cloud image, disks, HTTP seed, logs.
// No host installers, WSL/Hyper-V changes, services, API credentials, or production DB.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,createReadStream,createWriteStream,statSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createPlatformProbe} from '../../../dist/src/runtime/process-probe.js';
import {terminateProcessTree} from '../../../dist/src/adapters/process-spawn.js';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
if(process.cwd()!==project)throw new Error('Run from acceptance worktree root');
const assets=path.join(project,'.run/acceptance/ubuntu-assets'),root=mkdtempSync(path.join(project,'.run/acceptance/ubuntu-vm-'));
const resume=process.argv[2]==='--resume'?path.resolve(process.argv[3]):null;
const testsOnly=process.argv.includes('--tests-only');
if(resume&&(!resume.startsWith(path.join(project,'.run/acceptance/ubuntu-vm-'))||JSON.parse(readFileSync(path.join(resume,'evidence.json'))).source_commit!=='904f45770f21a423ba683cd0a91d9b1dd5fca6b8'))throw new Error('Not an owned R2 guest');
const qemu=path.join(assets,'qemu/qemu-system-x86_64.exe'),qemuImg=path.join(assets,'qemu/qemu-img.exe');
const sum=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
const files=['ubuntu.img','node-linux.tar.xz','source-904f457.tar','node-modules.tar.gz','esbuild-linux.tgz'];
const evidence={root,source_commit:'904f45770f21a423ba683cd0a91d9b1dd5fca6b8',acceleration:'TCG software emulation',memory_mib:4096,cpus:1,
 started_at:new Date().toISOString(),resume_from:resume,tests_only:testsOnly,assets:Object.fromEntries(files.map(f=>[f,{bytes:statSync(path.join(assets,f)).size,sha256:sum(path.join(assets,f))}]))};
let guestStatus;
const server=createServer(async(req,res)=>{
 const name=req.url?.slice(1);
 if(req.method==='POST'&&['log','status','bridge.mjs','worker-main.mjs','upgrade-sqlite-v14.mjs','wait-task.mjs'].includes(name)){
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
   const data=Buffer.concat(chunks);writeFileSync(path.join(root,'guest-'+name+'.txt'),data);if(name==='status')guestStatus=String(data).trim();res.end('saved');return;
 }
 if(req.method==='GET'){
   if(name==='meta-data'){res.end(`instance-id: r2-${path.basename(root)}\nlocal-hostname: r2-ubuntu\n`);return;}
   if(name==='user-data'){res.end(userData);return;}
   if(name==='bootstrap.sh'){res.end(bootstrap);return;}
   if(name==='guest.sh'){res.end(readFileSync(new URL(resume?'./ubuntu-resume.sh':'./ubuntu-guest.sh',import.meta.url)));return;}
   if(files.includes(name)&&name!=='ubuntu.img'){res.writeHead(200,{'Content-Length':statSync(path.join(assets,name)).size});createReadStream(path.join(assets,name)).pipe(res);return;}
 }
 res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://10.0.2.2:${server.address().port}/`;
const bootstrap=`#!/bin/bash
set -eu
exec > >(tee /tmp/r2-bootstrap.log) 2>&1
finish(){ code=$?; trap - EXIT; sync; curl -fsS -X POST --data-binary @/tmp/r2-bootstrap.log ${origin}log || true; curl -fsS -X POST --data "$code" ${origin}status || true; sync; poweroff; }
trap finish EXIT
mkdir -p /opt/r2-node /home/ubuntu/r2
${resume?`cd /home/ubuntu/r2
for f in bridge.mjs upgrade-sqlite-v14.mjs wait-task.mjs; do curl -fsS -X POST --data-binary @plugins/codex-zcode-bridge/dist/$f ${origin}$f; done
curl -fsS -X POST --data-binary @plugins/codex-zcode-bridge/worker/worker-main.mjs ${origin}worker-main.mjs
`:`
for f in node-linux.tar.xz source-904f457.tar node-modules.tar.gz esbuild-linux.tgz; do curl -fsS ${origin}$f -o /tmp/$f; done
tar -xJf /tmp/node-linux.tar.xz --strip-components=1 -C /opt/r2-node
tar -xf /tmp/source-904f457.tar -C /home/ubuntu/r2
tar -xzf /tmp/node-modules.tar.gz -C /home/ubuntu/r2
mkdir -p /home/ubuntu/r2/node_modules/@esbuild/linux-x64
tar -xzf /tmp/esbuild-linux.tgz --strip-components=1 -C /home/ubuntu/r2/node_modules/@esbuild/linux-x64
chmod +x /home/ubuntu/r2/node_modules/@esbuild/linux-x64/bin/esbuild /home/ubuntu/r2/node_modules/.bin/*
`}
curl -fsS ${origin}guest.sh -o /tmp/r2-guest.sh
chown -R ubuntu:ubuntu /home/ubuntu/r2
su - ubuntu -c '${testsOnly?'R2_ACCEPTANCE_TESTS_ONLY=1 ':''}bash /tmp/r2-guest.sh'
`;
const userData=`#cloud-config\nruncmd:\n  - [bash, -c, "curl -fsS ${origin}bootstrap.sh -o /tmp/r2-bootstrap.sh && bash /tmp/r2-bootstrap.sh"]\n`;
writeFileSync(path.join(root,'user-data'),userData);writeFileSync(path.join(root,'bootstrap.sh'),bootstrap);
const overlay=path.join(resume??root,'guest.qcow2');
if(!resume)execFileSync(qemuImg,['create','-f','qcow2','-F','qcow2','-b',path.join(assets,'ubuntu.img'),overlay,'12G']);
// QEMU Windows TCG showed an IO-APIC timer boot panic. Use the observed-working
// legacy PIC profile for this fixture, without changing any product test clocks.
const args=['-accel','tcg,thread=single','-machine','pc,hpet=off','-cpu','max,-apic,-x2apic','-smp','1','-m','4096','-display','none','-serial','stdio','-monitor','none','-no-reboot',
 '-drive',`file=${overlay},if=virtio,format=qcow2`,'-netdev','user,id=n0','-device','virtio-net-pci,netdev=n0',
 '-smbios',`type=1,serial=ds=nocloud-net;s=${origin}`];
evidence.qemu_args=args;writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
const child=spawn(qemu,args,{cwd:path.dirname(qemu),stdio:['ignore','pipe','pipe'],windowsHide:true});
const closed=once(child,'close');const serial=createWriteStream(path.join(root,'serial.log')),err=createWriteStream(path.join(root,'qemu-stderr.log'));
child.stdout.pipe(serial);child.stderr.pipe(err);const identity=await createPlatformProbe().identityOf(child.pid);evidence.pid=child.pid;evidence.identity=identity;
writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
let expired=false;const timer=setTimeout(async()=>{expired=true;try{evidence.cleanup=await terminateProcessTree(child.pid,{expectedRootFingerprint:identity.fingerprint,killWaitMs:3000});}catch(error){evidence.cleanup_error=String(error);}},45*60*1000);
console.log(JSON.stringify({root,pid:child.pid,origin}));
const [code,signal]=await closed;clearTimeout(timer);await new Promise(resolve=>server.close(resolve));
evidence.finished_at=new Date().toISOString();evidence.qemu_exit_code=code;evidence.signal=signal;evidence.guest_exit_code=guestStatus??null;evidence.probe_budget_expired=expired;
writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
if(code!==0||guestStatus!=='0'||expired)process.exitCode=1;
