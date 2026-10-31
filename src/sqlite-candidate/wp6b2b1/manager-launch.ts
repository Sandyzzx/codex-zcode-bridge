/** Isolated Manager Spawn/Receipt seam. It is not imported by production composition. */
import { randomUUID } from "node:crypto";
import {
  observeTrustedLaunchIdentity,
  type TrustedLaunchIdentity,
} from "./launch-identity.js";
import type { ProcessProbe } from "../../runtime/process-probe.js";

export interface SpawnObservationChild {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  readonly exitSeen?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface LaunchRequest {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly launch_id: string;
  readonly launch_epoch: number;
  readonly launch_token: string;
}

export interface LaunchIntentResult {
  readonly duplicate?: boolean;
  readonly revision: number;
  readonly phase: string;
  readonly process_started?: string;
}

export interface LaunchReceiptResult {
  readonly duplicate?: boolean;
  readonly revision: number;
  readonly phase: string;
  readonly synthetic: boolean;
}

export interface LaunchLifecycleStore {
  createLaunchIntent(request: LaunchRequest): LaunchIntentResult;
  recordLaunchReceipt(request: LaunchRequest & {
    readonly revision: number;
    readonly receipt_id: string;
    readonly launch_identity: TrustedLaunchIdentity;
  }): LaunchReceiptResult;
}

export type CandidateSpawn = () => SpawnObservationChild | Promise<SpawnObservationChild>;

export type LaunchOnceResult =
  | { readonly state: "intent_rejected"; readonly reason: "intent_write_failed" }
  | { readonly state: "launch_outcome_unknown"; readonly reason: "duplicate_intent" | "spawn_threw" | "identity_unavailable" | "receipt_write_failed"; readonly intent: LaunchIntentResult; readonly child?: SpawnObservationChild }
  | { readonly state: "receipt_persisted"; readonly intent: LaunchIntentResult; readonly receipt: LaunchReceiptResult; readonly identity: TrustedLaunchIdentity; readonly child: SpawnObservationChild };

/**
 * Persists Intent first, then invokes Spawn outside any Store transaction.
 * This function makes exactly one Spawn invocation per call. A repeated Intent
 * is treated as an unknown prior launch and never authorizes a second Spawn.
 */
export async function launchOnce(
  store: LaunchLifecycleStore,
  request: LaunchRequest,
  spawnChild: CandidateSpawn,
  probe: ProcessProbe,
): Promise<LaunchOnceResult> {
  let intent: LaunchIntentResult;
  try {
    intent = store.createLaunchIntent(request);
  } catch {
    return { state: "intent_rejected", reason: "intent_write_failed" };
  }
  if (intent.duplicate) return { state: "launch_outcome_unknown", reason: "duplicate_intent", intent };

  let child: SpawnObservationChild;
  try {
    child = await spawnChild();
  } catch {
    return { state: "launch_outcome_unknown", reason: "spawn_threw", intent };
  }

  const identity = await observeTrustedLaunchIdentity(child, probe, request.launch_id, request.generation);
  if (!identity) return { state: "launch_outcome_unknown", reason: "identity_unavailable", intent, child };

  try {
    const receipt = store.recordLaunchReceipt({
      ...request,
      revision: intent.revision,
      receipt_id: randomUUID(),
      launch_identity: identity,
    });
    return { state: "receipt_persisted", intent, receipt, identity, child };
  } catch {
    // The process may exist even when Receipt persistence is unknown. Keep the
    // child handle and Intent evidence; never turn this into a Spawn retry.
    return { state: "launch_outcome_unknown", reason: "receipt_write_failed", intent, child };
  }
}
