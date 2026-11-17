import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import core from "../network-observer-core.cjs";
import {
  compareIdentitySurfaces,
  correlateOfficialCapture,
  coverageSummary,
  readWireEvidence,
  sanitizeOfficialCapture,
} from "../network-observer.mjs";
import { PROJECT_ROOT } from "../official-assembly-probe.mjs";

const PRELOAD_PATH = path.join(PROJECT_ROOT, "tools", "cost-lab", "network-observer-preload.cjs");

export function fixtureSource() {
  return String.raw`
"use strict";
const http = require("node:http");

const secret = "raw-secret-value-do-not-persist";
const server = http.createServer((request, response) => {
  if (request.url === "/json") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "fixture-json-request",
        "x-safe-fixture": "safe",
      });
      response.end(JSON.stringify({
        id: "response-json",
        model: "GLM-5.3-Flash",
        usage: { input_tokens: 12, output_tokens: 3 },
        echo_keys: Object.keys(JSON.parse(body)).length,
      }));
    });
    return;
  }
  if (request.url === "/sse") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {"id":"response-sse","model":"GLM-5.3-Flash","usage":{"input_tokens":10}}\n\n');
    response.write('event: message_delta\ndata: {"usage":{"output_tokens":2},"stop_reason":"end_turn"}\n\n');
    response.end("data: [DONE]\n\n");
    return;
  }
  if (request.url === "/api/v1/ultra/anthropic/v1/messages") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {"id":"response-ultra","model":"GLM-5.3-Flash","usage":{"input_tokens":5}}\n\n');
    response.write('event: message_delta\ndata: {"usage":{"output_tokens":1},"stop_reason":"end_turn"}\n\n');
    response.end("data: [DONE]\n\n");
    return;
  }
  if (request.url === "/fail") {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":{"type":"fixture_failure","code":"E500"}}');
    return;
  }
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "/final" });
    response.end();
    return;
  }
  if (request.url === "/timeout") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("late");
    }, 1000);
    return;
  }
  if (request.url === "/final") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  try {
    const json = await fetch(base + "/json", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + secret,
        "x-api-key": "sk-" + "abcdefghijklmnop",
      },
      body: JSON.stringify({
        model: "GLM-5.3-Flash",
        messages: [{ role: "user", content: "do not persist " + secret }],
        tools: [{ name: "fixture_tool", input_schema: { type: "object" } }],
        metadata: { requestId: "fixture-request", plan: "personal" },
      }),
    });
    await json.text();

    const sse = await fetch(base + "/sse");
    await sse.text();

    const ultra = await fetch(base + "/api/v1/ultra/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.3-Flash", messages: [] }),
    });
    await ultra.text();

    const failed = await fetch(base + "/fail");
    await failed.text();

    const redirected = await fetch(base + "/redirect", { redirect: "follow" });
    await redirected.text();

    await fetch(base + "/timeout", { signal: AbortSignal.timeout(50) }).catch(() => undefined);

    await new Promise((resolve, reject) => {
      const request = http.request(base + "/final", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-header": "safe" },
      }, (response) => {
        response.resume();
        response.once("end", resolve);
      });
      request.once("error", reject);
      request.end('{"node":true}');
    });
  } finally {
    server.closeIdleConnections();
    server.close();
  }
});
`;
}

test("network body summaries retain structure and redact payloads", () => {
  const request = core.summarizeRequestBodyText(JSON.stringify({
    model: "GLM-5.3-Flash",
    stream: true,
    messages: [
      { role: "system", content: "private system text" },
      { role: "user", content: "private user text" },
    ],
    tools: [{ name: "fixture_tool", input_schema: { type: "object" } }],
    metadata: { plan: "personal", secret: "should-not-appear" },
  }), "application/json");
  const serializedRequest = JSON.stringify(request);
  assert.equal(serializedRequest.includes("private user text"), false);
  assert.equal(serializedRequest.includes("should-not-appear"), false);
  assert.equal(request.structure.safe_scalars.model, "GLM-5.3-Flash");
  assert.equal(request.structure.messages.count, 2);
  assert.deepEqual(request.structure.messages.roles, { system: 1, user: 1 });
  assert.equal(request.structure.tools.count, 1);
  assert.equal(request.structure.metadata.safe_values.plan, "personal");

  const response = core.summarizeResponseBodyText(
    'event: message_start\ndata: {"id":"response-1","model":"GLM-5.3-Flash","usage":{"input_tokens":10}}\n\n' +
      'event: message_delta\ndata: {"usage":{"output_tokens":2},"stop_reason":"end_turn"}\n\n',
    "text/event-stream",
  );
  assert.equal(response.format, "sse");
  assert.equal(response.provider_response_id, "response-1");
  assert.equal(response.usage.input_tokens, 10);
  assert.equal(response.usage.output_tokens, 2);
  assert.equal(response.stop_reason, "end_turn");
  assert.equal(response.usage_status, "OBSERVED");
});

