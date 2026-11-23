import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import {
  CONFIRMATION_PHRASE,
  PROJECT_ROOT,
  createCostLabWebServer,
  isLoopbackAddress,
} from "../web-server.mjs";
import { buildSnapshotEnvelope } from "../coding-plan-billing.mjs";
import { redactValue } from "../web-services.mjs";

const RUN_ROOT = path.join(PROJECT_ROOT, ".run");
const FIXED_ID = "00000000-0000-4000-8000-000000000001";

function zeroArrays() {
  return Array.from({ length: 24 }, () => 0);
}

function modelRow(values = {}) {
  const row = {
    modelName: "GLM-5.3-Flash",
    totalTokens: 0,
    totalCredits: 0,
    cachedInputTokensUsage: zeroArrays(),
    uncachedInputTokensUsage: zeroArrays(),
    outputTokensUsage: zeroArrays(),
    cachedInputCreditsUsage: zeroArrays(),
    uncachedInputCreditsUsage: zeroArrays(),
    outputCreditsUsage: zeroArrays(),
  };
  const {
    cachedInputTokens = 0,
    uncachedInputTokens = 0,
    outputTokens = 0,
    cachedInputCredits = 0,
    uncachedInputCredits = 0,
    outputCredits = 0,
    hour = 10,
  } = values;
  row.cachedInputTokensUsage[hour] = cachedInputTokens;
  row.uncachedInputTokensUsage[hour] = uncachedInputTokens;
  row.outputTokensUsage[hour] = outputTokens;
  row.cachedInputCreditsUsage[hour] = cachedInputCredits;
  row.uncachedInputCreditsUsage[hour] = uncachedInputCredits;
  row.outputCreditsUsage[hour] = outputCredits;
  row.totalTokens = cachedInputTokens + uncachedInputTokens + outputTokens;
  row.totalCredits = cachedInputCredits + uncachedInputCredits + outputCredits;
  return row;
}

function snapshot(row, capturedAt) {
  const xTime = zeroArrays().map((_, hour) => `${String(hour).padStart(2, "0")}:00:00`);
  return buildSnapshotEnvelope({
    result: {
      snapshot: {
        rangeStartDate: "2026-11-17",
        rangeEndDate: "2026-11-17",
        sourceProvider: {
          id: "account:bigmodel-individual-coding-plan",
          name: "BigModel - Coding Plan",
        },
        quota: { level: "lite", limits: [] },
        modelUsage: {
          xTime,
          granularity: "hour",
          modelDataList: [row],
          costLabBillingSource: { xTime, modelDataList: [row] },
        },
      },
      identity: { apiKeyId: "synthetic-key-id" },
    },
    providerId: "account:bigmodel-individual-coding-plan",
    query: { range: "today", timeZone: "Asia/Shanghai" },
    capturedAt,
  });
}

function environment() {
  return {
    schema_version: 1,
    kind: "cost_lab_environment",
    generated_at: "2026-11-17T10:00:00.000Z",
    host: {
      platform: "win32",
      arch: "x64",
      node_version: "24.16.0",
      node_compatible: true,
      supported: true,
    },
    zcode: {
      installed: true,
      install_source: "LOCALAPPDATA",
      install_root_fingerprint: "f".repeat(64),
      runtime_status: "OFFICIAL_RUNTIME_VERIFIED",
      discount_status: "OFFICIAL_DISCOUNT_VERIFIED",
      version: "3.18.2.10443",
      appserver_protocol: "app-server --stdio --surface desktop",
      request_security_capability: "OfficialRequestSecurity",
      assets: {
        bundle: {
          status: "VERIFIED",
          bytes: 15_675_386,
          sha256: "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c",
        },
      },
    },
    billing_reader: { status: "PASS", accessor: "usageStatsService.getCodingPlanUsageSnapshot" },
    credential_readability: { status: "AVAILABLE", content_read: false },
    resource_isolation: {
      status: "PASS",
      server_binding: "127.0.0.1_ONLY",
      model_requests_on_page_load: 0,
    },
    appserver_protocol_smoke: { status: "NOT_RUN", model_requests: 0 },
    warnings: [],
  };
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Static responses are intentionally not JSON.
  }
  return { response, text, json };
}

