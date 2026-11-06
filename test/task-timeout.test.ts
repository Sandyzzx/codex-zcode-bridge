import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TASK_TIMEOUT_MS, MAX_TASK_TIMEOUT_MS, ADAPTER_CLEANUP_TIMEOUT_MS, RESULT_DELIVERY_GRACE_MS, resolveTaskTimeout, resultWaitBudgetMs } from "../src/runtime/task-timeout.js";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { BridgeError } from "../src/runtime/errors.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";

test("task timeout defaults to 60 minutes", () => {
  assert.equal(DEFAULT_TASK_TIMEOUT_MS, 60 * 60 * 1000);
  assert.equal(resolveTaskTimeout({}, {}), 60 * 60 * 1000);
});

test("four-hour execution remains live past one hour, then aborts even a blocked resolver", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const budget = MAX_TASK_TIMEOUT_MS;
  assert.equal(resultWaitBudgetMs(budget), budget + ADAPTER_CLEANUP_TIMEOUT_MS + RESULT_DELIVERY_GRACE_MS);
  const adapter = new ZCodeAppServerAdapter({ childEnvBase: {}, resolver: { resolve: () => new Promise<ZCodeRuntimeConfig>(() => {}) } });
  const task: TaskPackage = {task_id:"long-budget",workspace:process.cwd(),objective:"controlled-clock deadline",requirements:[],allowed_paths:[],forbidden_paths:[],acceptance_criteria:[],test_commands:[],timeout_ms:budget};
  const handle = await adapter.startTask({task,attempt:1,workspace:{requestedPath:process.cwd(),canonicalPath:process.cwd(),mode:"direct"}});
  let settled = false;
  const result = adapter.getResult(handle); void result.then(()=>{settled=true;},()=>{settled=true;});
  t.mock.timers.tick(60*60_000 + 30_000); await Promise.resolve();
  assert.equal(settled,false);
  t.mock.timers.tick(budget - (60*60_000 + 30_000) - 1); await Promise.resolve();
  assert.equal(settled,false);
  t.mock.timers.tick(1);
  await assert.rejects(result, (error: unknown) => error instanceof BridgeError && error.code === "timeout");
});

test("task and valid user timeout overrides retain precedence", () => {
  assert.equal(resolveTaskTimeout({ timeout_ms: 90_000 }, { ZCODE_BRIDGE_TIMEOUT_MS: "120000" }), 90_000);
  assert.equal(resolveTaskTimeout({}, { ZCODE_BRIDGE_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(resolveTaskTimeout({}, { ZCODE_BRIDGE_TIMEOUT_MS: "invalid" }), 60 * 60 * 1000);
});
