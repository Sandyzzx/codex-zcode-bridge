// C1/C3 project task ledger: an independent, opt-in logical control layer for
// long-lived project tasks. The Bridge TaskManager keeps owning execution and
// process cleanup; the ledger owns project-task identity, runs, reviews, and
// the DONE gate. ProjectTask IDs are a separate namespace from Bridge
// task_ids; they relate only through an explicit executor_ref (C2).
//
// Integrity contract (C1): the journal is the authority for state changes;
// the snapshot is a rebuildable cache. A torn trailing line is not a commit;
// a corrupt record mid-file blocks all mutations (the B1 skip-bad-line rule
// for ACTIVE logs never applies here). Every mutation carries an
// operation_id (idempotent replay with identical input, conflict otherwise)
// and may carry an expected_revision (one writer wins, the other conflicts).
import { randomUUID } from "node:crypto";

export type ProjectTaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "implemented"
  | "review"
  | "done"
  | "blocked"
  | "cancelled";

export const LEDGER_SCHEMA_VERSION = 1 as const;

export interface LedgerActor {
  /** "host" is the only source allowed to review, exempt, complete, or
   * reopen; an actor string is never authorization by itself (C3-01). */
  readonly source: "host" | "bridge" | "worker" | "manual";
  readonly id: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
}

export interface AcExemption {
  readonly ac_id: string;
  readonly authorized_by: string;
  readonly reason: string;
  readonly granted_at: string;
}

