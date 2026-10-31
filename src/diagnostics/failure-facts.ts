// ADR-011 P0 private failure diagnostics: the frozen FailureFactsV1 contract
// (docs/decisions/adr-011/FAILURE_FACTS_V1.md). This is Bridge-owned private
// evidence — never a TaskResult field, never a task-state source, never a
// public event, and never readable through MCP in P0. Every value is
// whitelist-constructed; raw messages, stacks, headers, URLs, paths,
// credentials, prompts, model output and unknown codes are never persisted.
//
// ADR-011 P0 decisions embodied here:
// - FAILURE_PHASES is the single registry: the TypeScript type and the runtime
//   membership check both derive from it (no second enumeration, T1).
// - Evidence strength: explicit trusted business codes > reviewed structured
//   type/reason > HTTP status > bounded text clues. Same-strength conflicts are
//   checked before classification; weaker evidence never overrides stronger.
// - Numeric business codes are preserved in their fields but never classified
//   in P0: versioned_mapping stays contract-capable yet disabled, so no
//   version string or source checkout may activate the numeric interpretations.
// - runtime_retryable only carries a directly reported boolean from the
//   attributed error ("reported"); contradictory booleans null both fields and
//   set evidence_conflict.
// - accepted_before_error is a three-state evidence conclusion for this
//   attempt's session/send, independent of the compat progress filters (M2).

/** The only phase registry. Runtime validation derives from this table. */
export const FAILURE_PHASES = [
  "unknown", "pre_send", "send_pending", "rpc_rejected", "turn_started",
  "processing_input", "awaiting_model_response", "streaming",
  "scheduling_tools", "executing_tools", "aggregating_results",
  "awaiting_permission", "completing", "error", "compact", "rewind",
  "model_creation", "turn_terminal", "spawn", "process_exit",
  "transport_lost", "protocol_guard",
] as const;

export type FailurePhase = (typeof FAILURE_PHASES)[number];

/** Runtime membership derived from the same frozen table (no second source). */
export const FAILURE_PHASE_SET: ReadonlySet<string> = new Set<string>(FAILURE_PHASES);

export const FAILURE_SOURCES = ["rpc", "turn_event", "process", "transport"] as const;
export type FailureSource = (typeof FAILURE_SOURCES)[number];

export const ACCEPTED_STATES = ["yes", "no", "unknown"] as const;
export type AcceptedEvidence = (typeof ACCEPTED_STATES)[number];

export const FAILURE_CATEGORIES = [
  "quota_exhausted", "rate_limited", "auth_failed", "network_failure",
  "context_exceeded", "invalid_request", "model_unavailable",
  "execution_failed", "protocol_failure", "unknown",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const CONFIDENCE_LEVELS = ["confirmed", "inferred", "unknown"] as const;
export type FailureConfidence = (typeof CONFIDENCE_LEVELS)[number];

export const EVIDENCE_BASES = [
  "business_code", "runtime_type_or_reason", "http_status", "result_type",
  "process_errno", "protocol_guard", "text", "conflict", "none",
] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

export const RETRYABLE_BASES = ["reported", "versioned_mapping"] as const;
export type RetryableBasis = (typeof RETRYABLE_BASES)[number];

export const PROCESS_ERRNOS = ["ENOENT", "EACCES", "EPERM"] as const;
export type ProcessErrno = (typeof PROCESS_ERRNOS)[number];

// ---- Frozen initial registries (FAILURE_FACTS_V1.md). Unknown upstream values
// map to null; implementations must never extend them dynamically. ----

/** P0 explicit terminal-quota provider business codes. */
export const QUOTA_BUSINESS_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

/** Explicit structured rate-limit business codes. */
export const RATE_LIMIT_STRING_CODES: ReadonlySet<string> = new Set([
  "rate_limit_error",
  "rate_limit_reached_error",
]);

/**
 * Numeric business codes. Preserved in facts, never classified in P0: the
 * versioned interpretation stays disabled until a separately reviewed
 * versioned_mapping enablement (installed-artifact fingerprint + semantic
 * binding), which a source checkout or version string cannot provide.
 */
export const PROVIDER_NUMERIC_CODES: ReadonlySet<string> = new Set([
  "1005", "1006", "1261", "3001", "3006", "3007", "3008", "3009", "3010",
  "1302", "1303", "1304", "1305", "1308", "1310", "1313", "3002",
]);

export const PROVIDER_BUSINESS_CODES: ReadonlySet<string> = new Set([
  ...QUOTA_BUSINESS_CODES,
  ...RATE_LIMIT_STRING_CODES,
  ...PROVIDER_NUMERIC_CODES,
]);

/** Model/generic error codes; the provider business codes are also accepted. */
export const MODEL_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_model_selection",
  "model_config_missing",
  "provider_not_found",
  "provider_not_configured",
  "model_not_found",
  "invalid_model_request",
  "invalid_model_response",
  "model_request_failed",
  "model_request_auth_missing",
  "model_request_cancelled",
  "model_request_timeout",
  "model_rate_limited",
  "model_context_exceeded",
  ...PROVIDER_BUSINESS_CODES,
]);

