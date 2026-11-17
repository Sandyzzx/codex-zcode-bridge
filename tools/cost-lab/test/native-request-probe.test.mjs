import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateRequestUsage,
  deriveProbeCoverage,
  mergeNativeEvidence,
  parseModelIoJsonl,
  parseModelRequestLogJsonl,
  projectModelUsageRow,
} from "../native-request-probe.mjs";

function usageRow(overrides = {}) {
  return {
    id: "usage-model-main-0",
    logical_request_id: "logic-main",
    attempt_index: 0,
    session_id: "session-1",
    turn_id: "turn-1",
    trace_id: "trace-1",
    span_id: "span-1",
    parent_user_message_id: "message-1",
    query_source: "main_turn",
    provider_id: "account:bigmodel-individual-coding-plan",
    model_id: "GLM-5.3-Flash",
    variant: "low",
    status: "completed",
    started_at: Date.parse("2026-11-17T04:00:00.000Z"),
    first_token_at: null,
    completed_at: Date.parse("2026-11-17T04:00:01.000Z"),
    duration_ms: 1_000,
    finish_reason: "stop",
    tool_call_count: 0,
    input_tokens: 1_100,
    output_tokens: 30,
    reasoning_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 100,
    computed_total_tokens: 1_130,
    retry_count: 0,
    retryable: 0,
    error_code: null,
    error_type: null,
    ...overrides,
  };
}

function modelIoLine(overrides = {}) {
  return JSON.stringify({
    type: "model_io",
    requestId: "network-1",
    attempt: 1,
    sessionId: "session-1",
    turnId: "turn-1",
    traceId: "trace-1",
    querySource: "main_turn",
    startedAt: "2026-11-17T04:00:00.050Z",
    completedAt: "2026-11-17T04:00:01.050Z",
    durationMs: 1_000,
    model: {
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
    },
    request: {
      headers: {
        "x-request-id": "network-1",
        authorization: "Bearer secret",
        cookie: "secret-cookie",
        "x-zcode-app-version": "3.18.2",
      },
      messageCount: 4,
      messageOffset: 0,
      messagesKind: "array",
      messages: [{ role: "user", content: "must not be retained" }],
      toolNames: ["read_file"],
    },
    response: {
      headers: { "set-cookie": "must not be retained" },
      finishReason: "stop",
      modelId: "GLM-5.3-Flash",
      usage: {
        inputTokens: 1_100,
        cacheReadTokens: 100,
        outputTokens: 30,
        totalTokens: 1_130,
      },
    },
    ...overrides,
  });
}

function modelLogLine(overrides = {}) {
  return JSON.stringify({
    timestamp: "2026-11-17T04:00:01.000Z",
    level: "info",
    event: "model.request.completed",
    message: "Model request completed",
    traceId: "trace-1",
    spanId: "span-memory",
    sessionId: "session-1",
    turnId: "turn-1",
    durationMs: 900,
    status: "completed",
    context: {
      attempt: 1,
      baseURL: "https://open.bigmodel.cn/api/anthropic",
      modelId: "GLM-5.3-Flash",
      providerId: "account:bigmodel-individual-coding-plan",
      providerKind: "anthropic",
      querySource: "project_memory_extract",
      requestId: "network-memory",
      transport: "http",
      finishReason: "stop",
      usage: {
        inputTokens: "[Redacted]",
        outputTokens: "[Redacted]",
      },
      authorization: "Bearer secret",
    },
    ...overrides,
  });
}

test("native usage normalization distinguishes cached and uncached input", () => {
  const record = projectModelUsageRow(usageRow(), {
    experimentId: "exp-1",
    clientVersion: "3.18.2",
    runtimeVersion: "3.18.2.10443",
  });
  assert.equal(record.cached_input_tokens, 100);
  assert.equal(record.uncached_input_tokens, 1_000);
  assert.equal(record.total_tokens, 1_130);
  assert.equal(record.usage_status, "OBSERVED");
  assert.equal(record.request_kind, "model_main_turn");
  assert.equal(record.usage_scene, "CODING_PLAN");
});

test("model I/O projection retains allowlisted metadata but no secrets or payloads", () => {
  const { records, invalidLines } = parseModelIoJsonl(modelIoLine(), {
    experimentId: "exp-1",
  });
  assert.equal(invalidLines, 0);
  assert.equal(records.length, 1);
  const serialized = JSON.stringify(records[0]);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("must not be retained"), false);
  assert.equal(records[0].network_request_id, "network-1");
  assert.equal(records[0].safe_header_values["x-zcode-app-version"], "3.18.2");
  assert.equal(records[0].message_count, 4);
  assert.deepEqual(records[0].tool_names, ["read_file"]);
});

test("cross-log evidence merges only a unique session turn source time match", () => {
  const usage = [projectModelUsageRow(usageRow(), { experimentId: "exp-1" })];
  const http = parseModelIoJsonl(modelIoLine()).records;
  const merged = mergeNativeEvidence(usage, http);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].network_request_id, "network-1");
  assert.equal(merged[0].link_confidence, "SUPPORTED_SESSION_TURN_QUERY_SOURCE_TIME");
  assert.equal(merged[0].cached_input_tokens, 100);
});

