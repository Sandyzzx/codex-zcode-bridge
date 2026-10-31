import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  defaultDurableFileOperations,
  type DurableFileOperations,
} from "../runtime/durable-file-system.js";
import {
  readJsonHistoryArchiveSnapshot,
  type JsonHistoryArchiveIdentity,
  type JsonHistoryArchiveSnapshot,
} from "./json-history-archive.js";
import { jsonWriterFenceState } from "./json-writer-quiescence.js";
import {
  loadLifecycleCandidateModules,
  type LifecycleCandidateModules,
} from "./lifecycle-gate.js";
import {
  SQLITE_CANDIDATE_SCHEMA_VERSION,
  SQLITE_CUTOVER_PROTOCOL_VERSION,
  SQLITE_CUTOVER_VERIFIER_VERSION,
  currentSqliteRuntimeRosterDigest,
} from "../runtime/sqlite-runtime-roster.js";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_INTERACTION_PARAMS_BYTES = 1024 * 1024;
const LEGACY_INTERACTION_PARAMS_BYTES = 32_000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);
const ALLOWED_TASK_ROOT_FILES = new Set([
  "task.json",
  "status.json",
  "events.jsonl",
  "events.seq",
  "events.gen",
  "events.index",
  "result.json",
  "stdout.log",
  "stderr.log",
  "submission.json",
  "workspace.json",
]);
const ALLOWED_TASK_ROOT_CONTROL_FILE = ".recovery-last-run";
// Historical attempt evidence is byte-preserved, but only TaskStore's known
// record set may cross the Authority boundary. In particular, arbitrary raw
// files and active respawn markers are not silently promoted into SQLite.
const ALLOWED_ATTEMPT_FILES = new Set([
  "result.json",
  "execution.claim",
  "runtime-provenance.json",
  "started.json",
  "prompt.txt",
  "turn-correlation.json",
  "failure-facts.json",
  "outcome-checkpoint.json",
  "cleanup-failure.json",
  "outcome.json",
  "observation.json",
  "executor-identity.json",
  "continue.json",
  "worker-identity.json",
  "heartbeat.json",
  "worker-stderr.log",
]);

export interface JsonAuthorityArtifact {
  readonly artifact_id: string;
  readonly relative_path: string;
  readonly task_id: string | null;
  readonly attempt: number | null;
  readonly kind: string;
  readonly byte_length: number;
  readonly sha256: string;
  readonly content: Uint8Array;
}

export interface JsonAuthorityTask {
  readonly task_id: string;
  readonly task: Record<string, unknown>;
  readonly status: string;
  readonly current_attempt: number;
  readonly created_at: string;
  readonly attempts: readonly {
    readonly attempt: number;
    readonly status: string;
    readonly created_at: string;
  }[];
}

export interface JsonAuthorityResult {
  readonly task_id: string;
  readonly attempt: number;
  readonly result: Record<string, unknown>;
  readonly artifact_id: string;
}

export interface JsonAuthorityEvent {
  readonly task_id: string;
  readonly attempt: number | null;
  readonly source_sequence: number;
  readonly event_type: string;
  readonly at: string;
  readonly summary: string;
  readonly details: Record<string, unknown> | null;
  readonly artifact_id: string;
}

export interface JsonAuthoritySourceManifest {
  readonly root_digest: string;
  readonly manifest_digest: string;
  readonly manifest_json: string;
  readonly task_count: number;
  readonly artifact_count: number;
  readonly artifact_bytes: number;
  readonly result_count: number;
  readonly event_count: number;
}

export interface JsonAuthoritySnapshot {
  readonly schema_version: 1;
  readonly migration_id: string;
  readonly cutover_id: string;
  readonly protocol_version: typeof SQLITE_CUTOVER_PROTOCOL_VERSION;
  readonly verifier_version: typeof SQLITE_CUTOVER_VERIFIER_VERSION;
  readonly runtime_roster_digest: string;
  readonly source: JsonAuthoritySourceManifest;
  readonly archive: JsonHistoryArchiveIdentity;
  readonly tasks: readonly JsonAuthorityTask[];
  readonly artifacts: readonly JsonAuthorityArtifact[];
  readonly results: readonly JsonAuthorityResult[];
  readonly events: readonly JsonAuthorityEvent[];
}

export interface JsonAuthorityScan {
  readonly data_root: string;
  readonly tasks_root: string;
  readonly manifest: JsonAuthoritySourceManifest;
  readonly snapshot: Omit<JsonAuthoritySnapshot, "migration_id" | "cutover_id" | "runtime_roster_digest" | "archive">;
}

export interface PublishJsonAuthorityOptions {
  readonly jsonDataRoot: string;
  readonly sqliteRoot: string;
  readonly archiveDirectory: string;
  readonly expectedArchiveManifestDigest: string;
  readonly databaseFileName?: string;
  readonly durability?: DurableFileOperations;
}

export interface PublishJsonAuthorityResult {
  readonly status: "published";
  readonly database_path: string;
  readonly publication_receipt_path: string;
  readonly migration_id: string;
  readonly cutover_id: string;
  readonly source_manifest_digest: string;
  readonly source_root_digest: string;
  readonly archive: JsonHistoryArchiveIdentity;
  readonly task_count: number;
  readonly artifact_count: number;
  readonly artifact_bytes: number;
  readonly result_count: number;
  readonly event_count: number;
  readonly final_event_cursor: number;
}

interface ScannedFile {
  readonly relative_path: string;
  readonly absolute_path: string;
  readonly byte_length: number;
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly task_id: string | null;
  readonly attempt: number | null;
  readonly kind: string;
}

