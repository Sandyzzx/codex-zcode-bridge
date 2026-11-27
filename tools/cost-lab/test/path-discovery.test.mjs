import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverZCodeData,
  resolveBillingDataBaseDir,
  resolveUserHome,
} from "../path-discovery.mjs";

test("explicit billing data root takes precedence over discovery", () => {
  const result = resolveBillingDataBaseDir("D:\\ExplicitRoot");
  assert.equal(result.dataBaseDir, "D:\\ExplicitRoot");
  assert.equal(result.dataBaseDirSource, "explicit");
  assert.equal(result.discovery, null);
});

test("Windows discovery reads an absolute setting.json dataBaseDir", () => {
  const result = discoverZCodeData({
    platform: "win32",
    env: {
      HOME: "C:\\Users\\Synthetic",
      USERPROFILE: "C:\\Users\\Synthetic",
    },
    fileExists: () => true,
    readFile: () => JSON.stringify({ dataBaseDir: "D:\\Program Files" }),
  });
  assert.equal(result.settingStatus, "ok");
  assert.equal(result.dataBaseDir, "D:\\Program Files");
  assert.equal(result.dataBaseDirSource, "setting.json");
  assert.equal(result.zcodeV2Dir, "D:\\Program Files\\.zcode\\v2");
});

test("missing setting.json falls back to the portable user home", () => {
  const result = discoverZCodeData({
    platform: "win32",
    env: {
      USERPROFILE: "C:\\Users\\Synthetic",
    },
    fileExists: () => false,
  });
  assert.equal(result.settingStatus, "absent");
  assert.equal(result.dataBaseDir, "C:\\Users\\Synthetic");
  assert.equal(result.dataBaseDirSource, "default");
});

test("relative dataBaseDir is ignored rather than resolved against the process cwd", () => {
  const result = discoverZCodeData({
    platform: "win32",
    env: {
      USERPROFILE: "C:\\Users\\Synthetic",
    },
    fileExists: () => true,
    readFile: () => JSON.stringify({ dataBaseDir: ".\\relative-root" }),
  });
  assert.equal(result.settingStatus, "ok");
  assert.equal(result.settingError, "relative_data_base_dir_ignored");
  assert.equal(result.dataBaseDir, "C:\\Users\\Synthetic");
  assert.equal(result.dataBaseDirSource, "default");
});

test("Windows HOME conflicting with USERPROFILE cannot redirect discovery", () => {
  const home = resolveUserHome({
    platform: "win32",
    env: {
      HOME: "D:\\UntrustedHome",
      USERPROFILE: "C:\\Users\\Synthetic",
    },
  });
  assert.equal(home.userHome, "C:\\Users\\Synthetic");
  assert.equal(home.source, "USERPROFILE");
  assert.equal(home.homeConflict, "home_does_not_match_userprofile");
});

test("invalid setting JSON is reported without changing the default root", () => {
  const result = discoverZCodeData({
    platform: "win32",
    env: {
      USERPROFILE: "C:\\Users\\Synthetic",
    },
    fileExists: () => true,
    readFile: () => "{not-json",
  });
  assert.equal(result.settingStatus, "invalid_json");
  assert.equal(result.dataBaseDir, "C:\\Users\\Synthetic");
});
