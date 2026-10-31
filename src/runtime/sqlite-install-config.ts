import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "./resolver.js";
import { validateHostProfile, type BridgeHostProfile } from "../host/profile.js";

const CONFIG_FILE = "authority.json";
const CONFIG_LIMIT = 8 * 1024;
export const FRESH_SQLITE_DATABASE_FILE = "bridge.sqlite";

export type InstallAuthoritySelection =
  | { readonly state: "json"; readonly configPath: string }
  | { readonly state: "sqlite"; readonly configPath: string; readonly configuredDataRoot: string };

export class SqliteInstallConfigurationError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "SqliteInstallConfigurationError"; }
}

/** A missing file preserves legacy JSON behavior; every explicit bad file fails startup. */
export function loadInstallAuthoritySelection(host: BridgeHostProfile): InstallAuthoritySelection {
  validateHostProfile(host);
  const configPath = path.join(host.settingsDirectory, CONFIG_FILE);
  try {
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SqliteInstallConfigurationError("authority_config_not_regular_file");
    if (stat.size > CONFIG_LIMIT) throw new SqliteInstallConfigurationError("authority_config_too_large");
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(parsed)) throw new SqliteInstallConfigurationError("authority_config_invalid_shape");
    const keys = Object.keys(parsed).sort().join("|");
    if (parsed.schema_version !== 1) throw new SqliteInstallConfigurationError("authority_config_version_unsupported");
    if (parsed.authority === "json" && keys === "authority|schema_version") return { state: "json", configPath };
    if (parsed.authority !== "sqlite" || (keys !== "authority|schema_version" && keys !== "authority|data_root|schema_version")) {
      throw new SqliteInstallConfigurationError("authority_config_invalid_contract");
    }
    const configuredDataRoot = parsed.data_root === undefined ? "" : parsed.data_root;
    if (typeof configuredDataRoot !== "string" || (configuredDataRoot && !isLocalAbsolutePath(configuredDataRoot))) {
      throw new SqliteInstallConfigurationError("authority_config_data_root_invalid");
    }
    return { state: "sqlite", configPath, configuredDataRoot };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "json", configPath };
    if (error instanceof SqliteInstallConfigurationError) throw error;
    throw new SqliteInstallConfigurationError("authority_config_unreadable_or_invalid", error instanceof Error ? error.message : "authority config failed");
  }
}

/** Create only the app and state directories, reject redirected roots, and never choose a different root. */
export function prepareFreshSqliteStateDirectory(
  selection: Extract<InstallAuthoritySelection, { readonly state: "sqlite" }>,
  env: NodeJS.ProcessEnv,
): { readonly dataRoot: string; readonly databaseFileName: typeof FRESH_SQLITE_DATABASE_FILE } {
  return prepareStateDirectory(selection, env, sqliteInstallationRoot(env), os.tmpdir());
}

// A marketplace plugin ships plugin manifests rather than a package.json.
// Only the actual bundled bridge in its expected layout may use that root;
// source/core entry points retain their existing package-root resolution.
function sqliteInstallationRoot(env: NodeJS.ProcessEnv): string {
  const modulePath = fileURLToPath(import.meta.url);
  const dist = path.dirname(modulePath);
  if (env["ZCODE_BRIDGE_PLUGIN_MODE"] === "1" && path.basename(modulePath) === "bridge.mjs" && path.basename(dist) === "dist") {
    const pluginRoot = path.dirname(dist);
    if (!existsSync(path.join(pluginRoot, ".codex-plugin", "plugin.json")) || !existsSync(path.join(pluginRoot, "launch-node24.mjs"))) {
      throw new SqliteInstallConfigurationError("sqlite_plugin_layout_invalid");
    }
    return pluginRoot;
  }
  return findPackageRoot();
}

/** Test-only reserved-root injection keeps synthetic databases inside the repository. */
export function prepareFreshSqliteStateDirectoryForTest(
  selection: Extract<InstallAuthoritySelection, { readonly state: "sqlite" }>,
  env: NodeJS.ProcessEnv,
  reserved: { readonly packageRoot: string; readonly tempRoot?: string },
): { readonly dataRoot: string; readonly databaseFileName: typeof FRESH_SQLITE_DATABASE_FILE } {
  return prepareStateDirectory(selection, env, reserved.packageRoot, reserved.tempRoot ?? os.tmpdir());
}

/** Resolve the configured state directory without creating it or following a redirect. */
export function resolveSqliteStateDirectory(
  selection: Extract<InstallAuthoritySelection, { readonly state: "sqlite" }>,
  env: NodeJS.ProcessEnv,
): { readonly dataRoot: string; readonly databaseFileName: typeof FRESH_SQLITE_DATABASE_FILE } {
  return resolveStateDirectory(selection, env, sqliteInstallationRoot(env), os.tmpdir());
}

