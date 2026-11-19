import {
  AGENT_KINDS,
  ACCOUNTING_MODES,
  EVIDENCE_LEVELS,
  PHASES,
  PROFILER_REPORT_KIND,
  PROFILER_SCHEMA_VERSION,
  PROFILER_SNAPSHOT_KIND,
  RECONCILIATION_STATUSES,
  USAGE_FIELDS,
} from "./constants.mjs";
import { deepFreeze, isRecord } from "./util.mjs";

const nullableInteger = Object.freeze({
  anyOf: [
    Object.freeze({ type: "integer", minimum: 0 }),
    Object.freeze({ type: "null" }),
  ],
});

const nullableNumber = Object.freeze({
  anyOf: [
    Object.freeze({ type: "number", minimum: 0 }),
    Object.freeze({ type: "null" }),
  ],
});

const nullableString = Object.freeze({
  anyOf: [
    Object.freeze({ type: "string" }),
    Object.freeze({ type: "null" }),
  ],
});

const usageProperties = Object.freeze(Object.fromEntries(
  USAGE_FIELDS.map((field) => [field, nullableInteger]),
));

export const USAGE_SCHEMA = deepFreeze({
  type: "object",
  required: [
    "currency",
    "input_tokens",
    "cached_input_tokens",
    "uncached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
    "cache_hit_rate",
    "missing_fields",
    "conflicts",
    "evidence_level",
  ],
  properties: {
    currency: { enum: ["tokens"] },
    model: nullableString,
    provider: nullableString,
    reasoning_effort: nullableString,
    ...usageProperties,
    cache_hit_rate: {
      anyOf: [
        { type: "number", minimum: 0, maximum: 1 },
        { type: "null" },
      ],
    },
    total_source: { type: "string" },
    missing_fields: {
      type: "array",
      items: { enum: [...USAGE_FIELDS] },
    },
    observed_fields: {
      type: "array",
      items: { enum: [...USAGE_FIELDS] },
    },
    conflicts: {
      type: "array",
      items: { type: "string" },
    },
    dropped_unknown_keys: { type: "integer", minimum: 0 },
    evidence_level: { enum: [...EVIDENCE_LEVELS] },
  },
});

const agentSchema = deepFreeze({
  type: "object",
  required: [
    "agent_id",
    "kind",
    "parent_agent_id",
    "parent_thread_id",
    "root_agent_id",
    "goal_id",
    "thread_id",
    "usage",
    "source_refs",
  ],
  properties: {
    agent_id: { type: "string" },
    kind: { enum: [...AGENT_KINDS] },
    parent_agent_id: nullableString,
    parent_thread_id: nullableString,
    root_agent_id: nullableString,
    goal_id: nullableString,
    thread_id: nullableString,
    task_id: nullableString,
    nickname: nullableString,
    agent_path: nullableString,
    model: nullableString,
    provider: nullableString,
    reasoning_effort: nullableString,
    started_at: nullableString,
    ended_at: nullableString,
    duration_ms: nullableInteger,
    response_count: { type: "integer", minimum: 0 },
    unknown_usage_response_count: { type: "integer", minimum: 0 },
    usage: {
      type: "object",
      required: [
        "currency",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "total_tokens",
        "accounting_mode",
        "reconciliation",
        "evidence_level",
      ],
      properties: {
        ...usageProperties,
        accounting_mode: { enum: [...ACCOUNTING_MODES] },
        reconciliation: {
          type: "object",
          required: ["status"],
          properties: {
            status: { enum: [...RECONCILIATION_STATUSES] },
          },
        },
        evidence_level: { enum: [...EVIDENCE_LEVELS] },
      },
    },
    source_refs: {
      type: "array",
      items: { type: "string" },
    },
    correlation: {
      type: "object",
      required: ["status", "evidence"],
    },
  },
});

const toolSchema = deepFreeze({
  type: "object",
  required: [
    "tool_event_id",
    "agent_id",
    "name",
    "kind",
    "started_at",
    "ended_at",
    "duration_ms",
    "output_bytes",
    "estimated_output_tokens",
    "status",
    "failed",
    "signature",
  ],
  properties: {
    tool_event_id: { type: "string" },
    call_id: nullableString,
    agent_id: { type: "string" },
    thread_id: nullableString,
    turn_id: nullableString,
    response_id: nullableString,
    name: { type: "string" },
    namespace: nullableString,
    kind: { enum: ["MCP", "SHELL", "OTHER"] },
    started_at: nullableString,
    ended_at: nullableString,
    duration_ms: nullableNumber,
    output_bytes: nullableInteger,
    estimated_output_tokens: nullableInteger,
    estimated_token_evidence: { enum: [...EVIDENCE_LEVELS] },
    status: { enum: ["SUCCESS", "FAILURE", "UNKNOWN"] },
    failed: {
      anyOf: [
        { type: "boolean" },
        { type: "null" },
      ],
    },
    exit_code: nullableInteger,
    signature: { type: "string" },
    output_hash: nullableString,
    duplicate_of: nullableString,
    state_unchanged: {
      anyOf: [
        { type: "boolean" },
        { type: "null" },
      ],
    },
    task_id: nullableString,
    command_class: { type: "string" },
    wait_ms: nullableInteger,
    wait_for: nullableString,
    content_retained: { enum: [false] },
  },
});

