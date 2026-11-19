import {
  MCP_DISPATCH_TOOL_NAMES,
  MCP_POLL_TOOL_NAMES,
} from "./constants.mjs";
import {
  emptyUsage,
  sumUsagesStrict,
  usageIsUnknown,
} from "./usage.mjs";
import {
  safeRatio,
  summarizeObserved,
  timestampMs,
  uniqueBy,
} from "./util.mjs";

function usageForResponseIds(responseIds, responses, model = null, provider = null) {
  const wanted = new Set(responseIds);
  const selected = responses.filter((response) => wanted.has(response.response_id));
  const known = selected.map((response) => response.usage).filter((usage) => !usageIsUnknown(usage));
  const usage = sumUsagesStrict(known, { model, provider });
  return {
    usage,
    response_count: selected.length,
    unknown_usage_response_count: selected.filter((response) => (
      usageIsUnknown(response.usage)
    )).length,
    evidence_level: selected.length === 0
      ? "UNKNOWN"
      : selected.some((response) => usageIsUnknown(response.usage))
        ? "UNKNOWN"
        : "ATTRIBUTED",
  };
}

function responsesBetween(responses, startAt, endAt) {
  const start = timestampMs(startAt);
  const end = timestampMs(endAt);
  if (start === null || end === null) return [];
  return responses.filter((response) => {
    const at = timestampMs(response.observed_at);
    return at !== null && at >= start && at < end;
  });
}

function classifyCalls(tools, responses) {
  const pureWaitThresholdMs = 5000;
  const responsesByAgent = new Map();
  for (const response of responses) {
    if (!responsesByAgent.has(response.agent_id)) responsesByAgent.set(response.agent_id, []);
    responsesByAgent.get(response.agent_id).push(response);
  }
  for (const list of responsesByAgent.values()) {
    list.sort((left, right) => (
      (left.observed_at ?? "").localeCompare(right.observed_at ?? "")
      || left.response_id.localeCompare(right.response_id)
    ));
  }

  const ordered = [...tools]
    .filter((tool) => tool.kind === "MCP")
    .sort((left, right) => (
      (left.started_at ?? "").localeCompare(right.started_at ?? "")
      || left.tool_event_id.localeCompare(right.tool_event_id)
    ));
  const repeats = new Map();
  const perResponseCallCount = new Map();
  for (const call of ordered) {
    if (call.response_id) {
      perResponseCallCount.set(
        call.response_id,
        (perResponseCallCount.get(call.response_id) ?? 0) + 1,
      );
    }
  }

  const result = [];
  for (const call of ordered) {
    const agentResponses = responsesByAgent.get(call.agent_id) ?? [];
    const responsesDuring = responsesBetween(
      agentResponses.filter((response) => response.response_id !== call.response_id),
      call.started_at,
      call.ended_at,
    );
    const repeatKey = `${call.agent_id}\0${call.name}\0${call.signature}`;
    const previous = repeats.get(repeatKey) ?? null;
    const responsesBeforeCurrent = previous
      ? responsesBetween(agentResponses, previous.ended_at ?? previous.started_at, call.started_at)
      : [];
    const pollCandidate = MCP_POLL_TOOL_NAMES.includes(call.name);
    const modelDrivenPoll = Boolean(
      pollCandidate
      && previous
      && call.response_id
      && previous.response_id
      && call.response_id !== previous.response_id,
    );
    let callKind = "QUERY";
    if (MCP_DISPATCH_TOOL_NAMES.includes(call.name)) {
      callKind = "DISPATCH";
    } else if (modelDrivenPoll) {
      callKind = "MODEL_DRIVEN_POLL";
    } else if (
      (call.wait_ms !== null && call.wait_ms > 0)
      || (call.wait_for !== null && responsesDuring.length === 0)
      || (
        pollCandidate
        && responsesDuring.length === 0
        && (call.duration_ms ?? 0) >= pureWaitThresholdMs
      )
    ) {
      callKind = "PURE_WAIT";
    } else if (previous && call.duplicate_of) {
      callKind = "DUPLICATE_QUERY";
    } else if (responsesDuring.length > 0) {
      callKind = "PARALLEL_QUERY";
    }
    const sharedCallCount = call.response_id
      ? perResponseCallCount.get(call.response_id) ?? 0
      : 0;
    result.push({
      ...call,
      call_kind: callKind,
      responses_during_call: responsesDuring.map((response) => response.response_id),
      responses_before_call_since_previous:
        responsesBeforeCurrent.map((response) => response.response_id),
      model_driven_poll: modelDrivenPoll,
      pure_wait: callKind === "PURE_WAIT",
      response_usage_allocated: sharedCallCount === 1,
      response_usage_allocation: call.response_id === null
        ? "NO_RESPONSE_LINK"
        : sharedCallCount === 1
          ? "UNIQUE_RESPONSE_TOOL"
          : "SHARED_RESPONSE_NOT_DUPLICATED",
    });
    repeats.set(repeatKey, call);
  }
  return result;
}