function resolveStateDirectory(
  selection: Extract<InstallAuthoritySelection, { readonly state: "sqlite" }>,
  env: NodeJS.ProcessEnv,
  packageRootValue: string,
  tempRootValue: string,
): { readonly dataRoot: string; readonly databaseFileName: typeof FRESH_SQLITE_DATABASE_FILE } {
  const appRoot = selection.configuredDataRoot || defaultDataRoot(env);
  if (!isLocalAbsolutePath(appRoot)) throw new SqliteInstallConfigurationError("sqlite_data_root_not_local_absolute");
  const normalizedRoot = path.resolve(appRoot);
  const stateDirectory = path.join(normalizedRoot, "state");
  const packageRoot = path.resolve(packageRootValue);
  const tempRoot = path.resolve(tempRootValue);
  if (within(packageRoot, normalizedRoot) || within(tempRoot, normalizedRoot)
    || within(packageRoot, stateDirectory) || within(tempRoot, stateDirectory)) {
    throw new SqliteInstallConfigurationError("sqlite_data_root_reserved_location");
  }
  return { dataRoot: stateDirectory, databaseFileName: FRESH_SQLITE_DATABASE_FILE };
}

function prepareStateDirectory(
  selection: Extract<InstallAuthoritySelection, { readonly state: "sqlite" }>,
  env: NodeJS.ProcessEnv,
  packageRootValue: string,
  tempRootValue: string,
): { readonly dataRoot: string; readonly databaseFileName: typeof FRESH_SQLITE_DATABASE_FILE } {
  const resolved = resolveStateDirectory(selection, env, packageRootValue, tempRootValue);
  const normalizedRoot = path.dirname(resolved.dataRoot);
  ensurePlainDirectoryTree(normalizedRoot);
  ensurePlainDirectoryTree(resolved.dataRoot);
  const canonicalState = canonicalDirectory(resolved.dataRoot);
  rejectOrphanedDatabaseState(canonicalState);
  return { dataRoot: canonicalState, databaseFileName: FRESH_SQLITE_DATABASE_FILE };
}

function defaultDataRoot(env: NodeJS.ProcessEnv): string {
  const localAppData = env["LOCALAPPDATA"]?.trim();
  if (!localAppData || !isLocalAbsolutePath(localAppData)) throw new SqliteInstallConfigurationError("local_app_data_unavailable");
  return path.join(localAppData, "CodexZCodeBridge");
}

function ensurePlainDirectoryTree(value: string): void {
  if (!isLocalAbsolutePath(value)) throw new SqliteInstallConfigurationError("sqlite_data_path_not_local");
  const parsed = path.parse(value);
  const segments = value.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SqliteInstallConfigurationError("sqlite_data_path_component_unsafe");
      if (!samePath(realpathSync.native(current), current)) throw new SqliteInstallConfigurationError("sqlite_data_path_redirected");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { mkdirSync(current); }
      catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw new SqliteInstallConfigurationError("sqlite_data_path_create_failed", String(createError));
      }
      const created = lstatSync(current);
      if (!created.isDirectory() || created.isSymbolicLink() || !samePath(realpathSync.native(current), current)) {
        throw new SqliteInstallConfigurationError("sqlite_data_path_create_unverified");
      }
    }
  }
}

function canonicalDirectory(value: string): string {
  try {
    const stat = lstatSync(value);
    const real = realpathSync.native(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, value)) throw new Error("directory_identity_mismatch");
    return real;
  } catch (error) {
    throw new SqliteInstallConfigurationError("sqlite_data_path_unverified", String(error));
  }
}

function rejectOrphanedDatabaseState(root: string): void {
  const expected = path.join(root, FRESH_SQLITE_DATABASE_FILE);
  if (existsSync(expected)) return;
  for (const name of [
    `${FRESH_SQLITE_DATABASE_FILE}-wal`, `${FRESH_SQLITE_DATABASE_FILE}-shm`,
    "operations.sqlite3", "operations.sqlite3-wal", "operations.sqlite3-shm",
    "ROOT_POISONED.json", "WRITER_INTENT.json",
  ]) {
    if (existsSync(path.join(root, name))) throw new SqliteInstallConfigurationError("sqlite_existing_state_incomplete");
  }
}

function isLocalAbsolutePath(value: string): boolean {
  if (process.platform === "win32") return /^[A-Za-z]:\\/u.test(value) && path.win32.isAbsolute(value) && !value.startsWith("\\\\");
  return path.isAbsolute(value) && !value.startsWith("/proc/") && !value.startsWith("/sys/") && !value.startsWith("/dev/");
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.win32.normalize(value).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US") : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
