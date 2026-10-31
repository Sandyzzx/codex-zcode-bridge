import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface RuntimeArtifactFingerprint {
  readonly path: string | null;
  readonly sha256: string | null;
}

export interface RuntimeBuildProvenance {
  readonly bridge: RuntimeArtifactFingerprint;
  readonly worker: RuntimeArtifactFingerprint;
}

/** Fixed, non-secret launch-mode discriminator appended only by the Bridge
 * spawner. Provenance itself remains an identity consistency check, not an
 * authorization credential. */
export const BRIDGE_WORKER_LAUNCH_MARKER = "--zcode-bridge-launch-v1";

export type WorkerProvenanceErrorCode =
  | "provenance_missing"
  | "provenance_malformed"
  | "provenance_path_mismatch"
  | "provenance_hash_mismatch";

export type WorkerProvenanceCheck =
  | {
      readonly status: "verified";
      readonly expected: RuntimeBuildProvenance;
      readonly actualWorker: RuntimeArtifactFingerprint;
      readonly workerMatchesExpected: true;
    }
  | {
      readonly status: "unverified";
      readonly expected: null;
      readonly actualWorker: RuntimeArtifactFingerprint;
      readonly workerMatchesExpected: false;
      readonly reason: "provenance_unverified_legacy";
    }
  | {
      readonly status: "rejected";
      readonly expected: RuntimeBuildProvenance | null;
      readonly actualWorker: RuntimeArtifactFingerprint;
      readonly workerMatchesExpected: false;
      readonly errorCode: WorkerProvenanceErrorCode;
      readonly reason: string;
    };

/**
 * Verifies the Bridge-to-Worker bootstrap envelope. A missing envelope is a
 * legacy direct launch only when the Bridge's independent argv marker is also
 * absent. If either signal indicates Bridge bootstrap, missing or malformed
 * provenance fails closed. A direct launch that supplies an envelope is
 * verified under the same strict rules.
 */
export function verifyWorkerProvenance(input: {
  readonly bridgeLaunchMarker: boolean;
  readonly rawEnvelope: string | undefined;
  readonly actualWorker: RuntimeArtifactFingerprint;
}): WorkerProvenanceCheck {
  const { bridgeLaunchMarker, rawEnvelope, actualWorker } = input;
  if (rawEnvelope === undefined && !bridgeLaunchMarker) {
    return {
      status: "unverified",
      expected: null,
      actualWorker,
      workerMatchesExpected: false,
      reason: "provenance_unverified_legacy",
    };
  }
  if (rawEnvelope === undefined) {
    return rejected("provenance_missing", "Bridge launch marker was present but the provenance envelope was missing", actualWorker);
  }

  let parsed: unknown;
  try { parsed = JSON.parse(rawEnvelope) as unknown; }
  catch { return rejected("provenance_malformed", "provenance envelope was not valid JSON", actualWorker); }

  if (!isRecord(parsed) || !hasExactKeys(parsed, ["bridge", "worker"])) {
    return rejected("provenance_malformed", "provenance envelope must contain exactly bridge and worker fingerprints", actualWorker);
  }
  const bridge = parseFingerprint(parsed["bridge"], false);
  const worker = parseFingerprint(parsed["worker"], true);
  if (!bridge || !worker) {
    return rejected("provenance_malformed", "provenance fingerprint fields were invalid", actualWorker);
  }
  const expected: RuntimeBuildProvenance = { bridge, worker };

  let expectedWorkerPath: string;
  try {
    if (!path.isAbsolute(worker.path!)) throw new Error("expected worker path was not absolute");
    expectedWorkerPath = realpathSync(worker.path!);
  } catch {
    return rejected("provenance_malformed", "expected worker path was missing, unreadable, or non-canonicalizable", actualWorker, expected);
  }

  const actualPath = actualWorker.path;
  let canonicalActualPath: string | null = null;
  if (actualPath !== null) {
    try { canonicalActualPath = realpathSync(actualPath); }
    catch { /* an unavailable actual path is a mismatch, never a match */ }
  }
  if (canonicalActualPath === null || normalizeComparisonPath(canonicalActualPath) !== normalizeComparisonPath(expectedWorkerPath)) {
    return rejected("provenance_path_mismatch", "actual worker path did not match the Bridge-expected worker path", actualWorker, expected);
  }
  if (actualWorker.sha256 === null || actualWorker.sha256.toUpperCase() !== worker.sha256!.toUpperCase()) {
    return rejected("provenance_hash_mismatch", "actual worker SHA256 did not match the Bridge-expected SHA256", actualWorker, expected);
  }
  return { status: "verified", expected, actualWorker, workerMatchesExpected: true };
}

function rejected(
  errorCode: WorkerProvenanceErrorCode,
  reason: string,
  actualWorker: RuntimeArtifactFingerprint,
  expected: RuntimeBuildProvenance | null = null,
): WorkerProvenanceCheck {
  return { status: "rejected", expected, actualWorker, workerMatchesExpected: false, errorCode, reason };
}

function parseFingerprint(value: unknown, requireComplete: boolean): RuntimeArtifactFingerprint | null {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "sha256"])) return null;
  const artifactPath = value["path"];
  const sha256 = value["sha256"];
  if (requireComplete) {
    if (typeof artifactPath !== "string" || !path.isAbsolute(artifactPath)) return null;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256)) return null;
    return { path: artifactPath, sha256 };
  }
  if (artifactPath !== null && (typeof artifactPath !== "string" || !path.isAbsolute(artifactPath))) return null;
  if (sha256 !== null && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256))) return null;
  return { path: artifactPath as string | null, sha256: sha256 as string | null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeComparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toUpperCase() : normalized;
}

export function fingerprintRuntimeArtifact(filePath: string | undefined): RuntimeArtifactFingerprint {
  if (!filePath) return { path: null, sha256: null };
  try {
    const resolvedPath = realpathSync(filePath);
    return {
      path: resolvedPath,
      sha256: createHash("sha256").update(readFileSync(resolvedPath)).digest("hex").toUpperCase(),
    };
  } catch {
    return { path: path.resolve(filePath), sha256: null };
  }
}
