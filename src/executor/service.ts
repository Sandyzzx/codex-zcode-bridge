import { homedir } from "node:os";
import type { ProgressTaskManager } from "../interfaces.js";
import { workerEntryPath } from "../manager/spawn-worker.js";
import { fingerprintRuntimeArtifact } from "../runtime/build-provenance.js";
import type { DoctorReport } from "../runtime/doctor.js";
import type { ZCodeModelSettings } from "../runtime/model-settings.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { FRESH_SQLITE_DATABASE_FILE } from "../runtime/sqlite-install-config.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "../runtime/host-profile.js";
import {
  createProductionAuthorityComposition,
  createWorkerDiagnosticSink,
  type ProductionAuthorityComposition,
} from "./production-composition.js";
import { startExecutorControlServer, type ExecutorControlServerHandle } from "./control-server.js";
import {
  acquireExecutorLease,
  assertExecutorLeaseTransition,
  type ExecutorLeaseHandle,
} from "./lease.js";
import { executorPipeName } from "./pipe.js";
import type { ExecutorShutdownDecision } from "./management.js";
import type { ExecutorTaskManagement } from "../task-list.js";

export interface ExecutorAuthority extends ProgressTaskManager, Partial<ExecutorTaskManagement> {
  getExecutorIdleState(): { readonly idle: boolean; readonly blockers: readonly string[] };
  closeIfIdle(): Promise<{ readonly closed: boolean; readonly blockers: readonly string[] }>;
}

export type ExecutorModelSettings = Pick<
  ZCodeModelSettings,
  "listModels" | "getDefaultModel" | "setDefaultModel" | "clearDefaultModel"
>;

export interface ExecutorServiceOptions {
  readonly dataRoot: string;
  readonly host?: BridgeHostProfile;
  readonly bridgeEntryPath: string;
  readonly heartbeatMs?: number;
  readonly acceptUnleasedExistingRoot?: boolean;
  /** Internal synthetic E2E switches; production entry points never set them. */
  readonly testOnlyFakeAdapter?: true;
  readonly testWorkerEntryPath?: string;
  readonly testBeforeDispatch?: () => Promise<void>;
  readonly testOnScheduler?: (stage: string, detail: Readonly<Record<string, unknown>>) => void;
  /** Internal lifecycle-test seams. Production entry points never set them. */
  readonly testAuthority?: ExecutorAuthority;
  readonly testAuthorityFactory?: () => Promise<ExecutorAuthority>;
  readonly testModelSettings?: ExecutorModelSettings;
  readonly testDoctor?: () => Promise<DoctorReport>;
  readonly testUnrefHeartbeat?: boolean;
}

export interface ExecutorServiceHandle {
  readonly leaseId: string;
  readonly pipeName: string;
  readonly closed: Promise<void>;
  state(): ExecutorServiceState;
  shutdown(): Promise<{ readonly status: "closed" | "not_idle" | "release_unknown"; readonly blockers: readonly string[] }>;
}

export type ExecutorServiceState = "active" | "shutdown_pending" | "lease_unknown" | "closed";

async function cleanupFailedStartup(
  authority: ExecutorAuthority | undefined,
  composition: ProductionAuthorityComposition | undefined,
  server: ExecutorControlServerHandle | undefined,
  leaseHandle: ExecutorLeaseHandle,
): Promise<"released" | "retained"> {
  if (!authority) {
    // Authority construction can fail after opening the Store. Without an
    // explicit closed/not-writable fact, retain the exact lease fail closed.
    return "retained";
  }
  try {
    if (server) await server.close();
    const idle = authority.getExecutorIdleState();
    if (!idle.idle) return "retained";
    await leaseHandle.assertOwned();
    const closed = await authority.closeIfIdle();
    if (!closed.closed) return "retained";
    await leaseHandle.assertOwned();
    await leaseHandle.release();
    composition?.abortAuthentication();
    return "released";
  } catch {
    // A Store close, listener close, or ownership check that cannot be proved
    // leaves the owner record in place. Retry must use explicit lease recovery.
    return "retained";
  }
}