test("coverage fails closed without process and official-capture evidence", () => {
  const record = {
    record_id: "record-1",
    http_method: "POST",
    endpoint_kind: "model_provider",
    request_header_presence: ["authorization"],
    request_auth: [{ header: "authorization", token: { sha256: "a" } }],
    usage_status: "USAGE_MISSING",
    request_status: "completed",
  };
  const coverage = coverageSummary({
    records: [record],
    officialCaptures: [],
  });
  assert.equal(coverage.PROBE_COVERAGE, "PARTIAL");
  assert.equal(coverage.HTTP_METHOD_COVERAGE, "PARTIAL");
  assert.equal(coverage.NON_MODEL_HTTP_COVERAGE, "PARTIAL");
  assert.equal(coverage.RPC_COVERAGE, "PARTIAL");
  assert.equal(coverage.IDENTITY_OBSERVABILITY, "NOT_OBSERVED");
  assert.deepEqual(coverage.missing_required_process_roles, [
    "bridge_main_or_experiment_harness",
    "official_app_server",
  ]);
});

test("official capture correlation does not match by URL alone", () => {
  const record = {
    record_id: "record-1",
    http_method: "POST",
    endpoint_host: "open.bigmodel.cn",
    endpoint_path: "/api/anthropic",
    request_started_at: "2026-11-17T07:30:00.000Z",
  };
  const captures = [{
    method: "POST",
    url: "https://open.bigmodel.cn/api/anthropic",
    timestamp: Date.parse("2026-11-17T07:30:10.000Z"),
    pid: 42,
  }];
  const result = correlateOfficialCapture([record], captures);
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched_official.length, 1);
});

test("identity path parameters are fingerprinted instead of persisted", () => {
  const parts = core.urlParts(
    "https://bigmodel.cn/api/biz/v1/organization/org-secret/projects/project-secret/api_keys/key-secret/access_tokens",
  );
  assert.equal(
    parts.path,
    "/api/biz/v1/organization/{organization_id}/projects/{project_id}/api_keys/{api_key_id}/access_tokens",
  );
  assert.deepEqual(
    parts.path_parameter_fingerprints.map((entry) => entry.kind),
    ["organization_id", "project_id", "api_key_id"],
  );
  const serialized = JSON.stringify(parts);
  assert.equal(serialized.includes("org-secret"), false);
  assert.equal(serialized.includes("project-secret"), false);
  assert.equal(serialized.includes("key-secret"), false);

  const capture = sanitizeOfficialCapture({
    timestamp: 1,
    processType: "cli",
    pid: 42,
    method: "post",
    url: "https://bigmodel.cn/api/biz/v1/organization/org-secret/projects/project-secret/api_keys/key-secret/access_tokens?code=secret",
  });
  assert.equal(capture.method, "POST");
  assert.equal(capture.endpoint_path.includes("key-secret"), false);
  assert.equal(JSON.stringify(capture).includes("code=secret"), false);
});

test("identity comparison distinguishes matching and missing API key id surfaces", () => {
  const host = {
    normalized: true,
    present: true,
    api_key: { sha256: "key-hash" },
    api_key_id: { sha256: "id-hash" },
    account_scope: { sha256: "scope-hash" },
  };
  const matching = compareIdentitySurfaces(host, [{
    endpoint_kind: "model_provider",
    record_id: "wire-1",
    endpoint_path: "/api/anthropic",
    request_auth: [
      { header: "authorization", token: { sha256: "key-hash" } },
      { header: "x-api-key-id", token: { sha256: "id-hash" } },
    ],
  }]);
  assert.equal(matching.api_key_parity, "MATCH");
  assert.equal(matching.api_key_id_parity, "MATCH");
  const missingId = compareIdentitySurfaces(host, [{
    endpoint_kind: "model_provider",
    record_id: "wire-2",
    endpoint_path: "/api/anthropic",
    request_auth: [{ header: "authorization", token: { sha256: "key-hash" } }],
  }]);
  assert.equal(missingId.api_key_parity, "MATCH");
  assert.equal(missingId.api_key_id_parity, "UNKNOWN");
});

