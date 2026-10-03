// TaskStore per docs/ARCHITECTURE.md (frozen): file-backed records under
// <dataRoot>/.tasks/<task_id>/ — task.json, status.json, append-only bounded
// stdout.log / stderr.log, terminal result.json, and immutable per-attempt
// records under attempts/. JSON writes are atomic (temp file + rename). Full
// child environments and provider config files are never persisted; bounded
// task evidence and pending interaction decisions live here. Permission
// request details may contain tool inputs and are persisted so the Master can
// inspect them and answer after a worker restart.
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TaskPackage, TaskProgressEvent, TaskResult, TaskStatus, TaskStatusRecord, WorkspaceRef, ZCodeInteractionRecord, ZCodeInteractionRequest } from "../interfaces.js";
import { tryAcquireProcessLock } from "./process-lock.js";
import { atomicRenameSync } from "./atomic-rename.js";

/** status.json shape: the frozen TaskStatusRecord plus internal fields. */
export interface InternalTaskStatus extends Omit<TaskStatusRecord, "error_code" | "error"> {
  /** Null in JSON clears the optional frozen fields on merge. */
  error_code?: string | null;
  error?: string | null;
  cancel_requested?: boolean | null;
  cleanup_unverified?: boolean | null;
  zcode_pid?: number | null;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_CRITICAL_EVENT_RESERVE_BYTES = 256 * 1024;
const CRITICAL_EVENT_TYPES = new Set([
  "error", "task_finished", "turn_completed", "report_ready", "session_ready",
  "turn_started", "worker_started", "workspace_ready", "timeout_warning", "model_catalog",
  "account_provider_sync_failed", "interaction_requested", "interaction_reply_submitted", "cancelled", "cancel_failed",
]);

export interface TaskStoreOptions {
  maxLogBytes?: number;
  maxEventBytes?: number;
}

export interface AttemptMeta {
  [key: string]: unknown;
}

export class TaskStore {
  readonly #dataRoot: string;
  readonly #tasksRoot: string;
  readonly #maxLogBytes: number;
  readonly #maxEventBytes: number;

  constructor(dataRoot: string, options: TaskStoreOptions = {}) {
    this.#dataRoot = dataRoot;
    this.#tasksRoot = path.join(dataRoot, ".tasks");
    this.#maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.#maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_LOG_BYTES;
    privateMkdir(this.#tasksRoot);
  }

  get dataRoot(): string {
    return this.#dataRoot;
  }

  get tasksRoot(): string {
    return this.#tasksRoot;
  }

  assertValidTaskId(taskId: string): void {
    if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`invalid task_id (must match ${TASK_ID_PATTERN.source}): ${String(taskId)}`);
    }
  }

