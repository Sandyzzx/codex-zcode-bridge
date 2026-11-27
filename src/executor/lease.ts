import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe } from "../runtime/process-probe.js";

export const EXECUTOR_LEASE_PROTOCOL_VERSION = 1 as const;
export const EXECUTOR_LEASE_FILE = "executor-lease.json";
export const EXECUTOR_LEASE_RELEASED_FILE = "executor-lease.released.json";
export const EXECUTOR_LEASE_CLEARED_FILE = "executor-lease.cleared.json";
export const EXECUTOR_UNLEASED_TRANSITION_ENV = "ZCODE_BRIDGE_ACCEPT_UNLEASED_AUTHORITY";
const LEASE_LIMIT_BYTES = 64 * 1024;

export type ExecutorOwnerKind = "executor" | "legacy_mcp";

export type ExecutorLeaseState = "active" | "stale_unknown" | "released";

export interface ExecutorLeaseOwner {
  readonly owner_kind: ExecutorOwnerKind;
  readonly process_id: number;
  readonly start_fingerprint: string | null;
  readonly fingerprint_precision: "exact" | "coarse" | "unknown";
  readonly identity_version: typeof PROCESS_IDENTITY_VERSION;
  readonly platform: string;
  readonly captured_at: string;
}

export interface ExecutorLeaseRecord {
  readonly lease_id: string;
  readonly authority_root_digest: string;
  readonly protocol_version: number;
  readonly owner: ExecutorLeaseOwner;
  readonly bridge_sha256: string;
  readonly worker_sha256: string;
  readonly started_at: string;
  readonly heartbeat_at: string;
  readonly pipe_name: string | null;
  readonly state: ExecutorLeaseState;
  readonly lease_digest: string;
}

export type ExecutorLeaseAcquisition =
  | { readonly status: "already_active"; readonly lease: ExecutorLeaseRecord }
  | { readonly status: "stale_unknown"; readonly reason: string; readonly lease?: ExecutorLeaseRecord };

export class ExecutorLeaseError extends Error {
  constructor(
    readonly code:
      | "EXECUTOR_LEASE_ROOT_UNSAFE"
      | "EXECUTOR_LEASE_MALFORMED"
      | "EXECUTOR_LEASE_OWNER_UNKNOWN"
      | "EXECUTOR_LEASE_OWNER_ACTIVE"
      | "EXECUTOR_LEASE_TRANSITION_REQUIRED"
      | "EXECUTOR_LEASE_RELEASE_UNKNOWN"
      | "EXECUTOR_HEARTBEAT_FAILED",
    message: string = code,
  ) {
    super(message);
    this.name = "ExecutorLeaseError";
  }
}

export interface ExecutorLeaseInput {
  readonly authorityRoot: string;
  readonly ownerKind: ExecutorOwnerKind;
  readonly processProbe: ProcessProbe;
  readonly identity?: ProcessIdentity;
  readonly bridgeSha256: string;
  readonly workerSha256: string;
  readonly pipeName?: string | null;
  readonly now?: () => number;
}

export interface ExecutorLeaseHandle {
  readonly lease: ExecutorLeaseRecord;
  heartbeat(options?: { readonly onUnknown?: (error: Error) => void }): Promise<void>;
  assertOwned(): Promise<void>;
  release(options?: { readonly markStale?: boolean }): Promise<void>;
}

export interface ExecutorLeaseClearInput {
  readonly authorityRoot: string;
  readonly processProbe: ProcessProbe;
  readonly now?: () => number;
}

export interface ExecutorLeaseInspection {
  readonly lease: ExecutorLeaseRecord;
  readonly owner_state: "alive" | "exited" | "unknown";
  readonly heartbeat_age_ms: number | null;
}

/**
 * A historical MCP Host has no Lease file. Refuse to infer that an existing
 * SQLite Authority is unowned; the operator must stop the old Host, verify no
 * owner remains, and explicitly acknowledge the one-time transition.
 */
