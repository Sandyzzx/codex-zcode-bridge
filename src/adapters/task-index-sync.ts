/**
 * Best-effort registration of externally-created ZCode sessions in the
 * Desktop-owned tasks-index.sqlite. The ZCode session remains controlled by
 * Bridge; this module only mirrors its discoverability and coarse status.
 *
 * Adapted from william0wang/zcode-acp src/tasks-index.ts (Apache-2.0), with
 * changes for Bridge task correlation, custom ZCODE_HOME paths, schema checks,
 * and a narrow status update that never changes user-owned titles.
 */
import { existsSync } from "node:fs";

type DatabaseSyncCtor = (typeof import("node:sqlite"))["DatabaseSync"];
type Database = InstanceType<DatabaseSyncCtor>;

export type DesktopTaskStatus = "running" | "completed" | "error" | null;

export interface DesktopTaskIndexEntry {
  readonly databasePath: string;
  /** Project identity used by ZCode Desktop to group this task. */
  readonly workspaceKey: string;
  /** Effective directory used by the ZCode session (project root or the calling host-created worktree). */
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly bridgeTaskId: string;
  readonly title: string;
  readonly model: string | null;
  readonly provider: string;
  readonly mode: string;
}

let databaseSyncPromise: Promise<DatabaseSyncCtor | null> | null = null;

async function loadDatabaseSync(): Promise<DatabaseSyncCtor | null> {
  databaseSyncPromise ??= import("node:sqlite")
    .then((module) => module.DatabaseSync)
    .catch(() => null);
  return databaseSyncPromise;
}

/** Add a row without overwriting a row the ZCode Desktop already owns. */
export async function registerDesktopTask(entry: DesktopTaskIndexEntry): Promise<void> {
  await withDatabase(entry.databasePath, (database) => {
    requireTaskTable(database);
    const now = Date.now();
    const title = entry.title.trim().slice(0, 80) || entry.bridgeTaskId;
    const metaJson = JSON.stringify({
      taskId: entry.sessionId,
      traceId: entry.bridgeTaskId,
      title,
      titleOverridden: false,
      workspaceKey: entry.workspaceKey,
      workspacePath: entry.workspacePath,
      createdAt: now,
      updatedAt: now,
      mode: entry.mode,
      model: entry.model,
      provider: entry.provider,
      status: "running",
      target: null,
    });

    database.prepare(
      "INSERT OR IGNORE INTO tasks " +
        "(workspace_key, workspace_path, workspace_identity, task_id, " +
        "title, task_status, provider, mode, model, " +
        "created_at, updated_at, unread_at, pinned, archived, deleted, " +
        "title_overridden, meta_json, searchable_text) " +
        "VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, ?, ?)",
    ).run(
      entry.workspaceKey,
      entry.workspacePath,
      entry.sessionId,
      title,
      "running",
      entry.provider,
      entry.mode,
      entry.model,
      now,
      now,
      metaJson,
      entry.bridgeTaskId,
    );

    // A resumed session can already have a Bridge-owned row. Insert-or-ignore
    // preserves its identity, then refresh only its Bridge-owned status.
    if (!updateOwnedStatus(database, entry, "running")) {
      throw new Error("Desktop task row already exists and is not owned by this Bridge task");
    }
  });
}

/** Update only a row created by this Bridge task; never overwrite a collision. */
export async function updateDesktopTaskStatus(
  entry: DesktopTaskIndexEntry,
  status: DesktopTaskStatus,
): Promise<void> {
  await withDatabase(entry.databasePath, (database) => {
    requireTaskTable(database);
    if (!updateOwnedStatus(database, entry, status)) {
      throw new Error("Desktop task row is missing or is not owned by this Bridge task");
    }
  });
}

function updateOwnedStatus(
  database: Database,
  entry: DesktopTaskIndexEntry,
  status: DesktopTaskStatus,
): boolean {
  const row = database.prepare(
    "SELECT meta_json FROM tasks WHERE workspace_key = ? AND task_id = ?",
  ).get(entry.workspaceKey, entry.sessionId) as { meta_json?: unknown } | undefined;
  if (!row || typeof row.meta_json !== "string") return false;

  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.meta_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    meta = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (meta["traceId"] !== entry.bridgeTaskId || meta["taskId"] !== entry.sessionId) return false;

  const now = Date.now();
  meta["updatedAt"] = now;
  if (status === null) delete meta["status"];
  else meta["status"] = status;
  database.prepare(
    "UPDATE tasks SET task_status = ?, updated_at = ?, meta_json = ? " +
      "WHERE workspace_key = ? AND task_id = ?",
  ).run(status, now, JSON.stringify(meta), entry.workspaceKey, entry.sessionId);
  return true;
}

function requireTaskTable(database: Database): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name?: unknown }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const required = [
    "workspace_key", "workspace_path", "workspace_identity", "task_id", "title", "task_status",
    "provider", "mode", "model", "created_at", "updated_at", "unread_at", "pinned",
    "archived", "deleted", "title_overridden", "meta_json", "searchable_text",
  ];
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new Error(`ZCode tasks-index schema is missing columns: ${missing.join(", ")}`);
  }
}

async function withDatabase<T>(databasePath: string, operation: (database: Database) => T): Promise<T> {
  if (!existsSync(databasePath)) {
    throw new Error("ZCode Desktop tasks-index database does not exist");
  }
  const DatabaseSync = await loadDatabaseSync();
  if (!DatabaseSync) throw new Error("node:sqlite is unavailable in the Bridge runtime");

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let database: Database | null = null;
    try {
      database = new DatabaseSync(databasePath, { timeout: 1000 });
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (attempt < 2 && isDatabaseBusy(error)) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      throw error;
    } finally {
      database?.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ZCode tasks-index write failed");
}

function isDatabaseBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is (busy|locked)/i.test(message);
}