  taskDir(taskId: string): string {
    this.assertValidTaskId(taskId);
    return path.join(this.#tasksRoot, taskId);
  }

  hasTask(taskId: string): boolean {
    try {
      return existsSync(path.join(this.taskDir(taskId), "status.json"));
    } catch {
      return false;
    }
  }

  listTaskIds(): string[] {
    if (!existsSync(this.#tasksRoot)) return [];
    return readdirSync(this.#tasksRoot).filter((entry) =>
      existsSync(path.join(this.#tasksRoot, entry, "status.json")),
    );
  }

  createTask(task: TaskPackage, createdAt: string): void {
    this.assertValidTaskId(task.task_id);
    const dir = this.taskDir(task.task_id);
    if (existsSync(path.join(dir, "task.json"))) {
      throw new Error(`task already exists: ${task.task_id}`);
    }
    privateMkdir(path.join(dir, "attempts"));
    this.#writeJsonAtomic(path.join(dir, "task.json"), task);
    const status: InternalTaskStatus = {
      task_id: task.task_id,
      status: "queued",
      attempt: 1,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_session_id: null,
      exit_code: null,
    };
    this.#writeJsonAtomic(path.join(dir, "status.json"), status);
  }

  readTask(taskId: string): TaskPackage {
    const file = path.join(this.taskDir(taskId), "task.json");
    const parsed = this.#readJson(file);
    const task = parsed as TaskPackage;
    if (!task || task.task_id !== taskId || typeof task.workspace !== "string" || !task.workspace || typeof task.objective !== "string" || [task.requirements, task.allowed_paths, task.forbidden_paths, task.acceptance_criteria, task.test_commands].some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"))) throw new Error(`corrupt task record: ${file}`);
    return task;
  }

  readSubmission<T = { fingerprint: string; receipt: { task_id: string; status: "queued" | "running"; created_at: string } }>(taskId: string): T | null {
    const file = path.join(this.taskDir(taskId), "submission.json");
    if (!existsSync(file)) return null;
    return this.#readJson(file) as T;
  }

  writeSubmission(taskId: string, submission: unknown): void {
    this.#writeJsonAtomic(path.join(this.taskDir(taskId), "submission.json"), submission);
  }

  writeWorkspaceRef(taskId: string, workspace: WorkspaceRef): void {
    this.#writeJsonAtomic(path.join(this.taskDir(taskId), "workspace.json"), workspace);
  }

  readWorkspaceRef(taskId: string): WorkspaceRef | null {
    const file = path.join(this.taskDir(taskId), "workspace.json");
    if (!existsSync(file)) return null;
    const workspace = this.#readJson(file) as WorkspaceRef;
    if (!workspace || typeof workspace.canonicalPath !== "string" || typeof workspace.requestedPath !== "string" || !["direct", "worktree"].includes(workspace.mode)) throw new Error(`corrupt workspace record: ${file}`);
    return workspace;
  }

  readStatus(taskId: string): InternalTaskStatus {
    const file = path.join(this.taskDir(taskId), "status.json");
    const parsed = this.#readJson(file) as InternalTaskStatus;
    if (!parsed || parsed.task_id !== taskId || !["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"].includes(parsed.status) || !Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1 || typeof parsed.created_at !== "string") {
      throw new Error(`corrupt status record: ${file}`);
    }
    return parsed;
  }

  /** Read-merge-write with an updated timestamp; atomic via temp file + rename. */
  writeStatus(taskId: string, patch: Partial<InternalTaskStatus>, expectedAttempt?: number): InternalTaskStatus {
    return withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const current = this.readStatus(taskId);
      if (expectedAttempt !== undefined && (current.attempt !== expectedAttempt || isTerminalStatus(current.status))) throw new Error("stale or terminal worker status rejected");
      const next: InternalTaskStatus = {
        ...current,
        ...patch,
        task_id: current.task_id,
        updated_at: new Date().toISOString(),
      };
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "status.json"), next);
      return next;
    });
  }

  readResult(taskId: string): TaskResult | null {
    const file = path.join(this.taskDir(taskId), "result.json");
    if (!existsSync(file)) return null;
    const result = this.#readJson(file) as TaskResult;
    if (!result || result.task_id !== taskId || !Number.isSafeInteger(result.attempt) || !isTerminalStatus(result.status)) throw new Error(`corrupt result record: ${file}`);
    return result.attempt === this.readStatus(taskId).attempt ? result : null;
  }

  writeResult(taskId: string, result: TaskResult): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      if (this.readStatus(taskId).attempt !== result.attempt) throw new Error("stale worker attempt result rejected");
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "result.json"), result);
    });
  }

  commitWorkerResult(taskId: string, attempt: number, result: TaskResult, patch: Partial<InternalTaskStatus>): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      this.assertWorkerAttempt(taskId, attempt);
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "result.json"), result);
      const current = this.readStatus(taskId);
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "status.json"), { ...current, ...patch, task_id: taskId, attempt, updated_at: new Date().toISOString() });
    });
  }

  patchRunningAttempt(taskId: string, attempt: number, patch: Partial<InternalTaskStatus>): void {
    withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const current = this.readStatus(taskId);
      if (current.attempt !== attempt || current.status !== "running") return;
      this.#writeJsonAtomic(path.join(this.taskDir(taskId), "status.json"), { ...current, ...patch, updated_at: new Date().toISOString() });
    });
  }

  /** Copies evidence before the continuation status commit; the old result remains recoverable. */
  archiveResultToAttempt(taskId: string, attempt: number): void {
    const dir = this.taskDir(taskId);
    const source = path.join(dir, "result.json");
    if (!existsSync(source)) return;
    const targetDir = this.attemptDir(taskId, attempt);
    privateMkdir(targetDir);
    copyFileSync(source, path.join(targetDir, "result.json"));
    privateFile(path.join(targetDir, "result.json"));
  }

  /** A claim is permanent: a started attempt must never execute again. */
  claimWorkerExecution(taskId: string, attempt: number): boolean {
    return withEventLock(path.join(this.taskDir(taskId), "state.lock"), () => {
      const status = this.readStatus(taskId);
      if (status.attempt !== attempt || isTerminalStatus(status.status)) return false;
      privateMkdir(this.attemptDir(taskId, attempt));
      try {
        writeFileSync(path.join(this.attemptDir(taskId, attempt), "execution.claim"), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    });
  }

  assertWorkerAttempt(taskId: string, attempt: number): void {
    const status = this.readStatus(taskId);
    if (status.attempt !== attempt || isTerminalStatus(status.status)) throw new Error("stale or terminal worker attempt rejected");
  }

  readArchivedResult(taskId: string, attempt: number): TaskResult | null {
    const file = path.join(this.attemptDir(taskId, attempt), "result.json");
    if (!existsSync(file)) return null;
    return this.#readJson(file) as TaskResult;
  }

  attemptDir(taskId: string, attempt: number): string {
    return path.join(this.taskDir(taskId), "attempts", String(attempt));
  }

  writeAttemptFile(taskId: string, attempt: number, fileName: string, content: string): void {
    const dir = this.attemptDir(taskId, attempt);
    privateMkdir(dir);
    this.#writeTextAtomic(path.join(dir, fileName), content);
  }

  writeAttemptMeta(taskId: string, attempt: number, fileName: string, meta: AttemptMeta): void {
    const dir = this.attemptDir(taskId, attempt);
    privateMkdir(dir);
    this.#writeJsonAtomic(path.join(dir, fileName), meta);
  }

  readAttemptMeta<T = AttemptMeta>(taskId: string, attempt: number, fileName: string): T | null {
    const file = path.join(this.attemptDir(taskId, attempt), fileName);
    if (!existsSync(file)) return null;
    return this.#readJson(file) as T;
  }

  readAttemptText(taskId: string, attempt: number, fileName: string): string | null {
    const file = path.join(this.attemptDir(taskId, attempt), fileName);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }

  /**
   * Atomically claims the single worker-respawn slot for an attempt by
   * creating the marker file with an exclusive flag, so several Bridge
   * processes sharing this data root can never spawn two replacement
   * workers. Returns false when the slot is already claimed.
   */
  claimAttemptRespawn(taskId: string, attempt: number): boolean {
    const dir = this.attemptDir(taskId, attempt);
    privateMkdir(dir);
    try {
      closeSync(openSync(path.join(dir, "respawn.claim"), "wx"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  /** File time of the respawn claim, or null when the attempt is unclaimed. */
  respawnClaimedAt(taskId: string, attempt: number): Date | null {
    try {
      return statSync(path.join(this.attemptDir(taskId, attempt), "respawn.claim")).mtime;
    } catch {
      return null;
    }
  }

  /** Append-only, byte-bounded. Returns whether the chunk was truncated. */
  appendLog(taskId: string, kind: "stdout" | "stderr", text: string): { truncated: boolean } {
    if (!text) return { truncated: false };
    const dir = this.taskDir(taskId);
    privateMkdir(dir);
    const file = path.join(dir, `${kind}.log`);
    let currentBytes = 0;
    try {
      currentBytes = statSync(file).size;
    } catch {
      currentBytes = 0;
    }
    const bytes = Buffer.from(text, "utf8");
    const room = this.#maxLogBytes - currentBytes;
    if (room <= 0) return { truncated: true };
    appendFileSync(file, bytes.length <= room ? bytes : bytes.subarray(0, room), { mode: 0o600 });
    privateFile(file);
    return { truncated: bytes.length > room };
  }

  readLog(taskId: string, kind: "stdout" | "stderr"): string {
    const file = path.join(this.taskDir(taskId), `${kind}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  appendEvent(
    taskId: string,
    type: string,
    summary: string,
    details?: Record<string, unknown>,
    at = new Date().toISOString(),
  ): TaskProgressEvent | null {
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    const lockDir = path.join(dir, "events.lock");
    return withEventLock(lockDir, () => {
      const file = path.join(dir, "events.jsonl");
      const seqFile = path.join(dir, "events.seq");
      let bytes = 0;
      let previousSeq = 0;
      let needsSeparator = false;
      try {
        const info = statSync(file);
        bytes = info.size;
        let lastByte: number | undefined;
        if (bytes > 0) {
          const fd = openSync(file, "r");
          try { const tail = Buffer.alloc(1); readSync(fd, tail, 0, 1, bytes - 1); lastByte = tail[0]; }
          finally { closeSync(fd); }
        }
        needsSeparator = bytes > 0 && lastByte !== 0x0a;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        bytes = 0;
      }
      try {
        previousSeq = Number(readFileSync(seqFile, "utf8"));
        if (!Number.isSafeInteger(previousSeq) || previousSeq < 0) previousSeq = readLastEventSeq(file);
      } catch {
        previousSeq = readLastEventSeq(file);
      }
      const event: TaskProgressEvent = {
        seq: previousSeq + 1,
        at,
        type: type.slice(0, 80),
        summary: summary.length <= 2_000 ? summary : `${summary.slice(0, 1_970)}…[output truncated]`,
        ...(details && Object.keys(details).length ? { details } : {}),
      };
      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8") + (needsSeparator ? 1 : 0);
      const critical = CRITICAL_EVENT_TYPES.has(type);
      const capacity = this.#maxEventBytes + (critical ? MAX_CRITICAL_EVENT_RESERVE_BYTES : 0);
      if (lineBytes > 64_000 || bytes + lineBytes > capacity) return null;
      // Advance the durable cursor before append. A crash can leave a harmless
      // sequence gap, but can never cause two writers to reuse one sequence.
      this.#writeTextAtomic(seqFile, String(event.seq));
      const eventOffset = bytes + (needsSeparator ? 1 : 0);
      appendFileSync(file, `${needsSeparator ? "\n" : ""}${line}`, { encoding: "utf8", mode: 0o600 });
      privateFile(file);
      if (event.seq % 100 === 0) {
        const index = path.join(dir, "events.index");
        appendFileSync(index, `${event.seq}\t${eventOffset}\n`, { encoding: "utf8", mode: 0o600 });
        privateFile(index);
      }
      return event;
    });
  }

  readEvents(taskId: string, afterSeq = 0, limit = 100, view: "raw" | "summary" = "raw"): { events: TaskProgressEvent[]; nextSeq: number; hasMore: boolean; omittedEvents: number } {
    const file = path.join(this.taskDir(taskId), "events.jsonl");
    if (!existsSync(file)) return { events: [], nextSeq: afterSeq, hasMore: false, omittedEvents: 0 };
    let offset = 0;
    const indexFile = path.join(this.taskDir(taskId), "events.index");
    if (existsSync(indexFile)) {
      for (const row of readFileSync(indexFile, "utf8").split(/\r?\n/u)) {
        const [seqText, offsetText] = row.split("\t");
        const seq = Number(seqText);
        const candidateOffset = Number(offsetText);
        if (Number.isInteger(seq) && Number.isSafeInteger(candidateOffset) && seq <= afterSeq) offset = candidateOffset;
        if (seq > afterSeq) break;
      }
    }
    const fd = openSync(file, "r");
    const page: TaskProgressEvent[] = [];
    let hasMore = false;
    let position = offset;
    let pending = "";
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (true) {
        const count = readSync(fd, buffer, 0, buffer.length, position);
        if (count <= 0) break;
        position += count;
        const lines = `${pending}${decoder.write(buffer.subarray(0, count))}`.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseProgressEvent(line);
          if (!event || event.seq <= afterSeq) continue;
          if (page.length === limit) { hasMore = true; break; }
          page.push(event);
        }
        if (hasMore) break;
      }
      pending += decoder.end();
      if (!hasMore && pending) {
        const event = parseProgressEvent(pending);
        if (event && event.seq > afterSeq) {
          if (page.length === limit) hasMore = true;
          else page.push(event);
        }
      }
    } finally {
      closeSync(fd);
    }
    let events = page;
    let omittedEvents = 0;
    if (view === "summary") {
      events = [];
      for (const event of page) {
        const previous = events.at(-1);
        if (event.type === "model_output" && previous?.type === "model_output") {
          const combined = previous.summary + event.summary;
          events[events.length - 1] = {
            ...previous,
            seq: event.seq,
            at: event.at,
            summary: combined.length <= 5_000 ? combined : `${combined.slice(0, 4_950)}…[output compacted]`,
          };
          omittedEvents += 1;
        } else {
          events.push(event);
        }
      }
    }
    return {
      events,
      nextSeq: page.at(-1)?.seq ?? afterSeq,
      hasMore,
      omittedEvents,
    };
  }

  writeInteractionRequest(
    taskId: string,
    request: ZCodeInteractionRequest,
    createdAt = new Date().toISOString(),
  ): { record: ZCodeInteractionRecord; created: boolean } {
    const directory = path.join(this.taskDir(taskId), "interactions");
    privateMkdir(directory);
    const file = this.interactionFile(taskId, request.request_id);
    return withEventLock(path.join(this.taskDir(taskId), "interactions.lock"), () => {
      if (existsSync(file)) {
        const record = this.#readJson(file) as ZCodeInteractionRecord;
        if (record.request_id !== request.request_id || record.method !== request.method || stableJson(record.params) !== stableJson(request.params)) {
          throw new Error("interaction request id collision");
        }
        return { record, created: false };
      }
      if (Buffer.byteLength(JSON.stringify(request.params), "utf8") > 32_000) {
        throw new Error("ZCode interaction request exceeded the 32 KB persistence limit");
      }
      const record: ZCodeInteractionRecord = {
        ...request,
        state: "pending",
        created_at: createdAt,
      };
      this.#writeJsonAtomic(file, record);
      return { record, created: true };
    });
  }

  readInteractionRequest(taskId: string, requestId: string): ZCodeInteractionRecord | null {
    const file = this.interactionFile(taskId, requestId);
    if (!existsSync(file)) return null;
    const record = this.#readJson(file) as ZCodeInteractionRecord;
    if (record.request_id !== requestId) throw new Error("interaction request id hash mismatch");
    return record;
  }

  answerInteractionRequest(
    taskId: string,
    requestId: string,
    answer: Record<string, unknown>,
    answeredAt = new Date().toISOString(),
  ): "answered" | "already_answered" {
    const file = this.interactionFile(taskId, requestId);
    return withEventLock(path.join(this.taskDir(taskId), "interactions.lock"), () => {
      if (!existsSync(file)) throw new Error(`unknown ZCode interaction request: ${requestId}`);
      const current = this.#readJson(file) as ZCodeInteractionRecord;
      if (current.request_id !== requestId) throw new Error("interaction request id hash mismatch");
      if (current.state === "answered") return "already_answered";
      this.#writeJsonAtomic(file, {
        ...current,
        state: "answered",
        answer,
        answered_at: answeredAt,
      } satisfies ZCodeInteractionRecord);
      return "answered";
    });
  }

  private interactionFile(taskId: string, requestId: string): string {
    if (!requestId || requestId.length > 512) throw new Error("invalid ZCode interaction request_id");
    const key = createHash("sha256").update(requestId).digest("hex");
    return path.join(this.taskDir(taskId), "interactions", `${this.readStatus(taskId).attempt}-${key}.json`);
  }

  #readJson(file: string): unknown {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { throw new Error(`unreadable or corrupt JSON record: ${file}`, { cause: error }); }
  }

  #writeJsonAtomic(file: string, value: unknown): void {
    this.#writeTextAtomic(file, JSON.stringify(value, null, 2));
  }

  #writeTextAtomic(file: string, text: string): void {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
      privateFile(tmp);
      atomicRenameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best-effort cleanup
      }
      throw error;
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function withEventLock<T>(lockDir: string, operation: () => T): T {
  const deadline = Date.now() + 10_000;
  let release: (() => void) | null;
  while (!(release = tryAcquireProcessLock(lockDir))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for task state/event lock: ${lockDir}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return operation();
  } finally {
    release();
  }
}

function privateMkdir(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateDirectory(directory);
}

function privateDirectory(directory: string): void {
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function privateFile(file: string): void {
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

function readLastEventSeq(file: string): number {
  if (!existsSync(file)) return 0;
  for (const line of readFileSync(file, "utf8").trimEnd().split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as TaskProgressEvent;
      if (Number.isInteger(event.seq)) return event.seq;
    } catch {
      // Skip malformed or partial records.
    }
  }
  return 0;
}

function parseProgressEvent(line: string): TaskProgressEvent | null {
  if (!line) return null;
  try {
    const event = JSON.parse(line) as TaskProgressEvent;
    return Number.isInteger(event.seq) ? event : null;
  } catch {
    // Ignore a partial final line left by an interrupted process.
    return null;
  }
}

export function isTerminalStatus(status: TaskStatus): boolean {
  // waiting_for_master ends the current attempt and has a persisted result;
  // a later master decision starts a new attempt through zcode_continue.
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "waiting_for_master"
  );
}

/** Strips internal fields for the frozen TaskStatusRecord view. */
export function toPublicStatus(status: InternalTaskStatus): TaskStatusRecord {
  const record: TaskStatusRecord = {
    task_id: status.task_id,
    status: status.status,
    attempt: status.attempt,
    created_at: status.created_at,
    updated_at: status.updated_at,
    started_at: status.started_at,
    finished_at: status.finished_at,
    worker_pid: status.worker_pid,
    zcode_session_id: status.zcode_session_id,
    exit_code: status.exit_code,
  };
  if (status.error_code) record.error_code = status.error_code;
  if (status.error) record.error = status.error;
  return record;
}
