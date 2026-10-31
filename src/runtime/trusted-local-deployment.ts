import { createHostTrustedLocalPolicyProvider } from "./trusted-local-policy-config.js";
import type { BridgeHostProfile } from "../host/profile.js";
import type { TrustedLocalPolicyProvider } from "../sqlite-candidate/wp6b2b1/trusted-local-policy.js";

/**
 * In-process evidence that the candidate policy was composed by the Bridge's
 * local stdio Host. This is a composition guard, not an OS security boundary.
 */
export interface TrustedLocalStdioContext {
  readonly policy: TrustedLocalPolicyProvider;
  readonly status: TrustedLocalPolicyProvider["status"];
}

const issuedContexts = new WeakSet<object>();

/** Called by the stdio Host composition; request data is never an input. */
export function createTrustedLocalStdioContext(host: BridgeHostProfile): TrustedLocalStdioContext {
  const policy = createHostTrustedLocalPolicyProvider(host);
  const context = Object.freeze({
    policy,
    get status() { return policy.status; },
  });
  issuedContexts.add(context);
  return context;
}

export function isTrustedLocalStdioContext(value: unknown): value is TrustedLocalStdioContext {
  return typeof value === "object" && value !== null && issuedContexts.has(value);
}
