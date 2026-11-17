import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import core from "./network-observer-core.cjs";

export const NETWORK_TARGET_INVENTORY = Object.freeze([
  {
    process_role: "bridge_main_or_experiment_harness",
    network_clients: ["global fetch / undici", "node:http.request", "node:https.request"],
    observation: ["preload fetch wrapper", "diagnostics_channel", "node:http / node:https wrapper"],
  },
  {
    process_role: "bridge_worker",
    network_clients: ["global fetch / undici", "node:http.request", "node:https.request"],
    observation: ["NODE_OPTIONS preload", "diagnostics_channel", "node:http / node:https wrapper"],
  },
  {
    process_role: "official_app_server",
    network_clients: ["bundled undici fetch", "node:http", "node:https", "websocket"],
    observation: [
      "NODE_OPTIONS preload",
      "undici diagnostics_channel",
      "node:http diagnostics",
      "official process/networkCapture",
    ],
  },
  {
    process_role: "node_helper_children",
    network_clients: ["global fetch / undici", "node:http.request", "node:https.request"],
    observation: ["inherited NODE_OPTIONS preload", "diagnostics_channel"],
  },
  {
    process_role: "zcode_runtime_host_helper",
    network_clients: ["no JavaScript network client observed"],
    observation: ["process-tree inventory", "official AppServer cross-check"],
    status: "PROCESS_CONTROL_ONLY",
  },
]);

export {
  core as networkObserverCore,
  core,
};

export function createStableId(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export async function readWireEvidence(directory) {
  const events = [];
  const invalidLines = [];
  let files = [];
  try {
    files = (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { files: [], events, records: [], invalid_lines: invalidLines };
  }
  for (const name of files) {
    const filePath = path.join(directory, name);
    const text = await readFile(filePath, "utf8");
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        invalidLines.push({ file: name, line: index + 1 });
      }
    }
  }
  return {
    files,
    events,
    records: core.mergeNetworkEvents(events.filter((event) =>
      event?.kind === "cost_lab_network_wire_event")),
    invalid_lines: invalidLines,
  };
}

export function normalizeUsage(usage) {
  const numeric = {};
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) numeric[key.toLowerCase()] = value;
  }
  const pick = (...keys) => {
    for (const key of keys) {
      if (Number.isFinite(numeric[key])) return numeric[key];
    }
    return null;
  };
  const input = pick("input_tokens", "prompt_tokens", "inputtokens");
  const output = pick("output_tokens", "completion_tokens", "outputtokens");
  const cached = pick(
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cache_read_tokens",
    "cachedinputtokens",
    "cachereadinputtokens",
  );
  const cacheWrite = pick("cache_creation_input_tokens", "cache_write_tokens");
  const total = pick("total_tokens", "totaltokens") ??
    (input !== null && output !== null ? input + output : null);
  const uncached = input !== null && cached !== null ? Math.max(0, input - cached) : input;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    uncached_input_tokens: uncached,
    cache_write_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: total,
    raw_keys: Object.keys(usage ?? {}).sort(),
  };
}

export function modelRequestShape(record) {
  const structure = record?.request_body?.structure;
  if (!structure || record?.endpoint_kind !== "model_provider") return null;
  return {
    model: structure.safe_scalars?.model ?? null,
    stream: structure.safe_scalars?.stream ?? null,
    max_tokens: structure.safe_scalars?.max_tokens ?? null,
    temperature: structure.safe_scalars?.temperature ?? null,
    top_p: structure.safe_scalars?.top_p ?? null,
    reasoning: structure.safe_scalars?.thinking ?? structure.safe_scalars?.reasoning ?? null,
    messages: structure.messages ?? null,
    system: structure.system ?? null,
    tools: structure.tools ?? null,
    metadata_keys: structure.metadata?.keys ?? [],
    cache_control_count: structure.cache_control_count ?? 0,
  };
}

export function authFingerprints(record) {
  const auth = Array.isArray(record?.request_auth) ? record.request_auth : [];
  return auth.map((entry) => ({
    header: entry.header,
    scheme: entry.scheme ?? null,
    token_fingerprint: entry.token?.sha256 ?? null,
    token_length: entry.token?.length ?? null,
    jwt: entry.jwt ?? null,
  }));
}

