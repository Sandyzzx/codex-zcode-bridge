import { mkdtempSync, mkdirSync, existsSync, realpathSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const staging = mkdtempSync(path.join(root, ".build-core-"));
const output = path.join(root, "dist");
const target = path.join(output, "src");
const backup = path.join(staging, "previous-src");
let replaced = false;
try {
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const run = spawnSync(process.execPath, [compiler, "--project", path.join(root, "tsconfig.json"), "--outDir", staging], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) throw new Error(`core compilation failed (${String(run.status)})`);
  mkdirSync(output, { recursive: true });
  // Reject an output junction escaping the named workspace before any move.
  if (realpathSync(output) !== output || (existsSync(target) && realpathSync(target) !== target)) throw new Error("core output must be a real directory inside the repository");
  if (existsSync(target)) renameSync(target, backup);
  try { renameSync(path.join(staging, "src"), target); replaced = true; }
  catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
} finally {
  // staging is generated under the verified repository root, including backup.
  if (path.dirname(staging) !== root || realpathSync(staging) !== staging) throw new Error("unexpected core staging path");
  rmSync(staging, { recursive: true, force: true });
}
if (replaced) console.log("Built fresh core modules and declarations; stale outputs removed.");
