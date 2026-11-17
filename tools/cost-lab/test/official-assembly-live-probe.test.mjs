import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { PROJECT_ROOT } from "../official-assembly-probe.mjs";
import {
  approvedLockLifecycle,
  analyzeBillingSnapshots,
  assessCredentialReadIsolation,
  assertInside,
  billingSnapshotView,
  buildAccountConfigRevision,
  billingHourForTimestamp,
  calculateCreditBreakdown,
  compareBillingIdentitySurfaces,
  compareSharedState,
  isOffPeakBillingTime,
  parseArgs,
  patchReadOnlyRuntimeExports,
  rpcParamShape,
  runProbeConversation,
  safeProtocolError,
  tracedRequest,
  validateBeforeBillingSnapshot,
} from "../official-assembly-live-probe.mjs";

const FINAL_EXPORT = `export {
  ZCODE_VERSION as ZCODE_PRODUCT_VERSION,
  ZCodeAgentProcessManager,
  ZCodeProtocolClient,
  ZCodeStdioTransport,
  createOAuthProviderRuntimeAuthService,
  createOfficialStartPlanAuthenticationResolver
};`;

const EMPTY_HOURS = Array.from({ length: 24 }, () => 0);

function modelRow(modelName, overrides = {}) {
  return {
    modelName,
    tokensUsage: [...EMPTY_HOURS],
    creditsUsage: [...EMPTY_HOURS],
    cachedInputTokensUsage: [...EMPTY_HOURS],
    uncachedInputTokensUsage: [...EMPTY_HOURS],
    outputTokensUsage: [...EMPTY_HOURS],
    cachedInputCreditsUsage: [...EMPTY_HOURS],
    uncachedInputCreditsUsage: [...EMPTY_HOURS],
    outputCreditsUsage: [...EMPTY_HOURS],
    ...overrides,
  };
}

function snapshot(capturedAt, rows) {
  return {
    schema_version: 1,
    captured_at: capturedAt,
    account_scope: "personal",
    time_zone: "Asia/Shanghai",
    source_provider: {
      id: "account:bigmodel-individual-coding-plan",
      name: "BigModel - Coding Plan",
    },
    range: "today",
    range_start_date: "2026-11-16",
    range_end_date: "2026-11-16",
    model_usage: {
      granularity: "hour",
      modelDataList: rows,
    },
  };
}

function normalizedSnapshot(capturedAt, rows) {
  return {
    schema_version: 1,
    captured_at: capturedAt,
    provider: {
      id: "account:bigmodel-individual-coding-plan",
      name: "BigModel - Coding Plan",
    },
    identity: {
      api_key_id: "api-key-id",
      organization_id: "organization-id",
      project_id: "project-id",
    },
    query: {
      range: "today",
      time_zone: "Asia/Shanghai",
    },
    range: {
      start_date: "2026-11-16",
      end_date: "2026-11-16",
    },
    official_snapshot: {
      range: "today",
      rangeStartDate: "2026-11-16",
      rangeEndDate: "2026-11-16",
      sourceProvider: {
        id: "account:bigmodel-individual-coding-plan",
        name: "BigModel - Coding Plan",
      },
      modelUsage: {
        granularity: "hour",
        modelDataList: rows,
      },
    },
  };
}

function atHour(hour, value) {
  const copy = [...EMPTY_HOURS];
  copy[hour] = value;
  return copy;
}

test("read-only runtime patch exports only the two official internal entrypoints", () => {
  const source = [
    "function setDataBaseDir(dir) {}",
    "function createCredentialService(dependencies = {}) {}",
    FINAL_EXPORT,
  ].join("\n");
  const patched = patchReadOnlyRuntimeExports(source);
  assert.match(patched, /createCredentialService,/u);
  assert.match(patched, /setDataBaseDir\n/u);
  assert.equal(patched.includes("createCredentialService as"), false);
  assert.equal(patchReadOnlyRuntimeExports(`${source}\n`).endsWith("};\n"), true);
  assert.throws(
    () => patchReadOnlyRuntimeExports(source.replace(
      "createOfficialStartPlanAuthenticationResolver",
      "createOfficialStartPlanAuthenticationResolverRenamed",
    )),
    /export block changed/u,
  );
});

