/**
 * Isolated WP6 lifecycle composition. Production startBridge does
 * not import this module; JSON remains the sole production authority.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessProbe, type ProbeRequest, type ProbeVerdict } from "../runtime/process-probe.js";
import { terminateProcessTree, verifyProcessTreeClaimantsClean } from "../adapters/process-spawn.js";
import { fingerprintRuntimeArtifact, type RuntimeBuildProvenance } from "../runtime/build-provenance.js";
import { spawnClaimOnlyWorker, type ClaimOnlyWorkerProcess } from "../manager/spawn-worker.js";
import {
  spawnAndBootstrapOnce,
  type PrivateBootstrapChild,
  deriveAdmissionPolicySnapshotDigest,
  type AdmissionPolicySnapshot,
} from "../sqlite-candidate/wp6b2b1/launch-bootstrap.js";
import type { LaunchRequest } from "../sqlite-candidate/wp6b2b1/manager-launch.js";
import { observeTrustedLaunchIdentity } from "../sqlite-candidate/wp6b2b1/launch-identity.js";
import { verifyHandshakeAndCommitClaim, type WorkerReportedIdentity } from "../sqlite-candidate/wp6b2b1/worker-handshake.js";
import type {
  CandidateExecutionCleanupProof,
  CandidateResultStatus,
  CandidateTaskResult,
  CandidateWorkerResultFrame,
} from "../sqlite-candidate/wp6c/fake-result-adapter.js";
import { isTrustedLocalStdioContext, type TrustedLocalStdioContext } from "../runtime/trusted-local-deployment.js";
import type { BridgeHostProfile } from "../host/profile.js";
import { codexHostProfile, validateHostProfile } from "../host/profile.js";
import {
  currentSqliteRuntimeRosterDigest,
  SQLITE_CUTOVER_VERIFIER_VERSION,
} from "../runtime/sqlite-runtime-roster.js";
import { isSupportedNodeVersion } from "../runtime/node-runtime.js";

const DEFAULT_PROCESS_PROBE_TIMEOUT_MS = 5_000;
type BoundedProbeOutcome =
  | { readonly status: "resolved"; readonly verdict: ProbeVerdict | undefined }
  | { readonly status: "timeout" | "rejected" };
type BoundedTreeOutcome =
  | { readonly status: "resolved"; readonly result: Awaited<ReturnType<typeof verifyProcessTreeClaimantsClean>> }
  | { readonly status: "timeout" | "rejected" };

interface CandidateResultCommitInput {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly claim_id: string;
  readonly claim_worker_identity_digest: string;
  readonly result_status: CandidateResultStatus;
  readonly result: CandidateTaskResult;
  readonly cancel_verification_digest?: string;
}

interface CandidateResultCommitOutcome {
  readonly operation_id: string;
  readonly generation: number;
  readonly revision: number;
  readonly result_digest?: string;
  readonly result_commit_ref?: string;
  readonly result_status?: CandidateResultStatus;
  readonly phase?: string;
  readonly duplicate: boolean;
  readonly conflict: boolean;
  readonly quarantined?: boolean;
  readonly conflict_evidence_digest?: string;
}

interface CandidateCommittedResult {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly phase: string;
  readonly claim_id: string;
  readonly claim_worker_identity_digest: string;
  readonly result_status: CandidateResultStatus;
  readonly result_generation: number;
  readonly result_digest: string;
  readonly result_commit_ref: string;
  readonly result: CandidateTaskResult;
}

interface CandidateCleanupFence {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly claim_id: string;
  readonly claim_worker_identity_digest: string;
}

export interface CandidateTaskPackage {
  readonly task_id: string;
  readonly workspace: string;
  readonly worktree_path?: string;
  readonly model?: Readonly<{ provider_id: string; model_id: string; reasoning_level?: string }>;
  readonly timeout_ms?: number;
  readonly objective: string;
  readonly requirements: readonly string[];
  readonly allowed_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
  readonly acceptance_criteria: readonly string[];
  readonly test_commands: readonly string[];
  readonly context?: string;
}

type LifecycleEventsPage = Readonly<{
  events: readonly Readonly<Record<string, unknown>>[];
  nextCursor: number;
  hasMore: boolean;
}>;

interface ClaimOnlyPort {
  provisionCapacity(input: unknown): unknown;
  createTask(task: CandidateTaskPackage): unknown;
  admitOperation(input: unknown, gates: unknown): unknown;
  readOperation(operationId: string): unknown;
  createLaunchIntent(request: LaunchRequest): unknown;
  recordLaunchReceipt(input: LaunchRequest & { receipt_id: string; launch_identity: unknown }): unknown;
  commitPermanentClaim: Parameters<typeof verifyHandshakeAndCommitClaim>[0]["commitPermanentClaim"];
  readLifecycleEvents(operationId: string, options?: { readonly afterSequence?: number; readonly limit?: number }): readonly Readonly<Record<string, unknown>>[];
  readTaskProjection(taskId: string): unknown;
  readAttempt(taskId: string, attempt: number): unknown;
  commitResult(input: CandidateResultCommitInput): CandidateResultCommitOutcome;
  readCommittedResult(operationId: string): CandidateCommittedResult | null;
  beginCleanup(input: CandidateCleanupFence): Readonly<Record<string, unknown>>;
  recordCleanupEvidence(input: CandidateCleanupFence & Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  reverifyCleanup(input: CandidateCleanupFence & { readonly cleanup_evidence: Readonly<Record<string, unknown>> }): Readonly<Record<string, unknown>>;
  releaseCapacity(input: CandidateCleanupFence & { readonly cleanup_digest: string }): Readonly<Record<string, unknown>>;
  readTaskLifecycle(taskId: string): unknown;
  readRecoverableQueuedAttempts(): readonly Readonly<Record<string, unknown>>[];
  readTaskEvents(taskId: string, options?: { readonly afterCursor?: number; readonly limit?: number }): LifecycleEventsPage;
  readTaskFeedback(taskId: string): unknown;
  readRecoverySnapshot(): unknown;
  recordRecoveryObservation(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): unknown;
  createNextAttempt(input: Readonly<Record<string, unknown>>, gates: {
    readonly workspaceValidator: (input: { readonly requestedPath: string; readonly canonicalPath: string }) => unknown;
    readonly executionPermissionCheck: (context: Parameters<TrustedLocalStdioContext["policy"]["checkPermission"]>[0]) => unknown;
  }): unknown;
  cancelQueuedAttempt(input: { readonly task_id: string; readonly expected_attempt: number }): unknown;
  requestCancellation(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  recordCancellationVerification(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  readInteractionRequest(taskId: string, requestId: string): Readonly<Record<string, unknown>> | null;
  replyToInteractionRequest(input: unknown): Promise<Readonly<Record<string, unknown>>>;
  openInteractionChannel(child: ClaimOnlyWorkerProcess, operation: Readonly<Record<string, unknown>>, verifyProcessIdentity: (input: CandidateInteractionIdentityCheck) => Promise<unknown>): Promise<CandidateInteractionChannel>;
  receiveInteractionRequest(channel: CandidateInteractionChannel): Promise<Readonly<Record<string, unknown>>>;
  replyToInteractionRequest(input: unknown, channel: CandidateInteractionChannel): Promise<Readonly<Record<string, unknown>>>;
}

/** Read every Operation event through the Store's bounded cursor API. */
export function readAllLifecycleEventsForRecovery(
  port: Pick<ClaimOnlyPort, "readLifecycleEvents">,
  operationId: string,
): readonly Readonly<Record<string, unknown>>[] {
  const pageSize = 200;
  const events: Readonly<Record<string, unknown>>[] = [];
  let afterSequence = 0;
  while (true) {
    const page = port.readLifecycleEvents(operationId, { afterSequence, limit: pageSize });
    if (page.length > pageSize) throw new LifecycleGateError("recovery_event_page_oversized");
    events.push(...page);
    if (page.length < pageSize) return events;
    const lastSequence = Number(page[page.length - 1]?.sequence);
    if (!Number.isSafeInteger(lastSequence) || lastSequence <= afterSequence) {
      throw new LifecycleGateError("recovery_event_cursor_invalid");
    }
    afterSequence = lastSequence;
  }
}

interface CandidateInteractionChannel {
  readonly binding: Readonly<Record<string, unknown>>;
  receiveRequest(): Promise<Readonly<Record<string, unknown>>>;
  prepareReply(reply: Readonly<Record<string, unknown>>): Promise<unknown>;
  commitReply(reply: Readonly<Record<string, unknown>>, commit: Readonly<Record<string, unknown>>): Promise<unknown>;
}

interface CandidateInteractionIdentityCheck {
  readonly child: ClaimOnlyWorkerProcess;
  readonly expected: Readonly<{ process_id: number; start_fingerprint: string }>;
}

export class LifecycleGateError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "LifecycleGateError";
  }
}

export interface LifecycleCandidateStore {
  close(): void;
  importJsonAuthoritySnapshot(snapshot: unknown): unknown;
  recordRawJsonArchiveCutover(snapshot: unknown): unknown;
  checkpoint(): void;
  assertAuthorityReady(expectedRuntimeRosterDigest: string): Readonly<Record<string, unknown>>;
  readSnapshot(): unknown;
  readTask(taskId: string): Readonly<Record<string, unknown>> | null;
  readAttempt(taskId: string, attempt: number): Readonly<Record<string, unknown>> | null;
  readTaskLifecycle(taskId: string): Readonly<Record<string, unknown>> | null;
  readTaskEvents(taskId: string, options?: {
    readonly afterCursor?: number;
    readonly limit?: number;
  }): LifecycleEventsPage;
  readMigratedResult(taskId: string, attempt: number): Readonly<Record<string, unknown>> | null;
  readMigratedHistoryExceptions(): readonly Readonly<Record<string, unknown>>[];
  readMigratedEvents(taskId: string): readonly Readonly<Record<string, unknown>>[];
  readMigratedArtifact(relativePath: string): Readonly<Record<string, unknown>> | null;
  readRecoverySnapshot(): unknown;
}

export interface LifecycleCandidateModules {
  readonly Store: {
    initialize(root: string, options?: Readonly<Record<string, unknown>>): LifecycleCandidateStore;
    open(root: string, options?: Readonly<Record<string, unknown>>): LifecycleCandidateStore;
    openForRecovery(root: string, options?: Readonly<Record<string, unknown>>): LifecycleCandidateStore | undefined;
  };
  readonly createPort: (store: object, options?: Readonly<Record<string, unknown>>) => ClaimOnlyPort;
}

export interface ClaimOnlyDriverOptions {
  readonly dataRoot: string;
  /** Internal Host install binding; candidate callers retain the default operations.sqlite3 path guard. */
  readonly databaseFileName?: string;
  readonly managedDataDirectory?: boolean;
  /** Production Host compositions require one durable Fresh Install or Authority Switch receipt. */
  readonly requireAuthorityReceipt?: boolean;
  readonly workerEntryPath: string;
  readonly bridgeEntryPath: string;
  readonly hostProfile?: BridgeHostProfile;
  readonly processProbe?: ProcessProbe;
  /** Test-only shortening of the fixed Manager probe deadline; production uses 5 seconds. */
  readonly testProcessProbeTimeoutMs?: number;
  readonly loadModules?: () => Promise<LifecycleCandidateModules>;
  /** Opaque capability created by the local stdio Host composition. */
  readonly trustedLocalContext?: TrustedLocalStdioContext;
  /** Test-only stage recorder for bounded cross-process diagnostics. */
  readonly onStage?: (stage: string, detail?: Readonly<Record<string, unknown>>) => void;
  /** Test-only callback to attach a draining stderr recorder immediately after Spawn. */
  readonly onChildSpawn?: (child: ClaimOnlyWorkerProcess) => void;
  /** Synthetic integration test only. Production host composition never enables this driver. */
  readonly enableSyntheticInteractionChannel?: boolean;
  /** Test-only injection. Production composition must not set this option. */
  readonly testOnlyFakeAdapter?: true;
}

export interface ClaimOnlyRunInput {
  readonly task: CandidateTaskPackage;
  readonly operationId: string;
  readonly launchId: string;
  readonly launchToken: string;
  readonly attempt: number;
  readonly continuation?: Readonly<Record<string, unknown>> | null;
  readonly previousResult?: CandidateTaskResult | null;
}

export interface ClaimOnlyRunResult {
  readonly state: "result_committed" | "result_rejected" | "result_conflict" | "result_outcome_unknown" | "claim_rejected" | "launch_outcome_unknown";
  readonly reason?: string;
  readonly operation: unknown;
  readonly task: unknown;
  readonly attempt: unknown;
  readonly workerExitCode: number | null;
  readonly spawnCount: number;
  readonly result?: CandidateTaskResult;
  readonly resultStatus?: CandidateResultCommitOutcome["result_status"];
  readonly resultDigest?: string;
  readonly cleanupState: "not_attempted" | "released" | "unverified" | "unknown";
  readonly stopBoundary: "claim_only" | "result";
}

