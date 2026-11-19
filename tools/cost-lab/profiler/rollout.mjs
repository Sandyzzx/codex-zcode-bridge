import path from "node:path";
import {
  MCP_POLL_TOOL_NAMES,
  MCP_TOOL_NAMES,
} from "./constants.mjs";
import {
  readJsonLinesFromOffset,
  readZstdJsonLines,
} from "./source-reader.mjs";
import {
  normalizeUsage,
  normalizeUsageCheckpoint,
  usageFromTokenCountPayload,
  usageIsUnknown,
} from "./usage.mjs";
import {
  classifyCommand,
  cleanString,
  estimatedTokensFromBytes,
  isMcpTool,
  isRecord,
  normalizeTimestamp,
  normalizeToolName,
  nonNegativeSafeInteger,
  parseJsonLoose,
  sha256,
  stableStringify,
  timestampMs,
  valueBytes,
} from "./util.mjs";

function eventRef(sourceId, ordinal) {
  return `${sourceId}:${ordinal}`;
}

const SKIPPED_TOP_LEVEL_TYPES = new Set([
  "world_state",
  "inter_agent_communication_metadata",
  "message",
  "reasoning",
  "interaction_requested",
]);
const MAX_TOKEN_COUNT_FALLBACK_RESPONSES = 10_000;

function skipTopLevelRecord(value) {
  return isRecord(value) && SKIPPED_TOP_LEVEL_TYPES.has(value.type);
}

function contextItem({
  sourceId,
  ordinal,
  agentId,
  category,
  bytes,
  timestamp,
  toolName = null,
  pathHash = null,
}) {
  const safeBytes = nonNegativeSafeInteger(bytes) ?? 0;
  return {
    context_event_id: eventRef(sourceId, ordinal),
    agent_id: agentId,
    observed_at: normalizeTimestamp(timestamp),
    category,
    tool_name: toolName,
    path_hash: pathHash,
    bytes: safeBytes,
    estimated_tokens: estimatedTokensFromBytes(safeBytes),
    evidence_level: "ESTIMATED",
    content_retained: false,
  };
}

function detectStructuredFailure(value) {
  const parsed = parseJsonLoose(value);
  if (!isRecord(parsed)) {
    if (typeof value === "string" && /^\s*(?:error|failed|exception)\b/iu.test(value)) {
      return true;
    }
    return null;
  }
  if (parsed.success === false || parsed.ok === false) return true;
  if (typeof parsed.error === "string" && parsed.error.trim()) return true;
  if (typeof parsed.error_code === "string" && parsed.error_code.trim()) return true;
  if (typeof parsed.status === "string" && /^(?:failed|failure|error)$/iu.test(parsed.status)) {
    return true;
  }
  if (parsed.success === true || parsed.ok === true) return false;
  if (typeof parsed.status === "string" && /^(?:completed|ok|success)$/iu.test(parsed.status)) {
    return false;
  }
  return null;
}

function failedFromCallPayload(payload) {
  const status = payload?.status;
  if (typeof status === "string" && /^(?:failed|failure|error)$/iu.test(status)) return true;
  return null;
}

function extractTaskId(args) {
  if (!isRecord(args)) return null;
  return cleanString(args.task_id ?? args.taskId, 256);
}

function extractWaitMs(args) {
  if (!isRecord(args)) return null;
  return nonNegativeSafeInteger(args.wait_ms ?? args.waitMs);
}

function extractWaitFor(args) {
  if (!isRecord(args)) return null;
  return cleanString(args.wait_for ?? args.waitFor, 64);
}

function durationMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (!isRecord(value)) return null;
  const seconds = nonNegativeSafeInteger(value.secs ?? value.seconds) ?? 0;
  const nanoseconds = nonNegativeSafeInteger(value.nanos ?? value.nanoseconds) ?? 0;
  if (seconds === 0 && nanoseconds === 0 && value.secs === undefined && value.seconds === undefined) {
    return null;
  }
  return seconds * 1000 + nanoseconds / 1_000_000;
}

function timestampFromEpochMs(value) {
  return Number.isFinite(value) && value >= 0 ? new Date(value).toISOString() : null;
}

