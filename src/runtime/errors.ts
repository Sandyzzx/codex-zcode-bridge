// Error taxonomy from docs/ARCHITECTURE.md ("Failure handling", frozen).
// Messages must never contain provider config contents, credentials, or
// environment dumps; paths and bounded stderr excerpts are allowed.

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
  | "zcode_usage_exhausted";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly memberPids?: readonly number[];

  constructor(code: BridgeErrorCode, message: string, options?: { cause?: unknown; memberPids?: readonly number[] }) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
    if (options?.memberPids?.length) this.memberPids = [...new Set(options.memberPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  }
}