type CandidateImport = {
  readonly Store: LifecycleCandidateModules["Store"];
  readonly createPort: LifecycleCandidateModules["createPort"];
};

/** Node range for the SQLite candidate; never changes the product engines gate. */
export function assertSqliteRuntimeVersion(version: string): void {
  if (!isSupportedNodeVersion(version)) {
    throw new LifecycleGateError("sqlite_runtime_unsupported", "SQLite candidate requires Node >=24.16.0 <25");
  }
}

/** Test seam proves the version gate runs before any SQLite/native module load. */
export async function loadLifecycleCandidateModules(
  version = process.versions.node,
  importer: () => Promise<CandidateImport> = async () => {
    await import("node:sqlite");
    const [store, port] = await Promise.all([
      import("../sqlite-candidate/wp6b2b1/store.mjs"),
      import("../sqlite-candidate/wp6b2b1/lifecycle-port.mjs"),
    ]);
    return {
      Store: store.IsolatedAdmissionStore as unknown as LifecycleCandidateModules["Store"],
      createPort: port.createSqliteLifecyclePort as unknown as LifecycleCandidateModules["createPort"],
    };
  },
): Promise<LifecycleCandidateModules> {
  assertSqliteRuntimeVersion(version);
  try {
    return await importer();
  } catch (error) {
    throw new LifecycleGateError("sqlite_candidate_unavailable", error instanceof Error ? error.message : "candidate module unavailable");
  }
}

/** Initialize only a fresh synthetic root; never migrates an existing root. */
export async function initializeIsolatedCandidateRoot(root: string, version = process.versions.node): Promise<void> {
  const modules = await loadLifecycleCandidateModules(version);
  try {
    const store = modules.Store.initialize(root);
    store.close();
  } catch (error) {
    throw new LifecycleGateError("sqlite_initialization_failed", error instanceof Error ? error.message : "initialization failed");
  }
}

/** Initialize the explicit Fresh Install database without changing candidate-root defaults. */
export async function initializeFreshInstallSqliteRoot(
  root: string,
  databaseFileName: string,
  version = process.versions.node,
): Promise<{ readonly receiptId: string; readonly verifierVersion: string }> {
  const modules = await loadLifecycleCandidateModules(version);
  try {
    const receiptId = `fresh-install-${randomUUID()}`;
    const store = modules.Store.initialize(root, {
      databaseFileName,
      managedDataDirectory: true,
      freshInstallReceiptId: receiptId,
      verifierVersion: SQLITE_CUTOVER_VERIFIER_VERSION,
    });
    try {
      const port = modules.createPort(store);
      port.provisionCapacity({
        operation_id: "fresh-install-capacity-v1",
        capacity_limit: 8,
        expected_generation: 0,
        maintenance: { dispatch_blocked: true, writers_drained: true },
      });
    } finally { store.close(); }
    return { receiptId, verifierVersion: SQLITE_CUTOVER_VERIFIER_VERSION };
  } catch (error) {
    throw new LifecycleGateError("sqlite_initialization_failed", error instanceof Error ? error.message : "initialization failed");
  }
}

/**
 * Manager-side isolated driver. It binds Candidate lifecycle calls to one
 * SQLite port and performs the fenced Worker lifecycle in the synthetic host.
 */
