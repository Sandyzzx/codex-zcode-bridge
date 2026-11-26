import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateFailureFacts } from "../diagnostics/failure-facts.js";
import type { SqliteLifecycleMcpAuthority } from "../manager/sqlite-lifecycle-mcp-authority.js";
import { BridgeError } from "../runtime/errors.js";
import {
  createTaskModelRouter,
  buildModelRoutingCatalog,
  RecordingStartPlanEntitlement,
  resolvePreferStartPlan,
  StartPlanEntitlementJournal,
} from "../runtime/model-routing.js";
import { ZCodeModelSettings } from "../runtime/model-settings.js";
import { createPlatformProbe, type ProcessProbe } from "../runtime/process-probe.js";
import { loadPersistedRuntimeEnvironment, NodeRuntimeResolver } from "../runtime/resolver.js";
import { autoWakeEnabledFromEnvironment } from "../runtime/auto-wake-setting.js";
import {
  type OfficialStartPlanAuthenticationResolver,
  type ProductionAuthIssuer,
  type StartPlanLiveEntitlement,
} from "../runtime/start-plan-production-auth.js";
import { FRESH_SQLITE_DATABASE_FILE } from "../runtime/sqlite-install-config.js";
import { createTrustedLocalStdioContext } from "../runtime/trusted-local-deployment.js";
import { runBridgeDoctor, type DoctorCheck, type DoctorReport } from "../runtime/doctor.js";
import { initializeFreshInstallSqliteRoot } from "../store/lifecycle-gate.js";
import { SqliteLifecycleMcpAuthority as SqliteAuthority } from "../manager/sqlite-lifecycle-mcp-authority.js";
import { zcodeDataBaseDir } from "../runtime/account-provider.js";
import { workerEntryPath } from "../manager/spawn-worker.js";
import type { BridgeHostProfile } from "../runtime/host-profile.js";
import {
  createExecutorWakeCoordinator,
  defaultAppServerControlSocket,
  defaultCodexExecutable,
} from "./wake.js";

export interface HostStartPlanIssuerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly host: BridgeHostProfile;
  readonly workerEntryPath?: string;
  /** Aborted when the Host shuts down; revokes pending Lease delivery. */
  readonly signal: AbortSignal;
  /** Test-only override; production always uses the official Billing endpoint. */
  readonly entitlement?: StartPlanLiveEntitlement;
  /** Test-only Host resolver; production loads it from the verified artifact. */
  readonly authentication?: OfficialStartPlanAuthenticationResolver;
  /** ADR-031 routing journal fed by every live Billing verdict; advisory
   * execution-routing facts only, never an authorization cache. */
  readonly journal?: StartPlanEntitlementJournal;
}

export interface ProductionAuthorityCompositionOptions {
  readonly authorityRoot: string;
  readonly host: BridgeHostProfile;
  readonly bridgeEntryPath: string;
  readonly workerEntryPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly processProbe?: ProcessProbe;
  readonly testOnlyFakeAdapter?: true;
  readonly testBeforeDispatch?: () => Promise<void>;
  readonly testOnScheduler?: (stage: string, detail: Readonly<Record<string, unknown>>) => void;
  readonly onWorkerDiagnosticLine?: (line: string) => void;
  /** P1 §3.2 Lease Spawn Fence forwarded to the Manager. A non-null reason
   * blocks every new Worker Spawn path (pump, retry timers, recovery
   * redispatch) while Executor lease ownership is unknown. */
  readonly dispatchFence?: () => string | null;
}

export interface ProductionAuthorityComposition {
  readonly authority: SqliteLifecycleMcpAuthority;
  readonly modelSettings: ZCodeModelSettings;
  lifecycleChecks(): readonly DoctorCheck[];
  doctor(): Promise<DoctorReport>;
  abortAuthentication(): void;
}

/** Internal capability factory used by production and isolated adapter tests. */
export function createTrustedLocalCandidateContext(host: BridgeHostProfile) {
  return createTrustedLocalStdioContext(host);
}

/** Builds the production Start Plan issuer used by both the legacy Host and
 * the independent Executor. Account discovery remains per-dispatch. */
export async function createHostStartPlanIssuer(options: HostStartPlanIssuerOptions): Promise<ProductionAuthIssuer | null> {
  try {
    const config = await new NodeRuntimeResolver({
      env: options.env,
      homeDir: options.homeDir,
      host: options.host,
    }).resolve();
    if (!config.zcodeEntrypoint || !config.zcodeDataRoot) return null;
    const dataBaseDir = zcodeDataBaseDir(config.providerPersonalConfigFile);
    if (!dataBaseDir) return null;
    const { createProductionStartPlanAuth, StartPlanBillingEntitlement } = await import("../runtime/start-plan-production-auth.js");
    const workerModuleUrl = pathToFileURL(options.workerEntryPath ?? workerEntryPath());
    const {
      loadOfficialHostProductVersion,
      loadOfficialStartPlanAuthenticationResolverFactory,
    } = await import("../adapters/official-host-adapter.js");
    // Billing's app_version is the official product version embedded by the
    // fixed Host build. It is not the installed Desktop version.
    const officialProductVersion = options.entitlement
      ? undefined
      : await loadOfficialHostProductVersion(workerModuleUrl);
    const billingEntitlement = options.entitlement ?? new StartPlanBillingEntitlement({
      getAppVersion: async () => officialProductVersion,
    });
    let authentication = options.authentication;
    if (!authentication) {
      const factory = await loadOfficialStartPlanAuthenticationResolverFactory(workerModuleUrl);
      authentication = factory({ dataBaseDir });
    }
    return await createProductionStartPlanAuth({
      authentication,
      signal: options.signal,
      entitlement: options.journal
        ? new RecordingStartPlanEntitlement(billingEntitlement, options.journal)
        : billingEntitlement,
    });
  } catch {
    return null;
  }
}

