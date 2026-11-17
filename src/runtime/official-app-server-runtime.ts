import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RuntimeResolver, ZCodeRuntimeConfig } from "../interfaces.js";
import { codexHostProfile } from "../host/profile.js";
import { buildZCodeAppServerLaunch } from "./desktop-host-launch.js";
import { BridgeError } from "./errors.js";
import { isSupportedNodeVersion, SUPPORTED_NODE_RANGE } from "./node-runtime.js";
import { discoverZCodeInstall, isAbsolutePathForPlatform } from "./paths.js";
import {
  loadPersistedRuntimeEnvironment,
  NodeRuntimeResolver,
  type RuntimeResolverOptions,
} from "./resolver.js";

const execFileAsync = promisify(execFile);

export const OFFICIAL_CODING_PLAN_PROVIDER_ID =
  "account:bigmodel-individual-coding-plan" as const;

export type OfficialRuntimeVerificationStatus =
  | "OFFICIAL_RUNTIME_VERIFIED"
  | "OFFICIAL_RUNTIME_UNVERIFIED";

export type OfficialDiscountCapability =
  | "OFFICIAL_DISCOUNT_VERIFIED"
  | "OFFICIAL_DISCOUNT_NOT_VERIFIED";

export type StartPlanStaticCompatibility =
  | "OFFLINE_COMPATIBLE"
  | "OFFLINE_INCOMPATIBLE"
  | "OFFLINE_RESEARCH_PENDING";

export interface OfficialAppServerRuntimeManifestEntry {
  readonly desktop_version: string;
  readonly bundle_sha256: string;
  readonly bundle_bytes: number;
  readonly builtin_provider_config_sha256: string;
  readonly builtin_provider_config_bytes: number;
  readonly runtime_host_sha256: string;
  readonly runtime_host_bytes: number;
  readonly node_compatibility: string;
  readonly appserver_protocol: string;
  readonly request_security_capability: string;
  readonly coding_plan_discount_verified: boolean;
  readonly start_plan_static_compatibility: StartPlanStaticCompatibility;
  readonly verification_date: string;
}

/**
 * Known-good installed runtimes. A match is an exact identity gate, not a
 * prediction based on a product version string alone.
 */
export const OFFICIAL_APPSERVER_COMPATIBILITY_MANIFEST: readonly OfficialAppServerRuntimeManifestEntry[] =
  Object.freeze([
    Object.freeze({
      desktop_version: "3.18.2.10443",
      bundle_sha256: "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c",
      bundle_bytes: 15_675_386,
      builtin_provider_config_sha256: "ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69",
      builtin_provider_config_bytes: 261_659,
      runtime_host_sha256: "c2c8ff5ff28cbddc4f177c094aa67c322830889612251bd173baaabc89379ab4",
      runtime_host_bytes: 179_608,
      node_compatibility: SUPPORTED_NODE_RANGE,
      appserver_protocol: "zcode-app-server-stdio-desktop-v1",
      request_security_capability: "official-installed-bundle-signing",
      coding_plan_discount_verified: true,
      start_plan_static_compatibility: "OFFLINE_COMPATIBLE",
      verification_date: "2026-11-18",
    }),
  ]);

export interface OfficialAppServerRuntimeDescriptor {
  readonly status: OfficialRuntimeVerificationStatus;
  readonly discount_capability: OfficialDiscountCapability;
  readonly reason: string | null;
  readonly install_dir: string | null;
  readonly install_source: string | null;
  readonly desktop_version: string | null;
  readonly bundle_path: string | null;
  readonly bundle_bytes: number | null;
  readonly bundle_sha256: string | null;
  readonly builtin_provider_config_path: string | null;
  readonly builtin_provider_config_bytes: number | null;
  readonly builtin_provider_config_sha256: string | null;
  readonly runtime_host_path: string | null;
  readonly runtime_host_bytes: number | null;
  readonly runtime_host_sha256: string | null;
  readonly node_executable: string;
  readonly node_version: string | null;
  readonly node_compatible: boolean;
  readonly manifest: OfficialAppServerRuntimeManifestEntry | null;
}

export interface OfficialAppServerRuntimeResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly host?: RuntimeResolverOptions["host"];
  /** Base resolver supplies the user's personal provider/data paths. */
  readonly baseResolver?: RuntimeResolver;
  readonly manifest?: readonly OfficialAppServerRuntimeManifestEntry[];
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly hashFile?: (filePath: string) => Promise<string>;
  readonly probeNodeVersion?: (executable: string) => Promise<string>;
  readonly probeDesktopVersion?: (executable: string) => Promise<string>;
  readonly readDesktopLaunch?: (bundlePath: string) => Readonly<{
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>;
}

