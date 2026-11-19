import { SEVERITY_ORDER } from "./constants.mjs";

function diagnostic({
  id,
  severity,
  category,
  fact,
  metric,
  value,
  evidenceLevel,
  recommendation,
  quantifiable,
  relatedTokens = null,
  relatedBytes = null,
  relatedRefs = [],
}) {
  return {
    id,
    severity,
    category,
    fact,
    metric,
    value,
    evidence_level: evidenceLevel,
    recommendation,
    quantifiable,
    impact: {
      related_tokens: relatedTokens,
      related_bytes: relatedBytes,
      evidence_level: evidenceLevel,
    },
    related_refs: relatedRefs.slice(0, 20),
  };
}

function severityForShare(share, tokens, mediumTokens, highTokens) {
  if (share !== null && share >= 0.4) return "HIGH";
  if (tokens !== null && tokens >= highTokens) return "HIGH";
  if (share !== null && share >= 0.2) return "MEDIUM";
  if (tokens !== null && tokens >= mediumTokens) return "MEDIUM";
  return "LOW";
}

export function buildProfilerDiagnostics({
  snapshot,
  usage,
  phases,
  mcp,
  context,
}) {
  const diagnostics = [];
  const unknownResponses = snapshot.responses.filter((response) => (
    response.usage_unknown === true || response.usage === null || response.usage === undefined
  )).length;
  if (unknownResponses > 0) {
    diagnostics.push(diagnostic({
      id: "diagnostic:missing_response_usage",
      severity: "MEDIUM",
      category: "data_quality",
      fact: `${unknownResponses} response record(s) did not expose usable usage fields.`,
      metric: "unknown_usage_response_count",
      value: unknownResponses,
      evidenceLevel: "UNKNOWN",
      recommendation: "Preserve these values as UNKNOWN and improve capture before optimizing on the missing slice.",
      quantifiable: false,
    }));
  }

  const pollingCount = mcp.waiting.model_driven_poll_count;
  const pollingTokens = mcp.waiting.model_driven_poll_usage?.total_tokens ?? null;
  const pollingShare = mcp.waiting.model_driven_poll_share_of_master_tokens;
  if (
    pollingCount >= 2
    || (pollingShare !== null && pollingShare >= 0.1)
    || (pollingTokens !== null && pollingTokens >= 20_000)
  ) {
    diagnostics.push(diagnostic({
      id: "diagnostic:model_driven_polling",
      severity: severityForShare(pollingShare, pollingTokens, 20_000, 100_000),
      category: "mcp_polling",
      fact: `${pollingCount} repeated MCP status query round(s) were separated by model responses.`,
      metric: "model_driven_poll_share_of_master_tokens",
      value: {
        poll_count: pollingCount,
        polling_tokens: pollingTokens,
        master_share: pollingShare,
      },
      evidenceLevel: pollingTokens === null ? "UNKNOWN" : "ATTRIBUTED",
      recommendation: "Prefer one bounded long-poll or a completion signal; do not replace it with shorter polling intervals.",
      quantifiable: pollingTokens !== null,
      relatedTokens: pollingTokens,
      relatedRefs: mcp.calls
        .filter((call) => call.model_driven_poll)
        .map((call) => call.tool_event_id),
    }));
  }

  const largeTools = mcp.by_tool.filter((row) => (
    (row.output_bytes.total ?? 0) >= 64 * 1024
    || (row.estimated_output_tokens.total ?? 0) >= 16_000
  ));
  for (const row of largeTools) {
    diagnostics.push(diagnostic({
      id: `diagnostic:large_mcp_output:${row.tool_name}`,
      severity: (row.output_bytes.total ?? 0) >= 256 * 1024 ? "HIGH" : "MEDIUM",
      category: "mcp_output_size",
      fact: `${row.tool_name} produced a large observable return payload.`,
      metric: "output_bytes",
      value: {
        output_bytes: row.output_bytes.total,
        estimated_output_tokens: row.estimated_output_tokens.total,
        call_count: row.call_count,
      },
      evidenceLevel: "ESTIMATED",
      recommendation: "Return bounded summaries, paginate deterministically, or request only changed fields.",
      quantifiable: true,
      relatedBytes: row.output_bytes.total,
    }));
  }

  if (mcp.duplicate_calls.length > 0) {
    diagnostics.push(diagnostic({
      id: "diagnostic:duplicate_mcp_calls",
      severity: mcp.duplicate_calls.some((call) => call.state_unchanged) ? "MEDIUM" : "LOW",
      category: "duplicate_calls",
      fact: `${mcp.duplicate_calls.length} MCP call(s) repeated an earlier tool/signature.`,
      metric: "duplicate_mcp_call_count",
      value: {
        duplicate_count: mcp.duplicate_calls.length,
        unchanged_output_count: mcp.duplicate_calls.filter((call) => call.state_unchanged).length,
      },
      evidenceLevel: "OBSERVED",
      recommendation: "Reuse the last receipt or suppress a repeat when the tool state and arguments are unchanged.",
      quantifiable: true,
      relatedRefs: mcp.duplicate_calls.map((call) => call.tool_event_id),
    }));
  }

  const repeatedReadCount = context.repeated_reads.repeated_read_count;
  if (repeatedReadCount > 0) {
    diagnostics.push(diagnostic({
      id: "diagnostic:repeated_reads",
      severity: repeatedReadCount >= 5 ? "MEDIUM" : "LOW",
      category: "context_reuse",
      fact: `${repeatedReadCount} repeated file-read output(s) were observed by content signature.`,
      metric: "repeated_file_read_count",
      value: repeatedReadCount,
      evidenceLevel: "ESTIMATED",
      recommendation: "Reuse a bounded content digest or cite the prior observation instead of re-reading unchanged content.",
      quantifiable: true,
      relatedTokens: context.repeated_reads.rows.reduce(
        (sum, row) => sum + (row.estimated_tokens ?? 0),
        0,
      ),
    }));
  }

  const uncachedRatio = context.cache.overall_uncached_input_ratio;
  const totalInput = usage.overall.input_tokens;
  if (
    uncachedRatio !== null
    && uncachedRatio >= 0.8
    && totalInput !== null
    && totalInput >= 50_000
  ) {
    diagnostics.push(diagnostic({
      id: "diagnostic:high_uncached_input",
      severity: uncachedRatio >= 0.95 ? "HIGH" : "MEDIUM",
      category: "cache",
      fact: "Observed input contains a high share of uncached tokens.",
      metric: "uncached_input_ratio",
      value: {
        uncached_input_ratio: uncachedRatio,
        input_tokens: totalInput,
      },
      evidenceLevel: "OBSERVED",
      recommendation: "Stabilize reusable prefixes and avoid unnecessary context churn before changing model choice.",
      quantifiable: true,
      relatedTokens: totalInput,
    }));
  }
  if (context.cache.direction.status === "DECLINING") {
    diagnostics.push(diagnostic({
      id: "diagnostic:cache_hit_rate_decline",
      severity: context.cache.direction.change <= -0.25 ? "HIGH" : "MEDIUM",
      category: "cache",
      fact: "The later response window has a lower cache-hit rate than the earlier window.",
      metric: "cache_hit_rate_change",
      value: context.cache.direction.change,
      evidenceLevel: "OBSERVED",
      recommendation: "Identify large context changes near the inflection and keep stable instructions/tool schemas ahead of volatile data.",
      quantifiable: true,
    }));
  }

  if (context.compactions.count >= 3) {
    diagnostics.push(diagnostic({
      id: "diagnostic:frequent_compaction",
      severity: context.compactions.count >= 6 ? "HIGH" : "MEDIUM",
      category: "compaction",
      fact: `${context.compactions.count} compaction event(s) were observed.`,
      metric: "compaction_count",
      value: context.compactions.count,
      evidenceLevel: "ESTIMATED",
      recommendation: "Reduce repeated large outputs and split unrelated work before relying on compaction.",
      quantifiable: true,
    }));
  }

  const failureRow = phases.summary.find((row) => row.phase === "FailureRetry");
  const failureTokens = failureRow?.usage.total_tokens ?? null;
  const failureShare = failureRow?.token_share ?? null;
  if (
    failureRow
    && (
      (failureTokens !== null && failureTokens >= 20_000)
      || (failureShare !== null && failureShare >= 0.15)
    )
  ) {
    diagnostics.push(diagnostic({
      id: "diagnostic:failure_retry_cost",
      severity: severityForShare(failureShare, failureTokens, 50_000, 200_000),
      category: "failure_retry",
      fact: "Failure/retry-attributed responses account for material observed usage.",
      metric: "failure_retry_share",
      value: {
        tokens: failureTokens,
        share: failureShare,
        response_count: failureRow.response_count,
      },
      evidenceLevel: "ATTRIBUTED",
      recommendation: "Fix the deterministic failure source before retrying the same expensive path.",
      quantifiable: failureTokens !== null,
      relatedTokens: failureTokens,
      relatedRefs: failureRow.evidence_refs,
    }));
  }

  const mcpPhases = phases.summary.filter((row) => (
    row.phase === "MCPDispatchResult" || row.phase === "MCPWaitingPolling"
  ));
  const mcpManagementTokens = mcpPhases.reduce(
    (sum, row) => sum + (row.usage.total_tokens ?? 0),
    0,
  );
  const masterTotal = usage.by_agent_kind.MASTER?.total_tokens ?? null;
  const managementShare = masterTotal !== null && masterTotal > 0
    ? mcpManagementTokens / masterTotal
    : null;
  if (
    mcpManagementTokens >= 20_000
    || (managementShare !== null && managementShare >= 0.2)
  ) {
    diagnostics.push(diagnostic({
      id: "diagnostic:master_dispatch_burden",
      severity: severityForShare(managementShare, mcpManagementTokens, 50_000, 200_000),
      category: "master_overhead",
      fact: "MCP dispatch/result and waiting/polling phases consume material Master usage.",
      metric: "mcp_management_share_of_master_tokens",
      value: {
        tokens: mcpManagementTokens,
        share: managementShare,
      },
      evidenceLevel: "ATTRIBUTED",
      recommendation: "Consolidate dispatch and completion handling into fewer model round trips.",
      quantifiable: masterTotal !== null,
      relatedTokens: mcpManagementTokens,
    }));
  }

  const scanWarnings = snapshot.warnings.filter((warning) => (
    warning.code?.startsWith("rollout_")
    || warning.code?.startsWith("bridge_")
    || warning.code?.startsWith("incremental_")
  ));
  if (scanWarnings.length > 0) {
    diagnostics.push(diagnostic({
      id: "diagnostic:source_completeness",
      severity: "LOW",
      category: "data_quality",
      fact: `${scanWarnings.length} source completeness warning(s) were recorded.`,
      metric: "source_warning_count",
      value: scanWarnings.length,
      evidenceLevel: "OBSERVED",
      recommendation: "Treat affected aggregates as partial until the source tail or database read is repaired.",
      quantifiable: false,
    }));
  }

  return diagnostics.sort((left, right) => (
    (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99)
    || (right.impact.related_tokens ?? 0) - (left.impact.related_tokens ?? 0)
    || (right.impact.related_bytes ?? 0) - (left.impact.related_bytes ?? 0)
    || left.id.localeCompare(right.id)
  ));
}