test("coverage reaches COMPLETE with correlated HTTP, RPC, identity, and status evidence", () => {
  const startedAt = "2026-11-17T07:30:00.000Z";
  const completedAt = "2026-11-17T07:30:01.000Z";
  const host = {
    normalized: true,
    present: true,
    api_key: { sha256: "key-hash" },
    api_key_id: { sha256: "id-hash" },
    account_scope: { sha256: "scope-hash" },
  };
  const records = [
    {
      record_id: "wire-project",
      process_role: "official_app_server",
      http_method: "GET",
      endpoint_kind: "project_identity",
      endpoint_host: "bigmodel.cn",
      endpoint_path: "/api/biz/customer/getCustomerInfo",
      endpoint_path_parameter_fingerprints: [],
      request_started_at: startedAt,
      request_status: "completed",
      http_status: 200,
      request_header_presence: ["authorization"],
      request_auth: [{ header: "authorization", token: { sha256: "login-hash" } }],
      request_body: { present: false },
      usage_status: "USAGE_NOT_EXPOSED",
    },
    {
      record_id: "wire-model",
      process_role: "official_app_server",
      http_method: "POST",
      endpoint_kind: "model_provider",
      endpoint_host: "open.bigmodel.cn",
      endpoint_path: "/api/anthropic",
      endpoint_path_parameter_fingerprints: [{
        kind: "api_key_id",
        fingerprint: { sha256: "id-hash" },
      }],
      request_started_at: startedAt,
      request_status: "completed",
      http_status: 200,
      request_header_presence: ["authorization", "x-api-key"],
      request_auth: [
        { header: "authorization", token: { sha256: "key-hash" } },
        { header: "x-api-key", token: { sha256: "key-hash" } },
      ],
      request_body: { present: true },
      usage_status: "OBSERVED",
    },
  ];
  const officialCaptures = [
    {
      timestamp: Date.parse(startedAt),
      pid: 42,
      method: "GET",
      endpoint_host: "bigmodel.cn",
      endpoint_path: "/api/biz/customer/getCustomerInfo",
    },
    {
      timestamp: Date.parse(startedAt),
      pid: 42,
      method: "POST",
      endpoint_host: "open.bigmodel.cn",
      endpoint_path: "/api/anthropic",
    },
  ];
  const rpcTrace = [
    {
      rpc_id: "rpc-send",
      method: "session/send",
      status: "PASS",
      started_at: "2026-11-17T07:29:59.900Z",
      completed_at: "2026-11-17T07:30:00.100Z",
      request_shape: { type: "object" },
      response_shape: { type: "object" },
    },
    {
      rpc_id: "rpc-terminal",
      method: "session/event:terminal",
      status: "PASS",
      started_at: completedAt,
      completed_at: completedAt,
      request_shape: { type: "object" },
      response_shape: { type: "object" },
    },
  ];
  const coverage = coverageSummary({
    records,
    officialCaptures,
    preloadInitEvents: [
      { process_role: "bridge_main_or_experiment_harness" },
      { process_role: "official_app_server" },
    ],
    rpcTrace,
    identity: compareIdentitySurfaces(host, records),
  });
  assert.equal(coverage.PROBE_COVERAGE, "COMPLETE");
  assert.equal(coverage.HTTP_METHOD_COVERAGE, "COMPLETE");
  assert.equal(coverage.NON_MODEL_HTTP_COVERAGE, "COMPLETE");
  assert.equal(coverage.RPC_COVERAGE, "COMPLETE");
  assert.equal(coverage.IDENTITY_OBSERVABILITY, "COMPLETE");
  assert.equal(coverage.identity.api_key_id_parity, "MATCH");
  assert.equal(coverage.identity.api_key_id_transport, "PROJECT_PATH");
  assert.equal(coverage.counts.preload_only, 0);
  assert.equal(coverage.counts.non_official_preload_only, 0);
});

