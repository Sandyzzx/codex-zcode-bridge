import { MAX_WORKER_RESULT_FRAME_BYTES, canonicalTaskResult, submissionFailure, assertWorkerResultEnvelope } from "../result-contract.mjs";
/**
 * SQLite lifecycle composition shared by production startup and isolated tests.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import { resolveTaskTimeout, resultWaitBudgetMs, WORKER_CLOSE_TIMEOUT_MS, EXECUTION_DELIVERY_TIMEOUT_MS } from "../runtime/task-timeout.js";
import type { Readable } from "node:stream";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe, type ProbeRequest, type ProbeVerdict } from "../runtime/process-probe.js";
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
import { servePrivateCredential } from "../runtime/start-plan-private-channel.js";
import type { PrivateCredentialLease, PrivateLeaseBinding } from "../runtime/start-plan-private-lease.js";
import { WorkerHandleGate } from "../runtime/start-plan-handle-gate.js";
import type { WindowsTreeTransactionLike } from "../adapters/windows-process-cleanup.js";

const DEFAULT_PROCESS_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PROCESS_TREE_PROBE_TIMEOUT_MS = 30_000;
// Share a verified process-tree stop across Managers using the same local
// SQLite Authority. Keep it until Release so an earlier alive probe cannot
// trigger a second signal from a competing Recovery.
const verifiedRecoveryStops = new Map<string, Promise<void>>();

function recoveryStopKey(dataRoot: string, databaseFileName: string | undefined, operationId: string): string {
  return `${path.resolve(dataRoot)}\0${databaseFileName ?? "operations.sqlite3"}\0${operationId}`;
}

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
  recordResultSubmissionFailure?(input: Readonly<Record<string, unknown>>, reason: string): unknown;
  readCommittedResult(operationId: string): CandidateCommittedResult | null;
  beginCleanup(input: CandidateCleanupFence): Readonly<Record<string, unknown>>;
  recordCleanupEvidence(input: CandidateCleanupFence & Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  reverifyCleanup(input: CandidateCleanupFence & { readonly cleanup_evidence: Readonly<Record<string, unknown>> }): Readonly<Record<string, unknown>>;
  releaseCapacity(input: CandidateCleanupFence & { readonly cleanup_digest: string }): Readonly<Record<string, unknown>>;
  readTaskLifecycle(taskId: string): unknown;
  readTaskAttention(taskId: string): Readonly<Record<string, unknown>> | null;
  readRecoverableQueuedAttempts(): readonly Readonly<Record<string, unknown>>[];
  readTaskEvents(taskId: string, options?: { readonly afterCursor?: number; readonly limit?: number }): LifecycleEventsPage;
  readTaskFeedback(taskId: string): unknown;
  readRecoverySnapshot(): unknown;
  recordRecoveryObservation(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): unknown;
  createNextAttempt(input: Readonly<Record<string, unknown>>, gates: {
    readonly workspaceValidator: (input: { readonly requestedPath: string; readonly canonicalPath: string }) => unknown;
    readonly executionPermissionCheck: (context: Parameters<TrustedLocalStdioContext["policy"]["checkPermission"]>[0]) => unknown;
  }): unknown;
  interruptAndRequeue(input: Readonly<Record<string, unknown>>, gates: {
    readonly workspaceValidator: (input: { readonly requestedPath: string; readonly canonicalPath: string }) => unknown;
    readonly executionPermissionCheck: (context: Parameters<TrustedLocalStdioContext["policy"]["checkPermission"]>[0]) => unknown;
  }): Readonly<Record<string, unknown>>;
  cancelQueuedAttempt(input: { readonly task_id: string; readonly expected_attempt: number }): unknown;
  requestCancellation(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  recordCancellationVerification(input: Readonly<Record<string, unknown>>, evidence: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  readInteractionRequest(taskId: string, requestId: string): Readonly<Record<string, unknown>> | null;
  replyToInteractionRequest(input: unknown): Promise<Readonly<Record<string, unknown>>>;
  openInteractionChannel(child: ClaimOnlyWorkerProcess, operation: Readonly<Record<string, unknown>>, verifyProcessIdentity: (input: CandidateInteractionIdentityCheck) => Promise<unknown>): Promise<CandidateInteractionChannel>;
  receiveInteractionRequest(channel: CandidateInteractionChannel): Promise<Readonly<Record<string, unknown>>>;
  replyToInteractionRequest(input: unknown, channel: CandidateInteractionChannel): Promise<Readonly<Record<string, unknown>>>;
  openRuntimeEventChannel(child: ClaimOnlyWorkerProcess, operation: Readonly<Record<string, unknown>>, verifyProcessIdentity: (input: CandidateInteractionIdentityCheck) => Promise<unknown>): Promise<CandidateRuntimeEventChannel>;
  receiveRuntimeTaskEvent(channel: CandidateRuntimeEventChannel): Promise<Readonly<Record<string, unknown>>>;
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

/**
 * Any persisted Runtime event means the Adapter reached an execution boundary
 * whose external effects cannot be reconstructed from SQLite. Absence of such
 * an event is only used to classify the explicitly controlled test Adapter;
 * production Adapter recovery also requires its own cleanup proof.
 */
