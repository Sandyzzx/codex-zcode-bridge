import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RuntimeResolver } from "../interfaces.js";
import {
  withOfficialHostLaunchIdentity,
} from "../runtime/desktop-host-launch.js";
import { BridgeError } from "../runtime/errors.js";
import type { RuntimeResolverOptions } from "../runtime/resolver.js";
import {
  OfficialAppServerRuntimeResolver,
  type OfficialAppServerRuntimeDescriptor,
  type OfficialProviderRuntimeCapability,
} from "../runtime/official-app-server-runtime.js";
import {
  type AdapterClientProcess,
  type AdapterCloseDiagnostic,
  type AdapterRecordedTreeScan,
  type AppServerCloseResult,
  type ExternalHostClientFactory,
  type ExternalHostClientFactoryContext,
  type ExternalHostClientHandle,
} from "./zcode-app-server-adapter.js";

export type {
  ExternalHostClientFactory,
  ExternalHostClientFactoryContext,
  ExternalHostClientHandle,
} from "./zcode-app-server-adapter.js";

export const OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

const OFFICIAL_HOST_ASSET_RELATIVE_ROOT =
  "./vendor/official-host/win32-x64-node24.16.0-zcode3.18.2-fec97590";

interface OfficialHostAssetDefinition {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

const OFFICIAL_HOST_ASSETS = {
  hostModule: {
    relativePath: "official-host-runtime.mjs",
    bytes: 1_829_872,
    sha256: "7E2B8B772F1DD83135903B64D569D634C7E7FC6F303460E08C98E27D311B6A91",
  },
  runtimeHost: {
    relativePath: "zcode-runtime-host.exe",
    bytes: 179_608,
    sha256: "C2C8FF5FF28CBDDC4F177C094AA67C322830889612251BD173BAAABC89379AB4",
  },
  keyringLoader: {
    relativePath: "node_modules/@napi-rs/keyring/index.js",
    bytes: 29_176,
    sha256: "8A89DB37F981D05B484EB063ADAE3399660AE7734AD38797463E5691382F5036",
  },
  keyringPackage: {
    relativePath: "node_modules/@napi-rs/keyring/package.json",
    bytes: 3_325,
    sha256: "4BA8C90AC72BE27FCB3337ED7BC0159C68747E0824294DF5F2AAAEB03130CD4F",
  },
  keyringNativePackage: {
    relativePath: "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
    bytes: 641,
    sha256: "1552C08589EEAEBC3680642883A8CAFEA8C72F80ED62908DE814177498562121",
  },
  keyringNative: {
    relativePath: "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
    bytes: 1_912_832,
    sha256: "52B16658275B7848F8081A6542FEE3448F1B1C5D3A36487107AE0E7CEC95AC6F",
  },
} as const satisfies Record<string, OfficialHostAssetDefinition>;

export interface OfficialHostAssets {
  readonly root: string;
  readonly hostModulePath: string;
  readonly appServerEntryPath: string;
  readonly builtinProviderConfigPath: string;
  readonly runtimeHostPath: string;
  readonly manifestDigest: string;
}

export interface OfficialHostPackagedAssets {
  readonly root: string;
  readonly hostModulePath: string;
  readonly runtimeHostPath: string;
  readonly manifestDigest: string;
}

export interface OfficialInstalledRuntimeResolver extends RuntimeResolver {
  inspect(): Promise<OfficialAppServerRuntimeDescriptor>;
}

export interface OfficialHostSessionFactoryOptions {
  readonly officialRuntimeResolver?: OfficialInstalledRuntimeResolver;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly host?: RuntimeResolverOptionsHost;
  readonly providerCapability?: OfficialProviderRuntimeCapability;
  readonly testOnlyOfficialHostModule?: OfficialHostModuleSource;
  /** Worker-shaped URL used to resolve the shipped Host module. */
  readonly workerModuleUrl?: string | URL;
  readonly testOnlyOfficialHostPackagedAssets?: OfficialHostPackagedAssets;
  readonly onVerified?: (descriptor: OfficialAppServerRuntimeDescriptor) => void;
  readonly onUnverified?: (
    descriptor: OfficialAppServerRuntimeDescriptor,
    reason: string,
  ) => void;
  readonly onDiagnostic?: (
    descriptor: OfficialAppServerRuntimeDescriptor,
    reason: string,
  ) => void;
}

export interface OfficialHostSessionFactory {
  readonly resolver: OfficialInstalledRuntimeResolver;
  inspect(): Promise<OfficialAppServerRuntimeDescriptor>;
  createClient(context: ExternalHostClientFactoryContext): Promise<ExternalHostClientHandle>;
}

type RuntimeResolverOptionsHost = NonNullable<RuntimeResolverOptions["host"]>;

export interface OfficialHostModule {
  readonly ZCODE_PRODUCT_VERSION?: string;
  readonly ZCodeAgentProcessManager: new (options: Record<string, unknown>) => OfficialHostProcessManager;
  readonly ZCodeProtocolClient: new (...args: never[]) => OfficialHostProtocolClient;
  readonly createOAuthProviderRuntimeAuthService?: OfficialHostRuntimeAuthServiceFactory;
  readonly createOfficialStartPlanAuthenticationResolver?: OfficialStartPlanAuthenticationResolverFactory;
}

/**
 * The single production composition point for installed Official AppServer
 * sessions. Task adapters and the model catalog share this resolver, packaged
 * Official Host module, ProcessManager, ProtocolClient, and close ownership.
 */
export function createInstalledOfficialHostSessionFactory(
  options: OfficialHostSessionFactoryOptions = {},
): OfficialHostSessionFactory {
  const providerCapability = options.providerCapability ?? "installed_runtime";
  const resolver = options.officialRuntimeResolver
    ?? new OfficialAppServerRuntimeResolver({
      env: options.env,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.host ? { host: options.host } : {}),
    });
  let packagedAssetsPromise: Promise<OfficialHostPackagedAssets> | undefined;
  const packagedAssets = (): Promise<OfficialHostPackagedAssets> =>
    packagedAssetsPromise ??= options.testOnlyOfficialHostPackagedAssets
      ? Promise.resolve(options.testOnlyOfficialHostPackagedAssets)
      : verifyOfficialHostAssets(options.workerModuleUrl);
  const moduleSource: OfficialHostModuleSource = options.testOnlyOfficialHostModule
    ?? (async () => loadOfficialHostModule((await packagedAssets()).hostModulePath));
  let resolved: Promise<{
    readonly descriptor: OfficialAppServerRuntimeDescriptor;
    readonly assets: OfficialHostAssets;
  }> | undefined;