test("official capture accepts only a failed request that preload completed after capture", () => {
  const startedAt = "2026-11-17T07:30:00.000Z";
  const completedAt = "2026-11-17T07:30:01.000Z";
  const host = {
    normalized: true,
    present: true,
    api_key: { sha256: "key-hash" },
    api_key_id: { sha256: "id-hash" },
    account_scope: { sha256: "scope-hash" },
  };
  const records = [
    {
      record_id: "host-project-token",
      process_role: "bridge_main_or_experiment_harness",
      http_method: "POST",
      endpoint_kind: "project_identity",
      endpoint_host: "bigmodel.cn",
      endpoint_path:
        "/api/biz/v1/organization/{organization_id}/projects/{project_id}/api_keys/{api_key_id}/access_tokens",
      endpoint_path_parameter_fingerprints: [{
        kind: "api_key_id",
        fingerprint: { sha256: "id-hash" },
      }],
      request_started_at: startedAt,
      request_status: "completed",
      http_status: 200,
      request_header_presence: ["authorization"],
      request_auth: [{ header: "authorization", token: { sha256: "login-hash" } }],
      request_body: { present: true },
      usage_status: "USAGE_NOT_EXPOSED",
    },
    {
      record_id: "official-account",
      process_role: "official_app_server",
      http_method: "GET",
      endpoint_kind: "project_identity",
      endpoint_host: "bigmodel.cn",
      endpoint_path: "/api/biz/customer/getCustomerInfo",
      endpoint_path_parameter_fingerprints: [],
      request_started_at: startedAt,
      request_status: "completed",
      http_status: 200,
      request_header_presence: ["authorization"],
      request_auth: [{ header: "authorization", token: { sha256: "login-hash" } }],
      request_body: { present: false },
      usage_status: "USAGE_NOT_EXPOSED",
    },
    {
      record_id: "official-model",
      process_role: "official_app_server",
      http_method: "POST",
      endpoint_kind: "model_provider",
      endpoint_host: "open.bigmodel.cn",
      endpoint_path: "/api/anthropic",
      endpoint_path_parameter_fingerprints: [{
        kind: "api_key_id",
        fingerprint: { sha256: "id-hash" },
      }],
      request_started_at: startedAt,
      request_status: "completed",
      http_status: 200,
      request_header_presence: ["authorization", "x-api-key"],
      request_auth: [
        { header: "authorization", token: { sha256: "key-hash" } },
        { header: "x-api-key", token: { sha256: "key-hash" } },
      ],
      request_body: { present: true },
      usage_status: "OBSERVED",
    },
    {
      record_id: "official-cancelled-auxiliary",
      process_role: "official_app_server",
      http_method: "POST",
      endpoint_kind: "model_provider",
      endpoint_host: "open.bigmodel.cn",
      endpoint_path: "/api/anthropic",
      endpoint_path_parameter_fingerprints: [],
      request_started_at: "2026-11-17T07:30:00.500Z",
      request_completed_at: "2026-11-17T07:30:00.750Z",
      request_status: "failed",
      http_status: null,
      request_header_presence: ["authorization", "x-api-key"],
      request_auth: [
        { header: "authorization", token: { sha256: "key-hash" } },
        { header: "x-api-key", token: { sha256: "key-hash" } },
      ],
      request_body: { present: true },
      usage_status: "USAGE_NOT_EXPOSED",
    },
  ];
  const officialCaptures = [
    {
      timestamp: Date.parse(startedAt),
      pid: 42,
      method: "GET",
      endpoint_host: "bigmodel.cn",
      endpoint_path: "/api/biz/customer/getCustomerInfo",
    },
    {
      timestamp: Date.parse(startedAt),
      pid: 42,
      method: "POST",
      endpoint_host: "open.bigmodel.cn",
      endpoint_path: "/api/anthropic",
    },
  ];
  const rpcTrace = [
    {
      rpc_id: "rpc-send",
      method: "session/send",
      status: "PASS",
      started_at: "2026-11-17T07:29:59.900Z",
      completed_at: "2026-11-17T07:30:00.100Z",
      request_shape: { type: "object" },
      response_shape: { type: "object" },
    },
    {
      rpc_id: "rpc-terminal",
      method: "session/event:terminal",
      status: "PASS",
      started_at: completedAt,
      completed_at: completedAt,
      request_shape: { type: "object" },
      response_shape: { type: "object" },
    },
  ];

  const coverage = coverageSummary({
    records,
    officialCaptures,
    preloadInitEvents: [
      { process_role: "bridge_main_or_experiment_harness" },
      { process_role: "official_app_server" },
    ],
    rpcTrace,
    identity: compareIdentitySurfaces(host, records),
  });

  assert.equal(coverage.PROBE_COVERAGE, "COMPLETE");
  assert.equal(coverage.counts.official_records, 3);
  assert.equal(coverage.counts.matched, 2);
  assert.equal(coverage.counts.preload_only, 1);
  assert.equal(coverage.counts.failed_preload_only, 1);
  assert.equal(coverage.counts.unexplained_preload_only, 0);
  assert.equal(coverage.counts.non_official_preload_only, 1);
  assert.deepEqual(coverage.official.preload_only, ["official-cancelled-auxiliary"]);
  assert.deepEqual(coverage.official.failed_preload_only, ["official-cancelled-auxiliary"]);
  assert.deepEqual(coverage.official.unexplained_preload_only, []);
  assert.deepEqual(coverage.official.non_official_preload_only, ["host-project-token"]);
});

