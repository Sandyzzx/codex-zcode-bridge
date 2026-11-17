import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFICIAL_NATIVE_CAPTURE_CHANNELS,
  evaluateNativeControlEvidence,
  normalizeDesktopProcessManifest,
  parseArgs,
} from "../native-control-evidence.mjs";

test("installed official capture paths fail closed for complete Native V3 evidence", () => {
  const result = evaluateNativeControlEvidence();
  assert.equal(result.NATIVE_CAPTURE_CONTROL, "PARTIAL");
  assert.equal(result.NATIVE_HTTP_CAPTURE, "BLOCKED");
  assert.equal(result.NATIVE_RPC_CAPTURE, "BLOCKED");
  assert.equal(result.NATIVE_IDENTITY_CAPTURE, "BLOCKED");
  assert.equal(result.IDENTITY_REDACTION, "PASS");
  assert.equal(result.REAL_NATIVE_TASK_ALLOWED, false);
  assert.ok(result.BLOCKERS.includes("installed_resource_manager_capture_is_metadata_only"));
});

test("Resource Manager metadata cannot be promoted to wire or identity evidence", () => {
  const channel = OFFICIAL_NATIVE_CAPTURE_CHANNELS.find(
    (candidate) => candidate.id === "resource_manager_network_capture",
  );
  assert.ok(channel);
  assert.equal(channel.control_supported, true);
  assert.equal(channel.fields.process_role, true);
  assert.equal(channel.fields.http_method, true);
  assert.equal(channel.fields.endpoint, true);
  assert.equal(channel.fields.request_header_presence, false);
  assert.equal(channel.fields.request_body_structure, false);
  assert.equal(channel.fields.sse_usage, false);
  assert.equal(channel.fields.wire_authorization, false);
  assert.match(channel.limitation, /headers, bodies, SSE, Usage, identity or RPC payloads/u);
});

test("development stdio tap and prohibited MITM proxy cannot satisfy production gates", () => {
  const tap = OFFICIAL_NATIVE_CAPTURE_CHANNELS.find(
    (candidate) => candidate.id === "stdio_tap_dev",
  );
  const proxy = OFFICIAL_NATIVE_CAPTURE_CHANNELS.find(
    (candidate) => candidate.id === "debug_mitm_proxy",
  );
  assert.equal(tap.production_supported, false);
  assert.equal(tap.development_only, true);
  assert.equal(tap.fields.rpc_request_payload, true);
  assert.equal(tap.fields.endpoint, false);
  assert.equal(proxy.policy, "prohibited");
  assert.equal(proxy.fields.wire_authorization, true);

  const result = evaluateNativeControlEvidence([tap, proxy]);
  assert.equal(result.NATIVE_HTTP_CAPTURE, "BLOCKED");
  assert.equal(result.NATIVE_RPC_CAPTURE, "BLOCKED");
  assert.equal(result.NATIVE_IDENTITY_CAPTURE, "BLOCKED");
  assert.equal(result.REAL_NATIVE_TASK_ALLOWED, false);
});

test("the evaluator accepts a synthetic complete production channel", () => {
  const fields = {};
  for (const name of [
    "process_role",
    "http_method",
    "endpoint",
    "request_header_presence",
    "safe_request_headers",
    "request_body_structure",
    "response_status",
    "safe_response_headers",
    "sse_usage",
    "terminal_state",
    "auxiliary_requests",
    "rpc_request_payload",
    "rpc_response_payload",
    "oauth_credential_source",
    "project_id",
    "project_token_source",
    "project_token_fingerprint",
    "api_key_id",
    "request_auth",
    "wire_authorization",
    "wire_api_key",
  ]) {
    fields[name] = true;
  }
  const result = evaluateNativeControlEvidence([
    {
      id: "synthetic_complete",
      label: "Synthetic complete",
      official: true,
      production_supported: true,
      development_only: false,
      policy: "allowed",
      control_supported: true,
      control_complete: true,
      identity_values_redacted: true,
      fields,
    },
  ]);
  assert.equal(result.NATIVE_CAPTURE_CONTROL, "PASS");
  assert.equal(result.NATIVE_HTTP_CAPTURE, "COMPLETE");
  assert.equal(result.NATIVE_RPC_CAPTURE, "COMPLETE");
  assert.equal(result.NATIVE_IDENTITY_CAPTURE, "COMPLETE");
  assert.equal(result.REAL_NATIVE_TASK_ALLOWED, true);
});

test("process manifest normalization classifies AppServers without retaining secrets", () => {
  const manifest = {
    collected_at_utc: "2026-11-17T11:24:37.317Z",
    root_pid: 572,
    processes: [
      {
        process_role: "runtime-host",
        pid: 22592,
        parent_pid: 27592,
        depth: 2,
        binary_path: "C:\\Program Files\\ZCode\\resources\\tools\\runtime-host\\zcode-runtime-host.exe",
      },
      {
        process_role: "other",
        pid: 8388,
        parent_pid: 22592,
        depth: 3,
        binary_path: "C:\\Program Files\\ZCode\\ZCode.exe",
        command_line: "SECRET_COMMAND_LINE",
        env: { SECRET_ENV: "SECRET_VALUE" },
      },
      {
        process_role: "other",
        pid: 19072,
        parent_pid: 22592,
        depth: 3,
        binary_path: "C:\\Windows\\System32\\conhost.exe",
      },
    ],
  };
  const result = normalizeDesktopProcessManifest(manifest);
  assert.equal(result.role_counts["runtime-host"], 1);
  assert.equal(result.role_counts["app-server"], 1);
  assert.equal(result.role_counts.conhost, 1);
  assert.equal(
    result.processes.find((record) => record.pid === 8388).process_role,
    "app-server",
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/u);
});

test("argument parsing requires a manifest for process summarization", () => {
  const preflight = parseArgs(["preflight", "--json"]);
  assert.equal(preflight.command, "preflight");
  assert.equal(preflight.json, true);
  assert.throws(() => parseArgs(["processes"]), /processes_requires_manifest/u);
  const processes = parseArgs(["processes", "--manifest", "manifest.json"]);
  assert.match(processes.manifest, /manifest\.json$/u);
});
