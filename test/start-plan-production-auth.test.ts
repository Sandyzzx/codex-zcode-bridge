import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyEntitlementFailure,
  createProductionStartPlanAuth,
  readStartPlanEntitlementFailureFacts,
  readOfficialCliVersion,
  StartPlanBillingEntitlement,
  type OfficialStartPlanAuthentication,
  type OfficialStartPlanAuthenticationResolver,
} from "../src/runtime/start-plan-production-auth.js";
import { NodeRuntimeResolver } from "../src/runtime/resolver.js";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { BridgeError } from "../src/runtime/errors.js";
import { makeWorkspace, validReport, TEMP_TREE_REMOVE_OPTIONS } from "./helpers.js";
import type { PrivateLeaseBinding } from "../src/runtime/start-plan-private-lease.js";
import type { ZCodeRuntimeConfig } from "../src/interfaces.js";
import type { FailureFactsV1 } from "../src/diagnostics/failure-facts.js";
import { appendStartPlanEntitlementFailureFacts } from "../src/store/lifecycle-gate.js";
import type { CandidateTaskResult } from "../src/sqlite-candidate/wp6c/fake-result-adapter.js";

const DEVICE_ID = "synthetic-device-mid-fixed";
const ACCOUNT_A = "synthetic-account-a";
const ACCOUNT_B = "synthetic-account-b";
const MODEL = "glm-5.3-flash";

function makeRoot(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => {
      TEST_AUTH.delete(root);
      rmSync(root, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS });
    },
  };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function syntheticJwt(payload: Record<string, unknown> = {}): string {
  return `${base64url({ alg: "synthetic" })}.${base64url(payload)}.synthetic-signature`;
}

const TEST_AUTH = new Map<string, OfficialStartPlanAuthentication | null>();

function writeCredential(
  zcodeRoot: string,
  options: {
    jwt?: string;
    account?: string;
    deviceMid?: string | null;
    credentialExpiresAt?: number | null;
  } = {},
): void {
  const jwt = options.jwt ?? syntheticJwt({ account: ACCOUNT_A, exp: 4_000 });
  const account = options.account ?? ACCOUNT_A;
  TEST_AUTH.set(zcodeRoot, {
    accountIdentity: account,
    sessionRevision: null,
    requestCredential: jwt,
    credentialExpiresAt: options.credentialExpiresAt ?? null,
    deviceMid: options.deviceMid === null ? "" : options.deviceMid ?? DEVICE_ID,
  });
}

function clearCredential(zcodeRoot: string): void {
  TEST_AUTH.delete(zcodeRoot);
}

function authResolver(
  root: string,
  transform?: (
    value: OfficialStartPlanAuthentication | null,
  ) => OfficialStartPlanAuthentication | null,
): OfficialStartPlanAuthenticationResolver {
  return {
    resolveStartPlanAuthentication: async () => {
      const value = TEST_AUTH.get(root) ?? null;
      return transform ? transform(value) : value;
    },
  };
}

function billingBody(overrides: {
  success?: unknown;
  code?: unknown;
  plans?: unknown;
  balances?: unknown;
  serverTime?: unknown;
} = {}): Record<string, unknown> {
  return {
    ...(overrides.success === undefined ? {} : { success: overrides.success }),
    ...(overrides.code === undefined ? {} : { code: overrides.code }),
    data: {
      plans: overrides.plans ?? [{
        status: "active",
        plan_id: "synthetic-start-plan",
        name: "Synthetic Start Plan",
      }],
      balances: overrides.balances ?? [{
        plan_id: "synthetic-start-plan",
        capabilities: [`model:${MODEL}`],
        remaining_units: 7,
      }],
      ...(overrides.serverTime === undefined ? {} : { server_time: overrides.serverTime }),
    },
  };
}

function fakeBillingFetch(
  body: unknown,
  status = 200,
  requestId?: string,
): { fetch: typeof fetch; requests: Array<{ url: string; headers: Headers }> } {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    const headers = new Headers(requestId ? { "x-request-id": requestId } : undefined);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch: fetchImpl, requests };
}

function binding(overrides: Partial<PrivateLeaseBinding> = {}): PrivateLeaseBinding {
  return {
    account: ACCOUNT_A,
    provider: "account:bigmodel-start-plan",
    model: MODEL,
    task: "synthetic-task",
    attempt: 1,
    operation: "synthetic-operation",
    generation: 1,
    claim: "synthetic-claim",
    session: "synthetic-session",
    turn: "synthetic-turn",
    pid: process.pid,
    creation: "synthetic-exact-creation",
    ...overrides,
  };
}

test("discovers the official runtime without ZCODE_BRIDGE_ZCODE_CJS and runs its --version", async () => {
  const { root, cleanup } = makeRoot("start-plan-version-discovery-");
  try {
    const install = path.join(root, "ZCode");
    mkdirSync(path.join(install, "resources", "glm"), { recursive: true });
    mkdirSync(path.join(install, "resources", "config", "provider"), { recursive: true });
    const entrypoint = path.join(install, "resources", "glm", "zcode.cjs");
    const builtin = path.join(install, "resources", "config", "provider", "zcode-builtin.json");
    const personal = path.join(root, "personal.json");
    writeFileSync(entrypoint, "if (process.argv[2] === '--version') process.stdout.write('3.17.4\\n');\n");
    writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, revision: 1, config: {} }));
    writeFileSync(personal, JSON.stringify({
      schemaVersion: 1,
      config: { providerConfigRules: { providerRules: [{ providerId: "account:synthetic" }] } },
    }));

    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_WINDOWS_APP_INSTALL_DIR: install,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_BRIDGE_DATA_DIR: path.join(root, "bridge-sqlite-data"),
      },
      homeDir: path.join(root, "home"),
      packageRoot: root,
    });
    const config = await resolver.resolve();
    assert.equal(config.zcodeEntrypoint, entrypoint);
    assert.equal(await readOfficialCliVersion(config.zcodeEntrypoint), "3.17.4");
  } finally {
    cleanup();
  }
});

