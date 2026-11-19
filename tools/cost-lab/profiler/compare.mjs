import { PROFILER_SCHEMA_VERSION } from "./constants.mjs";
import { assertProfilerReport } from "./schema.mjs";
import { difference, safeRatio, uniqueBy } from "./util.mjs";

function metric(before, after) {
  const delta = difference(before, after);
  return {
    before: before ?? null,
    after: after ?? null,
    delta,
    percent_change: before === null || before === undefined || before === 0
      ? null
      : safeRatio(delta, Math.abs(before)),
    comparison_status: before === null || before === undefined
      || after === null || after === undefined
      ? "UNKNOWN"
      : "OBSERVED_DELTA",
  };
}

function phaseMap(report) {
  return new Map((report.phases?.summary ?? []).map((row) => [row.phase, row]));
}

function toolMap(report) {
  return new Map((report.mcp?.by_tool ?? []).map((row) => [row.tool_name, row]));
}

function reportMetrics(report) {
  return {
    total_tokens: report.usage.overall.total_tokens,
    input_tokens: report.usage.overall.input_tokens,
    cached_input_tokens: report.usage.overall.cached_input_tokens,
    output_tokens: report.usage.overall.output_tokens,
    reasoning_tokens: report.usage.overall.reasoning_tokens,
    response_count: report.usage.overall.response_count,
    cache_hit_rate: report.context.cache.overall_cache_hit_rate,
    uncached_input_ratio: report.context.cache.overall_uncached_input_ratio,
    mcp_call_count: report.mcp.calls.length,
    model_driven_poll_count: report.mcp.waiting.model_driven_poll_count,
    polling_tokens: report.mcp.waiting.model_driven_poll_usage?.total_tokens ?? null,
    pure_wait_ms: report.mcp.waiting.pure_wait_ms,
    mcp_output_bytes: report.mcp.by_tool.reduce(
      (sum, row) => sum + (row.output_bytes.total ?? 0),
      0,
    ),
    compaction_count: report.context.compactions.count,
    diagnostics_count: report.diagnostics.length,
  };
}

function phaseComparison(before, after) {
  const previous = phaseMap(before);
  const current = phaseMap(after);
  const phases = uniqueBy(
    [...previous.keys(), ...current.keys()],
    (value) => value,
  ).sort();
  return phases.map((phase) => {
    const left = previous.get(phase);
    const right = current.get(phase);
    return {
      phase,
      tokens: metric(left?.usage.total_tokens ?? null, right?.usage.total_tokens ?? null),
      share: metric(left?.token_share ?? null, right?.token_share ?? null),
      evidence_before: left?.evidence_level ?? "UNKNOWN",
      evidence_after: right?.evidence_level ?? "UNKNOWN",
    };
  });
}

function mcpComparison(before, after) {
  const previous = toolMap(before);
  const current = toolMap(after);
  const names = uniqueBy([...previous.keys(), ...current.keys()], (value) => value).sort();
  return names.map((toolName) => {
    const left = previous.get(toolName);
    const right = current.get(toolName);
    return {
      tool_name: toolName,
      call_count: metric(left?.call_count ?? null, right?.call_count ?? null),
      duration_ms: metric(
        left?.duration_ms.total ?? null,
        right?.duration_ms.total ?? null,
      ),
      output_bytes: metric(
        left?.output_bytes.total ?? null,
        right?.output_bytes.total ?? null,
      ),
      estimated_output_tokens: metric(
        left?.estimated_output_tokens.total ?? null,
        right?.estimated_output_tokens.total ?? null,
      ),
      model_driven_poll_count: metric(
        left?.model_driven_poll_count ?? null,
        right?.model_driven_poll_count ?? null,
      ),
      polling_tokens: metric(
        left?.polling_usage.total_tokens ?? null,
        right?.polling_usage.total_tokens ?? null,
      ),
      failure_count: metric(left?.failure_count ?? null, right?.failure_count ?? null),
      duplicate_count: metric(left?.duplicate_count ?? null, right?.duplicate_count ?? null),
    };
  });
}