test("an uncaptured AppServer request still fails closed", () => {
  const record = {
    record_id: "official-model",
    process_role: "official_app_server",
    http_method: "POST",
    endpoint_kind: "model_provider",
    endpoint_host: "open.bigmodel.cn",
    endpoint_path: "/api/anthropic",
    request_started_at: "2026-11-17T07:30:00.000Z",
  };
  const coverage = coverageSummary({
    records: [record],
    officialCaptures: [],
    preloadInitEvents: [{ process_role: "official_app_server" }],
  });

  assert.equal(coverage.PROBE_COVERAGE, "PARTIAL");
  assert.equal(coverage.counts.official_records, 1);
  assert.deepEqual(coverage.official.preload_only, ["official-model"]);
});

test("preload observes fetch, SSE, failures, redirects, timeout, and node HTTP", async () => {
  const root = await mkdtemp(path.join(PROJECT_ROOT, ".run", "network-probe-test-"));
  const fixturePath = path.join(root, "fixture.cjs");
  const networkDirectory = path.join(root, "wire");
  try {
    await writeFile(fixturePath, fixtureSource(), "utf8");
    const result = spawnSync(process.execPath, [fixturePath], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${PRELOAD_PATH}`,
        COST_LAB_NETWORK_DIR: networkDirectory,
        COST_LAB_EXPERIMENT_ID: "network-probe-test",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const evidence = await readWireEvidence(networkDirectory);
    const records = evidence.records;
    assert.ok(records.some((record) =>
      record.http_method === "POST" &&
      record.endpoint_path === "/json" &&
      record.request_body?.structure?.messages?.count === 1));
    assert.ok(records.some((record) =>
      record.endpoint_path === "/sse" &&
      record.usage_status === "OBSERVED" &&
      record.usage?.input_tokens === 10 &&
      record.usage?.output_tokens === 2));
    assert.ok(records.some((record) =>
      record.endpoint_path === "/api/v1/ultra/anthropic/v1/messages" &&
      record.endpoint_kind === "model_provider" &&
      record.usage_status === "OBSERVED" &&
      record.usage?.input_tokens === 5));
    assert.ok(records.some((record) =>
      record.endpoint_path === "/fail" && record.http_status === 500));
    assert.ok(records.some((record) =>
      record.endpoint_path === "/redirect" &&
      record.final_endpoint_path === "/final"));
    assert.ok(records.some((record) =>
      record.endpoint_path === "/timeout" &&
      record.request_status === "failed"));
    assert.ok(records.some((record) =>
      record.endpoint_path === "/final" &&
      record.http_method === "POST" &&
      record.request_body?.present === true));
    assert.ok(records.some((record) =>
      record.request_auth?.some((entry) =>
        entry.header === "authorization" &&
        entry.token?.sha256 &&
        !JSON.stringify(entry).includes("raw-secret-value-do-not-persist"))));
    const raw = await readFile(
      path.join(networkDirectory, evidence.files[0]),
      "utf8",
    );
    assert.equal(raw.includes("raw-secret-value-do-not-persist"), false);
    assert.equal(raw.includes("sk-abcdefghijklmnop"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