test("HTTP 200 alone is not entitlement evidence", async () => {
  const cases: Array<{
    name: string;
    body: unknown;
    expected: string;
  }> = [
    { name: "empty plans", body: billingBody({ plans: [], balances: [] }), expected: "no_entitlement" },
    {
      name: "unknown active plan",
      body: billingBody({ plans: [{ status: "active", plan_id: "other-plan", name: "Other Plan" }] }),
      expected: "no_entitlement",
    },
    { name: "business rejection", body: billingBody({ success: false, code: 4001 }), expected: "unavailable" },
    {
      name: "model not authorized",
      body: billingBody({
        balances: [{ plan_id: "synthetic-start-plan", capabilities: ["model:another-synthetic-model"], remaining_units: 7 }],
      }),
      expected: "model_unavailable",
    },
    { name: "invalid JSON", body: "{not-json", expected: "unavailable" },
  ];
  for (const item of cases) {
    const { fetch: fetchImpl, requests } = fakeBillingFetch(item.body);
    const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
    const verdict = await entitlement.check({
      account: ACCOUNT_A,
      provider: "account:bigmodel-start-plan",
      model: MODEL,
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt(),
      signal: new AbortController().signal,
    });
    assert.equal(verdict.status, item.expected, item.name);
    assert.notEqual(verdict.status, "entitled");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.17.4");
    assert.equal(requests[0]!.headers.get("x-device-mid"), DEVICE_ID);
    assert.match(requests[0]!.headers.get("authorization") ?? "", /^Bearer /u);
  }
});

test("official 3.18.2 success envelope variants still require ADR-030 quota proof", async () => {
  const cases: Array<{ name: string; body: unknown }> = [
    {
      name: "missing success",
      body: (() => {
        const { success: _success, ...envelope } = billingBody();
        return envelope;
      })(),
    },
    {
      name: "code 200",
      body: billingBody({ code: 200 }),
    },
    {
      name: "null legacy success",
      body: billingBody({ success: null }),
    },
    {
      name: "non-boolean legacy success",
      body: billingBody({ success: "legacy" }),
    },
  ];
  for (const item of cases) {
    const { fetch: fetchImpl, requests } = fakeBillingFetch(item.body);
    const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
    const verdict = await entitlement.check({
      account: ACCOUNT_A,
      provider: "account:bigmodel-start-plan",
      model: MODEL,
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt(),
      signal: new AbortController().signal,
    });
    assert.equal(verdict.status, "entitled", item.name);
    assert.equal(requests.length, 1, item.name);
  }
});

test("task-level entitlement fails closed without attributable positive model quota", async () => {
  const cases: Array<{
    name: string;
    body: Record<string, unknown>;
    expectedStatus: string;
    expectedClass: string;
  }> = [
    {
      name: "active plan without identity fields",
      body: billingBody({ plans: [{ status: "active" }], balances: [] }),
      expectedStatus: "no_entitlement",
      expectedClass: "active_plan_absent",
    },
    {
      name: "no balance list",
      body: billingBody({ balances: [] }),
      expectedStatus: "unavailable",
      expectedClass: "model_quota_unproven",
    },
    {
      name: "zero remaining units",
      body: billingBody({
        balances: [{ plan_id: "synthetic-start-plan", capabilities: [`model:${MODEL}`], remaining_units: 0 }],
      }),
      expectedStatus: "quota_exhausted",
      expectedClass: "quota_exhausted",
    },
    {
      name: "missing remaining units",
      body: billingBody({
        balances: [{ plan_id: "synthetic-start-plan", capabilities: [`model:${MODEL}`] }],
      }),
      expectedStatus: "unavailable",
      expectedClass: "model_quota_unproven",
    },
    {
      name: "non-numeric remaining units",
      body: billingBody({
        balances: [{ plan_id: "synthetic-start-plan", capabilities: [`model:${MODEL}`], remaining_units: "many" }],
      }),
      expectedStatus: "unavailable",
      expectedClass: "model_quota_unproven",
    },
    {
      name: "negative remaining units",
      body: billingBody({
        balances: [{ plan_id: "synthetic-start-plan", capabilities: [`model:${MODEL}`], remaining_units: -1 }],
      }),
      expectedStatus: "unavailable",
      expectedClass: "model_quota_unproven",
    },
    {
      name: "available units cannot replace missing remaining units",
      body: billingBody({
        balances: [{
          plan_id: "synthetic-start-plan",
          capabilities: [`model:${MODEL}`],
          available_units: 9,
        }],
      }),
      expectedStatus: "unavailable",
      expectedClass: "model_quota_unproven",
    },
    {
      name: "invalid remaining units cannot be replaced by available units",
      body: billingBody({
        balances: [{
          plan_id: "synthetic-start-plan",
          capabilities: [`model:${MODEL}`],
          remaining_units: "invalid",
          available_units: 9,
        }],
      }),
      expectedStatus: "unavailable",
      expectedClass: "model_quota_unproven",
    },
    {
      name: "balance belongs to another plan",
      body: billingBody({
        balances: [{ plan_id: "another-plan", capabilities: [`model:${MODEL}`], remaining_units: 7 }],
      }),
      expectedStatus: "unavailable",
      expectedClass: "model_quota_unproven",
    },
  ];
  for (const item of cases) {
    const { fetch: fetchImpl, requests } = fakeBillingFetch(item.body);
    const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
    const verdict = await entitlement.check({
      account: ACCOUNT_A,
      provider: "account:bigmodel-start-plan",
      model: MODEL,
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt(),
      signal: new AbortController().signal,
    });
    assert.notEqual(verdict.status, "entitled", item.name);
    assert.equal(verdict.status, item.expectedStatus, item.name);
    if (verdict.status === "entitled") throw new Error("unreachable");
    assert.equal(verdict.failureFacts?.failure_class, item.expectedClass, item.name);
    assert.equal(requests.length, 1, item.name);
  }
});

