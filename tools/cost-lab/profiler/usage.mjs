import {
  ACCOUNTING_MODES,
  ADDITIVE_USAGE_FIELDS,
  RECONCILIATION_STATUSES,
  USAGE_FIELDS,
} from "./constants.mjs";
import {
  isRecord,
  normalizeTimestamp,
  safeRatio,
  nonNegativeSafeInteger,
  uniqueBy,
} from "./util.mjs";

const FIELD_ALIASES = Object.freeze({
  input_tokens: ["input_tokens", "inputTokens"],
  cached_input_tokens: [
    "cached_input_tokens",
    "cachedInputTokens",
    "cacheReadTokens",
    "cache_read_tokens",
  ],
  uncached_input_tokens: ["uncached_input_tokens", "uncachedInputTokens"],
  cache_write_input_tokens: [
    "cache_write_input_tokens",
    "cached_write_input_tokens",
    "cachedWriteInputTokens",
    "cacheWriteInputTokens",
    "cacheWriteTokens",
    "cache_write_tokens",
  ],
  output_tokens: ["output_tokens", "outputTokens"],
  reasoning_tokens: [
    "reasoning_tokens",
    "reasoningTokens",
    "reasoning_output_tokens",
  ],
  total_tokens: ["total_tokens", "totalTokens"],
});

const METADATA_KEYS = new Set([
  "source",
  "usage_source",
  "scope",
  "observed_at",
  "finality",
  "conflicts",
  "model",
  "provider",
  "provider_id",
  "model_id",
  "reasoning_effort",
]);

const KNOWN_KEYS = new Set(
  Object.values(FIELD_ALIASES).flat().concat([...METADATA_KEYS]),
);

export function emptyUsage() {
  return {
    currency: "tokens",
    model: null,
    provider: null,
    reasoning_effort: null,
    input_tokens: null,
    cached_input_tokens: null,
    uncached_input_tokens: null,
    cache_write_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    cache_hit_rate: null,
    total_source: "UNKNOWN",
    missing_fields: [...USAGE_FIELDS],
    observed_fields: [],
    conflicts: [],
    dropped_unknown_keys: 0,
    evidence_level: "UNKNOWN",
  };
}

function acceptNumber(value) {
  if (value === undefined || value === null) return { value: null, conflict: null };
  if (typeof value !== "number") return { value: null, conflict: "non_numeric_rejected" };
  if (Number.isNaN(value)) return { value: null, conflict: "nan_rejected" };
  if (!Number.isFinite(value)) return { value: null, conflict: "non_finite_rejected" };
  if (!Number.isSafeInteger(value)) return { value: null, conflict: "unsafe_integer_rejected" };
  if (value < 0) return { value: null, conflict: "negative_rejected" };
  return { value, conflict: null };
}

function firstAliasValue(record, aliases) {
  for (const key of aliases) {
    if (record[key] !== undefined) return { key, value: record[key] };
  }
  return { key: null, value: undefined };
}

export function normalizeUsage(raw, options = {}) {
  const result = emptyUsage();
  result.model = typeof options.model === "string" ? options.model : null;
  result.provider = typeof options.provider === "string" ? options.provider : null;
  result.reasoning_effort = typeof options.reasoningEffort === "string"
    ? options.reasoningEffort
    : null;
  if (!isRecord(raw)) return result;

  const conflicts = new Set();
  const observed = [];
  for (const field of USAGE_FIELDS) {
    if (field === "uncached_input_tokens") continue;
    const aliases = FIELD_ALIASES[field];
    const selected = firstAliasValue(raw, aliases);
    if (selected.key === null) continue;
    for (const alias of aliases) {
      if (raw[alias] !== undefined && raw[alias] !== selected.value) {
        conflicts.add("duplicate_synonyms");
      }
    }
    const accepted = acceptNumber(selected.value);
    if (accepted.conflict) {
      conflicts.add(accepted.conflict);
      continue;
    }
    result[field] = accepted.value;
    if (accepted.value !== null) observed.push(field);
  }

  if (result.input_tokens !== null && result.cached_input_tokens !== null) {
    if (result.cached_input_tokens > result.input_tokens) {
      conflicts.add("cached_input_exceeds_input");
    } else {
      result.uncached_input_tokens = result.input_tokens - result.cached_input_tokens;
      observed.push("uncached_input_tokens");
    }
  }

  if (result.total_tokens !== null) {
    result.total_source = "REPORTED";
  } else if (result.input_tokens !== null && result.output_tokens !== null) {
    result.total_tokens = result.input_tokens + result.output_tokens;
    result.total_source = "DERIVED_INPUT_PLUS_OUTPUT";
    observed.push("total_tokens");
  }
  if (
    result.total_tokens !== null
    && result.input_tokens !== null
    && result.output_tokens !== null
    && result.total_tokens !== result.input_tokens + result.output_tokens
  ) {
    conflicts.add("total_mismatch");
  }
  if (result.cached_input_tokens !== null && result.input_tokens !== null) {
    result.cache_hit_rate = safeRatio(result.cached_input_tokens, result.input_tokens);
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) result.dropped_unknown_keys += 1;
  }

  result.missing_fields = USAGE_FIELDS.filter((field) => result[field] === null);
  result.observed_fields = uniqueBy(observed, (field) => field);
  result.conflicts = [...conflicts].sort();
  result.evidence_level = result.observed_fields.length > 0 ? "OBSERVED" : "UNKNOWN";
  return result;
}