function toolAccumulator(name) {
  return {
    tool_name: name,
    call_count: 0,
    success_count: 0,
    failure_count: 0,
    unknown_outcome_count: 0,
    duplicate_count: 0,
    state_unchanged_duplicate_count: 0,
    pure_wait_count: 0,
    model_driven_poll_count: 0,
    dispatch_count: 0,
    total_duration_ms: null,
    average_duration_ms: null,
    maximum_duration_ms: null,
    output_bytes: null,
    estimated_output_tokens: null,
    response_ids: [],
    polling_response_ids: [],
    attributed_usage: emptyUsage(),
    polling_usage: emptyUsage(),
    evidence_level: "UNKNOWN",
  };
}

function aggregateByTool(calls, responses) {
  const byTool = new Map();
  for (const call of calls) {
    if (!byTool.has(call.name)) byTool.set(call.name, toolAccumulator(call.name));
    const item = byTool.get(call.name);
    item.call_count += 1;
    if (call.status === "SUCCESS") item.success_count += 1;
    else if (call.status === "FAILURE") item.failure_count += 1;
    else item.unknown_outcome_count += 1;
    if (call.duplicate_of) item.duplicate_count += 1;
    if (call.state_unchanged === true) item.state_unchanged_duplicate_count += 1;
    if (call.call_kind === "PURE_WAIT") item.pure_wait_count += 1;
    if (call.model_driven_poll) item.model_driven_poll_count += 1;
    if (call.call_kind === "DISPATCH") item.dispatch_count += 1;
    if (call.response_id) item.response_ids.push(call.response_id);
    if (call.model_driven_poll && call.response_id) {
      item.polling_response_ids.push(call.response_id);
    }
  }

  const toolRows = [];
  for (const [name, item] of [...byTool.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const toolCalls = calls.filter((call) => call.name === name);
    const durations = summarizeObserved(toolCalls.map((call) => call.duration_ms));
    const outputBytes = summarizeObserved(toolCalls.map((call) => call.output_bytes));
    const estimatedOutputTokens = summarizeObserved(
      toolCalls.map((call) => call.estimated_output_tokens),
    );
    const singleToolResponseIds = toolCalls
      .filter((call) => call.response_usage_allocated && call.response_id)
      .map((call) => call.response_id);
    const attribution = usageForResponseIds(
      uniqueBy(singleToolResponseIds, (value) => value),
      responses,
    );
    const polling = usageForResponseIds(
      uniqueBy(item.polling_response_ids, (value) => value),
      responses,
    );
    toolRows.push({
      tool_name: name,
      call_count: item.call_count,
      success_count: item.success_count,
      failure_count: item.failure_count,
      unknown_outcome_count: item.unknown_outcome_count,
      duplicate_count: item.duplicate_count,
      state_unchanged_duplicate_count: item.state_unchanged_duplicate_count,
      pure_wait_count: item.pure_wait_count,
      model_driven_poll_count: item.model_driven_poll_count,
      dispatch_count: item.dispatch_count,
      duration_ms: durations,
      output_bytes: outputBytes,
      estimated_output_tokens: estimatedOutputTokens,
      estimated_token_evidence: "ESTIMATED",
      associated_response_count: uniqueBy(item.response_ids, (value) => value).length,
      attributed_usage: attribution.usage,
      attributed_response_count: attribution.response_count,
      unknown_attributed_response_count: attribution.unknown_usage_response_count,
      polling_usage: polling.usage,
      polling_response_count: polling.response_count,
      evidence_level: attribution.evidence_level,
      content_retained: false,
    });
  }
  return toolRows;
}

function overlapMs(leftStart, leftEnd, rightStart, rightEnd) {
  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  return end > start ? end - start : 0;
}

function workerOverlapEvidence(calls, bridgeTasks, masterResponses) {
  const intervals = bridgeTasks
    .map((task) => ({
      task,
      start: timestampMs(task.execution_started_at),
      end: timestampMs(task.execution_ended_at),
    }))
    .filter((entry) => entry.start !== null
      && entry.end !== null
      && entry.end >= entry.start);
  const totalWorkerMs = intervals.reduce((sum, entry) => sum + (entry.end - entry.start), 0);
  let parallelMs = 0;
  const parallelTasks = [];
  for (const interval of intervals) {
    const masterWork = masterResponses.some((response) => {
      const at = timestampMs(response.observed_at);
      return at !== null && at >= interval.start && at <= interval.end;
    });
    if (masterWork) {
      parallelMs += interval.end - interval.start;
      parallelTasks.push({
        task_id: interval.task.task_id,
        attempt: interval.task.attempt,
        duration_ms: interval.end - interval.start,
        evidence_level: "ATTRIBUTED",
      });
    }
  }
  let blockingEquivalentMs = 0;
  for (const call of calls) {
    if (!call.pure_wait || call.duration_ms === null) continue;
    const start = timestampMs(call.started_at);
    const end = timestampMs(call.ended_at);
    if (start === null || end === null) continue;
    let parallelOverlap = 0;
    for (const task of parallelTasks) {
      const interval = intervals.find((entry) => (
        entry.task.task_id === task.task_id
        && entry.task.attempt === task.attempt
      ));
      if (!interval) continue;
      parallelOverlap = Math.max(
        parallelOverlap,
        overlapMs(start, end, interval.start, interval.end),
      );
    }
    const candidate = Math.max(0, end - start - parallelOverlap);
    blockingEquivalentMs += candidate;
  }
  return {
    worker_execution_ms: intervals.length > 0 ? totalWorkerMs : null,
    worker_execution_interval_count: intervals.length,
    master_parallel_work_ms: parallelTasks.length > 0 ? parallelMs : null,
    master_parallel_worker_tasks: parallelTasks,
    wait_without_parallel_work_ms: calls.some((call) => call.pure_wait)
      ? blockingEquivalentMs
      : null,
    evidence_level: parallelTasks.length > 0 ? "ATTRIBUTED" : "UNKNOWN",
  };
}

export function analyzeMcpUsage(snapshot) {
  const responses = snapshot.responses;
  const classifiedCalls = classifyCalls(snapshot.tools, responses);
  const byTool = aggregateByTool(classifiedCalls, responses);
  const durations = summarizeObserved(classifiedCalls.map((call) => call.duration_ms));
  const pureWaitCalls = classifiedCalls.filter((call) => call.pure_wait);
  const pollCalls = classifiedCalls.filter((call) => call.model_driven_poll);
  const pollingResponseIds = uniqueBy(
    pollCalls.map((call) => call.response_id).filter(Boolean),
    (value) => value,
  );
  const pollingUsage = usageForResponseIds(pollingResponseIds, responses);
  const masterAgentIds = new Set(
    snapshot.agents.filter((agent) => agent.kind === "MASTER").map((agent) => agent.agent_id),
  );
  const masterResponses = responses.filter((response) => masterAgentIds.has(response.agent_id));
  const masterKnownUsage = sumUsagesStrict(
    masterResponses.map((response) => response.usage).filter((usage) => !usageIsUnknown(usage)),
  );
  const outputRank = byTool
    .filter((row) => row.output_bytes.total !== null)
    .sort((left, right) => (
      right.output_bytes.total - left.output_bytes.total
      || left.tool_name.localeCompare(right.tool_name)
    ))
    .map((row) => ({
      tool_name: row.tool_name,
      output_bytes: row.output_bytes.total,
      estimated_output_tokens: row.estimated_output_tokens.total,
      evidence_level: "ESTIMATED",
    }));
  const failures = byTool
    .filter((row) => row.failure_count > 0 || row.unknown_outcome_count > 0)
    .map((row) => ({
      tool_name: row.tool_name,
      failure_count: row.failure_count,
      unknown_outcome_count: row.unknown_outcome_count,
    }));
  const overlap = workerOverlapEvidence(classifiedCalls, snapshot.bridge_tasks, masterResponses);
  return {
    calls: classifiedCalls,
    by_tool: byTool,
    waiting: {
      mcp_call_duration_ms: durations,
      pure_wait_ms: pureWaitCalls.length > 0
        ? summarizeObserved(pureWaitCalls.map((call) => call.duration_ms)).total
        : null,
      pure_wait_call_count: pureWaitCalls.length,
      model_driven_poll_count: pollCalls.length,
      model_driven_poll_response_count: pollingUsage.response_count,
      model_driven_poll_usage: pollingUsage.usage,
      model_driven_poll_share_of_master_tokens: safeRatio(
        pollingUsage.usage.total_tokens,
        masterKnownUsage.total_tokens,
      ),
      parallel_mcp_call_count: classifiedCalls.filter(
        (call) => call.responses_during_call.length > 0,
      ).length,
      ...overlap,
      evidence_level: pureWaitCalls.length > 0 || pollCalls.length > 0
        ? "ATTRIBUTED"
        : "UNKNOWN",
      note: "Pure wait time is wall-clock evidence only; it does not create model tokens.",
    },
    output_ranking: outputRank,
    failures,
    duplicate_calls: classifiedCalls.filter((call) => call.duplicate_of).map((call) => ({
      tool_name: call.name,
      tool_event_id: call.tool_event_id,
      duplicate_of: call.duplicate_of,
      state_unchanged: call.state_unchanged,
      evidence_level: "OBSERVED",
    })),
    content_retained: false,
  };
}
