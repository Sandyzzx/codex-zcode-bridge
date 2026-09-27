// DirectWorkspaceProvider per docs/ARCHITECTURE.md (frozen): resolves a
// requested workspace to a canonical existing directory. V0.1 does not create
// or delete workspaces; release is a no-op.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { WorkspaceProvider, WorkspaceRef } from "../interfaces.js";

export class DirectWorkspaceProvider implements WorkspaceProvider {
  async resolve(workspacePath: string, _taskId?: string): Promise<WorkspaceRef> {
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
      throw new Error("workspace must be a non-empty string");
    }
    if (!path.isAbsolute(workspacePath)) {
      throw new Error(`workspace must be an absolute path: ${workspacePath}`);
    }
    let stat;
    try {
      stat = statSync(workspacePath);
    } catch {
      throw new Error(`workspace does not exist: ${workspacePath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`workspace is not a directory: ${workspacePath}`);
    }
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(workspacePath);
    } catch {
      throw new Error(`workspace could not be canonicalized: ${workspacePath}`);
    }
    return { requestedPath: workspacePath, canonicalPath, mode: "direct" };
  }

  async release(_workspace: WorkspaceRef): Promise<void> {
    // Direct V0.1 release is a no-op (frozen contract): the provider never
    // creates or deletes the task workspace.
  }
}