function taskExecutionEvidenceObserved(
  port: Pick<ClaimOnlyPort, "readTaskEvents">,
  operation: Readonly<Record<string, unknown>>,
  lifecycleEvents: readonly Readonly<Record<string, unknown>>[],
): boolean {
  if (lifecycleEvents.some((event) => String(event.event_type).startsWith("interaction_"))) return true;
  const runtimeExecutionEventTypes = new Set([
    "session_ready", "model_selected", "turn_started", "model_tool_call",
    "tool_status", "model_output", "turn_completed", "turn_failed", "report_ready",
  ]);
  const taskId = text(operation.task_id, "recovery_task_id_missing");
  const operationId = text(operation.operation_id, "recovery_operation_id_missing");
  const attempt = positive(Number(operation.attempt), "recovery_attempt_invalid");
  const generation = positive(Number(operation.generation), "recovery_generation_invalid");
  const pageSize = 200;
  let afterCursor = 0;
  while (true) {
    const page = port.readTaskEvents(taskId, { afterCursor, limit: pageSize });
    if (page.events.length > pageSize) throw new LifecycleGateError("recovery_task_event_page_oversized");
    if (page.events.some((event) => runtimeExecutionEventTypes.has(String(event.event_type))
      && event.operation_id === operationId
      && Number(event.operation_attempt ?? event.attempt) === attempt
      && Number(event.generation) === generation)) return true;
    if (!page.hasMore) return false;
    const nextCursor = Number(page.nextCursor);
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= afterCursor) {
      throw new LifecycleGateError("recovery_task_event_cursor_invalid");
    }
    afterCursor = nextCursor;
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

interface CandidateRuntimeEventChannel {
  readonly binding: Readonly<Record<string, unknown>>;
  receiveEvent(): Promise<Readonly<Record<string, unknown>>>;
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
  readTaskAttention(taskId: string): Readonly<Record<string, unknown>> | null;
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
    autoUpgradeV13?(root: string, options: { databaseFileName: string; runtimeRosterDigest: string; assertStartupLock: () => void }): unknown;
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
  /** Test-only injection for the existing exact-root recorded-tree verifier. */
  readonly testVerifyProcessTreeClaimantsClean?: typeof verifyProcessTreeClaimantsClean;
  /** Test-only shortening of the fixed Manager tree-scan deadline; production uses 30 seconds. */
  readonly testProcessTreeProbeTimeoutMs?: number;
  /** Internal test seams: only shorten fixed production phase waits. */
  readonly testResultWaitMs?: number;
  readonly testWorkerCloseWaitMs?: number;
  readonly loadModules?: () => Promise<LifecycleCandidateModules>;
  /** Opaque capability created by the local stdio Host composition. */
  readonly trustedLocalContext?: TrustedLocalStdioContext;
  /** Test-only stage recorder for bounded cross-process diagnostics. */
  readonly onStage?: (stage: string, detail?: Readonly<Record<string, unknown>>) => void;
  /** Test-only callback to attach a draining stderr recorder immediately after Spawn. */
  readonly onChildSpawn?: (child: ClaimOnlyWorkerProcess) => void;
  /** Bounded private diagnostics: forwards Worker stderr lines that carry the
   * ADR-011 failure-facts marker. The composition validates the snapshot;
   * unvalidated content never reaches Host diagnostics. */
  readonly onWorkerDiagnosticLine?: (line: string) => void;
  /** Test-only seam for the explicit Recovery stop path; production always uses identity-bound OS termination. */
  readonly testStopWorkerForRecovery?: (pid: number, expectedFingerprint: string) => Promise<void>;
  /** Test-only barrier immediately before evidence/CAS writes in a cleanup Recovery race. */
  readonly testBeforeRecoveryWrite?: (operationId: string, phase: string) => Promise<void>;
  /** Synthetic integration test only. Production host composition never enables this driver. */
  readonly enableSyntheticInteractionChannel?: boolean;
  /** Test-only injection. Production composition must not set this option. */
  readonly testOnlyFakeAdapter?: true;
  /** Internal explicit opt-in only. The issuer must perform live entitlement
   * checks before creating a lease; never derived from a TaskPackage. */
  readonly startPlanPrivateAuth?: {
    readonly account: string;
    /** Aborted when authorization or active account identity is invalidated. */
    readonly signal: AbortSignal;
    /** The task's authoritative live entitlement check before provider
     * registration. issue() must reuse this verdict rather than call Billing. */
    prepare(provider: string, model: string, signal: AbortSignal): Promise<boolean>;
    issue(binding: Readonly<PrivateLeaseBinding>, signal: AbortSignal): Promise<PrivateCredentialLease>;
  };
  /** Host-supplied on-demand issuer discovery (ADR-031): consulted only when
   * a task actually requires Start Plan authentication, so a post-startup
   * login/logout/account switch is observed by the next dispatch without any
   * polling. The factory must fail closed (null) when no usable official
   * credential exists; a returned issuer still performs live entitlement
   * checks before any lease. */
  readonly startPlanPrivateAuthFactory?: () => Promise<NonNullable<ClaimOnlyDriverOptions["startPlanPrivateAuth"]> | null>;
  /** Injectable Worker-handle transaction factory for tests and non-Windows
   * CI. Production uses the real kernel-handle helper on Windows; when absent
   * on a non-Windows host the gate fails closed instead of trusting a PID
   * snapshot. The factory receives the launch receipt ticks so a controlled
   * fake can verify the same identity contract. */
  readonly startPlanPrivateAuthHandleTransaction?: (pid: number, expectedCreationTicks: string) => Promise<WindowsTreeTransactionLike>;
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

const freshBootstrapPromises = new Map<string, Promise<Readonly<Record<string, unknown>>>>();
const DEFAULT_FRESH_BOOTSTRAP_LOCK_TIMEOUT_MS = 30_000;
const FRESH_BOOTSTRAP_LOCK_RETRY_MS = 75;
const FRESH_BOOTSTRAP_LOCK_HANDSHAKE_TIMEOUT_MS = 10_000;
const FRESH_BOOTSTRAP_LOCK_RELEASE_TIMEOUT_MS = 3_000;

export type FreshBootstrapStage =
  | "lock_acquired"
  | "intent_written"
  | "marker_temp_written"
  | "schema_initialized"
  | "before_ready_receipt"
  | "ready_receipt_written"
  | "capacity_provisioned"
  | "database_staged"
  | "database_published"
  | "ready";

export interface FreshBootstrapOptions {
  /** Cross-process lock acquisition budget. The default is 30 seconds. */
  readonly lockTimeoutMs?: number;
  /** Deterministic test/evidence hook. Production callers leave this unset. */
  readonly onStage?: (stage: FreshBootstrapStage) => void;
}

/**
 * Ensure the production SQLite Authority exists and is fully usable before MCP
 * service construction. The per-process Promise coalesces concurrent startup
 * callers; the durable pending marker makes an interrupted unpublished
 * bootstrap recoverable without treating an unmarked corrupt database as new.
 */
export async function initializeFreshInstallSqliteRoot(
  root: string,
  databaseFileName: string,
  version = process.versions.node,
  processProbe: ProcessProbe = createPlatformProbe(),
  options: FreshBootstrapOptions = {},
): Promise<Readonly<Record<string, unknown>>> {
  if (typeof databaseFileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(databaseFileName)
    || databaseFileName === "." || databaseFileName === "..") {
    throw new LifecycleGateError("sqlite_bootstrap_database_name_invalid");
  }
  const modules = await loadLifecycleCandidateModules(version);
  const key = path.join(path.resolve(root), databaseFileName);
  const pending = freshBootstrapPromises.get(key);
  if (pending) return pending;
  const operation = ensureFreshSqliteAuthority(root, databaseFileName, modules, processProbe, options);
  freshBootstrapPromises.set(key, operation);
  try { return await operation; }
  finally { if (freshBootstrapPromises.get(key) === operation) freshBootstrapPromises.delete(key); }
}

interface FreshBootstrapMarker {
  readonly schema_version: 1;
  readonly state: "sqlite_bootstrap_pending";
  readonly database_file: string;
  readonly stage_file: string;
  readonly token: string;
  readonly owner_identity: ProcessIdentity;
}

interface FreshBootstrapLock {
  assertHeld(): void;
  release(): Promise<void>;
}

interface FreshBootstrapLockRecord {
  readonly schema_version: 1;
  readonly state: "held";
  readonly database_file: string;
  readonly owner_identity: ProcessIdentity;
  readonly acquired_at: string;
  readonly token: string;
}

interface ReleasedFreshBootstrapLockRecord {
  readonly schema_version: 1;
  readonly state: "released";
  readonly database_file: string;
  readonly released_at: string;
}

type FreshBootstrapLockAttempt =
  | { readonly kind: "acquired"; readonly lock: FreshBootstrapLock }
  | { readonly kind: "busy" };

async function acquireFreshBootstrapLock(
  root: string,
  databaseFileName: string,
  timeoutMs: number,
  ownerIdentity: ProcessIdentity,
  processProbe: ProcessProbe,
): Promise<FreshBootstrapLock> {
  if (process.platform !== "win32") {
    throw new LifecycleGateError(
      "sqlite_bootstrap_lock_platform_unsupported",
      "Fresh SQLite bootstrap requires the Windows exclusive-file-handle lock",
    );
  }
  const lockPath = path.join(root, `${databaseFileName}.bootstrap.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    assertFreshBootstrapRootPath(root);
    assertBootstrapLockPath(lockPath);
    const attempt = await tryAcquireWindowsBootstrapLock(root, lockPath, databaseFileName, ownerIdentity, processProbe);
    if (attempt.kind === "acquired") return attempt.lock;
    if (Date.now() >= deadline) {
      throw new LifecycleGateError(
        "sqlite_bootstrap_lock_timeout",
        `timed out waiting ${timeoutMs} ms for the SQLite bootstrap lock`,
      );
    }
    await delay(Math.min(FRESH_BOOTSTRAP_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
}

function assertBootstrapLockPath(lockPath: string): void {
  try {
    const stat = lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new LifecycleGateError("sqlite_bootstrap_lock_unsafe_entry");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function tryAcquireWindowsBootstrapLock(
  root: string,
  lockPath: string,
  databaseFileName: string,
  ownerIdentity: ProcessIdentity,
  processProbe: ProcessProbe,
): Promise<FreshBootstrapLockAttempt> {
  const record = `${JSON.stringify({
    schema_version: 1,
    state: "held",
    database_file: databaseFileName,
    owner_identity: ownerIdentity,
    acquired_at: new Date().toISOString(),
    token: randomUUID(),
  } satisfies FreshBootstrapLockRecord)}\n`;
  const releaseRecord = `${JSON.stringify({
    schema_version: 1,
    state: "released",
    database_file: databaseFileName,
    released_at: new Date().toISOString(),
  } satisfies ReleasedFreshBootstrapLockRecord)}\n`;
  const systemRoot = process.env["SystemRoot"];
  const absolutePowerShell = systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const executable = existsSync(absolutePowerShell) ? absolutePowerShell : "powershell.exe";
  const child = spawn(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(WINDOWS_BOOTSTRAP_LOCK_SCRIPT, "utf16le").toString("base64"),
  ], {
    cwd: root,
    env: {
      ...process.env,
      ZCODE_BOOTSTRAP_LOCK_FILE: lockPath,
      ZCODE_BOOTSTRAP_LOCK_RECORD_B64: Buffer.from(record, "utf8").toString("base64"),
      ZCODE_BOOTSTRAP_LOCK_RELEASE_RECORD_B64: Buffer.from(releaseRecord, "utf8").toString("base64"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exitPromise = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let helperExit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
  void exitPromise.then((exit) => { helperExit = exit; });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // A helper can disappear between an ownership check and the next pipe write.
  // The exit promise is authoritative; suppress the derived EPIPE event so it
  // cannot bypass the bootstrap's first-error path.
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const acquiredRecord: {
    base64?: string;
    length?: number;
  } = {};
  const handshake = await new Promise<"acquired" | "busy" | "failed">((resolve) => {
    let settled = false;
    const finish = (state: "acquired" | "busy" | "failed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    const inspectOutput = () => {
      if (/(?:^|\r?\n)BUSY(?:\r?\n|$)/u.test(stdout)) finish("busy");
      else {
        const match = /(?:^|\r?\n)ACQUIRED_BEGIN:(\d+)\r?\n([\s\S]*?)\r?\nACQUIRED_END(?:\r?\n|$)/u.exec(stdout);
        if (match) {
          acquiredRecord.length = Number(match[1]);
          // The helper frames the payload in short lines so console wrapping
          // cannot create a premature record boundary. Whitespace is not part
          // of base64, so remove it before the exact length and canonical
          // encoding checks below.
          acquiredRecord.base64 = (match[2] ?? "").replace(/\s+/gu, "");
          finish("acquired");
        }
      }
    };
    child.stdout.on("data", inspectOutput);
    child.once("error", () => finish("failed"));
    void exitPromise.then(({ code }) => finish(code === 73 ? "busy" : "failed"));
    const timer = setTimeout(() => {
      finish("failed");
      child.kill();
    }, FRESH_BOOTSTRAP_LOCK_HANDSHAKE_TIMEOUT_MS);
  });

  if (handshake === "acquired") {
    try {
      if (acquiredRecord.length === undefined
        || acquiredRecord.base64 === undefined
        || acquiredRecord.base64.length !== acquiredRecord.length) {
        throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
      }
      const previous = parsePreviousBootstrapLockRecord(acquiredRecord.base64, databaseFileName);
      if (previous?.state === "held") {
        const [verdict] = await processProbe.probe([{ pid: previous.owner_identity.pid, identity: previous.owner_identity }]);
        if (verdict?.state === "alive") {
          throw new LifecycleGateError(
            "sqlite_bootstrap_previous_owner_still_alive",
            "the previous bootstrap owner is still running after its exclusive lock helper exited",
          );
        }
        if (verdict?.state !== "exited") {
          throw new LifecycleGateError(
            "sqlite_bootstrap_previous_owner_unknown",
            "the previous bootstrap owner's process identity could not be proven exited",
          );
        }
      }
      child.stdin.write("COMMIT\n");
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const inspectOutput = () => {
          if (/(?:^|\r?\n)LOCKED(?:\r?\n|$)/u.test(stdout)) finish();
        };
        child.stdout.on("data", inspectOutput);
        void exitPromise.then(({ code, signal }) => finish(new LifecycleGateError(
          "sqlite_bootstrap_lock_helper_failed",
          `exclusive lock helper exited before commit with code ${code ?? "null"} and signal ${signal ?? "none"}; ${stderr.trim()}`,
        )));
        inspectOutput();
        const timer = setTimeout(() => {
          finish(new LifecycleGateError("sqlite_bootstrap_lock_helper_timeout"));
          child.kill();
        }, FRESH_BOOTSTRAP_LOCK_HANDSHAKE_TIMEOUT_MS);
      });
    } catch (error) {
      child.stdin.end();
      await waitForChildExit(child, exitPromise, FRESH_BOOTSTRAP_LOCK_RELEASE_TIMEOUT_MS);
      throw error;
    }
    try {
      assertBootstrapLockPath(lockPath);
    } catch (error) {
      child.stdin.end();
      await waitForChildExit(child, exitPromise, FRESH_BOOTSTRAP_LOCK_RELEASE_TIMEOUT_MS);
      throw error;
    }
    let released = false;
    return {
      kind: "acquired",
      lock: {
        assertHeld: () => {
          if (released || helperExit !== null || child.exitCode !== null || child.signalCode !== null
            || !processExists(child.pid)) {
            throw new LifecycleGateError(
              "sqlite_bootstrap_lock_lost",
              "the SQLite bootstrap lock helper exited while the bootstrap was in progress",
            );
          }
        },
        release: async () => {
          if (released) return;
          released = true;
          let exit = helperExit;
          if (exit === null && child.exitCode === null && child.signalCode === null && processExists(child.pid)) {
            child.stdin.write("RELEASE\n");
            await waitForChildExit(child, exitPromise, FRESH_BOOTSTRAP_LOCK_RELEASE_TIMEOUT_MS);
            exit = await exitPromise;
          } else {
            exit ??= await exitPromise;
          }
          if (exit.code !== 0 || exit.signal !== null) {
            throw new LifecycleGateError(
              "sqlite_bootstrap_lock_lost",
              `exclusive lock helper exited abnormally with code ${exit.code ?? "null"} and signal ${exit.signal ?? "none"}`,
            );
          }
        },
      },
    };
  }
  if (handshake === "busy") {
    child.stdin.end();
    await waitForChildExit(child, exitPromise, FRESH_BOOTSTRAP_LOCK_RELEASE_TIMEOUT_MS);
    return { kind: "busy" };
  }
  child.stdin.end();
  await waitForChildExit(child, exitPromise, FRESH_BOOTSTRAP_LOCK_RELEASE_TIMEOUT_MS);
  throw new LifecycleGateError(
    "sqlite_bootstrap_lock_helper_failed",
    stderr.trim() || `exclusive lock helper exited with code ${child.exitCode ?? "unknown"}`,
  );
}

function processExists(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new LifecycleGateError(
      "sqlite_bootstrap_lock_helper_unknown",
      error instanceof Error ? error.message : "bootstrap lock helper liveness could not be determined",
    );
  }
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  exitPromise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    exitPromise.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!timedOut) return;
  child.kill();
  const killed = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!killed) {
    throw new LifecycleGateError("sqlite_bootstrap_lock_helper_exit_timeout");
  }
}

function emitFreshBootstrapStage(options: FreshBootstrapOptions, stage: FreshBootstrapStage): void {
  options.onStage?.(stage);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WINDOWS_BOOTSTRAP_LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$stream = $null
try {
  try {
    $stream = [System.IO.FileStream]::new(
      $env:ZCODE_BOOTSTRAP_LOCK_FILE,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    [Console]::Out.WriteLine('BUSY')
    [Console]::Out.Flush()
    exit 73
  }
  if ($stream.Length -gt 16384) {
    [Console]::Error.WriteLine('existing lock record exceeds 16 KiB')
    exit 77
  }
  $previous = ''
  if ($stream.Length -gt 0) {
    $stream.Position = 0
    $buffer = New-Object byte[] $stream.Length
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -ne $buffer.Length) { throw 'short lock record read' }
    $previous = [Convert]::ToBase64String($buffer)
  }
  [Console]::Out.WriteLine('ACQUIRED_BEGIN:' + $previous.Length)
  if ($previous.Length -eq 0) {
    [Console]::Out.WriteLine('')
  } else {
    $offset = 0
    while ($offset -lt $previous.Length) {
      $count = [Math]::Min(64, $previous.Length - $offset)
      [Console]::Out.WriteLine($previous.Substring($offset, $count))
      $offset += $count
    }
  }
  [Console]::Out.WriteLine('ACQUIRED_END')
  [Console]::Out.Flush()
  $command = [Console]::In.ReadLine()
  if ($command -ne 'COMMIT') {
    exit 75
  }
  $record = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZCODE_BOOTSTRAP_LOCK_RECORD_B64))
  $bytes = [Text.Encoding]::UTF8.GetBytes($record)
  $stream.SetLength(0)
  $stream.Position = 0
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
  [Console]::Out.WriteLine('LOCKED')
  [Console]::Out.Flush()
  do {
    $command = [Console]::In.ReadLine()
  } while ($null -ne $command -and $command -ne 'RELEASE')
  if ($command -ne 'RELEASE') {
    exit 76
  }
  $releasedRecord = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZCODE_BOOTSTRAP_LOCK_RELEASE_RECORD_B64))
  $releasedBytes = [Text.Encoding]::UTF8.GetBytes($releasedRecord)
  $stream.SetLength(0)
  $stream.Position = 0
  $stream.Write($releasedBytes, 0, $releasedBytes.Length)
  $stream.Flush($true)
} catch {
  [Console]::Error.WriteLine($_.Exception.GetType().FullName + ': ' + $_.Exception.Message)
  exit 74
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
`;

async function ensureFreshSqliteAuthority(
  root: string,
  databaseFileName: string,
  modules: LifecycleCandidateModules,
  processProbe: ProcessProbe,
  options: FreshBootstrapOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const resolvedRoot = path.resolve(root);
  assertFreshBootstrapRootPath(resolvedRoot);
  const databasePath = path.join(resolvedRoot, databaseFileName);
  const pendingPath = `${databasePath}.bootstrap-pending.json`;
  const markerTempPath = `${databasePath}.bootstrap-marker.tmp`;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_FRESH_BOOTSTRAP_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 5 * 60_000) {
    throw new LifecycleGateError("sqlite_bootstrap_lock_timeout_invalid");
  }
  const ownerIdentity = await processProbe.selfIdentity();
  if (ownerIdentity.fingerprint_precision !== "exact" || !ownerIdentity.fingerprint
    || ownerIdentity.identity_version !== PROCESS_IDENTITY_VERSION || ownerIdentity.pid !== process.pid) {
    throw new LifecycleGateError("sqlite_bootstrap_owner_identity_unknown");
  }
  const lock = await acquireFreshBootstrapLock(
    resolvedRoot,
    databaseFileName,
    lockTimeoutMs,
    ownerIdentity,
    processProbe,
  );
  let result: Readonly<Record<string, unknown>> | undefined;
  let primaryError: unknown;
  try {
    lock.assertHeld();
    emitFreshBootstrapStage(options, "lock_acquired");
    for (;;) {
      assertFreshBootstrapRootPath(resolvedRoot);
      lock.assertHeld();
      if (existsSync(markerTempPath)) {
        // This path is inspected only while the cross-process exclusive lock is
        // held. Its existence therefore cannot indicate another live writer.
        const tempStat = lstatSync(markerTempPath);
        if (!tempStat.isFile() || tempStat.isSymbolicLink() || existsSync(databasePath) && !existsSync(pendingPath)) {
          throw new LifecycleGateError("sqlite_bootstrap_marker_temp_unexpected");
        }
      }
      if (existsSync(pendingPath)) {
        const marker = readFreshBootstrapMarker(pendingPath, databaseFileName);
        if (existsSync(databasePath)) {
          const published = tryReadReadySqliteAuthority(modules, resolvedRoot, databaseFileName, true);
          if (published?.kind === "fresh_install" && published.receipt_id === `fresh-install-${marker.token}`) {
            const stagePath = path.join(resolvedRoot, marker.stage_file);
            removeOwnedBootstrapFile(stagePath);
            removeOwnedBootstrapFile(`${stagePath}-wal`);
            removeOwnedBootstrapFile(`${stagePath}-shm`);
            removeOwnedBootstrapFile(`${stagePath}-journal`);
            unlinkSync(pendingPath);
            removeOwnedBootstrapFile(markerTempPath);
            emitFreshBootstrapStage(options, "ready");
            result = normalizeReadySqliteAuthority(published);
            break;
          }
          // A database at the production path may be a valid but unrelated
          // Authority or a damaged post-publication result. Never delete it
          // based only on a pending marker; the marker does not prove the
          // database file's identity.
          throw new LifecycleGateError("sqlite_bootstrap_published_database_unverified");
        }
        const stagePath = path.join(resolvedRoot, marker.stage_file);
        removeOwnedBootstrapFile(stagePath);
        removeOwnedBootstrapFile(`${stagePath}-wal`);
        removeOwnedBootstrapFile(`${stagePath}-shm`);
        removeOwnedBootstrapFile(`${stagePath}-journal`);
        unlinkSync(pendingPath);
        removeOwnedBootstrapFile(markerTempPath);
        continue;
      }

      if (existsSync(markerTempPath)) {
        // A temp marker without a published marker or database cannot have
        // started SQLite initialization. Keep the deletion bound to this
        // reserved regular-file name; all other unexpected root entries fail
        // closed below.
        removeOwnedBootstrapFile(markerTempPath);
      }

      if (existsSync(databasePath) || existsSync(databasePath + '.v13-v14-pending.json')) {
        // Existing v13 Authorities are upgraded once, while the same Windows
        // bootstrap lock protects promotion and cross-process startup.
        const upgrade = modules.Store.autoUpgradeV13?.(resolvedRoot, {
          databaseFileName,
          runtimeRosterDigest: currentSqliteRuntimeRosterDigest(),
          assertStartupLock: () => lock.assertHeld(),
        });
        const existing = tryReadReadySqliteAuthority(modules, resolvedRoot, databaseFileName, false);
        if (!existing) throw new LifecycleGateError("sqlite_existing_database_unverified", "existing SQLite database is not a valid production Authority");
        emitFreshBootstrapStage(options, "ready");
        result = {
          ...normalizeReadySqliteAuthority(existing),
          ...(upgrade && typeof upgrade === "object" && "state" in upgrade && upgrade.state === "upgraded"
            ? { upgradeState: "upgraded" }
            : {}),
        };
        break;
      }

      assertFreshBootstrapRootEmpty(resolvedRoot, databaseFileName);
      const token = randomUUID();
      const stageFile = `${databaseFileName}.bootstrap-${token}.stage`;
      const marker: FreshBootstrapMarker = {
        schema_version: 1,
        state: "sqlite_bootstrap_pending",
        database_file: databaseFileName,
        stage_file: stageFile,
        token,
        owner_identity: ownerIdentity,
      };
      assertFreshBootstrapRootPath(resolvedRoot);
      writeDurableBootstrapMarker(pendingPath, marker, options, lock);
      emitFreshBootstrapStage(options, "intent_written");
      result = await constructAndPublishFreshSqlite(
        resolvedRoot,
        databaseFileName,
        marker,
        modules,
        lock,
        options,
      );
      emitFreshBootstrapStage(options, "ready");
      break;
    }
  } catch (error) {
    primaryError = error instanceof LifecycleGateError
      ? error
      : new LifecycleGateError("sqlite_initialization_failed", error instanceof Error ? error.message : "initialization failed");
  }
  try {
    await lock.release();
  } catch (error) {
    if (primaryError === undefined) {
      primaryError = new LifecycleGateError(
        "sqlite_bootstrap_lock_release_failed",
        error instanceof Error ? error.message : "bootstrap lock release failed",
      );
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (!result) throw new LifecycleGateError("sqlite_initialization_failed", "bootstrap completed without a result");
  return result;
}

async function constructAndPublishFreshSqlite(
  root: string,
  databaseFileName: string,
  marker: FreshBootstrapMarker,
  modules: LifecycleCandidateModules,
  lock: FreshBootstrapLock,
  options: FreshBootstrapOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const databasePath = path.join(root, databaseFileName);
  const pendingPath = `${databasePath}.bootstrap-pending.json`;
  const stagePath = path.join(root, marker.stage_file);
  let published = false;
  try {
    lock.assertHeld();
    assertFreshBootstrapRootPath(root);
    const receiptId = `fresh-install-${marker.token}`;
    const stageStore = modules.Store.initialize(root, {
      databaseFileName: marker.stage_file,
      managedDataDirectory: true,
      freshInstallReceiptId: receiptId,
      freshInstallCapacityLimit: 8,
      verifierVersion: SQLITE_CUTOVER_VERIFIER_VERSION,
      onFreshBootstrapStage: (stage: FreshBootstrapStage) => emitFreshBootstrapStage(options, stage),
    });
    stageStore.close();
    lock.assertHeld();
    syncRegularFile(stagePath);
    emitFreshBootstrapStage(options, "database_staged");
    const staged = modules.Store.open(root, { databaseFileName: marker.stage_file, managedDataDirectory: true });
    try {
      lock.assertHeld();
      staged.assertAuthorityReady(currentSqliteRuntimeRosterDigest());
    }
    finally { staged.close(); }

    lock.assertHeld();
    assertFreshBootstrapRootPath(root);
    if (existsSync(databasePath)) throw new LifecycleGateError("sqlite_database_appeared_during_bootstrap");
    linkSync(stagePath, databasePath);
    published = true;
    unlinkSync(stagePath);
    const ready = tryReadReadySqliteAuthority(modules, root, databaseFileName, true);
    if (!ready) throw new LifecycleGateError("sqlite_bootstrap_readback_failed");
    unlinkSync(pendingPath);
    emitFreshBootstrapStage(options, "database_published");
    return normalizeReadySqliteAuthority(ready);
  } catch (error) {
    if (!published) {
      let cleanupOwned = false;
      try {
        lock.assertHeld();
        cleanupOwned = true;
      } catch { /* a lost lock must not let this owner delete the next owner's evidence */ }
      if (!cleanupOwned) throw error;
      removeOwnedBootstrapFile(stagePath);
      removeOwnedBootstrapFile(`${stagePath}-wal`);
      removeOwnedBootstrapFile(`${stagePath}-shm`);
      removeOwnedBootstrapFile(`${stagePath}-journal`);
      removeOwnedBootstrapFile(pendingPath);
      removeOwnedBootstrapFile(`${databasePath}.bootstrap-marker.tmp`);
    }
    throw error;
  }
}

function tryReadReadySqliteAuthority(
  modules: LifecycleCandidateModules,
  root: string,
  databaseFileName: string,
  allowPending: boolean,
): Readonly<Record<string, unknown>> | null {
  let store: LifecycleCandidateStore | undefined;
  try {
    store = modules.Store.open(root, {
      databaseFileName,
      managedDataDirectory: true,
      ...(allowPending ? { allowFreshBootstrapPending: true } : {}),
    });
    return store.assertAuthorityReady(currentSqliteRuntimeRosterDigest());
  } catch (error) {
    if (errorCode(error) === "schema_upgrade_required") throw error;
    return null;
  } finally { store?.close(); }
}

function normalizeReadySqliteAuthority(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (value.kind === "fresh_install") {
    return { authorityKind: "fresh_install", receiptId: value.receipt_id, verifierVersion: value.verifier_version };
  }
  return { authorityKind: "authority_switch" };
}

function assertFreshBootstrapRootEmpty(root: string, databaseFileName: string): void {
  const allowed = new Set([
    `${databaseFileName}.bootstrap-pending.json`,
    `${databaseFileName}.bootstrap.lock`,
  ]);
  for (const name of readdirSync(root)) {
    if (!allowed.has(name)) throw new LifecycleGateError("sqlite_existing_state_incomplete", `unexpected SQLite root entry: ${name}`);
  }
}

function assertFreshBootstrapRootPath(root: string): void {
  try {
    const stat = lstatSync(root);
    const real = realpathSync.native(root);
    const normalize = (value: string) => process.platform === "win32"
      ? path.win32.normalize(value).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US")
      : path.resolve(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(real) !== normalize(root)) {
      throw new LifecycleGateError("sqlite_data_root_redirected");
    }
  } catch (error) {
    if (error instanceof LifecycleGateError) throw error;
    throw new LifecycleGateError("sqlite_data_root_unverified", error instanceof Error ? error.message : "data root unavailable");
  }
}

function readFreshBootstrapMarker(file: string, databaseFileName: string): FreshBootstrapMarker {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error("unsafe_marker");
    const value = JSON.parse(readFileSync(file, "utf8")) as FreshBootstrapMarker;
    const expectedStagePrefix = `${databaseFileName}.bootstrap-`;
    if (value.schema_version !== 1 || value.state !== "sqlite_bootstrap_pending" || value.database_file !== databaseFileName
      || typeof value.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.token)
      || value.stage_file !== `${expectedStagePrefix}${value.token}.stage`
      || !value.owner_identity || value.owner_identity.pid < 1 || !Number.isSafeInteger(value.owner_identity.pid)
      || value.owner_identity.fingerprint_precision !== "exact" || !value.owner_identity.fingerprint
      || value.owner_identity.identity_version !== PROCESS_IDENTITY_VERSION || !value.owner_identity.platform
      || !value.owner_identity.captured_at || Number.isNaN(Date.parse(value.owner_identity.captured_at))) throw new Error("invalid_marker");
    return value;
  } catch (error) {
    throw new LifecycleGateError("sqlite_bootstrap_marker_invalid", error instanceof Error ? error.message : "invalid marker");
  }
}

function writeDurableBootstrapMarker(
  file: string,
  marker: FreshBootstrapMarker,
  options: FreshBootstrapOptions,
  lock: FreshBootstrapLock,
): void {
  let fd: number | undefined;
  let created = false;
  const temp = `${file.slice(0, -".bootstrap-pending.json".length)}.bootstrap-marker.tmp`;
  let tempCreated = false;
  try {
    lock.assertHeld();
    fd = openSync(temp, "wx", 0o600);
    lock.assertHeld();
    tempCreated = true;
    writeFileSync(fd, `${JSON.stringify(marker)}\n`, "utf8");
    fsyncSync(fd);
    lock.assertHeld();
    closeSync(fd);
    fd = undefined;
    emitFreshBootstrapStage(options, "marker_temp_written");
    lock.assertHeld();
    // linkSync is an exclusive atomic publication: it cannot overwrite a
    // marker created by another process between the preflight and this point.
    linkSync(temp, file);
    created = true;
    lock.assertHeld();
    unlinkSync(temp);
    tempCreated = false;
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve the marker write error */ } }
    let cleanupOwned = false;
    try {
      lock.assertHeld();
      cleanupOwned = true;
    } catch { /* a lost lock must leave recovery evidence for the next owner */ }
    if (cleanupOwned && created) { try { unlinkSync(file); } catch { /* a surviving malformed marker fails closed */ } }
    if (cleanupOwned && tempCreated) { try { unlinkSync(temp); } catch { /* a surviving reserved temp is handled on next startup */ } }
    throw error;
  }
}

function parsePreviousBootstrapLockRecord(
  encoded: string,
  databaseFileName: string,
): FreshBootstrapLockRecord | ReleasedFreshBootstrapLockRecord | null {
  if (encoded.length === 0) return null;
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
  }
  let value: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) {
      throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
    }
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
  }
  const record = value as Record<string, unknown>;
  if (record["schema_version"] !== 1 || record["database_file"] !== databaseFileName) {
    throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
  }
  if (record["state"] === "released") {
    if (typeof record["released_at"] !== "string" || Number.isNaN(Date.parse(record["released_at"]))) {
      throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
    }
    return record as unknown as ReleasedFreshBootstrapLockRecord;
  }
  if (record["state"] !== "held"
    || typeof record["acquired_at"] !== "string" || Number.isNaN(Date.parse(record["acquired_at"]))
    || typeof record["token"] !== "string"
    || !record["owner_identity"] || typeof record["owner_identity"] !== "object") {
    throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
  }
  const identity = record["owner_identity"] as Record<string, unknown>;
  if (identity["fingerprint_precision"] !== "exact"
    || typeof identity["fingerprint"] !== "string" || identity["fingerprint"].length === 0
    || identity["identity_version"] !== PROCESS_IDENTITY_VERSION
    || !Number.isSafeInteger(identity["pid"]) || Number(identity["pid"]) < 1
    || typeof identity["platform"] !== "string"
    || typeof identity["captured_at"] !== "string" || Number.isNaN(Date.parse(identity["captured_at"]))) {
    throw new LifecycleGateError("sqlite_bootstrap_lock_record_invalid");
  }
  return record as unknown as FreshBootstrapLockRecord;
}

