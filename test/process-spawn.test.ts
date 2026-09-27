// Real (local, model-free) process-tree termination test for Windows. Spawns a
// Node parent that spawns its own sleeper child, then verifies that
// terminateProcessTree kills the entire verified tree. Skipped on non-Windows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isProcessRunning, terminateProcessTree } from "../src/adapters/process-spawn.js";

test("terminateProcessTree kills a real Windows process tree and verifies it", { timeout: 30_000 }, async () => {
  if (process.platform !== "win32") {
    return test.skip("Windows-only process tree semantics");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-bridge-tree-"));
  try {
    const parentScript = path.join(dir, "parent.cjs");
    writeFileSync(
      parentScript,
      [
        '"use strict";',
        "const { spawn } = require('node:child_process');",
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "console.log(String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    const parent = spawn(process.execPath, [parentScript], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      parent.stdout?.setEncoding("utf8");
      parent.stdout?.on("data", (chunk: string) => {
        const pid = Number.parseInt(chunk.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) resolve(pid);
      });
      parent.on("error", reject);
      setTimeout(() => reject(new Error("parent did not report its child pid")), 10_000);
    });
    assert.ok(parent.pid);
    assert.ok(isProcessRunning(parent.pid), "parent must be alive before termination");
    assert.ok(isProcessRunning(grandchildPid), "grandchild must be alive before termination");

    const result = await terminateProcessTree(parent.pid, { graceMs: 500, killWaitMs: 5_000 });
    assert.equal(result.verified, true);
    assert.equal(isProcessRunning(parent.pid), false, "parent must be dead after termination");
    assert.equal(isProcessRunning(grandchildPid), false, "grandchild must be dead after termination");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminateProcessTree rejects non-positive PIDs", async () => {
  await assert.rejects(terminateProcessTree(0), /positive integer PID/);
  await assert.rejects(terminateProcessTree(-5), /positive integer PID/);
});
