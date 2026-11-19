import {
  ADDITIVE_USAGE_FIELDS,
  MCP_DISPATCH_TOOL_NAMES,
  MCP_POLL_TOOL_NAMES,
  PHASES,
  USAGE_FIELDS,
  phaseForCommandClass,
} from "./constants.mjs";
import {
  emptyUsage,
  sumUsagesStrict,
  usageIsUnknown,
} from "./usage.mjs";
import { safeRatio, uniqueBy } from "./util.mjs";

const MAX_EVIDENCE_REFS = 200;

function phaseForTool(tool) {
  if (!tool) return null;
  if (tool.kind === "MCP") {
    if (MCP_DISPATCH_TOOL_NAMES.includes(tool.name)) return "MCPDispatchResult";
    if (MCP_POLL_TOOL_NAMES.includes(tool.name)) return "MCPWaitingPolling";
    return "MCPDispatchResult";
  }
  const fromCommand = phaseForCommandClass(tool.command_class);
  if (fromCommand) return fromCommand;
  switch (tool.name) {
    case "update_plan":
    case "create_goal":
      return "Planning";
    case "apply_patch":
    case "write_file":
    case "edit_file":
      return "Implementation";
    default:
      return null;
  }
}

export function classifyResponsePhase(response, tools) {
  if (!response) {
    return {
      phase: "OtherMixedUnknown",
      evidence_level: "UNKNOWN",
      rule: "missing_response",
    };
  }
  const responseTools = tools.filter((tool) => tool.response_id === response.response_id);
  const failed = responseTools.find((tool) => tool.failed === true);
  if (failed) {
    return {
      phase: "FailureRetry",
      evidence_level: "ATTRIBUTED",
      rule: "failed_tool_call",
      evidence_refs: [failed.tool_event_id],
    };
  }
  const phaseSet = new Set(responseTools.map(phaseForTool).filter(Boolean));
  if (phaseSet.size === 0) {
    return {
      phase: "OtherMixedUnknown",
      evidence_level: "UNKNOWN",
      rule: responseTools.length === 0 ? "no_tool_phase_evidence" : "unclassified_tools",
    };
  }
  if (phaseSet.size > 1) {
    return {
      phase: "OtherMixedUnknown",
      evidence_level: "UNKNOWN",
      rule: "mixed_tool_phases",
      evidence_refs: responseTools.map((tool) => tool.tool_event_id),
    };
  }
  return {
    phase: [...phaseSet][0],
    evidence_level: "ATTRIBUTED",
    rule: `tool_sequence:${[...phaseSet][0]}`,
    evidence_refs: responseTools.map((tool) => tool.tool_event_id),
  };
}

function usageDelta(scopeUsage, responseSum) {
  const result = emptyUsage();
  let complete = false;
  for (const field of ADDITIVE_USAGE_FIELDS) {
    const scope = scopeUsage?.[field] ?? null;
    const attributed = responseSum?.[field] ?? null;
    result[field] = scope === null || attributed === null ? null : scope - attributed;
    if (result[field] !== null && result[field] >= 0) complete = true;
  }
  if (complete) {
    if (result.input_tokens !== null && result.cached_input_tokens !== null) {
      result.uncached_input_tokens = result.input_tokens - result.cached_input_tokens;
    }
    result.cache_hit_rate = result.cached_input_tokens !== null && result.input_tokens
      ? safeRatio(result.cached_input_tokens, result.input_tokens)
      : null;
    result.total_source = "CUMULATIVE_RESPONSE_DELTA";
    result.missing_fields = USAGE_FIELDS.filter((field) => result[field] === null);
    result.observed_fields = USAGE_FIELDS.filter((field) => result[field] !== null);
    result.evidence_level = "UNKNOWN";
  }
  return result;
}

function addUsageValues(rows) {
  const result = emptyUsage();
  for (const field of ADDITIVE_USAGE_FIELDS) {
    if (rows.length === 0) {
      result[field] = null;
      continue;
    }
    const values = rows.map((row) => row.usage?.[field] ?? null);
    result[field] = values.some((value) => value === null)
      ? null
      : values.reduce((sum, value) => sum + value, 0);
  }
  if (result.input_tokens !== null && result.cached_input_tokens !== null) {
    result.uncached_input_tokens = result.input_tokens - result.cached_input_tokens;
  }
  result.cache_hit_rate = result.cached_input_tokens !== null && result.input_tokens
    ? safeRatio(result.cached_input_tokens, result.input_tokens)
    : null;
  result.total_source = "PHASE_SUM";
  result.missing_fields = USAGE_FIELDS.filter((field) => result[field] === null);
  result.observed_fields = USAGE_FIELDS.filter((field) => result[field] !== null);
  result.evidence_level = result.observed_fields.length > 0 ? "ATTRIBUTED" : "UNKNOWN";
  return result;
}

