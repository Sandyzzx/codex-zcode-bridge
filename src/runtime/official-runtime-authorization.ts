import { createHash } from "node:crypto";

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

/**
 * Stable digest for the exact observed official installation identity.
 * Paths and timestamps are intentionally excluded; changing any listed byte,
 * signer identity, launch metadata or supported Node version invalidates it.
 *
 * ADR-054 retired the version-authorization mechanism this module used to
 * carry; installation fingerprints remain the binding key for compatibility
 * evidence and runtime diagnostics.
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
