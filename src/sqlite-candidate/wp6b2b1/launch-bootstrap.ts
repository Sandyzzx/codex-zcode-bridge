/**
 * Private, one-shot detached Worker bootstrap. Manager retains the authoritative
 * token value for Claim CAS. Bounded non-secret launch coordinates plus the
 * exact Manager-issued token cross the
 * inherited child-only pipe (fd 3). The received fields remain untrusted and
 * never replace Manager OS probing or Store token-digest validation.
 */
import type { Writable } from "node:stream";
import { createHash } from "node:crypto";
import type { LaunchRequest } from "./manager-launch.js";
import type { SpawnObservationChild } from "./manager-launch.js";

export interface LaunchBootstrap {
  readonly protocol: "bridge-launch-bootstrap-v1";
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly launch_id: string;
  readonly launch_epoch: number;
  readonly launch_token: string;
  readonly authorization_source: "trusted_local_policy";
  readonly workspace_ref: string;
  readonly policy_revision: string;
  readonly policy_digest: string;
  readonly execution_profile_id: string;
  readonly policy_snapshot_digest: string;
}

export interface AdmissionPolicySnapshot {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly workspace_ref: string;
  readonly authorization_source: "trusted_local_policy";
  readonly policy_revision: string;
  readonly policy_digest: string;
  readonly execution_profile_id: string;
  readonly policy_snapshot_digest: string;
}

export type LaunchBootstrapSource = Pick<LaunchRequest,
  "operation_id" | "task_id" | "attempt" | "generation" | "launch_id" | "launch_epoch" | "launch_token"> & {
    readonly policy_snapshot: AdmissionPolicySnapshot;
  };

export interface PrivateBootstrapChild extends SpawnObservationChild {
  readonly bootstrapChannel: Writable | null;
}

export type SpawnBootstrapResult =
  | { readonly state: "bootstrap_sent"; readonly child: PrivateBootstrapChild }
  | { readonly state: "launch_outcome_unknown"; readonly reason: "spawn_threw" | "private_channel_unavailable" | "private_channel_failed"; readonly child?: PrivateBootstrapChild };

const KEYS = ["attempt", "authorization_source", "execution_profile_id", "generation", "launch_epoch", "launch_id", "launch_token", "operation_id", "policy_digest", "policy_revision", "policy_snapshot_digest", "protocol", "task_id", "workspace_ref"] as const;
const MAX_FRAME_BYTES = 8_192;

/** Explicit projection sends only the Manager-issued token, never a Worker field. */
export function createLaunchBootstrap(source: LaunchBootstrapSource): LaunchBootstrap {
  const snapshot = source.policy_snapshot;
  const bootstrap: LaunchBootstrap = {
    protocol: "bridge-launch-bootstrap-v1",
    operation_id: source.operation_id,
    task_id: source.task_id,
    attempt: source.attempt,
    generation: source.generation,
    launch_id: source.launch_id,
    launch_epoch: source.launch_epoch,
    launch_token: source.launch_token,
    authorization_source: snapshot.authorization_source,
    workspace_ref: snapshot.workspace_ref,
    policy_revision: snapshot.policy_revision,
    policy_digest: snapshot.policy_digest,
    execution_profile_id: snapshot.execution_profile_id,
    policy_snapshot_digest: snapshot.policy_snapshot_digest,
  };
  validate(bootstrap);
  return bootstrap;
}

/** Strict allowlist serializer; unexpected Worker-reported fields fail closed. */
export function encodeLaunchBootstrap(value: unknown): Buffer {
  validate(value);
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (frame.byteLength > MAX_FRAME_BYTES) throw new TypeError("launch bootstrap exceeds frame limit");
  return frame;
}

/** Decode one complete newline framed message and reject trailing/extra fields. */
export function decodeLaunchBootstrap(frame: Uint8Array | string): LaunchBootstrap {
  const bytes = typeof frame === "string" ? Buffer.from(frame, "utf8") : Buffer.from(frame);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES || bytes.at(-1) !== 0x0a
    || bytes.subarray(0, -1).includes(0x0a)) throw new TypeError("invalid launch bootstrap frame");
  const payload = bytes.subarray(0, -1);
  const text = payload.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(payload)) throw new TypeError("invalid launch bootstrap UTF-8");
  const value: unknown = JSON.parse(text);
  validate(value);
  return value;
}

/** Send one bootstrap frame on the bound child's private fd 3 pipe, then close it. */
export function writeLaunchBootstrap(channel: Writable, source: LaunchBootstrapSource): Promise<void> {
  const frame = encodeLaunchBootstrap(createLaunchBootstrap(source));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      channel.removeListener("error", onError);
      channel.removeListener("finish", onFinish);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    const onFinish = (): void => finish();
    channel.once("error", onError);
    channel.once("finish", onFinish);
    try {
      channel.end(frame);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Invoke Spawn once and retain its child handle even if private bootstrap
 * delivery is uncertain. The caller may not retry Spawn for this Intent.
 */
export async function spawnAndBootstrapOnce(
  spawnChild: () => PrivateBootstrapChild | Promise<PrivateBootstrapChild>,
  source: LaunchBootstrapSource,
): Promise<SpawnBootstrapResult> {
  let child: PrivateBootstrapChild;
  try {
    child = await spawnChild();
  } catch {
    return { state: "launch_outcome_unknown", reason: "spawn_threw" };
  }
  if (!child.bootstrapChannel) return { state: "launch_outcome_unknown", reason: "private_channel_unavailable", child };
  try {
    await writeLaunchBootstrap(child.bootstrapChannel, source);
    return { state: "bootstrap_sent", child };
  } catch {
    return { state: "launch_outcome_unknown", reason: "private_channel_failed", child };
  }
}

function validate(value: unknown): asserts value is LaunchBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid launch bootstrap");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...KEYS].sort().join("\0")
    || record.protocol !== "bridge-launch-bootstrap-v1"
    || !validId(record.operation_id) || !validId(record.task_id) || !validId(record.launch_id)
    || !validToken(record.launch_token)
    || !positive(record.attempt) || !positive(record.generation) || !positive(record.launch_epoch)
    || record.authorization_source !== "trusted_local_policy" || !validWorkspace(record.workspace_ref)
    || !validId(record.policy_revision) || !validDigest(record.policy_digest)
    || !validId(record.execution_profile_id) || !validDigest(record.policy_snapshot_digest)
    || record.policy_snapshot_digest !== deriveAdmissionPolicySnapshotDigest(record as unknown as AdmissionPolicySnapshot)) {
    throw new TypeError("invalid launch bootstrap fields");
  }
}

/** Stable digest over the persisted Admission identity and policy snapshot. */
export function deriveAdmissionPolicySnapshotDigest(value: Omit<AdmissionPolicySnapshot, "policy_snapshot_digest"> | AdmissionPolicySnapshot): string {
  const envelope = {
    contract: "bridge-admission-policy-snapshot-v1",
    operation_id: value.operation_id,
    task_id: value.task_id,
    attempt: value.attempt,
    generation: value.generation,
    workspace_ref: value.workspace_ref,
    authorization_source: value.authorization_source,
    policy_revision: value.policy_revision,
    policy_digest: value.policy_digest,
    execution_profile_id: value.execution_profile_id,
  };
  return createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("invalid admission policy snapshot");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 16
    && Buffer.byteLength(value, "utf8") <= 4_096;
}

function validDigest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function validWorkspace(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\x00-\x1f]/u.test(value); }
