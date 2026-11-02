import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the historical JSON-to-SQLite CLI refuses execution and has no supported npm entry", async () => {
  const cli = new URL("../src/cli/migrate-json-to-sqlite.js", import.meta.url);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [fileURLToPath(cli), "--apply", "--json-data-root", "C:\\must-not-be-read", "--sqlite-root", "C:\\must-not-be-written", "--backup-root", "C:\\must-not-be-created"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  const output = JSON.parse(Buffer.concat(stderr).toString("utf8")) as Record<string, unknown>;
  assert.equal(output.status, "blocked");
  assert.equal(output.error_code, "json_to_sqlite_migration_removed");

  const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.["migrate:json-to-sqlite"], undefined);
});
