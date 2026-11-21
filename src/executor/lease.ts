import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe } from "../runtime/process-probe.js";

export const EXECUTOR_LEASE_PROTOCOL_VERSION = 1 as const;
export const EXECUTOR_LEASE_FILE = "executor-lease.json";
export const EXECUTOR_LEASE_RELEASED_FILE = "executor-lease.released.json";
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
  heartbeat(): Promise<void>;
  release(options?: { readonly markStale?: boolean }): Promise<void>;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortObject(item)]));
}

export function authorityRootDigest(root: string): string {
  return createHash("sha256").update(path.resolve(root).toLocaleLowerCase("en-US"), "utf8").digest("hex");
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
    || !/^[0-9a-f]{64}$/u.test(record.bridge_sha256 ?? "") || !/^[0-9a-f]{64}$/u.test(record.worker_sha256 ?? "")
    || typeof record.started_at !== "string" || typeof record.heartbeat_at !== "string"
    || !["active", "stale_unknown", "released"].includes(record.state ?? "")
    || typeof record.lease_digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.lease_digest)) {
    throw new ExecutorLeaseError("EXECUTOR_LEASE_MALFORMED");
  }
  const { lease_digest: _leaseDigest, ...body } = record as ExecutorLeaseRecord;
  if (leaseDigest(body) !== record.lease_digest) throw new ExecutorLeaseError("EXECUTOR_LEASE_MALFORMED");
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
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeSync(fd, canonicalJson(record), undefined, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* release result is unknown */ }
    throw new ExecutorLeaseError("EXECUTOR_LEASE_RELEASE_UNKNOWN", error instanceof Error ? error.message : String(error));
  }
}

function updateState(file: string, lease: ExecutorLeaseRecord, state: ExecutorLeaseState, now: () => number): ExecutorLeaseRecord {
  const body = { ...lease, state, heartbeat_at: new Date(now()).toISOString() };
  const updated = { ...body, lease_digest: leaseDigest(body) };
  writeLeaseFile(file, updated);
  return updated;
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
    const ownerState = existing.state === "released" ? "exited" : await probeOwner(existing.owner, input.processProbe);
    if (existing.state === "active" && ownerState === "alive") {
      throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", "EXECUTOR_ALREADY_ACTIVE");
    }
    if (ownerState !== "exited") {
      const reason = existing.state === "active" && ownerState === "unknown"
        ? "owner_probe_unknown"
        : "stale_or_released_owner_not_proven_exited";
      try { updateState(file, existing, "stale_unknown", now); } catch { /* The malformed/unreleasable active lease remains fail-closed. */ }
      throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", reason);
    }
    const released = updateState(file, existing, "released", now);
    renameSync(file, path.join(root, EXECUTOR_LEASE_RELEASED_FILE));
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
  } catch {
    // A concurrent winner or a failed durable create leaves this process
    // without Store ownership; the caller must not retry automatically.
    throw new ExecutorLeaseError("EXECUTOR_LEASE_OWNER_UNKNOWN", "executor lease atomic create did not win");
  }
  const handle: ExecutorLeaseHandle = {
    lease,
    async heartbeat() {
      const current = readLease(file);
      if (current.state !== "active" || current.lease_id !== lease.lease_id) {
        throw new ExecutorLeaseError("EXECUTOR_HEARTBEAT_FAILED", "executor lease no longer belongs to this owner");
      }
      updateState(file, current, "active", now);
    },
    async release(options = {}) {
      const current = readLease(file);
      if (current.lease_id !== lease.lease_id) {
        throw new ExecutorLeaseError("EXECUTOR_LEASE_RELEASE_UNKNOWN", "executor lease identity changed before release");
      }
      const state = options.markStale === true ? "stale_unknown" : "released";
      updateState(file, current, state, now);
      if (state === "released") renameSync(file, path.join(root, EXECUTOR_LEASE_RELEASED_FILE));
    },
  };
  return handle;
}
