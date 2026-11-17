import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(TOOL_DIRECTORY, "..", "..");
export const DEFAULT_RUN_ROOT = path.join(
  PROJECT_ROOT,
  ".run",
  "cost-lab-observability-ab-v2-live",
);
// The pinned clean source is shared read-only evidence in the main checkout's ignored .run tree.
export const DEFAULT_OFFICIAL_SOURCE = path.resolve(PROJECT_ROOT, "..", "z182-ab-source");

export const EXPECTED_OFFICIAL_SOURCE = Object.freeze({
  version: "3.18.2",
  commit: "fec975905a2abd4c07e35c40d51fa097a2258ec9",
  tree: "5e90fec80706b8381f94e4eef48cf821b9868916",
});

const SOURCE_MARKERS = Object.freeze([
  {
    id: "native_full_local_services",
    source: "official",
    file: "packages/desktop/src/host/index.ts",
    needle: "const initializedServices = createLocalServices({",
    reachability: "Native assembly entry",
    finalRequestEffect: "Selects the official service graph; not itself a model HTTP field.",
  },
  {
    id: "native_settings_service",
    source: "official",
    file: "packages/desktop/src/host/index.ts",
    needle: "} = createSettingServiceWithMigrations({ shareCredentialKeyWithDataRoot });",
    reachability: "Native settings initialization",
    finalRequestEffect: "Feeds settings-aware account access resolution.",
  },
  {
    id: "native_settings_may_write",
    source: "official",
    file: "packages/services/src/setting/settingService.ts",
    needle: "await writeSettings(projected, shouldCommit, enterCommitPhase);",
    reachability: "Settings migration during get()",
    finalRequestEffect: "No model HTTP field, but prevents claiming read-only initialization.",
  },
  {
    id: "native_local_services_app_ca",
    source: "official",
    file: "packages/services/src/node.ts",
    needle: "ensureAppCaCert();",
    reachability: "createLocalServices side effect",
    finalRequestEffect: "May create local CA material; no billing identity field.",
  },
  {
    id: "native_settings_aware_access",
    source: "official",
    file: "packages/services/src/node.ts",
    needle: "resolveCurrentAccountAccess({",
    reachability: "Account access resolution",
    finalRequestEffect: "Produces a canonical plan identity consumed by official request auth.",
  },
  {
    id: "native_host_transport",
    source: "official",
    file: "packages/services/src/node.ts",
    needle: "fetchImpl: hostApiNetworkTransport.fetch,",
    reachability: "Official API client for OAuth and Project Token issuance",
    finalRequestEffect: "Changes proxy/CA transport only; not model request billing headers.",
  },
  {
    id: "native_project_token_client",
    source: "official",
    file: "packages/services/src/node.ts",
    needle: "const projectTokenClient = createAccountProjectTokenClient(apiClient, credentialService);",
    reachability: "Project token issuance",
    finalRequestEffect: "Supplies model apiKey and optional non-secret apiKeyId.",
  },
  {
    id: "official_request_auth_material",
    source: "official",
    file: "packages/services/src/model-provider/accountProviderRequestAuthService.ts",
    needle: "apiKey: requireApiKey(material?.token, providerId),",
    reachability: "Final request-auth response from Host to AppServer",
    finalRequestEffect:
      "Material is apiKey plus optional apiKeyId/accountScope; no discount or campaign field.",
  },
  {
    id: "coding_plan_usage_scene",
    source: "official",
    file: "packages/shared/src/project-access-token-client.ts",
    needle: "usageScene: API_KEY_USAGE_SCENE.CODING_PLAN,",
    reachability: "Project token API-key selection/issuance",
    finalRequestEffect: "Shared by native and Bridge source paths.",
  },
  {
    id: "model_request_auth_application",
    source: "official",
    file: "apps/zcode-cli/packages/adapters/src/model/model-execution.ts",
    needle: "const providerConfig = applyModelRequestAuth(snapshot.providerConfig, requestAuth);",
    reachability: "Final model request construction",
    finalRequestEffect: "Applies apiKey and dynamic headers; apiKeyId is routing metadata.",
  },
  {
    id: "bridge_simplified_access_callback",
    source: "bridge",
    file: "src/worker/worker-main.ts",
    needle: "resolveCurrentAccountAccess: async (currentAccess) => {",
    reachability: "Bridge request auth",
    finalRequestEffect: "Returns the same canonical individual-coding-plan shape for valid input.",
  },
  {
    id: "bridge_default_api_client",
    source: "bridge",
    file: "upstream/zcode-3.18.2/patches/0002-oauth-refresh-coordination.patch",
    needle: "const apiClient = options.apiClient ?? createNodeApiClient();",
    reachability: "Bridge-added minimal official factory",
    finalRequestEffect: "Transport construction differs; final model auth fields remain official.",
  },
  {
    id: "bridge_project_token_client",
    source: "bridge",
    file: "upstream/zcode-3.18.2/patches/0002-oauth-refresh-coordination.patch",
    needle:
      "const projectTokenClient = createAccountProjectTokenClient(apiClient, credentialService);",
    reachability: "Project token issuance",
    finalRequestEffect: "Uses the same official Project Token client as native assembly.",
  },
  {
    id: "bridge_appserver_forwarding",
    source: "bridge",
    file: "src/adapters/zcode-app-server-adapter.ts",
    needle: "void this.#resolveProviderRuntimeAuth(params, config, entry.abort.signal)",
    reachability: "Bridge AppServer runtime-auth forwarding",
    finalRequestEffect: "Forwards official requestAuth to the same official AppServer.",
  },
]);

