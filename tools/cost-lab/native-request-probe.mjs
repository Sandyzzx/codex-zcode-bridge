#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveUserHome } from "./path-discovery.mjs";
import { atomicWriteJson } from "./coding-plan-billing.mjs";

export const NATIVE_PROBE_SCHEMA_VERSION = 1;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
const RUN_ROOT = path.join(PROJECT_ROOT, ".run");
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_DURATION_MS = 180_000;
const LINK_WINDOW_MS = 3_000;
const SAFE_HEADER_VALUES = Object.freeze([
  "x-request-id",
  "x-zcode-trace-id",
  "x-query-id",
  "x-zcode-query-source",
  "x-session-id",
  "x-zcode-app-version",
  "x-platform",
  "x-zcode-agent",
  "x-release-channel",
  "x-zcode-session-type",
  "x-client-timezone",
  "x-client-language",
]);
const SAFE_RESPONSE_HEADER_VALUES = Object.freeze([
  "content-type",
  "date",
  "ga-traceid",
  "server",
  "x-log-id",
  "x-request-id",
  "x-site-cache-status",
]);
const MODEL_LIFECYCLE_EVENTS = new Set([
  "ttft.model.request_started",
  "ttft.model.response_headers",
  "model.network.failed",
  "model.request.failed",
  "model.network.completed",
  "model.request.completed",
  "model.sdk.generate.completed",
  "model.sdk.stream.completed",
]);
const TERMINAL_MODEL_EVENTS = new Set([
  "model.network.failed",
  "model.request.failed",
  "model.network.completed",
  "model.request.completed",
  "model.sdk.generate.completed",
  "model.sdk.stream.completed",
]);
const MODEL_USAGE_FIELDS = Object.freeze([
  "id",
  "logical_request_id",
  "attempt_index",
  "session_id",
  "turn_id",
  "trace_id",
  "span_id",
  "assistant_message_id",
  "parent_user_message_id",
  "query_source",
  "provider_id",
  "model_id",
  "variant",
  "agent",
  "mode",
  "task_type",
  "status",
  "started_at",
  "first_token_at",
  "completed_at",
  "duration_ms",
  "time_to_first_token_ms",
  "finish_reason",
  "tool_call_count",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "provider_total_tokens",
  "computed_total_tokens",
  "retry_count",
  "retryable",
  "cancelled_by_user",
  "context_exceeded",
  "error_type",
  "error_code",
]);

function requiredValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name}_requires_value`);
  return value;
}

function integerOption(value, name, { min, max }) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name}_must_be_between_${min}_and_${max}`);
  }
  return number;
}

function isoFromMilliseconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function parseTimestamp(value, name) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${name}_invalid`);
  return milliseconds;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "watch" && command !== "rescan") {
    throw new Error("command_must_be_watch_or_rescan");
  }
  const options = {
    command,
    experimentId: null,
    outDir: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: DEFAULT_DURATION_MS,
    pollMs: DEFAULT_POLL_MS,
    stopFile: null,
    dbPath: null,
    modelIoDirs: [],
    logDirs: [],
    clientVersion: null,
    runtimeVersion: null,
    json: false,
  };
  let startedAtProvided = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--experiment-id") {
      options.experimentId = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--out") {
      options.outDir = path.resolve(requiredValue(rest, index, arg));
      index += 1;
    } else if (arg === "--started-at") {
      options.startedAt = new Date(parseTimestamp(requiredValue(rest, index, arg), "started_at")).toISOString();
      startedAtProvided = true;
      index += 1;
    } else if (arg === "--ended-at") {
      options.endedAt = new Date(parseTimestamp(requiredValue(rest, index, arg), "ended_at")).toISOString();
      index += 1;
    } else if (arg === "--duration-ms") {
      options.durationMs = integerOption(requiredValue(rest, index, arg), "duration_ms", {
        min: 1_000,
        max: 3_600_000,
      });
      index += 1;
    } else if (arg === "--poll-ms") {
      options.pollMs = integerOption(requiredValue(rest, index, arg), "poll_ms", {
        min: 250,
        max: 30_000,
      });
      index += 1;
    } else if (arg === "--stop-file") {
      options.stopFile = path.resolve(requiredValue(rest, index, arg));
      index += 1;
    } else if (arg === "--db") {
      options.dbPath = path.resolve(requiredValue(rest, index, arg));
      index += 1;
    } else if (arg === "--model-io-dir") {
      options.modelIoDirs.push(path.resolve(requiredValue(rest, index, arg)));
      index += 1;
    } else if (arg === "--log-dir") {
      options.logDirs.push(path.resolve(requiredValue(rest, index, arg)));
      index += 1;
    } else if (arg === "--client-version") {
      options.clientVersion = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--runtime-version") {
      options.runtimeVersion = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown_option:${arg}`);
    }
  }
  if (!options.experimentId) throw new Error("experiment_id_required");
  if (!options.outDir) throw new Error("out_required");
  if (options.command === "rescan" && (!startedAtProvided || !options.endedAt)) {
    throw new Error("rescan_requires_started_at_and_ended_at");
  }
  if (options.command === "watch" && options.endedAt) {
    throw new Error("ended_at_only_supported_for_rescan");
  }
  if (options.endedAt && parseTimestamp(options.endedAt, "ended_at") <= parseTimestamp(options.startedAt, "started_at")) {
    throw new Error("ended_at_must_be_after_started_at");
  }
  assertRunOutput(options.outDir);
  const home = resolveUserHome();
  const zcodeCliDir = path.join(home.userHome, ".zcode", "cli");
  options.dbPath ??= path.join(zcodeCliDir, "db", "db.sqlite");
  if (options.modelIoDirs.length === 0) {
    options.modelIoDirs = [
      path.join(zcodeCliDir, "rollout"),
      path.join(zcodeCliDir, "debug"),
    ];
  }
  if (options.logDirs.length === 0) {
    options.logDirs = [path.join(zcodeCliDir, "log")];
  }
  return Object.freeze(options);
}

