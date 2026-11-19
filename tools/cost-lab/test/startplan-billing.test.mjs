import assert from "node:assert/strict";
import test from "node:test";

import {
  annotateStartPlanFreshness,
  compareStartPlanSnapshots,
  normalizeStartPlanSnapshot,
  sanitizeOfficialStartPlanPayload,
} from "../startplan-billing.mjs";

const CAPTURED_AT = "2026-11-19T00:58:15.267Z";

function officialPayload(overrides = {}) {
  return {
    code: 0,
    data: {
      server_time: Date.parse("2026-11-19T00:58:10.000Z") / 1_000,
      plans: [{
        user_plan_id: "private-user-plan",
        plan_id: "zcode-v3-start-plan-1118",
        name: "ZCODE GLOBAL BUILD",
        status: "active",
      }],
      balances: [{
        bucket_id: "private-bucket",
        user_plan_id: "private-user-plan",
        plan_id: "zcode-v3-start-plan-1118",
        entitlement_id: "private-entitlement",
        show_name: "GLM-5.3-Flash",
        model: "GLM-5.3-Flash",
        meter: "model_usage",
        unit_type: "token",
        capabilities: ["model:glm-5.3-flash"],
        total_units: 300_000_000,
        used_units: 102_684,
        remaining_units: 299_897_316,
        available_units: 299_897_316,
        period_start: Date.parse("2026-11-18T14:14:19.000Z") / 1_000,
        period_end: Date.parse("2026-11-19T01:00:00.000Z") / 1_000,
        expires_at: Date.parse("2026-11-19T01:00:00.000Z") / 1_000,
      }],
      ...overrides.data,
    },
  };
}

function normalize(raw = officialPayload(), options = {}) {
  return normalizeStartPlanSnapshot(raw, {
    capturedAt: CAPTURED_AT,
    accountIdentity: "private-account",
    source: "official_billing_balance",
    officialEntitlement: {
      status: "entitled",
      observedAt: Date.parse(CAPTURED_AT),
      requestId: "private-request",
    },
    requestMetadata: {
      http_status: 200,
      response_bytes: 900,
    },
    ...options,
  });
}

test("normalizes Start Plan plans, token buckets, totals, and period without mixing units", () => {
  const snapshot = normalize();
  assert.equal(snapshot.plan_id, "zcode-v3-start-plan-1118");
  assert.equal(snapshot.plan_type, "ZCODE GLOBAL BUILD");
  assert.equal(snapshot.plan_status, "active");
  assert.equal(snapshot.unit_type, "token");
  assert.equal(snapshot.total_balance, 300_000_000);
  assert.equal(snapshot.used_balance, 102_684);
  assert.equal(snapshot.remaining_balance, 299_897_316);
  assert.equal(snapshot.buckets[0].bucket_key.startsWith("sha256:"), true);
  assert.equal(snapshot.buckets[0].entitlement_key.startsWith("sha256:"), true);
  assert.deepEqual(snapshot.available_models, ["glm-5.3-flash"]);
  assert.equal(snapshot.integrity.status, "PASS");
  assert.equal(snapshot.process.model_requests_triggered, 0);
});

test("sanitization removes credentials and hashes stable opaque identifiers", () => {
  const sanitized = sanitizeOfficialStartPlanPayload({
    data: {
      plans: [{ user_plan_id: "private-user-plan" }],
      balances: [{
        bucket_id: "private-bucket",
        entitlement_id: "private-entitlement",
      }],
      authorization: "Bearer private-secret",
      nested: {
        device_mid: "private-device-mid",
        note: "visible",
      },
    },
  });
  assert.match(sanitized.data.plans[0].user_plan_id, /^sha256:[a-f0-9]{16}$/u);
  assert.match(sanitized.data.balances[0].bucket_id, /^sha256:[a-f0-9]{16}$/u);
  assert.equal(sanitized.data.authorization, "[REDACTED]");
  assert.equal(sanitized.data.nested.device_mid, "[REDACTED]");
  assert.equal(sanitized.data.nested.note, "visible");
  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /private-(?:user-plan|bucket|entitlement|secret|device-mid)/u,
  );
});

