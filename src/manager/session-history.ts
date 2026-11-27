// ADR-066: a Task continuation is not a Session resume. Before a continued
// Attempt is dispatched, the Manager decides from the committed Results of the
// same Task whether `previous_result.session_id` is a resumable handle. Pure
// function: the caller supplies the committed Result reader and owns SQLite.
import type { CandidateTaskResult } from "../sqlite-candidate/wp6c/fake-result-adapter.js";
import { SESSION_NOT_RESUMABLE } from "../runtime/errors.js";

/** Upper bound on earlier Attempts examined; the scan also stops at a different Session. */
export const SESSION_HISTORY_SCAN_LIMIT = 32;

export type SessionHistoryReason = "turn_history" | "no_turn_history" | typeof SESSION_NOT_RESUMABLE;

export interface SessionHistory {
  readonly session_id: string;
  readonly resumable: boolean;
  readonly reason: SessionHistoryReason;
  /** Attempt whose Result supplied the decisive evidence; null for `no_turn_history`. */
  readonly evidence_attempt: number | null;
  readonly scanned_attempts: number;
}

export interface SessionHistoryInput {
  /** The Attempt about to be dispatched. */
  readonly attempt: number;
  readonly previousResult: CandidateTaskResult | null;
  /** Committed Result of one earlier Attempt; null when it has none. */
  readonly readResult: (attempt: number) => CandidateTaskResult | null;
}

/** The fields the Worker envelope uses to bind one Manager verdict. */
export interface SessionHistoryEnvelopeContext {
  readonly attempt: number;
  readonly continuation: unknown;
  readonly previousResultSessionId: string | null;
}

/**
 * `null` when the previous Result carries no Session ID, so nothing can be
 * resumed. Otherwise the same Session is scanned from the newest Result:
 *
 * - its newest Result is `session_not_resumable`, or no Result of it shows a
 *   turn: the ID stays evidence only and the new Attempt creates a Session;
 * - any Result of it shows a turn: the ID is resumed.
 *
 * A Result without a Session ID (an infrastructure failure before any Session
 * existed) is not evidence either way and is skipped.
 */
export function resolveSessionHistory(input: SessionHistoryInput): SessionHistory | null {
  const sessionId = sessionHandle(input.previousResult);
  if (sessionId === null) return null;
  let scannedAttempts = 0;
  // Attempts are 1-based; attempt 0 is never a committed Result.
  for (let attempt = input.attempt - 1; attempt >= 1 && scannedAttempts < SESSION_HISTORY_SCAN_LIMIT; attempt -= 1) {
    let result: CandidateTaskResult | null;
    try {
      result = input.readResult(attempt);
    } catch {
      result = null;
    }
    scannedAttempts += 1;
    if (!result) continue;
    const resultSessionId = sessionHandle(result);
    if (resultSessionId === null) continue;
    // An older Attempt ran a different Session; it says nothing about this one.
    if (resultSessionId !== sessionId) break;
    if (result.error_code === SESSION_NOT_RESUMABLE) {
      return { session_id: sessionId, resumable: false, reason: SESSION_NOT_RESUMABLE, evidence_attempt: attempt, scanned_attempts: scannedAttempts };
    }
    if (hasTurnHistory(result)) {
      return { session_id: sessionId, resumable: true, reason: "turn_history", evidence_attempt: attempt, scanned_attempts: scannedAttempts };
    }
  }
  return { session_id: sessionId, resumable: false, reason: "no_turn_history", evidence_attempt: null, scanned_attempts: scannedAttempts };
}

/**
 * The Session a continuation should resume. With a Manager verdict only a
 * resumable Session is used; without one (an older Manager) the previous
 * Result's ID is kept for compatibility.
 */
export function continuationSessionId(
  history: SessionHistory | undefined,
  previousResultSessionId: string | null,
): string | null {
  if (!history) return previousResultSessionId;
  return history.resumable ? history.session_id : null;
}

/**
 * Validate the optional `session_history` envelope key and return it as the
 * bounded verdict the Manager produced. Every field is cross-checked against
 * the envelope itself so a Worker never acts on an unbound claim.
 */
export function validateSessionHistoryEnvelope(
  value: unknown,
  context: SessionHistoryEnvelopeContext,
): SessionHistory {
  const history = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const sessionId = history?.session_id;
  const resumable = history?.resumable;
  const reason = history?.reason;
  const evidenceAttempt = history?.evidence_attempt;
  const scannedAttempts = history?.scanned_attempts;
  const isEvidenceAttempt = typeof evidenceAttempt === "number" && Number.isSafeInteger(evidenceAttempt)
    && evidenceAttempt >= 1 && evidenceAttempt < context.attempt;
  const bound = history !== null
    && Object.keys(history).sort().join("|") === "evidence_attempt|reason|resumable|scanned_attempts|session_id"
    && context.continuation !== null
    && typeof sessionId === "string" && sessionId !== ""
    && context.previousResultSessionId === sessionId
    && typeof resumable === "boolean"
    && (resumable
      ? reason === "turn_history" && isEvidenceAttempt
      : (reason === "no_turn_history" && evidenceAttempt === null)
        || (reason === "session_not_resumable" && isEvidenceAttempt))
    && typeof scannedAttempts === "number" && Number.isSafeInteger(scannedAttempts)
    && scannedAttempts >= 1 && scannedAttempts <= SESSION_HISTORY_SCAN_LIMIT;
  if (!bound) throw new Error("post-Claim session history binding rejected");
  return {
    session_id: sessionId as string,
    resumable: resumable as boolean,
    reason: reason as SessionHistoryReason,
    evidence_attempt: evidenceAttempt as number | null,
    scanned_attempts: scannedAttempts as number,
  };
}

function sessionHandle(result: CandidateTaskResult | null): string | null {
  return typeof result?.session_id === "string" && result.session_id ? result.session_id : null;
}

/** A real turn ran, or the report of one was delivered, in this Session. */
function hasTurnHistory(result: CandidateTaskResult): boolean {
  if (result.status === "completed" || result.status === "waiting_for_master") return true;
  const turnId = asRecord(result.model)?.turn_id;
  if (typeof turnId === "string" && turnId) return true;
  const usage = asRecord(result.usage);
  return usage !== null
    && ["input_tokens", "output_tokens", "total_tokens"].some((key) => typeof usage[key] === "number");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
