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

export interface CandidateOperationIdentity {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly launch_id: string;
  readonly launch_epoch: number;
  readonly launch_token: string;
}

export type CandidateResultStatus = 'completed' | 'failed' | 'cancelled' | 'waiting_for_master';

export interface CandidateTaskResult {
  readonly task_id: string;
  readonly attempt: number;
  readonly status: CandidateResultStatus;
  readonly summary: string;
  readonly files_changed: readonly string[];
  readonly tests: readonly Readonly<{ command: string; status: 'passed' | 'failed' | 'not_run'; details?: string }>[];
  readonly issues: readonly string[];
  readonly needs_master_decision: boolean;
  readonly zcode_output: string;
  readonly exit_code: number | null;
  readonly session_id: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly error_code?: string;
  readonly report_candidate?: Readonly<Record<string, unknown>>;
  readonly usage?: Readonly<Record<string, unknown>> | null;
  readonly model?: Readonly<Record<string, unknown>> | null;
  readonly timing?: Readonly<Record<string, unknown>> | null;
}

export interface CandidateResultCommitInput {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly claim_id: string;
  readonly claim_worker_identity_digest: string;
  readonly result_status: CandidateResultStatus;
  readonly result: CandidateTaskResult;
  /** Required only when a cancelled Result follows a persisted, verified cancellation intent. */
  readonly cancel_verification_digest?: string;
}

