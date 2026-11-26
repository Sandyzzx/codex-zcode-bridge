/**
 * Official runtime Built-in Registry discovery (ADR-066).
 *
 * Mirrors the Observed behavior of the installed ZCode Desktop (4.0.0.10870,
 * `zcode.cjs` 0.18.0) so the Bridge and the Desktop load the same Built-in
 * Provider registry. These are observations, not an official contract:
 * - path: `<dataBaseDir>/.zcode/v2/runtime/provider/<platform>/<appVersion>/endpoint-<sha256(origin)[0:32]>/zcode-builtin.json`
 * - selection: a usable runtime registry is authoritative; only an absent or
 *   unusable runtime registry falls back to the installation's bundled file.
 *
 * Pure module: every filesystem access is injectable and no official file is
 * ever written, downloaded, cached or updated by the Bridge.
 */
import { createHash } from "node:crypto";
import { lstat as nodeLstat, readFile as nodeReadFile } from "node:fs/promises";
import { realpath as nodeRealpath } from "node:fs/promises";
import path from "node:path";
import { buildZCodeAppServerLaunch } from "./desktop-host-launch.js";
import { sameFileSystemPath } from "./paths.js";

/** Observed defaults of the official endpoint resolver. */
const OFFICIAL_PRODUCTION_ENDPOINT_ORIGIN = "https://zcode.z.ai";
const OFFICIAL_TEST_ENDPOINT_ORIGIN = "https://zcode.chatglm.site";

/**
 * Non-secret environment keys that select the official Endpoint. Executor and
 * detached Worker must resolve the same Endpoint to locate the same registry.
 */
export const OFFICIAL_ENDPOINT_ENV_KEYS: readonly string[] = Object.freeze([
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZCODE_TEST_BASE_URL",
]);

/**
 * Copy the non-secret Endpoint selectors into an AppServer child environment.
 * The registry is located by Endpoint, so the Bridge and the process it
 * starts must resolve the same one.
 */
export function forwardOfficialEndpointEnv(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  for (const key of OFFICIAL_ENDPOINT_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
  return target;
}

/**
 * True only when an explicitly configured Built-in file names something other
 * than the given installation's own bundled file. Another spelling of the
 * same file is the default (the path older installers persisted), not a pin.
 * Both resolvers share this rule so they never disagree about a pin.
 */
export async function isOfficialBuiltinRegistryPin(
  explicitBuiltin: string | null | undefined,
  bundledPath: string | null | undefined,
): Promise<boolean> {
  const explicit = explicitBuiltin?.trim() || null;
  if (!explicit || !bundledPath) return false;
  const [explicitCanonical, bundledCanonical] = await Promise.all([canonicalPath(explicit), canonicalPath(bundledPath)]);
  return !sameFileSystemPath(explicitCanonical, bundledCanonical);
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await nodeRealpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** A registry file far beyond the observed size (~270 KiB) is not trusted. */
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;

/**
 * Provider the Observed 0.18.0 release decoder rejects. A registry that still
 * carries it is treated the same way by the Desktop: unusable.
 */
const OBSERVED_RETIRED_PROVIDER_ID = "builtin:zapi";

export type OfficialBuiltinRegistrySource = "runtime" | "bundled";

export type OfficialBuiltinRegistryRuntimeStatus =
  | "selected"
  /** No Desktop version or data base directory is known, so no path exists. */
  | "unresolved"
  | "not_found"
  /** Present but not a regular file, unreadable, or not a valid release. */
  | "invalid";

export interface OfficialBuiltinRegistrySelection {
  /** The file the Bridge will hand to the AppServer. */
  readonly path: string;
  readonly source: OfficialBuiltinRegistrySource;
  /** The installation's own bundled file, always the fallback. */
  readonly bundledPath: string;
  /** Revision of the selected file; null when it could not be decoded. */
  readonly revision: number | null;
  readonly runtimePath: string | null;
  readonly runtimeStatus: OfficialBuiltinRegistryRuntimeStatus;
}

interface RegistryFileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface RegistryCandidate {
  readonly revision: number;
}

/** Official endpoint origin: env overrides first, then the built-in default. */
export function officialEndpointOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (key: string): string | undefined => {
    const value = env[key]?.trim();
    return value || undefined;
  };
  const test = env["ZCODE_ENV"]?.trim().toLowerCase() === "test";
  const base = configured("ZCODE_BASE_URL")
    ?? configured("ZCODE_ENDPOINT_ORIGIN")
    ?? (test ? configured("ZCODE_TEST_BASE_URL") : configured("ZCODE_PRODUCTION_BASE_URL"));
  if (!base) return test ? OFFICIAL_TEST_ENDPOINT_ORIGIN : OFFICIAL_PRODUCTION_ENDPOINT_ORIGIN;
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ZCode endpoint origin must use http or https");
  }
  return url.origin;
}