interface TaskScan {
  readonly task: JsonAuthorityTask;
  readonly files: ReadonlyMap<string, ScannedFile>;
  readonly results: readonly JsonAuthorityResult[];
  readonly events: readonly JsonAuthorityEvent[];
}

export class JsonAuthorityCutoverError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: string, details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = "JsonAuthorityCutoverError";
    this.code = code;
    this.details = details;
  }
}

function fail(code: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new JsonAuthorityCutoverError(code, details);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  fail("unsupported_json_value");
}

function jsonRecord(bytes: Buffer, relativePath: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("source_json_invalid", { path: relativePath });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("source_json_not_object", { path: relativePath });
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, relativePath: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) fail("source_record_invalid", { path: relativePath, field: key });
  return value;
}

function requiredAttempt(record: Record<string, unknown>, relativePath: string): number {
  const value = record.attempt;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("source_record_invalid", { path: relativePath, field: "attempt" });
  }
  return value as number;
}

function requiredTimestamp(record: Record<string, unknown>, key: string, relativePath: string): string {
  const value = requiredString(record, key, relativePath);
  if (!Number.isFinite(Date.parse(value))) fail("source_timestamp_invalid", { path: relativePath, field: key });
  return value;
}

function resolvePlainDirectory(value: string, label: string): string {
  let stat;
  try {
    stat = lstatSync(value);
  } catch {
    fail(`${label}_missing`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label}_unsafe`);
  const resolved = realpathSync.native(value);
  if (path.normalize(resolved).toLocaleLowerCase("en-US") !== path.normalize(value).toLocaleLowerCase("en-US")) {
    fail(`${label}_redirected`);
  }
  return resolved;
}

function scanFile(absolutePath: string, relativePath: string): ScannedFile {
  const before = lstatSync(absolutePath);
  if (before.isSymbolicLink() || !before.isFile()) fail("unsafe_source_entry", { path: relativePath });
  if (before.size > MAX_ARTIFACT_BYTES) fail("source_artifact_too_large", { path: relativePath });
  const bytes = readFileSync(absolutePath);
  const after = lstatSync(absolutePath);
  if (after.isSymbolicLink() || !after.isFile() || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev
    || bytes.length !== before.size) {
    fail("source_changed_during_snapshot", { path: relativePath });
  }
  const binding = artifactBinding(relativePath);
  if (binding.kind === "interaction") validateInteractionRecord(bytes, relativePath, binding.attempt!);
  return {
    relative_path: relativePath,
    absolute_path: absolutePath,
    byte_length: bytes.length,
    sha256: sha256(bytes),
    bytes,
    ...binding,
  };
}

function validateInteractionRecord(bytes: Buffer, relativePath: string, attempt: number): void {
  const record = jsonRecord(bytes, relativePath);
  const requestId = requiredString(record, "request_id", relativePath);
  if (requestId.length > 512) fail("source_interaction_invalid", { path: relativePath, field: "request_id" });
  const fileName = relativePath.split("/").at(-1)!;
  const expectedName = `${attempt}-${sha256(requestId)}.json`;
  if (fileName !== expectedName) fail("source_interaction_filename_mismatch", { path: relativePath });
  const method = requiredString(record, "method", relativePath);
  if (method !== "interaction/requestPermission" && method !== "interaction/requestUserInput") {
    fail("source_interaction_invalid", { path: relativePath, field: "method" });
  }
  if (!record.params || typeof record.params !== "object" || Array.isArray(record.params)) {
    fail("source_interaction_invalid", { path: relativePath, field: "params" });
  }
  const state = requiredString(record, "state", relativePath);
  if (state !== "pending" && state !== "answered") {
    fail("source_interaction_invalid", { path: relativePath, field: "state" });
  }
  requiredTimestamp(record, "created_at", relativePath);
  if (state === "answered") {
    if (!record.answer || typeof record.answer !== "object" || Array.isArray(record.answer)) {
      fail("source_interaction_invalid", { path: relativePath, field: "answer" });
    }
    requiredTimestamp(record, "answered_at", relativePath);
  } else if (record.answer !== undefined || record.answered_at !== undefined) {
    fail("source_interaction_invalid", { path: relativePath, field: "answer_state" });
  }
  const serialized = JSON.stringify(record.params);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_INTERACTION_PARAMS_BYTES) {
    fail("source_interaction_too_large", { path: relativePath, bytes: byteLength });
  }
  const hasBytes = record.params_bytes !== undefined;
  const hasDigest = record.params_sha256 !== undefined;
  if (!hasBytes && !hasDigest) {
    if (byteLength <= LEGACY_INTERACTION_PARAMS_BYTES) return;
    fail("source_interaction_integrity_missing", { path: relativePath, bytes: byteLength });
  }
  if (!hasBytes || !hasDigest
    || !Number.isSafeInteger(record.params_bytes) || (record.params_bytes as number) < 0
    || typeof record.params_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.params_sha256)
    || record.params_bytes !== byteLength || record.params_sha256 !== sha256(serialized)) {
    fail("source_interaction_integrity_invalid", { path: relativePath });
  }
}

function artifactBinding(relativePath: string): {
  readonly task_id: string | null;
  readonly attempt: number | null;
  readonly kind: string;
} {
  if (relativePath === ".writer-quiescence.json") return { task_id: null, attempt: null, kind: "writer_fence" };
  if (relativePath === ".writer-roster/registry.json") return { task_id: null, attempt: null, kind: "writer_registry" };
  if (relativePath === ALLOWED_TASK_ROOT_CONTROL_FILE) return { task_id: null, attempt: null, kind: "recovery_cooldown" };
  const parts = relativePath.split("/");
  const taskId = parts[0]!;
  if (!TASK_ID.test(taskId) || parts.length < 2) fail("unknown_source_entry", { path: relativePath });
  if (parts[1] === "attempts") {
    const attempt = Number(parts[2]);
    if (!/^[1-9]\d*$/u.test(parts[2] ?? "") || !Number.isSafeInteger(attempt) || parts.length !== 4
      || !ALLOWED_ATTEMPT_FILES.has(parts[3]!)) {
      fail("unknown_source_entry", { path: relativePath });
    }
    return {
      task_id: taskId,
      attempt,
      kind: parts[3] === "result.json" ? "attempt_result" : "attempt_artifact",
    };
  }
  if (parts[1] === "interactions" && parts.length === 3) {
    const interactionName = parts[2]!.match(/^([1-9]\d*)-[a-f0-9]{64}\.json$/u);
    if (!interactionName) fail("unknown_source_entry", { path: relativePath });
    const attempt = Number(interactionName[1]);
    if (!Number.isSafeInteger(attempt)) fail("unknown_source_entry", { path: relativePath });
    return { task_id: taskId, attempt, kind: "interaction" };
  }
  if (parts.length === 2 && ALLOWED_TASK_ROOT_FILES.has(parts[1]!)) {
    const kind = parts[1] === "result.json" ? "task_result"
      : parts[1] === "events.jsonl" ? "task_events"
        : parts[1] === "task.json" ? "task"
          : parts[1] === "status.json" ? "status"
            : "task_artifact";
    return { task_id: taskId, attempt: null, kind };
  }
  fail("unknown_source_entry", { path: relativePath });
}

function collectFiles(tasksRoot: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  function visit(directory: string, relativeDirectory: string): void {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"))) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        fail("unsafe_source_entry_name");
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolutePath = path.join(directory, name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail("source_symlink_rejected", { path: relativePath });
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        artifactBinding(relativePath);
        files.push(scanFile(absolutePath, relativePath));
      } else {
        fail("unsupported_source_entry", { path: relativePath });
      }
    }
  }
  visit(tasksRoot, "");
  return files.sort((left, right) => left.relative_path.localeCompare(right.relative_path, "en"));
}

function parseResult(record: Record<string, unknown>, relativePath: string, taskId: string, attempt: number): Record<string, unknown> {
  if (requiredString(record, "task_id", relativePath) !== taskId || requiredAttempt(record, relativePath) !== attempt) {
    fail("cross_bound_result", { path: relativePath });
  }
  const status = requiredString(record, "status", relativePath);
  if (!TERMINAL.has(status)) fail("source_result_not_terminal", { path: relativePath });
  requiredTimestamp(record, "finished_at", relativePath);
  if (record.started_at !== null) requiredTimestamp(record, "started_at", relativePath);
  return record;
}

function parseEvents(bytes: Buffer, relativePath: string, taskId: string, artifactId: string): JsonAuthorityEvent[] {
  const text = bytes.toString("utf8");
  if (text.includes("\r")) fail("source_event_line_ending_unsupported", { path: relativePath });
  const events: JsonAuthorityEvent[] = [];
  const seen = new Set<number>();
  let previousSequence = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { fail("source_event_invalid", { path: relativePath, sequence: previousSequence + 1 }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("source_event_invalid", { path: relativePath, sequence: previousSequence + 1 });
    }
    const event = value as Record<string, unknown>;
    const sequence = event.seq;
    const type = event.type;
    const summary = event.summary;
    const at = event.at;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || seen.has(sequence as number)
      || typeof type !== "string" || !type || type.length > 80
      || typeof summary !== "string"
      || typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
      fail("source_event_invalid", { path: relativePath, sequence });
    }
    if ((sequence as number) <= previousSequence) {
      fail("source_event_sequence_not_monotonic", {
        path: relativePath,
        previous: previousSequence,
        actual: sequence,
      });
    }
    const details = event.details;
    if (details !== undefined && (!details || typeof details !== "object" || Array.isArray(details))) {
      fail("source_event_details_invalid", { path: relativePath, sequence });
    }
    events.push({
      task_id: taskId,
      attempt: null,
      source_sequence: sequence as number,
      event_type: type,
      at,
      summary,
      details: details === undefined ? null : details as Record<string, unknown>,
      artifact_id: artifactId,
    });
    seen.add(sequence as number);
    previousSequence = sequence as number;
  }
  return events;
}

function scanTask(taskId: string, taskFiles: readonly ScannedFile[]): TaskScan {
  const byPath = new Map(taskFiles.map((file) => [file.relative_path, file]));
  for (const file of taskFiles) {
    const name = file.relative_path.split("/").at(-1)!;
    if (name.endsWith(".json") || name === "execution.claim") jsonRecord(file.bytes, file.relative_path);
  }
  const taskFile = byPath.get(`${taskId}/task.json`);
  const statusFile = byPath.get(`${taskId}/status.json`);
  if (!taskFile || !statusFile) fail("task_required_record_missing", { task_id: taskId });
  const task = jsonRecord(taskFile.bytes, taskFile.relative_path);
  const status = jsonRecord(statusFile.bytes, statusFile.relative_path);
  if (requiredString(task, "task_id", taskFile.relative_path) !== taskId
    || requiredString(status, "task_id", statusFile.relative_path) !== taskId) {
    fail("cross_bound_task", { task_id: taskId });
  }
  const currentAttempt = requiredAttempt(status, statusFile.relative_path);
  const currentStatus = requiredString(status, "status", statusFile.relative_path);
  if (!["queued", ...TERMINAL].includes(currentStatus)) fail("source_task_not_migratable", { task_id: taskId, status: currentStatus });
  if (status.cleanup_unverified === true) fail("cleanup_unverified_task_not_migratable", { task_id: taskId });
  const taskCreatedAt = requiredTimestamp(status, "created_at", statusFile.relative_path);

  const attemptIds = [...byPath.keys()]
    .map((relativePath) => relativePath.match(new RegExp(`^${taskId}/attempts/(\\d+)/`, "u"))?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const uniqueAttempts = [...new Set(attemptIds)].sort((left, right) => left - right);
  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    if (!uniqueAttempts.includes(attempt) && attempt !== 1) fail("source_attempt_gap", { task_id: taskId, attempt });
  }
  if (uniqueAttempts.some((attempt) => attempt > currentAttempt)
    || taskFiles.some((file) => file.attempt !== null && file.attempt > currentAttempt)) {
    fail("source_attempt_after_current", { task_id: taskId });
  }

  const artifacts: JsonAuthorityArtifact[] = taskFiles.map((file) => ({
    artifact_id: `artifact-${sha256(file.relative_path).slice(0, 40)}`,
    relative_path: file.relative_path,
    task_id: file.task_id,
    attempt: file.attempt,
    kind: file.kind,
    byte_length: file.byte_length,
    sha256: file.sha256,
    content: file.bytes,
  }));
  const artifactIdForPath = new Map(artifacts.map((artifact) => [artifact.relative_path, artifact.artifact_id]));
  const results: JsonAuthorityResult[] = [];
  const attempts: JsonAuthorityTask["attempts"][number][] = [];

  for (let attempt = 1; attempt <= currentAttempt; attempt += 1) {
    const relativeResultPath = attempt === currentAttempt
      ? `${taskId}/result.json`
      : `${taskId}/attempts/${attempt}/result.json`;
    const resultFile = byPath.get(relativeResultPath);
    let attemptStatus = attempt === currentAttempt ? currentStatus : "unknown";
    let createdAt = taskCreatedAt;
    if (resultFile) {
      const result = parseResult(jsonRecord(resultFile.bytes, relativeResultPath), relativeResultPath, taskId, attempt);
      attemptStatus = requiredString(result, "status", relativeResultPath);
      if (typeof result.started_at === "string") createdAt = result.started_at;
      results.push({
        task_id: taskId,
        attempt,
        result,
        artifact_id: artifactIdForPath.get(relativeResultPath)!,
      });
    } else if (attempt !== currentAttempt || currentStatus !== "queued") {
      fail("source_result_missing", { task_id: taskId, attempt });
    }
    attempts.push({ attempt, status: attemptStatus, created_at: createdAt });
  }
  if (results.some((result) => result.attempt === currentAttempt && currentStatus === "queued")) {
    fail("queued_task_has_result", { task_id: taskId });
  }

  const eventsFile = byPath.get(`${taskId}/events.jsonl`);
  const events = eventsFile
    ? parseEvents(eventsFile.bytes, eventsFile.relative_path, taskId, artifactIdForPath.get(eventsFile.relative_path)!)
    : [];
  return {
    task: {
      task_id: taskId,
      task,
      status: currentStatus,
      current_attempt: currentAttempt,
      created_at: taskCreatedAt,
      attempts,
    },
    files: byPath,
    results,
    events,
  };
}

function buildManifest(files: readonly ScannedFile[], tasks: readonly TaskScan[]): JsonAuthoritySourceManifest {
  const fileRows = files.map((file) => ({
    path: file.relative_path,
    byte_length: file.byte_length,
    sha256: file.sha256,
  }));
  const rootDigest = sha256(stableJson(fileRows));
  const manifest = {
    schema_version: 1,
    files: fileRows,
    task_count: tasks.length,
    artifact_count: files.length,
    artifact_bytes: files.reduce((total, file) => total + file.byte_length, 0),
    result_count: tasks.reduce((total, task) => total + task.results.length, 0),
    event_count: tasks.reduce((total, task) => total + task.events.length, 0),
  };
  const manifestJson = stableJson(manifest);
  return {
    root_digest: rootDigest,
    manifest_digest: sha256(manifestJson),
    manifest_json: manifestJson,
    task_count: manifest.task_count,
    artifact_count: manifest.artifact_count,
    artifact_bytes: manifest.artifact_bytes,
    result_count: manifest.result_count,
    event_count: manifest.event_count,
  };
}

export async function scanJsonAuthority(jsonDataRoot: string): Promise<JsonAuthorityScan> {
  const dataRoot = resolvePlainDirectory(jsonDataRoot, "json_data_root");
  if (jsonWriterFenceState(dataRoot) !== "sealed") fail("json_writer_root_not_sealed");
  const tasksRoot = resolvePlainDirectory(path.join(dataRoot, ".tasks"), "json_tasks_root");
  const files = collectFiles(tasksRoot);
  const taskIds = [...new Set(files.map((file) => file.task_id).filter((value): value is string => value !== null))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const taskFiles = new Map(taskIds.map((taskId) => [taskId, files.filter((file) => file.task_id === taskId)]));
  const tasks = taskIds.map((taskId) => scanTask(taskId, taskFiles.get(taskId)!));
  const artifacts = files.map((file) => ({
    artifact_id: `artifact-${sha256(file.relative_path).slice(0, 40)}`,
    relative_path: file.relative_path,
    task_id: file.task_id,
    attempt: file.attempt,
    kind: file.kind,
    byte_length: file.byte_length,
    sha256: file.sha256,
    content: file.bytes,
  }));
  const manifest = buildManifest(files, tasks);
  return {
    data_root: dataRoot,
    tasks_root: tasksRoot,
    manifest,
    snapshot: {
      schema_version: 1,
      protocol_version: SQLITE_CUTOVER_PROTOCOL_VERSION,
      verifier_version: SQLITE_CUTOVER_VERIFIER_VERSION,
      source: manifest,
      tasks: tasks.map((task) => task.task),
      artifacts,
      results: tasks.flatMap((task) => task.results),
      events: tasks.flatMap((task) => task.events),
    },
  };
}

function ensurePlainDirectory(value: string): string {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("sqlite_root_component_unsafe", { component: path.basename(current) });
    } else {
      mkdirSync(current);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("sqlite_root_create_unverified", { component: path.basename(current) });
    }
  }
  return realpathSync.native(resolved);
}

function fsyncFile(filePath: string): void {
  // Windows rejects FlushFileBuffers on a read-only descriptor.
  const fd = openSync(filePath, "r+");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function removeOwnedStagingFiles(stagingPath: string): void {
  for (const candidate of [stagingPath, `${stagingPath}-wal`, `${stagingPath}-shm`]) {
    try { rmSync(candidate, { force: true }); }
    catch { /* Preserve the primary publish error; the marker remains fail-closed. */ }
  }
}

function writePublishMarker(
  markerPath: string,
  value: Readonly<Record<string, unknown>>,
  durability: DurableFileOperations,
): void {
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(markerPath, "wx", 0o600);
    created = true;
    writeFileSync(fd, `${stableJson(value)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(markerPath, 0o600);
    durability.flushDirectorySync(path.dirname(markerPath));
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve primary marker error */ }
    }
    if (created) {
      try { unlinkSync(markerPath); } catch { /* preserve primary marker error */ }
    }
    throw error;
  }
}

