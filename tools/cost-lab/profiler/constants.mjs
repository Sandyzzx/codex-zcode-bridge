export const PROFILER_SCHEMA_VERSION = 1;
export const PROFILER_SNAPSHOT_KIND = "profiler_snapshot";
export const PROFILER_REPORT_KIND = "profiler_report";

export const EVIDENCE_LEVELS = Object.freeze([
  "OBSERVED",
  "ATTRIBUTED",
  "ESTIMATED",
  "UNKNOWN",
]);

export const AGENT_KINDS = Object.freeze(["MASTER", "SUBAGENT", "WORKER", "UNKNOWN"]);

export const PHASES = Object.freeze([
  "Planning",
  "Implementation",
  "ReviewAudit",
  "TestingCI",
  "MCPDispatchResult",
  "MCPWaitingPolling",
  "FailureRetry",
  "DocumentationReport",
  "OtherMixedUnknown",
]);

export const USAGE_FIELDS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "uncached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
]);

export const ADDITIVE_USAGE_FIELDS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "uncached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
]);

export const ACCOUNTING_MODES = Object.freeze([
  "RESPONSE_LEVEL",
  "CUMULATIVE",
  "NONE",
]);

export const RECONCILIATION_STATUSES = Object.freeze([
  "RECONCILED",
  "MISMATCH",
  "PARTIAL",
  "NOT_APPLICABLE",
  "UNKNOWN",
]);

export const MCP_TOOL_NAMES = Object.freeze([
  "zcode_task",
  "zcode_status",
  "zcode_feedback",
  "zcode_events",
  "zcode_result",
  "zcode_continue",
  "zcode_cancel",
  "zcode_doctor",
]);

export const MCP_POLL_TOOL_NAMES = Object.freeze([
  "zcode_status",
  "zcode_feedback",
  "zcode_events",
  "zcode_result",
]);

export const MCP_DISPATCH_TOOL_NAMES = Object.freeze([
  "zcode_task",
  "zcode_continue",
  "zcode_cancel",
]);

export const CONTEXT_CATEGORIES = Object.freeze([
  "system_prompt",
  "developer_prompt",
  "user_message",
  "base_instructions",
  "conversation_message",
  "mcp_tool_schema",
  "mcp_tool_output",
  "shell_output",
  "file_read",
  "agent_instruction",
  "compaction_context",
  "tool_output",
  "unknown",
]);

export const COMMAND_CLASSES = Object.freeze([
  "PLANNING",
  "IMPLEMENTATION",
  "REVIEW",
  "TESTING",
  "DOCUMENTATION",
  "MCP",
  "OTHER",
]);

export const SEVERITY_ORDER = Object.freeze({
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  INFO: 3,
});

export const DEFAULT_TOKEN_ESTIMATE_BYTES = 4;
export const DEFAULT_READ_CHUNK_BYTES = 1024 * 1024;

export function phaseForCommandClass(commandClass) {
  switch (commandClass) {
    case "PLANNING":
      return "Planning";
    case "IMPLEMENTATION":
      return "Implementation";
    case "REVIEW":
      return "ReviewAudit";
    case "TESTING":
      return "TestingCI";
    case "DOCUMENTATION":
      return "DocumentationReport";
    case "MCP":
      return "MCPDispatchResult";
    default:
      return null;
  }
}