test("official credential read admits only the pinned shared keyring lock", () => {
  const source = "withFileLock(`${filePath}.keyring`, async () => null)";
  const assessment = assessCredentialReadIsolation(source, "D:\\Program Files");
  assert.equal(assessment.status, "PASS");
  assert.equal(
    assessment.reason,
    "official_read_only_key_lookup_uses_approved_transient_lock",
  );
  assert.match(assessment.shared_lock_root, /credentials\.json\.keyring\.lock$/u);

  const unknown = assessCredentialReadIsolation("changed implementation", "D:\\Program Files");
  assert.equal(unknown.status, "BLOCKED");
  assert.equal(unknown.reason, "official_credential_read_isolation_unproven");
});

test("protocol trace records the first failed RPC without exposing credentials", async () => {
  const state = { rpc_trace: [], rpc_last_success: null, rpc_first_failure: null };
  const client = {
    async request(method) {
      if (method === "session/setModel") {
        const error = new Error("provider rejected apiKey=secret-value");
        error.code = -32021;
        error.data = { apiKey: "secret-value" };
        throw error;
      }
      return { ok: true };
    },
  };

  await tracedRequest(client, state, "session/create", {
    workspace: { workspacePath: "D:\\private\\fixture", workspaceKey: "private" },
    mode: "plan",
  });
  await assert.rejects(
    tracedRequest(client, state, "session/setModel", {
      sessionId: "private-session",
      model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash" },
      persistAsWorkspaceLastUsed: false,
    }),
    /provider rejected/u,
  );

  assert.equal(state.rpc_last_success, "session/create");
  assert.equal(state.rpc_first_failure.method, "session/setModel");
  assert.equal(state.rpc_first_failure.code, -32021);
  assert.equal(state.rpc_first_failure.message, "provider rejected apiKey=<redacted>");
  assert.equal(JSON.stringify(state).includes("secret-value"), false);
  assert.deepEqual(rpcParamShape({
    sessionId: "private-session",
    model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash" },
    persistAsWorkspaceLastUsed: false,
  }), {
    sessionId: { type: "string" },
    model: {
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
    },
    persistAsWorkspaceLastUsed: false,
  });
  assert.deepEqual(safeProtocolError({ code: -1, data: "secret-value" }), {
    name: "unknown_error",
    code: -1,
    message: "[object Object]",
    data_type: "string",
  });
});

test("protocol probe selects its model and reasoning during session/create", async () => {
  const methods = [];
  const state = {
    rpc_trace: [],
    rpc_last_success: null,
    rpc_first_failure: null,
    session_id: null,
  };
  const client = {
    async request(method, params) {
      methods.push(method);
      if (method === "provider/updateAccountConfig") return { status: "accepted" };
      if (method === "session/create") {
        assert.deepEqual(params.model, {
          providerId: "account:bigmodel-individual-coding-plan",
          modelId: "GLM-5.3-Flash",
          options: { reasoningLevel: "low" },
        });
        assert.equal(params.thoughtLevel, "low");
        return {
          session: { sessionId: "isolated-session" },
          settings: {
            model: { current: params.model },
            thoughtLevel: { current: "low" },
          },
          runtime: { eventSeq: 2 },
        };
      }
      if (method === "session/subscribe") return { events: [] };
      throw new Error(`unexpected RPC ${method}`);
    },
  };

  const conversation = await runProbeConversation({
    client,
    state,
    paths: { workspace: "isolated-workspace" },
    assets: {},
    accountProviderPayload: {},
    skipModelSend: true,
  });

  assert.deepEqual(methods, [
    "provider/updateAccountConfig",
    "session/create",
    "session/subscribe",
  ]);
  assert.equal(conversation.selected_model.modelId, "GLM-5.3-Flash");
  assert.equal(conversation.reasoning_level, "low");
  assert.equal(conversation.model_send_skipped, true);
  assert.equal(state.rpc_last_success, "session/subscribe");
});

