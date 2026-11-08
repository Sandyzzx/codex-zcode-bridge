import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyEntitlementFailure,
  createProductionStartPlanAuth,
  readOfficialCliVersion,
  readOfficialStartPlanCredential,
  StartPlanBillingEntitlement,
} from "../src/runtime/start-plan-production-auth.js";
import { NodeRuntimeResolver } from "../src/runtime/resolver.js";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { BridgeError } from "../src/runtime/errors.js";
import { makeWorkspace, validReport, TEMP_TREE_REMOVE_OPTIONS } from "./helpers.js";
import type { PrivateLeaseBinding } from "../src/runtime/start-plan-private-lease.js";
import type { ZCodeRuntimeConfig } from "../src/interfaces.js";

const DEVICE_ID = "synthetic-device-mid-fixed";
const ACCOUNT_A = "synthetic-account-a";
const ACCOUNT_B = "synthetic-account-b";
const MODEL = "glm-5.3-flash";
const CREDENTIAL_SECRET = "synthetic-official-credential-secret";

function makeRoot(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS }) };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function syntheticJwt(payload: Record<string, unknown> = {}): string {
  return `${base64url({ alg: "synthetic" })}.${base64url(payload)}.synthetic-signature`;
}

function encryptCredential(value: string, secret = CREDENTIAL_SECRET): string {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(secret).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function syntheticMachineFallbackSecret(): string {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Match the production fallback's best-effort username lookup.
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function replaceEncryptedSegment(envelope: string, index: number, replacement: string): string {
  const segments = envelope.slice("enc:v1:".length).split(".");
  segments[index] = replacement;
  return `enc:v1:${segments.join(".")}`;
}

function tamperCiphertextPreservingAuthTag(envelope: string): string {
  const segments = envelope.slice("enc:v1:".length).split(".");
  const ciphertext = Buffer.from(segments[2]!, "base64url");
  ciphertext[0] = ciphertext[0]! ^ 0xff;
  segments[2] = ciphertext.toString("base64url");
  return `enc:v1:${segments.join(".")}`;
}

function writeCredential(
  zcodeRoot: string,
  options: {
    jwt?: string;
    account?: string;
    deviceMid?: string | null;
    officialString?: boolean;
    encryptionSecret?: string;
    userInfo?: unknown;
  } = {},
): void {
  const v2 = path.join(zcodeRoot, "v2");
  mkdirSync(v2, { recursive: true });
  const jwt = options.jwt ?? syntheticJwt({ account: ACCOUNT_A, exp: 4_000 });
  const account = options.account ?? ACCOUNT_A;
  const userInfo = options.userInfo ?? {
    id: account,
    username: "synthetic-user",
    displayName: "Synthetic User",
    rawProfile: {
      user_id: account,
      name: "Synthetic User",
      email: "synthetic@example.invalid",
      avatar: "",
      zcodeProfileSchemaVersion: 1,
    },
  };
  writeFileSync(path.join(v2, "credentials.json"), JSON.stringify({
    zcodejwttoken: options.officialString ? encryptCredential(jwt, options.encryptionSecret) : jwt,
    "oauth:bigmodel:user_info": options.officialString
      ? encryptCredential(JSON.stringify(userInfo), options.encryptionSecret)
      : userInfo,
  }));
  writeFileSync(path.join(v2, "telemetry-state.json"), JSON.stringify({
    deviceMid: options.deviceMid === null ? undefined : options.deviceMid ?? DEVICE_ID,
  }));
}

function writeRawCredentialRecord(zcodeRoot: string, record: unknown): void {
  const v2 = path.join(zcodeRoot, "v2");
  mkdirSync(v2, { recursive: true });
  writeFileSync(path.join(v2, "credentials.json"), JSON.stringify(record));
  writeFileSync(path.join(v2, "telemetry-state.json"), JSON.stringify({ deviceMid: DEVICE_ID }));
}

function assertRejectedWithoutEntitlement(
  root: string,
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  assert.equal(readOfficialStartPlanCredential(root, env), null, label);
  let entitlementCalls = 0;
  const issuer = createProductionStartPlanAuth({
    zcodeDataRoot: root,
    env,
    signal: new AbortController().signal,
    entitlement: {
      check: async () => {
        entitlementCalls += 1;
        return { status: "entitled", observedAt: 1, requestId: "must-not-be-used" };
      },
    },
  });
  assert.equal(issuer, null, label);
  assert.equal(entitlementCalls, 0, label);
}

function billingBody(overrides: {
  success?: unknown;
  code?: unknown;
  plans?: unknown;
  balances?: unknown;
} = {}): Record<string, unknown> {
  return {
    success: overrides.success ?? true,
    ...(overrides.code === undefined ? {} : { code: overrides.code }),
    data: {
      plans: overrides.plans ?? [{
        status: "active",
        plan_id: "synthetic-start-plan",
        name: "Synthetic Start Plan",
      }],
      balances: overrides.balances ?? [{
        capabilities: [`model:${MODEL}`],
        remaining_units: 7,
      }],
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

test("reads official credentials from the resolved ZCode root while keeping SQLite and ZCode roots separate", async () => {
  const { root, cleanup } = makeRoot("start-plan-production-roots-");
  try {
    const home = path.join(root, "home");
    const migratedBase = path.join(root, "zcode-migrated-data");
    const zcodeRoot = path.join(migratedBase, ".zcode");
    const sqliteRoot = path.join(root, "bridge-sqlite-data");
    const entrypoint = path.join(root, "fake-official.cjs");
    const builtin = path.join(root, "builtin.json");
    const personal = path.join(zcodeRoot, "v2", "provider_config.json");
    mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    mkdirSync(zcodeRoot, { recursive: true });
    mkdirSync(sqliteRoot, { recursive: true });
    writeFileSync(path.join(home, ".zcode", "v2", "setting.json"), JSON.stringify({
      dataBaseDir: migratedBase,
    }));
    writeCredential(zcodeRoot);
    writeFileSync(entrypoint, "// synthetic runtime entrypoint\n");
    writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, revision: 1, config: {} }));
    writeFileSync(personal, JSON.stringify({
      schemaVersion: 1,
      config: { providerConfigRules: { providerRules: [{ providerId: "account:synthetic" }] } },
    }));

    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_BRIDGE_NODE: process.execPath,
        ZCODE_BRIDGE_ZCODE_CJS: entrypoint,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_DATA_BASE_DIR: migratedBase,
        ZCODE_HOME: zcodeRoot,
        ZCODE_BRIDGE_DATA_DIR: sqliteRoot,
      },
      homeDir: home,
      packageRoot: root,
    });
    const config = await resolver.resolve();
    assert.equal(config.dataRoot, path.resolve(sqliteRoot));
    assert.equal(config.zcodeDataRoot, path.resolve(zcodeRoot));
    writeFileSync(path.join(sqliteRoot, "state.marker"), "SQLite-only");

    const credential = readOfficialStartPlanCredential(config.zcodeDataRoot);
    assert.ok(credential);
    assert.equal(credential.account, ACCOUNT_A);
    assert.equal(credential.deviceMid, DEVICE_ID);
    assert.equal(readOfficialStartPlanCredential(config.dataRoot), null);
    assert.equal(readOfficialStartPlanCredential(config.zcodeDataRoot)?.deviceMid, DEVICE_ID);
  } finally {
    cleanup();
  }
});