/** Observed client platform label, e.g. `windows-x86_64`. */
export function officialClientPlatform(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const operatingSystem = platform === "win32" ? "windows" : platform;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : architecture;
  return `${operatingSystem}-${arch}`;
}

/**
 * Desktop application version from the installed `app.asar` build metadata;
 * this is the version segment of the official runtime registry path. Null
 * when the installed Desktop identity cannot be read.
 */
export function officialDesktopAppVersion(zcodeEntrypoint: string): string | null {
  try {
    return buildZCodeAppServerLaunch(zcodeEntrypoint, {}).env["ZCODE_APP_VERSION"] ?? null;
  } catch {
    return null;
  }
}

/**
 * The one official runtime registry path for this data base directory,
 * Desktop version and Endpoint. Nothing is searched: another version, data
 * root or Endpoint never contributes a candidate.
 */
export function officialRuntimeRegistryPath(input: {
  readonly dataBaseDir: string;
  readonly appVersion: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}): string | null {
  const appVersion = input.appVersion?.trim() || null;
  if (!appVersion || !path.isAbsolute(input.dataBaseDir)) return null;
  try {
    registrySegment(appVersion, "appVersion");
    const platform = registrySegment(
      officialClientPlatform(input.platform, input.architecture),
      "platform",
    );
    const origin = officialEndpointOrigin(input.env);
    const endpointKey = `endpoint-${createHash("sha256").update(origin).digest("hex").slice(0, 32)}`;
    return path.join(
      input.dataBaseDir,
      ".zcode",
      "v2",
      "runtime",
      "provider",
      platform,
      appVersion,
      endpointKey,
      "zcode-builtin.json",
    );
  } catch {
    return null;
  }
}

/**
 * Choose between the installation's bundled registry and the official runtime
 * registry. An unusable runtime file falls back to the bundled file; the
 * caller still validates whichever file is returned.
 */
export async function selectOfficialBuiltinRegistry(input: {
  readonly bundledPath: string;
  readonly runtimePath: string | null;
  readonly readFile?: (filePath: string) => Promise<string>;
  readonly lstat?: (filePath: string) => Promise<RegistryFileStat>;
}): Promise<OfficialBuiltinRegistrySelection> {
  const readFile = input.readFile ?? ((filePath: string) => nodeReadFile(filePath, "utf8"));
  const lstat = input.lstat ?? ((filePath: string) => nodeLstat(filePath) as Promise<RegistryFileStat>);
  const bundled = (status: OfficialBuiltinRegistryRuntimeStatus, revision: number | null = null): OfficialBuiltinRegistrySelection => ({
    path: input.bundledPath,
    source: "bundled",
    bundledPath: input.bundledPath,
    revision,
    runtimePath: input.runtimePath,
    runtimeStatus: status,
  });
  if (!input.runtimePath) return bundled("unresolved");

  let stat: RegistryFileStat;
  try {
    stat = await lstat(input.runtimePath);
  } catch {
    return bundled("not_found");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return bundled("invalid");
  let runtime: RegistryCandidate | null;
  try {
    runtime = decodeRegistry(await readFile(input.runtimePath));
  } catch {
    runtime = null;
  }
  if (!runtime) return bundled("invalid");

  return runtimeSelected();

  function runtimeSelected(): OfficialBuiltinRegistrySelection {
    return {
      path: input.runtimePath!,
      source: "runtime",
      bundledPath: input.bundledPath,
      revision: runtime!.revision,
      runtimePath: input.runtimePath,
      runtimeStatus: "selected",
    };
  }
}

function registrySegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/u.test(value)) {
    throw new Error(`ZCode Built-in ${label} is not a valid path segment`);
  }
  return value;
}

/**
 * Observed release shape: exactly `schemaVersion` (1), a safe `revision` and a
 * `config` holding exactly the two rule tables. The AppServer remains the
 * authoritative validator of whichever file is selected.
 */
function decodeRegistry(text: string): RegistryCandidate {
  if (Buffer.byteLength(text, "utf8") > MAX_REGISTRY_BYTES) throw new Error("registry too large");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "revision", "config"]) || value.schemaVersion !== 1) {
    throw new Error("unsupported registry schema");
  }
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("invalid registry revision");
  }
  const config = value.config;
  if (!isRecord(config)
    || !hasExactKeys(config, ["providerConfigRules", "modelConfigRules"])
    || !isRecord(config.providerConfigRules)
    || !isRecord(config.modelConfigRules)) {
    throw new Error("invalid registry config");
  }
  const providerRules = config.providerConfigRules.providerRules;
  if (Array.isArray(providerRules)
    && providerRules.some((rule) => isRecord(rule) && rule.providerId === OBSERVED_RETIRED_PROVIDER_ID)) {
    throw new Error("registry contains a retired provider");
  }
  if (isRecord(providerRules) && Object.hasOwn(providerRules, OBSERVED_RETIRED_PROVIDER_ID)) {
    throw new Error("registry contains a retired provider");
  }
  return { revision };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