export interface ProjectTask {
  readonly task_id: string;
  readonly project_id: string;
  readonly goal: string;
  readonly acceptance_criteria: AcceptanceCriterion[];
  readonly constraints: { readonly allowed_paths: string[]; readonly forbidden_paths: string[]; readonly notes?: string };
  readonly workspace: string;
  readonly definition_version: number;
  readonly dependencies: string[];
  readonly epic_id: string | null;
  readonly assignee: string | null;
  readonly expected_delivery: string | null;
  readonly status: ProjectTaskStatus;
  readonly blocked_reason: string | null;
  readonly open_decisions: string[];
  readonly ac_exemptions: AcExemption[];
  readonly run_ids: string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProjectRecord {
  readonly project_id: string;
  readonly title: string;
  readonly workspace: string;
  readonly schema_version: typeof LEDGER_SCHEMA_VERSION;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RunRecord {
  readonly run_id: string;
  readonly task_id: string;
  readonly definition_version: number;
  readonly executor: { readonly kind: "zcode-bridge" | "manual" };
  /** Bridge task_id (executor namespace) or a manual-work description ref. */
  readonly executor_ref: string | null;
  readonly attempt: number | null;
  readonly status: "intent" | "dispatch_unknown" | "accepted" | "queued" | "started" | "finished" | "failed" | "cancelled";
  readonly model: { provider_id: string | null; model_id: string | null; requested_model: string | null; effective_reasoning_level: string | null; source: string | null } | null;
  readonly usage: Record<string, unknown> | null;
  readonly timing: Record<string, unknown> | null;
  readonly report_ref: { readonly summary: string; readonly files_changed: string[]; readonly tests: Array<{ command: string; status: string }> } | null;
  readonly manual_evidence: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ReviewRecord {
  readonly review_id: string;
  readonly task_id: string;
  readonly run_id: string | null;
  /** Task definition_version this review binds to; later definition changes
   * invalidate the approval (C3-03). */
  readonly ac_version: number;
  readonly results: Array<{ readonly ac_id: string; readonly verdict: "pass" | "fail" | "not_verified"; readonly evidence: string }>;
  readonly deliverable_fingerprints: Array<{ readonly path: string; readonly sha256: string }>;
  readonly reviewer: LedgerActor;
  readonly verdict: "approved" | "rejected";
  readonly reason: string | null;
  readonly created_at: string;
}

export type LedgerEventKind =
  | "project.created"
  | "project.updated"
  | "task.created"
  | "task.updated"
  | "task.transitioned"
  | "task.reopened"
  | "ac.exempted"
  | "run.started"
  | "run.updated"
  | "review.recorded";

export interface LedgerEvent {
  readonly event_id: string;
  readonly revision: number;
  readonly operation_id: string;
  readonly ts: string;
  readonly actor: LedgerActor;
  readonly kind: LedgerEventKind;
  readonly payload: Record<string, unknown>;
  /** Persisted hash of the operation's caller input (volatile fields
   * excluded). Journal replays reuse it because the event payload may embed
   * state-derived facts (definition versions, resolved run bindings) that the
   * caller never passed; events without it fall back to hashing the payload. */
  readonly op_hash?: string;
}

export interface LedgerState {
  revision: number;
  projects: Map<string, ProjectRecord>;
  tasks: Map<string, ProjectTask>;
  runs: Map<string, RunRecord>;
  reviews: Map<string, ReviewRecord>;
  /** operation_id → event hash + recorded result for idempotent replay. */
  operations: Map<string, { hash: string; kind: LedgerEventKind; result: Record<string, unknown> }>;
}

export function emptyLedgerState(): LedgerState {
  return { revision: 0, projects: new Map(), tasks: new Map(), runs: new Map(), reviews: new Map(), operations: new Map() };
}

export const TASK_STATUSES: readonly ProjectTaskStatus[] = ["backlog", "ready", "in_progress", "implemented", "review", "done", "blocked", "cancelled"];

export class LedgerError extends Error {
  readonly code: "LEDGER_CORRUPT" | "LEDGER_CONFLICT" | "LEDGER_INVALID" | "LEDGER_NOT_FOUND" | "LEDGER_STATE" | "LEDGER_FORBIDDEN";
  constructor(code: LedgerError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** The single state-transition function: applies one event to the state.
 * Pure — used both for live writes and journal replay/rebuild. */
export function applyLedgerEvent(state: LedgerState, event: LedgerEvent): void {
  const payload = event.payload;
  switch (event.kind) {
    case "project.created": {
      state.projects.set(payload.project_id as string, payload as unknown as ProjectRecord);
      break;
    }
    case "project.updated": {
      const current = state.projects.get(payload.project_id as string);
      if (current) state.projects.set(current.project_id, { ...current, ...(payload as Record<string, unknown>), project_id: current.project_id } as ProjectRecord);
      break;
    }
    case "task.created": {
      state.tasks.set(payload.task_id as string, payload as unknown as ProjectTask);
      break;
    }
    case "task.updated": {
      const current = state.tasks.get(payload.task_id as string);
      if (current) {
        state.tasks.set(current.task_id, {
          ...current,
          ...(payload as Record<string, unknown>),
          task_id: current.task_id,
          project_id: current.project_id,
          created_at: current.created_at,
        } as ProjectTask);
      }
      break;
    }
    case "task.transitioned":
    case "task.reopened": {
      const current = state.tasks.get(payload.task_id as string);
      if (current) {
        state.tasks.set(current.task_id, {
          ...current,
          status: payload.status as ProjectTaskStatus,
          blocked_reason: (payload.blocked_reason as string | null) ?? null,
          updated_at: event.ts,
        });
      }
      break;
    }
    case "ac.exempted": {
      const current = state.tasks.get(payload.task_id as string);
      if (current) {
        const exemption = payload.exemption as AcExemption;
        state.tasks.set(current.task_id, {
          ...current,
          ac_exemptions: [...current.ac_exemptions.filter((item) => item.ac_id !== exemption.ac_id), exemption],
          updated_at: event.ts,
        });
      }
      break;
    }
    case "run.started": {
      state.runs.set(payload.run_id as string, payload as unknown as RunRecord);
      const task = state.tasks.get(payload.task_id as string);
      if (task && !task.run_ids.includes(payload.run_id as string)) {
        state.tasks.set(task.task_id, { ...task, run_ids: [...task.run_ids, payload.run_id as string], updated_at: event.ts });
      }
      break;
    }
    case "run.updated": {
      const current = state.runs.get(payload.run_id as string);
      if (current) state.runs.set(current.run_id, { ...current, ...(payload as Record<string, unknown>), run_id: current.run_id, task_id: current.task_id, created_at: current.created_at } as RunRecord);
      break;
    }
    case "review.recorded": {
      state.reviews.set(payload.review_id as string, payload as unknown as ReviewRecord);
      const task = state.tasks.get(payload.task_id as string);
      if (task && payload.status === "review") {
        state.tasks.set(task.task_id, { ...task, status: "review", updated_at: event.ts });
      }
      break;
    }
  }
  state.revision = event.revision;
}

/** Deterministic hash of the operation input for idempotency checks. */
export function operationHash(kind: LedgerEventKind, payload: Record<string, unknown>): string {
  return stableJson({ kind, payload });
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function newLedgerId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
