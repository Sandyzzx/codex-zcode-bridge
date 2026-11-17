"use strict";

const { createHash } = require("node:crypto");

const MAX_SUMMARY_TEXT_BYTES = 2 * 1024 * 1024;

const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-api-key-id",
  "api-key-id",
  "x-coding-plan-api-key-id",
  "x-bigmodel-authorization",
  "x-coding-plan-api-key",
]);

const SAFE_HEADER_VALUES = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "eagleid",
  "ga-traceid",
  "server",
  "transfer-encoding",
  "user-agent",
  "via",
  "x-client-language",
  "x-client-timezone",
  "x-log-id",
  "x-os-category",
  "x-os-version",
  "x-platform",
  "x-process-time",
  "x-query-id",
  "x-release-channel",
  "x-request-id",
  "x-session-id",
  "x-site-cache-status",
  "x-title",
  "x-trace-id",
  "x-zcode-agent",
  "x-zcode-app-version",
  "x-zcode-query-source",
  "x-zcode-session-features",
  "x-zcode-session-type",
  "x-zcode-trace-id",
]);

const SAFE_METADATA_KEYS = new Set([
  "accountscope",
  "campaign",
  "codingplan",
  "discount",
  "entitlement",
  "entitlements",
  "free",
  "id",
  "messageid",
  "model",
  "multiplier",
  "plan",
  "quota",
  "quotalimit",
  "quota_level",
  "ratelimit",
  "ratelimitremaining",
  "requestid",
  "responseid",
  "stopreason",
  "subscription",
  "type",
]);

const SAFE_REQUEST_SCALAR_KEYS = new Set([
  "model",
  "stream",
  "max_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "top_k",
  "thinking",
  "reasoning",
  "reasoning_effort",
  "tool_choice",
  "service_tier",
]);

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function secretFingerprint(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return {
    sha256: sha256Hex(normalized),
    length: normalized.length,
    prefix_kind: normalized.startsWith("Bearer ") ? "bearer_prefixed" : "opaque",
  };
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function summarizeJwt(token) {
  if (typeof token !== "string") return null;
  const normalized = token.replace(/^Bearer\s+/iu, "").trim();
  const parts = normalized.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(decodeBase64Url(parts[0]));
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") {
      return null;
    }
    const scalar = (value) => {
      if (typeof value === "string") return value.slice(0, 256);
      if (typeof value === "number" || typeof value === "boolean") return value;
      return null;
    };
    return {
      alg: scalar(header.alg),
      typ: scalar(header.typ),
      iss: scalar(payload.iss),
      aud: scalar(payload.aud),
      scope: scalar(payload.scope),
      exp: scalar(payload.exp),
      iat: scalar(payload.iat),
      sub: typeof payload.sub === "string" ? secretFingerprint(payload.sub) : null,
      user_id: typeof payload.user_id === "string"
        ? secretFingerprint(payload.user_id)
        : typeof payload.userId === "string"
          ? secretFingerprint(payload.userId)
          : null,
    };
  } catch {
    return null;
  }
}

function rawHeaderEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === "function" && !Array.isArray(headers)) {
    return [...headers.entries()].map(([name, value]) => [String(name), String(value)]);
  }
  const entries = [];
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      entries.push([String(headers[index]), String(headers[index + 1])]);
    }
    return entries;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) entries.push([String(name), String(item)]);
    } else if (value !== undefined && value !== null) {
      entries.push([String(name), String(value)]);
    }
  }
  return entries;
}

function normalizeHeaders(headers) {
  const normalized = new Map();
  for (const [rawName, value] of rawHeaderEntries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const values = normalized.get(name) ?? [];
    values.push(value);
    normalized.set(name, values);
  }
  return normalized;
}

function headerValue(headers, name) {
  return normalizeHeaders(headers).get(name.toLowerCase())?.at(-1) ?? null;
}

function safeScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (value.length > 256) return { sha256: sha256Hex(value), length: value.length };
  if (/(?:bearer\s+|eyJ[a-zA-Z0-9_-]{10,}|sk-[a-zA-Z0-9_-]{8,})/iu.test(value)) {
    return { redacted: true, sha256: sha256Hex(value), length: value.length };
  }
  return value;
}

