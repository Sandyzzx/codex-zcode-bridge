/**
 * Unified ZCode path discovery.
 *
 * Contracts (docs/ZCODE_RUNTIME.md, ADR-020):
 * - User directory follows Magpie's Windows HOME rule (internal/appdir/zcode.go,
 *   v0.1.2127, reimplemented independently): HOME wins only when it is a rooted
 *   absolute path whose cleaned form equals USERPROFILE (case-insensitive on
 *   Windows). Test or WSL directories in HOME never override the real user
 *   directory. On POSIX, HOME wins as usual.
 * - Data directory: ZCode Desktop reads `dataBaseDir` from
 *   `<userHome>/.zcode/v2/setting.json` and uses it only when it is a non-empty
 *   absolute path; otherwise the data base directory is the user directory.
 *   Layout: `<dataBaseDir>/.zcode` (data root), `<dataBaseDir>/.zcode/v2`.
 * - Bridge env semantics are frozen and distinct from Magpie's functions:
 *   ZCODE_HOME names the `.zcode` directory itself; ZCODE_DATA_BASE_DIR names
 *   its parent. Explicit configuration wins over discovery; conflicting
 *   explicit values must error, never silently pick one.
 *
 * All functions take injectable environments and (where the filesystem is
 * touched) injectable readers so tests never depend on the real user data.
 * No function returns settings or provider config contents.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type UserHomeSource = "HOME" | "USERPROFILE" | "FALLBACK";

export interface UserHomeDiscovery {
  /** Effective user directory (absolute, normalized for the platform). */
  userHome: string;
  /** Where the user directory came from. */
  source: UserHomeSource;
  /** Raw HOME value (trimmed) for diagnostics; null when unset/empty. */
  homeRaw: string | null;
  /** Why HOME was not adopted; null when HOME was adopted or unset. */
  homeConflict: string | null;
}

export interface UserHomeOptions {
  /** Defaults to process.platform; lets tests exercise Windows rules anywhere. */
  platform?: NodeJS.Platform;
  /** Used when neither HOME nor USERPROFILE yields a directory. */
  fallbackHomeDir?: string;
}

export function resolveUserHome(
  env: NodeJS.ProcessEnv,
  options: UserHomeOptions = {},
): UserHomeDiscovery {
  const platform = options.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const homeRaw = env["HOME"]?.trim() || null;
  const userProfileRaw = env["USERPROFILE"]?.trim() || null;

  if (platform !== "win32") {
    if (homeRaw) {
      return { userHome: pathImpl.resolve(homeRaw), source: "HOME", homeRaw, homeConflict: null };
    }
    const fallback = userProfileRaw ?? options.fallbackHomeDir ?? "";
    if (!fallback) {
      throw new Error("no user home directory available (HOME is empty and no fallback provided)");
    }
    return { userHome: pathImpl.resolve(fallback), source: userProfileRaw ? "USERPROFILE" : "FALLBACK", homeRaw: null, homeConflict: null };
  }

  if (homeRaw) {
    const rooted = pathImpl.isAbsolute(homeRaw);
    const matchesUserProfile = userProfileRaw !== null
      && sameCleanPath(homeRaw, userProfileRaw, pathImpl, true);
    if (rooted && matchesUserProfile) {
      return { userHome: pathImpl.resolve(homeRaw), source: "HOME", homeRaw, homeConflict: null };
    }
    const conflict = !rooted
      ? "HOME is set but is not an absolute path"
      : userProfileRaw === null
        ? "HOME is set but USERPROFILE is not, so HOME cannot be verified as the current Windows user directory"
        : "HOME is set but does not match USERPROFILE (test or WSL directories must not override the Windows user directory)";
    if (userProfileRaw) {
      return { userHome: pathImpl.resolve(userProfileRaw), source: "USERPROFILE", homeRaw, homeConflict: conflict };
    }
    const fallback = options.fallbackHomeDir;
    if (!fallback) {
      throw new Error("no Windows user directory available (HOME is invalid and no USERPROFILE or fallback provided)");
    }
    return { userHome: pathImpl.resolve(fallback), source: "FALLBACK", homeRaw, homeConflict: conflict };
  }

  if (userProfileRaw) {
    return { userHome: pathImpl.resolve(userProfileRaw), source: "USERPROFILE", homeRaw: null, homeConflict: null };
  }
  const fallback = options.fallbackHomeDir;
  if (!fallback) {
    throw new Error("no Windows user directory available (HOME and USERPROFILE are unset and no fallback provided)");
  }
  return { userHome: pathImpl.resolve(fallback), source: "FALLBACK", homeRaw: null, homeConflict: null };
}