export function correlateOfficialCapture(records, officialCaptures) {
  const pending = records.map((record) => ({
    record,
    used: false,
    match: null,
  }));
  const unmatchedOfficial = [];
  for (const capture of officialCaptures) {
    const captureTime = Number(capture?.timestamp);
    const captureUrl = capture?.endpoint_host !== undefined
      ? { host: capture.endpoint_host, path: capture.endpoint_path }
      : new URLSafeCapture(capture?.url);
    let best = null;
    for (const candidate of pending) {
      if (candidate.used) continue;
      const record = candidate.record;
      if (String(record.http_method).toUpperCase() !== String(capture.method).toUpperCase()) {
        continue;
      }
      if (record.endpoint_host !== captureUrl.host || record.endpoint_path !== captureUrl.path) {
        continue;
      }
      const recordTime = Date.parse(record.request_started_at);
      const difference = Math.abs(recordTime - captureTime);
      if (!Number.isFinite(difference) || difference > 5000) continue;
      if (!best || difference < best.difference) best = { candidate, difference };
    }
    if (!best) {
      unmatchedOfficial.push(capture);
    } else {
      best.candidate.used = true;
      best.candidate.match = {
        timestamp: capture.timestamp,
        pid: capture.pid,
        time_delta_ms: Math.round(best.difference),
      };
    }
  }
  return {
    matched: pending.filter((entry) => entry.used).map((entry) => ({
      record_id: entry.record.record_id,
      capture: entry.match,
    })),
    unmatched_official: unmatchedOfficial,
    preload_only: pending.filter((entry) => !entry.used).map((entry) =>
      entry.record.record_id),
  };
}

export function sanitizeOfficialCapture(record) {
  const parts = core.urlParts(record?.url);
  return {
    timestamp: Number.isFinite(record?.timestamp) ? record.timestamp : null,
    process_type: typeof record?.processType === "string" ? record.processType : null,
    pid: Number.isSafeInteger(record?.pid) ? record.pid : null,
    method: typeof record?.method === "string" ? record.method.toUpperCase() : null,
    endpoint_host: parts.host,
    endpoint_path: parts.path,
    endpoint_path_parameter_fingerprints: parts.path_parameter_fingerprints,
  };
}

function URLSafeCapture(rawUrl) {
  const parts = core.urlParts(rawUrl);
  return { host: parts.host, path: parts.path };
}

