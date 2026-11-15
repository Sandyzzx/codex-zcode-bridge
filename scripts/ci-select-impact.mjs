#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { changedFiles } from "./lib/changed-files.mjs";
import { automaticTestEntries } from "./lib/test-files.mjs";
import { selectAffectedTests } from "./test-impact-selector.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function selectCiImpact({ files, map, forceFull = false }) {
  const selection = selectAffectedTests({ changedFiles: files, map, platform: "win32", forceFull });

  const fullTests = new Set(
    automaticTestEntries(map, "win32", { includeStress: true }).map((entry) => entry.file),
  );
  const selectedFiles = selection.selected_tests.map((entry) => entry.file);
  for (const file of selectedFiles) {
    if (!fullTests.has(file)) {
      throw new Error(`impact selection includes an entry outside the full suite: ${file}`);
    }
  }
  if (selection.mode === "FULL_SUITE") {
    const expected = automaticTestEntries(map, "win32", { includeStress: false })
      .map((entry) => entry.file)
      .sort();
    const actual = selection.selected_tests
      .filter((entry) => !entry.stress)
      .map((entry) => entry.file)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("FULL_SUITE selection does not shadow-compare equal to the complete functional suite");
    }
  }

  const integrationRequired = selection.mode === "FULL_SUITE"
    || selection.selected_tests.some((entry) => (
      entry.type === "Integration" || entry.type === "Stress" || entry.stress !== undefined
    ));
  const stressRequired = selection.stress_mode === "STRESS_TEST_REQUIRED";

  return {
    affected_mode: selection.mode,
    changed_file_count: selection.changed_files.length,
    selected_test_count: selectedFiles.length,
    selected_test_files: selectedFiles,
    affected_domains: selection.affected_domains,
    force_full: forceFull,
    full_required: selection.mode === "FULL_SUITE",
    integration_required: integrationRequired,
    stress_required: stressRequired,
  };
}

function parseArgs(argv) {
  const options = { base: undefined, head: "HEAD", forceFull: false, githubOutput: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") {
      options.base = argv[++index];
      if (!options.base) throw new Error("--base requires a Git revision");
    }
    else if (argv[index] === "--head") options.head = argv[++index];
    else if (argv[index] === "--force-full") options.forceFull = true;
    else if (argv[index] === "--github-output") options.githubOutput = true;
    else throw new Error(`unknown option: ${argv[index]}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const forceFull = options.forceFull
    || !options.base
    || /^0+$/u.test(options.base);
  const files = forceFull
    ? []
    : changedFiles({
        root: repositoryRoot,
        base: options.base,
        head: options.head,
        includeWorktree: false,
      });
  const map = JSON.parse(readFileSync(path.join(repositoryRoot, "test/test-impact-map.json"), "utf8"));
  const impact = selectCiImpact({ files, map, forceFull });
  const text = JSON.stringify(impact, null, 2);

  if (options.githubOutput) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) throw new Error("GITHUB_OUTPUT is required with --github-output");
    const output = [
      `affected_mode=${impact.affected_mode}`,
      `changed_file_count=${String(impact.changed_file_count)}`,
      `selected_test_count=${String(impact.selected_test_count)}`,
      `full_required=${String(impact.full_required)}`,
      `force_full=${String(impact.force_full)}`,
      `integration_required=${String(impact.integration_required)}`,
      `stress_required=${String(impact.stress_required)}`,
    ].join("\n");
    appendFileSync(outputPath, `${output}\n`, "utf8");
  }
  console.log(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