test("missing official values stay null and are never normalized to zero", () => {
  const payload = officialPayload();
  delete payload.data.balances[0].remaining_units;
  delete payload.data.balances[0].used_units;
  const snapshot = normalize(payload);
  assert.equal(snapshot.buckets[0].remaining_units, null);
  assert.equal(snapshot.buckets[0].used_units, null);
  assert.equal(snapshot.remaining_balance, null);
  assert.equal(snapshot.used_balance, null);
  assert.ok(snapshot.missing_fields.includes("remaining_balance"));
  assert.ok(snapshot.missing_fields.includes("used_balance"));
});

test("mixed units produce per-bucket data but no invented aggregate balance", () => {
  const payload = officialPayload();
  payload.data.balances.push({
    ...payload.data.balances[0],
    bucket_id: "private-credit-bucket",
    entitlement_id: "private-credit-entitlement",
    unit_type: "credit",
    total_units: 100,
    used_units: 5,
    remaining_units: 95,
  });
  const snapshot = normalize(payload);
  assert.equal(snapshot.buckets.length, 2);
  assert.equal(snapshot.total_balance, null);
  assert.equal(snapshot.used_balance, null);
  assert.equal(snapshot.remaining_balance, null);
  assert.ok(snapshot.missing_fields.includes("unambiguous_unit_type"));
});

test("freshness distinguishes fresh, stale, missing, and expired snapshots", () => {
  const snapshot = normalize();
  assert.equal(
    annotateStartPlanFreshness(snapshot, Date.parse("2026-11-19T00:59:00.000Z")).status,
    "FRESH",
  );
  assert.equal(
    annotateStartPlanFreshness(snapshot, Date.parse("2026-11-19T01:10:00.000Z")).status,
    "EXPIRED",
  );
  assert.equal(annotateStartPlanFreshness({}, Date.now()).status, "UNKNOWN");
  snapshot.expiry = "2026-11-20T00:00:00.000Z";
  snapshot.billing_period = { start: CAPTURED_AT, end: "2026-11-20T00:00:00.000Z" };
  assert.equal(
    annotateStartPlanFreshness(snapshot, Date.parse("2026-11-19T02:00:00.000Z")).status,
    "STALE",
  );
});

test("snapshot comparison requires matching account, bucket, entitlement, unit, and period", () => {
  const previous = normalize();
  const payload = officialPayload();
  payload.data.server_time = Date.parse("2026-11-19T00:59:10.000Z") / 1_000;
  payload.data.balances[0].used_units = 103_000;
  payload.data.balances[0].remaining_units = 299_897_000;
  const current = normalize(payload, { capturedAt: "2026-11-19T00:59:15.000Z" });
  const comparison = compareStartPlanSnapshots(previous, current);
  assert.equal(comparison.status, "COMPARABLE");
  assert.equal(comparison.aggregate.used_delta, 316);
  assert.equal(comparison.aggregate.remaining_delta, -316);

  const nextPeriodPayload = officialPayload();
  nextPeriodPayload.data.server_time = Date.parse("2026-11-19T01:05:00.000Z") / 1_000;
  nextPeriodPayload.data.balances[0].period_start =
    Date.parse("2026-11-19T01:00:01.000Z") / 1_000;
  nextPeriodPayload.data.balances[0].period_end =
    Date.parse("2026-11-20T01:00:00.000Z") / 1_000;
  nextPeriodPayload.data.balances[0].expires_at =
    Date.parse("2026-11-20T01:00:00.000Z") / 1_000;
  const nextPeriod = normalize(nextPeriodPayload, {
    capturedAt: "2026-11-19T01:05:01.000Z",
  });
  const rollover = compareStartPlanSnapshots(current, nextPeriod);
  assert.equal(rollover.status, "NEW_PERIOD");
  assert.equal(rollover.buckets[0].status, "ROLLED_OVER");
  assert.equal(rollover.buckets[0].used_delta, null);
});

test("account mismatch and unit changes are explicitly non-comparable", () => {
  const previous = normalize();
  const accountChanged = normalize(officialPayload(), {
    accountIdentity: "different-account",
  });
  assert.equal(compareStartPlanSnapshots(previous, accountChanged).status, "NOT_COMPARABLE");

  const unitChangedPayload = officialPayload();
  unitChangedPayload.data.balances[0].unit_type = "credit";
  const unitChanged = normalize(unitChangedPayload);
  const comparison = compareStartPlanSnapshots(previous, unitChanged);
  assert.equal(comparison.status, "PARTIAL");
  assert.equal(comparison.buckets[0].status, "UNIT_CHANGED");
  assert.equal(comparison.aggregate, null);
});
