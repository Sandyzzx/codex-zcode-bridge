// DirectWorkspaceProvider tests: absolute/existing/directory validation,
// canonicalization, and the no-op release contract.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { makeTempDir, removeTempDir } from "./helpers.js";

test("resolves an existing absolute directory to a canonical ref", async () => {
  const dir = await makeTempDir("ws 中文 dir");
  try {
    const provider = new DirectWorkspaceProvider();
    const ref = await provider.resolve(dir);
    assert.equal(ref.requestedPath, dir);
    assert.ok(path.isAbsolute(ref.canonicalPath));
    assert.equal(ref.mode, "direct");
    assert.ok(existsSync(ref.canonicalPath));
  } finally {
    await removeTempDir(dir);
  }
});

test("rejects relative, missing, and file paths with clear errors", async () => {
  const provider = new DirectWorkspaceProvider();
  await assert.rejects(provider.resolve("relative/path"), /absolute/);
  await assert.rejects(provider.resolve(""), /non-empty/);
  const root = await makeTempDir("ws-missing");
  try {
    const missing = path.join(root, "does-not-exist");
    await assert.rejects(provider.resolve(missing), /does not exist/);
    const filePath = path.join(root, "file.txt");
    writeFileSync(filePath, "x", "utf8");
    await assert.rejects(provider.resolve(filePath), /not a directory/);
  } finally {
    await removeTempDir(root);
  }
});

test("release is a no-op and never deletes the workspace", async () => {
  const dir = await makeTempDir("ws-release");
  try {
    const provider = new DirectWorkspaceProvider();
    const ref = await provider.resolve(dir);
    await provider.release(ref);
    assert.ok(existsSync(ref.canonicalPath), "release must not delete the workspace");
  } finally {
    await removeTempDir(dir);
  }
});
