/** Isolated observer for Codex App Server thread token usage notifications. */

export const TOKEN_USAGE_NOTIFICATION = "thread/tokenUsage/updated" as const;

export type TokenUsageConfidence = "protocol_notification" | "rollout_restored" | "unknown";
export type TokenUsageSourceKind = typeof TOKEN_USAGE_NOTIFICATION | "rollout/token_count";
export type TokenUsageProtocolState = "unknown" | "supported" | "unsupported";

export interface TokenUsageBreakdown {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface TokenUsageSnapshot {
  threadId: string;
  turnId: string;
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  lastTokens: number | null;
  lastInputTokens: number | null;
  lastCachedInputTokens: number | null;
  lastCacheWriteInputTokens: number | null;
  lastOutputTokens: number | null;
  lastReasoningOutputTokens: number | null;
  modelContextWindow: number | null;
  observedAt: string;
  source: TokenUsageSourceKind;
  confidence: TokenUsageConfidence;
}

export type TokenUsageIngestResult =
  | { state: "accepted"; snapshot: TokenUsageSnapshot }
  | { state: "duplicate"; snapshot: TokenUsageSnapshot }
  | { state: "stale_turn"; snapshot?: TokenUsageSnapshot }
  | { state: "ignored" }
  | { state: "invalid"; reason: string };

export type AccountUsageReadState =
  | "available"
  | "authentication_required"
  | "permission_denied"
  | "unsupported"
  | "failed"
  | "unknown";

export interface AccountUsageReadResult<T> {
  state: AccountUsageReadState;
  value?: T;
  reasonCode?: string;
}

/** Maps only explicit RPC evidence. Unrecognized errors stay failed/unknown. */
export function classifyAccountUsageReadFailure(code: unknown, message: unknown): AccountUsageReadState {
  const normalizedCode = typeof code === "string" || typeof code === "number" ? String(code).toLowerCase() : "";
  const normalizedMessage = typeof message === "string" ? message.toLowerCase() : "";
  if (normalizedCode === "method_not_found" || normalizedCode === "-32601") return "unsupported";
  if (normalizedCode === "unauthorized" || normalizedCode === "authentication_required" ||
      normalizedMessage.includes("not authenticated")) return "authentication_required";
  if (normalizedCode === "forbidden" || normalizedCode === "permission_denied") return "permission_denied";
  if (!normalizedCode && !normalizedMessage) return "unknown";
  return "failed";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integerOrUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function breakdown(value: unknown): TokenUsageBreakdown | null {
  const input = record(value);
  if (!input) return null;
  return {
    totalTokens: integerOrUnknown(input.totalTokens),
    inputTokens: integerOrUnknown(input.inputTokens),
    cachedInputTokens: integerOrUnknown(input.cachedInputTokens),
    cacheWriteInputTokens: integerOrUnknown(input.cacheWriteInputTokens),
    outputTokens: integerOrUnknown(input.outputTokens),
    reasoningOutputTokens: integerOrUnknown(input.reasoningOutputTokens),
  };
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

/** Receives only notifications explicitly delivered by the app-server transport. */
export class TokenUsageSource {
  status: TokenUsageProtocolState = "unknown";

  constructor(private readonly manager: ThreadTokenUsageManager) {}

  receive(method: string, params: unknown, observedAt = new Date().toISOString()): TokenUsageIngestResult {
    if (method !== TOKEN_USAGE_NOTIFICATION) return { state: "ignored" };
    this.status = "supported";
    return this.manager.ingest(params, observedAt, TOKEN_USAGE_NOTIFICATION, "protocol_notification");
  }

  markUnsupported(): void { this.status = "unsupported"; }
}

/** Keeps latest per-thread absolute snapshots. It never sums `last` values. */
export class ThreadTokenUsageManager {
  private readonly latest = new Map<string, TokenUsageSnapshot>();
  private readonly fingerprints = new Map<string, string>();
  private readonly activeTurn = new Map<string, string>();

  markTurnStarted(threadId: string, turnId: string): void {
    if (threadId && turnId) this.activeTurn.set(threadId, turnId);
  }

  ingest(
    payload: unknown,
    observedAt = new Date().toISOString(),
    source: TokenUsageSourceKind = TOKEN_USAGE_NOTIFICATION,
    confidence: TokenUsageConfidence = "protocol_notification",
  ): TokenUsageIngestResult {
    const root = record(payload);
    const usage = record(root?.tokenUsage);
    const total = breakdown(usage?.total);
    const last = breakdown(usage?.last);
    if (typeof root?.threadId !== "string" || root.threadId.length === 0 ||
        typeof root.turnId !== "string" || root.turnId.length === 0 || !usage || !total || !last) {
      return { state: "invalid", reason: "missing_thread_turn_or_usage" };
    }

    const expectedTurn = this.activeTurn.get(root.threadId);
    const previous = this.latest.get(root.threadId);
    if (expectedTurn && root.turnId !== expectedTurn) {
      return previous ? { state: "stale_turn", snapshot: previous } : { state: "stale_turn" };
    }

    const key = `${root.threadId}\0${root.turnId}`;
    const digest = fingerprint({ tokenUsage: usage, turnId: root.turnId });
    if (this.fingerprints.get(key) === digest) {
      return { state: "duplicate", snapshot: previous ?? this.makeSnapshot(root.threadId, root.turnId, total, last, usage, observedAt, source, confidence) };
    }

    const snapshot = this.makeSnapshot(root.threadId, root.turnId, total, last, usage, observedAt, source, confidence);
    this.latest.set(root.threadId, snapshot);
    this.fingerprints.set(key, digest);
    return { state: "accepted", snapshot };
  }

  get(threadId: string): TokenUsageSnapshot | undefined { return this.latest.get(threadId); }

  list(): TokenUsageSnapshot[] { return [...this.latest.values()]; }

  restore(payload: unknown, observedAt: string): TokenUsageIngestResult {
    return this.ingest(payload, observedAt, "rollout/token_count", "rollout_restored");
  }

  private makeSnapshot(
    threadId: string,
    turnId: string,
    total: TokenUsageBreakdown,
    last: TokenUsageBreakdown,
    usage: Record<string, unknown>,
    observedAt: string,
    source: TokenUsageSourceKind,
    confidence: TokenUsageConfidence,
  ): TokenUsageSnapshot {
    return {
      threadId, turnId,
      totalTokens: total.totalTokens,
      inputTokens: total.inputTokens,
      cachedInputTokens: total.cachedInputTokens,
      cacheWriteInputTokens: total.cacheWriteInputTokens,
      outputTokens: total.outputTokens,
      reasoningOutputTokens: total.reasoningOutputTokens,
      lastTokens: last.totalTokens,
      lastInputTokens: last.inputTokens,
      lastCachedInputTokens: last.cachedInputTokens,
      lastCacheWriteInputTokens: last.cacheWriteInputTokens,
      lastOutputTokens: last.outputTokens,
      lastReasoningOutputTokens: last.reasoningOutputTokens,
      modelContextWindow: integerOrUnknown(usage.modelContextWindow),
      observedAt, source, confidence,
    };
  }
}
