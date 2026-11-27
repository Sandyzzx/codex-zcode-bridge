// Error taxonomy from docs/ARCHITECTURE.md ("Failure handling", frozen).
// Messages must never contain provider config contents, credentials, or
// environment dumps; paths and bounded stderr excerpts are allowed.
import type { RpcDiagnostic } from "../interfaces.js";

export type BridgeErrorCode =
  | "cleanup_failed"
  | "runtime_not_found"
  | "provider_config_missing"
  | "provider_config_invalid"
  | "spawn_failed"
  | "timeout"
  | "cancelled"
  | "worker_lost"
  | "invalid_json"
  | "invalid_agent_report"
  | "provenance_missing"
  | "provenance_malformed"
  | "provenance_path_mismatch"
  | "provenance_hash_mismatch"
  | "zcode_nonzero_exit"
  | "zcode_usage_exhausted"
  /** ADR-066: the official runtime rejected resuming a Session that has turn history. */
  | "session_not_resumable";

/** Error code and Result `error_code` of a rejected resume of a Session with turn history. */
export const SESSION_NOT_RESUMABLE = "session_not_resumable" as const;

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly memberPids?: readonly number[];
  /** ADR-066: redacted official RPC rejections observed before this failure. */
  readonly rpcDiagnostics?: readonly RpcDiagnostic[];
  /** ADR-066: the Session bound to the rejected RPC, kept as execution evidence. */
  readonly sessionId?: string;

  constructor(code: BridgeErrorCode, message: string, options?: {
    cause?: unknown; memberPids?: readonly number[]; rpcDiagnostics?: readonly RpcDiagnostic[]; sessionId?: string | null;
  }) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
    if (options?.memberPids?.length) this.memberPids = [...new Set(options.memberPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
    if (options?.rpcDiagnostics?.length) this.rpcDiagnostics = options.rpcDiagnostics;
    if (typeof options?.sessionId === "string" && options.sessionId) this.sessionId = options.sessionId;
  }
}