function bridgeResultComparison(before, after) {
  const statusCounts = (report) => {
    const result = {};
    for (const task of report.bridge_tasks ?? []) {
      const status = task.result_status ?? task.status ?? "UNKNOWN";
      result[status] = (result[status] ?? 0) + 1;
    }
    return result;
  };
  return {
    before: statusCounts(before),
    after: statusCounts(after),
  };
}

export function compareProfilerReports(beforeInput, afterInput) {
  const before = assertProfilerReport(beforeInput);
  const after = assertProfilerReport(afterInput);
  const beforeProviders = new Set(
    before.usage.by_provider.map((row) => `${row.provider ?? "UNKNOWN"}\0${row.model ?? "UNKNOWN"}`),
  );
  const afterProviders = new Set(
    after.usage.by_provider.map((row) => `${row.provider ?? "UNKNOWN"}\0${row.model ?? "UNKNOWN"}`),
  );
  const providerOnlyBefore = [...beforeProviders]
    .filter((value) => !afterProviders.has(value)).sort();
  const providerOnlyAfter = [...afterProviders]
    .filter((value) => !beforeProviders.has(value)).sort();
  const beforeMetrics = reportMetrics(before);
  const afterMetrics = reportMetrics(after);
  const metricNames = Object.keys(beforeMetrics).sort();
  const metrics = Object.fromEntries(metricNames.map((name) => [
    name,
    metric(beforeMetrics[name], afterMetrics[name]),
  ]));
  return {
    schema_version: PROFILER_SCHEMA_VERSION,
    kind: "profiler_comparison",
    before_report_id: before.report_id,
    after_report_id: after.report_id,
    compatibility: {
      status: providerOnlyBefore.length === 0 && providerOnlyAfter.length === 0
        ? "COMPARABLE"
        : "PARTIAL_COMPARABLE",
      token_unit: "tokens",
      provider_only_before: providerOnlyBefore,
      provider_only_after: providerOnlyAfter,
      note: "Provider/model sets remain separate; no billing-unit conversion is implied.",
    },
    metrics,
    phases: phaseComparison(before, after),
    mcp: {
      tools: mcpComparison(before, after),
      total_output_bytes: metric(beforeMetrics.mcp_output_bytes, afterMetrics.mcp_output_bytes),
      polling_tokens: metric(beforeMetrics.polling_tokens, afterMetrics.polling_tokens),
      pure_wait_ms: metric(beforeMetrics.pure_wait_ms, afterMetrics.pure_wait_ms),
    },
    context: {
      cache_hit_rate: metrics.cache_hit_rate,
      uncached_input_ratio: metrics.uncached_input_ratio,
      compaction_count: metrics.compaction_count,
    },
    diagnostics: {
      count: metric(
        before.diagnostics.length,
        after.diagnostics.length,
      ),
      high_before: before.diagnostics.filter((item) => item.severity === "HIGH").length,
      high_after: after.diagnostics.filter((item) => item.severity === "HIGH").length,
    },
    bridge_results: bridgeResultComparison(before, after),
    direction: {
      tokens: metrics.total_tokens.delta === null
        ? "UNKNOWN"
        : metrics.total_tokens.delta < 0
          ? "LOWER"
          : metrics.total_tokens.delta > 0
            ? "HIGHER"
            : "UNCHANGED",
      cache_hit_rate: metrics.cache_hit_rate.delta === null
        ? "UNKNOWN"
        : metrics.cache_hit_rate.delta > 0
          ? "HIGHER"
          : metrics.cache_hit_rate.delta < 0
            ? "LOWER"
            : "UNCHANGED",
      polling_tokens: metrics.polling_tokens.delta === null
        ? "UNKNOWN"
        : metrics.polling_tokens.delta < 0
          ? "LOWER"
          : metrics.polling_tokens.delta > 0
            ? "HIGHER"
            : "UNCHANGED",
    },
    read_only: true,
    content_retained: false,
  };
}
