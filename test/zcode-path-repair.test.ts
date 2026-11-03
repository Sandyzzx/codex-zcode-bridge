// Repair matrix for full Windows absolute paths, PS 5.1/PS 7 parity, and doctor accuracy.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runBridgeDoctor } from "../src/runtime/doctor.js";
import { discoverZCodeData, isAbsolutePathForPlatform, isPermissionDeniedCode, isWindowsAbsolutePath } from "../src/runtime/paths.js";
import { NodeRuntimeResolver } from "../src/runtime/resolver.js";

const BUILTIN = JSON.stringify({ schemaVersion: 1, revision: 1, config: {} });
const PERSONAL = JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: { "p-1": {} } } } });

function fixture(prefix = "zcode-path-repair-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeUtf8NoBom(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(value, "utf8"));
}

function makeInstall(root: string, name: string): string {
  const install = path.join(root, name);
  mkdirSync(path.join(install, "resources", "glm"), { recursive: true });
  mkdirSync(path.join(install, "resources", "config", "provider"), { recursive: true });
  writeFileSync(path.join(install, "resources", "glm", "zcode.cjs"), "// fake runtime");
  writeFileSync(path.join(install, "resources", "config", "provider", "zcode-builtin.json"), BUILTIN);
  return install;
}

function makeProviderBase(root: string, name: string): string {
  const base = path.join(root, name);
  mkdirSync(path.join(base, ".zcode", "v2"), { recursive: true });
  writeFileSync(path.join(base, ".zcode", "v2", "provider_config.json"), PERSONAL);
  return base;
}

function isolatedEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  return env;
}

