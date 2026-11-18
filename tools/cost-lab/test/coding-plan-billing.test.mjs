import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  PROJECT_ROOT,
  atomicWriteJson,
  buildSnapshotEnvelope,
  calculateCreditBreakdown,
  captureSnapshot,
  extractRequestUsage,
  isOffPeakShanghai,
  parseArgs,
  reconcileBillingSnapshots,
  safeError,
  sanitizeErrorMessage,
  sanitizeOfficialSnapshot,
  shanghaiHourForTimestamp,
} from "../coding-plan-billing.mjs";

const RUNTIME_PATH = path.join(
  PROJECT_ROOT,
  "tools",
  "cost-lab",
  "vendor",
  "official-billing-runtime.mjs",
);

function zeroArrays() {
  return Array.from({ length: 24 }, () => 0);
}

function modelRow({
  cachedInputTokens = 0,
  uncachedInputTokens = 0,
  outputTokens = 0,
  cachedInputCredits = 0,
  uncachedInputCredits = 0,
  outputCredits = 0,
  hour = 10,
} = {}) {
  const row = {
    modelName: "GLM-5.3-Flash",
    totalTokens: cachedInputTokens + uncachedInputTokens + outputTokens,
    totalCredits: cachedInputCredits + uncachedInputCredits + outputCredits,
    cachedInputTokensUsage: zeroArrays(),
    uncachedInputTokensUsage: zeroArrays(),
    outputTokensUsage: zeroArrays(),
    cachedInputCreditsUsage: zeroArrays(),
    uncachedInputCreditsUsage: zeroArrays(),
    outputCreditsUsage: zeroArrays(),
  };
  row.cachedInputTokensUsage[hour] = cachedInputTokens;
  row.uncachedInputTokensUsage[hour] = uncachedInputTokens;
  row.outputTokensUsage[hour] = outputTokens;
  row.cachedInputCreditsUsage[hour] = cachedInputCredits;
  row.uncachedInputCreditsUsage[hour] = uncachedInputCredits;
  row.outputCreditsUsage[hour] = outputCredits;
  return row;
}

function snapshot(row, capturedAt = "2026-11-17T02:00:00.000Z", billingSource) {
  const xTime = zeroArrays().map((_, hour) => `${String(hour).padStart(2, "0")}:00:00`);
  return buildSnapshotEnvelope({
    result: {
      snapshot: {
        range: "today",
        rangeStartDate: "2026-11-17",
        rangeEndDate: "2026-11-17",
        generatedAt: 1_794_885_600_000,
        sourceProvider: {
          id: "account:bigmodel-individual-coding-plan",
          name: "BigModel - Coding Plan",
        },
        quota: { level: "lite", limits: [] },
        modelUsage: {
          xTime,
          granularity: "hour",
          modelDataList: [row],
          costLabBillingSource: billingSource ?? { xTime, modelDataList: [row] },
        },
      },
      identity: {
        apiKeyId: "key-synthetic",
        accountScope: null,
        organizationId: "org-synthetic",
        projectId: "project-synthetic",
      },
    },
    providerId: "account:bigmodel-individual-coding-plan",
    query: {
      range: "today",
      timeZone: "Asia/Shanghai",
    },
    capturedAt,
  });
}

test("parseArgs accepts fixed snapshot and reconciliation interfaces", () => {
  const snapshotOptions = parseArgs([
    "snapshot",
    "--provider",
    "account:bigmodel-individual-coding-plan",
    "--model",
    "GLM-5.3-Flash",
    "--json",
  ]);
  assert.equal(snapshotOptions.command, "snapshot");
  assert.equal(snapshotOptions.provider, "account:bigmodel-individual-coding-plan");
  assert.equal(snapshotOptions.model, "GLM-5.3-Flash");
  assert.equal(snapshotOptions.timeZone, "Asia/Shanghai");
  assert.equal(snapshotOptions.json, true);
  assert.equal(snapshotOptions.dataRoot, null);

  const reconcileOptions = parseArgs([
    "reconcile",
    "--before",
    "before.json",
    "--after",
    "after.json",
    "--usage",
    "usage.json",
    "--hour",
    "16",
  ]);
  assert.equal(reconcileOptions.command, "reconcile");
  assert.equal(reconcileOptions.hour, 16);
  assert.throws(
    () => parseArgs(["snapshot", "--timezone", "UTC"]),
    /only_asia_shanghai/,
  );
  assert.throws(
    () => parseArgs(["reconcile", "--before", "before.json"]),
    /reconcile_requires/,
  );
});

