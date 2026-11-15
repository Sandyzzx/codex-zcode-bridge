import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { selectCiImpact } from "../scripts/ci-select-impact.mjs";
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
  const worker = selectAffectedTests({ changedFiles: filesFor("worker"), map, platform: "win32" });
  assert.ok(worker.selected_tests.some((entry) => entry.file === "test/spawn-worker-stderr.test.ts"));
  assert.ok(worker.selected_tests.some((entry) => entry.file === "test/sqlite-candidate/wp6b-wiring/composition.test.ts"));
  const workerLinux = selectAffectedTests({ changedFiles: filesFor("worker"), map, platform: "linux" });
  assert.ok(workerLinux.selected_tests.some((entry) => entry.file === "test/spawn-worker-stderr.test.ts"));
  assert.equal(workerLinux.selected_tests.some((entry) => entry.file === "test/sqlite-candidate/wp6b-wiring/composition.test.ts"), false,
    "Windows-only composition coverage must not run on Linux");
  const adapter = selectAffectedTests({ changedFiles: ["src/adapters/zcode-app-server-adapter.ts"], map, platform: "win32" });
  assert.ok(adapter.selected_tests.some((entry) => entry.file === "test/zcode-app-server-adapter.test.ts"));
  assert.ok(adapter.selected_tests.some((entry) => entry.file === "test/session-frames.test.ts"));
  assert.equal(worker.selected_tests.some((entry) => entry.file === "test/sqlite-resource-stress.test.mjs"), false);
  const deadlines = selectAffectedTests({ changedFiles: ["src/runtime/task-timeout.ts"], map, platform: "win32" });
  for (const file of ["test/task-timeout.test.ts", "test/zcode-app-server-adapter.test.ts", "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter.test.ts"]) {
    assert.ok(deadlines.selected_tests.some((entry) => entry.file === file), `shared deadline changes must select ${file}`);
  }
  assert.equal(deadlines.stress_mode, "STRESS_TEST_REQUIRED");
  const deadlinesLinux = selectAffectedTests({ changedFiles: ["src/runtime/task-timeout.ts"], map, platform: "linux" });
  assert.equal(deadlinesLinux.selected_tests.some((entry) => entry.file === "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter.test.ts"), false,
    "Windows-only real-adapter deadline coverage must not run on Linux");
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

test("CI impact gate shadow-compares targeted and full selections with the executable manifest", () => {
  const docs = selectCiImpact({ files: ["docs/report.md"], map });
  assert.equal(docs.affected_mode, "NO_TESTS_APPLICABLE");
  assert.equal(docs.integration_required, false);
  assert.equal(docs.full_required, false);

  const worker = selectCiImpact({ files: ["src/worker/worker-main.ts"], map });
  assert.equal(worker.affected_mode, "TARGETED");
  assert.equal(worker.integration_required, true);
  assert.equal(worker.full_required, false);
  assert.ok(worker.selected_test_files.includes("test/spawn-worker-stderr.test.ts"));
  assert.ok(worker.selected_test_files.includes("test/sqlite-candidate/wp6b-wiring/composition.test.ts"));

  const full = selectCiImpact({ files: ["package.json"], map });
  assert.equal(full.affected_mode, "FULL_SUITE");
  assert.equal(full.force_full, false);
  assert.equal(full.full_required, true);
  assert.equal(full.integration_required, true);

  const forced = selectCiImpact({ files: [], map, forceFull: true });
  assert.equal(forced.force_full, true);
  assert.equal(forced.full_required, true);
});

test("CI impact CLI fails safe for dispatch, initial-push and invalid base revisions", () => {
  const validBase = spawnSync(
    process.execPath,
    ["scripts/ci-select-impact.mjs", "--base", "HEAD~1", "--head", "HEAD"],
    { encoding: "utf8" },
  );
  assert.equal(validBase.status, 0, validBase.stderr);
  assert.equal(JSON.parse(validBase.stdout).force_full, false);

  for (const args of [
    ["--head", "HEAD", "--force-full"],
    ["--base", "0".repeat(40), "--head", "HEAD"],
  ]) {
    const full = spawnSync(
      process.execPath,
      ["scripts/ci-select-impact.mjs", ...args],
      { encoding: "utf8" },
    );
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).force_full, true);
    assert.equal(JSON.parse(full.stdout).full_required, true);
  }

  const invalid = spawnSync(
    process.execPath,
    ["scripts/ci-select-impact.mjs", "--base", "not-a-revision", "--head", "HEAD"],
    { encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0, "an invalid non-zero base must fail rather than skip validation");
  assert.match(invalid.stderr, /git diff .* failed/u);
});

test("FULL-impact Fast gate delegates the full regression to Release", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
  assert.match(
    workflow,
    /Fast selection \(FULL delegates regression to Release\)[\s\S]*?args\+=\(--t0-only\)[\s\S]*?npm run test:affected/u,
    "the Fast gate must request only T0 when impact policy requires the full suite",
  );
  assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/u);
  assert.match(workflow, /A non-full Fast gate requires a valid base SHA/u);
  assert.doesNotMatch(
    workflow,
    /run:\s+npm run test:affected -- --base "\$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}"/u,
    "CI must never pass an empty workflow expression directly to --base",
  );
  assert.doesNotMatch(workflow, /npm run test:full/u);
  assert.equal(
    [...workflow.matchAll(/^\s*-\s+run:\s+npm test\s*$/gmu)].length,
    1,
    "the complete npm test run belongs to the Release gate",
  );
});
