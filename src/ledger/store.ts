// C1/C3 LedgerStore: durable journal-backed store with a rebuildable
// snapshot, single-writer locking, idempotent operations, revision fencing,
// the READY→DONE state machine, review binding, and controlled DONE gate.
// Definitions are imported from .agent-ledger/project.json + tasks/*.json
// (JSON chosen over YAML to keep the bundle dependency-free; the schema is
// identical and validated — recorded as an implementation assumption).
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tryAcquireProcessLock } from "../store/process-lock.js";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  applyLedgerEvent,
  emptyLedgerState,
  LedgerError,
  operationHash,
  stableJson,
  TASK_STATUSES,
  type LedgerActor,
  type LedgerEvent,
  type LedgerEventKind,
  type LedgerState,
  type ProjectRecord,
  type ProjectTask,
  type ProjectTaskStatus,
  type ReviewRecord,
  type RunRecord,
} from "./types.js";

const MAX_PAYLOAD_BYTES = 16 * 1024;
const TORN_TAIL_MAX_BYTES = 64 * 1024;

export interface LedgerOpenOptions {
  /** Refuse to create a new ledger unless explicitly opted in. */
  readonly create?: boolean;
  readonly now?: () => Date;
}

export interface CompleteTaskInput {
  readonly task_id: string;
  /** Delivery receipt for the target workspace; required with evidence. */
  readonly delivery: { readonly accepted: boolean; readonly workspace: string; readonly evidence: string };
  /** Current fingerprints of the declared deliverables; compared with the review's. */
  readonly deliverable_fingerprints?: Array<{ path: string; sha256: string }>;
}

export interface TaskSummaryRow {
  task_id: string;
  goal: string;
  status: ProjectTaskStatus;
  runs: number;
  latest_review: "approved" | "rejected" | "none";
  blocked: string | null;
}

export interface ProjectSummary {
  project_id: string;
  title: string;
  revision: number;
  total_leaf_tasks: number;
  accepted_leaf_tasks: number;
  cancelled_leaf_tasks: number;
  coverage_note: string;
  tasks: TaskSummaryRow[];
}

export class LedgerStore {
  readonly #root: string;
  readonly #ledgerDir: string;
  readonly #journalFile: string;
  readonly #snapshotFile: string;
  readonly #now: () => Date;
  #state: LedgerState = emptyLedgerState();
  #corrupt: string | null = null;

  private constructor(root: string, options: LedgerOpenOptions) {
    this.#root = root;
    this.#ledgerDir = path.join(root, ".agent-ledger", "ledger");
    this.#journalFile = path.join(this.#ledgerDir, "journal.jsonl");
    this.#snapshotFile = path.join(this.#ledgerDir, "snapshot.json");
    this.#now = options.now ?? (() => new Date());
  }