test("account config revision uses official release number and source path identity", () => {
  const config = JSON.stringify({ schemaVersion: 1, revision: 44, config: {} });
  const revision = buildAccountConfigRevision(config, "D:\\zcode\\provider\\zcode-builtin.json");
  assert.match(revision, /^zcode-builtin:44:[a-f0-9]{64}$/u);
  assert.notEqual(
    revision,
    buildAccountConfigRevision(config, "D:\\other\\zcode-builtin.json"),
  );
  assert.throws(
    () => buildAccountConfigRevision(JSON.stringify({ revision: "44" }), "D:\\zcode\\x.json"),
    /revision is invalid/u,
  );
});

test("protocol smoke honors its isolated run root argument", () => {
  const options = parseArgs([
    "--protocol-smoke",
    "--run-root",
    path.join(PROJECT_ROOT, ".run", "protocol-smoke-fixture"),
  ]);
  assert.equal(options.mode, "protocol-smoke");
  assert.equal(options.runRoot, path.join(PROJECT_ROOT, ".run", "protocol-smoke-fixture"));
});

test("credit breakdown reconciles the recovered native 0.67 evidence", () => {
  const breakdown = calculateCreditBreakdown({
    uncachedInputTokens: 21,
    cachedInputTokens: 0,
    outputTokens: 74,
    offPeak: true,
    actualCredits: 0.0215,
  });
  assert.ok(Math.abs(breakdown.base_credits - 0.06403) < 1e-12);
  assert.ok(Math.abs(breakdown.expected_without_extra_discount - 0.032015) < 1e-12);
  assert.ok(Math.abs(breakdown.expected_with_zero_point_six_seven - 0.02145005) < 1e-12);
  assert.ok(Math.abs(breakdown.effective_extra_discount_ratio - 0.67156) < 1e-5);
});

test("write-path guard rejects project roots and sibling paths", () => {
  const root = path.join(PROJECT_ROOT, ".run", "fixture-root");
  assert.throws(() => assertInside(root, root), /must resolve inside/u);
  assert.throws(
    () => assertInside(root, path.join(PROJECT_ROOT, ".run", "fixture-root-sibling")),
    /must resolve inside/u,
  );
  assert.doesNotThrow(() => assertInside(root, path.join(root, "live-probe")));
});

test("shared-state comparison detects metadata changes without reading file contents", () => {
  const before = [{
    relative_path: "credentials.json",
    exists: true,
    size: 100,
    mtime_ms: 1000,
  }];
  assert.deepEqual(compareSharedState(before, structuredClone(before)), {
    unchanged: true,
    changed_paths: [],
  });
  const after = structuredClone(before);
  after[0].mtime_ms = 2000;
  assert.deepEqual(compareSharedState(before, after), {
    unchanged: false,
    changed_paths: ["credentials.json"],
  });

  const lockBefore = [{
    relative_path: "credentials.json.keyring.lock",
    exists: true,
    size: 0,
    mtime_ms: 1000,
  }];
  const lockAfter = [{
    relative_path: "credentials.json.keyring.lock",
    exists: false,
    size: null,
    mtime_ms: null,
  }];
  assert.deepEqual(compareSharedState(lockBefore, lockAfter), {
    unchanged: true,
    changed_paths: [],
  });
  assert.deepEqual(approvedLockLifecycle(lockBefore, lockAfter), {
    path: "credentials.json.keyring.lock",
    observed_during_operation: true,
    released_after_operation: true,
    observed_size: 0,
    observed_mtime_ms: 1000,
  });
});

test("before-snapshot gate permits differential attribution from a nonempty hour", () => {
  const now = new Date("2026-11-16T03:05:00.000Z");
  const before = snapshot("2026-11-16T03:04:00.000Z", [
    modelRow("GLM-5.3"),
    modelRow("GLM-5.3-Flash"),
  ]);
  const result = validateBeforeBillingSnapshot(before, now);
  assert.equal(result.status, "PASS");
  assert.equal(result.hour, 11);

  before.model_usage.modelDataList[1].tokensUsage[11] = 1;
  before.model_usage.modelDataList[1].creditsUsage[11] = 0.01;
  const differential = validateBeforeBillingSnapshot(before, now);
  assert.equal(differential.status, "PASS");
  assert.equal(differential.target_bucket_before.tokensUsage, 1);
});