export async function openClaimOnlyDriver(options: ClaimOnlyDriverOptions): Promise<{
  provisionCapacity(input: unknown): unknown;
  createTask(task: CandidateTaskPackage): unknown;
  readTaskLifecycle(taskId: string): unknown;
  readTaskEvents(taskId: string, options?: { readonly afterCursor?: number; readonly limit?: number }): LifecycleEventsPage;
  readCommittedResult(operationId: string): CandidateCommittedResult | null;
  readTaskFeedback(taskId: string): unknown;
  readRecoverySnapshot(): unknown;
  readRecoverableQueuedAttempts(): readonly Readonly<Record<string, unknown>>[];
  recoverOperation(operationId: string): Promise<Readonly<Record<string, unknown>>>;
  createNextAttempt(input: Readonly<Record<string, unknown>>): unknown;
  cancelQueuedAttempt(input: { readonly task_id: string; readonly expected_attempt: number }): unknown;
  requestCancellation(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  recordCancellationVerification(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  readInteractionRequest(taskId: string, requestId: string): Readonly<Record<string, unknown>> | null;
  replyToInteractionRequest(input: unknown): Promise<Readonly<Record<string, unknown>>>;
  openInteractionChannel(child: ClaimOnlyWorkerProcess, operation: Readonly<Record<string, unknown>>, verifyProcessIdentity: (input: CandidateInteractionIdentityCheck) => Promise<unknown>): Promise<CandidateInteractionChannel>;
  receiveInteractionRequest(channel: CandidateInteractionChannel): Promise<Readonly<Record<string, unknown>>>;
  run(input: ClaimOnlyRunInput): Promise<ClaimOnlyRunResult>;
  cancelRunning(taskId: string, attempt: number): Promise<Readonly<Record<string, unknown>>>;
  completeRunningCancellation(taskId: string, attempt: number): Promise<Readonly<Record<string, unknown>>>;
  close(): void;
}> {
  if (!isTrustedLocalStdioContext(options.trustedLocalContext)) {
    throw new LifecycleGateError("trusted_local_deployment_untrusted", "candidate admission requires the local stdio Host composition capability");
  }
  if (options.testOnlyFakeAdapter !== undefined && options.testOnlyFakeAdapter !== true) {
    throw new LifecycleGateError("test_adapter_mode_invalid");
  }
  const workerHostProfile = validateHostProfile(options.hostProfile ?? codexHostProfile());
  assertSqliteRuntimeVersion(process.versions.node);
  const processProbeTimeoutMs = options.testProcessProbeTimeoutMs ?? DEFAULT_PROCESS_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(processProbeTimeoutMs) || processProbeTimeoutMs < 1
    || processProbeTimeoutMs > DEFAULT_PROCESS_PROBE_TIMEOUT_MS) {
    throw new LifecycleGateError("process_probe_timeout_invalid");
  }
  const modules = await (options.loadModules?.() ?? loadLifecycleCandidateModules());
  let raw: LifecycleCandidateStore | undefined;
  try {
    if (!existsSync(options.dataRoot)) throw new LifecycleGateError("sqlite_database_missing", "candidate database must be initialized explicitly");
    raw = modules.Store.open(options.dataRoot, {
      ...(options.databaseFileName ? { databaseFileName: options.databaseFileName } : {}),
      ...(options.managedDataDirectory ? { managedDataDirectory: true } : {}),
    });
    if (options.requireAuthorityReceipt) {
      raw.assertAuthorityReady(currentSqliteRuntimeRosterDigest());
    }
  } catch (error) {
    raw?.close();
    if (error instanceof LifecycleGateError) throw error;
    throw new LifecycleGateError("sqlite_open_failed", error instanceof Error ? error.message : "candidate database open failed");
  }
  if (!raw) throw new LifecycleGateError("sqlite_open_failed", "candidate database open returned no Store");
  const probe = options.processProbe ?? createPlatformProbe();
  const workerIdentityVerifier = ({ operation, worker_identity, evidence }: { operation: Readonly<Record<string, unknown>>; worker_identity: Readonly<Record<string, unknown>>; evidence: Readonly<Record<string, unknown>> }) => {
    const operationDigest = text(operation.claim_worker_identity_digest, "cancellation_claim_identity_missing");
    const processId = positive(Number(worker_identity.process_id), "cancellation_worker_pid_invalid");
    const fingerprint = text(worker_identity.start_fingerprint, "cancellation_worker_fingerprint_missing");
    const state = evidence.identity_state;
    if (worker_identity.source !== "manager_verified_process_probe" || worker_identity.fixture !== false
      || evidence.source !== "manager_process_probe" || evidence.worker_identity_digest !== operationDigest
      || evidence.process_id !== processId || evidence.start_fingerprint !== fingerprint
      || (state !== "alive" && state !== "exited")
      || typeof evidence.probe_reason !== "string" || typeof evidence.observed_at !== "string") return false;
    return { state, worker_identity_digest: operationDigest, evidence_digest: sha256(canonicalJson(evidence)) };
  };
  const cancellationVerifier = ({ operation, cancel_intent, worker_identity, evidence }: { operation: Readonly<Record<string, unknown>>; cancel_intent: Readonly<Record<string, unknown>>; worker_identity: Readonly<Record<string, unknown>>; evidence: Readonly<Record<string, unknown>> }) => {
    const operationDigest = text(operation.claim_worker_identity_digest, "cancellation_claim_identity_missing");
    const processId = positive(Number(worker_identity.process_id), "cancellation_worker_pid_invalid");
    const fingerprint = text(worker_identity.start_fingerprint, "cancellation_worker_fingerprint_missing");
    if (evidence.source !== "manager_process_tree_verification" || evidence.outcome !== "verified"
      || evidence.operation_id !== operation.operation_id || evidence.task_id !== operation.task_id
      || evidence.attempt !== operation.attempt || evidence.generation !== operation.generation
      || evidence.cancel_id !== cancel_intent.cancel_id || evidence.claim_id !== operation.claim_id
      || evidence.worker_identity_digest !== operationDigest || evidence.root_process_id !== processId
      || evidence.root_start_fingerprint !== fingerprint || evidence.worker_tree_complete !== true
      || evidence.scan_clean !== true || !Array.isArray(evidence.live_pids) || evidence.live_pids.length !== 0
      || !["terminated", "already_exited"].includes(String(evidence.termination_state))) return false;
    const processTreeDigest = text(evidence.process_tree_digest, "cancellation_process_tree_digest_missing");
    if (!/^[0-9a-f]{64}$/u.test(processTreeDigest)) return false;
    return { state: "verified", worker_identity_digest: operationDigest, process_tree_digest: processTreeDigest,
      root_process_id: processId, root_start_fingerprint: fingerprint, worker_tree_complete: true,
      evidence_digest: sha256(canonicalJson(evidence)) };
  };
  const recoveryEvidenceBindings = new Map<string, Readonly<{
    operation_id: string; task_id: string; attempt: number; generation: number; expected_revision: number;
    claim_id: string; worker_identity_digest: string; classification: "hold";
    reason_code: "worker_identity_unknown" | "cleanup_identity_unknown" | "cleanup_incomplete"; evidence_source: "manager_process_probe"; evidence_json: string;
  }>>();
  const recoveryEvidenceVerifier = (context: {
    readonly operation: Readonly<Record<string, unknown>>;
    readonly observation: Readonly<Record<string, unknown>>;
    readonly evidence: Readonly<Record<string, unknown>>;
  }) => {
    const binding = recoveryEvidenceBindings.get(String(context.observation.evidence_digest));
    // Keep revision freshness in the Store transaction so concurrent observations receive a stale-CAS result.
    if (!binding || binding.evidence_json !== canonicalJson(context.evidence)
      || binding.operation_id !== context.operation.operation_id || binding.task_id !== context.operation.task_id
      || binding.attempt !== context.operation.attempt || binding.generation !== context.operation.generation
      || binding.claim_id !== context.operation.claim_id
      || binding.worker_identity_digest !== context.operation.worker_identity_digest
      || Object.entries(binding).some(([key, value]) => key !== "evidence_json" && context.observation[key] !== value)) return false;
    recoveryEvidenceBindings.delete(String(context.observation.evidence_digest));
    return { classification: binding.classification, reason_code: binding.reason_code,
      evidence_source: binding.evidence_source, evidence_digest: String(context.observation.evidence_digest) };
  };
  const port = modules.createPort(raw as object, { workerIdentityVerifier, cancellationVerifier, recoveryEvidenceVerifier });
  const localPolicy = options.trustedLocalContext.policy;
  const interactionChannels = new Map<string, CandidateInteractionChannel>();
  const activeWorkers = new Map<string, { readonly child: ClaimOnlyWorkerProcess; readonly input: ClaimOnlyRunInput }>();
  const cancellationProofs = new Map<string, { readonly input: ClaimOnlyRunInput; readonly child: ClaimOnlyWorkerProcess; readonly cancelId: string; readonly verificationDigest: string; readonly identityState: "alive" | "exited"; readonly terminationState: "terminated" | "already_exited"; readonly processTreeDigest: string; readonly livePids: readonly number[]; readonly observedPids: readonly number[]; readonly workerExitCode: number }>();
  const provenance: RuntimeBuildProvenance = {
    bridge: fingerprintRuntimeArtifact(options.bridgeEntryPath),
    worker: fingerprintRuntimeArtifact(options.workerEntryPath),
  };

  return {
    provisionCapacity: (input) => port.provisionCapacity(input),
    readRecoverySnapshot() {
      const recoveryStore = modules.Store.openForRecovery(options.dataRoot, {
        ...(options.databaseFileName ? { databaseFileName: options.databaseFileName } : {}),
        ...(options.managedDataDirectory ? { managedDataDirectory: true } : {}),
      });
      if (!recoveryStore) throw new LifecycleGateError("recovery_store_unavailable", "read-only Recovery Store could not be opened");
      try { return modules.createPort(recoveryStore).readRecoverySnapshot(); }
      finally { recoveryStore.close(); }
    },
    readRecoverableQueuedAttempts: () => port.readRecoverableQueuedAttempts(),
    async recoverOperation(operationId: string) {
      const operationValue = port.readOperation(operationId);
      if (!operationValue) throw new LifecycleGateError("recovery_operation_missing");
      const operation = asRecord(operationValue);
      if (operation.operation_kind !== "attempt_lifecycle") return { state: "not_applicable", operation_id: operationId };
      const phase = text(operation.phase, "recovery_phase_missing");
      if (phase === "released" || phase === "cancelled_before_launch") return { state: "complete", operation_id: operationId, phase };
      if (phase === "reserved") return { state: "reserved", operation_id: operationId, phase };

      const lifecycleEvents = readAllLifecycleEventsForRecovery(port, operationId);
      const reverifiedCleanup = lifecycleEvents.find((event) => event.event_type === "cleanup_reverified");
      let resolvedRecoveryDigests = new Set<string>();
      if (reverifiedCleanup) {
        try {
          const evidence = JSON.parse(String(reverifiedCleanup.evidence_json)) as Record<string, unknown>;
          if (!Array.isArray(evidence.resolved_recovery_event_digests)
            || evidence.resolved_recovery_event_digests.some((value) => typeof value !== "string")) {
            throw new LifecycleGateError("recovery_cleanup_resolution_invalid");
          }
          resolvedRecoveryDigests = new Set(evidence.resolved_recovery_event_digests as string[]);
        } catch (error) {
          if (error instanceof LifecycleGateError) throw error;
          throw new LifecycleGateError("recovery_cleanup_resolution_invalid");
        }
      }
      const activeRecovery = lifecycleEvents.filter((event) => {
        if (event.event_type !== "observation_recorded") return false;
        try {
          const evidence = JSON.parse(String(event.evidence_json)) as Record<string, unknown>;
          return (evidence.reason === "recovery_hold" || evidence.reason === "recovery_quarantine")
            && !resolvedRecoveryDigests.has(String(event.evidence_digest));
        } catch { throw new LifecycleGateError("recovery_event_evidence_invalid"); }
      });
      const cleanupOnlyHolds = phase === "cleanup_unverified" && activeRecovery.every((event) => {
        try {
          const evidence = JSON.parse(String(event.evidence_json)) as Record<string, unknown>;
          return evidence.classification === "hold"
            && (evidence.reason_code === "cleanup_identity_unknown" || evidence.reason_code === "cleanup_incomplete");
        } catch { throw new LifecycleGateError("recovery_event_evidence_invalid"); }
      });
      if (activeRecovery.length > 0 && !cleanupOnlyHolds) {
        return { state: "held", operation_id: operationId, phase, reason: "recovery_latch_persisted" };
      }

      if (phase === "cleanup_verified") {
        const cleanup = lifecycleEvents.find((event) => event.event_type === "cleanup_verified");
        if (!cleanup) throw new LifecycleGateError("recovery_cleanup_evidence_missing");
        let evidence: Record<string, unknown>;
        try { evidence = JSON.parse(String(cleanup.evidence_json)) as Record<string, unknown>; }
        catch { throw new LifecycleGateError("recovery_cleanup_evidence_invalid"); }
        const cleanupDigest = text(evidence.cleanup_digest, "recovery_cleanup_digest_missing");
        const release = asRecord(port.releaseCapacity({
          operation_id: operationId,
          task_id: text(operation.task_id, "recovery_task_id_missing"),
          attempt: positive(Number(operation.attempt), "recovery_attempt_invalid"),
          generation: positive(Number(operation.generation), "recovery_generation_invalid"),
          revision: positive(Number(operation.revision), "recovery_revision_invalid"),
          claim_id: text(operation.claim_id, "recovery_claim_id_missing"),
          claim_worker_identity_digest: text(operation.claim_worker_identity_digest, "recovery_claim_identity_missing"),
          cleanup_digest: cleanupDigest,
        }));
        if (release.phase !== "released" || release.capacity_released !== true) throw new LifecycleGateError("recovery_release_not_persisted");
        return { state: "released", operation_id: operationId, phase: "released", revision: release.revision };
      }

      const claimId = operation.claim_id;
      const workerDigest = operation.claim_worker_identity_digest;
      if (claimId === null || typeof claimId !== "string" || typeof workerDigest !== "string") {
        return { state: "held", operation_id: operationId, phase, reason: "claim_or_launch_outcome_unknown" };
      }
      if (!["running", "result_committed", "cleanup_pending", "cleanup_unverified"].includes(phase)) {
        return { state: "held", operation_id: operationId, phase, reason: "phase_not_automatically_recoverable" };
      }
      let worker: Record<string, unknown>;
      try { worker = parseEvidence(operation.claim_worker_identity_json, "recovery_worker_identity_invalid"); }
      catch { return { state: "held", operation_id: operationId, phase, reason: "worker_identity_unverifiable" }; }
      const launch = parseEvidence(operation.launch_identity_json, "recovery_launch_identity_invalid");
      const processId = Number(worker.process_id);
      const fingerprint = worker.start_fingerprint;
      if (worker.source !== "manager_verified_process_probe" || worker.fixture !== false
        || launch.source !== "manager_os_spawn_observation" || launch.fixture !== false
        || worker.platform !== "win32" || launch.platform !== "win32" || probe.platform !== "win32"
        || worker.fingerprint_precision !== "exact" || launch.fingerprint_precision !== "exact"
        || launch.process_id !== processId || launch.start_fingerprint !== fingerprint
        || worker.identity_version !== PROCESS_IDENTITY_VERSION || launch.identity_version !== PROCESS_IDENTITY_VERSION
        || !Number.isSafeInteger(processId) || processId < 1 || typeof fingerprint !== "string") {
        return { state: "held", operation_id: operationId, phase, reason: "worker_identity_unverifiable" };
      }
      const identity = { pid: processId, fingerprint, fingerprint_precision: "exact" as const,
        identity_version: PROCESS_IDENTITY_VERSION, platform: "win32" as const, captured_at: text(worker.captured_at, "recovery_identity_capture_missing") };
      let verdict: ProbeVerdict | undefined;
      let probeFailure: "probe_timeout" | "probe_rejected" | null = null;
      const probeOutcome = await probeWithDeadline(probe, { pid: processId, identity }, processProbeTimeoutMs);
      if (probeOutcome.status === "resolved") verdict = probeOutcome.verdict;
      else probeFailure = probeOutcome.status === "timeout" ? "probe_timeout" : "probe_rejected";
      const identityState = verdict?.state === "alive" || verdict?.state === "exited" ? verdict.state : "unknown";
      const cleanupPhase = phase === "result_committed" || phase === "cleanup_pending" || phase === "cleanup_unverified";
      const probeReason = probeFailure ?? (typeof verdict?.reason_code === "string" ? verdict.reason_code : "probe_result_unknown");
      const cancellationRequested = lifecycleEvents.some((event) => {
        if (event.event_type !== "observation_recorded") return false;
        try { return JSON.parse(String(event.evidence_json)).reason === "cancel_requested"; }
        catch { throw new LifecycleGateError("recovery_event_evidence_invalid"); }
      });

      // Recovery may finish the C2 protocol from result_committed or
      // cleanup_pending. The OD-8 supplement also permits cleanup_unverified
      // to proceed only after fresh exact-identity exit evidence and a clean,
      // complete tree/resource verification. PID absence alone never releases.
      let treeOutcome: BoundedTreeOutcome | undefined;
      if ((phase === "result_committed" || phase === "cleanup_pending" || phase === "cleanup_unverified")
        && identityState === "exited") {
        treeOutcome = await processTreeWithDeadline([{ pid: processId, fingerprint }], 30_000);
      }
      if ((phase === "result_committed" || phase === "cleanup_pending" || phase === "cleanup_unverified") && identityState === "exited") {
        // The current claimant scan proves only that recorded roots and
        // observed claimants are absent. Its contract explicitly excludes
        // unobserved intermediate ancestors, so a clean scan is not a
        // complete process-tree or Operation-resource closure proof. Keep
        // this Recovery path fail-closed until a trusted verifier can return
        // that complete evidence; never manufacture C2 completeness flags
        // from `clean === true` alone.
        const completeCleanupClosureAvailable = false;
        if (completeCleanupClosureAvailable && treeOutcome?.status === "resolved"
          && treeOutcome.result.clean === true && treeOutcome.result.livePids.length === 0) {
          const currentOperation = asRecord(port.readOperation(operationId));
          if (currentOperation.task_id !== operation.task_id || Number(currentOperation.attempt) !== Number(operation.attempt)
            || Number(currentOperation.generation) !== Number(operation.generation) || currentOperation.claim_id !== claimId
            || currentOperation.claim_worker_identity_digest !== workerDigest) {
            return { state: "held", operation_id: operationId, phase: String(currentOperation.phase), reason: "recovery_identity_fence_changed" };
          }
          if (currentOperation.phase === "released") {
            return { state: "released", operation_id: operationId, phase: "released", revision: currentOperation.revision,
              duplicate: true, cleanup_recovered: true };
          }
          const currentPhase = text(currentOperation.phase, "recovery_phase_missing");
          if (currentPhase === "cleanup_verified") {
            const verifiedEvent = readAllLifecycleEventsForRecovery(port, operationId)
              .find((event) => event.event_type === "cleanup_verified");
            if (!verifiedEvent) throw new LifecycleGateError("recovery_cleanup_evidence_missing");
            const verifiedEvidence = parseEvidence(verifiedEvent.evidence_json, "recovery_cleanup_evidence_invalid");
            if (verifiedEvidence.claim_id !== claimId || verifiedEvidence.worker_identity_digest !== workerDigest
              || verifiedEvidence.root_process_id !== processId || verifiedEvidence.root_start_fingerprint !== fingerprint
              || verifiedEvidence.workspace_touched !== false || verifiedEvidence.worker_tree_complete !== true
              || verifiedEvidence.operation_resources_complete !== true) {
              throw new LifecycleGateError("recovery_cleanup_evidence_binding_invalid");
            }
            const released = asRecord(port.releaseCapacity({
              operation_id: operationId,
              task_id: text(currentOperation.task_id, "recovery_task_id_missing"),
              attempt: positive(Number(currentOperation.attempt), "recovery_attempt_invalid"),
              generation: positive(Number(currentOperation.generation), "recovery_generation_invalid"),
              revision: positive(Number(currentOperation.revision), "recovery_revision_invalid"),
              claim_id: text(claimId, "recovery_claim_id_missing"),
              claim_worker_identity_digest: text(workerDigest, "recovery_claim_identity_missing"),
              cleanup_digest: text(verifiedEvidence.cleanup_digest, "recovery_cleanup_digest_missing"),
            }));
            if (released.phase !== "released" || released.capacity_released !== true) throw new LifecycleGateError("recovery_release_not_persisted");
            return { state: "released", operation_id: operationId, phase: "released", revision: released.revision,
              duplicate: true, cleanup_recovered: true };
          }
          // Cleanup evidence was collected against the Operation/event snapshot
          // read before the asynchronous identity and process-tree probes. Do
          // not upgrade to a newer revision here: a concurrent Recovery may
          // have appended a new Cleanup Hold while those probes were pending.
          // The Store CAS still fences writes after this check; this comparison
          // fences the evidence against changes that happened during probing.
          if (Number(currentOperation.revision) !== Number(operation.revision)) {
            return { state: "held", operation_id: operationId, phase: currentPhase,
              reason: "recovery_revision_changed_during_probe" };
          }
          if (currentPhase !== "result_committed" && currentPhase !== "cleanup_pending" && currentPhase !== "cleanup_unverified") {
            return { state: "held", operation_id: operationId, phase: currentPhase, reason: "recovery_phase_advanced_or_latched" };
          }
          const committedResult = port.readCommittedResult(operationId);
          if (!committedResult || committedResult.operation_id !== operationId
            || committedResult.task_id !== operation.task_id || committedResult.attempt !== Number(operation.attempt)
            || committedResult.generation !== Number(operation.generation) || committedResult.claim_id !== claimId
            || committedResult.claim_worker_identity_digest !== workerDigest
            || committedResult.result_commit_ref !== operation.result_commit_ref
            || committedResult.phase !== currentPhase) {
            throw new LifecycleGateError("recovery_committed_result_binding_invalid");
          }
          const fence: CandidateCleanupFence = {
            operation_id: operationId,
            task_id: text(operation.task_id, "recovery_task_id_missing"),
            attempt: positive(Number(operation.attempt), "recovery_attempt_invalid"),
            generation: positive(Number(operation.generation), "recovery_generation_invalid"),
            revision: positive(Number(currentOperation.revision), "recovery_revision_invalid"),
            claim_id: text(claimId, "recovery_claim_id_missing"),
            claim_worker_identity_digest: text(workerDigest, "recovery_claim_identity_missing"),
          };
          const pending = currentPhase === "result_committed" ? asRecord(port.beginCleanup(fence)) : currentOperation;
          const expectedCleanupPhase = currentPhase === "cleanup_unverified" ? "cleanup_unverified" : "cleanup_pending";
          if (pending.phase !== expectedCleanupPhase || pending.operation_id !== operationId
            || Number(pending.generation) !== fence.generation) {
            throw new LifecycleGateError("recovery_cleanup_pending_not_persisted");
          }
          const cleanupFence = { ...fence, revision: positive(Number(pending.revision), "recovery_cleanup_revision_missing") };
          // This isolated Driver only launches fake_candidate_adapter. Its
          // Worker has no Workspace write path; Store cleanup APIs separately
          // reject unresolved interaction replies inside the transaction.
          const processTreeFacts = {
            contract: "sqlite-candidate-recovery-worker-tree-v1",
            operation_id: operationId,
            task_id: fence.task_id,
            attempt: fence.attempt,
            generation: fence.generation,
            claim_id: fence.claim_id,
            worker_identity_digest: workerDigest,
            root_process_id: processId,
            root_start_fingerprint: fingerprint,
            identity_state: "exited",
            scan_clean: true,
            live_pids: [],
          };
          const resourceFacts = {
            contract: "sqlite-candidate-recovery-operation-resources-v1",
            adapter: "fake_candidate_adapter",
            operation_id: operationId,
            generation: fence.generation,
            claim_id: fence.claim_id,
            worker_identity_digest: workerDigest,
            result_commit_ref: committedResult.result_commit_ref,
            worker_process_exited: true,
            worker_tree_complete: true,
            workspace_touched: false,
            interaction_replies_resolved: true,
          };
          const cleanupEvidence = {
            source: "manager_os_cleanup_verification",
            fixture: false,
            operation_id: operationId,
            task_id: fence.task_id,
            attempt: fence.attempt,
            generation: fence.generation,
            claim_id: fence.claim_id,
            worker_identity_digest: workerDigest,
            launch_receipt_digest: text(operation.launch_receipt_digest, "recovery_receipt_digest_missing"),
            result_commit_ref: text(committedResult.result_commit_ref, "recovery_result_ref_missing"),
            process_tree_digest: sha256(canonicalJson(processTreeFacts)),
            resources_digest: sha256(canonicalJson(resourceFacts)),
            root_process_id: processId,
            root_start_fingerprint: fingerprint,
            worker_tree_complete: true,
            operation_resources_complete: true,
            workspace_touched: false,
          };
          const recorded = asRecord(currentPhase === "cleanup_unverified"
            ? port.reverifyCleanup({ ...cleanupFence, cleanup_evidence: cleanupEvidence })
            : port.recordCleanupEvidence({ ...cleanupFence, outcome: "verified", cleanup_evidence: cleanupEvidence }));
          if (recorded.cleanup_verified !== true || (recorded.phase !== "cleanup_verified" && recorded.phase !== "released")) {
            throw new LifecycleGateError("recovery_cleanup_evidence_not_persisted");
          }
          const released = asRecord(port.releaseCapacity({ ...cleanupFence,
            revision: positive(Number(recorded.revision), "recovery_cleanup_verified_revision_missing"),
            cleanup_digest: text(recorded.cleanup_digest, "recovery_cleanup_digest_missing") }));
          if (released.phase !== "released" || released.capacity_released !== true) {
            throw new LifecycleGateError("recovery_release_not_persisted");
          }
          return { state: "released", operation_id: operationId, phase: "released", revision: released.revision,
            cleanup_recovered: true, cancellation_requested: cancellationRequested };
        }
      }

      const treeReason = treeOutcome?.status === "timeout" ? "process_tree_probe_timeout"
        : treeOutcome?.status === "rejected" ? "process_tree_probe_rejected"
          : treeOutcome?.status === "resolved" && treeOutcome.result.livePids.length > 0 ? "process_tree_still_live"
            : treeOutcome?.status === "resolved" && treeOutcome.result.clean !== true ? "process_tree_not_verified"
              : treeOutcome?.status === "resolved" && treeOutcome.result.clean === true ? "complete_cleanup_closure_unavailable" : undefined;
      const disposition = phase === "running" && identityState === "exited"
        ? cancellationRequested ? "cancel_interrupted_without_committed_result" : "worker_exited_without_committed_result"
        : phase === "cleanup_unverified"
          ? identityState === "alive" ? "worker_still_alive"
            : identityState === "unknown" ? "cleanup_identity_unknown"
              : treeReason ?? "cleanup_evidence_incomplete"
          : identityState === "alive" ? "worker_still_alive"
            : identityState === "exited" && cleanupPhase ? treeReason ?? "cleanup_evidence_incomplete" : "worker_identity_unknown";
      const reasonCode = identityState === "unknown"
        ? cleanupPhase ? "cleanup_identity_unknown" as const : "worker_identity_unknown" as const
        : "cleanup_incomplete" as const;
      const evidence = {
        source: "manager_process_probe", operation_id: operationId, task_id: operation.task_id,
        attempt: Number(operation.attempt), generation: Number(operation.generation), phase,
        claim_id: claimId, worker_identity_digest: workerDigest, identity_state: identityState,
        process_id: processId, start_fingerprint: fingerprint,
        probe_reason: probeReason, recovery_disposition: disposition,
        process_tree_scan_clean: treeOutcome?.status === "resolved" ? treeOutcome.result.clean : null,
        process_tree_scan_scope: "recorded_roots_and_observed_claimants_only",
        complete_cleanup_closure: false,
        observed_at: typeof verdict?.observed_at === "string" ? verdict.observed_at : new Date().toISOString(),
      };
      const evidenceDigest = sha256(canonicalJson(evidence));
      const input = {
        operation_id: operationId, task_id: text(operation.task_id, "recovery_task_id_missing"),
        attempt: positive(Number(operation.attempt), "recovery_attempt_invalid"),
        generation: positive(Number(operation.generation), "recovery_generation_invalid"),
        expected_revision: positive(Number(operation.revision), "recovery_revision_invalid"),
        claim_id: claimId, worker_identity_digest: workerDigest, classification: "hold" as const,
        reason_code: reasonCode, evidence_source: "manager_process_probe" as const, evidence_digest: evidenceDigest,
      };
      recoveryEvidenceBindings.set(evidenceDigest, { ...input, evidence_json: canonicalJson(evidence) });
      try {
        const recorded = asRecord(port.recordRecoveryObservation(input, evidence));
        return { state: "held", operation_id: operationId, phase, reason: reasonCode, revision: recorded.revision,
          identity_state: identityState, probe_reason: probeReason, evidence_digest: evidenceDigest };
      } catch (error) {
        recoveryEvidenceBindings.delete(evidenceDigest);
        if (errorCode(error) === "recovery_observation_conflict" || errorCode(error) === "stale_recovery_cas") {
          return { state: "held", operation_id: operationId, phase, reason: errorCode(error) };
        }
        throw error;
      }
    },
    createTask: (task) => port.createTask(task),
    readTaskLifecycle: (taskId) => port.readTaskLifecycle(taskId),
    readTaskEvents: (taskId, options) => port.readTaskEvents(taskId, options),
    readCommittedResult: (operationId) => port.readCommittedResult(operationId),
    readTaskFeedback: (taskId) => port.readTaskFeedback(taskId),
    createNextAttempt: (input) => port.createNextAttempt(input, {
      workspaceValidator: localPolicy.validateWorkspace,
      executionPermissionCheck: localPolicy.checkPermission,
    }),
    cancelQueuedAttempt: (input) => port.cancelQueuedAttempt(input),
    requestCancellation: (input, evidence) => port.requestCancellation(input, evidence),
    recordCancellationVerification: (input, evidence) => port.recordCancellationVerification(input, evidence),
    async cancelRunning(taskId, attempt) {
      const activeEntry = [...activeWorkers.entries()].find(([, value]) => value.input.task.task_id === taskId && value.input.attempt === attempt);
      const operationId = activeEntry?.[0];
      const active = activeEntry?.[1];
      if (!operationId || !active || !active.child.pid) {
        throw new LifecycleGateError("cancellation_worker_unavailable", "no bound Worker process handle exists for this SQLite Attempt");
      }
      const operation = asRecord(port.readOperation(operationId));
      if (operation.phase !== "running" || operation.task_id !== taskId || Number(operation.attempt) !== attempt) {
        return { result_won: operation.result_digest !== null, operation_id: operationId, phase: operation.phase, result_status: operation.result_status };
      }
      const worker = parseEvidence(String(operation.claim_worker_identity_json), "cancellation_worker_identity_invalid");
      if (worker.source !== "manager_verified_process_probe" || worker.fixture !== false || Number(worker.process_id) !== active.child.pid
        || worker.platform !== "win32" || worker.fingerprint_precision !== "exact" || typeof worker.start_fingerprint !== "string") {
        throw new LifecycleGateError("cancellation_worker_identity_mismatch");
      }
      const processIdentity = { pid: Number(worker.process_id), fingerprint: String(worker.start_fingerprint),
        fingerprint_precision: "exact" as const, identity_version: PROCESS_IDENTITY_VERSION, platform: "win32",
        captured_at: String(worker.captured_at) };
      const identityOutcome = await probeWithDeadline(probe, { pid: processIdentity.pid, identity: processIdentity }, processProbeTimeoutMs);
      const identityVerdict = identityOutcome.status === "resolved" ? identityOutcome.verdict : undefined;
      if (!identityVerdict || (identityVerdict.state !== "alive" && identityVerdict.state !== "exited")) {
        throw new LifecycleGateError("cancellation_identity_unknown", identityOutcome.status === "timeout"
          ? "Worker identity probe timed out"
          : identityOutcome.status === "rejected" ? "Worker identity probe failed"
            : identityVerdict?.reason_code ?? "Worker identity probe returned no verdict");
      }
      const fence = { operation_id: operationId, task_id: taskId, attempt, generation: Number(operation.generation),
        revision: Number(operation.revision), claim_id: String(operation.claim_id),
        claim_worker_identity_digest: String(operation.claim_worker_identity_digest), worker_identity: worker };
      const identityEvidence = { source: "manager_process_probe", identity_state: identityVerdict.state,
        probe_reason: identityVerdict.reason_code, observed_at: identityVerdict.observed_at,
        worker_identity_digest: fence.claim_worker_identity_digest, process_id: processIdentity.pid,
        start_fingerprint: processIdentity.fingerprint };
      const intent = asRecord(port.requestCancellation(fence, identityEvidence));
      if (intent.result_won === true) return intent;
      const cancelId = text(intent.cancel_id, "cancellation_intent_missing");
      const terminationState: "terminated" | "already_exited" = identityVerdict.state === "alive" ? "terminated" : "already_exited";
      if (identityVerdict.state === "alive") {
        const terminated = await terminateProcessTree(processIdentity.pid, { graceMs: 500, killWaitMs: 5_000,
          expectedRootFingerprint: processIdentity.fingerprint });
        if (terminated.verified !== true) throw new LifecycleGateError("cancellation_tree_termination_unverified");
      }
      const workerExitCode = await waitForClose(active.child, 15_000);
      if (workerExitCode === null) throw new LifecycleGateError("cancellation_worker_exit_unknown");
      const scan = await verifyProcessTreeClaimantsClean([{ pid: processIdentity.pid, fingerprint: processIdentity.fingerprint }]);
      if (!scan.clean || scan.livePids.length > 0) throw new LifecycleGateError("cancellation_tree_not_clean");
      const processTreeFacts = { contract: "sqlite-candidate-cancelled-worker-tree-v1", operation_id: operationId,
        task_id: taskId, attempt, generation: Number(operation.generation), claim_id: fence.claim_id, cancel_id: cancelId,
        worker_identity_digest: fence.claim_worker_identity_digest, root_process_id: processIdentity.pid,
        root_start_fingerprint: processIdentity.fingerprint, identity_state: identityVerdict.state,
        termination_state: terminationState, worker_exit_code: workerExitCode, scan_clean: true,
        live_pids: [], observed_pids: [...scan.observedPids].sort((a, b) => a - b) };
      const treeEvidence = { source: "manager_process_tree_verification", outcome: "verified", operation_id: operationId,
        task_id: taskId, attempt, generation: Number(operation.generation), cancel_id: cancelId, claim_id: fence.claim_id,
        worker_identity_digest: fence.claim_worker_identity_digest, root_process_id: processIdentity.pid,
        root_start_fingerprint: processIdentity.fingerprint, worker_tree_complete: true, scan_clean: true,
        live_pids: [], termination_state: terminationState, process_tree_digest: sha256(canonicalJson(processTreeFacts)) };
      const current = asRecord(port.readOperation(operationId));
      const verification = asRecord(port.recordCancellationVerification({ ...fence, revision: Number(current.revision) }, treeEvidence));
      if (verification.result_won === true) return verification;
      const verificationDigest = text(verification.cancellation_verification_digest, "cancellation_verification_missing");
      cancellationProofs.set(operationId, { input: active.input, child: active.child, cancelId, verificationDigest,
        identityState: identityVerdict.state, terminationState, processTreeDigest: String(treeEvidence.process_tree_digest),
        livePids: [], observedPids: [...scan.observedPids], workerExitCode });
      return { ...verification, result_won: false, cancellation_verification_digest: verificationDigest };
    },
    async completeRunningCancellation(taskId, attempt) {
      const proofEntry = [...cancellationProofs.entries()].find(([, value]) => value.input.task.task_id === taskId && value.input.attempt === attempt);
      const operationId = proofEntry?.[0];
      const proof = proofEntry?.[1];
      if (!operationId || !proof) throw new LifecycleGateError("cancellation_verification_missing");
      let operation = asRecord(port.readOperation(operationId));
      if (operation.result_digest === null && operation.phase === "running") {
        const result: CandidateTaskResult = { task_id: taskId, attempt, status: "cancelled",
          summary: "Cancelled by MCP request after verified Worker process-tree cleanup", files_changed: [], tests: [], issues: [],
          needs_master_decision: false, zcode_output: "", exit_code: null, session_id: null, started_at: null,
          finished_at: new Date().toISOString(), error_code: "cancelled" };
        const committed = asRecord(port.commitResult({ operation_id: operationId, task_id: taskId, attempt,
          generation: Number(operation.generation), revision: Number(operation.revision), claim_id: String(operation.claim_id),
          claim_worker_identity_digest: String(operation.claim_worker_identity_digest), result_status: "cancelled", result,
          cancel_verification_digest: proof.verificationDigest }));
        if (committed.cancellation_lost_to_result === true) return { cancelled: false, result_won: true, phase: committed.phase };
        if (committed.conflict === true || committed.quarantined === true) throw new LifecycleGateError("cancellation_result_conflict");
        operation = asRecord(port.readOperation(operationId));
      }
      if (operation.result_status !== "cancelled") return { cancelled: false, result_won: true, phase: operation.phase, result_status: operation.result_status };
      if (operation.phase === "released") { cancellationProofs.delete(operationId); return { cancelled: true, phase: "released" }; }
      if (operation.phase !== "result_committed" && operation.phase !== "cleanup_pending") throw new LifecycleGateError("cancellation_cleanup_phase_unknown");
      const claimId = text(operation.claim_id, "cancellation_claim_missing");
      const claimDigest = text(operation.claim_worker_identity_digest, "cancellation_worker_digest_missing");
      const cleanupBase = { operation_id: operationId, task_id: taskId, attempt, generation: Number(operation.generation),
        revision: Number(operation.revision), claim_id: claimId, claim_worker_identity_digest: claimDigest };
      const pending = asRecord(port.beginCleanup(cleanupBase));
      if (pending.phase !== "cleanup_pending") throw new LifecycleGateError("cancellation_cleanup_pending_missing");
      const cleanupFence = { ...cleanupBase, revision: Number(pending.revision) };
      const streams = proof.child.stdio as ReadonlyArray<{ destroyed?: boolean; closed?: boolean } | null>;
      const workerStdioClosed = streams.every((stream) => stream === null || stream.destroyed === true || stream.closed === true);
      const worker = parseEvidence(String(operation.claim_worker_identity_json), "cancellation_worker_identity_invalid");
      const resourceFacts = { contract: "sqlite-candidate-cancelled-worker-resources-v1",
        adapter: options.testOnlyFakeAdapter ? "explicit_test_fake" : "zcode_app_server",
        workspace_touched: false, worker_stdio_closed: workerStdioClosed, interaction_channels_closed: workerStdioClosed };
      if (!workerStdioClosed) {
        const failed = asRecord(port.recordCleanupEvidence({ ...cleanupFence, outcome: "unverified", probe_state: "incomplete", reason: "worker_stdio_not_closed" }));
        cancellationProofs.delete(operationId);
        return { cancelled: true, phase: failed.phase, cleanup_verified: false };
      }
      const cleanupEvidence = { source: "manager_os_cleanup_verification", fixture: false, operation_id: operationId,
        task_id: taskId, attempt, generation: Number(operation.generation), claim_id: claimId, worker_identity_digest: claimDigest,
        launch_receipt_digest: text(operation.launch_receipt_digest, "cancellation_receipt_digest_missing"),
        result_commit_ref: text(operation.result_commit_ref, "cancellation_result_ref_missing"),
        process_tree_digest: proof.processTreeDigest, resources_digest: sha256(canonicalJson(resourceFacts)),
        root_process_id: Number(worker.process_id), root_start_fingerprint: String(worker.start_fingerprint),
        worker_tree_complete: true, operation_resources_complete: true, workspace_touched: false };
      const recorded = asRecord(port.recordCleanupEvidence({ ...cleanupFence, outcome: "verified", cleanup_evidence: cleanupEvidence }));
      if (recorded.cleanup_verified !== true || recorded.phase !== "cleanup_verified") throw new LifecycleGateError("cancellation_cleanup_evidence_not_persisted");
      const released = asRecord(port.releaseCapacity({ ...cleanupFence, revision: Number(recorded.revision),
        cleanup_digest: text(recorded.cleanup_digest, "cancellation_cleanup_digest_missing") }));
      if (released.phase !== "released" || released.capacity_released !== true) throw new LifecycleGateError("cancellation_release_not_persisted");
      cancellationProofs.delete(operationId);
      return { cancelled: true, phase: "released", cleanup_verified: true };
    },
    readInteractionRequest: (taskId, requestId) => port.readInteractionRequest(taskId, requestId),
    openInteractionChannel: (child, operation, verifyProcessIdentity) => port.openInteractionChannel(child, operation, verifyProcessIdentity),
    receiveInteractionRequest: (channel) => port.receiveInteractionRequest(channel),
    async replyToInteractionRequest(input) {
      const value = asRecord(input);
      const key = interactionKey(String(value.task_id), String(value.request_id));
      const channel = interactionChannels.get(key);
      if (!channel) throw new LifecycleGateError("interaction_channel_unavailable", "no live Worker channel is bound to this SQLite interaction request");
      const result = await port.replyToInteractionRequest(input, channel);
      interactionChannels.delete(key);
      return result;
    },
    close: () => raw.close(),
    async run(input) {
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
        throw new LifecycleGateError("attempt_invalid");
      }
      let child: ClaimOnlyWorkerProcess | undefined;
      let operation: unknown = null;
      let task: unknown = null;
      let attempt: unknown = null;
      let state: ClaimOnlyRunResult["state"] = "launch_outcome_unknown";
      let reason = "launch_outcome_unknown";
      let workerExitCode: number | null = null;
      let spawnCount = 0;
      let committedResult: CandidateTaskResult | undefined;
      let resultStatus: CandidateResultCommitOutcome["result_status"];
      let resultDigest: string | undefined;
      let cleanupState: ClaimOnlyRunResult["cleanupState"] = "not_attempted";
      let stopBoundary: ClaimOnlyRunResult["stopBoundary"] = "claim_only";
      const stage = (name: string, detail?: Readonly<Record<string, unknown>>): void =>
        options.onStage?.(name, { operation_id: input.operationId, ...detail });
      try {
        stage("admission_start");
        let admission: Record<string, unknown>;
        const existingOperation = port.readOperation(input.operationId);
        if (existingOperation) {
          admission = readSafeReservedAdmission(port, input, asRecord(existingOperation));
          stage("reserved_operation_resumed", { revision: admission.revision, generation: admission.generation });
        } else {
          admission = asRecord(port.admitOperation({
            operation_id: input.operationId,
            task_id: input.task.task_id,
            attempt: input.attempt,
            workspace_ref: input.task.workspace,
          }, {
            workspaceValidator: localPolicy.validateWorkspace,
            executionPermissionCheck: localPolicy.checkPermission,
          }));
        }
        stage("admission_complete", { operation_id: input.operationId });
        const generation = positive(admission.generation, "admission_generation_missing");
        const revision = positive(admission.revision, "admission_revision_missing");
        stage("reserved_snapshot_read_start");
        const admissionOperation = asRecord(port.readOperation(input.operationId));
        let safeReserved: Readonly<{ generation: number; revision: number }>;
        let policySnapshot: AdmissionPolicySnapshot;
        try {
          safeReserved = readSafeReservedAdmission(port, input, admissionOperation);
          if (Number(safeReserved.generation) !== generation || Number(safeReserved.revision) !== revision) {
            throw new LifecycleGateError("stale_reserved_operation_snapshot");
          }
          policySnapshot = readPersistedAdmissionPolicySnapshot(port, input, admissionOperation, generation, revision);
        } catch (error) {
          stage("reserved_snapshot_check_failed", {
            reason: errorCode(error) ?? "reserved_snapshot_invalid",
            detail: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        stage("reserved_snapshot_read_complete", { policy_snapshot_digest: policySnapshot.policy_snapshot_digest });
        const launchRequest: LaunchRequest = {
          operation_id: input.operationId,
          task_id: input.task.task_id,
          attempt: input.attempt,
          generation,
          revision,
          launch_id: input.launchId,
          launch_epoch: 1,
          launch_token: input.launchToken,
        };
        stage("intent_start");
        const intent = asRecord(port.createLaunchIntent(launchRequest));
        if (intent.duplicate === true) throw new LifecycleGateError("launch_outcome_unknown", "existing Intent never authorizes another Spawn");
        const intentRevision = positive(intent.revision, "launch_intent_revision_missing");
        stage("intent_complete", { revision: intentRevision });
        const usePolicy = localPolicy.validateWorkspaceForUse(input.task.workspace);
        if (usePolicy.state !== "allow") {
          state = "launch_outcome_unknown";
          reason = usePolicy.reason;
          throw new LifecycleGateError("trusted_local_workspace_use_denied", usePolicy.reason);
        }
        stage("spawn_bootstrap_start");
        const launch = await spawnAndBootstrapOnce(() => {
          spawnCount += 1;
          child = spawnClaimOnlyWorker(options.workerEntryPath, provenance, {
            ...(options.enableSyntheticInteractionChannel || !options.testOnlyFakeAdapter ? { interactionChannel: true } : {}),
          });
          options.onChildSpawn?.(child);
          return child as PrivateBootstrapChild;
        }, {
          operation_id: launchRequest.operation_id,
          task_id: launchRequest.task_id,
          attempt: launchRequest.attempt,
          generation: launchRequest.generation,
          launch_id: launchRequest.launch_id,
          launch_epoch: launchRequest.launch_epoch,
          launch_token: launchRequest.launch_token,
          policy_snapshot: policySnapshot,
        });
        stage("spawn_bootstrap_complete", { state: launch.state, pid: child?.pid ?? null });
        if (launch.state !== "bootstrap_sent" || !child) {
          state = "launch_outcome_unknown";
          reason = launch.state === "launch_outcome_unknown" ? launch.reason : "bootstrap_failed";
          await rejectChild(child);
          throw new LifecycleGateError(reason);
        }

        stage("receipt_identity_start", { pid: child.pid ?? null });
        const launchIdentity = await observeTrustedLaunchIdentity(child, probe, input.launchId, generation);
        if (!launchIdentity) {
          state = "launch_outcome_unknown";
          reason = "launch_identity_unverified";
          await rejectChild(child);
          throw new LifecycleGateError(reason);
        }
        const receipt = asRecord(port.recordLaunchReceipt({
          ...launchRequest,
          revision: intentRevision,
          receipt_id: randomUUID(),
          launch_identity: launchIdentity,
        }));
        const receiptRevision = positive(receipt.revision, "launch_receipt_revision_missing");
        stage("receipt_complete", { revision: receiptRevision });
        const persisted = asRecord(port.readOperation(input.operationId));
        verifyPersistedLaunchEvidence(port, input, persisted, policySnapshot, launchRequest, intentRevision, receiptRevision);
        stage("preflight_complete", { revision: receiptRevision });
        stage("worker_report_read_start", { pid: child.pid ?? null });
        const report = await readJsonLine(child.reportChannel, 8_192, 15_000) as WorkerReportedIdentity;
        stage("worker_report_read_complete", {
          worker_id: report.worker_id,
          pid: report.process_id,
          policy_snapshot_digest: report.policy_snapshot_digest,
          workspace_ref: report.workspace_ref,
          policy_revision: report.policy_revision,
          policy_digest: report.policy_digest,
          execution_profile_id: report.execution_profile_id,
          provenance_digest: report.provenance_digest,
        });
        const claimId = randomUUID();
        const claim = await verifyHandshakeAndCommitClaim(port as Parameters<typeof verifyHandshakeAndCommitClaim>[0], {
          operation_id: input.operationId,
          task_id: input.task.task_id,
          attempt: input.attempt,
          generation,
          revision: receiptRevision,
          phase: String(persisted.phase),
          launch_id: String(persisted.launch_id),
          launch_epoch: Number(persisted.launch_epoch),
          launch_receipt_id: String(persisted.launch_receipt_id),
          launch_receipt_digest: String(persisted.launch_receipt_digest),
          launch_identity_json: String(persisted.launch_identity_json),
          claim_id: persisted.claim_id === null ? null : String(persisted.claim_id),
          claim_worker_identity_json: persisted.claim_worker_identity_json === null ? null : String(persisted.claim_worker_identity_json),
        }, report, input.launchToken, claimId, probe, policySnapshot, digestProvenance(provenance), (name) => stage(name));
        if (claim.state !== "claim_committed") {
          state = "claim_rejected";
          reason = claim.reason;
          await sendDecision(child, "claim_rejected");
          stage("claim_rejected_decision_sent", { reason });
          workerExitCode = await waitForClose(child, 15_000);
          stage("worker_close", { pid: child.pid ?? null, exitCode: workerExitCode });
        } else {
          state = "result_outcome_unknown";
          reason = "result_not_committed";
          stopBoundary = "result";
          stage("claim_committed", { claim_id: claimId });
          activeWorkers.set(input.operationId, { child, input });
          // Task and execution configuration are sent only after the durable
          // Claim. Production always selects the real ZCode Adapter. The fake
          // path requires this internal test-only capability and is never
          // selected by the Host's normal configuration.
          await sendDecision(child, "claim_committed", {
            protocol: "bridge-sqlite-execution-envelope-v1",
            operation_id: input.operationId,
            task_id: input.task.task_id,
            attempt: input.attempt,
            generation,
            workspace_ref: policySnapshot.workspace_ref,
            policy_snapshot_digest: policySnapshot.policy_snapshot_digest,
            execution_profile_id: policySnapshot.execution_profile_id,
            adapter_mode: options.testOnlyFakeAdapter ? "test_fake" : "zcode_app_server",
            task: input.task,
            host_profile: workerHostProfile,
            continuation: input.continuation ?? null,
            previous_result: input.previousResult ?? null,
          });
          stage("claim_continue_sent", { claim_id: claimId });

          let interactionPump: Promise<void> | undefined;
          if (options.enableSyntheticInteractionChannel || !options.testOnlyFakeAdapter) {
            const claimedOperation = asRecord(port.readOperation(input.operationId));
            const channel = await port.openInteractionChannel(child, claimedOperation, async ({ child: observedChild, expected }) => {
              if (observedChild.pid !== expected.process_id || observedChild.exitCode !== null || observedChild.signalCode !== null) return false;
              const workerIdentity = parseEvidence(String(claimedOperation.claim_worker_identity_json), "interaction_worker_identity_invalid");
              if (workerIdentity.identity_version !== PROCESS_IDENTITY_VERSION || workerIdentity.platform !== probe.platform
                || workerIdentity.fingerprint_precision !== "exact") return false;
              const probeOutcome = await probeWithDeadline(probe, {
                pid: Number(expected.process_id),
                identity: {
                  pid: Number(expected.process_id),
                  fingerprint: String(expected.start_fingerprint),
                  fingerprint_precision: "exact",
                  identity_version: PROCESS_IDENTITY_VERSION,
                  platform: probe.platform,
                  captured_at: String(workerIdentity.captured_at),
                },
              }, processProbeTimeoutMs);
              return probeOutcome.status === "resolved" && probeOutcome.verdict?.state === "alive"
                ? { state: "verified", process_id: expected.process_id, start_fingerprint: expected.start_fingerprint }
                : false;
            });
            stage("interaction_channel_bound", { pid: child.pid, claim_id: claimId });
            interactionPump = (async () => {
              while (child!.exitCode === null && child!.signalCode === null) {
                const persistedRequest = await port.receiveInteractionRequest(channel);
                const request = asRecord(persistedRequest.request);
                interactionChannels.set(interactionKey(input.task.task_id, String(request.request_id)), channel);
                stage("interaction_request_persisted", {
                  request_id: request.request_id,
                  revision: persistedRequest.revision,
                  event_sequence: persistedRequest.event_sequence,
                });
              }
            })().catch((error: unknown) => {
              stage("interaction_channel_closed", { reason: errorCode(error) ?? "interaction_channel_unavailable" });
            });
          }

          let rawResult: unknown;
          try {
            stage("worker_result_frame_read_start");
            const resultWaitMs = Math.min(60 * 60_000, input.task.timeout_ms ?? 60 * 60_000) + 30_000;
            rawResult = await readJsonLine(child.resultChannel, 16 * 1024 * 1024, resultWaitMs);
            stage("worker_result_frame_read_complete");
          } catch (error) {
            state = "result_rejected";
            reason = error instanceof Error ? error.message : "worker_result_unavailable";
            stage("worker_result_unavailable", { reason });
          }

          workerExitCode = await waitForClose(child, 15_000);
          await interactionPump;
          stage("worker_close", { pid: child.pid ?? null, exitCode: workerExitCode });

          if (state !== "result_rejected") {
            if (workerExitCode !== 0) {
              state = "result_rejected";
              reason = "worker_result_exit_unverified";
              stage("worker_result_rejected", { reason, workerExitCode });
            } else {
              try {
                const resultFrame = validateWorkerResultFrame(rawResult, {
                  operation_id: input.operationId,
                  task_id: input.task.task_id,
                  attempt: input.attempt,
                  generation,
                  workspace_ref: policySnapshot.workspace_ref,
                  policy_snapshot_digest: policySnapshot.policy_snapshot_digest,
                });
                if (!options.testOnlyFakeAdapter && resultFrame.execution_cleanup?.source === "explicit_test_fake") {
                  throw new LifecycleGateError("test_adapter_frame_forbidden");
                }
                const executionCleanup = trustedExecutionCleanupProof(
                  resultFrame.execution_cleanup,
                  options.testOnlyFakeAdapter === true,
                );
                stage("worker_result_verified", { status: resultFrame.result.status });
                const current = asRecord(port.readOperation(input.operationId));
                verifyPersistedClaimEvidence(port, current, input, generation, claimId);
                const revision = positive(current.revision, "result_revision_missing");
                const identityDigest = text(current.claim_worker_identity_digest, "result_claim_identity_missing");
                const commitInput: CandidateResultCommitInput = {
                  operation_id: input.operationId,
                  task_id: input.task.task_id,
                  attempt: input.attempt,
                  generation,
                  revision,
                  claim_id: claimId,
                  claim_worker_identity_digest: identityDigest,
                  result_status: resultFrame.result.status,
                  result: resultFrame.result,
                };
                stage("result_commit_start", { revision, status: resultFrame.result.status });
                let commit: CandidateResultCommitOutcome;
                try {
                  commit = port.commitResult(commitInput);
                } catch (error) {
                  const code = errorCode(error);
                  state = code === "transaction_outcome_unknown" ? "result_outcome_unknown" : "result_rejected";
                  reason = code ?? "result_commit_failed";
                  stage("result_commit_failed", { reason, unknown: state === "result_outcome_unknown" });
                  throw new LifecycleGateError("result_commit_terminal", reason);
                }
                stage("result_commit_ack", {
                  duplicate: commit.duplicate,
                  conflict: commit.conflict,
                  phase: commit.phase,
                  revision: commit.revision,
                  result_digest: commit.result_digest,
                });
                if (commit.conflict || commit.quarantined) {
                  state = "result_conflict";
                  reason = "conflicting_result_quarantined";
                  stage("result_conflict", { revision: commit.revision });
                } else {
                  try {
                    const persistedResult = port.readCommittedResult(input.operationId);
                    const currentAfter = asRecord(port.readOperation(input.operationId));
                    verifyPersistedResult(port, currentAfter, persistedResult, commitInput, commit);
                    committedResult = resultFrame.result;
                    resultStatus = resultFrame.result.status;
                    resultDigest = text(commit.result_digest, "result_digest_missing");
                    state = "result_committed";
                    reason = "result_committed";
                    stage("result_projection_verified", { revision: commit.revision, status: resultStatus, result_digest: resultDigest });
                    cleanupState = await finalizeClaimedWorkerCleanup(port, input, generation, claimId, probe, processProbeTimeoutMs, workerExitCode,
                      executionCleanup, executionCleanup ? "adapter_verified" : "adapter_unverified",
                      (name, detail) => stage(name, detail));
                    stage("cleanup_complete", { cleanup_state: cleanupState });
                  } catch (error) {
                    if (state === "result_committed") {
                      cleanupState = "unknown";
                      reason = errorCode(error) ?? "cleanup_outcome_unknown";
                      stage("cleanup_outcome_unknown", { reason });
                    } else {
                      state = "result_outcome_unknown";
                      reason = errorCode(error) ?? "result_projection_verification_failed";
                      stage("result_projection_unknown", { reason });
                    }
                  }
                }
              } catch (error) {
                if (error instanceof LifecycleGateError && error.code === "result_commit_terminal") {
                  // The Store or commit verifier supplied the terminal result
                  // state above. Do not retry an Adapter or Result write.
                } else {
                  state = "result_rejected";
                  reason = errorCode(error) ?? "worker_result_invalid";
                  stage("worker_result_rejected", { reason });
                }
              }
            }
          }
        }
      } catch (error) {
        if (state === "launch_outcome_unknown") reason = error instanceof LifecycleGateError ? error.code : "claim_only_lifecycle_failed";
        else if (state === "result_outcome_unknown") reason = errorCode(error) ?? reason;
        else reason = errorCode(error) ?? reason;
        if (child && workerExitCode === null) {
          try { await rejectChild(child); workerExitCode = await waitForClose(child, 5_000); } catch { /* remain unknown and retain the claim/intent */ }
        }
      } finally {
        const active = activeWorkers.get(input.operationId);
        if (active?.child === child) activeWorkers.delete(input.operationId);
        try {
          operation = port.readOperation(input.operationId);
          task = port.readTaskProjection(input.task.task_id);
          attempt = port.readAttempt(input.task.task_id, input.attempt);
        } catch (error) {
          stage("final_projection_unavailable", { reason: errorCode(error) ?? "projection_unavailable" });
          if (state !== "claim_rejected" && state !== "launch_outcome_unknown") {
            state = "result_outcome_unknown";
            reason = errorCode(error) ?? "final_projection_unavailable";
          }
        }
      }
      stage("run_complete", { state, reason, workerExitCode, spawnCount, result_status: resultStatus, result_digest: resultDigest });
      return { state, ...(state === "result_committed" ? {} : { reason }), operation, task, attempt, workerExitCode, spawnCount,
        ...(committedResult ? { result: committedResult } : {}), ...(resultStatus ? { resultStatus } : {}), ...(resultDigest ? { resultDigest } : {}), cleanupState, stopBoundary };
    },
  };
}

/**
 * Candidate-only cleanup proof. This Worker runs only the controlled synthetic
 * adapter and never creates OS descendants or touches the Workspace. We still
 * require the Manager's fresh PID/fingerprint probe to prove the Worker exited;
 * any unknown/alive result is persisted as unverified and retains Capacity.
 */
async function finalizeClaimedWorkerCleanup(
  port: ClaimOnlyPort,
  input: ClaimOnlyRunInput,
  generation: number,
  claimId: string,
  probe: ProcessProbe,
  probeTimeoutMs: number,
  workerExitCode: number | null,
  executionCleanup: CandidateExecutionCleanupProof | null,
  adapterCleanupState: "adapter_verified" | "adapter_unverified",
  stage: (name: string, detail?: Readonly<Record<string, unknown>>) => void,
): Promise<ClaimOnlyRunResult["cleanupState"]> {
  stage("cleanup_prepare_start");
  const current = asRecord(port.readOperation(input.operationId));
  const claimIdentity = parseEvidence(current.claim_worker_identity_json, "cleanup_worker_identity_missing");
  const launchIdentity = parseEvidence(current.launch_identity_json, "cleanup_launch_identity_missing");
  const claimIdentityDigest = text(current.claim_worker_identity_digest, "cleanup_claim_identity_digest_missing");
  const rootProcessId = positive(claimIdentity.process_id, "cleanup_worker_pid_invalid");
  const rootFingerprint = text(claimIdentity.start_fingerprint, "cleanup_worker_fingerprint_invalid");
  if (claimIdentity.identity_version !== PROCESS_IDENTITY_VERSION) throw new LifecycleGateError("cleanup_identity_version_invalid");
  if (claimIdentity.source !== "manager_verified_process_probe" || launchIdentity.source !== "manager_os_spawn_observation"
    || launchIdentity.process_id !== rootProcessId || launchIdentity.start_fingerprint !== rootFingerprint
    || claimIdentity.platform !== "win32" || launchIdentity.platform !== "win32"
    || claimIdentity.fingerprint_precision !== "exact" || launchIdentity.fingerprint_precision !== "exact"
    || probe.platform !== "win32") {
    throw new LifecycleGateError("cleanup_identity_mismatch");
  }
  const fence: CandidateCleanupFence = {
    operation_id: input.operationId,
    task_id: input.task.task_id,
    attempt: input.attempt,
    generation,
    revision: positive(current.revision, "cleanup_result_revision_missing"),
    claim_id: claimId,
    claim_worker_identity_digest: claimIdentityDigest,
  };
  const pending = asRecord(port.beginCleanup(fence));
  if (pending.phase !== "cleanup_pending" || pending.operation_id !== input.operationId
    || pending.generation !== generation) throw new LifecycleGateError("cleanup_pending_projection_mismatch");
  stage("cleanup_pending_persisted", { revision: pending.revision });
  const cleanupFence = { ...fence, revision: positive(pending.revision, "cleanup_pending_revision_missing") };

  let probeState: "alive" | "unknown" | "identity_mismatch" | "incomplete" = "unknown";
  let cleanupEvidence: Readonly<Record<string, unknown>> | undefined;
  if (workerExitCode === 0 && executionCleanup) {
    try {
      stage("cleanup_identity_probe_start", { pid: rootProcessId });
      const probeOutcome = await probeWithDeadline(probe, {
        pid: rootProcessId,
        identity: {
          pid: rootProcessId,
          fingerprint: rootFingerprint,
          fingerprint_precision: "exact",
          identity_version: PROCESS_IDENTITY_VERSION,
          platform: "win32",
          captured_at: String(claimIdentity.captured_at),
        },
      }, probeTimeoutMs);
      const verdict = probeOutcome.status === "resolved" ? probeOutcome.verdict : undefined;
      stage(probeOutcome.status === "timeout" ? "cleanup_identity_probe_timeout"
        : probeOutcome.status === "rejected" ? "cleanup_identity_probe_failed" : "cleanup_identity_probe_complete",
      { state: verdict?.state ?? "unknown", reason: verdict?.reason_code ?? probeOutcome.status });
      if (verdict?.state === "exited") {
        const launchReceiptDigest = text(current.launch_receipt_digest, "cleanup_launch_receipt_digest_missing");
        const resultCommitRef = text(current.result_commit_ref, "cleanup_result_commit_ref_missing");
        const processTreeFacts = {
          contract: executionCleanup.source === "zcode_app_server_adapter"
            ? "real-zcode-claimed-worker-process-tree-v1"
            : "synthetic-claim-worker-process-tree-v1",
          process_id: rootProcessId,
          start_fingerprint: rootFingerprint,
          worker_exit_code: workerExitCode,
          probe_state: verdict.state,
          descendants: [],
          execution_cleanup_proof_digest: sha256(canonicalJson(executionCleanup)),
        };
        const resourceFacts = {
          contract: executionCleanup.source === "zcode_app_server_adapter"
            ? "real-zcode-adapter-resources-v1"
            : "synthetic-claimed-worker-resources-v1",
          adapter_cleanup_state: adapterCleanupState,
          execution_cleanup_source: executionCleanup.source,
          execution_cleanup_method: executionCleanup.method,
          worker_stdio_closed: true,
          interaction_channels: false,
          cleanup_scope: "worker_and_adapter_descendant_resources",
          managed_browser_cleanup_verified: executionCleanup.managed_browser_cleanup_verified,
          workspace_retained: executionCleanup.workspace_retained,
        };
        cleanupEvidence = {
          source: "manager_os_cleanup_verification",
          fixture: false,
          operation_id: input.operationId,
          task_id: input.task.task_id,
          attempt: input.attempt,
          generation,
          claim_id: claimId,
          worker_identity_digest: claimIdentityDigest,
          launch_receipt_digest: launchReceiptDigest,
          result_commit_ref: resultCommitRef,
          process_tree_digest: sha256(canonicalJson(processTreeFacts)),
          resources_digest: sha256(canonicalJson(resourceFacts)),
          root_process_id: rootProcessId,
          root_start_fingerprint: rootFingerprint,
          worker_tree_complete: true,
          operation_resources_complete: true,
          workspace_touched: false,
        };
      } else {
        probeState = verdict?.state === "alive" ? "alive" : "unknown";
      }
    } catch {
      probeState = "unknown";
      stage("cleanup_identity_probe_failed");
    }
  } else {
    probeState = workerExitCode === null ? "unknown" : "incomplete";
  }

  if (!cleanupEvidence) {
    port.recordCleanupEvidence({
      ...cleanupFence,
      outcome: "unverified",
      probe_state: probeState,
      reason: !executionCleanup ? "adapter_cleanup_unverified"
        : workerExitCode === 0 ? "worker_exit_identity_not_proven" : "worker_exit_not_verified",
    });
    return "unverified";
  }
  const recorded = asRecord(port.recordCleanupEvidence({
    ...cleanupFence,
    outcome: "verified",
    cleanup_evidence: cleanupEvidence,
  }));
  if (recorded.cleanup_verified !== true || recorded.phase !== "cleanup_verified") {
    throw new LifecycleGateError("cleanup_evidence_not_persisted");
  }
  const cleanupDigest = text(recorded.cleanup_digest, "cleanup_digest_missing");
  const released = asRecord(port.releaseCapacity({
    ...cleanupFence,
    revision: positive(recorded.revision, "cleanup_verified_revision_missing"),
    cleanup_digest: cleanupDigest,
  }));
  if (released.phase !== "released" || released.capacity_released !== true) {
    throw new LifecycleGateError("capacity_release_not_persisted");
  }
  const finalOperation = asRecord(port.readOperation(input.operationId));
  if (finalOperation.phase !== "released" || finalOperation.generation !== generation
    || finalOperation.claim_id !== claimId || finalOperation.claim_worker_identity_digest !== claimIdentityDigest) {
    throw new LifecycleGateError("released_operation_projection_mismatch");
  }
  return "released";
}

async function rejectChild(child: ClaimOnlyWorkerProcess | undefined): Promise<void> {
  if (!child) return;
  try { await sendDecision(child, "claim_rejected"); } catch { /* closing the pipe is a closed rejection */ }
}

async function sendDecision(
  child: ClaimOnlyWorkerProcess,
  state: "claim_committed" | "claim_rejected",
  execution?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const channel = child.decisionChannel;
  if (!channel) throw new LifecycleGateError("private_decision_channel_unavailable");
  if ((state === "claim_committed") !== (execution !== undefined)) throw new LifecycleGateError("private_execution_envelope_required");
  const frame = Buffer.from(`${JSON.stringify({ protocol: "bridge-claim-decision-v1", state, ...(execution ? { execution } : {}) })}\n`, "utf8");
  if (frame.byteLength > 1_100_000) throw new LifecycleGateError("private_execution_envelope_too_large");
  await new Promise<void>((resolve, reject) => {
    channel.once("error", reject);
    channel.once("finish", resolve);
    channel.end(frame);
  });
}

async function readJsonLine(stream: Readable | null, limit: number, timeoutMs: number): Promise<unknown> {
  if (!stream) throw new LifecycleGateError("private_report_channel_unavailable");
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const fail = (error: Error): void => { cleanup(); reject(error); };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) return fail(new LifecycleGateError("private_report_too_large"));
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      try {
        const bytes = Buffer.concat(chunks, size);
        if (!bytes.length || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) throw new Error("invalid worker report frame");
        const value: unknown = JSON.parse(bytes.subarray(0, -1).toString("utf8"));
        cleanup();
        resolve(value);
      } catch (error) { fail(error instanceof Error ? error : new Error("invalid worker report")); }
    };
    const onError = (error: Error): void => fail(error);
    const timer = setTimeout(() => fail(new LifecycleGateError("private_report_timeout")), timeoutMs);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

async function waitForClose(child: ClaimOnlyWorkerProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("close", onClose); reject(new LifecycleGateError("worker_stop_timeout")); }, timeoutMs);
    const onClose = (code: number | null): void => { clearTimeout(timer); resolve(code); };
    child.once("close", onClose);
  });
}

