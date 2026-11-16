import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PROJECT_ROOT } from "../official-assembly-probe.mjs";
import {
  analyzeBillingSnapshots,
  assessCredentialReadIsolation,
  assertInside,
  billingHourForTimestamp,
  calculateCreditBreakdown,
  compareSharedState,
  isOffPeakBillingTime,
  patchReadOnlyRuntimeExports,
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

test("official credential read fails closed when key lookup uses a shared lock", () => {
  const source = "withFileLock(`${filePath}.keyring`, async () => null)";
  const assessment = assessCredentialReadIsolation(source, "D:\\Program Files");
  assert.equal(assessment.status, "BLOCKED");
  assert.equal(assessment.reason, "official_credential_read_requires_shared_transient_lock");
  assert.match(assessment.shared_lock_root, /credentials\.json\.keyring\.lock$/u);

  const unknown = assessCredentialReadIsolation("changed implementation", "D:\\Program Files");
  assert.equal(unknown.status, "BLOCKED");
  assert.equal(unknown.reason, "official_credential_read_isolation_unproven");
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
});

test("before-snapshot gate requires a fresh empty current-hour window", () => {
  const now = new Date("2026-11-16T03:05:00.000Z");
  const before = snapshot("2026-11-16T03:04:00.000Z", [
    modelRow("GLM-5.3"),
    modelRow("GLM-5.3-Flash"),
  ]);
  const result = validateBeforeBillingSnapshot(before, now);
  assert.equal(result.status, "PASS");
  assert.equal(result.hour, 11);

  before.model_usage.modelDataList[1].tokensUsage[11] = 1;
  assert.throws(
    () => validateBeforeBillingSnapshot(before, now),
    /target model already has activity/u,
  );
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
