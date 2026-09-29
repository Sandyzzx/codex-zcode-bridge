import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { accountProviderId } from "../src/runtime/account-provider.js";
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
