import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RuntimeResolver, ZCodeRuntimeConfig } from "../interfaces.js";
import { zcodeDataBaseDir } from "./account-provider.js";
import { codexHostProfile, type BridgeHostProfile } from "./host-profile.js";
import { buildZCodeAppServerLaunch } from "./desktop-host-launch.js";
import { BridgeError } from "./errors.js";
import { isSupportedNodeVersion, SUPPORTED_NODE_RANGE } from "./node-runtime.js";
import {
  isOfficialBuiltinRegistryPin,
  officialRuntimeRegistryPath,
  selectOfficialBuiltinRegistry,
  type OfficialBuiltinRegistrySelection,
  type OfficialBuiltinRegistrySource,
} from "./official-builtin-registry.js";
import { discoverZCodeInstall, isAbsolutePathForPlatform } from "./paths.js";
import {
  computeOfficialInstallationFingerprint,
} from "./official-runtime-authorization.js";
import {
  loadPersistedRuntimeEnvironment,
  NodeRuntimeResolver,
  type RuntimeResolverOptions,
} from "./resolver.js";

const execFileAsync = promisify(execFile);

export const OFFICIAL_CODING_PLAN_PROVIDER_ID =
  "account:bigmodel-individual-coding-plan" as const;

export function isOfficialCodingPlanProvider(providerId: string | undefined): boolean {
  return providerId === OFFICIAL_CODING_PLAN_PROVIDER_ID
    || providerId === "bigmodel-individual-coding-plan"
    || providerId === "builtin:bigmodel-coding-plan";
}

export type OfficialRuntimeVerificationStatus =
  | "OFFICIAL_RUNTIME_VERIFIED"
  | "OFFICIAL_RUNTIME_EXPERIMENTAL"
  | "OFFICIAL_RUNTIME_UNVERIFIED";

export type OfficialInstallationSafety =
  | "OFFICIAL_INSTALLATION_SAFE"
  | "OFFICIAL_INSTALLATION_UNSAFE"
  | "OFFICIAL_INSTALLATION_INCOMPLETE";

export type OfficialDiscountCapability =
  | "OFFICIAL_DISCOUNT_VERIFIED"
  | "OFFICIAL_DISCOUNT_NOT_VERIFIED";

export type StartPlanStaticCompatibility =
  | "OFFLINE_COMPATIBLE"
  | "OFFLINE_INCOMPATIBLE"
  | "OFFLINE_RESEARCH_PENDING";

export type OfficialProviderRuntimeCapability =
  | "coding_plan_discount"
  | "start_plan_static"
  | "installed_runtime";

export interface OfficialAppServerRuntimeManifestEntry {
  readonly desktop_version: string;
  readonly desktop_app_version: string;
  readonly desktop_build_commit_id: string;
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
  readonly verification_stage?: "VERIFIED" | "EXPERIMENTAL";
  readonly desktop_executable_sha256?: string;
  readonly desktop_executable_bytes?: number;
  readonly desktop_archive_sha256?: string;
  readonly desktop_archive_bytes?: number;
  /**
   * Legacy verified entries predate full Desktop executable/archive pinning.
   * Runtime safety still verifies both files are signed x64 official binaries.
   */
  readonly desktop_asset_pinning?: "FULL" | "LEGACY_SAFETY_ONLY";
}

/**
 * Known-good installed runtimes. A match is an exact identity gate, not a
 * prediction based on a product version string alone.
 */
