import { PHASES, SEVERITY_ORDER } from "./constants.mjs";

function valueOrUnknown(value) {
  if (value === null || value === undefined) return "UNKNOWN";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString("en-US")
      : value.toFixed(3);
  }
  return String(value);
}

function percent(value) {
  return value === null || value === undefined ? "UNKNOWN" : `${(value * 100).toFixed(1)}%`;
}

function milliseconds(value) {
  if (value === null || value === undefined) return "UNKNOWN";
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headers, rows) {
  if (rows.length === 0) return "_No observed records._";
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function renderReport(report) {
  const lines = [
    "# Agent Token Profiler",
    "",
    `- Report: \`${report.report_id}\``,
    `- Snapshot: \`${report.source_snapshot_id}\``,
    `- Captured: ${valueOrUnknown(report.captured_at)}`,
    `- Generated: ${valueOrUnknown(report.generated_at)}`,
    `- Read only: ${report.read_only === true ? "YES" : "NO"}`,
    "",
    "## Usage Overview",
    "",
    table(
      ["Kind", "Input", "Cached", "Uncached", "Output", "Reasoning", "Total", "Responses", "Evidence"],
      Object.entries(report.usage.by_agent_kind).map(([kind, row]) => [
        kind,
        valueOrUnknown(row.input_tokens),
        valueOrUnknown(row.cached_input_tokens),
        valueOrUnknown(row.uncached_input_tokens),
        valueOrUnknown(row.output_tokens),
        valueOrUnknown(row.reasoning_tokens),
        valueOrUnknown(row.total_tokens),
        valueOrUnknown(row.response_count),
        row.evidence_level,
      ]),
    ),
    "",
    `Cache hit rate: ${percent(report.context.cache.overall_cache_hit_rate)}. ` +
      `Uncached input ratio: ${percent(report.context.cache.overall_uncached_input_ratio)}.`,
    "",
    "## Phase Breakdown",
    "",
    table(
      ["Phase", "Total Tokens", "Share", "Responses", "Tools", "Evidence"],
      PHASES
        .map((phase) => report.phases.summary.find((row) => row.phase === phase))
        .filter(Boolean)
        .map((row) => [
          row.phase,
          valueOrUnknown(row.usage.total_tokens),
          percent(row.token_share),
          valueOrUnknown(row.response_count),
          valueOrUnknown(row.tool_call_count),
          row.evidence_level,
        ]),
    ),
    "",
    `Phase conservation: **${report.phases.conservation.status}**.`,
    "",
    "## MCP Waiting And Polling",
    "",
    table(
      ["Metric", "Value"],
      [
        ["MCP calls", valueOrUnknown(report.mcp.calls.length)],
        ["Observed MCP wall time", milliseconds(report.mcp.waiting.mcp_call_duration_ms.total)],
        ["Pure wait", milliseconds(report.mcp.waiting.pure_wait_ms)],
        ["Model-driven polls", valueOrUnknown(report.mcp.waiting.model_driven_poll_count)],
        ["Polling tokens", valueOrUnknown(report.mcp.waiting.model_driven_poll_usage.total_tokens)],
        ["Polling share of Master tokens", percent(report.mcp.waiting.model_driven_poll_share_of_master_tokens)],
        ["Worker execution", milliseconds(report.mcp.waiting.worker_execution_ms)],
        ["Parallel Master work with Worker", milliseconds(report.mcp.waiting.master_parallel_work_ms)],
      ],
    ),
    "",
    table(
      ["Tool", "Calls", "Failures", "Duplicates", "Duration", "Output Bytes", "Est. Tokens", "Poll Tokens"],
      report.mcp.by_tool.map((row) => [
        row.tool_name,
        row.call_count,
        row.failure_count,
        row.duplicate_count,
        milliseconds(row.duration_ms.total),
        valueOrUnknown(row.output_bytes.total),
        valueOrUnknown(row.estimated_output_tokens.total),
        valueOrUnknown(row.polling_usage.total_tokens),
      ]),
    ),
    "",
    "## Context And Cache",
    "",
    table(
      ["Context Source", "Items", "Bytes", "Est. Tokens", "Evidence"],
      report.context.context.sources.map((row) => [
        row.category,
        row.item_count,
        valueOrUnknown(row.bytes),
        valueOrUnknown(row.estimated_tokens),
        row.evidence_level,
      ]),
    ),
    "",
    `Compaction count: ${valueOrUnknown(report.context.compactions.count)}. ` +
      `Repeated file reads: ${valueOrUnknown(report.context.repeated_reads.repeated_read_count)}.`,
    "",
    "## Diagnostics",
    "",
    table(
      ["Severity", "Category", "Fact", "Evidence", "Recommendation"],
      report.diagnostics.map((item) => [
        item.severity,
        item.category,
        item.fact,
        item.evidence_level,
        item.recommendation,
      ]),
    ),
    "",
    "## Evidence Boundary",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
    "Raw prompt, source code, reasoning text, and tool-output content are not retained by this report.",
    "",
  ];
  return lines.join("\n");
}

function renderComparison(comparison) {
  return [
    "# Agent Token Profiler Comparison",
    "",
    `- Before: \`${comparison.before_report_id}\``,
    `- After: \`${comparison.after_report_id}\``,
    `- Compatibility: **${comparison.compatibility.status}**`,
    "",
    "## Metrics",
    "",
    table(
      ["Metric", "Before", "After", "Delta", "Percent"],
      Object.entries(comparison.metrics).map(([name, row]) => [
        name,
        valueOrUnknown(row.before),
        valueOrUnknown(row.after),
        valueOrUnknown(row.delta),
        percent(row.percent_change),
      ]),
    ),
    "",
    "## Phases",
    "",
    table(
      ["Phase", "Before Tokens", "After Tokens", "Delta", "Before Evidence", "After Evidence"],
      comparison.phases.map((row) => [
        row.phase,
        valueOrUnknown(row.tokens.before),
        valueOrUnknown(row.tokens.after),
        valueOrUnknown(row.tokens.delta),
        row.evidence_before,
        row.evidence_after,
      ]),
    ),
    "",
    "## MCP Tools",
    "",
    table(
      ["Tool", "Call Delta", "Duration Delta", "Bytes Delta", "Poll Tokens Delta", "Failure Delta"],
      comparison.mcp.tools.map((row) => [
        row.tool_name,
        valueOrUnknown(row.call_count.delta),
        valueOrUnknown(row.duration_ms.delta),
        valueOrUnknown(row.output_bytes.delta),
        valueOrUnknown(row.polling_tokens.delta),
        valueOrUnknown(row.failure_count.delta),
      ]),
    ),
    "",
    "Provider and model groups remain separate; token deltas do not imply billing credit deltas.",
    "",
  ].join("\n");
}

export function renderProfilerMarkdown(value) {
  if (value?.kind === "profiler_comparison") return renderComparison(value);
  if (value?.kind !== "profiler_report") {
    throw new Error("profiler_report_expected");
  }
  return renderReport(value);
}