export function assertExecutorLeaseTransition(input: {
  readonly authorityRoot: string;
  readonly databaseFileName: string;
  readonly acceptUnleasedExistingRoot: boolean;
}): void {
  const root = ensurePlainRoot(input.authorityRoot);
  if (existsSync(path.join(root, EXECUTOR_LEASE_FILE))) return;
  const leaseHistory = hasValidLeaseHistory(root);
  if (leaseHistory || !existsSync(path.join(root, input.databaseFileName))) return;
  if (input.acceptUnleasedExistingRoot) return;
  throw new ExecutorLeaseError(
    "EXECUTOR_LEASE_TRANSITION_REQUIRED",
    `existing Authority has no Lease history; stop and verify the old MCP Host, then set ${EXECUTOR_UNLEASED_TRANSITION_ENV}=1 for this transition`,
  );
}

function hasValidLeaseHistory(root: string): boolean {
  const candidates = [
    EXECUTOR_LEASE_RELEASED_FILE,
    ...readdirSync(root).filter((name) => name.startsWith(`${EXECUTOR_LEASE_CLEARED_FILE}.`)),
  ];
  return candidates.some((name) => {
    try {
      const record = readLease(path.join(root, name));
      return record.state === "released" || record.state === "stale_unknown";
    } catch {
      return false;
    }
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value)) ?? "null";
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortObject(item)]));
}

export function authorityRootDigest(root: string): string {
  return createHash("sha256").update(path.resolve(root).toLowerCase(), "utf8").digest("hex");
}

function ownerFromIdentity(ownerKind: ExecutorOwnerKind, identity: ProcessIdentity): ExecutorLeaseOwner {
  return {
    owner_kind: ownerKind,
    process_id: identity.pid,
    start_fingerprint: identity.fingerprint,
    fingerprint_precision: identity.fingerprint_precision,
    identity_version: identity.identity_version,
    platform: identity.platform,
    captured_at: identity.captured_at,
  };
}

function leaseDigest(record: Omit<ExecutorLeaseRecord, "lease_digest">): string {
  return createHash("sha256").update(canonicalJson(record), "utf8").digest("hex");
}

function ensurePlainRoot(root: string): string {
  let current: string;
  try {
    current = path.resolve(root);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not_plain_directory");
  } catch {
    throw new ExecutorLeaseError("EXECUTOR_LEASE_ROOT_UNSAFE", "authority root must be an existing plain directory");
  }
  return current;
}

function readLease(file: string): ExecutorLeaseRecord {
  let parsed: unknown;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LEASE_LIMIT_BYTES) throw new Error("unsafe_lease_file");
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ExecutorLeaseError("EXECUTOR_LEASE_MALFORMED");
  }
  const record = parsed as Partial<ExecutorLeaseRecord>;
  if (!record || typeof record !== "object" || record.lease_id === undefined
    || record.authority_root_digest !== authorityRootDigest(path.dirname(file))
    || record.protocol_version !== EXECUTOR_LEASE_PROTOCOL_VERSION
    || !record.owner || typeof record.owner !== "object" || !["executor", "legacy_mcp"].includes(record.owner.owner_kind ?? "")
    || !Number.isInteger(record.owner.process_id) || record.owner.process_id <= 0
    || typeof record.owner.start_fingerprint !== "string" || record.owner.fingerprint_precision !== "exact"
    || record.owner.identity_version !== PROCESS_IDENTITY_VERSION
    || typeof record.owner.platform !== "string" || typeof record.owner.captured_at !== "string"
    || !/^[0-9a-f]{64}$/iu.test(record.bridge_sha256 ?? "") || !/^[0-9a-f]{64}$/iu.test(record.worker_sha256 ?? "")
    || typeof record.started_at !== "string" || typeof record.heartbeat_at !== "string"
    || !["active", "stale_unknown", "released"].includes(record.state ?? "")
    || typeof record.lease_digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.lease_digest)) {
    throw new ExecutorLeaseError("EXECUTOR_LEASE_MALFORMED");
  }
  const { lease_digest: recordedDigest, ...body } = record as ExecutorLeaseRecord;
  if (recordedDigest !== leaseDigest(body)) throw new ExecutorLeaseError("EXECUTOR_LEASE_MALFORMED");
  return { ...body, lease_digest: record.lease_digest };
}

