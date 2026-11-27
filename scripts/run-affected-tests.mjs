#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles } from "./lib/changed-files.mjs";
import { selectAffectedTests } from "./test-impact-selector.mjs";
import { compiledTestPath } from "./lib/test-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function run(command, args, { shell = command === "npm" && isWindows } = {}) {
  console.log(`[test:affected] ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit", shell });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}`);
  }
}

function commandLine(argv) {
  const options = {
    base: undefined,
    development: false,
    dryRun: false,
    t0Only: false,
    testsOnly: false,
    safeTestsOnly: false,
    forceFull: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") {
      options.base = argv[++index];
      if (!options.base) throw new Error("--base requires a Git revision");
    } else if (argv[index] === "--development") {
      options.development = true;
    } else if (argv[index] === "--dry-run") {
      options.dryRun = true;
    } else if (argv[index] === "--t0-only") {
      options.t0Only = true;
    } else if (argv[index] === "--tests-only") {
      options.testsOnly = true;
    } else if (argv[index] === "--safe-tests-only") {
      options.safeTestsOnly = true;
    } else if (argv[index] === "--force-full") {
      options.forceFull = true;
    } else {
      throw new Error(`unknown option: ${argv[index]}`);
    }
  }
  return options;
}

const options = commandLine(process.argv.slice(2));
if (options.t0Only && options.testsOnly) throw new Error("--t0-only and --tests-only are mutually exclusive");
if (options.t0Only && options.safeTestsOnly) throw new Error("--t0-only and --safe-tests-only are mutually exclusive");
if (options.development && (options.testsOnly || options.safeTestsOnly)) {
  throw new Error("--development cannot be combined with --tests-only or --safe-tests-only");
}
if (options.testsOnly || options.safeTestsOnly) {
  if (!options.base) {
    throw new Error(`${options.safeTestsOnly ? "--safe-tests-only" : "--tests-only"} requires an explicit --base`);
  }
  if (process.env.CODEX_BRIDGE_CI_T0_COMPLETED !== "1") {
    throw new Error(`${options.safeTestsOnly ? "--safe-tests-only" : "--tests-only"} requires a completed CI T0 preflight`);
  }
}
const map = JSON.parse(readFileSync(path.join(repositoryRoot, "test/test-impact-map.json"), "utf8"));
const files = changedFiles({
  root: repositoryRoot,
  base: options.base,
  includeWorktree: true,
});
const selection = selectAffectedTests({ changedFiles: files, map, forceFull: options.forceFull });
if (options.testsOnly && selection.mode !== "TARGETED") {
  throw new Error("--tests-only requires a TARGETED impact selection");
}
const targetedTests = selection.selected_tests.filter((entry) => !entry.stress);
const developmentTests = (selection.development_tests ?? []).filter((entry) => !entry.stress);

console.log(JSON.stringify({
  command: "npm run test:affected",
  baseline: options.base ?? "merge-base-with-upstream-plus-worktree",
  development: options.development,
  t0_only: options.t0Only,
  tests_only: options.testsOnly,
  safe_tests_only: options.safeTestsOnly,
  force_full: options.forceFull,
  ...selection,
}, null, 2));

// T0 remains unconditional, including for documentation-only diffs. A zero
// exit with NO_TESTS_APPLICABLE is not a targeted-test PASS.
if (!options.testsOnly && !options.safeTestsOnly) {
  run("npm", ["run", "typecheck"]);
  run("npm", ["run", "build"]);
  run("npm", ["run", "validate:plugin"]);
  run("npm", ["run", "check:generated"]);
  run("git", ["diff", "--check"]);
}

if (options.dryRun) {
  console.log("DRY_RUN_ONLY");
  process.exit(0);
}
if (options.t0Only) {
  console.log("T0_ONLY_PASS");
  process.exit(0);
}
if (selection.mode === "NO_TESTS_APPLICABLE") {
  if (options.safeTestsOnly) throw new Error("SAFE_TEST_SELECTION_REQUIRED: the selected domain has no development-safe tests");
  console.log("NO_TESTS_APPLICABLE");
  process.exit(0);
}

if (options.safeTestsOnly) {
  if (developmentTests.length === 0) {
    throw new Error("SAFE_TEST_SELECTION_REQUIRED: the selected domain has no development-safe tests");
  }
  run("npm", ["run", "build:test"]);
  run(process.execPath, [
    "scripts/test-isolated.mjs",
    ...developmentTests.map((entry) => compiledTestPath(entry.file)),
  ]);
  console.log(`SAFE_TESTS_PASS count=${developmentTests.length}`);
  process.exit(0);
}

if (selection.mode === "FULL_SUITE") {
  if (options.development) {
    if (developmentTests.length === 0) {
      throw new Error("DEVELOPMENT_SAFE_TEST_SELECTION_REQUIRED: FULL_SUITE selected no direct or domain tests");
    }
    run("npm", ["run", "build:test"]);
    run(process.execPath, [
      "scripts/test-isolated.mjs",
      ...developmentTests.map((entry) => compiledTestPath(entry.file)),
    ]);
    console.log(`DEVELOPMENT_SAFE_TESTS_PASS count=${developmentTests.length}`);
    console.log("FULL_SUITE_DEFERRED_TO_RELEASE_GATE");
    process.exit(0);
  }
  run("npm", ["test"]);
  console.log("FULL_REGRESSION_PASS");
  process.exit(0);
}

// Registered stress tests run once in the dedicated Stress job. Running them
// here as well duplicates the most expensive resource matrix.
if (targetedTests.length === 0) {
  console.log("STRESS_TEST_REQUIRED_SEPARATE_GATE");
  process.exit(0);
}

run("npm", ["run", "build:test"]);
const testPaths = targetedTests.map((entry) => compiledTestPath(entry.file));
run(process.execPath, ["scripts/test-isolated.mjs", ...testPaths]);
console.log(selection.stress_mode === "STRESS_TEST_REQUIRED" ? "STRESS_TEST_REQUIRED_SEPARATE_GATE" : "TARGETED_TESTS_PASS");
