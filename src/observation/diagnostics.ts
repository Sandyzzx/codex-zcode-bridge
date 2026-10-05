// A3 bounded, correlatable diagnostics. Public projections and diagnostic
// payloads pass through a strict field whitelist: task body text, provider
// credentials, hidden reasoning, and unbounded raw error messages can never
// reach events or tool output. Counters are bounded and deduplicated so
// repeated failures produce count + last-seen instead of event spam (A3-04).
export interface DiagnosticFieldPolicy {
  /** Allowlisted top-level keys; everything else is dropped and counted. */
  readonly allowedKeys: ReadonlySet<string>;
  readonly maxStringChars: number;
  readonly maxEntries: number;
}

export const DIAGNOSTIC_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  // Correlation identifiers (non-sensitive association values).
  "task_id", "project_task_id", "run_id", "attempt", "execution_token", "worker_pid", "runtime_pid",
  "session_id", "turn_id", "request_id", "bridge_event_seq", "runtime_event_seq",
  // Stage/reason/timing evidence.
  "component", "stage", "reason_code", "error_code", "duration_ms", "queue_age_ms",
  "heartbeat_age_ms", "event_age_ms", "probe_verdict", "cleanup_verdict", "observed_at",
  // Bounded operation facts.
  "worker_pid_previous", "operation", "count", "last_seen_at", "scan_bytes", "records_scanned",
  "invalid_lines", "index_fallback", "platform", "cleanup_unverified", "mode", "status",
  "revision", "definition_version", "ac_count", "coverage", "updated_at",
]);

const DEFAULT_MAX_STRING_CHARS = 300;

/** Keeps only allowlisted keys with bounded scalar values. Dropped keys and
 * oversized strings are reported by count, never by content. */
export function sanitizeDiagnostics(
  fields: Record<string, unknown> | undefined,
  policy: Partial<DiagnosticFieldPolicy> = {},
): { fields: Record<string, unknown>; dropped_keys: number; truncated_values: number } {
  const allowedKeys = policy.allowedKeys ?? DIAGNOSTIC_FIELD_WHITELIST;
  const maxStringChars = policy.maxStringChars ?? DEFAULT_MAX_STRING_CHARS;
  const maxEntries = policy.maxEntries ?? 24;
  const result: Record<string, unknown> = {};
  let droppedKeys = 0;
  let truncatedValues = 0;
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (Object.keys(result).length >= maxEntries) { droppedKeys += 1; continue; }
      if (!allowedKeys.has(key)) { droppedKeys += 1; continue; }
      if (typeof value === "string") {
        if (value.length > maxStringChars) { truncatedValues += 1; result[key] = `${value.slice(0, maxStringChars)}…`; }
        else result[key] = value;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        result[key] = value;
      } else if (typeof value === "boolean" || value === null) {
        result[key] = value;
      } else {
        droppedKeys += 1;
      }
    }
  }
  return { fields: result, dropped_keys: droppedKeys, truncated_values: truncatedValues };
}

/** Bounded raw-error projection: control characters stripped, hard length cap.
 * Used where an operator-visible message is required; never for provider
 * payloads or model output. */
export function boundedErrorMessage(message: unknown, maxChars = 500): string {
  const text = message instanceof Error ? message.message : String(message ?? "");
  return text.replace(/[\r\n\0\t]/gu, " ").slice(0, maxChars);
}

interface CounterEntry {
  count: number;
  last_seen_at: string;
  last_reason: string;
}

const MAX_COUNTER_KEYS = 64;
const MAX_LATENCY_SAMPLES = 64;

/** In-memory failure counters with bounded keys. Key stages are also appended
 * to the persistent event log by callers, so counts survive restarts through
 * events while the live window stays bounded (A3-04). */
export class DiagnosticCounters {
  readonly #counters = new Map<string, CounterEntry>();
  readonly #latency: number[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(reason: string, detail = ""): { count: number; last_seen_at: string } {
    const key = `${reason}${detail ? `:${detail}` : ""}`.slice(0, 160);
    let entry = this.#counters.get(key);
    if (!entry) {
      if (this.#counters.size >= MAX_COUNTER_KEYS) {
        // Evict the oldest inserted key; the map keeps insertion order.
        const oldest = this.#counters.keys().next().value;
        if (oldest !== undefined) this.#counters.delete(oldest);
      }
      entry = { count: 0, last_seen_at: new Date(this.#now()).toISOString(), last_reason: reason };
      this.#counters.set(key, entry);
    }
    entry.count += 1;
    entry.last_seen_at = new Date(this.#now()).toISOString();
    entry.last_reason = reason;
    return { count: entry.count, last_seen_at: entry.last_seen_at };
  }

  /** Throttle decision: emit a persistent event on the first occurrence and
   * then every `every`th occurrence, always carrying the cumulative count. */
  shouldEmit(reason: string, detail = "", every = 10): boolean {
    const key = `${reason}${detail ? `:${detail}` : ""}`.slice(0, 160);
    const entry = this.#counters.get(key);
    if (!entry) return true;
    return entry.count === 1 || entry.count % every === 0;
  }

  recordLatency(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.#latency.push(ms);
    if (this.#latency.length > MAX_LATENCY_SAMPLES) this.#latency.shift();
  }

  latencySummary(): { samples: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null } {
    if (this.#latency.length === 0) return { samples: 0, p50_ms: null, p95_ms: null, max_ms: null };
    const sorted = [...this.#latency].sort((a, b) => a - b);
    const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
    return { samples: sorted.length, p50_ms: percentile(50), p95_ms: percentile(95), max_ms: sorted[sorted.length - 1]! };
  }

  snapshot(): Record<string, { count: number; last_seen_at: string; reason: string }> {
    const result: Record<string, { count: number; last_seen_at: string; reason: string }> = {};
    for (const [key, entry] of this.#counters) {
      result[key] = { count: entry.count, last_seen_at: entry.last_seen_at, reason: entry.last_reason };
    }
    return result;
  }
}