test("normalized billing snapshots retain official hour and identity evidence", () => {
  const now = new Date("2026-11-16T03:05:00.000Z");
  const before = normalizedSnapshot("2026-11-16T03:04:00.000Z", [
    modelRow("GLM-5.3-Flash", {
      tokensUsage: atHour(11, 95),
      creditsUsage: atHour(11, 0.0215),
    }),
  ]);

  const view = billingSnapshotView(before);
  assert.equal(view.time_zone, "Asia/Shanghai");
  assert.equal(view.source_provider.id, "account:bigmodel-individual-coding-plan");
  assert.equal(view.range_start_date, "2026-11-16");
  assert.equal(view.model_usage, before.official_snapshot.modelUsage);

  const result = validateBeforeBillingSnapshot(before, now);
  assert.equal(result.status, "PASS");
  assert.equal(result.hour, 11);
  assert.equal(result.target_bucket_before.tokensUsage, 95);
});

test("Shanghai hour conversion is stable at the UTC day boundary", () => {
  assert.equal(billingHourForTimestamp("2026-11-15T16:00:00.000Z"), 0);
  assert.equal(billingHourForTimestamp("2026-11-15T15:59:59.999Z"), 23);
});

test("official peak window is weekday 14:00 to 18:00 Asia/Shanghai", () => {
  assert.equal(isOffPeakBillingTime("2026-11-16T03:00:00.000Z"), true);
  assert.equal(isOffPeakBillingTime("2026-11-16T06:00:00.000Z"), false);
  assert.equal(isOffPeakBillingTime("2026-11-16T10:00:00.000Z"), true);
  assert.equal(isOffPeakBillingTime("2026-11-15T06:00:00.000Z"), true);
});

test("billing analysis requires an uncontaminated request-hour delta", () => {
  const before = snapshot("2026-11-16T02:59:00.000Z", [
    modelRow("GLM-5.3"),
    modelRow("GLM-5.3-Flash"),
  ]);
  const after = snapshot("2026-11-16T03:02:00.000Z", [
    modelRow("GLM-5.3"),
    modelRow("GLM-5.3-Flash", {
      tokensUsage: atHour(11, 95),
      creditsUsage: atHour(11, 0.0215),
      cachedInputTokensUsage: atHour(11, 0),
      uncachedInputTokensUsage: atHour(11, 21),
      outputTokensUsage: atHour(11, 74),
      cachedInputCreditsUsage: atHour(11, 0),
      uncachedInputCreditsUsage: atHour(11, 0.0016),
      outputCreditsUsage: atHour(11, 0.0198),
    }),
  ]);
  const run = {
    status: "PASS",
    experiment: {
      started_at: "2026-11-16T03:00:00.000Z",
      finished_at: "2026-11-16T03:01:00.000Z",
    },
    runtime: {
      usage_numeric: {
        cachedInputTokens: 0,
        uncachedInputTokens: 21,
        outputTokens: 74,
        totalTokens: 95,
      },
    },
  };
  const result = analyzeBillingSnapshots(before, after, run);
  assert.deepEqual(result.window.reasons, []);
  assert.equal(result.status, "PASS");
  assert.equal(result.window.clean, true);
  assert.equal(result.token_match, "PASS");
  assert.ok(Math.abs(result.effective_extra_discount_ratio - 0.67156) < 1e-5);
  assert.equal(result.discount, "PASS");

  after.model_usage.modelDataList[0].tokensUsage[11] = 1;
  const contaminated = analyzeBillingSnapshots(before, after, run);
  assert.equal(contaminated.status, "INCONCLUSIVE");
  assert.equal(contaminated.window.clean, false);
  assert.equal(contaminated.discount, "INCONCLUSIVE");
  assert.ok(contaminated.window.reasons.includes("other_model_activity_in_hour"));
});