  const inspect = (): Promise<OfficialAppServerRuntimeDescriptor> =>
    resolver.inspect();

  const resolveAssets = (): Promise<{
    readonly descriptor: OfficialAppServerRuntimeDescriptor;
    readonly assets: OfficialHostAssets;
  }> => {
    resolved ??= Promise.all([resolver.inspect(), packagedAssets()]).then(([descriptor, packaged]) => {
      const missingRuntimeAsset = descriptor.installation_safety !== "OFFICIAL_INSTALLATION_SAFE"
        || !descriptor.bundle_path
        || !descriptor.builtin_provider_config_path
        || !descriptor.runtime_host_path;
      if (missingRuntimeAsset) {
        const failure = descriptor.installation_safety === "OFFICIAL_INSTALLATION_UNSAFE"
          ? `OFFICIAL_INSTALLATION_UNSAFE: ${descriptor.reason ?? "installed runtime failed safety validation"}`
          : "OFFICIAL_RUNTIME_UNVERIFIED: installed runtime descriptor is incomplete";
        try {
          options.onUnverified?.(descriptor, failure);
        } catch {
          // Observation cannot alter the fail-closed decision.
        }
        throw new BridgeError("provider_config_invalid", failure);
      }
      const capabilityWarning = officialProviderCapabilityWarning(descriptor, providerCapability);
      if (capabilityWarning) {
        try {
          options.onDiagnostic?.(descriptor, capabilityWarning);
        } catch {
          // Diagnostics cannot turn a safe runtime into a static gate.
        }
      }
      return {
        descriptor,
        assets: {
          root: descriptor.install_dir!,
          hostModulePath: packaged.hostModulePath,
          appServerEntryPath: descriptor.bundle_path,
          builtinProviderConfigPath: descriptor.builtin_provider_config_path,
          runtimeHostPath: descriptor.runtime_host_path,
          manifestDigest: descriptor.installation_fingerprint
            ?? descriptor.bundle_sha256
            ?? "unavailable",
        },
      };
    });
    return resolved;
  };