async function probeOwner(owner: ExecutorLeaseOwner, processProbe: ProcessProbe): Promise<"alive" | "exited" | "unknown"> {
  const [verdict] = await processProbe.probe([{
    pid: owner.process_id,
    identity: {
      pid: owner.process_id,
      fingerprint: owner.start_fingerprint,
      fingerprint_precision: owner.fingerprint_precision,
      identity_version: owner.identity_version,
      platform: owner.platform,
      captured_at: owner.captured_at,
    },
  }]);
  if (verdict?.state === "alive") return "alive";
  if (verdict?.state === "exited") return "exited";
  return "unknown";
}

function writeLeaseFile(file: string, record: ExecutorLeaseRecord): void {
  const temporary = `${file}.new-${randomUUID()}`;
  const payload = canonicalJson(record);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeSync(fd, payload, undefined, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    // A completed rename can still leave an unknown state if the target is
    // unreadable or was replaced by another writer during the update.
    const observed = readLease(file);
    if (observed.lease_id !== record.lease_id || observed.lease_digest !== record.lease_digest) {
      throw new Error("lease_update_readback_mismatch");
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* release result is unknown */ }
    throw new ExecutorLeaseError("EXECUTOR_LEASE_RELEASE_UNKNOWN", error instanceof Error ? error.message : String(error));
  }
}

function updateState(file: string, lease: ExecutorLeaseRecord, state: ExecutorLeaseState, now: () => number): ExecutorLeaseRecord {
  const { lease_digest: _previousDigest, ...previous } = lease;
  const body = { ...previous, state, heartbeat_at: new Date(now()).toISOString() };
  const updated = { ...body, lease_digest: leaseDigest(body) };
  writeLeaseFile(file, updated);
  return updated;
}

function releaseLeaseFile(file: string, lease: ExecutorLeaseRecord, now: () => number): void {
  const released = updateState(file, lease, "released", now);
  const archive = path.join(path.dirname(file), EXECUTOR_LEASE_RELEASED_FILE);
  try {
    renameSync(file, archive);
    return;
  } catch {
    // A stale archive must not make the active lease path look like a
    // successful release. Persist the released record at the archive path
    // first, then remove the active path. Any failure remains fail closed.
  }
  try {
    writeLeaseFile(archive, released);
    unlinkSync(file);
  } catch (error) {
    throw new ExecutorLeaseError(
      "EXECUTOR_LEASE_RELEASE_UNKNOWN",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function acquireExecutorLease(input: ExecutorLeaseInput): Promise<ExecutorLeaseHandle> {
  const root = ensurePlainRoot(input.authorityRoot);
  const file = path.join(root, EXECUTOR_LEASE_FILE);
  const now = input.now ?? Date.now;
  const identity = input.identity ?? await input.processProbe.selfIdentity();
  if (identity.fingerprint === null || identity.fingerprint_precision !== "exact") {
    throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", "executor owner requires an exact process identity");
  }
  if (existsSync(file)) {
    const existing = readLease(file);
    const ownerState = await probeOwner(existing.owner, input.processProbe);
    if (existing.state === "active" && ownerState === "alive") {
      throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", "EXECUTOR_ALREADY_ACTIVE");
    }
    const reason = ownerState === "unknown"
      ? "owner_probe_unknown"
      : existing.state === "released"
        ? "unpublished_released_lease_requires_clear"
        : ownerState === "alive"
          ? "non_active_lease_owner_still_alive"
          : "owner_exited_requires_explicit_clear";
    try {
      updateState(file, existing, "stale_unknown", now);
    } catch {
      // The malformed or unreleasable active lease remains fail-closed.
    }
    throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", reason);
  }

  const at = new Date(now()).toISOString();
  const body = {
    lease_id: randomUUID(),
    authority_root_digest: authorityRootDigest(root),
    protocol_version: EXECUTOR_LEASE_PROTOCOL_VERSION,
    owner: ownerFromIdentity(input.ownerKind, identity),
    bridge_sha256: input.bridgeSha256,
    worker_sha256: input.workerSha256,
    started_at: at,
    heartbeat_at: at,
    pipe_name: input.pipeName ?? null,
    state: "active" as const,
  };
  const lease: ExecutorLeaseRecord = { ...body, lease_digest: leaseDigest(body) };
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, canonicalJson(lease), undefined, "utf8");
    } finally {
      closeSync(fd);
    }
    const observed = readLease(file);
    if (observed.lease_id !== lease.lease_id || observed.lease_digest !== lease.lease_digest) {
      throw new Error("lease_create_readback_mismatch");
    }
  } catch {
    // A concurrent winner or a failed durable create leaves this process
    // without Store ownership; the caller must not retry automatically.
    throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", "executor lease atomic create did not win");
  }
  const handle: ExecutorLeaseHandle = {
    lease,
    async heartbeat(heartbeatOptions = {}) {
      try {
        const current = readLease(file);
        if (current.state !== "active" || current.lease_id !== lease.lease_id) {
          throw new ExecutorLeaseError("EXECUTOR_HEARTBEAT_FAILED", "executor lease no longer belongs to this owner");
        }
        updateState(file, current, "active", now);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        heartbeatOptions.onUnknown?.(failure);
        throw failure;
      }
    },
    async assertOwned() {
      const current = readLease(file);
      if (current.state !== "active" || current.lease_id !== lease.lease_id) {
        throw new ExecutorLeaseError("EXECUTOR_HEARTBEAT_FAILED", "executor lease no longer belongs to this owner");
      }
    },
    async release(options = {}) {
      const current = readLease(file);
      if (current.lease_id !== lease.lease_id) {
        throw new ExecutorLeaseError("EXECUTOR_LEASE_RELEASE_UNKNOWN", "executor lease identity changed before release");
      }
      const state = options.markStale === true ? "stale_unknown" : "released";
      if (state === "stale_unknown") {
        updateState(file, current, state, now);
      } else {
        releaseLeaseFile(file, current, now);
      }
    },
  };
  return handle;
}

