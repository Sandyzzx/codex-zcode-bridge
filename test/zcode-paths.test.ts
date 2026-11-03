// Unified ZCode path discovery matrix (WP: Path Discoverer, ADR-020).
// All scenarios use injected environments and disposable temp directories;
// no test reads or writes real ZCode user data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverZCodeData, discoverZCodeInstall, resolveUserHome, sameFileSystemPath } from "../src/runtime/paths.js";
import { createWorkerEnv } from "../src/runtime/child-env.js";
import { NodeRuntimeResolver } from "../src/runtime/resolver.js";

const BUILTIN = JSON.stringify({ schemaVersion: 1, revision: 1, config: {} });
const REAL_PERSONAL = JSON.stringify({
  schemaVersion: 1,
  config: { providerConfigRules: { providerRules: { "p-1": {} } } },
});

function makeFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-paths-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSetting(userHome: string, body: string): void {
  mkdirSync(path.join(userHome, ".zcode", "v2"), { recursive: true });
  writeFileSync(path.join(userHome, ".zcode", "v2", "setting.json"), body);
}

function makeInstall(root: string, name: string, options: { runtime?: boolean; builtin?: boolean } = {}): string {
  const install = path.join(root, name);
  if (options.runtime !== false) {
    mkdirSync(path.join(install, "resources", "glm"), { recursive: true });
    writeFileSync(path.join(install, "resources", "glm", "zcode.cjs"), "// fake");
  }
  if (options.builtin !== false) {
    mkdirSync(path.join(install, "resources", "config", "provider"), { recursive: true });
    writeFileSync(path.join(install, "resources", "config", "provider", "zcode-builtin.json"), BUILTIN);
  }
  return install;
}

test("Windows default discovery falls back to USERPROFILE when HOME is unset", () => {
  const home = resolveUserHome({ USERPROFILE: "C:\\Users\\Sandy" }, { platform: "win32" });
  assert.equal(home.userHome, "C:\\Users\\Sandy");
  assert.equal(home.source, "USERPROFILE");
  assert.equal(home.homeConflict, null);
});

test("Windows HOME is adopted only when it matches USERPROFILE", () => {
  const match = resolveUserHome({ HOME: "C:/Users/Sandy", USERPROFILE: "C:\\Users\\Sandy" }, { platform: "win32" });
  assert.equal(match.userHome, "C:\\Users\\Sandy");
  assert.equal(match.source, "HOME");

  const caseOnly = resolveUserHome({ HOME: "C:\\USERS\\SANDY", USERPROFILE: "C:\\Users\\Sandy" }, { platform: "win32" });
  assert.equal(caseOnly.source, "HOME");
  assert.equal(caseOnly.userHome, "C:\\USERS\\SANDY");
});

test("Windows HOME from test or WSL directories never overrides the user directory", () => {
  const wsl = resolveUserHome({ HOME: "\\\\wsl$\\Ubuntu\\home\\dev", USERPROFILE: "C:\\Users\\Sandy" }, { platform: "win32" });
  assert.equal(wsl.userHome, "C:\\Users\\Sandy");
  assert.equal(wsl.source, "USERPROFILE");
  assert.match(wsl.homeConflict!, /does not match USERPROFILE/u);

  const testDir = resolveUserHome({ HOME: "D:\\bridge-test-home", USERPROFILE: "C:\\Users\\Sandy" }, { platform: "win32" });
  assert.equal(testDir.userHome, "C:\\Users\\Sandy");
});

test("Windows relative or empty HOME values are ignored", () => {
  const relative = resolveUserHome({ HOME: "relative/home", USERPROFILE: "C:\\Users\\Sandy" }, { platform: "win32" });
  assert.equal(relative.userHome, "C:\\Users\\Sandy");
  assert.match(relative.homeConflict!, /not an absolute path/u);

  const empty = resolveUserHome({ HOME: "   ", USERPROFILE: "C:\\Users\\Sandy" }, { platform: "win32" });
  assert.equal(empty.source, "USERPROFILE");
  assert.equal(empty.homeConflict, null);
});

test("Windows discovery without HOME or USERPROFILE uses the injected fallback", () => {
  const home = resolveUserHome({}, { platform: "win32", fallbackHomeDir: "D:\\fixture-home" });
  assert.equal(home.userHome, "D:\\fixture-home");
  assert.equal(home.source, "FALLBACK");
});