export function coverageSummary({
  records,
  officialCaptures,
  officialDropped = 0,
  invalidLines = [],
  preloadInitEvents = [],
  rpcTrace = [],
  identity = null,
  requiredProcessRoles = [
    "bridge_main_or_experiment_harness",
    "official_app_server",
  ],
}) {
  const officialRecords = records.filter((record) =>
    record.process_role === "official_app_server");
  const nonOfficialRecords = records.filter((record) =>
    record.process_role !== "official_app_server");
  const official = correlateOfficialCapture(officialRecords, officialCaptures);
  const nonOfficialPreloadOnly = nonOfficialRecords.map((record) => record.record_id);
  const completed = records.filter((record) =>
    record.request_status && record.request_status !== "pending");
  const statusObserved = records.filter((record) =>
    Number.isFinite(record.http_status) || record.request_status === "failed");
  const headerObserved = records.filter((record) =>
    Array.isArray(record.request_header_presence));
  const terminalObserved = records.filter((record) =>
    typeof record.request_status === "string" && record.request_status !== "pending");
  const bodies = records.filter((record) =>
    record.request_body?.present === true);
  const expectedRequestBodies = records.filter((record) =>
    ["POST", "PUT", "PATCH"].includes(String(record.http_method).toUpperCase()));
  const requestBodiesComplete = expectedRequestBodies.every((record) =>
    record.request_body?.present === true);
  const responseBodies = records.filter((record) =>
    record.response_body?.present === true);
  const usageMissing = records.filter((record) =>
    record.endpoint_kind === "model_provider" &&
    (!record.usage_status || record.usage_status !== "OBSERVED"));
  const methods = [...new Set(records.map((record) =>
    String(record.http_method ?? "UNKNOWN").toUpperCase()))].sort();
  const transports = [...new Set(records.map((record) => record.transport ?? "UNKNOWN"))].sort();
  const endpointKinds = [...new Set(records.map((record) =>
    record.endpoint_kind ?? "unknown"))].sort();
  const initializedRoles = [...new Set(preloadInitEvents.map((event) =>
    event?.process_role).filter(Boolean))].sort();
  const missingRequiredRoles = requiredProcessRoles.filter((role) =>
    !initializedRoles.includes(role));
  const processBoundRecords = records.filter((record) =>
    initializedRoles.includes(record.process_role));
  const methodCoverageComplete =
    records.length > 0 &&
    processBoundRecords.length === records.length &&
    records.every((record) =>
      typeof record.http_method === "string" &&
      /^[A-Z][A-Z0-9_-]{1,15}$/u.test(record.http_method)) &&
    methods.includes("GET") &&
    methods.includes("POST");
  const rpcStructured = rpcTrace.filter((entry) =>
    typeof entry.rpc_id === "string" &&
    typeof entry.started_at === "string" &&
    typeof entry.completed_at === "string" &&
    entry.request_shape &&
    entry.response_shape);
  const protocolModelRecords = records.filter((record) =>
    record.endpoint_kind === "model_provider");
  const untracedModelRecords = protocolModelRecords.filter((record) => {
    const started = Date.parse(record.request_started_at);
    return !rpcTrace.some((entry) =>
      entry.method === "session/send" &&
      entry.status === "PASS" &&
      Number.isFinite(started) &&
      Number.isFinite(Date.parse(entry.started_at)) &&
      started >= Date.parse(entry.started_at) - 1_000 &&
      started <= Date.parse(entry.started_at) + 30_000);
  });
  const failedPreloadOnly = official.preload_only
    .map((recordId) => officialRecords.find((record) => record.record_id === recordId))
    .filter((record) =>
      record &&
      ["failed", "cancelled", "timeout"].includes(record.request_status) &&
      typeof record.request_completed_at === "string" &&
      Array.isArray(record.request_header_presence) &&
      (!["POST", "PUT", "PATCH"].includes(String(record.http_method).toUpperCase()) ||
        record.request_body?.present === true));
  const unexplainedPreloadOnly = official.preload_only.filter((recordId) =>
    !failedPreloadOnly.some((record) => record.record_id === recordId));
  const officialCoverageComplete =
    officialRecords.length > 0 &&
    officialCaptures.length > 0 &&
    official.unmatched_official.length === 0 &&
    official.matched.length > 0 &&
    unexplainedPreloadOnly.length === 0 &&
    officialDropped === 0 &&
    invalidLines.length === 0;
  const requiredRolesObserved = missingRequiredRoles.length === 0;
  const identityComplete =
    identity?.host_request_auth?.present === true &&
    identity?.api_key_parity === "MATCH" &&
    identity?.api_key_id_parity === "MATCH" &&
    identity?.account_scope_observed === "HOST_OBSERVED";
  const rpcCoverageComplete =
    rpcTrace.length > 0 &&
    rpcStructured.length === rpcTrace.length &&
    untracedModelRecords.length === 0;
  const nonModelComplete =
    records.some((record) =>
      record.endpoint_kind !== "model_provider" &&
      record.endpoint_kind !== "unknown") &&
    records.every((record) => record.endpoint_kind !== "unknown");
  const probeComplete =
    requiredRolesObserved &&
    officialCoverageComplete &&
    methodCoverageComplete &&
    nonModelComplete &&
    rpcCoverageComplete &&
    identityComplete &&
    headerObserved.length === records.length &&
    statusObserved.length === records.length &&
    terminalObserved.length === records.length &&
    requestBodiesComplete;
  return {
    PROBE_COVERAGE: probeComplete ? "COMPLETE" : "PARTIAL",
    HTTP_METHOD_COVERAGE: methodCoverageComplete ? "COMPLETE" : "PARTIAL",
    NON_MODEL_HTTP_COVERAGE: nonModelComplete ? "COMPLETE" : "PARTIAL",
    RPC_COVERAGE: rpcCoverageComplete ? "COMPLETE" : "PARTIAL",
    IDENTITY_OBSERVABILITY: identityComplete
      ? "COMPLETE"
      : identity?.host_request_auth?.present
        ? "PARTIAL"
        : "NOT_OBSERVED",
    AUXILIARY_USAGE_COVERAGE: usageMissing.length === 0
      ? "OBSERVED"
      : "PARTIAL_WITH_USAGE_MISSING",
    missing_required_process_roles: missingRequiredRoles,
    initialized_process_roles: initializedRoles,
    rpc_structured: rpcStructured.length,
    rpc_total: rpcTrace.length,
    untraced_model_records: untracedModelRecords.map((record) => record.record_id),
    identity,
    counts: {
      wire_records: records.length,
      process_bound_records: processBoundRecords.length,
      official_capture_records: officialCaptures.length,
      official_records: officialRecords.length,
      matched: official.matched.length,
      preload_only: official.preload_only.length,
      failed_preload_only: failedPreloadOnly.length,
      unexplained_preload_only: unexplainedPreloadOnly.length,
      non_official_preload_only: nonOfficialPreloadOnly.length,
      unmatched_official: official.unmatched_official.length,
      official_dropped: officialDropped,
      completed: completed.length,
      terminal_observed: terminalObserved.length,
      status_observed: statusObserved.length,
      request_headers_observed: headerObserved.length,
      request_bodies_observed: bodies.length,
      response_bodies_observed: responseBodies.length,
      model_usage_missing: usageMissing.length,
    },
    methods,
    transports,
    endpoint_kinds: endpointKinds,
    official: {
      matched: official.matched,
      unmatched_official: official.unmatched_official,
      preload_only: official.preload_only,
      failed_preload_only: failedPreloadOnly.map((record) => record.record_id),
      unexplained_preload_only: unexplainedPreloadOnly,
      non_official_preload_only: nonOfficialPreloadOnly,
    },
  };
}

