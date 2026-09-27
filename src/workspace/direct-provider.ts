// DirectWorkspaceProvider per docs/ARCHITECTURE.md (frozen): resolves a
// requested workspace to a canonical existing directory. V0.1 does not create
// or delete workspaces; release is a no-op.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { WorkspaceProvider, WorkspaceRef } from "../interfaces.js";

export class DirectWorkspaceProvider implements WorkspaceProvider {
  async resolve(workspacePath: string, _taskId?: string, executionPath?: string): Promise<WorkspaceRef> {
    const projectPath = resolveExistingDirectory(workspacePath, "workspace");
    const execution = executionPath === undefined
      ? projectPath
      : resolveExistingDirectory(executionPath, "worktree_path");
    return {
      requestedPath: projectPath.canonicalPath,
      canonicalPath: execution.canonicalPath,
      mode: executionPath === undefined ? "direct" : "worktree",
      ...(executionPath === undefined ? {} : { sourcePath: projectPath.canonicalPath }),
    };
  }

  async release(_workspace: WorkspaceRef): Promise<void> {
    // Direct V0.1 release is a no-op (frozen contract): the provider never
    // creates or deletes the task workspace.
  }
}

function resolveExistingDirectory(input: string, field: string): { requestedPath: string; canonicalPath: string } {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (!path.isAbsolute(input)) throw new Error(`${field} must be an absolute path: ${input}`);
  let stat;
  try {
    stat = statSync(input);
  } catch {
    throw new Error(`${field} does not exist: ${input}`);
  }
  if (!stat.isDirectory()) throw new Error(`${field} is not a directory: ${input}`);
  try {
    return { requestedPath: input, canonicalPath: realpathSync(input) };
  } catch {
    throw new Error(`${field} could not be canonicalized: ${input}`);
  }
}