function assertRunOutput(filePath) {
  const relative = path.relative(RUN_ROOT, path.resolve(filePath));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("probe_output_must_be_inside_project_run_root");
  }
}

function providerUsesCodingPlan(providerId) {
  return typeof providerId === "string" && providerId.includes("coding-plan");
}

function requestKind(querySource) {
  if (querySource === "main_turn") return "model_main_turn";
  if (querySource === "session_title") return "model_session_title";
  return "model_auxiliary";
}

function numeric(value) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function nativeUsageStatus(row) {
  if (row.status === "running") return "UNKNOWN";
  if (row.status === "error" || row.status === "cancelled") {
    return numeric(row.computed_total_tokens) > 0 ? "PARTIAL" : "USAGE_MISSING";
  }
  return numeric(row.computed_total_tokens) > 0 ? "OBSERVED" : "USAGE_MISSING";
}

export function projectModelUsageRow(row, context = {}) {
  const cachedInput = numeric(row.cache_read_input_tokens);
  const input = numeric(row.input_tokens);
  return {
    schema_version: NATIVE_PROBE_SCHEMA_VERSION,
    source_client: "native-zcode",
    client_version: context.clientVersion ?? null,
    runtime_version: context.runtimeVersion ?? null,
    experiment_id: context.experimentId ?? null,
    session_id: row.session_id ?? null,
    turn_id: row.turn_id ?? null,
    trace_id: row.trace_id ?? null,
    logical_request_id: row.logical_request_id ?? null,
    network_request_id: null,
    parent_request_id: row.parent_user_message_id ?? null,
    request_kind: requestKind(row.query_source),
    query_source: row.query_source ?? null,
    attempt: numeric(row.attempt_index) + 1,
    started_at: isoFromMilliseconds(row.started_at),
    completed_at: isoFromMilliseconds(row.completed_at),
    duration_ms: row.duration_ms === null || row.duration_ms === undefined
      ? null
      : numeric(row.duration_ms),
    provider_id: row.provider_id ?? null,
    model_id: row.model_id ?? null,
    reasoning_level: row.variant ?? null,
    transport_kind: "official_native_sqlite",
    http_method: null,
    endpoint_host: null,
    endpoint_path: null,
    http_status: null,
    organization_id: null,
    project_id: null,
    api_key_id: null,
    account_scope: providerUsesCodingPlan(row.provider_id) ? "personal" : "UNKNOWN",
    usage_scene: providerUsesCodingPlan(row.provider_id) ? "CODING_PLAN" : "UNKNOWN",
    input_tokens: input,
    cached_input_tokens: cachedInput,
    uncached_input_tokens: Math.max(0, input - cachedInput),
    output_tokens: numeric(row.output_tokens),
    reasoning_tokens: numeric(row.reasoning_tokens),
    total_tokens: numeric(row.computed_total_tokens),
    finish_reason: row.finish_reason ?? null,
    error_code: row.error_code ?? null,
    error_type: row.error_type ?? null,
    retryable: Boolean(row.retryable),
    usage_status: nativeUsageStatus(row),
    evidence_source: "official_native_sqlite:model_usage",
    usage_id: row.id ?? null,
    span_id: row.span_id ?? null,
    tool_call_count: numeric(row.tool_call_count),
    retry_count: numeric(row.retry_count),
  };
}

function safeHeaderProjection(headers, allowedNames = SAFE_HEADER_VALUES) {
  const source = headers && typeof headers === "object" ? headers : {};
  const normalized = new Map(
    Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const values = {};
  for (const name of allowedNames) {
    if (normalized.has(name)) values[name] = String(normalized.get(name));
  }
  return {
    header_names: [...normalized.keys()].sort(),
    safe_header_values: values,
  };
}

function responseUsage(raw) {
  const usage = raw?.response?.usage;
  if (!usage || typeof usage !== "object") return null;
  const fields = {
    input_tokens: usage.inputTokens ?? usage.input_tokens,
    cached_input_tokens: usage.cacheReadTokens ?? usage.cache_read_input_tokens,
    output_tokens: usage.outputTokens ?? usage.output_tokens,
    reasoning_tokens: usage.reasoningTokens ?? usage.reasoning_tokens,
    total_tokens: usage.totalTokens ?? usage.total_tokens,
  };
  return Object.values(fields).some((value) => value !== undefined)
    ? Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, numeric(value)]),
      )
    : null;
}

