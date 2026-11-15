#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_ARTIFACTS } from "./lib/generated-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = [...GENERATED_ARTIFACTS];

if (process.argv.includes("--list")) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(0);
}

if (artifacts.length === 0 || new Set(artifacts).size !== artifacts.length) {
  throw new Error("generated artifact inventory must be non-empty and unique");
}
for (const artifact of artifacts) {
  if (path.isAbsolute(artifact) || artifact.includes("\\") || artifact.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid generated artifact path: ${artifact}`);
  }
  if (!existsSync(path.join(root, artifact))) {
    throw new Error(`generated artifact is missing: ${artifact}`);
  }
}

const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", ...artifacts], {
  cwd: root,
  encoding: "utf8",
});
if (tracked.status !== 0) {
  throw new Error(`generated artifact is not tracked: ${tracked.stderr.trim()}`);
}

const changed = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...artifacts], {
  cwd: root,
  encoding: "utf8",
});
if (changed.error) throw changed.error;
if (changed.status !== 0) throw new Error(changed.stderr.trim() || `git status exited ${String(changed.status)}`);
if (changed.stdout.trim()) {
  throw new Error(
    `generated artifacts are stale after build:\n${changed.stdout.trim()}\n` +
    "Commit the rebuilt files with the source change.",
  );
}

console.log(`Generated artifacts are tracked and fresh (${String(artifacts.length)} files).`);
