import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { tryAcquireProcessLock } from "../src/store/process-lock.js";

test("crashing during lock retirement cannot strand an ownerless shared lock", { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lock-retire-"));
  try {
    const lock = path.join(root, "recovery.lock");
    const script = path.join(root, "crash-on-unlink.mjs");
    writeFileSync(script, [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const { tryAcquireProcessLock } = await import(${JSON.stringify(new URL("../src/store/process-lock.js", import.meta.url).href)});`,
      `const release = tryAcquireProcessLock(${JSON.stringify(lock)});`,
      'if (!release) process.exit(2);',
      // Exit immediately before deleting owner.json. With unlink-before-rename
      // this leaves the shared lock stranded; retirement keeps it private.
      'fs.unlinkSync = () => process.exit(0);',
      'syncBuiltinESMExports();',
      'release();',
      'process.exit(3);',
    ].join("\n"));
    const crashed = spawnSync(process.execPath, [script], { timeout: 10_000, windowsHide: true });
    assert.equal(crashed.status, 0, crashed.stderr.toString());
    assert.equal(existsSync(lock), false, "complete lock must be withdrawn before owner deletion");
    assert.ok(readdirSync(root).some((name) => name.endsWith(".retired")), "interrupted cleanup stays private");
    const release = tryAcquireProcessLock(lock);
    assert.ok(release, "a new owner can acquire after the crash");
    release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