async function probeWithDeadline(
  probe: ProcessProbe,
  request: ProbeRequest,
  timeoutMs: number,
): Promise<BoundedProbeOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const pending = Promise.resolve().then(() => probe.probe([request])).then(
    (verdicts): BoundedProbeOutcome => ({ status: "resolved", verdict: verdicts[0] }),
    (): BoundedProbeOutcome => ({ status: "rejected" }),
  );
  const deadline = new Promise<BoundedProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processTreeWithDeadline(
  targets: readonly { readonly pid: number; readonly fingerprint: string }[],
  timeoutMs: number,
): Promise<BoundedTreeOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const pending = Promise.resolve().then(() => verifyProcessTreeClaimantsClean(targets)).then(
    (result): BoundedTreeOutcome => ({ status: "resolved", result }),
    (): BoundedTreeOutcome => ({ status: "rejected" }),
  );
  const deadline = new Promise<BoundedTreeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleGateError("candidate_projection_invalid");
  return value as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positive(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new LifecycleGateError(code);
  return Number(value);
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\x00-\x1f]/u.test(value)) {
    throw new LifecycleGateError(code);
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length <= 128 ? code : undefined;
}

function validateWorkerResultFrame(
  value: unknown,
  expected: Pick<AdmissionPolicySnapshot, "operation_id" | "task_id" | "attempt" | "generation" | "workspace_ref" | "policy_snapshot_digest">,
): CandidateWorkerResultFrame {
  const frame = asRecord(value);
  if (Object.keys(frame).sort().join("|") !== "attempt|execution_cleanup|execution_cleanup_verified|generation|operation_id|policy_snapshot_digest|protocol|result|task_id|workspace_ref"
    || frame.protocol !== "bridge-sqlite-candidate-result-v1"
    || frame.operation_id !== expected.operation_id || frame.task_id !== expected.task_id
    || frame.attempt !== expected.attempt || frame.generation !== expected.generation
    || frame.workspace_ref !== expected.workspace_ref || frame.policy_snapshot_digest !== expected.policy_snapshot_digest
    || typeof frame.execution_cleanup_verified !== "boolean") {
    throw new LifecycleGateError("worker_result_coordinates_mismatch");
  }
  const executionCleanup = validateExecutionCleanupProof(frame.execution_cleanup);
  if (frame.execution_cleanup_verified !== (executionCleanup !== null)) {
    throw new LifecycleGateError("worker_cleanup_proof_inconsistent");
  }
  const result = asRecord(frame.result);
  if (result.task_id !== expected.task_id || result.attempt !== expected.attempt
    || !["completed", "failed", "cancelled", "waiting_for_master"].includes(String(result.status))) {
    throw new LifecycleGateError("worker_result_identity_or_status_invalid");
  }
  return frame as unknown as CandidateWorkerResultFrame;
}

