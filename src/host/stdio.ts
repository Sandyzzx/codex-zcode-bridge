// stdio entry point for the Bridge MCP server (ARCHITECTURE component 1).
//
// Startup never resolves the ZCode provider configuration, so a missing or
// broken ZCode setup cannot prevent the server from starting; such problems
// surface per task through the existing failure flow. All protocol traffic
// goes to stdout via the SDK's serveStdio transport; every log line here is
// written to stderr. A connected Host keeps the transport available until
// lifecycle shutdown verifies Cleanup; stdin EOF is handled separately.
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import path from "node:path";
import { findPackageRoot, loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import { BridgeTaskManager } from "../manager/task-manager.js";
import { createBridgeServer } from "../mcp/server.js";
import { DEFAULT_TASK_TIMEOUT_MS, validateTaskTimeout } from "../runtime/task-timeout.js";
import { runBridgeDoctor, type DoctorCheck } from "../runtime/doctor.js";
import { ZCodeModelSettings } from "../runtime/model-settings.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "./profile.js";
import { workerEntryPath } from "../manager/spawn-worker.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { fingerprintRuntimeArtifact } from "../runtime/build-provenance.js";
import { createTrustedLocalStdioContext } from "../runtime/trusted-local-deployment.js";
import { SERVER_VERSION } from "../mcp/server.js";
import {
  loadInstallAuthoritySelection,
  prepareFreshSqliteStateDirectory,
  FRESH_SQLITE_DATABASE_FILE,
} from "../runtime/sqlite-install-config.js";

export interface DataRootResolution {
  readonly dataRoot: string;
  readonly warning?: string;
}

/** Internal capability factory used only by the local stdio Host composition. */
export function createTrustedLocalCandidateContext(host: BridgeHostProfile) {
  validateHostProfile(host);
  return createTrustedLocalStdioContext(host);
}

/** Frozen rule: use a valid ZCODE_BRIDGE_DATA_DIR, else the Bridge install dir. */
export function resolveDataRoot(env: NodeJS.ProcessEnv): DataRootResolution {
  const override = env["ZCODE_BRIDGE_DATA_DIR"]?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        dataRoot: findPackageRoot(),
        warning: `ZCODE_BRIDGE_DATA_DIR must be an absolute path; ignoring ${override} and using the Bridge installation directory`,
      };
    }
    return { dataRoot: path.normalize(override) };
  }
  return { dataRoot: findPackageRoot() };
}

export interface WorkerLimitResolution {
  readonly maxConcurrentWorkers: number;
  readonly warning?: string;
}

/** Defaults to eight concurrent workers; invalid values fail safely back to one worker. */
export function resolveMaxConcurrentWorkers(env: NodeJS.ProcessEnv): WorkerLimitResolution {
  const raw = env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"]?.trim();
  if (!raw) return { maxConcurrentWorkers: 8 };
  if (!/^[1-8]$/u.test(raw)) {
    return {
      maxConcurrentWorkers: 1,
      warning: "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS must be an integer from 1 to 8; using 1",
    };
  }
  return { maxConcurrentWorkers: Number(raw) };
}

export interface StdioLifecycleHost {
  /** Begin or retry graceful shutdown. False means the connected Host remains available. */
  shutdown(reason: string): Promise<boolean>;
}

/**
 * Serves one MCP stdio connection and coordinates its Manager shutdown.
 * Signals drain the Manager before closing the transport. If Cleanup is
 * unknown, the Manager keeps its Root and the still-connected client can
 * inspect state, finish a live Worker, or issue a bounded Cancel retry.
 * stdin EOF is different: the SDK closes the disconnected wire and this
 * function makes the same bounded shutdown attempt without promising a query
 * channel afterward.
 */
