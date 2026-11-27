// B4 usage normalization: a strict numeric whitelist over runtime-reported
// statistics. Missing values are null (not_reported); a real zero survives;
// NaN/Infinity/negative/non-number/unsafe-integer values are rejected with a
// conflict marker instead of being coerced. Reported totals are preserved as
// reported — never silently recomputed — and conflicts stay visible.
import type { NormalizedUsage } from "../interfaces.js";

const KNOWN_NUMERIC_FIELDS = [
  ["input_tokens", "inputTokens"],
  ["output_tokens", "outputTokens"],
  ["total_tokens", "totalTokens"],
  ["cached_input_tokens", "cachedInputTokens", "cacheReadTokens", "cache_read_tokens"],
  ["cached_write_input_tokens", "cachedWriteInputTokens", "cacheWriteInputTokens", "cacheWriteTokens", "cache_write_tokens"],
  ["reasoning_tokens", "reasoningTokens"],
] as const;

const SOURCE_FIELDS = ["source", "usage_source"] as const;
const SAFE_USAGE_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;

function isKnownNumericKey(key: string): boolean {
  return KNOWN_NUMERIC_FIELDS.some(([canonical, ...aliases]) => (
    key === canonical || aliases.some((candidate) => candidate === key)
  ));
}

export interface NormalizeUsageOptions {
  /** e.g. "zcode_turn" — where the numbers were read from. */
  source?: string | null;
  /** e.g. "turn:<id>" — what the numbers describe. */
  scope?: string | null;
  observedAt?: string | null;
}

function acceptNumber(value: unknown): { value: number | null; conflict: string | null } {
  if (value === undefined || value === null) return { value: null, conflict: null };
  if (typeof value !== "number") return { value: null, conflict: "non_numeric_rejected" };
  if (Number.isNaN(value)) return { value: null, conflict: "nan_rejected" };
  if (!Number.isFinite(value)) return { value: null, conflict: "non_finite_rejected" };
  if (!Number.isSafeInteger(value)) return { value: null, conflict: "unsafe_integer_rejected" };
  if (value < 0) return { value: null, conflict: "negative_rejected" };
  return { value, conflict: null };
}

/**
 * Normalizes one runtime usage payload. camelCase/snake_case synonyms collapse
 * to the canonical snake_case field; when both spellings exist with different
 * values the conflict is recorded (snake_case wins) rather than silently
 * summed or averaged. Unknown keys are dropped but counted. Reported total is
 * kept as reported; if input+output disagree with it a total_mismatch marker
 * is added — the value itself is never rewritten to a self-computed number.
 */
export function normalizeUsage(raw: unknown, options: NormalizeUsageOptions = {}): NormalizedUsage | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const conflicts = new Set<string>();
  const result: NormalizedUsage = {
    source: null,
    scope: null,
    observed_at: null,
    finality: "reported",
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cached_input_tokens: null,
    cached_write_input_tokens: null,
    reasoning_tokens: null,
    conflicts: [],
    dropped_unknown_keys: 0,
  };

  let knownKeys = 0;
  for (const [canonical, ...aliases] of KNOWN_NUMERIC_FIELDS) {
    const present = [canonical, ...aliases]
      .filter((key) => record[key] !== undefined)
      .map((key) => record[key]);
    if (present.length === 0) continue;
    knownKeys += 1;
    if (present.some((value) => value !== present[0])) conflicts.add("duplicate_synonyms");
    const accepted = acceptNumber(present[0]);
    if (accepted.conflict) {
      conflicts.add(accepted.conflict);
      continue;
    }
    (result as unknown as Record<string, number | null>)[canonical] = accepted.value;
  }

  for (const key of Object.keys(record)) {
    const known = isKnownNumericKey(key);
    const metadata = SOURCE_FIELDS.some((candidate) => key === candidate)
      || key === "scope" || key === "observed_at" || key === "finality" || key === "conflicts";
    if (!known && !metadata) result.dropped_unknown_keys += 1;
  }

  for (const sourceField of SOURCE_FIELDS) {
    const value = record[sourceField];
    if (typeof value === "string" && value.trim()) {
      result.source = options.source ?? value.trim();
      break;
    }
  }
  if (result.source === null) result.source = options.source ?? null;
  result.scope = options.scope
    ?? (typeof record.scope === "string" && SAFE_USAGE_TOKEN.test(record.scope) ? record.scope : null);
  result.observed_at = options.observedAt
    ?? (typeof record.observed_at === "string" && !Number.isNaN(Date.parse(record.observed_at)) ? record.observed_at : null);
  if (record.finality === "reported" || record.finality === "derived" || record.finality === "partial") {
    result.finality = record.finality;
  }
  if (Array.isArray(record.conflicts)) {
    for (const conflict of record.conflicts) {
      if (typeof conflict === "string" && SAFE_USAGE_TOKEN.test(conflict)) conflicts.add(conflict);
    }
  }

  // Reported total preserved; consistency is reported, never repaired.
  const { input_tokens: input, output_tokens: output, total_tokens: total } = result;
  if (total !== null && input !== null && output !== null && total !== input + output) {
    conflicts.add("total_mismatch");
  }
  // Session-derived aggregations must be labelled; direct reports stay "reported".
  if (options.source?.includes("session_delta")) result.finality = "derived";
  if (conflicts.size > 0) result.finality = result.finality === "derived" ? "derived" : "partial";

  result.conflicts = [...conflicts];
  if (knownKeys === 0 && result.dropped_unknown_keys === 0) return null;
  return result;
}

/** Adds two normalized usages that are known not to overlap. Missing inputs
 * propagate null (partial), never a fabricated zero (B4-03/B4 totals rule). */
export function addNonOverlappingUsage(a: NormalizedUsage | null, b: NormalizedUsage | null, source: string): NormalizedUsage | null {
  if (!a && !b) return null;
  const conflicts = new Set<string>([...(a?.conflicts ?? []), ...(b?.conflicts ?? [])]);
  const add = (x: number | null, y: number | null): number | null => (x === null || y === null ? null : x + y);
  return {
    source,
    scope: null,
    observed_at: null,
    finality: a?.finality === "derived" || b?.finality === "derived" ? "derived" : "partial",
    input_tokens: add(a?.input_tokens ?? null, b?.input_tokens ?? null),
    output_tokens: add(a?.output_tokens ?? null, b?.output_tokens ?? null),
    total_tokens: add(a?.total_tokens ?? null, b?.total_tokens ?? null),
    cached_input_tokens: add(a?.cached_input_tokens ?? null, b?.cached_input_tokens ?? null),
    cached_write_input_tokens: add(a?.cached_write_input_tokens ?? null, b?.cached_write_input_tokens ?? null),
    reasoning_tokens: add(a?.reasoning_tokens ?? null, b?.reasoning_tokens ?? null),
    conflicts: [...conflicts],
    dropped_unknown_keys: (a?.dropped_unknown_keys ?? 0) + (b?.dropped_unknown_keys ?? 0),
  };
}

/** B4 timing helpers: bounded, non-negative phase durations. A missing or
 * regressed clock yields null with a note — never a negative or fake zero. */
export function phaseDuration(startIso: string | null, endIso: string | null, notes: string[]): number | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    notes.push("unparsable_timestamp");
    return null;
  }
  if (end < start) {
    notes.push("clock_regression_dropped");
    return null;
  }
  return end - start;
}
