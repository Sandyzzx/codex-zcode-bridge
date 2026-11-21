import assert from "node:assert/strict";
import test from "node:test";
import { waitForAttentionSnapshot } from "../src/attention/wait.js";
import type { TaskAttentionSnapshot } from "../src/interfaces.js";

const running=(attempt=1,pending:string[]=[]):TaskAttentionSnapshot=>({task_id:"task_1",attempt,status:"running",pending_requests:pending});
async function wait(snapshots:TaskAttentionSnapshot[]) {
  let time=0,index=0;
  return waitForAttentionSnapshot({read:async()=>snapshots[Math.min(index++,snapshots.length-1)]!,timeoutMs:350,now:()=>time,sleep:async ms=>{time+=ms;}});
}
test("attention wait wakes only on a current pending request, terminal status, changed Attempt or deadline",async()=>{
  const interaction=await wait([running(),running(),running(1,["request-1"])]);
  assert.equal(interaction.reason,"interaction");assert.deepEqual(interaction.snapshot,running(1,["request-1"]));
  assert.equal((await wait([{...running(2),status:"completed"}])).reason,"terminal");
  assert.equal((await wait([running(),{...running(2),status:"queued"}])).reason,"attempt_changed");
  const timeout=await wait([running()]);assert.equal(timeout.reason,"timeout");assert.equal(timeout.elapsed_ms,350);
});
test("attention read failures propagate without fabricating empty success",async()=>{
  let reads=0;
  await assert.rejects(waitForAttentionSnapshot({timeoutMs:350,read:async()=>{if(++reads===1)return running();throw new Error("interaction_reply_outcome_unknown");},sleep:async()=>{}}),/interaction_reply_outcome_unknown/);
});
test("attention returns the exact interaction or terminal payload without waiting",async()=>{
  const pending={...running(1,["request-1"]),status:"running" as const};
  const interaction=await waitForAttentionSnapshot({read:async()=>pending,timeoutMs:0});
  assert.equal(interaction.reason,"interaction");
  assert.deepEqual(interaction.snapshot,pending);
  const terminal={...running(2),status:"completed" as const};
  const completed=await waitForAttentionSnapshot({read:async()=>terminal,timeoutMs:0});
  assert.equal(completed.reason,"terminal");
  assert.deepEqual(completed.snapshot,terminal);
});