export type SettingFileStatus = "ok" | "absent" | "unreadable" | "invalid_json" | "invalid_shape" | "permission_denied";

export interface ZCodeDataDiscovery {
  userHome: string;
  /** `<userHome>/.zcode/v2/setting.json` — always the original user directory. */
  settingFile: string;
  settingStatus: SettingFileStatus;
  /** Read/validation failure reason; never settings content. */
  settingError: string | null;
  /** Valid absolute `dataBaseDir` from setting.json; null when not configured. */
  configuredDataBaseDir: string | null;
  /** Effective data base directory: configured value or the user directory. */
  dataBaseDir: string;
  dataBaseDirSource: "setting.json" | "default";
  /** `<dataBaseDir>/.zcode` — the ZCode data root. */
  zcodeDataDir: string;
  /** `<dataBaseDir>/.zcode/v2`. */
  zcodeV2Dir: string;
  /** True when setting.json moved the data directory away from the user home. */
  migrated: boolean;
}

export interface ZCodeDataOptions extends UserHomeOptions {
  readFile?: (filePath: string) => string;
  fileExists?: (filePath: string) => boolean;
}

export function discoverZCodeData(
  env: NodeJS.ProcessEnv,
  options: ZCodeDataOptions = {},
): ZCodeDataDiscovery {
  const platform = options.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  const fileExists = options.fileExists ?? existsSync;
  const home = resolveUserHome(env, options);
  const settingFile = pathImpl.join(home.userHome, ".zcode", "v2", "setting.json");

  let settingStatus: SettingFileStatus = "ok";
  let settingError: string | null = null;
  let configuredDataBaseDir: string | null = null;

  if (!fileExists(settingFile)) {
    settingStatus = "absent";
  } else {
    let text: string;
    try {
      text = readFile(settingFile);
    } catch (error) {
      settingStatus = (error as NodeJS.ErrnoException).code === "EACCES" ? "permission_denied" : "unreadable";
      settingError = error instanceof Error ? error.message : String(error);
      text = "";
    }
    if (settingStatus === "ok") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        settingStatus = "invalid_json";
        settingError = error instanceof Error ? error.message : String(error);
      }
      if (settingStatus === "ok") {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          settingStatus = "invalid_shape";
          settingError = "setting.json must contain a JSON object";
        } else {
          const raw = (parsed as Record<string, unknown>)["dataBaseDir"];
          if (raw === undefined || raw === null) {
            // No dataBaseDir configured: the default location applies.
          } else if (typeof raw !== "string") {
            settingStatus = "invalid_shape";
            settingError = "dataBaseDir must be a string when present";
          } else {
            const trimmed = raw.trim();
            if (trimmed && pathImpl.isAbsolute(trimmed)) {
              configuredDataBaseDir = pathImpl.resolve(trimmed);
            } else if (trimmed) {
              // A relative dataBaseDir is ignored (ZCode behavior), not an error.
              settingError = "dataBaseDir is a relative path and was ignored";
            }
          }
        }
      }
    }
  }

  const dataBaseDir = configuredDataBaseDir ?? home.userHome;
  return {
    userHome: home.userHome,
    settingFile,
    settingStatus,
    settingError,
    configuredDataBaseDir,
    dataBaseDir,
    dataBaseDirSource: configuredDataBaseDir ? "setting.json" : "default",
    zcodeDataDir: pathImpl.join(dataBaseDir, ".zcode"),
    zcodeV2Dir: pathImpl.join(dataBaseDir, ".zcode", "v2"),
    migrated: configuredDataBaseDir !== null,
  };
}

export type InstallSource = "ZCODE_WINDOWS_APP_INSTALL_DIR" | "LOCALAPPDATA" | "ProgramFiles";

