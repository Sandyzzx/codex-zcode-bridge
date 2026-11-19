import { attributeUsagePhases } from "./attribute.mjs";
import { analyzeContextAndCache } from "./context.mjs";
import {
  AGENT_KINDS,
  PROFILER_REPORT_KIND,
  PROFILER_SCHEMA_VERSION,
  PROFILER_SNAPSHOT_KIND,
} from "./constants.mjs";
import { buildProfilerDiagnostics } from "./diagnostics.mjs";
import { groupAgentsByGoal } from "./correlate.mjs";
import { analyzeMcpUsage } from "./mcp.mjs";
import { assertProfilerSnapshot } from "./schema.mjs";
import { createAggregateUsage, sumUsagesStrict, usageIsUnknown } from "./usage.mjs";
import {
  safeRatio,
  sha256,
  timestampMs,
  uniqueBy,
} from "./util.mjs";

function filterSnapshot(snapshot, options) {
  const hasFilter = options.goalId || options.threadId || options.agentId
    || options.from || options.to;
  if (!hasFilter) return snapshot;
  let selectedIds = new Set(snapshot.agents.map((agent) => agent.agent_id));
  if (options.goalId) {
    selectedIds = new Set(
      snapshot.agents
        .filter((agent) => agent.goal_id === options.goalId)
        .map((agent) => agent.agent_id),
    );
  } else if (options.threadId) {
    selectedIds = new Set(
      snapshot.agents
        .filter((agent) => (
          agent.thread_id === options.threadId
          || agent.parent_thread_id === options.threadId
        ))
        .map((agent) => agent.agent_id),
    );
  } else if (options.agentId) {
    selectedIds = new Set(
      snapshot.agents
        .filter((agent) => (
          agent.agent_id === options.agentId
          || (agent.lineage ?? []).includes(options.agentId)
        ))
        .map((agent) => agent.agent_id),
    );
  }
  const fromMs = options.from ? timestampMs(options.from) : null;
  const toMs = options.to ? timestampMs(options.to) : null;
  const timeFiltered = fromMs !== null || toMs !== null;
  const withinTime = (value) => {
    if (fromMs === null && toMs === null) return true;
    const at = timestampMs(value);
    if (at === null) return false;
    return (fromMs === null || at >= fromMs) && (toMs === null || at <= toMs);
  };
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const agent of snapshot.agents) {
      if (selectedIds.has(agent.agent_id)) continue;
      const isDescendant = (
        (agent.parent_agent_id && selectedIds.has(agent.parent_agent_id))
        || (agent.lineage ?? []).some((id) => selectedIds.has(id))
      );
      if (isDescendant) {
        selectedIds.add(agent.agent_id);
        expanded = true;
      }
    }
  }
  const intervalMatches = (startAt, endAt = startAt) => {
    if (fromMs === null && toMs === null) return true;
    const start = timestampMs(startAt);
    const end = timestampMs(endAt ?? startAt);
    if (start === null && end === null) return false;
    const effectiveStart = start ?? end;
    const effectiveEnd = end ?? start;
    return (toMs === null || effectiveStart <= toMs)
      && (fromMs === null || effectiveEnd >= fromMs);
  };
  const selectedAgents = snapshot.agents.filter((agent) => (
    selectedIds.has(agent.agent_id)
    && intervalMatches(agent.started_at, agent.ended_at)
  ));
  const keptIds = new Set(selectedAgents.map((agent) => agent.agent_id));
  const responses = snapshot.responses.filter((response) => (
    keptIds.has(response.agent_id) && withinTime(response.observed_at)
  ));
  const usageCheckpoints = snapshot.usage_checkpoints.filter((checkpoint) => (
    keptIds.has(checkpoint.agent_id) && withinTime(checkpoint.observed_at ?? checkpoint.event_ref)
  ));
  const tools = snapshot.tools.filter((tool) => (
    keptIds.has(tool.agent_id) && intervalMatches(tool.started_at, tool.ended_at)
  ));
  const contextItems = snapshot.context_items.filter((item) => (
    keptIds.has(item.agent_id)
    && (
      !timeFiltered
      || (item.observed_at !== null && item.observed_at !== undefined && withinTime(item.observed_at))
    )
  ));
  const compactions = snapshot.compactions.filter((compaction) => (
    keptIds.has(compaction.agent_id) && withinTime(compaction.observed_at)
  ));
  const agents = timeFiltered
    ? selectedAgents.map((agent) => {
        const agentResponses = responses.filter((response) => response.agent_id === agent.agent_id);
        const unknownUsageResponseCount = agentResponses.filter((response) => (
          usageIsUnknown(response.usage)
        )).length;
        const usage = createAggregateUsage({
          responseUsages: agentResponses
            .map((response) => response.usage)
            .filter((value) => value !== null),
          cumulativeUsages: [],
          unknownUsageResponseCount,
          model: agent.model,
          provider: agent.provider,
          reasoningEffort: agent.reasoning_effort,
          source: "time_window_response_level",
        });
        return {
          ...agent,
          usage,
          response_count: agentResponses.length,
          unknown_usage_response_count: unknownUsageResponseCount,
        };
      })
    : selectedAgents;
  const payload = {
    ...snapshot,
    snapshot_id: null,
    agents,
    goals: groupAgentsByGoal(agents),
    responses,
    usage_checkpoints: usageCheckpoints,
    tools,
    context_items: contextItems,
    compactions,
    bridge_tasks: snapshot.bridge_tasks.filter((task) => (
      agents.some((agent) => (
        agent.kind === "WORKER"
        && agent.task_id === task.task_id
        && Number(agent.agent_id.split(":").at(-1)) === task.attempt
      )) && intervalMatches(task.execution_started_at, task.execution_ended_at)
    )),
  };
  payload.snapshot_id = sha256(payload);
  return assertProfilerSnapshot(payload);
}