export const ERROR_TYPE_REGISTRY: ReadonlySet<string> = new Set([
  "model_error",
  "model_timeout",
  "model_rate_limited",
  "model_context_exceeded",
  "tool_not_found",
  "tool_execution_failed",
  "tool_timeout",
  "tool_cancelled",
  "tool_max_calls",
  "permission_denied",
  "permission_timeout",
  "storage_error",
  "configuration_error",
  "unknown_error",
  ...MODEL_ERROR_CODES,
]);

/** rpc_data_code accepts the model/generic error code table (which includes
 * the provider business codes); other recovery codes stay un-persisted. */
export const RPC_DATA_CODE_REGISTRY: ReadonlySet<string> = MODEL_ERROR_CODES;

export const RESULT_TYPE_REGISTRY: ReadonlySet<string> = new Set([
  "success",
  "cancelled",
  "error_max_turns",
  "error_max_budget",
  "error_during_execution",
  "error_max_tool_calls",
]);

/** Turn-terminal result types that establish an execution failure. */
const EXECUTION_RESULT_TYPES: ReadonlySet<string> = new Set([
  "error_max_turns",
  "error_max_budget",
  "error_during_execution",
  "error_max_tool_calls",
]);

/** Initial rpc_method list; arbitrary upstream strings are never stored. */
export const RPC_METHOD_REGISTRY: ReadonlySet<string> = new Set([
  "provider/updateAccountConfig",
  "session/create",
  "session/resume",
  "session/setMode",
  "session/setModel",
  "session/subscribe",
  "session/send",
  "session/events",
]);

/** The frozen FailureFactsV1 shape. All fields exist explicitly; nullable
 * fields use null for "no reliable evidence". Arbitrary extension is
 * prohibited; validation rejects unknown keys. */
export interface FailureFactsV1 {
  schema_version: "1";
  source: FailureSource;
  phase: FailurePhase;
  rpc_method: string | null;
  rpc_code: number | null;
  rpc_data_code: string | null;
  error_type: string | null;
  error_code: string | null;
  provider_code: string | null;
  http_status: number | null;
  accepted_before_error: AcceptedEvidence;
  category: FailureCategory;
  confidence: FailureConfidence;
  evidence_basis: EvidenceBasis;
  evidence_conflict: boolean;
  runtime_retryable: boolean | null;
  runtime_retryable_basis: "reported" | "versioned_mapping" | null;
  result_type: string | null;
  process_errno: ProcessErrno | null;
}

/** ADR-011: compact UTF-8 serialization cap for one facts snapshot. */
export const MAX_FAILURE_FACTS_BYTES = 4096;