export function usageIsUnknown(usage) {
  return !usage || USAGE_FIELDS.every((field) => usage[field] === null);
}

export function sumUsagesStrict(usages, options = {}) {
  const valid = usages.filter((usage) => usage && !usageIsUnknown(usage));
  const result = emptyUsage();
  result.model = options.model ?? null;
  result.provider = options.provider ?? null;
  result.reasoning_effort = options.reasoningEffort ?? null;
  const conflicts = new Set();
  for (const field of ADDITIVE_USAGE_FIELDS) {
    if (valid.length === 0) {
      result[field] = null;
      continue;
    }
    if (valid.some((usage) => usage[field] === null || usage[field] === undefined)) {
      result[field] = null;
      conflicts.add(`partial_${field}`);
      continue;
    }
    result[field] = valid.reduce((sum, usage) => sum + usage[field], 0);
  }

  if (result.input_tokens !== null && result.cached_input_tokens !== null) {
    result.uncached_input_tokens = result.input_tokens - result.cached_input_tokens;
  }
  if (result.cached_input_tokens !== null && result.input_tokens !== null) {
    result.cache_hit_rate = safeRatio(result.cached_input_tokens, result.input_tokens);
  }
  if (result.total_tokens !== null) result.total_source = "SUMMED_RESPONSES";
  result.missing_fields = USAGE_FIELDS.filter((field) => result[field] === null);
  result.observed_fields = USAGE_FIELDS.filter((field) => result[field] !== null);
  for (const usage of valid) {
    for (const conflict of usage.conflicts ?? []) conflicts.add(conflict);
  }
  result.conflicts = [...conflicts].sort();
  result.evidence_level = valid.length > 0 && result.observed_fields.length > 0
    ? "OBSERVED"
    : "UNKNOWN";
  result._observed_usage_count = valid.length;
  return result;
}

function compareUsageFields(left, right) {
  const fields = {};
  let mismatched = 0;
  let comparable = 0;
  for (const field of ADDITIVE_USAGE_FIELDS) {
    const a = left?.[field] ?? null;
    const b = right?.[field] ?? null;
    const status = a === null && b === null
      ? "NOT_REPORTED"
      : a === null || b === null
        ? "UNKNOWN"
      : a === b
        ? "MATCH"
        : "MISMATCH";
    fields[field] = { status, response_level: a, cumulative: b };
    if (status === "MISMATCH") mismatched += 1;
    if (status === "MATCH" || status === "MISMATCH") comparable += 1;
  }
  return {
    status: comparable === 0
      ? "UNKNOWN"
      : mismatched > 0
        ? "MISMATCH"
        : Object.values(fields).some((field) => field.status === "UNKNOWN")
          ? "PARTIAL"
          : "RECONCILED",
    fields,
  };
}

function latestCumulative(cumulativeUsages) {
  return [...cumulativeUsages]
    .filter((entry) => entry?.usage && !usageIsUnknown(entry.usage))
    .sort((left, right) => {
      const leftTime = Date.parse(left.observed_at ?? "") || 0;
      const rightTime = Date.parse(right.observed_at ?? "") || 0;
      const leftOrdinal = eventRefOrdinal(left.event_ref);
      const rightOrdinal = eventRefOrdinal(right.event_ref);
      return leftTime - rightTime
        || (leftOrdinal !== null && rightOrdinal !== null ? leftOrdinal - rightOrdinal : 0)
        || (left.event_ref ?? "").localeCompare(right.event_ref ?? "");
    })
    .at(-1) ?? null;
}

