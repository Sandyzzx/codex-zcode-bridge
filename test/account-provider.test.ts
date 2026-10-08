import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { accountProviderId, catalogProviderId } from "../src/runtime/account-provider.js";
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
