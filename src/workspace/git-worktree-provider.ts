// Isolates every task in a task-specific Git worktree. The worktree is kept
// after completion so Codex can review it and decide how to integrate changes.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { WorkspaceProvider, WorkspaceRef } from "../interfaces.js";

export class GitWorktreeWorkspaceProvider implements WorkspaceProvider {
  readonly #dataRoot: string;
  readonly #worktreesRoot: string;

  constructor(dataRoot: string) {
    this.#dataRoot = path.resolve(dataRoot);
    this.#worktreesRoot = path.join(this.#dataRoot, ".tasks", "workspaces");
  }

  async resolve(workspacePath: string, taskId?: string): Promise<WorkspaceRef> {
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
      throw new Error("workspace must be a non-empty string");
    }
    if (!path.isAbsolute(workspacePath)) {
      throw new Error(`workspace must be an absolute Git repository path: ${workspacePath}`);
    }
    if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(taskId)) {
      throw new Error("a valid task_id is required to create an isolated Git worktree");
    }

    let sourcePath: string;
    try {
      sourcePath = realpathSync(workspacePath);
    } catch {
      throw new Error(`workspace does not exist: ${workspacePath}`);
    }
    const root = this.#git(sourcePath, ["rev-parse", "--show-toplevel"]).trim();
    const canonicalSource = realpathSync(root);
    const branchName = `codex-zcode/${taskId}`;
    const worktreePath = path.join(this.#worktreesRoot, taskId);

    if (existsSync(worktreePath)) {
      return this.#reuseExisting(canonicalSource, worktreePath, branchName);
    }

    mkdirSync(this.#worktreesRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.#worktreesRoot, 0o700);
    try {
      const baseCommit = this.#snapshotWorkingTree(canonicalSource);
      this.#git(canonicalSource, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
    } catch (error) {
      // Only remove a path created by this attempt; never clean an existing
      // user's directory after a failed Git invocation.
      if (existsSync(worktreePath) && !this.#isRegisteredWorktree(canonicalSource, worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      throw error;
    }
    const canonicalWorktree = realpathSync(worktreePath);
    return {
      requestedPath: workspacePath,
      sourcePath: canonicalSource,
      canonicalPath: canonicalWorktree,
      branchName,
      mode: "worktree",
    };
  }

  async release(workspace: WorkspaceRef): Promise<void> {
    if (workspace.mode !== "worktree" || !workspace.branchName || !workspace.sourcePath) return;
    const resolved = path.resolve(workspace.canonicalPath);
    const rel = path.relative(this.#worktreesRoot, resolved);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`refusing to remove worktree outside Bridge worktree root: ${resolved}`);
    }
    this.#git(workspace.sourcePath, ["worktree", "remove", "--force", resolved]);
    this.#git(workspace.sourcePath, ["branch", "-D", workspace.branchName]);
  }

  #reuseExisting(sourcePath: string, worktreePath: string, branchName: string): WorkspaceRef {
    let canonicalWorktree: string;
    try {
      canonicalWorktree = realpathSync(worktreePath);
    } catch {
      throw new Error(`task worktree path could not be canonicalized: ${worktreePath}`);
    }
    const actualRoot = realpathSync(this.#git(canonicalWorktree, ["rev-parse", "--show-toplevel"]).trim());
    if (actualRoot !== canonicalWorktree) {
      throw new Error(`existing task worktree path is not its own Git root: ${canonicalWorktree}`);
    }
    const actualBranch = this.#git(canonicalWorktree, ["branch", "--show-current"]).trim();
    if (actualBranch !== branchName) {
      throw new Error(`existing task worktree is on unexpected branch ${actualBranch || "(detached)"}`);
    }
    const sourceCommon = realpathSync(path.resolve(sourcePath, this.#git(sourcePath, ["rev-parse", "--git-common-dir"]).trim()));
    const worktreeCommon = realpathSync(path.resolve(canonicalWorktree, this.#git(canonicalWorktree, ["rev-parse", "--git-common-dir"]).trim()));
    if (sourceCommon !== worktreeCommon) {
      throw new Error("existing task worktree does not belong to the requested source repository");
    }
    return {
      requestedPath: sourcePath,
      sourcePath,
      canonicalPath: canonicalWorktree,
      branchName,
      mode: "worktree",
    };
  }

  #isRegisteredWorktree(sourcePath: string, worktreePath: string): boolean {
    try {
      const root = realpathSync(this.#git(worktreePath, ["rev-parse", "--show-toplevel"]).trim());
      const common = this.#git(sourcePath, ["rev-parse", "--git-common-dir"]).trim();
      const worktreeCommon = this.#git(worktreePath, ["rev-parse", "--git-common-dir"]).trim();
      return root === realpathSync(worktreePath) &&
        realpathSync(path.resolve(sourcePath, common)) === realpathSync(path.resolve(worktreePath, worktreeCommon));
    } catch {
      return false;
    }
  }

  #snapshotWorkingTree(sourcePath: string): string {
    const indexFile = path.join(os.tmpdir(), `codex-zcode-bridge-index-${randomUUID()}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: "Codex ZCode Bridge",
      GIT_AUTHOR_EMAIL: "codex-zcode-bridge@localhost",
      GIT_COMMITTER_NAME: "Codex ZCode Bridge",
      GIT_COMMITTER_EMAIL: "codex-zcode-bridge@localhost",
    };
    try {
      const head = this.#git(sourcePath, ["rev-parse", "HEAD"]);
      this.#git(sourcePath, ["read-tree", head.trim()], env);
      // Build a private index so dirty/staged/untracked source files are
      // included in the task's base without changing the user's real index.
      this.#git(sourcePath, ["add", "-A"], env);
      // Do not put common local credentials into the task snapshot. This is a
      // safety filter, not a complete secret scanner; users must still review
      // their workspace before delegating it to an agent.
      this.#git(sourcePath, [
        "rm", "-r", "--cached", "--ignore-unmatch", "--",
        ":(glob)**/.env", ":(glob)**/.env.*", ":(glob)**/.npmrc", ":(glob)**/.pypirc",
        ":(glob)**/credentials.json", ":(glob)**/secrets.json",
        ":(glob)**/*.pem", ":(glob)**/*.key", ":(glob)**/*.p12", ":(glob)**/*.pfx",
        ":(glob)**/.aws/**", ":(glob)**/.ssh/**",
      ], env);
      const tree = this.#git(sourcePath, ["write-tree"], env).trim();
      const headTree = this.#git(sourcePath, ["rev-parse", `${head.trim()}^{tree}`]).trim();
      if (tree === headTree) return head.trim();
      return this.#git(sourcePath, [
        "commit-tree", tree, "-p", head.trim(), "-m", "Codex ZCode Bridge task workspace snapshot",
      ], env).trim();
    } finally {
      rmSync(indexFile, { force: true });
      rmSync(`${indexFile}.lock`, { force: true });
    }
  }

  #git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
}
