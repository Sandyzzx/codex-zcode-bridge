import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { selectAffectedTests } from "../scripts/test-impact-selector.mjs";

const map = JSON.parse(readFileSync(new URL("./test-impact-map.json", import.meta.url), "utf8"));
const selectorUrl = pathToFileURL(path.resolve(import.meta.dirname, "../scripts/test-impact-selector.mjs")).href;

function filesFor(selectorFile: string): string[] {
  if (selectorFile === "path-discovery") return ["src/runtime/paths.ts"];
  if (selectorFile === "task-store") return ["src/store/task-store.ts"];
  if (selectorFile === "sqlite-schema") return ["src/sqlite-candidate/wp6b2b1/schema.sql"];
  if (selectorFile === "worker") return ["src/worker/run-task.ts"];
  if (selectorFile === "attention") throw new Error("Attention is not part of this master snapshot");
  if (selectorFile === "docs") return ["docs/reports/example.md"];
  if (selectorFile === "unknown-source") return ["src/example/new-domain.ts"];
  if (selectorFile === "test-runner") return ["scripts/test-isolated.mjs"];
  if (selectorFile === "rename") return ["test/zcode-paths-old.test.ts", "test/zcode-paths.test.ts"];
  return [];
}

async function importSelector(): Promise<typeof import("../scripts/test-impact-selector.mjs")> {
  return import(selectorUrl);
}

test("path discovery changes select path tests but not B3-05", () => {
  const selection = selectAffectedTests({ changedFiles: filesFor("path-discovery"), map });
  const files = selection.selected_tests.map((entry) => entry.file);
  assert.ok(files.includes("test/zcode-paths.test.ts"));
  assert.ok(files.includes("test/zcode-path-repair.test.ts"));
  assert.ok(files.includes("test/worker-env-portability.test.ts"));
  assert.equal(files.includes("test/batch2-performance.test.ts"), false);
  assert.equal(selection.mode, "TARGETED");
  assert.equal(selection.stress_mode, "STRESS_TESTS_NOT_APPLICABLE");
});

test("TaskStore and SQLite schema changes trigger B3-05 with frozen parameters", () => {
  for (const files of [filesFor("task-store"), filesFor("sqlite-schema")]) {
    const selection = selectAffectedTests({ changedFiles: files, map });
    const stress = selection.selected_tests.find((entry) => entry.file === "test/batch2-performance.test.ts");
    assert.ok(stress?.stress);
    assert.equal(selection.stress_mode, "STRESS_TEST_REQUIRED");
    assert.equal(stress?.stress?.parameters_frozen.active_tasks, 32);
    assert.equal(stress?.stress?.parameters_frozen.historical_tasks, 10_000);
    assert.equal(stress?.stress?.parameters_frozen.existing_test_timeout_seconds, 900);
    assert.equal(stress?.stress?.parameters_frozen.setup_performance_budget_seconds, 720);
  }
});

test("Worker and protocol-adapter source changes select corresponding integration tests", () => {
  const worker = selectAffectedTests({ changedFiles: filesFor("worker"), map });
  assert.ok(worker.selected_tests.some((entry) => entry.file === "test/run-worker-task.test.ts"));
  assert.ok(worker.selected_tests.some((entry) => entry.file === "test/task-manager.test.ts"));
  const adapter = selectAffectedTests({ changedFiles: ["src/adapters/zcode-app-server-adapter.ts"], map });
  assert.ok(adapter.selected_tests.some((entry) => entry.file === "test/zcode-app-server-adapter.test.ts"));
  assert.ok(adapter.selected_tests.some((entry) => entry.file === "test/session-frames.test.ts"));
  assert.equal(worker.selected_tests.some((entry) => entry.file === "test/batch2-performance.test.ts"), false);
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
    assert.equal(selection.stress_mode, "INCLUDED_BY_FULL_SUITE");
    assert.ok(selection.selected_tests.some((entry) => entry.file === "test/batch2-performance.test.ts"));
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
  const once = selectAffectedTests({ changedFiles: ["src/store/task-store.ts"], map });
  const twice = selectAffectedTests({ changedFiles: ["src/store/task-store.ts"], map });
  assert.deepEqual(twice, once);
});

test("explicit baseline changes are just another deterministic changed-file input", () => {
  const files = ["package.json", "src/store/task-store.ts", "docs/example.md"];
  const first = selectAffectedTests({ changedFiles: files, map });
  const second = selectAffectedTests({ changedFiles: [...files].sort().reverse(), map });
  assert.deepEqual(second, first);
});

test("selector module exports stable policy functions", async () => {
  const module = await importSelector();
  assert.equal(typeof module.selectAffectedTests, "function");
});
