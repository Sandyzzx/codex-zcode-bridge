import assert from "node:assert/strict";
import test from "node:test";
import { assertSqliteRuntimeVersion, loadLifecycleCandidateModules, LifecycleGateError } from "../../../src/store/lifecycle-gate.js";

test("SQLite Runtime Gate accepts only Node 24.16 through 24.x", () => {
  for (const version of ["24.16.0", "24.16.1", "24.99.0"]) assert.doesNotThrow(() => assertSqliteRuntimeVersion(version));
  for (const version of ["22.18.0", "24.15.9", "25.0.0", "24.17.0-rc.1", "v24.16.0", "unknown"]) {
    assert.throws(() => assertSqliteRuntimeVersion(version), (error: unknown) => error instanceof LifecycleGateError && error.code === "sqlite_runtime_unsupported");
  }
});

test("ineligible runtime is rejected before loading SQLite or selecting JSON fallback", async () => {
  let loads = 0;
  await assert.rejects(loadLifecycleCandidateModules("22.18.0", async () => { loads += 1; throw new Error("must not load"); }),
    (error: unknown) => error instanceof LifecycleGateError && error.code === "sqlite_runtime_unsupported");
  assert.equal(loads, 0);
});

test("missing SQLite candidate fails closed without fallback", async () => {
  let loads = 0;
  await assert.rejects(loadLifecycleCandidateModules("24.16.0", async () => { loads += 1; throw new Error("node:sqlite unavailable"); }),
    (error: unknown) => error instanceof LifecycleGateError && error.code === "sqlite_candidate_unavailable");
  assert.equal(loads, 1, "one explicit candidate load, with no JSON fallback attempt");
});