test("snapshot envelope normalizes hour buckets and retains the raw source", () => {
  const row = modelRow({
    cachedInputTokens: 64,
    uncachedInputTokens: 13_291,
    outputTokens: 47,
    cachedInputCredits: 0.003584,
    uncachedInputCredits: 3.05693,
    outputCredits: 0.0376,
  });
  const envelope = snapshot(row);
  const model = envelope.models[0];
  assert.equal(envelope.source, "official:usageStatsService.getCodingPlanUsageSnapshot");
  assert.equal(envelope.identity.api_key_id, "key-synthetic");
  assert.equal(envelope.identity.plan_scope, "personal");
  assert.equal(envelope.integrity.status, "COMPLETE");
  assert.equal(model.hours.length, 24);
  assert.deepEqual(
    {
      cached_input_tokens: model.hours[10].cached_input_tokens,
      uncached_input_tokens: model.hours[10].uncached_input_tokens,
      output_tokens: model.hours[10].output_tokens,
      total_tokens: model.hours[10].total_tokens,
    },
    {
      cached_input_tokens: 64,
      uncached_input_tokens: 13_291,
      output_tokens: 47,
      total_tokens: 13_402,
    },
  );
  assert.deepEqual(envelope.official_snapshot.modelUsage.modelDataList[0], row);
});

test("dated partial-day source buckets take precedence over display padding", () => {
  const usage = { cached_input_tokens: 0, uncached_input_tokens: 100, output_tokens: 2 };
  const options = { model: "GLM-5.3-Flash", hour: 10 };
  const displayRow = modelRow();
  const source = (row, hours) => ({
    xTime: Array.from({ length: hours }, (_, hour) =>
      `2026-11-17 ${String(hour).padStart(2, "0")}:00`),
    modelDataList: [Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, Array.isArray(value) ? value.slice(0, hours) : value]))],
  });
  const before = snapshot(displayRow, undefined, source(displayRow, 11));
  const chargedRow = modelRow({ uncachedInputTokens: 100, outputTokens: 2, uncachedInputCredits: 0.0115, outputCredits: 0.0008 });
  delete chargedRow.totalTokens;
  delete chargedRow.totalCredits;
  const chargedSource = source(chargedRow, 12);
  const after = snapshot(displayRow, undefined, chargedSource);
  assert.equal(before.integrity.status, "COMPLETE");
  assert.equal(after.integrity.status, "COMPLETE");
  assert.equal(after.models[0].total_tokens, 102);
  assert.equal(after.models[0].total_credits, 0.0123);
  assert.equal(after.models[0].hours[10].bucket, "10:00:00");
  assert.equal(after.models[0].hours[12], undefined);
  const result = reconcileBillingSnapshots(before, after, usage, options);
  assert.equal(result.credit_class, "NORMAL");
  assert.equal(result.calculation.actual_credits, 0.0123);

  const legacy = structuredClone(after);
  delete legacy.official_snapshot.modelUsage.costLabBillingSource;
  assert.equal(reconcileBillingSnapshots(before, legacy, usage, options).calculation.actual_credits, null);

  delete chargedSource.modelDataList[0].outputCreditsUsage;
  const incomplete = snapshot(displayRow, undefined, chargedSource);
  assert.equal(incomplete.integrity.status, "PARTIAL");
  assert.equal(incomplete.models[0].total_credits, null);
  assert.equal(reconcileBillingSnapshots(before, incomplete, usage, options).calculation.actual_credits, null);
  const missingBefore = snapshot(displayRow, undefined, source(displayRow, 10));
  assert.equal(reconcileBillingSnapshots(missingBefore, after, usage, options).calculation.actual_credits, null);
});