function eventRefOrdinal(eventRef) {
  const match = /(?:^|:)(\d+)$/u.exec(String(eventRef ?? ""));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export function createAggregateUsage({
  responseUsages = [],
  cumulativeUsages = [],
  unknownUsageResponseCount = 0,
  model = null,
  provider = null,
  reasoningEffort = null,
  source = "local_observation",
} = {}) {
  const knownResponses = responseUsages.filter((usage) => !usageIsUnknown(usage));
  const unknownInArray = responseUsages.filter((usage) => usageIsUnknown(usage)).length;
  const effectiveUnknownResponseCount = Math.max(unknownUsageResponseCount, unknownInArray);
  const responseSum = sumUsagesStrict(knownResponses, { model, provider, reasoningEffort });
  const cumulative = latestCumulative(cumulativeUsages);
  const reconciliation = cumulative
    ? compareUsageFields(responseSum, cumulative.usage)
    : {
        status: "NOT_APPLICABLE",
        fields: {},
      };
  if (effectiveUnknownResponseCount > 0 && reconciliation.status === "RECONCILED") {
    reconciliation.status = "PARTIAL";
  }

  const selected = cumulative ? cumulative.usage : responseSum;
  const result = {
    ...selected,
    currency: "tokens",
    model,
    provider,
    reasoning_effort: reasoningEffort,
    response_count: responseUsages.length
      + Math.max(0, unknownUsageResponseCount - unknownInArray),
    usage_response_count: knownResponses.length,
    unknown_usage_response_count: effectiveUnknownResponseCount,
    accounting_mode: cumulative
      ? "CUMULATIVE"
      : knownResponses.length > 0
        ? "RESPONSE_LEVEL"
        : "NONE",
    source,
    reconciliation,
    response_level_usage: responseSum,
    cumulative_usage: cumulative?.usage ?? null,
    evidence_level: cumulative || knownResponses.length > 0 ? "OBSERVED" : "UNKNOWN",
  };
  if (!ACCOUNTING_MODES.includes(result.accounting_mode)) {
    result.accounting_mode = "NONE";
  }
  if (!RECONCILIATION_STATUSES.includes(result.reconciliation.status)) {
    result.reconciliation.status = "UNKNOWN";
  }
  return result;
}

export function normalizeUsageCheckpoint(raw, options = {}) {
  if (!isRecord(raw)) return null;
  return {
    event_ref: options.eventRef ?? null,
    observed_at: normalizeTimestamp(options.observedAt),
    usage: normalizeUsage(raw, options),
    model_context_window: nonNegativeSafeInteger(options.modelContextWindow),
    last_usage_includes_reasoning: typeof options.lastUsageIncludesReasoning === "boolean"
      ? options.lastUsageIncludesReasoning
      : null,
  };
}

export function usageFromTokenCountPayload(payload, options = {}) {
  if (!isRecord(payload)) return { cumulative: null, last: null };
  const info = isRecord(payload.info) ? payload.info : payload;
  const totalRaw = info.total_token_usage ?? info.total;
  const lastRaw = info.last_token_usage ?? info.last;
  return {
    cumulative: normalizeUsageCheckpoint(totalRaw, {
      ...options,
      eventRef: `${options.eventRef ?? "token_count"}:total`,
      modelContextWindow: info.model_context_window,
      lastUsageIncludesReasoning: info.last_usage_includes_reasoning,
    }),
    last: normalizeUsageCheckpoint(lastRaw, {
      ...options,
      eventRef: `${options.eventRef ?? "token_count"}:last`,
      modelContextWindow: info.model_context_window,
      lastUsageIncludesReasoning: info.last_usage_includes_reasoning,
    }),
  };
}

export function usageSnapshotWithoutInternalFields(usage) {
  if (!usage) return emptyUsage();
  const result = {};
  for (const [key, value] of Object.entries(usage)) {
    if (!key.startsWith("_")) result[key] = value;
  }
  return result;
}