/** Validates the bounded ADR-011 failure-facts marker emitted by a Worker. */
export function formatWorkerFailureFactsLine(line: string): string | null {
  const marker = "[bridge-worker] failure-facts ";
  if (!line.startsWith(marker)) return null;
  try {
    return JSON.stringify(validateFailureFacts(JSON.parse(line.slice(marker.length))));
  } catch {
    return null;
  }
}

export function createWorkerDiagnosticSink(prefix: string): (line: string) => void {
  return (line: string) => {
    const runtime = /^\[bridge-worker\] installed-runtime ([a-zA-Z0-9][a-zA-Z0-9_-]{0,63} [1-9]\d{0,8} [0-9a-f]{64})$/u.exec(line);
    if (runtime) {
      console.error(`${prefix} worker installed-runtime ${runtime[1]}`);
      return;
    }
    if (/^\[bridge-worker\] runtime-auth \{[^\r\n]{1,1024}\}$/u.test(line)) {
      console.error(`${prefix} ${line.slice("[bridge-worker] ".length)}`);
      return;
    }
    const facts = formatWorkerFailureFactsLine(line);
    if (facts) console.error(`${prefix} worker failure-facts ${facts}`);
  };
}

/**
 * One production Authority composition shared by the legacy MCP Host and the
 * independent Executor. It owns no Lease, transport, or shutdown policy.
 */
export async function createProductionAuthorityComposition(
  options: ProductionAuthorityCompositionOptions,
): Promise<ProductionAuthorityComposition> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const processProbe = options.processProbe ?? createPlatformProbe();
  const trustedLocalContext = createTrustedLocalStdioContext(options.host);
  if (trustedLocalContext.status !== "enabled") {
    throw new Error(`SQLite Authority startup refused: Trusted Local policy is ${trustedLocalContext.status}`);
  }

  const startPlanAuthAbort = new AbortController();
  const modelSettings = new ZCodeModelSettings(env, {
    homeDir,
    host: options.host,
    workerModuleUrl: pathToFileURL(options.workerEntryPath),
  });
  // Per-dispatch discovery observes login, logout, account switch, and config
  // changes without creating a second credential cache.
  const modelRoutingJournal = new StartPlanEntitlementJournal();
  const routeTaskModel = createTaskModelRouter({
    settings: () => {
      const persistedEnv = loadPersistedRuntimeEnvironment(env, homeDir, options.host);
      return {
        preferStartPlan: resolvePreferStartPlan(persistedEnv),
        defaultProviderId: persistedEnv["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() ?? "",
      };
    },
    catalog: async (workspace) => {
      const routingCatalog = await modelSettings.listRoutingCatalog(workspace);
      return {
        ...buildModelRoutingCatalog(routingCatalog.models),
        startPlanUnavailableReason: routingCatalog.startPlanUnavailableReason,
      };
    },
  });
  const wakeCoordinator = createExecutorWakeCoordinator({
    authorityRoot: options.authorityRoot,
    codexExecutable: defaultCodexExecutable(env),
    socketPath: defaultAppServerControlSocket(env, homeDir),
    autoWakeEnabled: () => autoWakeEnabledFromEnvironment(
      loadPersistedRuntimeEnvironment(env, homeDir, options.host),
    ),
  });

  await initializeFreshInstallSqliteRoot(
    options.authorityRoot,
    FRESH_SQLITE_DATABASE_FILE,
    process.versions.node,
    processProbe,
  );
  const authority = await SqliteAuthority.create({
    dataRoot: options.authorityRoot,
    databaseFileName: FRESH_SQLITE_DATABASE_FILE,
    managedDataDirectory: true,
    workerEntryPath: options.workerEntryPath,
    hostProfile: options.host,
    bridgeEntryPath: options.bridgeEntryPath,
    processProbe,
    trustedLocalContext,
    requireAuthorityReceipt: true,
    startPlanPrivateAuthFactory: () => createHostStartPlanIssuer({
      env,
      homeDir,
      host: options.host,
      workerEntryPath: options.workerEntryPath,
      signal: startPlanAuthAbort.signal,
      journal: modelRoutingJournal,
    }),
    routeTaskModel,
    onOperationReleased: (fact, recorder) => wakeCoordinator.handle(fact, {
      recordExecutorWakeObservation: (input) => recorder(input),
    }).then(() => undefined),
    onWorkerDiagnosticLine: options.onWorkerDiagnosticLine
      ?? createWorkerDiagnosticSink("[bridge]"),
    ...(options.testOnlyFakeAdapter === true ? { testOnlyFakeAdapter: true as const } : {}),
    ...(options.testBeforeDispatch ? { testBeforeDispatch: options.testBeforeDispatch } : {}),
    ...(options.testOnScheduler ? { testOnScheduler: options.testOnScheduler } : {}),
    ...(options.dispatchFence ? { dispatchFence: options.dispatchFence } : {}),
  });
  const lifecycleChecks = () => authority.getDoctorChecks();
  return {
    authority,
    modelSettings,
    lifecycleChecks,
    doctor: () => runBridgeDoctor({
      env,
      dataRoot: options.authorityRoot,
      resolver: { host: options.host, homeDir },
      lifecycleChecks,
    }),
    abortAuthentication: () => startPlanAuthAbort.abort(),
  };
}