async function makeServer(overrides = {}, historyItems = null) {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "cost-lab-web-test-"));
  const historyPath = path.join(root, "history.json");
  if (historyItems) {
    await writeFile(historyPath, JSON.stringify({ schema_version: 1, items: historyItems }));
  }
  const server = createCostLabWebServer({
    projectRoot: PROJECT_ROOT,
    historyPath,
    createId: () => FIXED_ID,
    afterRetryDelaysMs: [0],
    inspectEnvironment: async () => environment(),
    ...overrides,
  });
  const address = await server.start();
  return {
    server,
    address,
    root,
    cleanup: async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function session(base) {
  const result = await request(base, "/api/session");
  assert.equal(result.response.status, 200);
  return result.json.data;
}

function stateChangingHeaders(base, token) {
  return {
    "Content-Type": "application/json",
    Origin: base,
    "X-Cost-Lab-CSRF": token,
    "Sec-Fetch-Site": "same-origin",
  };
}

test("local server serves the real UI and performs no model request on page load", async () => {
  let runnerCalls = 0;
  const fixture = await makeServer({
    verificationRunner: async () => {
      runnerCalls += 1;
      throw new Error("should not run");
    },
  });
  try {
    const page = await request(fixture.address.origin, "/");
    assert.equal(page.response.status, 200);
    assert.match(page.text, /Cost Lab/);
    assert.match(page.response.headers.get("content-security-policy"), /default-src 'self'/);
    const environmentResult = await request(fixture.address.origin, "/api/environment");
    assert.equal(environmentResult.response.status, 200);
    assert.equal(environmentResult.json.data.zcode.runtime_status, "OFFICIAL_RUNTIME_VERIFIED");
    assert.equal(environmentResult.json.data.credential_readability.status, "AVAILABLE");
    assert.equal(runnerCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("mounted Cost Lab APIs reuse the Console origin and Authority evidence root", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "cost-lab-mounted-"));
  const evidenceRoot = path.join(root, ".run");
  const historyPath = path.join(evidenceRoot, "cost-lab-web", "history.json");
  const startPlanHistoryPath = path.join(evidenceRoot, "cost-lab-web", "startplan-history.json");
  const app = createCostLabWebServer({
    projectRoot: path.join(root, "package"),
    evidenceRoot,
    historyPath,
    startPlanHistoryPath,
    apiMountPath: "/api/cost-lab",
    inspectEnvironment: async () => environment(),
  });
  const host = http.createServer((request, response) => {
    void app.handleRequest(request, response).catch((error) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { message: error.message } }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      host.once("error", reject);
      host.listen(0, "127.0.0.1", resolve);
    });
    const address = host.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    await app.mountEndpoints({ origin, port: address.port });

    const result = await request(origin, "/api/cost-lab/session");
    assert.equal(result.response.status, 200);
    assert.equal(result.json.data.provider, "account:bigmodel-individual-coding-plan");
    const environmentResult = await request(origin, "/api/cost-lab/environment");
    assert.equal(environmentResult.response.status, 200);
    assert.equal(environmentResult.json.data.zcode.runtime_status, "OFFICIAL_RUNTIME_VERIFIED");
  } finally {
    await app.close();
    await new Promise((resolve) => host.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("state-changing APIs reject missing CSRF, foreign origins, and arbitrary billing input", async () => {
  const fixture = await makeServer();
  try {
    const current = await session(fixture.address.origin);
    const missingCsrf = await request(fixture.address.origin, "/api/environment/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.address.origin,
      },
      body: JSON.stringify({ deep: false }),
    });
    assert.equal(missingCsrf.response.status, 403);
    assert.equal(missingCsrf.json.error.code, "COST_LAB_CSRF_REJECTED");

    const foreignOrigin = await request(fixture.address.origin, "/api/environment/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.invalid",
        "X-Cost-Lab-CSRF": current.csrf_token,
      },
      body: JSON.stringify({ deep: false }),
    });
    assert.equal(foreignOrigin.response.status, 403);

    const arbitrary = await request(fixture.address.origin, "/api/billing/snapshot", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({ dataRoot: "C:\\Users\\Synthetic" }),
    });
    assert.equal(arbitrary.response.status, 400);
    assert.equal(arbitrary.json.error.code, "BILLING_INPUT_REJECTED");
  } finally {
    await fixture.cleanup();
  }
});

