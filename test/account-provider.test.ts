import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  accountProviderId,
  buildAccountProviderPayload,
  catalogProviderId,
  runtimeAuthReply,
} from "../src/runtime/account-provider.js";
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

test("official account snapshot keeps Start and Coding Plan facts independent and revision stable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-start-plan-provider-entitlement-"));
  const builtinPath = path.join(root, "resources", "config", "provider", "builtin.json");
  const personalPath = path.join(root, ".zcode", "v2", "provider_config.json");
  const settingPath = path.join(root, ".zcode", "v2", "setting.json");
  const modelId = "GLM-5.3-Flash";
  mkdirSync(path.dirname(builtinPath), { recursive: true });
  mkdirSync(path.dirname(personalPath), { recursive: true });
  writeFileSync(builtinPath, JSON.stringify({ revision: 1, config: { providerConfigRules: { providerRules: [
    { providerId: "account:bigmodel-start-plan", config: { builtinModelIds: [modelId], access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" } } },
    { providerId: "account:bigmodel-individual-coding-plan", config: { builtinModelIds: [modelId], access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" } } },
  ] } } }));
  writeFileSync(personalPath, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }));
  writeFileSync(path.join(root, ".zcode", "v2", "config.json"), JSON.stringify({
    provider: {
      "builtin:bigmodel-start-plan": { enabled: true, options: { apiKey: "synthetic-start-plan-legacy-key" } },
      "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "synthetic-coding-plan-key" } },
    },
  }));
  const dataDir = path.join(root, ".zcode", "v2");
  const cacheDir = path.join(dataDir, "coding-plan-cache.json");
  writeFileSync(cacheDir, JSON.stringify({ entryStatus: { items: {
    "builtin:bigmodel-start-plan": { status: "available" },
    "builtin:bigmodel-coding-plan": { status: "available" },
  } } }));
  writeFileSync(settingPath, JSON.stringify({
    modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
    providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
  }));
  const config: ZCodeRuntimeConfig = {
    nodeExecutable: process.execPath, zcodeEntrypoint: "unused", dataRoot: path.join(root, "sqlite"), zcodeDataRoot: path.join(root, ".zcode"),
    providerBuiltinConfigFile: builtinPath, providerPersonalConfigFile: personalPath,
  };
  try {
    const withoutLiveCheck = buildAccountProviderPayload(config, undefined, root);
    const stableRepeat = buildAccountProviderPayload(config, undefined, root);
    assert.equal(withoutLiveCheck?.revision, stableRepeat?.revision);
    assert.match(withoutLiveCheck?.revision ?? "", /^account:\[/u);
    assert.equal(
      withoutLiveCheck?.basedOnZCodeBuiltinRevision,
      `zcode-builtin:1:${createHash("sha256").update(path.resolve(builtinPath)).digest("hex")}`,
    );
    assert.equal(withoutLiveCheck?.providers["account:bigmodel-start-plan"]?.access.entitled, false);
    assert.equal(withoutLiveCheck?.states["account:bigmodel-start-plan"]?.current, false);
    assert.equal(withoutLiveCheck?.providers["account:bigmodel-individual-coding-plan"]?.access.entitled, true);
    assert.equal(withoutLiveCheck?.states["account:bigmodel-individual-coding-plan"]?.current, true);
    assert.equal(JSON.stringify(withoutLiveCheck).includes("synthetic-coding-plan-key"), false);
    assert.deepEqual(runtimeAuthReply("account:bigmodel-individual-coding-plan", config), {
      headersApplied: true,
      requestAuth: { apiKey: "synthetic-coding-plan-key" },
    });
    assert.equal((runtimeAuthReply("account:bigmodel-start-plan", config) as { headersApplied?: boolean }).headersApplied, false);

    const withLiveCheck = buildAccountProviderPayload(config, { providerId: "account:bigmodel-start-plan", modelId }, root);
    assert.equal(withLiveCheck?.providers["account:bigmodel-start-plan"]?.access.entitled, true);
    assert.equal(withLiveCheck?.states["account:bigmodel-start-plan"]?.current, false);
    assert.equal(withLiveCheck?.providers["account:bigmodel-individual-coding-plan"]?.access.entitled, true);
    assert.equal(withLiveCheck?.states["account:bigmodel-individual-coding-plan"]?.current, true);
    assert.notEqual(withLiveCheck?.revision, withoutLiveCheck?.revision);
    assert.throws(() => buildAccountProviderPayload(
      config,
      { providerId: "account:bigmodel-start-plan", modelId: "unregistered-model" },
      root,
    ), /start_plan_model_not_registered/u);

    writeFileSync(settingPath, JSON.stringify({
      modelProviderFamilySelectedKeys: { bigmodel: "start-plan:builtin:bigmodel-start-plan" },
      providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
    }));
    const startCurrent = buildAccountProviderPayload(config, undefined, root);
    assert.equal(startCurrent?.states["account:bigmodel-start-plan"]?.current, true);
    assert.equal(startCurrent?.states["account:bigmodel-individual-coding-plan"]?.current, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("modern connection selections override legacy keys and keep Team distinct", () => {
  const fixture = makeConnectionSelectionFixture();
  try {
    writeFileSync(fixture.settingPath, JSON.stringify({
      modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      providerFamilyConnectionSelections: {
        bigmodel: {
          kind: "team-coding-plan",
          productId: "synthetic-product",
          organizationId: "synthetic-organization",
          projectId: "synthetic-project",
        },
      },
    }));
    const team = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.equal(team?.states["account:bigmodel-individual-coding-plan"]?.current, false);
    assert.equal(team?.states["account:bigmodel-team-coding-plan"]?.current, true);
    assert.equal(team?.states["account:bigmodel-start-plan"]?.current, false);

    writeFileSync(fixture.settingPath, JSON.stringify({
      modelProviderFamilySelectedKeys: { bigmodel: "start-plan:builtin:bigmodel-start-plan" },
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
    }));
    const individual = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.equal(individual?.states["account:bigmodel-individual-coding-plan"]?.current, true);
    assert.equal(individual?.states["account:bigmodel-team-coding-plan"]?.current, false);
    assert.equal(individual?.states["account:bigmodel-start-plan"]?.current, false);

    writeFileSync(fixture.settingPath, JSON.stringify({
      modelProviderFamilySelectedKeys: { bigmodel: "start-plan:builtin:bigmodel-start-plan" },
    }));
    const legacy = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.equal(legacy?.states["account:bigmodel-start-plan"]?.current, true);
    assert.equal(legacy?.states["account:bigmodel-individual-coding-plan"]?.current, false);

    writeFileSync(fixture.settingPath, JSON.stringify({
      modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      providerFamilyConnectionSelections: { bigmodel: "invalid-modern-selection" },
    }));
    const malformedModern = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.equal(malformedModern?.states["account:bigmodel-start-plan"]?.current, false);
    assert.equal(malformedModern?.states["account:bigmodel-individual-coding-plan"]?.current, false);
    assert.equal(malformedModern?.states["account:bigmodel-team-coding-plan"]?.current, false);

    writeFileSync(fixture.settingPath, JSON.stringify({
      modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      providerFamilyConnectionSelections: "invalid-modern-root",
    }));
    const malformedModernRoot = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.equal(malformedModernRoot?.states["account:bigmodel-individual-coding-plan"]?.current, false);

    writeFileSync(fixture.settingPath, JSON.stringify({
      providerFamilyConnectionSelections: {
        bigmodel: { kind: "team-coding-plan", productId: "synthetic-product" },
      },
    }));
    const malformedTeam = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.equal(malformedTeam?.states["account:bigmodel-team-coding-plan"]?.current, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task-scoped current authorizes only the selected account provider", () => {
  const fixture = makeConnectionSelectionFixture();
  const modelId = "GLM-5.3-Flash";
  try {
    writeFileSync(fixture.settingPath, JSON.stringify({
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
    }));
    const startTask = buildAccountProviderPayload(
      fixture.config,
      { providerId: "account:bigmodel-start-plan", modelId },
      fixture.root,
      "account:bigmodel-start-plan",
    );
    assert.equal(startTask?.providers["account:bigmodel-start-plan"]?.access.entitled, true);
    assert.equal(startTask?.states["account:bigmodel-start-plan"]?.current, true);
    assert.equal(startTask?.providers["account:bigmodel-individual-coding-plan"]?.access.entitled, true);
    assert.equal(startTask?.states["account:bigmodel-individual-coding-plan"]?.current, undefined);

    writeFileSync(fixture.settingPath, JSON.stringify({
      providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
    }));
    const codingTask = buildAccountProviderPayload(
      fixture.config,
      undefined,
      fixture.root,
      "account:bigmodel-individual-coding-plan",
    );
    assert.equal(codingTask?.states["account:bigmodel-individual-coding-plan"]?.current, true);
    assert.equal(codingTask?.states["account:bigmodel-start-plan"]?.current, undefined);
    assert.equal(codingTask?.providers["account:bigmodel-individual-coding-plan"]?.access.entitled, true);
    assert.equal(codingTask?.states["account:bigmodel-individual-coding-plan"]?.entitled, true);
    assert.deepEqual(runtimeAuthReply("account:bigmodel-individual-coding-plan", fixture.config), {
      headersApplied: true,
      requestAuth: { apiKey: "synthetic-coding-plan-key" },
    });

    assert.equal(codingTask?.states["account:bigmodel-offpeak-idle-plan"]?.current, undefined);
    assert.equal(codingTask?.states["account:bigmodel-highspeed-card"]?.current, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("builtin model order is preserved while revision remains deterministic", () => {
  const fixture = makeConnectionSelectionFixture(["GLM-5.3", "GLM-5.3-Flash"]);
  try {
    const first = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    const repeat = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.deepEqual(
      first?.providers["account:bigmodel-start-plan"]?.builtinModelIds,
      ["GLM-5.3", "GLM-5.3-Flash"],
    );
    assert.equal(first?.revision, repeat?.revision);

    fixture.writeBuiltin(["GLM-5.3-Flash", "GLM-5.3"]);
    const reordered = buildAccountProviderPayload(fixture.config, undefined, fixture.root);
    assert.deepEqual(
      reordered?.providers["account:bigmodel-start-plan"]?.builtinModelIds,
      ["GLM-5.3-Flash", "GLM-5.3"],
    );
    assert.notEqual(reordered?.revision, first?.revision);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function makeConnectionSelectionFixture(
  startPlanModels: readonly string[] = ["GLM-5.3-Flash"],
): {
  readonly root: string;
  readonly settingPath: string;
  readonly config: ZCodeRuntimeConfig;
  readonly writeBuiltin: (models: readonly string[]) => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-account-selection-"));
  const builtinPath = path.join(root, "resources", "config", "provider", "builtin.json");
  const personalPath = path.join(root, ".zcode", "v2", "provider_config.json");
  const settingPath = path.join(root, ".zcode", "v2", "setting.json");
  mkdirSync(path.dirname(builtinPath), { recursive: true });
  mkdirSync(path.dirname(personalPath), { recursive: true });
  const writeBuiltin = (models: readonly string[]): void => {
    writeFileSync(builtinPath, JSON.stringify({
      revision: 7,
      config: { providerConfigRules: { providerRules: [
        {
          providerId: "account:bigmodel-start-plan",
          config: { builtinModelIds: [...models], access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" } },
        },
        {
          providerId: "account:bigmodel-individual-coding-plan",
          config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" } },
        },
        {
          providerId: "account:bigmodel-team-coding-plan",
          config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "team-coding-plan", accountType: "bigmodel" } },
        },
        {
          providerId: "account:bigmodel-offpeak-idle-plan",
          config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "off-peak", accountType: "bigmodel" } },
        },
        {
          providerId: "account:bigmodel-highspeed-card",
          config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "highspeed", accountType: "bigmodel" } },
        },
      ] } },
    }));
  };
  writeBuiltin(startPlanModels);
  writeFileSync(personalPath, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }));
  writeFileSync(path.join(root, ".zcode", "v2", "config.json"), JSON.stringify({
    provider: {
      "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "synthetic-coding-plan-key" } },
    },
  }));
  writeFileSync(path.join(root, ".zcode", "v2", "coding-plan-cache.json"), JSON.stringify({
    entryStatus: { items: { "builtin:bigmodel-coding-plan": { status: "available" } } },
  }));
  writeFileSync(settingPath, JSON.stringify({}));
  return {
    root,
    settingPath,
    writeBuiltin,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: "unused",
      providerBuiltinConfigFile: builtinPath,
      providerPersonalConfigFile: personalPath,
      zcodeDataRoot: path.join(root, ".zcode"),
      dataRoot: path.join(root, "sqlite"),
    },
  };
}