test("POSIX discovery keeps HOME first", () => {
  const home = resolveUserHome({ HOME: "/home/dev", USERPROFILE: "/ignored" }, { platform: "linux" });
  assert.equal(home.userHome, "/home/dev");
  assert.equal(home.source, "HOME");

  const fallback = resolveUserHome({}, { platform: "linux", fallbackHomeDir: "/fallback" });
  assert.equal(fallback.userHome, "/fallback");
  assert.equal(fallback.source, "FALLBACK");
});

test("setting.json dataBaseDir drives the data directory only when absolute", () => {
  const { root, cleanup } = makeFixture();
  try {
    const userHome = path.join(root, "user");
    const migrated = path.join(root, "moved data");
    writeSetting(userHome, JSON.stringify({ dataBaseDir: migrated }));
    const data = discoverZCodeData({ USERPROFILE: userHome }, { platform: "win32" });
    assert.equal(data.settingStatus, "ok");
    assert.equal(data.dataBaseDirSource, "setting.json");
    assert.equal(data.dataBaseDir, path.win32.resolve(migrated));
    assert.equal(data.migrated, true);
    assert.equal(data.zcodeDataDir, path.win32.resolve(migrated, ".zcode"));
    assert.equal(data.zcodeV2Dir, path.win32.resolve(migrated, ".zcode", "v2"));
    assert.equal(data.userHome, path.win32.resolve(userHome), "settingFile stays in the original user directory");
  } finally {
    cleanup();
  }
});

test("missing, broken, empty, relative, or non-string dataBaseDir safely falls back", () => {
  const { root, cleanup } = makeFixture();
  try {
    const userHome = path.join(root, "user");
    const base = { USERPROFILE: userHome };

    const absent = discoverZCodeData(base, { platform: "win32" });
    assert.equal(absent.settingStatus, "absent");
    assert.equal(absent.dataBaseDirSource, "default");

    writeSetting(userHome, "{not json");
    const broken = discoverZCodeData(base, { platform: "win32" });
    assert.equal(broken.settingStatus, "invalid_json");
    assert.equal(broken.dataBaseDirSource, "default");

    writeSetting(userHome, JSON.stringify({ dataBaseDir: "" }));
    assert.equal(discoverZCodeData(base, { platform: "win32" }).dataBaseDirSource, "default");

    writeSetting(userHome, JSON.stringify({ dataBaseDir: "relative/dir" }));
    const relative = discoverZCodeData(base, { platform: "win32" });
    assert.equal(relative.dataBaseDirSource, "default");
    assert.match(relative.settingError!, /relative path/u);

    writeSetting(userHome, JSON.stringify({ dataBaseDir: 42 }));
    assert.equal(discoverZCodeData(base, { platform: "win32" }).settingStatus, "invalid_shape");

    writeSetting(userHome, "[]");
    assert.equal(discoverZCodeData(base, { platform: "win32" }).settingStatus, "invalid_shape");
  } finally {
    cleanup();
  }
});

test("dataBaseDir on a different drive or with spaces and Unicode is honored verbatim", () => {
  const data = discoverZCodeData(
    { HOME: "C:\\Users\\Sandy", USERPROFILE: "C:\\Users\\Sandy" },
    {
      platform: "win32",
      fileExists: () => true,
      readFile: () => JSON.stringify({ dataBaseDir: "Q:\\数据 目录\\zcode-data" }),
    },
  );
  assert.equal(data.dataBaseDir, "Q:\\数据 目录\\zcode-data");
  assert.equal(data.migrated, true);
});