  /** Opens (or creates) the ledger rooted at <root>/.agent-ledger. */
  static open(root: string, options: LedgerOpenOptions = {}): LedgerStore {
    const store = new LedgerStore(root, options);
    const ledgerRoot = path.join(root, ".agent-ledger");
    if (!existsSync(store.#journalFile)) {
      if (!options.create) {
        throw new LedgerError("LEDGER_NOT_FOUND", `no task ledger exists under ${ledgerRoot}; creating one is an explicit opt-in`);
      }
      mkdirSync(store.#ledgerDir, { recursive: true });
      // Respect pre-existing user content: a non-empty .agent-ledger without a
      // journal must never be overwritten silently.
      const foreign = readdirSync(ledgerRoot).filter((entry) => entry !== "ledger");
      if (foreign.length > 0) {
        throw new LedgerError("LEDGER_INVALID", `.agent-ledger already contains foreign content (${foreign.join(", ")}); refusing to initialize`);
      }
      store.#persistSnapshot();
      return store;
    }
    store.#load();
    return store;
  }

  get root(): string {
    return this.#root;
  }

  get revision(): number {
    return this.#state.revision;
  }

  get corruption(): string | null {
    return this.#corrupt;
  }

  // ---- load / rebuild ----

  #load(): void {
    const state = emptyLedgerState();
    const raw = readFileSync(this.#journalFile, "utf8");
    const endsWithNewline = raw.endsWith("\n") || raw.length === 0;
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    // A torn trailing line was never committed: replay ignores it, but a
    // corrupt COMPLETE line blocks everything (C1-04).
    const usable = endsWithNewline ? lines : lines.slice(0, -1);
    if (!endsWithNewline && lines.length > 0) {
      const torn = lines[lines.length - 1]!;
      if (torn.length > TORN_TAIL_MAX_BYTES) {
        this.#corrupt = `journal tail exceeds ${String(TORN_TAIL_MAX_BYTES)} bytes and is not newline-terminated`;
      }
    }
    let expectedRevision = 0;
    for (const line of usable) {
      let event: LedgerEvent;
      try {
        event = JSON.parse(line) as LedgerEvent;
      } catch (error) {
        this.#corrupt = `corrupt journal record at revision ${String(expectedRevision + 1)}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
      if (!event || event.revision !== expectedRevision + 1 || typeof event.operation_id !== "string" || typeof event.kind !== "string") {
        this.#corrupt = `journal integrity broken near revision ${String(expectedRevision + 1)}`;
        break;
      }
      try {
        applyLedgerEvent(state, event);
      } catch (error) {
        this.#corrupt = `journal replay failed at revision ${String(event.revision)}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
      state.operations.set(event.operation_id, { hash: eventOperationHash(event), kind: event.kind, result: summarizeResult(state, event) });
      expectedRevision = event.revision;
    }
    this.#state = state;
    if (this.#corrupt) throw new LedgerError("LEDGER_CORRUPT", `${this.#corrupt}; mutations are blocked (rebuild requires repairing the journal)`);
    // Snapshot is a cache only: drift or damage is repaired from the journal.
    this.#persistSnapshot();
  }

  /** Last committed revision according to the journal file itself. */
  #journalTailRevision(): number {
    if (!existsSync(this.#journalFile)) return 0;
    const size = statSync(this.#journalFile).size;
    if (size === 0) return 0;
    const window = Math.min(64 * 1024, size);
    void window;
    const raw = readFileSync(this.#journalFile, "utf8");
    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n").filter((line) => line.trim());
    const usable = endsWithNewline ? lines : lines.slice(0, -1);
    if (usable.length === 0) return 0;
    try {
      const last = JSON.parse(usable[usable.length - 1]!) as { revision?: number };
      return Number.isSafeInteger(last.revision) ? last.revision! : 0;
    } catch {
      return -1; // corrupt tail: #reloadUnderLock will surface the details
    }
  }

  /** Full journal reload used when another writer advanced the log. */
  #reloadUnderLock(): void {
    const raw = readFileSync(this.#journalFile, "utf8");
    const state = emptyLedgerState();
    const endsWithNewline = raw.endsWith("\n") || raw.length === 0;
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const usable = endsWithNewline ? lines : lines.slice(0, -1);
    let expected = 0;
    for (const line of usable) {
      let event: LedgerEvent;
      try {
        event = JSON.parse(line) as LedgerEvent;
      } catch (error) {
        this.#corrupt = `corrupt journal record at revision ${String(expected + 1)}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
      if (event.revision !== expected + 1) {
        this.#corrupt = `journal integrity broken near revision ${String(expected + 1)}`;
        break;
      }
      applyLedgerEvent(state, event);
      state.operations.set(event.operation_id, { hash: eventOperationHash(event), kind: event.kind, result: summarizeResult(state, event) });
      expected = event.revision;
    }
    this.#state = state;
    if (this.#corrupt) throw new LedgerError("LEDGER_CORRUPT", `${this.#corrupt}; mutations are blocked`);
  }

  #persistSnapshot(): void {
    mkdirSync(this.#ledgerDir, { recursive: true });
    const snapshot = {
      schema_version: 1,
      revision: this.#state.revision,
      saved_at: this.#now().toISOString(),
    };
    const tmp = `${this.#snapshotFile}.${randomUUID()}.tmp`;
    writeTextAtomic(tmp, JSON.stringify(snapshot), this.#snapshotFile);
  }

  // ---- write path ----

  /** Appends one event under the single-writer lock, durably, then updates
   * the state and snapshot. Returns the recorded result for the operation.
   *
   * `payload` is either the event payload or a builder invoked under the lock
   * (for payloads embedding state-derived facts, so they never go stale).
   * `identity` is the hash basis for idempotent replay and must bind ONLY
   * caller input: state-derived fields (timestamps, resolved ids, definition
   * versions, latest-run bindings) drift as the ledger evolves and would turn
   * a legitimate replay into a spurious conflict. State-dependent gates belong
   * in `validate`, which fresh commits run under the lock but replays skip —
   * a replay must be answered from the journal even if the task has moved on
   * (done, cancelled, re-defined, new runs) since the original commit. */
  #commit<T>(actor: LedgerActor, kind: LedgerEventKind, payload: Record<string, unknown> | ((state: LedgerState) => Record<string, unknown>), options: { operationId: string; expectedRevision?: number; identity?: Record<string, unknown>; validate?: (state: LedgerState) => void }): T {
    if (this.#corrupt) throw new LedgerError("LEDGER_CORRUPT", "the journal contains a corrupt record; mutations are blocked");
    if (typeof options.operationId !== "string" || !options.operationId.trim() || options.operationId.length > 128) {
      throw new LedgerError("LEDGER_INVALID", "operation_id must be a non-empty string up to 128 characters");
    }
    const identity = options.identity ?? (typeof payload === "function" ? null : payload);
    if (!identity) throw new LedgerError("LEDGER_INVALID", "internal: identity input is required when the event payload is built under the write lock");
    if (Buffer.byteLength(JSON.stringify(identity), "utf8") > MAX_PAYLOAD_BYTES) {
      throw new LedgerError("LEDGER_INVALID", "ledger event payload exceeds the 16 KB bound");
    }
    mkdirSync(this.#ledgerDir, { recursive: true });
    const release = tryAcquireProcessLock(path.join(this.#ledgerDir, "write.lock"));
    if (!release) throw new LedgerError("LEDGER_CONFLICT", "another writer holds the ledger write lock; retry with the same operation_id");
    try {
      // Another process may have appended while we waited: under the lock the
      // authoritative revision comes from the journal, never stale memory.
      const journalRevision = this.#journalTailRevision();
      if (journalRevision !== this.#state.revision) this.#reloadUnderLock();
      // Idempotent replay: identical operation → identical recorded result,
      // no new event, no side effects (C1-03). Volatile timestamps are
      // excluded from the hash so a replayed call matches its original.
      const hash = operationHash(kind, stableOperationPayload(identity));
      const previous = this.#state.operations.get(options.operationId);
      if (previous) {
        if (previous.hash !== hash) {
          throw new LedgerError("LEDGER_CONFLICT", `operation_id '${options.operationId}' already belongs to different input`);
        }
        return previous.result as T;
      }
      if (options.expectedRevision !== undefined && this.#state.revision !== options.expectedRevision) {
        throw new LedgerError("LEDGER_CONFLICT", `revision conflict: expected ${String(options.expectedRevision)}, current ${String(this.#state.revision)}`);
      }
      const eventPayload = typeof payload === "function" ? payload(this.#state) : payload;
      if (Buffer.byteLength(JSON.stringify(eventPayload), "utf8") > MAX_PAYLOAD_BYTES) {
        throw new LedgerError("LEDGER_INVALID", "ledger event payload exceeds the 16 KB bound");
      }
      options.validate?.(this.#state);
      const event: LedgerEvent = {
        event_id: randomUUID(),
        revision: this.#state.revision + 1,
        operation_id: options.operationId,
        ts: this.#now().toISOString(),
        actor,
        kind,
        payload: eventPayload,
        op_hash: hash,
      };
      // Durability before success: append + fsync, then atomic snapshot.
      const fd = openSync(this.#journalFile, "a");
      try {
        appendFileSync(fd, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      applyLedgerEvent(this.#state, event);
      const result = summarizeResult(this.#state, event);
      this.#state.operations.set(event.operation_id, { hash, kind, result });
      this.#persistSnapshot();
      return result as T;
    } finally {
      release();
    }
  }

  // ---- project / definition import ----

  createProject(input: { project_id?: string; title: string; workspace: string }, operationId: string, actor: LedgerActor = { source: "host", id: "local" }): ProjectRecord {
    if (!input.title?.trim() || !path.isAbsolute(input.workspace)) {
      throw new LedgerError("LEDGER_INVALID", "project requires a title and an absolute workspace path");
    }
    const project_id = input.project_id?.trim() || operationDerivedId("proj", operationId);
    const now = this.#now().toISOString();
    return this.#commit<ProjectRecord>(actor, "project.created", {
      project_id,
      title: input.title.trim(),
      workspace: path.resolve(input.workspace),
      schema_version: 1,
      created_at: now,
      updated_at: now,
    }, { operationId, validate: (state) => {
      if (state.projects.has(project_id)) throw new LedgerError("LEDGER_INVALID", `project already exists: ${project_id}`);
    } });
  }

  /** Explicit re-binding after a project move; never auto-adopts a path. */
  rebindProject(projectId: string, workspace: string, operationId: string, actor: LedgerActor = { source: "host", id: "local" }): ProjectRecord {
    if (!path.isAbsolute(workspace)) throw new LedgerError("LEDGER_INVALID", "workspace must be an absolute path");
    const current = this.#state.projects.get(projectId);
    if (!current) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project: ${projectId}`);
    return this.#commit<ProjectRecord>(actor, "project.updated", {
      project_id: projectId,
      workspace: path.resolve(workspace),
      updated_at: this.#now().toISOString(),
    }, { operationId });
  }

  /** Imports validated task definitions from <root>/.agent-ledger/tasks/*.json. */
  importDefinitions(actor: LedgerActor = { source: "host", id: "local" }): Array<ProjectTask> {
    const tasksDir = path.join(this.#root, ".agent-ledger", "tasks");
    if (!existsSync(tasksDir)) return [];
    const imported: Array<ProjectTask> = [];
    for (const file of readdirSync(tasksDir).filter((entry) => entry.endsWith(".json")).sort()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path.join(tasksDir, file), "utf8"));
      } catch (error) {
        throw new LedgerError("LEDGER_INVALID", `invalid task definition ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const definition = parsed as Record<string, unknown>;
      const created = this.createTask({
        task_id: typeof definition.task_id === "string" ? definition.task_id : undefined,
        project_id: typeof definition.project_id === "string" ? definition.project_id : undefined,
        goal: String(definition.goal ?? ""),
        acceptance_criteria: Array.isArray(definition.acceptance_criteria) ? definition.acceptance_criteria as Array<{ id: string; text: string }> : [],
        constraints: (definition.constraints as ProjectTask["constraints"]) ?? { allowed_paths: [], forbidden_paths: [] },
        workspace: String(definition.workspace ?? ""),
        dependencies: Array.isArray(definition.dependencies) ? definition.dependencies as string[] : [],
        epic_id: typeof definition.epic_id === "string" ? definition.epic_id : null,
        assignee: typeof definition.assignee === "string" ? definition.assignee : null,
        expected_delivery: typeof definition.expected_delivery === "string" ? definition.expected_delivery : null,
      }, `import:${file}`, actor);
      imported.push(created);
    }
    return imported;
  }

  // ---- task CRUD + state machine ----

  createTask(input: {
    task_id?: string;
    project_id?: string;
    goal: string;
    acceptance_criteria: Array<{ id: string; text: string }>;
    constraints?: ProjectTask["constraints"];
    workspace: string;
    dependencies?: string[];
    epic_id?: string | null;
    assignee?: string | null;
    expected_delivery?: string | null;
  }, operationId: string, actor: LedgerActor = { source: "host", id: "local" }): ProjectTask {
    const projectId = input.project_id ?? [...this.#state.projects.keys()][0];
    if (!projectId) {
      throw new LedgerError("LEDGER_INVALID", "create a project before adding tasks");
    }
    const task_id = input.task_id?.trim() || operationDerivedId("pt", operationId);
    if (!/^[a-z][a-z0-9_-]{2,63}$/u.test(task_id)) {
      throw new LedgerError("LEDGER_INVALID", `task_id must match [a-z][a-z0-9_-]{2,63}: ${task_id}`);
    }
    if (!input.goal?.trim()) throw new LedgerError("LEDGER_INVALID", "task requires a non-empty goal");
    if (!input.acceptance_criteria?.length || input.acceptance_criteria.some((ac) => !ac.id?.trim() || !ac.text?.trim())) {
      throw new LedgerError("LEDGER_INVALID", "task requires numbered, non-empty acceptance criteria");
    }
    const ids = new Set(input.acceptance_criteria.map((ac) => ac.id));
    if (ids.size !== input.acceptance_criteria.length) throw new LedgerError("LEDGER_INVALID", "acceptance criterion ids must be unique");
    if (!path.isAbsolute(input.workspace)) throw new LedgerError("LEDGER_INVALID", "task workspace must be an absolute path");
    const dependencies = input.dependencies ?? [];
    if (dependencies.includes(task_id)) throw new LedgerError("LEDGER_INVALID", "a task cannot depend on itself");
    // State-dependent checks run inside #commit after the idempotency check,
    // so replaying a recorded operation never hits "duplicate id".
    for (const dependency of dependencies) {
      if (this.#dependencyReaches(dependency, task_id)) {
        throw new LedgerError("LEDGER_INVALID", `dependency cycle detected through '${dependency}'`);
      }
    }
    const now = this.#now().toISOString();
    return this.#commit<ProjectTask>(actor, "task.created", {
      task_id,
      project_id: projectId,
      goal: input.goal.trim(),
      acceptance_criteria: input.acceptance_criteria,
      constraints: input.constraints ?? { allowed_paths: [], forbidden_paths: [] },
      workspace: path.resolve(input.workspace),
      definition_version: 1,
      dependencies,
      epic_id: input.epic_id ?? null,
      assignee: input.assignee ?? null,
      expected_delivery: input.expected_delivery ?? null,
      status: "backlog",
      blocked_reason: null,
      open_decisions: [],
      ac_exemptions: [],
      run_ids: [],
      created_at: now,
      updated_at: now,
    }, { operationId, validate: (state) => {
      if (!state.projects.has(projectId)) throw new LedgerError("LEDGER_INVALID", "create a project before adding tasks");
      if (state.tasks.has(task_id)) throw new LedgerError("LEDGER_INVALID", `duplicate task id: ${task_id}`);
    } });
  }

  #dependencyReaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const walk = (current: string): boolean => {
      if (current === target) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      const task = this.#state.tasks.get(current);
      return task ? task.dependencies.some(walk) : false;
    };
    return walk(from);
  }

  updateTask(taskId: string, patch: {
    goal?: string;
    acceptance_criteria?: Array<{ id: string; text: string }>;
    dependencies?: string[];
    assignee?: string | null;
    expected_delivery?: string | null;
    open_decisions?: string[];
    epic_id?: string | null;
  }, operationId: string, actor: LedgerActor = { source: "host", id: "local" }, expectedRevision?: number): ProjectTask {
    // Identity binds only the caller's patch: a replay must match even though
    // the recorded definition bump was computed against the older state.
    const identity: Record<string, unknown> = { task_id: taskId };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) identity[key] = value;
    }
    // The definition bump, cycle check, and terminal-state gate read live
    // state under the write lock, so replays of recorded operations are
    // answered from the journal even after the task completed or moved on.
    return this.#commit<ProjectTask>(actor, "task.updated", (state) => {
      const current = state.tasks.get(taskId);
      if (!current) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${taskId}`);
      if (current.status === "done" || current.status === "cancelled") {
        throw new LedgerError("LEDGER_STATE", `cannot update a ${current.status} task; reopen or create a new task`);
      }
      if (patch.dependencies) {
        for (const dependency of patch.dependencies) {
          if (dependency === taskId) throw new LedgerError("LEDGER_INVALID", "a task cannot depend on itself");
          if (this.#dependencyReaches(dependency, taskId)) {
            throw new LedgerError("LEDGER_INVALID", `dependency cycle detected through '${dependency}'`);
          }
        }
      }
      // A definition change invalidates prior approvals: the review binds to the
      // definition version, so DONE checks always compare versions (C3-03).
      let definitionBump = false;
      if (patch.goal !== undefined && patch.goal !== current.goal) definitionBump = true;
      if (patch.acceptance_criteria !== undefined && stableJson(patch.acceptance_criteria) !== stableJson(current.acceptance_criteria)) definitionBump = true;
      if (patch.dependencies !== undefined && stableJson(patch.dependencies) !== stableJson(current.dependencies)) definitionBump = true;
      return {
        task_id: taskId,
        ...identity,
        ...(definitionBump ? { definition_version: current.definition_version + 1 } : {}),
        updated_at: this.#now().toISOString(),
      };
    }, { operationId, identity, expectedRevision });
  }

  #requireTask(taskId: string): ProjectTask {
    const task = this.#state.tasks.get(taskId);
    if (!task) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${taskId}`);
    return task;
  }

  /** READY gate: definition complete, dependencies resolved, no open decisions. */
  #assertReady(state: LedgerState, task: ProjectTask): void {
    if (!task.goal.trim()) throw new LedgerError("LEDGER_STATE", "READY requires a goal");
    if (!task.acceptance_criteria.length) throw new LedgerError("LEDGER_STATE", "READY requires at least one acceptance criterion");
    if (!task.workspace) throw new LedgerError("LEDGER_STATE", "READY requires an explicit workspace binding");
    for (const dependency of task.dependencies) {
      const dep = state.tasks.get(dependency);
      if (!dep) throw new LedgerError("LEDGER_STATE", `dependency '${dependency}' does not exist`);
      if (dep.status !== "done" && dep.status !== "cancelled") {
        throw new LedgerError("LEDGER_STATE", `dependency '${dependency}' is ${dep.status}; READY requires it done or cancelled`);
      }
    }
    if (task.open_decisions.length > 0) throw new LedgerError("LEDGER_STATE", `READY requires resolving open decisions: ${task.open_decisions.join(", ")}`);
  }

  transitionTask(taskId: string, to: ProjectTaskStatus, operationId: string, options: { reason?: string; runId?: string; manualEvidence?: string } = {}, actor: LedgerActor = { source: "host", id: "local" }): ProjectTask {
    if (!TASK_STATUSES.includes(to)) throw new LedgerError("LEDGER_INVALID", `unknown status: ${to}`);
    // DONE is reachable only through the review gate (completeTask); the done
    // task itself changes state only through reopen. Both gates live in
    // validate: they run on fresh commits under the lock, and replays of
    // recorded transitions are answered from the journal without re-checking.
    if (to === "done") {
      throw new LedgerError("LEDGER_STATE", "task completion must pass the review/DONE gate (completeTask), not a direct transition");
    }
    if (to === "blocked" && !options.reason?.trim()) {
      throw new LedgerError("LEDGER_STATE", "blocking requires a reason");
    }
    if (to === "cancelled" && actor.source !== "host") {
      throw new LedgerError("LEDGER_FORBIDDEN", "only the host may cancel a project task");
    }
    return this.#commit<ProjectTask>(actor, "task.transitioned", {
      task_id: taskId,
      status: to,
      blocked_reason: to === "blocked" ? options.reason ?? null : null,
      updated_at: this.#now().toISOString(),
    }, { operationId, validate: (state) => {
      const live = state.tasks.get(taskId);
      if (!live) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${taskId}`);
      if (live.status === "done") {
        throw new LedgerError("LEDGER_STATE", "a done task changes state only through reopen");
      }
      if (to === "ready") this.#assertReady(state, live);
      if (to === "in_progress") {
        // "Assigned" is not "started": an actual run or a manual work record
        // must exist before IN_PROGRESS (C3).
        const hasRun = options.runId ? live.run_ids.includes(options.runId) : live.run_ids.length > 0;
        const hasManual = Boolean(options.manualEvidence?.trim()) || live.run_ids.some((runId) => state.runs.get(runId)?.executor.kind === "manual");
        if (!hasRun && !hasManual) {
          throw new LedgerError("LEDGER_STATE", "IN_PROGRESS requires a linked run or a manual work record");
        }
      }
      if (to === "implemented") {
        // IMPLEMENTED means an implementation report exists for review — it is
        // never a verdict of acceptance (C3).
        const finished = live.run_ids.some((runId) => {
          const run = state.runs.get(runId);
          if (!run) return false;
          if (run.executor.kind === "manual" && run.manual_evidence) return true;
          return run.status === "finished" && run.report_ref !== null;
        });
        if (!finished && !options.manualEvidence?.trim()) {
          throw new LedgerError("LEDGER_STATE", "IMPLEMENTED requires a finished run with an implementation report or manual work evidence");
        }
      }
    } });
  }

  reopenTask(taskId: string, reason: string, operationId: string, actor: LedgerActor = { source: "host", id: "local" }): ProjectTask {
    if (!reason.trim()) throw new LedgerError("LEDGER_STATE", "reopen requires a reason");
    // Reopen preserves all history: prior reviews/runs stay queryable. The
    // done-task precondition is checked under the lock so a replay of a
    // recorded reopen (task now ready) still replays from the journal.
    return this.#commit<ProjectTask>(actor, "task.reopened", {
      task_id: taskId,
      status: "ready",
      blocked_reason: null,
      updated_at: this.#now().toISOString(),
    }, { operationId, validate: (state) => {
      const live = state.tasks.get(taskId);
      if (!live) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${taskId}`);
      if (live.status !== "done") throw new LedgerError("LEDGER_STATE", `reopen applies to done tasks (current: ${live.status})`);
      this.#assertReady(state, live);
      void reason;
    } });
  }

  exemptAc(taskId: string, acId: string, authorization: { authorized_by: string; reason: string }, operationId: string, actor: LedgerActor = { source: "host", id: "local" }): ProjectTask {
    if (actor.source !== "host") {
      throw new LedgerError("LEDGER_FORBIDDEN", "AC exemptions require an explicit host authorization record; a worker can never self-exempt");
    }
    if (!authorization.authorized_by.trim() || !authorization.reason.trim()) {
      throw new LedgerError("LEDGER_INVALID", "exemptions require authorized_by and reason");
    }
    // Identity excludes the store-generated granted_at (it is regenerated on
    // every call), so a recorded exemption replays instead of conflicting.
    const identity = { task_id: taskId, ac_id: acId, authorized_by: authorization.authorized_by.trim(), reason: authorization.reason.trim() };
    return this.#commit<ProjectTask>(actor, "ac.exempted", (state) => {
      const live = state.tasks.get(taskId);
      if (!live) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${taskId}`);
      if (!live.acceptance_criteria.some((ac) => ac.id === acId)) {
        throw new LedgerError("LEDGER_NOT_FOUND", `unknown acceptance criterion: ${acId}`);
      }
      return {
        task_id: taskId,
        exemption: { ac_id: acId, authorized_by: authorization.authorized_by.trim(), reason: authorization.reason.trim(), granted_at: this.#now().toISOString() },
      };
    }, { operationId, identity });
  }

  // ---- runs ----

  startRun(input: {
    task_id: string;
    executor: { kind: "zcode-bridge" | "manual" };
    executor_ref?: string | null;
    manual_evidence?: string | null;
    run_id?: string;
  }, operationId: string, actor: LedgerActor = { source: "host", id: "local" }): RunRecord {
    if (input.executor.kind === "manual" && !input.manual_evidence?.trim()) {
      throw new LedgerError("LEDGER_INVALID", "a manual run requires work evidence");
    }
    // The derived run_id is a pure function of operation_id, so a retry that
    // re-derives it (or passes it explicitly) hashes to the same identity.
    const run_id = input.run_id?.trim() || operationDerivedId("run", operationId);
    // definition_version is state-derived: build the payload under the lock so
    // a replay of a recorded intent never conflicts after the definition (or
    // the task's terminal state) changed.
    return this.#commit<RunRecord>(actor, "run.started", (state) => {
      const live = state.tasks.get(input.task_id);
      if (!live) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${input.task_id}`);
      if (live.status === "done" || live.status === "cancelled") {
        throw new LedgerError("LEDGER_STATE", `cannot start a run for a ${live.status} task`);
      }
      const now = this.#now().toISOString();
      return {
        run_id,
        task_id: live.task_id,
        definition_version: live.definition_version,
        executor: input.executor,
        executor_ref: input.executor_ref ?? null,
        attempt: null,
        status: "intent",
        model: null,
        usage: null,
        timing: null,
        report_ref: null,
        manual_evidence: input.manual_evidence ?? null,
        created_at: now,
        updated_at: now,
      };
    }, { operationId, identity: {
      run_id,
      task_id: input.task_id,
      executor: input.executor,
      executor_ref: input.executor_ref ?? null,
      manual_evidence: input.manual_evidence ?? null,
    } });
  }

  updateRun(runId: string, patch: {
    status?: RunRecord["status"];
    attempt?: number | null;
    executor_ref?: string | null;
    model?: RunRecord["model"];
    usage?: Record<string, unknown> | null;
    timing?: Record<string, unknown> | null;
    report_ref?: RunRecord["report_ref"];
  }, operationId: string, actor: LedgerActor): RunRecord {
    const run = this.#state.runs.get(runId);
    if (!run) throw new LedgerError("LEDGER_NOT_FOUND", `unknown run: ${runId}`);
    if (actor.source === "worker") {
      throw new LedgerError("LEDGER_FORBIDDEN", "workers deliver evidence through the bridge actor, never write runs directly");
    }
    // Undefined patch values mean "not provided", never "clear the fact".
    const effective: Record<string, unknown> = { run_id: runId };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) effective[key] = value;
    }
    effective["updated_at"] = this.#now().toISOString();
    return this.#commit<RunRecord>(actor, "run.updated", effective, { operationId });
  }

  // ---- review + DONE gate ----

  recordReview(input: {
    task_id: string;
    run_id?: string | null;
    results: Array<{ ac_id: string; verdict: "pass" | "fail" | "not_verified"; evidence: string }>;
    deliverable_fingerprints: Array<{ path: string; sha256: string }>;
    verdict: "approved" | "rejected";
    reason?: string | null;
  }, operationId: string, actor: LedgerActor): { review: ReviewRecord; task: ProjectTask } {
    // The controlled host entry is the only review authorization source.
    // An actor string claiming 'host' from an uncontrolled channel is a
    // deployment error, not something the ledger can verify — so writes are
    // restricted to host actors and the entry point is host-owned (C3-01).
    if (actor.source !== "host") {
      throw new LedgerError("LEDGER_FORBIDDEN", "reviews may only be recorded through the controlled host entry");
    }
    if (input.deliverable_fingerprints.length === 0) {
      throw new LedgerError("LEDGER_INVALID", "a review must bind deliverable fingerprints");
    }
    if (`${operationId}:reject`.length > 128) {
      throw new LedgerError("LEDGER_INVALID", "operation_id must stay under 121 characters so the paired rejection transition fits");
    }
    const review_id = operationDerivedId("rev", operationId);
    // Identity binds only caller input. The recorded review binds run and AC
    // version under the lock; a replay of the same review request is answered
    // from the journal even if the task meanwhile returned to ready and took
    // new runs (the rejection flow) or its definition changed.
    const reviewResult = this.#commit<ReviewRecord>(actor, "review.recorded", (state) => {
      const live = state.tasks.get(input.task_id);
      if (!live) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${input.task_id}`);
      const acIds = new Set(live.acceptance_criteria.map((ac) => ac.id));
      for (const result of input.results) {
        if (!acIds.has(result.ac_id)) throw new LedgerError("LEDGER_INVALID", `review result references unknown AC: ${result.ac_id}`);
      }
      for (const ac of live.acceptance_criteria) {
        if (!input.results.some((result) => result.ac_id === ac.id)) {
          throw new LedgerError("LEDGER_INVALID", `review must cover every AC; missing: ${ac.id}`);
        }
      }
      const review: ReviewRecord = {
        review_id,
        task_id: live.task_id,
        run_id: input.run_id ?? live.run_ids.at(-1) ?? null,
        ac_version: live.definition_version,
        results: input.results,
        deliverable_fingerprints: input.deliverable_fingerprints,
        reviewer: actor,
        verdict: input.verdict,
        reason: input.reason ?? null,
        created_at: this.#now().toISOString(),
      };
      return review as unknown as Record<string, unknown>;
    }, {
      operationId,
      identity: {
        task_id: input.task_id,
        run_id: input.run_id ?? null,
        results: input.results,
        deliverable_fingerprints: input.deliverable_fingerprints,
        verdict: input.verdict,
        reason: input.reason ?? null,
      },
      validate: (state) => {
        const live = state.tasks.get(input.task_id);
        if (!live) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${input.task_id}`);
        if (!["implemented", "review"].includes(live.status)) {
          throw new LedgerError("LEDGER_STATE", `review requires an implemented task (current: ${live.status})`);
        }
      },
    });
    // A rejection returns the task to ready with the reason preserved; a
    // review never continues execution automatically (C3).
    if (input.verdict === "rejected") {
      const taskAfter = this.#commit<ProjectTask>(actor, "task.transitioned", {
        task_id: input.task_id,
        status: "ready",
        blocked_reason: input.reason ?? "review rejected",
        updated_at: this.#now().toISOString(),
      }, { operationId: `${operationId}:reject` });
      return { review: reviewResult, task: taskAfter };
    }
    return { review: reviewResult, task: this.#requireTask(input.task_id) };
  }

  latestReview(taskId: string): ReviewRecord | null {
    const reviews = [...this.#state.reviews.values()].filter((review) => review.task_id === taskId);
    return reviews.length ? reviews.reduce((a, b) => (a.created_at > b.created_at ? a : b)) : null;
  }

  /** DONE gate (C3-02/03): every AC pass-or-exempt under a current review,
   * deliverables received into the target workspace, fingerprints unchanged.
   * The gates read live state under the lock, so replaying a recorded
   * completion (task already done) replays the recorded result instead of
   * refusing. */
  completeTask(input: CompleteTaskInput, operationId: string, actor: LedgerActor = { source: "host", id: "local" }): ProjectTask {
    if (actor.source !== "host") {
      throw new LedgerError("LEDGER_FORBIDDEN", "only the controlled host entry may complete a task");
    }
    if (!input.delivery.accepted || !input.delivery.evidence.trim()) {
      throw new LedgerError("LEDGER_STATE", "complete requires an explicit delivery receipt with evidence");
    }
    return this.#commit<ProjectTask>(actor, "task.transitioned", {
      task_id: input.task_id,
      status: "done",
      blocked_reason: null,
      updated_at: this.#now().toISOString(),
    }, { operationId, validate: (state) => {
      const live = state.tasks.get(input.task_id);
      if (!live) throw new LedgerError("LEDGER_NOT_FOUND", `unknown project task: ${input.task_id}`);
      if (!["implemented", "review"].includes(live.status)) {
        throw new LedgerError("LEDGER_STATE", `complete requires implemented/review (current: ${live.status})`);
      }
      if (path.resolve(input.delivery.workspace) !== path.resolve(live.workspace)) {
        throw new LedgerError("LEDGER_STATE", "the delivery receipt must reference the task's bound workspace");
      }
      const review = this.latestReview(input.task_id);
      if (!review || review.verdict !== "approved") {
        throw new LedgerError("LEDGER_STATE", "complete requires a current approved review");
      }
      if (review.ac_version !== live.definition_version) {
        throw new LedgerError("LEDGER_STATE", `the approved review binds definition v${String(review.ac_version)}; the task is at v${String(live.definition_version)} — re-review required`);
      }
      if (input.deliverable_fingerprints) {
        const reviewed = new Map(review.deliverable_fingerprints.map((item) => [item.path, item.sha256]));
        for (const fingerprint of input.deliverable_fingerprints) {
          const bound = reviewed.get(fingerprint.path);
          if (bound === undefined) throw new LedgerError("LEDGER_STATE", `deliverable '${fingerprint.path}' was not covered by the approved review`);
          if (bound !== fingerprint.sha256) {
            throw new LedgerError("LEDGER_STATE", `deliverable '${fingerprint.path}' changed after approval; re-review required`);
          }
        }
      }
      const failures = live.acceptance_criteria.filter((ac) => {
        if (live.ac_exemptions.some((exemption) => exemption.ac_id === ac.id)) return false;
        const result = review.results.find((item) => item.ac_id === ac.id);
        return !result || result.verdict !== "pass";
      });
      if (failures.length > 0) {
        throw new LedgerError("LEDGER_STATE", `complete refused: unmet acceptance criteria (${failures.map((ac) => ac.id).join(", ")}); exemptions require explicit host authorization records`);
      }
    } });
  }

  // ---- read-only views (C1-05) ----

  getTask(taskId: string): ProjectTask {
    return this.#requireTask(taskId);
  }

  listRuns(filter: { task_id?: string } = {}): RunRecord[] {
    return [...this.#state.runs.values()]
      .filter((run) => (filter.task_id ? run.task_id === filter.task_id : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listTasks(filter: { status?: ProjectTaskStatus; project_id?: string } = {}): ProjectTask[] {
    return [...this.#state.tasks.values()]
      .filter((task) => (filter.status ? task.status === filter.status : true))
      .filter((task) => (filter.project_id ? task.project_id === filter.project_id : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  taskHistory(taskId: string): Array<{ revision: number; ts: string; kind: LedgerEventKind; actor: LedgerActor; summary: string }> {
    this.#requireTask(taskId);
    // Re-read the journal tail for this task's events (bounded).
    const raw = existsSync(this.#journalFile) ? readFileSync(this.#journalFile, "utf8") : "";
    const history: Array<{ revision: number; ts: string; kind: LedgerEventKind; actor: LedgerActor; summary: string }> = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as LedgerEvent;
        const involved = event.payload.task_id === taskId
          || (event.kind === "review.recorded" && (event.payload as unknown as ReviewRecord).task_id === taskId);
        if (!involved) continue;
        const result = event.payload as Record<string, unknown>;
        history.push({ revision: event.revision, ts: event.ts, kind: event.kind, actor: event.actor, summary: stableJson(result) });
      } catch { /* corrupt tail handled at open() */ }
    }
    return history;
  }

  summary(projectId?: string): ProjectSummary {
    const project = projectId
      ? this.#state.projects.get(projectId)
      : [...this.#state.projects.values()][0];
    if (!project) throw new LedgerError("LEDGER_NOT_FOUND", "no project exists in this ledger");
    const tasks = this.listTasks({ project_id: project.project_id });
    // Leaf = not grouped under an epic. Dependencies order work; they do not
    // remove a task from the denominator, and epics are never double counted.
    const leaf = tasks.filter((task) => !tasks.some((other) => other.epic_id === task.task_id));
    const done = leaf.filter((task) => task.status === "done").length;
    const cancelled = leaf.filter((task) => task.status === "cancelled").length;
    return {
      project_id: project.project_id,
      title: project.title,
      revision: this.#state.revision,
      total_leaf_tasks: leaf.length,
      accepted_leaf_tasks: done,
      cancelled_leaf_tasks: cancelled,
      coverage_note: `已验收叶子任务 ${String(done)}/${String(leaf.length)}（cancelled ${String(cancelled)} 计入分母但不计入完成）；统计截至 revision ${String(this.#state.revision)}，更新于 ${this.#now().toISOString()}。该比例只是任务数比例，不是整体工程完成度。`,
      tasks: tasks.map((task) => {
        const review = this.latestReview(task.task_id);
        return {
          task_id: task.task_id,
          goal: task.goal,
          status: task.status,
          runs: task.run_ids.length,
          latest_review: review ? review.verdict : "none",
          blocked: task.blocked_reason,
        };
      }),
    };
  }

  /** Sanitized export: definitions + summary only; never private run logs,
   * session content, credentials, or hidden reasoning (C1-06). */
  export(): Record<string, unknown> {
    return {
      schema_version: 1,
      exported_at: this.#now().toISOString(),
      projects: [...this.#state.projects.values()],
      tasks: [...this.#state.tasks.values()].map((task) => ({
        task_id: task.task_id,
        goal: task.goal,
        status: task.status,
        acceptance_criteria: task.acceptance_criteria,
        dependencies: task.dependencies,
        definition_version: task.definition_version,
        ac_exemptions: task.ac_exemptions,
      })),
      runs: [...this.#state.runs.values()].map((run) => ({
        run_id: run.run_id,
        task_id: run.task_id,
        executor: run.executor,
        status: run.status,
        model: run.model,
        usage: run.usage,
      })),
      reviews: [...this.#state.reviews.values()].map((review) => ({
        review_id: review.review_id,
        task_id: review.task_id,
        ac_version: review.ac_version,
        verdict: review.verdict,
        results: review.results,
      })),
    };
  }

  /** Corrupt-journal diagnosis surface for operators. */
  static journalFingerprint(journalFile: string): { bytes: number; lines: number; sha256: string } | null {
    if (!existsSync(journalFile)) return null;
    const raw = readFileSync(journalFile);
    return { bytes: raw.length, lines: raw.toString("utf8").split("\n").filter((line) => line.trim()).length, sha256: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
  }

  get journalPath(): string {
    return this.#journalFile;
  }

  /** Test/operator helper: drops the rebuildable snapshot (never the journal). */
  static resetSnapshot(root: string): void {
    const file = path.join(root, ".agent-ledger", "ledger", "snapshot.json");
    if (existsSync(file)) rmSync(file);
  }
}

const VOLATILE_PAYLOAD_KEYS = new Set(["created_at", "updated_at", "ts"]);

/** The idempotency hash a journal event was committed with: the persisted
 * op_hash when present (caller-input identity), otherwise the legacy payload
 * hash for journals written before identity hashing existed. */
function eventOperationHash(event: LedgerEvent): string {
  return typeof event.op_hash === "string" && event.op_hash ? event.op_hash : operationHash(event.kind, stableOperationPayload(event.payload));
}

function stableOperationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!VOLATILE_PAYLOAD_KEYS.has(key)) copy[key] = value;
  }
  return copy;
}

function operationDerivedId(prefix: string, operationId: string): string {
  return `${prefix}-${createHash("sha256").update(operationId).digest("hex").slice(0, 16)}`;
}

function summarizeResult(state: LedgerState, event: LedgerEvent): Record<string, unknown> {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case "project.created":
    case "project.updated":
      return structuredClone(state.projects.get(String(payload.project_id)) ?? {});
    case "task.created":
    case "task.updated":
    case "task.transitioned":
    case "task.reopened":
      return structuredClone(state.tasks.get(String(payload.task_id)) ?? {});
    case "ac.exempted":
      return structuredClone(state.tasks.get(String(payload.task_id)) ?? {});
    case "run.started":
    case "run.updated":
      return structuredClone(state.runs.get(String(payload.run_id)) ?? {});
    case "review.recorded":
      return structuredClone(state.reviews.get(String(payload.review_id)) ?? {});
    default:
      return {};
  }
}

function writeTextAtomic(tmp: string, text: string, target: string): void {
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}
