import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { automaticTestEntries } from "../scripts/lib/test-files.mjs";
import { validateShardPlan } from "../scripts/test-shard.mjs";

const map = JSON.parse(readFileSync(new URL("./test-impact-map.json", import.meta.url), "utf8"));
const plan = JSON.parse(readFileSync(new URL("./windows-test-shard-plan.json", import.meta.url), "utf8"));

test("Windows shard plan is complete, disjoint, automatic-only, and duration-balanced", () => {
  const evidence = validateShardPlan(map, plan);
  assert.deepEqual([...evidence.seen.keys()].sort(), evidence.automatic);
  assert.ok(evidence.imbalance <= 0.15);
  for (const shard of plan.shards) {
    const componentTotal = shard.tests.reduce((total: number, entry: { estimated_ms: number }) => total + entry.estimated_ms, 0);
    assert.equal(shard.estimated_ms, componentTotal, `shard ${shard.id} estimate must equal its component sum`);
  }
  assert.equal(automaticTestEntries(map, "linux", { includeStress: false }).some((entry: { file: string }) => entry.file.includes("mvp-real-adapter-stream-stress")), false);
});