function buildTimeline(snapshot, mcp, options) {
  const requestedLimit = Number.isSafeInteger(options.timelineLimit)
    ? options.timelineLimit
    : 500;
  const limit = Math.max(1, Math.min(2000, requestedLimit));
  const events = [];
  for (const response of snapshot.responses) {
    events.push({
      timeline_id: `response:${response.response_id}`,
      kind: "RESPONSE",
      at: response.observed_at,
      end_at: response.observed_at,
      agent_id: response.agent_id,
      turn_id: response.turn_id,
      response_id: response.response_id,
      status: response.usage_unknown ? "UNKNOWN" : "OBSERVED",
      input_tokens: response.usage?.input_tokens ?? null,
      cached_input_tokens: response.usage?.cached_input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
      total_tokens: response.usage?.total_tokens ?? null,
      evidence_level: response.usage_unknown ? "UNKNOWN" : "OBSERVED",
    });
  }
  for (const call of mcp.calls) {
    events.push({
      timeline_id: `mcp:${call.tool_event_id}`,
      kind: "MCP_TOOL",
      at: call.started_at,
      end_at: call.ended_at,
      agent_id: call.agent_id,
      turn_id: call.turn_id,
      tool_name: call.name,
      tool_event_id: call.tool_event_id,
      status: call.call_kind,
      duration_ms: call.duration_ms,
      output_bytes: call.output_bytes,
      duplicate: Boolean(call.duplicate_of),
      failure: call.failed,
      evidence_level: call.model_driven_poll ? "ATTRIBUTED" : "OBSERVED",
    });
  }
  for (const task of snapshot.bridge_tasks) {
    events.push({
      timeline_id: `worker:${task.task_id}:${task.attempt}`,
      kind: "WORKER",
      at: task.execution_started_at,
      end_at: task.execution_ended_at,
      task_id: task.task_id,
      attempt: task.attempt,
      status: task.status,
      duration_ms: task.execution_duration_ms,
      turn_count: task.turn_count,
      tool_call_count: task.tool_call_count,
      evidence_level: "OBSERVED",
    });
  }
  for (const compaction of snapshot.compactions) {
    events.push({
      timeline_id: `compaction:${compaction.compaction_id}`,
      kind: "COMPACTION",
      at: compaction.observed_at,
      end_at: compaction.observed_at,
      agent_id: compaction.agent_id,
      compaction_id: compaction.compaction_id,
      status: compaction.after_usage ? "OBSERVED" : "UNKNOWN",
      window_number: compaction.window_number,
      replacement_item_count: compaction.replacement_item_count,
      estimated_retained_context_tokens: compaction.estimated_retained_context_tokens,
      evidence_level: "ESTIMATED",
    });
  }
  events.sort((left, right) => (
    (left.at ?? "").localeCompare(right.at ?? "")
    || left.kind.localeCompare(right.kind)
    || left.timeline_id.localeCompare(right.timeline_id)
  ));
  const total = events.length;
  let selected = events;
  if (events.length > limit) {
    const head = Math.ceil(limit / 2);
    const tail = limit - head;
    selected = events.slice(0, head).concat(events.slice(-tail));
  }
  return {
    entries: selected,
    // The public report keeps these fields separately so timeline remains a
    // stable array contract for CLI and Web consumers.
    meta: {
      event_count: selected.length,
      total_event_count: total,
      truncated: total > selected.length,
      limit,
      content_retained: false,
    },
  };
}