function isFileReadCommand(command, commandClass) {
  if (typeof command !== "string") return false;
  if (commandClass !== "OTHER" && commandClass !== "REVIEW") return false;
  return /\b(?:get-content|select-string|rg|ripgrep|cat|type|head|tail|git\s+(?:diff|show|log|status|blame))\b/iu
    .test(command);
}

function buildTool({
  sourceId,
  ordinal,
  agentId,
  payload,
  timestamp,
  activeTurnId,
  activeModel,
}) {
  const args = parseJsonLoose(payload.arguments);
  const rawName = cleanString(payload.name, 160) ?? "unknown";
  const namespace = cleanString(payload.namespace, 160);
  const name = normalizeToolName(rawName, namespace);
  const command = isRecord(args) && typeof args.cmd === "string"
    ? args.cmd
    : isRecord(args) && typeof args.command === "string"
      ? args.command
      : null;
  const commandClass = name === "apply_patch" || name === "write_file" || name === "edit_file"
    ? "IMPLEMENTATION"
    : classifyCommand(command);
  const mcp = isMcpTool(rawName, namespace) || MCP_TOOL_NAMES.includes(name);
  return {
    tool_event_id: eventRef(sourceId, ordinal),
    call_id: cleanString(payload.call_id ?? payload.id, 256),
    agent_id: agentId,
    thread_id: agentId,
    turn_id: activeTurnId,
    response_id: null,
    name,
    namespace,
    kind: mcp ? "MCP" : command !== null || name === "exec_command" ? "SHELL" : "OTHER",
    started_at: normalizeTimestamp(timestamp),
    ended_at: null,
    duration_ms: null,
    output_bytes: null,
    estimated_output_tokens: null,
    estimated_token_evidence: "ESTIMATED",
    status: "UNKNOWN",
    failed: failedFromCallPayload(payload),
    exit_code: null,
    signature: sha256({
      name,
      namespace,
      arguments: args ?? payload.arguments ?? null,
    }),
    output_hash: null,
    duplicate_of: null,
    state_unchanged: null,
    task_id: extractTaskId(args),
    command_class: mcp
      ? "MCP"
      : isFileReadCommand(command, commandClass)
        ? commandClass
        : commandClass,
    wait_ms: extractWaitMs(args),
    wait_for: extractWaitFor(args),
    content_retained: false,
    model: activeModel,
    _command: command,
    _is_file_read: isFileReadCommand(command, commandClass),
  };
}

function contextPayloadBytes(payload) {
  switch (payload.type) {
    case "message":
      return valueBytes(payload.content);
    case "reasoning":
      return valueBytes(payload.summary ?? payload.content);
    case "agent_message":
      return valueBytes(payload.content ?? payload.message);
    default:
      return null;
  }
}

function contextCategoryForMessage(payload) {
  if (payload.type === "agent_message") return "agent_instruction";
  if (payload.role === "system") return "system_prompt";
  if (payload.role === "developer") return "developer_prompt";
  if (payload.role === "user") return "user_message";
  return "conversation_message";
}

function finishTool(tool, payload, timestamp) {
  const output = payload.output ?? payload.result ?? null;
  tool.ended_at = normalizeTimestamp(timestamp);
  tool.output_bytes = valueBytes(output);
  tool.estimated_output_tokens = estimatedTokensFromBytes(tool.output_bytes);
  tool.output_hash = output === null || output === undefined ? null : sha256(output);
  const structuredFailure = detectStructuredFailure(output);
  if (structuredFailure !== null) tool.failed = structuredFailure;
  if (typeof payload.status === "string") {
    if (/^(?:failed|failure|error)$/iu.test(payload.status)) tool.failed = true;
    else if (/^(?:completed|success|succeeded|done)$/iu.test(payload.status)) tool.failed = false;
  }
  tool.status = tool.failed === true
    ? "FAILURE"
    : tool.failed === false
      ? "SUCCESS"
      : "UNKNOWN";
  const endedMs = timestampMs(tool.ended_at);
  const startedMs = timestampMs(tool.started_at);
  tool.duration_ms = endedMs !== null && startedMs !== null && endedMs >= startedMs
    ? endedMs - startedMs
    : null;
}

