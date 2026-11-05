#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { automaticTestEntries, compiledTestPath } from "./lib/test-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const map = JSON.parse(readFileSync(path.join(repositoryRoot, "test/test-impact-map.json"), "utf8"));
const args = process.argv.slice(2);
const requested = args.filter((argument) => argument.startsWith("--file=")).map((argument) => argument.slice("--file=".length));
const automaticFiles = new Set(automaticTestEntries(map).map((entry) => entry.file));
const registered = map.stress_tests.filter((entry) => automaticFiles.has(entry.file));
const stressTests = requested.length > 0
  ? registered.filter((entry) => requested.includes(entry.file))
  : registered;

if (requested.length > 0 && stressTests.length !== requested.length) {
  const known = new Set(registered.map((entry) => entry.file));
  const unknown = requested.filter((file) => !known.has(file));
  console.error(`Unknown stress test file(s): ${unknown.join(", ")}`);
  process.exitCode = 1;
} else if (stressTests.length === 0) {
  console.log("NO_STRESS_TESTS_REGISTERED");
} else {
  const compiled = stressTests.map((entry) => compiledTestPath(entry.file));
  console.log(`Registered stress tests:\n${compiled.map((file) => `- ${file}`).join("\n")}`);
  const build = spawnSync("npm", ["run", "build:test"], { cwd: repositoryRoot, stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
  } else {
    const test = spawnSync(process.execPath, ["scripts/test-isolated.mjs", ...compiled], { cwd: repositoryRoot, stdio: "inherit" });
    process.exitCode = test.status ?? 1;
  }
}