  const factory = createOfficialHostClientFactory({
    assets: async () => (await resolveAssets()).assets,
    moduleSource,
  });
  return {
    resolver,
    inspect,
    createClient: async (context) => {
      const runtime = await resolveAssets();
      const client = await factory(context);
      try {
        options.onVerified?.(runtime.descriptor);
      } catch {
        // Observation cannot alter the runtime or cleanup ownership.
      }
      return client;
    },
  };
}

export function officialProviderCapabilityWarning(
  descriptor: OfficialAppServerRuntimeDescriptor,
  capability: OfficialProviderRuntimeCapability,
): string | null {
  if (capability === "coding_plan_discount") {
    return descriptor.discount_capability === "OFFICIAL_DISCOUNT_VERIFIED"
      ? null
      : `OFFICIAL_DISCOUNT_DIAGNOSTIC: ${descriptor.reason ?? "installed runtime has no reviewed Coding Plan discount evidence"}; ` +
        "OFFICIAL_DISCOUNT_NOT_VERIFIED";
  }
  if (capability === "start_plan_static") {
    return descriptor.start_plan_static_compatibility === "OFFLINE_COMPATIBLE"
      ? null
      : `STARTPLAN_STATIC_DIAGNOSTIC: ${descriptor.reason ?? "installed runtime has no reviewed Start Plan static evidence"}; ` +
        `START_PLAN_COMPATIBILITY_${descriptor.start_plan_static_compatibility ?? "UNVERIFIED"}`;
  }
  return descriptor.status === "OFFICIAL_RUNTIME_UNVERIFIED"
    ? `OFFICIAL_RUNTIME_MANIFEST_UNVERIFIED: ${descriptor.reason ?? "installed runtime is not in the reviewed compatibility manifest"}`
    : null;
}

/** @deprecated Use officialProviderCapabilityWarning; this value is diagnostic, not an execution gate. */
export const officialProviderCapabilityFailure = officialProviderCapabilityWarning;

export type OfficialHostModuleSource =
  | OfficialHostModule
  | (() => Promise<OfficialHostModule> | OfficialHostModule);

