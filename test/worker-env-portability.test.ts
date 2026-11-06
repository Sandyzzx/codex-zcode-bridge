import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnClaimOnlyWorker} from "../src/manager/spawn-worker.js";

for(const browser of [false,true])test(`SQLite production Spawner forwards browser configuration=${browser} and filters unrelated secrets`,{timeout:15000},async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"sqlite-worker-env-"));
  const worker=path.join(root,"probe.mjs");
  writeFileSync(worker,`import {writeSync} from 'node:fs';writeSync(6,JSON.stringify({browser:process.env.ZCODE_BRIDGE_BROWSER_USE??null,executable:process.env.ZCODE_BRIDGE_BROWSER_EXECUTABLE??null,secret:process.env.ZCODE_BRIDGE_SECRET_PROBE??null,unrelated:process.env.BRIDGE_TEST_UNRELATED_SECRET??null,provenance:JSON.parse(process.env.ZCODE_BRIDGE_RUNTIME_PROVENANCE),marker:process.argv.includes('--zcode-bridge-launch-v1')})+'\\n');`);
  const before={...process.env};
  let child:ReturnType<typeof spawnClaimOnlyWorker>;
  const provenance={bridge:{path:null,sha256:null},worker:{path:worker,sha256:null}};
  try{
    process.env.ZCODE_BRIDGE_SECRET_PROBE="secret";process.env.BRIDGE_TEST_UNRELATED_SECRET="secret";
    delete process.env.ZCODE_BRIDGE_BROWSER_USE;delete process.env.ZCODE_BRIDGE_BROWSER_EXECUTABLE;
    if(browser){process.env.ZCODE_BRIDGE_BROWSER_USE="headless";process.env.ZCODE_BRIDGE_BROWSER_EXECUTABLE=process.execPath;}
    child=spawnClaimOnlyWorker(worker,provenance);
  }finally{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);}
  const closed=once(child,"close");
  try{
    const chunks:Buffer[]=[];for await(const chunk of child.resultChannel!)chunks.push(Buffer.from(chunk));
    const [code]=await closed;assert.equal(code,0);
    const receipt=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(receipt.browser,browser?"headless":null);assert.equal(receipt.executable,browser?process.execPath:null);
    assert.equal(receipt.secret,null);assert.equal(receipt.unrelated,null);assert.deepEqual(receipt.provenance,provenance);assert.equal(receipt.marker,true);
  }finally{await closed;rmSync(root,{recursive:true,force:true});}
});
