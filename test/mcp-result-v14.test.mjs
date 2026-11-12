import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {canonical,MAX_TASK_RESULT_BYTES} from '../src/result-contract.mjs';
import {fixture,running,result} from './sqlite-v14-fixture.mjs';

test('maximum persisted Result survives real MCP stdio with both structuredContent and text JSON', {timeout:60000},async()=>{
  const root=fixture('mcp-result-wire');const {store,fence}=running(root);
  const value=result();value.zcode_output='x'.repeat(MAX_TASK_RESULT_BYTES-Buffer.byteLength(canonical(value)));
  store.commitResult({...fence,result_status:'completed',result:value});store.close();
  const serverEntry=path.join(root,'server.mjs');
  const project=process.cwd();
  // Real production MCP factory and SDK stdio framing, with a read-only Store
  // consumer. This fixture does not initialize a Host or inspect installed data.
  const {pathToFileURL}=await import('node:url');
  const serverUrl=pathToFileURL(path.join(project,'dist-test/src/mcp/server.js')).href;
  const storeUrl=pathToFileURL(path.join(project,'src/sqlite-candidate/wp6b2b1/store.mjs')).href;
  const sdkUrl=import.meta.resolve('@modelcontextprotocol/server/stdio');
  writeFileSync(serverEntry,`import {createBridgeServer} from ${JSON.stringify(serverUrl)};
import {IsolatedAdmissionStore} from ${JSON.stringify(storeUrl)};
import {StdioServerTransport} from ${JSON.stringify(sdkUrl)};
const store=IsolatedAdmissionStore.openForRecovery(${JSON.stringify(root)},{managedDataDirectory:true});
const manager={async getResult(taskId){return store.readTaskLifecycle(taskId).result;}};
await createBridgeServer({taskManager:manager}).connect(new StdioServerTransport());
`);
  // The SDK client defaults to a 10 MiB read buffer. Prove that this consumer
  // limit is independent of persistence; the Bridge cannot configure its Host.
  const defaultTransport=new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:project,stderr:'pipe'});
  const defaultClient=new Client({name:'r2-default-buffer',version:'1'});const consumerErrors=[];
  defaultClient.onerror=error=>consumerErrors.push(String(error));
  try{
    await defaultClient.connect(defaultTransport);
    await assert.rejects(defaultClient.callTool({name:'zcode_result',arguments:{task_id:value.task_id}},undefined,{timeout:30000}),/Connection closed/);
    assert.ok(consumerErrors.some(error=>error.includes('ReadBuffer exceeded maximum size of 10485760 bytes')),consumerErrors.join('\n'));
  }finally{await defaultClient.close();}
  const transport=new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:project,stderr:'pipe',maxBufferSize:MAX_TASK_RESULT_BYTES*2+1024*1024});
  const client=new Client({name:'r2-result-wire',version:'1'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=String(chunk);});
  try{
    await client.connect(transport);
    const response=await client.callTool({name:'zcode_result',arguments:{task_id:value.task_id}},undefined,{timeout:30000});
    assert.equal(response.isError,undefined,stderr);
    assert.equal(response.structuredContent.zcode_output,value.zcode_output);
    assert.equal(response.content[0].type,'text');
    assert.deepEqual(JSON.parse(response.content[0].text),response.structuredContent);
    console.log('R2_MCP_STDIO_RESOURCE',JSON.stringify({canonical_result_bytes:MAX_TASK_RESULT_BYTES,call_tool_result_bytes:Buffer.byteLength(JSON.stringify(response)),max_rss_kib:process.resourceUsage().maxRSS}));
  }finally{await client.close();}
});