test("snapshot envelope marks incomplete arrays and missing quota as partial", () => {
  const row = modelRow({ outputTokens: 2 });
  row.cachedInputTokensUsage = [0];
  row.totalCredits = 0.0016;
  row.outputCreditsUsage[10] = 0.0016;
  const envelope = buildSnapshotEnvelope({
    result: {
      snapshot: {
        rangeStartDate: "2026-11-17",
        rangeEndDate: "2026-11-17",
        sourceProvider: {
          id: "account:bigmodel-individual-coding-plan",
          name: "BigModel - Coding Plan",
        },
        modelUsage: {
          xTime: zeroArrays().map((_, hour) => `${String(hour).padStart(2, "0")}:00:00`),
          granularity: "hour",
          modelDataList: [row],
        },
      },
      identity: {},
    },
    providerId: "account:bigmodel-individual-coding-plan",
    query: { range: "today", timeZone: "Asia/Shanghai" },
    capturedAt: "2026-11-17T02:00:00.000Z",
  });
  assert.equal(envelope.integrity.status, "PARTIAL");
  assert.ok(envelope.integrity.missing_fields.includes("quota"));
  assert.ok(
    envelope.integrity.missing_fields.includes(
      "GLM-5.3-Flash.cachedInputTokensUsage",
    ),
  );
});

test("snapshot sanitization redacts credential-shaped fields without hiding identity ids", () => {
  const result = sanitizeOfficialSnapshot({
    identity: {
      apiKeyId: "key-id-is-not-a-secret",
      projectId: "project-id",
    },
    nested: {
      access_token: "secret-token",
      Cookie: "session=secret",
      harmless: "visible",
    },
  });
  assert.deepEqual(result.value, {
    identity: {
      apiKeyId: "key-id-is-not-a-secret",
      projectId: "project-id",
    },
    nested: {
      access_token: "<redacted>",
      Cookie: "<redacted>",
      harmless: "visible",
    },
  });
  assert.deepEqual(result.redactedPaths, [
    "nested.access_token",
    "nested.Cookie",
  ]);
});

test("Shanghai timezone and peak windows use Asia/Shanghai", () => {
  assert.equal(shanghaiHourForTimestamp("2026-11-16T19:00:00.000Z"), 3);
  assert.equal(isOffPeakShanghai(new Date("2026-11-17T05:59:59.999Z")), true);
  assert.equal(isOffPeakShanghai(new Date("2026-11-17T06:00:00.000Z")), false);
  assert.equal(isOffPeakShanghai(new Date("2026-11-17T07:00:00.000Z")), false);
  assert.equal(isOffPeakShanghai(new Date("2026-11-17T09:59:59.999Z")), false);
  assert.equal(isOffPeakShanghai(new Date("2026-11-17T10:00:00.000Z")), true);
  assert.equal(isOffPeakShanghai(new Date("2026-11-17T02:00:00.000Z")), true);
  assert.equal(isOffPeakShanghai(new Date("2026-11-21T07:00:00.000Z")), true);
});

test("credit calculation separates base, time multiplier and 0.67", () => {
  const calculation = calculateCreditBreakdown({
    cachedInputTokens: 64,
    uncachedInputTokens: 13_291,
    outputTokens: 47,
    offPeak: true,
    actualCredits: 1.03786819,
  });
  assert.equal(calculation.base_credits, 3.098114);
  assert.equal(calculation.time_multiplier, 0.5);
  assert.equal(calculation.expected_normal, 1.549057);
  assert.equal(calculation.expected_with_0_67, 1.03786819);
  assert.equal(calculation.effective_extra_ratio, 0.67);
});

