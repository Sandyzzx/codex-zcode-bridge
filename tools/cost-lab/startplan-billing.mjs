import { createHash } from "node:crypto";

export const START_PLAN_PROVIDER_ID = "account:bigmodel-start-plan";
export const START_PLAN_BILLING_ORIGIN = "https://zcode.z.ai";
export const START_PLAN_BILLING_PATH = "/api/v1/zcode-plan/billing/balance";
export const STARTPLAN_HISTORY_SCHEMA_VERSION = 1;

const FRESHNESS_WINDOW_MS = 5 * 60 * 1_000;
const SENSITIVE_KEY =
  /(authorization|cookie|credential|device.?mid|jwt|password|refresh.?token|secret|api.?key|access.?token)/iu;
const OPAQUE_KEY =
  /(account.?id|bucket.?id|customer.?id|entitlement.?id|request.?id|log.?id|user.?id|user.?plan.?id)/iu;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function boundedText(value, maximum = 256) {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function finiteInteger(value) {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function timestampToIso(value) {
  if (value === null || value === undefined || value === "") return null;
  let milliseconds;
  if (typeof value === "number") {
    milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim())) {
    const numeric = Number(value);
    milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  } else {
    milliseconds = Date.parse(String(value));
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function hashStartPlanOpaque(prefix, value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value);
  if (/^sha256:[a-f0-9]{16}$/u.test(normalized)) return normalized;
  return `sha256:${shortHash(`${prefix}:${normalized}`)}`;
}

function looksSecret(value) {
  return /^(?:bearer\s+|basic\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/iu.test(value)
    || /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}\b/iu.test(value)
    || /\bsk-[A-Za-z0-9_-]{16,}\b/u.test(value);
}

function opaquePrefix(key) {
  const normalized = key.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
  if (normalized.includes("user_plan")) return "startplan-user-plan";
  if (normalized.includes("bucket")) return "startplan-bucket";
  if (normalized.includes("entitlement")) return "startplan-entitlement";
  if (normalized.includes("request") || normalized.includes("logid") || normalized.includes("log_id")) {
    return "official-request";
  }
  if (normalized.includes("account") || normalized.includes("customer") || normalized.includes("user")) {
    return "official-account";
  }
  return "official-opaque";
}

function sanitizeValue(value, depth = 0) {
  if (depth > 20 || value === undefined) return "[UNKNOWN]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return looksSecret(value) ? "[REDACTED]" : value.slice(0, 2_048);
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => sanitizeValue(item, depth + 1));
  const input = record(value);
  if (!input) return "[UNKNOWN]";
  const output = {};
  for (const [key, item] of Object.entries(input).slice(0, 1_000)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[REDACTED]";
    } else if (OPAQUE_KEY.test(key) && (typeof item === "string" || typeof item === "number")) {
      output[key] = hashStartPlanOpaque(opaquePrefix(key), item);
    } else {
      output[key] = sanitizeValue(item, depth + 1);
    }
  }
  return output;
}

export function sanitizeOfficialStartPlanPayload(raw) {
  return sanitizeValue(raw);
}

function extractBillingData(raw) {
  const root = record(raw);
  if (!root) return null;
  if (record(root.data) && (Array.isArray(root.data.plans) || Array.isArray(root.data.balances))) {
    return root.data;
  }
  const payload = record(root.payload);
  if (record(payload?.data) && (Array.isArray(payload.data.plans) || Array.isArray(payload.data.balances))) {
    return payload.data;
  }
  if (Array.isArray(root.plans) || Array.isArray(root.balances)) return root;
  return null;
}

function safeCapabilities(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
      .map((item) => boundedText(item, 128))
      .filter(Boolean)
      .sort()
    : [];
}

function modelIdsFromCapabilities(capabilities, showName) {
  const models = capabilities
    .map((capability) => capability.toLowerCase().startsWith("model:")
      ? capability.slice("model:".length).trim()
      : "")
    .filter(Boolean);
  return [...new Set(models.length > 0
    ? models
    : showName
      ? [showName.toLowerCase()]
      : [])].sort();
}