test("real verification is explicit, reconciles mocked before/after billing, and persists redacted history", async () => {
  const before = snapshot(modelRow(), "2026-11-17T02:00:00.000Z");
  const after = snapshot(modelRow({
    cachedInputTokens: 64,
    uncachedInputTokens: 13_291,
    outputTokens: 47,
    cachedInputCredits: 0.00120064,
    uncachedInputCredits: 1.02407155,
    outputCredits: 0.012596,
  }), "2026-11-17T02:04:00.000Z");
  let captureCalls = 0;
  let runnerCalls = 0;
  const fixture = await makeServer({
    captureSnapshot: async () => {
      captureCalls += 1;
      return captureCalls === 1 ? before : after;
    },
    verificationRunner: async () => {
      runnerCalls += 1;
      return {
        model_requests: 1,
        hour: 10,
        usage: {
          model: "GLM-5.3-Flash",
          cached_input_tokens: 64,
          uncached_input_tokens: 13_291,
          output_tokens: 47,
          total_tokens: 13_402,
          access_token: "must-not-leak",
        },
        runtime_evidence: {
          status: "PASS",
          temporary_path: "C:\\Users\\Sandy\\private",
          request_security: "OfficialRequestSecurity",
        },
      };
    },
  });
  try {
    const current = await session(fixture.address.origin);
    const started = await request(fixture.address.origin, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
      }),
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.json.data.id, FIXED_ID);

    let record = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const polled = await request(fixture.address.origin, `/api/verifications/${FIXED_ID}`);
      record = polled.json.data;
      if (record.status === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(record.status, "SUCCEEDED", JSON.stringify(record.error));
    assert.equal(record.reconciliation.token_match, true);
    assert.equal(record.reconciliation.credit_class, "EXTRA_0_67");
    assert.equal(record.request_usage.access_token, "<redacted>");
    assert.equal(record.runtime_evidence.temporary_path, "<redacted-path>");
    assert.equal(runnerCalls, 1);
    assert.equal(captureCalls, 2);

    const exported = await request(fixture.address.origin, `/api/history/${FIXED_ID}/export`);
    assert.equal(exported.response.status, 200);
    assert.match(exported.response.headers.get("content-disposition"), /attachment/u);
    assert.doesNotMatch(exported.text, /must-not-leak/);
    assert.doesNotMatch(exported.text, /C:\\\\Users\\\\Sandy/u);
    assert.match(exported.text, /<redacted-path>/u);

    const persisted = JSON.parse(await readFile(path.join(fixture.root, "history.json"), "utf8"));
    assert.equal(persisted.items[0].id, FIXED_ID);
    assert.equal(persisted.items[0].status, "SUCCEEDED");
  } finally {
    await fixture.cleanup();
  }
});