test("remaining_units is authoritative while available_units reflects reservations", async () => {
  const cases: Array<{ name: string; balance: Record<string, unknown>; status: string }> = [
    {
      name: "zero remaining with positive available is exhausted",
      balance: {
        plan_id: "synthetic-start-plan",
        capabilities: [`model:${MODEL}`],
        remaining_units: 0,
        available_units: 9,
      },
      status: "quota_exhausted",
    },
    {
      name: "positive remaining with zero available remains authorized",
      balance: {
        plan_id: "synthetic-start-plan",
        capabilities: [`model:${MODEL}`],
        remaining_units: 9,
        available_units: 0,
      },
      status: "entitled",
    },
  ];
  for (const item of cases) {
    const { fetch: fetchImpl } = fakeBillingFetch(billingBody({ balances: [item.balance] }));
    const entitlement = new StartPlanBillingEntitlement({
      getAppVersion: async () => "3.18.2",
      fetchImpl,
    });
    const verdict = await entitlement.check({
      account: ACCOUNT_A,
      provider: "account:bigmodel-start-plan",
      model: MODEL,
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt(),
      signal: new AbortController().signal,
    });
    assert.equal(verdict.status, item.status, item.name);
  }
});

test("Billing uses the official product version rather than the AppServer CLI version", async () => {
  const { fetch: fetchImpl, requests } = fakeBillingFetch(billingBody());
  const entitlement = new StartPlanBillingEntitlement({
    getAppVersion: async () => "3.18.2",
    fetchImpl,
  });
  const verdict = await entitlement.check({
    account: ACCOUNT_A,
    provider: "account:bigmodel-start-plan",
    model: MODEL,
    deviceMid: DEVICE_ID,
    jwt: syntheticJwt(),
    signal: new AbortController().signal,
  });
  assert.equal(verdict.status, "entitled");
  assert.equal(
    new URL(requests[0]!.url).searchParams.get("app_version"),
    "3.18.2",
  );
  assert.equal(requests[0]!.headers.get("x-zcode-app-version"), "3.18.2");
  assert.equal(requests[0]!.headers.get("user-agent"), "ZCode/3.18.2");
});

test("official expiry and activation timing fail closed without model evidence", async () => {
  const cases: Array<{
    name: string;
    body: Record<string, unknown>;
    expectedStatus: string;
    expectedClass: string;
  }> = [
    {
      name: "expired active plan",
      body: billingBody({
        plans: [{ status: "active", plan_id: "synthetic-start-plan", ends_at: 999 }],
        balances: [{ plan_id: "synthetic-start-plan", capabilities: [`model:${MODEL}`], remaining_units: 7 }],
        serverTime: 1_000,
      }),
      expectedStatus: "no_entitlement",
      expectedClass: "active_plan_absent",
    },
    {
      name: "future activation without model evidence",
      body: billingBody({
        plans: [{ status: "active", plan_id: "synthetic-start-plan", starts_at: 1_001 }],
        balances: [],
        serverTime: 1_000,
      }),
      expectedStatus: "unavailable",
      expectedClass: "activation_pending",
    },
  ];
  for (const item of cases) {
    const { fetch: fetchImpl } = fakeBillingFetch(item.body);
    const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
    const verdict = await entitlement.check({
      account: ACCOUNT_A,
      provider: "account:bigmodel-start-plan",
      model: MODEL,
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt(),
      signal: new AbortController().signal,
    });
    assert.equal(verdict.status, item.expectedStatus, item.name);
    if (verdict.status === "entitled") throw new Error("unreachable");
    assert.equal(verdict.failureFacts?.failure_class, item.expectedClass, item.name);
    assert.equal(verdict.failureFacts?.http_status, 200, item.name);
  }
});

test("billing checks fail closed without an official device identity", async () => {
  const { fetch: fetchImpl, requests } = fakeBillingFetch(billingBody(), 200, "synthetic-request-id");
  const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
  const verdict = await entitlement.check({
    account: ACCOUNT_A,
    provider: "account:bigmodel-start-plan",
    model: MODEL,
    deviceMid: "   ",
    jwt: syntheticJwt(),
    signal: new AbortController().signal,
  });
  assert.equal(verdict.status, "unavailable");
  assert.deepEqual(verdict.failureFacts, {
    request_attempted: false,
    http_status: null,
    provider_code: null,
    failure_class: "not_attempted",
    entitlement_verdict: "unavailable",
  });
  assert.equal(requests.length, 0, "a missing device identity must not produce a Billing request");
});

test("authorized model proof returns entitled with the response request ID", async () => {
  const { fetch: fetchImpl, requests } = fakeBillingFetch(billingBody(), 200, "synthetic-request-id");
  const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
  const verdict = await entitlement.check({
    account: ACCOUNT_A,
    provider: "account:bigmodel-start-plan",
    model: MODEL.toUpperCase(),
    deviceMid: DEVICE_ID,
    jwt: syntheticJwt(),
    signal: new AbortController().signal,
  });
  assert.equal(verdict.status, "entitled");
  if (!("requestId" in verdict)) throw new Error("authorized verdict omitted request ID");
  assert.equal(verdict.requestId, "synthetic-request-id");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.get("user-agent"), "ZCode/3.17.4");
  assert.equal(requests[0]!.headers.get("http-referer"), "https://zcode.z.ai");
  assert.equal(requests[0]!.headers.get("x-title"), "Z Code@electron");
  assert.equal(requests[0]!.headers.get("x-zcode-app-version"), "3.17.4");
  assert.equal(requests[0]!.headers.get("x-release-channel"), "production");
  assert.equal(requests[0]!.headers.get("x-platform"), `${process.platform}-${process.arch}`);
  assert.ok(requests[0]!.headers.get("x-client-language"));
  assert.ok(requests[0]!.headers.get("x-client-timezone"));
  assert.ok(requests[0]!.headers.get("x-os-category"));
});

