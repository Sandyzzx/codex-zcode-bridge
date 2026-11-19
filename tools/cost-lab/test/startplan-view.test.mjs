import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStartPlanView,
  compareStartPlanViews,
  startPlanFreshness,
} from "../web/startplan-view.mjs";

function snapshot(overrides = {}) {
  return {
    captured_at: "2026-11-19T00:58:15.267Z",
    server_time: "2026-11-19T00:58:10.000Z",
    account: { key: "sha256:account" },
    plan_id: "zcode-v3-start-plan-1118",
    plan_type: "ZCODE GLOBAL BUILD",
    plan_status: "active",
    official_entitlement: { status: "entitled" },
    unit_type: "token",
    total_balance: 300_000_000,
    used_balance: 102_684,
    remaining_balance: 299_897_316,
    billing_period: {
      start: "2026-11-18T14:14:19.000Z",
      end: "2026-11-19T01:00:00.000Z",
    },
    expiry: "2026-11-19T01:00:00.000Z",
    missing_fields: [],
    buckets: [{
      bucket_key: "sha256:bucket",
      entitlement_key: "sha256:entitlement",
      plan_id: "zcode-v3-start-plan-1118",
      show_name: "GLM-5.3-Flash",
      unit_type: "token",
      model_ids: ["glm-5.3-flash"],
      total_units: 300_000_000,
      used_units: 102_684,
      remaining_units: 299_897_316,
      period_start: "2026-11-18T14:14:19.000Z",
      period_end: "2026-11-19T01:00:00.000Z",
      expires_at: "2026-11-19T01:00:00.000Z",
    }],
    ...overrides,
  };
}

function latest(snapshotValue) {
  return {
    available: Boolean(snapshotValue),
    state: snapshotValue ? "AVAILABLE" : "NO_SNAPSHOT",
    snapshot: snapshotValue
      ? {
          id: "snapshot-one",
          captured_at: snapshotValue.captured_at,
          total_balance: snapshotValue.total_balance,
          remaining_balance: snapshotValue.remaining_balance,
          freshness: startPlanFreshness(snapshotValue, Date.parse("2026-11-19T00:59:00.000Z")),
          snapshot: snapshotValue,
        }
      : null,
  };
}

test("empty Start Plan view renders an explicit no-snapshot state with unknown values", () => {
  const view = buildStartPlanView(latest(null), Date.parse("2026-11-19T00:59:00.000Z"));
  assert.equal(view.available, false);
  assert.equal(view.status, "NO_SNAPSHOT");
  assert.equal(view.freshness.status, "UNKNOWN");
  assert.equal(view.progress.total, null);
  assert.equal(view.progress.used, null);
  assert.deepEqual(view.buckets, []);
});

test("fresh and expired views preserve plan values while changing only freshness", () => {
  const data = latest(snapshot());
  const fresh = buildStartPlanView(data, Date.parse("2026-11-19T00:59:00.000Z"));
  assert.equal(fresh.freshness.status, "FRESH");
  assert.equal(fresh.summary.total_balance, 300_000_000);
  assert.equal(fresh.summary.remaining_balance, 299_897_316);
  assert.equal(fresh.progress.percent > 0 && fresh.progress.percent < 1, true);

  const expired = buildStartPlanView(data, Date.parse("2026-11-19T02:00:00.000Z"));
  assert.equal(expired.freshness.status, "EXPIRED");
  assert.equal(expired.summary.plan_status, "active");
  assert.equal(expired.summary.remaining_balance, 299_897_316);
});

test("unknown values remain unknown rather than becoming zero", () => {
  const value = snapshot({
    total_balance: null,
    used_balance: null,
    remaining_balance: null,
    missing_fields: ["total_balance", "used_balance", "remaining_balance"],
  });
  const view = buildStartPlanView(latest(value), Date.parse("2026-11-19T00:59:00.000Z"));
  assert.equal(view.progress.percent, null);
  assert.equal(view.progress.total, null);
  assert.equal(view.summary.total_balance, null);
  assert.ok(view.summary.missing_fields.includes("remaining_balance"));
});

test("multiple bucket units are displayed independently with no invented aggregate", () => {
  const value = snapshot({
    total_balance: null,
    used_balance: null,
    remaining_balance: null,
    missing_fields: ["unambiguous_unit_type"],
    buckets: [
      ...snapshot().buckets,
      {
        ...snapshot().buckets[0],
        bucket_key: "sha256:credit-bucket",
        entitlement_key: "sha256:credit-entitlement",
        unit_type: "credit",
        total_units: 100,
        used_units: 5,
        remaining_units: 95,
      },
    ],
  });
  const view = buildStartPlanView(latest(value), Date.parse("2026-11-19T00:59:00.000Z"));
  assert.equal(view.buckets.length, 2);
  assert.deepEqual(view.buckets.map((bucket) => bucket.unit_type), ["token", "credit"]);
  assert.equal(view.summary.total_balance, null);
});

test("comparison shows positive usage delta and a negative remaining delta", () => {
  const previous = snapshot();
  const current = snapshot({
    captured_at: "2026-11-19T00:59:15.000Z",
    used_balance: 103_000,
    remaining_balance: 299_897_000,
    buckets: [{
      ...snapshot().buckets[0],
      used_units: 103_000,
      remaining_units: 299_897_000,
    }],
  });
  const comparison = compareStartPlanViews(previous, current);
  assert.equal(comparison.status, "COMPARABLE");
  assert.equal(comparison.rows[0].used_delta, 316);
  assert.equal(comparison.rows[0].remaining_delta, -316);
  assert.equal(comparison.aggregate.used_delta, 316);
});

test("rollover and account changes are not rendered as negative consumption", () => {
  const previous = snapshot();
  const rollover = snapshot({
    captured_at: "2026-11-19T01:05:00.000Z",
    buckets: [{
      ...snapshot().buckets[0],
      period_start: "2026-11-19T01:00:01.000Z",
      period_end: "2026-11-20T01:00:00.000Z",
      expires_at: "2026-11-20T01:00:00.000Z",
    }],
  });
  const currentPeriod = compareStartPlanViews(previous, rollover);
  assert.equal(currentPeriod.status, "NEW_PERIOD");
  assert.equal(currentPeriod.rows[0].status, "ROLLED_OVER");
  assert.equal(currentPeriod.rows[0].used_delta, null);

  const otherAccount = snapshot({ account: { key: "sha256:other-account" } });
  const notComparable = compareStartPlanViews(previous, otherAccount);
  assert.equal(notComparable.status, "NOT_COMPARABLE");
  assert.deepEqual(notComparable.rows, []);
});
