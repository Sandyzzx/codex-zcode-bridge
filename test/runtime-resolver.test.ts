// RuntimeResolver unit tests: override precedence, discovery, provider-pair
// validation (paired requirement, stub rejection), data-root resolution, and
// paths containing spaces or non-ASCII characters. All filesystem state is
// created under a disposable temp directory; nothing machine-specific.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeError } from "../src/runtime/errors.js";
import { loadPersistedRuntimeEnvironment, NodeRuntimeResolver } from "../src/runtime/resolver.js";

const REAL_PERSONAL = JSON.stringify({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: { "p-1": {} } },
    modelConfigRules: { providerModelRules: {}, manualProviderModelRules: {} },
  },
});
const STUB_PERSONAL = JSON.stringify({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: {} },
    modelConfigRules: { providerModelRules: {}, manualProviderModelRules: {} },
  },
});
const BUILTIN = JSON.stringify({ schemaVersion: 1, revision: 7, config: {} });

function makeFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-resolver-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeInstall(root: string, name = "ZCode"): string {
  const install = path.join(root, name);
  mkdirSync(path.join(install, "resources", "glm"), { recursive: true });
  writeFileSync(path.join(install, "resources", "glm", "zcode.cjs"), "// fake cli");
  mkdirSync(path.join(install, "resources", "config", "provider"), { recursive: true });
  writeFileSync(path.join(install, "resources", "config", "provider", "zcode-builtin.json"), BUILTIN);
  return install;
}

test("explicit Bridge overrides and a valid inherited pair win", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const personal = path.join(root, "personal.json");
    writeFileSync(personal, REAL_PERSONAL);
    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_BRIDGE_NODE: path.join(root, "node.exe"),
        ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "zcode.cjs"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(install, "resources", "config", "provider", "zcode-builtin.json"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_BRIDGE_DATA_DIR: path.join(root, "data"),
        ZCODE_WINDOWS_APP_INSTALL_DIR: path.join(root, "should-not-be-needed"),
      },
      packageRoot: root,
      homeDir: path.join(root, "home"),
    });
    writeFileSync(path.join(root, "node.exe"), "");
    const config = await resolver.resolve();
    assert.equal(config.nodeExecutable, path.join(root, "node.exe"));
    assert.equal(config.zcodeEntrypoint, path.join(install, "resources", "glm", "zcode.cjs"));
    assert.equal(config.providerBuiltinConfigFile, path.join(install, "resources", "config", "provider", "zcode-builtin.json"));
    assert.equal(config.providerPersonalConfigFile, personal);
    assert.equal(config.dataRoot, path.join(root, "data"));
  } finally {
    cleanup();
  }
});

test("persisted runtime settings override inherited environment values", () => {
  const { root, cleanup } = makeFixture();
  try {
    const dataRoot = path.join(root, "bridge-data");
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "runtime-config.json"), JSON.stringify({
      ZCODE_BRIDGE_NODE: "C:\\discovered\\node.exe",
      ZCODE_BRIDGE_ZCODE_CJS: "C:\\ZCode\\resources\\glm\\zcode.cjs",
      ZCODE_HOME: "D:\\ZCodeData\\.zcode",
      ZCODE_BRIDGE_MODE: "build",
      PRIVATE_TOKEN: "must-not-be-loaded",
    }));
    const env = loadPersistedRuntimeEnvironment({
      ZCODE_BRIDGE_DATA_DIR: dataRoot,
      ZCODE_BRIDGE_NODE: "E:\\explicit\\node.exe",
    }, path.join(root, "home"));
    assert.equal(env.ZCODE_BRIDGE_NODE, "C:\\discovered\\node.exe");
    assert.equal(env.ZCODE_BRIDGE_ZCODE_CJS, "C:\\ZCode\\resources\\glm\\zcode.cjs");
    assert.equal(env.ZCODE_HOME, "D:\\ZCodeData\\.zcode");
    assert.equal(env.ZCODE_BRIDGE_MODE, "build");
    assert.equal(env.PRIVATE_TOKEN, undefined);
  } finally {
    cleanup();
  }
});

test("discovery via ZCODE_WINDOWS_APP_INSTALL_DIR and data-dir personal config", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root, "App With Spaces 中文");
    const dataBase = path.join(root, "data base");
    mkdirSync(path.join(dataBase, ".zcode", "v2"), { recursive: true });
    writeFileSync(path.join(dataBase, ".zcode", "v2", "provider_config.json"), REAL_PERSONAL);
    const resolver = new NodeRuntimeResolver({
      env: { ZCODE_WINDOWS_APP_INSTALL_DIR: install, ZCODE_DATA_BASE_DIR: dataBase },
      homeDir: path.join(root, "home-not-used"),
      packageRoot: root,
    });
    const config = await resolver.resolve();
    assert.equal(config.nodeExecutable, "node");
    assert.equal(config.zcodeEntrypoint, path.join(install, "resources", "glm", "zcode.cjs"));
    assert.equal(config.providerBuiltinConfigFile, path.join(install, "resources", "config", "provider", "zcode-builtin.json"));
    assert.equal(config.providerPersonalConfigFile, path.join(dataBase, ".zcode", "v2", "provider_config.json"));
    assert.equal(config.dataRoot, root);
  } finally {
    cleanup();
  }
});