function summarizeAuthorizationValue(name, rawValue) {
  if (!rawValue) return null;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9_-]{0,31})\s+(.+)$/u.exec(rawValue);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  const token = schemeMatch ? schemeMatch[2] : rawValue;
  return {
    header: name,
    scheme,
    token: secretFingerprint(token),
    jwt: summarizeJwt(token),
  };
}

function summarizeHeaders(headers, { response = false } = {}) {
  const normalized = normalizeHeaders(headers);
  const names = [...normalized.keys()].sort();
  const safeValues = {};
  const auth = [];
  for (const name of names) {
    const rawValue = normalized.get(name)?.at(-1) ?? "";
    if (AUTH_HEADER_NAMES.has(name)) {
      const summary = summarizeAuthorizationValue(name, rawValue);
      if (summary) auth.push(summary);
      continue;
    }
    if (SAFE_HEADER_VALUES.has(name) ||
        name.startsWith("x-ratelimit-") ||
        name.startsWith("ratelimit-")) {
      const value = safeScalar(rawValue);
      if (value !== null) safeValues[name] = value;
    }
  }
  return {
    names,
    auth,
    safe_values: safeValues,
    set_cookie_present: response && names.includes("set-cookie"),
  };
}

const IDENTITY_PATH_PARAMETERS = Object.freeze([
  {
    pattern: /\/organization\/([^/]+)/u,
    template: "/organization/{organization_id}",
    kind: "organization_id",
  },
  {
    pattern: /\/projects\/([^/]+)/u,
    template: "/projects/{project_id}",
    kind: "project_id",
  },
  {
    pattern: /\/api_keys\/([^/]+)/u,
    template: "/api_keys/{api_key_id}",
    kind: "api_key_id",
  },
]);

function sanitizePathname(pathname) {
  let pathTemplate = pathname;
  const parameterFingerprints = [];
  for (const definition of IDENTITY_PATH_PARAMETERS) {
    pathTemplate = pathTemplate.replace(definition.pattern, (match, value) => {
      parameterFingerprints.push({
        kind: definition.kind,
        fingerprint: secretFingerprint(value),
      });
      return definition.template;
    });
  }
  return {
    path: pathTemplate,
    parameter_fingerprints: parameterFingerprints,
  };
}

function urlParts(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    const safePath = sanitizePathname(url.pathname);
    return {
      protocol: url.protocol,
      host: url.host,
      path: safePath.path,
      path_parameter_fingerprints: safePath.parameter_fingerprints,
      query_keys: [...url.searchParams.keys()].sort(),
    };
  } catch {
    return {
      protocol: null,
      host: null,
      path: null,
      path_parameter_fingerprints: [],
      query_keys: [],
    };
  }
}

function textByteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  return 0;
}

function bufferText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value instanceof URLSearchParams) return value.toString();
  return null;
}

function contentLength(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + contentLength(item, depth + 1), 0);
  }
  if (typeof value === "object") {
    let total = 0;
    for (const child of Object.values(value)) total += contentLength(child, depth + 1);
    return total;
  }
  return 0;
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return { present: false, count: 0, roles: {}, content_lengths: [] };
  }
  const roles = {};
  const lengths = [];
  for (const message of messages) {
    const role = typeof message?.role === "string" ? message.role : "unknown";
    roles[role] = (roles[role] ?? 0) + 1;
    lengths.push(contentLength(message?.content));
  }
  return {
    present: true,
    count: messages.length,
    roles,
    content_lengths: lengths,
  };
}

function summarizeTools(tools) {
  if (!Array.isArray(tools)) return { present: false, count: 0, names: [], schema_fingerprints: [] };
  const names = [];
  const schemaFingerprints = [];
  for (const tool of tools) {
    const name = typeof tool?.name === "string"
      ? tool.name
      : typeof tool?.function?.name === "string"
        ? tool.function.name
        : null;
    if (name) names.push(name);
    const schema = tool?.input_schema ?? tool?.parameters ?? tool?.function?.parameters ?? tool?.schema;
    schemaFingerprints.push(schema === undefined ? null : sha256Hex(stableStringify(schema)));
  }
  return {
    present: true,
    count: tools.length,
    names,
    schema_fingerprints: schemaFingerprints,
  };
}

