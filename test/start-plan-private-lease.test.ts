import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateCredentialLease, type PrivateLeaseBinding } from "../src/runtime/start-plan-private-lease.js";

const binding: PrivateLeaseBinding = Object.freeze({ account: "a", provider: "p", model: "m", task: "t", attempt: 1,
  operation: "o", generation: 1, claim: "c", session: "s", turn: "u", pid: 123, creation: "exact" });
const create = (): PrivateCredentialLease => new PrivateCredentialLease(binding, "synthetic-only", 200, () => 100);

test("private lease consumes once and rejects every mismatched identity field", async () => {
  for (const key of Object.keys(binding) as Array<keyof PrivateLeaseBinding>) {
    const lease = create();
    const wrong = { ...binding, [key]: typeof binding[key] === "number" ? 999 : "wrong" };
    await assert.rejects(lease.redeem(wrong, async () => true, async () => assert.fail(), new AbortController().signal));
    await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), new AbortController().signal));
  }
  const lease = create(); let count = 0;
  await lease.redeem(binding, async () => true, async (value) => { assert.equal(value, "synthetic-only"); count++; }, new AbortController().signal);
  await assert.rejects(lease.redeem(binding, async () => true, async () => { count++; }, new AbortController().signal));
  assert.equal(count, 1);
});

test("ACK loss and cancellation during write never permit retransmission", async () => {
  const lease = create(); const controller = new AbortController(); let calls = 0;
  await assert.rejects(lease.redeem(binding, async () => true, async () => { calls++; controller.abort(); throw new Error("ack lost"); }, controller.signal));
  await assert.rejects(lease.redeem(binding, async () => true, async () => { calls++; }, new AbortController().signal));
  assert.equal(calls, 1);
});

test("lease snapshots identity, rejects expired values, and serializes competing redeems", async () => {
  assert.throws(() => new PrivateCredentialLease(binding, "x", NaN), /credential_lease_invalid/);
  const original = { ...binding }; const lease = new PrivateCredentialLease(original, "x", 200, () => 100);
  original.turn = "mutated";
  let release!: (value: boolean) => void;
  const first = lease.redeem(binding, () => new Promise((resolve) => { release = resolve; }), async () => {}, new AbortController().signal);
  await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), new AbortController().signal));
  release(true); await first;
});
