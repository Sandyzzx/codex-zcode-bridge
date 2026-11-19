import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ZCodeRuntimeConfig } from "../src/interfaces.js";
import {
  accountProviderRuleFacts,
  buildAccountProviderPayload,
  testOnlyRuntimeAuthReply,
} from "../src/runtime/account-provider.js";
import { classifyEntitlementFailure } from "../src/runtime/start-plan-production-auth.js";

interface ProviderRule {
  providerId?: string;
  config?: {
    builtinModelIds?: string[];
    access?: { type?: string; mode?: string; accountType?: string };
    api?: { type?: string; baseUrl?: string };
  };
}

const providerRulesFixture: ProviderRule[] = [
  {
    providerId: "account:bigmodel-start-plan",
    config: {
      builtinModelIds: ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"],
      access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      },
    },
  },
  {
    providerId: "account:bigmodel-individual-coding-plan",
    config: {
      builtinModelIds: ["GLM-5.3-Flash"],
      access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
      },
    },
  },
];

test("offline official registry fixture keeps Start Plan and Coding Plan provider identities separate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-official-registry-"));
  const builtinConfig = path.join(root, "zcode-builtin.json");
  writeFileSync(builtinConfig, JSON.stringify({
    config: { providerConfigRules: { providerRules: providerRulesFixture } },
  }));
  const rules = providerRulesFixture;
  const startPlan = rules.find((rule) => rule.providerId === "account:bigmodel-start-plan");
  const codingPlan = rules.find((rule) => rule.providerId === "account:bigmodel-individual-coding-plan");
  assert.ok(startPlan);
  assert.ok(codingPlan);

  assert.deepEqual(startPlan.config?.builtinModelIds, ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]);
  assert.deepEqual(startPlan.config?.access, {
    type: "zhipu-account",
    mode: "start-plan",
    accountType: "bigmodel",
  });
  assert.deepEqual(startPlan.config?.api, {
    type: "anthropic-messages",
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
  });

  assert.deepEqual(codingPlan.config?.access, {
    type: "zhipu-account",
    mode: "individual-coding-plan",
    accountType: "bigmodel",
  });
  assert.equal(codingPlan.config?.api?.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  assert.notEqual(startPlan.config?.api?.baseUrl, codingPlan.config?.api?.baseUrl);

  const config = {
    providerBuiltinConfigFile: builtinConfig,
  } as ZCodeRuntimeConfig;
  try {
    assert.deepEqual(accountProviderRuleFacts("account:bigmodel-start-plan", config), {
      planKind: "start-plan",
      accountType: "bigmodel",
    });
    assert.deepEqual(accountProviderRuleFacts("account:bigmodel-individual-coding-plan", config), {
      planKind: "individual-coding-plan",
      accountType: "bigmodel",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline Start Plan account and runtime-auth simulation never falls back to Coding Plan", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-start-plan-official-offline-"));
  const builtinConfig = path.join(root, "zcode-builtin.json");
  const zcodeDataRoot = path.join(root, ".zcode");
  const v2 = path.join(zcodeDataRoot, "v2");
  const personalConfig = path.join(v2, "provider_config.json");
  mkdirSync(v2, { recursive: true });
  writeFileSync(builtinConfig, JSON.stringify({
    config: { providerConfigRules: { providerRules: providerRulesFixture } },
  }));
  writeFileSync(personalConfig, JSON.stringify({
    config: { providerConfigRules: { providerRules: [] } },
  }));
  writeFileSync(path.join(v2, "config.json"), JSON.stringify({
    provider: {
      "builtin:bigmodel-coding-plan": {
        enabled: true,
        options: { apiKey: "synthetic-coding-plan-only-key" },
      },
    },
  }));
  writeFileSync(path.join(v2, "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: { "builtin:bigmodel-coding-plan": { status: "available" } } },
  }));
  writeFileSync(path.join(v2, "setting.json"), JSON.stringify({
    providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
  }));

  const config: ZCodeRuntimeConfig = {
    nodeExecutable: process.execPath,
    zcodeEntrypoint: "unused",
    providerBuiltinConfigFile: builtinConfig,
    providerPersonalConfigFile: personalConfig,
    zcodeDataRoot,
    dataRoot: root,
  };

  try {
    const unverified = buildAccountProviderPayload(config, undefined, root);
    assert.equal(unverified?.providers["account:bigmodel-start-plan"]?.access.entitled, false);
    // A Desktop selection is not an entitlement fact. It may remain current,
    // but the provider stays unavailable until a task-scoped Billing verdict.
    assert.equal(unverified?.states["account:bigmodel-start-plan"]?.current, true);
    assert.equal(unverified?.providers["account:bigmodel-individual-coding-plan"]?.access.entitled, true);

    const verified = buildAccountProviderPayload(
      config,
      { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
      root,
      "account:bigmodel-start-plan",
    );
    assert.equal(verified?.providers["account:bigmodel-start-plan"]?.access.entitled, true);
    assert.equal(verified?.states["account:bigmodel-start-plan"]?.current, true);
    assert.equal(verified?.states["account:bigmodel-individual-coding-plan"]?.current, false);

    assert.throws(
      () => buildAccountProviderPayload(
        config,
        { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3" },
        root,
        "account:bigmodel-start-plan",
      ),
      /start_plan_model_not_registered/u,
    );

    const startPlanFallback = testOnlyRuntimeAuthReply("account:bigmodel-start-plan", config);
    assert.equal(startPlanFallback.headersApplied, false);
    assert.match(String(startPlanFallback.errorMessage), /Start Plan/u);
    assert.deepEqual(testOnlyRuntimeAuthReply("account:bigmodel-individual-coding-plan", config), {
      headersApplied: true,
      requestAuth: { apiKey: "synthetic-coding-plan-only-key" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Start Plan entitlement failure classes remain fail-closed offline", () => {
  assert.equal(classifyEntitlementFailure({
    statusCode: 405,
    providerCode: "3007",
  }).status, "captcha_required");
  assert.equal(classifyEntitlementFailure({
    statusCode: 405,
    providerCode: "3012",
  }).status, "unusual_activity");
  assert.equal(classifyEntitlementFailure({ statusCode: 401 }).status, "unauthorized");
  assert.equal(classifyEntitlementFailure({ statusCode: 403 }).status, "forbidden");
});
