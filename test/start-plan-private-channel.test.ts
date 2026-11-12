import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { PrivateCredentialLease, type PrivateLeaseBinding } from "../src/runtime/start-plan-private-lease.js";
import { receivePrivateCredential, servePrivateCredential } from "../src/runtime/start-plan-private-channel.js";

const binding: PrivateLeaseBinding = Object.freeze({ account: "a", provider: "p", model: "m", task: "t", attempt: 1,
  operation: "o", generation: 1, claim: "c", session: "s", turn: "u", pid: 123, creation: "exact" });

test("dedicated channels deliver one credential only after identity verification and ACK", async () => {
  const request = new PassThrough(), response = new PassThrough(), acknowledgement = new PassThrough();
  const controller = new AbortController();
  const lease = new PrivateCredentialLease(binding, "SYNTHETIC_UNIQUE_MARKER", Date.now() + 20_000);
  let verified = 0;
  const served = servePrivateCredential({ request, response, acknowledgement, signal: controller.signal, timeoutMs: 5000,
    resolveLease: async () => ({ lease, binding, verifyWorker: async (actual) => { verified++; return actual.pid === binding.pid; } }) });
  const received = await receivePrivateCredential({ request, response, acknowledgement, binding, signal: controller.signal, timeoutMs: 5000 });
  assert.equal(received.jwt, "SYNTHETIC_UNIQUE_MARKER");
  assert.equal(await served, "acknowledged");
  assert.equal(verified, 1);
  await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), controller.signal));
});

test("wrong worker cannot receive credential and error cannot echo it", async () => {
  const request = new PassThrough(), response = new PassThrough(), acknowledgement = new PassThrough();
  const controller = new AbortController();
  const lease = new PrivateCredentialLease(binding, "SYNTHETIC_UNIQUE_MARKER", Date.now() + 20_000);
  const served = servePrivateCredential({ request, response, acknowledgement, signal: controller.signal, timeoutMs: 5000,
    resolveLease: async () => ({ lease, binding, verifyWorker: async () => false }) });
  const received = receivePrivateCredential({ request, response, acknowledgement, binding, signal: controller.signal, timeoutMs: 5000 });
  const results = await Promise.allSettled([served, received]);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(JSON.stringify(results).includes("SYNTHETIC_UNIQUE_MARKER"), false);
  await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), controller.signal));
});
