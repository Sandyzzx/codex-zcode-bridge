#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_CONTROL_EVIDENCE_SCHEMA_VERSION = 1;

export const REQUIRED_NATIVE_WIRE_FIELDS = Object.freeze([
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
]);

export const REQUIRED_NATIVE_IDENTITY_FIELDS = Object.freeze([
  "oauth_credential_source",
  "project_id",
  "project_token_source",
  "project_token_fingerprint",
  "api_key_id",
  "request_auth",
  "wire_authorization",
  "wire_api_key",
]);

const CAPTURE_FIELDS = Object.freeze({
  process_role: false,
  http_method: false,
  endpoint: false,
  request_header_presence: false,
  safe_request_headers: false,
  request_body_structure: false,
  response_status: false,
  safe_response_headers: false,
  sse_usage: false,
  terminal_state: false,
  auxiliary_requests: false,
  rpc_request_payload: false,
  rpc_response_payload: false,
  oauth_credential_source: false,
  project_id: false,
  project_token_source: false,
  project_token_fingerprint: false,
  api_key_id: false,
  request_auth: false,
  wire_authorization: false,
  wire_api_key: false,
});

function channel(definition) {
  return Object.freeze({
    control_complete: false,
    ...definition,
    fields: Object.freeze({ ...CAPTURE_FIELDS, ...definition.fields }),
  });
}

export const OFFICIAL_NATIVE_CAPTURE_CHANNELS = Object.freeze([
  channel({
    id: "resource_manager_network_capture",
    label: "Official Resource Manager network capture",
    source_path: "packages/desktop/src/main/resourceManagerNetwork.ts",
    schema_path: "packages/shared/src/networkCapture.ts",
    official: true,
    production_supported: true,
    development_only: false,
    policy: "allowed",
    control_supported: true,
    url_is_sanitized: true,
    identity_values_redacted: false,
    fields: {
      process_role: true,
      http_method: true,
      endpoint: true,
      request_header_presence: false,
      request_body_structure: false,
      response_status: false,
      safe_response_headers: false,
      sse_usage: false,
      terminal_state: false,
      auxiliary_requests: true,
    },
    limitation:
      "Records only timestamp, process type, pid, method and sanitized URL; it has no headers, bodies, SSE, Usage, identity or RPC payloads.",
  }),
  channel({
    id: "model_io_diagnostics",
    label: "Official model I/O diagnostics",
    source_path: "apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts",
    official: true,
    production_supported: true,
    development_only: false,
    policy: "allowed",
    control_supported: false,
    url_is_sanitized: true,
    identity_values_redacted: true,
    fields: {
      process_role: true,
      endpoint: true,
      request_header_presence: true,
      safe_request_headers: true,
      request_body_structure: true,
      response_status: true,
      safe_response_headers: true,
      sse_usage: true,
      terminal_state: true,
      auxiliary_requests: true,
    },
    limitation:
      "Credential-bearing headers are replaced with [redacted], so the credential source and final Wire identity cannot be proved.",
  }),
  channel({
    id: "stdio_tap_dev",
    label: "Official Agent stdio tap",
    source_path: "packages/services/src/zcode-agent/zcodeStdioTapDevConfig.ts",
    official: true,
    production_supported: false,
    development_only: true,
    policy: "allowed",
    control_supported: false,
    url_is_sanitized: true,
    identity_values_redacted: true,
    fields: {
      rpc_request_payload: true,
      rpc_response_payload: true,
    },
    limitation:
      "Visible only in development Node environments, forwards exact RPC bytes, hides credential RPC payloads, and does not capture model HTTP.",
  }),
  channel({
    id: "debug_mitm_proxy",
    label: "Official CLI debug MITM proxy",
    source_path: "apps/zcode-cli/packages/debug/server/network-capture.ts",
    official: true,
    production_supported: false,
    development_only: true,
    policy: "prohibited",
    control_supported: false,
    url_is_sanitized: false,
    identity_values_redacted: false,
    fields: {
      process_role: true,
      http_method: true,
      endpoint: true,
      request_header_presence: true,
      safe_request_headers: true,
      request_body_structure: true,
      response_status: true,
      safe_response_headers: true,
      sse_usage: true,
      terminal_state: true,
      auxiliary_requests: true,
      rpc_request_payload: true,
      rpc_response_payload: true,
      oauth_credential_source: true,
      project_id: true,
      project_token_source: true,
      project_token_fingerprint: true,
      api_key_id: true,
      request_auth: true,
      wire_authorization: true,
      wire_api_key: true,
    },
    limitation:
      "Requires a local CA and proxy interception; this is prohibited for Native V3 and cannot qualify even though it could expose wire data.",
  }),
]);

function hasAllFields(fields, requiredFields) {
  return requiredFields.every((name) => fields[name] === true);
}

function isEligibleProductionChannel(candidate) {
  return candidate.official === true
    && candidate.production_supported === true
    && candidate.development_only === false
    && candidate.policy === "allowed";
}

function completeOrBlocked(eligibleChannels, predicate) {
  return eligibleChannels.some(predicate) ? "COMPLETE" : "BLOCKED";
}

