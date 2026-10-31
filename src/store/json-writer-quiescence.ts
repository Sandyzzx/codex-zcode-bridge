import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tryAcquireProcessLock, withProcessLock } from "./process-lock.js";
import type { ProbeRequest, ProcessIdentity, ProcessProbe } from "../runtime/process-probe.js";
import {
  defaultDurableFileOperations,
  type DurableFileOperations,
} from "../runtime/durable-file-system.js";
import type { ProcessIdentityLike, TaskStore } from "./task-store.js";
import { isTerminalStatus } from "./task-store.js";

export type JsonWriterFenceState = "closing" | "draining" | "sealed";
export type JsonWriterKind = "manager" | "worker";

interface JsonWriterFenceRecord {
  readonly schema_version: 1;
  readonly state: JsonWriterFenceState;
  readonly revision: number;
  readonly transition_id: string;
  readonly updated_at: string;
}

interface JsonWriterLease {
  readonly schema_version: 1;
  readonly token: string;
  readonly kind: JsonWriterKind;
  readonly pid: number | null;
  readonly identity: ProcessIdentity | null;
  readonly task_id?: string;
  readonly attempt?: number;
  readonly created_at: string;
}

export interface JsonWriterQuiescenceResult {
  readonly sealed: boolean;
  readonly state: JsonWriterFenceState;
  readonly blockers: readonly string[];
  readonly reaped_leases: number;
}

export function jsonWriterFenceState(dataRoot: string): "open" | JsonWriterFenceState {
  return readFence(dataRoot)?.state ?? "open";
}

const FENCE_FILE = ".writer-quiescence.json";
const ROSTER_DIR = ".writer-roster";
const REGISTRY_FILE = "registry.json";
const GATE_LOCK = ".writer-quiescence.lock";
const ATOMIC_RENAME_RETRY_MS = 5_000;
const ATOMIC_RENAME_RETRY_PAUSE_MS = 10;
const TRANSIENT_ATOMIC_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function fencePath(dataRoot: string): string {
  return path.join(dataRoot, ".tasks", FENCE_FILE);
}

function rosterPath(dataRoot: string): string {
  return path.join(dataRoot, ".tasks", ROSTER_DIR);
}

function leasePath(dataRoot: string, token: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(token)) throw new Error("invalid JSON writer lease token");
  return path.join(rosterPath(dataRoot), `${token}.json`);
}

function gateLockPath(dataRoot: string): string {
  return path.join(dataRoot, ".tasks", GATE_LOCK);
}

function strictObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFence(dataRoot: string): JsonWriterFenceRecord | null {
  const file = fencePath(dataRoot);
  if (!existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error("JSON writer quiescence record is unreadable; writes fail closed", { cause: error }); }
  if (!strictObject(value) || value.schema_version !== 1 || !["closing", "draining", "sealed"].includes(String(value.state))
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.transition_id !== "string" || !value.transition_id
    || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new Error("JSON writer quiescence record is malformed; writes fail closed");
  }
  return value as unknown as JsonWriterFenceRecord;
}

function writeJsonAtomic(
  file: string,
  value: unknown,
  durability: DurableFileOperations = defaultDurableFileOperations,
): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Windows can report a sharing violation when another process has the
    // destination open for a concurrent read. Keep the atomic replace and
    // retry only the documented transient namespace/share codes for a bounded
    // interval; persistent failures remain visible and fail closed.
    const deadline = Date.now() + ATOMIC_RENAME_RETRY_MS;
    for (;;) {
      try {
        durability.replaceFileSync(temporary, file);
        break;
      } catch (error) {
        if (!TRANSIENT_ATOMIC_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "")
          || Date.now() >= deadline) {
          throw error;
        }
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          ATOMIC_RENAME_RETRY_PAUSE_MS,
        );
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve primary write error */ }
    }
    try { rmSync(temporary, { force: true }); } catch { /* preserve primary error */ }
    throw error;
  }
}