export function projectModelIoRecord(row, context = {}) {
  const model = row?.model ?? {};
  const request = row?.request ?? {};
  const response = row?.response ?? {};
  const usage = responseUsage(row);
  const headers = safeHeaderProjection(request.headers);
  const responseHeaders = safeHeaderProjection(
    response.headers,
    SAFE_RESPONSE_HEADER_VALUES,
  );
  return {
    schema_version: NATIVE_PROBE_SCHEMA_VERSION,
    source_client: "native-zcode",
    client_version: context.clientVersion ?? headers.safe_header_values["x-zcode-app-version"] ?? null,
    runtime_version: context.runtimeVersion ?? null,
    experiment_id: context.experimentId ?? null,
    session_id: row?.sessionId ?? headers.safe_header_values["x-session-id"] ?? null,
    turn_id: row?.turnId ?? null,
    trace_id: row?.traceId ?? headers.safe_header_values["x-zcode-trace-id"] ?? null,
    logical_request_id: null,
    network_request_id: row?.requestId ?? headers.safe_header_values["x-request-id"] ?? null,
    parent_request_id: null,
    request_kind: requestKind(row?.querySource),
    query_source: row?.querySource ?? headers.safe_header_values["x-zcode-query-source"] ?? null,
    attempt: numeric(row?.attempt),
    started_at: row?.startedAt ?? null,
    completed_at: row?.completedAt ?? null,
    duration_ms: numeric(row?.durationMs),
    provider_id: model.providerId ?? null,
    model_id: model.modelId ?? response.modelId ?? null,
    reasoning_level: null,
    transport_kind: "official_native_model_io",
    model_transport: null,
    provider_kind: null,
    http_method: "UNKNOWN",
    endpoint_host: null,
    endpoint_path: null,
    http_status: "UNKNOWN",
    response_headers_at: null,
    organization_id: null,
    project_id: null,
    api_key_id: null,
    account_scope: providerUsesCodingPlan(model.providerId) ? "personal" : "UNKNOWN",
    usage_scene: providerUsesCodingPlan(model.providerId) ? "CODING_PLAN" : "UNKNOWN",
    input_tokens: usage?.input_tokens ?? null,
    cached_input_tokens: usage?.cached_input_tokens ?? null,
    uncached_input_tokens: usage
      ? Math.max(0, usage.input_tokens - usage.cached_input_tokens)
      : null,
    output_tokens: usage?.output_tokens ?? null,
    reasoning_tokens: usage?.reasoning_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
    finish_reason: response.finishReason ?? null,
    error_code: null,
    error_type: null,
    retryable: null,
    usage_status: usage ? "OBSERVED" : "USAGE_MISSING",
    evidence_source: "official_native_model_io",
    header_names: headers.header_names,
    safe_header_values: headers.safe_header_values,
    response_header_names: responseHeaders.header_names,
    safe_response_header_values: responseHeaders.safe_header_values,
    provider_response_id: response.responseId ?? null,
    message_count: numeric(request.messageCount),
    message_offset: numeric(request.messageOffset),
    messages_kind: request.messagesKind ?? null,
    tool_names: Array.isArray(request.toolNames) ? request.toolNames.map(String) : [],
  };
}

export function parseModelIoJsonl(text, context = {}) {
  const records = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "model_io" && row.requestId) {
        records.push(projectModelIoRecord(row, context));
      }
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

function endpointParts(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl) return { host: null, path: null };
  try {
    const parsed = new URL(baseUrl);
    return {
      host: parsed.host || null,
      path: parsed.pathname || null,
    };
  } catch {
    return { host: null, path: null };
  }
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function latestValue(events, read) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = read(events[index]);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function lifecycleStatus(events) {
  const status = latestValue(events, (event) => event.status);
  if (status) return String(status);
  return events.some((event) =>
    event.event === "model.network.failed" || event.event === "model.request.failed")
    ? "failed"
    : "UNKNOWN";
}

