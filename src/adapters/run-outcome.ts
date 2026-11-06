import type { AgentReport, AgentRunOutcome } from "../interfaces.js";

export type AdapterErrorCode =
  | "spawn_failed"
  | "timeout"
  | "cancelled"
  | "invalid_json"
  | "invalid_agent_report"
  | "zcode_nonzero_exit"
  | "unknown_turn_terminal";

/**
 * Frozen AgentRunOutcome fields plus adapter-normalization evidence. A
 * non-null reportError or errorCode means the run must be treated as failed
 * for review even when exitCode is 0 (docs/INTERFACES.md: never mark a run
 * successful on invalid JSON or an invalid report).
 */
export interface ZCodeRunOutcome extends AgentRunOutcome {
  readonly agentReport: AgentReport | null;
  readonly reportCandidate: Partial<AgentReport> | null;
  readonly reportError: string | null;
  readonly errorCode: AdapterErrorCode | null;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly attempts: number;
  /** Process cleanup failed after the turn result was captured. */
  readonly cleanupError?: string | null;
  readonly cleanupVerified?: boolean;
  /** Recorded root/member PIDs when cleanup remains unverified. */
  readonly cleanupMemberPids?: readonly number[];
  /**
   * Identity-bound Windows process-tree termination receipt. Present only
   * when the adapter's direct cleanup transaction proved the full tree gone;
   * a weaker recorded-tree claimant scan never supplies this receipt.
   */
  readonly cleanupTreeReceipt?: import("./windows-process-cleanup.js").WindowsTerminationReceipt;
  /** B2 additive: persisted correlation timestamps (RPC accept / turn start / turn end). */
  readonly phaseTimestamps?: {
    readonly rpc_accepted_at?: string | null;
    readonly turn_started_at?: string | null;
    readonly turn_completed_at?: string | null;
  } | null;
  /** B4 additive: runtime-confirmed model and reasoning-depth evidence. */
  readonly modelProfile?: import("../interfaces.js").ExecutionProfile | null;
}

