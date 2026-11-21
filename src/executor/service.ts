import { homedir } from "node:os";
import { FRESH_SQLITE_DATABASE_FILE } from "../runtime/sqlite-install-config.js";
import { loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { fingerprintRuntimeArtifact } from "../runtime/build-provenance.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "../host/profile.js";
import { workerEntryPath } from "../manager/spawn-worker.js";
import { createTaskModelRouter, resolvePreferStartPlan, StartPlanEntitlementJournal } from "../runtime/model-routing.js";
import { SqliteLifecycleMcpAuthority } from "../manager/sqlite-lifecycle-mcp-authority.js";
import { createTrustedLocalStdioContext } from "../runtime/trusted-local-deployment.js";
import { initializeFreshInstallSqliteRoot } from "../store/lifecycle-gate.js";
import {
  acquireExecutorLease,
  assertExecutorLeaseTransition,
  authorityRootDigest,
  type ExecutorLeaseHandle,
} from "./lease.js";
import { startExecutorControlServer, type ExecutorControlServerHandle } from "./control-server.js";
import type { ProgressTaskManager } from "../interfaces.js";

export interface ExecutorAuthority extends ProgressTaskManager {
  getExecutorIdleState(): { readonly idle: boolean; readonly blockers: readonly string[] };
  closeIfIdle(): Promise<{ readonly closed: boolean; readonly blockers: readonly string[] }>;
}

export interface ExecutorServiceOptions {
  readonly dataRoot: string;
  readonly host?: BridgeHostProfile;
  readonly bridgeEntryPath: string;
  readonly heartbeatMs?: number;
  readonly acceptUnleasedExistingRoot?: boolean;
  /** Internal synthetic E2E switch; production never sets this. */
  readonly testOnlyFakeAdapter?: true;
  readonly testWorkerEntryPath?: string;
  readonly testBeforeDispatch?: () => Promise<void>;
  /** Internal lifecycle-test seam. Production entry points never set this. */
  readonly testAuthority?: ExecutorAuthority;
}

export interface ExecutorServiceHandle {
  readonly leaseId: string;
  readonly pipeName: string;
  state(): ExecutorServiceState;
  shutdown(): Promise<{ readonly status: "closed" | "not_idle" | "release_unknown"; readonly blockers: readonly string[] }>;
}

export type ExecutorServiceState = "active" | "shutdown_pending" | "lease_unknown" | "closed";

export function executorPipeName(root: string): string {
  return `\\\\.\\pipe\\codex-zcode-bridge-executor-v1-${authorityRootDigest(root)}`;
}

async function buildAuthority(options: ExecutorServiceOptions, dataRoot: string) {
  const host = options.host ?? codexHostProfile(homedir());
  validateHostProfile(host);
  const runtimeEnv = loadPersistedRuntimeEnvironment(process.env, homedir(), host);
  await initializeFreshInstallSqliteRoot(dataRoot, FRESH_SQLITE_DATABASE_FILE, process.versions.node, createPlatformProbe());
  const journal = new StartPlanEntitlementJournal();
  const authority = await SqliteLifecycleMcpAuthority.create({
    dataRoot,
    databaseFileName: FRESH_SQLITE_DATABASE_FILE,
    managedDataDirectory: true,
    workerEntryPath: options.testWorkerEntryPath ?? host.workerEntryPath ?? workerEntryPath(),
    hostProfile: host,
    bridgeEntryPath: options.bridgeEntryPath,
    processProbe: createPlatformProbe(),
    trustedLocalContext: createTrustedLocalStdioContext(host),
    requireAuthorityReceipt: true,
    ...(options.testOnlyFakeAdapter ? { testOnlyFakeAdapter: options.testOnlyFakeAdapter } : {}),
    ...(options.testBeforeDispatch ? { testBeforeDispatch: options.testBeforeDispatch } : {}),
    routeTaskModel: createTaskModelRouter({
      settings: () => ({
        preferStartPlan: resolvePreferStartPlan(runtimeEnv),
        defaultProviderId: runtimeEnv["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() ?? "",
      }),
      journal,
      registry: async () => ({ startPlanModelIds: [], codingPlanProviders: [] }),
    }),
  });
  return { authority, host, runtimeEnv };
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
  const identity = await createPlatformProbe().selfIdentity();
  const pipeName = executorPipeName(options.dataRoot);
  const leaseHandle: ExecutorLeaseHandle = await acquireExecutorLease({
    authorityRoot: options.dataRoot,
    ownerKind: "executor",
    processProbe: createPlatformProbe(),
    identity,
    bridgeSha256: bridge.sha256,
    workerSha256: worker.sha256,
    pipeName,
  });
  const authority = options.testAuthority ?? (await buildAuthority(options, options.dataRoot)).authority;
  let state: ExecutorServiceState = "active";
  let leaseSafe = true;
  let shutdownPromise: Promise<{ readonly status: "closed" | "not_idle" | "release_unknown"; readonly blockers: readonly string[] }> | null = null;
  const server: ExecutorControlServerHandle = await startExecutorControlServer({
    pipeName,
    manager: authority,
    leaseId: leaseHandle.lease.lease_id,
    executorState: () => state,
  });
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
  // The heartbeat is also the Executor's process-lifetime hold. The control
  // server stays unref'd for embedders, but a standalone Executor must not
  // exit while it still owns the SQLite Store.
  return {
    leaseId: leaseHandle.lease.lease_id,
    pipeName,
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
          await server.drainMutations();
        } catch {
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["control_request_drain_unknown"] };
        }
        let idle: ReturnType<ExecutorAuthority["getExecutorIdleState"]>;
        try {
          idle = authority.getExecutorIdleState();
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
          await server.close();
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
          const closed = await authority.closeIfIdle();
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
          await leaseHandle.release();
        } catch {
          leaseSafe = false;
          state = "lease_unknown";
          return { status: "release_unknown" as const, blockers: ["lease_release_unknown"] };
        }
        clearInterval(heartbeat);
        state = "closed";
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
}