const FACTS_KEYS: ReadonlySet<string> = new Set([
  "schema_version", "source", "phase", "rpc_method", "rpc_code", "rpc_data_code",
  "error_type", "error_code", "provider_code", "http_status",
  "accepted_before_error", "category", "confidence", "evidence_basis",
  "evidence_conflict", "runtime_retryable", "runtime_retryable_basis",
  "result_type", "process_errno",
]);

const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

// ---- Classifier input -------------------------------------------------------

/**
 * Bounded, already-extracted evidence for one established termination. Every
 * field is either null or validated; raw upstream text never crosses this
 * boundary — only the boolean result of an in-memory bounded text match.
 */
export interface FailureEvidenceInput {
  source: FailureSource;
  phase: FailurePhase;
  rpcMethod?: string | null;
  rpcCode?: number | null;
  rpcDataCode?: string | null;
  providerCode?: string | null;
  errorCode?: string | null;
  errorType?: string | null;
  /** Reviewed reason token classified in memory; never persisted itself. */
  reviewedReason?: string | null;
  httpStatus?: number | null;
  /** Directly reported retryable booleans collected from one error payload. */
  retryableBooleans?: boolean[];
  resultType?: string | null;
  processErrno?: ProcessErrno | null;
  protocolGuard?: boolean;
  /** Bounded in-memory match: top-level explicit quota text was present. */
  quotaText?: boolean;
  accepted: AcceptedEvidence;
  /** An ACK (or strict-correlation "yes") contradicted by a *version-proven*
   * pre-acceptance rejection. No P0 production path can prove pre-acceptance
   * rejection, so the adapter never sets this; the rule is contract-pinned. */
  acceptedContradiction?: boolean;
}

export interface FailureClassification {
  category: FailureCategory;
  confidence: FailureConfidence;
  evidence_basis: EvidenceBasis;
  evidence_conflict: boolean;
  runtime_retryable: boolean | null;
  runtime_retryable_basis: "reported" | "versioned_mapping" | null;
}

const DIRECT_FACT_CATEGORIES = new Set<FailureCategory>([
  "quota_exhausted", "rate_limited", "auth_failed", "context_exceeded",
  "invalid_request", "model_unavailable", "execution_failed",
]);

function registeredCode(value: unknown, registry: ReadonlySet<string>): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = typeof value === "number" ? (Number.isSafeInteger(value) ? String(value) : null) : value;
  if (text === null || !CODE_PATTERN.test(text)) return null;
  return registry.has(text) ? text : null;
}

export { registeredCode };

/** Reviewed type/reason → category per the frozen rules; anything not
 * enumerated stays unknown (including provider_not_configured,
 * model_request_auth_missing and invalid_model_selection, which are
 * explicitly insufficient for auth_failed). */
function reviewedTypeOrReasonCategories(input: FailureEvidenceInput): Set<FailureCategory> {
  const categories = new Set<FailureCategory>();
  const type = input.errorType ?? null;
  const code = input.errorCode ?? null;
  const reason = input.reviewedReason ?? null;
  if (type === "model_context_exceeded" || code === "model_context_exceeded" || reason === "context_exceeded") {
    categories.add("context_exceeded");
  }
  if (type === "model_rate_limited" || code === "model_rate_limited" || reason === "rate_limited") {
    categories.add("rate_limited");
  }
  if (code === "model_not_found" || type === "model_not_found") categories.add("model_unavailable");
  if (type === "tool_execution_failed" || type === "tool_timeout") categories.add("execution_failed");
  if (reason === "auth_failed") categories.add("auth_failed");
  if (reason === "invalid_request" && !categories.has("auth_failed")) {
    // invalid_request only after excluding the documented counter-evidence
    // (a 1005 provider code or an invalid_model_response error code).
    if (code !== "invalid_model_response" && code !== "1005" && input.providerCode !== "1005" && input.rpcDataCode !== "1005") {
      categories.add("invalid_request");
    }
  }
  return categories;
}

