import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson } from "./coding-plan-billing.mjs";
import {
  STARTPLAN_HISTORY_SCHEMA_VERSION,
  annotateStartPlanFreshness,
  compareStartPlanSnapshots,
} from "./startplan-billing.mjs";

const DEFAULT_COOLDOWN_MS = 5_000;
const DEFAULT_HISTORY_LIMIT = 25;
const MAX_HISTORY_ITEMS = 100;

function serviceError(statusCode, code, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  Object.assign(error, details);
  return error;
}

function asDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("startplan_clock_invalid");
  return date;
}

function validStoredItem(value) {
  return value
    && typeof value === "object"
    && typeof value.id === "string"
    && /^[0-9a-f-]{36}$/u.test(value.id)
    && value.snapshot
    && typeof value.snapshot === "object"
    && typeof value.captured_at === "string";
}

function snapshotDigest(snapshot) {
  const canonical = {
    account: snapshot.account?.key ?? null,
    server_time: snapshot.server_time ?? null,
    plans: snapshot.plans ?? [],
    buckets: snapshot.buckets ?? [],
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizeQueryDate(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw serviceError(400, "STARTPLAN_HISTORY_RANGE_INVALID", `${field} must be an ISO timestamp.`);
  }
  return milliseconds;
}

function summarize(item, nowMs) {
  const snapshot = item.snapshot;
  return {
    id: item.id,
    captured_at: item.captured_at,
    server_time: snapshot.server_time ?? null,
    plan_id: snapshot.plan_id ?? null,
    plan_type: snapshot.plan_type ?? null,
    plan_status: snapshot.plan_status ?? null,
    entitlement_status: snapshot.official_entitlement?.status ?? null,
    unit_type: snapshot.unit_type ?? null,
    total_balance: snapshot.total_balance ?? null,
    used_balance: snapshot.used_balance ?? null,
    remaining_balance: snapshot.remaining_balance ?? null,
    billing_period: snapshot.billing_period ?? null,
    expiry: snapshot.expiry ?? null,
    missing_fields: Array.isArray(snapshot.missing_fields) ? snapshot.missing_fields : [],
    buckets: Array.isArray(snapshot.buckets) ? snapshot.buckets : [],
    freshness: annotateStartPlanFreshness(snapshot, nowMs),
    integrity: snapshot.integrity?.status ?? "UNKNOWN",
    bucket_count: Array.isArray(snapshot.buckets) ? snapshot.buckets.length : null,
  };
}

function publicItem(item, nowMs) {
  return {
    ...summarize(item, nowMs),
    snapshot: {
      ...item.snapshot,
      freshness: annotateStartPlanFreshness(item.snapshot, nowMs),
    },
    integrity: item.integrity ?? item.snapshot.integrity ?? null,
    sanitized_raw: item.sanitized_raw ?? null,
    capture_metadata: item.capture_metadata ?? null,
  };
}

export function createStartPlanBillingService(options = {}) {
  if (!options.historyPath) throw new Error("startplan_history_path_required");
  if (typeof options.readBilling !== "function") throw new Error("startplan_reader_required");
  const historyPath = path.resolve(options.historyPath);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maximumItems = options.maximumItems ?? MAX_HISTORY_ITEMS;
  const state = {
    loaded: false,
    items: [],
    inFlight: null,
    lastAttemptMs: null,
    activeAbortController: null,
    closed: false,
  };

  async function ensureLoaded() {
    if (state.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(historyPath, "utf8"));
      if (parsed?.schema_version !== STARTPLAN_HISTORY_SCHEMA_VERSION || !Array.isArray(parsed.items)) {
        throw new Error("startplan_history_schema_invalid");
      }
      state.items = parsed.items.filter(validStoredItem).slice(-maximumItems);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state.items = [];
    }
    state.loaded = true;
  }

  async function persist() {
    const updated = asDate(now).toISOString();
    await atomicWriteJson(historyPath, {
      schema_version: STARTPLAN_HISTORY_SCHEMA_VERSION,
      updated_at: updated,
      items: state.items.slice(-maximumItems),
    });
  }

  function latestInternal() {
    return state.items.at(-1) ?? null;
  }

  async function latest() {
    await ensureLoaded();
    const currentMs = asDate(now).getTime();
    const latestItem = latestInternal();
    const previousItem = state.items.at(-2) ?? null;
    return {
      available: Boolean(latestItem),
      state: latestItem ? "AVAILABLE" : "NO_SNAPSHOT",
      official_request_performed: false,
      snapshot: latestItem ? publicItem(latestItem, currentMs) : null,
      comparison: latestItem && previousItem
        ? compareStartPlanSnapshots(previousItem.snapshot, latestItem.snapshot)
        : null,
    };
  }

  async function history(query = {}) {
    await ensureLoaded();
    const fromMs = normalizeQueryDate(query.from, "from");
    const toMs = normalizeQueryDate(query.to, "to");
    if (fromMs !== null && toMs !== null && fromMs > toMs) {
      throw serviceError(400, "STARTPLAN_HISTORY_RANGE_INVALID", "from must not be after to.");
    }
    const requestedLimit = query.limit === undefined || query.limit === null || query.limit === ""
      ? DEFAULT_HISTORY_LIMIT
      : Number(query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > DEFAULT_HISTORY_LIMIT) {
      throw serviceError(
        400,
        "STARTPLAN_HISTORY_LIMIT_INVALID",
        `limit must be an integer from 1 to ${DEFAULT_HISTORY_LIMIT}.`,
      );
    }
    const currentMs = asDate(now).getTime();
    const filtered = state.items.filter((item) => {
      const capturedMs = Date.parse(item.captured_at);
      return Number.isFinite(capturedMs)
        && (fromMs === null || capturedMs >= fromMs)
        && (toMs === null || capturedMs <= toMs);
    });
    const selected = filtered.slice(-requestedLimit);
    return {
      items: selected.map((item) => publicItem(item, currentMs)),
      total: filtered.length,
      limit: requestedLimit,
      official_request_performed: false,
    };
  }

  async function findById(id) {
    await ensureLoaded();
    return state.items.find((item) => item.id === id) ?? null;
  }

  async function exportSnapshot(id) {
    const item = await findById(id);
    if (!item) {
      throw serviceError(404, "STARTPLAN_SNAPSHOT_NOT_FOUND", "Start Plan snapshot not found.");
    }
    return {
      schema_version: 1,
      exported_at: asDate(now).toISOString(),
      redaction: "credential_fields_absolute_paths_and_raw_opaque_ids_omitted",
      model_requests: 0,
      snapshot: publicItem(item, asDate(now).getTime()),
    };
  }

  async function doRefresh(signal) {
    const startedAt = asDate(now);
    const read = await options.readBilling({ signal });
    if (!read?.snapshot || !read?.sanitized_raw) {
      throw serviceError(
        502,
        "STARTPLAN_READER_RESPONSE_INVALID",
        "The official Start Plan reader returned an invalid response.",
      );
    }
    const id = createId();
    const digest = snapshotDigest(read.snapshot);
    const duplicate = state.items.find((item) => item.dedupe_digest === digest);
    if (duplicate) {
      return {
        snapshot: publicItem(duplicate, startedAt.getTime()),
        deduplicated: true,
        official_request_performed: true,
        official_billing_get_attempts: 1,
      };
    }
    const capturedAt = read.snapshot.captured_at ?? startedAt.toISOString();
    const item = {
      id,
      captured_at: capturedAt,
      stored_at: startedAt.toISOString(),
      dedupe_digest: digest,
      snapshot: read.snapshot,
      sanitized_raw: read.sanitized_raw,
      capture_metadata: read.metadata ?? null,
      integrity: read.snapshot.integrity ?? null,
    };
    state.items.push(item);
    if (state.items.length > maximumItems) state.items.splice(0, state.items.length - maximumItems);
    try {
      await persist();
    } catch (error) {
      state.items = state.items.filter((candidate) => candidate !== item);
      throw error;
    }
    return {
      snapshot: publicItem(item, startedAt.getTime()),
      deduplicated: false,
      official_request_performed: true,
      official_billing_get_attempts: 1,
    };
  }

  async function refresh() {
    await ensureLoaded();
    if (state.closed) {
      throw serviceError(503, "STARTPLAN_SERVICE_CLOSING", "The Cost Lab service is closing.");
    }
    if (state.inFlight) {
      const completed = await state.inFlight;
      return { ...completed, deduplicated: true };
    }
    const currentMs = asDate(now).getTime();
    if (state.lastAttemptMs !== null && currentMs - state.lastAttemptMs < cooldownMs) {
      const retryAfterMs = cooldownMs - (currentMs - state.lastAttemptMs);
      throw serviceError(
        429,
        "STARTPLAN_REFRESH_COOLDOWN",
        "Start Plan billing was refreshed recently.",
        { retryAfterMs },
      );
    }
    state.lastAttemptMs = currentMs;
    const abortController = new AbortController();
    state.activeAbortController = abortController;
    const operation = doRefresh(abortController.signal)
      .finally(() => {
        if (state.inFlight === operation) state.inFlight = null;
        if (state.activeAbortController === abortController) state.activeAbortController = null;
      });
    state.inFlight = operation;
    return operation;
  }

  async function close({ abort = true } = {}) {
    state.closed = true;
    if (abort) state.activeAbortController?.abort(new Error("cost_lab_startplan_shutdown"));
    if (!state.inFlight) return;
    await state.inFlight.catch(() => undefined);
  }

  return {
    latest,
    history,
    refresh,
    exportSnapshot,
    close,
    historyPath,
  };
}
