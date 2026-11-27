import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe } from "../runtime/process-probe.js";
import { FRESH_SQLITE_DATABASE_FILE } from "../runtime/sqlite-install-config.js";
import { loadLifecycleCandidateModules } from "../store/lifecycle-gate.js";
import { withProcessLock } from "../store/process-lock.js";
import { ExecutorControlClient } from "./control-client.js";
import {
  assertExecutorLeaseTransition,
  clearExecutorLease,
  EXECUTOR_LEASE_FILE,
  inspectExecutorLease,
  type ExecutorLeaseInspection,
  type ExecutorLeaseRecord,
} from "./lease.js";
import { executorPipeName } from "./pipe.js";
import { spawnExecutorProcess, type ExecutorSpawnHandle, type ExecutorSpawnInput } from "./spawn.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_RECOVERY_LOCK_TIMEOUT_MS = 30_000;
const STATUS_POLL_MS = 100;

export type ExecutorRecoveryCode =
  | "EXECUTOR_RECOVERY_OWNER_UNKNOWN"
  | "EXECUTOR_RECOVERY_WORKER_ACTIVE"
  | "EXECUTOR_RECOVERY_BLOCKED"
  | "EXECUTOR_RECOVERY_SPAWN_FAILED"
  | "EXECUTOR_START_TIMEOUT";

export class ExecutorRecoveryError extends Error {
  constructor(
    readonly code: ExecutorRecoveryCode,
    message: string,
    readonly blockers: readonly string[] = [],
  ) {
    super(message);
    this.name = "ExecutorRecoveryError";
  }
}

export interface ExecutorLiveStatus extends Record<string, unknown> {
  readonly lease_id: string;
}

export interface ExecutorWorkerSafety {
  readonly safe: boolean;
  readonly blockers: readonly string[];
  readonly retained_operations?: readonly string[];
}

export type ExecutorRecoveryResult =
  | {
    readonly status: "already_running";
    readonly lease_id: string;
  }
  | {
    readonly status: "started" | "recovered";
    readonly lease_id: string;
    readonly pid: number | null;
    readonly archived_lease_id: string | null;
  };

