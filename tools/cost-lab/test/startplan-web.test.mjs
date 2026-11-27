import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  PROJECT_ROOT,
  createCostLabWebServer,
} from "../web-server.mjs";
import {
  normalizeStartPlanSnapshot,
  sanitizeOfficialStartPlanPayload,
} from "../startplan-billing.mjs";

const RUN_ROOT = path.join(PROJECT_ROOT, ".run");

function officialPayload({
  used = 102_684,
  remaining = 299_897_316,
  serverTime = "2026-11-19T00:58:10.000Z",
  periodStart = "2026-11-18T14:14:19.000Z",
  periodEnd = "2026-11-19T01:00:00.000Z",
  mixedUnits = false,
  missingRemaining = false,
} = {}) {
  const balances = [{
    bucket_id: "private-bucket",
    user_plan_id: "private-user-plan",
    plan_id: "zcode-v3-start-plan-1118",
    entitlement_id: "private-entitlement",
    show_name: "GLM-5.3-Flash",
    unit_type: "token",
    capabilities: ["model:glm-5.3-flash"],
    total_units: 300_000_000,
    used_units: used,
    remaining_units: missingRemaining ? null : remaining,
    available_units: missingRemaining ? null : remaining,
    period_start: Date.parse(periodStart) / 1_000,
    period_end: Date.parse(periodEnd) / 1_000,
    expires_at: Date.parse(periodEnd) / 1_000,
  }];
  if (mixedUnits) {
    balances.push({
      ...balances[0],
      bucket_id: "private-credit-bucket",
      entitlement_id: "private-credit-entitlement",
      unit_type: "credit",
      total_units: 100,
      used_units: 5,
      remaining_units: 95,
      available_units: 95,
    });
  }
  return {
    code: 0,
    data: {
      server_time: Date.parse(serverTime) / 1_000,
      plans: [{
        user_plan_id: "private-user-plan",
        plan_id: "zcode-v3-start-plan-1118",
        name: "ZCODE GLOBAL BUILD",
        status: "active",
      }],
      balances,
    },
  };
}

function readerResult(raw, capturedAt = "2026-11-19T00:58:15.267Z") {
  const snapshot = normalizeStartPlanSnapshot(raw, {
    capturedAt,
    accountIdentity: "private-account",
    source: "official_billing_balance",
    officialEntitlement: {
      status: "entitled",
      observedAt: Date.parse(capturedAt),
      requestId: "private-request",
    },
    requestMetadata: {
      http_status: 200,
      response_bytes: 900,
      header_names: ["authorization", "x-device-mid"],
    },
  });
  return {
    sanitized_raw: {
      schema_version: 1,
      source: "official_billing_balance",
      payload: sanitizeOfficialStartPlanPayload(raw),
    },
    snapshot,
    metadata: {
      state: {
        credentials_unchanged: true,
        keyring_lock_released: true,
      },
      process: {
        model_requests_triggered: 0,
      },
    },
  };
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Binary/download responses are not expected in this suite.
  }
  return { response, text, json };
}

async function makeServer(t, overrides = {}) {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "startplan-web-test-"));
  let id = 0;
  const server = createCostLabWebServer({
    projectRoot: PROJECT_ROOT,
    historyPath: path.join(root, "history.json"),
    startPlanHistoryPath: path.join(root, "startplan-history.json"),
    startPlanCooldownMs: 0,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    inspectEnvironment: async () => ({ schema_version: 1, warnings: [] }),
    ...overrides,
  });
  const address = await server.start();
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { server, address, root };
}

async function session(base) {
  const current = await request(base, "/api/session");
  assert.equal(current.response.status, 200);
  return current.json.data;
}

function mutationHeaders(base, token) {
  return {
    "Content-Type": "application/json",
    Origin: base,
    "X-Cost-Lab-CSRF": token,
    "Sec-Fetch-Site": "same-origin",
  };
}

test("page load and latest/history APIs never call the official Start Plan reader", async (t) => {
  let reads = 0;
  const fixture = await makeServer(t, {
    readStartPlanBilling: async () => {
      reads += 1;
      return readerResult(officialPayload());
    },
  });
  const base = fixture.address.origin;
  const page = await request(base, "/");
  assert.equal(page.response.status, 200);
  const latest = await request(base, "/api/billing/startplan/latest");
  assert.equal(latest.response.status, 200);
  assert.equal(latest.json.data.available, false);
  assert.equal(latest.json.data.official_request_performed, false);
  const history = await request(base, "/api/billing/startplan/history");
  assert.equal(history.response.status, 200);
  assert.deepEqual(history.json.data.items, []);
  assert.equal(reads, 0);
});

