import { validateHostProfile, type BridgeHostProfile } from "../host/profile.js";
import { createTrustedLocalPolicyProvider, type TrustedLocalPolicyConfig, type TrustedLocalPolicyProvider } from "../sqlite-candidate/wp6b2b1/trusted-local-policy.js";

const BUILT_IN_POLICY: TrustedLocalPolicyConfig = Object.freeze({
  enabled: true,
  policy_revision: "single-user-local-v2",
  execution_profile_id: "local-build-v1",
  allowed_operation_kinds: Object.freeze(["attempt_lifecycle"] as const),
  unrestricted: false,
});

export type TrustedLocalPolicyLoadResult = {
  readonly status: "loaded";
  readonly source: "built-in-local-stdio";
  readonly config: TrustedLocalPolicyConfig;
};

/**
 * Return the fixed policy for the single-user trusted-local Host composition.
 * Project paths are validated with the same local-directory rules as the JSON
 * path; there is no Owner-maintained project allowlist file.
 */
export function loadTrustedLocalPolicyConfig(
  host: BridgeHostProfile,
): TrustedLocalPolicyLoadResult {
  validateHostProfile(host);
  return { status: "loaded", source: "built-in-local-stdio", config: BUILT_IN_POLICY };
}

/**
 * Build a Host-owned fixed policy provider. The in-process stdio capability
 * remains the authority boundary; files, request fields, prompts and Workers
 * cannot replace or broaden this policy.
 */
export function createHostTrustedLocalPolicyProvider(host: BridgeHostProfile): TrustedLocalPolicyProvider {
  validateHostProfile(host);
  return createTrustedLocalPolicyProvider(BUILT_IN_POLICY);
}
