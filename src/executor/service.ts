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
import { acquireExecutorLease, authorityRootDigest, type ExecutorLeaseHandle } from "./lease.js";
import { startExecutorControlServer, type ExecutorControlServerHandle } from "./control-server.js";

export interface ExecutorServiceOptions {
  readonly dataRoot: string;
  readonly host?: BridgeHostProfile;
  readonly bridgeEntryPath: string;
  readonly heartbeatMs?: number;
}

export interface ExecutorServiceHandle {
  readonly leaseId: string;
  readonly pipeName: string;
  shutdown(): Promise<{ readonly status: "closed" | "not_idle" | "release_unknown"; readonly blockers: readonly string[] }>;
}

function pipeNameFor(root: string): string {
  return `codex-zcode-bridge-executor-v1-${authorityRootDigest(root)}`;
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
    workerEntryPath: host.workerEntryPath ?? workerEntryPath(),
    hostProfile: host,
    bridgeEntryPath: options.bridgeEntryPath,
    processProbe: createPlatformProbe(),
    trustedLocalContext: createTrustedLocalStdioContext(host),
    requireAuthorityReceipt: true,
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
  const bridge = fingerprintRuntimeArtifact(options.bridgeEntryPath);
  const worker = fingerprintRuntimeArtifact(host.workerEntryPath ?? workerEntryPath());
  if (!bridge.sha256 || !worker.sha256) throw new Error("EXECUTOR_BUILD_PROVENANCE_UNAVAILABLE");
  const identity = await createPlatformProbe().selfIdentity();
  const leaseHandle: ExecutorLeaseHandle = await acquireExecutorLease({
    authorityRoot: options.dataRoot,
    ownerKind: "executor",
    processProbe: createPlatformProbe(),
    identity,
    bridgeSha256: bridge.sha256,
    workerSha256: worker.sha256,
    pipeName: null,
  });
  const pipeName = pipeNameFor(options.dataRoot);
  const built = await buildAuthority(options, options.dataRoot);
  const server: ExecutorControlServerHandle = await startExecutorControlServer({
    pipeName,
    manager: built.authority,
    leaseId: leaseHandle.lease.lease_id,
  });
  const heartbeat = setInterval(() => {
    void leaseHandle.heartbeat().catch(() => undefined);
  }, options.heartbeatMs ?? 5_000);
  heartbeat.unref?.();
  return {
    leaseId: leaseHandle.lease.lease_id,
    pipeName,
    async shutdown() {
      const idle = await built.authority.getExecutorIdleState();
      if (!idle.idle) return { status: "not_idle", blockers: idle.blockers };
      await server.close();
      try {
        await built.authority.closeIfIdle();
      } catch {
        return { status: "release_unknown", blockers: ["store_close_unknown"] };
      }
      try {
        await leaseHandle.release();
      } catch {
        return { status: "release_unknown", blockers: ["lease_release_unknown"] };
      }
      clearInterval(heartbeat);
      return { status: "closed", blockers: [] };
    },
  };
}