export function projectModelLifecycleRecord(events, context = {}) {
  const ordered = [...events].sort((left, right) =>
    String(left.timestamp).localeCompare(String(right.timestamp)));
  const first = ordered[0];
  const details = (event) => event?.context ?? {};
  const terminal = [...ordered].reverse().find((event) =>
    TERMINAL_MODEL_EVENTS.has(event.event));
  const requestStarted = ordered.find((event) =>
    event.event === "ttft.model.request_started");
  const responseHeaders = ordered.find((event) =>
    event.event === "ttft.model.response_headers");
  const completedAt = terminal?.timestamp ?? null;
  const durationMs = finiteOrNull(
    latestValue(ordered, (event) => event.durationMs ?? details(event).durationMs),
  );
  const completedMs = Date.parse(completedAt);
  const inferredStartedAt = Number.isFinite(completedMs)
    && durationMs !== null
    && durationMs >= 0
    ? new Date(completedMs - durationMs).toISOString()
    : null;
  const startedAt = requestStarted?.timestamp ?? inferredStartedAt;
  const endpoint = endpointParts(
    latestValue(ordered, (event) => details(event).baseURL),
  );
  const httpStatus = finiteOrNull(
    latestValue(ordered, (event) => details(event).statusCode),
  );
  const providerId = latestValue(ordered, (event) => details(event).providerId);
  const lifecycleEvents = [...new Set(ordered.map((event) => event.event))]
    .filter(Boolean)
    .sort();
  return {
    schema_version: NATIVE_PROBE_SCHEMA_VERSION,
    source_client: "native-zcode",
    client_version: context.clientVersion ?? null,
    runtime_version: context.runtimeVersion ?? null,
    experiment_id: context.experimentId ?? null,
    session_id: latestValue(ordered, (event) => event.sessionId),
    turn_id: latestValue(ordered, (event) => event.turnId),
    trace_id: latestValue(ordered, (event) => event.traceId),
    logical_request_id: null,
    network_request_id: latestValue(ordered, (event) => details(event).requestId),
    parent_request_id: null,
    request_kind: requestKind(
      latestValue(ordered, (event) => details(event).querySource),
    ),
    query_source: latestValue(ordered, (event) => details(event).querySource),
    attempt: numeric(latestValue(ordered, (event) => details(event).attempt)),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    provider_id: providerId,
    model_id: latestValue(ordered, (event) => details(event).modelId),
    reasoning_level: null,
    transport_kind: "official_native_log",
    model_transport: latestValue(ordered, (event) => details(event).transport),
    provider_kind: latestValue(ordered, (event) => details(event).providerKind),
    http_method: String(latestValue(ordered, (event) => details(event).method) ?? "UNKNOWN"),
    endpoint_host: endpoint.host,
    endpoint_path: endpoint.path,
    http_status: httpStatus ?? "UNKNOWN",
    response_headers_at: responseHeaders?.timestamp ?? null,
    lifecycle_events: lifecycleEvents,
    lifecycle_event_count: ordered.length,
    request_status: lifecycleStatus(ordered),
    organization_id: null,
    project_id: null,
    api_key_id: null,
    account_scope: providerUsesCodingPlan(providerId) ? "personal" : "UNKNOWN",
    usage_scene: providerUsesCodingPlan(providerId) ? "CODING_PLAN" : "UNKNOWN",
    input_tokens: null,
    cached_input_tokens: null,
    uncached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    finish_reason: latestValue(ordered, (event) => details(event).finishReason),
    error_code: latestValue(ordered, (event) => details(event).errorCode),
    error_type:
      latestValue(ordered, (event) => details(event).errorType)
      ?? (lifecycleStatus(ordered) === "failed" ? "model_request_failed" : null),
    retryable: null,
    usage_status: "USAGE_MISSING",
    evidence_source: "official_native_log:model_lifecycle",
    usage_missing_reason: terminal
      ? "native_log_redacts_usage_and_model_usage_row_absent"
      : "native_log_lifecycle_has_no_usage_and_no_terminal_event",
    query_id: latestValue(ordered, (event) => details(event).queryId),
    tool_call_count: finiteOrNull(
      latestValue(ordered, (event) => details(event).toolCallCount),
    ),
    retry_count: numeric(latestValue(ordered, (event) => details(event).attempt)) > 1
      ? numeric(latestValue(ordered, (event) => details(event).attempt)) - 1
      : 0,
    base_url: latestValue(ordered, (event) => details(event).baseURL),
  };
}

export function parseModelLifecycleLogJsonl(text, context = {}) {
  let invalidLines = 0;
  const eventsByRequestId = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        MODEL_LIFECYCLE_EVENTS.has(event?.event)
        && typeof event?.context?.requestId === "string"
      ) {
        const events = eventsByRequestId.get(event.context.requestId) ?? [];
        events.push(event);
        eventsByRequestId.set(event.context.requestId, events);
      }
    } catch {
      invalidLines += 1;
    }
  }
  return {
    records: [...eventsByRequestId.values()].map((events) =>
      projectModelLifecycleRecord(events, context)),
    invalidLines,
  };
}

export function parseModelRequestLogJsonl(text, context = {}) {
  const parsed = parseModelLifecycleLogJsonl(text, context);
  return {
    records: parsed.records.filter((record) =>
      record.lifecycle_events.some((event) => TERMINAL_MODEL_EVENTS.has(event))),
    invalidLines: parsed.invalidLines,
  };
}

