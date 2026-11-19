import {
  PROFILER_SCHEMA_VERSION,
  PROFILER_SNAPSHOT_KIND,
} from "./constants.mjs";
import { collectBridgeHistorySource } from "./bridge-history.mjs";
import { collectBridgeSqliteSource } from "./bridge-sqlite.mjs";
import { correlateProfilerAgents, groupAgentsByGoal } from "./correlate.mjs";
import { discoverProfilerSources } from "./discover.mjs";
import { parseRolloutJsonl } from "./rollout.mjs";
import { assertProfilerSnapshot } from "./schema.mjs";
import { createAggregateUsage, usageIsUnknown } from "./usage.mjs";
import {
  sha256,
  timestampMs,
  uniqueBy,
  normalizeTimestamp,
} from "./util.mjs";

function sourceStateKey(source) {
  return source.source_id;
}

function emptyCollection() {
  return {
    agents: [],
    responses: [],
    usage_checkpoints: [],
    tools: [],
    context_items: [],
    compactions: [],
    bridge_tasks: [],
    warnings: [],
  };
}

function mergeCollection(left, right) {
  const agentsByKey = new Map();
  for (const agent of [...left.agents, ...right.agents]) {
    const key = agent.agent_id;
    const previous = agentsByKey.get(key);
    if (!previous) {
      agentsByKey.set(key, { ...agent });
      continue;
    }
    agentsByKey.set(key, {
      ...previous,
      ...agent,
      parent_thread_id: agent.parent_thread_id ?? previous.parent_thread_id,
      task_id: agent.task_id ?? previous.task_id,
      nickname: agent.nickname ?? previous.nickname,
      agent_path: agent.agent_path ?? previous.agent_path,
      model: agent.model ?? previous.model,
      provider: agent.provider ?? previous.provider,
      reasoning_effort: agent.reasoning_effort ?? previous.reasoning_effort,
      started_at: previous.started_at && agent.started_at
        ? (timestampMs(previous.started_at) <= timestampMs(agent.started_at)
            ? previous.started_at
            : agent.started_at)
        : previous.started_at ?? agent.started_at,
      ended_at: previous.ended_at && agent.ended_at
        ? (timestampMs(previous.ended_at) >= timestampMs(agent.ended_at)
            ? previous.ended_at
            : agent.ended_at)
        : previous.ended_at ?? agent.ended_at,
      source_refs: [...new Set([...(previous.source_refs ?? []), ...(agent.source_refs ?? [])])].sort(),
      warnings: [...new Set([...(previous.warnings ?? []), ...(agent.warnings ?? [])])],
    });
  }
  return {
    agents: [...agentsByKey.values()],
    responses: uniqueBy(
      [...left.responses, ...right.responses],
      (response) => response.response_id ?? response.event_ref,
    ),
    usage_checkpoints: uniqueBy(
      [...left.usage_checkpoints, ...right.usage_checkpoints],
      (checkpoint) => `${checkpoint.agent_id ?? "unknown"}\0${checkpoint.event_ref ?? "unknown"}`,
    ),
    tools: mergeTools(left.tools, right.tools),
    context_items: uniqueBy(
      [...left.context_items, ...right.context_items],
      (item) => item.context_event_id,
    ),
    compactions: uniqueBy(
      [...left.compactions, ...right.compactions],
      (item) => item.compaction_id,
    ),
    bridge_tasks: uniqueBy(
      [...left.bridge_tasks, ...right.bridge_tasks],
      (task) => `${task.task_id}\0${task.attempt}`,
    ),
    warnings: uniqueBy(
      [...left.warnings, ...right.warnings],
      (warning) => `${warning.code}\0${warning.source_id ?? ""}\0${warning.count ?? ""}`,
    ),
  };
}

function mergeTools(left, right) {
  const merged = new Map();
  for (const tool of left) {
    merged.set(tool.tool_event_id ?? tool.call_id ?? tool.signature, tool);
  }
  for (const tool of right) {
    const key = tool.tool_event_id ?? tool.call_id ?? tool.signature;
    const previous = merged.get(key);
    merged.set(key, previous ? {
      ...previous,
      ...tool,
      response_id: tool.response_id ?? previous.response_id,
      started_at: tool.started_at ?? previous.started_at,
      ended_at: tool.ended_at ?? previous.ended_at,
      duration_ms: tool.duration_ms ?? previous.duration_ms,
      output_bytes: tool.output_bytes ?? previous.output_bytes,
      estimated_output_tokens:
        tool.estimated_output_tokens ?? previous.estimated_output_tokens,
      status: tool.status ?? previous.status,
      failed: tool.failed ?? previous.failed,
      output_hash: tool.output_hash ?? previous.output_hash,
      duplicate_of: tool.duplicate_of ?? previous.duplicate_of,
      state_unchanged: tool.state_unchanged ?? previous.state_unchanged,
    } : tool);
  }
  return [...merged.values()];
}

function withoutAgentUsage(agent) {
  const { usage: _usage, ...metadata } = agent;
  return metadata;
}

