import type { TaskAttentionSnapshot } from "../interfaces.js";
import { isAttentionTerminalStatus } from "./snapshot.js";

export type AttentionWakeReason = "interaction" | "terminal" | "attempt_changed" | "timeout";

export interface AttentionWaitResult {
  readonly snapshot: TaskAttentionSnapshot;
  readonly initial_attempt: number;
  readonly reason: AttentionWakeReason;
  readonly elapsed_ms: number;
}

export interface AttentionWaitOptions {
  readonly read: () => Promise<TaskAttentionSnapshot>;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Shared passive wait predicate for MCP and the standalone thin waiter.
 * It has no persistence, dispatch, reply, or notification behavior.
 */
export async function waitForAttentionSnapshot(options: AttentionWaitOptions): Promise<AttentionWaitResult> {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error("timeoutMs must be non-negative");
  if (!Number.isInteger(pollMs) || pollMs < 1) throw new Error("pollMs must be a positive integer");
  const started = now();
  const deadline = started + options.timeoutMs;
  let snapshot = await options.read();
  const initialAttempt = snapshot.attempt;
  for (;;) {
    const reason = classify(snapshot, initialAttempt, now() >= deadline);
    if (reason) {
      return { snapshot, initial_attempt: initialAttempt, reason, elapsed_ms: Math.max(0, now() - started) };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    snapshot = await options.read();
  }
}

function classify(snapshot: TaskAttentionSnapshot, initialAttempt: number, deadlineReached: boolean): AttentionWakeReason | null {
  if (isAttentionTerminalStatus(snapshot.status)) return "terminal";
  if (snapshot.pending_requests.length > 0) return "interaction";
  if (snapshot.attempt !== initialAttempt) return "attempt_changed";
  return deadlineReached ? "timeout" : null;
}
