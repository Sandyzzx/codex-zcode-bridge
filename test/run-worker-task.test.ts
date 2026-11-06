import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { workerEntryPath } from "../src/manager/spawn-worker.js";

test("the compiled worker shell rejects missing arguments without any task access", () => {
  const run = spawnSync(process.execPath, [workerEntryPath()], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: Worker requires the SQLite private lifecycle channels/);
});
