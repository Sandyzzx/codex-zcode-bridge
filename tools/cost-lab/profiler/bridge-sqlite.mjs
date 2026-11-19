import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createAggregateUsage, normalizeUsage, usageIsUnknown } from "./usage.mjs";
import {
  cleanString,
  estimatedTokensFromBytes,
  isMcpTool,
  isRecord,
  normalizeTimestamp,
  normalizeToolName,
  nonNegativeSafeInteger,
  parseJsonLoose,
  sha256,
  timestampMs,
  valueBytes,
} from "./util.mjs";

function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
      .map((row) => row.name),
  );
}

function tableColumns(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all()
      .map((row) => row.name),
  );
}

function allIfPresent(db, tables, table, sql) {
  return tables.has(table) ? db.prepare(sql).all() : [];
}

function parseDetails(value) {
  const parsed = parseJsonLoose(value);
  return isRecord(parsed) ? parsed : null;
}

function operationKey(taskId, attempt) {
  return `${taskId}\0${attempt}`;
}

function eventSourceRef(sourceId, eventCursor) {
  return `bridge:${sourceId}:${eventCursor}`;
}

function statusFromEvents(events, fallback) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event_type === "turn_failed") return "failed";
    if (events[index].event_type === "turn_completed") return "completed";
  }
  return fallback ?? "unknown";
}

function modelFromEvents(events, fallback = {}) {
  let model = fallback.model ?? null;
  let provider = fallback.provider ?? null;
  let reasoningEffort = fallback.reasoningEffort ?? null;
  for (const event of events) {
    const details = event.details;
    if (!details) continue;
    const selectedModel = cleanString(details.selected_model, 256);
    if (selectedModel) {
      const parenthesized = /^(.*?)\s+\(([^()]*)\)$/u.exec(selectedModel);
      model = cleanString(parenthesized?.[1] ?? selectedModel, 256);
      provider = cleanString(parenthesized?.[2] ?? provider, 256);
    }
    model = cleanString(details.model_id, 256) ?? model;
    provider = cleanString(details.provider_id, 256) ?? provider;
    reasoningEffort = cleanString(details.reasoning_level, 64) ?? reasoningEffort;
  }
  return { model, provider, reasoningEffort };
}

function buildTools(events, agentId, taskId, turnId, sourceId) {
  const byCall = new Map();
  const unresolvedCursors = new Map();
  const tools = [];
  for (const event of events) {
    const details = event.details;
    if (event.event_type === "model_tool_call" && details) {
      const rawName = cleanString(details.tool_name, 160) ?? "unknown";
      const namespace = cleanString(details.tool_namespace ?? details.namespace, 160);
      const name = normalizeToolName(rawName, namespace);
      const callId = cleanString(details.tool_call_id, 256);
      const tool = {
        tool_event_id: eventSourceRef(sourceId, event.event_cursor),
        call_id: callId,
        agent_id: agentId,
        thread_id: agentId,
        turn_id: cleanString(details.turn_id, 256) ?? turnId,
        response_id: null,
        name,
        namespace,
        kind: isMcpTool(rawName, namespace) || /^zcode_/u.test(name) ? "MCP" : "OTHER",
        started_at: normalizeTimestamp(event.at),
        ended_at: null,
        duration_ms: null,
        output_bytes: null,
        estimated_output_tokens: null,
        estimated_token_evidence: "ESTIMATED",
        status: "UNKNOWN",
        failed: null,
        exit_code: null,
        signature: sha256({ name, namespace, args: details.arguments ?? null }),
        output_hash: null,
        duplicate_of: null,
        state_unchanged: null,
        task_id: taskId,
        command_class: "OTHER",
        wait_ms: nonNegativeSafeInteger(details.wait_ms),
        wait_for: cleanString(details.wait_for, 64),
        content_retained: false,
      };
      tools.push(tool);
      if (callId) {
        byCall.set(callId, tool);
        unresolvedCursors.set(callId, event.event_cursor);
      }
    } else if (event.event_type === "tool_status" && details) {
      const callId = cleanString(details.tool_call_id, 256);
      const tool = callId ? byCall.get(callId) : null;
      if (!tool) continue;
      if (callId) unresolvedCursors.delete(callId);
      tool.ended_at = normalizeTimestamp(event.at);
      tool.status = /^(?:failed|failure|error)$/iu.test(details.state ?? "")
        ? "FAILURE"
        : /^(?:completed|success|succeeded|done)$/iu.test(details.state ?? "")
          ? "SUCCESS"
          : "UNKNOWN";
      tool.failed = tool.status === "FAILURE" ? true : tool.status === "SUCCESS" ? false : null;
      tool.output_bytes = nonNegativeSafeInteger(details.output_bytes);
      tool.estimated_output_tokens = estimatedTokensFromBytes(tool.output_bytes);
      tool.output_hash = cleanString(details.output_hash, 128);
      tool.exit_code = nonNegativeSafeInteger(details.exit_code);
      const startMs = timestampMs(tool.started_at);
      const endMs = timestampMs(tool.ended_at);
      tool.duration_ms = startMs !== null && endMs !== null && endMs >= startMs
        ? endMs - startMs
        : nonNegativeSafeInteger(details.duration_ms);
    }
  }
  return {
    tools,
    resume_before_cursor: unresolvedCursors.size > 0
      ? Math.min(...unresolvedCursors.values())
      : null,
  };
}

