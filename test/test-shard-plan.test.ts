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

// The hosted windows-shard-experiment workflow was retired on 2026-11-24
// (not a required check on either protected branch, no release dependency,
// and its trigger branch no longer exists). The guard that validated its
// runner-temp scoping retired together with the file.

test("production CI gates the protected Windows check on both isolated shards", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/gu, "\n");
  const windowsStart = workflow.indexOf("  verify-windows:");
  const releaseStart = workflow.indexOf("  release:", windowsStart);
  const resultStart = workflow.indexOf("  windows-result:", releaseStart);
  const stressStart = workflow.indexOf("  sqlite-stress:", resultStart);
  assert.ok(windowsStart >= 0 && releaseStart > windowsStart && resultStart > releaseStart && stressStart > resultStart);

  const windows = workflow.slice(windowsStart, releaseStart);
  assert.match(windows, /name: Windows Verify shard \$\{\{ matrix\.shard \}\}\/2/u);
  assert.match(windows, /shard: \[1, 2\]/u);
  assert.match(windows, /if: matrix\.shard == 1[\s\S]*?node scripts\/verify-windows-worker-identity\.mjs/u);
  assert.match(windows, /run: npm run test:shard -- --shard=\$\{\{ matrix\.shard \}\}\/2/u);
  assert.match(windows, /WP6_TEST_FIXTURE_ROOT: \$\{\{ runner\.temp \}\}/u);

  const release = workflow.slice(releaseStart, resultStart);
  assert.match(release, /name: Verify \(ubuntu-latest\)/u);
  assert.doesNotMatch(release, /windows-2022/u,
    "the unsharded Windows full suite must not also run under the protected check");

  const result = workflow.slice(resultStart, stressStart);
  assert.match(result, /name: Verify \(windows-2022\)/u,
    "the aggregate must preserve the existing protected required-check name");
  assert.match(result, /needs: \[impact, verify-windows\]/u);
  assert.match(result, /needs\.verify-windows\.result/u);
});
