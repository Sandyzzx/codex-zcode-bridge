import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RuntimeResolver, ZCodeRuntimeConfig } from "../interfaces.js";
import { BridgeError } from "../runtime/errors.js";
import { NodeRuntimeResolver } from "../runtime/resolver.js";
import {
  ZCodeAppServerAdapter,
  type AdapterClientProcess,
  type AdapterCloseDiagnostic,
  type AdapterRecordedTreeScan,
  type AppServerCloseResult,
  type ExternalHostClientFactory,
  type ExternalHostClientHandle,
  type ZCodeAppServerAdapterOptions,
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
    bytes: 1_829_875,
    sha256: "EBB262FE6364E3F982381F6554812EC2FC308030842711A916AE4F4357F99FEC",
  },
  appServerEntry: {
    relativePath: "app-server/zcode.cjs",
    bytes: 31_009_692,
    sha256: "B55BA68C3B7939AFAFFB4D373D15594817AD3319FDECFBE26640CE4B218CF639",
  },
  builtinProviderConfig: {
    relativePath: "app-server/provider/zcode-builtin.json",
    bytes: 265_884,
    sha256: "BC760A3B0C6D096EA07EE4E963471F135AE75AB207DB6ED4C372E1B183C856CD",
  },
  runtimeHost: {
    relativePath: "zcode-runtime-host.exe",
    bytes: 167_424,
    sha256: "04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24",
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

export interface OfficialHostModule {
  readonly ZCodeAgentProcessManager: new (options: Record<string, unknown>) => OfficialHostProcessManager;
  readonly ZCodeProtocolClient: new (...args: never[]) => OfficialHostProtocolClient;
  readonly createOAuthProviderRuntimeAuthService?: OfficialHostRuntimeAuthServiceFactory;
  readonly createOfficialStartPlanAuthenticationResolver?: OfficialStartPlanAuthenticationResolverFactory;
}

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

export interface OfficialHostAdapterOptions extends ZCodeAppServerAdapterOptions {
  /** Exists only for isolated tests and never consulted by the Worker wiring. */
  readonly testOnlyOfficialHostModule?: OfficialHostModuleSource;
  /** Resolves test assets relative to a Worker-shaped module URL. */
  readonly testOnlyWorkerModuleUrl?: string | URL;
}

/**
 * Production adapter for the existing `zcode_app_server` mode. The upstream
 * module and AppServer/helper assets are selected from this Worker's shipped
 * tree; no environment variable or persisted setting can redirect them.
 */
export class OfficialHostAdapter extends ZCodeAppServerAdapter {
  constructor(options: OfficialHostAdapterOptions = {}) {
    const assets = options.testOnlyWorkerModuleUrl
      ? lazyOfficialHostAssets(options.testOnlyWorkerModuleUrl)
      : lazyOfficialHostAssets();
    const baseEnv = options.childEnvBase ?? process.env;
    const fixedResolver: RuntimeResolver = {
      resolve: async () => {
        const verified = await assets();
        const resolver = options.resolver ?? new NodeRuntimeResolver({
          env: {
            ...baseEnv,
            ZCODE_BRIDGE_ZCODE_CJS: verified.appServerEntryPath,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: verified.builtinProviderConfigPath,
          },
          homeDir: options.homeDir,
          host: options.host,
        });
        const config = await resolver.resolve();
        return fixedOfficialRuntimeConfig(config, verified);
      },
    };
    const moduleSource = options.testOnlyOfficialHostModule
      ?? (async () => loadOfficialHostModule((await assets()).hostModulePath));
    super({
      ...options,
      resolver: fixedResolver,
      providerRetryLimit: 0,
      externalHostClientFactory: createOfficialHostClientFactory({
        assets,
        moduleSource,
      }),
    });
  }
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
      throw new BridgeError("provider_config_invalid", "Official Host runtime entrypoint must be the shipped bundle.");
    }
    const module = await resolveOfficialHostModule(input.moduleSource);
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
          ...context.launch.env,
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

export function lazyOfficialHostAssets(
  workerModuleUrl: string | URL = import.meta.url,
): () => Promise<OfficialHostAssets> {
  let pending: Promise<OfficialHostAssets> | undefined;
  return () => {
    pending ??= verifyOfficialHostAssets(workerModuleUrl);
    return pending;
  };
}

export async function verifyOfficialHostAssets(
  workerModuleUrl: string | URL = import.meta.url,
): Promise<OfficialHostAssets> {
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
    appServerEntryPath: verified.get("appServerEntry")!,
    builtinProviderConfigPath: verified.get("builtinProviderConfig")!,
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

function fixedOfficialRuntimeConfig(
  configured: ZCodeRuntimeConfig,
  assets: OfficialHostAssets,
): ZCodeRuntimeConfig {
  return {
    ...configured,
    zcodeEntrypoint: assets.appServerEntryPath,
    providerBuiltinConfigFile: assets.builtinProviderConfigPath,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