/**
 * Resolves the installed Desktop AppServer. Unknown version, size, or digest
 * never receives a discount-compatible verdict.
 */
export class OfficialAppServerRuntimeResolver implements RuntimeResolver {
  readonly #env: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #host: RuntimeResolverOptions["host"];
  readonly #baseResolver: RuntimeResolver | null;
  readonly #manifest: readonly OfficialAppServerRuntimeManifestEntry[];
  readonly #platform: NodeJS.Platform;
  readonly #architecture: string;
  readonly #hashFile: (filePath: string) => Promise<string>;
  readonly #probeNodeVersion: (executable: string) => Promise<string>;
  readonly #probeDesktopVersion: (executable: string) => Promise<string>;
  readonly #readDesktopLaunch: (bundlePath: string) => Readonly<{
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>;

  constructor(options: OfficialAppServerRuntimeResolverOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#homeDir = options.homeDir ?? homedir();
    this.#host = options.host;
    this.#baseResolver = options.baseResolver ?? null;
    this.#manifest = options.manifest ?? OFFICIAL_APPSERVER_COMPATIBILITY_MANIFEST;
    this.#platform = options.platform ?? process.platform;
    this.#architecture = options.architecture ?? process.arch;
    this.#hashFile = options.hashFile ?? sha256File;
    this.#probeNodeVersion = options.probeNodeVersion ?? probeNodeCliVersion;
    this.#probeDesktopVersion = options.probeDesktopVersion ?? probeWindowsFileVersion;
    this.#readDesktopLaunch = options.readDesktopLaunch
      ?? ((bundlePath) => buildZCodeAppServerLaunch(bundlePath, {}));
  }