test("non-200 billing responses never prove entitlement from the body", async () => {
  for (const statusCode of [401, 403, 405, 429, 500, 503]) {
    const { fetch: fetchImpl } = fakeBillingFetch(billingBody(), statusCode);
    const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
    const verdict = await entitlement.check({
      account: ACCOUNT_A,
      provider: "account:bigmodel-start-plan",
      model: MODEL,
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt(),
      signal: new AbortController().signal,
    });
    assert.notEqual(verdict.status, "entitled", `HTTP ${statusCode} must not prove entitlement`);
    if (verdict.status === "entitled") throw new Error("unreachable");
    assert.deepEqual(verdict.failureFacts, {
      request_attempted: true,
      http_status: statusCode,
      provider_code: null,
      failure_class: statusCode === 401 ? "unauthorized"
        : statusCode === 403 ? "forbidden"
          : statusCode === 429 ? "rate_limited"
            : statusCode >= 500 ? "service_error"
              : "http_rejected",
      entitlement_verdict: "unavailable",
    });
  }
  assert.equal(classifyEntitlementFailure({ statusCode: 429, body: billingBody(), model: MODEL }).status, "rate_limited");
  assert.equal(classifyEntitlementFailure({ statusCode: 500, body: billingBody(), model: MODEL }).status, "unavailable");
});

test("failure classes and provider codes stay independent", async () => {
  assert.equal(classifyEntitlementFailure({ statusCode: 405, providerCode: "3007" }).status, "captcha_required");
  assert.equal(classifyEntitlementFailure({ statusCode: 405, providerCode: "3012" }).status, "unusual_activity");
  assert.equal(classifyEntitlementFailure({ statusCode: 200, providerCode: "3001" }).status, "billing_parameter_error");
  assert.equal(classifyEntitlementFailure({ statusCode: 401 }).status, "unauthorized");
  assert.equal(classifyEntitlementFailure({ statusCode: 403 }).status, "forbidden");
  assert.equal(classifyEntitlementFailure({ statusCode: 429 }).status, "rate_limited");
  assert.equal(classifyEntitlementFailure({ statusCode: 503 }).status, "unavailable");
  const captcha = classifyEntitlementFailure({ statusCode: 405, providerCode: "3007" });
  assert.ok(captcha);
  assert.equal(captcha.providerCode, "3007");
});

test("Billing provider rejection facts preserve status and sanitized code", async () => {
  const cases = [
    { status: 200, code: "3001", expected: "billing_parameter_error" },
    { status: 405, code: "3012", expected: "unusual_activity" },
  ] as const;
  for (const item of cases) {
    const { fetch: fetchImpl } = fakeBillingFetch({ success: false, code: item.code }, item.status);
    const entitlement = new StartPlanBillingEntitlement({ getAppVersion: async () => "3.17.4", fetchImpl });
    const verdict = await entitlement.check({
      account: ACCOUNT_A,
      provider: "account:bigmodel-start-plan",
      model: MODEL,
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt(),
      signal: new AbortController().signal,
    });
    assert.equal(verdict.status, item.expected);
    const failureFacts = "failureFacts" in verdict ? verdict.failureFacts : undefined;
    assert.deepEqual(failureFacts, {
      request_attempted: true,
      http_status: item.status,
      provider_code: item.code,
      failure_class: item.expected,
      entitlement_verdict: "unavailable",
    });
  }
});

test("missing official app version records Billing as not attempted", async () => {
  let requests = 0;
  const entitlement = new StartPlanBillingEntitlement({
    getAppVersion: async () => undefined,
    fetchImpl: async () => {
      requests += 1;
      return new Response("{}");
    },
  });
  const verdict = await entitlement.check({
    account: ACCOUNT_A,
    provider: "account:bigmodel-start-plan",
    model: MODEL,
    deviceMid: DEVICE_ID,
    jwt: syntheticJwt(),
    signal: new AbortController().signal,
  });
  assert.equal(verdict.status, "unavailable");
  assert.deepEqual(verdict.failureFacts, {
    request_attempted: false,
    http_status: null,
    provider_code: null,
    failure_class: "not_attempted",
    entitlement_verdict: "unavailable",
  });
  assert.equal(requests, 0);
});

test("network failures retain only a sanitized transport fact", async () => {
  const sentinel = "SENTINEL_NETWORK_FAILURE";
  const entitlement = new StartPlanBillingEntitlement({
    getAppVersion: async () => "3.17.4",
    fetchImpl: async () => { throw new Error(sentinel); },
  });
  const verdict = await entitlement.check({
    account: ACCOUNT_A,
    provider: "account:bigmodel-start-plan",
    model: MODEL,
    deviceMid: DEVICE_ID,
    jwt: syntheticJwt(),
    signal: new AbortController().signal,
  });
  assert.equal(verdict.status, "unavailable");
  assert.deepEqual(verdict.failureFacts, {
    request_attempted: true,
    http_status: null,
    provider_code: null,
    failure_class: "transport",
    entitlement_verdict: "unavailable",
  });
  assert.equal(JSON.stringify(verdict).includes(sentinel), false);
});