export const OFFICIAL_APPSERVER_COMPATIBILITY_MANIFEST: readonly OfficialAppServerRuntimeManifestEntry[] =
  Object.freeze([
    Object.freeze({
      desktop_version: "3.18.2.10443",
      desktop_app_version: "3.18.2",
      desktop_build_commit_id: "2681f4af",
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
      desktop_asset_pinning: "LEGACY_SAFETY_ONLY",
    }),
    Object.freeze({
      desktop_version: "3.19.0.10774",
      desktop_app_version: "3.19.0",
      desktop_build_commit_id: "a7ed1054",
      desktop_executable_sha256: "c5afb161a2d9389761d417ca668bc94311e3d2aff6ca3d0117b0b15701666f27",
      desktop_executable_bytes: 246_332_312,
      desktop_archive_sha256: "2421850970f361aaa1b3f1d6c960b101a5d476ad95631359d0413a19de1197cb",
      desktop_archive_bytes: 385_171_742,
      bundle_sha256: "6b84e928d9258fe020c6ab8c75fa2c123b0cd658fe43c0ce141a13df677fb0ea",
      bundle_bytes: 15_843_692,
      builtin_provider_config_sha256: "ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69",
      builtin_provider_config_bytes: 261_659,
      runtime_host_sha256: "c87a9f3cf9cf920e4b5993aad69f8840a5d9bc7c0ae90b32acb29c15a1db0aae",
      runtime_host_bytes: 179_608,
      node_compatibility: SUPPORTED_NODE_RANGE,
      appserver_protocol: "zcode-app-server-stdio-desktop-v1",
      request_security_capability: "identity-observed-provider-verification-pending",
      coding_plan_discount_verified: false,
      start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
      verification_date: "2026-11-20",
      verification_stage: "EXPERIMENTAL",
      desktop_asset_pinning: "FULL",
    }),
  ]);

export interface OfficialAppServerRuntimeDescriptor {
  readonly status: OfficialRuntimeVerificationStatus;
  readonly installation_safety?: OfficialInstallationSafety;
  readonly installation_fingerprint?: string | null;
  readonly discount_capability: OfficialDiscountCapability;
  readonly start_plan_static_compatibility: StartPlanStaticCompatibility | null;
  readonly reason: string | null;
  readonly install_dir: string | null;
  readonly install_source: string | null;
  readonly desktop_version: string | null;
  readonly desktop_app_version?: string | null;
  readonly desktop_build_commit_id?: string | null;
  readonly bundle_path: string | null;
  readonly bundle_bytes: number | null;
  readonly bundle_sha256: string | null;
  readonly builtin_provider_config_path: string | null;
  readonly builtin_provider_config_bytes: number | null;
  readonly builtin_provider_config_sha256: string | null;
  /**
   * ADR-066: the official Built-in registry actually handed to the AppServer.
   * `builtin_provider_config_*` above keep describing the installation's
   * bundled file so the manifest and installation fingerprint stay stable
   * while the Desktop refreshes its runtime registry.
   */
  readonly active_builtin_provider_config_path: string | null;
  readonly active_builtin_provider_config_source: OfficialBuiltinRegistrySource | null;
  readonly active_builtin_provider_config_revision: number | null;
  readonly runtime_host_path: string | null;
  readonly runtime_host_bytes: number | null;
  readonly runtime_host_sha256: string | null;
  readonly runtime_host_signer_subject?: string | null;
  readonly runtime_host_signer_thumbprint?: string | null;
  readonly desktop_executable_path?: string | null;
  readonly desktop_executable_bytes?: number | null;
  readonly desktop_executable_sha256?: string | null;
  readonly desktop_executable_signer_subject?: string | null;
  readonly desktop_executable_signer_thumbprint?: string | null;
  readonly desktop_archive_path?: string | null;
  readonly desktop_archive_bytes?: number | null;
  readonly desktop_archive_sha256?: string | null;
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
  readonly inspectExecutable?: (filePath: string) => Promise<OfficialWindowsExecutableIdentity>;
}

export interface OfficialWindowsExecutableIdentity {
  readonly architecture: "x64" | "unknown";
  readonly signature_status: string;
  readonly signer_subject: string | null;
  readonly signer_thumbprint: string | null;
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
  readonly #inspectExecutable: (filePath: string) => Promise<OfficialWindowsExecutableIdentity>;
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
    this.#inspectExecutable = options.inspectExecutable ?? inspectWindowsExecutable;
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

    // The capability probe can be simulated, but the files live on this host.
    const discovery = discoverZCodeInstall(env, { requireBuiltin: true });
    if (!discovery.installDir || !discovery.zcodeEntrypoint || !discovery.builtinConfigFile) {
      return unverified(
        "installed ZCode Desktop AppServer with same-root builtin provider config was not found",
        nodeExecutable,
      );
    }
    if (!isAbsolutePathForPlatform(discovery.installDir)) {
      return unverified("installed ZCode path is not absolute", nodeExecutable);
    }

