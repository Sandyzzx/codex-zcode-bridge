import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { selectAffectedTests } from "../scripts/test-impact-selector.mjs";
import { automaticTestEntries, compiledTestPath } from "../scripts/lib/test-files.mjs";

const map: { tests: Array<{ file: string; gate: string; type: string; domains: string[] }>; domains: Array<{ id: string; paths: string[] }>; stress_tests: any[]; full_suite_paths: string[] }
  = JSON.parse(readFileSync(new URL("./test-impact-map.json", import.meta.url), "utf8"));
const selectorUrl = pathToFileURL(path.resolve(import.meta.dirname, "../scripts/test-impact-selector.mjs")).href;

function filesFor(selectorFile: string): string[] {
  if (selectorFile === "path-discovery") return ["src/runtime/paths.ts"];
  if (selectorFile === "task-store") return ["src/sqlite-candidate/wp6b2b1/store.mjs"];
  if (selectorFile === "sqlite-schema") return ["src/sqlite-candidate/wp6b2b1/schema.sql"];
  if (selectorFile === "worker") return ["src/worker/worker-main.ts"];
  if (selectorFile === "docs") return ["docs/reports/example.md"];
  if (selectorFile === "unknown-source") return ["src/example/new-domain.ts"];
  if (selectorFile === "test-runner") return ["scripts/test-isolated.mjs"];
  if (selectorFile === "rename") return ["test/zcode-paths-old.test.ts", "test/zcode-paths.test.ts"];
  return [];
}

async function importSelector(): Promise<typeof import("../scripts/test-impact-selector.mjs")> {
  return import(selectorUrl);
}

test("path discovery changes select path tests but not SQLite stress", () => {
  const selection = selectAffectedTests({ changedFiles: filesFor("path-discovery"), map });
  const files = selection.selected_tests.map((entry) => entry.file);
  assert.ok(files.includes("test/zcode-paths.test.ts"));
  assert.ok(files.includes("test/zcode-path-repair.test.ts"));
  assert.ok(files.includes("test/worker-env-portability.test.ts"));
  assert.equal(files.includes("test/sqlite-resource-stress.test.mjs"), false);
  assert.equal(selection.mode, "TARGETED");
  assert.equal(selection.stress_mode, "STRESS_TESTS_NOT_APPLICABLE");
});

test("SQLite Store and schema changes trigger SQLite stress with frozen parameters", () => {
  for (const files of [filesFor("task-store"), filesFor("sqlite-schema")]) {
    const selection = selectAffectedTests({ changedFiles: files, map });
    const stress = selection.selected_tests.find((entry) => entry.file === "test/sqlite-resource-stress.test.mjs");
    assert.ok(stress?.stress);
    assert.equal(selection.stress_mode, "STRESS_TEST_REQUIRED");
    assert.equal(stress?.stress?.parameters_frozen.capacity_limit, 8);
    assert.equal(stress?.stress?.parameters_frozen.historical_tasks, 256);
    assert.equal(stress?.stress?.parameters_frozen.existing_test_timeout_seconds, 120);
  }
});

test("Worker and protocol-adapter source changes select corresponding integration tests", () => {
  const worker = selectAffectedTests({ changedFiles: filesFor("worker"), map });
  assert.ok(worker.selected_tests.some((entry) => entry.file === "test/spawn-worker-stderr.test.ts"));
  assert.ok(worker.selected_tests.some((entry) => entry.file === "test/sqlite-candidate/wp6b-wiring/composition.test.ts"));
  const adapter = selectAffectedTests({ changedFiles: ["src/adapters/zcode-app-server-adapter.ts"], map });
  assert.ok(adapter.selected_tests.some((entry) => entry.file === "test/zcode-app-server-adapter.test.ts"));
  assert.ok(adapter.selected_tests.some((entry) => entry.file === "test/session-frames.test.ts"));
  assert.equal(worker.selected_tests.some((entry) => entry.file === "test/sqlite-resource-stress.test.mjs"), false);
  const deadlines = selectAffectedTests({ changedFiles: ["src/runtime/task-timeout.ts"], map });
  for (const file of ["test/task-timeout.test.ts", "test/zcode-app-server-adapter.test.ts", "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter.test.ts"]) {
    assert.ok(deadlines.selected_tests.some((entry) => entry.file === file), `shared deadline changes must select ${file}`);
  }
  assert.equal(deadlines.stress_mode, "STRESS_TEST_REQUIRED");
});

test("documentation-only changes never select stress or executable tests", () => {
  const selection = selectAffectedTests({ changedFiles: filesFor("docs"), map });
  assert.equal(selection.mode, "NO_TESTS_APPLICABLE");
  assert.equal(selection.selected_tests.length, 0);
  assert.equal(selection.stress_mode, "STRESS_TESTS_NOT_APPLICABLE");
});

test("unknown source and test infrastructure fall back to the complete suite", () => {
  const unknownSource = selectAffectedTests({ changedFiles: filesFor("unknown-source"), map });
  assert.equal(unknownSource.mode, "FULL_SUITE");
  assert.ok(unknownSource.full_suite_reasons.some((reason) => reason.startsWith("unknown-source:")));
  const unknownTest = selectAffectedTests({ changedFiles: ["test/new-domain.test.ts"], map });
  assert.equal(unknownTest.mode, "FULL_SUITE");
  assert.ok(unknownTest.full_suite_reasons.some((reason) => reason.startsWith("unknown-test-infrastructure:")));
});