function enrichMcpItem({
  item,
  payload,
  timestamp,
  tools,
  callsById,
  sourceId,
  ordinal,
  agentId,
  activeTurnId,
}) {
  if (!isRecord(item)) return null;
  const itemType = cleanString(item.type, 64);
  if (itemType !== "McpToolCall") return null;
  const callId = cleanString(item.id, 256);
  let tool = callId ? callsById.get(callId) : null;
  if (!tool) {
    const args = parseJsonLoose(item.arguments);
    const rawName = cleanString(item.tool, 160) ?? "unknown";
    const namespace = cleanString(item.server, 160);
    const name = normalizeToolName(rawName, namespace);
    tool = {
      tool_event_id: eventRef(sourceId, ordinal),
      call_id: callId,
      agent_id: agentId,
      thread_id: agentId,
      turn_id: cleanString(payload.turn_id, 256) ?? activeTurnId,
      response_id: null,
      name,
      namespace,
      kind: "MCP",
      started_at: timestampFromEpochMs(payload.started_at_ms),
      ended_at: timestampFromEpochMs(payload.completed_at_ms) ?? normalizeTimestamp(timestamp),
      duration_ms: durationMs(item.duration),
      output_bytes: null,
      estimated_output_tokens: null,
      estimated_token_evidence: "ESTIMATED",
      status: /^(?:failed|failure|error)$/iu.test(item.status ?? "")
        ? "FAILURE"
        : /^(?:completed|success|succeeded|done)$/iu.test(item.status ?? "")
          ? "SUCCESS"
          : "UNKNOWN",
      failed: item.result?.isError === true
        ? true
        : /^(?:failed|failure|error)$/iu.test(item.status ?? "")
          ? true
          : /^(?:completed|success|succeeded|done)$/iu.test(item.status ?? "")
            ? false
            : null,
      exit_code: null,
      signature: sha256({ name, namespace, arguments: args ?? item.arguments ?? null }),
      output_hash: null,
      duplicate_of: null,
      state_unchanged: null,
      task_id: extractTaskId(args),
      command_class: "MCP",
      wait_ms: extractWaitMs(args),
      wait_for: extractWaitFor(args),
      content_retained: false,
    };
    tools.push(tool);
    if (callId) callsById.set(callId, tool);
  } else {
    tool.started_at = timestampFromEpochMs(payload.started_at_ms) ?? tool.started_at;
    tool.ended_at = timestampFromEpochMs(payload.completed_at_ms)
      ?? normalizeTimestamp(timestamp)
      ?? tool.ended_at;
    tool.duration_ms = durationMs(item.duration) ?? tool.duration_ms;
    if (item.result?.isError === true) {
      tool.failed = true;
      tool.status = "FAILURE";
    } else if (
      typeof item.status === "string"
      && /^(?:completed|success|succeeded|done)$/iu.test(item.status)
      && tool.status === "UNKNOWN"
    ) {
      tool.failed = false;
      tool.status = "SUCCESS";
    }
  }
  return tool;
}

function contextCategoryForTool(tool) {
  if (tool.kind === "MCP") return "mcp_tool_output";
  if (tool._is_file_read) return "file_read";
  if (tool.kind === "SHELL") return "shell_output";
  return "tool_output";
}

function selectLatestCheckpoint(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = timestampMs(left.observed_at) ?? -1;
  const rightTime = timestampMs(right.observed_at) ?? -1;
  return rightTime >= leftTime ? right : left;
}

function finalizeToolFlags(tools) {
  const seen = new Map();
  const sorted = [...tools].sort((left, right) => (
    (timestampMs(left.started_at) ?? 0) - (timestampMs(right.started_at) ?? 0)
    || left.tool_event_id.localeCompare(right.tool_event_id)
  ));
  for (const tool of sorted) {
    const stateKey = `${tool.agent_id}\0${tool.name}\0${tool.signature}`;
    const previous = seen.get(stateKey);
    if (previous) {
      tool.duplicate_of = previous.tool_event_id;
      tool.state_unchanged = previous.output_hash !== null
        && tool.output_hash !== null
        && previous.output_hash === tool.output_hash;
    }
    seen.set(stateKey, tool);
  }
  return sorted;
}