export interface CandidateResultCommitOutcome {
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

export interface CandidateLifecycleEvent {
  readonly event_cursor?: number;
  readonly operation_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly from_phase: string | null;
  readonly to_phase: string;
  readonly generation: number | null;
  readonly evidence_json: string;
  readonly evidence_digest: string;
  readonly at: string;
}

export interface CandidateTaskLifecycleEvent extends Omit<CandidateLifecycleEvent, 'sequence'> {
  /** Task-wide stream sequence; equal to the stable database-wide cursor. */
  readonly sequence: number;
  readonly cursor: number;
  /** Operation-local revision sequence, retained only for lifecycle auditing. */
  readonly operation_sequence: number;
  readonly task_id: string;
  readonly operation_attempt: number;
}

export interface CandidateTaskLifecycleEventsPage {
  readonly events: readonly CandidateTaskLifecycleEvent[];
  /** Last returned task-wide cursor, or the input cursor for an empty page. */
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export interface CandidateTaskLifecycleSnapshot {
  readonly task: CandidateTaskPackage;
  readonly projection: Readonly<{ task_id: string; status: string; current_attempt: number; created_at: string }>;
  readonly attempt: Readonly<{ task_id: string; attempt: number; generation: number | null; status: string; created_at: string }>;
  readonly operation: Readonly<Record<string, unknown>> | null;
  readonly result: CandidateTaskResult | null;
  readonly continuation: CandidateContinuationEnvelope | null;
}

export interface CandidateTaskFeedbackSnapshot {
  readonly schema_version: '0.1';
  readonly task_id: string;
  readonly attempt: number;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_for_master';
  readonly model: null;
  readonly phase: null;
  readonly progress: null;
  readonly activity: null;
  readonly interaction: Readonly<{ readonly state: 'not_observed'; readonly kind: null }>;
  readonly result: null;
}

export interface CandidateContinuationEnvelope {
  readonly contract: 'wp6b2b-continue-v1';
  readonly operation_id: string;
  readonly task_id: string;
  readonly feedback: string;
  readonly additional_requirements: readonly string[];
  readonly previous_attempt: number;
  readonly previous_operation_id: string;
  readonly previous_generation: number;
  readonly previous_revision: number;
  readonly previous_claim_id: string;
  readonly previous_worker_identity_digest: string;
}

export interface CandidateContinueAttemptInput {
  readonly operation_id?: string;
  readonly task_id: string;
  /** Required for a new Continue key; ignored when replaying an existing key. */
  readonly previous_attempt?: number;
  /** Required for a new Continue key; ignored when replaying an existing key. */
  readonly previous_operation_id?: string;
  /** Required for a new Continue key; ignored when replaying an existing key. */
  readonly expected_generation?: number;
  /** Required for a new Continue key; ignored when replaying an existing key. */
  readonly expected_revision?: number;
  /** Required for a new Continue key; ignored when replaying an existing key. */
  readonly claim_id?: string;
  /** Required for a new Continue key; ignored when replaying an existing key. */
  readonly claim_worker_identity_digest?: string;
  readonly feedback: string;
  readonly additional_requirements?: readonly string[];
}

export interface CandidateContinueAttemptOutcome {
  /** The requested idempotency key, or a generated key for non-idempotent public calls. */
  readonly duplicate: boolean;
  /** Continue idempotency key; this is not the future scheduler-created lifecycle Operation id. */
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly status: 'queued';
  readonly created_at: string;
}

export interface CandidateInteractionRequestInput {
  readonly method: 'interaction/requestPermission' | 'interaction/requestUserInput';
  readonly params: Readonly<Record<string, unknown>>;
  readonly request_id: string;
}

export interface CandidateInteractionReplyInput {
  readonly task_id: string;
  readonly request_id: string;
  readonly decision: 'allow' | 'deny' | 'accept' | 'decline';
  readonly reason?: string;
  readonly answers?: Readonly<Record<string, string>>;
}

export interface CandidateInteractionChannel {
  readonly binding: Readonly<{ operation_id: string; task_id: string; attempt: number; generation: number;
    claim_id: string; worker_identity_digest: string; process_id: number; start_fingerprint: string }>;
  receiveRequest(): Promise<Readonly<{ binding: CandidateInteractionChannel['binding']; request: CandidateInteractionRequestInput }>>;
  prepareReply(reply: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
  commitReply(reply: Readonly<Record<string, unknown>>, commit: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

export interface CandidateCommittedResult {
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

export type CandidateRecoveryDecision = 'hold' | 'complete' | 'blocked_read_only' | 'quarantine_read_only';
export type CandidateRecoveryCleanupState = 'not_applicable' | 'unknown' | 'unverified' | 'verified';

export interface CandidateRecoveryOperation {
  readonly operation_id: string;
  readonly task_id: string | null;
  readonly attempt: number | null;
  readonly generation: number | null;
  readonly revision: number;
  readonly phase: string;
  readonly recovery_decision: CandidateRecoveryDecision;
  readonly recovery_classification: 'normal' | 'hold' | 'quarantine';
  readonly recovery_observation_count: number;
  readonly recovery_blockers: readonly string[];
  readonly claim_permanent: boolean;
  readonly capacity_occupied: boolean;
  readonly cleanup_state: CandidateRecoveryCleanupState;
}

export interface CandidateRecoverySnapshot {
  readonly schema_version: 3;
  readonly root_status: 'consistent_read_only' | 'blocked_read_only' | 'quarantined_read_only' | 'unavailable_read_only';
  readonly root_blockers: readonly string[];
  readonly capacity: Readonly<Record<string, unknown>> | null;
  readonly operations: readonly CandidateRecoveryOperation[];
  readonly events: readonly CandidateLifecycleEvent[];
  readonly verified_event_projection_consistency: boolean;
  readonly writes_allowed: false;
  readonly cleanup_performed: false;
  readonly claim_release_performed: false;
  readonly operation_release_performed: false;
}

export interface CandidateCleanupFence {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly claim_id: string;
  readonly claim_worker_identity_digest: string;
}

export interface CandidateCancellationFence {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly claim_id: string;
  readonly claim_worker_identity_digest: string;
  readonly worker_identity: Readonly<Record<string, unknown>>;
}

export interface CandidateQueuedCancelInput {
  readonly task_id: string;
  readonly expected_attempt: number;
}

export interface CandidateQueuedCancelOutcome {
  readonly duplicate: boolean;
  readonly task_id: string;
  readonly attempt: number;
  readonly status: 'cancelled';
  readonly cancel_id: string;
  readonly event_cursor: number;
  readonly operation_id: string | null;
}

export type CandidateWorkerIdentityVerifier = (context: Readonly<{
  operation: Readonly<Record<string, unknown>>;
  worker_identity: Readonly<Record<string, unknown>>;
  evidence: Readonly<Record<string, unknown>>;
}>) => Readonly<{ state: 'alive' | 'exited'; worker_identity_digest: string; evidence_digest: string }> | false;

export type CandidateCancellationVerifier = (context: Readonly<{
  operation: Readonly<Record<string, unknown>>;
  cancel_intent: Readonly<Record<string, unknown>>;
  worker_identity: Readonly<Record<string, unknown>>;
  evidence: Readonly<Record<string, unknown>>;
}>) => Readonly<{ state: 'verified'; worker_identity_digest: string; process_tree_digest: string; root_process_id: number;
  root_start_fingerprint: string; worker_tree_complete: true; evidence_digest: string }> | false;

export interface CandidateCancellationOutcome {
  readonly duplicate: boolean;
  readonly result_won: boolean;
  readonly operation_id: string;
  readonly generation: number;
  readonly revision: number;
  readonly phase: string;
  readonly cancel_id?: string;
  readonly cancellation_verification_digest?: string;
  readonly result_status?: CandidateResultStatus;
}

export type CandidateCleanupEvidence = Readonly<{
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly claim_id: string;
  readonly worker_identity_digest: string;
  readonly launch_receipt_digest: string;
  readonly result_commit_ref: string;
  readonly process_tree_digest: string;
  readonly resources_digest: string;
  readonly root_process_id: number;
  readonly root_start_fingerprint: string;
  readonly worker_tree_complete: true;
  readonly operation_resources_complete: true;
  readonly workspace_touched: false;
}> & (
  | Readonly<{ readonly source: 'synthetic_fixture'; readonly fixture: true }>
  | Readonly<{ readonly source: 'manager_os_cleanup_verification'; readonly fixture: false }>
);

export type CandidateCleanupOutcome =
  | Readonly<{ readonly outcome: 'verified'; readonly cleanup_evidence: CandidateCleanupEvidence }>
  | Readonly<{ readonly outcome: 'unverified'; readonly probe_state: 'alive' | 'unknown' | 'identity_mismatch' | 'incomplete'; readonly reason: string }>;

export interface CandidateRecoveryObservationInput {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly expected_revision: number;
  readonly claim_id: string;
  readonly worker_identity_digest: string;
  readonly classification: 'hold' | 'quarantine';
  readonly reason_code: 'worker_identity_unknown' | 'launch_outcome_unknown' | 'cleanup_identity_unknown' | 'cleanup_incomplete' | 'claim_identity_conflict' | 'operation_projection_conflict';
  readonly evidence_source: 'manager_process_probe' | 'manager_launch_probe' | 'manager_cleanup_probe' | 'manager_projection_validator';
  readonly evidence_digest: string;
}

export interface CandidateRecoveryEvidenceVerificationContext {
  readonly operation: Readonly<{ readonly operation_id: string; readonly task_id: string; readonly attempt: number; readonly generation: number;
    readonly phase: string; readonly revision: number; readonly claim_id: string; readonly worker_identity_digest: string }>;
  readonly observation: CandidateRecoveryObservationInput;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export type CandidateRecoveryEvidenceVerifier = (context: CandidateRecoveryEvidenceVerificationContext) => Readonly<{
  readonly classification: 'hold' | 'quarantine';
  readonly reason_code: CandidateRecoveryObservationInput['reason_code'];
  readonly evidence_source: CandidateRecoveryObservationInput['evidence_source'];
  readonly evidence_digest: string;
}> | false;

export interface SqliteLifecyclePort {
  createTask(task: CandidateTaskPackage, createdAt?: string): { task_id: string; current_attempt: 1; status: 'queued'; created_at: string };
  readTask(taskId: string): CandidateTaskPackage | null;
  readTaskProjection(taskId: string): { task_id: string; status: string; current_attempt: number; created_at: string } | null;
  readAttempt(taskId: string, attempt: number): { task_id: string; attempt: number; generation: number | null; status: string; created_at: string } | null;
  readTaskLifecycle(taskId: string): CandidateTaskLifecycleSnapshot | null;
  readRecoverableQueuedAttempts(): readonly Readonly<{
    readonly task: CandidateTaskPackage;
    readonly task_id: string;
    readonly attempt: number;
    readonly generation: number | null;
    readonly operation_id: string | null;
    readonly phase: string | null;
    readonly dispatchable: boolean;
    readonly reason: string | null;
  }>[];
  readTaskEvents(taskId: string, options?: { readonly afterCursor?: number; readonly limit?: number }): CandidateTaskLifecycleEventsPage;
  readTaskFeedback(taskId: string): CandidateTaskFeedbackSnapshot | null;
  provisionCapacity(input: unknown): unknown;
  assertCapacityPolicy(limit: number): unknown;
  admitOperation(input: unknown, gates: unknown): unknown;
  readOperation(operationId: string): unknown;
  createLaunchIntent(input: CandidateOperationIdentity): unknown;
  recordLaunchReceipt(input: CandidateOperationIdentity & { readonly receipt_id: string; readonly launch_identity: unknown }): unknown;
  commitPermanentClaim(input: CandidateOperationIdentity & { readonly claim_id: string; readonly worker_identity: unknown }): unknown;
  createNextAttempt(input: CandidateContinueAttemptInput, gates: { readonly workspaceValidator: (input: { readonly requestedPath: string; readonly canonicalPath: string }) => unknown; readonly executionPermissionCheck: (context: { readonly workspace: string; readonly task: CandidateContinueAttemptInput & { readonly task: CandidateTaskPackage } }) => unknown }): CandidateContinueAttemptOutcome;
  readLifecycleEvents(operationId: string, options?: { readonly afterSequence?: number; readonly limit?: number }): CandidateLifecycleEvent[];
  appendLifecycleEvent(...args: never[]): never;
  readLifecycleStatus(...args: never[]): never;
  writeLifecycleStatus(...args: never[]): never;
  commitResult(input: CandidateResultCommitInput): CandidateResultCommitOutcome;
  readCommittedResult(operationId: string): CandidateCommittedResult | null;
  beginCleanup(input: CandidateCleanupFence): { readonly duplicate: boolean; readonly operation_id: string; readonly generation: number; readonly revision: number; readonly phase: 'cleanup_pending' };
  recordCleanupEvidence(input: CandidateCleanupFence & CandidateCleanupOutcome): { readonly duplicate: boolean; readonly operation_id: string; readonly generation: number; readonly revision: number; readonly phase: 'cleanup_verified' | 'cleanup_unverified' | 'released'; readonly cleanup_verified: boolean; readonly cleanup_digest?: string };
  reverifyCleanup(input: CandidateCleanupFence & { readonly cleanup_evidence: CandidateCleanupEvidence }): { readonly duplicate: boolean; readonly operation_id: string; readonly task_id: string; readonly attempt: number; readonly generation: number; readonly claim_id: string; readonly revision: number; readonly event_sequence: number; readonly phase: 'cleanup_verified' | 'released'; readonly cleanup_verified: true; readonly cleanup_digest: string; readonly resolved_recovery_event_digests: readonly string[] };
  releaseCapacity(input: CandidateCleanupFence & { readonly cleanup_digest: string }): { readonly duplicate: boolean; readonly operation_id: string; readonly generation: number; readonly revision: number; readonly phase: 'released'; readonly capacity_released: true };
  requestCancellation(input: CandidateCancellationFence, evidence: Readonly<Record<string, unknown>>): CandidateCancellationOutcome;
  recordCancellationVerification(input: CandidateCancellationFence, evidence: Readonly<Record<string, unknown>>): CandidateCancellationOutcome;
  cancelQueuedAttempt(input: CandidateQueuedCancelInput): CandidateQueuedCancelOutcome;
  openInteractionChannel(child: object, operation: Readonly<Record<string, unknown>>, verifyProcessIdentity: (context: unknown) => Promise<unknown>): Promise<CandidateInteractionChannel>;
  receiveInteractionRequest(channel: CandidateInteractionChannel): Promise<Readonly<Record<string, unknown>>>;
  replyToInteractionRequest(input: CandidateInteractionReplyInput, channel: CandidateInteractionChannel): Promise<Readonly<Record<string, unknown>>>;
  readInteractionRequest(taskId: string, requestId: string): Readonly<Record<string, unknown>> | null;
  readRecoverySnapshot(): CandidateRecoverySnapshot;
  recordRecoveryObservation(input: CandidateRecoveryObservationInput, evidence: Readonly<Record<string, unknown>>): unknown;
  recoverOperation(...args: never[]): never;
}

export class UnsupportedLifecycleOperationError extends Error {
  readonly code: 'lifecycle_operation_unsupported';
  readonly operation: string;
}

export function createSqliteLifecyclePort(store: object, options?: { readonly recoveryEvidenceVerifier?: CandidateRecoveryEvidenceVerifier;
  readonly workerIdentityVerifier?: CandidateWorkerIdentityVerifier; readonly cancellationVerifier?: CandidateCancellationVerifier }): SqliteLifecyclePort;