function sameManifest(left: JsonAuthoritySourceManifest, right: JsonAuthoritySourceManifest): boolean {
  return left.manifest_digest === right.manifest_digest
    && left.root_digest === right.root_digest
    && left.manifest_json === right.manifest_json;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function sameCanonicalPath(left: string, right: string): boolean {
  return path.normalize(path.resolve(left)).toLocaleLowerCase("en-US")
    === path.normalize(path.resolve(right)).toLocaleLowerCase("en-US");
}

function canonicalizePotentialPath(value: string): string {
  const absolute = path.resolve(value);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail("cutover_root_parent_missing");
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  return path.resolve(canonicalExisting, path.relative(existing, absolute));
}

function assertRootsDisjoint(jsonRoot: string, sqliteRoot: string, archiveRoot: string): void {
  const roots = [
    { label: "json", root: jsonRoot },
    { label: "sqlite", root: sqliteRoot },
    { label: "archive", root: archiveRoot },
  ];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left]!;
      const b = roots[right]!;
      if (isWithin(a.root, b.root) || isWithin(b.root, a.root)) {
        fail("cutover_roots_overlap", { left: a.label, right: b.label });
      }
    }
  }
}

async function loadVerifiedArchive(
  archiveDirectory: string,
  expectedManifestDigest: string,
): Promise<JsonHistoryArchiveSnapshot> {
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestDigest)) fail("json_archive_digest_invalid");
  let archive: JsonHistoryArchiveSnapshot;
  try {
    archive = await readJsonHistoryArchiveSnapshot(archiveDirectory);
  } catch (error) {
    fail("json_archive_invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (archive.identity.manifest_digest !== expectedManifestDigest) {
    fail("json_archive_changed_after_archive");
  }
  return archive;
}