test("reconciliation identifies normal and 0.67 credits without inventing request attribution", () => {
  const usage = {
    model: "GLM-5.3-Flash",
    timestamp: "2026-11-17T02:00:00.000Z",
    cached_input_tokens: 64,
    uncached_input_tokens: 13_291,
    output_tokens: 47,
    total_tokens: 13_402,
  };
  const before = snapshot(modelRow({ hour: 10 }));
  const normalAfter = snapshot(
    modelRow({
      cachedInputTokens: 64,
      uncachedInputTokens: 13_291,
      outputTokens: 47,
      cachedInputCredits: 0.001792,
      uncachedInputCredits: 1.528465,
      outputCredits: 0.0188,
    }),
  );

  const normal = reconcileBillingSnapshots(before, normalAfter, usage);
  assert.equal(normal.token_match, true);
  assert.equal(normal.credit_class, "NORMAL");
  assert.equal(normal.calculation.time_multiplier, 0.5);

  const discountedAfter = snapshot(
    modelRow({
      cachedInputTokens: 64,
      uncachedInputTokens: 13_291,
      outputTokens: 47,
      cachedInputCredits: 0.00120064,
      uncachedInputCredits: 1.02407155,
      outputCredits: 0.012596,
    }),
  );
  const discounted = reconcileBillingSnapshots(before, discountedAfter, usage);
  assert.equal(discounted.credit_class, "EXTRA_0_67");
  assert.equal(discounted.billing_reconciliation, "PASS");

  const peakUsage = {
    ...usage,
    timestamp: "2026-11-17T08:30:00.000Z",
  };
  const peakAfter = snapshot(
    modelRow({
      cachedInputTokens: 64,
      uncachedInputTokens: 13_291,
      outputTokens: 47,
      cachedInputCredits: 0.003584,
      uncachedInputCredits: 3.05693,
      outputCredits: 0.0376,
      hour: 16,
    }),
  );
  const peak = reconcileBillingSnapshots(before, peakAfter, peakUsage, { hour: 16 });
  assert.equal(peak.credit_class, "NORMAL");
});

test("reconciliation refuses to assign an aggregate delta to a mismatched request", () => {
  const usage = {
    model: "GLM-5.3-Flash",
    cached_input_tokens: 0,
    uncached_input_tokens: 13_000,
    output_tokens: 47,
    total_tokens: 13_047,
  };
  const before = snapshot(modelRow());
  const after = snapshot(
    modelRow({
      uncachedInputTokens: 13_291,
      outputTokens: 47,
      uncachedInputCredits: 1.549057,
    }),
  );
  const result = reconcileBillingSnapshots(before, after, usage);
  assert.equal(result.token_match, false);
  assert.equal(result.credit_class, "INCONCLUSIVE");
  assert.equal(result.billing_reconciliation, "INCONCLUSIVE");
  assert.equal(result.settlement_status, "UNATTRIBUTED_DELTA");
  assert.equal(result.calculation.actual_credits, null);
  assert.equal(result.calculation.effective_extra_ratio, null);
});

test("reconciliation distinguishes unsettled and explicitly settled zero credits", () => {
  const usage = { cached_input_tokens: 0, uncached_input_tokens: 10, output_tokens: 2 };
  const before = snapshot(modelRow());
  const after = snapshot(modelRow({ uncachedInputTokens: 10, outputTokens: 2 }));
  const options = { model: "GLM-5.3-Flash", hour: 10 };
  const pending = reconcileBillingSnapshots(before, after, usage, options);
  assert.equal(pending.token_match, true);
  assert.equal(pending.settlement_status, "CREDITS_PENDING");
  assert.equal(pending.calculation.actual_credits, null);
  assert.equal(pending.official_delta.total_credits, null);
  after.integrity.settlement_status = "SETTLED";
  const zero = reconcileBillingSnapshots(before, after, usage, options);
  assert.equal(zero.settlement_status, "ZERO_CHARGE_OBSERVED");
  assert.equal(zero.calculation.actual_credits, 0);
  assert.equal(zero.credit_class, "ZERO_CHARGE");
});