const FINAL_REQUEST_BOUNDARIES = Object.freeze([
  {
    component: "Settings-aware resolveCurrentAccountAccess",
    reachesFinalRequest: "indirect",
    classification: "STRUCTURAL_RUNTIME_ONLY",
  },
  {
    component: "Credential cipher process boundary",
    reachesFinalRequest: "decryption only",
    classification: "STRUCTURAL_RUNTIME_ONLY",
  },
  {
    component: "Host API network transport",
    reachesFinalRequest: "Project Token issuance transport",
    classification: "NETWORK_PATH_ONLY_ON_EVIDENCE",
  },
  {
    component: "OAuth invalidation/associated refresh hooks",
    reachesFinalRequest: "credential freshness/recovery",
    classification: "STRUCTURAL_RUNTIME_ONLY",
  },
  {
    component: "AccountProviderRequestAuthService",
    reachesFinalRequest: "yes",
    classification: "SHARED_OFFICIAL_IMPLEMENTATION",
  },
  {
    component: "Project Access Token client",
    reachesFinalRequest: "yes",
    classification: "SHARED_OFFICIAL_IMPLEMENTATION",
  },
  {
    component: "Official AppServer",
    reachesFinalRequest: "yes",
    classification: "SHARED_OFFICIAL_IMPLEMENTATION",
  },
]);

