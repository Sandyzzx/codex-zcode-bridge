"use strict";

const diagnostics = require("node:diagnostics_channel");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const core = require("./network-observer-core.cjs");

if (!globalThis[Symbol.for("costLab.networkObserver.v1")]) {
  install();
}

function install() {
  const outputDir = process.env.COST_LAB_NETWORK_DIR;
  if (!outputDir || !path.isAbsolute(outputDir)) return;
  globalThis[Symbol.for("costLab.networkObserver.v1")] = {
    outputDir,
    installed_at: new Date().toISOString(),
  };
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(
    outputDir,
    `wire-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
  );
  const experimentId = process.env.COST_LAB_EXPERIMENT_ID?.trim() || null;
  const role = core.processRole(process.env, process.argv, "node_child");
  const storage = new AsyncLocalStorage();
  const activeById = new Map();
  const httpContexts = new WeakMap();
  const undiciContexts = new WeakMap();
  let sequence = 0;

  const append = (value) => {
    try {
      fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
    } catch {
      // Observation must never alter the process under test.
    }
  };

  const baseRecord = (fields) => ({
    schema_version: 1,
    kind: "cost_lab_network_wire_event",
    experiment_id: experimentId,
    record_id: fields.record_id,
    phase: fields.phase,
    process_role: role,
    process_id: process.pid,
    parent_process_id: process.ppid,
    process_command_kind: classifyProcessCommand(process.argv),
    node_version: process.version,
    recorded_at: new Date().toISOString(),
    ...fields,
  });

  const writePhase = (recordId, phase, fields = {}) => {
    const record = activeById.get(recordId);
    append(baseRecord({ record_id: recordId, phase, ...record?.base, ...fields }));
    if (record && phase !== "start" && phase !== "init") {
      record.base = {
        ...record.base,
        ...fields,
      };
    }
  };

  const createRecord = ({
    transport,
    method,
    url,
    headers,
    captureSource,
  }) => {
    const id = `net_${process.pid}_${++sequence}`;
    const parts = core.urlParts(url);
    const requestHeaders = core.summarizeHeaders(headers);
    const requestId = core.headerValue(headers, "x-request-id");
    const base = {
      transport,
      capture_source: captureSource,
      http_method: String(method || "GET").toUpperCase(),
      endpoint_host: parts.host,
      endpoint_path: parts.path,
      endpoint_path_parameter_fingerprints: parts.path_parameter_fingerprints,
      endpoint_protocol: parts.protocol,
      query_keys: parts.query_keys,
      request_started_at: new Date().toISOString(),
      request_header_presence: requestHeaders.names,
      safe_request_headers: requestHeaders.safe_values,
      request_auth: requestHeaders.auth,
      request_id: typeof requestId === "string" ? requestId : null,
      parent_request_id: null,
      retry_attempt: 1,
      redirect_chain: [],
      connection_reuse: "UNKNOWN",
      http_status: null,
      error_class: null,
      error_code: null,
      request_body: null,
      response_body: null,
      usage: null,
      usage_status: "USAGE_NOT_EXPOSED",
      response_header_presence: [],
      safe_response_headers: {},
      response_headers_at: null,
      request_completed_at: null,
      duration_ms: null,
      endpoint_kind: classifyEndpoint(url),
    };
    activeById.set(id, { base, startedMs: Date.now() });
    writePhase(id, "start");
    return { id, base };
  };

  const completeRecord = (recordId, fields = {}) => {
    const record = activeById.get(recordId);
    if (!record) return;
    const completedAt = fields.request_completed_at ?? new Date().toISOString();
    const duration = Date.parse(completedAt) - Date.parse(record.base.request_started_at);
    writePhase(recordId, "complete", {
      request_completed_at: completedAt,
      duration_ms: Number.isFinite(duration) && duration >= 0 ? duration : null,
      ...fields,
    });
    activeById.delete(recordId);
  };

  const failRecord = (recordId, error, fields = {}) => {
    completeRecord(recordId, {
      request_status: "failed",
      error_class: safeErrorClass(error),
      error_code: safeErrorCode(error),
      ...fields,
    });
  };

  const mergeHeadersPhase = (recordId, responseHeaders, status, extra = {}) => {
    const summary = core.summarizeHeaders(responseHeaders, { response: true });
    writePhase(recordId, "headers", {
      http_status: Number.isFinite(status) ? status : null,
      response_headers_at: new Date().toISOString(),
      response_header_presence: summary.names,
      safe_response_headers: summary.safe_values,
      set_cookie_present: summary.set_cookie_present,
      ...extra,
    });
  };

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = async function costLabObservedFetch(input, init) {
      let effectiveRequest = null;
      let requestBodyPromise = Promise.resolve(null);
      try {
        effectiveRequest = input instanceof Request
          ? new Request(input, init)
          : new Request(input, init);
        if (effectiveRequest.body && !effectiveRequest.bodyUsed) {
          requestBodyPromise = effectiveRequest.clone().text().then((text) => ({
            text,
            truncated: false,
          })).catch(() => null);
        }
      } catch {
        effectiveRequest = null;
      }
      let url = null;
      try {
        url = effectiveRequest?.url ?? new URL(String(input), globalThis.location?.href).href;
      } catch {
        url = String(input);
      }
      const headers = effectiveRequest?.headers ?? init?.headers ?? null;
      const method = effectiveRequest?.method ?? init?.method ?? "GET";
      const record = createRecord({
        transport: "fetch",
        method,
        url,
        headers,
        captureSource: "fetch_wrapper",
      });
      const context = { recordId: record.id };
      return storage.run(context, async () => {
        try {
          const bodyCapture = await requestBodyPromise;
          if (bodyCapture) {
            const contentType = core.headerValue(headers, "content-type");
            writePhase(record.id, "request_body", {
              request_body: core.summarizeRequestBodyText(bodyCapture.text, contentType),
            });
          }
          const response = await originalFetch.call(this, input, init);
          const finalParts = core.urlParts(response.url || url);
          mergeHeadersPhase(record.id, response.headers, response.status, {
            final_endpoint_host: finalParts.host,
            final_endpoint_path: finalParts.path,
            final_endpoint_path_parameter_fingerprints:
              finalParts.path_parameter_fingerprints,
            final_query_keys: finalParts.query_keys,
            redirected: response.redirected === true,
            redirect_chain: response.redirected
              ? [{
                  from_host: core.urlParts(url).host,
                  from_path: core.urlParts(url).path,
                  to_host: finalParts.host,
                  to_path: finalParts.path,
                }]
              : [],
          });
          const contentType = response.headers.get("content-type");
          void readResponseTextBounded(response.clone(), core.MAX_SUMMARY_TEXT_BYTES)
            .then((bodyCapture) => {
              const responseBody = core.summarizeResponseBodyText(
                bodyCapture.text,
                contentType,
                { truncated: bodyCapture.truncated },
              );
              completeRecord(record.id, {
                request_status: response.ok ? "completed" : "http_error",
                response_body: responseBody,
                usage: Object.keys(responseBody.usage).length > 0
                  ? responseBody.usage
                  : null,
                usage_status: responseBody.usage_status,
                provider_response_id: responseBody.provider_response_id,
                response_model: responseBody.model,
                stop_reason: responseBody.stop_reason,
                response_error: responseBody.error,
              });
            })
            .catch((error) => {
              completeRecord(record.id, {
                request_status: "response_body_unobserved",
                error_class: safeErrorClass(error),
                error_code: safeErrorCode(error),
              });
            });
          return response;
        } catch (error) {
          failRecord(record.id, error);
          throw error;
        }
      });
    };
  }

  diagnostics.subscribe("undici:request:create", (message) => {
    try {
      const request = message?.request;
      if (!request) return;
      const context = storage.getStore();
      let recordId = context?.recordId;
      if (!recordId) {
        const rawUrl = new URL(request.path, request.origin).href;
        const created = createRecord({
          transport: "undici",
          method: request.method,
          url: rawUrl,
          headers: request.headers,
          captureSource: "diagnostics_channel",
        });
        recordId = created.id;
      }
      undiciContexts.set(request, recordId);
      writePhase(recordId, "transport", {
        transport: "undici",
        undici_request_observed: true,
        connection_reuse: "UNKNOWN",
      });
    } catch {
      // Diagnostics hooks are observation-only.
    }
  });

  diagnostics.subscribe("undici:request:headers", (message) => {
    try {
      const recordId = undiciContexts.get(message?.request);
      if (!recordId) return;
      const status = message?.response?.statusCode;
      const headers = message?.response?.headers ?? null;
      mergeHeadersPhase(recordId, headers, status);
    } catch {
      // Diagnostics hooks are observation-only.
    }
  });

  diagnostics.subscribe("undici:request:trailers", (message) => {
    try {
      const recordId = undiciContexts.get(message?.request);
      if (!recordId) return;
      const active = activeById.get(recordId);
      if (active && active.base.capture_source === "diagnostics_channel") {
        completeRecord(recordId, { request_status: "completed" });
      }
    } catch {
      // Diagnostics hooks are observation-only.
    }
  });

  diagnostics.subscribe("undici:request:error", (message) => {
    try {
      const recordId = undiciContexts.get(message?.request);
      if (!recordId) return;
      failRecord(recordId, message?.error);
    } catch {
      // Diagnostics hooks are observation-only.
    }
  });

  diagnostics.subscribe("http.client.request.start", (message) => {
    try {
      const request = message?.request;
      if (!request) return;
      const context = storage.getStore();
      let recordId = context?.recordId ?? httpContexts.get(request);
      if (!recordId) {
        const record = createRecord({
          transport: request.protocol === "https:" ? "https" : "http",
          method: request.method,
          url: inferNodeRequestUrl(request),
          headers: request.getHeaders(),
          captureSource: "node_http_diagnostics",
        });
        recordId = record.id;
      }
      httpContexts.set(request, recordId);
      writePhase(recordId, "transport", {
        transport: request.protocol === "https:" ? "https" : "http",
        node_http_request_observed: true,
      });
    } catch {
      // Diagnostics hooks are observation-only.
    }
  });

  patchNodeHttp(http, "http");
  patchNodeHttp(https, "https");
  patchWebSocket();

  append({
    schema_version: 1,
    kind: "cost_lab_network_probe_init",
    experiment_id: experimentId,
    process_role: role,
    process_id: process.pid,
    parent_process_id: process.ppid,
    process_command_kind: classifyProcessCommand(process.argv),
    node_version: process.version,
    recorded_at: new Date().toISOString(),
  });

  function patchNodeHttp(module, packageName) {
    const originalRequest = module.request;
    const originalGet = module.get;
    const wrappedRequest = function costLabObservedRequest(...args) {
      let requestUrl = null;
      let options = null;
      let callback = null;
      if (typeof args[0] === "string" || args[0] instanceof URL) {
        requestUrl = String(args[0]);
        if (typeof args[1] === "function") callback = args[1];
        else {
          options = args[1] ?? {};
          callback = typeof args[2] === "function" ? args[2] : null;
        }
      } else {
        options = args[0] ?? {};
        callback = typeof args[1] === "function" ? args[1] : null;
      }
      const protocol = options?.protocol ?? (packageName === "https" ? "https:" : "http:");
      const hostname = options?.hostname ?? options?.host ?? "localhost";
      const port = options?.port ? `:${options.port}` : "";
      const pathname = options?.path ?? "/";
      const inferredUrl = requestUrl ?? `${protocol}//${hostname}${port}${pathname}`;
      const headers = options?.headers ?? {};
      const record = createRecord({
        transport: packageName,
        method: options?.method ?? "GET",
        url: inferredUrl,
        headers,
        captureSource: "node_http_wrapper",
      });
      const bodyChunks = [];
      let bodyBytes = 0;
      const captureChunk = (chunk, encoding) => {
        if (chunk === undefined || chunk === null || bodyBytes >= core.MAX_SUMMARY_TEXT_BYTES) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
        const remaining = core.MAX_SUMMARY_TEXT_BYTES - bodyBytes;
        bodyChunks.push(buffer.subarray(0, remaining));
        bodyBytes += Math.min(buffer.length, remaining);
      };
      let request;
      try {
        request = storage.run({ recordId: record.id }, () => originalRequest.apply(this, args));
      } catch (error) {
        failRecord(record.id, error);
        throw error;
      }
      httpContexts.set(request, record.id);
      storage.run({ recordId: record.id }, () => {
        const originalWrite = request.write;
        const originalEnd = request.end;
        request.write = function observedWrite(chunk, encoding, callbackWrite) {
          captureChunk(chunk, encoding);
          return originalWrite.call(this, chunk, encoding, callbackWrite);
        };
        request.end = function observedEnd(chunk, encoding, callbackEnd) {
          if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
            captureChunk(chunk, encoding);
          }
          const contentType = core.headerValue(headers, "content-type");
          writePhase(record.id, "request_body", {
            request_body: core.summarizeRequestBodyText(Buffer.concat(bodyChunks), contentType),
          });
          return originalEnd.call(this, chunk, encoding, callbackEnd);
        };
      });
      request.once("error", (error) => failRecord(record.id, error));
      request.once("response", (response) => {
        mergeHeadersPhase(record.id, response.headers, response.statusCode);
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          if (bytes >= core.MAX_SUMMARY_TEXT_BYTES) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
          const remaining = core.MAX_SUMMARY_TEXT_BYTES - bytes;
          chunks.push(buffer.subarray(0, remaining));
          bytes += Math.min(buffer.length, remaining);
        });
        response.once("end", () => {
          const responseBody = core.summarizeResponseBodyText(
            Buffer.concat(chunks),
            response.headers["content-type"] ?? null,
            { truncated: bytes >= core.MAX_SUMMARY_TEXT_BYTES },
          );
          completeRecord(record.id, {
            request_status: response.statusCode >= 200 && response.statusCode < 400
              ? "completed"
              : "http_error",
            response_body: responseBody,
            usage: Object.keys(responseBody.usage).length > 0 ? responseBody.usage : null,
            usage_status: responseBody.usage_status,
            provider_response_id: responseBody.provider_response_id,
            response_model: responseBody.model,
            stop_reason: responseBody.stop_reason,
            response_error: responseBody.error,
          });
        });
        response.once("error", (error) => failRecord(record.id, error));
      });
      return request;
    };
    module.request = wrappedRequest;
    module.get = function costLabObservedGet(...args) {
      const request = wrappedRequest.call(module, ...args);
      request.end();
      return request;
    };
    module.get.__costLabOriginal = originalGet;
  }

  function patchWebSocket() {
    const NativeWebSocket = globalThis.WebSocket;
    if (typeof NativeWebSocket !== "function" ||
        NativeWebSocket[Symbol.for("costLab.networkObserver.wrapped")]) {
      return;
    }
    const WrappedWebSocket = function CostLabObservedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      const record = createRecord({
        transport: "websocket",
        method: "GET",
        url: String(url),
        headers: null,
        captureSource: "websocket_wrapper",
      });
      let sentBytes = 0;
      socket.addEventListener("open", () => {
        writePhase(record.id, "headers", {
          http_status: 101,
          response_headers_at: new Date().toISOString(),
        });
      });
      socket.addEventListener("error", () => {
        failRecord(record.id, new Error("websocket_error"));
      });
      socket.addEventListener("close", (event) => {
        completeRecord(record.id, {
          request_status: "closed",
          websocket_sent_bytes: sentBytes,
          websocket_close_code: Number.isFinite(event.code) ? event.code : null,
        });
      });
      const originalSend = socket.send;
      socket.send = function observedWebSocketSend(data) {
        sentBytes += core.textByteLength(data);
        return originalSend.call(this, data);
      };
      return socket;
    };
    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(WrappedWebSocket, key, {
        value: NativeWebSocket[key],
        enumerable: true,
      });
    }
    WrappedWebSocket[Symbol.for("costLab.networkObserver.wrapped")] = true;
    globalThis.WebSocket = WrappedWebSocket;
  }

  function inferNodeRequestUrl(request) {
    const headers = request.getHeaders?.() ?? {};
    const host = request.host ?? headers.host ?? "localhost";
    return `${request.protocol ?? "http:"}//${host}${request.path ?? "/"}`;
  }
}

