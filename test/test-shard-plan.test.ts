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

test("Windows shard workflow scopes runner temp expressions to steps", () => {
  const workflow = readFileSync(".github/workflows/windows-shard-experiment.yml", "utf8").replace(/\r\n/gu, "\n");
  assert.match(workflow, /push:\n {4}branches:\n {6}- codex\/ci-performance-test-optimization-20261120\n {4}paths:\n {6}- \.github\/workflows\/windows-shard-experiment\.yml/u,
    "hosted experiment pushes must stay confined to this research branch and workflow file");
  const shardStart = workflow.indexOf("  shard:");
  const stepsStart = workflow.indexOf("    steps:", shardStart);
  assert.ok(shardStart >= 0 && stepsStart > shardStart, "the shard job header must be identifiable");
  assert.doesNotMatch(workflow.slice(shardStart, stepsStart), /runner\.temp/u,
    "the runner context is not available in job-level env");
  assert.match(workflow, /- name: Prepare isolated shard directories[\s\S]*?SHARD_TEMP: \$\{\{ runner\.temp \}\}/u);
  assert.match(workflow, /- name: Run Windows shard[\s\S]*?WP6_TEST_FIXTURE_ROOT: \$\{\{ runner\.temp \}\}/u);
});
