import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isAbsolutePathForPlatform } from "./paths.js";

export const OFFICIAL_RUNTIME_PROBE_SCOPES = Object.freeze([
  "coding_plan_probe",
  "start_plan_probe",
  "other_provider_probe",
] as const);

export type OfficialRuntimeProbeScope = typeof OFFICIAL_RUNTIME_PROBE_SCOPES[number];

export interface OfficialInstallationFingerprintInput {
  readonly desktop_version: string;
  readonly desktop_app_version: string;
  readonly desktop_build_commit_id: string;
  readonly desktop_executable_bytes: number;
  readonly desktop_executable_sha256: string;
  readonly desktop_archive_bytes: number;
  readonly desktop_archive_sha256: string;
  readonly bundle_bytes: number;
  readonly bundle_sha256: string;
  readonly builtin_provider_config_bytes: number;
  readonly builtin_provider_config_sha256: string;
  readonly runtime_host_bytes: number;
  readonly runtime_host_sha256: string;
  readonly desktop_signer_thumbprint: string;
  readonly runtime_host_signer_thumbprint: string;
  readonly node_version: string;
}

export interface OfficialRuntimeAuthorizationRecord {
  readonly installation_fingerprint: string;
  readonly desktop_version: string;
  readonly authorized_at: string;
  readonly authorized_by: string;
  readonly scopes: readonly OfficialRuntimeProbeScope[];
}

export type OfficialRuntimeAuthorization =
  | Readonly<{
      state: "not_configured";
      file_path: null;
      reason: null;
      record: null;
      scopes: readonly [];
    }>
  | Readonly<{
      state: "required";
      file_path: string;
      reason: null;
      record: null;
      scopes: readonly [];
    }>
  | Readonly<{
      state: "authorized";
      file_path: string;
      reason: null;
      record: OfficialRuntimeAuthorizationRecord;
      scopes: readonly OfficialRuntimeProbeScope[];
    }>
  | Readonly<{
      state: "invalid";
      file_path: string;
      reason: string;
      record: null;
      scopes: readonly [];
    }>;

const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * Stable digest for the exact observed official installation identity.
 * Paths and timestamps are intentionally excluded; changing any listed byte,
 * signer identity, launch metadata or supported Node version invalidates it.
 */
export function computeOfficialInstallationFingerprint(
  input: OfficialInstallationFingerprintInput,
): string {
  const normalized = {
    schema_version: 1,
    desktop_version: input.desktop_version,
    desktop_app_version: input.desktop_app_version,
    desktop_build_commit_id: input.desktop_build_commit_id,
    desktop_executable: {
      bytes: input.desktop_executable_bytes,
      sha256: input.desktop_executable_sha256.toLowerCase(),
    },
    desktop_archive: {
      bytes: input.desktop_archive_bytes,
      sha256: input.desktop_archive_sha256.toLowerCase(),
    },
    appserver_bundle: {
      bytes: input.bundle_bytes,
      sha256: input.bundle_sha256.toLowerCase(),
    },
    builtin_provider_config: {
      bytes: input.builtin_provider_config_bytes,
      sha256: input.builtin_provider_config_sha256.toLowerCase(),
    },
    runtime_host: {
      bytes: input.runtime_host_bytes,
      sha256: input.runtime_host_sha256.toLowerCase(),
    },
    signers: {
      desktop: input.desktop_signer_thumbprint.replace(/[^0-9A-F]/giu, "").toUpperCase(),
      runtime_host: input.runtime_host_signer_thumbprint.replace(/[^0-9A-F]/giu, "").toUpperCase(),
    },
    node_version: input.node_version,
  };
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

export async function lookupOfficialRuntimeAuthorization(options: {
  readonly filePath: string | null;
  readonly installationFingerprint: string;
  readonly desktopVersion: string;
  readonly platform?: NodeJS.Platform;
}): Promise<OfficialRuntimeAuthorization> {
  if (!options.filePath) {
    return {
      state: "not_configured",
      file_path: null,
      reason: null,
      record: null,
      scopes: [],
    };
  }
  if (!isAbsolutePathForPlatform(options.filePath, options.platform)) {
    return invalid(options.filePath, "experimental authorization path is not absolute");
  }
  const filePath = path.resolve(options.filePath);
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        state: "required",
        file_path: filePath,
        reason: null,
        record: null,
        scopes: [],
      };
    }
    return invalid(filePath, "experimental authorization file could not be inspected");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return invalid(filePath, "experimental authorization path is not a regular file");
  }
  if (metadata.size > MAX_AUTHORIZATION_BYTES) {
    return invalid(filePath, "experimental authorization file exceeds 64 KB");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return invalid(filePath, "experimental authorization file is not valid JSON");
  }
  const root = asRecord(parsed);
  if (!root || root["schema_version"] !== 1 || !Array.isArray(root["authorizations"])) {
    return invalid(filePath, "experimental authorization file has an unsupported schema");
  }

  const records: OfficialRuntimeAuthorizationRecord[] = [];
  const identities = new Set<string>();
  for (const raw of root["authorizations"]) {
    const record = parseRecord(raw);
    if (!record) {
      return invalid(filePath, "experimental authorization file contains a malformed record");
    }
    const identity = `${record.desktop_version}\u0000${record.installation_fingerprint}`;
    if (identities.has(identity)) {
      return invalid(filePath, "experimental authorization file contains duplicate records");
    }
    identities.add(identity);
    records.push(record);
  }
  const matches: OfficialRuntimeAuthorizationRecord[] = [];
  for (const record of records) {
    if (record.desktop_version !== options.desktopVersion) continue;
    if (record.installation_fingerprint === options.installationFingerprint) matches.push(record);
  }
  if (matches.length === 0) {
    return {
      state: "required",
      file_path: filePath,
      reason: null,
      record: null,
      scopes: [],
    };
  }
  if (matches.length !== 1) {
    return invalid(filePath, "experimental authorization file contains duplicate matching records");
  }
  const record = matches[0]!;
  return {
    state: "authorized",
    file_path: filePath,
    reason: null,
    record,
    scopes: record.scopes,
  };
}

function parseRecord(value: unknown): OfficialRuntimeAuthorizationRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const fingerprint = text(record["installation_fingerprint"]);
  const desktopVersion = text(record["desktop_version"]);
  const authorizedAt = text(record["authorized_at"]);
  const authorizedBy = text(record["authorized_by"]);
  const rawScopes = record["scopes"];
  if (!fingerprint || !FINGERPRINT_PATTERN.test(fingerprint)
    || !desktopVersion || !VERSION_PATTERN.test(desktopVersion)
    || !authorizedAt || Number.isNaN(new Date(authorizedAt).getTime())
    || !authorizedBy || !Array.isArray(rawScopes) || rawScopes.length === 0) {
    return null;
  }
  const scopes: OfficialRuntimeProbeScope[] = [];
  for (const rawScope of rawScopes) {
    if (typeof rawScope !== "string"
      || !OFFICIAL_RUNTIME_PROBE_SCOPES.includes(rawScope as OfficialRuntimeProbeScope)) {
      return null;
    }
    const scope = rawScope as OfficialRuntimeProbeScope;
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return {
    installation_fingerprint: fingerprint,
    desktop_version: desktopVersion,
    authorized_at: new Date(authorizedAt).toISOString(),
    authorized_by: authorizedBy,
    scopes,
  };
}

function invalid(filePath: string, reason: string): OfficialRuntimeAuthorization {
  return {
    state: "invalid",
    file_path: filePath,
    reason,
    record: null,
    scopes: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