/**
 * Evidence-strength adjudication. Same-strength conflicts are resolved first;
 * weaker evidence cannot override stronger, and text never overrides any
 * structured rate-limit evidence.
 */
export function classifyFailureEvidence(input: FailureEvidenceInput): FailureClassification {
  // runtime_retryable: only directly reported booleans of this error.
  const booleans = (input.retryableBooleans ?? []).filter((value) => typeof value === "boolean");
  const distinct = new Set<boolean>(booleans);
  let retryableConflict = false;
  let runtimeRetryable: boolean | null = null;
  let retryableBasis: "reported" | "versioned_mapping" | null = null;
  if (distinct.size === 1) {
    runtimeRetryable = booleans[0]!;
    retryableBasis = "reported";
  } else if (distinct.size > 1) {
    retryableConflict = true;
  }

  // Same-strength business-code conflict: independent quota and rate-limit
  // codes in one payload. Generic wrappers (type=generic type) are not conflicts.
  const quotaCodes = [input.providerCode, input.errorCode, input.rpcDataCode]
    .filter((value): value is string => typeof value === "string" && QUOTA_BUSINESS_CODES.has(value));
  const rateCodes = [input.providerCode, input.errorCode, input.rpcDataCode]
    .filter((value): value is string => typeof value === "string" && RATE_LIMIT_STRING_CODES.has(value));
  const businessConflict = quotaCodes.length > 0 && rateCodes.length > 0;

  let evidenceConflict = businessConflict || retryableConflict || input.acceptedContradiction === true;

  let category: FailureCategory = "unknown";
  let confidence: FailureConfidence = "unknown";
  let basis: EvidenceBasis = "none";

  if (businessConflict) {
    category = "unknown";
    confidence = "unknown";
    basis = "conflict";
  } else if (quotaCodes.length > 0) {
    // Explicit quota business codes cover a generic HTTP 429 (Q1) and a
    // generic model_rate_limited type is not a contradiction.
    category = "quota_exhausted";
    confidence = "confirmed";
    basis = "business_code";
  } else if (rateCodes.length > 0) {
    // A structured rate-limit code wins over weaker quota-flavored text (Q2).
    category = "rate_limited";
    confidence = "confirmed";
    basis = "business_code";
  } else {
    const typeReasons = reviewedTypeOrReasonCategories(input);
    const typeReason = typeReasons.values().next().value;
    if (typeReasons.size > 1) {
      evidenceConflict = true;
      basis = "conflict";
    } else if (typeReason && DIRECT_FACT_CATEGORIES.has(typeReason)) {
      category = typeReason;
      confidence = "confirmed";
      basis = "runtime_type_or_reason";
    } else if (input.resultType !== null && input.resultType !== undefined && EXECUTION_RESULT_TYPES.has(input.resultType)) {
      category = "execution_failed";
      confidence = "confirmed";
      basis = "result_type";
    } else if (input.httpStatus === 429) {
      category = "rate_limited";
      confidence = "inferred";
      basis = "http_status";
    } else if (input.quotaText && typeReasons.size === 0 &&
      ![input.providerCode, input.errorCode, input.rpcDataCode].includes("1005")) {
      // Top-level explicit quota text with no structured counter-evidence
      // keeps the ADR-006 fallback at inferred strength (Q7).
      category = "quota_exhausted";
      confidence = "inferred";
      basis = "text";
    }
  }

  // Direct process/protocol facts carry their own basis even at unknown category.
  if (category === "unknown" && input.protocolGuard) {
    category = "protocol_failure";
    confidence = "confirmed";
    basis = "protocol_guard";
  } else if (category === "unknown" && input.processErrno) {
    basis = "process_errno";
  }

  return {
    category,
    confidence,
    evidence_basis: basis,
    evidence_conflict: evidenceConflict,
    runtime_retryable: runtimeRetryable,
    runtime_retryable_basis: retryableBasis,
  };
}

// ---- Facts construction -----------------------------------------------------

function safeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function httpStatusOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function errnoOrNull(value: unknown): ProcessErrno | null {
  return typeof value === "string" && (PROCESS_ERRNOS as readonly string[]).includes(value)
    ? value as ProcessErrno
    : null;
}

export function registeredPhase(value: unknown): FailurePhase {
  return typeof value === "string" && FAILURE_PHASE_SET.has(value) ? value as FailurePhase : "unknown";
}

/**
 * Builds one validated snapshot from bounded evidence. Whitelist construction:
 * the object literal is fixed; no raw input object is ever serialized. Throws
 * when the result would violate the frozen schema or the 4096-byte cap.
 */
export function buildFailureFacts(input: FailureEvidenceInput): FailureFactsV1 {
  const source = input.source;
  const classification = classifyFailureEvidence(input);
  const facts: FailureFactsV1 = {
    schema_version: "1",
    source: source as FailureSource,
    phase: registeredPhase(input.phase),
    rpc_method: input.rpcMethod != null && RPC_METHOD_REGISTRY.has(input.rpcMethod) ? input.rpcMethod : null,
    rpc_code: safeIntegerOrNull(input.rpcCode),
    rpc_data_code: registeredCode(input.rpcDataCode ?? null, RPC_DATA_CODE_REGISTRY),
    error_type: registeredCode(input.errorType ?? null, ERROR_TYPE_REGISTRY),
    error_code: registeredCode(input.errorCode ?? null, MODEL_ERROR_CODES),
    provider_code: registeredCode(input.providerCode ?? null, PROVIDER_BUSINESS_CODES),
    http_status: httpStatusOrNull(input.httpStatus),
    accepted_before_error: input.acceptedContradiction ? "unknown" : input.accepted,
    category: classification.category,
    confidence: classification.confidence,
    evidence_basis: classification.evidence_basis,
    evidence_conflict: classification.evidence_conflict,
    runtime_retryable: classification.runtime_retryable,
    runtime_retryable_basis: classification.runtime_retryable_basis,
    result_type: registeredCode(input.resultType ?? null, RESULT_TYPE_REGISTRY),
    process_errno: errnoOrNull(input.processErrno ?? null),
  };
  const bytes = Buffer.byteLength(JSON.stringify(facts), "utf8");
  if (bytes > MAX_FAILURE_FACTS_BYTES) {
    throw new Error(`failure facts snapshot exceeds the ${MAX_FAILURE_FACTS_BYTES}-byte limit (${bytes} bytes)`);
  }
  return validateFailureFacts(facts);
}

/**
 * Strict validation for the persistence boundary. Rejects unknown keys,
 * non-registry values, malformed codes, out-of-range integers, and any
 * runtime_retryable basis other than a directly reported boolean (the
 * versioned_mapping value stays a contract capability but is disabled in P0).
 */
