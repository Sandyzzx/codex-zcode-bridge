// Error taxonomy from docs/ARCHITECTURE.md ("Failure handling", frozen).
// Messages must never contain provider config contents, credentials, or
// environment dumps; paths and bounded stderr excerpts are allowed.

export type BridgeErrorCode =
  | "runtime_not_found"
  | "provider_config_missing"
  | "provider_config_invalid"
  | "spawn_failed"
  | "timeout"
  | "cancelled"
  | "worker_lost"
  | "invalid_json"
  | "invalid_agent_report"
  | "zcode_nonzero_exit"
  | "execution_mode_disabled";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
  }
}