test("invalid ledger values and partial usage do not normalize to zero", () => {
  const before = snapshot(modelRow());
  const row = modelRow({ uncachedInputTokens: 10, outputTokens: 2 });
  row.outputCreditsUsage[10] = null;
  row.cachedInputTokensUsage[10] = false;
  const after = snapshot(row);
  assert.equal(after.integrity.status, "PARTIAL");
  assert.equal(after.models[0].hours[10].total_credits, null);
  assert.equal(after.models[0].hours[10].total_tokens, null);
  const usage = { cached_input_tokens: 0, uncached_input_tokens: 10, output_tokens: 2 };
  const options = { model: "GLM-5.3-Flash", hour: 10 };
  const result = reconcileBillingSnapshots(before, after, usage, options);
  assert.equal(result.settlement_status, "INVALID_BILLING_DATA");
  assert.equal(result.calculation.actual_credits, null);
  assert.throws(() => extractRequestUsage({ total_tokens: 12 }), /usage_cached_input_tokens_invalid/u);
  assert.throws(() => extractRequestUsage({ ...usage, total_tokens: 13 }), /usage_total_tokens_inconsistent/u);
  after.identity.project_id = "another-project";
  assert.throws(() => reconcileBillingSnapshots(before, after, usage, options), /billing_identity_changed/u);
});

test("usage parsing rejects records with no token fields", () => {
  assert.throws(
    () =>
      extractRequestUsage({
        model: "GLM-5.3-Flash",
        timestamp: "2026-11-17T10:30:00.000Z",
      }),
    /usage_token_fields_missing/,
  );
});

test("the pre-normalization billing evidence takes precedence over display zero-fill", () => {
  const before = snapshot(modelRow());
  const after = snapshot(modelRow({ uncachedInputTokens: 10, outputTokens: 2 }));
  const display = after.official_snapshot.modelUsage;
  display.costLabBillingSource = {
    xTime: display.xTime,
    modelDataList: [{ ...display.modelDataList[0], cachedInputCreditsUsage: undefined }],
  };
  const result = reconcileBillingSnapshots(before, after, {
    cached_input_tokens: 0, uncached_input_tokens: 10, output_tokens: 2,
  }, { model: "GLM-5.3-Flash", hour: 10 });
  assert.equal(result.settlement_status, "INVALID_BILLING_DATA");
  assert.equal(result.calculation.actual_credits, null);
});

test("reconciliation requires a billing identity and rejects usage from another Shanghai date", () => {
  const before = snapshot(modelRow());
  const after = snapshot(modelRow({ uncachedInputTokens: 10, outputTokens: 2, uncachedInputCredits: 0.0023 }));
  const usage = {
    timestamp: "2026-11-16T02:00:00.000Z", cached_input_tokens: 0, uncached_input_tokens: 10, output_tokens: 2,
  };
  const options = { model: "GLM-5.3-Flash", hour: 10 };
  assert.throws(() => reconcileBillingSnapshots(before, after, usage, options), /billing_usage_window_changed/u);
  before.identity.api_key_id = after.identity.api_key_id = null;
  assert.throws(() => reconcileBillingSnapshots(before, after, usage, options), /billing_identity_missing/u);
});

test("reconciliation rejects before and after snapshots from different ranges", () => {
  const usage = {
    model: "GLM-5.3-Flash",
    cached_input_tokens: 0,
    uncached_input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
  };
  const before = snapshot(modelRow());
  const after = snapshot(modelRow({ uncachedInputTokens: 1, outputTokens: 1 }));
  after.range.start_date = "2026-11-18";
  after.range.end_date = "2026-11-18";
  assert.throws(
    () => reconcileBillingSnapshots(before, after, usage),
    /billing_range_changed/,
  );
});

