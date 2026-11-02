import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureSpawnGenerationIdentity, createPlatformProbe, isProcessRunning, verifyProcessTreeClaimantsClean } from "../src/adapters/process-spawn.js";

test("recorded-tree claimant scan observes a real Windows descendant after root exit", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only native process identity and CIM semantics");

  const dir = mkdtempSync(path.join(tmpdir(), "bridge-native-claimant-"));
  const membersPath = path.join(dir, "members.json");
  const childExitPath = path.join(dir, "child.exit.json");
  const grandchildExitPath = path.join(dir, "grandchild.exit.json");
  const rootRelease = path.join(dir, "root.release");
  const treeRelease = path.join(dir, "tree.release");
  const grandchildScript = path.join(dir, "grandchild.cjs");
  const childScript = path.join(dir, "child.cjs");
  const rootScript = path.join(dir, "root.cjs");

  writeFileSync(grandchildScript, [
    "const fs = require('node:fs');",
    `const exitRecord = ${JSON.stringify(grandchildExitPath)};`,
    `const release = ${JSON.stringify(treeRelease)};`,
    "process.on('exit', (code) => fs.writeFileSync(exitRecord, JSON.stringify({ code })));",
    "function tick() { if (fs.existsSync(release)) process.exit(0); setTimeout(tick, 25); }",
    "tick(); setInterval(() => {}, 1000);",
  ].join("\n"));
  writeFileSync(childScript, [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const exitRecord = ${JSON.stringify(childExitPath)};`,
    `const release = ${JSON.stringify(treeRelease)};`,
    `const grandchild = ${JSON.stringify(grandchildScript)};`,
    `const members = ${JSON.stringify(membersPath)};`,
    "process.on('exit', (code) => fs.writeFileSync(exitRecord, JSON.stringify({ code })));",
    "const child = spawn(process.execPath, [grandchild], { stdio: 'ignore', windowsHide: true, detached: true });",
    "let grandchildClosed = false;",
    "let grandchildExitCode = null;",
    "let treeReleased = false;",
    "child.once('close', (code) => { grandchildClosed = true; grandchildExitCode = code; if (treeReleased) process.exit(code === 0 ? 0 : 1); });",
    "fs.writeFileSync(members, JSON.stringify({ child: process.pid, grandchild: child.pid }));",
    "function tick() { if (fs.existsSync(release)) { treeReleased = true; if (grandchildClosed) process.exit(grandchildExitCode === 0 ? 0 : 1); return; } setTimeout(tick, 25); }",
    "tick(); setInterval(() => {}, 1000);",
  ].join("\n"));
  writeFileSync(rootScript, [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const members = ${JSON.stringify(membersPath)};`,
    `const release = ${JSON.stringify(rootRelease)};`,
    `const child = ${JSON.stringify(childScript)};`,
    "spawn(process.execPath, [child], { stdio: 'ignore', windowsHide: true, detached: true });",
    "function ready() { if (fs.existsSync(members)) { process.stdout.write(fs.readFileSync(members, 'utf8') + '\\n'); waitExit(); return; } setTimeout(ready, 20); }",
    "function waitExit() { if (fs.existsSync(release)) { process.exit(0); return; } setTimeout(waitExit, 20); }",
    "ready(); setInterval(() => {}, 1000);",
  ].join("\n"));

  const root = spawn(process.execPath, [rootScript], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const rootPid = root.pid ?? 0;
  let childPid = 0;
  let grandchildPid = 0;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let rootFingerprint: string | null = null;
  const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${description}`);
  };
  const rootClosed = new Promise<void>((resolve, reject) => {
    root.once("close", (code, signal) => { rootExit = { code, signal }; resolve(); });
    root.once("error", reject);
  });

  try {
    assert.ok(rootPid > 0, "fixture root has a pid");
    let output = "";
    const receipt = new Promise<{ child: number; grandchild: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture member receipt timed out")), 12_000);
      root.stdout?.setEncoding("utf8");
      root.stdout?.on("data", (chunk: string) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(output.slice(0, newline)) as { child: number; grandchild: number });
      });
      root.once("close", () => { clearTimeout(timer); reject(new Error("root exited before fixture receipt")); });
      root.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const members = await receipt;
    childPid = members.child;
    grandchildPid = members.grandchild;
    assert.ok(childPid > 0 && grandchildPid > 0);
    assert.ok(isProcessRunning(rootPid) && isProcessRunning(childPid) && isProcessRunning(grandchildPid));

    const probe = createPlatformProbe();
    const rootIdentity = await captureSpawnGenerationIdentity(root, probe);
    const childIdentity = await probe.identityOf(childPid);
    const grandchildIdentity = await probe.identityOf(grandchildPid);
    assert.ok(rootIdentity, "root identity is captured from its original ChildProcess generation");
    assert.equal(childIdentity.fingerprint_precision, "exact");
    assert.equal(grandchildIdentity.fingerprint_precision, "exact");
    rootFingerprint = rootIdentity.fingerprint;
    assert.ok(rootFingerprint);
    assert.ok(childIdentity.fingerprint && grandchildIdentity.fingerprint);
    t.diagnostic(JSON.stringify({
      root: { pid: rootPid, creationTicks: rootIdentity.fingerprint },
      child: { pid: childPid, creationTicks: childIdentity.fingerprint },
      grandchild: { pid: grandchildPid, creationTicks: grandchildIdentity.fingerprint },
    }));

    writeFileSync(rootRelease, "release");
    await rootClosed;
    await waitFor(() => !isProcessRunning(rootPid), "root exit");
    assert.ok(isProcessRunning(childPid) && isProcessRunning(grandchildPid), "descendants remain after root exit");
    const whileDescendantsLive = await verifyProcessTreeClaimantsClean([{ pid: rootPid, fingerprint: rootFingerprint }]);
    assert.equal(whileDescendantsLive.clean, false);
    assert.ok(whileDescendantsLive.livePids.includes(childPid));
    assert.ok(whileDescendantsLive.livePids.includes(grandchildPid));
    t.diagnostic(JSON.stringify({ rootExitedScan: whileDescendantsLive }));

    writeFileSync(treeRelease, "release");
    await waitFor(() => !isProcessRunning(childPid) && !isProcessRunning(grandchildPid), "descendant exits");
    const afterAllExit = await verifyProcessTreeClaimantsClean([{ pid: rootPid, fingerprint: rootFingerprint }]);
    assert.equal(afterAllExit.clean, true);
    assert.deepEqual(afterAllExit.livePids, []);
    const childExit = JSON.parse(readFileSync(childExitPath, "utf8")) as { code: number };
    const grandchildExit = JSON.parse(readFileSync(grandchildExitPath, "utf8")) as { code: number };
    assert.deepEqual(rootExit, { code: 0, signal: null });
    assert.equal(childExit.code, 0);
    assert.equal(grandchildExit.code, 0);
    t.diagnostic(JSON.stringify({ allExitedScan: afterAllExit, exits: { root: rootExit, child: childExit, grandchild: grandchildExit } }));
  } finally {
    try { writeFileSync(rootRelease, "release"); } catch { /* fixture may not have started */ }
    try { writeFileSync(treeRelease, "release"); } catch { /* fixture may not have started */ }
    for (const pid of [rootPid, childPid, grandchildPid]) {
      if (pid > 0) await waitFor(() => !isProcessRunning(pid), `owned fixture pid ${pid} cleanup`).catch(() => undefined);
    }
    const leftovers = [rootPid, childPid, grandchildPid].filter((pid) => pid > 0 && isProcessRunning(pid));
    if (leftovers.length > 0) throw new Error(`Owned fixture processes remain; preserved ${dir}: ${leftovers.join(",")}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