test("billing analysis uses the official aggregate when an auxiliary usage is missing", () => {
  const before = snapshot("2026-11-17T10:02:50.748Z", [
    modelRow("GLM-5.3-Flash"),
  ]);
  before.range_start_date = "2026-11-17";
  before.range_end_date = "2026-11-17";
  const after = snapshot("2026-11-17T10:12:18.531Z", [
    modelRow("GLM-5.3-Flash", {
      tokensUsage: atHour(18, 13925),
      creditsUsage: atHour(18, 1.6072),
      cachedInputTokensUsage: atHour(18, 192),
      uncachedInputTokensUsage: atHour(18, 13654),
      outputTokensUsage: atHour(18, 79),
      cachedInputCreditsUsage: atHour(18, 0.0054),
      uncachedInputCreditsUsage: atHour(18, 1.5702),
      outputCreditsUsage: atHour(18, 0.0316),
    }),
  ]);
  after.range_start_date = "2026-11-17";
  after.range_end_date = "2026-11-17";
  const run = {
    status: "FAIL",
    execution_gate: "PASS",
    network_gate: "FAIL",
    experiment: {
      started_at: "2026-11-17T10:06:56.733Z",
      finished_at: "2026-11-17T10:07:11.714Z",
    },
    runtime: {
      usage_numeric: {
        cachedInputTokens: 0,
        uncachedInputTokens: 13544,
        outputTokens: 68,
        totalTokens: 13612,
      },
    },
  };

  const result = analyzeBillingSnapshots(before, after, run);
  assert.deepEqual(result.window.reasons, []);
  assert.equal(result.status, "PASS");
  assert.equal(result.request_usage_source, "OFFICIAL_HOURLY_DELTA");
  assert.equal(result.request_usage.runtime_usage_complete, true);
  assert.equal(result.request_usage.runtime_usage_matches_official, false);
  assert.equal(result.request_usage.official_usage_complete, true);
  assert.equal(result.token_match, "PASS");
  assert.equal(result.discount, "FAIL");
  assert.ok(Math.abs(result.effective_extra_discount_ratio - 1.0000087108772726) < 1e-12);
});

test("billing identity comparison uses only local fingerprints", () => {
  const before = snapshot("2026-11-16T02:59:00.000Z", [
    modelRow("GLM-5.3-Flash"),
  ]);
  const after = snapshot("2026-11-16T03:02:00.000Z", [
    modelRow("GLM-5.3-Flash"),
  ]);
  before.identity = {
    api_key_id: "api-key-id",
    organization_id: "organization-id",
    project_id: "project-id",
  };
  after.identity = structuredClone(before.identity);
  const run = {
    network: {
      identity: {
        project_identity_parameter_fingerprints: {
          api_key_id: [
            "e6aa8a9eca2255c2ab9c3d82b05cac045e1e81a0e5ba1a1a84ff25f6b8a3a79c",
          ],
          organization_id: [
            "c7f4b2257bf6f0f204dcdb9ef1d94a3b128d9ca30f14b4e6ddcf096cd30df6e5",
          ],
          project_id: [
            "89b8c5b296c18e85b0c79f25a85d8e3cd98962bfa79da6461e790b15b04a1a04",
          ],
        },
      },
    },
  };
  for (const [kind, field] of [
    ["api_key_id", "api_key_id"],
    ["organization_id", "organization_id"],
    ["project_id", "project_id"],
  ]) {
    run.network.identity.project_identity_parameter_fingerprints[kind] = [
      createHash("sha256").update(after.identity[field]).digest("hex"),
    ];
  }

  assert.deepEqual(compareBillingIdentitySurfaces(before, after, run), {
    snapshot_identity_complete: true,
    snapshot_stable: true,
    api_key_id_parity: "MATCH",
    organization_id_parity: "MATCH",
    project_id_parity: "MATCH",
    project_identity_parity: "MATCH",
  });

  after.identity.project_id = "different-project";
  const changed = compareBillingIdentitySurfaces(before, after, run);
  assert.equal(changed.snapshot_identity_complete, true);
  assert.equal(changed.snapshot_stable, false);
  assert.equal(changed.project_identity_parity, "DIFFERENT");

  const missing = snapshot("2026-11-16T03:02:00.000Z", [
    modelRow("GLM-5.3-Flash"),
  ]);
  assert.equal(
    compareBillingIdentitySurfaces(missing, missing, run).project_identity_parity,
    "UNKNOWN",
  );
});