/** Read the active Lease and exact owner state without changing any file. */
export async function inspectExecutorLease(input: {
  readonly authorityRoot: string;
  readonly processProbe: ProcessProbe;
  readonly now?: () => number;
}): Promise<ExecutorLeaseInspection> {
  const root = ensurePlainRoot(input.authorityRoot);
  const file = path.join(root, EXECUTOR_LEASE_FILE);
  if (!existsSync(file)) throw new ExecutorLeaseError("EXECUTOR_LEASE_MALFORMED", "executor lease is absent");
  const lease = readLease(file);
  const ownerState = await probeOwner(lease.owner, input.processProbe);
  const heartbeatAt = Date.parse(lease.heartbeat_at);
  const age = Number.isFinite(heartbeatAt) ? Math.max(0, (input.now ?? Date.now)() - heartbeatAt) : null;
  return { lease, owner_state: ownerState, heartbeat_age_ms: age };
}

/**
 * Explicit operator recovery for an abandoned lease. The Task CLI exposes
 * this exact-owner guard after an explicit confirmation flag.
 */
export async function clearExecutorLease(input: ExecutorLeaseClearInput): Promise<ExecutorLeaseRecord> {
  const root = ensurePlainRoot(input.authorityRoot);
  const file = path.join(root, EXECUTOR_LEASE_FILE);
  if (!existsSync(file)) throw new ExecutorLeaseError("EXECUTOR_LEASE_MALFORMED", "executor lease is absent");
  const lease = readLease(file);
  const ownerState = await probeOwner(lease.owner, input.processProbe);
  if (ownerState === "alive") {
    throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_ACTIVE", "refusing to clear an exact live executor owner");
  }
  if (ownerState !== "exited") {
    throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", "refusing to clear an owner whose exit is not proven");
  }
  const now = input.now ?? Date.now;
  const stale = updateState(file, lease, "stale_unknown", now);
  const archive = path.join(root, `${EXECUTOR_LEASE_CLEARED_FILE}.${lease.lease_id}`);
  try {
    renameSync(file, archive);
  } catch (error) {
    throw new ExecutorLeaseError(
      "EXECUTOR_LEASE_RELEASE_UNKNOWN",
      error instanceof Error ? error.message : String(error),
    );
  }
  return stale;
}