export function summarizeNativeProtocolLog(text, startedAt, completedAt) {
  const events = new Set();
  let started = 0;
  let completed = 0;
  let failed = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const name = typeof event?.event === "string" ? event.event : "";
      if (!/^zcode_protocol\./u.test(name)) continue;
      const timestamp = Date.parse(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > completedAt) {
        continue;
      }
      events.add(name);
      if (name.endsWith(".started")) started += 1;
      if (name.endsWith(".completed") || name === "zcode_protocol.provider_registry.ready") {
        completed += 1;
      }
      if (name.endsWith(".failed")) failed += 1;
    } catch {
      // Model lifecycle parsing reports malformed JSON once for the same files.
    }
  }
  return {
    rpc_event_types: [...events].sort(),
    rpc_started_events: started,
    rpc_completed_events: completed,
    rpc_failed_events: failed,
  };
}

function sameTimestamp(a, b, windowMs) {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= windowMs;
}

function mergeHttpLogEvidence(http, logged) {
  if (!logged) return http;
  return {
    ...http,
    endpoint_host: logged.endpoint_host ?? http.endpoint_host,
    endpoint_path: logged.endpoint_path ?? http.endpoint_path,
    http_status: logged.http_status === "UNKNOWN"
      ? http.http_status
      : logged.http_status,
    http_method: logged.http_method === "UNKNOWN"
      ? http.http_method
      : logged.http_method,
    model_transport: logged.model_transport ?? http.model_transport ?? null,
    provider_kind: logged.provider_kind ?? http.provider_kind ?? null,
    response_headers_at: logged.response_headers_at ?? http.response_headers_at ?? null,
    request_status: logged.request_status ?? http.request_status ?? "UNKNOWN",
    lifecycle_events: logged.lifecycle_events ?? [],
    lifecycle_event_count: logged.lifecycle_event_count ?? 0,
    error_code: logged.error_code ?? http.error_code ?? null,
    error_type: logged.error_type ?? http.error_type ?? null,
    base_url: logged.base_url ?? null,
    evidence_source:
      `${http.evidence_source}+official_native_log:model_lifecycle`,
  };
}

function evidenceWithNativeLog(record) {
  return record.evidence_source.includes("official_native_log:model_lifecycle")
    ? record.evidence_source
    : `${record.evidence_source}+official_native_log:model_lifecycle`;
}

function mergeLogEvidence(record, logged) {
  return {
    ...record,
    network_request_id: record.network_request_id ?? logged.network_request_id,
    endpoint_host: logged.endpoint_host ?? record.endpoint_host,
    endpoint_path: logged.endpoint_path ?? record.endpoint_path,
    http_status: logged.http_status === "UNKNOWN"
      ? record.http_status
      : logged.http_status,
    http_method: logged.http_method === "UNKNOWN"
      ? record.http_method
      : logged.http_method,
    model_transport: logged.model_transport ?? record.model_transport ?? null,
    provider_kind: logged.provider_kind ?? record.provider_kind ?? null,
    response_headers_at: logged.response_headers_at ?? record.response_headers_at ?? null,
    lifecycle_events: logged.lifecycle_events ?? [],
    lifecycle_event_count: logged.lifecycle_event_count ?? 0,
    request_status: logged.request_status ?? record.request_status ?? "UNKNOWN",
    error_code: logged.error_code ?? record.error_code ?? null,
    error_type: logged.error_type ?? record.error_type ?? null,
    query_id: logged.query_id ?? record.query_id ?? null,
    base_url: logged.base_url ?? record.base_url ?? null,
    evidence_source: evidenceWithNativeLog(record),
  };
}

