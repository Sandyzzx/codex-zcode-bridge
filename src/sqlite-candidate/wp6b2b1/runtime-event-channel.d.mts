import type { Writable } from "node:stream";

export interface CandidateRuntimeTaskEventProtocol {
  readonly worker_sequence: number;
  readonly event_type: "session_ready" | "model_selected" | "turn_started" | "model_tool_call"
    | "tool_status" | "model_output" | "turn_completed" | "turn_failed" | "report_ready";
  readonly at: string;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CandidateRuntimeEventChannel {
  readonly binding: Readonly<{
    operation_id: string;
    task_id: string;
    attempt: number;
    generation: number;
    claim_id: string;
    worker_identity_digest: string;
    process_id: number;
    start_fingerprint: string;
  }>;
  receiveEvent(): Promise<Readonly<{
    binding: CandidateRuntimeEventChannel["binding"];
    event: CandidateRuntimeTaskEventProtocol;
  }>>;
}

export function createCandidateRuntimeEventChannel(
  child: object,
  operation: Readonly<Record<string, unknown>>,
  verifyProcessIdentity: (context: unknown) => Promise<unknown>,
): Promise<CandidateRuntimeEventChannel>;

export function isCandidateRuntimeEventChannel(value: unknown): value is CandidateRuntimeEventChannel;

export function createCandidateWorkerRuntimeEventChannel(options: {
  readonly writeStream: Writable;
  readonly now?: () => string;
}): Promise<Readonly<{
  send(event: {
    readonly type: CandidateRuntimeTaskEventProtocol["event_type"];
    readonly summary: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }): number;
  close(): Promise<void>;
}>>;
