#!/usr/bin/env node

import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBillingDataBaseDir } from "./path-discovery.mjs";
import {
  OFFICIAL_RUNTIME_PATH,
  prepareOfficialBillingVendor,
} from "./vendor-loader.mjs";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const RECONCILIATION_SCHEMA_VERSION = 2;
export const DEFAULT_PROVIDER_ID = "account:bigmodel-individual-coding-plan";
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export const DEFAULT_TIMEOUT_MS = 45_000;

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
const RUN_ROOT = path.join(PROJECT_ROOT, ".run");
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, ".run", "cost-lab-billing");
const DEFAULT_RUNTIME_PATH = OFFICIAL_RUNTIME_PATH;
const MODEL_ARRAY_FIELDS = Object.freeze([
  "cachedInputTokensUsage",
  "uncachedInputTokensUsage",
  "outputTokensUsage",
  "cachedInputCreditsUsage",
  "uncachedInputCreditsUsage",
  "outputCreditsUsage",
]);
const PROVIDERS = Object.freeze({
  "account:bigmodel-individual-coding-plan": Object.freeze({
    family: "bigmodel",
    plan_scope: "personal",
  }),
  "account:zai-individual-coding-plan": Object.freeze({
    family: "zai",
    plan_scope: "personal",
  }),
});

function requiredValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name}_requires_value`);
  return value;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "snapshot" && command !== "reconcile") {
    throw new Error("command_must_be_snapshot_or_reconcile");
  }
  const options = {
    command,
    json: false,
    provider: DEFAULT_PROVIDER_ID,
    model: null,
    range: "today",
    start: null,
    end: null,
    timeZone: DEFAULT_TIME_ZONE,
    dataRoot: null,
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    before: null,
    after: null,
    usage: null,
    hour: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--provider") {
      options.provider = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--model") {
      options.model = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--range") {
      options.range = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--start") {
      options.start = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--end") {
      options.end = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--timezone") {
      options.timeZone = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--data-root") {
      options.dataRoot = requiredValue(rest, index, arg);
      index += 1;
    } else if (arg === "--out") {
      options.out = path.resolve(requiredValue(rest, index, arg));
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = Number(requiredValue(rest, index, arg));
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
        throw new Error("timeout_ms_must_be_between_1000_and_300000");
      }
      options.timeoutMs = value;
      index += 1;
    } else if (arg === "--before") {
      options.before = path.resolve(requiredValue(rest, index, arg));
      index += 1;
    } else if (arg === "--after") {
      options.after = path.resolve(requiredValue(rest, index, arg));
      index += 1;
    } else if (arg === "--usage") {
      options.usage = path.resolve(requiredValue(rest, index, arg));
      index += 1;
    } else if (arg === "--hour") {
      const value = Number(requiredValue(rest, index, arg));
      if (!Number.isInteger(value) || value < 0 || value > 23) {
        throw new Error("hour_must_be_between_0_and_23");
      }
      options.hour = value;
      index += 1;
    } else {
      throw new Error(`unknown_option:${arg}`);
    }
  }
  if (command === "snapshot") {
    if (!["today", "7d", "30d", "custom"].includes(options.range)) {
      throw new Error("range_must_be_today_7d_30d_or_custom");
    }
    if (options.range === "custom" && (!options.start || !options.end)) {
      throw new Error("custom_range_requires_start_and_end");
    }
    if (options.timeZone !== DEFAULT_TIME_ZONE) {
      throw new Error("only_asia_shanghai_is_supported_for_billing_windows");
    }
    assertSupportedProvider(options.provider);
  } else {
    if (!options.before || !options.after || !options.usage) {
      throw new Error("reconcile_requires_before_after_and_usage");
    }
  }
  return Object.freeze(options);
}

export function assertSupportedProvider(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`unsupported_individual_coding_plan_provider:${providerId}`);
  return provider;
}

function finiteNumber(value, fallback = 0) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isFinite(number) ? number : fallback;
}

function ledgerNumber(value, tokens = false) {
  const number = finiteNumber(value, null);
  return number !== null && number >= 0 && (!tokens || Number.isSafeInteger(number))
    ? number
    : null;
}

function knownSum(...values) {
  return values.includes(null) ? null : values.reduce((sum, value) => sum + value, 0);
}

function normalizeHourAxis(xTime, granularity) {
  if (!Array.isArray(xTime)) return [];
  return xTime.map((entry) => {
    const raw = String(entry);
    if (granularity !== "hour") return raw;
    const match = /(?:^|[ T])(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(raw);
    return match ? `${match[1]}:${match[2]}:${match[3] ?? "00"}` : raw;
  });
}

function normalizeBucket(row, index) {
  const value = (field) => {
    const sequence = row?.[field];
    return Array.isArray(sequence) ? ledgerNumber(sequence[index], field.includes("Tokens")) : null;
  };
  const cachedInputTokens = value("cachedInputTokensUsage");
  const uncachedInputTokens = value("uncachedInputTokensUsage");
  const outputTokens = value("outputTokensUsage");
  const cachedInputCredits = value("cachedInputCreditsUsage");
  const uncachedInputCredits = value("uncachedInputCreditsUsage");
  const outputCredits = value("outputCreditsUsage");
  return {
    cached_input_tokens: cachedInputTokens,
    uncached_input_tokens: uncachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: knownSum(cachedInputTokens, uncachedInputTokens, outputTokens),
    cached_input_credits: cachedInputCredits,
    uncached_input_credits: uncachedInputCredits,
    output_credits: outputCredits,
    total_credits: knownSum(cachedInputCredits, uncachedInputCredits, outputCredits),
  };
}

function missingModelFields(row, model) {
  const missing = [];
  for (const field of MODEL_ARRAY_FIELDS) {
    if (!Array.isArray(row?.[field]) || row[field].length !== model.hours.length ||
        row[field].some((value) => ledgerNumber(value, field.includes("Tokens")) === null)) {
      missing.push(field);
    }
  }
  if (model.total_tokens === null) missing.push("totalTokens");
  if (model.total_credits === null) missing.push("totalCredits");
  return missing;
}

export function buildSnapshotEnvelope({
  result,
  providerId,
  modelFilter = null,
  query,
  capturedAt,
  dataBaseDirSource = null,
}) {
  if (!result?.snapshot || !result?.identity) throw new Error("official_billing_result_invalid");
  const provider = assertSupportedProvider(providerId);
  const snapshot = result.snapshot;
  const billingSource = sourceModelUsage(snapshot.modelUsage);
  const xTime = normalizeHourAxis(billingSource?.xTime, snapshot.modelUsage?.granularity);
  const allRows = Array.isArray(billingSource?.modelDataList)
    ? billingSource.modelDataList
    : [];
  const selectedRows = modelFilter
    ? allRows.filter((row) => billingModelName(row) === modelFilter)
    : allRows;
  if (modelFilter && selectedRows.length === 0) throw new Error(`model_not_found:${modelFilter}`);
  const models = selectedRows.map((row) => {
    const hours = xTime.map((axis, index) => ({
      bucket: axis,
      ...normalizeBucket(row, index),
    }));
    // Official detail can omit daily totals while returning the classified series.
    const total = (raw, field) => raw === undefined && hours.length > 0
      ? ledgerNumber(knownSum(...hours.map((hour) => hour[field])), field === "total_tokens")
      : ledgerNumber(raw, field === "total_tokens");
    return {
      model: billingModelName(row),
      total_tokens: total(row.totalTokens, "total_tokens"),
      total_credits: total(row.totalCredits, "total_credits"),
      hours,
    };
  });
  const missingFields = selectedRows.flatMap((row, index) =>
    missingModelFields(row, models[index])
      .map((field) => `${billingModelName(row)}.${field}`),
  );
  if (!Array.isArray(billingSource?.xTime) || xTime.length === 0 ||
      new Set(xTime).size !== xTime.length ||
      (snapshot.modelUsage?.granularity === "hour" &&
        xTime.some((label) => !/^(?:[01]\d|2[0-3]):00:00$/u.test(label)))) {
    missingFields.push("modelUsage.xTime");
  }
  if (snapshot.quota == null) missingFields.push("quota");
  const integrityStatus =
    models.length === 0 || missingFields.length > 0 ? "PARTIAL" : "COMPLETE";
  const retainedSnapshot = sanitizeOfficialSnapshot(snapshot);
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    kind: "coding_plan_billing_snapshot",
    source: "official:usageStatsService.getCodingPlanUsageSnapshot",
    captured_at: capturedAt,
    provider: {
      id: String(snapshot.sourceProvider?.id ?? providerId),
      name: String(snapshot.sourceProvider?.name ?? "Coding Plan"),
    },
    identity: {
      api_key_id: result.identity.apiKeyId ?? null,
      official_account_scope: result.identity.accountScope ?? null,
      plan_scope: provider.plan_scope,
      organization_id: result.identity.organizationId ?? null,
      project_id: result.identity.projectId ?? null,
    },
    query: {
      range: query.range,
      custom_start_date: query.customStartDate ?? null,
      custom_end_date: query.customEndDate ?? null,
      time_zone: query.timeZone,
      model_filter: modelFilter,
    },
    range: {
      start_date: snapshot.rangeStartDate ?? null,
      end_date: snapshot.rangeEndDate ?? null,
      granularity: snapshot.modelUsage?.granularity ?? null,
      generated_at: finiteNumber(snapshot.generatedAt, null),
    },
    quota: snapshot.quota ?? null,
    models,
    integrity: {
      status: integrityStatus,
      missing_fields: missingFields,
      settlement_status: "UNKNOWN",
      source_snapshot_retained: retainedSnapshot.redactedPaths.length === 0,
      redacted_secret_fields: retainedSnapshot.redactedPaths,
    },
    data_discovery: {
      data_base_dir_source: dataBaseDirSource,
    },
    official_snapshot: retainedSnapshot.value,
  };
}

function sourceModelUsage(modelUsage) {
  return modelUsage && Object.hasOwn(modelUsage, "costLabBillingSource")
    ? modelUsage.costLabBillingSource
    : modelUsage;
}

function billingModelName(row) {
  return row?.modelName?.trim() || row?.modelCode?.trim() || null;
}

const SECRET_FIELD_PATTERN =
  /^(?:authorization|cookie|password|secret|credentials?|access[_-]?token|refresh[_-]?token|project[_-]?token|jwt|bearer|private[_-]?key|api[_-]?key)$/iu;

export function sanitizeOfficialSnapshot(value) {
  const redactedPaths = [];
  const visit = (entry, location) => {
    if (Array.isArray(entry)) {
      return entry.map((item, index) => visit(item, `${location}[${index}]`));
    }
    if (!entry || typeof entry !== "object") return entry;
    const result = {};
    for (const [key, child] of Object.entries(entry)) {
      const childLocation = location ? `${location}.${key}` : key;
      if (SECRET_FIELD_PATTERN.test(key)) {
        result[key] = "<redacted>";
        redactedPaths.push(childLocation);
      } else {
        result[key] = visit(child, childLocation);
      }
    }
    return result;
  };
  return { value: visit(value, ""), redactedPaths };
}

export function shanghaiHourForTimestamp(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new Error("usage_timestamp_invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value);
}

export function isOffPeakShanghai(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const weekdayPeak =
    ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday) && hour >= 14 && hour < 18;
  return !weekdayPeak;
}

function usageRecord(raw) {
  return raw?.request_usage ?? raw?.usage ?? raw?.tokens ?? raw;
}

export function extractRequestUsage(raw) {
  const usage = usageRecord(raw);
  if (!usage || typeof usage !== "object") throw new Error("usage_record_missing");
  const pick = (...names) => {
    for (const name of names) {
      if (usage[name] !== undefined && usage[name] !== null) return usage[name];
    }
    return undefined;
  };
  const cachedInputTokens = finiteNumber(
    pick("cached_input_tokens", "cachedInputTokens", "cached_input", "cachedInput"),
    null,
  );
  const explicitUncached = pick(
    "uncached_input_tokens",
    "uncachedInputTokens",
    "uncached_input",
    "uncachedInput",
  );
  const inputTokens = pick("input_tokens", "inputTokens");
  const outputTokensRaw = pick("output_tokens", "outputTokens", "output");
  const explicitTotal = pick("total_tokens", "totalTokens", "total");
  if (
    ![
      pick("cached_input_tokens", "cachedInputTokens", "cached_input", "cachedInput"),
      explicitUncached,
      inputTokens,
      outputTokensRaw,
      explicitTotal,
    ].some((value) => value !== undefined)
  ) {
    throw new Error("usage_token_fields_missing");
  }
  const inclusiveInput = ledgerNumber(inputTokens, true);
  const uncachedInputTokens = explicitUncached !== undefined
    ? ledgerNumber(explicitUncached, true)
    : inclusiveInput !== null && cachedInputTokens !== null
      ? inclusiveInput - cachedInputTokens
      : null;
  const outputTokens = ledgerNumber(outputTokensRaw, true);
  const totalTokens =
    explicitTotal !== undefined
      ? ledgerNumber(explicitTotal, true)
      : knownSum(cachedInputTokens, uncachedInputTokens, outputTokens);
  for (const [name, value] of Object.entries({
    cached_input_tokens: cachedInputTokens,
    uncached_input_tokens: uncachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`usage_${name}_invalid`);
  }
  if (knownSum(cachedInputTokens, uncachedInputTokens, outputTokens) !== totalTokens) {
    throw new Error("usage_total_tokens_inconsistent");
  }
  return {
    model:
      pick("model", "modelName", "model_id", "modelId")?.toString() ??
      raw?.model ??
      raw?.model_id ??
      null,
    timestamp:
      pick("observed_at", "captured_at", "timestamp", "ended_at", "started_at", "time") ??
      raw?.captured_at ??
      raw?.timestamp ??
      null,
    cached_input_tokens: cachedInputTokens,
    uncached_input_tokens: uncachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function bucketAt(snapshot, model, hour) {
  const label = `${String(hour).padStart(2, "0")}:00:00`;
  const official = snapshot.official_snapshot?.modelUsage?.costLabBillingSource;
  if (!Array.isArray(official?.modelDataList) || !Array.isArray(official?.xTime)) return null;
  const rows = official.modelDataList.filter((row) => billingModelName(row) === model);
  const axis = normalizeHourAxis(official.xTime, "hour");
  const index = axis.indexOf(label);
  if (rows.length !== 1 || index < 0 || axis.lastIndexOf(label) !== index) return null;
  return normalizeBucket(rows[0], index);
}

function subtractBucket(after, before) {
  const result = {};
  for (const field of [
    "cached_input_tokens",
    "uncached_input_tokens",
    "output_tokens",
    "total_tokens",
    "cached_input_credits",
    "uncached_input_credits",
    "output_credits",
    "total_credits",
  ]) {
    const isToken = field.endsWith("_tokens");
    const first = ledgerNumber(before?.[field], isToken);
    const last = ledgerNumber(after?.[field], isToken);
    result[field] = first === null || last === null ? null : last - first;
  }
  return result;
}

function changedHours(before, after, model) {
  return Array.from({ length: 24 }, (_, hour) => {
    const diff = subtractBucket(bucketAt(after, model, hour), bucketAt(before, model, hour));
    return Object.values(diff).some((value) => value !== null && Math.abs(value) > 1e-12)
      ? hour
      : null;
  }).filter((hour) => hour !== null);
}

export function calculateCreditBreakdown({
  uncachedInputTokens,
  cachedInputTokens,
  outputTokens,
  offPeak,
  actualCredits,
}) {
  for (const [name, value] of Object.entries({
    uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`credit_${name}_invalid`);
  }
  if (actualCredits !== null && (!Number.isFinite(actualCredits) || actualCredits < 0)) {
    throw new Error("credit_actualCredits_invalid");
  }
  const baseCredits =
    (uncachedInputTokens * 2.3 + cachedInputTokens * 0.56 + outputTokens * 8) / 10_000;
  const timeMultiplier = offPeak ? 0.5 : 1;
  const expectedNormal = baseCredits * timeMultiplier;
  const expectedWithZeroPointSixSeven = expectedNormal * 0.67;
  return {
    base_credits: baseCredits,
    time_multiplier: timeMultiplier,
    expected_normal: expectedNormal,
    expected_with_0_67: expectedWithZeroPointSixSeven,
    actual_credits: actualCredits,
    effective_extra_ratio: expectedNormal > 0 && actualCredits !== null ? actualCredits / expectedNormal : null,
  };
}

function classifyCredit(actual, normal, withDiscount, tolerance) {
  if (actual === null) return "INCONCLUSIVE";
  if (actual === 0) return "ZERO_CHARGE";
  const normalMatch = Math.abs(actual - normal) <= tolerance;
  const discountMatch = Math.abs(actual - withDiscount) <= tolerance;
  if (normalMatch && discountMatch) return "INCONCLUSIVE";
  if (normalMatch) return "NORMAL";
  if (discountMatch) return "EXTRA_0_67";
  return "OTHER";
}

export function reconcileBillingSnapshots(before, after, rawUsage, options = {}) {
  if (before?.kind !== "coding_plan_billing_snapshot" ||
      after?.kind !== "coding_plan_billing_snapshot") {
    throw new Error("billing_snapshot_schema_invalid");
  }
  if (!before.provider?.id || before.provider.id !== after.provider?.id) throw new Error("billing_provider_changed");
  if (!before.query?.time_zone || before.query.time_zone !== after.query?.time_zone) {
    throw new Error("billing_timezone_changed");
  }
  for (const key of ["api_key_id", "organization_id", "project_id", "official_account_scope", "plan_scope"]) {
    if ((before.identity?.[key] ?? null) !== (after.identity?.[key] ?? null)) {
      throw new Error("billing_identity_changed");
    }
  }
  if (typeof before.identity?.api_key_id !== "string" || !before.identity.api_key_id.trim()) {
    throw new Error("billing_identity_missing");
  }
  const beforeStartDate = before.range?.start_date;
  const beforeEndDate = before.range?.end_date;
  const afterStartDate = after.range?.start_date;
  const afterEndDate = after.range?.end_date;
  if (!beforeStartDate || !beforeEndDate || !afterStartDate || !afterEndDate) {
    throw new Error("billing_range_date_missing");
  }
  if (beforeStartDate !== afterStartDate || beforeEndDate !== afterEndDate) {
    throw new Error("billing_range_changed");
  }
  if (beforeStartDate !== beforeEndDate || before.range.granularity !== "hour" ||
      after.range.granularity !== "hour") throw new Error("billing_single_day_hourly_range_required");
  const usage = extractRequestUsage(rawUsage);
  const model = options.model ?? usage.model;
  if (!model) throw new Error("model_required_for_reconciliation");
  if (usage.model && usage.model !== model) throw new Error("billing_usage_model_changed");
  let hour = options.hour;
  if (hour === undefined || hour === null) {
    const changed = changedHours(before, after, model);
    if (changed.length !== 1) throw new Error("hour_required_for_reconciliation");
    hour = changed[0];
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("billing_hour_invalid");
  const beforeCaptured = Date.parse(before.captured_at);
  const afterCaptured = Date.parse(after.captured_at);
  if (!Number.isFinite(beforeCaptured) || !Number.isFinite(afterCaptured) || afterCaptured < beforeCaptured) {
    throw new Error("billing_capture_order_invalid");
  }
  if (usage.timestamp !== null) {
    const observed = new Date(usage.timestamp);
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: DEFAULT_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(observed);
    if (localDate !== afterEndDate || shanghaiHourForTimestamp(observed) !== hour) {
      throw new Error("billing_usage_window_changed");
    }
  }
  const diff = subtractBucket(bucketAt(after, model, hour), bucketAt(before, model, hour));
  const complete = Object.values(diff).every((value) => value !== null && value >= -1e-12);
  const creditsObserved = complete && diff.total_credits > 1e-12;
  const settledZero = complete && diff.total_credits === 0 && after.integrity?.settlement_status === "SETTLED";
  const tokenDeltaObserved = complete && diff.total_tokens > 0;
  const tokenMatch =
    complete && (tokenDeltaObserved || settledZero) &&
    diff.cached_input_tokens === usage.cached_input_tokens &&
    diff.uncached_input_tokens === usage.uncached_input_tokens &&
    diff.output_tokens === usage.output_tokens &&
    diff.total_tokens === usage.total_tokens;
  const bucketDateKey = after.range.end_date ?? after.range.start_date;
  if (!bucketDateKey) throw new Error("billing_range_date_missing");
  const bucketInstant = new Date(
    `${bucketDateKey}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  );
  if (Number.isNaN(bucketInstant.getTime())) throw new Error("billing_hour_date_invalid");
  const calculation = calculateCreditBreakdown({
    uncachedInputTokens: usage.uncached_input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    offPeak: isOffPeakShanghai(bucketInstant),
    actualCredits: tokenMatch && (creditsObserved || settledZero) ? diff.total_credits : null,
  });
  const tolerance = options.creditTolerance ?? 0.0005;
  const creditClass = classifyCredit(
    calculation.actual_credits, calculation.expected_normal, calculation.expected_with_0_67, tolerance,
  );
  const reconciliationStatus =
    tokenMatch && ["NORMAL", "EXTRA_0_67", "ZERO_CHARGE"].includes(creditClass)
      ? "PASS"
      : "INCONCLUSIVE";
  let settlementStatus = "NO_OBSERVED_CREDIT_DELTA";
  if (!complete) settlementStatus = "INVALID_BILLING_DATA";
  else if (settledZero) settlementStatus = "ZERO_CHARGE_OBSERVED";
  else if (creditsObserved) settlementStatus = "DELTA_OBSERVED";
  else if (tokenDeltaObserved) settlementStatus = "CREDITS_PENDING";
  if ((creditsObserved || settledZero) && !tokenMatch) settlementStatus = "UNATTRIBUTED_DELTA";
  return {
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    kind: "coding_plan_billing_reconciliation",
    provider: after.provider,
    model,
    time_zone: after.query.time_zone,
    hour: `${String(hour).padStart(2, "0")}:00:00`,
    captured_at: new Date().toISOString(),
    before_captured_at: before.captured_at,
    after_captured_at: after.captured_at,
    official_delta: Object.fromEntries(Object.entries(diff).map(([key, value]) => [
      key, key.endsWith("_credits") && !creditsObserved && !settledZero ? null : value,
    ])),
    request_usage: usage,
    token_match: tokenMatch,
    calculation,
    credit_class: creditClass,
    credit_tolerance: tolerance,
    billing_reconciliation: reconciliationStatus,
    settlement_status: settlementStatus,
    limitations: [
      "official_api_is_hour_aggregated",
      "unique_attribution_requires_token_match_and_no_parallel_activity",
      "entitlement_is_not_inferred_from_a_single_credit_ratio",
    ],
  };
}

