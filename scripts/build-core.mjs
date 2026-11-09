import { copyFileSync, mkdtempSync, mkdirSync, existsSync, realpathSync, renameSync, rmSync } from "node:fs";
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

// Windows Defender can briefly hold a freshly emitted tree open. This retry is
// only for transient EPERM; every other rename failure stays immediately visible.
function renameWithTransientEpermRetry(source, destination) {
  const backoff = new Int32Array(new SharedArrayBuffer(4));
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM") throw error;
      Atomics.wait(backoff, 0, 0, 10 * (attempt + 1));
    }
  }
  throw lastError;
}
try {
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const run = spawnSync(process.execPath, [compiler, "--project", path.join(root, "tsconfig.json"), "--outDir", staging], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) throw new Error(`core compilation failed (${String(run.status)})`);
  copyFileSync(
    path.join(root, "src", "store", "json-history-result-exceptions.mjs"),
    path.join(staging, "src", "store", "json-history-result-exceptions.mjs"),
  );
  copyFileSync(
    path.join(root, "src", "sqlite-candidate", "wp6b2b1", "schema.sql"),
    path.join(staging, "src", "sqlite-candidate", "wp6b2b1", "schema.sql"),
  );
  copyFileSync(
    path.join(root, "src", "sqlite-candidate", "wp6b2b1", "admin-abandonment.sql"),
    path.join(staging, "src", "sqlite-candidate", "wp6b2b1", "admin-abandonment.sql"),
  );
  copyFileSync(path.join(root,'src/sqlite-candidate/wp6b2b1/schema-v13.sql'),path.join(staging,'src/sqlite-candidate/wp6b2b1/schema-v13.sql'));
  mkdirSync(output, { recursive: true });
  // Reject an output junction escaping the named workspace before any move.
  if (realpathSync(output) !== output || (existsSync(target) && realpathSync(target) !== target)) throw new Error("core output must be a real directory inside the repository");
  if (existsSync(target)) renameWithTransientEpermRetry(target, backup);
  try { renameWithTransientEpermRetry(path.join(staging, "src"), target); replaced = true; }
  catch (error) { if (existsSync(backup)) renameWithTransientEpermRetry(backup, target); throw error; }
} finally {
  // staging is generated under the verified repository root, including backup.
  if (path.dirname(staging) !== root || realpathSync(staging) !== staging) throw new Error("unexpected core staging path");
  rmSync(staging, { recursive: true, force: true });
}
if (replaced) console.log("Built fresh core modules and declarations; stale outputs removed.");
