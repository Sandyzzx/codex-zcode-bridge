import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { authorityRootDigest } from "../executor/lease.js";
import {
  createPlatformProbe,
  PROCESS_IDENTITY_VERSION,
  type ProcessIdentity,
  type ProcessProbe,
} from "../runtime/process-probe.js";

export const TASK_CONSOLE_DISCOVERY_FILE = "task-console.json";
export const TASK_CONSOLE_PROTOCOL_VERSION = 1 as const;
const DISCOVERY_LIMIT_BYTES = 16 * 1024;
const TASK_CONSOLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type TaskConsoleDiscoveryState = "absent" | "active_owner" | "stale_owner" | "owner_unknown";

export interface TaskConsoleDiscoveryRecord {
  readonly protocol_version: typeof TASK_CONSOLE_PROTOCOL_VERSION;
  readonly console_id: string;
  readonly authority_root_digest: string;
  readonly pid: number;
  readonly start_fingerprint: string | null;
  readonly fingerprint_precision: "exact" | "coarse" | "unknown";
  readonly identity_version: number;
  readonly platform: string;
  readonly captured_at: string;
  readonly origin: string;
  readonly url: string;
  readonly port: number;
  readonly started_at: string;
  readonly record_digest: string;
}

export interface TaskConsoleDiscoveryInput {
  readonly dataRoot: string;
  readonly consoleId: string;
  readonly origin: string;
  readonly url: string;
  readonly port: number;
  readonly startedAt?: string;
  readonly processProbe?: ProcessProbe;
}

export interface TaskConsoleDiscoveryInspection {
  readonly state: TaskConsoleDiscoveryState;
  readonly record?: TaskConsoleDiscoveryRecord;
}

export interface TaskConsoleSession {
  readonly csrf_token: string;
  readonly executor: Record<string, unknown>;
  readonly console: {
    readonly console_id: string;
    readonly authority_root_digest: string;
    readonly url: string;
  };
}