function recomputeAgents(agentMetadata, responses, checkpoints) {
  return agentMetadata.map((agent) => {
    const agentResponses = responses.filter((response) => response.agent_id === agent.agent_id);
    const agentCheckpoints = checkpoints.filter((checkpoint) => (
      checkpoint.agent_id === agent.agent_id
    ));
    const unknownCount = agentResponses.filter((response) => (
      usageIsUnknown(response.usage)
    )).length;
    const usage = createAggregateUsage({
      responseUsages: agentResponses.map((response) => response.usage).filter(Boolean),
      cumulativeUsages: agentCheckpoints,
      unknownUsageResponseCount: unknownCount,
      model: agent.model,
      provider: agent.provider,
      reasoningEffort: agent.reasoning_effort,
      source: agent.kind === "WORKER" ? "bridge" : "codex_rollout",
    });
    return {
      ...agent,
      response_count: agentResponses.length || agent.response_count || 0,
      unknown_usage_response_count: unknownCount,
      usage,
      content_retained: false,
    };
  });
}

function mergeAgentMetadata(agents) {
  const map = new Map();
  for (const agent of agents) {
    const metadata = withoutAgentUsage(agent);
    const previous = map.get(metadata.agent_id);
    if (!previous) {
      map.set(metadata.agent_id, metadata);
      continue;
    }
    map.set(metadata.agent_id, {
      ...previous,
      ...metadata,
      source_refs: [...new Set([...(previous.source_refs ?? []), ...(metadata.source_refs ?? [])])].sort(),
      started_at: previous.started_at ?? metadata.started_at,
      ended_at: previous.ended_at ?? metadata.ended_at,
    });
  }
  return [...map.values()];
}

function sanitizeSource(source, result) {
  return {
    source_id: source.source_id,
    kind: source.kind,
    display_name: source.display_name,
    size_bytes: source.size_bytes ?? null,
    modified_at: source.modified_at ?? null,
    read_only: true,
    status: result?.warnings?.length ? "PARTIAL" : "READ",
    scan: result?.scan ?? null,
  };
}

function maxTimestamp(values) {
  let selected = null;
  let selectedMs = -Infinity;
  for (const value of values) {
    const parsed = timestampMs(value);
    if (parsed !== null && parsed > selectedMs) {
      selected = new Date(parsed).toISOString();
      selectedMs = parsed;
    }
  }
  return selected;
}

function finalizeSnapshotPayload(collection, sources, warnings, collectionMode, collectionTime) {
  const agentMetadata = mergeAgentMetadata(collection.agents);
  const agents = correlateProfilerAgents(
    recomputeAgents(agentMetadata, collection.responses, collection.usage_checkpoints),
    collection.tools,
  );
  const goals = groupAgentsByGoal(agents);
  const eventHorizonAt = maxTimestamp([
    ...agents.flatMap((agent) => [agent.started_at, agent.ended_at]),
    ...collection.responses.map((response) => response.observed_at),
    ...collection.compactions.map((compaction) => compaction.observed_at),
  ]);
  const payload = {
    schema_version: PROFILER_SCHEMA_VERSION,
    kind: PROFILER_SNAPSHOT_KIND,
    snapshot_id: null,
    captured_at: collectionTime,
    generated_at: collectionTime,
    event_horizon_at: eventHorizonAt,
    read_only: true,
    collection_mode: collectionMode,
    sources,
    goals,
    agents,
    responses: [...collection.responses].sort((left, right) => (
      (left.observed_at ?? "").localeCompare(right.observed_at ?? "")
      || left.response_id.localeCompare(right.response_id)
    )),
    usage_checkpoints: [...collection.usage_checkpoints].sort((left, right) => (
      (left.observed_at ?? "").localeCompare(right.observed_at ?? "")
      || String(left.event_ref).localeCompare(String(right.event_ref))
    )),
    tools: [...collection.tools].sort((left, right) => (
      (left.started_at ?? "").localeCompare(right.started_at ?? "")
      || left.tool_event_id.localeCompare(right.tool_event_id)
    )),
    context_items: [...collection.context_items].sort((left, right) => (
      left.context_event_id.localeCompare(right.context_event_id)
    )),
    compactions: [...collection.compactions].sort((left, right) => (
      (left.observed_at ?? "").localeCompare(right.observed_at ?? "")
      || left.compaction_id.localeCompare(right.compaction_id)
    )),
    bridge_tasks: [...collection.bridge_tasks].sort((left, right) => (
      left.task_id.localeCompare(right.task_id) || left.attempt - right.attempt
    )),
    warnings: [...warnings].sort((left, right) => (
      `${left.code}\0${left.source_id ?? ""}`.localeCompare(
        `${right.code}\0${right.source_id ?? ""}`,
      )
    )),
    limitations: [
      "Only local observable records are analyzed; hidden server prompts are not reconstructed.",
      "Content sizes are byte observations; token estimates use a fixed bytes-per-token heuristic.",
      "Provider token counts remain separate and are not converted into billing credits.",
    ],
  };
  const snapshotId = sha256(payload);
  payload.snapshot_id = snapshotId;
  return payload;
}