function addDuplicateEvidence(tools) {
  const seen = new Map();
  for (const tool of tools) {
    const key = `${tool.agent_id}\0${tool.name}\0${tool.signature}`;
    const previous = seen.get(key);
    if (previous) {
      tool.duplicate_of = previous.tool_event_id;
      tool.state_unchanged = previous.output_hash !== null
        && tool.output_hash !== null
        && previous.output_hash === tool.output_hash;
    }
    seen.set(key, tool);
  }
}

export function buildBridgeAgents({
  sourceId,
  tasks = [],
  attempts = [],
  runtimeEvents = [],
  operations = [],
  operationEvents = [],
}) {
  const taskMap = new Map(tasks.map((task) => [task.task_id, task]));
  const attemptMap = new Map(
    attempts.map((attempt) => [operationKey(attempt.task_id, attempt.attempt), attempt]),
  );
  const operationByTask = new Map();
  for (const operation of operations) {
    if (!operation.task_id || !Number.isSafeInteger(operation.attempt)) continue;
    operationByTask.set(operationKey(operation.task_id, operation.attempt), operation);
  }
  const operationEventMap = new Map();
  for (const event of operationEvents) {
    if (!operationEventMap.has(event.operation_id)) operationEventMap.set(event.operation_id, []);
    operationEventMap.get(event.operation_id).push(event);
  }
  const runtimeMap = new Map();
  for (const event of runtimeEvents) {
    const key = operationKey(event.task_id, event.attempt);
    if (!runtimeMap.has(key)) runtimeMap.set(key, []);
    runtimeMap.get(key).push(event);
  }

  const keys = new Set([
    ...attemptMap.keys(),
    ...operationByTask.keys(),
    ...runtimeMap.keys(),
  ]);
  const agents = [];
  const toolsOut = [];
  const contextItems = [];
  const bridgeTasks = [];
  const checkpoints = [];
  const closures = [];
  let resumeBeforeCursor = null;

  for (const key of [...keys].sort()) {
    const sampleAttempt = attemptMap.get(key);
    const sampleOperation = operationByTask.get(key);
    const taskId = sampleAttempt?.task_id ?? sampleOperation?.task_id ?? key.split("\0")[0];
    const attemptNumber = sampleAttempt?.attempt ?? sampleOperation?.attempt ?? Number(key.split("\0")[1]);
    if (!taskId || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) continue;
    const task = taskMap.get(taskId) ?? {};
    const events = (runtimeMap.get(key) ?? []).sort((left, right) => (
      left.event_cursor - right.event_cursor
      || left.worker_sequence - right.worker_sequence
    )).map((event) => ({
      ...event,
      details: parseDetails(event.details_json),
    }));
    const lifecycleEvents = sampleOperation
      ? (operationEventMap.get(sampleOperation.operation_id) ?? []).sort((left, right) => (
          left.event_cursor - right.event_cursor
        ))
      : [];
    const agentId = `worker:${taskId}:${attemptNumber}`;
    const model = modelFromEvents(events, {
      model: sampleOperation?.result_model,
      provider: null,
      reasoningEffort: null,
    });
    const sessionReady = events.find((event) => event.event_type === "session_ready");
    const sessionId = cleanString(sessionReady?.details?.session_id, 256);
    const responseUsages = [];
    const responseIds = [];
    const turnSeen = new Set();
    for (const event of events) {
      if (event.event_type !== "turn_completed" || !event.details) continue;
      const turnId = cleanString(event.details.turn_id, 256)
        ?? `event:${event.event_cursor}`;
      if (turnSeen.has(turnId)) continue;
      turnSeen.add(turnId);
      const usage = normalizeUsage(event.details.usage, {
        model: model.model,
        provider: model.provider,
        reasoningEffort: model.reasoningEffort,
      });
      const responseId = `bridge-turn:${sourceId}:${event.event_cursor}`;
      responseIds.push(responseId);
      responseUsages.push({
        response_id: responseId,
        agent_id: agentId,
        thread_id: agentId,
        turn_id: turnId,
        root_turn_id: null,
        model: model.model,
        provider: model.provider,
        reasoning_effort: model.reasoningEffort,
        observed_at: normalizeTimestamp(event.at),
        usage,
        usage_unknown: usageIsUnknown(usage),
        event_ref: eventSourceRef(sourceId, event.event_cursor),
        evidence_level: usageIsUnknown(usage) ? "UNKNOWN" : "OBSERVED",
        content_retained: false,
      });
    }
    const turnResponses = responseUsages;
    if (turnResponses.length === 0 && isRecord(sampleOperation?.result_usage)) {
      turnResponses.push({
        response_id: `bridge-result:${sourceId}:${sampleOperation.operation_id}`,
        agent_id: agentId,
        thread_id: agentId,
        turn_id: null,
        root_turn_id: null,
        model: model.model,
        provider: model.provider,
        reasoning_effort: model.reasoningEffort,
        observed_at: normalizeTimestamp(sampleOperation.result_observed_at),
        usage: normalizeUsage(sampleOperation.result_usage, {
          model: model.model,
          provider: model.provider,
          reasoningEffort: model.reasoningEffort,
        }),
        usage_unknown: false,
        event_ref: `bridge:${sourceId}:result:${sampleOperation.operation_id}`,
        evidence_level: "OBSERVED",
        content_retained: false,
      });
    }
    const builtTools = buildTools(events, agentId, taskId, null, sourceId);
    const agentTools = builtTools.tools;
    if (builtTools.resume_before_cursor !== null) {
      resumeBeforeCursor = resumeBeforeCursor === null
        ? builtTools.resume_before_cursor
        : Math.min(resumeBeforeCursor, builtTools.resume_before_cursor);
    }
    addDuplicateEvidence(agentTools);
    toolsOut.push(...agentTools);
    for (const event of events) {
      if (event.event_type !== "model_output") continue;
      const bytes = Buffer.byteLength(event.summary ?? "", "utf8");
      contextItems.push({
        context_event_id: eventSourceRef(sourceId, event.event_cursor),
        agent_id: agentId,
        observed_at: normalizeTimestamp(event.at),
        category: "conversation_message",
        tool_name: null,
        path_hash: null,
        bytes,
        estimated_tokens: estimatedTokensFromBytes(bytes),
        evidence_level: "ESTIMATED",
        content_retained: false,
      });
    }
    const timestamps = events.map((event) => normalizeTimestamp(event.at)).filter(Boolean);
    const lifecycleTimestamps = lifecycleEvents.map((event) => normalizeTimestamp(event.at)).filter(Boolean);
    const allTimestamps = timestamps.concat(lifecycleTimestamps);
    const startedAt = allTimestamps.sort()[0] ?? normalizeTimestamp(sampleAttempt?.created_at)
      ?? normalizeTimestamp(task.created_at);
    const endedAt = allTimestamps.sort().at(-1) ?? null;
    const unknownResponseCount = turnResponses.filter((response) => usageIsUnknown(response.usage)).length;
    const usage = createAggregateUsage({
      responseUsages: turnResponses.map((response) => response.usage).filter(Boolean),
      unknownUsageResponseCount: unknownResponseCount,
      model: model.model,
      provider: model.provider,
      reasoningEffort: model.reasoningEffort,
      source: "bridge_sqlite",
    });
    const latestEventCursor = events.reduce(
      (maximum, event) => Math.max(maximum, event.event_cursor ?? 0),
      0,
    );
    agents.push({
      agent_id: agentId,
      kind: "WORKER",
      parent_agent_id: null,
      parent_thread_id: null,
      root_agent_id: null,
      goal_id: `bridge:${taskId}`,
      thread_id: agentId,
      session_id: sessionId,
      root_thread_id: null,
      task_id: taskId,
      nickname: null,
      agent_path: null,
      model: model.model,
      provider: model.provider,
      reasoning_effort: model.reasoningEffort,
      started_at: startedAt ?? null,
      ended_at: endedAt,
      duration_ms: startedAt && endedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : null,
      response_count: turnResponses.length,
      unknown_usage_response_count: unknownResponseCount,
      usage,
      context_window: null,
      source_refs: [sourceId],
      correlation: {
        status: "UNRESOLVED",
        evidence: "bridge_task_identity",
      },
      warnings: [],
      content_retained: false,
    });
    closures.push({
      agent_id: agentId,
      latest_event_cursor: latestEventCursor,
    });
    bridgeTasks.push({
      task_id: taskId,
      attempt: attemptNumber,
      generation: sampleAttempt?.generation ?? sampleOperation?.generation ?? null,
      task_status: task.status ?? sampleAttempt?.status ?? null,
      result_status: sampleOperation?.result_status ?? null,
      operation_phase: sampleOperation?.phase ?? null,
      session_id: sessionId,
      model: model.model,
      provider: model.provider,
      reasoning_effort: model.reasoningEffort,
      execution_started_at: startedAt ?? null,
      execution_ended_at: endedAt,
      execution_duration_ms: startedAt && endedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : null,
      turn_count: turnResponses.length,
      status: statusFromEvents(events, task.status ?? sampleAttempt?.status),
      tool_call_count: agentTools.length,
      source_ref: eventSourceRef(sourceId, latestEventCursor || 0),
      content_retained: false,
    });
  }

  const responses = agents.flatMap((agent) => {
    const key = operationKey(agent.task_id, Number(agent.agent_id.split(":").at(-1)));
    const events = runtimeMap.get(key) ?? [];
    const turnSeen = new Set();
    return events
      .filter((event) => event.event_type === "turn_completed")
      .filter((event) => {
        const turnId = cleanString(event.details?.turn_id, 256)
          ?? `event:${event.event_cursor}`;
        if (turnSeen.has(turnId)) return false;
        turnSeen.add(turnId);
        return true;
      })
      .map((event) => {
        const details = parseDetails(event.details_json);
        const usage = normalizeUsage(details?.usage, {
          model: agent.model,
          provider: agent.provider,
          reasoningEffort: agent.reasoning_effort,
        });
        return {
          response_id: `bridge-turn:${sourceId}:${event.event_cursor}`,
          agent_id: agent.agent_id,
          thread_id: agent.thread_id,
          turn_id: cleanString(details?.turn_id, 256),
          root_turn_id: null,
          model: agent.model,
          provider: agent.provider,
          reasoning_effort: agent.reasoning_effort,
          observed_at: normalizeTimestamp(event.at),
          usage,
          usage_unknown: usageIsUnknown(usage),
          event_ref: eventSourceRef(sourceId, event.event_cursor),
          evidence_level: usageIsUnknown(usage) ? "UNKNOWN" : "OBSERVED",
          content_retained: false,
        };
      });
  });
  if (responses.length === 0) {
    for (const agent of agents) {
      const key = operationKey(agent.task_id, Number(agent.agent_id.split(":").at(-1)));
      const operation = operationByTask.get(key);
      if (!isRecord(operation?.result_usage)) continue;
      const usage = normalizeUsage(operation.result_usage, {
        model: agent.model,
        provider: agent.provider,
        reasoningEffort: agent.reasoning_effort,
      });
      responses.push({
        response_id: `bridge-result:${sourceId}:${operation.operation_id}`,
        agent_id: agent.agent_id,
        thread_id: agent.thread_id,
        turn_id: null,
        root_turn_id: null,
        model: agent.model,
        provider: agent.provider,
        reasoning_effort: agent.reasoning_effort,
        observed_at: normalizeTimestamp(operation.result_observed_at),
        usage,
        usage_unknown: usageIsUnknown(usage),
        event_ref: `bridge:${sourceId}:result:${operation.operation_id}`,
        evidence_level: usageIsUnknown(usage) ? "UNKNOWN" : "OBSERVED",
        content_retained: false,
      });
    }
  }

  return {
    agents,
    responses,
    tools: toolsOut,
    context_items: contextItems,
    bridge_tasks: bridgeTasks,
    usage_checkpoints: checkpoints,
    closures,
    resume_before_cursor: resumeBeforeCursor,
  };
}

