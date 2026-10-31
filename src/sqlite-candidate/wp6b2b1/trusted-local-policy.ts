import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveTrustedLocalExecutionProfile } from "../../runtime/trusted-local-profile.js";

export interface TrustedLocalPolicyConfig {
  readonly enabled: true;
  readonly policy_revision: string;
  readonly workspace_roots: readonly string[];
  readonly execution_profile_id: string;
  readonly allowed_operation_kinds: readonly ["attempt_lifecycle"];
  readonly unrestricted: false;
}

export type PolicyDecision =
  | { readonly state: "allow"; readonly source: "trusted_local_policy"; readonly policy_revision: string; readonly policy_digest: string; readonly execution_profile_id: string; readonly execution_mode: "build" }
  | { readonly state: "deny" | "unknown"; readonly reason: string };

export interface TrustedLocalPolicyProvider {
  readonly status: "enabled" | "disabled" | "invalid";
  readonly reason: string | null;
  validateWorkspace(input: { requestedPath: string; canonicalPath: string }): PolicyDecision;
  validateWorkspaceForUse(pathValue: string): PolicyDecision;
  checkPermission(input: { workspace: string; task: unknown }): PolicyDecision;
  disable(): void;
}

interface RootRecord {
  readonly configuredPath: string;
  readonly canonicalPath: string;
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
  let roots: RootRecord[] = [];

  if (config !== undefined) {
    try {
      const parsed = validateConfig(config);
      policyRevision = parsed.policy_revision;
      executionProfileId = parsed.execution_profile_id;
      const profile = resolveTrustedLocalExecutionProfile(executionProfileId);
      if (!profile) throw new Error("trusted_local_execution_profile_unknown");
      executionMode = profile.sessionMode;
      roots = parsed.workspace_roots.map((configuredPath) => ({
        configuredPath,
        canonicalPath: resolveLocalDirectory(configuredPath),
      }));
      if (new Set(roots.map((root) => windowsKey(root.canonicalPath))).size !== roots.length) {
        throw new Error("workspace_roots_duplicate");
      }
      const policyEnvelope = {
        contract: "od10-trusted-local-policy-candidate-v1",
        policy_revision: policyRevision,
        workspace_roots: roots.map((root) => root.canonicalPath).sort((a, b) => windowsKey(a).localeCompare(windowsKey(b))),
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

  const inScope = (canonicalPath: string): "allow" | "deny" | "unknown" => {
    if (!enabled) return "unknown";
    try {
      for (const root of roots) {
        const currentRoot = resolveLocalDirectory(root.configuredPath);
        if (!sameWindowsPath(currentRoot, root.canonicalPath)) return "unknown";
        if (withinRoot(root.canonicalPath, canonicalPath)) return "allow";
      }
      return "deny";
    } catch {
      return "unknown";
    }
  };

  const allowed = (): PolicyDecision => ({
    state: "allow",
    source: "trusted_local_policy",
    policy_revision: policyRevision,
    policy_digest: policyDigest,
    execution_profile_id: executionProfileId,
    execution_mode: executionMode,
  });

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
      const scope = inScope(input.canonicalPath);
      if (scope === "allow") return allowed();
      return scope === "deny"
        ? { state: "deny", reason: "workspace_outside_owner_scope" }
        : { state: "unknown", reason: "workspace_scope_unknown" };
    },
    validateWorkspaceForUse(pathValue: string): PolicyDecision {
      if (!enabled) return disabledOrInvalid();
      if (typeof pathValue !== "string" || !isLocalAbsolute(pathValue)) {
        return { state: "deny", reason: "workspace_path_form_denied" };
      }
      try {
        const stat = statSync(pathValue);
        if (!stat.isDirectory()) return { state: "deny", reason: "workspace_not_directory" };
        const canonicalPath = path.win32.normalize(realpathSync(pathValue));
        if (!isLocalAbsolute(canonicalPath)) return { state: "deny", reason: "workspace_path_form_denied" };
        const scope = inScope(canonicalPath);
        if (scope === "allow") return allowed();
        return scope === "deny"
          ? { state: "deny", reason: "workspace_outside_owner_scope" }
          : { state: "unknown", reason: "workspace_scope_unknown" };
      } catch {
        return { state: "unknown", reason: "workspace_unavailable" };
      }
    },
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
      const scope = inScope(input.workspace);
      if (scope === "deny") return { state: "deny", reason: "workspace_outside_owner_scope" };
      if (scope !== "allow") return { state: "unknown", reason: "workspace_scope_unknown" };
      return allowed();
    },
    disable(): void {
      enabled = false;
      failure = "trusted_local_mode_disabled";
    },
  });
}

function validateConfig(value: unknown): TrustedLocalPolicyConfig {
  if (!isPlainRecord(value)) throw new Error("trusted_local_policy_config_invalid");
  const expected = ["allowed_operation_kinds", "enabled", "execution_profile_id", "policy_revision", "unrestricted", "workspace_roots"];
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
  if (!Array.isArray(value.workspace_roots) || value.workspace_roots.length < 1 || value.workspace_roots.length > 32
    || value.workspace_roots.some((item) => typeof item !== "string")) {
    throw new Error("trusted_local_policy_workspace_roots_invalid");
  }
  return value as unknown as TrustedLocalPolicyConfig;
}

function resolveLocalDirectory(input: string): string {
  if (!isLocalAbsolute(input)) throw new Error("workspace_root_path_form_denied");
  const stat = statSync(input);
  if (!stat.isDirectory()) throw new Error("workspace_root_not_directory");
  const canonical = realpathSync(input);
  if (!isLocalAbsolute(canonical)) throw new Error("workspace_root_path_form_denied");
  return path.win32.normalize(canonical);
}

function isLocalAbsolute(value: string): boolean {
  return process.platform === "win32"
    && path.win32.isAbsolute(value)
    && /^[A-Za-z]:\\/u.test(value)
    && !value.startsWith("\\\\");
}

function withinRoot(root: string, candidate: string): boolean {
  if (!isLocalAbsolute(candidate)) return false;
  const relative = path.win32.relative(root, path.win32.normalize(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative));
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