function withSyncGateLock<T>(dataRoot: string, operation: () => T): T {
  const directory = gateLockPath(dataRoot);
  const deadline = Date.now() + 10_000;
  let release: (() => void) | null;
  while (!(release = tryAcquireProcessLock(directory))) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for JSON writer quiescence lock");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { return operation(); }
  finally { release(); }
}

const activeWritePermits = new Map<string, { depth: number }>();

/** Run one complete synchronous TaskStore mutation while holding the same
 * cross-process gate lock used by CLOSING/SEALED transitions. The local depth
 * makes nested TaskStore mutations (for example observation -> metadata)
 * reentrant without releasing the OS lock between their writes. */
export function withJsonWriterWritePermit<T>(dataRoot: string, token: string | undefined, taskId: string | undefined, attempt: number | undefined, operation: () => T): T {
  const resolved = realpathSync(dataRoot);
  const key = process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  const active = activeWritePermits.get(key);
  if (active) {
    active.depth += 1;
    try {
      assertJsonWriterCanWrite(dataRoot, token, taskId, attempt);
      return operation();
    } finally {
      active.depth -= 1;
    }
  }
  return withSyncGateLock(dataRoot, () => {
    assertJsonWriterCanWrite(dataRoot, token, taskId, attempt);
    activeWritePermits.set(key, { depth: 1 });
    try { return operation(); }
    finally { activeWritePermits.delete(key); }
  });
}

function readLease(dataRoot: string, token: string): JsonWriterLease | null {
  const file = leasePath(dataRoot, token);
  if (!existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error("JSON writer lease is unreadable; writes fail closed", { cause: error }); }
  if (!strictObject(value) || value.schema_version !== 1 || value.token !== token
    || (value.kind !== "manager" && value.kind !== "worker")
    || (value.pid !== null && (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1))
    || (value.identity !== null && !validIdentity(value.identity))
    || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error("JSON writer lease is malformed; writes fail closed");
  }
  if (value.kind === "worker" && (typeof value.task_id !== "string" || !Number.isSafeInteger(value.attempt))) {
    throw new Error("JSON worker lease is missing its attempt binding; writes fail closed");
  }
  return value as unknown as JsonWriterLease;
}

function validIdentity(value: unknown): value is ProcessIdentity {
  if (!strictObject(value)) return false;
  return Number.isSafeInteger(value.pid) && (value.pid as number) > 0
    && typeof value.fingerprint === "string" && value.fingerprint.length > 0
    && value.fingerprint_precision === "exact"
    && Number.isSafeInteger(value.identity_version)
    && typeof value.platform === "string"
    && typeof value.captured_at === "string" && Number.isFinite(Date.parse(value.captured_at));
}

function registryEnabled(dataRoot: string): boolean {
  const file = path.join(rosterPath(dataRoot), REGISTRY_FILE);
  if (!existsSync(file)) return false;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error("JSON writer registry is unreadable; writes fail closed", { cause: error }); }
  if (!strictObject(value) || value.schema_version !== 1 || typeof value.created_at !== "string"
    || !Number.isFinite(Date.parse(value.created_at))) throw new Error("JSON writer registry is malformed; writes fail closed");
  return true;
}

export function jsonWriterParticipationRequired(dataRoot: string): boolean {
  return registryEnabled(dataRoot) || readFence(dataRoot) !== null;
}

function ensureFenceOpen(dataRoot: string): void {
  const fence = readFence(dataRoot);
  if (fence) throw new Error(`JSON writer fence is ${fence.state}; new writer registration is closed`);
}

/** Absence of a fence is the unchanged legacy JSON mode. Once a fence exists,
 * every fenced TaskStore mutation must be owned by a registered participant. */