export function validateFailureFacts(value: unknown): FailureFactsV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("failure facts must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FACTS_KEYS.has(key)) throw new Error("failure facts has an unknown field");
  }
  for (const key of FACTS_KEYS) {
    if (!(key in record)) throw new Error(`failure facts is missing the field: ${key}`);
  }
  if (record["schema_version"] !== "1") throw new Error("failure facts schema_version must be \"1\"");
  if (!(FAILURE_SOURCES as readonly string[]).includes(record["source"] as string)) {
    throw new Error("failure facts source is not in the frozen registry");
  }
  if (!(FAILURE_PHASE_SET as ReadonlySet<string>).has(record["phase"] as string)) {
    throw new Error("failure facts phase is not in the frozen registry");
  }
  if (!(ACCEPTED_STATES as readonly string[]).includes(record["accepted_before_error"] as string)) {
    throw new Error("failure facts accepted_before_error must be yes, no, or unknown");
  }
  if (!(FAILURE_CATEGORIES as readonly string[]).includes(record["category"] as string)) {
    throw new Error("failure facts category is not in the frozen registry");
  }
  if (!(CONFIDENCE_LEVELS as readonly string[]).includes(record["confidence"] as string)) {
    throw new Error("failure facts confidence is not in the frozen registry");
  }
  if (!(EVIDENCE_BASES as readonly string[]).includes(record["evidence_basis"] as string)) {
    throw new Error("failure facts evidence_basis is not in the frozen registry");
  }
  if (typeof record["evidence_conflict"] !== "boolean") {
    throw new Error("failure facts evidence_conflict must be a boolean");
  }
  const retryable = record["runtime_retryable"];
  const retryableBasis = record["runtime_retryable_basis"];
  if (retryable !== null && typeof retryable !== "boolean") {
    throw new Error("failure facts runtime_retryable must be a boolean or null");
  }
  if (retryableBasis !== null && retryableBasis !== "reported") {
    throw new Error("failure facts runtime_retryable_basis must be reported or null in P0; versioned_mapping is disabled");
  }
  if ((retryable === null) !== (retryableBasis === null)) {
    throw new Error("failure facts runtime_retryable and runtime_retryable_basis must be null together");
  }
  const codeFields: Array<[string, ReadonlySet<string>]> = [
    // rpc_method strings contain "/" by design; membership in the frozen
    // method registry is the whole validation, the bounded code pattern
    // applies only to code families.
    ["rpc_method", RPC_METHOD_REGISTRY],
    ["rpc_data_code", RPC_DATA_CODE_REGISTRY],
    ["error_type", ERROR_TYPE_REGISTRY],
    ["error_code", MODEL_ERROR_CODES],
    ["provider_code", PROVIDER_BUSINESS_CODES],
    ["result_type", RESULT_TYPE_REGISTRY],
  ];
  for (const [key, registry] of codeFields) {
    const item = record[key];
    if (item === null) continue;
    if (key !== "rpc_method" && (typeof item !== "string" || !CODE_PATTERN.test(item))) {
      throw new Error(`failure facts field ${key} is not a bounded code value`);
    }
    if (typeof item !== "string" || !registry.has(item)) {
      throw new Error(`failure facts field ${key} is not a registered value`);
    }
  }
  if (record["rpc_code"] !== null && safeIntegerOrNull(record["rpc_code"]) === null) {
    throw new Error("failure facts rpc_code must be a safe integer or null");
  }
  if (record["http_status"] !== null && httpStatusOrNull(record["http_status"]) === null) {
    throw new Error("failure facts http_status must be an integer in 100..599 or null");
  }
  if (record["process_errno"] !== null && !(PROCESS_ERRNOS as readonly string[]).includes(record["process_errno"] as string)) {
    throw new Error("failure facts process_errno must be ENOENT, EACCES, EPERM, or null");
  }
  const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (bytes > MAX_FAILURE_FACTS_BYTES) {
    throw new Error(`failure facts snapshot exceeds the ${MAX_FAILURE_FACTS_BYTES}-byte limit (${bytes} bytes)`);
  }
  return value as FailureFactsV1;
}

// ---- Bounded in-memory text evidence (ADR-006 fallback, never persisted) ----

/**
 * Reason tokens whose classification semantics have been reviewed (v3.15.1
 * audit). Any other upstream reason string stays unclassified and is never
 * persisted in any form.
 */
export const REVIEWED_REASON_TOKENS: ReadonlySet<string> = new Set([
  "auth_failed",
  "invalid_request",
  "context_exceeded",
  "rate_limited",
]);