function uniqueNullable(values) {
  if (values.length === 0 || values.some((value) => value === null || value === undefined)) return null;
  return new Set(values.map(stableStringify)).size === 1 ? values[0] : null;
}

function summedInteger(buckets, key) {
  const values = buckets.map((bucket) => bucket[key]);
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function buildSummary(snapshot) {
  const { buckets, plans } = snapshot;
  const units = [...new Set(buckets.map((bucket) => bucket.unit_type).filter(Boolean))];
  const planIds = [...new Set(buckets.map((bucket) => bucket.plan_id).filter(Boolean))];
  const planNames = [...new Set(plans.map((plan) => plan.name).filter(Boolean))];
  const planStatuses = [...new Set(plans.map((plan) => plan.status).filter(Boolean))];
  const periods = uniqueNullable(buckets.map((bucket) => (
    bucket.period_start && bucket.period_end
      ? { start: bucket.period_start, end: bucket.period_end }
      : null
  )));
  const expiry = uniqueNullable(buckets.map((bucket) => bucket.expires_at));
  const aggregateUnits = units.length === 1 ? units[0] : null;
  const summary = {
    plan_id: planIds.length === 1 ? planIds[0] : null,
    plan_type: planNames.length === 1 ? planNames[0] : null,
    plan_status: planStatuses.length === 1 ? planStatuses[0] : null,
    unit_type: aggregateUnits,
    total_balance: aggregateUnits ? summedInteger(buckets, "total_units") : null,
    used_balance: aggregateUnits ? summedInteger(buckets, "used_units") : null,
    remaining_balance: aggregateUnits ? summedInteger(buckets, "remaining_units") : null,
    billing_period: aggregateUnits ? periods : null,
    expiry: aggregateUnits ? expiry : null,
  };
  const missing = Object.entries(summary)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  if (buckets.length > 1) missing.push("single_bucket");
  if (units.length > 1) missing.push("unambiguous_unit_type");
  return { ...summary, missing_fields: [...new Set(missing)] };
}

function normalizedIntegrity(raw, first, second) {
  const rawData = extractBillingData(raw);
  const rawBuckets = Array.isArray(rawData?.balances) ? rawData.balances : [];
  const rawPlans = Array.isArray(rawData?.plans) ? rawData.plans : [];
  const mismatches = [];
  if (rawBuckets.length !== first.buckets.length || first.buckets.length !== second.buckets.length) {
    mismatches.push("bucket_count");
  }
  if (rawPlans.length !== first.plans.length || first.plans.length !== second.plans.length) {
    mismatches.push("plan_count");
  }
  for (let index = 0; index < Math.min(rawBuckets.length, first.buckets.length, second.buckets.length); index += 1) {
    for (const key of [
      "bucket_key",
      "user_plan_key",
      "entitlement_key",
      "total_units",
      "used_units",
      "remaining_units",
      "available_units",
    ]) {
      if (first.buckets[index][key] !== second.buckets[index][key]) {
        mismatches.push(`bucket_${index}_${key}`);
      }
    }
  }
  return {
    status: mismatches.length === 0 ? "PASS" : "FAIL",
    checks: {
      response_shape_recognized: Boolean(rawData),
      raw_bucket_count: rawBuckets.length,
      normalized_bucket_count: first.buckets.length,
      reparsed_bucket_count: second.buckets.length,
      raw_plan_count: rawPlans.length,
      normalized_plan_count: first.plans.length,
      reparsed_plan_count: second.plans.length,
      numeric_fields_match_reparse: mismatches.length === 0,
    },
    mismatches,
  };
}

function normalizeEntitlement(value) {
  const input = record(value);
  if (!input) return null;
  return {
    status: boundedText(input.status, 64),
    reason: boundedText(input.reason, 200),
    provider_code: boundedText(input.providerCode, 64),
    observed_at: timestampToIso(input.observedAt),
    request_id_hash: typeof input.requestId === "string" && input.requestId
      ? hashStartPlanOpaque("official-request", input.requestId)
      : null,
    failure_facts: record(input.failureFacts) ?? null,
  };
}

export function parseStartPlanSnapshot(raw, options = {}) {
  const data = extractBillingData(raw);
  if (!data) throw new Error("start_plan_balance_data_required");
  const serverTime = timestampToIso(data.server_time ?? data.serverTime);
  const capturedAt = timestampToIso(options.capturedAt ?? raw?.captured_at ?? raw?.capturedAt) ?? serverTime;
  const plans = (Array.isArray(data.plans) ? data.plans : []).map((value) => {
    const plan = record(value);
    if (!plan) return null;
    return {
      plan_id: boundedText(plan.plan_id ?? plan.planId, 128),
      user_plan_key: hashStartPlanOpaque(
        "startplan-user-plan",
        plan.user_plan_id ?? plan.userPlanId,
      ),
      name: boundedText(plan.name, 128),
      status: boundedText(plan.status, 64),
      starts_at: timestampToIso(plan.starts_at ?? plan.startsAt),
      ends_at: timestampToIso(plan.ends_at ?? plan.endsAt),
      entitlements: (Array.isArray(plan.entitlements) ? plan.entitlements : []).map((entryValue) => {
        const entry = record(entryValue);
        if (!entry) return null;
        return {
          entitlement_key: hashStartPlanOpaque(
            "startplan-entitlement",
            entry.entitlement_id ?? entry.entitlementId,
          ),
          show_name: boundedText(entry.show_name ?? entry.showName, 128),
          meter: boundedText(entry.meter, 64),
          unit_type: boundedText(entry.unit_type ?? entry.unitType, 64),
          period: boundedText(entry.period, 64),
          grant_units: finiteInteger(entry.grant_units ?? entry.grantUnits),
          effective_at: timestampToIso(entry.effective_at ?? entry.effectiveAt),
        };
      }).filter(Boolean),
    };
  }).filter(Boolean);
  const buckets = (Array.isArray(data.balances) ? data.balances : []).map((value) => {
    const bucket = record(value);
    if (!bucket) return null;
    const capabilities = safeCapabilities(bucket.capabilities);
    const showName = boundedText(bucket.show_name ?? bucket.showName, 128);
    return {
      bucket_key: hashStartPlanOpaque("startplan-bucket", bucket.bucket_id ?? bucket.bucketId),
      user_plan_key: hashStartPlanOpaque(
        "startplan-user-plan",
        bucket.user_plan_id ?? bucket.userPlanId,
      ),
      plan_id: boundedText(bucket.plan_id ?? bucket.planId, 128),
      entitlement_key: hashStartPlanOpaque(
        "startplan-entitlement",
        bucket.entitlement_id ?? bucket.entitlementId,
      ),
      show_name: showName,
      model_ids: modelIdsFromCapabilities(capabilities, showName),
      meter: boundedText(bucket.meter, 64),
      unit_type: boundedText(bucket.unit_type ?? bucket.unitType, 64),
      capabilities,
      total_units: finiteInteger(bucket.total_units ?? bucket.totalUnits),
      used_units: finiteInteger(bucket.used_units ?? bucket.usedUnits),
      reserved_units: finiteInteger(bucket.reserved_units ?? bucket.reservedUnits),
      remaining_units: finiteInteger(bucket.remaining_units ?? bucket.remainingUnits),
      available_units: finiteInteger(bucket.available_units ?? bucket.availableUnits),
      period_start: timestampToIso(bucket.period_start ?? bucket.periodStart),
      period_end: timestampToIso(bucket.period_end ?? bucket.periodEnd),
      expires_at: timestampToIso(bucket.expires_at ?? bucket.expiresAt),
      plan_priority: finiteInteger(bucket.plan_priority ?? bucket.planPriority),
      entitlement_priority: finiteInteger(
        bucket.entitlement_priority ?? bucket.entitlementPriority,
      ),
    };
  }).filter(Boolean);
  return {
    schema_version: 1,
    kind: "start_plan_billing_snapshot",
    source: boundedText(options.source, 128) ?? "official_billing_balance",
    captured_at: capturedAt,
    server_time: serverTime,
    provider_scope: START_PLAN_PROVIDER_ID,
    plans,
    buckets,
    available_models: [...new Set(buckets.flatMap((bucket) => bucket.model_ids))].sort(),
    precision: {
      unit: "token_units",
      request_level_deductions: false,
      note: "Start Plan balance is token units and is not a Coding Plan credit ledger.",
    },
  };
}

export function normalizeStartPlanSnapshot(raw, options = {}) {
  const first = parseStartPlanSnapshot(raw, options);
  const sanitized = sanitizeOfficialStartPlanPayload(raw);
  const second = parseStartPlanSnapshot(sanitized, {
    capturedAt: first.captured_at,
    source: "sanitized_reparse",
  });
  const summary = buildSummary(first);
  const integrity = normalizedIntegrity(raw, first, second);
  return {
    ...first,
    account: {
      key: options.accountIdentity
        ? hashStartPlanOpaque("official-account", options.accountIdentity)
        : null,
      provider_scope: START_PLAN_PROVIDER_ID,
      scope: "personal",
    },
    ...summary,
    official_entitlement: normalizeEntitlement(options.officialEntitlement),
    integrity: {
      ...integrity,
      raw_sanitized_reparse_match: integrity.status === "PASS",
      http_status: finiteInteger(options.requestMetadata?.http_status),
      response_bytes: finiteInteger(options.requestMetadata?.response_bytes),
    },
    request: options.requestMetadata ?? null,
    process: {
      model_requests_triggered: 0,
    },
  };
}

export function annotateStartPlanFreshness(snapshot, now = Date.now()) {
  if (!record(snapshot)) {
    return {
      status: "UNKNOWN",
      reason: "snapshot_unavailable",
      evaluated_at_ms: now,
    };
  }
  const capturedMs = Date.parse(snapshot.captured_at ?? "");
  const serverMs = Date.parse(snapshot.server_time ?? "");
  const referenceMs = Number.isFinite(serverMs) ? serverMs : capturedMs;
  const expiryMs = Math.min(
    ...[snapshot.expiry, snapshot.billing_period?.end, snapshot.period_end]
      .map((value) => Date.parse(value ?? ""))
      .filter(Number.isFinite),
  );
  const ageMs = Number.isFinite(referenceMs) ? now - referenceMs : null;
  let status = "UNKNOWN";
  let reason = "capture_time_unavailable";
  if (Number.isFinite(expiryMs) && expiryMs <= now) {
    status = "EXPIRED";
    reason = "official_period_ended";
  } else if (ageMs !== null && ageMs < -FRESHNESS_WINDOW_MS) {
    status = "UNKNOWN";
    reason = "server_time_in_future";
  } else if (ageMs !== null) {
    status = Math.abs(ageMs) <= FRESHNESS_WINDOW_MS ? "FRESH" : "STALE";
    reason = status === "FRESH" ? "recent_official_capture" : "capture_older_than_window";
  }
  return {
    status,
    reason,
    evaluated_at: new Date(now).toISOString(),
    captured_at: snapshot.captured_at ?? null,
    server_time: snapshot.server_time ?? null,
    age_ms: ageMs,
    expiry: Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null,
    maximum_fresh_age_ms: FRESHNESS_WINDOW_MS,
  };
}

function bucketIdentity(bucket) {
  return [
    bucket.bucket_key,
    bucket.entitlement_key,
    bucket.plan_id,
    bucket.unit_type,
  ].map((value) => value ?? "null").join("|");
}

function delta(current, previous) {
  return Number.isSafeInteger(current) && Number.isSafeInteger(previous)
    ? current - previous
    : null;
}

export function compareStartPlanSnapshots(previous, current) {
  if (!previous || !current) {
    return {
      status: previous === current ? "NO_BASELINE" : "PARTIAL",
      reason: "two_snapshots_required",
      buckets: [],
      aggregate: null,
    };
  }
  if (previous.account?.key !== current.account?.key) {
    return {
      status: "NOT_COMPARABLE",
      reason: "account_changed",
      buckets: [],
      aggregate: null,
    };
  }
  const previousBuckets = Array.isArray(previous.buckets) ? previous.buckets : [];
  const currentBuckets = Array.isArray(current.buckets) ? current.buckets : [];
  const comparisons = currentBuckets.map((bucket) => {
    const sameLogicalBucket = previousBuckets.filter((candidate) => (
      candidate.bucket_key === bucket.bucket_key
      && candidate.entitlement_key === bucket.entitlement_key
      && candidate.plan_id === bucket.plan_id
    ));
    const exact = sameLogicalBucket.find((candidate) => (
      candidate.unit_type === bucket.unit_type
      && candidate.period_start === bucket.period_start
      && candidate.period_end === bucket.period_end
    ));
    if (exact) {
      return {
        bucket_key: bucket.bucket_key,
        entitlement_key: bucket.entitlement_key,
        unit_type: bucket.unit_type,
        period_start: bucket.period_start,
        period_end: bucket.period_end,
        status: "COMPARABLE",
        used_delta: delta(bucket.used_units, exact.used_units),
        remaining_delta: delta(bucket.remaining_units, exact.remaining_units),
        total_delta: delta(bucket.total_units, exact.total_units),
      };
    }
    if (sameLogicalBucket.some((candidate) => candidate.unit_type !== bucket.unit_type)) {
      return {
        bucket_key: bucket.bucket_key,
        entitlement_key: bucket.entitlement_key,
        unit_type: bucket.unit_type,
        status: "UNIT_CHANGED",
        used_delta: null,
        remaining_delta: null,
        total_delta: null,
      };
    }
    if (sameLogicalBucket.length > 0) {
      return {
        bucket_key: bucket.bucket_key,
        entitlement_key: bucket.entitlement_key,
        unit_type: bucket.unit_type,
        period_start: bucket.period_start,
        period_end: bucket.period_end,
        status: bucket.period_start && bucket.period_start === current.period_start
          ? "NEW_BUCKET"
          : "ROLLED_OVER",
        used_delta: null,
        remaining_delta: null,
        total_delta: null,
      };
    }
    return {
      bucket_key: bucket.bucket_key,
      entitlement_key: bucket.entitlement_key,
      unit_type: bucket.unit_type,
      period_start: bucket.period_start,
      period_end: bucket.period_end,
      status: "NEW_BUCKET",
      used_delta: null,
      remaining_delta: null,
      total_delta: null,
    };
  });
  const currentIdentities = new Set(currentBuckets.map(bucketIdentity));
  const removed = previousBuckets
    .filter((bucket) => !currentIdentities.has(bucketIdentity(bucket)))
    .map((bucket) => ({
      bucket_key: bucket.bucket_key,
      entitlement_key: bucket.entitlement_key,
      unit_type: bucket.unit_type,
      status: "REMOVED_BUCKET",
      used_delta: null,
      remaining_delta: null,
      total_delta: null,
    }));
  const units = [...new Set(currentBuckets.map((bucket) => bucket.unit_type).filter(Boolean))];
  const allComparable = comparisons.length > 0
    && removed.length === 0
    && comparisons.every((item) => item.status === "COMPARABLE")
    && units.length === 1;
  const aggregate = allComparable
    ? {
        unit_type: units[0],
        used_delta: comparisons.every((item) => item.used_delta !== null)
          ? comparisons.reduce((sum, item) => sum + item.used_delta, 0)
          : null,
        remaining_delta: comparisons.every((item) => item.remaining_delta !== null)
          ? comparisons.reduce((sum, item) => sum + item.remaining_delta, 0)
          : null,
        total_delta: comparisons.every((item) => item.total_delta !== null)
          ? comparisons.reduce((sum, item) => sum + item.total_delta, 0)
          : null,
      }
    : null;
  const status = allComparable
    ? "COMPARABLE"
    : comparisons.some((item) => ["ROLLED_OVER", "NEW_PERIOD"].includes(item.status))
      ? "NEW_PERIOD"
      : "PARTIAL";
  return {
    status,
    reason: allComparable ? "matching_account_bucket_entitlement_unit_and_period" : "non_comparable_bucket_scope",
    previous_captured_at: previous.captured_at ?? null,
    current_captured_at: current.captured_at ?? null,
    buckets: [...comparisons, ...removed],
    aggregate,
  };
}
