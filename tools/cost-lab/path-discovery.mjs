import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const USER_HOME_SOURCES = Object.freeze(["HOME", "USERPROFILE", "FALLBACK"]);
export const SETTING_FILE_STATUSES = Object.freeze([
  "ok",
  "absent",
  "unreadable",
  "invalid_json",
  "invalid_shape",
  "permission_denied",
]);

export function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || /^\/\/[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/u.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/u.test(value);
}

export function isAbsolutePathForPlatform(value, platform = process.platform) {
  return platform === "win32" ? isWindowsAbsolutePath(value) : path.posix.isAbsolute(value);
}

function isPermissionDenied(error) {
  return error?.code === "EACCES" || error?.code === "EPERM";
}

export function resolveUserHome({
  env = process.env,
  platform = process.platform,
  fallbackHomeDir = null,
} = {}) {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const homeRaw = env.HOME?.trim() || null;
  const userProfileRaw = env.USERPROFILE?.trim() || null;

  if (platform !== "win32") {
    if (homeRaw) return { userHome: pathImpl.resolve(homeRaw), source: "HOME", homeRaw, homeConflict: null };
    const fallback = userProfileRaw ?? fallbackHomeDir;
    if (!fallback) throw new Error("user_home_unavailable");
    return {
      userHome: pathImpl.resolve(fallback),
      source: userProfileRaw ? "USERPROFILE" : "FALLBACK",
      homeRaw: null,
      homeConflict: null,
    };
  }

  if (homeRaw) {
    const rooted = isWindowsAbsolutePath(homeRaw);
    const matchesProfile = userProfileRaw !== null
      && pathImpl.normalize(homeRaw).toLowerCase()
        === pathImpl.normalize(userProfileRaw).toLowerCase();
    if (rooted && matchesProfile) {
      return { userHome: pathImpl.resolve(homeRaw), source: "HOME", homeRaw, homeConflict: null };
    }
    const conflict = !rooted
      ? "home_not_absolute"
      : userProfileRaw === null
        ? "home_without_userprofile"
        : "home_does_not_match_userprofile";
    if (userProfileRaw) {
      return {
        userHome: pathImpl.resolve(userProfileRaw),
        source: "USERPROFILE",
        homeRaw,
        homeConflict: conflict,
      };
    }
    if (!fallbackHomeDir) throw new Error("windows_user_home_unavailable");
    return {
      userHome: pathImpl.resolve(fallbackHomeDir),
      source: "FALLBACK",
      homeRaw,
      homeConflict: conflict,
    };
  }

  if (userProfileRaw) {
    return {
      userHome: pathImpl.resolve(userProfileRaw),
      source: "USERPROFILE",
      homeRaw: null,
      homeConflict: null,
    };
  }
  if (!fallbackHomeDir) throw new Error("windows_user_home_unavailable");
  return {
    userHome: pathImpl.resolve(fallbackHomeDir),
    source: "FALLBACK",
    homeRaw: null,
    homeConflict: null,
  };
}

export function discoverZCodeData({
  env = process.env,
  platform = process.platform,
  fallbackHomeDir = null,
  fileExists = existsSync,
  readFile = (filePath) => readFileSync(filePath, "utf8"),
} = {}) {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const home = resolveUserHome({ env, platform, fallbackHomeDir });
  const settingFile = pathImpl.join(home.userHome, ".zcode", "v2", "setting.json");

  let settingStatus = "ok";
  let settingError = null;
  let configuredDataBaseDir = null;

  if (!fileExists(settingFile)) {
    settingStatus = "absent";
  } else {
    let text;
    try {
      text = readFile(settingFile);
    } catch (error) {
      settingStatus = isPermissionDenied(error) ? "permission_denied" : "unreadable";
      settingError = error instanceof Error ? error.message : String(error);
    }

    if (settingStatus === "ok") {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        settingStatus = "invalid_json";
        settingError = error instanceof Error ? error.message : String(error);
      }

      if (settingStatus === "ok") {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          settingStatus = "invalid_shape";
          settingError = "setting_json_not_object";
        } else {
          const raw = parsed.dataBaseDir;
          if (raw === undefined || raw === null) {
            // No override: ZCode uses the user home as its data base directory.
          } else if (typeof raw !== "string") {
            settingStatus = "invalid_shape";
            settingError = "data_base_dir_not_string";
          } else {
            const trimmed = raw.trim();
            if (trimmed && isAbsolutePathForPlatform(trimmed, platform)) {
              configuredDataBaseDir = pathImpl.resolve(trimmed);
            } else if (trimmed) {
              settingError = "relative_data_base_dir_ignored";
            }
          }
        }
      }
    }
  }

  const dataBaseDir = configuredDataBaseDir ?? home.userHome;
  return {
    userHome: home.userHome,
    userHomeSource: home.source,
    settingFile,
    settingStatus,
    settingError,
    configuredDataBaseDir,
    dataBaseDir,
    dataBaseDirSource: configuredDataBaseDir ? "setting.json" : "default",
    zcodeDataDir: pathImpl.join(dataBaseDir, ".zcode"),
    zcodeV2Dir: pathImpl.join(dataBaseDir, ".zcode", "v2"),
  };
}

export function resolveBillingDataBaseDir(explicitDataBaseDir, discoveryOptions = {}) {
  if (explicitDataBaseDir !== null && explicitDataBaseDir !== undefined) {
    if (typeof explicitDataBaseDir !== "string" || !explicitDataBaseDir.trim()) {
      throw new Error("billing_data_base_dir_empty");
    }
    return {
      dataBaseDir: path.resolve(explicitDataBaseDir.trim()),
      dataBaseDirSource: "explicit",
      discovery: null,
    };
  }
  const discovery = discoverZCodeData(discoveryOptions);
  return {
    dataBaseDir: discovery.dataBaseDir,
    dataBaseDirSource: discovery.dataBaseDirSource,
    discovery,
  };
}