test("install discovery follows the fixed priority and rejects mixed installations", () => {
  const { root, cleanup } = makeFixture();
  try {
    const explicitRoot = makeInstall(root, "explicit");
    const localRoot = makeInstall(root, "local");
    const programFilesRoot = makeInstall(root, "pf");
    const baseEnv = { LOCALAPPDATA: path.join(root, "local-parent"), ProgramFiles: path.join(root, "pf-parent") };
    // Position the roots so priority, not existence order, decides.
    const localInstall = path.join(root, "local-parent", "Programs", "ZCode");
    const pfInstall = path.join(root, "pf-parent", "ZCode");
    rmSync(localRoot, { recursive: true, force: true });
    rmSync(programFilesRoot, { recursive: true, force: true });
    mkdirSync(path.dirname(localInstall), { recursive: true });
    mkdirSync(path.dirname(pfInstall), { recursive: true });
    for (const install of [localInstall, pfInstall]) {
      mkdirSync(path.join(install, "resources", "glm"), { recursive: true });
      writeFileSync(path.join(install, "resources", "glm", "zcode.cjs"), "// fake");
      mkdirSync(path.join(install, "resources", "config", "provider"), { recursive: true });
      writeFileSync(path.join(install, "resources", "config", "provider", "zcode-builtin.json"), BUILTIN);
    }

    const none = discoverZCodeInstall(baseEnv, { platform: "win32" });
    assert.equal(none.installDir, localInstall, "LOCALAPPDATA outranks ProgramFiles");
    assert.equal(none.source, "LOCALAPPDATA");

    const explicit = discoverZCodeInstall({ ...baseEnv, ZCODE_WINDOWS_APP_INSTALL_DIR: explicitRoot }, { platform: "win32" });
    assert.equal(explicit.installDir, explicitRoot);
    assert.equal(explicit.source, "ZCODE_WINDOWS_APP_INSTALL_DIR");
    assert.equal(explicit.zcodeEntrypoint, path.join(explicitRoot, "resources", "glm", "zcode.cjs"));

    // A root with a runtime but no builtin is skipped instead of mixed.
    rmSync(path.join(localInstall, "resources", "config", "provider", "zcode-builtin.json"));
    const mixed = discoverZCodeInstall(baseEnv, { platform: "win32" });
    assert.equal(mixed.installDir, pfInstall);
    assert.equal(mixed.candidates.find((candidate) => candidate.root === localInstall)?.builtinExists, false);
  } finally {
    cleanup();
  }
});

test("explicit runtime derives its builtin config from the same installation", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root, "ZCode");
    const other = makeInstall(root, "Other");
    const personal = path.join(root, "personal.json");
    writeFileSync(personal, REAL_PERSONAL);
    const homeDir = path.join(root, "home");
    const env = {
      ZCODE_BRIDGE_NODE: path.join(root, "node.exe"),
      ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "zcode.cjs"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
      ZCODE_WINDOWS_APP_INSTALL_DIR: other,
    };
    writeFileSync(path.join(root, "node.exe"), "// fake node");
    const resolved = await new NodeRuntimeResolver({ env, packageRoot: root, homeDir }).resolve();
    assert.equal(resolved.providerBuiltinConfigFile, path.join(install, "resources", "config", "provider", "zcode-builtin.json"));

    rmSync(path.join(install, "resources", "config", "provider", "zcode-builtin.json"));
    await assert.rejects(
      () => new NodeRuntimeResolver({ env, packageRoot: root, homeDir }).resolve(),
      /builtin config was not found next to the configured runtime/u,
    );
  } finally {
    cleanup();
  }
});

test("conflicting explicit ZCODE_HOME and ZCODE_DATA_BASE_DIR error instead of silently choosing", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root, "ZCode");
    const base = path.join(root, "data-base");
    mkdirSync(path.join(root, "elsewhere", ".zcode"), { recursive: true });
    writeFileSync(path.join(root, "node.exe"), "// fake node");
    const personal = path.join(base, ".zcode", "v2", "provider_config.json");
    mkdirSync(path.dirname(personal), { recursive: true });
    writeFileSync(personal, REAL_PERSONAL);
    const env = {
      ZCODE_BRIDGE_NODE: path.join(root, "node.exe"),
      ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "zcode.cjs"),
      ZCODE_HOME: path.join(root, "elsewhere", ".zcode"),
      ZCODE_DATA_BASE_DIR: base,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    };
    await assert.rejects(
      () => new NodeRuntimeResolver({ env, packageRoot: root, homeDir: path.join(root, "home") }).resolve(),
      /ZCODE_HOME .* and ZCODE_DATA_BASE_DIR .* conflict/u,
    );

    const consistent = { ...env, ZCODE_HOME: path.join(base, ".zcode") };
    const resolved = await new NodeRuntimeResolver({ env: consistent, packageRoot: root, homeDir: path.join(root, "home") }).resolve();
    assert.equal(resolved.providerPersonalConfigFile, personal);
  } finally {
    cleanup();
  }
});

test("detached worker environments resolve the same user directory as the Bridge", () => {
  const source = {
    // A parent process with a Git-Bash style HOME pointing elsewhere must not
    // make the worker follow it.
    HOME: "D:\\bridge-test-home",
    USERPROFILE: "C:\\Users\\Sandy",
    PATH: "safe-path",
  };
  const workerEnv = createWorkerEnv(source);
  const workerHome = resolveUserHome(workerEnv, { platform: "win32" });
  const mainHome = resolveUserHome(source, { platform: "win32" });
  assert.equal(workerHome.userHome, mainHome.userHome);
  assert.equal(workerHome.userHome, "C:\\Users\\Sandy");
  assert.equal(workerEnv.HOME, "C:\\Users\\Sandy");

  const posixWorker = createWorkerEnv({ HOME: "/home/dev", PATH: "safe-path" }, { platform: "linux" });
  assert.equal(posixWorker.HOME, "/home/dev");
});