function buildPhaseRows(agent, responses, tools) {
  const classified = responses.map((response) => ({
    response,
    classification: classifyResponsePhase(response, tools),
  }));
  const byPhase = new Map(PHASES.map((phase) => [phase, []]));
  for (const entry of classified) byPhase.get(entry.classification.phase).push(entry);

  const rows = [];
  for (const phase of PHASES) {
    const entries = byPhase.get(phase);
    const responseUsages = entries
      .map((entry) => entry.response.usage)
      .filter((usage) => !usageIsUnknown(usage));
    const attributedTools = tools.filter((tool) => phaseForTool(tool) === phase);
    if (entries.length === 0 && attributedTools.length === 0) continue;
    const usage = sumUsagesStrict(responseUsages, {
      model: agent.model,
      provider: agent.provider,
      reasoningEffort: agent.reasoning_effort,
    });
    const evidenceRefs = uniqueBy(
      entries.flatMap((entry) => [
        entry.response.event_ref,
        ...(entry.classification.evidence_refs ?? []),
      ]).concat(attributedTools.map((tool) => tool.tool_event_id)),
      (value) => value,
    );
    rows.push({
      agent_id: agent.agent_id,
      agent_kind: agent.kind,
      phase,
      usage,
      response_count: entries.length,
      unknown_usage_response_count: entries.filter((entry) => (
        usageIsUnknown(entry.response.usage)
      )).length,
      tool_call_count: attributedTools.length,
      token_share: safeRatio(usage.total_tokens, agent.usage?.total_tokens),
      evidence_level: entries.some((entry) => entry.classification.evidence_level === "UNKNOWN")
        ? "UNKNOWN"
        : entries.length > 0 || attributedTools.length > 0
          ? "ATTRIBUTED"
          : "UNKNOWN",
      rules: uniqueBy(
        entries.map((entry) => entry.classification.rule),
        (value) => value,
      ),
      evidence_refs: evidenceRefs.slice(0, MAX_EVIDENCE_REFS),
      evidence_refs_truncated: evidenceRefs.length > MAX_EVIDENCE_REFS,
      content_retained: false,
    });
  }
  const knownResponseUsages = responses
    .map((entry) => entry.usage)
    .filter((usage) => !usageIsUnknown(usage));
  const knownResponseSum = sumUsagesStrict(knownResponseUsages, {
    model: agent.model,
    provider: agent.provider,
    reasoningEffort: agent.reasoning_effort,
  });
  const unresolvedDelta = agent.usage?.accounting_mode === "CUMULATIVE"
    ? usageDelta(agent.usage, knownResponseSum)
    : emptyUsage();
  const hasNonZeroDelta = ADDITIVE_USAGE_FIELDS.some((field) => (
    unresolvedDelta[field] !== null && unresolvedDelta[field] > 0
  ));
  if (hasNonZeroDelta) {
    const existing = rows.find((row) => row.phase === "OtherMixedUnknown");
    if (existing) {
      const combined = {};
      for (const field of ADDITIVE_USAGE_FIELDS) {
        const left = existing.usage[field];
        const right = unresolvedDelta[field];
        combined[field] = left === null || right === null ? null : left + right;
      }
      existing.usage = {
        ...existing.usage,
        ...combined,
        uncached_input_tokens: combined.input_tokens !== null
          && combined.cached_input_tokens !== null
          ? combined.input_tokens - combined.cached_input_tokens
          : null,
        cache_hit_rate: combined.input_tokens
          ? safeRatio(combined.cached_input_tokens, combined.input_tokens)
          : null,
        total_source: "PHASE_SUM_WITH_UNRESOLVED_DELTA",
        missing_fields: USAGE_FIELDS.filter((field) => combined[field] === null),
        observed_fields: USAGE_FIELDS.filter((field) => combined[field] !== null),
        evidence_level: "UNKNOWN",
      };
      existing.rules = uniqueBy(
        [...existing.rules, "cumulative_unresolved_delta"],
        (value) => value,
      );
      existing.evidence_level = "UNKNOWN";
    } else {
      rows.push({
        agent_id: agent.agent_id,
        agent_kind: agent.kind,
        phase: "OtherMixedUnknown",
        usage: unresolvedDelta,
        response_count: 0,
        unknown_usage_response_count: 0,
        tool_call_count: 0,
        token_share: safeRatio(unresolvedDelta.total_tokens, agent.usage?.total_tokens),
        evidence_level: "UNKNOWN",
        rules: ["cumulative_unresolved_delta"],
        evidence_refs: [],
        evidence_refs_truncated: false,
        content_retained: false,
      });
    }
  }
  return { rows, classified };
}

function fieldAllKnown(responses, field) {
  return responses.every((response) => (
    response.usage
    && response.usage[field] !== null
    && response.usage[field] !== undefined
  ));
}