const NETWORK_ENTRYPOINTS = Object.freeze([
  {
    id: "host_api_undici_fetch",
    source: "official",
    file: "packages/services/src/providers/api/nodeApiNetwork.ts",
    needle: "fetch as undiciFetch",
    process_role: "bridge_main_or_experiment_harness",
    active_in_b_task: true,
    observation: ["undici diagnostics_channel", "preload fetch wrapper"],
  },
  {
    id: "host_api_global_fetch_fallback",
    source: "official",
    file: "packages/services/src/providers/api/nodeApiNetwork.ts",
    needle: "return globalThis.fetch(",
    process_role: "bridge_main_or_experiment_harness",
    active_in_b_task: true,
    observation: ["preload fetch wrapper"],
  },
  {
    id: "host_api_undici_websocket",
    source: "official",
    file: "packages/services/src/providers/api/nodeApiNetwork.ts",
    needle: "import { Agent, ProxyAgent, WebSocket",
    process_role: "bridge_main_or_experiment_harness",
    active_in_b_task: false,
    observation: ["not a B-task transport; no voice request is issued"],
  },
  {
    id: "model_execution_fetch",
    source: "official",
    file: "apps/zcode-cli/packages/adapters/src/model/model-execution.ts",
    needle: "const response = await fetch(input, init);",
    process_role: "official_app_server",
    active_in_b_task: true,
    observation: ["undici diagnostics_channel", "preload fetch wrapper"],
  },
  {
    id: "proxy_fetch_node_https",
    source: "official",
    file: "apps/zcode-cli/packages/adapters/src/network/proxy-fetch.ts",
    needle: "const transport = request.url.protocol",
    process_role: "official_app_server",
    active_in_b_task: true,
    observation: ["node:http diagnostics", "preload node:http/https wrapper"],
  },
  {
    id: "project_token_http",
    source: "official",
    file: "packages/shared/src/project-access-token-client.ts",
    needle: "await request(`${origin}/api/biz/customer/getCustomerInfo`",
    process_role: "bridge_main_or_experiment_harness",
    active_in_b_task: true,
    observation: ["official Host transport fetch", "undici diagnostics_channel"],
  },
  {
    id: "official_undici_capture",
    source: "official",
    file: "packages/shared/src/node/networkCapture.ts",
    needle: 'channel("undici:request:create").subscribe(undici);',
    process_role: "official_app_server",
    active_in_b_task: true,
    observation: ["official process/networkCapture cross-check"],
  },
  {
    id: "official_node_http_capture",
    source: "official",
    file: "packages/shared/src/node/networkCapture.ts",
    needle: 'channel("http.client.request.start").subscribe(http);',
    process_role: "official_app_server",
    active_in_b_task: true,
    observation: ["official process/networkCapture cross-check"],
  },
  {
    id: "bridge_worker_fd_socket",
    source: "bridge",
    file: "src/worker/worker-main.ts",
    needle: "new Socket({ fd: 8, readable: true, writable: false })",
    process_role: "bridge_worker",
    active_in_b_task: true,
    observation: ["inherited fd IPC, not an outbound network client"],
  },
]);

const DIRECT_NETWORK_BYPASS_FILES = Object.freeze([
  "packages/services/src/providers/api/nodeApiNetwork.ts",
  "apps/zcode-cli/packages/adapters/src/model/model-execution.ts",
  "apps/zcode-cli/packages/adapters/src/network/proxy-fetch.ts",
  "packages/shared/src/project-access-token-client.ts",
  "packages/shared/src/node/networkCapture.ts",
]);