test("atomic JSON writes stay complete and output is valid JSON", async () => {
  const runRoot = path.join(PROJECT_ROOT, ".run");
  await mkdir(runRoot, { recursive: true });
  const directory = await mkdtemp(path.join(runRoot, "cost-lab-billing-test-"));
  assert.ok(path.resolve(directory).startsWith(`${path.resolve(runRoot)}${path.sep}`));
  try {
    const output = path.join(directory, "snapshot.json");
    await atomicWriteJson(output, { ok: true, value: 1 });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      ok: true,
      value: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe errors redact credential-shaped values", () => {
  assert.equal(
    sanitizeErrorMessage(new Error("Authorization: Bearer secret-value")),
    "Authorization=<redacted>",
  );
  assert.deepEqual(safeError(new Error("access_token=abc123")), {
    ok: false,
    error: {
      code: "cost_lab_billing_error",
      message: "access_token=<redacted>",
    },
  });
});

test("official API guard permits reads and short-lived token issuance only", async () => {
  const runtime = await import(pathToFileURL(RUNTIME_PATH).href);
  assert.equal(typeof runtime.createCostLabReadOnlyApiClient, "function");
  assert.equal(typeof runtime.createCostLabReadOnlyLocationStore, "function");
  const calls = [];
  const guarded = runtime.createCostLabReadOnlyApiClient({
    async request(input, init) {
      calls.push({
        input: String(input),
        method: init?.method ?? "GET",
        redirect: init?.redirect ?? null,
      });
      return new Response("{}", { status: 200 });
    },
  });

  await guarded.request("https://zcode.z.ai/api/monitor/usage");
  await guarded.request(
    "https://bigmodel.cn/api/biz/v1/organization/org/projects/project/api_keys/key/access_tokens",
    { method: "POST" },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[1].redirect, "error");

  await assert.rejects(
    guarded.request("https://example.invalid/api/monitor/usage"),
    /cost_lab_read_only_api_blocked_origin/,
  );
  await assert.rejects(
    guarded.request("http://zcode.z.ai/api/monitor/usage"),
    /cost_lab_read_only_api_blocked_origin/,
  );
  await assert.rejects(
    guarded.request("https://zcode.z.ai.evil.invalid/api/monitor/usage"),
    /cost_lab_read_only_api_blocked_origin/,
  );

  await assert.rejects(
    guarded.request(
      "https://bigmodel.cn/api/biz/v1/organization/org/projects/project/api_keys",
      { method: "POST" },
    ),
    /cost_lab_read_only_api_blocked_write/,
  );
  await assert.rejects(
    guarded.request(
      "https://bigmodel.cn/api/biz/v1/organization/org/projects/project/api_keys/key",
      { method: "DELETE" },
    ),
    /cost_lab_read_only_api_blocked_write/,
  );
  assert.equal(calls.length, 2);

  const locationCalls = [];
  const locationStore = runtime.createCostLabReadOnlyLocationStore({
    async load(key) {
      locationCalls.push(["load", key]);
      return "cached-location";
    },
    async save(key) {
      locationCalls.push(["save", key]);
    },
    async delete(key) {
      locationCalls.push(["delete", key]);
    },
    async recoverUnreadable(key) {
      locationCalls.push(["recover", key]);
      return "recovered";
    },
  });
  assert.equal(await locationStore.load("location-key"), "cached-location");
  await assert.rejects(
    locationStore.save("location-key", "new-location"),
    /cost_lab_read_only_location_store_blocked_write/,
  );
  await assert.rejects(
    locationStore.delete("location-key"),
    /cost_lab_read_only_location_store_blocked_write/,
  );
  await assert.rejects(
    locationStore.recoverUnreadable("location-key", () => undefined),
    /cost_lab_read_only_location_store_blocked_write/,
  );
  assert.deepEqual(locationCalls, [["load", "location-key"]]);
});

test("capture timeout aborts the official runtime request", async () => {
  let aborted = false;
  const fakeRuntime = {
    createCostLabBillingRuntime({ signal }) {
      return {
        getCodingPlanUsageSnapshot() {
          return new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      };
    },
  };
  await assert.rejects(
    captureSnapshot(
      {
        provider: "account:bigmodel-individual-coding-plan",
        range: "today",
        start: null,
        end: null,
        timeZone: "Asia/Shanghai",
        dataRoot: "D:\\Program Files",
        model: null,
        timeoutMs: 20,
      },
      {
        runtimeModule: fakeRuntime,
        now: () => new Date("2026-11-17T02:00:00.000Z"),
        dataDirectoryExists: async () => true,
      },
    ),
    /official_billing_read_timeout/,
  );
  assert.equal(aborted, true);
});
