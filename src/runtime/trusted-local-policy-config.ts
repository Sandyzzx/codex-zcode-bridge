import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateHostProfile, type BridgeHostProfile } from "../host/profile.js";
import { createTrustedLocalPolicyProvider, type TrustedLocalPolicyConfig, type TrustedLocalPolicyProvider } from "../sqlite-candidate/wp6b2b1/trusted-local-policy.js";
import { resolveTrustedLocalExecutionProfile } from "./trusted-local-profile.js";

const MAX_POLICY_BYTES = 64 * 1024;
const POLICY_FILE = "trusted-local-policy.json";

export type TrustedLocalPolicyLoadResult =
  | { readonly status: "disabled"; readonly source: string }
  | { readonly status: "invalid"; readonly source: string; readonly reason: string }
  | { readonly status: "loaded"; readonly source: string; readonly config: TrustedLocalPolicyConfig };

/**
 * Load the Owner policy only from the validated Host settings directory.
 * Environment variables and request data are intentionally not inputs.
 * Deployment evidence is carried separately by the stdio composition context;
 * it is not policy-file data.
 */
export function loadTrustedLocalPolicyConfig(
  host: BridgeHostProfile,
): TrustedLocalPolicyLoadResult {
  validateHostProfile(host);
  const source = path.join(host.settingsDirectory, POLICY_FILE);
  try {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: "invalid", source, reason: "trusted_local_policy_not_regular_file" };
    }
    if (stat.size > MAX_POLICY_BYTES) {
      return { status: "invalid", source, reason: "trusted_local_policy_too_large" };
    }
    const value: unknown = JSON.parse(readFileSync(source, "utf8"));
    const file = validatePolicyFile(value);
    const profile = resolveTrustedLocalExecutionProfile(file.execution_profile_id);
    if (!profile) return { status: "invalid", source, reason: "trusted_local_execution_profile_unknown" };
    return {
      status: "loaded",
      source,
      config: {
        enabled: true,
        policy_revision: file.policy_revision,
        workspace_roots: file.workspace_roots,
        execution_profile_id: profile.id,
        allowed_operation_kinds: ["attempt_lifecycle"],
        unrestricted: false,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "disabled", source };
    return {
      status: "invalid",
      source,
      reason: error instanceof Error && error.message.startsWith("trusted_local_")
        ? error.message
        : "trusted_local_policy_unreadable_or_invalid",
    };
  }
}

/**
 * Re-read Owner policy at each Candidate admission/use check. A policy change
 * applies to later checks but does not mutate or release existing Operations.
 */
export function createHostTrustedLocalPolicyProvider(host: BridgeHostProfile): TrustedLocalPolicyProvider {
  validateHostProfile(host);
  let disabled = false;
  const current = (): TrustedLocalPolicyProvider => {
    if (disabled) return createTrustedLocalPolicyProvider();
    const loaded = loadTrustedLocalPolicyConfig(host);
    return createTrustedLocalPolicyProvider(
      loaded.status === "loaded" ? loaded.config : loaded.status === "invalid" ? null : undefined,
    );
  };
  return Object.freeze({
    get status() { return current().status; },
    get reason() { return current().reason; },
    validateWorkspace: (input: Parameters<TrustedLocalPolicyProvider["validateWorkspace"]>[0]) => current().validateWorkspace(input),
    validateWorkspaceForUse: (workspace: string) => current().validateWorkspaceForUse(workspace),
    checkPermission: (input: Parameters<TrustedLocalPolicyProvider["checkPermission"]>[0]) => current().checkPermission(input),
    disable: () => { disabled = true; },
  });
}

interface TrustedLocalPolicyFile {
  readonly schema_version: 1;
  readonly enabled: true;
  readonly policy_revision: string;
  readonly workspace_roots: readonly string[];
  readonly execution_profile_id: string;
  readonly allowed_operation_kinds: readonly ["attempt_lifecycle"];
  readonly unrestricted: false;
}

function validatePolicyFile(value: unknown): TrustedLocalPolicyFile {
  if (!isRecord(value)) throw new Error("trusted_local_policy_invalid_json_shape");
  const keys = Object.keys(value).sort().join("|");
  if (keys !== [
    "allowed_operation_kinds", "enabled", "execution_profile_id", "policy_revision",
    "schema_version", "unrestricted", "workspace_roots",
  ].sort().join("|")) throw new Error("trusted_local_policy_invalid_fields");
  if (value.schema_version !== 1 || value.enabled !== true || value.unrestricted !== false
    || !Array.isArray(value.allowed_operation_kinds)
    || value.allowed_operation_kinds.length !== 1
    || value.allowed_operation_kinds[0] !== "attempt_lifecycle") {
    throw new Error("trusted_local_policy_invalid_contract");
  }
  if (!isId(value.policy_revision) || !isId(value.execution_profile_id)) {
    throw new Error("trusted_local_policy_invalid_identity");
  }
  if (!Array.isArray(value.workspace_roots) || value.workspace_roots.length < 1 || value.workspace_roots.length > 32
    || value.workspace_roots.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("trusted_local_policy_invalid_workspace_roots");
  }
  return value as unknown as TrustedLocalPolicyFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}