export function assertJsonWriterCanWrite(dataRoot: string, token?: string, taskId?: string, attempt?: number): void {
  const fence = readFence(dataRoot);
  if (!fence) {
    if (!registryEnabled(dataRoot)) return;
    if (!token) throw new Error("JSON writer is not registered; write rejected");
    const lease = readLease(dataRoot, token);
    if (!lease || lease.pid !== process.pid || (lease.kind === "worker" && lease.identity?.pid !== process.pid)) {
      throw new Error("JSON writer lease does not belong to this process; write rejected");
    }
    assertLeaseMutationScope(dataRoot, lease, taskId, attempt);
    return;
  }
  if (fence.state === "sealed") throw new Error("JSON writer fence is sealed; write rejected");
  if (!token) throw new Error(`JSON writer fence is ${fence.state}; unregistered write rejected`);
  const lease = readLease(dataRoot, token);
  if (!lease || lease.pid !== process.pid || (lease.kind === "worker" && lease.identity?.pid !== process.pid)) {
    throw new Error("JSON writer lease does not belong to this process; write rejected");
  }
  assertLeaseMutationScope(dataRoot, lease, taskId, attempt);
}

function assertLeaseMutationScope(dataRoot: string, lease: JsonWriterLease, taskId?: string, attempt?: number): void {
  if (lease.kind === "manager") return;
  if (!taskId || lease.task_id !== taskId || (attempt !== undefined && lease.attempt !== attempt)) {
    throw new Error("Worker writer lease is not authorized for this Task/Attempt; write rejected");
  }
  let status: unknown;
  try { status = JSON.parse(readFileSync(path.join(dataRoot, ".tasks", taskId, "status.json"), "utf8")); }
  catch (error) { throw new Error("Worker Task status is unreadable; write rejected", { cause: error }); }
  if (!strictObject(status) || status.attempt !== lease.attempt) {
    throw new Error("Worker writer lease does not match the current Task Attempt; write rejected");
  }
}

export function assertJsonAdmissionOpen(dataRoot: string): void {
  const fence = readFence(dataRoot);
  if (fence) throw new Error(`JSON writer fence is ${fence.state}; new task admission is closed`);
}

export function assertJsonWorkerLease(dataRoot: string, token: string | undefined, taskId: string, attempt: number): void {
  const fence = readFence(dataRoot);
  if (!fence && !registryEnabled(dataRoot)) return;
  if (!token) throw new Error("worker launch has no registered JSON writer lease");
  const lease = readLease(dataRoot, token);
  if (!lease || lease.kind !== "worker" || lease.pid !== process.pid || lease.task_id !== taskId || lease.attempt !== attempt
    || !lease.identity || lease.identity.pid !== process.pid) {
    throw new Error("worker JSON writer lease does not match this process and attempt");
  }
  if (fence?.state === "sealed") throw new Error("JSON writer fence is sealed; worker start rejected");
}

export async function registerManagerJsonWriter(dataRoot: string, identity: ProcessIdentity | null): Promise<string> {
  const token = randomUUID();
  mkdirSync(path.join(dataRoot, ".tasks"), { recursive: true, mode: 0o700 });
  await withProcessLock(gateLockPath(dataRoot), async () => {
    ensureFenceOpen(dataRoot);
    mkdirSync(rosterPath(dataRoot), { recursive: true, mode: 0o700 });
    const registry = path.join(rosterPath(dataRoot), REGISTRY_FILE);
    if (!existsSync(registry)) writeJsonAtomic(registry, { schema_version: 1, created_at: new Date().toISOString() });
    if (identity && (!validIdentity(identity) || identity.pid !== process.pid)) throw new Error("Manager process identity is invalid");
    writeJsonAtomic(leasePath(dataRoot, token), {
      schema_version: 1, token, kind: "manager", pid: process.pid, identity,
      created_at: new Date().toISOString(),
    } satisfies JsonWriterLease);
  });
  return token;
}

export async function releaseManagerJsonWriter(dataRoot: string, token: string): Promise<void> {
  await withProcessLock(gateLockPath(dataRoot), async () => {
    const lease = readLease(dataRoot, token);
    if (!lease) return;
    if (lease.kind !== "manager" || lease.pid !== process.pid) throw new Error("Manager writer lease owner mismatch");
    rmSync(leasePath(dataRoot, token));
  });
}

