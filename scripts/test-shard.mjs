#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { automaticTestEntries, compiledTestPath } from "./lib/test-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

export function validateShardPlan(map, plan, platform = "win32") {
  if (plan?.schema_version !== 1 || plan.platform !== platform) {
    throw new Error(`unsupported shard plan schema or platform: ${String(plan?.schema_version)} ${String(plan?.platform)}`);
  }
  if (!Array.isArray(plan.shards) || plan.shards.length !== 2) {
    throw new Error("Windows shard experiment requires exactly two shards");
  }
  const automatic = automaticTestEntries(map, platform, { includeStress: false }).map((entry) => entry.file).sort();
  const automaticSet = new Set(automatic);
  const seen = new Map();
  for (const shard of plan.shards) {
    if (!Number.isSafeInteger(shard.id) || shard.id < 1 || shard.id > 2) throw new Error(`invalid shard id: ${String(shard.id)}`);
    if (!Number.isFinite(shard.estimated_ms) || shard.estimated_ms <= 0) throw new Error(`invalid shard estimate: ${shard.id}`);
    if (!Array.isArray(shard.tests)) throw new Error(`shard ${shard.id} has no test list`);
    for (const item of shard.tests) {
      if (!automaticSet.has(item.file)) throw new Error(`shard ${shard.id} contains a non-automatic test: ${item.file}`);
      if (seen.has(item.file)) throw new Error(`test appears in shards ${seen.get(item.file)} and ${shard.id}: ${item.file}`);
      if (!Number.isFinite(item.estimated_ms) || item.estimated_ms <= 0) throw new Error(`invalid test estimate: ${item.file}`);
      seen.set(item.file, shard.id);
    }
  }
  const missing = automatic.filter((file) => !seen.has(file));
  if (missing.length > 0) throw new Error(`shard plan is missing tests: ${missing.join(", ")}`);
  const imbalance = Math.abs(plan.shards[0].estimated_ms - plan.shards[1].estimated_ms)
    / Math.max(plan.shards[0].estimated_ms, plan.shards[1].estimated_ms);
  if (imbalance > 0.15) throw new Error(`shards are not balanced: ${JSON.stringify(plan.shards.map((shard) => shard.estimated_ms))}`);
  return { automatic, seen, imbalance };
}

export function selectShard(plan, shardId, map = readJson("test/test-impact-map.json")) {
  validateShardPlan(map, plan);
  const shard = plan.shards.find((candidate) => candidate.id === shardId);
  if (!shard) throw new Error(`unknown shard: ${String(shardId)}`);
  return shard.tests.map((item) => compiledTestPath(item.file));
}

function parseShardArgument(args) {
  const direct = args.find((argument) => argument.startsWith("--shard="));
  if (direct) return direct.slice("--shard=".length);
  const index = args.indexOf("--shard");
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  if (process.platform !== "win32") throw new Error("the shard experiment is Windows-only");
  const value = parseShardArgument(process.argv.slice(2));
  const match = /^([12])\/2$/u.exec(value ?? "");
  if (!match) throw new Error("use --shard=1/2 or --shard=2/2");
  const plan = readJson("test/windows-test-shard-plan.json");
  const map = readJson("test/test-impact-map.json");
  const compiled = selectShard(plan, Number(match[1]), map);
  console.log(`WINDOWS_SHARD ${match[1]}/2 files=${compiled.length}`);
  if (process.argv.includes("--validate-only")) return;

  const build = spawnSync("npm", ["run", "build:test"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) process.exitCode = build.status ?? 1;
  else {
    const test = spawnSync(process.execPath, ["scripts/test-isolated.mjs", ...compiled], {
      cwd: repositoryRoot,
      env: { ...process.env, CODEX_BRIDGE_TEST_SHARD: `${match[1]}/2` },
      stdio: "inherit",
    });
    process.exitCode = test.status ?? 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