const QUOTA_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\binsufficient[_\s-]+quota\b/,
  /\bquota[_\s-]+(?:(?:has[_\s-]+been)[_\s-]+)?(?:exceeded|exhausted|depleted)\b/,
  /\b(?:usage|token)[_\s-]+quota[_\s-]+(?:exceeded|exhausted|depleted)\b/,
  /\b(?:usage|token)[_\s-]+limit[_\s-]+(?:exceeded|exhausted|reached)\b/,
  /\b(?:out[_\s-]+of|no[_\s-]+remaining|insufficient[_\s-]+)(?:[_\s-]+)?credits?\b/,
  /\bcredits?[_\s-]+(?:exhausted|depleted)\b/,
  /\bbilling[_\s-]+hard[_\s-]+limit[_\s-]+reached\b/,
  /(?:用量|额度|配额)(?:已|已经)?(?:用尽|耗尽|用完|不足)/,
  /(?:用尽|耗尽|用完|不足)(?:了)?(?:用量|额度|配额)/,
  /(?:超出|超过)(?:了)?(?:当前)?(?:用量|额度|配额)/,
  /(?:当前)?(?:用量|额度|配额)(?:已经)?(?:超出|不足)/,
];

/**
 * Bounded in-memory match of the ADR-006 top-level explicit quota fields
 * (the error value itself when a plain string, or its top-level code/type/
 * message). The match result is a boolean; no excerpt is ever returned or
 * stored. Generic "limit exceeded" phrasing without a quota marker never
 * matches, and structured rate-limit codes defeat this evidence at
 * classification time.
 */
export function matchesExplicitQuotaText(value: unknown): boolean {
  const error = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const candidates = [
    typeof value === "string" ? value : null,
    typeof error["code"] === "string" ? error["code"] : null,
    typeof error["type"] === "string" ? error["type"] : null,
    typeof error["message"] === "string" ? error["message"] : null,
  ].filter((candidate): candidate is string => candidate !== null)
    .map((candidate) => candidate.slice(0, 2_048));
  if (candidates.length === 0) return false;
  const text = candidates.join("\n").normalize("NFKC").toLowerCase();
  return QUOTA_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

// ---- M2: independent send-acceptance upgrade --------------------------------

/** The send boundary recorded when this attempt first attempted session/send. */
export interface SendBoundaryContext {
  /** Explicit session the send belongs to. */
  sessionId: string;
  /** Runtime event seq observed before the send; null when no reliable baseline. */
  seqBaseline: number | null;
  /** Turn IDs already strictly bound to earlier turns of this attempt. */
  boundTurnIds: ReadonlySet<string>;
  /** Locally generated submission correlation ID (never sent as a protocol
   * parameter in P0; an echo can only exist via a verified native mechanism). */
  submitCorrelationId: string;
  /** True only when the runtime's native send-correlation echo has been
   * verified for this installation. P0 production never sets this. */
  nativeCorrelationVerified: boolean;
}

/** A candidate new-turn observation considered for the no-ACK upgrade. */
export interface TurnEventObservation {
  /** Explicit sessionId carried by the event; never backfilled. */
  sessionId: string | null;
  seq: number | null;
  turnId: string | null;
  /** Runtime echo of the submission correlation ID, when natively provided. */
  correlationEcho: string | null;
}

export type AcceptedUpgrade = "yes" | "unknown";

/**
 * M2: without an ACK, "yes" requires every independent condition at once —
 * explicit sessionId match, a reliable seq baseline with a strictly newer
 * monotonic seq, a new turnId not already bound, and verified native
 * correlation to this send boundary. Any missing or contradictory item keeps
 * "unknown"; late events from older sends can never upgrade (A6).
 */
export function evaluateAcceptedUpgrade(
  context: SendBoundaryContext,
  event: TurnEventObservation,
): AcceptedUpgrade {
  if (!context.nativeCorrelationVerified) return "unknown";
  if (event.sessionId === null || event.sessionId !== context.sessionId) return "unknown";
  if (context.seqBaseline === null || !Number.isSafeInteger(context.seqBaseline) || context.seqBaseline < 0) return "unknown";
  if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq <= context.seqBaseline) return "unknown";
  if (!event.turnId || context.boundTurnIds.has(event.turnId)) return "unknown";
  if (!context.sessionId || !context.submitCorrelationId) return "unknown";
  if (event.correlationEcho !== context.submitCorrelationId) return "unknown";
  return "yes";
}