export async function collectProfilerSnapshot(options = {}) {
  const collectionTime = normalizeTimestamp(options.generatedAt ?? options.collectedAt)
    ?? new Date().toISOString();
  const discovered = discoverProfilerSources({ ...options, includePaths: true });
  const previousSnapshot = options.previousSnapshot ?? null;
  const incrementalState = options.incrementalState ?? {};
  const hasPrevious = previousSnapshot?.kind === PROFILER_SNAPSHOT_KIND;
  let collection = emptyCollection();
  const sources = [];
  const warnings = [...discovered.warnings];
  const nextState = {};
  const fileResults = new Map();

  if (hasPrevious) {
    collection = mergeCollection(collection, {
      agents: previousSnapshot.agents ?? [],
      responses: previousSnapshot.responses ?? [],
      usage_checkpoints: previousSnapshot.usage_checkpoints ?? [],
      tools: previousSnapshot.tools ?? [],
      context_items: previousSnapshot.context_items ?? [],
      compactions: previousSnapshot.compactions ?? [],
      bridge_tasks: previousSnapshot.bridge_tasks ?? [],
      warnings: [],
    });
  }

  let usedIncremental = false;
  for (const source of discovered.sources) {
    const state = incrementalState[sourceStateKey(source)] ?? {};
    if (source.kind === "codex_rollout_jsonl") {
      let startOffset = Number.isSafeInteger(state.offset) && state.offset > 0
        ? state.offset
        : 0;
      if (startOffset > 0 && !hasPrevious) {
        warnings.push({
          code: "incremental_without_previous_snapshot_rescanned",
          source_id: source.source_id,
        });
        startOffset = 0;
      } else if (startOffset > 0) {
        usedIncremental = true;
      }
      const previousAgent = hasPrevious
        ? previousSnapshot.agents.find((agent) => (
            (agent.source_refs ?? []).includes(source.source_id)
          )) ?? null
        : null;
      const agentHint = previousAgent
        ? {
            thread_id: previousAgent.thread_id,
            kind: previousAgent.kind,
            session_id: previousAgent.session_id,
            parent_thread_id: previousAgent.parent_thread_id,
            nickname: previousAgent.nickname,
            agent_path: previousAgent.agent_path,
            model: previousAgent.model,
            provider: previousAgent.provider,
            reasoning_effort: previousAgent.reasoning_effort,
            context_window: previousAgent.context_window,
          }
        : null;
      const result = await parseRolloutJsonl(source, {
        startOffset,
        chunkBytes: options.chunkBytes,
        maxBytes: options.maxBytesPerSource,
        agentHint,
        zstdCodec: options.zstdCodec,
      });
      fileResults.set(source.source_id, result);
      const delta = {
        agents: result.agent ? [result.agent] : [],
        responses: result.responses,
        usage_checkpoints: result.usage_checkpoints,
        tools: result.tools,
        context_items: result.context_items,
        compactions: result.compactions,
        bridge_tasks: [],
        warnings: result.warnings,
      };
      collection = mergeCollection(collection, delta);
      warnings.push(...result.warnings);
      nextState[source.source_id] = {
        offset: source.compression === "zstd"
          ? 0
          : result.scan.resume_offset ?? result.scan.next_offset,
        size_bytes: result.scan.file_size,
        kind: source.kind,
        compression: source.compression,
        thread_id: result.agent.thread_id,
      };
      sources.push(sanitizeSource(source, result));
    } else if (source.kind === "bridge_sqlite") {
      let startEventCursor = Number.isSafeInteger(state.event_cursor) && state.event_cursor > 0
        ? state.event_cursor
        : 0;
      if (startEventCursor > 0 && !hasPrevious) {
        warnings.push({
          code: "incremental_without_previous_snapshot_rescanned",
          source_id: source.source_id,
        });
        startEventCursor = 0;
      } else if (startEventCursor > 0) {
        usedIncremental = true;
      }
      const result = collectBridgeSqliteSource(source, { startEventCursor });
      fileResults.set(source.source_id, result);
      collection = mergeCollection(collection, result);
      warnings.push(...result.warnings);
      nextState[source.source_id] = {
        event_cursor: result.resume_before_cursor !== null
          && result.resume_before_cursor !== undefined
          ? Math.max(0, result.resume_before_cursor - 1)
          : result.scan.next_event_cursor ?? 0,
        kind: source.kind,
      };
      sources.push(sanitizeSource(source, result));
    } else if (source.kind === "bridge_history_json") {
      const result = collectBridgeHistorySource(source);
      fileResults.set(source.source_id, result);
      collection = mergeCollection(collection, result);
      warnings.push(...result.warnings);
      nextState[source.source_id] = {
        event_cursor: result.scan.next_event_cursor ?? 0,
        kind: source.kind,
      };
      sources.push(sanitizeSource(source, result));
    }
  }

  const snapshot = finalizeSnapshotPayload(
    collection,
    sources,
    warnings,
    usedIncremental ? "INCREMENTAL" : "FULL",
    collectionTime,
  );
  snapshot.next_incremental_state = nextState;
  assertProfilerSnapshot(snapshot);
  return snapshot;
}
