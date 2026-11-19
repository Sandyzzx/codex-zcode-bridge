import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PROJECT_ROOT } from "../web-server.mjs";
import {
  assertOfficialStartPlanBillingRequest,
  readOfficialStartPlanBilling,
} from "../startplan-reader.mjs";

const RUN_ROOT = path.join(PROJECT_ROOT, ".run");

function payload() {
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
        unit_type: "token",
        capabilities: ["model:glm-5.3-flash"],
        total_units: 300_000_000,
        used_units: 102_684,
        remaining_units: 299_897_316,
        period_start: Date.parse("2026-11-18T14:14:19.000Z") / 1_000,
        period_end: Date.parse("2026-11-19T01:00:00.000Z") / 1_000,
        expires_at: Date.parse("2026-11-19T01:00:00.000Z") / 1_000,
      }],
    },
  };
}

class FakeEntitlement {
  constructor({ fetchImpl }) {
    this.fetchImpl = fetchImpl;
  }

  async check(input) {
    const response = await this.fetchImpl(
      "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.18.2",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.jwt}`,
          "X-Device-Mid": input.deviceMid,
          "X-ZCode-App-Version": "3.18.2",
        },
        signal: input.signal,
      },
    );
    await response.clone().json();
    return {
      status: response.status === 200 ? "entitled" : "unauthorized",
      observedAt: Date.now(),
      requestId: "private-request",
    };
  }
}

async function fixture(t, responseFactory) {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "startplan-reader-test-"));
  const dataBaseDir = path.join(root, "data");
  const credentials = path.join(dataBaseDir, ".zcode", "v2", "credentials.json");
  const worker = path.join(root, "worker-main.mjs");
  await mkdir(path.dirname(credentials), { recursive: true });
  await writeFile(credentials, "opaque-credential-fixture", "utf8");
  await writeFile(worker, "export {};\n", "utf8");
  const calls = [];
  const dependencies = {
    StartPlanBillingEntitlement: FakeEntitlement,
    loadOfficialHostProductVersion: async () => "3.18.2",
    loadOfficialStartPlanAuthenticationResolverFactory: async () => () => ({
      resolveStartPlanAuthentication: async () => ({
        accountIdentity: "private-account",
        requestCredential: "header.payload.signature",
        deviceMid: "private-device-mid",
      }),
    }),
  };
  const transportFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responseFactory(url, init);
  };
  return {
    root,
    dataBaseDir,
    credentials,
    worker,
    calls,
    dependencies,
    transportFetch,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("official request guard accepts only the exact read-only billing GET", () => {
  assert.deepEqual(assertOfficialStartPlanBillingRequest(
    {
      url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.18.2",
      init: { method: "GET" },
    },
    "3.18.2",
  ), {
    method: "GET",
    origin: "https://zcode.z.ai",
    path: "/api/v1/zcode-plan/billing/balance",
    query_keys: ["app_version"],
    app_version: "3.18.2",
  });
  assert.throws(() => assertOfficialStartPlanBillingRequest({
    url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.18.2&mid=private",
    init: { method: "GET" },
  }, "3.18.2"), /query_invalid|query/i);
});

test("reader performs one official GET, preserves credentials, and returns sanitized evidence", async (t) => {
  const data = await fixture(t, async () => new Response(JSON.stringify(payload()), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "private-request",
    },
  }));
  try {
    const result = await readOfficialStartPlanBilling({
      projectRoot: PROJECT_ROOT,
      dataBaseDir: data.dataBaseDir,
      officialHostWorker: data.worker,
      officialDependencies: data.dependencies,
      transportFetch: data.transportFetch,
      now: Date.parse("2026-11-19T00:58:15.267Z"),
    });
    assert.equal(data.calls.length, 1);
    const requestUrl = new URL(data.calls[0].url);
    assert.equal(requestUrl.origin, "https://zcode.z.ai");
    assert.deepEqual([...requestUrl.searchParams.keys()], ["app_version"]);
    assert.equal(requestUrl.searchParams.get("app_version"), "3.18.2");
    assert.equal(result.snapshot.total_balance, 300_000_000);
    assert.equal(result.snapshot.process.model_requests_triggered, 0);
    assert.equal(result.metadata.process.official_billing_get_attempts, 1);
    assert.equal(result.metadata.state.credentials_unchanged, true);
    assert.equal(result.metadata.state.keyring_lock_released, true);
    assert.equal(await readFile(data.credentials, "utf8"), "opaque-credential-fixture");
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(
      serialized,
      /private-account|private-user-plan|private-bucket|private-entitlement|private-device-mid|private-request|header\.payload\.signature/u,
    );
  } finally {
    await data.cleanup();
  }
});

test("reader returns one bounded timeout without retry", async (t) => {
  let calls = 0;
  const data = await fixture(t, async (_url, init) => {
    calls += 1;
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  try {
    await assert.rejects(
      readOfficialStartPlanBilling({
        projectRoot: PROJECT_ROOT,
        dataBaseDir: data.dataBaseDir,
        officialHostWorker: data.worker,
        officialDependencies: data.dependencies,
        transportFetch: data.transportFetch,
        timeoutMs: 20,
      }),
      (error) => error?.code === "startplan_billing_timeout",
    );
    assert.equal(calls, 1);
  } finally {
    await data.cleanup();
  }
});

test("reader maps 401 and 429 to stable failure codes after one attempt", async (t) => {
  for (const [status, code] of [[401, "startplan_billing_unauthorized"], [429, "startplan_billing_rate_limited"]]) {
    const data = await fixture(t, async () => new Response(JSON.stringify({ code: status }), {
      status,
      headers: { "content-type": "application/json" },
    }));
    try {
      await assert.rejects(
        readOfficialStartPlanBilling({
          projectRoot: PROJECT_ROOT,
          dataBaseDir: data.dataBaseDir,
          officialHostWorker: data.worker,
          officialDependencies: data.dependencies,
          transportFetch: data.transportFetch,
          now: Date.parse("2026-11-19T00:58:15.267Z"),
        }),
        (error) => error?.code === code,
      );
      assert.equal(data.calls.length, 1);
    } finally {
      await data.cleanup();
    }
  }
});