async function readResponseTextBounded(response, maximumBytes) {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maximumBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value).subarray(0, remaining));
      bytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The clone stream is already closed.
    }
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated,
  };
}

function safeErrorClass(error) {
  if (error?.name === "AbortError") return "AbortError";
  if (error?.name === "TimeoutError") return "TimeoutError";
  if (error?.code === "UND_ERR_CONNECT_TIMEOUT") return "ConnectTimeout";
  if (error?.code === "UND_ERR_HEADERS_TIMEOUT") return "HeadersTimeout";
  if (error?.code === "UND_ERR_BODY_TIMEOUT") return "BodyTimeout";
  return error instanceof Error ? error.name.slice(0, 80) : "unknown_error";
}

function safeErrorCode(error) {
  if (typeof error?.code === "string") return error.code.slice(0, 80);
  if (typeof error?.cause?.code === "string") return error.cause.code.slice(0, 80);
  return null;
}

function classifyProcessCommand(argv) {
  const command = argv.join(" ").toLowerCase();
  if (command.includes("app-server")) return "official_app_server";
  if (command.includes("worker-main")) return "bridge_worker";
  if (command.includes("network-observer")) return "network_observer_helper";
  return "node_process";
}

function classifyEndpoint(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (/\/anthropic(?:\/|$)/iu.test(url.pathname)) return "model_provider";
    if (/customer|api_keys|access_tokens|project/iu.test(url.pathname)) return "project_identity";
    if (/oauth|token|login|auth/iu.test(url.pathname)) return "oauth";
    if (/usage|credit|billing|quota/iu.test(url.pathname)) return "billing";
    if (/telemetry|log|metrics|report/iu.test(url.pathname)) return "telemetry";
    return "other";
  } catch {
    return "unknown";
  }
}