function validateExecutionCleanupProof(value: unknown): CandidateExecutionCleanupProof | null {
  if (value === null) return null;
  const proof = asRecord(value);
  if (proof.contract !== "candidate-execution-cleanup-proof-v1" || proof.complete !== true
    || proof.workspace_retained !== true || proof.managed_browser_cleanup_verified !== true) {
    throw new LifecycleGateError("worker_cleanup_proof_invalid");
  }
  if (proof.source === "zcode_app_server_adapter") {
    if (Object.keys(proof).sort().join("|")
      !== "adapter_process_id|adapter_start_fingerprint|complete|contract|managed_browser_cleanup_verified|method|process_tree_member_count|process_tree_receipt_digest|source|workspace_retained"
      || proof.method !== "identity_bound_windows_tree_cleanup"
      || !Number.isSafeInteger(proof.adapter_process_id) || Number(proof.adapter_process_id) < 1
      || typeof proof.adapter_start_fingerprint !== "string" || proof.adapter_start_fingerprint.length === 0
      || typeof proof.process_tree_receipt_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(proof.process_tree_receipt_digest)
      || !Number.isSafeInteger(proof.process_tree_member_count) || Number(proof.process_tree_member_count) < 1) {
      throw new LifecycleGateError("worker_cleanup_proof_invalid");
    }
    return proof as unknown as CandidateExecutionCleanupProof;
  }
  if (proof.source === "explicit_test_fake") {
    if (Object.keys(proof).sort().join("|")
      !== "complete|contract|managed_browser_cleanup_verified|method|source|workspace_retained"
      || proof.method !== "synthetic_fixture") {
      throw new LifecycleGateError("worker_cleanup_proof_invalid");
    }
    return proof as unknown as CandidateExecutionCleanupProof;
  }
  throw new LifecycleGateError("worker_cleanup_proof_invalid");
}