/** Called under the Manager scheduling lock before Spawn. The token is sent
 * only through the Bridge-controlled Worker environment and is bound to one
 * task attempt in the durable roster. */
export function registerPendingWorkerJsonWriter(dataRoot: string, taskId: string, attempt: number): string {
  const token = randomUUID();
  return withSyncGateLock(dataRoot, () => {
    ensureFenceOpen(dataRoot);
    if (!registryEnabled(dataRoot)) throw new Error("JSON writer registry is missing; Worker registration rejected");
    writeJsonAtomic(leasePath(dataRoot, token), {
      schema_version: 1, token, kind: "worker", pid: null, identity: null,
      task_id: taskId, attempt, created_at: new Date().toISOString(),
    } satisfies JsonWriterLease);
    return token;
  });
}

export function bindPendingWorkerJsonWriter(dataRoot: string, token: string, pid: number): void {
  withSyncGateLock(dataRoot, () => {
    const lease = readLease(dataRoot, token);
    // A very short synthetic/real Worker can finish and release its roster
    // entry before the Manager returns from spawn; that is already settled.
    if (!lease) return;
    if (lease.kind !== "worker" || !Number.isSafeInteger(pid) || pid < 1
      || (lease.pid !== null && lease.pid !== pid)) throw new Error("spawned Worker does not match its pending writer lease");
    if (lease.pid === null) writeJsonAtomic(leasePath(dataRoot, token), { ...lease, pid } satisfies JsonWriterLease);
  });
}

export function removePendingWorkerJsonWriterSync(dataRoot: string, token: string): void {
  withSyncGateLock(dataRoot, () => {
    const lease = readLease(dataRoot, token);
    if (!lease) return;
    if (lease.kind !== "worker" || lease.pid !== null) throw new Error("cannot remove an active worker writer lease as pending");
    rmSync(leasePath(dataRoot, token));
  });
}

export async function activateWorkerJsonWriter(
  dataRoot: string,
  token: string,
  taskId: string,
  attempt: number,
  identity: ProcessIdentity,
): Promise<void> {
  await withProcessLock(gateLockPath(dataRoot), async () => {
    const fence = readFence(dataRoot);
    if (fence?.state === "sealed") throw new Error("JSON writer fence is sealed; worker activation rejected");
    const lease = readLease(dataRoot, token);
    if (!lease || lease.kind !== "worker" || lease.task_id !== taskId || lease.attempt !== attempt
      || (lease.pid !== null && lease.pid !== process.pid)
      || !validIdentity(identity) || identity.pid !== process.pid) {
      throw new Error("pending worker writer lease does not match this process and attempt");
    }
    writeJsonAtomic(leasePath(dataRoot, token), { ...lease, pid: process.pid, identity } satisfies JsonWriterLease);
  });
}

export async function releaseWorkerJsonWriter(dataRoot: string, token: string): Promise<void> {
  await withProcessLock(gateLockPath(dataRoot), async () => {
    const lease = readLease(dataRoot, token);
    if (!lease) return;
    if (lease.kind !== "worker" || lease.pid !== process.pid) throw new Error("Worker writer lease owner mismatch");
    rmSync(leasePath(dataRoot, token));
  });
}

export async function removePendingWorkerJsonWriter(dataRoot: string, token: string): Promise<void> {
  await withProcessLock(gateLockPath(dataRoot), async () => {
    const lease = readLease(dataRoot, token);
    if (!lease) return;
    if (lease.kind !== "worker" || lease.pid !== null) throw new Error("cannot remove an active worker writer lease as pending");
    rmSync(leasePath(dataRoot, token));
  });
}

export async function beginJsonWriterDrain(
  dataRoot: string,
  durability: DurableFileOperations = defaultDurableFileOperations,
): Promise<"draining" | "sealed"> {
  return withProcessLock(
    path.join(dataRoot, ".tasks", ".manager.lock"),
    async () => beginJsonWriterDrainUnderManagerLock(dataRoot, durability),
  );
}