function aggregateUsage(agents) {
  const byKind = {};
  for (const kind of AGENT_KINDS) {
    const members = agents.filter((agent) => agent.kind === kind);
    if (members.length === 0) continue;
    const usage = sumUsagesStrict(
      members.map((agent) => agent.usage).filter((value) => !usageIsUnknown(value)),
    );
    byKind[kind] = {
      ...usage,
      agent_count: members.length,
      response_count: members.reduce((sum, agent) => sum + (agent.response_count ?? 0), 0),
      unknown_usage_response_count: members.reduce(
        (sum, agent) => sum + (agent.unknown_usage_response_count ?? 0),
        0,
      ),
      evidence_level: members.some((agent) => !usageIsUnknown(agent.usage))
        ? "OBSERVED"
        : "UNKNOWN",
    };
  }
  const overall = sumUsagesStrict(
    agents.map((agent) => agent.usage).filter((value) => !usageIsUnknown(value)),
  );
  const providers = new Map();
  for (const agent of agents) {
    const key = `${agent.provider ?? "UNKNOWN_PROVIDER"}\0${agent.model ?? "UNKNOWN_MODEL"}`;
    if (!providers.has(key)) {
      providers.set(key, {
        provider: agent.provider,
        model: agent.model,
        agent_ids: [],
        agent_kinds: [],
      });
    }
    const row = providers.get(key);
    row.agent_ids.push(agent.agent_id);
    row.agent_kinds.push(agent.kind);
  }
  const byProvider = [...providers.values()].map((row) => {
    const members = agents.filter((agent) => row.agent_ids.includes(agent.agent_id));
    const usage = sumUsagesStrict(
      members.map((agent) => agent.usage).filter((value) => !usageIsUnknown(value)),
      { model: row.model, provider: row.provider },
    );
    return {
      provider: row.provider,
      model: row.model,
      agent_ids: row.agent_ids.sort(),
      agent_kinds: uniqueBy(row.agent_kinds, (value) => value).sort(),
      usage: {
        ...usage,
        response_count: members.reduce((sum, agent) => sum + (agent.response_count ?? 0), 0),
        unknown_usage_response_count: members.reduce(
          (sum, agent) => sum + (agent.unknown_usage_response_count ?? 0),
          0,
        ),
      },
    };
  }).sort((left, right) => (
    (left.provider ?? "").localeCompare(right.provider ?? "")
    || (left.model ?? "").localeCompare(right.model ?? "")
  ));
  return {
    overall: {
      ...overall,
      agent_count: agents.length,
      response_count: agents.reduce((sum, agent) => sum + (agent.response_count ?? 0), 0),
      unknown_usage_response_count: agents.reduce(
        (sum, agent) => sum + (agent.unknown_usage_response_count ?? 0),
        0,
      ),
      mixed_providers: uniqueBy(
        agents.map((agent) => agent.provider ?? "UNKNOWN_PROVIDER"),
        (value) => value,
      ).length > 1,
      billing_units_combined: false,
      evidence_level: agents.some((agent) => !usageIsUnknown(agent.usage))
        ? "OBSERVED"
        : "UNKNOWN",
    },
    by_agent_kind: byKind,
    by_provider: byProvider,
    unknown_usage_agent_count: agents.filter((agent) => usageIsUnknown(agent.usage)).length,
    note: "Token fields are additive only within a provider/model group; no monetary conversion is performed.",
  };
}

