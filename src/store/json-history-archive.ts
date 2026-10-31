/**
 * Read-only JSON TaskStore history archive.
 *
 * This module copies bytes from an explicitly supplied `.tasks` root into a
 * separate archive directory. It never imports TaskStore or Manager and has
 * no scheduling, claim, recovery, or lifecycle-write API. Archive summaries
 * are evidence classifications only; they do not authorize execution.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const ARCHIVE_SCHEMA_VERSION = 1;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);
const RESULT_STATUSES = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);
const MANIFEST_NAME = "archive-manifest.json";
const MANIFEST_DIGEST_NAME = "archive-manifest.sha256";
const PAYLOAD_DIR = "payload";

export type JsonHistoryRecordClassification = "complete" | "missing" | "corrupt" | "conflict";
export type JsonHistoryArchiveStatus = "archived" | "unresolved";

export interface JsonHistoryArchiveFile {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "unsupported";
  readonly byte_length: number;
  readonly sha256: string;
  readonly link_target?: string;
}

export interface JsonHistoryAnomaly {
  readonly code:
    | "missing_record"
    | "corrupt_record"
    | "conflicting_projection"
    | "invalid_task_id"
    | "unsafe_entry"
    | "source_changed_during_snapshot"
    | "writer_lock_present"
    | "running_task_unresolved"
    | "unknown_task_state"
    | "event_sequence_conflict"
    | "event_line_corrupt"
    | "attempt_result_missing";
  readonly path: string;
  readonly record_type: "task" | "attempt" | "result" | "event" | "filesystem" | "archive";
  readonly detail: string;
}

export interface JsonHistoryTaskRecord {
  readonly task_id: string;
  readonly classification: JsonHistoryRecordClassification;
  readonly archive_status: JsonHistoryArchiveStatus;
  readonly current_status: string | null;
  readonly current_attempt: number | null;
  readonly attempts: readonly number[];
  readonly anomalies: readonly JsonHistoryAnomaly[];
}

export interface JsonHistoryArchiveManifest {
  readonly schema_version: 1;
  readonly archive_status: JsonHistoryArchiveStatus;
  readonly source_tasks_root: string;
  readonly created_at: string;
  readonly source_file_count: number;
  readonly source_byte_count: number;
  readonly files: readonly JsonHistoryArchiveFile[];
  readonly tasks: readonly JsonHistoryTaskRecord[];
  readonly anomalies: readonly JsonHistoryAnomaly[];
}

export interface CreateJsonHistoryArchiveResult {
  readonly disposition: "created" | "already_archived";
  readonly archive_directory: string;
  readonly identity: JsonHistoryArchiveIdentity;
  readonly manifest: JsonHistoryArchiveManifest;
}

export interface JsonHistoryArchiveIdentity {
  readonly archive_directory: string;
  readonly manifest_digest: string;
  readonly source_tasks_root: string;
  readonly file_count: number;
  readonly byte_count: number;
}

export interface JsonHistoryArchiveSnapshot {
  readonly manifest: JsonHistoryArchiveManifest;
  readonly identity: JsonHistoryArchiveIdentity;
}

interface TreeEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "unsupported";
  byte_length: number;
  sha256: string;
  link_target?: string;
  source_path: string;
}

interface JsonParseResult {
  value?: unknown;
  error?: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertDisjointPaths(source: string, destination: string): void {
  if (isWithin(source, destination) || isWithin(destination, source)) {
    throw new Error("archive_source_and_destination_must_be_disjoint");
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    !relativePath || relativePath.startsWith("/") || relativePath.includes("\\")
    || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("invalid_archive_relative_path");
  }
}

async function hashFile(filePath: string): Promise<{ byteLength: number; digest: string }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    byteLength += bytes.length;
  }
  return { byteLength, digest: hash.digest("hex") };
}

async function scanTree(root: string): Promise<TreeEntry[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("source_tasks_root_must_be_a_real_directory");
  const entries: TreeEntry[] = [];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b, "en"));
    for (const name of names) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error("unsafe_source_entry_name");
      }
      const sourcePath = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertSafeRelativePath(relative);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) {
        const target = await readlink(sourcePath);
        const targetBytes = Buffer.from(target, "utf8");
        entries.push({
          path: relative,
          kind: "symlink",
          byte_length: targetBytes.length,
          sha256: sha256(targetBytes),
          link_target: target,
          source_path: sourcePath,
        });
      } else if (info.isDirectory()) {
        entries.push({ path: relative, kind: "directory", byte_length: 0, sha256: sha256(Buffer.alloc(0)), source_path: sourcePath });
        await visit(sourcePath, relative);
      } else if (info.isFile()) {
        const before = { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev };
        const content = await hashFile(sourcePath);
        const after = await lstat(sourcePath);
        if (
          after.isSymbolicLink() || !after.isFile() || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev
          || content.byteLength !== before.size
        ) {
          throw new Error(`source_changed_during_snapshot:${relative}`);
        }
        entries.push({ path: relative, kind: "file", byte_length: content.byteLength, sha256: content.digest, source_path: sourcePath });
      } else {
        entries.push({ path: relative, kind: "unsupported", byte_length: 0, sha256: sha256(Buffer.alloc(0)), source_path: sourcePath });
      }
    }
  }

  await visit(root, "");
  return entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function publicFiles(entries: readonly TreeEntry[]): JsonHistoryArchiveFile[] {
  return entries
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      byte_length: entry.byte_length,
      sha256: entry.sha256,
      ...(entry.link_target === undefined ? {} : { link_target: entry.link_target }),
    }));
}

function parseJson(bytes: Buffer | undefined): JsonParseResult {
  if (!bytes) return {};
  try {
    return { value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 240) : "invalid_json" };
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fileMap(files: readonly JsonHistoryArchiveFile[]): Map<string, JsonHistoryArchiveFile> {
  return new Map(files.map((file) => [file.path, file]));
}

async function readPayloadBytes(payloadRoot: string, relativePath: string, files: Map<string, JsonHistoryArchiveFile>): Promise<Buffer | undefined> {
  const entry = files.get(relativePath);
  if (!entry || entry.kind !== "file") return undefined;
  return readFile(path.join(payloadRoot, ...relativePath.split("/")));
}

async function classifyArchivePayload(
  payloadRoot: string,
  entries: readonly TreeEntry[],
): Promise<{ tasks: JsonHistoryTaskRecord[]; anomalies: JsonHistoryAnomaly[] }> {
  const files = publicFiles(entries);
  const byPath = fileMap(files);
  const anomalies: JsonHistoryAnomaly[] = [];
  const tasks: JsonHistoryTaskRecord[] = [];
  const taskDirectories = new Set<string>();

  for (const entry of entries) {
    // The Manager writes this root-level cooldown marker as ordinary runtime
    // state. It is byte-preserved with the archive but is not a Task directory.
    if (entry.path === ".recovery-last-run") {
      if (entry.kind === "file") continue;
      anomalies.push({
        code: "unsafe_entry",
        path: entry.path,
        record_type: "filesystem",
        detail: "recovery_cooldown_marker_must_be_a_regular_file",
      });
      continue;
    }
    // Writer-quiescence records are part of the byte-preserved archive, but
    // they are protocol metadata rather than Task directories. A sealed,
    // well-formed fence and an empty participant registry are expected at a
    // successful archive point; active leases or unknown control records keep
    // the archive explicitly unresolved.
    if (entry.path === ".writer-quiescence.json") {
      const bytes = await readPayloadBytes(payloadRoot, entry.path, byPath);
      const parsed = parseJson(bytes);
      const record = object(parsed.value);
      const sealed = !parsed.error && record?.schema_version === 1 && record.state === "sealed"
        && Number.isSafeInteger(record.revision) && (record.revision as number) >= 1
        && typeof record.transition_id === "string" && Boolean(record.transition_id)
        && typeof record.updated_at === "string" && Number.isFinite(Date.parse(record.updated_at));
      if (!sealed) anomalies.push({ code: "writer_lock_present", path: entry.path, record_type: "filesystem", detail: "writer_fence_not_verified_sealed" });
      continue;
    }
    if (entry.path === ".writer-roster" || entry.path.startsWith(".writer-roster/")) {
      if (entry.path === ".writer-roster" && entry.kind === "directory") continue;
      if (entry.path === ".writer-roster/registry.json" && entry.kind === "file") {
        const bytes = await readPayloadBytes(payloadRoot, entry.path, byPath);
        const parsed = parseJson(bytes);
        const record = object(parsed.value);
        const valid = !parsed.error && record?.schema_version === 1
          && typeof record.created_at === "string" && Number.isFinite(Date.parse(record.created_at));
        if (!valid) anomalies.push({ code: "writer_lock_present", path: entry.path, record_type: "filesystem", detail: "writer_registry_not_verified" });
        continue;
      }
      anomalies.push({ code: "writer_lock_present", path: entry.path, record_type: "filesystem", detail: "writer_roster_entry_present_at_archive" });
      continue;
    }
    if (entry.path === ".writer-quiescence.lock" || entry.path.startsWith(".writer-quiescence.lock/")) {
      anomalies.push({ code: "writer_lock_present", path: entry.path, record_type: "filesystem", detail: "writer_quiescence_lock_present_at_archive" });
      continue;
    }
    const first = entry.path.split("/")[0]!;
    if (entry.path.includes("/")) {
      if (entry.path.startsWith(".manager.lock/")) continue;
      taskDirectories.add(first);
    } else if (entry.kind === "directory" && first !== ".manager.lock") {
      taskDirectories.add(first);
    } else if (first === ".manager.lock") {
      anomalies.push({ code: "writer_lock_present", path: ".manager.lock", record_type: "filesystem", detail: "manager_lock_is_in_archive; writer_quiescence_not_proven" });
    } else {
      anomalies.push({ code: "unsafe_entry", path: entry.path, record_type: "filesystem", detail: "unclassified_root_entry_preserved_without_following" });
    }
    if (entry.kind === "symlink" || entry.kind === "unsupported") {
      anomalies.push({ code: "unsafe_entry", path: entry.path, record_type: "filesystem", detail: entry.kind === "symlink" ? "symlink_target_recorded_but_not_followed" : "unsupported_filesystem_entry_not_followed" });
    }
    if (entry.path.endsWith("/state.lock") || entry.path.endsWith("/events.lock")) {
      anomalies.push({ code: "writer_lock_present", path: entry.path, record_type: "filesystem", detail: "task_writer_lock_present_at_snapshot" });
    }
  }

  for (const taskId of [...taskDirectories].sort((a, b) => a.localeCompare(b, "en"))) {
    const taskRoot = taskId;
    const taskAnomalies: JsonHistoryAnomaly[] = [];
    const add = (code: JsonHistoryAnomaly["code"], relativePath: string, type: JsonHistoryAnomaly["record_type"], detail: string): void => {
      const anomaly = { code, path: relativePath, record_type: type, detail };
      taskAnomalies.push(anomaly);
      anomalies.push(anomaly);
    };
    if (taskId === ".manager.lock") continue;
    if (!TASK_ID_PATTERN.test(taskId)) add("invalid_task_id", taskRoot, "task", "directory_name_is_not_a_valid_task_id");

    const taskPath = `${taskRoot}/task.json`;
    const statusPath = `${taskRoot}/status.json`;
    const taskBytes = await readPayloadBytes(payloadRoot, taskPath, byPath);
    const statusBytes = await readPayloadBytes(payloadRoot, statusPath, byPath);
    let missing = false;
    let corrupt = false;
    let conflict = false;
    let currentStatus: string | null = null;
    let currentAttempt: number | null = null;

    if (!taskBytes) {
      missing = true;
      add("missing_record", taskPath, "task", "required_task_json_missing");
    }
    if (!statusBytes) {
      missing = true;
      add("missing_record", statusPath, "task", "required_status_json_missing");
    }

    const taskParsed = parseJson(taskBytes);
    const statusParsed = parseJson(statusBytes);
    if (taskParsed.error) {
      corrupt = true;
      add("corrupt_record", taskPath, "task", `invalid_json:${taskParsed.error}`);
    }
    if (statusParsed.error) {
      corrupt = true;
      add("corrupt_record", statusPath, "task", `invalid_json:${statusParsed.error}`);
    }

    const taskValue = object(taskParsed.value);
    const statusValue = object(statusParsed.value);
    if (taskBytes && !taskParsed.error) {
      if (!taskValue || taskValue.task_id !== taskId || typeof taskValue.workspace !== "string" || !taskValue.workspace || typeof taskValue.objective !== "string") {
        corrupt = true;
        add("corrupt_record", taskPath, "task", "task_json_missing_required_identity_or_fields");
      }
    }
    if (statusBytes && !statusParsed.error) {
      const state = statusValue?.status;
      const attempt = statusValue?.attempt;
      if (
        !statusValue || statusValue.task_id !== taskId
        || typeof state !== "string" || (!TERMINAL_STATUSES.has(state) && state !== "queued" && state !== "running")
        || !Number.isSafeInteger(attempt) || (attempt as number) < 1
        || typeof statusValue.created_at !== "string"
      ) {
        corrupt = true;
        add("corrupt_record", statusPath, "task", "status_json_missing_required_identity_or_fields");
      } else {
        currentStatus = state;
        currentAttempt = attempt as number;
      }
    }

    const attemptNumbers = new Set<number>();
    for (const entry of entries) {
      const match = entry.path.match(new RegExp(`^${escapeRegex(taskId)}/attempts/([^/]+)(?:/|$)`, "u"));
      if (!match) continue;
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number) || number < 1 || String(number) !== match[1]) {
        corrupt = true;
        add("corrupt_record", entry.path, "attempt", "attempt_directory_name_invalid");
        continue;
      }
      attemptNumbers.add(number);
    }

    // Every JSON file and execution.claim is structured evidence. Preserve
    // malformed bytes, but classify them as unresolved rather than hiding
    // them behind a successful directory copy.
    for (const entry of entries) {
      if (!entry.path.startsWith(`${taskRoot}/`)) continue;
      if (!(entry.path.endsWith(".json") || entry.path.endsWith("/execution.claim"))) continue;
      if (entry.path === taskPath || entry.path === statusPath || entry.path === `${taskRoot}/result.json` || /\/attempts\/\d+\/result\.json$/u.test(entry.path)) continue;
      const bytes = await readPayloadBytes(payloadRoot, entry.path, byPath);
      if (!bytes) continue;
      const parsed = parseJson(bytes);
      const metadata = object(parsed.value);
      if (parsed.error || !metadata) {
        corrupt = true;
        add("corrupt_record", entry.path, entry.path.includes("/attempts/") ? "attempt" : "task", parsed.error ? `invalid_json:${parsed.error}` : "structured_record_is_not_an_object");
        continue;
      }
      const attemptMatch = entry.path.match(/\/attempts\/(\d+)\//u);
      if (attemptMatch && Number.isSafeInteger(metadata.attempt) && metadata.attempt !== Number(attemptMatch[1])) {
        conflict = true;
        add("conflicting_projection", entry.path, "attempt", "attempt_metadata_generation_does_not_match_directory");
      }
      if (typeof metadata.task_id === "string" && metadata.task_id !== taskId) {
        conflict = true;
        add("conflicting_projection", entry.path, entry.path.includes("/attempts/") ? "attempt" : "task", "record_task_id_does_not_match_directory");
      }
    }

    const resultPaths = [
      { relative: `${taskRoot}/result.json`, attempt: currentAttempt, current: true },
      ...[...attemptNumbers].map((attempt) => ({ relative: `${taskRoot}/attempts/${attempt}/result.json`, attempt, current: false })),
    ];
    let currentResultPresent = false;
    for (const resultPath of resultPaths) {
      const bytes = await readPayloadBytes(payloadRoot, resultPath.relative, byPath);
      if (!bytes) continue;
      if (resultPath.current) currentResultPresent = true;
      const parsed = parseJson(bytes);
      if (parsed.error) {
        corrupt = true;
        add("corrupt_record", resultPath.relative, resultPath.current ? "result" : "attempt", `invalid_json:${parsed.error}`);
        continue;
      }
      const result = object(parsed.value);
      if (
        !result || result.task_id !== taskId || !Number.isSafeInteger(result.attempt)
        || !RESULT_STATUSES.has(String(result.status))
      ) {
        corrupt = true;
        add("corrupt_record", resultPath.relative, resultPath.current ? "result" : "attempt", "result_json_missing_required_identity_or_fields");
        continue;
      }
      if (result.attempt !== resultPath.attempt) {
        conflict = true;
        add("conflicting_projection", resultPath.relative, resultPath.current ? "result" : "attempt", "result_attempt_does_not_match_storage_generation");
      }
      if (resultPath.current && currentStatus && currentAttempt === result.attempt && currentStatus !== result.status) {
        conflict = true;
        add("conflicting_projection", resultPath.relative, "result", "current_result_status_differs_from_status_projection");
      }
      if (!resultPath.current && currentAttempt !== null && resultPath.attempt !== null && resultPath.attempt >= currentAttempt) {
        conflict = true;
        add("conflicting_projection", resultPath.relative, "attempt", "archived_attempt_result_is_not_from_a_prior_attempt");
      }
    }

    if (currentStatus && currentAttempt !== null && TERMINAL_STATUSES.has(currentStatus) && !currentResultPresent) {
      missing = true;
      add("missing_record", `${taskRoot}/result.json`, "result", "terminal_status_has_no_current_result");
    }
    if (currentAttempt !== null) {
      for (let prior = 1; prior < currentAttempt; prior += 1) {
        if (!byPath.has(`${taskRoot}/attempts/${prior}/result.json`)) {
          missing = true;
          add("attempt_result_missing", `${taskRoot}/attempts/${prior}/result.json`, "attempt", "prior_attempt_result_not_archived");
        }
      }
    }
    if (currentStatus === "running") {
      add("running_task_unresolved", statusPath, "task", "running_state_requires_writer_quiescence_and_process_identity_review");
    } else if (currentStatus && currentStatus !== "queued" && !TERMINAL_STATUSES.has(currentStatus)) {
      add("unknown_task_state", statusPath, "task", "task_status_not_classified_by_archive_contract");
    }

    const eventsPath = `${taskRoot}/events.jsonl`;
    const eventsBytes = await readPayloadBytes(payloadRoot, eventsPath, byPath);
    if (eventsBytes) {
      let previousSequence = 0;
      const lines = eventsBytes.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line && index === lines.length - 1) continue;
        if (!line.trim()) {
          corrupt = true;
          add("event_line_corrupt", `${eventsPath}#${index + 1}`, "event", "blank_event_line");
          continue;
        }
        const parsed = parseJson(Buffer.from(line, "utf8"));
        const event = object(parsed.value);
        if (
          parsed.error || !event || !Number.isSafeInteger(event.seq) || (event.seq as number) < 1
          || typeof event.at !== "string" || typeof event.type !== "string" || typeof event.summary !== "string"
        ) {
          corrupt = true;
          add("event_line_corrupt", `${eventsPath}#${index + 1}`, "event", "event_line_invalid");
          continue;
        }
        if ((event.seq as number) <= previousSequence) {
          conflict = true;
          add("event_sequence_conflict", `${eventsPath}#${index + 1}`, "event", "event_sequence_not_strictly_increasing");
        }
        previousSequence = event.seq as number;
      }
    }
    const sequenceBytes = await readPayloadBytes(payloadRoot, `${taskRoot}/events.seq`, byPath);
    if (sequenceBytes) {
      const sequenceText = sequenceBytes.toString("utf8").trim();
      const sequence = Number(sequenceText);
      if (!/^[0-9]+$/u.test(sequenceText) || !Number.isSafeInteger(sequence) || sequence < 0) {
        corrupt = true;
        add("corrupt_record", `${taskRoot}/events.seq`, "event", "event_sequence_cursor_invalid");
      } else if (eventsBytes) {
        const eventSequences = eventsBytes.toString("utf8").split("\n").flatMap((line) => {
          if (!line.trim()) return [];
          const event = object(parseJson(Buffer.from(line, "utf8")).value);
          return event && Number.isSafeInteger(event.seq) ? [event.seq as number] : [];
        });
        if (eventSequences.length && sequence < eventSequences.reduce((max, value) => Math.max(max, value), 0)) {
          conflict = true;
          add("event_sequence_conflict", `${taskRoot}/events.seq`, "event", "durable_event_cursor_is_behind_event_log");
        }
      }
    }

    const classification: JsonHistoryRecordClassification = conflict ? "conflict" : corrupt ? "corrupt" : missing ? "missing" : "complete";
    const unresolved = classification !== "complete" || currentStatus === "running" || taskAnomalies.length > 0;
    const record: JsonHistoryTaskRecord = {
      task_id: taskId,
      classification,
      archive_status: unresolved ? "unresolved" : "archived",
      current_status: currentStatus,
      current_attempt: currentAttempt,
      attempts: [...attemptNumbers].sort((a, b) => a - b),
      anomalies: taskAnomalies,
    };
    tasks.push(record);
  }
  return { tasks, anomalies };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function copyEntries(entries: readonly TreeEntry[], sourceRoot: string, payloadRoot: string): Promise<void> {
  await mkdir(payloadRoot, { recursive: false, mode: 0o700 });
  for (const entry of entries) {
    if (entry.kind === "directory") {
      await mkdir(path.join(payloadRoot, ...entry.path.split("/")), { recursive: true, mode: 0o700 });
    } else if (entry.kind === "file") {
      const destination = path.join(payloadRoot, ...entry.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(entry.source_path, destination);
      await chmod(destination, 0o600);
      await syncFile(destination);
    }
  }
  void sourceRoot;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  // Windows does not expose a portable FlushFileBuffers operation for a
  // directory handle. Files and manifests are still fsynced there; POSIX
  // runs receive directory-entry durability as well.
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function stableManifestBytes(manifest: JsonHistoryArchiveManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function compareScans(left: readonly TreeEntry[], right: readonly TreeEntry[]): Promise<boolean> {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.path !== b.path || a.kind !== b.kind || a.byte_length !== b.byte_length || a.sha256 !== b.sha256 || a.link_target !== b.link_target) return false;
  }
  return true;
}

async function verifyPayload(payloadRoot: string, files: readonly JsonHistoryArchiveFile[]): Promise<void> {
  const expectedFiles: string[] = [];
  const expectedDirectories: string[] = [];
  for (const file of files) {
    assertSafeRelativePath(file.path);
    if (file.kind === "symlink" || file.kind === "unsupported") continue;
    const full = path.join(payloadRoot, ...file.path.split("/"));
    const info = await lstat(full);
    if (file.kind === "directory") {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`archive_payload_type_mismatch:${file.path}`);
      expectedDirectories.push(file.path);
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`archive_payload_type_mismatch:${file.path}`);
    const content = await hashFile(full);
    if (content.byteLength !== file.byte_length || content.digest !== file.sha256) throw new Error(`archive_payload_digest_mismatch:${file.path}`);
    expectedFiles.push(file.path);
  }
  const actualEntries = await scanTree(payloadRoot);
  const actualFiles = actualEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path).sort((a, b) => a.localeCompare(b, "en"));
  const actualDirectories = actualEntries.filter((entry) => entry.kind === "directory").map((entry) => entry.path).sort((a, b) => a.localeCompare(b, "en"));
  expectedFiles.sort((a, b) => a.localeCompare(b, "en"));
  expectedDirectories.sort((a, b) => a.localeCompare(b, "en"));
  if (
    actualFiles.length !== expectedFiles.length || actualFiles.some((value, index) => value !== expectedFiles[index])
    || actualDirectories.length !== expectedDirectories.length || actualDirectories.some((value, index) => value !== expectedDirectories[index])
  ) {
    throw new Error("archive_payload_file_set_mismatch");
  }
}

export async function readJsonHistoryArchiveSnapshot(archiveDirectory: string): Promise<JsonHistoryArchiveSnapshot> {
  const requestedRoot = path.resolve(archiveDirectory);
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("archive_directory_must_be_a_real_directory");
  }
  const root = await realpath(requestedRoot);
  const manifestBytes = await readFile(path.join(root, MANIFEST_NAME));
  const digestBytes = await readFile(path.join(root, MANIFEST_DIGEST_NAME));
  const expectedManifestDigest = digestBytes.toString("ascii").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(expectedManifestDigest) || sha256(manifestBytes) !== expectedManifestDigest) {
    throw new Error("archive_manifest_digest_mismatch");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as JsonHistoryArchiveManifest;
  if (!manifest || manifest.schema_version !== ARCHIVE_SCHEMA_VERSION || !Array.isArray(manifest.files) || !Array.isArray(manifest.tasks) || !Array.isArray(manifest.anomalies)) {
    throw new Error("archive_manifest_invalid");
  }
  const sourceFiles = manifest.files.filter((file) => file.kind === "file");
  const sourceByteCount = sourceFiles.reduce((sum, file) => sum + file.byte_length, 0);
  if (
    (manifest.archive_status !== "archived" && manifest.archive_status !== "unresolved")
    || typeof manifest.source_tasks_root !== "string" || !path.isAbsolute(manifest.source_tasks_root)
    || typeof manifest.created_at !== "string" || !Number.isFinite(Date.parse(manifest.created_at))
    || !Number.isSafeInteger(manifest.source_file_count) || manifest.source_file_count < 0
    || !Number.isSafeInteger(manifest.source_byte_count) || manifest.source_byte_count < 0
    || manifest.source_file_count !== sourceFiles.length
    || manifest.source_byte_count !== sourceByteCount
  ) {
    throw new Error("archive_manifest_invalid");
  }
  await verifyPayload(path.join(root, PAYLOAD_DIR), manifest.files);
  return {
    manifest,
    identity: {
      archive_directory: root,
      manifest_digest: expectedManifestDigest,
      source_tasks_root: path.resolve(manifest.source_tasks_root),
      file_count: manifest.source_file_count,
      byte_count: manifest.source_byte_count,
    },
  };
}

export async function readJsonHistoryArchive(archiveDirectory: string): Promise<JsonHistoryArchiveManifest> {
  return (await readJsonHistoryArchiveSnapshot(archiveDirectory)).manifest;
}

export async function readArchivedJsonHistoryFile(archiveDirectory: string, relativePath: string): Promise<Buffer> {
  assertSafeRelativePath(relativePath);
  const { manifest } = await readJsonHistoryArchiveSnapshot(archiveDirectory);
  const entry = manifest.files.find((file) => file.path === relativePath && file.kind === "file");
  if (!entry) throw new Error("archive_file_not_found");
  const bytes = await readFile(path.join(await realpath(archiveDirectory), PAYLOAD_DIR, ...relativePath.split("/")));
  if (bytes.length !== entry.byte_length || sha256(bytes) !== entry.sha256) throw new Error("archive_payload_digest_mismatch");
  return bytes;
}

export async function createJsonHistoryArchive(
  sourceTasksRoot: string,
  archiveDirectory: string,
): Promise<CreateJsonHistoryArchiveResult> {
  const source = path.resolve(sourceTasksRoot);
  const destination = path.resolve(archiveDirectory);
  assertDisjointPaths(source, destination);
  const rootInfo = await lstat(source);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("source_tasks_root_must_be_a_real_directory");
  const sourceCanonical = await realpath(source);
  const destinationParent = path.dirname(destination);
  await mkdir(destinationParent, { recursive: true });
  const parentCanonical = await realpath(destinationParent);
  const canonicalDestination = path.join(parentCanonical, path.basename(destination));
  assertDisjointPaths(sourceCanonical, canonicalDestination);

  const before = await scanTree(source);
  const existing = await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (existing) {
    const destinationInfo = await lstat(destination);
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) throw new Error("archive_destination_must_be_a_real_directory");
    const snapshot = await readJsonHistoryArchiveSnapshot(destination);
    const { manifest, identity } = snapshot;
    if (!sameCanonicalPath(manifest.source_tasks_root, sourceCanonical)) throw new Error("archive_destination_conflict");
    const after = await scanTree(source);
    if (!(await compareScans(before, after))) throw new Error("source_changed_during_snapshot");
    const sourceFiles = publicFiles(before);
    if (JSON.stringify(sourceFiles) !== JSON.stringify(manifest.files)) throw new Error("archive_destination_conflict");
    return { disposition: "already_archived", archive_directory: identity.archive_directory, identity, manifest };
  }

  const staging = path.join(destinationParent, `.${path.basename(destination)}.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const payloadRoot = path.join(staging, PAYLOAD_DIR);
    await copyEntries(before, source, payloadRoot);
    const after = await scanTree(source);
    if (!(await compareScans(before, after))) throw new Error("source_changed_during_snapshot");
    const files = publicFiles(before);
    await verifyPayload(payloadRoot, files);
    const classified = await classifyArchivePayload(payloadRoot, before);
    const globalAnomalies = classified.anomalies.filter((anomaly) => !classified.tasks.some((task) => task.anomalies.includes(anomaly)));
    const archiveStatus: JsonHistoryArchiveStatus = classified.tasks.every((task) => task.archive_status === "archived") && globalAnomalies.length === 0
      ? "archived"
      : "unresolved";
    const manifest: JsonHistoryArchiveManifest = {
      schema_version: ARCHIVE_SCHEMA_VERSION,
      archive_status: archiveStatus,
      source_tasks_root: sourceCanonical,
      created_at: new Date().toISOString(),
      source_file_count: files.filter((file) => file.kind === "file").length,
      source_byte_count: files.filter((file) => file.kind === "file").reduce((sum, file) => sum + file.byte_length, 0),
      files,
      tasks: classified.tasks,
      anomalies: classified.anomalies,
    };
    const manifestBytes = stableManifestBytes(manifest);
    const manifestPath = path.join(staging, MANIFEST_NAME);
    const manifestDigestPath = path.join(staging, MANIFEST_DIGEST_NAME);
    await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
    await writeFile(manifestDigestPath, `${sha256(manifestBytes)}\n`, { flag: "wx", mode: 0o600 });
    await syncFile(manifestPath);
    await syncFile(manifestDigestPath);
    await syncDirectory(payloadRoot);
    await syncDirectory(staging);
    await rename(staging, destination);
    await syncDirectory(destinationParent);
    const snapshot = await readJsonHistoryArchiveSnapshot(destination);
    return {
      disposition: "created",
      archive_directory: snapshot.identity.archive_directory,
      identity: snapshot.identity,
      manifest: snapshot.manifest,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return path.normalize(path.resolve(left)).toLocaleLowerCase("en-US")
    === path.normalize(path.resolve(right)).toLocaleLowerCase("en-US");
}