test("worker and main resolver agree on the personal provider config location", async () => {
  const { root, cleanup } = makeFixture();
  try {
    const install = makeInstall(root, "ZCode");
    const userHome = path.join(root, "user");
    const migrated = path.join(root, "moved");
    writeSetting(userHome, JSON.stringify({ dataBaseDir: migrated }));
    mkdirSync(path.join(migrated, ".zcode", "v2"), { recursive: true });
    writeFileSync(path.join(migrated, ".zcode", "v2", "provider_config.json"), REAL_PERSONAL);
    writeFileSync(path.join(root, "node.exe"), "// fake node");
    const sourceEnv = { USERPROFILE: userHome, HOME: "D:\\bridge-test-home" };
    const workerEnv = createWorkerEnv(sourceEnv);
    for (const env of [sourceEnv, workerEnv]) {
      const resolved = await new NodeRuntimeResolver({
        env: { ...env, ZCODE_BRIDGE_NODE: path.join(root, "node.exe"), ZCODE_BRIDGE_ZCODE_CJS: path.join(install, "resources", "glm", "zcode.cjs") },
        packageRoot: root,
        homeDir: userHome,
      }).resolve();
      assert.equal(resolved.providerPersonalConfigFile, path.join(migrated, ".zcode", "v2", "provider_config.json"));
    }
  } finally {
    cleanup();
  }
});

test("sameFileSystemPath is case-insensitive on Windows only", () => {
  assert.equal(sameFileSystemPath("C:\\A\\B", "c:\\a\\b", "win32"), true);
  assert.equal(sameFileSystemPath("C:/A/B", "C:\\A\\B", "win32"), true);
  assert.equal(sameFileSystemPath("/home/dev", "/home/dev", "linux"), true);
  assert.equal(sameFileSystemPath("/home/Dev", "/home/dev", "linux"), false);
});

test("PowerShell discovery matches TypeScript discovery", { skip: process.platform !== "win32" }, () => {
  const { root, cleanup } = makeFixture();
  try {
    const userHome = path.join(root, "user home");
    const migrated = path.join(root, "moved data");
    writeSetting(userHome, JSON.stringify({ dataBaseDir: migrated }));
    const install = makeInstall(root, "ZCode");
    const scenarioEnv = {
      ...process.env,
      USERPROFILE: userHome,
      HOME: "D:\\bridge-test-home",
      ZCODE_WINDOWS_APP_INSTALL_DIR: install,
      LOCALAPPDATA: root,
      ProgramFiles: path.join(root, "pf"),
    };

    const powershell = process.env.WP6_PARITY_PWSH?.trim() || "powershell";
    const script = path.resolve("plugins", "codex-zcode-bridge", "hooks", "configure-runtime.ps1");
    const stdout = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & '${script}' -PrintPathDiscovery`,
      ],
      { env: scenarioEnv, encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    const ps = JSON.parse(stdout.slice(stdout.indexOf("{")));

    const data = discoverZCodeData(scenarioEnv, { platform: "win32" });
    assert.equal(ps.userHome, data.userHome, `userHome: ${ps.userHome} vs ${data.userHome}`);
    const home = resolveUserHome(scenarioEnv, { platform: "win32" });
    assert.equal(ps.userHomeSource, home.source);
    assert.equal(ps.settingFile, data.settingFile);
    assert.equal(ps.settingStatus, data.settingStatus);
    assert.equal(ps.configuredDataBaseDir, data.configuredDataBaseDir);
    assert.equal(ps.dataBaseDir, data.dataBaseDir);
    assert.equal(ps.dataBaseDirSource, data.dataBaseDirSource);
    assert.equal(ps.zcodeDataDir, data.zcodeDataDir);
    assert.equal(ps.zcodeV2Dir, data.zcodeV2Dir);
    assert.equal(ps.migrated, data.migrated);
    assert.equal(ps.install.installDir, install);
    assert.equal(ps.install.source, "ZCODE_WINDOWS_APP_INSTALL_DIR");
    assert.equal(ps.install.zcodeEntrypoint, path.win32.join(install, "resources", "glm", "zcode.cjs"));
  } finally {
    cleanup();
  }
});