export function mergeNativeEvidence(usageRecords, modelIoRecords, logRecords = []) {
  const logByRequestId = new Map(
    logRecords
      .filter((record) => record.network_request_id)
      .map((record) => [record.network_request_id, record]),
  );
  const enrichedHttp = modelIoRecords.map((record) =>
    mergeHttpLogEvidence(record, logByRequestId.get(record.network_request_id)));
  const usage = usageRecords.map((record) => ({ ...record }));
  const unlinkedHttp = [];
  for (const http of enrichedHttp) {
    const candidates = usage
      .map((record, index) => ({ record, index }))
      .filter(({ record }) =>
        record.network_request_id === null
        && record.session_id === http.session_id
        && record.turn_id === http.turn_id
        && record.query_source === http.query_source
        && record.attempt === http.attempt
        && sameTimestamp(record.started_at, http.started_at, LINK_WINDOW_MS));
    if (candidates.length !== 1) {
      unlinkedHttp.push(http);
      continue;
    }
    const { index } = candidates[0];
    usage[index] = {
      ...usage[index],
      network_request_id: http.network_request_id,
      transport_kind: http.evidence_source.includes("official_native_log")
        ? "official_native_sqlite+model_io+log"
        : "official_native_sqlite+model_io",
      http_method: http.http_method,
      http_status: http.http_status,
      evidence_source: `official_native_sqlite:model_usage+${http.evidence_source}`,
      header_names: http.header_names,
      safe_header_values: http.safe_header_values,
      response_header_names: http.response_header_names,
      safe_response_header_values: http.safe_response_header_values,
      provider_response_id: http.provider_response_id,
      endpoint_host: http.endpoint_host,
      endpoint_path: http.endpoint_path,
      model_transport: http.model_transport,
      provider_kind: http.provider_kind,
      response_headers_at: http.response_headers_at,
      lifecycle_events: http.lifecycle_events,
      lifecycle_event_count: http.lifecycle_event_count,
      request_status: http.request_status,
      base_url: http.base_url,
      message_count: http.message_count,
      message_offset: http.message_offset,
      messages_kind: http.messages_kind,
      tool_names: http.tool_names,
      link_confidence: "SUPPORTED_SESSION_TURN_QUERY_SOURCE_TIME",
    };
  }
  const records = [...usage, ...unlinkedHttp];
  const knownRequestIds = new Set(
    records.map((record) => record.network_request_id).filter(Boolean),
  );
  for (const logged of logRecords) {
    if (knownRequestIds.has(logged.network_request_id)) {
      const index = records.findIndex((record) =>
        record.network_request_id === logged.network_request_id);
      if (index >= 0) records[index] = mergeLogEvidence(records[index], logged);
      continue;
    }
    const candidates = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) =>
        record.network_request_id === null
        && record.session_id === logged.session_id
        && record.turn_id === logged.turn_id
        && record.query_source === logged.query_source
        && record.attempt === logged.attempt
        && sameTimestamp(record.started_at, logged.started_at, LINK_WINDOW_MS));
    if (candidates.length === 1) {
      const { index } = candidates[0];
      records[index] = {
        ...records[index],
        network_request_id: logged.network_request_id,
        transport_kind: "official_native_sqlite+official_native_log",
        endpoint_host: logged.endpoint_host,
        endpoint_path: logged.endpoint_path,
        evidence_source: evidenceWithNativeLog(records[index]),
        http_status: logged.http_status,
        http_method: logged.http_method,
        model_transport: logged.model_transport,
        provider_kind: logged.provider_kind,
        response_headers_at: logged.response_headers_at,
        lifecycle_events: logged.lifecycle_events,
        lifecycle_event_count: logged.lifecycle_event_count,
        request_status: logged.request_status,
        query_id: logged.query_id,
        base_url: logged.base_url,
        link_confidence: "SUPPORTED_SESSION_TURN_QUERY_SOURCE_TIME",
      };
    } else {
      records.push(logged);
    }
    knownRequestIds.add(logged.network_request_id);
  }
  return records.sort((left, right) =>
    String(left.started_at).localeCompare(String(right.started_at)));
}

export function aggregateRequestUsage(records) {
  const observed = records.filter((record) =>
    record.evidence_source.includes("model_usage")
    && ["OBSERVED", "PARTIAL"].includes(record.usage_status));
  const totals = observed.reduce(
    (result, record) => {
      result.cached_input_tokens += numeric(record.cached_input_tokens);
      result.uncached_input_tokens += numeric(record.uncached_input_tokens);
      result.output_tokens += numeric(record.output_tokens);
      result.total_tokens += numeric(record.total_tokens);
      return result;
    },
    {
      cached_input_tokens: 0,
      uncached_input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  );
  return {
    request_usage: totals,
    model_usage_records: records.filter((record) =>
      record.evidence_source.includes("model_usage")).length,
    observed_usage_records: observed.length,
    auxiliary_records: observed.filter((record) => record.request_kind !== "model_main_turn").length,
    auxiliary_request_records: records.filter((record) =>
      record.request_kind !== "model_main_turn").length,
    usage_missing_records: records.filter((record) =>
      record.usage_status === "USAGE_MISSING").length,
  };
}

export function deriveProbeCoverage({
  usageRecords,
  modelIoRecords,
  logRecords = [],
  records,
  protocolCoverage = null,
}) {
  const linked = records.filter((record) => record.link_confidence).length;
  const networkRecords = records.filter((record) => record.network_request_id);
  const endpointObserved = networkRecords.filter((record) =>
    record.endpoint_host && record.endpoint_path).length;
  const statusObserved = networkRecords.filter((record) =>
    record.http_status !== null && record.http_status !== "UNKNOWN").length;
  const logOnly = records.some((record) =>
    record.evidence_source.includes("official_native_log")
    && !record.evidence_source.includes("model_io")
    && !record.evidence_source.includes("model_usage"));
  const usageMissing = records.some((record) => record.usage_status === "USAGE_MISSING");
  const rpcObserved = (protocolCoverage?.rpc_event_types?.length ?? 0) > 0;
  return {
    PROBE_COVERAGE: usageRecords.length > 0 && modelIoRecords.length > 0 ? "PARTIAL" : "INCOMPLETE",
    MODEL_REQUEST_COVERAGE: usageRecords.length > 0
      ? logRecords.length > 0
        ? "SQLITE_MODEL_IO_AND_LOG"
        : linked === usageRecords.length
          ? "SQLITE_AND_MODEL_IO"
          : "SQLITE_WITH_PARTIAL_MODEL_IO"
      : "NOT_OBSERVED",
    AUTH_METADATA_COVERAGE: "NOT_OBSERVED",
    NON_MODEL_HTTP_COVERAGE: "NOT_OBSERVED",
    RPC_COVERAGE: rpcObserved ? "LIFECYCLE_PARTIAL" : "NOT_OBSERVED",
    HTTP_ENDPOINT_COVERAGE: networkRecords.length > 0
      && endpointObserved === networkRecords.length
      ? "OBSERVED"
      : endpointObserved > 0
        ? "PARTIAL"
        : "NOT_OBSERVED",
    HTTP_STATUS_COVERAGE: networkRecords.length > 0
      && statusObserved === networkRecords.length
      ? "OBSERVED"
      : statusObserved > 0
        ? "PARTIAL"
        : "NOT_OBSERVED",
    AUXILIARY_REQUEST_COVERAGE: records.some((record) =>
      record.request_kind !== "model_main_turn")
      ? logOnly
        ? "MODEL_AUXILIARY_HTTP_AND_LOG"
        : "MODEL_AUXILIARY_OBSERVED_ONLY"
      : "NOT_OBSERVED",
    UNOBSERVED_BOUNDARIES: [
      "non_model_account_oauth_project_and_token_http",
      ...(rpcObserved ? ["native_rpc_request_payloads"] : ["native_rpc_lifecycle"]),
      "model_http_method",
      ...(usageMissing ? ["auxiliary_model_usage_redacted_or_absent"] : []),
    ],
  };
}

function queryUsageRows(dbPath, startedAt, completedAt) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    const columns = MODEL_USAGE_FIELDS.join(", ");
    return db.prepare(
      `SELECT ${columns}
       FROM model_usage
       WHERE started_at >= ? AND started_at <= ?
       ORDER BY started_at ASC, attempt_index ASC, id ASC`,
    ).all(startedAt, completedAt);
  } finally {
    db.close();
  }
}