test("failed runner evidence is retained and still reconciled for billing attribution", async () => {
  const before = snapshot(modelRow(), "2026-11-17T02:00:00.000Z");
  const after = snapshot(modelRow({
    cachedInputTokens: 64,
    uncachedInputTokens: 13_291,
    outputTokens: 47,
    cachedInputCredits: 0.00120064,
    uncachedInputCredits: 1.02407155,
    outputCredits: 0.012596,
  }), "2026-11-17T02:04:00.000Z");
  let captureCalls = 0;
  let observedTaskMode = null;
  const fixture = await makeServer({
    captureSnapshot: async () => {
      captureCalls += 1;
      return captureCalls === 1 ? before : after;
    },
    verificationRunner: async ({ taskMode }) => {
      observedTaskMode = taskMode;
      const error = new Error("bridge_code_edit_unverified");
      error.code = "COST_LAB_RESULT_VALIDATION_FAILED";
      error.evidence = {
        status: "UNVERIFIED",
        model_requests: 1,
        hour: 10,
        usage: {
          model: "GLM-5.3-Flash",
          cached_input_tokens: 64,
          uncached_input_tokens: 13_291,
          output_tokens: 47,
          total_tokens: 13_402,
        },
        workspace_evidence: { content_changed: false, content_match: false },
      };
      throw error;
    },
  });
  try {
    const current = await session(fixture.address.origin);
    const started = await request(fixture.address.origin, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
        task_mode: "code_edit",
      }),
    });
    assert.equal(started.response.status, 202);

    let record = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const polled = await request(fixture.address.origin, `/api/verifications/${FIXED_ID}`);
      record = polled.json.data;
      if (record.status === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(record.status, "FAILED");
    assert.equal(record.error.code, "VERIFICATION_FAILED");
    assert.equal(record.error.message, "COST_LAB_RESULT_VALIDATION_FAILED");
    assert.equal(record.model_requests, 1);
    assert.equal(record.request_usage.total_tokens, 13_402);
    assert.equal(record.runtime_evidence.workspace_evidence.content_match, false);
    assert.equal(record.reconciliation.token_match, true);
    assert.equal(record.reconciliation.credit_class, "EXTRA_0_67");
    assert.equal(observedTaskMode, "code_edit");
    assert.equal(captureCalls, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("same-hour settlement retry waits for an observable delta instead of an hour rollover", async () => {
  const before = snapshot(modelRow(), "2026-11-17T02:00:00.000Z");
  const after = snapshot(modelRow({
    uncachedInputTokens: 1_000,
    outputTokens: 10,
    uncachedInputCredits: 0.23,
    outputCredits: 0.008,
  }), "2026-11-17T02:00:15.000Z");
  let captureCalls = 0;
  const fixture = await makeServer({
    afterRetryDelaysMs: [0, 0, 0],
    captureSnapshot: async () => {
      captureCalls += 1;
      if (captureCalls === 1) return before;
      if (captureCalls < 4) return snapshot(modelRow({
        uncachedInputTokens: 1_000,
        outputTokens: 10,
      }), "2026-11-17T02:00:10.000Z");
      return after;
    },
    verificationRunner: async () => ({
      model_requests: 1,
      hour: 10,
      usage: {
        model: "GLM-5.3-Flash",
        cached_input_tokens: 0,
        uncached_input_tokens: 1_000,
        output_tokens: 10,
        total_tokens: 1_010,
      },
      runtime_evidence: { status: "PASS" },
    }),
  });
  try {
    const current = await session(fixture.address.origin);
    const started = await request(fixture.address.origin, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
      }),
    });
    assert.equal(started.response.status, 202);

    let record = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const polled = await request(fixture.address.origin, `/api/verifications/${FIXED_ID}`);
      record = polled.json.data;
      if (record.status === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(record.status, "SUCCEEDED");
    assert.equal(captureCalls, 4);
    assert.equal(record.reconciliation.hour, "10:00:00");
    assert.equal(record.reconciliation.official_delta.total_tokens, 1_010);
    assert.equal(record.reconciliation.token_match, true);
  } finally {
    await fixture.cleanup();
  }
});

test("unobserved official credit delta is reported as inconclusive, not as a zero charge", async () => {
  const unchanged = snapshot(modelRow(), "2026-11-17T02:00:00.000Z");
  let captureCalls = 0;
  const fixture = await makeServer({
    afterRetryDelaysMs: [0, 0, 0],
    captureSnapshot: async () => {
      captureCalls += 1;
      return unchanged;
    },
    verificationRunner: async () => ({
      model_requests: 1,
      hour: 10,
      usage: {
        model: "GLM-5.3-Flash",
        cached_input_tokens: 0,
        uncached_input_tokens: 22_395,
        output_tokens: 101,
        total_tokens: 22_496,
      },
      runtime_evidence: { status: "PASS" },
    }),
  });
  try {
    const current = await session(fixture.address.origin);
    const started = await request(fixture.address.origin, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
      }),
    });
    assert.equal(started.response.status, 202);

    let record = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const polled = await request(fixture.address.origin, `/api/verifications/${FIXED_ID}`);
      record = polled.json.data;
      if (record.status === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(record.status, "SUCCEEDED");
    assert.equal(captureCalls, 4);
    assert.equal(record.reconciliation.settlement_status, "NO_OBSERVED_CREDIT_DELTA");
    assert.equal(record.reconciliation.billing_reconciliation, "INCONCLUSIVE");
    assert.equal(record.reconciliation.official_delta.total_credits, null);
    assert.equal(record.reconciliation.calculation.actual_credits, null);
    assert.equal(record.reconciliation.calculation.effective_extra_ratio, null);
    assert.equal(record.billing_window.after.models[0].hours[10].total_credits, 0);

    const history = await request(fixture.address.origin, "/api/history");
    assert.equal(history.response.status, 200);
    const summary = history.json.data.items.find((item) => item.id === FIXED_ID);
    assert.equal(summary.settlement_status, "NO_OBSERVED_CREDIT_DELTA");
    assert.equal(summary.actual_credits, null);
    assert.equal(summary.effective_extra_ratio, null);
    const exported = await request(fixture.address.origin, `/api/history/${FIXED_ID}/export`);
    assert.equal(exported.json.verification.reconciliation.settlement_status, "NO_OBSERVED_CREDIT_DELTA");
    assert.equal(exported.json.verification.reconciliation.calculation.actual_credits, null);
  } finally {
    await fixture.cleanup();
  }
});