export interface OfficialHostRuntimeAuthService {
  resolveProviderRuntimeRequest(
    request: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

export type OfficialHostRuntimeAuthServiceFactory = (options: {
  readonly dataBaseDir: string;
  readonly resolveCurrentAccountAccess: (
    access: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) => OfficialHostRuntimeAuthService;

export interface OfficialStartPlanAuthentication {
  readonly accountIdentity: string;
  readonly sessionRevision: string | null;
  readonly requestCredential: string;
  readonly credentialExpiresAt: number | null;
  readonly deviceMid: string;
}

export interface OfficialStartPlanAuthenticationResolver {
  resolveStartPlanAuthentication(input: {
    readonly family: "bigmodel";
    readonly signal: AbortSignal;
  }): Promise<OfficialStartPlanAuthentication | null>;
}

export type OfficialStartPlanAuthenticationResolverFactory = (options: {
  readonly dataBaseDir: string;
}) => OfficialStartPlanAuthenticationResolver;

interface OfficialHostProtocolClient {
  readonly isDisposed: boolean;
  request(
    method: string,
    params?: unknown,
    resultSchema?: unknown,
    options?: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
      readonly invalidateConnectionOnTimeout?: boolean;
    },
  ): Promise<unknown>;
  respond(id: string | number, result: unknown): Promise<void>;
  respondError(
    id: string | number,
    error: { readonly code: number; readonly message: string; readonly data?: unknown },
  ): Promise<void>;
  onNotification(listener: (message: unknown) => void): OfficialDisposable;
  onRequest(listener: (message: unknown) => void): OfficialDisposable;
  onClose(listener: (event: unknown) => void): OfficialDisposable;
}

interface OfficialHostRuntimeIdentity {
  readonly generation: number;
  readonly identity: string;
  readonly processId?: number;
  readonly workspaceKey: string;
}

interface OfficialHostProcessManager {
  getClient(params: OfficialWorkspace): Promise<OfficialHostProtocolClient>;
  getRuntimeIdentity(params: OfficialWorkspace): Promise<OfficialHostRuntimeIdentity>;
  listManagedProcesses(): Array<{
    readonly pid: number;
    readonly workspacePath: string;
    readonly workspaceIdentity?: string;
  }>;
  isSharedRuntime(params: OfficialWorkspace): boolean;
  disposeWorkspace(params: OfficialWorkspace): Promise<void>;
  disposeAllAndWait(): Promise<void>;
  readonly onRuntimeRestarted?: (listener: (event: unknown) => void) => OfficialDisposable;
  readonly onRuntimeExited?: (listener: (event: unknown) => void) => OfficialDisposable;
}

interface OfficialWorkspace {
  readonly workspacePath: string;
  readonly workspaceIdentity: string;
}

interface OfficialDisposable {
  dispose(): void;
}

interface ExitState {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function createOfficialHostClientFactory(input: {
  readonly assets: () => Promise<OfficialHostAssets>;
  readonly moduleSource: OfficialHostModuleSource;
}): ExternalHostClientFactory {
  return async (context) => {
    const assets = await input.assets();
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new BridgeError("runtime_not_found", "The fixed Official Host bundle is available only for Windows x64.");
    }
    if (path.resolve(context.config.zcodeEntrypoint) !== path.resolve(assets.appServerEntryPath)) {
      throw new BridgeError("provider_config_invalid", "Official Host runtime entrypoint must be the verified installed bundle.");
    }
    const module = await resolveOfficialHostModule(input.moduleSource);
    const productVersion = normalizeOfficialHostProductVersion(module.ZCODE_PRODUCT_VERSION);
    const launchEnv = withOfficialHostLaunchIdentity(context.launch.env, { productVersion });
    const manager = new module.ZCodeAgentProcessManager({
      useSharedTaskRuntime: () => false,
      maxFrameBytes: OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES,
      requestTimeoutMs: context.requestTimeoutMs,
      processLifecycleReporter: {
        onSpawn: () => undefined,
        onExit: () => undefined,
        onError: () => undefined,
        onException: () => undefined,
      },
      commandResolver: async ({ workspacePath }: { readonly workspacePath: string }) => ({
        command: context.config.nodeExecutable,
        args: [assets.appServerEntryPath, ...context.launch.args],
        cwd: workspacePath,
        env: {
          ...launchEnv,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: assets.builtinProviderConfigPath,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: context.config.providerPersonalConfigFile,
          ZCODE_RUNTIME_HOST_PATH: assets.runtimeHostPath,
        },
      }),
    });
    const workspace: OfficialWorkspace = {
      workspacePath: context.workspace.canonicalPath,
      workspaceIdentity: context.workspace.sourcePath ?? context.workspace.canonicalPath,
    };
    let runtimePid: number | undefined;
    let exitState: ExitState = { code: null, signal: null };
    let runtimeRootIdentity: NonNullable<ExternalHostClientHandle["runtimeRootIdentity"]> | null = null;
    let closePromise: Promise<AppServerCloseResult> | null = null;
    const disposables: OfficialDisposable[] = [];
    const notificationListeners = new Set<(message: unknown) => void>();
    const requestListeners = new Set<(message: unknown) => void>();
    const closeListeners = new Set<(event: unknown) => void>();
    const restartListeners = new Set<(event: unknown) => void>();
    try {
      // The fixed upstream helper resolver reads process.env directly before
      // the command child environment is merged. Serialize this narrow scope
      // so two Worker attempts cannot redirect each other's helper path.
      const client = await withOfficialRuntimeHostEnvironment(
        assets.runtimeHostPath,
        () => manager.getClient(workspace),
      );
      if (manager.isSharedRuntime(workspace)) {
        throw new BridgeError("provider_config_invalid", "Official Host shared task runtime is forbidden.");
      }
      const runtime = await manager.getRuntimeIdentity(workspace);
      if (!runtime.processId || !Number.isSafeInteger(runtime.processId) || runtime.processId < 1) {
        throw new BridgeError("spawn_failed", "Official Host runtime identity did not contain a live process ID.");
      }
      runtimePid = runtime.processId;
      const observed = await context.probe.identityOf(runtime.processId);
      const confirmed = await manager.getRuntimeIdentity(workspace);
      if (observed.fingerprint_precision !== "exact" || !observed.fingerprint
        || confirmed.processId !== runtime.processId || confirmed.identity !== runtime.identity) {
        throw new BridgeError("cleanup_failed", "Official Host runtime root identity could not be captured exactly.");
      }
      runtimeRootIdentity = {
        pid: runtime.processId,
        fingerprint: observed.fingerprint,
        generation: runtime.generation,
      };
      disposables.push(client.onNotification((message) => {
        for (const listener of notificationListeners) listener(message);
      }));
      disposables.push(client.onRequest((message) => {
        for (const listener of requestListeners) listener(message);
      }));
      disposables.push(client.onClose((event) => {
        exitState = { code: null, signal: null };
        for (const listener of closeListeners) listener(event);
      }));
      if (manager.onRuntimeRestarted) {
        disposables.push(manager.onRuntimeRestarted((event) => {
          for (const listener of restartListeners) listener(event);
        }));
      }
      if (manager.onRuntimeExited) {
        disposables.push(manager.onRuntimeExited((event) => {
          const value = asRecord(event);
          const code = typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)
            ? value.exitCode
            : null;
          const signal = typeof value.signal === "string" ? value.signal as NodeJS.Signals : null;
          exitState = { code, signal };
          for (const listener of closeListeners) listener(event);
        }));
      }
      const child: AdapterClientProcess = {
        get pid() { return runtimePid; },
        get exitCode() { return exitState.code; },
        get signalCode() { return exitState.signal; },
      };
      const close = async (): Promise<AppServerCloseResult> => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          let workspaceError: unknown;
          let allError: unknown;
          try {
            await manager.disposeWorkspace(workspace);
          } catch (error) {
            workspaceError = error;
          }
          try {
            await manager.disposeAllAndWait();
          } catch (error) {
            allError = error;
          }
          const managerProcessCountAfter = manager.listManagedProcesses().filter((entry) =>
            sameWorkspace(entry.workspacePath, context.workspace.canonicalPath)
            && sameWorkspace(entry.workspaceIdentity ?? entry.workspacePath, workspace.workspaceIdentity),
          ).length;
          let recordedTreeScan: AdapterRecordedTreeScan | undefined;
          let treeScanStatus: AdapterCloseDiagnostic["treeScanStatus"] = "incomplete";
          let scanError: unknown;
          const root = runtimeRootIdentity;
          if (root) {
            try {
              const scan = await context.verifyTreeClean([{ pid: root.pid, fingerprint: root.fingerprint }]);
              if (scan.clean && scan.livePids.length === 0 && scan.observedPids.includes(root.pid)) {
                const memberPids = [...new Set(scan.observedPids)].sort((left, right) => left - right);
                recordedTreeScan = {
                  rootPid: root.pid,
                  rootFingerprint: root.fingerprint,
                  evidenceDigest: createHash("sha256").update(JSON.stringify({
                    rootPid: root.pid,
                    rootFingerprint: root.fingerprint,
                    memberPids,
                  }), "utf8").digest("hex"),
                  observedMemberCount: memberPids.length,
                };
                treeScanStatus = "verified";
              } else {
                treeScanStatus = scan.livePids.length ? "live" : "incomplete";
              }
            } catch (error) {
              scanError = error;
              treeScanStatus = "incomplete";
            }
          } else {
            scanError = new Error("Official Host runtime root identity was unavailable before close.");
          }
          const closeError = workspaceError ?? allError;
          const failure = closeError ?? (treeScanStatus === "verified" ? undefined : scanError
            ?? new Error(treeScanStatus === "live"
              ? "Official Host recorded-tree scan found a live runtime claimant."
              : "Official Host recorded-tree scan was incomplete."));
          const closeDiagnostic: AdapterCloseDiagnostic = {
            status: closeError || managerProcessCountAfter > 0 ? "rejected" : "resolved",
            stage: workspaceError ? "official_manager_workspace_dispose"
              : allError ? "official_manager_dispose_all" : "official_manager_dispose",
            ...(closeError instanceof Error ? {
              errorName: closeError.name.slice(0, 120),
              ...(typeof (closeError as NodeJS.ErrnoException).code === "string"
                ? { errorCode: (closeError as NodeJS.ErrnoException).code!.slice(0, 120) } : {}),
              errorMessage: closeError.message.slice(0, 1_000),
            } : {}),
            managerProcessCountAfter,
            treeScanStatus,
          };
          for (const disposable of disposables.splice(0)) {
            try { disposable.dispose(); } catch { /* close evidence is already captured */ }
          }
          return {
            owner: "official_host",
            receipt: null,
            ...(recordedTreeScan ? { recordedTreeScan } : {}),
            ...(failure ? { error: failure } : {}),
            close: closeDiagnostic,
          };
        })();
        return closePromise;
      };
      return {
        child,
        runtimeRootIdentity,
        request: (method, params) => client.request(method, params, undefined, {
          timeoutMs: context.requestTimeoutMs,
          invalidateConnectionOnTimeout: false,
        }),
        respond: async (message) => {
          if (!("id" in message)) throw new Error("Official Host reply is missing its request ID.");
          const id = message.id;
          if (typeof id !== "string" && typeof id !== "number") {
            throw new Error("Official Host reply request ID is invalid.");
          }
          if (message.error !== undefined) {
            const error = asRecord(message.error);
            await client.respondError(id, {
              code: typeof error.code === "number" ? error.code : -32000,
              message: typeof error.message === "string" ? error.message.slice(0, 1_000) : "Bridge request failed",
              ...(error.data !== undefined ? { data: error.data } : {}),
            });
            return;
          }
          await client.respond(id, message.result);
        },
        replayEvents: (events) => {
          for (const event of events) {
            const message = { method: "session/event", params: asRecord(event) };
            for (const listener of notificationListeners) listener(message);
          }
        },
        prewarmCleanup: () => undefined,
        close,
        get stderr() { return ""; },
        onNotification: (listener) => {
          notificationListeners.add(listener);
          return () => notificationListeners.delete(listener);
        },
        onRequest: (listener) => {
          requestListeners.add(listener);
          return () => requestListeners.delete(listener);
        },
        onClose: (listener) => {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        onRuntimeRestarted: (listener) => {
          restartListeners.add(listener);
          return () => restartListeners.delete(listener);
        },
      };
    } catch (error) {
      for (const disposable of disposables.splice(0)) {
        try { disposable.dispose(); } catch { /* startup failure remains primary */ }
      }
      try { await manager.disposeAllAndWait(); } catch { /* preserve startup failure */ }
      throw error;
    }
  };
}