function highLevelFindings(usage, phases, mcp, context) {
  return {
    master_to_subagent_token_ratio: safeRatio(
      usage.by_agent_kind.MASTER?.total_tokens,
      usage.by_agent_kind.SUBAGENT?.total_tokens,
    ),
    master_to_worker_token_ratio: safeRatio(
      usage.by_agent_kind.MASTER?.total_tokens,
      usage.by_agent_kind.WORKER?.total_tokens,
    ),
    top_phase: [...phases.summary]
      .filter((row) => row.usage.total_tokens !== null)
      .sort((left, right) => (
        right.usage.total_tokens - left.usage.total_tokens
        || left.phase.localeCompare(right.phase)
      ))[0] ?? null,
    top_mcp_output: mcp.output_ranking[0] ?? null,
    cache_hit_rate: context.cache.overall_cache_hit_rate,
    compaction_count: context.compactions.count,
  };
}

export function analyzeProfilerSnapshot(input, options = {}) {
  const snapshot = filterSnapshot(assertProfilerSnapshot(input), options);
  const usage = aggregateUsage(snapshot.agents);
  const phases = attributeUsagePhases(snapshot);
  const mcp = analyzeMcpUsage(snapshot);
  const context = analyzeContextAndCache(snapshot);
  const timeline = buildTimeline(snapshot, mcp, options);
  const diagnostics = buildProfilerDiagnostics({
    snapshot,
    usage,
    phases,
    mcp,
    context,
  });
  const reportBase = {
    schema_version: PROFILER_SCHEMA_VERSION,
    kind: PROFILER_REPORT_KIND,
    report_id: null,
    source_snapshot_id: snapshot.snapshot_id,
    captured_at: snapshot.captured_at,
    generated_at: snapshot.generated_at ?? snapshot.captured_at,
    event_horizon_at: snapshot.event_horizon_at ?? null,
    scope: {
      goal_ids: uniqueBy(snapshot.agents.map((agent) => agent.goal_id), (value) => value)
        .filter(Boolean).sort(),
      thread_ids: uniqueBy(snapshot.agents.map((agent) => agent.thread_id), (value) => value)
        .filter(Boolean).sort(),
      agent_ids: snapshot.agents.map((agent) => agent.agent_id).sort(),
      source_count: snapshot.sources.length,
      filter: {
        goal_id: options.goalId ?? null,
        thread_id: options.threadId ?? null,
        agent_id: options.agentId ?? null,
        from: options.from ?? null,
        to: options.to ?? null,
      },
    },
    usage,
    agents: [...snapshot.agents].sort((left, right) => (
      AGENT_KINDS.indexOf(left.kind) - AGENT_KINDS.indexOf(right.kind)
      || left.agent_id.localeCompare(right.agent_id)
    )),
    goals: snapshot.goals,
    phases,
    mcp,
    context,
    diagnostics,
    timeline: timeline.entries,
    timeline_meta: timeline.meta,
    findings: highLevelFindings(usage, phases, mcp, context),
    limitations: [
      ...(snapshot.limitations ?? []),
      "Phase assignment is deterministic event/tool attribution and does not inspect hidden reasoning.",
      "MCP wait duration is not a token charge; token cost is reported only from observed model responses.",
      "Output token estimates are content-size estimates and are never presented as provider usage.",
    ],
    source_warnings: snapshot.warnings,
    read_only: true,
    snapshot_kind: PROFILER_SNAPSHOT_KIND,
    content_retained: false,
  };
  reportBase.report_id = sha256(reportBase);
  return reportBase;
}