function syncRegularFile(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new LifecycleGateError("sqlite_bootstrap_stage_unsafe");
  // Windows FlushFileBuffers requires a writable handle even when the caller
  // only intends to force previously written SQLite bytes to stable storage.
  const fd = openSync(file, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeOwnedBootstrapFile(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new LifecycleGateError("sqlite_bootstrap_recovery_unsafe_entry");
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  readTaskAttention(taskId: string): unknown;
  readTaskEvents(taskId: string, options?: { readonly afterCursor?: number; readonly limit?: number }): LifecycleEventsPage;
  readCommittedResult(operationId: string): CandidateCommittedResult | null;
  readTaskFeedback(taskId: string): unknown;
  readRecoverySnapshot(): unknown;
  readRecoverableQueuedAttempts(): readonly Readonly<Record<string, unknown>>[];
  recoverOperation(operationId: string, options?: {
    readonly stopAliveWorker?: boolean;
    readonly allowInterruptRequeue?: boolean;
    readonly interruptionReason?: "interrupted_by_upgrade" | "worker_exited_without_result" | "worker_terminated_without_result";
  }): Promise<Readonly<Record<string, unknown>>>;
  createNextAttempt(input: Readonly<Record<string, unknown>>): unknown;
  interruptAndRequeue(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
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
  const processTreeProbeTimeoutMs = options.testProcessTreeProbeTimeoutMs ?? DEFAULT_PROCESS_TREE_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(processTreeProbeTimeoutMs) || processTreeProbeTimeoutMs < 1
    || processTreeProbeTimeoutMs > DEFAULT_PROCESS_TREE_PROBE_TIMEOUT_MS) {
    throw new LifecycleGateError("process_tree_probe_timeout_invalid");
  }
  const verifyTreeClaimants = options.testVerifyProcessTreeClaimantsClean ?? verifyProcessTreeClaimantsClean;
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
  const activeWorkers = new Map<string, {
    readonly child: ClaimOnlyWorkerProcess;
    readonly input: ClaimOnlyRunInput;
    readonly privateAuthAbort?: AbortController;
    readonly privateAuthState?: { cancelled: boolean; phase: "resolving" | "delivering" | "acknowledged" };
    readonly releasePrivateAuth?: () => void;
    readonly closeHandleGate?: () => Promise<void>;
  }>();
  // A completed frame may be large. Finalize one already-exited Worker's
  // Result/Cleanup at a time so synchronous SQLite work cannot consume another
  // finalizer's OS probe budget. Executing Workers and pipe reads remain live.
  let resultFinalization = Promise.resolve();
  const takeResultFinalization = async (): Promise<() => void> => {
    const preceding = resultFinalization;
    let release!: () => void;
    resultFinalization = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    return release;
  };
  const cancellationProofs = new Map<string, {
    readonly task_id: string;
    readonly attempt: number;
    readonly child: ClaimOnlyWorkerProcess | null;
    readonly verificationDigest: string;
    readonly processTreeDigest: string;
  }>();
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
    async recoverOperation(operationId: string, recoveryOptions: {
      readonly stopAliveWorker?: boolean;
      readonly allowInterruptRequeue?: boolean;
      readonly interruptionReason?: "interrupted_by_upgrade" | "worker_exited_without_result" | "worker_terminated_without_result";
    } = {}) {
      const stopKey = recoveryStopKey(options.dataRoot, options.databaseFileName, operationId);
      const operationValue = port.readOperation(operationId);
      if (!operationValue) throw new LifecycleGateError("recovery_operation_missing");
      const operation = asRecord(operationValue);
      if (operation.operation_kind !== "attempt_lifecycle") return { state: "not_applicable", operation_id: operationId };
      const phase = text(operation.phase, "recovery_phase_missing");
      if (phase === "released" || phase === "cancelled_before_launch" || phase === "admin_abandoned") {
        if (phase === "released") verifiedRecoveryStops.delete(stopKey);
        return { state: "complete", operation_id: operationId, phase };
      }
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
        verifiedRecoveryStops.delete(stopKey);
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
      let identityState = verdict?.state === "alive" || verdict?.state === "exited" ? verdict.state : "unknown";
      const cleanupPhase = phase === "result_committed" || phase === "cleanup_pending" || phase === "cleanup_unverified";
      let probeReason = probeFailure ?? (typeof verdict?.reason_code === "string" ? verdict.reason_code : "probe_result_unknown");
      const cancellationRequested = lifecycleEvents.some((event) => {
        if (event.event_type !== "observation_recorded") return false;
        try { return JSON.parse(String(event.evidence_json)).reason === "cancel_requested"; }
        catch { throw new LifecycleGateError("recovery_event_evidence_invalid"); }
      });

      // A running Operation with no Result is kept occupied unless the Host
      // explicitly asks for scoped startup/interruption Recovery. In that mode
      // exact identity exit plus a clean recorded-tree scan is required before
      // the old Attempt can become interruption history and a new Attempt is
      // queued. An explicit cancellation always retains its own proof path.
      if (phase === "running" && recoveryOptions.allowInterruptRequeue !== true) {
        return {
          state: "held",
          operation_id: operationId,
          phase,
          reason: identityState === "alive" ? "worker_still_alive_managed_elsewhere"
            : identityState === "exited" ? "worker_exited_without_committed_result"
              : "worker_identity_unknown_managed_elsewhere",
          identity_state: identityState,
          probe_reason: probeReason,
        };
      }
      if (phase === "running") {
        if (cancellationRequested) {
          return { state: "held", operation_id: operationId, phase, reason: "cancellation_in_progress",
            identity_state: identityState, probe_reason: probeReason };
        }
        if (taskExecutionEvidenceObserved(port, operation, lifecycleEvents)) {
          return {
            state: "held",
            operation_id: operationId,
            phase,
            reason: "execution_side_effect_unverified",
            identity_state: identityState,
            probe_reason: probeReason,
          };
        }
        // OS exit/tree facts prove process closure, not completion of every
        // Adapter-owned resource. The production Adapter therefore needs its
        // existing cleanup contract before this path can write cleanup_verified.
        if (options.testOnlyFakeAdapter !== true) {
          return {
            state: "held",
            operation_id: operationId,
            phase,
            reason: "adapter_cleanup_unverified",
            identity_state: identityState,
            probe_reason: probeReason,
          };
        }
        const initialIdentityState = identityState;
        const activeEntry = [...activeWorkers.entries()]
          .find(([candidateOperationId]) => candidateOperationId === operationId);
        const active = activeEntry?.[1];
        if (active && active.child.pid !== processId) {
          return { state: "held", operation_id: operationId, phase, reason: "recovery_host_worker_identity_mismatch",
            identity_state: identityState, probe_reason: probeReason };
        }
        if (identityState === "alive" && recoveryOptions.stopAliveWorker === true && !active) {
          return {
            state: "held",
            operation_id: operationId,
            phase,
            reason: "worker_still_alive_managed_elsewhere",
            identity_state: identityState,
            probe_reason: probeReason,
          };
        }
        if (identityState === "alive" && recoveryOptions.stopAliveWorker === true) {
          try {
            let stop = verifiedRecoveryStops.get(stopKey);
            if (!stop) {
              stop = (async () => {
                if (options.testStopWorkerForRecovery) {
                  await options.testStopWorkerForRecovery(processId, fingerprint);
                } else {
                  const stopped = await terminateProcessTree(processId, {
                    graceMs: 500,
                    killWaitMs: 5_000,
                    expectedRootFingerprint: fingerprint,
                  });
                  if (stopped.verified !== true) throw new LifecycleGateError("recovery_worker_stop_unverified");
                }
              })();
              verifiedRecoveryStops.set(stopKey, stop);
            }
            await stop;
            const afterStop = await probeWithDeadline(probe, { pid: processId, identity }, processProbeTimeoutMs);
            identityState = afterStop.status === "resolved" && afterStop.verdict?.state === "exited" ? "exited"
              : afterStop.status === "resolved" && afterStop.verdict?.state === "alive" ? "alive" : "unknown";
            probeReason = afterStop.status === "resolved"
              ? afterStop.verdict?.reason_code ?? probeReason
              : afterStop.status === "timeout" ? "probe_timeout" : "probe_rejected";
          } catch (error) {
            verifiedRecoveryStops.delete(stopKey);
            identityState = "unknown";
            probeReason = errorCode(error) ?? "worker_stop_unverified";
          }
        }
        if (identityState !== "exited") {
          return {
            state: "held",
            operation_id: operationId,
            phase,
            reason: identityState === "alive" ? "worker_still_alive" : "worker_exit_unverified",
            identity_state: identityState,
            probe_reason: probeReason,
          };
        }
        const interruptionTree = await processTreeWithDeadline(
          [{ pid: processId, fingerprint }],
          processTreeProbeTimeoutMs,
          verifyTreeClaimants,
        );
        const treeResult = interruptionTree.status === "resolved" ? interruptionTree.result : undefined;
        const treeClosed = treeResult?.clean === true
          && treeResult.livePids.length === 0
          && treeResult.observedPids.includes(processId);
        if (!treeClosed || !treeResult) {
          return {
            state: "held",
            operation_id: operationId,
            phase,
            reason: interruptionTree.status === "timeout" ? "process_tree_probe_timeout"
              : interruptionTree.status === "rejected" ? "process_tree_probe_rejected"
                : treeResult !== undefined && treeResult.livePids.length > 0 ? "process_tree_still_live"
                  : "process_tree_not_verified",
            identity_state: identityState,
            probe_reason: probeReason,
          };
        }
        if (active) {
          try {
            const exitCode = await waitForClose(active.child, 15_000);
            if (exitCode === null && !active.child.signalCode) throw new LifecycleGateError("worker_exit_unverified");
            active.privateAuthAbort?.abort();
            active.releasePrivateAuth?.();
            await active.closeHandleGate?.();
            for (const stream of active.child.stdio) stream?.destroy();
          } catch (error) {
            return {
              state: "held",
              operation_id: operationId,
              phase,
              reason: errorCode(error) ?? "worker_resources_not_closed",
              identity_state: "unknown",
              probe_reason: probeReason,
            };
          }
        }
        const streams = active?.child.stdio as ReadonlyArray<{ destroyed?: boolean; closed?: boolean } | null> | undefined;
        const workerStdioClosed = streams === undefined
          || streams.every((stream) => stream === null || stream.destroyed === true || stream.closed === true);
        if (!workerStdioClosed) {
          return { state: "held", operation_id: operationId, phase, reason: "worker_resources_not_closed",
            identity_state: "exited", probe_reason: probeReason };
        }
        const observedPids = [...new Set(treeResult.observedPids)].sort((left, right) => left - right);
        const processTreeFacts = {
          contract: "sqlite-candidate-recovery-interruption-tree-v1",
          operation_id: operationId,
          task_id: String(operation.task_id),
          attempt: Number(operation.attempt),
          generation: Number(operation.generation),
          claim_id: claimId,
          worker_identity_digest: workerDigest,
          root_process_id: processId,
          root_start_fingerprint: fingerprint,
          identity_state: "exited",
          scan_scope: "worker_root_recorded_tree_and_observed_claimants",
          scan_clean: true,
          live_pids: [],
          observed_pids: observedPids,
        };
        const resourceFacts = {
          contract: "sqlite-candidate-recovery-interruption-resources-v1",
          adapter: options.testOnlyFakeAdapter ? "fake_candidate_adapter" : "zcode_app_server",
          operation_id: operationId,
          generation: Number(operation.generation),
          claim_id: claimId,
          worker_identity_digest: workerDigest,
          worker_process_exited: true,
          worker_tree_complete: true,
          worker_stdio_closed: true,
          interaction_channels_closed: true,
          workspace_touched: false,
          execution_events_observed: false,
        };
        const adapterCleanup = {
          contract: "adapter-cleanup-v1",
          close: { stage: "direct_close", status: "resolved", treeScanStatus: "verified" },
          treeScanStatus: "verified",
        } as const;
        const processTreeDigest = sha256(canonicalJson(processTreeFacts));
        const resourcesDigest = sha256(canonicalJson(resourceFacts));
        const interruptionReason = recoveryOptions.interruptionReason
          ?? (initialIdentityState === "alive" ? "worker_terminated_without_result" : "worker_exited_without_result");
        const interruptionEvidence = {
          contract: "sqlite-candidate-recovery-interruption-v1",
          reason: interruptionReason,
          operation_id: operationId,
          task_id: String(operation.task_id),
          attempt: Number(operation.attempt),
          generation: Number(operation.generation),
          claim_id: claimId,
          worker_identity_digest: workerDigest,
          initial_identity_state: initialIdentityState,
          final_identity_state: "exited",
          probe_reason: probeReason,
          process_tree_digest: processTreeDigest,
          resources_digest: resourcesDigest,
          host_worker_handle_present: active !== undefined,
          worker_stdio_closed: true,
          execution_evidence_state: "none_observed",
        };
        const nextAttempt = Number(operation.attempt) + 1;
        const outcome = asRecord(port.interruptAndRequeue({
          operation_id: operationId,
          task_id: text(operation.task_id, "recovery_task_id_missing"),
          attempt: positive(Number(operation.attempt), "recovery_attempt_invalid"),
          generation: positive(Number(operation.generation), "recovery_generation_invalid"),
          revision: positive(Number(operation.revision), "recovery_revision_invalid"),
          claim_id: text(claimId, "recovery_claim_id_missing"),
          claim_worker_identity_digest: text(workerDigest, "recovery_claim_identity_missing"),
          reason: interruptionReason,
          interruption_evidence: interruptionEvidence,
          process_tree_digest: processTreeDigest,
          resources_digest: resourcesDigest,
          adapter_cleanup: adapterCleanup,
          continuation_operation_id: `sqlite-${sha256(`${String(operation.task_id)}\0${nextAttempt}`).slice(0, 32)}`,
        }, {
          workspaceValidator: localPolicy.validateWorkspace,
          executionPermissionCheck: localPolicy.checkPermission,
        }));
        if (outcome.status !== "queued" || Number(outcome.attempt) !== nextAttempt) {
          throw new LifecycleGateError("recovery_interruption_not_persisted");
        }
        if (activeEntry) activeWorkers.delete(activeEntry[0]);
        cancellationProofs.delete(operationId);
        verifiedRecoveryStops.delete(stopKey);
        return {
          state: "requeued",
          operation_id: operationId,
          task_id: outcome.task_id,
          previous_attempt: outcome.previous_attempt,
          attempt: outcome.attempt,
          next_operation_id: outcome.next_operation_id,
          phase: "queued",
          reason: interruptionReason,
          result_digest: outcome.result_digest,
          cleanup_digest: outcome.cleanup_digest,
        };
      }

      // A missing Adapter resource proof is a distinct cleanup fact. An
      // OS-level Worker exit and tree scan cannot reconstruct resources that
      // the Adapter never reported, so do not scan or promote that Hold.
      if (phase === "cleanup_unverified") {
        const failureEvent = [...lifecycleEvents].reverse()
          .find((event) => event.event_type === "cleanup_unverified");
        let failureReason: unknown = null;
        try {
          failureReason = failureEvent
            ? (JSON.parse(String(failureEvent.evidence_json)) as Record<string, unknown>).reason
            : null;
        } catch {
          return { state: "held", operation_id: operationId, phase, reason: "cleanup_failure_evidence_invalid",
            identity_state: identityState, probe_reason: probeReason };
        }
        if (failureReason === "adapter_cleanup_unverified") {
          return { state: "held", operation_id: operationId, phase, reason: "adapter_cleanup_unverified",
            identity_state: identityState, probe_reason: probeReason };
        }
      }

      if (phase === "cleanup_unverified" && recoveryOptions.stopAliveWorker === true && identityState === "alive") {
        try {
          let stop = verifiedRecoveryStops.get(stopKey);
          if (!stop) {
            stop = (async () => {
              if (options.testStopWorkerForRecovery) {
                await options.testStopWorkerForRecovery(processId, fingerprint);
              } else {
                const stopped = await terminateProcessTree(processId, {
                  graceMs: 500,
                  killWaitMs: 5_000,
                  expectedRootFingerprint: fingerprint,
                });
                if (stopped.verified !== true) throw new LifecycleGateError("recovery_worker_stop_unverified");
              }
            })();
            verifiedRecoveryStops.set(stopKey, stop);
            try { await stop; }
            catch (error) {
              if (verifiedRecoveryStops.get(stopKey) === stop) verifiedRecoveryStops.delete(stopKey);
              throw error;
            }
          } else {
            await stop;
          }
          const afterStop = await probeWithDeadline(probe, { pid: processId, identity }, processProbeTimeoutMs);
          const afterStopVerdict = afterStop.status === "resolved" ? afterStop.verdict : undefined;
          identityState = afterStopVerdict?.state === "exited" ? "exited"
            : afterStopVerdict?.state === "alive" ? "alive" : "unknown";
          probeReason = afterStopVerdict?.reason_code
            ?? (identityState === "exited" ? "worker_stopped_and_exit_verified" : "worker_stop_exit_unverified");
        } catch (error) {
          identityState = "unknown";
          probeReason = errorCode(error) ?? "worker_stop_unverified";
        }
      }

      // Recovery may finish the C2 protocol from result_committed or
      // cleanup_pending. The OD-8 supplement also permits cleanup_unverified
      // to proceed only after fresh exact-identity exit evidence and a clean,
      // complete tree/resource verification. PID absence alone never releases.
      let treeOutcome: BoundedTreeOutcome | undefined;
      if ((phase === "result_committed" || phase === "cleanup_pending" || phase === "cleanup_unverified")
        && identityState === "exited") {
        treeOutcome = await processTreeWithDeadline(
          [{ pid: processId, fingerprint }],
          processTreeProbeTimeoutMs,
          verifyTreeClaimants,
        );
      }
      if ((phase === "result_committed" || phase === "cleanup_pending" || phase === "cleanup_unverified") && identityState === "exited") {
        // For a single-user local Bridge, exact exit identity plus a clean
        // recorded-root/claimant scan is the Recovery closure contract. The
        // scan can miss an unobserved adversarial intermediate ancestor; that
        // residual risk is retained in the DECISION rather than hidden by PID
        // absence alone. Unknown, alive, conflicting, or failed scans below
        // remain operation-scoped Holds.
        const completeCleanupClosureAvailable = treeOutcome?.status === "resolved"
          && treeOutcome.result.clean === true
          && treeOutcome.result.livePids.length === 0
          && treeOutcome.result.observedPids.includes(processId);
        if (completeCleanupClosureAvailable && treeOutcome?.status === "resolved") {
          const currentOperation = asRecord(port.readOperation(operationId));
          if (currentOperation.task_id !== operation.task_id || Number(currentOperation.attempt) !== Number(operation.attempt)
            || Number(currentOperation.generation) !== Number(operation.generation) || currentOperation.claim_id !== claimId
            || currentOperation.claim_worker_identity_digest !== workerDigest) {
            return { state: "held", operation_id: operationId, phase: String(currentOperation.phase), reason: "recovery_identity_fence_changed" };
          }
          if (currentOperation.phase === "released") {
            verifiedRecoveryStops.delete(stopKey);
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
            verifiedRecoveryStops.delete(stopKey);
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
          if (currentPhase === "cleanup_unverified") await options.testBeforeRecoveryWrite?.(operationId, currentPhase);
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
          const observedPids = [...new Set(treeOutcome.result.observedPids)].sort((left, right) => left - right);
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
            scan_scope: "worker_root_recorded_tree_and_observed_claimants",
            scan_clean: true,
            live_pids: [],
            observed_pids: observedPids,
          };
          const resourceFacts = {
            contract: "sqlite-candidate-recovery-operation-resources-v1",
            adapter: options.testOnlyFakeAdapter ? "fake_candidate_adapter" : "zcode_app_server",
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
          verifiedRecoveryStops.delete(stopKey);
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
    readTaskAttention: (taskId) => port.readTaskAttention(taskId),
    readTaskEvents: (taskId, options) => port.readTaskEvents(taskId, options),
    readCommittedResult: (operationId) => port.readCommittedResult(operationId),
    readTaskFeedback: (taskId) => port.readTaskFeedback(taskId),
    createNextAttempt: (input) => port.createNextAttempt(input, {
      workspaceValidator: localPolicy.validateWorkspace,
      executionPermissionCheck: localPolicy.checkPermission,
    }),
    interruptAndRequeue: (input) => port.interruptAndRequeue(input, {
      workspaceValidator: localPolicy.validateWorkspace,
      executionPermissionCheck: localPolicy.checkPermission,
    }),
    cancelQueuedAttempt: (input) => port.cancelQueuedAttempt(input),
    requestCancellation: (input, evidence) => port.requestCancellation(input, evidence),
    recordCancellationVerification: (input, evidence) => port.recordCancellationVerification(input, evidence),
    async cancelRunning(taskId, attempt) {
      const activeEntry = [...activeWorkers.entries()].find(([, value]) => value.input.task.task_id === taskId && value.input.attempt === attempt);
      const active = activeEntry?.[1];
      let operationId = activeEntry?.[0];
      if (!operationId) {
        const lifecycleValue = port.readTaskLifecycle(taskId);
        if (!lifecycleValue) throw new LifecycleGateError("cancellation_task_missing");
        const lifecycle = asRecord(lifecycleValue);
        const projection = asRecord(lifecycle.projection);
        if (Number(projection.current_attempt) !== attempt || !lifecycle.operation) {
          throw new LifecycleGateError("cancellation_operation_unavailable", "the current SQLite Attempt has no cancellable Operation");
        }
        operationId = text(asRecord(lifecycle.operation).operation_id, "cancellation_operation_id_missing");
      }
      const operation = asRecord(port.readOperation(operationId));
      if (operation.phase !== "running" || operation.task_id !== taskId || Number(operation.attempt) !== attempt) {
        return { result_won: operation.result_digest !== null, operation_id: operationId, phase: operation.phase, result_status: operation.result_status };
      }
      const worker = parseEvidence(String(operation.claim_worker_identity_json), "cancellation_worker_identity_invalid");
      const workerPid = positive(Number(worker.process_id), "cancellation_worker_pid_invalid");
      if (active?.child.pid !== undefined && active.child.pid !== workerPid) {
        throw new LifecycleGateError("cancellation_worker_identity_mismatch");
      }
      if (worker.source !== "manager_verified_process_probe" || worker.fixture !== false
        || worker.platform !== "win32" || worker.fingerprint_precision !== "exact"
        || worker.identity_version !== PROCESS_IDENTITY_VERSION || typeof worker.start_fingerprint !== "string") {
        throw new LifecycleGateError("cancellation_worker_identity_mismatch");
      }
      const processIdentity = { pid: workerPid, fingerprint: String(worker.start_fingerprint),
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
      // Do not destroy the credential pipes here. Doing so converts an
      // in-flight Start Plan request into an immediate Worker EOF/result and
      // lets that failure race the durable cancellation proof. Mark the
      // request cancelled, terminate the bound Worker, and let the owner-exit
      // path revoke both pending delivery and the credential channel.
      if (active?.privateAuthState) {
        active.privateAuthState.cancelled = true;
      }
      await active?.closeHandleGate?.();
      const cancelId = text(intent.cancel_id, "cancellation_intent_missing");
      const persistedVerification = readAllLifecycleEventsForRecovery(port, operationId).find((event) => {
        if (event.event_type !== "observation_recorded") return false;
        try { return parseEvidence(event.evidence_json, "cancellation_verification_invalid").reason === "cancel_tree_verified"; }
        catch { throw new LifecycleGateError("cancellation_verification_invalid"); }
      });
      if (persistedVerification) {
        if (identityVerdict.state !== "exited") throw new LifecycleGateError("cancellation_verification_conflict");
        const persistedEvidence = parseEvidence(persistedVerification.evidence_json, "cancellation_verification_invalid");
        if (persistedEvidence.cancel_id !== cancelId || persistedEvidence.claim_id !== fence.claim_id
          || persistedEvidence.worker_identity_digest !== fence.claim_worker_identity_digest
          || persistedEvidence.root_process_id !== processIdentity.pid
          || persistedEvidence.root_start_fingerprint !== processIdentity.fingerprint
          || persistedEvidence.worker_tree_complete !== true) {
          throw new LifecycleGateError("cancellation_verification_conflict");
        }
        const verificationDigest = text(persistedVerification.evidence_digest, "cancellation_verification_missing");
        const processTreeDigest = text(persistedEvidence.process_tree_digest, "cancellation_process_tree_digest_missing");
        cancellationProofs.set(operationId, { task_id: taskId, attempt, child: active?.child ?? null,
          verificationDigest, processTreeDigest });
        return { duplicate: true, result_won: false, operation_id: operationId, cancel_id: cancelId,
          phase: operation.phase, cancellation_verification_digest: verificationDigest };
      }
      const terminationState: "terminated" | "already_exited" = identityVerdict.state === "alive" ? "terminated" : "already_exited";
      if (identityVerdict.state === "alive") {
        const terminated = await terminateProcessTree(processIdentity.pid, { graceMs: 500, killWaitMs: 5_000,
          expectedRootFingerprint: processIdentity.fingerprint });
        if (terminated.verified !== true) throw new LifecycleGateError("cancellation_tree_termination_unverified");
      }
      let workerExitCode: number | null = null;
      if (active?.child) {
        workerExitCode = await waitForClose(active.child, 15_000);
        if (workerExitCode === null && !active.child.signalCode) throw new LifecycleGateError("cancellation_worker_exit_unknown");
      } else if (identityVerdict.state === "alive") {
        const afterStop = await probeWithDeadline(probe, { pid: processIdentity.pid, identity: processIdentity }, processProbeTimeoutMs);
        if (afterStop.status !== "resolved" || afterStop.verdict?.state !== "exited") {
          throw new LifecycleGateError("cancellation_worker_exit_unknown");
        }
      }
      const terminationSignal = workerExitCode === null && active?.child ? active.child.signalCode ?? null : null;
      const scan = await verifyProcessTreeClaimantsClean([{ pid: processIdentity.pid, fingerprint: processIdentity.fingerprint }]);
      if (!scan.clean || scan.livePids.length > 0) throw new LifecycleGateError("cancellation_tree_not_clean");
      const processTreeFacts = { contract: "sqlite-candidate-cancelled-worker-tree-v1", operation_id: operationId,
        task_id: taskId, attempt, generation: Number(operation.generation), claim_id: fence.claim_id, cancel_id: cancelId,
        worker_identity_digest: fence.claim_worker_identity_digest, root_process_id: processIdentity.pid,
        root_start_fingerprint: processIdentity.fingerprint, identity_state: identityVerdict.state,
        termination_state: terminationState, worker_exit_code: workerExitCode, worker_termination_signal: terminationSignal, scan_clean: true,
        live_pids: [], observed_pids: [...scan.observedPids].sort((a, b) => a - b) };
      const treeEvidence = { source: "manager_process_tree_verification", outcome: "verified", operation_id: operationId,
        task_id: taskId, attempt, generation: Number(operation.generation), cancel_id: cancelId, claim_id: fence.claim_id,
        worker_identity_digest: fence.claim_worker_identity_digest, root_process_id: processIdentity.pid,
        root_start_fingerprint: processIdentity.fingerprint, worker_tree_complete: true, scan_clean: true,
        termination_signal: terminationSignal,
        live_pids: [], termination_state: terminationState, process_tree_digest: sha256(canonicalJson(processTreeFacts)) };
      const current = asRecord(port.readOperation(operationId));
      const verification = asRecord(port.recordCancellationVerification({ ...fence, revision: Number(current.revision) }, treeEvidence));
      if (verification.result_won === true) return verification;
      const verificationDigest = text(verification.cancellation_verification_digest, "cancellation_verification_missing");
      cancellationProofs.set(operationId, { task_id: taskId, attempt, child: active?.child ?? null,
        verificationDigest, processTreeDigest: String(treeEvidence.process_tree_digest) });
      return { ...verification, result_won: false, cancellation_verification_digest: verificationDigest };
    },
    async completeRunningCancellation(taskId, attempt) {
      const proofEntry = [...cancellationProofs.entries()].find(([, value]) => value.task_id === taskId && value.attempt === attempt);
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
      const streams = proof.child?.stdio as ReadonlyArray<{ destroyed?: boolean; closed?: boolean } | null> | undefined;
      // After a Manager restart there is no inherited local handle. Exact
      // process exit plus the clean recorded-tree scan is the closure proof.
      const workerStdioClosed = streams === undefined
        || streams.every((stream) => stream === null || stream.destroyed === true || stream.closed === true);
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
      const retired = [...activeWorkers.entries()].find(([, value]) => value.input.task.task_id === taskId && value.input.attempt === attempt && value.child === proof.child);
      if (retired) activeWorkers.delete(retired[0]);
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
    close: () => {
      // Closing this Host detaches observation; it is never cleanup evidence.
      for (const { child } of activeWorkers.values()) {
        for (const stream of child.stdio) stream?.destroy();
        child.unref();
      }
      activeWorkers.clear();
      raw.close();
    },
    async run(input) {
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
        throw new LifecycleGateError("attempt_invalid");
      }
      const runtimeEnv = loadPersistedRuntimeEnvironment(process.env, homedir(), workerHostProfile);
      const executionTimeoutMs = resolveTaskTimeout(input.task, runtimeEnv);
      const executionTask = { ...input.task, timeout_ms: executionTimeoutMs };
      const resultWaitMs = options.testResultWaitMs ?? resultWaitBudgetMs(executionTimeoutMs);
      const workerCloseWaitMs = options.testWorkerCloseWaitMs ?? WORKER_CLOSE_TIMEOUT_MS;
      if (!Number.isSafeInteger(resultWaitMs) || resultWaitMs < 1 || resultWaitMs > resultWaitBudgetMs(executionTimeoutMs)
        || !Number.isSafeInteger(workerCloseWaitMs) || workerCloseWaitMs < 1 || workerCloseWaitMs > WORKER_CLOSE_TIMEOUT_MS) throw new LifecycleGateError("invalid_phase_test_budget");
      let runFinished = false, workerClosed = false;
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
          const executionWorkspace = taskExecutionWorkspace(input.task);
          admission = asRecord(port.admitOperation({
            operation_id: input.operationId,
            task_id: input.task.task_id,
            attempt: input.attempt,
            workspace_ref: executionWorkspace,
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
        // A deterministic refusal here must not create a durable launch permit.
        // Once Launch Intent exists, recovery must treat Worker creation as
        // potentially started even if this Manager has not called Spawn yet.
        for (const workspace of new Set([input.task.workspace, taskExecutionWorkspace(input.task)])) {
          const usePolicy = localPolicy.validateWorkspaceForUse(workspace);
          if (usePolicy.state !== "allow") {
            state = "launch_outcome_unknown";
            reason = usePolicy.reason;
            throw new LifecycleGateError("trusted_local_workspace_use_denied", usePolicy.reason);
          }
        }
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
        stage("spawn_bootstrap_start");
        // ADR-031 dynamic credential discovery: resolve the issuer once per
        // launch so each dispatch observes the current official login state.
        // The resolved issuer stays bound to this run; a mid-run account
        // change is rejected by the credential delivery checks, never
        // crossed over silently.
        const startPlanRequested = input.task.model?.provider_id === "account:bigmodel-start-plan";
        const startPlanPrivateAuth = options.startPlanPrivateAuth
          ?? (startPlanRequested && !options.testOnlyFakeAdapter
            ? await options.startPlanPrivateAuthFactory?.().catch(() => null) ?? null
            : null);
        if (startPlanRequested && !startPlanPrivateAuth && !options.testOnlyFakeAdapter) {
          throw new LifecycleGateError("start_plan_private_auth_unavailable");
        }
        const usePrivateAuth = startPlanRequested && !!startPlanPrivateAuth;
        if (usePrivateAuth && (!startPlanPrivateAuth!.account || !startPlanPrivateAuth!.signal || startPlanPrivateAuth!.signal.aborted || options.testOnlyFakeAdapter)) throw new LifecycleGateError("private_auth_configuration_invalid");
        stage("start_plan_private_auth_resolved", { requested: startPlanRequested, resolved: usePrivateAuth, source: options.startPlanPrivateAuth ? "injected" : "factory" });
        const launch = await spawnAndBootstrapOnce(() => {
          spawnCount += 1;
          child = spawnClaimOnlyWorker(options.workerEntryPath, provenance, {
            ...(options.enableSyntheticInteractionChannel || !options.testOnlyFakeAdapter ? { interactionChannel: true } : {}),
            ...(usePrivateAuth ? { privateAuthChannel: true } : {}),
            ...(options.enableSyntheticInteractionChannel || !options.testOnlyFakeAdapter ? { runtimeEventChannel: true } : {}),
            ...(options.onWorkerDiagnosticLine ? { onWorkerDiagnosticLine: options.onWorkerDiagnosticLine } : {}),
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
          const privateAuthAbort = new AbortController();
          const privateAuthState = { cancelled: false, phase: "resolving" as "resolving" | "delivering" | "acknowledged" };
          const accountSignal = usePrivateAuth ? startPlanPrivateAuth!.signal : undefined;
          const revokeOnAccountChange = (): void => privateAuthAbort.abort();
          accountSignal?.addEventListener("abort", revokeOnAccountChange, { once: true });
          if (accountSignal?.aborted) privateAuthAbort.abort();
          let startPlanEntitled = false;
          let handleGate: WorkerHandleGate | undefined;
          const closeHandleGate = async (): Promise<void> => {
            const gate = handleGate;
            handleGate = undefined;
            if (gate) await gate.close().catch(() => undefined);
          };
          activeWorkers.set(input.operationId, { child, input, ...(usePrivateAuth ? { privateAuthAbort,
            privateAuthState,
            releasePrivateAuth: () => accountSignal?.removeEventListener("abort", revokeOnAccountChange),
            closeHandleGate } : {}) });
          if (usePrivateAuth) {
            if (!child.privateAuthLifetimeChannel) throw new LifecycleGateError("private_auth_lifetime_unavailable");
            const lifetime = child.privateAuthLifetimeChannel;
            lifetime.on("error", () => privateAuthAbort.abort());
            privateAuthAbort.signal.addEventListener("abort", () => lifetime.destroy(), { once: true });
            if (privateAuthAbort.signal.aborted) lifetime.destroy();
            else lifetime.write(Buffer.from([1]));
            try {
              startPlanEntitled = await startPlanPrivateAuth!.prepare(
                input.task.model!.provider_id,
                input.task.model!.model_id,
                privateAuthAbort.signal,
              );
            } catch (error) {
              startPlanEntitled = false;
              stage("start_plan_entitlement_preflight_rejected", {
                ...classifyStartPlanEntitlementRejection(error),
              });
            }
            if (privateAuthAbort.signal.aborted) startPlanEntitled = false;
            stage("start_plan_entitlement_preflight", { entitled: startPlanEntitled });
          }
          child.once("close", () => {
            workerClosed = true;
            const active = activeWorkers.get(input.operationId);
            if (active && active.child === child) {
              active.privateAuthAbort?.abort();
              active.releasePrivateAuth?.();
              void active.closeHandleGate?.();
              if (runFinished) {
                let operationStillRunning = true;
                try { operationStillRunning = asRecord(port.readOperation(input.operationId)).phase === "running"; }
                catch { operationStillRunning = true; }
                if (!operationStillRunning) activeWorkers.delete(input.operationId);
              }
            }
          });
          const runtimeEventsEnabled = options.enableSyntheticInteractionChannel || !options.testOnlyFakeAdapter;
          const claimedOperation = asRecord(port.readOperation(input.operationId));
          const verifyClaimedWorkerIdentity = async ({ child: observedChild, expected }: CandidateInteractionIdentityCheck) => {
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
          };
          // Bind the one-way event reader before handing execution to the
          // Worker. Preflight/no-op Tasks can produce a terminal Result before
          // a post-decision bind, which would otherwise turn a valid quick
          // execution into an outcome-unknown Hold.
          const runtimeEventChannel = runtimeEventsEnabled
            ? await port.openRuntimeEventChannel(child, claimedOperation, verifyClaimedWorkerIdentity)
            : undefined;
          // Task and execution configuration are sent only after the durable
          // Claim. Production always selects the real ZCode Adapter. The fake
          // path requires this internal test-only capability and is never
          // selected by the Host's normal configuration.
          try { await sendDecision(child, "claim_committed", {
            protocol: "bridge-sqlite-execution-envelope-v1",
            operation_id: input.operationId,
            task_id: input.task.task_id,
            attempt: input.attempt,
            generation,
            workspace_ref: policySnapshot.workspace_ref,
            policy_snapshot_digest: policySnapshot.policy_snapshot_digest,
            execution_profile_id: policySnapshot.execution_profile_id,
            adapter_mode: options.testOnlyFakeAdapter ? "test_fake" : "zcode_app_server",
            task: executionTask,
            host_profile: workerHostProfile,
            continuation: input.continuation ?? null,
            previous_result: input.previousResult ?? null,
            ...(usePrivateAuth ? { private_auth: {
              account: startPlanPrivateAuth!.account,
              claim: claimId,
              provider: input.task.model!.provider_id,
              model: input.task.model!.model_id,
              entitled: startPlanEntitled,
            } } : {}),
          }); } catch (error) {
            state = "result_rejected";
            reason = errorCode(error) ?? "private_execution_delivery_failed";
            throw error;
          }
          stage("claim_continue_sent", { claim_id: claimId, execution_timeout_ms: executionTimeoutMs, result_wait_ms: resultWaitMs });

          let interactionPump: Promise<void> | undefined;
          let runtimeEventPump: Promise<void> | undefined;
          let runtimeEventFailure: unknown;
          let reportReadyPersisted = false;
          let privateAuthPump: Promise<unknown> | undefined;
          if (usePrivateAuth) {
            const owner = child;
            const claimed = asRecord(port.readOperation(input.operationId));
            const worker = parseEvidence(String(claimed.claim_worker_identity_json), "private_auth_identity_invalid");
            if (!owner.privateAuthRequestChannel || !owner.privateAuthResponseChannel || !owner.privateAuthAcknowledgementChannel
              || typeof owner.pid !== "number" || claimed.phase !== "running" || claimed.claim_id !== claimId || claimed.claim_generation !== generation
              || worker.process_id !== owner.pid || worker.fingerprint_precision !== "exact" || typeof worker.start_fingerprint !== "string") {
              throw new LifecycleGateError("private_auth_binding_invalid");
            }
            // P0-C production identity gate: hold one kernel handle on the
            // Worker and verify its exact creation time against the launch
            // receipt before any credential can be delivered.
            try {
              handleGate = await WorkerHandleGate.open({
                pid: owner.pid,
                expectedCreationTicks: String(worker.start_fingerprint),
                ...(options.startPlanPrivateAuthHandleTransaction ? { transaction: await options.startPlanPrivateAuthHandleTransaction(owner.pid, String(worker.start_fingerprint)) } : {}),
              });
            } catch (error) {
              throw new LifecycleGateError(`private_auth_handle_gate_unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
            owner.once("exit", () => privateAuthAbort.abort());
            privateAuthPump = servePrivateCredential({ request: owner.privateAuthRequestChannel, response: owner.privateAuthResponseChannel,
              acknowledgement: owner.privateAuthAcknowledgementChannel, signal: privateAuthAbort.signal, timeoutMs: 60_000,
              resolveLease: async (request, signal) => {
                const candidate = asRecord(request.binding);
                if (candidate.account !== startPlanPrivateAuth!.account || candidate.provider !== input.task.model?.provider_id
                  || candidate.model !== input.task.model?.model_id || candidate.task !== input.task.task_id || candidate.attempt !== input.attempt
                  || candidate.operation !== input.operationId || candidate.generation !== generation || candidate.claim !== claimId
                  || candidate.pid !== owner.pid || candidate.creation !== worker.start_fingerprint
                  || typeof candidate.session !== "string" || !candidate.session || typeof candidate.turn !== "string" || !candidate.turn) {
                  throw new Error("private_auth_binding_invalid");
                }
                const binding = Object.freeze({ ...candidate }) as unknown as PrivateLeaseBinding;
                const waitUntilOwnerExit = (): Promise<never> => new Promise((_, reject) => {
                  if (privateAuthAbort.signal.aborted) { reject(new Error("private_auth_cancelled")); return; }
                  privateAuthAbort.signal.addEventListener("abort", () => reject(new Error("private_auth_cancelled")), { once: true });
                });
                const verifyWorker = async (): Promise<boolean> => {
                  const current = asRecord(port.readOperation(input.operationId));
                  if (signal.aborted || owner.exitCode !== null || owner.signalCode !== null || current.phase !== "running"
                    || current.claim_id !== claimId || current.claim_generation !== generation
                    || current.claim_worker_identity_digest !== claimed.claim_worker_identity_digest) return false;
                  // The held kernel handle is the authoritative identity
                  // evidence; a snapshot probe alone is not accepted here.
                  await handleGate?.assertAlive();
                  return !signal.aborted && owner.exitCode === null && owner.signalCode === null;
                };
                if (!await verifyWorker()) throw new Error("private_auth_identity_invalid");
                const lease = await startPlanPrivateAuth!.issue(binding, signal);
                // A cancellation request must remain durable while its process
                // proof is in flight. Leave the pipes open, revoke the lease,
                // and let the pending private-auth request be aborted by the
                // Worker's own exit signal rather than fabricating an EOF.
                if (signal.aborted || privateAuthState.cancelled) {
                  lease.revoke();
                  await waitUntilOwnerExit();
                }
                privateAuthState.phase = "delivering";
                return { lease, binding, verifyWorker };
              },
            }).then(() => {
              privateAuthState.phase = "acknowledged";
              const lifetime = owner.privateAuthLifetimeChannel;
              if (privateAuthAbort.signal.aborted || !lifetime || lifetime.destroyed || lifetime.writableEnded) { privateAuthAbort.abort(); return; }
              lifetime.write(Buffer.from([2]), (error) => { if (error) privateAuthAbort.abort(); });
            }).catch(() => {
              // A failed or uncertain delivery is terminal. Closing the
              // lifetime pipe also revokes any Worker-side cached lease once
              // the Worker observes EOF; never attempt a second delivery.
              privateAuthAbort.abort();
            });
          }
          if (runtimeEventsEnabled) {
            const channel = await port.openInteractionChannel(child, claimedOperation, verifyClaimedWorkerIdentity);
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
            const runtimeChannel = runtimeEventChannel!;
            stage("runtime_event_channel_bound", { pid: child.pid, claim_id: claimId });
            const pump = (async () => {
              for (;;) {
                try {
                  const persisted = await port.receiveRuntimeTaskEvent(runtimeChannel);
                  stage("runtime_task_event_persisted", {
                    event_cursor: persisted.event_cursor,
                    worker_sequence: persisted.worker_sequence,
                    duplicate: persisted.duplicate,
                  });
                  if (persisted.event_type === "report_ready") reportReadyPersisted = true;
                } catch (error) {
                  const reason = errorCode(error) ?? "runtime_event_channel_unavailable";
                  if (reason === "runtime_event_channel_closed") return;
                  if (reason.startsWith("runtime_event_frame_")
                    || reason.startsWith("runtime_event_channel_identity")
                    || reason === "runtime_event_worker_not_live"
                    || reason !== "runtime_event_channel_unavailable") {
                    const runtimeStream = (child?.stdio as unknown as
                      ReadonlyArray<{ resume?(): unknown } | null> | undefined)?.[14];
                    runtimeStream?.resume?.();
                    throw error;
                  }
                  throw error;
                }
              }
            })();
            // Attach the rejection handler immediately. A malformed first frame
            // can fail before Result read or drain begins, and an unhandled
            // rejection would terminate the Manager before it can retain the
            // existing Hold/Recovery path. The drain below still rethrows it.
            runtimeEventPump = pump.catch((error: unknown) => {
              runtimeEventFailure = error;
            });
          }

          let rawResult: unknown;
          try {
            stage("worker_result_frame_read_start");
            rawResult = await readJsonLine(child.resultChannel, MAX_WORKER_RESULT_FRAME_BYTES + 1, resultWaitMs);
            stage("worker_result_frame_read_complete");
          } catch (error) {
            state = "result_rejected";
            reason = error instanceof Error ? error.message : "worker_result_unavailable";
            stage("worker_result_unavailable", { reason, child_exit_code: child.exitCode ?? null,
              child_signal: child.signalCode ?? null, child_exit_seen: child.exitSeen === true,
              spawn_count: spawnCount });
          }

          // A complete Worker Result frame is durable execution output. Revoke
          // any remaining auth lease now, but do not make Result persistence
          // wait for process close or an interaction pump that drains on EOF.
          privateAuthAbort.abort();
          await privateAuthPump;
          try {
            await raceWithTimeout(runtimeEventPump ?? Promise.resolve(), workerCloseWaitMs, "runtime_event_drain_timeout");
            if (runtimeEventFailure !== undefined) throw runtimeEventFailure;
            stage("runtime_event_channel_drained");
          } catch (error) {
            const drainReason = errorCode(error) ?? "runtime_event_drain_timeout";
            state = "result_rejected";
            reason = drainReason;
            stage("runtime_event_channel_drain_failed", { reason: drainReason });
          }


          const releaseResultFinalization = await takeResultFinalization();
          try {
            if (state !== "result_rejected") {
                try {
                  const resultFrame = { ...validateWorkerResultFrame(rawResult, {
                    operation_id: input.operationId,
                    task_id: input.task.task_id,
                    attempt: input.attempt,
                    generation,
                    workspace_ref: policySnapshot.workspace_ref,
                    policy_snapshot_digest: policySnapshot.policy_snapshot_digest,
                  }) };
                  if (!options.testOnlyFakeAdapter && resultFrame.execution_cleanup?.source === "explicit_test_fake") {
                    throw new LifecycleGateError("test_adapter_frame_forbidden");
                  }
                  const executionCleanup = trustedExecutionCleanupProof(
                    resultFrame.execution_cleanup,
                    options.testOnlyFakeAdapter === true,
                  );
                  if (!options.testOnlyFakeAdapter
                    && (resultFrame.result.status === "completed" || resultFrame.result.status === "waiting_for_master")
                    && !reportReadyPersisted) {
                    throw new LifecycleGateError("runtime_report_ready_missing");
                  }
                  try { canonicalTaskResult(resultFrame.result, {task_id:input.task.task_id, attempt:input.attempt, result_status:resultFrame.result.status}); }
                  catch(error) {
                    // Identity and cleanup proof were checked before replacing an invalid report.
                    resultFrame.result = submissionFailure({task_id:input.task.task_id,attempt:input.attempt},error) as CandidateTaskResult;
                  }
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
                      // The complete bound frame is durable before waiting for Worker shutdown.
                      try { workerExitCode = await waitForClose(child, workerCloseWaitMs, interactionPump); }
                      catch (error) { stage("worker_close_unverified", { reason: errorCode(error) ?? "worker_stop_timeout" }); }
                      if (workerClosed) await closeHandleGate();
                      stage("worker_close", { pid: child.pid ?? null, exitCode: workerExitCode });
                      cleanupState = await finalizeClaimedWorkerCleanup(port, input, generation, claimId, probe, processProbeTimeoutMs,
                        verifyTreeClaimants, processTreeProbeTimeoutMs, workerExitCode,
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
                    // A failed/uncertain ACK does not prevent bounded exit
                    // observation. It never authorizes Cleanup or Release.
                    try { workerExitCode = await waitForClose(child, workerCloseWaitMs, interactionPump); }
                    catch (closeError) { stage("worker_close_unverified", { reason: errorCode(closeError) ?? "worker_stop_timeout" }); }
                    stage("worker_close", { pid: child.pid ?? null, exitCode: workerExitCode });
                  } else {
                    state = "result_rejected";
                    reason = errorCode(error) ?? "worker_result_invalid";
                    stage("worker_result_rejected", { reason });
                  }
                }
            }
          } finally { releaseResultFinalization(); }
        }
      } catch (error) {
        if (state === "launch_outcome_unknown") reason = error instanceof LifecycleGateError ? error.code : "claim_only_lifecycle_failed";
        else if (state === "result_outcome_unknown") reason = errorCode(error) ?? reason;
        else if (state !== "result_rejected" || !reason || reason === "result_not_committed") reason = errorCode(error) ?? reason;
        if (child && workerExitCode === null) {
          try {
            if (activeWorkers.get(input.operationId)?.child !== child) await rejectChild(child);
            workerExitCode = await waitForClose(child, workerCloseWaitMs);
          } catch { /* keep the known handle and durable occupancy; never re-dispatch */ }
        }
      } finally {
        if (state === "result_rejected") {
          try {
            const current = asRecord(port.readOperation(input.operationId));
            if (current.phase === "running" && current.result_digest === null && current.task_id === input.task.task_id && current.attempt === input.attempt) {
              port.recordResultSubmissionFailure?.({ operation_id: input.operationId, generation: current.generation, revision: current.revision,
                claim_id: current.claim_id, claim_worker_identity_digest: current.claim_worker_identity_digest },
                /^[a-z0-9_]{1,128}$/u.test(reason) ? reason : "worker_result_unavailable");
            }
          } catch (error) {
            stage("result_failure_diagnostic_unavailable", { reason: errorCode(error) ?? "diagnostic_write_failed" });
          }
        }
        if (state === "result_rejected" || state === "result_outcome_unknown") {
          // No retry or release. This remains observable even if SQLite cannot
          // persist a diagnostic. Existing read-only Recovery inspects the root.
          process.stderr.write(`SQLITE_RESULT_SUBMISSION_FAILED ${JSON.stringify({operation_id:input.operationId,task_id:input.task.task_id,state,reason})}\n`);
          if (state === "result_outcome_unknown") {
            try {
              const recoveryStore = modules.Store.openForRecovery(options.dataRoot, {
                ...(options.databaseFileName ? { databaseFileName: options.databaseFileName } : {}),
                ...(options.managedDataDirectory ? { managedDataDirectory: true } : {}),
              });
              try {
                const snapshot = asRecord(modules.createPort(recoveryStore as object).readRecoverySnapshot());
                const matching = Array.isArray(snapshot.operations) ? snapshot.operations.map(asRecord).find(o => o.operation_id === input.operationId) : null;
                const reconciled = { root_status: snapshot.root_status, phase: matching?.phase ?? null, result_digest: matching?.result_digest ?? null };
                stage("result_outcome_reconciled_read_only", reconciled);
                process.stderr.write(`SQLITE_RESULT_OUTCOME_UNKNOWN ${JSON.stringify({operation_id:input.operationId,...reconciled})}\n`);
              } finally { recoveryStore?.close(); }
            } catch { /* poisoned root/marker remains the durable recovery fence */ }
          }
        }
        const active = activeWorkers.get(input.operationId);
        runFinished = true;
        if (active && active.child === child && workerClosed) {
          active.privateAuthAbort?.abort();
          active.releasePrivateAuth?.();
          await active.closeHandleGate?.();
          // An Operation that is still `running` (e.g. the Worker died before
          // producing a valid result) keeps its bound Worker handle so a later
          // cancellation can verify the exited identity and release the
          // attempt instead of losing all cancellation evidence.
          let operationStillRunning = true;
          try { operationStillRunning = asRecord(port.readOperation(input.operationId)).phase === "running"; }
          catch { operationStillRunning = true; }
          if (!operationStillRunning) activeWorkers.delete(input.operationId);
        }
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
  verifyTreeClaimants: typeof verifyProcessTreeClaimantsClean,
  processTreeProbeTimeoutMs: number,
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
  let cleanupFailureReason: string | undefined;
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
        stage("cleanup_tree_scan_start", { pid: rootProcessId });
        const treeOutcome = await processTreeWithDeadline(
          [{ pid: rootProcessId, fingerprint: rootFingerprint }],
          processTreeProbeTimeoutMs,
          verifyTreeClaimants,
        );
        const treeComplete = treeOutcome.status === "resolved"
          && treeOutcome.result.clean === true
          && treeOutcome.result.livePids.length === 0
          && treeOutcome.result.observedPids.includes(rootProcessId);
        stage(treeOutcome.status === "timeout" ? "cleanup_tree_scan_timeout"
          : treeOutcome.status === "rejected" ? "cleanup_tree_scan_failed"
            : treeComplete ? "cleanup_tree_scan_clean" : "cleanup_tree_scan_incomplete",
        treeOutcome.status === "resolved" ? {
          clean: treeOutcome.result.clean,
          live_pid_count: treeOutcome.result.livePids.length,
          observed_pid_count: treeOutcome.result.observedPids.length,
          execution_cleanup_method: executionCleanup.method,
        } : {});
        if (treeComplete && treeOutcome.status === "resolved") {
          const launchReceiptDigest = text(current.launch_receipt_digest, "cleanup_launch_receipt_digest_missing");
          const resultCommitRef = text(current.result_commit_ref, "cleanup_result_commit_ref_missing");
          const observedPids = [...new Set(treeOutcome.result.observedPids)].sort((left, right) => left - right);
          const processTreeFacts = {
            contract: executionCleanup.source === "zcode_app_server_adapter"
              ? "real-zcode-claimed-worker-process-tree-v1"
              : "synthetic-claim-worker-process-tree-v1",
            process_id: rootProcessId,
            start_fingerprint: rootFingerprint,
            worker_exit_code: workerExitCode,
            probe_state: verdict.state,
            scan_scope: "worker_root_recorded_tree_and_observed_claimants",
            scan_clean: true,
            live_pids: [],
            observed_pids: observedPids,
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
            ...("adapter_cleanup" in executionCleanup
              ? { adapter_cleanup: executionCleanup.adapter_cleanup } : {}),
          };
        } else {
          probeState = "incomplete";
          cleanupFailureReason = treeOutcome.status === "timeout" ? "process_tree_probe_timeout"
            : treeOutcome.status === "rejected" ? "process_tree_probe_rejected"
              : treeOutcome.status === "resolved" && treeOutcome.result.livePids.length > 0 ? "process_tree_still_live"
                : "process_tree_scan_incomplete";
        }
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
        : workerExitCode === 0 ? cleanupFailureReason ?? "worker_exit_identity_not_proven" : "worker_exit_not_verified",
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
  stage("cleanup_verified_persisted", { revision: recorded.revision, cleanup_digest: recorded.cleanup_digest });
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
    const timer = setTimeout(() => {
      channel.destroy();
      reject(new LifecycleGateError("private_execution_delivery_timeout"));
    }, EXECUTION_DELIVERY_TIMEOUT_MS);
    channel.once("error", error => { clearTimeout(timer); reject(error); });
    channel.once("finish", () => { clearTimeout(timer); resolve(); });
    channel.end(frame);
  });
}

async function readJsonLine(stream: Readable | null, limit: number, timeoutMs: number): Promise<unknown> {
  if (!stream) throw new LifecycleGateError("private_report_channel_unavailable");
  const startedAtMs = Date.now();
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const fail = (error: Error): void => {
      cleanup(); chunks.length = 0;
      // Preserve the original rejection while draining the owned pipe; a late
      // reset after rejection must not become an unhandled stream error.
      if (!stream.closed) {
        const drainingError = (): void => {};
        stream.on("error", drainingError);
        stream.once("close", () => stream.removeListener("error", drainingError));
        stream.resume();
      }
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) return fail(new LifecycleGateError("private_report_too_large"));
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      try {
        const bytes = Buffer.concat(chunks, size);
        chunks.length = 0;
        if (!bytes.length || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) {
          // Bounded diagnostic facts only: byte count and frame shape, never
          // frame content. These distinguish an empty premature EOF from a
          // partial or delimiter-broken frame on hosted CI.
          throw new Error(`invalid worker report frame (bytes=${bytes.length},`
            + ` trailing_newline=${bytes.at(-1) === 0x0a},`
            + ` embedded_newline=${bytes.subarray(0, -1).includes(0x0a)},`
            + ` elapsed_ms=${Date.now() - startedAtMs})`);
        }
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

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LifecycleGateError(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForClose(child: ClaimOnlyWorkerProcess, timeoutMs: number, drain?: Promise<void>): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  let onClose: ((code: number | null) => void) | undefined;
  const stdioClosed = (child.stdio as ReadonlyArray<{ destroyed?: boolean; closed?: boolean } | null>)
    .every((stream) => stream === null || stream.destroyed === true || stream.closed === true);
  const closeAlreadyObserved = child.exitCode !== null || child.signalCode !== null
    || (child.exitSeen === true && stdioClosed);
  const closed = closeAlreadyObserved ? Promise.resolve(child.exitCode)
    : new Promise<number | null>(resolve => { onClose = resolve; child.once("close", onClose); });
  try {
    return await Promise.race([
      Promise.all([closed, drain]).then(([code]) => code),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LifecycleGateError("worker_stop_timeout")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onClose) child.removeListener("close", onClose);
  }
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
  verify: typeof verifyProcessTreeClaimantsClean = verifyProcessTreeClaimantsClean,
): Promise<BoundedTreeOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const pending = Promise.resolve().then(() => verify(targets)).then(
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
  assertWorkerResultEnvelope(frame);
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
  if (proof.source === "zcode_app_server_adapter" && proof.method === "verified_recorded_tree_scan") {
    if (Object.keys(proof).sort().join("|")
      !== "adapter_cleanup|adapter_process_id|adapter_start_fingerprint|complete|contract|managed_browser_cleanup_verified|method|process_tree_member_count|process_tree_scan_digest|source|workspace_retained"
      || !Number.isSafeInteger(proof.adapter_process_id) || Number(proof.adapter_process_id) < 1
      || typeof proof.adapter_start_fingerprint !== "string" || proof.adapter_start_fingerprint.length === 0
      || typeof proof.process_tree_scan_digest !== "string" || !/^[0-9a-f]{64}$/u.test(proof.process_tree_scan_digest)
      || !Number.isSafeInteger(proof.process_tree_member_count) || Number(proof.process_tree_member_count) < 1
      || !validAdapterCleanupEvidence(proof.adapter_cleanup)
      || proof.adapter_cleanup.treeScanStatus !== "verified"
      || proof.adapter_cleanup.close.treeScanStatus !== "verified") {
      throw new LifecycleGateError("worker_cleanup_proof_invalid");
    }
    return proof as unknown as CandidateExecutionCleanupProof;
  }
  if (proof.source === "zcode_app_server_adapter") {
    if (proof.method === "adapter_not_started") {
      if (Object.keys(proof).sort().join("|")
        !== "complete|contract|managed_browser_cleanup_verified|method|reason|source|workspace_retained"
        || proof.reason !== "start_plan_preflight_rejected") {
        throw new LifecycleGateError("worker_cleanup_proof_invalid");
      }
      return proof as unknown as CandidateExecutionCleanupProof;
    }
    if (Object.keys(proof).sort().join("|")
      !== "adapter_cleanup|adapter_process_id|adapter_start_fingerprint|complete|contract|managed_browser_cleanup_verified|method|process_tree_member_count|process_tree_receipt_digest|source|workspace_retained"
      || proof.method !== "identity_bound_windows_tree_cleanup"
      || !Number.isSafeInteger(proof.adapter_process_id) || Number(proof.adapter_process_id) < 1
      || typeof proof.adapter_start_fingerprint !== "string" || proof.adapter_start_fingerprint.length === 0
      || typeof proof.process_tree_receipt_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(proof.process_tree_receipt_digest)
      || !Number.isSafeInteger(proof.process_tree_member_count) || Number(proof.process_tree_member_count) < 1
      || !validAdapterCleanupEvidence(proof.adapter_cleanup)) {
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

function validAdapterCleanupEvidence(value: unknown): value is Readonly<{
  readonly contract: "adapter-cleanup-v1";
  readonly close: Readonly<{
    readonly status: "resolved" | "rejected";
    readonly stage: string;
    readonly errorName?: string;
    readonly errorCode?: string;
    readonly managerProcessCountAfter?: number;
    readonly treeScanStatus: "verified" | "live" | "incomplete" | "not_applicable";
  }>;
  readonly treeScanStatus: "verified" | "live" | "incomplete" | "not_applicable";
}> {
  const evidence = asRecord(value);
  const close = asRecord(evidence.close);
  const scanStatuses = new Set(["verified", "live", "incomplete", "not_applicable"]);
  const stages = new Set([
    "not_started",
    "direct_close",
    "official_manager_dispose",
    "official_manager_dispose_all",
    "official_manager_workspace_dispose",
  ]);
  const boundedToken = (item: unknown): item is string =>
    typeof item === "string"
    && item.length > 0
    && item.length <= 120
    && /^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(item);
  const evidenceKeys = ["contract", "close", "treeScanStatus"];
  const closeKeys = ["status", "stage", "treeScanStatus"];
  if (close.errorName !== undefined) closeKeys.push("errorName");
  if (close.errorCode !== undefined) closeKeys.push("errorCode");
  if (close.managerProcessCountAfter !== undefined) closeKeys.push("managerProcessCountAfter");
  return Object.keys(evidence).sort().join("|") === evidenceKeys.sort().join("|")
    && Object.keys(close).sort().join("|") === closeKeys.sort().join("|")
    && evidence.contract === "adapter-cleanup-v1"
    && ["resolved", "rejected"].includes(String(close.status))
    && typeof close.stage === "string"
    && stages.has(close.stage)
    && scanStatuses.has(String(close.treeScanStatus))
    && scanStatuses.has(String(evidence.treeScanStatus))
    && (close.errorName === undefined || boundedToken(close.errorName))
    && (close.errorCode === undefined || boundedToken(close.errorCode))
    && (close.managerProcessCountAfter === undefined
      || Number.isSafeInteger(close.managerProcessCountAfter)
        && Number(close.managerProcessCountAfter) >= 0)
    && (!close.stage.startsWith("official_")
      || Number.isSafeInteger(close.managerProcessCountAfter));
}

function trustedExecutionCleanupProof(
  proof: CandidateExecutionCleanupProof | null,
  testOnlyFakeAdapter: boolean,
): CandidateExecutionCleanupProof | null {
  if (!proof) return null;
  if (testOnlyFakeAdapter) return proof.source === "explicit_test_fake" ? proof : null;
  return proof.source === "zcode_app_server_adapter"
    && proof.complete === true
    && proof.managed_browser_cleanup_verified === true
    && proof.workspace_retained === true
    && (proof.method === "identity_bound_windows_tree_cleanup"
      || proof.method === "verified_recorded_tree_scan"
      || proof.method === "adapter_not_started" && proof.reason === "start_plan_preflight_rejected")
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
    || operation.phase !== "reserved" || operation.workspace_ref !== taskExecutionWorkspace(input.task)) {
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
    workspace_ref: taskExecutionWorkspace(input.task),
    authorization_source: "trusted_local_policy" as const,
    policy_revision: evidence.policy_revision,
    policy_digest: evidence.policy_digest,
    execution_profile_id: evidence.execution_profile_id,
  };
  return { ...base, policy_snapshot_digest: deriveAdmissionPolicySnapshotDigest(base) };
}

function taskExecutionWorkspace(task: CandidateTaskPackage): string {
  return task.worktree_path ?? task.workspace;
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

/** Extracts a sanitized entitlement rejection classification from the
 * production issuer's `start_plan_entitlement_rejected:<status>[:<code>]`
 * errors. Arbitrary error text is never echoed; unknown failures map to
 * transport_unavailable without leaking message content. */
function classifyStartPlanEntitlementRejection(error: unknown): { classification: string; provider_code?: string } {
  const message = error instanceof Error ? error.message : "";
  const match = /^start_plan_entitlement_rejected:([a-z_]+)(?::([0-9A-Za-z_.-]{1,32}))?$/u.exec(message);
  if (match && match[1]) return { classification: match[1], ...(match[2] ? { provider_code: match[2] } : {}) };
  return { classification: "transport_unavailable" };
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
