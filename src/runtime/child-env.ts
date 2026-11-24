import { resolveUserHome } from "./paths.js";

/** Environment variables needed to start Node/ZCode without inheriting secrets. */
const WINDOWS_OS_ENV = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  // Non-sensitive system install directories; browser auto-discovery resolves
  // system Chrome/Edge under these roots (src/browser/executable.ts).
  "PROGRAMFILES", "PROGRAMFILES(X86)",
]);
const POSIX_OS_ENV = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
]);

export interface MinimalOsEnvOptions {
  /** Defaults to process.platform; injectable for tests. */
  platform?: NodeJS.Platform;
}

export function createMinimalOsEnv(source: NodeJS.ProcessEnv, options: MinimalOsEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const allowed = platform === "win32" ? WINDOWS_OS_ENV : POSIX_OS_ENV;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  if (platform === "win32") {
    // ZCode itself prefers HOME over homedir() for its data directory, so the
    // child must see the same unified user directory the Bridge resolved
    // (Magpie rule) instead of a parent-process HOME pointing at a test or
    // WSL directory. USERPROFILE is forwarded unchanged.
    try {
      const home = resolveUserHome(source, { platform });
      if (home.userHome) env["HOME"] = home.userHome;
    } catch {
      // No resolvable user directory: leave the filtered environment as-is.
    }
  }
  return env;
}

/** Detached workers need Bridge configuration, but never arbitrary parent secrets. */
export function createWorkerEnv(source: NodeJS.ProcessEnv, options: MinimalOsEnvOptions = {}): NodeJS.ProcessEnv {
  const env = createMinimalOsEnv(source, options);
  const explicitBridgeKeys = new Set([
    "ZCODE_BRIDGE_NODE", "ZCODE_BRIDGE_ZCODE_CJS", "ZCODE_BRIDGE_DATA_DIR",
    "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID", "ZCODE_BRIDGE_DEFAULT_MODEL_ID",
    "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL", "ZCODE_BRIDGE_MODE",
    "ZCODE_BRIDGE_TIMEOUT_MS",
    // Env-only browser configuration (ADR-007): non-secret strings the worker's
    // adapter reads from its own environment when no persisted setting exists.
    "ZCODE_BRIDGE_BROWSER_USE", "ZCODE_BRIDGE_BROWSER_EXECUTABLE",
    "ZCODE_HOME",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_DATA_BASE_DIR", "ZCODE_WINDOWS_APP_INSTALL_DIR",
  ]);
  for (const key of explicitBridgeKeys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
