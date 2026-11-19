import { safeRatio, summarizeObserved, timestampMs, uniqueBy } from "./util.mjs";
import { usageIsUnknown } from "./usage.mjs";

function cachePoint(response) {
  if (!response.usage || usageIsUnknown(response.usage)) return null;
  return {
    response_id: response.response_id,
    agent_id: response.agent_id,
    observed_at: response.observed_at,
    input_tokens: response.usage.input_tokens,
    cached_input_tokens: response.usage.cached_input_tokens,
    uncached_input_tokens: response.usage.uncached_input_tokens,
    cache_hit_rate: response.usage.cache_hit_rate,
    total_tokens: response.usage.total_tokens,
    evidence_level: "OBSERVED",
  };
}

function averageRate(points) {
  const rates = points
    .map((point) => point.cache_hit_rate)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  if (rates.length === 0) return null;
  return rates.reduce((sum, value) => sum + value, 0) / rates.length;
}

function cacheDirection(points) {
  const valid = points.filter((point) => (
    typeof point.cache_hit_rate === "number"
    && point.cache_hit_rate !== null
  ));
  if (valid.length < 4) {
    return {
      status: "INSUFFICIENT_DATA",
      first_half_average: null,
      second_half_average: null,
      change: null,
    };
  }
  const midpoint = Math.floor(valid.length / 2);
  const first = averageRate(valid.slice(0, midpoint));
  const second = averageRate(valid.slice(midpoint));
  return {
    status: first === null || second === null
      ? "UNKNOWN"
      : second + 0.1 < first
        ? "DECLINING"
        : second > first + 0.1
          ? "IMPROVING"
          : "STABLE",
    first_half_average: first,
    second_half_average: second,
    change: first === null || second === null ? null : second - first,
  };
}

function aggregateContextSources(items) {
  const byCategory = new Map();
  for (const item of items) {
    if (!byCategory.has(item.category)) {
      byCategory.set(item.category, {
        category: item.category,
        item_count: 0,
        bytes: 0,
        estimated_tokens: 0,
        agent_ids: new Set(),
        tool_names: new Set(),
      });
    }
    const row = byCategory.get(item.category);
    row.item_count += 1;
    row.bytes += item.bytes ?? 0;
    row.estimated_tokens += item.estimated_tokens ?? 0;
    row.agent_ids.add(item.agent_id);
    if (item.tool_name) row.tool_names.add(item.tool_name);
  }
  return [...byCategory.values()]
    .map((row) => ({
      category: row.category,
      item_count: row.item_count,
      bytes: row.bytes,
      estimated_tokens: row.estimated_tokens,
      agent_count: row.agent_ids.size,
      tool_names: [...row.tool_names].sort(),
      evidence_level: "ESTIMATED",
      content_retained: false,
    }))
    .sort((left, right) => (
      right.bytes - left.bytes || left.category.localeCompare(right.category)
    ));
}

