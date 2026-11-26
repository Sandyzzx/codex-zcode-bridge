// Frozen tool schemas per docs/INTERFACES.md (strict, snake_case, unknown
// fields rejected). Rendered with Zod 4 schemas, which the official
// MCP TypeScript SDK v2 accepts directly as tool input schemas; unknown or
// missing fields fail input validation before the TaskManager is invoked.
// Additive optional output fields (observation, scan cursor/metrics, usage)
// keep old clients working: they may ignore unknown optional keys.
import * as z from "zod/v4";
import {
  TASK_ID_PATTERN,
  taskIdSchema,
  zcodeContinueInputSchema,
  zcodeDefaultModelInputSchema,
  zcodeEventsInputSchema,
  zcodeInteractionReplyInputSchema,
  zcodeModelCatalogInputSchema,
  zcodeTaskInputSchema,
  taskIdOnlyInputSchema,
} from "../api-schemas.js";

export {
  TASK_ID_PATTERN,
  taskIdSchema,
  taskIdOnlyInputSchema,
  zcodeTaskInputSchema,
  zcodeContinueInputSchema,
  zcodeEventsInputSchema,
  zcodeInteractionReplyInputSchema,
  zcodeModelCatalogInputSchema,
  zcodeDefaultModelInputSchema,
};

const stringArray = z.array(z.string());

export const zcodeResultInputSchema = taskIdOnlyInputSchema.extend({
  view: z.enum(["summary", "full"]).optional(),
  expected_attempt: z.number().int().positive().optional(),
  // P1 §3.4 / ADR-056: bounded page over the stored canonical Result JSON.
  // Both must be provided together and cannot be combined with view=summary.
  offset_bytes: z.number().int().nonnegative().optional(),
  max_bytes: z.number().int().min(1_024).max(4_194_304).optional(),
});

export const zcodeFeedbackInputSchema = z.strictObject({
  task_id: taskIdSchema,
});

// ---- output schemas (structured content validation) ----

const testReportSchema = z.object({
  command: z.string(),
  status: z.enum(["passed", "failed", "not_run"]),
  details: z.string().optional(),
});

const taskOwnerBindingSchema = z.object({
  task_id: z.string(),
  state: z.enum(["bound", "unavailable"]),
  owner_thread_id: z.string().nullable(),
  source: z.enum(["mcp_meta", "mcp_meta_missing", "mcp_meta_invalid", "non_host_admission", "legacy_unavailable"]),
  bound_at: z.string().nullable(),
  reason_code: z.literal("owner_thread_unavailable").nullable(),
});

const taskConsoleLinkSchema = z.object({
  available: z.boolean(),
  web_url: z.string().nullable(),
  console_id: z.string().nullable(),
  console_reused: z.boolean().nullable(),
  reason_code: z.string().nullable(),
});

export const taskReceiptSchema = z.object({
  task_id: z.string(),
  status: z.enum(["queued", "running"]),
  created_at: z.string(),
  owner_binding: taskOwnerBindingSchema.optional(),
  console_link: taskConsoleLinkSchema.optional(),
});

const taskObservationSchema = z.object({
  schema_version: z.literal(1),
  worker: z.object({ state: z.enum(["alive", "exited", "unknown"]), reason_code: z.string(), observed_at: z.string() }),
  runtime: z.object({ state: z.enum(["alive", "exited", "unknown"]), reason_code: z.string(), observed_at: z.string() }),
  activity: z.object({ code: z.string(), reason_code: z.string(), observed_at: z.string() }),
  result: z.enum(["absent", "checkpointed", "committed"]),
  cleanup: z.enum(["not_started", "pending", "verified", "unverified"]),
  stalled: z.boolean(),
  evidence: z.object({
    heartbeat_age_ms: z.number().nullable(),
    last_event_age_ms: z.number().nullable(),
    last_event_seq: z.number().nullable(),
    last_event_type: z.string().nullable(),
    session_id: z.string().nullable(),
    turn_id: z.string().nullable(),
    attempt: z.number().int(),
    status_updated_at: z.string().nullable(),
  }),
});