export async function startExecutorService(options: ExecutorServiceOptions): Promise<ExecutorServiceHandle> {
  const host = options.host ?? codexHostProfile(homedir());
  validateHostProfile(host);
  const workerPath = options.testWorkerEntryPath ?? host.workerEntryPath ?? workerEntryPath();
  const bridge = fingerprintRuntimeArtifact(options.bridgeEntryPath);
  const worker = fingerprintRuntimeArtifact(workerPath);
  if (!bridge.sha256 || !worker.sha256) throw new Error("EXECUTOR_BUILD_PROVENANCE_UNAVAILABLE");
  assertExecutorLeaseTransition({
    authorityRoot: options.dataRoot,
    databaseFileName: FRESH_SQLITE_DATABASE_FILE,
    acceptUnleasedExistingRoot: options.acceptUnleasedExistingRoot === true,
  });
  const processProbe = createPlatformProbe();
  const identity = await processProbe.selfIdentity();
  const pipeName = executorPipeName(options.dataRoot);
  const leaseHandle: ExecutorLeaseHandle = await acquireExecutorLease({
    authorityRoot: options.dataRoot,
    ownerKind: "executor",
    processProbe,
    identity,
    bridgeSha256: bridge.sha256,
    workerSha256: worker.sha256,
    pipeName,
  });

  let composition: ProductionAuthorityComposition | undefined;
  let authority: ExecutorAuthority | undefined;
  let server: ExecutorControlServerHandle | undefined;
  let state: ExecutorServiceState = "active";
  let leaseSafe = true;
  let serviceHandle: ExecutorServiceHandle | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const prepareControlShutdown = (): ExecutorShutdownDecision => {
    if (state === "shutdown_pending" || state === "closed") {
      return { status: "accepted", blockers: [] };
    }
    if (state === "lease_unknown" || !leaseSafe) {
      return { status: "release_unknown", blockers: ["lease_ownership_unknown"] };
    }
    let idle: ReturnType<ExecutorAuthority["getExecutorIdleState"]>;
    try {
      idle = authority!.getExecutorIdleState();
    } catch {
      return { status: "release_unknown", blockers: ["idle_state_unknown"] };
    }
    if (!idle.idle) return { status: "not_idle", blockers: idle.blockers };
    // Fence new lifecycle mutations before the response is acknowledged. The
    // actual close is scheduled after that response has been written.
    state = "shutdown_pending";
    return { status: "accepted", blockers: [] };
  };
  try {
    if (options.testAuthority || options.testAuthorityFactory) {
      authority = options.testAuthority ?? await options.testAuthorityFactory!();
    } else {
      composition = await createProductionAuthorityComposition({
        authorityRoot: options.dataRoot,
        host,
        bridgeEntryPath: options.bridgeEntryPath,
        workerEntryPath: workerPath,
        processProbe,
        // P1 §3.2 Lease Spawn Fence: while Executor lease ownership is unknown,
        // the Manager may not start any new Worker Spawn. In-flight Workers and
        // queued Attempts keep their own lifecycle rules.
        dispatchFence: () => state === "lease_unknown" || !leaseSafe
          ? "lease_ownership_unknown"
          : state === "closed" || state === "shutdown_pending"
            ? "executor_not_dispatching"
            : null,
        ...(options.testOnlyFakeAdapter ? { testOnlyFakeAdapter: true } : {}),
        ...(options.testBeforeDispatch ? { testBeforeDispatch: options.testBeforeDispatch } : {}),
        ...(options.testOnScheduler ? { testOnScheduler: options.testOnScheduler } : {}),
        onWorkerDiagnosticLine: createWorkerDiagnosticSink("[executor]"),
      });
      authority = composition.authority;
    }
    server = await startExecutorControlServer({
      pipeName,
      manager: authority,
      ...(composition?.modelSettings ?? options.testModelSettings
        ? { modelSettings: composition?.modelSettings ?? options.testModelSettings }
        : {}),
      ...(composition?.doctor ?? options.testDoctor
        ? { doctor: composition?.doctor ?? options.testDoctor }
        : {}),
      leaseId: leaseHandle.lease.lease_id,
      executorState: () => state,
      executorIdleState: () => authority!.getExecutorIdleState(),
      prepareShutdown: prepareControlShutdown,
      onShutdownAccepted: () => {
        void serviceHandle?.shutdown();
      },
    });
  } catch (error) {
    const cleanup = await cleanupFailedStartup(authority, composition, server, leaseHandle);
    console.error(`EXECUTOR_STARTUP_FAILED ${JSON.stringify({
      cleanup,
      error: error instanceof Error ? error.message : String(error),
    })}`);
    throw error;
  }

  let shutdownPromise: Promise<{ readonly status: "closed" | "not_idle" | "release_unknown"; readonly blockers: readonly string[] }> | null = null;
  let heartbeatInFlight = false;
  let heartbeatFailureReported = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || state === "closed") return;
    heartbeatInFlight = true;
    void leaseHandle.heartbeat({
      onUnknown: (error) => {
        // Preserve the Store and every in-flight Result. Reads stay available,
        // but no new lifecycle mutation or Authority release is admitted.
        leaseSafe = false;
        if (state !== "closed") state = "lease_unknown";
        if (!heartbeatFailureReported) {
          heartbeatFailureReported = true;
          console.error(`EXECUTOR_HEARTBEAT_UNKNOWN ${error.message}`);
        }
      },
    }).catch(() => undefined).finally(() => {
      heartbeatInFlight = false;
    });
  }, options.heartbeatMs ?? 5_000);
  if (options.testUnrefHeartbeat === true) heartbeat.unref();
  // The heartbeat is also the Executor's process-lifetime hold. The control
  // server stays unref'd for embedders, but a standalone Executor must not
  // exit while it still owns the SQLite Store.
  const service: ExecutorServiceHandle = {
    leaseId: leaseHandle.lease.lease_id,
    pipeName,
    closed,
    state: () => state,
    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      const attempt = (async () => {
        if (state === "closed") return { status: "closed" as const, blockers: [] };
        if (state === "lease_unknown" || !leaseSafe) {
          return { status: "release_unknown" as const, blockers: ["lease_ownership_unknown"] };
        }
        state = "shutdown_pending";
        // Fence new lifecycle mutations first, then let accepted mutations
        // settle. The control pipe remains open so a not-idle refusal can
        // restore normal service without reopening the listener.
        try {
          await server!.drainMutations();
        } catch {
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["control_request_drain_unknown"] };
        }
        let idle: ReturnType<ExecutorAuthority["getExecutorIdleState"]>;
        try {
          idle = authority!.getExecutorIdleState();
        } catch {
          leaseSafe = false;
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["idle_state_unknown"] };
        }
        if (!idle.idle) {
          state = "active";
          return { status: "not_idle" as const, blockers: idle.blockers };
        }
        if (!leaseSafe) {
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["lease_ownership_unknown"] };
        }
        try {
          await leaseHandle.assertOwned();
        } catch {
          leaseSafe = false;
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["lease_ownership_unknown"] };
        }
        try {
          await server!.close();
        } catch {
          leaseSafe = false;
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["control_server_close_unknown"] };
        }
        try {
          await leaseHandle.assertOwned();
        } catch {
          leaseSafe = false;
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["lease_ownership_unknown"] };
        }
        try {
          const closed = await authority!.closeIfIdle();
          if (!closed.closed) {
            state = "lease_unknown";
            return { status: "release_unknown" as const, blockers: closed.blockers };
          }
        } catch {
          leaseSafe = false;
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["store_close_unknown"] };
        }
        try {
          await leaseHandle.assertOwned();
          await leaseHandle.release();
        } catch {
          leaseSafe = false;
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["lease_release_unknown"] };
        }
        composition?.abortAuthentication();
        clearInterval(heartbeat);
        state = "closed";
        resolveClosed();
        return { status: "closed" as const, blockers: [] };
      })();
      shutdownPromise = attempt;
      try {
        return await attempt;
      } finally {
        if (shutdownPromise === attempt && state !== "closed") shutdownPromise = null;
      }
    },
  };
  serviceHandle = service;
  return service;
}