export function serveStdioLifecycleHost(
  server: ReturnType<typeof createBridgeServer>,
  manager: Pick<BridgeTaskManager, "shutdown">,
  options: {
    readonly stdin?: Readable;
    readonly stdout?: Writable;
    readonly onShutdownFailure?: (reason: string, error: unknown) => void;
    readonly onShutdownComplete?: (reason: string) => void;
  } = {},
): StdioLifecycleHost {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  let handle: StdioServerHandle;
  let closed = false;
  let disconnected = false;
  let current: Promise<boolean> | null = null;
  let shutdown!: (reason: string) => Promise<boolean>;

  const onDisconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    void shutdown("EOF");
  };
  // Register before the SDK starts the transport so EOF fences the Manager
  // before the SDK's own listener closes the stdio wire.
  stdin.once("end", onDisconnect);
  stdin.once("close", onDisconnect);

  shutdown = (reason: string): Promise<boolean> => {
    if (closed) return Promise.resolve(true);
    if (current) return current;
    let attempt!: Promise<boolean>;
    attempt = (async () => {
      try {
        await manager.shutdown();
        if (!disconnected) await handle.close();
        closed = true;
        options.onShutdownComplete?.(reason);
        return true;
      } catch (error) {
        options.onShutdownFailure?.(reason, error);
        return false;
      } finally {
        if (current === attempt) current = null;
      }
    })();
    current = attempt;
    return attempt;
  };

  handle = serveStdio(() => server, { transport });
  // StdioServerTransport schedules close for a stream that was already ended
  // before listeners were attached. Mirror that case for Manager shutdown.
  if (stdin.readableEnded || stdin.destroyed) queueMicrotask(onDisconnect);
  return { shutdown };
}