export function safeRpcShape(value, depth = 0) {
  if (depth > 8) return { type: "depth_limit" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.length > 0 ? [safeRpcShape(value[0], depth + 1)] : [],
    };
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      const safe = core.safeScalar(value);
      return { type: "string", value: typeof safe === "string" ? safe : safe };
    }
    return { type: typeof value, value: typeof value === "number" ? value : undefined };
  }
  const shape = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (/apikey|token|authorization|credential|cookie|secret/iu.test(normalized)) {
      shape[key] = { type: typeof child, redacted: true };
    } else {
      shape[key] = safeRpcShape(child, depth + 1);
    }
  }
  return shape;
}

export function summarizeRequestAuth(requestAuth) {
  if (!requestAuth || typeof requestAuth !== "object") {
    return { present: false, normalized: true };
  }
  return {
    present: true,
    normalized: true,
    api_key: core.fingerprint(requestAuth.apiKey),
    api_key_id: core.fingerprint(requestAuth.apiKeyId),
    account_scope: core.fingerprint(requestAuth.accountScope),
    header_names: Object.keys(requestAuth.headers ?? {}).map((name) =>
      name.toLowerCase()).sort(),
    header_fingerprints: Object.fromEntries(
      Object.entries(requestAuth.headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        /authorization|api[-_]?key|cookie/iu.test(name)
          ? core.fingerprint(String(value))
          : core.safeScalar(String(value)),
      ]),
    ),
  };
}

