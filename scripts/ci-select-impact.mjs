#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { changedFiles } from "./lib/changed-files.mjs";
import { automaticTestEntries } from "./lib/test-files.mjs";
import { pathMatchesAny, selectAffectedTests } from "./test-impact-selector.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function selectCiImpact({ files, map, forceFull = false }) {
  const selection = selectAffectedTests({ changedFiles: files, map, platform: "win32", forceFull });
  const tracks = map.ci_tracks;
  if (!tracks) throw new Error("test impact map is missing ci_tracks");

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

  const normalizedFiles = selection.changed_files;
  const matchingFiles = (track) => normalizedFiles.filter((file) => pathMatchesAny(file, track.paths));
  const selectorFiles = matchingFiles(tracks.selector_contract);
  const workflowFiles = matchingFiles(tracks.workflow_contract);
  const costLabFiles = matchingFiles(tracks.cost_lab);
  const sharedFiles = matchingFiles(tracks.shared_dependencies);
  const bridgePathFiles = matchingFiles(tracks.bridge).filter((file) => (
    !pathMatchesAny(file, tracks.selector_contract.paths)
    && !pathMatchesAny(file, tracks.workflow_contract.paths)
  ));
  const unroutedFiles = normalizedFiles.filter((file) => !Object.values(tracks).some((track) => (
    pathMatchesAny(file, track.paths)
  )));

  const selectorRequired = forceFull || selectorFiles.length > 0 || workflowFiles.length > 0;
  const workflowRequired = forceFull || workflowFiles.length > 0;
  const costLabRequired = forceFull
    || costLabFiles.length > 0
    || (sharedFiles.length > 0 && tracks.shared_dependencies.requires_cost_lab === true);
  const sharedRuntimeRequired = forceFull || sharedFiles.length > 0;
  const costLabWebRequired = forceFull
    || normalizedFiles.some((file) => pathMatchesAny(file, tracks.cost_lab.web_paths));
  const bridgeFullRequired = forceFull
    || selection.mode === "FULL_SUITE"
    || normalizedFiles.some((file) => pathMatchesAny(file, tracks.bridge.full_paths))
    || unroutedFiles.length > 0;
  const bridgeRequired = bridgeFullRequired
    || bridgePathFiles.length > 0
    || sharedFiles.length > 0;
  const bridgeMode = bridgeRequired
    ? bridgeFullRequired ? "FULL" : "TARGETED"
    : "NONE";
  const selectedIntegration = selection.selected_tests.some((entry) => (
    entry.type === "Integration" || entry.type === "Stress" || entry.stress !== undefined
  ));
  const integrationRequired = bridgeMode === "FULL"
    || (bridgeMode === "TARGETED" && selectedIntegration);
  const stressRequired = forceFull
    || selection.stress_mode === "STRESS_TEST_REQUIRED"
    || (sharedFiles.length > 0 && tracks.shared_dependencies.requires_stress === true);
  const docsRequired = forceFull
    || normalizedFiles.some((file) => pathMatchesAny(file, tracks.documentation.paths));
  const fullRequired = bridgeMode === "FULL";
  const bridgeFullReasons = [...new Set([
    ...(forceFull ? ["forced-full"] : []),
    ...(selection.mode === "FULL_SUITE" ? selection.full_suite_reasons : []),
    ...normalizedFiles
      .filter((file) => pathMatchesAny(file, tracks.bridge.full_paths))
      .map((file) => `bridge-full-path:${file}`),
    ...unroutedFiles.map((file) => `unrouted-path:${file}`),
  ])].sort();

  return {
    affected_mode: selection.mode,
    changed_file_count: selection.changed_files.length,
    selected_test_count: selectedFiles.length,
    selected_test_files: selectedFiles,
    affected_domains: selection.affected_domains,
    force_full: forceFull,
    full_required: fullRequired,
    bridge_required: bridgeRequired,
    bridge_mode: bridgeMode,
    bridge_full_required: bridgeMode === "FULL",
    bridge_targeted_required: bridgeMode === "TARGETED",
    bridge_full_reasons: bridgeFullReasons,
    cost_lab_required: costLabRequired,
    cost_lab_mode: costLabRequired ? "REQUIRED" : "NONE",
    cost_lab_web_required: costLabWebRequired,
    shared_runtime_required: sharedRuntimeRequired,
    selector_required: selectorRequired,
    workflow_required: workflowRequired,
    docs_required: docsRequired,
    integration_required: integrationRequired,
    stress_required: stressRequired,
    unrouted_files: unroutedFiles,
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
      `bridge_required=${String(impact.bridge_required)}`,
      `bridge_mode=${impact.bridge_mode}`,
      `bridge_full_required=${String(impact.bridge_full_required)}`,
      `bridge_targeted_required=${String(impact.bridge_targeted_required)}`,
      `cost_lab_required=${String(impact.cost_lab_required)}`,
      `cost_lab_mode=${impact.cost_lab_mode}`,
      `cost_lab_web_required=${String(impact.cost_lab_web_required)}`,
      `shared_runtime_required=${String(impact.shared_runtime_required)}`,
      `selector_required=${String(impact.selector_required)}`,
      `workflow_required=${String(impact.workflow_required)}`,
      `docs_required=${String(impact.docs_required)}`,
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
