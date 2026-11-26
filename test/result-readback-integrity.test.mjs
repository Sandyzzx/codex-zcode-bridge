// P1 §3.4A Result Readback integrity (2026-11-24): bounded pages over the
// exact stored canonical Result JSON. Concatenating every page's data must
// reproduce the stored bytes whose SHA-256 is result_content_digest; it is
// distinct from the Result-envelope result_digest. Offsets land on UTF-8
// codepoint boundaries via
// next_offset; out-of-range and uncommitted reads fail explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../src/result-contract.mjs';
import {digest} from '../src/sqlite-candidate/wp6b2b1/store.mjs';
import {fixture,running,result} from './sqlite-v14-fixture.mjs';

test('paged reads reproduce the stored canonical bytes and digest exactly',()=>{
  const root=fixture('result-paging');const {store,fence}=running(root);
  try{
    const value=result();
    value.zcode_output='摘要😀'.repeat(400)+'tail';
    value.summary='paged readback 中文 summary';
    const committed=store.commitResult({...fence,result_status:'completed',result:value});
    const storedCanonical=canonical(value);
    const expectedDigest=digest({result_contract_version:1,result_status:'completed',result:value});
    assert.equal(committed.result_digest,expectedDigest);
    let seenContentDigest=null;
    let offset=0;let concatenated='';
    for(;;){
      const page=store.readTaskResultPage(fence.task_id,offset,1024);
      assert.equal(Number.isInteger(page.offset_bytes),true);
      assert.equal(typeof page.data,'string');
      concatenated+=page.data;
      if(page.next_offset===null)break;
      assert.ok(page.next_offset>offset,'next_offset must advance');
      offset=page.next_offset;
      seenContentDigest=page.result_content_digest;
    }
    assert.equal(concatenated,storedCanonical,'page data must reproduce the stored canonical JSON');
    assert.equal(createHash('sha256').update(concatenated,'utf8').digest('hex'),
      createHash('sha256').update(Buffer.from(storedCanonical,'utf8')).digest('hex'));
    assert.equal(seenContentDigest,
      createHash('sha256').update(Buffer.from(storedCanonical,'utf8')).digest('hex'));
    assert.notEqual(seenContentDigest,committed.result_digest);
  }finally{store.close();}
});

test('codepoint boundaries survive mid-multibyte slicing and the final page closes cleanly',()=>{
  const root=fixture('result-paging-boundary');const {store,fence}=running(root);
  try{
    const value=result();
    value.zcode_output='😀'.repeat(1200);
    store.commitResult({...fence,result_status:'completed',result:value});
    const total=store.readTaskResultPage(fence.task_id,0,1_048_576);
    // Force a small page that must split inside a 4-byte emoji.
    const first=store.readTaskResultPage(fence.task_id,0,1027);
    assert.ok(first.next_offset!==null,'a split must leave a next page');
    const second=store.readTaskResultPage(fence.task_id,first.next_offset,1_048_576);
    assert.equal(second.next_offset,null);
    assert.equal(Buffer.byteLength(first.data+second.data,'utf8'),total.total_bytes,
      'concatenated pages must cover every stored byte');
  }finally{store.close();}
});

test('out-of-range offsets and oversized page requests fail explicitly',()=>{
  const root=fixture('result-paging-invalid');const {store,fence}=running(root);
  try{
    const value=result();value.summary='invalid paging';
    store.commitResult({...fence,result_status:'completed',result:value});
    const total=store.readTaskResultPage(fence.task_id,0,1_048_576);
    assert.throws(()=>store.readTaskResultPage(fence.task_id,total.total_bytes+1,1024),
      error=>error.code==='invalid_result_page_offset');
    assert.throws(()=>store.readTaskResultPage(fence.task_id,0,4_194_305),
      error=>error.code==='invalid_result_page_read');
    assert.throws(()=>store.readTaskResultPage(fence.task_id,-1,1024),
      error=>error.code==='invalid_result_page_read');
  }finally{store.close();}
});

test('a task without a committed Result has no page to read',()=>{
  const root=fixture('result-paging-uncommitted');const {store}=running(root);
  try{
    assert.throws(()=>store.readTaskResultPage('result-v14',0,1024),
      error=>error.code==='result_not_committed');
  }finally{store.close();}
});