export function collectBridgeSqliteSource(source, options = {}) {
  if (!existsSync(source.path)) {
    return {
      agents: [],
      responses: [],
      tools: [],
      context_items: [],
      compactions: [],
      bridge_tasks: [],
      usage_checkpoints: [],
      warnings: [{ code: "bridge_sqlite_absent", source_id: source.source_id }],
      scan: { next_event_cursor: options.startEventCursor ?? 0, schema_version: null },
    };
  }
  let db;
  try {
    db = new DatabaseSync(source.path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    const tables = tableNames(db);
    const userVersion = db.prepare("PRAGMA user_version").get()?.user_version ?? null;
    const taskColumns = tables.has("tasks") ? tableColumns(db, "tasks") : new Set();
    const taskSelect = taskColumns.has("task_json")
      ? `task_id,status,current_attempt,created_at,
         json_extract(task_json,'$.model.model_id') AS task_model_id,
         json_extract(task_json,'$.model.provider_id') AS task_provider_id`
      : "task_id,status,current_attempt,created_at,NULL AS task_model_id,NULL AS task_provider_id";
    const tasks = allIfPresent(
      db,
      tables,
      "tasks",
      `SELECT ${taskSelect} FROM tasks ORDER BY task_id`,
    );
    const attempts = allIfPresent(
      db,
      tables,
      "attempts",
      "SELECT task_id,attempt,generation,status,created_at FROM attempts ORDER BY task_id,attempt",
    );
    const startEventCursor = nonNegativeSafeInteger(options.startEventCursor) ?? 0;
    const runtimeEvents = allIfPresent(
      db,
      tables,
      "runtime_task_events",
      `SELECT event_cursor,task_id,attempt,event_type,at,summary,details_json
       FROM runtime_task_events
       WHERE event_cursor>${startEventCursor}
       ORDER BY event_cursor`,
    );
    const operationColumns = tables.has("manager_operations")
      ? tableColumns(db, "manager_operations")
      : new Set();
    let operationSelect = "operation_id,task_id,attempt,generation,phase,created_at";
    if (operationColumns.has("result_status")) operationSelect += ",result_status";
    else operationSelect += ",NULL AS result_status";
    if (operationColumns.has("result_json")) {
      operationSelect += `,
        json_extract(result_json,'$.model') AS result_model,
        json_extract(result_json,'$.usage') AS result_usage,
        json_extract(result_json,'$.timing.finished_at') AS result_observed_at`;
    } else {
      operationSelect += ",NULL AS result_model,NULL AS result_usage,NULL AS result_observed_at";
    }
    const operations = allIfPresent(
      db,
      tables,
      "manager_operations",
      `SELECT ${operationSelect} FROM manager_operations
       WHERE operation_kind='attempt_lifecycle' ORDER BY created_at,operation_id`,
    ).map((operation) => ({
      ...operation,
      result_usage: parseJsonLoose(operation.result_usage),
    }));
    const operationEvents = allIfPresent(
      db,
      tables,
      "manager_operation_events",
      `SELECT event_cursor,operation_id,event_type,to_phase,at
       FROM manager_operation_events ORDER BY event_cursor`,
    );
    const built = buildBridgeAgents({
      sourceId: source.source_id,
      tasks,
      attempts,
      runtimeEvents,
      operations,
      operationEvents,
    });
    const nextEventCursor = runtimeEvents.reduce(
      (maximum, event) => Math.max(maximum, event.event_cursor ?? 0),
      startEventCursor,
    );
    return {
      ...built,
      compactions: [],
      warnings: [],
      scan: {
        next_event_cursor: nextEventCursor,
        schema_version: userVersion,
        table_count: tables.size,
      },
    };
  } catch (error) {
    return {
      agents: [],
      responses: [],
      tools: [],
      context_items: [],
      compactions: [],
      bridge_tasks: [],
      usage_checkpoints: [],
      warnings: [{
        code: "bridge_sqlite_read_failed",
        source_id: source.source_id,
        message: error instanceof Error ? error.name : "unknown_error",
      }],
      scan: { next_event_cursor: options.startEventCursor ?? 0, schema_version: null },
    };
  } finally {
    db?.close();
  }
}