function responseFromTokenRecord(agent, payload, timestamp, sourceId, ordinal, model, effort) {
  const usage = payload.usage === undefined ? null : normalizeUsage(payload.usage, {
    model,
    provider: agent.provider,
    reasoningEffort: effort,
  });
  const responseId = cleanString(payload.response_id, 256)
    ?? eventRef(sourceId, ordinal);
  return {
    response_id: responseId,
    agent_id: agent.agent_id,
    thread_id: agent.thread_id,
    turn_id: cleanString(payload.turn_id, 256),
    root_turn_id: cleanString(payload.root_turn_id, 256),
    model,
    provider: agent.provider,
    reasoning_effort: effort,
    observed_at: normalizeTimestamp(timestamp),
    usage,
    usage_unknown: usageIsUnknown(usage),
    event_ref: eventRef(sourceId, ordinal),
    evidence_level: usageIsUnknown(usage) ? "UNKNOWN" : "OBSERVED",
    content_retained: false,
  };
}

function compactionRecord(agent, payload, timestamp, sourceId, ordinal, previousUsage, previousCheckpoint) {
  const latest = payload.latest_token_usage_record;
  const latestThreadUsage = isRecord(latest) && isRecord(latest.thread_token_usage)
    ? normalizeUsage(latest.thread_token_usage, {
        model: agent.model,
        provider: agent.provider,
        reasoningEffort: agent.reasoning_effort,
      })
    : null;
  const compactionUsage = isRecord(latest) && isRecord(latest.usage)
    ? normalizeUsage(latest.usage, {
        model: agent.model,
        provider: agent.provider,
        reasoningEffort: agent.reasoning_effort,
      })
    : null;
  const after = compactionUsage ?? latestThreadUsage;
  const before = previousUsage ?? null;
  const retainedBytes = valueBytes(payload.retained_context);
  const replacementBytes = valueBytes(payload.replacement_history);
  return {
    compaction_id: eventRef(sourceId, ordinal),
    agent_id: agent.agent_id,
    thread_id: agent.thread_id,
    observed_at: normalizeTimestamp(timestamp),
    window_number: nonNegativeSafeInteger(payload.window_number),
    previous_window_id: cleanString(payload.previous_window_id, 256),
    window_id: cleanString(payload.window_id, 256),
    before_usage: before ?? null,
    after_usage: after ?? null,
    cumulative_before_usage: previousCheckpoint?.usage ?? null,
    cumulative_after_usage: latestThreadUsage ?? null,
    input_change_tokens: before?.input_tokens !== null
      && before?.input_tokens !== undefined
      && after?.input_tokens !== null
      && after?.input_tokens !== undefined
      ? after.input_tokens - before.input_tokens
      : null,
    replacement_item_count: Array.isArray(payload.replacement_history)
      ? payload.replacement_history.length
      : null,
    replacement_bytes: replacementBytes,
    retained_context_bytes: retainedBytes,
    estimated_retained_context_tokens: estimatedTokensFromBytes(retainedBytes),
    evidence_level: "ESTIMATED",
    content_retained: false,
  };
}