async function readModelIoDirectories(directories, startedAt, completedAt, context) {
  const recordsByRequestId = new Map();
  let invalidLines = 0;
  const files = [];
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/^model-io-.*\.jsonl$/u.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      const metadata = await stat(filePath).catch(() => null);
      if (!metadata?.isFile() || metadata.mtimeMs < startedAt - 3_600_000) continue;
      const parsed = parseModelIoJsonl(await readFile(filePath, "utf8"), context);
      invalidLines += parsed.invalidLines;
      files.push(filePath);
      for (const record of parsed.records) {
        const timestamp = Date.parse(record.started_at);
        if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > completedAt) continue;
        const key = record.network_request_id;
        if (!key || !recordsByRequestId.has(key)) recordsByRequestId.set(key, record);
      }
    }
  }
  return { records: [...recordsByRequestId.values()], files, invalidLines };
}

async function readModelRequestLogDirectories(directories, startedAt, completedAt, context) {
  const recordsByRequestId = new Map();
  const rpcEventTypes = new Set();
  let rpcStartedEvents = 0;
  let rpcCompletedEvents = 0;
  let rpcFailedEvents = 0;
  let invalidLines = 0;
  const files = [];
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/^zcode-.*\.jsonl$/u.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      const metadata = await stat(filePath).catch(() => null);
      if (!metadata?.isFile() || metadata.mtimeMs < startedAt - 3_600_000) continue;
      const text = await readFile(filePath, "utf8");
      const parsed = parseModelLifecycleLogJsonl(text, context);
      const rpc = summarizeNativeProtocolLog(text, startedAt, completedAt);
      invalidLines += parsed.invalidLines;
      files.push(filePath);
      for (const eventType of rpc.rpc_event_types) rpcEventTypes.add(eventType);
      rpcStartedEvents += rpc.rpc_started_events;
      rpcCompletedEvents += rpc.rpc_completed_events;
      rpcFailedEvents += rpc.rpc_failed_events;
      for (const record of parsed.records) {
        const timestamp = Date.parse(record.completed_at);
        if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > completedAt) continue;
        if (!recordsByRequestId.has(record.network_request_id)) {
          recordsByRequestId.set(record.network_request_id, record);
        }
      }
    }
  }
  return {
    records: [...recordsByRequestId.values()],
    files,
    invalidLines,
    rpc: {
      rpc_event_types: [...rpcEventTypes].sort(),
      rpc_started_events: rpcStartedEvents,
      rpc_completed_events: rpcCompletedEvents,
      rpc_failed_events: rpcFailedEvents,
    },
  };
}