test("runner and shared fixture changes force the complete regression", () => {
  for (const file of [filesFor("test-runner"), "test/helpers.ts", "test/test-impact-map.json"]) {
    const changed = Array.isArray(file) ? file : [file];
    const selection = selectAffectedTests({ changedFiles: changed, map });
    assert.equal(selection.mode, "FULL_SUITE");
    assert.equal(selection.stress_mode, "SEPARATE_STRESS_GATE");
    assert.equal(selection.selected_tests.some((entry) => entry.file === "test/sqlite-resource-stress.test.mjs"), false);
  }
});

test("renames preserve mapping by selecting both old and new paths", () => {
  const selection = selectAffectedTests({ changedFiles: filesFor("rename"), map });
  assert.ok(selection.selected_tests.some((entry) => entry.file === "test/zcode-paths.test.ts"));
  assert.ok(selection.affected_domains.includes("zcode-path-discovery"));
});

test("staged, unstaged, and untracked files use the same pure selection behavior", () => {
  // The Git wrapper records all three sources into one sorted list before this
  // function is called. The same file set must therefore produce one result.
  const once = selectAffectedTests({ changedFiles: ["src/sqlite-candidate/wp6b2b1/store.mjs"], map });
  const twice = selectAffectedTests({ changedFiles: ["src/sqlite-candidate/wp6b2b1/store.mjs"], map });
  assert.deepEqual(twice, once);
});

test("explicit baseline changes are just another deterministic changed-file input", () => {
  const files = ["package.json", "src/sqlite-candidate/wp6b2b1/store.mjs", "docs/example.md"];
  const first = selectAffectedTests({ changedFiles: files, map });
  const second = selectAffectedTests({ changedFiles: [...files].sort().reverse(), map });
  assert.deepEqual(second, first);
});

test("selector module exports stable policy functions", async () => {
  const module = await importSelector();
  assert.equal(typeof module.selectAffectedTests, "function");
});

test("every automatic selection excludes manual E2E and support fixtures", () => {
  const policyMap = { ...map, tests: [...map.tests, {file:"test/manual-only.mjs",gate:"MANUAL_E2E",type:"E2E",domains:["appserver-adapter"]}] };
  const forbidden = new Set(policyMap.tests.filter((entry) => entry.gate === "MANUAL_E2E" || entry.type === "Fixture").map((entry) => entry.file));
  const changed = [...map.domains.flatMap((domain) => domain.paths), ...forbidden, "package.json", "src/unknown-file.ts"];
  for (const platform of ["win32", "linux"] as const) {
    for (const file of changed) {
      const selection = selectAffectedTests({ changedFiles: [file], map: policyMap, platform });
      assert.equal(selection.selected_tests.some((entry) => forbidden.has(entry.file)), false, `${platform}: ${file}`);
    }
  }
});

test("Attention and Thin Waiter consumers follow their real production dependencies", () => {
  for (const dependency of ["src/runtime/sqlite-install-config.ts", "src/sqlite-candidate/wp6b2b1/store.mjs",
    "src/sqlite-candidate/wp6b2b1/schema.sql", "src/attention/read-only.ts", "src/attention/snapshot.ts",
    "src/attention/wait.ts", "src/cli/wait-task.ts", "src/manager/sqlite-lifecycle-mcp-authority.ts", "src/runtime/paths.ts"]) {
    const selection = selectAffectedTests({ changedFiles: [dependency], map });
    for (const consumer of ["test/attention-wait.test.ts", "test/wait-task.test.ts"]) {
      assert.ok(selection.selected_tests.some((entry) => entry.file === consumer), `${dependency} must select ${consumer}`);
    }
    assert.equal(selection.mode, "TARGETED", dependency);
  }
});

test("manifest covers all executable sources and full selection matches the actual runner", () => {
  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? sources(file) : /\.test\.(ts|mjs)$/u.test(file) ? [file] : [];
    });
  }
  const mapped = new Set(map.tests.map((entry) => entry.file));
  assert.equal(mapped.size, map.tests.length, "duplicate manifest entries");
  for (const file of sources("test")) assert.ok(mapped.has(file), `unmapped executable test: ${file}`);
  for (const entry of map.tests) assert.ok(existsSync(entry.file), `stale manifest entry: ${entry.file}`);
  for (const platform of ["win32", "linux"] as const) {
    const selection = selectAffectedTests({ changedFiles: ["package.json"], map, platform });
    assert.deepEqual(selection.selected_tests.map((entry) => entry.file).sort(), automaticTestEntries(map, platform).map((entry: { file: string }) => entry.file).sort());
  }
  const listed = spawnSync(process.execPath, ["scripts/test-isolated.mjs", "--list"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), automaticTestEntries(map).map((entry: { file: string }) => compiledTestPath(entry.file)).sort());
  for (const file of ["test/live-project-root.mjs", "test/sqlite-candidate/wp6b2b1/worker-process.mjs", "test/unknown.test.mjs"]) {
    const rejected = spawnSync(process.execPath, ["scripts/test-isolated.mjs", "--list", file], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0, file);
    assert.match(rejected.stderr, /Not an automatic test/u);
  }
});
