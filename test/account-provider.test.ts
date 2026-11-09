import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { accountProviderId, buildAccountProviderPayload, catalogProviderId } from "../src/runtime/account-provider.js";
import type { ZCodeRuntimeConfig } from "../src/interfaces.js";

test("account provider IDs are idempotent while legacy builtin IDs still map", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-account-provider-"));
  const providerConfigPath = path.join(root, "zcode-builtin.json");
  const runtimeProviderId = "account:bigmodel-individual-coding-plan";
  const legacyProviderId = "builtin:bigmodel-coding-plan";

  writeFileSync(providerConfigPath, JSON.stringify({
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: runtimeProviderId,
          config: {
            access: {
              type: "zhipu-account",
              accountType: "bigmodel",
              mode: "individual-coding-plan",
            },
          },
        }],
      },
    },
  }));

  const config: ZCodeRuntimeConfig = {
    nodeExecutable: process.execPath,
    zcodeEntrypoint: "unused",
    providerBuiltinConfigFile: providerConfigPath,
    providerPersonalConfigFile: "unused",
    zcodeDataRoot: "unused",
    dataRoot: root,
  };

  try {
    assert.equal(accountProviderId(runtimeProviderId, config), runtimeProviderId);
    assert.equal(accountProviderId(legacyProviderId, config), runtimeProviderId);
    assert.equal(accountProviderId("bigmodel-individual-coding-plan", config), runtimeProviderId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog aliases require the same advertised model and preserve exact provider IDs", () => {
  const config: ZCodeRuntimeConfig = {
    nodeExecutable: process.execPath, zcodeEntrypoint: "unused", dataRoot: "unused",
    zcodeDataRoot: "unused",
    providerBuiltinConfigFile: "missing-builtin.json", providerPersonalConfigFile: "missing-personal.json",
  };
  const account = { providerId: "account:plan", modelId: "flash" };
  assert.equal(catalogProviderId("plan", "flash", [account], config), "account:plan");
  assert.equal(catalogProviderId("plan", "other", [account], config), "plan");
  assert.equal(catalogProviderId("other-plan", "flash", [account], config), "other-plan");
  assert.equal(catalogProviderId("account:plan", "flash", [account], config), "account:plan");
  assert.equal(catalogProviderId("plan", "flash", [account, { providerId: "plan", modelId: "flash" }], config), "plan");
  assert.equal(catalogProviderId("builtin:plan", "flash", [account], config), "builtin:plan");
});

test("legacy cache and API key cannot entitle Start Plan, while an exact verified selection can", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-start-plan-provider-entitlement-"));
  const builtinPath = path.join(root, "resources", "config", "provider", "builtin.json");
  const personalPath = path.join(root, ".zcode", "v2", "provider_config.json");
  const modelId = "GLM-5.3-Flash";
  mkdirSync(path.dirname(builtinPath), { recursive: true });
  mkdirSync(path.dirname(personalPath), { recursive: true });
  writeFileSync(builtinPath, JSON.stringify({ revision: 1, config: { providerConfigRules: { providerRules: [
    { providerId: "account:bigmodel-start-plan", config: { builtinModelIds: [modelId], access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" } } },
  ] } } }));
  writeFileSync(personalPath, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }));
  writeFileSync(path.join(root, ".zcode", "v2", "config.json"), JSON.stringify({
    config: { provider: { "builtin:bigmodel-start-plan": { enabled: true, options: { apiKey: "synthetic-legacy-key" } } } },
  }));
  const dataDir = path.join(root, ".zcode", "v2");
  const cacheDir = path.join(dataDir, "coding-plan-cache.json");
  writeFileSync(cacheDir, JSON.stringify({ entryStatus: { items: { "builtin:bigmodel-start-plan": { status: "available" } } } }));
  const config: ZCodeRuntimeConfig = {
    nodeExecutable: process.execPath, zcodeEntrypoint: "unused", dataRoot: path.join(root, "sqlite"), zcodeDataRoot: path.join(root, "official"),
    providerBuiltinConfigFile: builtinPath, providerPersonalConfigFile: personalPath,
  };
  try {
    const withoutLiveCheck = buildAccountProviderPayload(config);
    assert.equal(withoutLiveCheck?.providers["account:bigmodel-start-plan"]?.access.entitled, false);
    assert.equal(withoutLiveCheck?.states["account:bigmodel-start-plan"]?.current, false);
    const withLiveCheck = buildAccountProviderPayload(config, { providerId: "account:bigmodel-start-plan", modelId });
    assert.equal(withLiveCheck?.providers["account:bigmodel-start-plan"]?.access.entitled, true);
    assert.equal(withLiveCheck?.states["account:bigmodel-start-plan"]?.current, true);
    assert.throws(() => buildAccountProviderPayload(config, { providerId: "account:bigmodel-start-plan", modelId: "unregistered-model" }), /start_plan_model_not_registered/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