function summarizeSystem(system) {
  if (system === undefined || system === null) return { present: false, count: 0, length: 0 };
  if (typeof system === "string") return { present: true, count: 1, length: system.length };
  if (Array.isArray(system)) {
    return {
      present: true,
      count: system.length,
      length: contentLength(system),
    };
  }
  return { present: true, count: 1, length: contentLength(system) };
}

function safeMetadataObject(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { present: false, keys: [], safe_values: {} };
  }
  const safeValues = {};
  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = key.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    if (!SAFE_METADATA_KEYS.has(normalizedKey)) continue;
    const safeValue = safeScalar(value);
    if (safeValue !== null) safeValues[key] = safeValue;
  }
  return {
    present: true,
    keys: Object.keys(metadata).sort(),
    safe_values: safeValues,
  };
}

function summarizeRequestBodyText(text, contentType = null) {
  const byteLength = textByteLength(text);
  if (byteLength === 0) {
    return {
      present: false,
      content_type: contentType,
      bytes: 0,
      sha256: null,
      format: null,
      structure: null,
    };
  }
  const stringValue = bufferText(text);
  const base = {
    present: true,
    content_type: contentType,
    bytes: byteLength,
    sha256: sha256Hex(stringValue ?? Buffer.from(text)),
    format: "text",
    structure: null,
  };
  if (stringValue === null) return base;
  let parsed;
  try {
    parsed = JSON.parse(stringValue);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...base, format: "json_scalar", structure: { type: typeof parsed } };
  }
  const safeScalars = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!SAFE_REQUEST_SCALAR_KEYS.has(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean" ||
        typeof value === "string") {
      safeScalars[key] = safeScalar(value);
    } else {
      safeScalars[key] = { type: "object", keys: Object.keys(value).sort() };
    }
  }
  const cacheControlCount = (JSON.stringify(parsed).match(/"cache_control"/gu) ?? []).length;
  return {
    ...base,
    format: "json",
    structure: {
      top_level_keys: Object.keys(parsed).sort(),
      safe_scalars: safeScalars,
      system: summarizeSystem(parsed.system),
      messages: summarizeMessages(parsed.messages),
      tools: summarizeTools(parsed.tools),
      metadata: safeMetadataObject(parsed.metadata),
      cache_control_count: cacheControlCount,
    },
  };
}

function parseSseText(text) {
  const events = [];
  let eventName = null;
  const dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) {
      eventName = null;
      return;
    }
    const data = dataLines.join("\n");
    dataLines.length = 0;
    let parsed = null;
    if (data !== "[DONE]") {
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = null;
      }
    }
    events.push({ event: eventName, data: parsed, raw_length: data.length });
    eventName = null;
  };
  for (const line of text.split(/\r?\n/u)) {
    if (line === "") {
      flush();
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  return events;
}

function collectUsage(value, output = {}, depth = 0) {
  if (!value || typeof value !== "object" || depth > 10) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectUsage(item, output, depth + 1);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (typeof child === "number" && Number.isFinite(child) && (
      normalized.includes("token") ||
      normalized.includes("credit") ||
      normalized === "inputtokens" ||
      normalized === "outputtokens"
    )) {
      output[key] = child;
    } else if (child && typeof child === "object") {
      collectUsage(child, output, depth + 1);
    }
  }
  return output;
}

function collectSafeResponseMetadata(value, output = {}, depth = 0) {
  if (!value || typeof value !== "object" || depth > 10) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) collectSafeResponseMetadata(item, output, depth + 1);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (typeof child !== "object" && SAFE_METADATA_KEYS.has(normalized)) {
      const safeValue = safeScalar(child);
      if (safeValue !== null) output[key] = safeValue;
    } else if (child && typeof child === "object" && depth < 8) {
      collectSafeResponseMetadata(child, output, depth + 1);
    }
  }
  return output;
}

function mergeObjects(left, right) {
  if (Array.isArray(right)) return [...right];
  if (right && typeof right === "object") {
    const result = left && typeof left === "object" && !Array.isArray(left) ? { ...left } : {};
    for (const [key, value] of Object.entries(right)) {
      result[key] = mergeObjects(result[key], value);
    }
    return result;
  }
  return right === undefined ? left : right;
}

function mergeNetworkEvents(events) {
  const records = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof event.record_id !== "string") continue;
    const current = records.get(event.record_id) ?? {};
    records.set(event.record_id, mergeObjects(current, event));
  }
  return [...records.values()].sort((left, right) => {
    const leftTime = Date.parse(left.request_started_at) || 0;
    const rightTime = Date.parse(right.request_started_at) || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.record_id).localeCompare(String(right.record_id));
  });
}