export async function loadOfficialHostProviderRuntimeAuthFactory(
  workerModuleUrl: string | URL = import.meta.url,
): Promise<OfficialHostRuntimeAuthServiceFactory> {
  const assets = await verifyOfficialHostAssets(workerModuleUrl);
  const module = await loadOfficialHostModule(assets.hostModulePath);
  if (typeof module.createOAuthProviderRuntimeAuthService !== "function") {
    throw new BridgeError(
      "provider_config_invalid",
      "The Official Host module is missing the provider runtime auth factory.",
    );
  }
  return module.createOAuthProviderRuntimeAuthService;
}

export async function loadOfficialStartPlanAuthenticationResolverFactory(
  workerModuleUrl: string | URL = import.meta.url,
): Promise<OfficialStartPlanAuthenticationResolverFactory> {
  const assets = await verifyOfficialHostAssets(workerModuleUrl);
  const module = await loadOfficialHostModule(assets.hostModulePath);
  if (typeof module.createOfficialStartPlanAuthenticationResolver !== "function") {
    throw new BridgeError(
      "provider_config_invalid",
      "The Official Host module is missing the Start Plan authentication resolver.",
    );
  }
  return module.createOfficialStartPlanAuthenticationResolver;
}

export async function loadOfficialHostProductVersion(
  workerModuleUrl: string | URL = import.meta.url,
): Promise<string> {
  const assets = await verifyOfficialHostAssets(workerModuleUrl);
  const module = await loadOfficialHostModule(assets.hostModulePath);
  return normalizeOfficialHostProductVersion(module.ZCODE_PRODUCT_VERSION);
}