test("reads encrypted official string credentials and preserves the object format", () => {
  const official = makeRoot("start-plan-official-string-");
  const legacyObject = makeRoot("start-plan-object-format-");
  try {
    writeCredential(official.root, { officialString: true });
    const credential = readOfficialStartPlanCredential(official.root, {
      ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET,
    });
    assert.ok(credential);
    assert.equal(credential.account, ACCOUNT_A);
    assert.equal(credential.deviceMid, DEVICE_ID);

    writeCredential(legacyObject.root);
    const legacy = readOfficialStartPlanCredential(legacyObject.root, {
      ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET,
    });
    assert.ok(legacy);
    assert.equal(legacy.account, ACCOUNT_A);
  } finally {
    official.cleanup();
    legacyObject.cleanup();
  }
});

test("uses the official machine fallback only when no explicit credential secret exists", () => {
  const { root, cleanup } = makeRoot("start-plan-machine-fallback-");
  try {
    const fallbackSecret = syntheticMachineFallbackSecret();
    writeCredential(root, {
      officialString: true,
      encryptionSecret: fallbackSecret,
    });

    const credential = readOfficialStartPlanCredential(root, {});
    assert.ok(credential);
    assert.equal(credential.account, ACCOUNT_A);
    assert.equal(credential.deviceMid, DEVICE_ID);

    assert.equal(readOfficialStartPlanCredential(root, {
      ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET,
    }), null);
  } finally {
    cleanup();
  }
});

test("reads plaintext JSON string user_info without changing the object-format path", () => {
  const { root, cleanup } = makeRoot("start-plan-plaintext-user-info-");
  try {
    writeCredential(root, {
      userInfo: JSON.stringify({ user_id: ACCOUNT_A, displayName: "Synthetic User" }),
    });
    const credential = readOfficialStartPlanCredential(root, {});
    assert.ok(credential);
    assert.equal(credential.account, ACCOUNT_A);
    assert.equal(credential.deviceMid, DEVICE_ID);
  } finally {
    cleanup();
  }
});