test("refresh persists a sanitized snapshot and latest/history/export expose redacted evidence", async (t) => {
  let reads = 0;
  const fixture = await makeServer(t, {
    readStartPlanBilling: async () => {
      reads += 1;
      return readerResult(officialPayload());
    },
  });
  const base = fixture.address.origin;
  const { csrf_token: token } = await session(base);
  const refreshed = await request(base, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: mutationHeaders(base, token),
    body: JSON.stringify({}),
  });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.json.data.official_billing_get_attempts, 1);
  assert.equal(refreshed.json.data.snapshot.total_balance, 300_000_000);
  assert.equal(refreshed.json.data.snapshot.remaining_balance, 299_897_316);
  assert.equal(reads, 1);

  const latest = await request(base, "/api/billing/startplan/latest");
  assert.equal(latest.json.data.available, true);
  assert.equal(latest.json.data.snapshot.remaining_balance, 299_897_316);
  const history = await request(base, "/api/billing/startplan/history?limit=10");
  assert.equal(history.json.data.items.length, 1);
  const id = history.json.data.items[0].id;
  const exported = await request(base, `/api/billing/startplan/history/${id}/export`);
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get("content-disposition"), /startplan/u);
  assert.doesNotMatch(
    exported.text,
    /private-account|private-user-plan|private-bucket|private-entitlement|private-device-mid|private-request/u,
  );
  assert.doesNotMatch(exported.text, /C:\\\\Users\\\\Sandy/u);

  const persisted = JSON.parse(await readFile(path.join(fixture.root, "startplan-history.json"), "utf8"));
  assert.equal(persisted.items.length, 1);
  assert.equal(persisted.items[0].snapshot.remaining_balance, 299_897_316);
  assert.equal(persisted.items[0].sanitized_raw.payload.data.balances[0].bucket_id.startsWith("sha256:"), true);
});

test("simultaneous refreshes share one official read and one history entry", async (t) => {
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = await makeServer(t, {
    readStartPlanBilling: async () => {
      reads += 1;
      await gate;
      return readerResult(officialPayload());
    },
  });
  const base = fixture.address.origin;
  const { csrf_token: token } = await session(base);
  const submit = () => request(base, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: mutationHeaders(base, token),
    body: JSON.stringify({}),
  });
  const first = submit();
  const second = submit();
  await new Promise((resolve) => setTimeout(resolve, 25));
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(({ response }) => response.status), [200, 200]);
  assert.equal(reads, 1);
  assert.equal(responses.filter(({ json }) => json.data.deduplicated === false).length, 1);
  assert.equal(responses.filter(({ json }) => json.data.deduplicated === true).length, 1);
  const history = await request(base, "/api/billing/startplan/history");
  assert.equal(history.json.data.items.length, 1);
});

test("failed refresh keeps the previous successful snapshot and does not retry", async (t) => {
  let reads = 0;
  const fixture = await makeServer(t, {
    startPlanCooldownMs: 60_000,
    readStartPlanBilling: async () => {
      reads += 1;
      if (reads === 1) return readerResult(officialPayload());
      const error = new Error("Official Start Plan authentication was rejected.");
      error.code = "startplan_billing_unauthorized";
      throw error;
    },
  });
  const base = fixture.address.origin;
  const { csrf_token: token } = await session(base);
  const submit = () => request(base, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: mutationHeaders(base, token),
    body: JSON.stringify({}),
  });
  const first = await submit();
  assert.equal(first.response.status, 200);
  const second = await submit();
  assert.equal(second.response.status, 429);
  assert.equal(second.json.error.code, "STARTPLAN_REFRESH_COOLDOWN");
  assert.equal(reads, 1);
  const latest = await request(base, "/api/billing/startplan/latest");
  assert.equal(latest.json.data.available, true);
  assert.equal(latest.json.data.snapshot.remaining_balance, 299_897_316);
});