test("failure fact persistence never invalidates a Result at the 32 MiB boundary", async () => {
  const contract = await import("../src/result-contract.mjs") as {
    canonical(value: unknown): string;
    MAX_TASK_RESULT_BYTES: number;
  };
  const baseResult: CandidateTaskResult = {
    task_id: "synthetic-boundary-report",
    attempt: 1,
    status: "failed",
    summary: "synthetic boundary report",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: true,
    zcode_output: "",
    exit_code: 1,
    session_id: null,
    started_at: "2026-11-14T00:00:00.000Z",
    finished_at: "2026-11-14T00:00:01.000Z",
  };
  const emptyBytes = Buffer.byteLength(contract.canonical(baseResult), "utf8");
  const result: CandidateTaskResult = {
    ...baseResult,
    zcode_output: "x".repeat(contract.MAX_TASK_RESULT_BYTES - emptyBytes),
  };
  assert.equal(Buffer.byteLength(contract.canonical(result), "utf8"), contract.MAX_TASK_RESULT_BYTES);

  const appended = appendStartPlanEntitlementFailureFacts(result, {
    request_attempted: true,
    http_status: 200,
    provider_code: null,
    failure_class: "model_quota_unproven",
    entitlement_verdict: "unavailable",
  }, result.task_id, result.attempt);

  assert.equal(appended.persisted, false);
  assert.equal(appended.result, result);
  assert.equal(Buffer.byteLength(contract.canonical(appended.result), "utf8"), contract.MAX_TASK_RESULT_BYTES);
});

test("issuer fails closed for missing JWT, expired JWT, and account switch without contacting entitlement", async () => {
  const missing = makeRoot("start-plan-missing-jwt-");
  try {
    let entitlementCalls = 0;
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(missing.root),
      signal: new AbortController().signal,
      entitlement: {
        check: async () => {
          entitlementCalls += 1;
          return { status: "entitled", observedAt: 1, requestId: "must-not-be-used" };
        },
      },
    });
    assert.equal(issuer, null);
    assert.equal(entitlementCalls, 0);
  } finally {
    missing.cleanup();
  }

  const expired = makeRoot("start-plan-expired-jwt-");
  try {
    writeCredential(expired.root, {
      jwt: syntheticJwt({ exp: 90 }),
      credentialExpiresAt: 90_000,
    });
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(expired.root),
      signal: new AbortController().signal,
      entitlement: { check: async () => { throw new Error("must not contact entitlement"); } },
      now: () => 90_001,
    });
    assert.ok(issuer);
    await assert.rejects(issuer.issue(binding(), new AbortController().signal), /start_plan_credential_expired/u);
  } finally {
    expired.cleanup();
  }

  const switched = makeRoot("start-plan-account-switch-");
  try {
    writeCredential(switched.root);
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(switched.root),
      signal: new AbortController().signal,
      entitlement: { check: async () => { throw new Error("must not contact entitlement"); } },
    });
    assert.equal(issuer?.account, ACCOUNT_A);
    assert.ok(issuer);
    await assert.rejects(
      issuer.issue(binding({ account: ACCOUNT_B }), new AbortController().signal),
      /start_plan_account_identity_invalid/u,
    );
  } finally {
    switched.cleanup();
  }
});

test("issuer rejects an account identity switch after construction without contacting entitlement", async () => {
  const { root, cleanup } = makeRoot("start-plan-account-switch-after-construction-");
  try {
    writeCredential(root);
    let entitlementCalls = 0;
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      entitlement: {
        check: async () => {
          entitlementCalls += 1;
          return { status: "entitled", observedAt: 1, requestId: "must-not-be-used" };
        },
      },
    });
    assert.ok(issuer);
    assert.equal(issuer.account, ACCOUNT_A);
    writeCredential(root, { account: ACCOUNT_B });
    await assert.rejects(
      issuer.issue(binding(), new AbortController().signal),
      /start_plan_account_identity_invalid/u,
    );
    assert.equal(entitlementCalls, 0);
  } finally {
    cleanup();
  }
});

test("credential failure prevents issuer creation and billing calls", async () => {
  const { root, cleanup } = makeRoot("start-plan-credential-billing-gate-");
  try {
    clearCredential(root);
    let entitlementCalls = 0;
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      entitlement: {
        check: async () => {
          entitlementCalls += 1;
          return { status: "entitled", observedAt: 1, requestId: "must-not-be-used" };
        },
      },
    });
    assert.equal(issuer, null);
    assert.equal(entitlementCalls, 0);
  } finally {
    cleanup();
  }
});

test("issuer checks the model with the unchanged official device identity before creating a lease", async () => {
  const { root, cleanup } = makeRoot("start-plan-issuer-success-");
  try {
    writeCredential(root);
    const observed: Array<{ deviceMid: string; jwt: string; model: string }> = [];
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement: {
        check: async (input) => {
          observed.push({ deviceMid: input.deviceMid, jwt: input.jwt, model: input.model });
          return { status: "entitled", observedAt: 1_001, requestId: "synthetic" };
        },
      },
    });
    assert.ok(issuer);
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    const lease = await issuer.issue(binding(), new AbortController().signal);
    assert.ok(lease);
    assert.deepEqual(observed, [{
      deviceMid: DEVICE_ID,
      jwt: syntheticJwt({ account: ACCOUNT_A, exp: 4_000 }),
      model: MODEL,
    }]);
  } finally {
    cleanup();
  }
});

test("provider preparation is model/account bound and lease issuance reuses its entitlement verdict", async () => {
  const { root, cleanup } = makeRoot("start-plan-provider-preflight-");
  try {
    writeCredential(root);
    const checks: Array<{ account: string; provider: string; model: string; deviceMid: string }> = [];
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement: {
        check: async (input) => {
          checks.push({ account: input.account, provider: input.provider, model: input.model, deviceMid: input.deviceMid });
          return input.model === MODEL
            ? { status: "entitled", observedAt: checks.length, requestId: `synthetic-${checks.length}` }
            : { status: "no_entitlement", reason: "synthetic model not entitled", observedAt: checks.length };
        },
      },
    });
    assert.ok(issuer);
    assert.equal(await issuer.prepare("account:other", MODEL, new AbortController().signal), false);
    assert.equal(checks.length, 0, "unsupported providers must be rejected before Billing");
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    assert.equal(checks.length, 1);
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    assert.equal(checks.length, 1, "repeated preparation must reuse the task-scoped verdict");
    const lease = await issuer.issue(binding(), new AbortController().signal);
    assert.ok(lease);
    assert.equal(checks.length, 1, "lease issuance must reuse the preparation verdict");
    await assert.rejects(
      issuer.issue(binding({ task: "separate-task" }), new AbortController().signal),
      /start_plan_lease_already_issued/u,
    );
    assert.equal(checks.length, 1, "repeated lease access must not trigger another Billing check");
    assert.deepEqual(checks.map(({ account, provider, model, deviceMid }) => ({ account, provider, model, deviceMid })), [
      { account: ACCOUNT_A, provider: "account:bigmodel-start-plan", model: MODEL, deviceMid: DEVICE_ID },
    ]);
  } finally {
    cleanup();
  }
});