const executionObservationSchema = z.object({
  state: z.enum([
    "interrupted_without_result",
    "worker_identity_unknown",
    "worker_alive_unmanaged",
    "cleanup_held",
  ]),
  observed_at: z.string(),
  evidence_ref: z.string(),
});

const dispatchBlockerSchema = z.object({
  reason: z.enum(["capacity_occupied", "workspace_occupied"]),
  task_id: z.string(),
  operation_id: z.string(),
  phase: z.string(),
  workspace: z.string(),
  queued_duration_ms: z.number().int().nonnegative(),
  blocked_duration_ms: z.number().int().nonnegative(),
});

export const taskStatusRecordSchema = z.object({
  task_id: z.string(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "waiting_for_master",
  ]),
  attempt: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  worker_pid: z.number().int().nullable(),
  zcode_session_id: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  error_code: z.string().optional(),
  error: z.string().optional(),
  observation: taskObservationSchema.optional(),
  execution_observation: executionObservationSchema.optional(),
  dispatch_blocker: dispatchBlockerSchema.optional(),
  owner_binding: taskOwnerBindingSchema.optional(),
});

export const taskAttentionSnapshotSchema = z.strictObject({
  task_id: z.string(),
  attempt: z.number().int().positive(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "waiting_for_master",
  ]),
  pending_requests: z.array(z.string().min(1).max(512)),
});

const normalizedUsageSchema = z.object({
  source: z.string().nullable(),
  scope: z.string().nullable(),
  observed_at: z.string().nullable(),
  finality: z.enum(["reported", "derived", "partial"]),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  total_tokens: z.number().int().nullable(),
  cached_input_tokens: z.number().int().nullable(),
  cached_write_input_tokens: z.number().int().nullable().optional(),
  reasoning_tokens: z.number().int().nullable(),
  conflicts: z.array(z.string()),
  dropped_unknown_keys: z.number().int(),
});

const executionProfileSchema = z.object({
  executor: z.string(),
  provider_id: z.string().nullable(),
  model_id: z.string().nullable(),
  requested_model: z.string().nullable(),
  requested_reasoning_level: z.string().nullable(),
  effective_reasoning_level: z.string().nullable(),
  effective_reasoning_level_source: z.enum(["runtime", "not_reported"]),
  selection_source: z.string().nullable(),
  effective_at: z.string().nullable(),
  session_id: z.string().nullable(),
  turn_id: z.string().nullable(),
});

const attemptTimingSchema = z.object({
  queued_ms: z.number().int().nullable(),
  execution_ms: z.number().int().nullable(),
  turn_ms: z.number().int().nullable(),
  finalize_ms: z.number().int().nullable(),
  wall_ms: z.number().int().nullable(),
  derived: z.boolean(),
  notes: z.array(z.string()),
});

export const taskResultSchema = z.object({
  task_id: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "waiting_for_master"]),
  summary: z.string(),
  files_changed: z.array(z.string()),
  tests: z.array(testReportSchema),
  issues: z.array(z.string()),
  needs_master_decision: z.boolean(),
  zcode_output: z.string(),
  exit_code: z.number().int().nullable(),
  session_id: z.string().nullable(),
  attempt: z.number().int(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  error_code: z.string().optional(),
  report_candidate: z.object({
    summary: z.string().optional(),
    files_changed: z.array(z.string()).optional(),
    tests: z.array(testReportSchema).optional(),
    issues: z.array(z.string()).optional(),
    needs_master_decision: z.boolean().optional(),
  }).optional(),
  usage: normalizedUsageSchema.nullable().optional(),
  model: executionProfileSchema.nullable().optional(),
  timing: attemptTimingSchema.nullable().optional(),
});

// A union at the root would cause older MCP protocol codecs to wrap the result.
/** P1 §3.4 / ADR-056: one bounded page of the stored canonical Result JSON.
 * Concatenating every page's data reproduces bytes whose SHA-256 is
 * `result_content_digest`; `result_digest` remains the stored Result-envelope digest. */
const zcodeResultPageSchema = z.object({
  offset_bytes: z.number().int().nonnegative(),
  next_offset: z.number().int().positive().nullable(),
  total_bytes: z.number().int().nonnegative(),
  result_content_digest: z.string(),
  data: z.string(),
});