function trustedExecutionCleanupProof(
  proof: CandidateExecutionCleanupProof | null,
  testOnlyFakeAdapter: boolean,
): CandidateExecutionCleanupProof | null {
  if (!proof) return null;
  if (testOnlyFakeAdapter) return proof.source === "explicit_test_fake" ? proof : null;
  return proof.source === "zcode_app_server_adapter"
    && proof.method === "identity_bound_windows_tree_cleanup"
    && proof.complete === true
    && proof.managed_browser_cleanup_verified === true
    && proof.workspace_retained === true
    ? proof
    : null;
}

function verifyPersistedClaimEvidence(
  port: ClaimOnlyPort,
  operation: Record<string, unknown>,
  input: ClaimOnlyRunInput,
  generation: number,
  claimId: string,
): void {
  if (operation.operation_id !== input.operationId || operation.task_id !== input.task.task_id
    || operation.attempt !== input.attempt || operation.generation !== generation || operation.phase !== "running"
    || operation.claim_id !== claimId || operation.claim_generation !== generation
    || !validSnapshotDigest(operation.claim_worker_identity_digest)) {
    throw new LifecycleGateError("persisted_claim_projection_mismatch");
  }
  const revision = positive(operation.revision, "persisted_claim_revision_invalid");
  const events = port.readLifecycleEvents(input.operationId);
  const latest = events.at(-1);
  const claims = events.filter((event) => event.event_type === "claim_committed");
  const claim = claims.length === 1 ? claims[0] : undefined;
  if (!latest || latest.sequence !== revision || !claim || claim.operation_id !== input.operationId
    || claim.generation !== generation || claim.from_phase !== "launch_intent" || claim.to_phase !== "running")
    throw new LifecycleGateError("persisted_claim_event_mismatch");
  const claimSequence = positive(claim.sequence, "persisted_claim_event_sequence_invalid");
  if (claimSequence > revision) throw new LifecycleGateError("persisted_claim_event_mismatch");
  const evidence = parseEvidence(claim.evidence_json, "persisted_claim_event_invalid");
  if (evidence.claim_id !== claimId || evidence.worker_identity_digest !== operation.claim_worker_identity_digest) {
    throw new LifecycleGateError("persisted_claim_binding_mismatch");
  }
}