function conservationForAgent(agent, responses, rows) {
  const responseUsages = responses.map((response) => response.usage).filter(Boolean);
  const responseSum = sumUsagesStrict(responseUsages, {
    model: agent.model,
    provider: agent.provider,
    reasoningEffort: agent.reasoning_effort,
  });
  const scope = agent.usage ?? emptyUsage();
  const unresolved = agent.usage?.accounting_mode === "CUMULATIVE"
    ? usageDelta(scope, responseSum)
    : emptyUsage();
  const fields = {};
  let hasMismatch = false;
  let hasUnknown = responses.some((response) => usageIsUnknown(response.usage));

  for (const field of ADDITIVE_USAGE_FIELDS) {
    const observedScope = scope[field] ?? null;
    const allKnown = fieldAllKnown(responses, field);
    const knownResponses = responses
      .map((response) => response.usage?.[field] ?? null)
      .filter((value) => value !== null);
    const responseKnownSum = knownResponses.length === 0
      ? null
      : knownResponses.reduce((sum, value) => sum + value, 0);
    const delta = unresolved[field] ?? null;
    const notReported = observedScope === null
      && responseKnownSum === null
      && delta === null;
    const phaseTotal = allKnown && responseKnownSum !== null
      ? responseKnownSum + (delta ?? 0)
      : null;
    let status = "UNKNOWN";
    if (notReported) {
      status = "NOT_REPORTED";
    } else if (observedScope === null || phaseTotal === null) {
      status = "UNKNOWN";
      hasUnknown = true;
    } else if (delta !== null && delta < 0) {
      status = "MISMATCH";
      hasMismatch = true;
    } else if (phaseTotal === observedScope) {
      status = "CONSERVED";
    } else {
      status = "MISMATCH";
      hasMismatch = true;
    }
    fields[field] = {
      status,
      scope_total: observedScope,
      known_response_sum: responseKnownSum,
      unresolved_delta: delta,
      phase_total: phaseTotal,
    };
  }

  return {
    status: hasMismatch ? "MISMATCH" : hasUnknown ? "UNKNOWN" : "CONSERVED",
    accounting_mode: scope.accounting_mode ?? "NONE",
    response_count: responses.length,
    unknown_usage_response_count: responses.filter((response) => (
      usageIsUnknown(response.usage)
    )).length,
    phase_row_count: rows.length,
    fields,
  };
}

function mergePhaseRows(rows, agents) {
  const byPhase = new Map();
  for (const row of rows) {
    if (!byPhase.has(row.phase)) byPhase.set(row.phase, []);
    byPhase.get(row.phase).push(row);
  }
  return PHASES.flatMap((phase) => {
    const members = byPhase.get(phase);
    if (!members?.length) return [];
    const usage = addUsageValues(members);
    const scopeTotal = members.every((row) => (
      Number.isSafeInteger(row.usage.total_tokens)
    ))
      ? members.reduce((sum, row) => sum + row.usage.total_tokens, 0)
      : null;
    const agentTotals = agents.map((agent) => agent.usage?.total_tokens);
    const agentTotal = agentTotals.every((value) => Number.isSafeInteger(value))
      ? agentTotals.reduce((sum, value) => sum + value, 0)
      : null;
    return [{
      phase,
      usage,
      response_count: members.reduce((sum, row) => sum + row.response_count, 0),
      unknown_usage_response_count: members.reduce(
        (sum, row) => sum + row.unknown_usage_response_count,
        0,
      ),
      tool_call_count: members.reduce((sum, row) => sum + row.tool_call_count, 0),
      token_share: safeRatio(
        usage.total_tokens,
        agentTotal,
      ),
      evidence_level: members.some((row) => row.evidence_level === "UNKNOWN")
        ? "UNKNOWN"
        : "ATTRIBUTED",
      agent_ids: uniqueBy(members.map((row) => row.agent_id), (value) => value).sort(),
      scope_total_tokens: scopeTotal,
      content_retained: false,
    }];
  });
}

export function attributeUsagePhases(snapshot) {
  const agents = [...snapshot.agents].sort((left, right) => (
    left.agent_id.localeCompare(right.agent_id)
  ));
  const rows = [];
  const byAgent = [];
  const conservationByAgent = [];
  for (const agent of agents) {
    const responses = snapshot.responses.filter((response) => response.agent_id === agent.agent_id);
    const tools = snapshot.tools.filter((tool) => tool.agent_id === agent.agent_id);
    const built = buildPhaseRows(agent, responses, tools);
    const conservation = conservationForAgent(agent, responses, built.rows);
    rows.push(...built.rows);
    byAgent.push({
      agent_id: agent.agent_id,
      agent_kind: agent.kind,
      phases: built.rows,
      conservation,
    });
    conservationByAgent.push({
      agent_id: agent.agent_id,
      ...conservation,
    });
  }
  const phaseSummary = mergePhaseRows(rows, agents);
  const overallConserved = conservationByAgent.length > 0
    && conservationByAgent.every((entry) => entry.status === "CONSERVED");
  const overallMismatch = conservationByAgent.some((entry) => entry.status === "MISMATCH");
  return {
    rows,
    summary: phaseSummary,
    by_agent: byAgent,
    conservation: {
      status: conservationByAgent.length === 0
        ? "UNKNOWN"
        : overallMismatch
          ? "MISMATCH"
          : overallConserved
            ? "CONSERVED"
            : "UNKNOWN",
      by_agent: conservationByAgent,
      rule: "Each response usage is allocated at most once; unresolved cumulative delta remains UNKNOWN.",
    },
  };
}