test("a valid JWT remains usable after the first model iteration exceeds 30 seconds", async () => {
  const { root, cleanup } = makeRoot("start-plan-multi-iteration-expiry-");
  try {
    let now = 1_000;
    let checks = 0;
    writeCredential(root, {
      jwt: syntheticJwt({ account: ACCOUNT_A, exp: 100 }),
      credentialExpiresAt: 100_000,
    });
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      now: () => now,
      entitlement: {
        check: async () => {
          checks += 1;
          return { status: "entitled", observedAt: now, requestId: "synthetic" };
        },
      },
    });
    assert.ok(issuer);
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    const lease = await issuer.issue(binding(), new AbortController().signal);
    let deliveredExpiry = 0;
    await lease.redeem(binding(), async () => true, async (_credential, expiresAt) => {
      deliveredExpiry = expiresAt;
    }, new AbortController().signal);
    now += 43_170;
    assert.equal(deliveredExpiry, 100_000);
    assert.ok(deliveredExpiry > now, "the actual JWT expiry, not the delivery deadline, bounds Worker reuse");
    assert.equal(checks, 1, "prepare remains the only Billing check");
  } finally {
    cleanup();
  }
});

test("no-exp credentials use the task lifetime and genuinely expired JWTs fail before lease issuance", async () => {
  const noExpiry = makeRoot("start-plan-no-expiry-");
  try {
    writeCredential(noExpiry.root, { jwt: syntheticJwt({ account: ACCOUNT_A }) });
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(noExpiry.root),
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement: { check: async () => ({ status: "entitled", observedAt: 1_000, requestId: "synthetic" }) },
    });
    assert.ok(issuer);
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    const lease = await issuer.issue(binding(), new AbortController().signal);
    let deliveredExpiry = 0;
    await lease.redeem(binding(), async () => true, async (_credential, expiresAt) => {
      deliveredExpiry = expiresAt;
    }, new AbortController().signal);
    assert.equal(deliveredExpiry, Number.MAX_SAFE_INTEGER);
  } finally {
    noExpiry.cleanup();
  }

  const expired = makeRoot("start-plan-expired-after-prepare-");
  try {
    let now = 1_000;
    let checks = 0;
    writeCredential(expired.root, {
      jwt: syntheticJwt({ account: ACCOUNT_A, exp: 4 }),
      credentialExpiresAt: 4_000,
    });
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(expired.root),
      signal: new AbortController().signal,
      now: () => now,
      entitlement: {
        check: async () => {
          checks += 1;
          return { status: "entitled", observedAt: now, requestId: "synthetic" };
        },
      },
    });
    assert.ok(issuer);
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    now = 4_000;
    await assert.rejects(issuer.issue(binding(), new AbortController().signal), /start_plan_credential_expired/u);
    assert.equal(checks, 1);
  } finally {
    expired.cleanup();
  }
});

test("an unentitled or account-switched task remains fail-closed without a second Billing check", async () => {
  const unentitled = makeRoot("start-plan-unentitled-reuse-");
  try {
    writeCredential(unentitled.root);
    let checks = 0;
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(unentitled.root),
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement: {
        check: async () => {
          checks += 1;
          return { status: "no_entitlement", reason: "synthetic", observedAt: 1_000 };
        },
      },
    });
    assert.ok(issuer);
    await assert.rejects(
      issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal),
      /start_plan_entitlement_rejected:no_entitlement/u,
    );
    await assert.rejects(
      issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal),
      /start_plan_entitlement_rejected:no_entitlement/u,
    );
    assert.equal(checks, 1);
  } finally {
    unentitled.cleanup();
  }

  const switched = makeRoot("start-plan-switch-after-prepare-");
  try {
    writeCredential(switched.root);
    let checks = 0;
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(switched.root),
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement: {
        check: async () => {
          checks += 1;
          return { status: "entitled", observedAt: 1_000, requestId: "synthetic" };
        },
      },
    });
    assert.ok(issuer);
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    writeCredential(switched.root, { account: ACCOUNT_B });
    await assert.rejects(
      issuer.issue(binding(), new AbortController().signal),
      /start_plan_account_identity_invalid/u,
    );
    assert.equal(checks, 1);
  } finally {
    switched.cleanup();
  }
});

test("separate tasks independently perform exactly one Billing check", async () => {
  const { root, cleanup } = makeRoot("start-plan-separate-tasks-");
  try {
    writeCredential(root);
    let checks = 0;
    const makeIssuer = async () => createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement: {
        check: async () => {
          checks += 1;
          return { status: "entitled", observedAt: checks, requestId: `synthetic-${checks}` };
        },
      },
    });
    const first = await makeIssuer();
    const second = await makeIssuer();
    assert.ok(first);
    assert.ok(second);
    assert.equal(await first.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    assert.equal(await second.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    await first.issue(binding({ task: "task-one" }), new AbortController().signal);
    await second.issue(binding({ task: "task-two" }), new AbortController().signal);
    assert.equal(checks, 2);
  } finally {
    cleanup();
  }
});

