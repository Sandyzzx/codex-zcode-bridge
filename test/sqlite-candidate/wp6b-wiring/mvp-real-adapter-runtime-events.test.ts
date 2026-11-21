import assert from "node:assert/strict";
import { test } from "node:test";

import { createBoundedRuntimeEventPublisher } from "../../../src/worker/worker-main.js";

test("Runtime Event publisher latches synchronous send failures and rejects close", async () => {
  let senderClosed = false;
  const publisher = createBoundedRuntimeEventPublisher({
    send() { throw new Error("synthetic synchronous validation failure"); },
    async close() { senderClosed = true; },
  });
  publisher.publish({ type: "session_ready", summary: "synthetic session ready" });
  await assert.rejects(publisher.close(), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "code" in error);
    assert.equal((error as { readonly code?: unknown }).code, "runtime_event_publish_failed");
    return true;
  });
  assert.equal(senderClosed, true);
});
