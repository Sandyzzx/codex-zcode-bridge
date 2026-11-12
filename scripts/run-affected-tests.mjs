#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

function git(args, { allowMissingUpstream = false } = {}) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status === 0) return result.stdout;
  if (allowMissingUpstream) return "";
  throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
}

function addNameStatus(output, files) {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const columns = line.split("\t");
    const status = columns[0];
    if (status.startsWith("R") || status.startsWith("C")) {
      if (columns[1]) files.add(columns[1]);
      if (columns[2]) files.add(columns[2]);
    } else {
      if (columns[1]) files.add(columns[1]);
    }
  }
}

function changedFiles(explicitBase) {
  const files = new Set();
  if (explicitBase) {
    addNameStatus(git(["diff", "--name-status", "--find-renames", `${explicitBase}...HEAD`]), files);
  } else {
    const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowMissingUpstream: true }).trim();
    if (upstream) {
      const mergeBase = git(["merge-base", "HEAD", upstream]).trim();
      addNameStatus(git(["diff", "--name-status", "--find-renames", `${mergeBase}...HEAD`]), files);
    }
  }
  addNameStatus(git(["diff", "--name-status", "--find-renames", "HEAD"]), files);
  for (const file of git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/u)) {
    if (file.trim()) files.add(file.trim());
  }
  return [...files].sort((left, right) => left.localeCompare(right, "en"));
}

function commandLine(argv) {
  const options = { base: undefined, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") {
      options.base = argv[++index];
      if (!options.base) throw new Error("--base requires a Git revision");
    } else if (argv[index] === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown option: ${argv[index]}`);
    }
  }
  return options;
}

const options = commandLine(process.argv.slice(2));
const map = JSON.parse(readFileSync(path.join(repositoryRoot, "test/test-impact-map.json"), "utf8"));
const files = changedFiles(options.base);
const selection = selectAffectedTests({ changedFiles: files, map });

console.log(JSON.stringify({
  command: "npm run test:affected",
  baseline: options.base ?? "merge-base-with-upstream-plus-worktree",
  ...selection,
}, null, 2));

// T0 remains unconditional, including for documentation-only diffs. A zero
// exit with NO_TESTS_APPLICABLE is not a targeted-test PASS.
run("npm", ["run", "typecheck"]);
run("npm", ["run", "build"]);
run("npm", ["run", "validate:plugin"]);
run("git", ["diff", "--check"]);

if (options.dryRun) {
  console.log("DRY_RUN_ONLY");
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
