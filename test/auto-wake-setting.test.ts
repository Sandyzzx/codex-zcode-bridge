import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTO_WAKE_RUNTIME_KEY,
  autoWakeEnabledFromEnvironment,
  readAutoWakeSetting,
  writeAutoWakeSetting,
} from "../src/runtime/auto-wake-setting.js";
import { loadPersistedRuntimeEnvironment } from "../src/runtime/resolver.js";
import { codexHostProfile } from "../src/runtime/host-profile.js";

test("Auto Wake defaults ON and a persisted false survives reload", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-auto-wake-"));
  try {
    assert.equal(await readAutoWakeSetting(root), true);
    assert.equal(autoWakeEnabledFromEnvironment({}), true);

    await writeAutoWakeSetting(root, false);
    assert.equal(await readAutoWakeSetting(root), false);
    assert.equal(autoWakeEnabledFromEnvironment({ [AUTO_WAKE_RUNTIME_KEY]: "false" }), false);

    const host = { ...codexHostProfile(root), settingsDirectory: root };
    const persisted = loadPersistedRuntimeEnvironment({}, root, host);
    assert.equal(persisted[AUTO_WAKE_RUNTIME_KEY], "false");
    assert.equal(autoWakeEnabledFromEnvironment(persisted), false);

    await writeAutoWakeSetting(root, true);
    assert.equal(await readAutoWakeSetting(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Auto Wake setting preserves unrelated runtime configuration", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-auto-wake-preserve-"));
  const configPath = path.join(root, "runtime-config.json");
  try {
    writeFileSync(configPath, JSON.stringify({ ZCODE_BRIDGE_MODE: "safe", ZCODE_BRIDGE_TIMEOUT_MS: "9000" }), "utf8");
    await writeAutoWakeSetting(root, false);
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.ZCODE_BRIDGE_MODE, "safe");
    assert.equal(saved.ZCODE_BRIDGE_TIMEOUT_MS, "9000");
    assert.equal(saved[AUTO_WAKE_RUNTIME_KEY], "false");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