    let installDir: string;
    let bundlePath: string;
    let builtinPath: string;
    let runtimeHostPath: string;
    let desktopExecutablePath: string;
    let desktopArchivePath: string;
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
      desktopArchivePath = await canonicalFileInside(
        installDir,
        path.join(installDir, "resources", "app.asar"),
        "installed Desktop archive",
      );
    } catch (error) {
      return unverified(errorMessage(error), nodeExecutable);
    }

    let bundleBytes: number;
    let builtinBytes: number;
    let runtimeHostBytes: number;
    let desktopExecutableBytes: number;
    let desktopArchiveBytes: number;
    try {
      [
        { size: bundleBytes },
        { size: builtinBytes },
        { size: runtimeHostBytes },
        { size: desktopExecutableBytes },
        { size: desktopArchiveBytes },
      ] = await Promise.all([
        lstat(bundlePath),
        lstat(builtinPath),
        lstat(runtimeHostPath),
        lstat(desktopExecutablePath),
        lstat(desktopArchivePath),
      ]);
    } catch (error) {
      return unverified(`could not verify installed Official runtime assets: ${errorMessage(error)}`, nodeExecutable);
    }
    const [
      bundleSha256,
      builtinSha256,
      runtimeHostSha256,
      desktopExecutableSha256,
      desktopArchiveSha256,
    ] = await Promise.all([
      optionalSha256(this.#hashFile, bundlePath),
      optionalSha256(this.#hashFile, builtinPath),
      optionalSha256(this.#hashFile, runtimeHostPath),
      optionalSha256(this.#hashFile, desktopExecutablePath),
      optionalSha256(this.#hashFile, desktopArchivePath),
    ]);

    let desktopExecutableIdentity: OfficialWindowsExecutableIdentity;
    let runtimeHostIdentity: OfficialWindowsExecutableIdentity;
    try {
      desktopExecutableIdentity = await this.#inspectExecutable(desktopExecutablePath);
      runtimeHostIdentity = await this.#inspectExecutable(runtimeHostPath);
    } catch (error) {
      return unsafe(
        `official executable safety inspection failed: ${errorMessage(error)}`,
        nodeExecutable,
        {
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
          desktop_executable_path: desktopExecutablePath,
          desktop_executable_bytes: desktopExecutableBytes,
          desktop_executable_sha256: desktopExecutableSha256,
          desktop_archive_path: desktopArchivePath,
          desktop_archive_bytes: desktopArchiveBytes,
          desktop_archive_sha256: desktopArchiveSha256,
        },
      );
    }
    const unsafeExecutableReason = executableArchitectureFailure(
      desktopExecutableIdentity,
      "Desktop executable",
    ) ?? executableArchitectureFailure(runtimeHostIdentity, "runtime-host");
    if (unsafeExecutableReason) {
      return unsafe(unsafeExecutableReason, nodeExecutable, {
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
        runtime_host_signer_subject: runtimeHostIdentity.signer_subject,
        runtime_host_signer_thumbprint: runtimeHostIdentity.signer_thumbprint,
        desktop_executable_path: desktopExecutablePath,
        desktop_executable_bytes: desktopExecutableBytes,
        desktop_executable_sha256: desktopExecutableSha256,
        desktop_executable_signer_subject: desktopExecutableIdentity.signer_subject,
        desktop_executable_signer_thumbprint: desktopExecutableIdentity.signer_thumbprint,
        desktop_archive_path: desktopArchivePath,
        desktop_archive_bytes: desktopArchiveBytes,
        desktop_archive_sha256: desktopArchiveSha256,
      });
    }

    let launchEnv: NodeJS.ProcessEnv;
    try {
      launchEnv = this.#readDesktopLaunch(bundlePath).env;
    } catch {
      launchEnv = {};
    }
    let desktopVersion: string | null = null;
    try {
      desktopVersion = normalizeDesktopVersion(await this.#probeDesktopVersion(desktopExecutablePath));
    } catch {}
    let nodeVersion: string | null = null;
    try {
      nodeVersion = normalizeNodeVersion(await this.#probeNodeVersion(nodeExecutable));
    } catch {}
    const nodeCompatible = nodeVersion !== null && isSupportedNodeVersion(nodeVersion);

    const observedDesktopVersion = desktopVersion ?? "unavailable";
    const observedAppVersion = launchEnv.ZCODE_APP_VERSION ?? "unavailable";
    const observedBuildCommitId = launchEnv.ZCODE_BUILD_COMMIT_ID ?? "unavailable";
    // ADR-066: an explicitly configured builtin file other than this
    // installation's own bundled file is a pin and is left untouched. The
    // bundled path itself is the default left by older installers, so it
    // follows the official runtime registry.
    const registryPinned = await this.#builtinRegistryPinned(builtinPath);
    let registry: OfficialBuiltinRegistrySelection | null = null;
    if (!registryPinned) {
      const dataBaseDir = await this.#personalDataBaseDir();
      const runtimePath = dataBaseDir && launchEnv.ZCODE_APP_VERSION
        ? officialRuntimeRegistryPath({
          dataBaseDir,
          appVersion: launchEnv.ZCODE_APP_VERSION,
          env,
        })
        : null;
      registry = await selectOfficialBuiltinRegistry({ bundledPath: builtinPath, runtimePath });
    }
    const installationFingerprint = computeOfficialInstallationFingerprint({
      desktop_version: observedDesktopVersion,
      desktop_app_version: observedAppVersion,
      desktop_build_commit_id: observedBuildCommitId,
      desktop_executable_bytes: desktopExecutableBytes,
      desktop_executable_sha256: desktopExecutableSha256 ?? "unavailable",
      desktop_archive_bytes: desktopArchiveBytes,
      desktop_archive_sha256: desktopArchiveSha256 ?? "unavailable",
      bundle_bytes: bundleBytes,
      bundle_sha256: bundleSha256 ?? "unavailable",
      builtin_provider_config_bytes: builtinBytes,
      builtin_provider_config_sha256: builtinSha256 ?? "unavailable",
      runtime_host_bytes: runtimeHostBytes,
      runtime_host_sha256: runtimeHostSha256 ?? "unavailable",
      desktop_signer_thumbprint: desktopExecutableIdentity.signer_thumbprint ?? "",
      runtime_host_signer_thumbprint: runtimeHostIdentity.signer_thumbprint ?? "",
      node_version: nodeVersion ?? "unavailable",
    });

    const manifestCandidate = this.#manifest.find((entry) =>
      entry.desktop_version === desktopVersion
      && entry.bundle_bytes === bundleBytes
      && bundleSha256 !== null
      && entry.bundle_sha256.toLowerCase() === bundleSha256.toLowerCase()
    ) ?? null;

    const mismatches: string[] = [];
    if (!manifestCandidate) {
      mismatches.push("desktop version/bundle bytes/SHA-256 are not in the compatibility manifest");
    } else {
      if (manifestCandidate.desktop_app_version !== observedAppVersion
        || manifestCandidate.desktop_build_commit_id !== observedBuildCommitId) {
        mismatches.push("Desktop launch identity does not match the compatibility manifest");
      }
      if (manifestCandidate.builtin_provider_config_bytes !== builtinBytes
        || builtinSha256 === null
        || manifestCandidate.builtin_provider_config_sha256.toLowerCase() !== builtinSha256.toLowerCase()) {
        mismatches.push("builtin provider config identity does not match the compatibility manifest");
      }
      if (manifestCandidate.runtime_host_bytes !== runtimeHostBytes
        || runtimeHostSha256 === null
        || manifestCandidate.runtime_host_sha256.toLowerCase() !== runtimeHostSha256.toLowerCase()) {
        mismatches.push("runtime-host identity does not match the compatibility manifest");
      }
      if (manifestCandidate.desktop_executable_bytes !== undefined
        && (manifestCandidate.desktop_executable_bytes !== desktopExecutableBytes
          || desktopExecutableSha256 === null
          || manifestCandidate.desktop_executable_sha256?.toLowerCase() !== desktopExecutableSha256.toLowerCase())) {
        mismatches.push("Desktop executable identity does not match the compatibility manifest");
      }
      if (manifestCandidate.desktop_archive_bytes !== undefined
        && (manifestCandidate.desktop_archive_bytes !== desktopArchiveBytes
          || desktopArchiveSha256 === null
          || manifestCandidate.desktop_archive_sha256?.toLowerCase() !== desktopArchiveSha256.toLowerCase())) {
        mismatches.push("Desktop archive identity does not match the compatibility manifest");
      }
    }
    const manifest = manifestCandidate && mismatches.length === 0 ? manifestCandidate : null;
    const manifestStage = manifest?.verification_stage ?? "VERIFIED";
    const common = {
      install_dir: installDir,
      install_source: discovery.source,
      installation_safety: "OFFICIAL_INSTALLATION_SAFE" as const,
      installation_fingerprint: installationFingerprint,
      desktop_version: observedDesktopVersion,
      desktop_app_version: observedAppVersion,
      desktop_build_commit_id: observedBuildCommitId,
      bundle_path: bundlePath,
      bundle_bytes: bundleBytes,
      bundle_sha256: bundleSha256,
      builtin_provider_config_path: builtinPath,
      builtin_provider_config_bytes: builtinBytes,
      builtin_provider_config_sha256: builtinSha256,
      active_builtin_provider_config_path: registry?.path ?? builtinPath,
      active_builtin_provider_config_source: registry?.source ?? "bundled",
      active_builtin_provider_config_revision: registry?.revision ?? null,
      runtime_host_path: runtimeHostPath,
      runtime_host_bytes: runtimeHostBytes,
      runtime_host_sha256: runtimeHostSha256,
      runtime_host_signer_subject: runtimeHostIdentity.signer_subject,
      runtime_host_signer_thumbprint: runtimeHostIdentity.signer_thumbprint,
      desktop_executable_path: desktopExecutablePath,
      desktop_executable_bytes: desktopExecutableBytes,
      desktop_executable_sha256: desktopExecutableSha256,
      desktop_executable_signer_subject: desktopExecutableIdentity.signer_subject,
      desktop_executable_signer_thumbprint: desktopExecutableIdentity.signer_thumbprint,
      desktop_archive_path: desktopArchivePath,
      desktop_archive_bytes: desktopArchiveBytes,
      desktop_archive_sha256: desktopArchiveSha256,
      node_version: nodeVersion,
      node_compatible: nodeCompatible,
      manifest,
    } satisfies Partial<OfficialAppServerRuntimeDescriptor>;
    if (manifest && manifestStage === "VERIFIED") {
      return {
        status: "OFFICIAL_RUNTIME_VERIFIED",
        ...common,
        discount_capability: manifest.coding_plan_discount_verified
          ? "OFFICIAL_DISCOUNT_VERIFIED"
          : "OFFICIAL_DISCOUNT_NOT_VERIFIED",
        start_plan_static_compatibility: manifest.start_plan_static_compatibility,
        reason: null,
        node_executable: nodeExecutable,
      };
    }
    const diagnosticReason = mismatches.join("; ")
      || "runtime identity is not present in the reviewed compatibility manifest";
    if (manifest && manifestStage === "EXPERIMENTAL") {
      return {
        status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
        ...common,
        discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
        start_plan_static_compatibility: manifest.start_plan_static_compatibility,
        reason: `SAFE_INSTALLATION_EXPERIMENTAL_MANIFEST: ${diagnosticReason}`,
        node_executable: nodeExecutable,
      };
    }
    return {
      status: "OFFICIAL_RUNTIME_UNVERIFIED",
      ...common,
      discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
      start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
      reason: `SAFE_INSTALLATION_MANIFEST_UNVERIFIED: ${diagnosticReason}`,
      node_executable: nodeExecutable,
    };
  }

  async resolve(): Promise<ZCodeRuntimeConfig> {
    const descriptor = await this.inspect();
    if (descriptor.installation_safety !== "OFFICIAL_INSTALLATION_SAFE"
      || !descriptor.bundle_path
      || !descriptor.builtin_provider_config_path
      || !descriptor.active_builtin_provider_config_path
      || !descriptor.runtime_host_path) {
      throw new BridgeError(
        "provider_config_invalid",
        `OFFICIAL_INSTALLATION_UNSAFE: ${descriptor.reason ?? "installed Official AppServer is unavailable"}; ` +
          "OFFICIAL_DISCOUNT_NOT_VERIFIED",
      );
    }
    const registryPinned = await this.#builtinRegistryPinned(descriptor.builtin_provider_config_path);
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
      providerBuiltinConfigFile: registryPinned
        ? configured.providerBuiltinConfigFile
        : descriptor.active_builtin_provider_config_path,
    };
  }

  /** True only for an explicit builtin file that is not this installation's bundled file. */
  async #builtinRegistryPinned(bundledPath: string | null): Promise<boolean> {
    return isOfficialBuiltinRegistryPin(
      this.#persistedEnv()["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"],
      bundledPath,
    );
  }

  #persistedEnv(): NodeJS.ProcessEnv {
    return loadPersistedRuntimeEnvironment(
      this.#env,
      this.#homeDir,
      this.#host ?? codexHostProfile(this.#homeDir),
    );
  }

  /** Data base directory of the personal provider config the base resolver selects; null when unavailable. */
  async #personalDataBaseDir(): Promise<string | null> {
    try {
      const base = this.#baseResolver ?? new NodeRuntimeResolver({
        env: this.#env,
        ...(this.#homeDir ? { homeDir: this.#homeDir } : {}),
        ...(this.#host ? { host: this.#host } : {}),
      });
      return zcodeDataBaseDir((await base.resolve()).providerPersonalConfigFile);
    } catch {
      return null;
    }
  }
}

