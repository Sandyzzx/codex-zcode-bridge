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
  const options = { base: undefined, dryRun: false, t0Only: false, forceFull: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") {
      options.base = argv[++index];
      if (!options.base) throw new Error("--base requires a Git revision");
    } else if (argv[index] === "--dry-run") {
      options.dryRun = true;
    } else if (argv[index] === "--t0-only") {
      options.t0Only = true;
    } else if (argv[index] === "--force-full") {
      options.forceFull = true;
    } else {
      throw new Error(`unknown option: ${argv[index]}`);
    }
  }
  return options;
}

const options = commandLine(process.argv.slice(2));
const map = JSON.parse(readFileSync(path.join(repositoryRoot, "test/test-impact-map.json"), "utf8"));
const files = changedFiles({
  root: repositoryRoot,
  base: options.base,
  includeWorktree: true,
});
const selection = selectAffectedTests({ changedFiles: files, map, forceFull: options.forceFull });

console.log(JSON.stringify({
  command: "npm run test:affected",
  baseline: options.base ?? "merge-base-with-upstream-plus-worktree",
  t0_only: options.t0Only,
  force_full: options.forceFull,
  ...selection,
}, null, 2));

// T0 remains unconditional, including for documentation-only diffs. A zero
// exit with NO_TESTS_APPLICABLE is not a targeted-test PASS.
run("npm", ["run", "typecheck"]);
run("npm", ["run", "build"]);
run("npm", ["run", "validate:plugin"]);
run("npm", ["run", "check:generated"]);
run("git", ["diff", "--check"]);

if (options.dryRun) {
  console.log("DRY_RUN_ONLY");
  process.exit(0);
}
if (options.t0Only) {
  console.log("T0_ONLY_PASS");
  process.exit(0);
}
if (selection.mode === "NO_TESTS_APPLICABLE") {
  console.log("NO_TESTS_APPLICABLE");
  process.exit(0);
}

if (selection.mode === "FULL_SUITE") {
  run("npm", ["test"]);
  console.log("FULL_REGRESSION_PASS");
  process.exit(0);
}

run("npm", ["run", "build:test"]);
const testPaths = selection.selected_tests.map((entry) => compiledTestPath(entry.file));
run(process.execPath, ["scripts/test-isolated.mjs", ...testPaths]);
console.log(selection.stress_mode === "STRESS_TEST_REQUIRED" ? "STRESS_TEST_REQUIRED_AND_PASS" : "TARGETED_TESTS_PASS");
