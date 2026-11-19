const FRESHNESS_WINDOW_MS = 5 * 60 * 1_000;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

export function startPlanFreshness(snapshot, nowMs = Date.now()) {
  if (!record(snapshot)) return { status: "UNKNOWN", reason: "snapshot_unavailable" };
  const capturedMs = Date.parse(snapshot.captured_at ?? "");
  const serverMs = Date.parse(snapshot.server_time ?? "");
  const referenceMs = Number.isFinite(serverMs) ? serverMs : capturedMs;
  const expiryCandidates = [
    snapshot.expiry,
    snapshot.billing_period?.end,
    snapshot.period_end,
  ].map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  const expiryMs = expiryCandidates.length ? Math.min(...expiryCandidates) : null;
  if (expiryMs !== null && expiryMs <= nowMs) {
    return {
      status: "EXPIRED",
      reason: "official_period_ended",
      captured_at: snapshot.captured_at ?? null,
      expiry: new Date(expiryMs).toISOString(),
    };
  }
  if (!Number.isFinite(referenceMs)) {
    return { status: "UNKNOWN", reason: "capture_time_unavailable" };
  }
  const ageMs = nowMs - referenceMs;
  if (ageMs < -FRESHNESS_WINDOW_MS) {
    return { status: "UNKNOWN", reason: "server_time_in_future", age_ms: ageMs };
  }
  return {
    status: Math.abs(ageMs) <= FRESHNESS_WINDOW_MS ? "FRESH" : "STALE",
    reason: Math.abs(ageMs) <= FRESHNESS_WINDOW_MS
      ? "recent_official_capture"
      : "capture_older_than_window",
    age_ms: ageMs,
  };
}

function usageProgress(snapshot) {
  const total = finiteInteger(snapshot?.total_balance);
  const used = finiteInteger(snapshot?.used_balance);
  if (total === null || used === null || total <= 0) {
    return { percent: null, total, used, remaining: finiteInteger(snapshot?.remaining_balance) };
  }
  const percent = Math.max(0, Math.min(100, (used / total) * 100));
  return {
    percent,
    total,
    used,
    remaining: finiteInteger(snapshot.remaining_balance),
  };
}

export function compareStartPlanViews(previous, current) {
  if (!previous || !current) {
    return {
      status: "NO_BASELINE",
      rows: [],
      aggregate: null,
    };
  }
  if (previous.account?.key !== current.account?.key) {
    return {
      status: "NOT_COMPARABLE",
      reason: "account_changed",
      rows: [],
      aggregate: null,
    };
  }
  const previousBuckets = Array.isArray(previous.buckets) ? previous.buckets : [];
  const currentBuckets = Array.isArray(current.buckets) ? current.buckets : [];
  const rows = currentBuckets.map((bucket) => {
    const logical = previousBuckets.filter((candidate) => (
      candidate.bucket_key === bucket.bucket_key
      && candidate.entitlement_key === bucket.entitlement_key
      && candidate.plan_id === bucket.plan_id
    ));
    const exact = logical.find((candidate) => (
      candidate.unit_type === bucket.unit_type
      && candidate.period_start === bucket.period_start
      && candidate.period_end === bucket.period_end
    ));
    if (exact) {
      return {
        bucket_key: bucket.bucket_key,
        label: bucket.show_name ?? bucket.bucket_key ?? "Bucket",
        unit_type: bucket.unit_type,
        status: "COMPARABLE",
        used_delta: finiteInteger(bucket.used_units) !== null
          && finiteInteger(exact.used_units) !== null
          ? bucket.used_units - exact.used_units
          : null,
        remaining_delta: finiteInteger(bucket.remaining_units) !== null
          && finiteInteger(exact.remaining_units) !== null
          ? bucket.remaining_units - exact.remaining_units
          : null,
      };
    }
    if (logical.some((candidate) => candidate.unit_type !== bucket.unit_type)) {
      return {
        bucket_key: bucket.bucket_key,
        label: bucket.show_name ?? bucket.bucket_key ?? "Bucket",
        unit_type: bucket.unit_type,
        status: "UNIT_CHANGED",
        used_delta: null,
        remaining_delta: null,
      };
    }
    return {
      bucket_key: bucket.bucket_key,
      label: bucket.show_name ?? bucket.bucket_key ?? "Bucket",
      unit_type: bucket.unit_type,
      status: logical.length ? "ROLLED_OVER" : "NEW_BUCKET",
      used_delta: null,
      remaining_delta: null,
    };
  });
  const allComparable = rows.length > 0
    && rows.every((row) => row.status === "COMPARABLE")
    && new Set(rows.map((row) => row.unit_type).filter(Boolean)).size === 1;
  return {
    status: allComparable ? "COMPARABLE" : rows.some((row) => row.status === "ROLLED_OVER")
      ? "NEW_PERIOD"
      : "PARTIAL",
    previous_captured_at: previous.captured_at ?? null,
    current_captured_at: current.captured_at ?? null,
    rows,
    aggregate: allComparable
      ? {
          unit_type: rows[0].unit_type,
          used_delta: rows.every((row) => row.used_delta !== null)
            ? rows.reduce((sum, row) => sum + row.used_delta, 0)
            : null,
          remaining_delta: rows.every((row) => row.remaining_delta !== null)
            ? rows.reduce((sum, row) => sum + row.remaining_delta, 0)
            : null,
        }
      : null,
  };
}

export function buildStartPlanView(data, nowMs = Date.now()) {
  const snapshot = data?.snapshot?.snapshot ?? data?.snapshot ?? null;
  const history = Array.isArray(data?.history) ? data.history : [];
  return {
    available: Boolean(snapshot),
    status: snapshot ? "READY" : data?.state ?? "NO_SNAPSHOT",
    freshness: startPlanFreshness(snapshot, nowMs),
    summary: snapshot ? {
      plan_id: snapshot.plan_id ?? null,
      plan_type: snapshot.plan_type ?? null,
      plan_status: snapshot.plan_status ?? null,
      entitlement_status: snapshot.official_entitlement?.status ?? "UNKNOWN",
      unit_type: snapshot.unit_type ?? null,
      total_balance: finiteInteger(snapshot.total_balance),
      used_balance: finiteInteger(snapshot.used_balance),
      remaining_balance: finiteInteger(snapshot.remaining_balance),
      billing_period: snapshot.billing_period ?? null,
      expiry: snapshot.expiry ?? null,
      captured_at: snapshot.captured_at ?? null,
      server_time: snapshot.server_time ?? null,
      integrity: snapshot.integrity?.status ?? "UNKNOWN",
      missing_fields: Array.isArray(snapshot.missing_fields) ? snapshot.missing_fields : [],
    } : null,
    progress: snapshot ? usageProgress(snapshot) : {
      percent: null,
      total: null,
      used: null,
      remaining: null,
    },
    buckets: snapshot && Array.isArray(snapshot.buckets)
      ? snapshot.buckets.map((bucket) => ({
          key: bucket.bucket_key ?? null,
          label: bucket.show_name ?? bucket.bucket_key ?? "Bucket",
          entitlement_key: bucket.entitlement_key ?? null,
          model_ids: Array.isArray(bucket.model_ids) ? bucket.model_ids : [],
          unit_type: bucket.unit_type ?? null,
          total_units: finiteInteger(bucket.total_units),
          used_units: finiteInteger(bucket.used_units),
          remaining_units: finiteInteger(bucket.remaining_units),
          period_start: bucket.period_start ?? null,
          period_end: bucket.period_end ?? null,
          expires_at: bucket.expires_at ?? null,
        }))
      : [],
    comparison: data?.comparison ?? null,
    history,
  };
}