export function evaluateNativeControlEvidence(
  channels = OFFICIAL_NATIVE_CAPTURE_CHANNELS,
) {
  const safeChannels = Array.isArray(channels) ? channels : [];
  const eligibleChannels = safeChannels.filter(isEligibleProductionChannel);
  const hasMetadataControl = eligibleChannels.some(
    (candidate) => candidate.control_supported && candidate.fields.endpoint,
  );
  const hasCompleteControl = eligibleChannels.some(
    (candidate) => candidate.control_supported && candidate.control_complete,
  );
  const completeHttp = completeOrBlocked(
    eligibleChannels,
    (candidate) => hasAllFields(candidate.fields, REQUIRED_NATIVE_WIRE_FIELDS),
  );
  const completeRpc = completeOrBlocked(
    eligibleChannels,
    (candidate) =>
      candidate.fields.rpc_request_payload === true
      && candidate.fields.rpc_response_payload === true,
  );
  const completeIdentity = completeOrBlocked(
    eligibleChannels,
    (candidate) => hasAllFields(candidate.fields, REQUIRED_NATIVE_IDENTITY_FIELDS),
  );
  const identityRedactionEstablished = eligibleChannels.some(
    (candidate) =>
      candidate.identity_values_redacted === true
      && candidate.fields.request_header_presence === true,
  );
  const gatePassed = completeHttp === "COMPLETE"
    && completeRpc === "COMPLETE"
    && completeIdentity === "COMPLETE";

  return {
    schema_version: NATIVE_CONTROL_EVIDENCE_SCHEMA_VERSION,
    official_installed_capture_channels: safeChannels.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      official: candidate.official,
      production_supported: candidate.production_supported,
      development_only: candidate.development_only,
      policy: candidate.policy,
      control_supported: candidate.control_supported,
      limitation: candidate.limitation,
    })),
    eligible_production_channel_ids: eligibleChannels.map((candidate) => candidate.id),
    NATIVE_CAPTURE_CONTROL: hasCompleteControl
      ? "PASS"
      : hasMetadataControl
        ? "PARTIAL"
        : "BLOCKED",
    NATIVE_HTTP_CAPTURE: completeHttp,
    NATIVE_RPC_CAPTURE: completeRpc,
    NATIVE_IDENTITY_CAPTURE: completeIdentity,
    IDENTITY_REDACTION: identityRedactionEstablished ? "PASS" : "UNKNOWN",
    REAL_NATIVE_TASK_ALLOWED: gatePassed,
    BLOCKERS: gatePassed
      ? []
      : [
          "installed_resource_manager_capture_is_metadata_only",
          "model_io_redacts_credential_headers",
          "stdio_tap_is_development_only",
          "debug_mitm_proxy_is_prohibited",
        ],
  };
}

function safeProcessRole(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function withoutSecretProcessFields(processRecord) {
  const {
    command_line: _commandLine,
    commandLine: _commandLineCamel,
    environment: _environment,
    env: _env,
    ...safe
  } = processRecord ?? {};
  return safe;
}

export function normalizeDesktopProcessManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.processes)) {
    throw new Error("process_manifest_must_contain_processes");
  }
  const initial = manifest.processes.map((raw) => {
    const safe = withoutSecretProcessFields(raw);
    return {
      ...safe,
      process_role: safeProcessRole(safe.process_role),
    };
  });
  const roleByPid = new Map(initial.map((record) => [record.pid, record.process_role]));
  const processes = initial.map((record) => {
    const binaryName = path.win32.basename(String(record.binary_path ?? "")).toLowerCase();
    const parentRole = roleByPid.get(record.parent_pid);
    let process_role = record.process_role;
    if (
      process_role === "other"
      && binaryName === "zcode.exe"
      && parentRole === "runtime-host"
      && Number.isInteger(record.depth)
      && record.depth >= 3
    ) {
      process_role = "app-server";
    } else if (
      process_role === "other"
      && binaryName === "conhost.exe"
    ) {
      process_role = "conhost";
    }
    return { ...record, process_role };
  });
  const roleCounts = {};
  for (const record of processes) {
    roleCounts[record.process_role] = (roleCounts[record.process_role] ?? 0) + 1;
  }
  return {
    schema_version: NATIVE_CONTROL_EVIDENCE_SCHEMA_VERSION,
    collected_at_utc: manifest.collected_at_utc ?? null,
    root_pid: manifest.root_pid ?? null,
    process_count: processes.length,
    role_counts: roleCounts,
    processes,
  };
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "preflight" && command !== "processes") {
    throw new Error("command_must_be_preflight_or_processes");
  }
  const options = {
    command,
    json: false,
    manifest: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--manifest") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--manifest_requires_value");
      options.manifest = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unsupported_argument:${arg}`);
    }
  }
  if (options.command === "processes" && !options.manifest) {
    throw new Error("processes_requires_manifest");
  }
  return options;
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  node tools/cost-lab/native-control-evidence.mjs preflight [--json]",
      "  node tools/cost-lab/native-control-evidence.mjs processes --manifest <path> [--json]",
      "",
    ].join("\n"),
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    throw error;
  }
  if (options.command === "preflight") {
    process.stdout.write(`${JSON.stringify(evaluateNativeControlEvidence(), null, 2)}\n`);
    return;
  }
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  process.stdout.write(
    `${JSON.stringify(normalizeDesktopProcessManifest(manifest), null, 2)}\n`,
  );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