function verifyPersistedResult(
  port: ClaimOnlyPort,
  operation: Record<string, unknown>,
  persisted: CandidateCommittedResult | null,
  input: CandidateResultCommitInput,
  commit: CandidateResultCommitOutcome,
): void {
  if (commit.conflict || !persisted || operation.operation_id !== input.operation_id
    || operation.task_id !== input.task_id || operation.attempt !== input.attempt
    || operation.generation !== input.generation || operation.phase !== "result_committed"
    || operation.claim_id !== input.claim_id || operation.claim_worker_identity_digest !== input.claim_worker_identity_digest
    || operation.revision !== commit.revision || persisted.revision !== commit.revision
    || persisted.operation_id !== input.operation_id || persisted.task_id !== input.task_id
    || persisted.attempt !== input.attempt || persisted.generation !== input.generation
    || persisted.claim_id !== input.claim_id || persisted.claim_worker_identity_digest !== input.claim_worker_identity_digest
    || persisted.result_generation !== input.generation || persisted.result_status !== input.result_status
    || persisted.result.status !== input.result_status || persisted.result_digest !== commit.result_digest
    || persisted.result_commit_ref !== commit.result_commit_ref) {
    throw new LifecycleGateError("result_projection_mismatch");
  }
  const events = port.readLifecycleEvents(input.operation_id);
  const resultEvent = events.at(-1);
  if (!resultEvent || resultEvent.event_type !== "result_committed" || resultEvent.operation_id !== input.operation_id
    || resultEvent.sequence !== commit.revision || resultEvent.generation !== input.generation
    || resultEvent.from_phase !== "running" || resultEvent.to_phase !== "result_committed") {
    throw new LifecycleGateError("result_event_mismatch");
  }
  const evidence = parseEvidence(resultEvent.evidence_json, "result_event_invalid");
  if (evidence.claim_id !== input.claim_id || evidence.worker_identity_digest !== input.claim_worker_identity_digest
    || evidence.outcome !== input.result_status || evidence.result_digest !== commit.result_digest
    || evidence.result_commit_ref !== commit.result_commit_ref) throw new LifecycleGateError("result_event_binding_mismatch");
  const cleanupEventTypes = new Set(["cleanup_pending", "cleanup_verified", "cleanup_unverified", "released"]);
  if (events.some((event) => typeof event.event_type === "string" && cleanupEventTypes.has(event.event_type))) {
    throw new LifecycleGateError("result_path_entered_cleanup");
  }
  const task = asRecord(port.readTaskProjection(input.task_id));
  const attempt = asRecord(port.readAttempt(input.task_id, input.attempt));
  if (task.status !== input.result_status || task.current_attempt !== input.attempt || attempt.status !== input.result_status) {
    throw new LifecycleGateError("result_task_attempt_projection_mismatch");
  }
}