export const zcodeResultOutputSchema = taskResultSchema.extend({
  zcode_output: taskResultSchema.shape.zcode_output.optional(),
  projection: z.object({
    omitted_fields: z.array(z.string()),
    test_counts: z.object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      not_run: z.number().int().nonnegative(),
    }),
  }).optional(),
  page: zcodeResultPageSchema.optional(),
  result_status: z.string().optional(),
  result_digest: z.string().optional(),
  result_content_digest: z.string().optional(),
  result_commit_ref: z.string().optional(),
}).refine(
  (result) => (result.zcode_output !== undefined ? 1 : 0) + (result.projection !== undefined ? 1 : 0) + (result.page !== undefined ? 1 : 0) === 1,
  "Result must contain exactly one of zcode_output, projection, or page",
).meta({
  oneOf: [{ required: ["zcode_output"] }, { required: ["projection"] }, { required: ["page"] }],
});

const taskProgressEventSchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  type: z.string(),
  summary: z.string(),
  attempt: z.number().int().positive().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const taskProgressPageSchema = z.object({
  task_id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"]),
  events: z.array(taskProgressEventSchema),
  next_seq: z.number().int().nonnegative(),
  has_more: z.boolean(),
  omitted_events: z.number().int().nonnegative().optional(),
  observation: taskObservationSchema.optional(),
  scan_incomplete: z.boolean().optional(),
  scan_cursor: z.string().optional(),
  scan_metrics: z.object({
    bytes_read: z.number().int(),
    records_scanned: z.number().int(),
    invalid_lines: z.number().int(),
    corrupt_count: z.number().int(),
    first_corrupt_offset: z.number().int().nullable(),
    index_fallback: z.number().int(),
  }).optional(),
  attention: taskAttentionSnapshotSchema.optional(),
});

export const taskFeedbackSnapshotV01Schema = z.strictObject({
  schema_version: z.literal("0.1"),
  task_id: z.string(),
  attempt: z.number().int(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"]),
  model: z.strictObject({
    provider_id: z.string().nullable(),
    model_id: z.string().nullable(),
    reasoning_level: z.string().nullable(),
    source: z.literal("runtime"),
  }).nullable(),
  phase: z.null(),
  progress: z.null(),
  activity: z.strictObject({
    kind: z.enum(["tool_call", "tool_update"]),
    summary: z.string(),
    observed_at: z.string(),
    currentness: z.literal("last_observed"),
  }).nullable(),
  interaction: z.strictObject({
    state: z.enum(["not_observed", "pending", "answered"]),
    kind: z.enum(["permission", "user_input"]).nullable(),
  }).nullable(),
  result: z.strictObject({
    source: z.literal("agent_report"),
    summary: z.string(),
    issues: stringArray,
    files_changed: stringArray,
    tests: z.array(testReportSchema),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
  }).nullable(),
});

export const toolErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const doctorReportSchema = z.object({
  checked_at: z.string(),
  execution_mode: z.string(),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(["ok", "warning", "error", "unknown"]),
    summary: z.string(),
  })),
});

export const modelCatalogSchema = z.object({
  workspace: z.string(),
  current_model: z.object({ provider_id: z.string(), model_id: z.string() }).nullable(),
  models: z.array(z.object({
    provider_id: z.string(),
    model_id: z.string(),
    label: z.string(),
    provider_label: z.string().optional(),
    context_window: z.number().optional(),
    max_output_tokens: z.number().optional(),
    reasoning_levels: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    reasoning_default_level: z.string().optional(),
    disabled_reason: z.string().optional(),
  })),
  account_provider_sync: z.enum(["not_needed", "applied", "failed"]),
  cache_status: z.enum(["fresh", "refreshed"]).optional(),
  cached_at: z.string().optional(),
  warning: z.string().optional(),
});

const modelSelectionSchema = z.object({
  provider_id: z.string(),
  model_id: z.string(),
  reasoning_level: z.string().optional(),
});

export const defaultModelSchema = z.object({
  configured: z.boolean(),
  model: modelSelectionSchema.nullable(),
});
