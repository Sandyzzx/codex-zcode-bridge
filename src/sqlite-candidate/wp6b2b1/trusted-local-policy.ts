import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveTrustedLocalExecutionProfile } from "../../runtime/trusted-local-profile.js";

export interface TrustedLocalPolicyConfig {
  readonly enabled: true;
  readonly policy_revision: string;
  readonly execution_profile_id: string;
  readonly allowed_operation_kinds: readonly ["attempt_lifecycle"];
  readonly unrestricted: false;
}

export type PolicyDecision =
  | { readonly state: "allow"; readonly source: "trusted_local_policy"; readonly policy_revision: string; readonly policy_digest: string; readonly execution_profile_id: string; readonly execution_mode: "build"; readonly canonical_path: string }
  | { readonly state: "deny" | "unknown"; readonly reason: string };

export interface TrustedLocalPolicyProvider {
  readonly status: "enabled" | "disabled" | "invalid";
  readonly reason: string | null;
  validateWorkspace(input: { requestedPath: string; canonicalPath: string }): PolicyDecision;
  validateWorkspaceForUse(pathValue: string): PolicyDecision;
  checkPermission(input: { workspace: string; task: unknown }): PolicyDecision;
  disable(): void;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * Candidate-only policy provider. Configuration comes from the trusted local
 * composition boundary, never from TaskPackage, Prompt or Worker. This module
 * does not authenticate that composition boundary; production Host wiring is
 * a separate gate.
 */
export function createTrustedLocalPolicyProvider(config?: unknown): TrustedLocalPolicyProvider {
  let enabled = false;
  let invalid = false;
  let failure: string | null = config === undefined ? "trusted_local_mode_disabled" : null;
  let policyRevision = "";
  let executionProfileId = "";
  let executionMode: "build" = "build";
  let policyDigest = "";

  if (config !== undefined) {
    try {
      const parsed = validateConfig(config);
      policyRevision = parsed.policy_revision;
      executionProfileId = parsed.execution_profile_id;
      const profile = resolveTrustedLocalExecutionProfile(executionProfileId);
      if (!profile) throw new Error("trusted_local_execution_profile_unknown");
      executionMode = profile.sessionMode;
      const policyEnvelope = {
        contract: "trusted-local-workspace-policy-v2",
        policy_revision: policyRevision,
        execution_profile_id: executionProfileId,
        allowed_operation_kinds: ["attempt_lifecycle"],
        unrestricted: false,
      };
      policyDigest = createHash("sha256").update(JSON.stringify(policyEnvelope), "utf8").digest("hex");
      enabled = true;
    } catch (error) {
      invalid = true;
      failure = error instanceof Error ? error.message : "trusted_local_policy_invalid";
    }
  }

  const disabledOrInvalid = (): PolicyDecision => ({
    state: "unknown",
    reason: failure ?? "trusted_local_mode_disabled",
  });

  const allowed = (canonicalPath: string): PolicyDecision => ({
    state: "allow",
    source: "trusted_local_policy",
    policy_revision: policyRevision,
    policy_digest: policyDigest,
    execution_profile_id: executionProfileId,
    execution_mode: executionMode,
    canonical_path: canonicalPath,
  });

  const validateWorkspaceForUse = (pathValue: string): PolicyDecision => {
    if (!enabled) return disabledOrInvalid();
    if (typeof pathValue !== "string" || !isLocalAbsolute(pathValue)) {
      return { state: "deny", reason: "workspace_path_form_denied" };
    }
    try {
      return allowed(resolveLocalDirectory(pathValue));
    } catch (error) {
      const reason = error instanceof Error
        && (error.message === "workspace_unavailable" || error.message === "workspace_not_directory")
        ? error.message
        : "workspace_unavailable";
      return { state: "unknown", reason };
    }
  };

  return Object.freeze({
    get status(): "enabled" | "disabled" | "invalid" {
      return enabled ? "enabled" : invalid ? "invalid" : "disabled";
    },
    get reason(): string | null { return enabled ? null : failure; },
    validateWorkspace(input: { requestedPath: string; canonicalPath: string }): PolicyDecision {
      if (!enabled) return disabledOrInvalid();
      if (!input || typeof input.requestedPath !== "string" || typeof input.canonicalPath !== "string") {
        return { state: "unknown", reason: "workspace_input_unknown" };
      }
      if (!isLocalAbsolute(input.requestedPath) || !isLocalAbsolute(input.canonicalPath)) {
        return { state: "deny", reason: "workspace_path_form_denied" };
      }
      try {
        const requested = resolveLocalDirectory(input.requestedPath);
        const canonical = resolveLocalDirectory(input.canonicalPath);
        if (!sameWindowsPath(requested, canonical)) {
          return { state: "deny", reason: "workspace_canonical_mismatch" };
        }
        return allowed(canonical);
      } catch (error) {
        const reason = error instanceof Error
          && (error.message === "workspace_unavailable" || error.message === "workspace_not_directory")
          ? error.message
          : "workspace_unavailable";
        return { state: "unknown", reason };
      }
    },
    validateWorkspaceForUse,
    checkPermission(input: { workspace: string; task: unknown }): PolicyDecision {
      if (!enabled) return disabledOrInvalid();
      if (!input || typeof input.workspace !== "string" || !isPlainRecord(input.task)) {
        return { state: "unknown", reason: "admission_context_unknown" };
      }
      const operation = input.task;
      if (typeof operation.operation_id !== "string" || typeof operation.task_id !== "string"
        || !Number.isSafeInteger(operation.attempt) || operation.attempt < 1) {
        return { state: "deny", reason: "operation_kind_not_allowed" };
      }
      return validateWorkspaceForUse(input.workspace);
    },
    disable(): void {
      enabled = false;
      failure = "trusted_local_mode_disabled";
    },
  });
}

function validateConfig(value: unknown): TrustedLocalPolicyConfig {
  if (!isPlainRecord(value)) throw new Error("trusted_local_policy_config_invalid");
  const expected = ["allowed_operation_kinds", "enabled", "execution_profile_id", "policy_revision", "unrestricted"];
  if (Object.keys(value).sort().join("|") !== expected.sort().join("|")) throw new Error("trusted_local_policy_config_fields_invalid");
  if (value.enabled !== true || value.unrestricted !== false || value.allowed_operation_kinds?.length !== 1 || value.allowed_operation_kinds[0] !== "attempt_lifecycle") {
    throw new Error("trusted_local_policy_config_denied");
  }
  if (typeof value.policy_revision !== "string" || !ID.test(value.policy_revision)
    || typeof value.execution_profile_id !== "string" || !ID.test(value.execution_profile_id)) {
    throw new Error("trusted_local_policy_config_identity_invalid");
  }
  if (!resolveTrustedLocalExecutionProfile(value.execution_profile_id)) {
    throw new Error("trusted_local_execution_profile_unknown");
  }
  return value as unknown as TrustedLocalPolicyConfig;
}

function resolveLocalDirectory(input: string): string {
  if (!isLocalAbsolute(input)) throw new Error("workspace_path_form_denied");
  let stat;
  try {
    stat = statSync(input);
  } catch {
    throw new Error("workspace_unavailable");
  }
  if (!stat.isDirectory()) throw new Error("workspace_not_directory");
  const canonical = realpathSync(input);
  if (!isLocalAbsolute(canonical)) throw new Error("workspace_path_form_denied");
  return path.win32.normalize(canonical);
}

function isLocalAbsolute(value: string): boolean {
  return process.platform === "win32"
    && path.win32.isAbsolute(value)
    && /^[A-Za-z]:[\\/]/u.test(value)
    && !value.startsWith("\\\\");
}

function sameWindowsPath(left: string, right: string): boolean {
  return windowsKey(path.win32.normalize(left)) === windowsKey(path.win32.normalize(right));
}

function windowsKey(value: string): string {
  return value.replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US");
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
