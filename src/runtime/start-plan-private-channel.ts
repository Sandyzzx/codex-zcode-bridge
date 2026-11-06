import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { readPrivateFrame, writePrivateFrame } from "./start-plan-private-frame.js";
import { PrivateCredentialLease, type PrivateLeaseBinding } from "./start-plan-private-lease.js";

const maximum = 16_384;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("private_auth_invalid");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new Error("private_auth_invalid");
}
function boundedSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; close(): void } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("private_auth_invalid");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, timeoutMs); timer.unref();
  return { signal: controller.signal, close() { clearTimeout(timer); parent.removeEventListener("abort", abort); } };
}

/** Manager side. The trusted resolver establishes live entitlement and the
 * exact expected binding before returning an unconsumed lease; Task input must
 * never be able to provide that lease or self-assert entitlement. */
export async function servePrivateCredential(options: {
  request: Readable; response: Writable; acknowledgement: Readable;
  signal: AbortSignal; timeoutMs: number;
  resolveLease: (request: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<{
    lease: PrivateCredentialLease; binding: PrivateLeaseBinding;
    verifyWorker: (binding: Readonly<PrivateLeaseBinding>) => Promise<boolean>;
  }>;
}): Promise<"acknowledged"> {
  const bounded = boundedSignal(options.signal, options.timeoutMs);
  let lease: PrivateCredentialLease | undefined;
  try {
    const request = record(await readPrivateFrame(options.request, maximum, bounded.signal));
    exactKeys(request, ["protocol", "requestId", "binding"]);
    if (request.protocol !== "start-plan-private-request-v1" || typeof request.requestId !== "string" || !request.requestId) throw new Error("private_auth_invalid");
    const resolved = await new Promise<Awaited<ReturnType<typeof options.resolveLease>>>((resolve, reject) => {
      const abort = (): void => { cleanup(); reject(new Error("private_auth_cancelled")); };
      const cleanup = (): void => bounded.signal.removeEventListener("abort", abort);
      bounded.signal.addEventListener("abort", abort, { once: true });
      if (bounded.signal.aborted) { abort(); return; }
      void Promise.resolve().then(() => options.resolveLease(Object.freeze({ ...request }), bounded.signal)).then((value) => {
        if (bounded.signal.aborted) { value.lease.revoke(); return; }
        cleanup(); resolve(value);
      }, () => { cleanup(); reject(new Error("private_auth_unavailable")); });
    });
    lease = resolved.lease;
    await lease.redeem(request.binding as PrivateLeaseBinding, resolved.verifyWorker, async (jwt, expiresAt) => {
      await writePrivateFrame(options.response, { protocol: "start-plan-private-response-v1", requestId: request.requestId,
        binding: resolved.binding, jwt, expiresAt }, maximum, bounded.signal);
      const ack = record(await readPrivateFrame(options.acknowledgement, maximum, bounded.signal));
      exactKeys(ack, ["protocol", "requestId"]);
      if (ack.protocol !== "start-plan-private-ack-v1" || ack.requestId !== request.requestId) throw new Error("private_auth_ack_invalid");
    }, bounded.signal);
    return "acknowledged";
  } catch {
    lease?.revoke();
    throw new Error("private_auth_delivery_failed");
  } finally {
    bounded.close();
    options.request.destroy(); options.response.destroy(); options.acknowledgement.destroy();
  }
}

/** Worker side: all three streams are dedicated inherited endpoints. The
 * response stays in this process; the caller must clear its lease on abort or
 * child/parent exit. No returned material may enter an event or error. */
export async function receivePrivateCredential(options: {
  request: Writable; response: Readable | (() => Readable); acknowledgement: Writable;
  binding: PrivateLeaseBinding; signal: AbortSignal; timeoutMs: number; now?: () => number;
}): Promise<{ jwt: string; expiresAt: number }> {
  const bounded = boundedSignal(options.signal, options.timeoutMs);
  const requestId = randomUUID();
  let responseStream: Readable | undefined;
  try {
    await writePrivateFrame(options.request, { protocol: "start-plan-private-request-v1", requestId, binding: options.binding }, maximum, bounded.signal);
    responseStream = typeof options.response === "function" ? options.response() : options.response;
    const response = record(await readPrivateFrame(responseStream, maximum, bounded.signal));
    exactKeys(response, ["protocol", "requestId", "binding", "jwt", "expiresAt"]);
    const binding = record(response.binding);
    const keys = ["account", "provider", "model", "task", "attempt", "operation", "generation", "claim", "session", "turn", "pid", "creation"] as const;
    exactKeys(binding, keys);
    const now = (options.now ?? Date.now)();
    if (response.protocol !== "start-plan-private-response-v1" || response.requestId !== requestId
      || keys.some((key) => binding[key] !== options.binding[key]) || typeof response.jwt !== "string" || !response.jwt
      || typeof response.expiresAt !== "number" || !Number.isFinite(response.expiresAt) || !Number.isFinite(now)
      || response.expiresAt <= now || bounded.signal.aborted) throw new Error("private_auth_invalid");
    await writePrivateFrame(options.acknowledgement, { protocol: "start-plan-private-ack-v1", requestId }, maximum, bounded.signal);
    if (bounded.signal.aborted) throw new Error("private_auth_invalid");
    return { jwt: response.jwt, expiresAt: response.expiresAt };
  } catch {
    throw new Error("private_auth_receive_failed");
  } finally {
    bounded.close();
    options.request.destroy(); responseStream?.destroy(); options.acknowledgement.destroy();
  }
}