test("persisted legacy history cannot confirm a charge from padded display data", async () => {
  const before = snapshot(modelRow(), "2026-11-17T02:01:00.000Z");
  const after = snapshot(modelRow({
    uncachedInputTokens: 10_000,
    uncachedInputCredits: 0.7705,
  }), "2026-11-17T02:02:00.000Z");
  delete before.official_snapshot.modelUsage.costLabBillingSource;
  delete after.official_snapshot.modelUsage.costLabBillingSource;
  const requestUsage = {
    model: "GLM-5.3-Flash",
    cached_input_tokens: 0,
    uncached_input_tokens: 10_000,
    output_tokens: 0,
    total_tokens: 10_000,
  };
  const fixture = await makeServer({}, [{
    id: FIXED_ID,
    status: "SUCCEEDED",
    model: requestUsage.model,
    request_usage: requestUsage,
    billing_window: { before, after },
    reconciliation: {
      schema_version: 1,
      hour: "10:00:00",
      billing_reconciliation: "PASS",
      credit_class: "EXTRA_0_67",
      calculation: { actual_credits: 0.7705, effective_extra_ratio: 0.67 },
    },
  }]);
  try {
    const exported = await request(fixture.address.origin, `/api/history/${FIXED_ID}/export`);
    assert.equal(exported.response.status, 200);
    const reconciliation = exported.json.verification.reconciliation;
    assert.equal(reconciliation.billing_reconciliation, "INCONCLUSIVE");
    assert.equal(reconciliation.settlement_status, "INVALID_BILLING_DATA");
    assert.equal(reconciliation.calculation.actual_credits, null);
    const history = await request(fixture.address.origin, "/api/history");
    assert.equal(history.json.data.items[0].actual_credits, null);
    assert.equal(history.json.data.items[0].effective_extra_ratio, null);
  } finally {
    await fixture.cleanup();
  }
});

test("verification admission rejects a history write failure before dispatch", async () => {
  let runnerCalls = 0;
  const fixture = await makeServer({
    verificationRunner: async () => { runnerCalls += 1; },
  });
  try {
    const current = await session(fixture.address.origin);
    await mkdir(path.join(fixture.root, "history.json"));
    const started = await request(fixture.address.origin, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
      }),
    });
    assert.equal(started.response.status, 500);
    assert.equal(runnerCalls, 0);
    assert.equal((await session(fixture.address.origin)).active_verification_id, null);
    const history = await request(fixture.address.origin, "/api/history");
    assert.deepEqual(history.json.data.items, []);
  } finally {
    await fixture.cleanup();
  }
});