function psDiscovery(shell: string, script: string, userHome: string, setting: object): any {
  const settingFile = path.join(userHome, ".zcode", "v2", "setting.json");
  writeUtf8NoBom(settingFile, JSON.stringify(setting));
  const stdout = execFileSync(shell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & '${script}' -PrintPathDiscovery`,
  ], {
    env: isolatedEnv({ HOME: userHome, USERPROFILE: userHome }),
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

test("Windows path classification separates drive-qualified, drive-relative, and UNC forms", () => {
  assert.equal(isWindowsAbsolutePath("C:\\foo"), true);
  assert.equal(isWindowsAbsolutePath("C:/foo"), true);
  assert.equal(isWindowsAbsolutePath("C:\\Foo\\数据"), true);
  assert.equal(isWindowsAbsolutePath("C:foo"), false);
  assert.equal(isWindowsAbsolutePath("C:"), false);
  assert.equal(isWindowsAbsolutePath("\\foo"), false);
  assert.equal(isWindowsAbsolutePath("\\/server\\share"), false);
  assert.equal(isWindowsAbsolutePath("\\\\server\\share\\foo"), true);
  assert.equal(isWindowsAbsolutePath("//server/share/foo"), true);
  assert.equal(isWindowsAbsolutePath("//server"), false);
  assert.equal(isAbsolutePathForPlatform("\\foo", "win32"), false);
  assert.equal(isAbsolutePathForPlatform("/foo", "linux"), true);
  assert.equal(isPermissionDeniedCode(Object.assign(new Error("denied"), { code: "EPERM" })), true);
  assert.equal(isPermissionDeniedCode(Object.assign(new Error("denied"), { code: "EACCES" })), true);
});

test("PowerShell 5.1 and 7 match TypeScript for absolute, drive-relative, UNC, UTF-8, and Unicode paths", { skip: process.platform !== "win32" }, () => {
  const root = fixture("zcode-path-parity-");
  const script = path.resolve("plugins", "codex-zcode-bridge", "hooks", "configure-runtime.ps1");
  const shells = [process.env.WP6_REPAIR_PS5?.trim() || "powershell", process.env.WP6_REPAIR_PS7?.trim() || "pwsh"];
  try {
    const scenarios = [
      { name: "drive-relative", setting: { dataBaseDir: "C:foo" } },
      { name: "drive-only", setting: { dataBaseDir: "C:" } },
      { name: "root-relative", setting: { dataBaseDir: "\\foo" } },
      { name: "drive-absolute", setting: { dataBaseDir: "D:\\foo bar" } },
      { name: "unc-absolute", setting: { dataBaseDir: "\\\\127.0.0.1\\share\\foo" } },
      { name: "mixed-unc-separators", setting: { dataBaseDir: "\\/server\\share" } },
      { name: "utf8-unicode", setting: { dataBaseDir: "Q:\\中文 目录\\zcode-data" } },
    ];
    for (const shell of shells) {
      for (const scenario of scenarios) {
        const userHome = path.join(root, shell.replace(/[^\w.-]/gu, "_"), scenario.name);
        mkdirSync(userHome, { recursive: true });
        const ps = psDiscovery(shell, script, userHome, scenario.setting);
        const data = discoverZCodeData({ HOME: userHome, USERPROFILE: userHome }, { platform: "win32" });
        assert.equal(ps.settingStatus, data.settingStatus, `${shell} ${scenario.name}`);
        assert.equal(ps.configuredDataBaseDir, data.configuredDataBaseDir, `${shell} ${scenario.name}`);
        assert.equal(ps.dataBaseDir, data.dataBaseDir, `${shell} ${scenario.name}`);
        assert.equal(ps.dataBaseDirSource, data.dataBaseDirSource, `${shell} ${scenario.name}`);
        assert.equal(ps.zcodeDataDir, data.zcodeDataDir, `${shell} ${scenario.name}`);
        assert.equal(ps.zcodeV2Dir, data.zcodeV2Dir, `${shell} ${scenario.name}`);
      }
    }

    const relativeHome = path.join(root, "relative");
    mkdirSync(relativeHome, { recursive: true });
    for (const shell of shells) {
      const ps = psDiscovery(shell, script, relativeHome, { dataBaseDir: "C:foo" });
      assert.equal(ps.settingStatus, "ok");
      assert.match(String(ps.settingError), /relative path/u);
      assert.equal(ps.configuredDataBaseDir, null);
      assert.equal(ps.dataBaseDir, relativeHome);
      assert.equal(ps.dataBaseDirSource, "default");
      assert.equal(existsSync(path.join(relativeHome, ".codex", "codex-zcode-bridge", "runtime-config.json")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PowerShell 5.1 and 7 honor explicit data roots and reject explicit conflicts without persisting", { skip: process.platform !== "win32" }, async () => {
  const root = fixture("zcode-path-explicit-");
  const script = path.resolve("plugins", "codex-zcode-bridge", "hooks", "configure-runtime.ps1");
  const shells = [process.env.WP6_REPAIR_PS5?.trim() || "powershell", process.env.WP6_REPAIR_PS7?.trim() || "pwsh"];
  try {
    const install = makeInstall(root, "ZCode");
    const userHome = path.join(root, "user");
    const explicitBase = makeProviderBase(root, "explicit-data");
    const runtimeConfig = path.join(userHome, ".codex", "codex-zcode-bridge", "runtime-config.json");
    mkdirSync(userHome, { recursive: true });
    for (const shell of shells) {
      const runtime = path.join(install, "resources", "glm", "zcode.cjs");
      const builtin = path.join(install, "resources", "config", "provider", "zcode-builtin.json");
      const personal = path.join(explicitBase, ".zcode", "v2", "provider_config.json");
      const env = isolatedEnv({ HOME: userHome, USERPROFILE: userHome, ZCODE_HOME: path.join(explicitBase, ".zcode"), ZCODE_DATA_BASE_DIR: explicitBase });
      const args = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        "-NodeExecutablePath", process.execPath, "-ZCodeRuntimePath", runtime,
        "-BuiltinProviderConfigPath", builtin, "-PersonalProviderConfigPath", personal, "-WhatIf",
      ];
      const valid = spawnSync(shell, args, { env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
      assert.equal(valid.status, 0, valid.stderr || valid.stdout);
      assert.match(valid.stdout, /ZCode data base directory: .*explicit-data/u);
      assert.equal(existsSync(runtimeConfig), false, "WhatIf must not persist runtime settings");

      const resolved = await new NodeRuntimeResolver({
        env: { ...env, ZCODE_BRIDGE_NODE: process.execPath, ZCODE_BRIDGE_ZCODE_CJS: runtime },
        packageRoot: root, homeDir: userHome,
      }).resolve();
      assert.equal(resolved.providerPersonalConfigFile, personal);

      const otherBase = makeProviderBase(root, `${path.basename(shell)}-other`);
      const wrongHome = path.join(otherBase, "not-the-data", ".zcode");
      mkdirSync(wrongHome, { recursive: true });
      const conflictEnv = { ...env, ZCODE_HOME: wrongHome, ZCODE_DATA_BASE_DIR: explicitBase };
      const conflict = spawnSync(shell, args, { env: conflictEnv, encoding: "utf8", windowsHide: true, timeout: 60_000 });
      assert.notEqual(conflict.status, 0);
      assert.match(`${conflict.stdout}\n${conflict.stderr}`, /ZCODE_HOME .*[\s\S]*ZCODE_DATA_BASE_DIR .*[\s\S]*conflict/u);
      assert.equal(existsSync(runtimeConfig), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor verifies explicit runtime, reports effective data sources, and hides config contents", async () => {
  const root = fixture("zcode-path-doctor-");
  try {
    const install = makeInstall(root, "ZCode");
    const automatic = makeInstall(root, "Automatic");
    const home = path.join(root, "home");
    const dataBase = path.join(root, "explicit data");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(dataBase, ".zcode", "v2"), { recursive: true });
    const runtime = path.join(install, "resources", "glm", "zcode.cjs");
    const builtin = path.join(install, "resources", "config", "provider", "zcode-builtin.json");
    const personal = path.join(dataBase, ".zcode", "v2", "provider_config.json");
    writeFileSync(personal, PERSONAL);

    const missingEnv = {
      ZCODE_BRIDGE_NODE: process.execPath,
      ZCODE_BRIDGE_ZCODE_CJS: path.join(root, "missing", "zcode.cjs"),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    };
    const missing = await runBridgeDoctor({ env: missingEnv, resolver: { env: missingEnv, homeDir: home, packageRoot: root } });
    const missingChecks = new Map(missing.checks.map((check) => [check.name, check]));
    assert.equal(missingChecks.get("zcode_install")?.status, "error");
    assert.match(missingChecks.get("zcode_install")?.summary ?? "", /not a readable file/u);

    const explicitEnv = {
      ZCODE_BRIDGE_NODE: process.execPath,
      ZCODE_BRIDGE_ZCODE_CJS: runtime,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
      ZCODE_WINDOWS_APP_INSTALL_DIR: automatic,
      ZCODE_DATA_BASE_DIR: dataBase,
      HOME: home,
      USERPROFILE: home,
    };
    const settingFile = path.join(home, ".zcode", "v2", "setting.json");
    writeUtf8NoBom(settingFile, JSON.stringify({ dataBaseDir: path.join(root, "setting-only") }));
    const explicit = await runBridgeDoctor({ env: explicitEnv, resolver: { env: explicitEnv, homeDir: home, packageRoot: root } });
    const explicitChecks = new Map(explicit.checks.map((check) => [check.name, check]));
    assert.equal(explicitChecks.get("zcode_install")?.status, "ok");
    assert.match(explicitChecks.get("zcode_install")?.summary ?? "", /derived from the same installation: .*ZCode/u);
    assert.match(explicitChecks.get("zcode_install")?.summary ?? "", /auto-discovery would choose .*Automatic/u);
    assert.match(explicitChecks.get("zcode_data_dir")?.summary ?? "", new RegExp(`${dataBase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\(from explicit ZCODE_DATA_BASE_DIR\\)`));

    const permissionEnv = {
      HOME: home,
      USERPROFILE: home,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
      ZCODE_BRIDGE_NODE: process.execPath,
      ZCODE_BRIDGE_ZCODE_CJS: runtime,
    };
    const denied = await runBridgeDoctor({
      env: permissionEnv,
      resolver: { env: permissionEnv, homeDir: home, packageRoot: root },
      settingReadFile: () => {
        throw Object.assign(new Error("read denied"), { code: "EPERM" });
      },
    });
    const deniedChecks = new Map(denied.checks.map((check) => [check.name, check]));
    assert.equal(deniedChecks.get("desktop_settings")?.status, "error");
    assert.equal(deniedChecks.get("desktop_settings")?.summary, "setting.json is not readable due to permissions; the default data location applies");

    writeUtf8NoBom(settingFile, `{"note":"TOKEN_DO_NOT_LEAK","dataBaseDir":"C:foo"}`);
    const invalidEnv = { HOME: home, USERPROFILE: home };
    const invalid = await runBridgeDoctor({
      env: invalidEnv,
      resolver: { env: invalidEnv, homeDir: home, packageRoot: root },
      settingReadFile: () => `{"note":"TOKEN_DO_NOT_LEAK","dataBaseDir":"C:foo"}`,
    });
    const invalidChecks = new Map(invalid.checks.map((check) => [check.name, check]));
    assert.equal(invalidChecks.get("desktop_settings")?.status, "warning");
    assert.match(invalidChecks.get("desktop_settings")?.summary ?? "", /relative path/u);
    assert.equal(invalidChecks.get("zcode_data_dir")?.status, "ok");
    assert.match(invalidChecks.get("zcode_data_dir")?.summary ?? "", /from default \(user directory\)/u);
    assert.doesNotMatch(JSON.stringify(invalid), /TOKEN_DO_NOT_LEAK/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