export class TaskConsoleDiscoveryError extends Error {
  constructor(
    readonly code:
      | "WEB_CONSOLE_ROOT_UNSAFE"
      | "WEB_CONSOLE_DISCOVERY_INVALID"
      | "WEB_CONSOLE_DISCOVERY_EXISTS"
      | "WEB_CONSOLE_DISCOVERY_CHANGED"
      | "WEB_CONSOLE_OWNER_UNRESPONSIVE"
      | "WEB_CONSOLE_SESSION_INVALID",
    message: string = code,
  ) {
    super(message);
    this.name = "TaskConsoleDiscoveryError";
  }
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

function recordDigest(record: Omit<TaskConsoleDiscoveryRecord, "record_digest">): string {
  return createHash("sha256").update(canonicalJson(record), "utf8").digest("hex");
}

function discoveryRoot(dataRoot: string): string {
  let root: string;
  try {
    root = path.resolve(dataRoot);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not_plain_directory");
  } catch {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_ROOT_UNSAFE");
  }
  return root;
}

function validatedEndpoint(originValue: string, urlValue: string, port: number): void {
  let origin: URL;
  let url: URL;
  try {
    origin = new URL(originValue);
    url = new URL(urlValue);
  } catch {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
  if (origin.origin !== originValue
    || origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1"
    || origin.port !== String(port)
    || url.origin !== originValue
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
}

export function taskConsoleDiscoveryPath(dataRoot: string): string {
  return path.join(discoveryRoot(dataRoot), TASK_CONSOLE_DISCOVERY_FILE);
}

function parseRecord(value: string): TaskConsoleDiscoveryRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
  const record = parsed as Partial<TaskConsoleDiscoveryRecord>;
  if (record.protocol_version !== TASK_CONSOLE_PROTOCOL_VERSION
    || typeof record.console_id !== "string" || !TASK_CONSOLE_ID.test(record.console_id)
    || typeof record.authority_root_digest !== "string" || !SHA256.test(record.authority_root_digest)
    || !Number.isSafeInteger(record.pid) || record.pid! < 1
    || (record.start_fingerprint !== null && typeof record.start_fingerprint !== "string")
    || !["exact", "coarse", "unknown"].includes(record.fingerprint_precision ?? "")
    || record.identity_version !== PROCESS_IDENTITY_VERSION
    || typeof record.platform !== "string"
    || typeof record.captured_at !== "string"
    || typeof record.origin !== "string"
    || typeof record.url !== "string"
    || !Number.isSafeInteger(record.port) || record.port! < 1 || record.port! > 65_535
    || typeof record.started_at !== "string"
    || typeof record.record_digest !== "string" || !SHA256.test(record.record_digest)) {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
  let origin: URL;
  let url: URL;
  try {
    origin = new URL(record.origin);
    url = new URL(record.url);
  } catch {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
  if (origin.origin !== record.origin
    || origin.protocol !== "http:"
    || origin.hostname !== "127.0.0.1"
    || origin.port !== String(record.port)
    || url.origin !== record.origin
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== "") {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
  const { record_digest: recordedDigest, ...body } = record as TaskConsoleDiscoveryRecord;
  if (recordDigest(body) !== recordedDigest) {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
  return { ...body, record_digest: recordedDigest };
}

export function readTaskConsoleDiscovery(dataRoot: string): TaskConsoleDiscoveryRecord | null {
  const file = taskConsoleDiscoveryPath(dataRoot);
  if (!existsSync(file)) return null;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DISCOVERY_LIMIT_BYTES) {
      throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
    }
    const record = parseRecord(readFileSync(file, "utf8"));
    if (record.authority_root_digest !== authorityRootDigest(dataRoot)) {
      throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
    }
    return record;
  } catch (error) {
    if (error instanceof TaskConsoleDiscoveryError) throw error;
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  }
}

export async function publishTaskConsoleDiscovery(
  input: TaskConsoleDiscoveryInput,
): Promise<TaskConsoleDiscoveryRecord> {
  const root = discoveryRoot(input.dataRoot);
  if (!TASK_CONSOLE_ID.test(input.consoleId)) throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
  validatedEndpoint(input.origin, input.url, input.port);
  const identity = await (input.processProbe ?? createPlatformProbe()).selfIdentity();
  const body = {
    protocol_version: TASK_CONSOLE_PROTOCOL_VERSION,
    console_id: input.consoleId,
    authority_root_digest: authorityRootDigest(root),
    pid: identity.pid,
    start_fingerprint: identity.fingerprint,
    fingerprint_precision: identity.fingerprint_precision,
    identity_version: identity.identity_version,
    platform: identity.platform,
    captured_at: identity.captured_at,
    origin: input.origin,
    url: input.url,
    port: input.port,
    started_at: input.startedAt ?? new Date().toISOString(),
  } as const;
  const record: TaskConsoleDiscoveryRecord = { ...body, record_digest: recordDigest(body) };
  const file = path.join(root, TASK_CONSOLE_DISCOVERY_FILE);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(file, "wx", 0o600);
    created = true;
    writeSync(fd, canonicalJson(record), undefined, "utf8");
    closeSync(fd);
    fd = undefined;
    if (readTaskConsoleDiscovery(root)?.record_digest !== record.record_digest) {
      throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_INVALID");
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
      fd = undefined;
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_EXISTS");
    }
    if (created) {
      try { unlinkSync(file); } catch { /* retain a failed discovery only if it cannot be removed */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
  return record;
}

function identityFromRecord(record: TaskConsoleDiscoveryRecord): ProcessIdentity {
  return {
    pid: record.pid,
    fingerprint: record.start_fingerprint,
    fingerprint_precision: record.fingerprint_precision,
    identity_version: PROCESS_IDENTITY_VERSION,
    platform: record.platform,
    captured_at: record.captured_at,
  };
}

export async function inspectTaskConsoleDiscovery(
  dataRoot: string,
  processProbe: ProcessProbe = createPlatformProbe(),
): Promise<TaskConsoleDiscoveryInspection> {
  let record: TaskConsoleDiscoveryRecord | null;
  try {
    record = readTaskConsoleDiscovery(dataRoot);
  } catch (error) {
    if (error instanceof TaskConsoleDiscoveryError && error.code === "WEB_CONSOLE_DISCOVERY_INVALID") {
      throw error;
    }
    throw error;
  }
  if (record === null) return { state: "absent" };
  const [verdict] = await processProbe.probe([{
    pid: record.pid,
    identity: identityFromRecord(record),
  }]);
  if (!verdict || verdict.state === "unknown") return { state: "owner_unknown", record };
  if (verdict.state === "exited") return { state: "stale_owner", record };
  return { state: "active_owner", record };
}

export function removeTaskConsoleDiscovery(
  dataRoot: string,
  expected: Pick<TaskConsoleDiscoveryRecord, "console_id" | "record_digest">,
): void {
  const current = readTaskConsoleDiscovery(dataRoot);
  if (current === null) return;
  if (current.console_id !== expected.console_id || current.record_digest !== expected.record_digest) {
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_DISCOVERY_CHANGED");
  }
  try {
    unlinkSync(taskConsoleDiscoveryPath(dataRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function fetchTaskConsoleSession(
  record: TaskConsoleDiscoveryRecord,
  timeoutMs = 2_000,
): Promise<TaskConsoleSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/api/session", record.url), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as {
      ok?: boolean;
      result?: TaskConsoleSession;
    } | null;
    if (!response.ok || body?.ok !== true || !body.result
      || body.result.console?.console_id !== record.console_id
      || body.result.console?.authority_root_digest !== record.authority_root_digest
      || body.result.console?.url !== record.url) {
      throw new TaskConsoleDiscoveryError("WEB_CONSOLE_SESSION_INVALID");
    }
    return body.result;
  } catch (error) {
    if (error instanceof TaskConsoleDiscoveryError) throw error;
    throw new TaskConsoleDiscoveryError("WEB_CONSOLE_OWNER_UNRESPONSIVE");
  } finally {
    clearTimeout(timer);
  }
}