test("invalid credential records and cryptographic envelopes fail closed before entitlement", () => {
  const encryptedUserInfo = encryptCredential(JSON.stringify({ id: ACCOUNT_A }));
  const cases: Array<{
    name: string;
    setup: (root: string) => void;
    env?: NodeJS.ProcessEnv;
  }> = [
    {
      name: "null credentials root",
      setup: (root) => writeRawCredentialRecord(root, null),
    },
    {
      name: "array credentials root",
      setup: (root) => writeRawCredentialRecord(root, []),
    },
    {
      name: "non-record credentials root",
      setup: (root) => writeRawCredentialRecord(root, 42),
    },
    {
      name: "malformed encrypted envelope",
      setup: (root) => writeCredential(root, {
        userInfo: "enc:v1:not-a-valid-envelope",
        officialString: false,
      }),
    },
    {
      name: "invalid encrypted IV",
      setup: (root) => writeCredential(root, {
        userInfo: replaceEncryptedSegment(
          encryptedUserInfo,
          0,
          Buffer.alloc(11).toString("base64url"),
        ),
      }),
    },
    {
      name: "invalid encrypted auth tag",
      setup: (root) => writeCredential(root, {
        userInfo: replaceEncryptedSegment(
          encryptedUserInfo,
          1,
          Buffer.alloc(15).toString("base64url"),
        ),
      }),
    },
    {
      name: "invalid encrypted ciphertext",
      setup: (root) => writeCredential(root, {
        userInfo: replaceEncryptedSegment(encryptedUserInfo, 2, "%"),
      }),
    },
    {
      name: "AES-GCM authentication failure",
      setup: (root) => writeCredential(root, {
        userInfo: tamperCiphertextPreservingAuthTag(encryptedUserInfo),
      }),
    },
    {
      name: "non-JSON string",
      setup: (root) => writeCredential(root, { userInfo: "not-json" }),
    },
    {
      name: "wrong credential secret",
      setup: (root) => writeCredential(root, { officialString: true }),
      env: { ZCODE_CREDENTIAL_SECRET: "wrong-synthetic-secret" },
    },
    {
      name: "missing verifiable account identity",
      setup: (root) => writeCredential(root, {
        officialString: true,
        userInfo: { displayName: "Synthetic" },
      }),
    },
    {
      name: "invalid JWT payload",
      setup: (root) => writeCredential(root, { jwt: "synthetic-header.not-json.synthetic-signature" }),
    },
    {
      name: "missing Device ID",
      setup: (root) => writeCredential(root, { deviceMid: null }),
    },
  ];
  for (const item of cases) {
    const { root, cleanup } = makeRoot("start-plan-invalid-credential-");
    try {
      item.setup(root);
      assertRejectedWithoutEntitlement(
        root,
        item.env ?? { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET },
        item.name,
      );
    } finally {
      cleanup();
    }
  }
});

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
    { name: "unknown active plan", body: billingBody({ plans: [{ status: "active" }] }), expected: "no_entitlement" },
    { name: "business rejection", body: billingBody({ success: false, code: 4001 }), expected: "unavailable" },
    { name: "missing model proof", body: billingBody({ balances: [] }), expected: "unavailable" },
    {
      name: "model not authorized",
      body: billingBody({ balances: [{ capabilities: ["model:another-synthetic-model"], remaining_units: 7 }] }),
      expected: "model_unavailable",
    },
    {
      name: "exhausted authorized model",
      body: billingBody({ balances: [{ capabilities: [`model:${MODEL}`], remaining_units: 0 }] }),
      expected: "quota_exhausted",
    },
    {
      name: "missing remaining_units",
      body: billingBody({ balances: [{ capabilities: [`model:${MODEL}`] }] }),
      expected: "unavailable",
    },
    {
      name: "non-numeric remaining_units",
      body: billingBody({ balances: [{ capabilities: [`model:${MODEL}`], remaining_units: "many" }] }),
      expected: "unavailable",
    },
    {
      name: "negative remaining_units",
      body: billingBody({ balances: [{ capabilities: [`model:${MODEL}`], remaining_units: -1 }] }),
      expected: "unavailable",
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
    assert.equal(requests[0]!.url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.17.4&mid=synthetic-device-mid-fixed");
    assert.equal(requests[0]!.headers.get("x-device-mid"), DEVICE_ID);
    assert.match(requests[0]!.headers.get("authorization") ?? "", /^Bearer /u);
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
});