function sameArchiveIdentity(
  left: JsonHistoryArchiveIdentity,
  right: JsonHistoryArchiveIdentity,
): boolean {
  return sameCanonicalPath(left.archive_directory, right.archive_directory)
    && left.manifest_digest === right.manifest_digest
    && sameCanonicalPath(left.source_tasks_root, right.source_tasks_root)
    && left.file_count === right.file_count
    && left.byte_count === right.byte_count;
}

interface SourceManifestFile {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

function sourceManifestFiles(manifest: JsonAuthoritySourceManifest): readonly SourceManifestFile[] {
  let value: unknown;
  try {
    value = JSON.parse(manifest.manifest_json);
  } catch {
    fail("json_source_manifest_invalid");
  }
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record || !Array.isArray(record.files)) fail("json_source_manifest_invalid");
  return record.files.map((entry) => {
    const file = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.byte_length)
      || (file.byte_length as number) < 0 || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      fail("json_source_manifest_invalid");
    }
    return {
      path: file.path,
      byte_length: file.byte_length as number,
      sha256: file.sha256,
    };
  });
}

function assertArchiveMatchesScan(archive: JsonHistoryArchiveSnapshot, scan: JsonAuthorityScan): void {
  const { manifest, identity } = archive;
  if (manifest.archive_status !== "archived" || manifest.anomalies.length !== 0
    || manifest.tasks.some((task) => task.archive_status !== "archived")) {
    fail("json_archive_incomplete");
  }
  if (!sameCanonicalPath(identity.source_tasks_root, scan.tasks_root)
    || identity.file_count !== scan.manifest.artifact_count
    || identity.byte_count !== scan.manifest.artifact_bytes) {
    fail("json_archive_source_mismatch");
  }
  const archivedFiles = manifest.files
    .filter((file) => file.kind === "file")
    .map((file) => ({ path: file.path, byte_length: file.byte_length, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const sourceFiles = sourceManifestFiles(scan.manifest)
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (archivedFiles.length !== sourceFiles.length
    || archivedFiles.some((file, index) => file.path !== sourceFiles[index]?.path
      || file.byte_length !== sourceFiles[index]?.byte_length
      || file.sha256 !== sourceFiles[index]?.sha256)) {
    fail("json_archive_source_mismatch");
  }
}

function readAllTaskEvents(store: { readTaskEvents(taskId: string, options?: { afterCursor?: number; limit?: number }): {
  events: readonly Record<string, unknown>[]; nextCursor: number; hasMore: boolean;
} }, taskId: string): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const page = store.readTaskEvents(taskId, { afterCursor: cursor, limit: 200 });
    for (const event of page.events) events.push(event);
    if (!page.hasMore) return events;
    if (page.nextCursor <= cursor) fail("migration_event_pagination_stalled", { task_id: taskId });
    cursor = page.nextCursor;
  }
}

function verifyReadback(
  store: {
    readTask(taskId: string): Record<string, unknown> | null;
    readAttempt(taskId: string, attempt: number): Record<string, unknown> | null;
    readTaskLifecycle(taskId: string): Record<string, unknown> | null;
    readMigratedResult(taskId: string, attempt: number): Record<string, unknown> | null;
    readMigratedEvents(taskId: string): readonly Record<string, unknown>[];
    readTaskEvents(taskId: string, options?: { afterCursor?: number; limit?: number }): {
      events: readonly Record<string, unknown>[]; nextCursor: number; hasMore: boolean;
    };
    readMigratedArtifact(relativePath: string): Record<string, unknown> | null;
    readRecoverySnapshot(): unknown;
    assertAuthorityReady(expectedRuntimeRosterDigest: string): Record<string, unknown>;
  },
  snapshot: JsonAuthoritySnapshot,
): void {
  const expectedEventCursors = new Map(snapshot.events.map((event, index) => [event, index + 1]));
  for (const task of snapshot.tasks) {
    const readTask = store.readTask(task.task_id);
    if (!readTask || stableJson(readTask) !== stableJson(task.task)) fail("migration_task_readback_mismatch", { task_id: task.task_id });
    for (const expectedAttempt of task.attempts) {
      const attempt = store.readAttempt(task.task_id, expectedAttempt.attempt);
      if (!attempt
        || attempt.task_id !== task.task_id
        || attempt.attempt !== expectedAttempt.attempt
        || attempt.generation !== null
        || attempt.status !== expectedAttempt.status
        || attempt.created_at !== expectedAttempt.created_at) {
        fail("migration_attempt_readback_mismatch", {
          task_id: task.task_id,
          attempt: expectedAttempt.attempt,
        });
      }
    }
    const lifecycle = store.readTaskLifecycle(task.task_id);
    if (!lifecycle) fail("migration_lifecycle_readback_mismatch", { task_id: task.task_id });
    const projection = autoRecord(lifecycle.projection);
    if (projection.task_id !== task.task_id
      || projection.status !== task.status
      || projection.current_attempt !== task.current_attempt
      || projection.created_at !== task.created_at) {
      fail("migration_lifecycle_readback_mismatch", { task_id: task.task_id });
    }
    for (const expectedResult of snapshot.results.filter((result) => result.task_id === task.task_id)) {
      const result = store.readMigratedResult(task.task_id, expectedResult.attempt);
      if (!result
        || result.task_id !== expectedResult.task_id
        || result.attempt !== expectedResult.attempt
        || result.artifact_id !== expectedResult.artifact_id
        || stableJson(result.result) !== stableJson(expectedResult.result)) {
        fail("migration_result_readback_mismatch", {
          task_id: task.task_id,
          attempt: expectedResult.attempt,
        });
      }
      if (expectedResult.attempt === task.current_attempt
        && (!lifecycle.result || stableJson(lifecycle.result) !== stableJson(expectedResult.result))) {
        fail("migration_current_result_readback_mismatch", { task_id: task.task_id });
      }
    }
    const expectedEvents = snapshot.events.filter((event) => event.task_id === task.task_id)
      .sort((left, right) => left.source_sequence - right.source_sequence);
    const visibleEvents = readAllTaskEvents(store, task.task_id);
    const migratedEvents = store.readMigratedEvents(task.task_id);
    if (visibleEvents.length !== expectedEvents.length
      || migratedEvents.length !== expectedEvents.length
      || migratedEvents.some((event, index) => {
        const expected = expectedEvents[index];
        if (!expected
          || event.event_cursor !== expectedEventCursors.get(expected)
          || event.task_id !== expected.task_id
          || event.attempt !== expected.attempt
          || event.source_sequence !== expected.source_sequence
          || event.event_type !== expected.event_type
          || event.at !== expected.at
          || event.summary !== expected.summary
          || event.artifact_id !== expected.artifact_id
          || (event.details_json === null ? null : stableJson(JSON.parse(String(event.details_json))))
            !== (expected.details === null ? null : stableJson(expected.details))) {
          return true;
        }
        return event.details_digest !== null
          && event.details_digest !== sha256(String(event.details_json));
      })) {
      fail("migration_event_readback_mismatch", { task_id: task.task_id });
    }
  }
  for (const artifact of snapshot.artifacts) {
    const actual = store.readMigratedArtifact(artifact.relative_path);
    if (!actual || actual.byte_length !== artifact.byte_length
      || actual.sha256 !== artifact.sha256
      || !(actual.content instanceof Uint8Array)
      || !Buffer.from(actual.content).equals(Buffer.from(artifact.content))) {
      fail("migration_artifact_readback_mismatch", { path: artifact.relative_path });
    }
  }
  const recovery = autoRecord(store.readRecoverySnapshot());
  const capacity = autoRecord(recovery.capacity);
  const operations = Array.isArray(recovery.operations) ? recovery.operations : null;
  const recoveryEvents = Array.isArray(recovery.events) ? recovery.events : null;
  const capacityOperationId = `migrated-capacity-${snapshot.migration_id}`;
  const capacityOperation = operations?.length === 1 ? operations[0] : null;
  const capacityEvent = recoveryEvents?.length === 1 ? recoveryEvents[0] : null;
  if (capacity.capacity_limit !== 8
    || capacity.policy_version !== 1
    || capacity.policy_generation !== 1
    || capacity.policy_operation_id !== capacityOperationId
    || capacity.next_event_cursor !== snapshot.events.length + 1
    || !operations || operations.length !== 1
    || !capacityOperation
    || capacityOperation.operation_id !== capacityOperationId
    || capacityOperation.operation_kind !== "capacity_policy_change"
    || capacityOperation.phase !== "policy_change_committed"
    || !recoveryEvents || recoveryEvents.length !== 1
    || !capacityEvent
    || capacityEvent.operation_id !== capacityOperationId
    || capacityEvent.event_cursor !== snapshot.events.length + 1
    || capacityEvent.sequence !== 1
    || capacityEvent.event_type !== "capacity_policy_committed"
    || capacityEvent.from_phase !== null
    || capacityEvent.to_phase !== "policy_change_committed"
    || recovery.root_status !== "consistent_read_only") {
    fail("migration_capacity_readback_mismatch", {
      expected_event_cursor: snapshot.events.length + 1,
      actual_event_cursor: capacity.next_event_cursor,
      operation_count: operations?.length ?? null,
      event_count: recoveryEvents?.length ?? null,
      root_status: recovery.root_status,
    });
  }
  const authority = store.assertAuthorityReady(snapshot.runtime_roster_digest);
  if (authority.kind !== "authority_switch"
    || authority.migration_id !== snapshot.migration_id
    || authority.cutover_id !== snapshot.cutover_id
    || authority.source_root_digest !== snapshot.source.root_digest
    || authority.source_manifest_digest !== snapshot.source.manifest_digest
    || authority.archive_directory !== snapshot.archive.archive_directory
    || authority.archive_manifest_digest !== snapshot.archive.manifest_digest
    || authority.archive_source_tasks_root !== snapshot.archive.source_tasks_root
    || authority.archive_file_count !== snapshot.archive.file_count
    || authority.archive_byte_count !== snapshot.archive.byte_count) {
    fail("migration_authority_receipt_readback_mismatch");
  }
}

function autoRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("migration_readback_shape_invalid");
  return value as Record<string, unknown>;
}