function extractUsageFromParsed(parsed) {
  return collectUsage(parsed, {});
}

function summarizeResponseBodyText(text, contentType = null, { truncated = false } = {}) {
  const byteLength = textByteLength(text);
  const stringValue = bufferText(text) ?? "";
  const isSse = /event-stream/iu.test(contentType ?? "") ||
    /(?:^|\n)data:\s*/u.test(stringValue);
  const result = {
    present: byteLength > 0,
    content_type: contentType,
    bytes: byteLength,
    sha256: byteLength > 0 ? sha256Hex(stringValue) : null,
    truncated,
    format: isSse ? "sse" : "json",
    sse_event_counts: {},
    provider_response_id: null,
    model: null,
    stop_reason: null,
    usage: {},
    usage_status: "USAGE_NOT_EXPOSED",
    safe_metadata: {},
    error: null,
  };
  if (byteLength === 0) {
    result.usage_status = "EMPTY_RESPONSE";
    return result;
  }
  const parsedValues = [];
  if (isSse) {
    const events = parseSseText(stringValue);
    for (const event of events) {
      const eventType = event.event ??
        (typeof event.data?.type === "string" ? event.data.type : "data");
      result.sse_event_counts[eventType] = (result.sse_event_counts[eventType] ?? 0) + 1;
      if (event.data && typeof event.data === "object") parsedValues.push(event.data);
    }
  } else {
    try {
      const parsed = JSON.parse(stringValue);
      parsedValues.push(parsed);
      result.format = "json";
    } catch {
      result.format = "text";
    }
  }
  for (const parsed of parsedValues) {
    const usage = extractUsageFromParsed(parsed);
    Object.assign(result.usage, usage);
    Object.assign(result.safe_metadata, collectSafeResponseMetadata(parsed, {}));
    const responseId = parsed?.id ??
      parsed?.message?.id ??
      parsed?.response?.id ??
      parsed?.data?.id;
    if (typeof responseId === "string") result.provider_response_id = responseId;
    const model = parsed?.model ?? parsed?.message?.model ?? parsed?.response?.model;
    if (typeof model === "string") result.model = model;
    const stopReason = parsed?.stop_reason ??
      parsed?.message?.stop_reason ??
      parsed?.delta?.stop_reason ??
      parsed?.choices?.[0]?.finish_reason;
    if (typeof stopReason === "string") result.stop_reason = stopReason;
    if (parsed?.error) {
      const error = parsed.error;
      result.error = {
        type: typeof error?.type === "string" ? error.type : null,
        code: typeof error?.code === "string" || typeof error?.code === "number"
          ? error.code
          : null,
        message: typeof error?.message === "string"
          ? error.message.replace(
            /(token|api[_ -]?key|authorization|secret|credential)\s*[:=]\s*[^,\s]+/giu,
            "$1=<redacted>",
          ).slice(0, 240)
          : null,
      };
    }
  }
  if (Object.keys(result.usage).length > 0) {
    result.usage_status = "OBSERVED";
  }
  return result;
}

function processRole(env = process.env, argv = process.argv, fallback = null) {
  if (typeof env.COST_LAB_PROCESS_ROLE === "string" && env.COST_LAB_PROCESS_ROLE.trim()) {
    return env.COST_LAB_PROCESS_ROLE.trim().slice(0, 80);
  }
  const command = argv.join(" ").toLowerCase();
  if (command.includes("app-server")) return "official_app_server";
  if (command.includes("worker-main")) return "bridge_worker";
  if (fallback) return fallback;
  return "node_helper";
}

module.exports = {
  MAX_SUMMARY_TEXT_BYTES,
  bufferText,
  collectSafeResponseMetadata,
  collectUsage,
  contentLength,
  extractUsageFromParsed,
  fingerprint: secretFingerprint,
  headerValue,
  mergeNetworkEvents,
  normalizeHeaders,
  parseSseText,
  processRole,
  safeScalar,
  sha256Hex,
  stableStringify,
  summarizeHeaders,
  summarizeJwt,
  summarizeRequestBodyText,
  summarizeResponseBodyText,
  sanitizePathname,
  textByteLength,
  urlParts,
};
