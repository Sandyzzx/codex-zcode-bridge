import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
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
  if (selectorFile === "unknown-script") return ["scripts/new-executable.mjs"];
  if (selectorFile === "copy-test-assets") return ["scripts/copy-test-assets.mjs"];
  if (selectorFile === "node-launcher") return ["plugins/codex-zcode-bridge/launch-node24.mjs"];
  if (selectorFile === "process-spawn") return ["src/adapters/process-spawn.ts"];
  return [];
}

async function importSelector(): Promise<typeof import("../scripts/test-impact-selector.mjs")> {
  return import(selectorUrl);
}

function matchesPattern(file: string, pattern: string): boolean {
  const parts = pattern.split("/");
  const regexSource = parts.map((part) => {
    if (part === "**") return "(?:[^/]+(?:/[^/]+)*)?";
    if (part === "*") return "[^/]+";
    return part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }).join("/");
  return new RegExp(`^${regexSource}$`, "u").test(file);
}

function resolveStaticImport(testFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), specifier));
  const withoutRuntimeExtension = target.replace(/\.(?:mjs|js|cjs|mts)$/u, "");
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.mts`,
    `${target}.mjs`,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.mts`,
    `${withoutRuntimeExtension}.mjs`,
    `${target}/index.ts`,
    `${target}/index.mjs`,
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function directRepositoryImports(testFile: string): string[] {
  const source = readFileSync(testFile, "utf8");
  const parsed = ts.createSourceFile(testFile, source, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  const addImport = (specifier: string) => {
    const resolved = resolveStaticImport(testFile, specifier);
    if (resolved && /^(?:src|plugins|scripts|tools)\//u.test(resolved)) imports.add(resolved);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      addImport(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...imports].sort();
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
  for (const file of [
    "test/task-timeout.test.ts",
    "test/zcode-app-server-adapter.test.ts",
    "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter-official-host.test.ts",
    "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter-result-lifecycle.test.ts",
  ]) {
    assert.ok(deadlines.selected_tests.some((entry) => entry.file === file), `shared deadline changes must select ${file}`);
  }
  assert.equal(deadlines.stress_mode, "STRESS_TEST_REQUIRED");
  const deadlinesLinux = selectAffectedTests({ changedFiles: ["src/runtime/task-timeout.ts"], map, platform: "linux" });
  assert.equal(deadlinesLinux.selected_tests.some((entry) => entry.file.includes("mvp-real-adapter-")), false,
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
  const unknownScript = selectAffectedTests({ changedFiles: filesFor("unknown-script"), map });
  assert.equal(unknownScript.mode, "FULL_SUITE");
  assert.ok(unknownScript.full_suite_reasons.some((reason) => reason.startsWith("unknown-executable-script:")));
});

test("runner and shared fixture changes force the complete regression", () => {
  const fullSuitePaths = [
    filesFor("test-runner"),
    filesFor("copy-test-assets"),
    "test/helpers.ts",
    "test/test-impact-map.json",
  ];
  for (const file of fullSuitePaths) {
    const changed = Array.isArray(file) ? file : [file];
    const selection = selectAffectedTests({ changedFiles: changed, map });
    assert.equal(selection.mode, "FULL_SUITE");
    assert.equal(selection.stress_mode, "SEPARATE_STRESS_GATE");
    assert.equal(selection.selected_tests.some((entry) => entry.file === "test/sqlite-resource-stress.test.mjs"), false);
  }
  const costLab = selectAffectedTests({ changedFiles: ["tools/cost-lab/web-server.mjs"], map });
  assert.equal(costLab.mode, "NO_TESTS_APPLICABLE");
  assert.deepEqual(costLab.affected_domains, ["cost-lab"]);
});

test("real script consumers map to their executable contract tests", () => {
  const launcher = selectAffectedTests({ changedFiles: filesFor("node-launcher"), map });
  assert.ok(launcher.selected_tests.some((entry) => entry.file === "test/node-runtime.test.ts"));

  const spawn = selectAffectedTests({ changedFiles: filesFor("process-spawn"), map, platform: "win32" });
  for (const consumer of [
    "test/process-spawn.test.ts",
    "test/runtime-remediation.test.ts",
    "test/sqlite-candidate/wp6b-wiring/composition.test.ts",
    "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter-official-host.test.ts",
    "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter-private-auth.test.ts",
    "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter-result-lifecycle.test.ts",
    "test/sqlite-candidate/wp6b-wiring/mvp-real-adapter-routing-admission.test.ts",
  ]) {
    assert.ok(spawn.selected_tests.some((entry) => entry.file === consumer), `process-spawn changes must select ${consumer}`);
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

test("every test domain covers its direct production imports", () => {
  const failures: string[] = [];
  for (const entry of map.tests) {
    if (entry.type === "Fixture") continue;
    for (const dependency of directRepositoryImports(entry.file)) {
      if (map.full_suite_paths.some((pattern) => matchesPattern(dependency, pattern))) continue;
      const ownerDomains = map.domains
        .filter((domain) => domain.paths.some((pattern) => matchesPattern(dependency, pattern)))
        .map((domain) => domain.id);
      if (ownerDomains.length === 0) continue;
      if (!ownerDomains.some((domain) => entry.domains.includes(domain))) {
        failures.push(`${entry.file} imports ${dependency} but lacks ${ownerDomains.join(" or ")}`);
      }
    }
  }
  assert.deepEqual(failures, []);
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

  const forcedRunner = selectAffectedTests({ changedFiles: [], map, forceFull: true });
  assert.equal(forcedRunner.mode, "FULL_SUITE");
  assert.deepEqual(forcedRunner.full_suite_reasons, ["forced-full"]);
});

test("Cost Lab changes select only the independent Cost Lab gate", () => {
  const costLab = selectCiImpact({ files: ["tools/cost-lab/startplan-billing.mjs"], map });
  assert.equal(costLab.affected_mode, "NO_TESTS_APPLICABLE");
  assert.equal(costLab.full_required, false);
  assert.equal(costLab.integration_required, false);
  assert.equal(costLab.cost_lab_required, true);
  const forced = selectCiImpact({ files: [], map, forceFull: true });
  assert.equal(forced.full_required, true);
  assert.equal(forced.cost_lab_required, true, "an unverifiable diff must not silently skip Cost Lab");
});

test("CI impact CLI fails safe for dispatch, initial-push and invalid base revisions", () => {
  const validBase = spawnSync(
    process.execPath,
    ["scripts/ci-select-impact.mjs", "--base", "HEAD", "--head", "HEAD"],
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

test("CI separates development checks from the complete release gate", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8").replace(/\r\n/gu, "\n");
  const runner = readFileSync(path.resolve("scripts/run-affected-tests.mjs"), "utf8");
  assert.match(
    workflow,
    /pull_request:\s*\n\s*types:\s*\[opened, synchronize, reopened, ready_for_review, labeled, unlabeled\]/u,
    "release-candidate label changes must recompute the formal PR gate",
  );
  assert.match(
    workflow,
    /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*release_gate:[\s\S]*?type: boolean\s*\n\s*default: false/u,
    "manual runs must opt in explicitly to the complete release gate",
  );
  assert.match(workflow, /release_required: \$\{\{ steps\.release\.outputs\.release_required \}\}/u);
  assert.match(
    workflow,
    /RELEASE_REQUESTED: \$\{\{ \(github\.event_name == 'workflow_dispatch' && inputs\.release_gate\) \|\| \(github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false && contains\(github\.event\.pull_request\.labels\.\*\.name, 'release-candidate'\)\) \}\}/u,
    "only an explicit dispatch or non-draft release-candidate label may request the release gate",
  );
  assert.match(workflow, /fast:\s+name: Fast PR gate\s+needs: impact\s+if: always\(\) && \(github\.event_name == 'pull_request' \|\| github\.event_name == 'workflow_dispatch'\)/u);
  assert.match(workflow, /npm run test:affected -- --base "\$BASE_SHA" --development/u);
  assert.match(workflow, /npm run test:affected -- --force-full --development/u);
  assert.match(runner, /FULL_SUITE_DEFERRED_TO_RELEASE_GATE/u);
  assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/u);
  assert.match(workflow, /Fast impact selection requires a valid base SHA/u);
  assert.match(
    workflow,
    /integration:[\s\S]*?needs: \[impact, fast\][\s\S]*?needs\.fast\.result == 'success' && needs\.impact\.outputs\.release_required != 'true' && needs\.impact\.outputs\.integration_required == 'true' && needs\.impact\.outputs\.full_required != 'true'/u,
    "targeted Windows integration must not duplicate complete release gates or unsafe full selections",
  );
  assert.match(
    workflow,
    /integration:[\s\S]*?- run: npm run build[\s\S]*?- name: Verify Windows worker process identity[\s\S]*?- name: Impacted integration and task-lifecycle tests/u,
    "Windows integration must not repeat Fast's typecheck, plugin, generated, or diff gates",
  );
  assert.match(
    workflow,
    /release:[\s\S]*?github\.event_name == 'push' \|\| needs\.impact\.outputs\.release_required == 'true'/u,
    "the Ubuntu complete regression must run on push or an explicit release request",
  );
  assert.match(
    workflow,
    /release:[\s\S]*?github\.event\.pull_request\.draft == false/u,
    "draft PRs must not pay for the full release regression",
  );
  assert.match(
    workflow,
    /sqlite-stress:[\s\S]*?github\.event_name == 'push' \|\| needs\.impact\.outputs\.release_required == 'true'/u,
    "the stress matrix belongs to the complete release gate",
  );
  assert.match(
    workflow,
    /cost-lab:[\s\S]*?always\(\) && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false && needs\.impact\.outputs\.cost_lab_required == 'true'\)\)/u,
    "Cost Lab must run on Push/Dispatch and selected non-draft PRs only",
  );
  assert.match(
    workflow,
    /cost-lab:[\s\S]*?runs-on: windows-2022[\s\S]*?run: npm run cost-lab:test/u,
    "Cost Lab's official-runtime and Windows path contracts must execute on Windows",
  );
  assert.match(workflow, /CODEX_BRIDGE_CI_T0_COMPLETED: "1"[\s\S]*?--tests-only/u);
  assert.match(workflow, /concurrency:[\s\S]*?group: ci-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}[\s\S]*?cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
  assert.doesNotMatch(
    workflow,
    /run:\s+npm run test:affected -- --base "\$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}"/u,
    "CI must never pass an empty workflow expression directly to --base",
  );
  assert.doesNotMatch(workflow, /npm run test:full/u);
  assert.equal(
    [...workflow.matchAll(/^\s*-\s+run:\s+npm test\s*$/gmu)].length,
    1,
    "the complete npm test run belongs once to the Release gate",
  );
});

test("required-check jobs stay present while complete jobs defer in development", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8").replace(/\r\n/gu, "\n");
  const windowsStart = workflow.indexOf("  verify-windows:");
  const releaseStart = workflow.indexOf("  release:", windowsStart);
  const resultStart = workflow.indexOf("  windows-result:", releaseStart);
  const stressStart = workflow.indexOf("  sqlite-stress:", resultStart);
  assert.ok(windowsStart >= 0 && releaseStart > windowsStart && resultStart > releaseStart && stressStart > resultStart);

  const windows = workflow.slice(windowsStart, releaseStart);
  const release = workflow.slice(releaseStart, resultStart);
  const result = workflow.slice(resultStart, stressStart);
  const stress = workflow.slice(stressStart);
  for (const job of [windows, release, result, stress]) {
    assert.match(
      job,
      /if: always\(\) && \(github\.event_name == 'push' \|\| \(\(github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'pull_request' && github\.event\.pull_request\.draft == false\)\) && needs\.impact\.result == 'success'\)\)/u,
      "a required-check job must materialize a result for every non-draft PR",
    );
  }

  assert.match(
    windows,
    /- name: Run Windows shard\s+if: github\.event_name == 'push' \|\| needs\.impact\.outputs\.release_required == 'true'/u,
  );
  assert.match(
    release,
    /- run: npm test\s+if: github\.event_name == 'push' \|\| needs\.impact\.outputs\.release_required == 'true'/u,
  );
  assert.match(
    stress,
    /- run: npm run test:stress\s+if: github\.event_name == 'push' \|\| needs\.impact\.outputs\.release_required == 'true'/u,
  );
  assert.match(windows, /- name: Full Windows suite deferred/u);
  assert.match(release, /- name: Full Ubuntu suite deferred/u);
  assert.match(stress, /- name: SQLite stress matrix deferred/u);
});

test("tests-only execution is fail-closed without CI preflight evidence", () => {
  const env = { ...process.env };
  delete env.CODEX_BRIDGE_CI_T0_COMPLETED;
  const missingPreflight = spawnSync(
    process.execPath,
    ["scripts/run-affected-tests.mjs", "--base", "HEAD", "--tests-only"],
    { encoding: "utf8", env },
  );
  assert.notEqual(missingPreflight.status, 0);
  assert.match(missingPreflight.stderr, /--tests-only requires a completed CI T0 preflight/u);

  const missingBase = spawnSync(
    process.execPath,
    ["scripts/run-affected-tests.mjs", "--tests-only"],
    { encoding: "utf8", env: { ...env, CODEX_BRIDGE_CI_T0_COMPLETED: "1" } },
  );
  assert.notEqual(missingBase.status, 0);
  assert.match(missingBase.stderr, /--tests-only requires an explicit --base/u);

  const developmentConflict = spawnSync(
    process.execPath,
    ["scripts/run-affected-tests.mjs", "--base", "HEAD", "--tests-only", "--development"],
    { encoding: "utf8", env: { ...env, CODEX_BRIDGE_CI_T0_COMPLETED: "1" } },
  );
  assert.notEqual(developmentConflict.status, 0);
  assert.match(developmentConflict.stderr, /--development and --tests-only are mutually exclusive/u);
});