test("ambiguous cross-log matches remain unlinked rather than double-counted", () => {
  const usage = [
    projectModelUsageRow(usageRow({ id: "usage-a" })),
    projectModelUsageRow(usageRow({ id: "usage-b", started_at: Date.parse("2026-11-17T04:00:00.100Z") })),
  ];
  const http = parseModelIoJsonl(modelIoLine()).records;
  const merged = mergeNativeEvidence(usage, http);
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((record) => record.link_confidence).length, 0);
});

test("model I/O duplicates across debug and rollout collapse by network request id", () => {
  const parsed = parseModelIoJsonl(`${modelIoLine()}\n${modelIoLine()}\n`);
  const unique = new Map(parsed.records.map((record) => [record.network_request_id, record]));
  assert.equal(parsed.records.length, 2);
  assert.equal(unique.size, 1);
});

test("aggregate usage includes auxiliary model requests and preserves usage missing", () => {
  const usage = [
    projectModelUsageRow(usageRow()),
    projectModelUsageRow(usageRow({
      id: "usage-title",
      logical_request_id: "logic-title",
      query_source: "session_title",
      input_tokens: 500,
      cache_read_input_tokens: 0,
      output_tokens: 20,
      computed_total_tokens: 520,
    })),
    projectModelUsageRow(usageRow({
      id: "usage-error",
      logical_request_id: "logic-error",
      status: "error",
      input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      computed_total_tokens: 0,
    })),
  ];
  const aggregate = aggregateRequestUsage(usage);
  assert.deepEqual(aggregate.request_usage, {
    cached_input_tokens: 100,
    uncached_input_tokens: 1_500,
    output_tokens: 50,
    total_tokens: 1_650,
  });
  assert.equal(aggregate.auxiliary_records, 1);
  assert.equal(aggregate.usage_missing_records, 1);
});

test("probe coverage does not claim unobserved authentication HTTP", () => {
  const usageRecords = [projectModelUsageRow(usageRow())];
  const modelIoRecords = parseModelIoJsonl(modelIoLine()).records;
  const records = mergeNativeEvidence(usageRecords, modelIoRecords);
  const coverage = deriveProbeCoverage({ usageRecords, modelIoRecords, records });
  assert.equal(coverage.PROBE_COVERAGE, "PARTIAL");
  assert.equal(coverage.MODEL_REQUEST_COVERAGE, "SQLITE_AND_MODEL_IO");
  assert.equal(coverage.AUTH_METADATA_COVERAGE, "NOT_OBSERVED");
  assert.ok(coverage.UNOBSERVED_BOUNDARIES.includes("native_rpc_lifecycle"));
});

test("model request log records an auxiliary HTTP request without inventing usage", () => {
  const { records, invalidLines } = parseModelRequestLogJsonl(modelLogLine(), {
    experimentId: "exp-1",
  });
  assert.equal(invalidLines, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].network_request_id, "network-memory");
  assert.equal(records[0].query_source, "project_memory_extract");
  assert.equal(records[0].usage_status, "USAGE_MISSING");
  assert.equal(records[0].input_tokens, null);
  assert.equal(records[0].output_tokens, null);
  assert.equal(records[0].endpoint_host, "open.bigmodel.cn");
  assert.equal(records[0].endpoint_path, "/api/anthropic");
  assert.equal(JSON.stringify(records[0]).includes("secret"), false);
});

test("log-only model request is merged once while known requests remain deduplicated", () => {
  const usage = [projectModelUsageRow(usageRow(), { experimentId: "exp-1" })];
  const modelIo = parseModelIoJsonl(modelIoLine()).records;
  const logs = parseModelRequestLogJsonl(`${modelIoLine()}\n${modelLogLine()}`).records;
  const merged = mergeNativeEvidence(usage, modelIo, logs);
  assert.equal(merged.length, 2);
  assert.equal(merged.filter((record) => record.usage_status === "USAGE_MISSING").length, 1);
  assert.equal(merged.find((record) => record.network_request_id === "network-memory").query_source,
    "project_memory_extract");
  const aggregate = aggregateRequestUsage(merged);
  assert.equal(aggregate.usage_missing_records, 1);
  assert.equal(aggregate.auxiliary_request_records, 1);
  assert.deepEqual(aggregate.request_usage, {
    cached_input_tokens: 100,
    uncached_input_tokens: 1_000,
    output_tokens: 30,
    total_tokens: 1_130,
  });
  const coverage = deriveProbeCoverage({
    usageRecords: usage,
    modelIoRecords: modelIo,
    logRecords: logs,
    records: merged,
  });
  assert.equal(coverage.MODEL_REQUEST_COVERAGE, "SQLITE_MODEL_IO_AND_LOG");
  assert.equal(coverage.AUXILIARY_REQUEST_COVERAGE, "MODEL_AUXILIARY_HTTP_AND_LOG");
  assert.ok(coverage.UNOBSERVED_BOUNDARIES.includes("auxiliary_model_usage_redacted_or_absent"));
});
