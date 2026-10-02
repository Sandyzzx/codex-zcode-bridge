import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Every test process and detached fixture inherits a disposable home.
const home = mkdtempSync(path.join(tmpdir(), "bridge-test-home-"));
const env = { ...process.env, HOME: home, USERPROFILE: home };
for (const key of Object.keys(env)) if (key.startsWith("ZCODE_")) delete env[key];
try {
  const args = process.argv.slice(2);
  if (args.every((arg) => arg.startsWith("--"))) args.push("dist-test/test/*.test.js");
  const result = spawnSync(process.execPath, ["--test", ...args], { env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { rmSync(home, { recursive: true, force: true }); }