export async function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertProjectRunOutput(filePath) {
  const relative = path.relative(RUN_ROOT, path.resolve(filePath));
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("output_must_be_inside_project_run_root");
  }
}

function timestampSlug(date) {
  return date.toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-").replace("Z", "Z");
}

function defaultOutputPath(prefix, now) {
  return path.join(DEFAULT_OUTPUT_ROOT, `${prefix}-${timestampSlug(now)}.json`);
}

export function sanitizeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(
      /\b(authorization|api[_-]?key|access[_-]?token|project[_-]?token)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu,
      "$1=<redacted>",
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer <redacted>")
    .slice(0, 500);
}

export function safeError(error) {
  return {
    ok: false,
    error: {
      code: "cost_lab_billing_error",
      message: sanitizeErrorMessage(error),
    },
  };
}

async function withTimeout(promise, timeoutMs, timeoutCode, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(timeoutCode));
          queueMicrotask(() => onTimeout?.());
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadOfficialRuntime(runtimePath = DEFAULT_RUNTIME_PATH) {
  const module = await import(pathToFileURL(runtimePath).href);
  if (typeof module.createCostLabBillingRuntime !== "function") {
    throw new Error("official_billing_runtime_export_missing");
  }
  return module;
}

export async function captureSnapshot(options, dependencies = {}) {
  const provider = assertSupportedProvider(options.provider);
  const now = dependencies.now?.() ?? new Date();
  const resolvedData = resolveBillingDataBaseDir(options.dataRoot, {
    env: dependencies.env ?? process.env,
    platform: dependencies.platform ?? process.platform,
    fallbackHomeDir: dependencies.fallbackHomeDir,
    fileExists: dependencies.fileExists,
    readFile: dependencies.readFile,
  });
  const dataDirectoryExists =
    dependencies.dataDirectoryExists
      ? await dependencies.dataDirectoryExists(resolvedData.dataBaseDir)
      : await access(resolvedData.dataBaseDir).then(
          () => true,
          () => false,
        );
  if (!dataDirectoryExists) throw new Error("billing_data_base_dir_not_found");
  if (!dependencies.runtimeModule) {
    await prepareOfficialBillingVendor({
      platform: dependencies.platform ?? process.platform,
      arch: dependencies.arch ?? process.arch,
    });
  }
  const runtimeModule =
    dependencies.runtimeModule ?? (await loadOfficialRuntime(dependencies.runtimePath));
  const controller = new AbortController();
  const runtime = runtimeModule.createCostLabBillingRuntime({
    dataBaseDir: resolvedData.dataBaseDir,
    signal: controller.signal,
  });
  const request = {
    range: options.range,
    preferredProviderId: options.provider,
    accountAccess: {
      type: "zhipu-account",
      family: provider.family,
      planKind: "individual-coding-plan",
    },
    timeZone: options.timeZone,
    ...(options.range === "custom"
      ? {
          customStartDate: options.start,
          customEndDate: options.end,
        }
      : {}),
  };
  const result = await withTimeout(
    runtime.getCodingPlanUsageSnapshot(request),
    options.timeoutMs,
    "official_billing_read_timeout",
    () => controller.abort(new Error("official_billing_read_timeout")),
  ).finally(() => controller.abort(new Error("official_billing_read_complete")));
  return buildSnapshotEnvelope({
    result,
    providerId: options.provider,
    modelFilter: options.model,
    query: request,
    capturedAt: now.toISOString(),
    dataBaseDirSource: resolvedData.dataBaseDirSource,
  });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`json_invalid:${path.basename(filePath)}`);
    throw error;
  }
}

export async function run(argv, dependencies = {}) {
  const options = parseArgs(argv);
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const now = dependencies.now?.() ?? new Date();
  let result;
  let prefix;
  if (options.command === "snapshot") {
    result = await captureSnapshot(options, { ...dependencies, now: () => now });
    prefix = "snapshot";
  } else {
    const [before, after, usage] = await Promise.all([
      readJson(options.before),
      readJson(options.after),
      readJson(options.usage),
    ]);
    result = reconcileBillingSnapshots(before, after, usage, {
      model: options.model,
      hour: options.hour,
    });
    prefix = "reconciliation";
  }
  const outputPath = options.out ?? defaultOutputPath(prefix, now);
  assertProjectRunOutput(outputPath);
  await atomicWriteJson(outputPath, result);
  const commandResult = {
    ok: true,
    output_path: path.relative(PROJECT_ROOT, outputPath).replaceAll(path.sep, "/"),
    data: result,
  };
  if (options.json) {
    stdout(`${JSON.stringify(commandResult, null, 2)}\n`);
  } else {
    stdout(`${prefix} written: ${commandResult.output_path}\n`);
  }
  return commandResult;
}

async function main() {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeError(error), null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
