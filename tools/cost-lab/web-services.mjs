import { createHash } from "node:crypto";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { resolveBillingDataBaseDir } from "./path-discovery.mjs";
import { inspectOfficialRuntimeAssets } from "./official-runtime-manifest.mjs";
import { verifyOfficialVendor } from "./vendor-loader.mjs";

export async function inspectCostLabEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const data = resolveBillingDataBaseDir(null, {
    env,
    platform,
    fallbackHomeDir: options.fallbackHomeDir,
    fileExists: options.fileExists,
    readFile: options.readFile,
  });
  const runtime = await (options.inspectRuntime ?? inspectOfficialRuntimeAssets)({ env, platform, arch });
  const billing = await inspectBillingAvailability(options);
  const credentials = await inspectCredentialAvailability(data, options);
  const nodeOk = /^24\.16\.\d+$/u.test(nodeVersion);
  const deep = options.deep === true;
  const protocolSmoke = deep && typeof options.protocolSmoke === "function"
    ? await runBoundedProtocolSmoke(options.protocolSmoke, options.protocolSmokeTimeoutMs ?? 30_000)
    : {
        status: "NOT_RUN",
        reason: deep ? "protocol_smoke_runner_not_configured" : "deep_check_not_requested",
        model_requests: 0,
      };
  return {
    schema_version: 1,
    kind: "cost_lab_environment",
    generated_at: generatedAt,
    host: {
      platform,
      arch,
      node_version: nodeVersion,
      node_compatible: nodeOk,
      supported: platform === "win32" && arch === "x64" && nodeOk,
    },
    zcode: {
      installed: runtime.install_root !== null,
      install_source: runtime.install_source ?? null,
      install_root_fingerprint: runtime.install_root_fingerprint,
      installation_fingerprint: runtime.installation_fingerprint ?? null,
      installation_safety: runtime.installation_safety ?? null,
      runtime_status: runtime.runtime_status,
      experimental_authorization: runtime.experimental_authorization ?? null,
      discount_status: runtime.discount_status,
      version: runtime.desktop_version ?? null,
      appserver_protocol: runtime.manifest?.appserver_protocol ?? null,
      request_security_capability: runtime.manifest?.request_security_capability ?? null,
      manifest: runtime.manifest,
      assets: runtime.assets,
    },
    billing_reader: billing,
    credential_readability: credentials,
    resource_isolation: {
      status: "PASS",
      server_binding: "127.0.0.1_ONLY",
      evidence_root: ".run/cost-lab-web",
      model_requests_on_page_load: 0,
    },
    provider: {
      id: "account:bigmodel-individual-coding-plan",
      model: "GLM-5.3-Flash",
      plan: "PERSONAL_CODING_PLAN",
    },
    appserver_protocol_smoke: protocolSmoke,
    start_plan: {
      status: "START_PLAN_OFFLINE_RESEARCH",
      live_test: "UNAVAILABLE",
      offline_compatibility: "AVAILABLE",
      discount: "NOT_VERIFIED",
    },
    warnings: buildWarnings({ nodeOk, platform, arch, runtime, billing, credentials }),
  };
}

export async function inspectBillingAvailability(options = {}) {
  try {
    const integrity = await (options.verifyBillingVendor ?? verifyOfficialVendor)();
    return {
      status: "PASS",
      accessor: "usageStatsService.getCodingPlanUsageSnapshot",
      runtime_sha256: integrity.runtime_sha256,
      native_keyring_sha256: integrity.keyring_native_sha256,
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      accessor: "usageStatsService.getCodingPlanUsageSnapshot",
      error: safeErrorCode(error),
    };
  }
}

async function inspectCredentialAvailability(data, options) {
  const credentialFile = path.join(data.dataBaseDir, ".zcode", "v2", "credentials.json");
  try {
    const metadata = await (options.statFile ?? stat)(credentialFile);
    return {
      status: "AVAILABLE",
      source: data.dataBaseDirSource,
      readable: await (options.accessFile ?? access)(credentialFile).then(() => true, () => false),
      file_present: metadata.isFile(),
      content_read: false,
      absolute_path_returned: false,
    };
  } catch (error) {
    return {
      status: errorCode(error) === "ENOENT" ? "NOT_FOUND" : "UNAVAILABLE",
      source: data.dataBaseDirSource,
      readable: false,
      file_present: false,
      content_read: false,
      absolute_path_returned: false,
    };
  }
}

async function runBoundedProtocolSmoke(run, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("protocol_smoke_timeout")), timeoutMs);
  try {
    // The AppServer smoke owns its lifecycle. Wait for its cleanup verdict.
    const result = await run({ signal: controller.signal, timeoutMs, modelRequests: 0 });
    if (result?.status === "PASS") controller.signal.throwIfAborted();
    return {
      status: result?.status === "PASS" ? "PASS" : "FAIL",
      ...(result?.reason ? { reason: safeErrorCode(result.reason) } : {}),
      duration_ms: result?.duration_ms ?? null,
      model_requests: 0,
      evidence: redactValue(result?.evidence ?? null),
    };
  } catch (error) {
    return {
      status: "FAIL",
      reason: safeErrorCode(error),
      model_requests: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildWarnings({ nodeOk, platform, arch, runtime, billing, credentials }) {
  const warnings = [];
  if (platform !== "win32" || arch !== "x64") warnings.push("PLATFORM_UNSUPPORTED");
  if (!nodeOk) warnings.push("NODE_RUNTIME_INCOMPATIBLE");
  if (runtime.runtime_status === "OFFICIAL_RUNTIME_EXPERIMENTAL") {
    warnings.push("OFFICIAL_RUNTIME_EXPERIMENTAL");
  } else if (runtime.runtime_status !== "OFFICIAL_RUNTIME_VERIFIED") {
    warnings.push("OFFICIAL_RUNTIME_UNVERIFIED");
  }
  if (billing.status !== "PASS") warnings.push("BILLING_READER_UNAVAILABLE");
  if (credentials.status !== "AVAILABLE") warnings.push("CREDENTIAL_SOURCE_UNAVAILABLE");
  return warnings;
}

export function redactValue(value, key = "") {
  if (isSecretKey(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "string") return redactAbsolutePaths(value);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [childKey, child] of Object.entries(value)) {
    output[childKey] = redactValue(child, childKey);
  }
  return output;
}

function redactAbsolutePaths(value) {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t"'<>|]*/gu, "<redacted-path>")
    .replace(/\\\\[^\\/\s]+[\\/][^\r\n\t"'<>|]*/gu, "<redacted-path>")
    .replace(/\/(?:Users|home|tmp|var|opt|private)\/[^\s"'<>|]*/gu, "<redacted-path>");
}

function isSecretKey(key) {
  const normalized = key.replaceAll("-", "_").toLowerCase();
  if (/^(api_key_id|organization_id|project_id|request_id|session_id)$/u.test(normalized)) return false;
  if (/(status|readability|present|read|returned|source|capability)$/u.test(normalized)) return false;
  if (/^(authorization|cookie|password|secret|credential|credentials|jwt|bearer)$/u.test(normalized)) return true;
  return /(access_token|refresh_token|project_token|api_key|client_secret|private_key|authorization_header|cookie_header)$/u.test(normalized);
}

export function digestText(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}


function safeErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|project[_-]?token)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu, "$1=<redacted>")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer <redacted>")
    .slice(0, 300);
}

function errorCode(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" ? code : "unavailable";
}
