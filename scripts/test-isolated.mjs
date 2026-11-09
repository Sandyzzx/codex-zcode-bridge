import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { automaticTestEntries, compiledTestPath } from "./lib/test-files.mjs";

const map = JSON.parse(readFileSync(new URL("../test/test-impact-map.json", import.meta.url), "utf8"));
const requestedArgs = process.argv.slice(2);
const requestedFiles = requestedArgs.filter((arg) => !arg.startsWith("--"));
const automatic = automaticTestEntries(map, process.platform, { includeStress: requestedFiles.length > 0 }).map((entry) => compiledTestPath(entry.file)).sort();
for (const file of requestedFiles) {
  if (!automatic.includes(file.replaceAll("\\", "/").replace(/^\.\//u, ""))) {
    throw new Error(`Not an automatic test for ${process.platform}: ${file}. Manual E2E and fixtures require their explicit entrypoints.`);
  }
}
const testFiles = requestedFiles.length ? requestedFiles : automatic;
if (requestedArgs.includes("--list")) {
  console.log(JSON.stringify(testFiles, null, 2));
  process.exit(0);
}
if (process.platform !== "win32") {
  const excluded = map.tests.filter((entry) => entry.gate !== "MANUAL_E2E" && entry.type !== "Fixture"
    && !automatic.includes(compiledTestPath(entry.file))).map((entry) => entry.file);
  console.log(`[isolated] Windows-only exclusions: ${excluded.join(", ")}`);
}

// Every test process and detached fixture inherits a disposable home. Git's
// worktree fixtures also get a short root so a caller's long worktree path
// cannot turn a supported command into a Windows path-length experiment.
const fixtureBase = process.env.WP6_TEST_FIXTURE_ROOT?.trim()
  || (process.platform === "win32" ? path.join(process.cwd(), ".run", "test-fixtures") : tmpdir());
if (!path.isAbsolute(fixtureBase)) throw new Error("WP6_TEST_FIXTURE_ROOT must be an absolute path");
mkdirSync(fixtureBase, { recursive: true });
const fixtureRoot = mkdtempSync(path.join(fixtureBase, "bridge-test-suite-"));
const home = path.join(fixtureRoot, "home");
const schemaFixtureRoot = path.join(fixtureRoot, "schema");
const tempRoot = path.join(fixtureRoot, "temp");
for (const directory of [home, schemaFixtureRoot, tempRoot]) mkdirSync(directory, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  TEMP: tempRoot,
  TMP: tempRoot,
  TMPDIR: tempRoot,
  WP6_SCHEMA_TEST_ROOT: schemaFixtureRoot,
  WP6_TEST_FIXTURE_ROOT: fixtureRoot,
};
for (const key of Object.keys(env)) if (key.startsWith("ZCODE_")) delete env[key];

try {
  const args = [...requestedArgs.filter((arg) => arg.startsWith("--")), ...testFiles];
  // Windows lifecycle suites share full-system CIM scans and disk-heavy lock
  // fixtures. Serialize files without changing assertions or test coverage.
  if (process.platform === "win32" && !args.some((arg) => arg.startsWith("--test-concurrency"))) args.unshift("--test-concurrency=1");
  const result = spawnSync(process.execPath, ["--test", ...args], { env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  // Cleanup is best-effort: an OS handle race must not mask the test exit code.
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* retained for the CI temp lifecycle */ }
}
