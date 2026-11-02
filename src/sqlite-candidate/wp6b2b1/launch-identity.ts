/** Isolated OS identity observation for WP6B-2B-1. No spawn occurs here. */
import { createHash } from "node:crypto";
import {
  captureSpawnGenerationIdentity,
  childStillOnSpawnGeneration,
  type SpawnGenerationChildState,
} from "../../adapters/process-spawn.js";
import type { ProcessIdentity, ProcessProbe } from "../../runtime/process-probe.js";

export interface TrustedLaunchIdentity {
  readonly source: "manager_os_spawn_observation";
  readonly fixture: false;
  readonly launch_id: string;
  readonly generation: number;
  readonly process_id: number;
  readonly start_fingerprint: string;
  readonly fingerprint_precision: "exact";
  readonly identity_version: number;
  readonly platform: "win32";
  readonly captured_at: string;
  readonly evidence_digest: string;
}

export interface VerifiedWorkerIdentity {
  readonly source: "manager_verified_process_probe";
  readonly fixture: false;
  readonly worker_id: string;
  readonly process_id: number;
  readonly start_fingerprint: string;
  readonly fingerprint_precision: "exact";
  readonly identity_version: number;
  readonly platform: "win32";
  readonly captured_at: string;
  readonly evidence_digest: string;
}

/**
 * Reuses the production Probe and spawn-generation continuity guard. The
 * caller must pass the actual ChildProcess state; PID-only values are refused.
 * Filesystem/DB work and process creation remain outside this function.
 */
export async function observeTrustedLaunchIdentity(
  child: SpawnGenerationChildState,
  probe: ProcessProbe,
  launchId: string,
  generation: number,
): Promise<TrustedLaunchIdentity | null> {
  if (probe.platform !== "win32" || !validText(launchId) || !positive(generation)) return null;
  const captured = await captureSpawnGenerationIdentity(child, probe);
  if (!captured || !childStillOnSpawnGeneration(child) || child.pid !== captured.pid) return null;
  let identity: ProcessIdentity;
  try {
    identity = await probe.identityOf(captured.pid);
  } catch {
    return null;
  }
  if (!childStillOnSpawnGeneration(child) || child.pid !== captured.pid || !exactWindowsIdentity(identity)
    || identity.fingerprint !== captured.fingerprint) return null;
  let verdict;
  try {
    [verdict] = await probe.probe([{ pid: captured.pid, identity }]);
  } catch {
    return null;
  }
  if (!childStillOnSpawnGeneration(child) || verdict?.state !== "alive") return null;
  const evidence = {
    source: "manager_os_spawn_observation" as const,
    fixture: false as const,
    launch_id: launchId,
    generation,
    process_id: captured.pid,
    start_fingerprint: captured.fingerprint,
    fingerprint_precision: "exact" as const,
    identity_version: identity.identity_version,
    platform: "win32" as const,
    captured_at: identity.captured_at,
  };
  return { ...evidence, evidence_digest: digest(evidence) };
}

/** Verify Worker handshake PID against the persisted Receipt and fresh OS evidence. */
export async function verifyWorkerAgainstLaunchReceipt(
  workerId: string,
  reportedPid: number,
  launch: TrustedLaunchIdentity,
  probe: ProcessProbe,
): Promise<VerifiedWorkerIdentity | null> {
  if (!validText(workerId) || probe.platform !== "win32" || reportedPid !== launch.process_id) return null;
  let identity: ProcessIdentity;
  try {
    identity = await probe.identityOf(reportedPid);
  } catch {
    return null;
  }
  if (!exactWindowsIdentity(identity) || identity.fingerprint !== launch.start_fingerprint) return null;
  try {
    const [verdict] = await probe.probe([{ pid: reportedPid, identity }]);
    if (verdict?.state !== "alive") return null;
  } catch {
    return null;
  }
  const evidence = {
    source: "manager_verified_process_probe" as const,
    fixture: false as const,
    worker_id: workerId,
    process_id: identity.pid,
    start_fingerprint: identity.fingerprint,
    fingerprint_precision: "exact" as const,
    identity_version: identity.identity_version,
    platform: "win32" as const,
    captured_at: identity.captured_at,
  };
  return { ...evidence, evidence_digest: digest(evidence) };
}

function exactWindowsIdentity(identity: ProcessIdentity): boolean {
  return identity.platform === "win32" && identity.fingerprint_precision === "exact"
    && Number.isSafeInteger(identity.identity_version) && typeof identity.fingerprint === "string"
    && identity.fingerprint.length > 0 && Number.isSafeInteger(identity.pid) && identity.pid > 0;
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validText(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/u.test(value);
}

function digest(value: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("invalid identity digest input");
}