function unverified(
  reason: string,
  nodeExecutable: string,
  details: Partial<OfficialAppServerRuntimeDescriptor> = {},
): OfficialAppServerRuntimeDescriptor {
  return {
    status: "OFFICIAL_RUNTIME_UNVERIFIED",
    installation_safety: details.installation_safety ?? "OFFICIAL_INSTALLATION_INCOMPLETE",
    installation_fingerprint: details.installation_fingerprint ?? null,
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    start_plan_static_compatibility: null,
    reason,
    install_dir: details.install_dir ?? null,
    install_source: details.install_source ?? null,
    desktop_version: details.desktop_version ?? null,
    desktop_app_version: details.desktop_app_version ?? null,
    desktop_build_commit_id: details.desktop_build_commit_id ?? null,
    bundle_path: details.bundle_path ?? null,
    bundle_bytes: details.bundle_bytes ?? null,
    bundle_sha256: details.bundle_sha256 ?? null,
    builtin_provider_config_path: details.builtin_provider_config_path ?? null,
    builtin_provider_config_bytes: details.builtin_provider_config_bytes ?? null,
    builtin_provider_config_sha256: details.builtin_provider_config_sha256 ?? null,
    active_builtin_provider_config_path: details.active_builtin_provider_config_path ?? null,
    active_builtin_provider_config_source: details.active_builtin_provider_config_source ?? null,
    active_builtin_provider_config_revision: details.active_builtin_provider_config_revision ?? null,
    runtime_host_path: details.runtime_host_path ?? null,
    runtime_host_bytes: details.runtime_host_bytes ?? null,
    runtime_host_sha256: details.runtime_host_sha256 ?? null,
    runtime_host_signer_subject: details.runtime_host_signer_subject ?? null,
    runtime_host_signer_thumbprint: details.runtime_host_signer_thumbprint ?? null,
    desktop_executable_path: details.desktop_executable_path ?? null,
    desktop_executable_bytes: details.desktop_executable_bytes ?? null,
    desktop_executable_sha256: details.desktop_executable_sha256 ?? null,
    desktop_executable_signer_subject: details.desktop_executable_signer_subject ?? null,
    desktop_executable_signer_thumbprint: details.desktop_executable_signer_thumbprint ?? null,
    desktop_archive_path: details.desktop_archive_path ?? null,
    desktop_archive_bytes: details.desktop_archive_bytes ?? null,
    desktop_archive_sha256: details.desktop_archive_sha256 ?? null,
    node_executable: nodeExecutable,
    node_version: details.node_version ?? null,
    node_compatible: details.node_compatible === true,
    manifest: details.manifest ?? null,
  };
}