export async function beginJsonWriterDrainUnderManagerLock(
  dataRoot: string,
  durability: DurableFileOperations = defaultDurableFileOperations,
): Promise<"draining" | "sealed"> {
  return withProcessLock(gateLockPath(dataRoot), async () => {
      const current = readFence(dataRoot);
      if (current?.state === "sealed") return "sealed";
      if (current?.state === "draining") return "draining";
      if (current?.state === "closing") {
        writeFence(dataRoot, { ...current, state: "draining", revision: current.revision + 1, updated_at: new Date().toISOString() }, durability);
        return "draining";
      }
      const transitionId = randomUUID();
      const closing: JsonWriterFenceRecord = {
        schema_version: 1, state: "closing", revision: 1, transition_id: transitionId,
        updated_at: new Date().toISOString(),
      };
      writeFence(dataRoot, closing, durability);
      writeFence(dataRoot, { ...closing, state: "draining", revision: 2, updated_at: new Date().toISOString() }, durability);
      return "draining";
    });
}

function writeFence(
  dataRoot: string,
  record: JsonWriterFenceRecord,
  durability: DurableFileOperations = defaultDurableFileOperations,
): void {
  writeJsonAtomic(fencePath(dataRoot), record, durability);
}

interface AttemptExecutorEvidence {
  readonly started: { worker_pid?: unknown } | null;
  readonly claim: { pid?: unknown } | null;
  readonly identity: { worker?: ProcessIdentityLike; runtime?: ProcessIdentityLike | null } | null;
}

function recordedPid(
  value: unknown,
  taskId: string,
  attempt: number,
  field: string,
  blockers: string[],
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    blockers.push(`task_attempt_identity_unknown:${taskId}:${attempt}:${field}`);
    return null;
  }
  return value as number;
}

function singleAttemptPid(
  values: readonly (number | null)[],
  taskId: string,
  attempt: number,
  field: string,
  blockers: string[],
): number | null {
  const known = [...new Set(values.filter((value): value is number => value !== null))];
  if (known.length > 1) {
    blockers.push(`task_attempt_identity_conflict:${taskId}:${attempt}:${field}`);
    return null;
  }
  return known[0] ?? null;
}

/** Every byte-preserved Attempt is checked independently. A queued current
 * Attempt may have no execution evidence yet, but any historical marker claims
 * a process generation and must therefore carry exact, probeable identity. */