function closeStore(store: { close(): void }): void {
  store.close();
}

export async function publishJsonAuthority(options: PublishJsonAuthorityOptions): Promise<PublishJsonAuthorityResult> {
  const durability = options.durability ?? defaultDurableFileOperations;
  const databaseFileName = options.databaseFileName ?? "bridge.sqlite";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(databaseFileName)
    || databaseFileName === "." || databaseFileName === "..") fail("invalid_database_file_name");
  const firstScan = await scanJsonAuthority(options.jsonDataRoot);
  const firstArchive = await loadVerifiedArchive(
    options.archiveDirectory,
    options.expectedArchiveManifestDigest,
  );
  assertArchiveMatchesScan(firstArchive, firstScan);
  const sqliteCandidate = canonicalizePotentialPath(options.sqliteRoot);
  assertRootsDisjoint(
    firstScan.data_root,
    sqliteCandidate,
    firstArchive.identity.archive_directory,
  );
  const sqliteRoot = ensurePlainDirectory(options.sqliteRoot);
  if (!sameCanonicalPath(sqliteRoot, sqliteCandidate)) fail("cutover_root_identity_changed");
  const finalPath = path.join(sqliteRoot, databaseFileName);
  const markerPath = path.join(sqliteRoot, `${databaseFileName}.cutover-pending.json`);
  const publishedMarkerPath = path.join(sqliteRoot, `${databaseFileName}.cutover-published.json`);
  if (existsSync(finalPath) || existsSync(`${finalPath}-wal`) || existsSync(`${finalPath}-shm`)
    || existsSync(path.join(sqliteRoot, "ROOT_POISONED.json")) || existsSync(path.join(sqliteRoot, "WRITER_INTENT.json"))
    || existsSync(markerPath) || existsSync(publishedMarkerPath)) {
    fail("migration_target_not_empty");
  }
  const stagingName = `${databaseFileName}.cutover-${randomUUID()}.staging`;
  const stagingPath = path.join(sqliteRoot, stagingName);
  const migrationId = `json-migration-${randomUUID()}`;
  const cutoverId = `authority-cutover-${randomUUID()}`;
  const runtimeRosterDigest = currentSqliteRuntimeRosterDigest();
  const snapshot: JsonAuthoritySnapshot = {
    ...firstScan.snapshot,
    migration_id: migrationId,
    cutover_id: cutoverId,
    runtime_roster_digest: runtimeRosterDigest,
    archive: firstArchive.identity,
  };
  const modules: LifecycleCandidateModules = await loadLifecycleCandidateModules();
  let publishedVisible = false;
  let markerOwned = false;
  try {
    const store = modules.Store.initialize(sqliteRoot, {
      databaseFileName: stagingName,
      managedDataDirectory: true,
    });
    try {
      store.importJsonAuthoritySnapshot(snapshot);
      const port = modules.createPort(store);
      port.provisionCapacity({
        operation_id: `migrated-capacity-${migrationId}`,
        capacity_limit: 8,
        expected_generation: 0,
        maintenance: { dispatch_blocked: true, writers_drained: true },
      });
      store.checkpoint();
    } finally {
      closeStore(store);
    }
    if (existsSync(`${stagingPath}-wal`) || existsSync(`${stagingPath}-shm`)) {
      fail("migration_staging_wal_not_checkpointed", { staging_path: stagingPath });
    }
    const staged = modules.Store.openForRecovery(sqliteRoot, {
      databaseFileName: stagingName,
      managedDataDirectory: true,
      allowUnpublishedCutover: true,
    });
    if (!staged) fail("migration_staging_open_failed");
    try { verifyReadback(staged, snapshot); }
    finally { closeStore(staged); }

    const finalSourceScan = await scanJsonAuthority(options.jsonDataRoot);
    if (!sameManifest(finalSourceScan.manifest, firstScan.manifest)) {
      fail("json_source_changed_before_publish");
    }
    const finalArchive = await loadVerifiedArchive(
      options.archiveDirectory,
      options.expectedArchiveManifestDigest,
    );
    assertArchiveMatchesScan(finalArchive, finalSourceScan);
    if (!sameArchiveIdentity(finalArchive.identity, firstArchive.identity)) {
      fail("json_archive_changed_before_publish");
    }

    chmodSync(stagingPath, 0o600);
    fsyncFile(stagingPath);
    writePublishMarker(markerPath, {
      schema_version: 1,
      state: "authority_switch_receipt",
      migration_id: migrationId,
      cutover_id: cutoverId,
      source_root_digest: firstScan.manifest.root_digest,
      source_manifest_digest: firstScan.manifest.manifest_digest,
      archive: firstArchive.identity,
      database_file: databaseFileName,
      created_at: new Date().toISOString(),
    }, durability);
    markerOwned = true;
    durability.moveFileSync(stagingPath, finalPath);
    publishedVisible = true;

    const pendingReadback = modules.Store.openForRecovery(sqliteRoot, {
      databaseFileName,
      managedDataDirectory: true,
      allowCutoverPending: true,
    });
    if (!pendingReadback) fail("migration_published_open_failed");
    try {
      verifyReadback(pendingReadback, snapshot);
    } finally {
      closeStore(pendingReadback);
    }

    // Renaming the durable pending record to its published name is the
    // namespace commit point. The write-through move flushes both the file
    // move and its destination directory before returning.
    durability.moveFileSync(markerPath, publishedMarkerPath);
    markerOwned = false;

    // A normal recovery open is the startup gate the production Host uses.
    // It must succeed only after the published receipt is present and must
    // repeat the authority and data readback checks.
    const published = modules.Store.openForRecovery(sqliteRoot, {
      databaseFileName,
      managedDataDirectory: true,
    });
    if (!published) fail("migration_published_open_failed");
    let authority: Record<string, unknown> | undefined;
    try {
      published.assertAuthorityReady(runtimeRosterDigest);
      verifyReadback(published, snapshot);
      authority = autoRecord(published.readSnapshot());
    } finally {
      closeStore(published);
    }
    if (!authority) fail("migration_published_readback_missing");
    const result: PublishJsonAuthorityResult = {
      status: "published",
      database_path: finalPath,
      publication_receipt_path: publishedMarkerPath,
      migration_id: migrationId,
      cutover_id: cutoverId,
      source_manifest_digest: firstScan.manifest.manifest_digest,
      source_root_digest: firstScan.manifest.root_digest,
      archive: firstArchive.identity,
      task_count: firstScan.manifest.task_count,
      artifact_count: firstScan.manifest.artifact_count,
      artifact_bytes: firstScan.manifest.artifact_bytes,
      result_count: firstScan.manifest.result_count,
      event_count: firstScan.manifest.event_count,
      final_event_cursor: Number(autoRecord(authority.capacity).next_event_cursor),
    };
    return result;
  } catch (error) {
    const finalDatabaseVisible = publishedVisible
      || existsSync(finalPath)
      || existsSync(`${finalPath}-wal`)
      || existsSync(`${finalPath}-shm`);
    if (!finalDatabaseVisible) {
      removeOwnedStagingFiles(stagingPath);
      if (markerOwned) {
        try { rmSync(markerPath); } catch { /* marker remains fail-closed */ }
      }
    }
    throw error;
  }
}

export function readJsonAuthorityManifest(dataRoot: string): JsonAuthoritySourceManifest {
  const root = resolvePlainDirectory(dataRoot, "json_data_root");
  if (jsonWriterFenceState(root) !== "sealed") fail("json_writer_root_not_sealed");
  const tasksRoot = resolvePlainDirectory(path.join(root, ".tasks"), "json_tasks_root");
  const files = collectFiles(tasksRoot);
  const taskIds = [...new Set(files.map((file) => file.task_id).filter((value): value is string => value !== null))];
  const tasks = taskIds.map((taskId) => scanTask(taskId, files.filter((file) => file.task_id === taskId)));
  return buildManifest(files, tasks);
}

export async function assertSourceFileReadable(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    stream.once("end", resolve);
    stream.resume();
  });
}