test("deep environment checks require explicit authorization and return no model requests", async () => {
  const fixture = await makeServer({
    inspectEnvironment: async ({ deep = false, protocolSmoke = null } = {}) => {
      const result = environment();
      if (deep && typeof protocolSmoke === "function") {
        const smoke = await protocolSmoke({ modelRequests: 0 });
        result.appserver_protocol_smoke = {
          status: smoke.status,
          duration_ms: smoke.duration_ms ?? null,
          model_requests: 0,
          evidence: smoke.evidence ?? null,
        };
      }
      return result;
    },
    protocolSmoke: async () => ({
      status: "PASS",
      duration_ms: 25,
      evidence: { session_created: true, model_requests: 0 },
    }),
  });
  try {
    const current = await session(fixture.address.origin);
    const checked = await request(fixture.address.origin, "/api/environment/check", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({ deep: true }),
    });
    assert.equal(checked.response.status, 200);
    assert.equal(checked.json.data.appserver_protocol_smoke.status, "PASS");
    assert.equal(checked.json.data.appserver_protocol_smoke.model_requests, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("the local server cannot be broadened to a wildcard bind", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "cost-lab-web-bind-test-"));
  const server = createCostLabWebServer({
    projectRoot: PROJECT_ROOT,
    historyPath: path.join(root, "history.json"),
    host: "0.0.0.0",
    inspectEnvironment: async () => environment(),
  });
  try {
    const address = await server.start();
    assert.equal(address.host, "127.0.0.1");
    assert.equal(address.origin.startsWith("http://127.0.0.1:"), true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("simultaneous confirmations admit one durable verification and one dispatch", async () => {
  let runnerCalls = 0;
  let runnerStarted;
  const started = new Promise((resolve) => { runnerStarted = resolve; });
  const fixture = await makeServer({
    captureSnapshot: async () => snapshot(modelRow(), "2026-11-17T02:00:00.000Z"),
    verificationRunner: async ({ signal }) => {
      runnerCalls += 1;
      runnerStarted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return {};
    },
  });
  try {
    const base = fixture.address.origin;
    const { csrf_token: token } = await session(base);
    const submit = () => request(base, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(base, token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
      }),
    });
    const responses = await Promise.all([submit(), submit()]);
    assert.deepEqual(responses.map(({ response }) => response.status).sort(), [202, 409]);
    await started;
    const history = JSON.parse(await readFile(path.join(fixture.root, "history.json"), "utf8"));
    assert.deepEqual(history.items.map(({ id }) => id), [FIXED_ID]);
    assert.equal(runnerCalls, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("server shutdown aborts and awaits an active verification cleanup", async () => {
  let aborted = 0;
  let cleaned = 0;
  let markRunnerStarted;
  const runnerStarted = new Promise((resolve) => {
    markRunnerStarted = resolve;
  });
  const before = snapshot(modelRow(), "2026-11-17T02:00:00.000Z");
  const fixture = await makeServer({
    captureSnapshot: async () => before,
    verificationRunner: async ({ signal }) => {
      markRunnerStarted();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted += 1;
          setTimeout(() => {
            cleaned += 1;
            reject(new Error("verification_aborted"));
          }, 20);
        }, { once: true });
      });
    },
  });
  try {
    const current = await session(fixture.address.origin);
    const started = await request(fixture.address.origin, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
      }),
    });
    assert.equal(started.response.status, 202);
    await runnerStarted;
    await fixture.server.close();
    assert.equal(aborted, 1);
    assert.equal(cleaned, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("shutdown closes admission and reports a pending runner cleanup timeout", async () => {
  let markRunnerStarted;
  let finishCleanup;
  const runnerStarted = new Promise((resolve) => { markRunnerStarted = resolve; });
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const fixture = await makeServer({
    captureSnapshot: async () => snapshot(modelRow(), "2026-11-17T02:00:00.000Z"),
    verificationRunner: async () => {
      markRunnerStarted();
      await cleanup;
      throw new Error("verification_aborted");
    },
  });
  try {
    const current = await session(fixture.address.origin);
    const started = await request(fixture.address.origin, "/api/verifications", {
      method: "POST",
      headers: stateChangingHeaders(fixture.address.origin, current.csrf_token),
      body: JSON.stringify({
        confirmation: CONFIRMATION_PHRASE,
        provider: "account:bigmodel-individual-coding-plan",
        model: "GLM-5.3-Flash",
        reasoning: "low",
      }),
    });
    assert.equal(started.response.status, 202);
    await runnerStarted;
    await assert.rejects(fixture.server.close({ timeoutMs: 25 }), /cost_lab_verification_shutdown_timeout/u);
    await assert.rejects(fetch(`${fixture.address.origin}/api/health`));
    const readHistory = async () => JSON.parse(await readFile(path.join(fixture.root, "history.json"), "utf8"));
    const pending = (await readHistory()).items[0];
    assert.equal(pending.status, "MODEL_REQUESTED");
    assert.equal(pending.model_requests, null);
    finishCleanup();
    await fixture.server.close();
    const final = (await readHistory()).items[0];
    assert.equal(final.status, "INTERRUPTED");
    assert.equal(final.model_requests, null);
  } finally {
    finishCleanup();
    await fixture.cleanup();
  }
});

test("embedded absolute paths are redacted from strings and errors", () => {
  const windows = redactValue("failed at C:\\Users\\Sandy\\private\\file.txt while reading");
  assert.match(windows, /^failed at <redacted-path>/u);
  assert.doesNotMatch(windows, /Sandy|private\\file/u);
  assert.equal(
    redactValue("failed at /home/sandy/private/file.txt while reading"),
    "failed at <redacted-path> while reading",
  );
});

test("loopback validation and cleanup do not broaden local access", async () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.25"), false);
  assert.equal(isLoopbackAddress("0.0.0.0"), false);

  const fixture = await makeServer();
  const origin = fixture.address.origin;
  await fixture.server.close();
  await assert.rejects(fetch(`${origin}/api/health`));
  await fixture.cleanup();
});