export function compareIdentitySurfaces(hostRequestAuth, wireRecords) {
  const host = hostRequestAuth?.normalized === true
    ? hostRequestAuth
    : summarizeRequestAuth(hostRequestAuth);
  const modelRecords = wireRecords.filter((record) =>
    record.endpoint_kind === "model_provider");
  const wire = modelRecords.map((record) => ({
    record_id: record.record_id,
    endpoint_path: record.endpoint_path,
    auth: authFingerprints(record),
  }));
  const hostApiKeyHash = host.api_key?.sha256 ?? null;
  const wireApiKeyHashes = new Set(
    wire.flatMap((entry) => entry.auth)
      .filter((entry) => !/(?:api[-_]?key[-_]?id)$/iu.test(entry.header ?? ""))
      .map((entry) => entry.token_fingerprint)
      .filter(Boolean),
  );
  const wireApiKeyIdHashes = new Set(
    wire.flatMap((entry) => entry.auth)
      .filter((entry) => /(?:api[-_]?key[-_]?id)$/iu.test(entry.header ?? ""))
      .map((entry) => entry.token_fingerprint)
      .filter(Boolean),
  );
  const projectPathApiKeyIdHashes = new Set(
    wireRecords.flatMap((record) =>
      (record.endpoint_path_parameter_fingerprints ?? [])
        .filter((entry) => entry?.kind === "api_key_id")
        .map((entry) => entry.fingerprint?.sha256)
        .filter(Boolean)),
  );
  const projectIdentityParameterFingerprints = {};
  for (const record of wireRecords) {
    for (const entry of record.endpoint_path_parameter_fingerprints ?? []) {
      if (!["organization_id", "project_id", "api_key_id"].includes(entry?.kind)) continue;
      const hash = entry?.fingerprint?.sha256;
      if (!hash) continue;
      const hashes = new Set(projectIdentityParameterFingerprints[entry.kind] ?? []);
      hashes.add(hash);
      projectIdentityParameterFingerprints[entry.kind] = [...hashes].sort();
    }
  }
  for (const hash of projectPathApiKeyIdHashes) wireApiKeyIdHashes.add(hash);
  const hostApiKeyIdHash = host.api_key_id?.sha256 ?? null;
  const apiKeyIdTransport =
    wireApiKeyIdHashes.size > 0
      ? projectPathApiKeyIdHashes.size > 0
        ? "PROJECT_PATH"
        : "WIRE_HEADER"
      : hostApiKeyIdHash
        ? "HOST_ONLY"
        : "NOT_OBSERVED";
  return {
    host_request_auth: host,
    wire_model_requests: wire,
    api_key_parity: hostApiKeyHash === null || wireApiKeyHashes.size === 0
      ? "UNKNOWN"
      : wireApiKeyHashes.size === 1 && wireApiKeyHashes.has(hostApiKeyHash)
        ? "MATCH"
        : "DIFFERENT",
    api_key_id_parity: hostApiKeyIdHash === null || wireApiKeyIdHashes.size === 0
      ? "UNKNOWN"
      : wireApiKeyIdHashes.size === 1 && wireApiKeyIdHashes.has(hostApiKeyIdHash)
        ? "MATCH"
        : "DIFFERENT",
    api_key_id_transport: apiKeyIdTransport,
    account_scope_observed: host.account_scope ? "HOST_OBSERVED" : "NOT_EXPOSED",
    project_identity_parameters_observed: projectPathApiKeyIdHashes.size > 0,
    project_identity_parameter_fingerprints: projectIdentityParameterFingerprints,
  };
}

export function correlateRpcToHttp(rpcTrace, records) {
  const modelSends = rpcTrace.filter((entry) =>
    entry.method === "session/send" && entry.status === "PASS");
  const runtimeAuthRequests = rpcTrace.filter((entry) =>
    entry.direction === "inbound" &&
    entry.method === "interaction/requestProviderRuntimeHeaders" &&
    entry.status === "PASS");
  const terminals = rpcTrace.filter((entry) =>
    entry.method === "session/event:terminal" || entry.kind === "terminal_event");
  return records
    .filter((record) => record.endpoint_kind === "model_provider")
    .map((record) => {
      const started = Date.parse(record.request_started_at);
      const candidates = modelSends.map((entry) => ({
        entry,
        delta: started - Date.parse(entry.started_at),
      })).filter((item) => Number.isFinite(item.delta) && item.delta >= -1000 &&
        item.delta <= 30_000);
      candidates.sort((left, right) => Math.abs(left.delta) - Math.abs(right.delta));
      const parent = candidates[0]?.entry ?? null;
      const runtimeAuth = runtimeAuthRequests
        .filter((entry) => Date.parse(entry.started_at) >= started - 30_000 &&
          Date.parse(entry.started_at) <= started + 1_000)
        .sort((left, right) =>
          Math.abs(Date.parse(right.started_at) - started) -
          Math.abs(Date.parse(left.started_at) - started))[0] ?? null;
      const terminal = terminals.find((entry) =>
        Date.parse(entry.started_at) >= started);
      return {
        record_id: record.record_id,
        endpoint_path: record.endpoint_path,
        rpc_parent_id: parent?.rpc_id ?? null,
        rpc_parent_method: parent?.method ?? null,
        rpc_delta_ms: parent ? Math.round(parent.delta) : null,
        runtime_auth_rpc_id: runtimeAuth?.rpc_id ?? null,
        terminal_rpc_id: terminal?.rpc_id ?? null,
        correlation: parent ? "SUPPORTED_TIME_WINDOW" : "UNATTRIBUTED",
      };
    });
}