test("discovery falls back to LOCALAPPDATA\\Programs\\ZCode", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(path.join(root, "Programs"));
    mkdirSync(path.join(root, ".zcode", "v2"), { recursive: true });
    writeFileSync(path.join(root, ".zcode", "v2", "provider_config.json"), REAL_PERSONAL);
    const resolver = new NodeRuntimeResolver({
      env: { LOCALAPPDATA: root },
      homeDir: root,
      packageRoot: root,
    });
    const config = await resolver.resolve();
    assert.equal(config.zcodeEntrypoint, path.join(install, "resources", "glm", "zcode.cjs"));
    assert.equal(config.providerBuiltinConfigFile, path.join(install, "resources", "config", "provider", "zcode-builtin.json"));
    assert.equal(config.providerPersonalConfigFile, path.join(root, ".zcode", "v2", "provider_config.json"));
  } finally {
    cleanup();
  }
});

test("missing runtime raises runtime_not_found with searched locations", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const resolver = new NodeRuntimeResolver({
      env: { LOCALAPPDATA: path.join(root, "absent") },
      homeDir: root,
      packageRoot: root,
    });
    await assert.rejects(resolver.resolve(), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "runtime_not_found");
      assert.match(error.message, /zcode\.cjs was not found/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("ZCODE_BRIDGE_ZCODE_CJS pointing at a missing file raises runtime_not_found", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "missing.cjs"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(root, "none.json"),
      },
      homeDir: root,
      packageRoot: root,
    });
    await assert.rejects(resolver.resolve(), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "runtime_not_found");
      return true;
    });
  } finally {
    cleanup();
  }
});

test("no personal config anywhere raises provider_config_missing with candidates", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const resolver = new NodeRuntimeResolver({
      env: { ZCODE_WINDOWS_APP_INSTALL_DIR: install, ZCODE_DATA_BASE_DIR: path.join(root, "nodata") },
      homeDir: path.join(root, "nohome"),
      packageRoot: root,
    });
    await assert.rejects(resolver.resolve(), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "provider_config_missing");
      assert.match(error.message, /provider_config\.json/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("a stub personal config raises provider_config_invalid (never silently selected)", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const stub = path.join(root, "stub.json");
    writeFileSync(stub, STUB_PERSONAL);
    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "zcode.cjs"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(install, "resources", "config", "provider", "zcode-builtin.json"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: stub,
      },
      homeDir: root,
      packageRoot: root,
    });
    await assert.rejects(resolver.resolve(), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "provider_config_invalid");
      assert.match(error.message, /stub/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("malformed personal config raises provider_config_invalid", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const broken = path.join(root, "broken.json");
    writeFileSync(broken, "{not json");
    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "zcode.cjs"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(install, "resources", "config", "provider", "zcode-builtin.json"),
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: broken,
      },
      homeDir: root,
      packageRoot: root,
    });
    await assert.rejects(
      resolver.resolve(),
      (error: unknown) => error instanceof BridgeError && error.code === "provider_config_invalid",
    );
  } finally {
    cleanup();
  }
});

test("invalid inherited builtin raises provider_config_invalid instead of falling back", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const badBuiltin = path.join(root, "bad-builtin.json");
    writeFileSync(badBuiltin, JSON.stringify({ schemaVersion: 1 }));
    const personal = path.join(root, "personal.json");
    writeFileSync(personal, REAL_PERSONAL);
    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: badBuiltin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_WINDOWS_APP_INSTALL_DIR: install,
      },
      homeDir: root,
      packageRoot: root,
    });
    await assert.rejects(
      resolver.resolve(),
      (error: unknown) => error instanceof BridgeError && error.code === "provider_config_invalid",
    );
  } finally {
    cleanup();
  }
});

test("personal discovery prefers a valid config over an existing stub in an earlier candidate", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const dataBase = path.join(root, "data");
    mkdirSync(path.join(dataBase, ".zcode", "v2"), { recursive: true });
    writeFileSync(path.join(dataBase, ".zcode", "v2", "provider_config.json"), STUB_PERSONAL);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(path.join(home, ".zcode", "v2", "provider_config.json"), REAL_PERSONAL);
    const resolver = new NodeRuntimeResolver({
      env: { ZCODE_WINDOWS_APP_INSTALL_DIR: install, ZCODE_DATA_BASE_DIR: dataBase },
      homeDir: home,
      packageRoot: root,
    });
    const config = await resolver.resolve();
    assert.equal(config.providerPersonalConfigFile, path.join(home, ".zcode", "v2", "provider_config.json"));
  } finally {
    cleanup();
  }
});

test("ZCODE_BRIDGE_DATA_DIR must be absolute when set", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root);
    const builtin = path.join(install, "resources", "config", "provider", "zcode-builtin.json");
    const personal = path.join(root, "personal.json");
    writeFileSync(personal, REAL_PERSONAL);
    const resolver = new NodeRuntimeResolver({
      env: {
        ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "zcode.cjs"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_BRIDGE_DATA_DIR: "relative/path",
      },
      homeDir: root,
      packageRoot: root,
    });
    await assert.rejects(resolver.resolve(), /ZCODE_BRIDGE_DATA_DIR must be an absolute path/);
  } finally {
    cleanup();
  }
});