test("non-200 billing responses never prove entitlement from the body", async () => {
  for (const statusCode of [429, 500, 503, 405]) {
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

test("issuer fails closed for missing JWT, expired JWT, and account switch without contacting entitlement", async () => {
  const missing = makeRoot("start-plan-missing-jwt-");
  try {
    mkdirSync(path.join(missing.root, "v2"), { recursive: true });
    writeFileSync(path.join(missing.root, "v2", "credentials.json"), "{}");
    writeFileSync(path.join(missing.root, "v2", "telemetry-state.json"), JSON.stringify({ deviceMid: DEVICE_ID }));
    assert.equal(readOfficialStartPlanCredential(missing.root), null);
  } finally {
    missing.cleanup();
  }

  const expired = makeRoot("start-plan-expired-jwt-");
  try {
    writeCredential(expired.root, { jwt: syntheticJwt({ exp: 90 }) });
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: expired.root,
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
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: switched.root,
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
    writeCredential(root, { officialString: true });
    let entitlementCalls = 0;
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: root,
      env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET },
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
    writeCredential(root, { officialString: true, account: ACCOUNT_B });
    await assert.rejects(
      issuer.issue(binding(), new AbortController().signal),
      /start_plan_account_identity_invalid/u,
    );
    assert.equal(entitlementCalls, 0);
  } finally {
    cleanup();
  }
});

test("credential failure prevents issuer creation and billing calls", () => {
  const { root, cleanup } = makeRoot("start-plan-credential-billing-gate-");
  try {
    writeCredential(root, { officialString: true, userInfo: { displayName: "Synthetic" } });
    let entitlementCalls = 0;
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: root,
      env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET },
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
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: root,
      signal: new AbortController().signal,
      now: () => 1_000,
      entitlement: {
        check: async (input) => {
          observed.push({ deviceMid: input.deviceMid, jwt: input.jwt, model: input.model });
          return { status: "entitled", observedAt: 1_001, requestId: "synthetic" };
        },
      },
    });
    const lease = await issuer?.issue(binding(), new AbortController().signal);
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

test("provider preparation is model/account bound and entitlement is rechecked before private lease delivery", async () => {
  const { root, cleanup } = makeRoot("start-plan-provider-preflight-");
  try {
    writeCredential(root);
    const checks: Array<{ account: string; provider: string; model: string; deviceMid: string }> = [];
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: root,
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
    await assert.rejects(
      issuer.prepare("account:bigmodel-start-plan", "unentitled-model", new AbortController().signal),
      /start_plan_entitlement_rejected:no_entitlement/u,
    );
    assert.equal(checks.length, 1, "an unentitled model receives one live check but no provider authorization");
    assert.equal(await issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal), true);
    assert.equal(checks.length, 2);
    const lease = await issuer.issue(binding(), new AbortController().signal);
    assert.ok(lease);
    assert.equal(checks.length, 3, "lease delivery must perform a fresh Billing check after preflight");
    assert.deepEqual(checks.map(({ account, provider, model, deviceMid }) => ({ account, provider, model, deviceMid })), [
      { account: ACCOUNT_A, provider: "account:bigmodel-start-plan", model: "unentitled-model", deviceMid: DEVICE_ID },
      { account: ACCOUNT_A, provider: "account:bigmodel-start-plan", model: MODEL, deviceMid: DEVICE_ID },
      { account: ACCOUNT_A, provider: "account:bigmodel-start-plan", model: MODEL, deviceMid: DEVICE_ID },
    ]);
  } finally {
    cleanup();
  }
});

test("billing rejections surface a sanitized provider classification through prepare", async () => {
  const { root, cleanup } = makeRoot("start-plan-prepare-reject-");
  try {
    writeCredential(root);
    let prepareCalls = 0;
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: root,
      now: () => 1_000,
      signal: new AbortController().signal,
      entitlement: {
        check: async () => {
          prepareCalls += 1;
          return { status: "billing_parameter_error", reason: "synthetic parameter rejection", providerCode: "3001", observedAt: 1 };
        },
      },
    });
    assert.ok(issuer);
    await assert.rejects(
      issuer.prepare("account:bigmodel-start-plan", MODEL, new AbortController().signal),
      /start_plan_entitlement_rejected:billing_parameter_error:3001/u,
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
    const issuer = createProductionStartPlanAuth({
      zcodeDataRoot: root,
      env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET },
      signal: new AbortController().signal,
      entitlement: { check: async () => { entitlementCalls += 1; return { status: "entitled", observedAt: 1, requestId: "synthetic" }; } },
    });
    assert.ok(issuer);
    writeCredential(root, { officialString: true, account: ACCOUNT_B });
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
      zcodeDataRoot: path.join(root, "official-zcode"),
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
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env["PATH"] ?? "" },
      homeDir: root,
      startPlanProviderEntitled: true,
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
      zcodeDataRoot: path.join(root, "official-zcode"),
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