test("prepare and lease issuance produce exactly one Billing GET per task", async () => {
  const { root, cleanup } = makeRoot("start-plan-single-billing-get-");
  try {
    writeCredential(root, { jwt: syntheticJwt({ account: ACCOUNT_A, exp: 100 }) });
    const billing = fakeBillingFetch(billingBody(), 200, "synthetic-request");
    const entitlement = new StartPlanBillingEntitlement({
      getAppVersion: async () => "3.17.4",
      fetchImpl: billing.fetch,
    });
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement,
    });
    assert.ok(issuer);
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    await issuer.issue(binding(), new AbortController().signal);
    assert.equal(billing.requests.length, 1);
    assert.equal(new URL(billing.requests[0]!.url).searchParams.has("mid"), false);
    assert.equal(billing.requests[0]!.headers.get("X-Device-Mid"), DEVICE_ID);
  } finally {
    cleanup();
  }
});

test("billing rejections surface a sanitized provider classification through prepare", async () => {
  const { root, cleanup } = makeRoot("start-plan-prepare-reject-");
  try {
    writeCredential(root);
    let prepareCalls = 0;
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      now: () => 1_000,
      signal: new AbortController().signal,
      entitlement: {
        check: async () => {
          prepareCalls += 1;
          return {
            status: "billing_parameter_error",
            reason: "synthetic parameter rejection",
            providerCode: "3001",
            observedAt: 1,
            failureFacts: {
              request_attempted: true,
              http_status: 200,
              provider_code: "3001",
              failure_class: "billing_parameter_error",
              entitlement_verdict: "unavailable",
            },
          };
        },
      },
    });
    assert.ok(issuer);
    await assert.rejects(
      issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : "", /start_plan_entitlement_rejected:billing_parameter_error:3001/u);
        assert.deepEqual(readStartPlanEntitlementFailureFacts(error), {
          request_attempted: true,
          http_status: 200,
          provider_code: "3001",
          failure_class: "billing_parameter_error",
          entitlement_verdict: "unavailable",
        });
        return true;
      },
    );
    assert.equal(prepareCalls, 1);
  } finally {
    cleanup();
  }
});

test("provider preparation refuses account changes and aborted tasks without Billing", async () => {
  const { root, cleanup } = makeRoot("start-plan-provider-preflight-account-");
  try {
    writeCredential(root);
    let entitlementCalls = 0;
    const issuer = await createProductionStartPlanAuth({
      authentication: authResolver(root),
      signal: new AbortController().signal,
      entitlement: { check: async () => { entitlementCalls += 1; return { status: "entitled", observedAt: 1, requestId: "synthetic" }; } },
    });
    assert.ok(issuer);
    writeCredential(root, { account: ACCOUNT_B });
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), false);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, aborted.signal), false);
    assert.equal(entitlementCalls, 0);
  } finally {
    cleanup();
  }
});