const DIRECT_NETWORK_BYPASS_PATTERNS = Object.freeze([
  {
    id: "HTTP2_CLIENT",
    pattern: /(?:from\s+["'](?:node:)?http2["']|require\(["'](?:node:)?http2["']\))/u,
  },
  {
    id: "DIRECT_TLS_CONNECT",
    pattern: /\btls\d*\.connect\s*\(/u,
  },
  {
    id: "DIRECT_NET_CONNECT",
    pattern: /\bnet\d*\.(?:connect|createConnection)\s*\(/u,
  },
]);

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function lineNumber(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return null;
  return text.slice(0, index).split(/\r?\n/u).length;
}

async function readBounded(filePath, maximumBytes = 2 * 1024 * 1024) {
  const bytes = await readFile(filePath);
  if (bytes.length > maximumBytes) {
    throw new Error(`source file exceeds bounded read size: ${path.basename(filePath)}`);
  }
  return bytes.toString("utf8");
}

export async function auditOfficialAssemblySources({
  officialSourceRoot = DEFAULT_OFFICIAL_SOURCE,
  bridgeRoot = PROJECT_ROOT,
} = {}) {
  const officialRoot = path.resolve(officialSourceRoot);
  const bridgeSourceRoot = path.resolve(bridgeRoot);
  if (!existsSync(path.join(officialRoot, ".git"))) {
    throw new Error(`official source checkout is missing: ${officialRoot}`);
  }

  const version = JSON.parse(
    await readBounded(path.join(officialRoot, "package.json"), 256 * 1024),
  ).version;
  const commit = git(officialRoot, ["rev-parse", "HEAD"]);
  const tree = git(officialRoot, ["show", "-s", "--format=%T", "HEAD"]);
  const sourceStatus = git(officialRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (
    version !== EXPECTED_OFFICIAL_SOURCE.version ||
    commit !== EXPECTED_OFFICIAL_SOURCE.commit ||
    tree !== EXPECTED_OFFICIAL_SOURCE.tree
  ) {
    throw new Error(
      `official source provenance mismatch: version=${version} commit=${commit} tree=${tree}`,
    );
  }
  if (sourceStatus) {
    throw new Error("official source checkout is not clean");
  }

  const cache = new Map();
  const readAt = async (root, relativePath) => {
    const key = `${root}\0${relativePath}`;
    let value = cache.get(key);
    if (!value) {
      value = await readBounded(path.join(root, relativePath));
      cache.set(key, value);
    }
    return value;
  };

  const markers = [];
  for (const marker of SOURCE_MARKERS) {
    const root = marker.source === "official" ? officialRoot : bridgeSourceRoot;
    const text = await readAt(root, marker.file);
    const line = lineNumber(text, marker.needle);
    markers.push({
      id: marker.id,
      source: marker.source,
      file: marker.file,
      line,
      present: line !== null,
      reachability: marker.reachability,
      final_request_effect: marker.finalRequestEffect,
    });
  }
  const missing = markers.filter((marker) => !marker.present);
  if (missing.length > 0) {
    throw new Error(`official assembly source markers missing: ${missing.map((item) => item.id)}`);
  }

  const networkEntrypoints = [];
  for (const definition of NETWORK_ENTRYPOINTS) {
    const root = definition.source === "official" ? officialRoot : bridgeSourceRoot;
    const text = await readAt(root, definition.file);
    const line = lineNumber(text, definition.needle);
    networkEntrypoints.push({
      id: definition.id,
      source: definition.source,
      file: definition.file,
      line,
      present: line !== null,
      process_role: definition.process_role,
      active_in_b_task: definition.active_in_b_task,
      observation: definition.observation,
    });
  }
  const missingNetworkEntrypoints = networkEntrypoints.filter((entry) => !entry.present);
  if (missingNetworkEntrypoints.length > 0) {
    throw new Error(
      `network entrypoint markers missing: ${missingNetworkEntrypoints.map((item) => item.id)}`,
    );
  }
  const bypassMatches = [];
  for (const relativePath of DIRECT_NETWORK_BYPASS_FILES) {
    const text = await readAt(officialRoot, relativePath);
    for (const definition of DIRECT_NETWORK_BYPASS_PATTERNS) {
      if (definition.pattern.test(text)) {
        bypassMatches.push({
          file: relativePath,
          kind: definition.id,
        });
      }
    }
  }

  const buildCore = await readAt(bridgeSourceRoot, "scripts/build-core.mjs");
  const buildPlugin = await readAt(bridgeSourceRoot, "scripts/build-plugin.mjs");
  const buildOfficialHost = await readAt(
    bridgeSourceRoot,
    "scripts/build-official-host-runtime.mjs",
  );
  const productionBuildScripts = [buildCore, buildPlugin, buildOfficialHost];
  const experimentPathReferencedByProductionBuild = productionBuildScripts.some((source) =>
    source.includes("tools/cost-lab"),
  );

  return {
    schema_version: 1,
    kind: "coding_plan_official_assembly_offline_audit",
    generated_at: new Date().toISOString(),
    official_source: {
      version,
      commit,
      tree,
      clean: true,
    },
    markers,
    network_entrypoints: networkEntrypoints,
    network_bypass_scan: {
      files: [...DIRECT_NETWORK_BYPASS_FILES],
      direct_http2: bypassMatches.some((entry) => entry.kind === "HTTP2_CLIENT")
        ? "FOUND"
        : "NOT_OBSERVED",
      direct_tls_connect: bypassMatches.some((entry) => entry.kind === "DIRECT_TLS_CONNECT")
        ? "FOUND"
        : "NOT_OBSERVED",
      direct_net_connect: bypassMatches.some((entry) => entry.kind === "DIRECT_NET_CONNECT")
        ? "FOUND"
        : "NOT_OBSERVED",
      matches: bypassMatches,
    },
    final_request_boundaries: FINAL_REQUEST_BOUNDARIES,
    observations: {
      runtime_assembly_delta: "CONFIRMED",
      settings_aware_access_delta: "CONFIRMED",
      host_transport_delta: "CONFIRMED",
      oauth_recovery_hook_delta: "CONFIRMED",
      shared_request_auth_service: "CONFIRMED",
      shared_project_token_client: "CONFIRMED",
      shared_appserver: "CONFIRMED",
      discount_or_campaign_field_in_model_request_auth: "NOT_FOUND",
    },
    experiment_bundle_isolated_from_production_build:
      !experimentPathReferencedByProductionBuild,
    network_requests: 0,
    model_requests: 0,
  };
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalIdentifier(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = requiredString(value, "apiKeyId");
  if (normalized.length > 256) throw new Error("apiKeyId exceeds metadata bound");
  return normalized;
}

function optionalAccountScope(value) {
  if (value === undefined || value === null || value === "") {
    return { present: false, format: null };
  }
  const normalized = requiredString(value, "accountScope");
  return {
    present: true,
    format: /^[a-f0-9]{64}$/u.test(normalized) ? "sha256_hex" : "opaque",
  };
}

export function normalizeAuthContext(input) {
  const account = input?.account;
  const requestAuth = input?.requestAuth;
  if (!account || typeof account !== "object") throw new Error("account is required");
  if (!requestAuth || typeof requestAuth !== "object") throw new Error("requestAuth is required");
  if (typeof requestAuth.apiKey !== "string" || !requestAuth.apiKey) {
    throw new Error("requestAuth.apiKey presence is required");
  }
  const headerNames = Object.keys(requestAuth.headers ?? {})
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return {
    provider_id: requiredString(input.providerId, "providerId"),
    model_id: requiredString(input.modelId, "modelId"),
    account: {
      family: requiredString(account.family, "account.family"),
      plan_kind: requiredString(account.planKind, "account.planKind"),
      scope: optionalAccountScope(requestAuth.accountScope),
    },
    request_auth: {
      api_key_present: true,
      api_key_id: optionalIdentifier(requestAuth.apiKeyId),
      header_names: headerNames,
      headers_present: headerNames.length > 0,
    },
    usage_scene: input.usageScene ?? null,
    transport: {
      kind: requiredString(input.transportKind, "transportKind"),
    },
    discount_fields_present: false,
    campaign_fields_present: false,
  };
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

export function compareNormalizedAuthContexts(leftInput, rightInput) {
  const left = normalizeAuthContext(leftInput);
  const right = normalizeAuthContext(rightInput);
  const leftJson = JSON.stringify(stableValue(left));
  const rightJson = JSON.stringify(stableValue(right));
  const authSurface = (normalized) => ({
    provider_id: normalized.provider_id,
    model_id: normalized.model_id,
    account: normalized.account,
    request_auth: normalized.request_auth,
    usage_scene: normalized.usage_scene,
  });
  const leftAuthSurfaceJson = JSON.stringify(stableValue(authSurface(left)));
  const rightAuthSurfaceJson = JSON.stringify(stableValue(authSurface(right)));
  return {
    fixture_only: true,
    left,
    right,
    normalized_equal: leftJson === rightJson,
    final_request_auth_surface_delta:
      leftAuthSurfaceJson === rightAuthSurfaceJson ? "NONE" : "PRESENT",
    transport_delta:
      JSON.stringify(stableValue(left.transport)) === JSON.stringify(stableValue(right.transport))
        ? "NONE"
        : "PRESENT",
    project_identity_parity:
      left.request_auth.api_key_id !== null && right.request_auth.api_key_id !== null
        ? left.request_auth.api_key_id === right.request_auth.api_key_id
          ? "FIXTURE_EQUAL"
          : "FIXTURE_DIFFERENT"
        : "UNKNOWN",
  };
}

function secretLikeValue(value) {
  return /(?:bearer\s+|eyJ[a-zA-Z0-9_-]{10,}|sk-[a-zA-Z0-9_-]{8,})/iu.test(String(value));
}

export function assertNoSecretMaterial(value, extraSecrets = []) {
  const forbidden = new Set(
    ["apiKey", "accessToken", "refreshToken", "authorization", "x-bigmodel-authorization"].map(
      (item) => item.toLowerCase(),
    ),
  );
  const secrets = (Array.isArray(extraSecrets) ? extraSecrets : [extraSecrets]).filter(
    (item) => typeof item === "string" && item.length > 0,
  );
  const pending = [{ value, key: null }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.key && forbidden.has(current.key.toLowerCase())) {
      throw new Error(`secret-bearing field is not allowed: ${current.key}`);
    }
    if (typeof current.value === "string") {
      if (secretLikeValue(current.value) || secrets.some((secret) => current.value.includes(secret))) {
        throw new Error("secret-like material is not allowed in evidence");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, key: null });
      continue;
    }
    if (current.value && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) {
        pending.push({ value: child, key });
      }
    }
  }
  return true;
}

export function assessLiveProbeGate({
  officialSourcePinned = true,
  settingsInitialization = "NOT_PROVEN_READ_ONLY",
  credentialStoreMutation = "NOT_PROVEN_NON_MUTATING",
  officialBillingSnapshotAccess = "BLOCKED",
  exclusiveBillingWindow = "NOT_PROVEN",
  deterministicCleanup = "NOT_PROVEN",
  outputInsideProject = true,
} = {}) {
  const requirements = {
    official_source_pinned: officialSourcePinned === true,
    settings_initialization_read_only: settingsInitialization === "PROVEN_READ_ONLY",
    credential_store_non_mutating: credentialStoreMutation === "PROVEN_NON_MUTATING",
    official_billing_snapshot_access: officialBillingSnapshotAccess === "PASS",
    exclusive_billing_window: exclusiveBillingWindow === "PROVEN",
    deterministic_cleanup: deterministicCleanup === "PROVEN",
    output_inside_project: outputInsideProject === true,
  };
  const blockers = Object.entries(requirements)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    status: blockers.length === 0 ? "LIVE_PROBE_READY" : "LIVE_PROBE_BLOCKED",
    authorization_to_launch_model_request: blockers.length === 0,
    requirements,
    blockers,
    reasons: {
      settings_initialization_read_only:
        "The official setting service can persist schema/account migrations during get().",
      credential_store_non_mutating:
        "The official Project Access Token client may persist a Project Token location record.",
      official_billing_snapshot_access:
        "No approved direct accessor is present in the current Cost Lab baseline; imports are manual-only.",
      exclusive_billing_window:
        "The current experiment cannot prove that no other same-account activity shares the hourly bucket.",
      deterministic_cleanup:
        "No live Harness/resource lifecycle has been exercised.",
    },
  };
}

function fixtureContexts() {
  const account = {
    type: "zhipu-account",
    family: "bigmodel",
    planKind: "individual-coding-plan",
  };
  return {
    left: {
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
      account,
      requestAuth: {
        apiKey: "fixture-project-token-not-real",
        apiKeyId: "fixture-api-key-id",
        accountScope: "a".repeat(64),
        headers: {},
      },
      usageScene: "coding_plan",
      transportKind: "bridge_default_node_api_client",
    },
    right: {
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
      account,
      requestAuth: {
        apiKey: "fixture-project-token-not-real",
        apiKeyId: "fixture-api-key-id",
        accountScope: "a".repeat(64),
        headers: {},
      },
      usageScene: "coding_plan",
      transportKind: "native_host_api_network_transport",
    },
  };
}

export async function buildOfflineEvidence(options = {}) {
  const sourceAudit = await auditOfficialAssemblySources(options);
  const fixtures = fixtureContexts();
  const comparison = compareNormalizedAuthContexts(fixtures.left, fixtures.right);
  const evidence = {
    schema_version: 1,
    kind: "coding_plan_official_assembly_ab_offline_evidence",
    generated_at: new Date().toISOString(),
    source_audit: sourceAudit,
    synthetic_fixture_comparison: {
      ...comparison,
      note:
        "Synthetic fixtures test redaction and structural comparison only. They do not prove live Project identity parity.",
    },
    conclusions: {
      runtime_assembly_delta: "CONFIRMED",
      auth_context_delta:
        "STRUCTURAL_RUNTIME_DIFFERENCE; NO DISCOUNT/CAMPAIGN FIELD OBSERVED AT FINAL REQUEST-AUTH BOUNDARY",
      project_identity_parity: "UNKNOWN",
      official_billing_reconciliation: "BLOCKED",
      b_discount: "INCONCLUSIVE",
      root_cause_confidence: "LOW",
    },
    live_probe_gate: assessLiveProbeGate(),
    real_model_tasks: 0,
    real_http_requests: 0,
    actual_credits: null,
  };
  assertNoSecretMaterial(evidence, fixtures.left.requestAuth.apiKey);
  return evidence;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative);
}

export async function writeOfflineEvidence(outputPath, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const runRoot = path.resolve(options.runRoot ?? DEFAULT_RUN_ROOT);
  const target = path.resolve(outputPath ?? path.join(runRoot, "offline-evidence.json"));
  if (!isInside(projectRoot, runRoot) || !isInside(runRoot, target)) {
    throw new Error("experiment output must resolve inside the task .run directory");
  }
  const evidence = await buildOfflineEvidence(options);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { evidence, outputPath: target };
}

function parseArgs(argv) {
  const result = {
    officialSourceRoot: DEFAULT_OFFICIAL_SOURCE,
    outputPath: path.join(DEFAULT_RUN_ROOT, "offline-evidence.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--official-source") {
      if (!argv[index + 1]) throw new Error("--official-source requires a path");
      result.officialSourceRoot = path.resolve(argv[++index]);
    } else if (argument === "--out") {
      if (!argv[index + 1]) throw new Error("--out requires a path");
      result.outputPath = path.resolve(argv[++index]);
    } else if (argument === "--live") {
      throw new Error(
        "LIVE_PROBE_BLOCKED: this baseline has no read-only settings/billing isolation proof",
      );
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { evidence, outputPath } = await writeOfflineEvidence(options.outputPath, {
    officialSourceRoot: options.officialSourceRoot,
  });
  const summary = {
    kind: evidence.kind,
    output: path.relative(PROJECT_ROOT, outputPath).replaceAll(path.sep, "/"),
    official_source: evidence.source_audit.official_source,
    runtime_assembly_delta: evidence.conclusions.runtime_assembly_delta,
    auth_context_delta: evidence.conclusions.auth_context_delta,
    final_request_auth_surface_delta:
      evidence.synthetic_fixture_comparison.final_request_auth_surface_delta,
    transport_delta: evidence.synthetic_fixture_comparison.transport_delta,
    project_identity_parity: evidence.conclusions.project_identity_parity,
    live_probe_gate: evidence.live_probe_gate.status,
    live_gate_blockers: evidence.live_probe_gate.blockers,
    real_model_tasks: evidence.real_model_tasks,
    real_http_requests: evidence.real_http_requests,
    evidence_sha256: createHash("sha256")
      .update(`${JSON.stringify(evidence, null, 2)}\n`)
      .digest("hex"),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