export interface ExecutorRecoveryDependencies {
  readonly probeStatus?: (pipeName: string) => Promise<ExecutorLiveStatus | null>;
  readonly inspectLease?: (dataRoot: string) => Promise<ExecutorLeaseInspection>;
  readonly clearLease?: (dataRoot: string) => Promise<ExecutorLeaseRecord>;
  readonly inspectWorkerSafety?: (dataRoot: string) => Promise<ExecutorWorkerSafety>;
  readonly spawnExecutor?: (input: ExecutorSpawnInput) => ExecutorSpawnHandle;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface ExecutorRecoveryOptions {
  readonly dataRoot: string;
  readonly settingsDirectory: string;
  readonly bridgeEntryPath: string;
  readonly pipeName?: string;
  readonly heartbeatMs?: number;
  readonly startupTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly processProbe?: ProcessProbe;
  readonly dependencies?: ExecutorRecoveryDependencies;
}

export interface ExecutorRecoveryCoordinator {
  ensureRunning(): Promise<ExecutorRecoveryResult>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function isUnavailable(error: unknown): boolean {
  return ["EXECUTOR_UNAVAILABLE", "ECONNREFUSED", "ENOENT"].includes(errorCode(error) ?? "");
}

async function defaultProbeStatus(pipeName: string): Promise<ExecutorLiveStatus | null> {
  const client = new ExecutorControlClient({ pipeName, connectTimeoutMs: 1_000 });
  try {
    await client.connect();
    const response = await client.request("executorStatus", {});
    if (!response.ok) {
      if (response.error?.code === "EXECUTOR_UNAVAILABLE") return null;
      throw Object.assign(
        new Error(response.error?.message ?? "EXECUTOR_STATUS_FAILED"),
        { code: response.error?.code ?? "EXECUTOR_STATUS_FAILED" },
      );
    }
    return liveStatus(response.result);
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  } finally {
    client.close();
  }
}

function liveStatus(value: Record<string, unknown> | undefined): ExecutorLiveStatus {
  if (!value || typeof value.lease_id !== "string" || !value.lease_id) {
    throw Object.assign(new Error("Executor status did not include a lease identity"), {
      code: "EXECUTOR_STATUS_INVALID",
    });
  }
  return value as ExecutorLiveStatus;
}

function parseRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function workerIdentity(value: unknown, processProbe: ProcessProbe): ProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (!Number.isSafeInteger(record.process_id) || Number(record.process_id) <= 0
    || typeof record.start_fingerprint !== "string" || !record.start_fingerprint
    || record.fingerprint_precision !== "exact"
    || record.identity_version !== PROCESS_IDENTITY_VERSION
    || record.platform !== processProbe.platform
    || typeof record.captured_at !== "string") return null;
  return {
    pid: Number(record.process_id),
    fingerprint: record.start_fingerprint,
    fingerprint_precision: "exact",
    identity_version: PROCESS_IDENTITY_VERSION,
    platform: processProbe.platform,
    captured_at: record.captured_at,
  };
}

/**
 * Inspect persisted Worker roots without making one uncertain root a global
 * startup gate. Unknown outcomes and live identities are retained per
 * Operation; SQLite's workspace fence prevents a new dispatch to the same
 * path while unrelated Tasks continue.
 */
export async function inspectExecutorWorkerSafety(
  dataRoot: string,
  processProbe: ProcessProbe = createPlatformProbe(),
): Promise<ExecutorWorkerSafety> {
  if (!existsSync(path.join(dataRoot, FRESH_SQLITE_DATABASE_FILE))) {
    return { safe: true, blockers: [] };
  }
  let store: ReturnType<Awaited<ReturnType<typeof loadLifecycleCandidateModules>>["Store"]["openForRecovery"]> | undefined;
  try {
    const modules = await loadLifecycleCandidateModules();
    store = modules.Store.openForRecovery(dataRoot, {
      databaseFileName: FRESH_SQLITE_DATABASE_FILE,
      managedDataDirectory: true,
    });
    if (!store) return { safe: false, blockers: ["recovery_store_unavailable"] };
    const snapshot = store.readRecoverySnapshot() as Readonly<Record<string, unknown>>;
    if (snapshot.root_status !== "consistent_read_only") {
      const rootBlockers = Array.isArray(snapshot.root_blockers)
        ? snapshot.root_blockers.map(String)
        : ["root_not_consistent"];
      return { safe: false, blockers: rootBlockers };
    }
    const operations = Array.isArray(snapshot.operations)
      ? snapshot.operations as ReadonlyArray<Readonly<Record<string, unknown>>>
      : [];
    const retained: string[] = [];
    const identities: Array<{ readonly operation: string; readonly identity: ProcessIdentity }> = [];
    for (const operation of operations) {
      if (operation.operation_kind !== "attempt_lifecycle"
        || operation.capacity_occupied !== true
        || operation.admin_abandoned === true
        || operation.phase === "released"
        || operation.phase === "cancelled_before_launch") continue;
      const label = `${String(operation.task_id)}/${String(operation.attempt)}`;
      if (operation.phase === "reserved") continue;
      if (operation.phase === "launch_intent" && operation.launch_receipt_digest === null) {
        retained.push(`launch_outcome_unknown:${label}`);
        continue;
      }
      const claimed = workerIdentity(parseRecord(operation.claim_worker_identity_json), processProbe)
        ?? workerIdentity(parseRecord(operation.launch_identity_json), processProbe);
      if (!claimed) {
        retained.push(`worker_identity_unknown:${label}`);
        continue;
      }
      identities.push({ operation: label, identity: claimed });
    }
    if (identities.length > 0) {
      const verdicts = await processProbe.probe(identities.map(({ identity }) => ({
        pid: identity.pid,
        identity,
      })));
      for (let index = 0; index < identities.length; index += 1) {
        const verdict = verdicts[index];
        if (verdict?.state !== "exited") {
          retained.push(`${verdict?.state === "alive" ? "worker_still_alive" : "worker_identity_unknown"}:${identities[index]!.operation}`);
        }
      }
    }
    return { safe: true, blockers: [], retained_operations: retained };
  } catch (error) {
    return {
      safe: false,
      blockers: [`worker_safety_probe_failed:${errorCode(error) ?? "unknown"}`],
    };
  } finally {
    try { store?.close(); } catch { /* read-only diagnostic close cannot authorize recovery */ }
  }
}

function recoveryError(
  code: ExecutorRecoveryCode,
  message: string,
  blockers: readonly string[] = [],
): ExecutorRecoveryError {
  return new ExecutorRecoveryError(code, blockers.length > 0 ? `${message}: ${blockers.join(",")}` : message, blockers);
}

export function createExecutorRecoveryCoordinator(options: ExecutorRecoveryOptions): ExecutorRecoveryCoordinator {
  const pipeName = options.pipeName ?? executorPipeName(options.dataRoot);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_RECOVERY_LOCK_TIMEOUT_MS;
  const processProbe = options.processProbe ?? createPlatformProbe();
  const dependencies = options.dependencies ?? {};
  const probeStatus = dependencies.probeStatus ?? defaultProbeStatus;
  const inspectLease = dependencies.inspectLease ?? ((root: string) => inspectExecutorLease({
    authorityRoot: root,
    processProbe,
  }));
  const clearLease = dependencies.clearLease ?? ((root: string) => clearExecutorLease({
    authorityRoot: root,
    processProbe,
  }));
  const inspectWorkerSafety = dependencies.inspectWorkerSafety ?? ((root: string) => inspectExecutorWorkerSafety(root, processProbe));
  const spawnExecutor = dependencies.spawnExecutor ?? spawnExecutorProcess;
  const wait = dependencies.sleep ?? sleep;
  let current: Promise<ExecutorRecoveryResult> | null = null;

  const waitForStatus = async (): Promise<ExecutorLiveStatus> => {
    const deadline = Date.now() + startupTimeoutMs;
    for (;;) {
      const status = await probeStatus(pipeName).catch((error: unknown) => {
        if (isUnavailable(error)) return null;
        throw error;
      });
      if (status) return status;
      if (Date.now() >= deadline) {
        throw recoveryError("EXECUTOR_START_TIMEOUT", `Executor did not become ready within ${startupTimeoutMs} ms`);
      }
      await wait(STATUS_POLL_MS);
    }
  };

  const ensureOnce = async (): Promise<ExecutorRecoveryResult> => {
    const existing = await probeStatus(pipeName);
    if (existing) return { status: "already_running", lease_id: existing.lease_id };
    if (!existsSync(options.dataRoot)) mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 });
    // The SQLite fresh-install gate requires the Authority root to contain only
    // its own artifacts. Keep the cross-process recovery lock with Host settings
    // instead of teaching the Store about a transient Executor concern.
    if (!existsSync(options.settingsDirectory)) {
      mkdirSync(options.settingsDirectory, { recursive: true, mode: 0o700 });
    }
    const lockDirectory = path.join(options.settingsDirectory, "executor-recovery.lock");
    return withProcessLock(lockDirectory, async () => {
      const raced = await probeStatus(pipeName);
      if (raced) return { status: "already_running", lease_id: raced.lease_id };

      let archivedLeaseId: string | null = null;
      const leaseFile = path.join(options.dataRoot, EXECUTOR_LEASE_FILE);
      if (existsSync(leaseFile)) {
        let inspection: ExecutorLeaseInspection;
        try {
          inspection = await inspectLease(options.dataRoot);
        } catch (error) {
          throw recoveryError(
            "EXECUTOR_RECOVERY_OWNER_UNKNOWN",
            "Executor lease could not be verified",
            [errorCode(error) ?? (error instanceof Error ? error.message : "lease_unknown")],
          );
        }
        if (inspection.owner_state === "alive") {
          const status = await waitForStatus();
          return { status: "recovered", lease_id: status.lease_id, pid: null, archived_lease_id: null };
        }
        if (inspection.owner_state !== "exited") {
          throw recoveryError(
            "EXECUTOR_RECOVERY_OWNER_UNKNOWN",
            "Executor owner exit is not proven",
            [inspection.lease.state, inspection.owner_state],
          );
        }
        const workers = await inspectWorkerSafety(options.dataRoot);
        if (!workers.safe) {
          throw recoveryError(
            "EXECUTOR_RECOVERY_WORKER_ACTIVE",
            "Executor lease was not archived because Worker execution is still live or unverifiable",
            workers.blockers,
          );
        }
        if (workers.retained_operations?.length) {
          console.error(`EXECUTOR_WORKER_OPERATIONS_RETAINED ${JSON.stringify({
            operations: workers.retained_operations,
          })}`);
        }
        try {
          const cleared = await clearLease(options.dataRoot);
          archivedLeaseId = cleared.lease_id;
          console.error(`EXECUTOR_LEASE_RECOVERED ${JSON.stringify({
            archived_lease_id: cleared.lease_id,
            prior_owner_pid: inspection.lease.owner.process_id,
          })}`);
        } catch (error) {
          throw recoveryError(
            "EXECUTOR_RECOVERY_BLOCKED",
            "Executor lease archival failed",
            [errorCode(error) ?? (error instanceof Error ? error.message : "lease_archive_unknown")],
          );
        }
      }

      assertExecutorLeaseTransition({
        authorityRoot: options.dataRoot,
        databaseFileName: FRESH_SQLITE_DATABASE_FILE,
        acceptUnleasedExistingRoot: false,
      });
      let spawned: ExecutorSpawnHandle;
      try {
        spawned = spawnExecutor({
          dataRoot: options.dataRoot,
          settingsDirectory: options.settingsDirectory,
          bridgeEntryPath: options.bridgeEntryPath,
          ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        });
      } catch (error) {
        throw recoveryError(
          "EXECUTOR_RECOVERY_SPAWN_FAILED",
          "Executor process could not be spawned",
          [errorCode(error) ?? (error instanceof Error ? error.message : "spawn_failed")],
        );
      }
      if (spawned.pid === undefined) {
        throw recoveryError("EXECUTOR_RECOVERY_SPAWN_FAILED", "Executor spawn did not return a process id");
      }
      let status: ExecutorLiveStatus;
      try {
        status = await waitForStatus();
      } catch (error) {
        throw recoveryError(
          errorCode(error) === "EXECUTOR_START_TIMEOUT" ? "EXECUTOR_START_TIMEOUT" : "EXECUTOR_RECOVERY_BLOCKED",
          error instanceof Error ? error.message : "Executor did not become ready",
          [errorCode(error) ?? "startup_unknown"],
        );
      }
      console.error(`EXECUTOR_START_RECOVERED ${JSON.stringify({
        lease_id: status.lease_id,
        pid: spawned.pid,
        archived_lease_id: archivedLeaseId,
      })}`);
      return {
        status: archivedLeaseId === null ? "started" : "recovered",
        lease_id: status.lease_id,
        pid: spawned.pid,
        archived_lease_id: archivedLeaseId,
      };
    }, lockTimeoutMs);
  };

  return {
    ensureRunning() {
      if (current) return current;
      const attempt = ensureOnce();
      current = attempt;
      void attempt.finally(() => {
        if (current === attempt) current = null;
      }).catch(() => undefined);
      return attempt;
    },
  };
}