test("Start Plan provider registration rejection prevents session creation and session/send", async () => {
  const { root, cleanup } = makeRoot("start-plan-provider-gate-");
  try {
    const sentinel = "SENTINEL_GATE_E2_REGISTRATION_MESSAGE";
    const personal = path.join(root, ".zcode", "v2", "provider_config.json");
    mkdirSync(path.dirname(personal), { recursive: true });
    const entrypoint = path.join(root, "fake-app-server.cjs");
    const requestLog = path.join(root, "requests.jsonl");
    const builtin = path.join(root, "builtin.json");
    const report = JSON.stringify(validReport());
    writeFileSync(builtin, JSON.stringify({
      revision: 7,
      config: { providerConfigRules: { providerRules: [{
        providerId: "account:bigmodel-start-plan",
        config: { builtinModelIds: [MODEL.toUpperCase()], access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" } },
      }] } },
    }));
    writeFileSync(personal, JSON.stringify({
      schemaVersion: 1,
      config: { providerConfigRules: { providerRules: [{ providerId: "account:synthetic" }] } },
    }));
    writeFileSync(entrypoint, String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const requestLog = ${JSON.stringify(requestLog)};
const report = ${report};
function line(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function snapshot() {
  return { session: { sessionId: "synthetic-session" }, settings: { model: {
    current: { providerId: "account:bigmodel-start-plan", modelId: ${JSON.stringify(MODEL.toUpperCase())} },
    available: [],
  } }, runtime: { eventSeq: 0 } };
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (text) => {
  const message = JSON.parse(text);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "provider/updateAccountConfig") {
    line({ id: message.id, error: {
      code: -32603,
      message: ${JSON.stringify(sentinel)},
      data: { code: "provider_not_configured", message: ${JSON.stringify(sentinel)} },
    } });
  } else if (message.method === "session/create" || message.method === "session/setModel") {
    line({ id: message.id, result: snapshot() });
  } else if (message.method === "session/send") {
    line({ id: message.id, result: {} });
    line({ method: "session/event", params: { seq: 1, type: "turn.completed", payload: {
      response: report, usage: { totalTokens: 1 }, resultType: "success" } } });
  } else {
    line({ id: message.id, result: {} });
  }
});
input.on("close", () => process.exit(0));
`);
    const config: ZCodeRuntimeConfig = {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: builtin,
      providerPersonalConfigFile: personal,
      zcodeDataRoot: path.join(root, ".zcode"),
      dataRoot: path.join(root, "bridge-sqlite"),
    };
    const unentitledAdapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env["PATH"] ?? "" },
      homeDir: root,
      resolveStartPlanRuntimeAuth: async () => { throw new Error("runtime auth must not run before live Billing"); },
    });
    const unentitledHandle = await unentitledAdapter.startTask({
      task: {
        task_id: "start-plan-preflight-rejected",
        workspace: "C:\\unused",
        objective: "A task without verified live entitlement must not reach AppServer",
        requirements: [],
        allowed_paths: [],
        forbidden_paths: [],
        acceptance_criteria: [],
        test_commands: [],
        model: { provider_id: "account:bigmodel-start-plan", model_id: MODEL.toUpperCase() },
      },
      workspace: makeWorkspace(root),
      attempt: 1,
    });
    const unentitledResult = await unentitledAdapter.getResult(unentitledHandle);
    assert.equal(unentitledResult.errorCode, "provider_config_invalid");
    assert.match(unentitledResult.reportError ?? "", /live entitlement was not verified/u);
    assert.equal(existsSync(requestLog), false, "unentitled Start Plan must not spawn or contact AppServer");
    let callbackCalls = 0;
    let facts: FailureFactsV1 | null = null;
    const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env["PATH"] ?? "" },
      homeDir: root,
      startPlanProviderEntitled: true,
      onEvent: (event) => events.push(event),
      onFailureFacts: (value) => { facts = value; },
      resolveStartPlanRuntimeAuth: async () => {
        callbackCalls += 1;
        throw new Error("runtime auth must not run before provider registration");
      },
    });
    const handle = await adapter.startTask({
      task: {
        task_id: "start-plan-provider-gate",
        workspace: "C:\\unused",
        objective: "Synthetic provider registration gate",
        requirements: [],
        allowed_paths: [],
        forbidden_paths: [],
        acceptance_criteria: [],
        test_commands: [],
        model: { provider_id: "account:bigmodel-start-plan", model_id: MODEL.toUpperCase() },
      },
      workspace: makeWorkspace(root),
      attempt: 1,
    });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "provider_config_invalid");
      return true;
    });
    const capturedFacts = facts as FailureFactsV1 | null;
    assert.ok(capturedFacts);
    assert.equal(capturedFacts.source, "rpc");
    assert.equal(capturedFacts.phase, "pre_send");
    assert.equal(capturedFacts.rpc_method, "provider/updateAccountConfig");
    assert.equal(capturedFacts.rpc_code, -32603);
    assert.equal(capturedFacts.rpc_data_code, "provider_not_configured");
    const syncFailure = events.find((event) => event.type === "account_provider_sync_failed");
    assert.ok(syncFailure);
    assert.deepEqual(syncFailure.details, {
      failure_stage: "provider_registration",
      failure_kind: "RPC_REJECTED",
      rpc_method: "provider/updateAccountConfig",
      rpc_error_code: -32603,
      rpc_data_code: "provider_not_configured",
    });
    assert.equal(JSON.stringify({ facts: capturedFacts, events }).includes(sentinel), false);
    assert.equal(callbackCalls, 0);
    const methods = readFileSync(requestLog, "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { method?: string }).method);
    assert.equal(methods.includes("provider/updateAccountConfig"), true);
    assert.equal(methods.includes("session/create"), false);
    assert.equal(methods.includes("session/send"), false);
  } finally {
    cleanup();
  }
});

test("Coding Plan continues after provider registration rejection with the same callback", async () => {
  const { root, cleanup } = makeRoot("coding-plan-provider-unchanged-");
  try {
    const personal = path.join(root, ".zcode", "v2", "provider_config.json");
    mkdirSync(path.dirname(personal), { recursive: true });
    const entrypoint = path.join(root, "fake-app-server.cjs");
    const requestLog = path.join(root, "requests.jsonl");
    const builtin = path.join(root, "builtin.json");
    const report = JSON.stringify(validReport());
    writeFileSync(builtin, JSON.stringify({
      revision: 7,
      config: { providerConfigRules: { providerRules: [{
        providerId: "account:individual-coding-plan",
        config: { access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" } },
      }] } },
    }));
    writeFileSync(personal, JSON.stringify({
      schemaVersion: 1,
      config: { providerConfigRules: { providerRules: [{ providerId: "account:synthetic" }] } },
    }));
    writeFileSync(entrypoint, String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const requestLog = ${JSON.stringify(requestLog)};
const report = ${report};
function line(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function snapshot() {
  return { session: { sessionId: "synthetic-session" }, settings: { model: {
    current: { providerId: "account:individual-coding-plan", modelId: ${JSON.stringify(MODEL.toUpperCase())} },
    available: [],
  } }, runtime: { eventSeq: 0 } };
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (text) => {
  const message = JSON.parse(text);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "provider/updateAccountConfig") {
    line({ id: message.id, error: { code: -32000, message: "synthetic provider registration rejected" } });
  } else if (message.method === "session/create" || message.method === "session/setModel") {
    line({ id: message.id, result: snapshot() });
  } else if (message.method === "session/send") {
    line({ id: message.id, result: {} });
    line({ method: "session/event", params: { seq: 1, type: "turn.completed", payload: {
      response: report, usage: { totalTokens: 1 }, resultType: "success" } } });
  } else {
    line({ id: message.id, result: {} });
  }
});
input.on("close", () => process.exit(0));
`);
    const config: ZCodeRuntimeConfig = {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: builtin,
      providerPersonalConfigFile: personal,
      zcodeDataRoot: path.join(root, ".zcode"),
      dataRoot: path.join(root, "bridge-sqlite"),
    };
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env["PATH"] ?? "" },
      homeDir: root,
      resolveStartPlanRuntimeAuth: async () => { throw new Error("Coding Plan must not use Start Plan runtime auth"); },
    });
    const handle = await adapter.startTask({
      task: {
        task_id: "coding-plan-provider-unchanged",
        workspace: "C:\\unused",
        objective: "Synthetic Coding Plan unchanged behavior",
        requirements: [],
        allowed_paths: [],
        forbidden_paths: [],
        acceptance_criteria: [],
        test_commands: [],
        model: { provider_id: "account:individual-coding-plan", model_id: MODEL.toUpperCase() },
      },
      workspace: makeWorkspace(root),
      attempt: 1,
    });
    const outcome = await adapter.getResult(handle);
    assert.equal(outcome.exitCode, 0);
    const methods = readFileSync(requestLog, "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { method?: string }).method);
    assert.equal(methods.includes("provider/updateAccountConfig"), true);
    assert.equal(methods.includes("session/create"), true);
    assert.equal(methods.includes("session/send"), true);
  } finally {
    cleanup();
  }
});