function repeatedReads(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.category !== "file_read" || !item.path_hash) continue;
    const key = `${item.agent_id}\0${item.tool_name ?? "unknown"}\0${item.path_hash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()]
    .filter((entries) => entries.length > 1)
    .map((entries) => ({
      agent_id: entries[0].agent_id,
      tool_name: entries[0].tool_name,
      path_hash: entries[0].path_hash,
      read_count: entries.length,
      repeated_count: entries.length - 1,
      bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      estimated_tokens: entries.reduce((sum, entry) => sum + (entry.estimated_tokens ?? 0), 0),
      evidence_level: "ESTIMATED",
      content_retained: false,
    }))
    .sort((left, right) => (
      right.read_count - left.read_count
      || right.bytes - left.bytes
      || left.path_hash.localeCompare(right.path_hash)
    ));
}

function compactionRows(compactions) {
  return [...compactions]
    .sort((left, right) => (
      (left.observed_at ?? "").localeCompare(right.observed_at ?? "")
      || left.compaction_id.localeCompare(right.compaction_id)
    ))
    .map((compaction) => {
      const before = compaction.before_usage;
      const after = compaction.after_usage;
      return {
        compaction_id: compaction.compaction_id,
        agent_id: compaction.agent_id,
        observed_at: compaction.observed_at,
        window_number: compaction.window_number,
        input_tokens_before: before?.input_tokens ?? null,
        input_tokens_after: after?.input_tokens ?? null,
        input_token_change: before?.input_tokens !== null
          && before?.input_tokens !== undefined
          && after?.input_tokens !== null
          && after?.input_tokens !== undefined
          ? after.input_tokens - before.input_tokens
          : null,
        total_tokens_before: before?.total_tokens ?? null,
        total_tokens_after: after?.total_tokens ?? null,
        replacement_item_count: compaction.replacement_item_count,
        replacement_bytes: compaction.replacement_bytes,
        retained_context_bytes: compaction.retained_context_bytes,
        estimated_retained_context_tokens: compaction.estimated_retained_context_tokens,
        evidence_level: "ESTIMATED",
        content_retained: false,
      };
    });
}

export function analyzeContextAndCache(snapshot) {
  const responses = [...snapshot.responses].sort((left, right) => (
    (left.observed_at ?? "").localeCompare(right.observed_at ?? "")
    || left.response_id.localeCompare(right.response_id)
  ));
  const cachePoints = responses.map(cachePoint).filter(Boolean);
  const cacheByAgent = snapshot.agents.map((agent) => {
    const points = cachePoints.filter((point) => point.agent_id === agent.agent_id);
    const input = summarizeObserved(points.map((point) => point.input_tokens));
    const cached = summarizeObserved(points.map((point) => point.cached_input_tokens));
    const uncached = summarizeObserved(points.map((point) => point.uncached_input_tokens));
    const complete = input.complete && cached.complete && uncached.complete;
    return {
      agent_id: agent.agent_id,
      agent_kind: agent.kind,
      input_tokens: input.total,
      cached_input_tokens: cached.total,
      uncached_input_tokens: uncached.total,
      cache_hit_rate: complete
        ? safeRatio(cached.total, input.total)
        : null,
      uncached_input_ratio: complete
        ? safeRatio(uncached.total, input.total)
        : null,
      point_count: points.length,
      direction: cacheDirection(points),
      evidence_level: points.length > 0 && complete ? "OBSERVED" : "UNKNOWN",
    };
  });
  const contextSources = aggregateContextSources(snapshot.context_items);
  const compactions = compactionRows(snapshot.compactions);
  const repeated = repeatedReads(snapshot.context_items);
  const overallInput = summarizeObserved(cachePoints.map((point) => point.input_tokens));
  const overallCached = summarizeObserved(cachePoints.map((point) => point.cached_input_tokens));
  const overallUncached = summarizeObserved(cachePoints.map((point) => point.uncached_input_tokens));
  const overallComplete = overallInput.complete
    && overallCached.complete
    && overallUncached.complete;
  const cacheHitRate = overallComplete
    ? safeRatio(overallCached.total, overallInput.total)
    : null;
  const uncachedRatio = overallComplete
    ? safeRatio(overallUncached.total, overallInput.total)
    : null;
  return {
    cache: {
      points: cachePoints,
      by_agent: cacheByAgent,
      overall_cache_hit_rate: cacheHitRate,
      overall_uncached_input_ratio: uncachedRatio,
      direction: cacheDirection(cachePoints),
      evidence_level: cachePoints.length > 0 && overallComplete ? "OBSERVED" : "UNKNOWN",
    },
    context: {
      sources: contextSources,
      total_observed_content_bytes: contextSources.reduce((sum, row) => sum + row.bytes, 0),
      total_estimated_content_tokens: contextSources.reduce(
        (sum, row) => sum + row.estimated_tokens,
        0,
      ),
      estimation_method: "ceil(bytes / 4)",
      scope_note: "Local observable content only; hidden server prompts are not reconstructed.",
      evidence_level: "ESTIMATED",
      content_retained: false,
    },
    compactions: {
      rows: compactions,
      count: compactions.length,
      by_agent: uniqueBy(compactions.map((row) => row.agent_id), (value) => value)
        .sort()
        .map((agentId) => ({
          agent_id: agentId,
          count: compactions.filter((row) => row.agent_id === agentId).length,
        })),
      evidence_level: compactions.length > 0 ? "ESTIMATED" : "UNKNOWN",
    },
    repeated_reads: {
      rows: repeated,
      repeated_read_count: repeated.reduce((sum, row) => sum + row.repeated_count, 0),
      evidence_level: repeated.length > 0 ? "ESTIMATED" : "UNKNOWN",
    },
    input_growth: {
      points: cachePoints.map((point) => ({
        response_id: point.response_id,
        agent_id: point.agent_id,
        observed_at: point.observed_at,
        input_tokens: point.input_tokens,
        total_tokens: point.total_tokens,
        evidence_level: "OBSERVED",
      })),
      evidence_level: cachePoints.length > 0 ? "OBSERVED" : "UNKNOWN",
    },
    content_retained: false,
  };
}