function readSafeReservedAdmission(port: ClaimOnlyPort, input: ClaimOnlyRunInput, operation: Record<string, unknown>): Readonly<{ generation: number; revision: number }> {
  const generation = positive(Number(operation.generation), "reserved_generation_missing");
  const revision = positive(Number(operation.revision), "reserved_revision_missing");
  if (operation.operation_id !== input.operationId || operation.operation_kind !== "attempt_lifecycle"
    || operation.task_id !== input.task.task_id || Number(operation.attempt) !== input.attempt
    || operation.phase !== "reserved" || revision !== 1
    || operation.launch_id !== null || operation.launch_epoch !== null || operation.launch_token_digest !== null
    || operation.launch_intent_digest !== null || operation.launch_receipt_id !== null
    || operation.launch_receipt_digest !== null || operation.launch_identity_json !== null
    || operation.claim_id !== null || operation.claim_request_digest !== null
    || operation.claim_worker_identity_json !== null || operation.claim_worker_identity_digest !== null
    || operation.claim_launch_id !== null || operation.claim_generation !== null || operation.claim_token_digest !== null
    || operation.result_status !== null || operation.result_generation !== null || operation.result_digest !== null
    || operation.result_json !== null || operation.result_commit_ref !== null) {
    throw new LifecycleGateError("launch_outcome_unknown", "only an untouched reserved Operation can resume; existing launch evidence is never replayed");
  }
  const lifecycle = asRecord(port.readTaskLifecycle(input.task.task_id));
  const projection = asRecord(lifecycle.projection);
  const attempt = asRecord(lifecycle.attempt);
  if (canonicalJson(lifecycle.task) !== canonicalJson(input.task)
    || projection.status !== "queued" || Number(projection.current_attempt) !== input.attempt
    || attempt.status !== "queued" || Number(attempt.attempt) !== input.attempt
    || Number(attempt.generation) !== generation) {
    throw new LifecycleGateError("launch_outcome_unknown", "reserved Operation no longer matches the current queued Attempt");
  }
  const events = port.readLifecycleEvents(input.operationId, { afterSequence: 0, limit: 200 });
  const reservedEvent = events[0];
  if (events.length !== 1 || !reservedEvent || reservedEvent.operation_id !== input.operationId || Number(reservedEvent.sequence) !== 1
    || reservedEvent.event_type !== "reserved" || reservedEvent.from_phase !== null || reservedEvent.to_phase !== "reserved"
    || Number(reservedEvent.generation) !== generation || !Number.isSafeInteger(Number(reservedEvent.event_cursor))
    || Number(reservedEvent.event_cursor) < 1) {
    throw new LifecycleGateError("launch_outcome_unknown", "reserved Operation history is not an untouched admission");
  }
  let evidence: Record<string, unknown>;
  try { evidence = parseEvidence(reservedEvent.evidence_json, "reserved_event_evidence_invalid"); }
  catch { throw new LifecycleGateError("launch_outcome_unknown", "reserved Operation evidence is invalid"); }
  if (evidence.reservation_id !== operation.reservation_id || Number(evidence.capacity_slot) !== Number(operation.capacity_slot)) {
    throw new LifecycleGateError("launch_outcome_unknown", "reserved Operation evidence does not match its projection");
  }
  return { generation, revision };
}

function readPersistedAdmissionPolicySnapshot(
  port: ClaimOnlyPort,
  input: ClaimOnlyRunInput,
  operation: Record<string, unknown>,
  generation: number,
  revision: number,
): AdmissionPolicySnapshot {
  if (operation.operation_id !== input.operationId || operation.task_id !== input.task.task_id
    || operation.attempt !== input.attempt || operation.generation !== generation || operation.revision !== revision
    || operation.phase !== "reserved" || operation.workspace_ref !== input.task.workspace) {
    throw new LifecycleGateError("admission_projection_mismatch");
  }
  // readLifecycleEvents performs the Store's full consistency scan, including
  // the event-chain digest checks; do not rebuild the snapshot from live policy.
  const events = port.readLifecycleEvents(input.operationId);
  const reserved = events.find((event) => event.sequence === 1 && event.event_type === "reserved");
  if (!reserved || reserved.operation_id !== input.operationId || reserved.generation !== generation
    || reserved.from_phase !== null || reserved.to_phase !== "reserved") {
    throw new LifecycleGateError("reserved_event_invalid");
  }
  const evidence = parseEvidence(reserved.evidence_json, "reserved_event_invalid");
  if (typeof evidence.authorization_source !== "string" || evidence.authorization_source !== "trusted_local_policy"
    || !validSnapshotText(evidence.policy_revision) || !validSnapshotDigest(evidence.policy_digest)
    || !validSnapshotText(evidence.execution_profile_id)) {
    throw new LifecycleGateError("reserved_policy_evidence_missing");
  }
  const base = {
    operation_id: input.operationId,
    task_id: input.task.task_id,
    attempt: input.attempt,
    generation,
    workspace_ref: input.task.workspace,
    authorization_source: "trusted_local_policy" as const,
    policy_revision: evidence.policy_revision,
    policy_digest: evidence.policy_digest,
    execution_profile_id: evidence.execution_profile_id,
  };
  return { ...base, policy_snapshot_digest: deriveAdmissionPolicySnapshotDigest(base) };
}

function verifyPersistedLaunchEvidence(
  port: ClaimOnlyPort,
  input: ClaimOnlyRunInput,
  operation: Record<string, unknown>,
  snapshot: AdmissionPolicySnapshot,
  request: LaunchRequest,
  intentRevision: number,
  receiptRevision: number,
): void {
  if (operation.operation_id !== snapshot.operation_id || operation.task_id !== snapshot.task_id
    || operation.attempt !== snapshot.attempt || operation.generation !== snapshot.generation
    || operation.workspace_ref !== snapshot.workspace_ref || operation.revision !== receiptRevision
    || operation.phase !== "launch_intent" || operation.claim_id !== null
    || operation.launch_id !== request.launch_id || operation.launch_epoch !== request.launch_epoch
    || operation.launch_receipt_id === null || operation.launch_receipt_digest === null
    || operation.launch_token_digest !== sha256(request.launch_token)) {
    throw new LifecycleGateError("persisted_launch_preflight_mismatch");
  }
  const events = port.readLifecycleEvents(input.operationId);
  if (events.length !== 3) throw new LifecycleGateError("persisted_launch_event_count_mismatch");
  const [reserved, intent, receipt] = events;
  if (!reserved || !intent || !receipt || reserved.event_type !== "reserved" || reserved.sequence !== 1
    || intent.event_type !== "launch_intent" || intent.sequence !== intentRevision
    || receipt.event_type !== "launch_receipt" || receipt.sequence !== receiptRevision
    || [reserved, intent, receipt].some((event) => event.operation_id !== snapshot.operation_id
      || event.generation !== snapshot.generation)) throw new LifecycleGateError("persisted_launch_event_chain_mismatch");
  const intentEvidence = parseEvidence(intent.evidence_json, "persisted_launch_intent_invalid");
  const receiptEvidence = parseEvidence(receipt.evidence_json, "persisted_launch_receipt_invalid");
  if (intentEvidence.launch_id !== request.launch_id || intentEvidence.launch_epoch !== request.launch_epoch
    || intentEvidence.token_digest !== sha256(request.launch_token)
    || receiptEvidence.launch_id !== request.launch_id || receiptEvidence.launch_epoch !== request.launch_epoch
    || receiptEvidence.token_digest !== sha256(request.launch_token)
    || receiptEvidence.receipt_digest !== operation.launch_receipt_digest) {
    throw new LifecycleGateError("persisted_launch_binding_mismatch");
  }
  const reservedEvidence = parseEvidence(reserved.evidence_json, "reserved_event_invalid");
  const persistedSnapshot = {
    operation_id: snapshot.operation_id,
    task_id: snapshot.task_id,
    attempt: snapshot.attempt,
    generation: snapshot.generation,
    workspace_ref: snapshot.workspace_ref,
    authorization_source: reservedEvidence.authorization_source,
    policy_revision: reservedEvidence.policy_revision,
    policy_digest: reservedEvidence.policy_digest,
    execution_profile_id: reservedEvidence.execution_profile_id,
  };
  if (deriveAdmissionPolicySnapshotDigest(persistedSnapshot as Omit<AdmissionPolicySnapshot, "policy_snapshot_digest">)
    !== snapshot.policy_snapshot_digest) throw new LifecycleGateError("persisted_policy_snapshot_mismatch");
}

function parseEvidence(value: unknown, errorCode: string): Record<string, unknown> {
  if (typeof value !== "string") throw new LifecycleGateError(errorCode);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch { throw new LifecycleGateError(errorCode); }
}

function validSnapshotText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/u.test(value);
}

function validSnapshotDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new LifecycleGateError("cleanup_evidence_not_canonicalizable");
}
function digestProvenance(value: RuntimeBuildProvenance): string {
  const canonical = JSON.stringify({
    bridge: { path: value.bridge.path, sha256: value.bridge.sha256 },
    worker: { path: value.worker.path, sha256: value.worker.sha256 },
  });
  return sha256(canonical);
}

function interactionKey(taskId: string, requestId: string): string {
  return `${taskId}\u0000${requestId}`;
}