  async inspect(): Promise<OfficialAppServerRuntimeDescriptor> {
    let env: NodeJS.ProcessEnv;
    try {
      env = loadPersistedRuntimeEnvironment(
        this.#env,
        this.#homeDir,
        this.#host ?? codexHostProfile(this.#homeDir),
      );
    } catch (error) {
      return unverified(`Bridge runtime settings could not be loaded: ${errorMessage(error)}`, "node");
    }
    const nodeExecutable = env["ZCODE_BRIDGE_NODE"]?.trim() || "node";
    if (this.#platform !== "win32" || this.#architecture !== "x64") {
      return unverified(
        `installed Official AppServer requires Windows x64, got ${this.#platform}/${this.#architecture}`,
        nodeExecutable,
      );
    }

    const discovery = discoverZCodeInstall(env, {
      platform: this.#platform,
      requireBuiltin: true,
    });
    if (!discovery.installDir || !discovery.zcodeEntrypoint || !discovery.builtinConfigFile) {
      return unverified(
        "installed ZCode Desktop AppServer with same-root builtin provider config was not found",
        nodeExecutable,
      );
    }
    if (!isAbsolutePathForPlatform(discovery.installDir, this.#platform)) {
      return unverified("installed ZCode path is not absolute", nodeExecutable);
    }

    let installDir: string;
    let bundlePath: string;
    let builtinPath: string;
    let runtimeHostPath: string;
    let desktopExecutablePath: string;
    try {
      installDir = await canonicalDirectory(discovery.installDir);
      bundlePath = await canonicalFileInside(
        installDir,
        discovery.zcodeEntrypoint,
        "installed AppServer bundle",
      );
      builtinPath = await canonicalFileInside(
        installDir,
        discovery.builtinConfigFile,
        "installed builtin provider config",
      );
      runtimeHostPath = await canonicalFileInside(
        installDir,
        path.join(installDir, "resources", "tools", "runtime-host", "zcode-runtime-host.exe"),
        "installed runtime-host",
      );
      desktopExecutablePath = await canonicalFileInside(
        installDir,
        path.join(installDir, "ZCode.exe"),
        "installed Desktop executable",
      );
    } catch (error) {
      return unverified(errorMessage(error), nodeExecutable);
    }

    let bundleBytes: number;
    let builtinBytes: number;
    let runtimeHostBytes: number;
    let bundleSha256: string;
    let builtinSha256: string;
    let runtimeHostSha256: string;
    try {
      [{ size: bundleBytes }, bundleSha256] = await Promise.all([
        lstat(bundlePath),
        this.#hashFile(bundlePath),
      ]);
      [{ size: builtinBytes }, builtinSha256] = await Promise.all([
        lstat(builtinPath),
        this.#hashFile(builtinPath),
      ]);
      [{ size: runtimeHostBytes }, runtimeHostSha256] = await Promise.all([
        lstat(runtimeHostPath),
        this.#hashFile(runtimeHostPath),
      ]);
    } catch (error) {
      return unverified(`could not verify installed Official runtime assets: ${errorMessage(error)}`, nodeExecutable);
    }

    const launch = this.#readDesktopLaunch(bundlePath);
    const launchIdentityVersion = launch.env.ZCODE_APP_VERSION?.trim() || null;
    let desktopVersion: string | null = null;
    try {
      desktopVersion = normalizeDesktopVersion(await this.#probeDesktopVersion(desktopExecutablePath));
    } catch (error) {
      return unverified(`installed Desktop version could not be inspected: ${errorMessage(error)}`, nodeExecutable, {
        install_dir: installDir,
        install_source: discovery.source,
        bundle_path: bundlePath,
        bundle_bytes: bundleBytes,
        bundle_sha256: bundleSha256,
        builtin_provider_config_path: builtinPath,
        builtin_provider_config_bytes: builtinBytes,
        builtin_provider_config_sha256: builtinSha256,
        runtime_host_path: runtimeHostPath,
        runtime_host_bytes: runtimeHostBytes,
        runtime_host_sha256: runtimeHostSha256,
      });
    }
    if (!launchIdentityVersion) {
      return unverified("installed Desktop AppServer launch identity metadata is unavailable", nodeExecutable, {
        install_dir: installDir,
        install_source: discovery.source,
        desktop_version: desktopVersion,
        bundle_path: bundlePath,
        bundle_bytes: bundleBytes,
        bundle_sha256: bundleSha256,
        builtin_provider_config_path: builtinPath,
        builtin_provider_config_bytes: builtinBytes,
        builtin_provider_config_sha256: builtinSha256,
        runtime_host_path: runtimeHostPath,
        runtime_host_bytes: runtimeHostBytes,
        runtime_host_sha256: runtimeHostSha256,
      });
    }

    let nodeVersion: string | null = null;
    try {
      nodeVersion = normalizeNodeVersion(await this.#probeNodeVersion(nodeExecutable));
    } catch (error) {
      return unverified(`configured Node runtime could not be inspected: ${errorMessage(error)}`, nodeExecutable, {
        install_dir: installDir,
        install_source: discovery.source,
        desktop_version: desktopVersion,
        bundle_path: bundlePath,
        bundle_bytes: bundleBytes,
        bundle_sha256: bundleSha256,
        builtin_provider_config_path: builtinPath,
        builtin_provider_config_bytes: builtinBytes,
        builtin_provider_config_sha256: builtinSha256,
        runtime_host_path: runtimeHostPath,
        runtime_host_bytes: runtimeHostBytes,
        runtime_host_sha256: runtimeHostSha256,
      });
    }
    const nodeCompatible = isSupportedNodeVersion(nodeVersion);

    const manifest = this.#manifest.find((entry) =>
      entry.desktop_version === desktopVersion
      && entry.bundle_bytes === bundleBytes
      && entry.bundle_sha256.toLowerCase() === bundleSha256.toLowerCase()
    ) ?? null;

    const mismatches: string[] = [];
    if (!manifest) mismatches.push("desktop version/bundle bytes/SHA-256 are not in the compatibility manifest");
    else {
      if (manifest.builtin_provider_config_bytes !== builtinBytes
        || manifest.builtin_provider_config_sha256.toLowerCase() !== builtinSha256.toLowerCase()) {
        mismatches.push("builtin provider config identity does not match the compatibility manifest");
      }
      if (manifest.runtime_host_bytes !== runtimeHostBytes
        || manifest.runtime_host_sha256.toLowerCase() !== runtimeHostSha256.toLowerCase()) {
        mismatches.push("runtime-host identity does not match the compatibility manifest");
      }
      if (manifest.node_compatibility !== SUPPORTED_NODE_RANGE || !nodeCompatible) {
        mismatches.push(`Node ${nodeVersion} is outside the verified compatibility range ${manifest.node_compatibility}`);
      }
    }

    const common = {
      install_dir: installDir,
      install_source: discovery.source,
      desktop_version: desktopVersion,
      bundle_path: bundlePath,
      bundle_bytes: bundleBytes,
      bundle_sha256: bundleSha256,
      builtin_provider_config_path: builtinPath,
      builtin_provider_config_bytes: builtinBytes,
      builtin_provider_config_sha256: builtinSha256,
      runtime_host_path: runtimeHostPath,
      runtime_host_bytes: runtimeHostBytes,
      runtime_host_sha256: runtimeHostSha256,
      node_version: nodeVersion,
      node_compatible: nodeCompatible,
      manifest,
    } satisfies Partial<OfficialAppServerRuntimeDescriptor>;
    if (mismatches.length > 0) {
      return unverified(mismatches.join("; "), nodeExecutable, common);
    }
    return {
      status: "OFFICIAL_RUNTIME_VERIFIED",
      discount_capability: manifest?.coding_plan_discount_verified === true
        ? "OFFICIAL_DISCOUNT_VERIFIED"
        : "OFFICIAL_DISCOUNT_NOT_VERIFIED",
      reason: null,
      install_dir: installDir,
      install_source: discovery.source,
      desktop_version: desktopVersion,
      bundle_path: bundlePath,
      bundle_bytes: bundleBytes,
      bundle_sha256: bundleSha256,
      builtin_provider_config_path: builtinPath,
      builtin_provider_config_bytes: builtinBytes,
      builtin_provider_config_sha256: builtinSha256,
      runtime_host_path: runtimeHostPath,
      runtime_host_bytes: runtimeHostBytes,
      runtime_host_sha256: runtimeHostSha256,
      node_executable: nodeExecutable,
      node_version: nodeVersion,
      node_compatible: nodeCompatible,
      manifest,
    };
  }

  async resolve(): Promise<ZCodeRuntimeConfig> {
    const descriptor = await this.inspect();
    if (descriptor.status !== "OFFICIAL_RUNTIME_VERIFIED"
      || !descriptor.bundle_path
      || !descriptor.builtin_provider_config_path) {
      throw new BridgeError(
        "provider_config_invalid",
        `OFFICIAL_RUNTIME_UNVERIFIED: ${descriptor.reason ?? "installed Official AppServer is unavailable"}; ` +
          "OFFICIAL_DISCOUNT_NOT_VERIFIED",
      );
    }
    const base = this.#baseResolver ?? new NodeRuntimeResolver({
      env: this.#env,
      ...(this.#homeDir ? { homeDir: this.#homeDir } : {}),
      ...(this.#host ? { host: this.#host } : {}),
    });
    const configured = await base.resolve();
    return {
      ...configured,
      nodeExecutable: descriptor.node_executable,
      zcodeEntrypoint: descriptor.bundle_path,
      providerBuiltinConfigFile: descriptor.builtin_provider_config_path,
    };
  }
}

function unverified(
  reason: string,
  nodeExecutable: string,
  details: Partial<OfficialAppServerRuntimeDescriptor> = {},
): OfficialAppServerRuntimeDescriptor {
  return {
    status: "OFFICIAL_RUNTIME_UNVERIFIED",
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    reason,
    install_dir: details.install_dir ?? null,
    install_source: details.install_source ?? null,
    desktop_version: details.desktop_version ?? null,
    bundle_path: details.bundle_path ?? null,
    bundle_bytes: details.bundle_bytes ?? null,
    bundle_sha256: details.bundle_sha256 ?? null,
    builtin_provider_config_path: details.builtin_provider_config_path ?? null,
    builtin_provider_config_bytes: details.builtin_provider_config_bytes ?? null,
    builtin_provider_config_sha256: details.builtin_provider_config_sha256 ?? null,
    runtime_host_path: details.runtime_host_path ?? null,
    runtime_host_bytes: details.runtime_host_bytes ?? null,
    runtime_host_sha256: details.runtime_host_sha256 ?? null,
    node_executable: nodeExecutable,
    node_version: details.node_version ?? null,
    node_compatible: details.node_compatible === true,
    manifest: details.manifest ?? null,
  };
}

async function canonicalDirectory(candidate: string): Promise<string> {
  const stat = await lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("installed ZCode root is not a real directory");
  return realpath(candidate);
}

async function canonicalFileInside(root: string, candidate: string, label: string): Promise<string> {
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  const resolved = await realpath(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside the installed ZCode root`);
  }
  return resolved;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function probeNodeCliVersion(executable: string): Promise<string> {
  const { stdout } = await execFileAsync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return stdout.trim();
}

function normalizeNodeVersion(value: string): string {
  const normalized = value.trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(normalized)) throw new Error(`invalid Node version output: ${value.slice(0, 80)}`);
  return normalized;
}

function normalizeDesktopVersion(value: string): string {
  const normalized = value.trim();
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`invalid Desktop file version output: ${value.slice(0, 80)}`);
  }
  return normalized;
}

async function probeWindowsFileVersion(executable: string): Promise<string> {
  const script = [
    "$path = $env:ZCODE_BRIDGE_VERSION_FILE",
    "if ([string]::IsNullOrWhiteSpace($path)) { exit 2 }",
    "$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion",
    "[Console]::Out.Write($version)",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const systemRoot = process.env["SystemRoot"]?.trim();
  if (!systemRoot) throw new Error("SystemRoot is unavailable for the Windows version probe");
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await execFileAsync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encoded,
  ], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: {
      SystemRoot: systemRoot,
      ZCODE_BRIDGE_VERSION_FILE: executable,
    },
  });
  return stdout.trim();
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}
