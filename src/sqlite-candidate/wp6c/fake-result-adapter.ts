import type { AdmissionPolicySnapshot } from "../wp6b2b1/launch-bootstrap.js";

export type CandidateResultStatus = "completed" | "failed" | "cancelled" | "waiting_for_master";

export interface CandidateTaskResult {
  readonly task_id: string;
  readonly attempt: number;
  readonly status: CandidateResultStatus;
  readonly summary: string;
  readonly files_changed: readonly string[];
  readonly tests: readonly Readonly<{ command: string; status: "passed" | "failed" | "not_run"; details?: string }>[];
  readonly issues: readonly string[];
  readonly needs_master_decision: boolean;
  readonly zcode_output: string;
  readonly exit_code: number | null;
  readonly session_id: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly error_code?: string;
  readonly report_candidate?: Readonly<Record<string, unknown>>;
  readonly usage?: Readonly<Record<string, unknown>> | null;
  readonly model?: Readonly<Record<string, unknown>> | null;
  readonly timing?: Readonly<Record<string, unknown>> | null;
}

export type CandidateExecutionCleanupProof =
  | {
      readonly contract: "candidate-execution-cleanup-proof-v1";
      readonly source: "zcode_app_server_adapter";
      readonly method: "identity_bound_windows_tree_cleanup";
      readonly complete: true;
      readonly workspace_retained: true;
      readonly adapter_process_id: number;
      readonly adapter_start_fingerprint: string;
      readonly process_tree_receipt_digest: string;
      readonly process_tree_member_count: number;
      readonly managed_browser_cleanup_verified: true;
    }
  | {
      readonly contract: "candidate-execution-cleanup-proof-v1";
      readonly source: "explicit_test_fake";
      readonly method: "synthetic_fixture";
      readonly complete: true;
      readonly workspace_retained: true;
      readonly managed_browser_cleanup_verified: true;
    };

export interface CandidateWorkerResultFrame {
  readonly protocol: "bridge-sqlite-candidate-result-v1";
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly workspace_ref: string;
  readonly policy_snapshot_digest: string;
  /** Adapter-owned cleanup confirmation; the Manager still verifies its own process tree. */
  readonly execution_cleanup_verified: boolean;
  /** Evidence-bearing adapter cleanup result; null keeps Cleanup fail closed. */
  readonly execution_cleanup: CandidateExecutionCleanupProof | null;
  readonly result: CandidateTaskResult;
}

/** Deterministic, local-only adapter used by the isolated WP6C claim path. */
export function executeFakeResultAdapter(snapshot: AdmissionPolicySnapshot): CandidateWorkerResultFrame {
  const result: CandidateTaskResult = {
    task_id: snapshot.task_id,
    attempt: snapshot.attempt,
    status: "completed",
    summary: "Synthetic WP6C FakeAdapter result",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "synthetic adapter output",
    exit_code: 0,
    session_id: null,
    started_at: "2026-10-24T00:00:00.000Z",
    finished_at: "2026-10-24T00:00:01.000Z",
  };
  return {
    protocol: "bridge-sqlite-candidate-result-v1",
    operation_id: snapshot.operation_id,
    task_id: snapshot.task_id,
    attempt: snapshot.attempt,
    generation: snapshot.generation,
    workspace_ref: snapshot.workspace_ref,
    policy_snapshot_digest: snapshot.policy_snapshot_digest,
    execution_cleanup_verified: true,
    execution_cleanup: {
      contract: "candidate-execution-cleanup-proof-v1",
      source: "explicit_test_fake",
      method: "synthetic_fixture",
      complete: true,
      workspace_retained: true,
      managed_browser_cleanup_verified: true,
    },
    result,
  };
}
