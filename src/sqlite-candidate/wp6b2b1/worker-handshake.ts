/** Isolated untrusted Worker handshake gate. Production Worker protocol is unchanged. */
import {
  verifyWorkerAgainstLaunchReceipt,
  type TrustedLaunchIdentity,
} from "./launch-identity.js";
import type { ProcessProbe } from "../../runtime/process-probe.js";
import type { AdmissionPolicySnapshot } from "./launch-bootstrap.js";

export interface PersistedLaunchOperation {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly phase: string;
  readonly launch_id: string | null;
  readonly launch_epoch: number | null;
  readonly launch_receipt_id: string | null;
  readonly launch_receipt_digest: string | null;
  readonly launch_identity_json: string | null;
  readonly claim_id: string | null;
  readonly claim_worker_identity_json: string | null;
}

export interface WorkerReportedIdentity {
  readonly worker_id: string;
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly launch_id: string;
  readonly launch_epoch: number;
  readonly generation: number;
  readonly process_id: number;
  readonly start_fingerprint: string;
  readonly authorization_source?: "trusted_local_policy";
  readonly workspace_ref?: string;
  readonly policy_revision?: string;
  readonly policy_digest?: string;
  readonly execution_profile_id?: string;
  readonly execution_mode?: "build";
  readonly unrestricted?: false;
  readonly policy_snapshot_digest?: string;
  readonly provenance_digest?: string;
}

export interface ClaimStore {
  commitPermanentClaim(input: {
    readonly operation_id: string;
    readonly task_id: string;
    readonly attempt: number;
    readonly generation: number;
    readonly revision: number;
    readonly launch_id: string;
    readonly launch_epoch: number;
    readonly launch_token: string;
    readonly policy_snapshot_digest?: string;
    readonly claim_id: string;
    readonly worker_identity: NonNullable<Awaited<ReturnType<typeof verifyWorkerAgainstLaunchReceipt>>>;
  }): unknown;
}

export type ClaimGateResult =
  | { readonly state: "claim_rejected"; readonly reason: "receipt_missing" | "launch_mismatch" | "worker_report_mismatch" | "os_identity_unverified" | "claim_cas_rejected" }
  | { readonly state: "claim_committed"; readonly result: unknown };

/**
 * Worker claims are committed only after Manager-side OS probing ties the
 * reported PID to the persisted Receipt. Worker-reported PID/fingerprint alone
 * cannot construct a trusted identity or call the Store.
 */
export async function verifyHandshakeAndCommitClaim(
  store: ClaimStore,
  operation: PersistedLaunchOperation,
  report: WorkerReportedIdentity,
  launchToken: string,
  claimId: string,
  probe: ProcessProbe,
  expectedPolicySnapshot?: AdmissionPolicySnapshot,
  expectedProvenanceDigest?: string,
  onStage?: (stage: string) => void,
): Promise<ClaimGateResult> {
  const firstClaim = operation.phase === "launch_intent" && operation.claim_id === null;
  const idempotentClaim = operation.phase === "running" && operation.claim_id !== null;
  if (!operation.launch_id || !operation.launch_epoch || !operation.launch_receipt_id
    || !operation.launch_receipt_digest || !operation.launch_identity_json
    || (!firstClaim && !idempotentClaim)) return { state: "claim_rejected", reason: "receipt_missing" };
  if (report.operation_id !== operation.operation_id || report.task_id !== operation.task_id
    || report.attempt !== operation.attempt || report.launch_id !== operation.launch_id
    || report.launch_epoch !== operation.launch_epoch || report.generation !== operation.generation) {
    return { state: "claim_rejected", reason: "launch_mismatch" };
  }

  if (expectedPolicySnapshot) {
    const expected = expectedPolicySnapshot;
    if (expected.operation_id !== operation.operation_id || expected.task_id !== operation.task_id
      || expected.attempt !== operation.attempt || expected.generation !== operation.generation
      || report.authorization_source !== expected.authorization_source || report.workspace_ref !== expected.workspace_ref
      || report.policy_revision !== expected.policy_revision || report.policy_digest !== expected.policy_digest
      || report.execution_profile_id !== expected.execution_profile_id
      || report.policy_snapshot_digest !== expected.policy_snapshot_digest || report.execution_mode !== "build"
      || report.unrestricted !== false || !/^[0-9a-f]{64}$/u.test(expectedProvenanceDigest ?? "")
      || report.provenance_digest !== expectedProvenanceDigest) {
      return { state: "claim_rejected", reason: "worker_report_mismatch" };
    }
    onStage?.("worker_policy_snapshot_verified");
  }
  onStage?.("worker_report_coordinates_verified");

  let launchIdentity: TrustedLaunchIdentity;
  try {
    launchIdentity = JSON.parse(operation.launch_identity_json) as TrustedLaunchIdentity;
  } catch {
    return { state: "claim_rejected", reason: "receipt_missing" };
  }
  if (launchIdentity.source !== "manager_os_spawn_observation" || launchIdentity.fixture !== false
    || launchIdentity.launch_id !== operation.launch_id || launchIdentity.generation !== operation.generation
    || report.process_id !== launchIdentity.process_id || report.start_fingerprint !== launchIdentity.start_fingerprint) {
    return { state: "claim_rejected", reason: "worker_report_mismatch" };
  }

  const workerIdentity = await verifyWorkerAgainstLaunchReceipt(report.worker_id, report.process_id, launchIdentity, probe);
  if (!workerIdentity) return { state: "claim_rejected", reason: "os_identity_unverified" };
  onStage?.("worker_os_identity_verified");

  let identityForStore = workerIdentity;
  if (idempotentClaim) {
    if (!operation.claim_worker_identity_json) return { state: "claim_rejected", reason: "claim_cas_rejected" };
    try {
      const persisted = JSON.parse(operation.claim_worker_identity_json) as typeof workerIdentity;
      if (persisted.source !== "manager_verified_process_probe" || persisted.fixture !== false
        || persisted.worker_id !== workerIdentity.worker_id || persisted.process_id !== workerIdentity.process_id
        || persisted.start_fingerprint !== workerIdentity.start_fingerprint || persisted.platform !== "win32"
        || persisted.fingerprint_precision !== "exact") return { state: "claim_rejected", reason: "worker_report_mismatch" };
      identityForStore = persisted;
    } catch {
      return { state: "claim_rejected", reason: "claim_cas_rejected" };
    }
  }

  try {
    onStage?.("claim_commit_start");
    const result = store.commitPermanentClaim({
      operation_id: operation.operation_id,
      task_id: operation.task_id,
      attempt: operation.attempt,
      generation: operation.generation,
      revision: operation.revision,
      launch_id: operation.launch_id,
      launch_epoch: operation.launch_epoch,
      launch_token: launchToken,
      claim_id: claimId,
      worker_identity: identityForStore,
    });
    onStage?.("claim_commit_complete");
    return { state: "claim_committed", result };
  } catch {
    return { state: "claim_rejected", reason: "claim_cas_rejected" };
  }
}
