import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { GitWorktreeWorkspaceProvider } from "../src/workspace/git-worktree-provider.js";
import { makeTempDir, removeTempDir } from "./helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

test("snapshots dirty source files into an isolated task worktree and reuses it", async () => {
  const root = await makeTempDir("bridge-worktree-test");
  const source = path.join(root, "source");
  // Mirrors the default deployment where Bridge data and the source repo are
  // the same directory, so worktrees are created under its ignored .tasks/.
  const dataRoot = source;
  const taskId = "task_worktree";
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(source, { recursive: true }));
    git(source, "init");
    git(source, "config", "user.name", "Test User");
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "core.autocrlf", "false");
    writeFileSync(path.join(source, "base.txt"), "committed\n", "utf8");
    writeFileSync(path.join(source, ".gitignore"), ".tasks/\n", "utf8");
    git(source, "add", "base.txt", ".gitignore");
    git(source, "commit", "-m", "initial");

    writeFileSync(path.join(source, "base.txt"), "local edit\n", "utf8");
    writeFileSync(path.join(source, "untracked.txt"), "local untracked\n", "utf8");
    const sourceStatusBefore = git(source, "status", "--porcelain", "--untracked-files=all");

    const provider = new GitWorktreeWorkspaceProvider(dataRoot);
    const workspace = await provider.resolve(source, taskId);
    assert.equal(workspace.mode, "worktree");
    assert.equal(workspace.sourcePath, source);
    assert.equal(workspace.branchName, `codex-zcode/${taskId}`);
    assert.notEqual(workspace.canonicalPath, source);
    assert.equal(readFileSync(path.join(workspace.canonicalPath, "base.txt"), "utf8").replace(/\r\n/g, "\n"), "local edit\n");
    assert.equal(readFileSync(path.join(workspace.canonicalPath, "untracked.txt"), "utf8").replace(/\r\n/g, "\n"), "local untracked\n");
    assert.equal(git(source, "status", "--porcelain", "--untracked-files=all"), sourceStatusBefore);

    writeFileSync(path.join(workspace.canonicalPath, "agent.txt"), "agent change\n", "utf8");
    const resumed = await provider.resolve(source, taskId);
    assert.equal(resumed.canonicalPath, workspace.canonicalPath);
    assert.equal(readFileSync(path.join(resumed.canonicalPath, "agent.txt"), "utf8"), "agent change\n");

    await provider.release(workspace);
    assert.equal(existsSync(workspace.canonicalPath), false);
    const branchCheck = spawnSync("git", ["-C", source, "show-ref", "--verify", `refs/heads/${workspace.branchName}`], {
      encoding: "utf8",
      stdio: "ignore",
      windowsHide: true,
    });
    assert.notEqual(branchCheck.status, 0);
  } finally {
    await removeTempDir(root);
  }
});

test("rejects non-Git workspaces and invalid task identifiers", async () => {
  const root = await makeTempDir("bridge-worktree-invalid");
  try {
    const provider = new GitWorktreeWorkspaceProvider(path.join(root, "data"));
    await assert.rejects(provider.resolve(root, "task_valid"), /not a git repository|fatal/i);
    await assert.rejects(provider.resolve(root, "../bad"), /valid task_id/);
  } finally {
    await removeTempDir(root);
  }
});

test("excludes common credential files from the task snapshot without changing the source index", async () => {
  const root = await makeTempDir("bridge-worktree-secrets");
  const source = path.join(root, "source");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(source, { recursive: true }));
    git(source, "init");
    git(source, "config", "user.name", "Test User");
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "core.autocrlf", "false");
    writeFileSync(path.join(source, ".gitignore"), ".tasks/\n", "utf8");
    writeFileSync(path.join(source, "app.txt"), "source\n", "utf8");
    git(source, "add", ".gitignore", "app.txt");
    git(source, "commit", "-m", "initial");
    writeFileSync(path.join(source, ".env"), "SECRET=do-not-snapshot\n", "utf8");
    writeFileSync(path.join(source, "app.txt"), "changed source\n", "utf8");
    const sourceStatusBefore = git(source, "status", "--porcelain", "--untracked-files=all");

    const provider = new GitWorktreeWorkspaceProvider(source);
    const workspace = await provider.resolve(source, "task_secret_filter");
    assert.equal(existsSync(path.join(workspace.canonicalPath, ".env")), false);
    assert.equal(readFileSync(path.join(workspace.canonicalPath, "app.txt"), "utf8"), "changed source\n");
    assert.equal(git(source, "status", "--porcelain", "--untracked-files=all"), sourceStatusBefore);
    await provider.release(workspace);
  } finally {
    await removeTempDir(root);
  }
});