export function lazyOfficialHostAssets(
  workerModuleUrl: string | URL = import.meta.url,
): () => Promise<OfficialHostPackagedAssets> {
  let pending: Promise<OfficialHostPackagedAssets> | undefined;
  return () => {
    pending ??= verifyOfficialHostAssets(workerModuleUrl);
    return pending;
  };
}

export async function verifyOfficialHostAssets(
  workerModuleUrl: string | URL = import.meta.url,
): Promise<OfficialHostPackagedAssets> {
  const workerUrl = workerModuleUrl instanceof URL ? workerModuleUrl : new URL(workerModuleUrl);
  const root = fileURLToPath(new URL(`${OFFICIAL_HOST_ASSET_RELATIVE_ROOT}/`, workerUrl));
  let rootReal: string;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("not a real directory");
    rootReal = await realpath(root);
  } catch (error) {
    throw new BridgeError("runtime_not_found", "The shipped Official Host asset directory is absent.", { cause: error });
  }
  const verified = new Map<string, string>();
  for (const [name, definition] of Object.entries(OFFICIAL_HOST_ASSETS)) {
    const candidate = path.resolve(rootReal, definition.relativePath);
    try {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) throw new Error("not a regular file");
      const candidateReal = await realpath(candidate);
      if (!isPathInside(rootReal, candidateReal)) throw new Error("resolved outside the shipped asset root");
      if (candidateStat.size !== definition.bytes) throw new Error("byte length mismatch");
      const sha256 = await sha256File(candidateReal);
      if (sha256.toUpperCase() !== definition.sha256) throw new Error("SHA-256 mismatch");
      verified.set(name, candidateReal);
    } catch (error) {
      throw new BridgeError("provider_config_invalid", "A shipped Official Host asset failed presence or integrity validation.", {
        cause: error,
      });
    }
  }
  const manifestDigest = createHash("sha256").update(JSON.stringify(
    Object.entries(OFFICIAL_HOST_ASSETS)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => ({
        name,
        relativePath: definition.relativePath,
        bytes: definition.bytes,
        sha256: definition.sha256,
      })),
  ), "utf8").digest("hex");
  return {
    root: rootReal,
    hostModulePath: verified.get("hostModule")!,
    runtimeHostPath: verified.get("runtimeHost")!,
    manifestDigest,
  };
}