export const PROFILER_SNAPSHOT_SCHEMA = deepFreeze({
  type: "object",
  required: [
    "schema_version",
    "kind",
    "snapshot_id",
    "captured_at",
    "generated_at",
    "event_horizon_at",
    "read_only",
    "sources",
    "agents",
    "responses",
    "usage_checkpoints",
    "tools",
    "context_items",
    "compactions",
    "bridge_tasks",
    "warnings",
  ],
  properties: {
    schema_version: { enum: [PROFILER_SCHEMA_VERSION] },
    kind: { enum: [PROFILER_SNAPSHOT_KIND] },
    snapshot_id: { type: "string" },
    captured_at: nullableString,
    generated_at: nullableString,
    event_horizon_at: nullableString,
    read_only: { enum: [true] },
    sources: { type: "array", items: { type: "object" } },
    agents: { type: "array", items: agentSchema },
    responses: { type: "array", items: { type: "object" } },
    usage_checkpoints: { type: "array", items: { type: "object" } },
    tools: { type: "array", items: toolSchema },
    context_items: { type: "array", items: { type: "object" } },
    compactions: { type: "array", items: { type: "object" } },
    bridge_tasks: { type: "array", items: { type: "object" } },
    warnings: {
      type: "array",
      items: { type: "object" },
    },
  },
});

export const PROFILER_REPORT_SCHEMA = deepFreeze({
  type: "object",
  required: [
    "schema_version",
    "kind",
    "report_id",
    "source_snapshot_id",
    "usage",
    "agents",
    "phases",
    "mcp",
    "context",
    "timeline",
    "timeline_meta",
    "diagnostics",
  ],
  properties: {
    schema_version: { enum: [PROFILER_SCHEMA_VERSION] },
    kind: { enum: [PROFILER_REPORT_KIND] },
    report_id: { type: "string" },
    source_snapshot_id: { type: "string" },
    usage: { type: "object" },
    agents: { type: "array", items: agentSchema },
    phases: {
      type: "object",
      required: ["rows", "conservation"],
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            required: ["phase", "evidence_level"],
            properties: {
              phase: { enum: [...PHASES] },
              evidence_level: { enum: [...EVIDENCE_LEVELS] },
            },
          },
        },
        conservation: { type: "object" },
      },
    },
    mcp: { type: "object" },
    context: { type: "object" },
    timeline: {
      type: "array",
      items: {
        type: "object",
        required: ["timeline_id", "kind", "at", "end_at", "evidence_level"],
        properties: {
          timeline_id: { type: "string" },
          kind: { enum: ["RESPONSE", "MCP_TOOL", "WORKER", "COMPACTION"] },
          at: nullableString,
          end_at: nullableString,
          evidence_level: { enum: [...EVIDENCE_LEVELS] },
        },
      },
    },
    timeline_meta: {
      type: "object",
      required: [
        "event_count",
        "total_event_count",
        "truncated",
        "limit",
        "content_retained",
      ],
      properties: {
        event_count: { type: "integer", minimum: 0 },
        total_event_count: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
        limit: { type: "integer", minimum: 1 },
        content_retained: { enum: [false] },
      },
    },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "severity", "evidence_level", "recommendation"],
      },
    },
  },
});

export class ProfilerSchemaError extends Error {
  constructor(errors, label = "profiler_value") {
    super(`${label}_schema_invalid`);
    this.name = "ProfilerSchemaError";
    this.code = `${label}_schema_invalid`;
    this.errors = errors;
  }
}

function matchesType(value, type) {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function validateNode(value, schema, path, errors) {
  if (schema?.anyOf) {
    const branchErrors = [];
    for (const branch of schema.anyOf) {
      const candidate = [];
      validateNode(value, branch, path, candidate);
      if (candidate.length === 0) return;
      branchErrors.push(candidate);
    }
    errors.push(`${path}: no anyOf branch matched`);
    return;
  }
  if (schema?.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: not in enum`);
    return;
  }
  if (schema?.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}`);
    return;
  }
  if (schema?.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: below minimum`);
  }
  if (schema?.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value) && schema?.items) {
    value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
  }
  if (isRecord(value) && schema?.properties) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required}: missing`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) {
        validateNode(value[key], childSchema, `${path}.${key}`, errors);
      }
    }
  } else if (isRecord(value) && schema?.required) {
    for (const required of schema.required) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required}: missing`);
    }
  }
}

export function validateWithSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

export function validateProfilerSnapshot(value) {
  return validateWithSchema(value, PROFILER_SNAPSHOT_SCHEMA);
}

export function validateProfilerReport(value) {
  return validateWithSchema(value, PROFILER_REPORT_SCHEMA);
}

export function assertProfilerSnapshot(value) {
  const result = validateProfilerSnapshot(value);
  if (!result.valid) throw new ProfilerSchemaError(result.errors, "profiler_snapshot");
  return value;
}

export function assertProfilerReport(value) {
  const result = validateProfilerReport(value);
  if (!result.valid) throw new ProfilerSchemaError(result.errors, "profiler_report");
  return value;
}
