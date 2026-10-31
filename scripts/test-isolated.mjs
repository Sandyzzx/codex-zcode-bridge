import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  const args = process.argv.slice(2);
  // The schema suite stays in source form because it imports the candidate
  // store directly. Keep it in the default CI entry without duplicating it.
  if (args.every((arg) => arg.startsWith("--"))) {
    args.push("dist-test/test/*.test.js", "test/sqlite-candidate/wp6b2b1/schema-integrity.test.mjs");
  }
  // Windows lifecycle suites share full-system CIM scans and disk-heavy lock
  // fixtures. Serialize files without changing assertions or test coverage.
  if (process.platform === "win32" && !args.some((arg) => arg.startsWith("--test-concurrency"))) args.unshift("--test-concurrency=1");
  const result = spawnSync(process.execPath, ["--test", ...args], { env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  // Cleanup is best-effort: an OS handle race must not mask the test exit code.
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* retained for the CI temp lifecycle */ }
}