export interface InstallCandidate {
  root: string;
  source: InstallSource;
  runtimeExists: boolean;
  builtinExists: boolean;
}

export interface ZCodeInstallDiscovery {
  installDir: string | null;
  source: InstallSource | null;
  /** `<installDir>/resources/glm/zcode.cjs` when discovered. */
  zcodeEntrypoint: string | null;
  /** `<installDir>/resources/config/provider/zcode-builtin.json` when discovered. */
  builtinConfigFile: string | null;
  /** All roots considered, in priority order, with per-root evidence. */
  candidates: InstallCandidate[];
}

export interface ZCodeInstallOptions {
  platform?: NodeJS.Platform;
  /** Require the builtin provider config in the same root (default true). */
  requireBuiltin?: boolean;
  fileExists?: (filePath: string) => boolean;
}

/**
 * Fixed Windows install priority: ZCODE_WINDOWS_APP_INSTALL_DIR, then
 * %LOCALAPPDATA%/Programs/ZCode, then %ProgramFiles%/ZCode. A root is only
 * accepted when the runtime and (by default) the builtin provider config live
 * in the same installation, so mixed-version files are never combined.
 */
export function discoverZCodeInstall(
  env: NodeJS.ProcessEnv,
  options: ZCodeInstallOptions = {},
): ZCodeInstallDiscovery {
  const platform = options.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const fileExists = options.fileExists ?? existsSync;
  const requireBuiltin = options.requireBuiltin ?? true;
  const roots: { root: string; source: InstallSource }[] = [];
  const explicit = env["ZCODE_WINDOWS_APP_INSTALL_DIR"]?.trim();
  if (explicit) roots.push({ root: explicit, source: "ZCODE_WINDOWS_APP_INSTALL_DIR" });
  const localAppData = env["LOCALAPPDATA"]?.trim();
  if (localAppData) roots.push({ root: pathImpl.join(localAppData, "Programs", "ZCode"), source: "LOCALAPPDATA" });
  const programFiles = env["ProgramFiles"]?.trim() ?? env["PROGRAMFILES"]?.trim();
  if (programFiles) roots.push({ root: pathImpl.join(programFiles, "ZCode"), source: "ProgramFiles" });

  const candidates: InstallCandidate[] = roots.map(({ root, source }) => ({
    root,
    source,
    runtimeExists: fileExists(pathImpl.join(root, "resources", "glm", "zcode.cjs")),
    builtinExists: fileExists(pathImpl.join(root, "resources", "config", "provider", "zcode-builtin.json")),
  }));
  for (const candidate of candidates) {
    if (!candidate.runtimeExists) continue;
    if (requireBuiltin && !candidate.builtinExists) continue;
    return {
      installDir: candidate.root,
      source: candidate.source,
      zcodeEntrypoint: pathImpl.join(candidate.root, "resources", "glm", "zcode.cjs"),
      builtinConfigFile: requireBuiltin || candidate.builtinExists
        ? pathImpl.join(candidate.root, "resources", "config", "provider", "zcode-builtin.json")
        : null,
      candidates,
    };
  }
  return { installDir: null, source: null, zcodeEntrypoint: null, builtinConfigFile: null, candidates };
}

/**
 * Builtin provider config that belongs to the same installation as an explicit
 * runtime entrypoint (mirrors configure-runtime.ps1's derivation).
 */
export function builtinConfigForRuntime(zcodeEntrypoint: string, platform: NodeJS.Platform = process.platform): string {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const resourcesDir = pathImpl.dirname(pathImpl.dirname(zcodeEntrypoint));
  return pathImpl.join(resourcesDir, "config", "provider", "zcode-builtin.json");
}

/** Case-insensitive (Windows) comparison of two cleaned absolute-ish paths. */
export function sameFileSystemPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  return sameCleanPath(left, right, pathImpl, platform === "win32");
}

function sameCleanPath(left: string, right: string, pathImpl: path.PlatformPath, caseInsensitive: boolean): boolean {
  const cleanLeft = pathImpl.normalize(left);
  const cleanRight = pathImpl.normalize(right);
  return caseInsensitive
    ? cleanLeft.toLowerCase() === cleanRight.toLowerCase()
    : cleanLeft === cleanRight;
}