export async function parseRolloutJsonl(source, options = {}) {
  const sourceId = source.source_id;
  const warnings = [];
  let scan;
  try {
    if (source.compression === "zstd") {
      const zstdCodec = options.zstdCodec === null
        ? null
        : options.zstdCodec ?? {};
      const codec = zstdCodec && typeof zstdCodec.createDecompress === "function"
        ? zstdCodec.createDecompress
        : undefined;
      scan = await readZstdJsonLines(source.path, {
        chunkBytes: options.chunkBytes,
        maxBytes: options.maxBytes,
        ...(zstdCodec === null
          ? { createDecompress: null }
          : codec
            ? { createDecompress: codec }
            : {}),
        skipValue: skipTopLevelRecord,
      });
    } else {
      scan = await readJsonLinesFromOffset(source.path, {
        startOffset: options.startOffset ?? 0,
        chunkBytes: options.chunkBytes,
        maxBytes: options.maxBytes,
        skipValue: skipTopLevelRecord,
      });
    }
  } catch (error) {
    const code = error?.code === "zstd_unavailable"
      ? "rollout_zstd_unavailable"
      : "rollout_source_read_failed";
    warnings.push({ code, source_id: sourceId });
    scan = {
      records: [],
      start_offset: 0,
      next_offset: 0,
      bytes_read: 0,
      file_size: source.size_bytes ?? null,
      invalid_json_lines: 0,
      skipped_lines: 0,
      partial_tail_bytes: 0,
      reset_from_truncated_source: false,
    };
  }
  if (scan.invalid_json_lines > 0) {
    warnings.push({
      code: "rollout_invalid_json_lines",
      source_id: sourceId,
      count: scan.invalid_json_lines,
    });
  }
  if (scan.partial_tail_bytes > 0) {
    warnings.push({
      code: "rollout_partial_tail_deferred",
      source_id: sourceId,
      bytes: scan.partial_tail_bytes,
    });
  }
  if (scan.reset_from_truncated_source) {
    warnings.push({ code: "rollout_source_truncated_rescan", source_id: sourceId });
  }

  let meta = null;
  const hint = isRecord(options.agentHint) ? options.agentHint : null;
  let threadId = cleanString(hint?.thread_id, 256) ?? `unresolved:${sourceId}`;
  let agentId = threadId;
  let sourceRole = hint?.kind ?? "UNKNOWN";
  let activeTurnId = null;
  let activeRootTurnId = null;
  let activeModel = cleanString(hint?.model, 256);
  let activeEffort = cleanString(hint?.reasoning_effort, 64);
  let contextWindow = nonNegativeSafeInteger(hint?.context_window);
  if (hint) {
    meta = {
      id: threadId,
      session_id: cleanString(hint.session_id, 256),
      parent_thread_id: cleanString(hint.parent_thread_id, 256),
      agent_nickname: cleanString(hint.nickname, 128),
      agent_path: cleanString(hint.agent_path, 512),
      thread_source: sourceRole === "SUBAGENT" ? "subagent" : null,
      originator: null,
      cli_version: null,
      model_provider: cleanString(hint.provider, 256),
      context_window: contextWindow,
    };
  }
  const responses = [];
  const checkpoints = [];
  const tokenCountLastCheckpoints = [];
  let tokenCountFallbackBounded = false;
  const tools = [];
  let latestCheckpoint = null;
  let latestResponseUsage = null;
  let pendingCalls = [];
  const callsById = new Map();
  const unresolvedCallOffsets = new Map();
  const contextItems = [];
  const compactions = [];
  let lastOrdinal = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (let index = 0; index < scan.records.length; index += 1) {
    const record = scan.records[index];
    const value = record.value;
    if (!isRecord(value)) continue;
    const payload = isRecord(value.payload) ? value.payload : {};
    const ordinal = Number.isSafeInteger(value.ordinal) ? value.ordinal : index;
    const timestamp = normalizeTimestamp(value.timestamp ?? payload.timestamp);
    lastOrdinal = ordinal;
    if (timestamp) {
      if (firstTimestamp === null) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }

    if (value.type === "session_meta") {
      meta = {
        id: cleanString(payload.id, 256),
        session_id: cleanString(payload.session_id, 256),
        parent_thread_id: cleanString(payload.parent_thread_id, 256),
        agent_nickname: cleanString(payload.agent_nickname, 128),
        agent_path: cleanString(payload.agent_path, 512),
        thread_source: cleanString(payload.thread_source, 64),
        originator: cleanString(payload.originator, 128),
        cli_version: cleanString(payload.cli_version, 128),
        model_provider: cleanString(payload.model_provider, 256),
        context_window: nonNegativeSafeInteger(payload.context_window),
      };
      threadId = meta.id ?? meta.session_id ?? threadId;
      agentId = threadId;
      const sourceObject = isRecord(payload.source) ? payload.source : null;
      const spawned = sourceObject && isRecord(sourceObject.subagent);
      if (spawned || meta.thread_source === "subagent" || meta.parent_thread_id) {
        sourceRole = "SUBAGENT";
      } else {
        sourceRole = "MASTER";
      }
      if (meta.context_window !== null) contextWindow = meta.context_window;
      if (payload.base_instructions !== undefined && payload.base_instructions !== null) {
        contextItems.push(contextItem({
          sourceId,
          ordinal,
          agentId,
          category: "base_instructions",
          bytes: valueBytes(payload.base_instructions),
          timestamp,
        }));
      }
      continue;
    }

    if (value.type === "turn_context") {
      activeTurnId = cleanString(payload.turn_id, 256) ?? activeTurnId;
      activeRootTurnId = cleanString(payload.root_turn_id, 256) ?? activeRootTurnId;
      activeModel = cleanString(payload.model, 256) ?? activeModel;
      activeEffort = cleanString(payload.effort, 64) ?? activeEffort;
      contextWindow = nonNegativeSafeInteger(payload.model_context_window) ?? contextWindow;
      continue;
    }

    if (value.type === "event_msg") {
      if (payload.type === "task_started") {
        activeTurnId = cleanString(payload.turn_id, 256) ?? activeTurnId;
        activeRootTurnId = cleanString(payload.root_turn_id, 256) ?? activeRootTurnId;
        contextWindow = nonNegativeSafeInteger(payload.model_context_window) ?? contextWindow;
      } else if (payload.type === "token_count") {
        const tokenCount = usageFromTokenCountPayload(payload, {
          model: activeModel,
          provider: meta?.model_provider,
          reasoningEffort: activeEffort,
          observedAt: timestamp,
          eventRef: eventRef(sourceId, ordinal),
        });
        if (tokenCount.cumulative) {
          tokenCount.cumulative.agent_id = agentId;
          checkpoints.push(tokenCount.cumulative);
          latestCheckpoint = selectLatestCheckpoint(latestCheckpoint, tokenCount.cumulative);
          contextWindow = tokenCount.cumulative.model_context_window ?? contextWindow;
        }
        if (tokenCount.last && !usageIsUnknown(tokenCount.last.usage)) {
          tokenCount.last.agent_id = agentId;
          if (tokenCountLastCheckpoints.length < MAX_TOKEN_COUNT_FALLBACK_RESPONSES) {
            tokenCountLastCheckpoints.push(tokenCount.last);
          } else {
            tokenCountFallbackBounded = true;
          }
        }
      } else if (payload.type === "item_completed") {
        const enriched = enrichMcpItem({
          item: payload.item,
          payload,
          timestamp,
          tools,
          callsById,
          sourceId,
          ordinal,
          agentId,
          activeTurnId,
        });
        if (enriched?.call_id && enriched.ended_at) {
          unresolvedCallOffsets.delete(enriched.call_id);
        }
      }
      continue;
    }

    if (value.type === "token_usage_record") {
      const response = responseFromTokenRecord(
        {
          agent_id: agentId,
          thread_id: threadId,
          provider: meta?.model_provider,
          model: activeModel,
        },
        payload,
        timestamp,
        sourceId,
        ordinal,
        activeModel,
        activeEffort,
      );
      responses.push(response);
      if (response.usage && !usageIsUnknown(response.usage)) {
        latestResponseUsage = response.usage;
      }
      if (isRecord(payload.thread_token_usage)) {
        const checkpoint = normalizeUsageCheckpoint(payload.thread_token_usage, {
          model: activeModel,
          provider: meta?.model_provider,
          reasoningEffort: activeEffort,
          observedAt: timestamp,
          eventRef: eventRef(sourceId, ordinal),
          modelContextWindow: contextWindow,
        });
        if (checkpoint) {
          checkpoint.agent_id = agentId;
          checkpoints.push(checkpoint);
          latestCheckpoint = selectLatestCheckpoint(latestCheckpoint, checkpoint);
        }
      }
      for (const tool of pendingCalls) tool.response_id = response.response_id;
      pendingCalls = [];
      continue;
    }

    if (value.type === "compacted") {
      compactions.push(compactionRecord(
        {
          agent_id: agentId,
          thread_id: threadId,
          provider: meta?.model_provider,
          model: activeModel,
          reasoning_effort: activeEffort,
        },
        payload,
        timestamp,
        sourceId,
        ordinal,
        latestResponseUsage,
        latestCheckpoint,
      ));
      continue;
    }

    if (value.type !== "response_item") continue;
    if (payload.type === "function_call") {
      const tool = buildTool({
        sourceId,
        ordinal,
        agentId,
        payload,
        timestamp,
        activeTurnId,
        activeModel,
      });
      tools.push(tool);
      pendingCalls.push(tool);
      if (tool.call_id) callsById.set(tool.call_id, tool);
      if (tool.call_id) unresolvedCallOffsets.set(tool.call_id, record.line_start);
      continue;
    }
    if (payload.type === "custom_tool_call") {
      const tool = buildTool({
        sourceId,
        ordinal,
        agentId,
        payload: {
          ...payload,
          name: cleanString(payload.name, 160) ?? "unknown",
          arguments: payload.arguments ?? payload.input,
        },
        timestamp,
        activeTurnId,
        activeModel,
      });
      tools.push(tool);
      pendingCalls.push(tool);
      if (tool.call_id) callsById.set(tool.call_id, tool);
      if (tool.call_id) unresolvedCallOffsets.set(tool.call_id, record.line_start);
      continue;
    }
    if (payload.type === "function_call_output") {
      const callId = cleanString(payload.call_id, 256);
      const tool = callId ? callsById.get(callId) : null;
      if (tool) {
        finishTool(tool, payload, timestamp);
        if (callId) unresolvedCallOffsets.delete(callId);
        contextItems.push(contextItem({
          sourceId,
          ordinal,
          agentId,
          category: contextCategoryForTool(tool),
          bytes: tool.output_bytes,
          timestamp,
          toolName: tool.name,
          pathHash: tool._is_file_read
            ? sha256({ tool: tool.name, signature: tool.signature })
            : null,
        }));
      }
      continue;
    }
    if (payload.type === "custom_tool_call_output") {
      const callId = cleanString(payload.call_id, 256);
      const tool = callId ? callsById.get(callId) : null;
      if (tool) {
        finishTool(tool, payload, timestamp);
        if (callId) unresolvedCallOffsets.delete(callId);
        contextItems.push(contextItem({
          sourceId,
          ordinal,
          agentId,
          category: contextCategoryForTool(tool),
          bytes: tool.output_bytes,
          timestamp,
          toolName: tool.name,
        }));
      }
      continue;
    }
    if (payload.type === "tool_search_call") {
      const tool = buildTool({
        sourceId,
        ordinal,
        agentId,
        payload: {
          ...payload,
          name: "tool_search",
        },
        timestamp,
        activeTurnId,
        activeModel,
      });
      tools.push(tool);
      pendingCalls.push(tool);
      if (tool.call_id) callsById.set(tool.call_id, tool);
      if (tool.call_id) unresolvedCallOffsets.set(tool.call_id, record.line_start);
      continue;
    }
    if (payload.type === "tool_search_output") {
      const callId = cleanString(payload.call_id, 256);
      const tool = callId ? callsById.get(callId) : null;
      if (tool) {
        finishTool(tool, { output: payload.tools }, timestamp);
        if (callId) unresolvedCallOffsets.delete(callId);
      }
      contextItems.push(contextItem({
        sourceId,
        ordinal,
        agentId,
        category: "mcp_tool_schema",
        bytes: valueBytes(payload.tools),
        timestamp,
      }));
      continue;
    }
    const contextBytes = contextPayloadBytes(payload);
    if (contextBytes !== null) {
      contextItems.push(contextItem({
        sourceId,
        ordinal,
        agentId,
        category: contextCategoryForMessage(payload),
        bytes: contextBytes,
        timestamp,
      }));
    }
  }

  if (responses.length === 0) {
    const useLastUsages = tokenCountLastCheckpoints.length > 0 && !tokenCountFallbackBounded;
    const fallbackCheckpoints = useLastUsages
      ? tokenCountLastCheckpoints
      : latestCheckpoint && !usageIsUnknown(latestCheckpoint.usage)
        ? [latestCheckpoint]
        : [];
    for (const checkpoint of fallbackCheckpoints) {
      responses.push({
        response_id: `token_count-fallback:${checkpoint.event_ref}`,
        agent_id: agentId,
        thread_id: threadId,
        turn_id: null,
        root_turn_id: activeRootTurnId,
        model: activeModel,
        provider: meta?.model_provider ?? null,
        reasoning_effort: activeEffort,
        observed_at: checkpoint.observed_at,
        usage: checkpoint.usage,
        usage_unknown: false,
        event_ref: checkpoint.event_ref,
        usage_source: useLastUsages
          ? "TOKEN_COUNT_LAST_USAGE_FALLBACK"
          : "TOKEN_COUNT_CUMULATIVE_FALLBACK",
        evidence_level: useLastUsages ? "OBSERVED" : "ATTRIBUTED",
        content_retained: false,
      });
    }
    if (fallbackCheckpoints.length > 0) {
      warnings.push({
        code: "rollout_token_count_usage_fallback",
        source_id: sourceId,
        synthesized_response_count: fallbackCheckpoints.length,
        basis: useLastUsages ? "last_token_usage" : "latest_cumulative",
        bounded: tokenCountFallbackBounded,
      });
    }
  }

  const synchronizedTools = finalizeToolFlags(tools);
  const resumeOffset = unresolvedCallOffsets.size > 0
    ? Math.min(...unresolvedCallOffsets.values())
    : null;
  for (const tool of synchronizedTools) {
    delete tool._command;
    delete tool._is_file_read;
    delete tool.model;
  }
  const provider = meta?.model_provider ?? null;
  const rootThreadId = meta?.session_id ?? threadId;
  const usage = {
    responseUsages: responses.map((response) => response.usage).filter(Boolean),
    unknownUsageResponseCount: responses.filter((response) => usageIsUnknown(response.usage)).length,
    checkpoints,
  };
  return {
    source_id: sourceId,
    meta,
    agent: {
      agent_id: agentId,
      kind: sourceRole,
      parent_agent_id: null,
      parent_thread_id: meta?.parent_thread_id ?? null,
      root_agent_id: null,
      goal_id: rootThreadId,
      thread_id: threadId,
      session_id: meta?.session_id ?? null,
      root_thread_id: rootThreadId,
      task_id: null,
      nickname: meta?.agent_nickname ?? null,
      agent_path: meta?.agent_path ?? null,
      model: activeModel,
      provider,
      reasoning_effort: activeEffort,
      started_at: firstTimestamp,
      ended_at: lastTimestamp,
      duration_ms: firstTimestamp && lastTimestamp
        ? Math.max(0, Date.parse(lastTimestamp) - Date.parse(firstTimestamp))
        : null,
      response_count: responses.length,
      unknown_usage_response_count: usage.unknownUsageResponseCount,
      usage,
      context_window: contextWindow,
      source_refs: [sourceId],
      correlation: {
        status: meta?.parent_thread_id ? "EXPLICIT_PARENT" : "ROOT",
        evidence: meta?.parent_thread_id ? "thread_spawn" : "session_meta",
      },
      warnings: [],
      content_retained: false,
    },
    responses,
    usage_checkpoints: checkpoints,
    tools: synchronizedTools,
    context_items: contextItems,
    compactions,
    scan: {
      start_offset: scan.start_offset,
      next_offset: scan.next_offset,
      bytes_read: scan.bytes_read,
      file_size: scan.file_size,
      invalid_json_lines: scan.invalid_json_lines,
      partial_tail_bytes: scan.partial_tail_bytes,
      reset_from_truncated_source: scan.reset_from_truncated_source,
      resume_offset: resumeOffset,
    },
    warnings,
  };
}

export function rolloutMarksMcpPoll(tool) {
  if (!tool || tool.kind !== "MCP") return false;
  return MCP_POLL_TOOL_NAMES.includes(tool.name);
}
