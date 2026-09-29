import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TASK_TIMEOUT_MS, resolveTaskTimeout } from "../src/runtime/task-timeout.js";

test("task timeout defaults to 60 minutes", () => {
  assert.equal(DEFAULT_TASK_TIMEOUT_MS, 60 * 60 * 1000);
  assert.equal(resolveTaskTimeout({}, {}), 60 * 60 * 1000);
});

test("task and valid user timeout overrides retain precedence", () => {
  assert.equal(resolveTaskTimeout({ timeout_ms: 90_000 }, { ZCODE_BRIDGE_TIMEOUT_MS: "120000" }), 90_000);
  assert.equal(resolveTaskTimeout({}, { ZCODE_BRIDGE_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(resolveTaskTimeout({}, { ZCODE_BRIDGE_TIMEOUT_MS: "invalid" }), 60 * 60 * 1000);
});
