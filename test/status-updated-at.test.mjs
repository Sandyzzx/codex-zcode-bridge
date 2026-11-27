// P2 §4.5: getStatus updated_at must reflect the latest persisted event, not
// the tail of the first 200-event page. Exercises the store-level latest-event
// read against a Task whose runtime-event history exceeds one page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,running} from './sqlite-v14-fixture.mjs';

test('the latest event time ignores the 200-event page boundary',()=>{
  const root=fixture('status-time');const {store,fence}=running(root);
  try{
    const before=store.readTaskLatestEventAt(fence.task_id);
    assert.ok(before&&typeof before.at==='string');
    const laterAt=new Date(Date.parse(before.at)+5_000).toISOString();
    for(let sequence=1;sequence<=250;sequence+=1){
      store.appendRuntimeTaskEvent({
        operation_id:fence.operation_id,task_id:fence.task_id,attempt:1,generation:fence.generation,
        claim_id:fence.claim_id,worker_sequence:sequence,event_type:sequence===250?'turn_completed':'model_output',
        at:sequence===250?laterAt:new Date(Date.parse(before.at)+sequence).toISOString(),
        summary:`progress ${sequence}`,
      });
    }
    const latest=store.readTaskLatestEventAt(fence.task_id);
    assert.equal(latest.at,laterAt,'the newest runtime event wins over earlier pages');
    const page=store.readTaskEvents(fence.task_id,{afterCursor:0,limit:200});
    assert.ok(page.events.length===200,'fixture really exceeds one page');
    assert.notEqual(page.events.at(-1).at,laterAt,'the page tail alone would report a stale time');
  }finally{store.close();}
});