export async function startBridge(
  host: BridgeHostProfile = codexHostProfile(),
  version = SERVER_VERSION,
  bridgeEntryPath = process.argv[1],
): Promise<void> {
  validateHostProfile(host);
  console.error("[bridge] SQLITE_INITIALIZING");
  let authoritySelection: ReturnType<typeof loadInstallAuthoritySelection>;
  let runtimeEnv: ReturnType<typeof loadPersistedRuntimeEnvironment>;
  let prepared: ReturnType<typeof prepareFreshSqliteStateDirectory>;
  try {
    runtimeEnv = loadPersistedRuntimeEnvironment(process.env, homedir(), host);
    authoritySelection = loadInstallAuthoritySelection(host);
    prepared = prepareFreshSqliteStateDirectory(authoritySelection, process.env);
  } catch (error) {
    console.error(`[bridge] SQLITE_INITIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const dataRoot = prepared.dataRoot;
  const provenance = {
    bridge: fingerprintRuntimeArtifact(bridgeEntryPath),
    worker: fingerprintRuntimeArtifact(host.workerEntryPath ?? workerEntryPath()),
  };
  console.error(`[bridge] runtime provenance: ${JSON.stringify({
    bridge: { sha256: provenance.bridge.sha256 },
    worker: { sha256: provenance.worker.sha256 },
  })}`);
  console.error(`[bridge] data root: ${dataRoot}`);

  const workerLimit = resolveMaxConcurrentWorkers(runtimeEnv);
  if (workerLimit.warning) console.error(`[bridge] ${workerLimit.warning}`);
  console.error(`[bridge] max concurrent workers: ${workerLimit.maxConcurrentWorkers}`);
  const timeoutSetting = runtimeEnv["ZCODE_BRIDGE_TIMEOUT_MS"]?.trim();
  if (timeoutSetting) {
    try {
      validateTaskTimeout(Number(timeoutSetting));
    } catch (error) {
      console.error(`[bridge] ${error instanceof Error ? error.message : String(error)}; using the ${DEFAULT_TASK_TIMEOUT_MS / 60_000} minute default`);
    }
  }

  const processProbe = createPlatformProbe();
  let manager: BridgeTaskManager;
  let lifecycleChecks: () => readonly DoctorCheck[];
  const databasePath = path.join(dataRoot, FRESH_SQLITE_DATABASE_FILE);
  // Start Plan production auth (P0). Constructed only on Windows when the
  // official credential store already holds a valid identity; otherwise it
  // stays absent and Start Plan tasks fail closed through the existing
  // runtime-auth path. Coding Plan providers never enter this issuer.
  const startPlanAuthController = new AbortController();
  let startPlanPrivateAuth: import("../store/lifecycle-gate.js").ClaimOnlyDriverOptions["startPlanPrivateAuth"] | undefined;
  if (process.platform === "win32") {
    try {
      const { readOfficialStartPlanCredential, createProductionStartPlanAuth, StartPlanBillingEntitlement, readOfficialCliVersion } = await import("../runtime/start-plan-production-auth.js");
      if (readOfficialStartPlanCredential(dataRoot)) {
        let cachedCliVersion: Promise<string | undefined> | undefined;
        startPlanPrivateAuth = createProductionStartPlanAuth({
          dataRoot,
          signal: startPlanAuthController.signal,
          entitlement: new StartPlanBillingEntitlement({
            getAppVersion: async () => {
              const zcodeEntry = runtimeEnv["ZCODE_BRIDGE_ZCODE_CJS"]?.trim() || undefined;
              if (!zcodeEntry) return undefined;
              cachedCliVersion ??= readOfficialCliVersion(zcodeEntry);
              return await cachedCliVersion;
            },
          }),
        }) ?? undefined;
      }
    } catch (error) {
      // A broken official credential read must not block Bridge startup; the
      // absent issuer keeps Start Plan fail-closed per task.
      console.error(`[bridge] start plan auth issuer unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let trustedLocalContext: ReturnType<typeof createTrustedLocalCandidateContext>;
  try {
    trustedLocalContext = createTrustedLocalCandidateContext(host);
    if (trustedLocalContext.status !== "enabled") {
      throw new Error(`SQLite Authority startup refused: Trusted Local policy is ${trustedLocalContext.status}`);
    }
    const lifecycleGate = await import("../store/lifecycle-gate.js");
    await lifecycleGate.initializeFreshInstallSqliteRoot(dataRoot, FRESH_SQLITE_DATABASE_FILE, process.versions.node, processProbe);
    const { SqliteLifecycleMcpAuthority } = await import("../manager/sqlite-lifecycle-mcp-authority.js");
    const authority = await SqliteLifecycleMcpAuthority.create({
      dataRoot,
      databaseFileName: FRESH_SQLITE_DATABASE_FILE,
      managedDataDirectory: true,
      workerEntryPath: host.workerEntryPath ?? workerEntryPath(),
      hostProfile: host,
      bridgeEntryPath: bridgeEntryPath ?? "",
      processProbe,
      trustedLocalContext,
      requireAuthorityReceipt: true,
      ...(startPlanPrivateAuth ? { startPlanPrivateAuth } : {}),
    });
    manager = new BridgeTaskManager({ lifecycleAuthority: authority, maxConcurrentWorkers: workerLimit.maxConcurrentWorkers });
    lifecycleChecks = () => authority.getDoctorChecks();
  } catch (error) {
    console.error(`[bridge] SQLITE_INITIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const modelSettings = new ZCodeModelSettings(process.env, { host });
  const server = createBridgeServer({
    taskManager: manager,
    doctor: () => runBridgeDoctor({ env: runtimeEnv, dataRoot, resolver: { host }, lifecycleChecks }),
    modelSettings,
    serverInfo: { name: host.name, version },
    instructions: host.instructions,
  });
  const stdioHost = serveStdioLifecycleHost(server, manager, {
    onShutdownFailure: (reason, error) => {
      process.exitCode = 1;
      console.error(`[bridge] ${reason} shutdown retained the lifecycle Root because cleanup was not verified: ${error instanceof Error ? error.message : String(error)}`);
    },
    onShutdownComplete: (reason) => {
      startPlanAuthController.abort();
      if (reason !== "EOF") process.exit(0);
    },
  });
  const shutdown = (signal: string): void => {
    console.error(`[bridge] received ${signal}; fencing Admission/Dispatch before closing MCP transport`);
    void stdioHost.shutdown(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.error(`[bridge] SQLITE_READY at ${databasePath}`);
  console.error(`[bridge] ${host.name} stdio MCP server ready`);
}