test("upstream failures are bounded, redacted, and never overwrite history", async (t) => {
  let fail = false;
  const fixture = await makeServer(t, {
    readStartPlanBilling: async () => {
      if (!fail) return readerResult(officialPayload());
      const error = new Error("Bearer private-secret at C:\\Users\\Sandy\\secret.txt");
      error.code = "startplan_billing_unauthorized";
      throw error;
    },
  });
  const base = fixture.address.origin;
  const { csrf_token: token } = await session(base);
  const submit = () => request(base, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: mutationHeaders(base, token),
    body: JSON.stringify({}),
  });
  assert.equal((await submit()).response.status, 200);
  fail = true;
  const failed = await submit();
  assert.equal(failed.response.status, 502);
  assert.doesNotMatch(failed.text, /private-secret|Sandy/u);
  const history = await request(base, "/api/billing/startplan/history");
  assert.equal(history.json.data.items.length, 1);
});

test("history supports bounded date filters and rejects arbitrary refresh input", async (t) => {
  let capturedAt = "2026-11-18T23:00:00.000Z";
  const fixture = await makeServer(t, {
    readStartPlanBilling: async () => readerResult(
      officialPayload({
        used: capturedAt.endsWith("23:00:00.000Z") ? 1 : 2,
        serverTime: capturedAt,
        periodEnd: "2026-11-20T01:00:00.000Z",
      }),
      capturedAt,
    ),
  });
  const base = fixture.address.origin;
  const { csrf_token: token } = await session(base);
  const submit = (body = {}) => request(base, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: mutationHeaders(base, token),
    body: JSON.stringify(body),
  });
  assert.equal((await submit()).response.status, 200);
  capturedAt = "2026-11-19T00:00:01.000Z";
  assert.equal((await submit()).response.status, 200);
  const filtered = await request(
    base,
    "/api/billing/startplan/history?from=2026-11-19T00%3A00%3A00.000Z&limit=1",
  );
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.json.data.items.length, 1);
  assert.equal(filtered.json.data.total, 1);
  const invalidRange = await request(
    base,
    "/api/billing/startplan/history?from=2026-11-20&to=2026-11-19",
  );
  assert.equal(invalidRange.response.status, 400);
  const arbitrary = await submit({ dataBaseDir: "C:\\Users\\Synthetic" });
  assert.equal(arbitrary.response.status, 400);
  assert.equal(arbitrary.json.error.code, "STARTPLAN_REFRESH_INPUT_REJECTED");
});

test("multi-unit balances remain separate and expose unknown aggregate values", async (t) => {
  const fixture = await makeServer(t, {
    readStartPlanBilling: async () => readerResult(officialPayload({ mixedUnits: true })),
  });
  const base = fixture.address.origin;
  const { csrf_token: token } = await session(base);
  const refreshed = await request(base, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: mutationHeaders(base, token),
    body: JSON.stringify({}),
  });
  assert.equal(refreshed.response.status, 200);
  const snapshot = refreshed.json.data.snapshot;
  assert.ok(Array.isArray(snapshot.buckets), JSON.stringify(refreshed.json));
  assert.equal(snapshot.buckets.length, 2);
  assert.equal(snapshot.total_balance, null);
  assert.equal(snapshot.remaining_balance, null);
  assert.ok(snapshot.missing_fields.includes("unambiguous_unit_type"));
});

test("expired storage is marked EXPIRED without being converted into a live balance", async (t) => {
  const fixture = await makeServer(t, {
    now: () => new Date("2026-11-19T02:00:00.000Z"),
    readStartPlanBilling: async () => readerResult(officialPayload()),
  });
  const base = fixture.address.origin;
  const { csrf_token: token } = await session(base);
  assert.equal((await request(base, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: mutationHeaders(base, token),
    body: JSON.stringify({}),
  })).response.status, 200);
  const latest = await request(base, "/api/billing/startplan/latest");
  assert.equal(latest.json.data.snapshot.freshness.status, "EXPIRED");
});

test("Start Plan refresh requires the existing same-origin CSRF gate", async (t) => {
  let reads = 0;
  const fixture = await makeServer(t, {
    readStartPlanBilling: async () => {
      reads += 1;
      return readerResult(officialPayload());
    },
  });
  const rejected = await request(fixture.address.origin, "/api/billing/startplan/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(rejected.response.status, 403);
  assert.equal(reads, 0);
});