function unsafe(
  reason: string,
  nodeExecutable: string,
  details: Partial<OfficialAppServerRuntimeDescriptor> = {},
): OfficialAppServerRuntimeDescriptor {
  return unverified(reason, nodeExecutable, {
    ...details,
    installation_safety: "OFFICIAL_INSTALLATION_UNSAFE",
  });
}

function executableArchitectureFailure(
  identity: OfficialWindowsExecutableIdentity,
  label: string,
): string | null {
  if (identity.architecture !== "x64") {
    return `OFFICIAL_INSTALLATION_UNSAFE: ${label} is not an x64 PE executable`;
  }
  return null;
}

async function inspectWindowsExecutable(filePath: string): Promise<OfficialWindowsExecutableIdentity> {
  const architecture = readPortableExecutableArchitecture(filePath);
  const systemRoot = process.env["SystemRoot"]?.trim();
  let signatureStatus = "";
  let signerSubject: string | null = null;
  let signerThumbprint: string | null = null;
  if (systemRoot) {
    try {
      const powershell = path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$target = $env:ZCODE_BRIDGE_AUTHENTICODE_FILE",
        "if ([string]::IsNullOrWhiteSpace($target)) { exit 2 }",
        "$signature = Get-AuthenticodeSignature -LiteralPath $target",
        "$certificate = $signature.SignerCertificate",
        "[pscustomobject]@{",
        "status = [string]$signature.Status;",
        "subject = if ($null -eq $certificate) { $null } else { [string]$certificate.Subject };",
        "thumbprint = if ($null -eq $certificate) { $null } else { [string]$certificate.Thumbprint }",
        "} | ConvertTo-Json -Compress",
      ].join("\n");
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const { stdout } = await execFileAsync(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded,
      ], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: {
          SystemRoot: systemRoot,
          ZCODE_BRIDGE_AUTHENTICODE_FILE: filePath,
        },
      });
      const parsed = JSON.parse(stdout.trim()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>;
        signatureStatus = typeof value["status"] === "string" ? value["status"] : "";
        signerSubject = typeof value["subject"] === "string" ? value["subject"] : null;
        signerThumbprint = typeof value["thumbprint"] === "string" ? value["thumbprint"] : null;
      }
    } catch {
      // Authenticode is diagnostic; architecture and actual process startup remain authoritative.
    }
  }
  return {
    architecture,
    signature_status: signatureStatus,
    signer_subject: signerSubject,
    signer_thumbprint: signerThumbprint,
  };
}

function readPortableExecutableArchitecture(filePath: string): "x64" | "unknown" {
  const fd = openSync(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(fd, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length
      || dosHeader.toString("ascii", 0, 2) !== "MZ") {
      return "unknown";
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (!Number.isSafeInteger(peOffset) || peOffset < 64 || peOffset > 64 * 1024 * 1024) {
      return "unknown";
    }
    const coffHeader = Buffer.alloc(6);
    if (readSync(fd, coffHeader, 0, coffHeader.length, peOffset) !== coffHeader.length
      || coffHeader.toString("ascii", 0, 4) !== "PE\u0000\u0000") {
      return "unknown";
    }
    return coffHeader.readUInt16LE(4) === 0x8664 ? "x64" : "unknown";
  } finally {
    closeSync(fd);
  }
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

async function optionalSha256(
  hashFile: (filePath: string) => Promise<string>,
  filePath: string,
): Promise<string | null> {
  try {
    return await hashFile(filePath);
  } catch {
    return null;
  }
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