function attemptExecutorRequests(
  store: TaskStore,
  taskId: string,
  status: ReturnType<TaskStore["readStatus"]>,
  blockers: string[],
): {
  executors: Array<{ pid: number; identity: ProcessIdentity }>;
  cleanupMembers: ProbeRequest[];
} {
  const attemptsRoot = path.dirname(store.attemptDir(taskId, 1));
  let entries: Dirent[];
  try {
    entries = readdirSync(attemptsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else {
      blockers.push(`task_attempt_layout_unknown:${taskId}`);
      entries = [];
    }
  }

  const attempts = new Set<number>();
  for (const entry of entries) {
    if (!/^[1-9]\d*$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      blockers.push(`task_attempt_layout_unknown:${taskId}`);
      continue;
    }
    const attempt = Number(entry.name);
    if (!Number.isSafeInteger(attempt) || attempt > status.attempt) {
      blockers.push(`task_attempt_layout_unknown:${taskId}`);
      continue;
    }
    attempts.add(attempt);
  }
  attempts.add(status.attempt);

  const executors: Array<{ pid: number; identity: ProcessIdentity }> = [];
  const cleanupMembers: ProbeRequest[] = [];
  for (const attempt of [...attempts].sort((left, right) => left - right)) {
    let evidence: AttemptExecutorEvidence;
    try {
      evidence = {
        started: store.readAttemptMeta<{ worker_pid?: unknown }>(taskId, attempt, "started.json"),
        claim: store.readAttemptMeta<{ pid?: unknown }>(taskId, attempt, "execution.claim"),
        identity: store.readExecutorIdentity(taskId, attempt),
      };
    } catch {
      blockers.push(`task_attempt_identity_unknown:${taskId}:${attempt}`);
      continue;
    }

    const cleanupFailurePath = path.join(store.attemptDir(taskId, attempt), "cleanup-failure.json");
    const cleanupFailurePresent = existsSync(cleanupFailurePath);
    if (cleanupFailurePresent) {
      let cleanupFailure: unknown;
      try {
        cleanupFailure = store.readAttemptMeta(taskId, attempt, "cleanup-failure.json");
      } catch {
        blockers.push(`task_cleanup_failure_unknown:${taskId}:${attempt}`);
        continue;
      }
      const record = strictObject(cleanupFailure) ? cleanupFailure : null;
      const memberPids = record?.member_pids;
      if (
        !record
        || record.complete !== true
        || !Array.isArray(memberPids)
        || !memberPids.every((pid) => Number.isSafeInteger(pid) && (pid as number) > 0)
      ) {
        blockers.push(`task_cleanup_failure_incomplete:${taskId}:${attempt}`);
        continue;
      }
      for (const pid of memberPids as number[]) cleanupMembers.push({ pid, identity: null });
    }

    const current = attempt === status.attempt;
    const currentStarted = current
      && (
        status.status !== "queued"
        || (typeof status.started_at === "string" && status.started_at.length > 0)
        || (status.worker_pid !== undefined && status.worker_pid !== null)
        || (status.zcode_pid !== undefined && status.zcode_pid !== null)
      );
    const attemptStarted = currentStarted
      || evidence.started !== null
      || evidence.claim !== null
      || evidence.identity !== null
      || cleanupFailurePresent;
    if (!attemptStarted) continue;

    const startedPid = recordedPid(evidence.started?.worker_pid, taskId, attempt, "started", blockers);
    const claimPid = recordedPid(evidence.claim?.pid, taskId, attempt, "claim", blockers);
    const identityWorkerPid = recordedPid(evidence.identity?.worker?.pid, taskId, attempt, "worker_identity", blockers);
    const statusWorkerPid = current ? recordedPid(status.worker_pid, taskId, attempt, "status_worker", blockers) : null;
    const workerPid = singleAttemptPid(
      [startedPid, claimPid, identityWorkerPid, statusWorkerPid],
      taskId,
      attempt,
      "worker",
      blockers,
    );
    if (workerPid === null) {
      blockers.push(`task_worker_identity_unknown:${taskId}:${attempt}`);
    } else {
      const workerIdentity = evidence.identity?.worker;
      if (!workerIdentity || !validIdentity(workerIdentity) || workerIdentity.pid !== workerPid) {
        blockers.push(`task_worker_identity_unknown:${taskId}:${attempt}`);
      } else {
        executors.push({ pid: workerPid, identity: workerIdentity as ProcessIdentity });
      }
    }

    const identityRuntimePid = recordedPid(evidence.identity?.runtime?.pid, taskId, attempt, "runtime_identity", blockers);
    const statusRuntimePid = current ? recordedPid(status.zcode_pid, taskId, attempt, "status_runtime", blockers) : null;
    const runtimePid = singleAttemptPid(
      [identityRuntimePid, statusRuntimePid],
      taskId,
      attempt,
      "runtime",
      blockers,
    );
    if (runtimePid !== null) {
      const runtimeIdentity = evidence.identity?.runtime;
      if (!runtimeIdentity || !validIdentity(runtimeIdentity) || runtimeIdentity.pid !== runtimePid) {
        blockers.push(`task_runtime_identity_unknown:${taskId}:${attempt}`);
      } else {
        executors.push({ pid: runtimePid, identity: runtimeIdentity as ProcessIdentity });
      }
    }
  }
  return { executors, cleanupMembers };
}

/** Final seal is a read/probe/CAS operation. Queued Tasks are retained but
 * never dispatched; every started attempt must be terminal and cleanup-safe. */
export async function sealJsonWriterRoot(
  dataRoot: string,
  store: TaskStore,
  probe: ProcessProbe,
  durability: DurableFileOperations = defaultDurableFileOperations,
): Promise<JsonWriterQuiescenceResult> {
  return withProcessLock(path.join(store.tasksRoot, ".recovery.lock"), async () =>
    withProcessLock(path.join(store.tasksRoot, ".manager.lock"), async () =>
      withProcessLock(gateLockPath(dataRoot), async () => {
      const current = readFence(dataRoot);
      if (!current) throw new Error("JSON writer drain has not started");
      if (current.state === "sealed") return { sealed: true, state: "sealed", blockers: [], reaped_leases: 0 };
      if (current.state !== "draining") return { sealed: false, state: current.state, blockers: ["fence_not_draining"], reaped_leases: 0 };
      const blockers: string[] = [];
      let reaped = 0;
      if (!registryEnabled(dataRoot)) blockers.push("writer_registry_missing");
      const roster = rosterPath(dataRoot);
      let names: string[];
      try { names = readdirSync(roster).filter((name) => name.endsWith(".json") && name !== REGISTRY_FILE); }
      catch { blockers.push("writer_roster_unreadable"); names = []; }
      const leases: Array<{ file: string; value: JsonWriterLease }> = [];
      for (const name of names) {
        const token = name.slice(0, -5);
        try {
          const lease = readLease(dataRoot, token);
          if (!lease) { blockers.push(`writer_lease_missing:${name}`); continue; }
          leases.push({ file: path.join(roster, name), value: lease });
        } catch { blockers.push(`writer_lease_invalid:${name}`); }
      }
      for (const { file, value } of leases) {
        if (value.pid === null) { blockers.push(`writer_pid_unknown:${value.token}`); continue; }
        const identity = value.identity;
        if (!identity || !validIdentity(identity) || identity.pid !== value.pid) {
          blockers.push(`writer_identity_unknown:${value.token}`);
          continue;
        }
        const [verdict] = await probe.probe([{ pid: value.pid, identity }]);
        if (!verdict || verdict.state !== "exited") { blockers.push(`writer_not_confirmed_exited:${value.token}:${verdict?.reason_code ?? "no_verdict"}`); continue; }
        rmSync(file);
        reaped += 1;
      }
      for (const taskId of store.listTaskIds()) {
        let status;
        try { status = store.readStatus(taskId); }
        catch { blockers.push(`task_status_unknown:${taskId}`); continue; }
        if (!isTerminalStatus(status.status) && status.status !== "queued") blockers.push(`task_not_terminal:${taskId}:${status.status}`);
        if (status.cleanup_unverified === true) { blockers.push(`cleanup_unverified:${taskId}`); continue; }
        const { executors, cleanupMembers } = attemptExecutorRequests(store, taskId, status, blockers);
        const requests = [...executors, ...cleanupMembers];
        if (requests.length) {
          let verdicts;
          try { verdicts = await probe.probe(requests); }
          catch { blockers.push(`executor_probe_unknown:${taskId}`); continue; }
          if (verdicts.length !== requests.length) {
            blockers.push(`executor_probe_incomplete:${taskId}`);
            continue;
          }
          const executorVerdicts = verdicts.slice(0, executors.length);
          const cleanupMemberVerdicts = verdicts.slice(executors.length);
          if (executorVerdicts.some((verdict) => verdict.state !== "exited")) {
            blockers.push(`executor_not_confirmed_exited:${taskId}`);
          }
          if (cleanupMemberVerdicts.some((verdict) => verdict.state !== "exited")) {
            blockers.push(`task_cleanup_member_not_confirmed_exited:${taskId}`);
          }
        }
      }
      if (blockers.length) return { sealed: false, state: "draining", blockers, reaped_leases: reaped };
      // The Manager lock fences every supported Manager mutation/pump; the
      // roster lock fences registrations. All TaskStore writers are now gone.
      writeFence(dataRoot, { ...current, state: "sealed", revision: current.revision + 1, updated_at: new Date().toISOString() }, durability);
      return { sealed: true, state: "sealed", blockers: [], reaped_leases: reaped };
      }),
    ),
  );
}