async function loadOfficialHostModule(modulePath: string): Promise<OfficialHostModule> {
  return resolveOfficialHostModule(await import(pathToFileURL(modulePath).href));
}

async function resolveOfficialHostModule(source: OfficialHostModuleSource): Promise<OfficialHostModule> {
  const value = typeof source === "function" ? await source() : source;
  if (!value || typeof value.ZCodeAgentProcessManager !== "function"
    || typeof value.ZCodeProtocolClient !== "function") {
    throw new BridgeError("provider_config_invalid", "The Official Host module is missing required exports.");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeOfficialHostProductVersion(value: unknown): string {
  const version = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(version)) {
    throw new BridgeError(
      "provider_config_invalid",
      "The Official Host module is missing a valid product version.",
    );
  }
  return version;
}

function sameWorkspace(left: string, right: string): boolean {
  const normalize = (value: string): string => path.normalize(path.resolve(value));
  return process.platform === "win32"
    ? normalize(left).toLocaleLowerCase("en-US") === normalize(right).toLocaleLowerCase("en-US")
    : normalize(left) === normalize(right);
}

let officialHostEnvironmentTail: Promise<void> = Promise.resolve();

async function withOfficialRuntimeHostEnvironment<T>(
  runtimeHostPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = officialHostEnvironmentTail;
  let release!: () => void;
  officialHostEnvironmentTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prior;
  const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, "ZCODE_RUNTIME_HOST_PATH");
  const previous = process.env.ZCODE_RUNTIME_HOST_PATH;
  process.env.ZCODE_RUNTIME_HOST_PATH = runtimeHostPath;
  try {
    return await operation();
  } finally {
    if (hadPrevious) process.env.ZCODE_RUNTIME_HOST_PATH = previous;
    else delete process.env.ZCODE_RUNTIME_HOST_PATH;
    release();
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
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