async function collectProbeResult(options, completedAt) {
  const startedAt = Date.parse(options.startedAt);
  const usageRows = queryUsageRows(options.dbPath, startedAt, completedAt);
  const context = {
    experimentId: options.experimentId,
    clientVersion: options.clientVersion,
    runtimeVersion: options.runtimeVersion,
  };
  const usageRecords = usageRows.map((row) => projectModelUsageRow(row, context));
  const modelIo = await readModelIoDirectories(
    options.modelIoDirs,
    startedAt,
    completedAt,
    context,
  );
  const logEvents = await readModelRequestLogDirectories(
    options.logDirs,
    startedAt,
    completedAt,
    context,
  );
  const records = mergeNativeEvidence(usageRecords, modelIo.records, logEvents.records);
  const aggregate = aggregateRequestUsage(records);
  const coverage = deriveProbeCoverage({
    usageRecords,
    modelIoRecords: modelIo.records,
    logRecords: logEvents.records,
    records,
    protocolCoverage: logEvents.rpc,
  });
  const networkRecords = records.filter((record) => record.network_request_id);
  return {
    schema_version: NATIVE_PROBE_SCHEMA_VERSION,
    kind: "native_request_probe_result",
    experiment_id: options.experimentId,
    started_at: options.startedAt,
    completed_at: new Date(completedAt).toISOString(),
    database_path: options.dbPath,
    model_io_files: modelIo.files,
    model_io_invalid_lines: modelIo.invalidLines,
    log_files: logEvents.files,
    log_invalid_lines: logEvents.invalidLines,
    log_model_request_records: logEvents.records.length,
    protocol_coverage: logEvents.rpc,
    model_http_attempts: networkRecords.length,
    main_http_attempts: networkRecords.filter((record) =>
      record.request_kind === "model_main_turn").length,
    auxiliary_http_attempts: networkRecords.filter((record) =>
      record.request_kind !== "model_main_turn").length,
    retry_attempts: networkRecords.filter((record) => record.attempt > 1).length,
    ...aggregate,
    coverage,
    records,
  };
}

async function writeProbeOutputs(outDir, result) {
  await mkdir(outDir, { recursive: true });
  const requestsPath = path.join(outDir, "requests.jsonl");
  await writeFile(
    requestsPath,
    `${result.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const summary = { ...result };
  delete summary.records;
  await atomicWriteJson(path.join(outDir, "request-usage.json"), summary);
  await atomicWriteJson(path.join(outDir, "probe-result.json"), result);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fileExists(filePath) {
  return stat(filePath).then(() => true, () => false);
}

export async function watch(options, dependencies = {}) {
  await mkdir(options.outDir, { recursive: true });
  const startedAt = options.startedAt;
  const deadline = Date.now() + options.durationMs;
  let lastError = null;
  await atomicWriteJson(path.join(options.outDir, "probe-heartbeat.json"), {
    schema_version: NATIVE_PROBE_SCHEMA_VERSION,
    status: "RUNNING",
    experiment_id: options.experimentId,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    database_path: options.dbPath,
    model_io_dirs: options.modelIoDirs,
    log_dirs: options.logDirs,
    stop_file: options.stopFile,
  });
  while (Date.now() < deadline) {
    if (options.stopFile && await fileExists(options.stopFile)) break;
    try {
      const completedAt = Date.now();
      const result = await collectProbeResult(options, completedAt);
      await writeProbeOutputs(options.outDir, result);
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(options.pollMs);
  }
  const completedAt = Date.now();
  const result = await collectProbeResult(options, completedAt);
  await writeProbeOutputs(options.outDir, result);
  await atomicWriteJson(path.join(options.outDir, "probe-heartbeat.json"), {
    schema_version: NATIVE_PROBE_SCHEMA_VERSION,
    status: "COMPLETED",
    experiment_id: options.experimentId,
    started_at: startedAt,
    updated_at: new Date(completedAt).toISOString(),
    last_error: lastError,
    database_path: options.dbPath,
    model_io_dirs: options.modelIoDirs,
    log_dirs: options.logDirs,
    stop_file: options.stopFile,
  });
  return result;
}

export async function rescan(options) {
  const completedAt = Date.parse(options.endedAt);
  const result = await collectProbeResult(options, completedAt);
  await writeProbeOutputs(options.outDir, result);
  await atomicWriteJson(path.join(options.outDir, "probe-heartbeat.json"), {
    schema_version: NATIVE_PROBE_SCHEMA_VERSION,
    status: "COMPLETED",
    experiment_id: options.experimentId,
    started_at: options.startedAt,
    updated_at: new Date(completedAt).toISOString(),
    last_error: null,
    database_path: options.dbPath,
    model_io_dirs: options.modelIoDirs,
    log_dirs: options.logDirs,
    stop_file: options.stopFile,
  });
  return result;
}

export async function run(argv, dependencies = {}) {
  const options = parseArgs(argv);
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const result = options.command === "rescan"
    ? await rescan(options)
    : await watch(options, dependencies);
  if (options.json) stdout(`${JSON.stringify(result, null, 2)}\n`);
  else {
    stdout(
      `native probe written: ${path.relative(PROJECT_ROOT, options.outDir).replaceAll(path.sep, "/")}\n`,
    );
  }
  return result;
}

async function main() {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: "native_request_probe_error",
        message: error instanceof Error ? error.message : String(error),
      },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
