import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { version as readOsVersion } from "node:os";
import path from "node:path";
import { PrivateCredentialLease, type PrivateLeaseBinding } from "./start-plan-private-lease.js";

/** Discriminated live-entitlement verdicts. "quota_exhausted" and
 * "no_entitlement" are separate facts; neither may be inferred from an HTTP
 * status alone, and a task never supplies any of these states. */
export type EntitlementStatus =
  | "entitled"
  | "no_entitlement"
  | "model_unavailable"
  | "quota_exhausted"
  | "rate_limited"
  | "forbidden"
  | "unauthorized"
  | "unusual_activity"
  | "captcha_required"
  | "billing_parameter_error"
  | "unavailable";

export type EntitlementVerdict = "entitled" | "not_entitled" | "unavailable";

export type EntitlementFailureClass =
  | "not_attempted"
  | "transport"
  | "unauthorized"
  | "forbidden"
  | "captcha_required"
  | "unusual_activity"
  | "billing_parameter_error"
  | "rate_limited"
  | "service_error"
  | "http_rejected"
  | "business_rejected"
  | "response_malformed"
  | "active_plan_absent"
  | "activation_pending"
  | "requested_model_absent"
  | "model_quota_unproven"
  | "quota_exhausted"
  | "unknown";

/** One sanitized ADR-030 decision record. This deliberately excludes response
 * bodies, credentials, authorization headers, account identities and device
 * identities. */
export interface StartPlanEntitlementFailureFacts {
  readonly request_attempted: boolean | null;
  readonly http_status: number | null;
  readonly provider_code: string | null;
  readonly failure_class: EntitlementFailureClass;
  readonly entitlement_verdict: EntitlementVerdict;
}

export const STARTPLAN_ENTITLEMENT_FACTS_ISSUE_PREFIX = "start_plan_entitlement_failure_facts:";

export interface EntitlementCheckInput {
  readonly account: string;
  readonly provider: string;
  readonly model: string;
  readonly deviceMid: string;
  /** In-memory credential for this one check only; never retained. */
  readonly jwt: string;
  readonly signal: AbortSignal;
}

export type EntitlementCheckResult =
  | { readonly status: "entitled"; readonly observedAt: number; readonly requestId: string }
  | {
      readonly status: EntitlementStatus;
      readonly reason: string;
      readonly providerCode?: string;
      readonly observedAt: number;
      readonly failureFacts?: StartPlanEntitlementFailureFacts;
    };

export interface StartPlanLiveEntitlement {
  check(input: EntitlementCheckInput): Promise<EntitlementCheckResult>;
}

/** Narrow result projected by the fixed Official Host. No access token,
 * refresh token, cookie, ciphertext, key or credential path crosses this
 * boundary. */
export interface OfficialStartPlanAuthentication {
  readonly accountIdentity: string;
  readonly sessionRevision: string | null;
  readonly requestCredential: string;
  readonly credentialExpiresAt: number | null;
  readonly deviceMid: string;
}

export interface OfficialStartPlanAuthenticationResolver {
  resolveStartPlanAuthentication(input: {
    readonly family: "bigmodel";
    readonly signal: AbortSignal;
  }): Promise<OfficialStartPlanAuthentication | null>;
}

/** Observed official billing envelope. Only field presence is interpreted;
 * message text is never echoed into Bridge diagnostics. */
interface OfficialBillingEnvelope {
  readonly success?: unknown;
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: {
    readonly plans?: unknown;
    readonly balances?: unknown;
    readonly server_time?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOfficialStartPlanAuthentication(
  value: unknown,
): OfficialStartPlanAuthentication | null {
  if (!isRecord(value)) return null;
  const accountIdentity = typeof value.accountIdentity === "string"
    ? value.accountIdentity.trim()
    : "";
  const requestCredential = typeof value.requestCredential === "string"
    ? value.requestCredential.trim()
    : "";
  const deviceMid = typeof value.deviceMid === "string" ? value.deviceMid.trim() : "";
  const sessionRevision = value.sessionRevision === null
    ? null
    : typeof value.sessionRevision === "string" && value.sessionRevision.trim()
      ? value.sessionRevision
      : undefined;
  const credentialExpiresAt = value.credentialExpiresAt === null
    ? null
    : typeof value.credentialExpiresAt === "number"
        && Number.isFinite(value.credentialExpiresAt)
        && value.credentialExpiresAt > 0
      ? value.credentialExpiresAt
      : undefined;
  if (!accountIdentity || !requestCredential || !deviceMid
    || sessionRevision === undefined || credentialExpiresAt === undefined) return null;
  return Object.freeze({
    accountIdentity,
    sessionRevision,
    requestCredential,
    credentialExpiresAt,
    deviceMid,
  });
}

function asOfficialBillingEnvelope(value: unknown): OfficialBillingEnvelope | null {
  if (!isRecord(value)) return null;
  const data = isRecord(value.data) ? value.data : undefined;
  return {
    success: value.success,
    code: value.code,
    msg: value.msg,
    ...(data ? { data: {
      plans: data.plans,
      balances: data.balances,
      server_time: data.server_time,
    } } : {}),
  };
}

function isSuccessfulBusinessEnvelope(envelope: OfficialBillingEnvelope): boolean {
  // Observed official 3.18.2 accepts a missing legacy field and uses
  // `success !== false`; the active-plan evidence below remains mandatory.
  return envelope.success !== false
    && (envelope.code === undefined || envelope.code === 0 || envelope.code === 200);
}

function stringKeyedArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(isRecord) as Array<Record<string, unknown>>
    : [];
}

function isActiveStartPlan(plan: Record<string, unknown>): boolean {
  const status = typeof plan.status === "string" ? plan.status.trim().toLowerCase() : "";
  const planId = typeof plan.plan_id === "string" ? plan.plan_id.trim().toLowerCase() : "";
  const name = typeof plan.name === "string" ? plan.name.trim().toLowerCase() : "";
  const startPlanIdentity = planId.includes("start-plan") || planId.includes("start plan")
    || name.includes("start-plan") || name.includes("start plan");
  // Provider catalog availability may accept an active plan with no identity,
  // but ADR-030's task-level credential authorization requires explicit Start
  // Plan identity. A missing identity is not enough to authorize a model.
  return status === "active" && startPlanIdentity;
}

function activeStartPlans(envelope: OfficialBillingEnvelope): Array<Record<string, unknown>> {
  return stringKeyedArray(envelope.data?.plans).filter(isActiveStartPlan);
}

function hasActiveStartPlan(envelope: OfficialBillingEnvelope): boolean {
  return activeStartPlans(envelope).length > 0;
}

function startPlanBalanceModelIds(balances: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const balance of balances) {
    const capabilities = Array.isArray(balance.capabilities) ? balance.capabilities : [];
    const capabilityModels = capabilities.flatMap((capability) => {
      const raw = typeof capability === "string" ? capability.trim().toLowerCase() : "";
      return raw.startsWith("model:") ? [raw.slice(6).trim()] : [];
    }).filter(Boolean);
    const candidates = capabilityModels.length > 0
      ? capabilityModels
      : typeof balance.show_name === "string" ? [balance.show_name.trim().toLowerCase()] : [];
    for (const model of candidates) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      models.push(model);
    }
  }
  return models;
}

function readIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function balanceBelongsToPlan(
  balance: Record<string, unknown>,
  plan: Record<string, unknown>,
): boolean {
  const balanceUserPlanId = readIdentifier(balance.user_plan_id);
  const planUserPlanId = readIdentifier(plan.user_plan_id);
  if (balanceUserPlanId && planUserPlanId) return balanceUserPlanId === planUserPlanId;
  const balancePlanId = readIdentifier(balance.plan_id);
  const planId = readIdentifier(plan.plan_id);
  return Boolean(balancePlanId && planId && balancePlanId === planId);
}

function requestedModelBalances(
  balances: Array<Record<string, unknown>>,
  requestedModel: string,
): Array<Record<string, unknown>> {
  return balances.filter((balance) => {
    const capabilities = Array.isArray(balance.capabilities) ? balance.capabilities : [];
    const capabilityModels = capabilities.flatMap((capability) => {
      const raw = typeof capability === "string" ? capability.trim().toLowerCase() : "";
      return raw.startsWith("model:") ? [raw.slice(6).trim()] : [];
    }).filter(Boolean);
    const candidates = capabilityModels.length > 0
      ? capabilityModels
      : typeof balance.show_name === "string" ? [balance.show_name.trim().toLowerCase()] : [];
    return candidates.includes(requestedModel);
  });
}

function numericUnit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function finiteEpochSeconds(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Applies the same expiry normalization observed in official 3.18.2 before
 * active-plan and balance evidence is interpreted. HTTP Date wins; a numeric
 * `data.server_time` is the fallback. */
function normalizeBillingAvailabilityEnvelope(
  envelope: OfficialBillingEnvelope,
  responseTimeSeconds: number | undefined,
): OfficialBillingEnvelope {
  const data = envelope.data;
  if (!data) return envelope;
  const nowSeconds = responseTimeSeconds
    ?? (typeof data.server_time === "number"
      && Number.isFinite(data.server_time)
      && data.server_time >= 0
      ? data.server_time
      : undefined)
    ?? Date.now() / 1000;
  const plans = stringKeyedArray(data.plans).map((plan) => {
    const status = typeof plan.status === "string" ? plan.status.trim().toLowerCase() : "";
    const end = finiteEpochSeconds(plan.ends_at);
    return status === "active" && end !== undefined && end > 0 && end <= nowSeconds
      ? { ...plan, status: "expired" }
      : plan;
  });
  const balances = stringKeyedArray(data.balances).filter((balance) => {
    const userPlanId = typeof balance.user_plan_id === "string" ? balance.user_plan_id : "";
    const planId = typeof balance.plan_id === "string" ? balance.plan_id : "";
    const owners = plans.filter((plan) => {
      const ownerUserPlanId = typeof plan.user_plan_id === "string" ? plan.user_plan_id : "";
      const ownerPlanId = typeof plan.plan_id === "string" ? plan.plan_id : "";
      return userPlanId && ownerUserPlanId
        ? userPlanId === ownerUserPlanId
        : planId === ownerPlanId;
    });
    return owners.length === 0 || owners.some((plan) => (
      typeof plan.status === "string" && plan.status.trim().toLowerCase() !== "expired"
    ));
  });
  return {
    ...envelope,
    data: {
      ...data,
      plans,
      balances,
    },
  };
}

/** Official 3.18.2 reports activation as pending only when no model
 * whitelist exists and every supplied effective time is still in the future.
 * Missing or malformed effective times are never converted into a date. */
function hasPendingActivation(envelope: OfficialBillingEnvelope): boolean {
  const data = envelope.data;
  if (!data) return false;
  const nowSeconds = typeof data.server_time === "number"
    && Number.isFinite(data.server_time)
    && data.server_time >= 0
    ? data.server_time
    : Date.now() / 1000;
  const effectiveTimes = activeStartPlans(envelope)
    .flatMap((plan) => {
      const entitlements = stringKeyedArray(plan.entitlements);
      return entitlements.length > 0
        ? entitlements.map((entry) => entry.effective_at)
        : [plan.starts_at];
    })
    .map((value) => value === null || value === undefined || value === ""
      ? undefined
      : Number(value));
  return effectiveTimes.length > 0
    && effectiveTimes.every((value) => value !== undefined && Number.isFinite(value) && value > nowSeconds);
}

function extractProviderCode(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  const error = isRecord(value.error) ? value.error : undefined;
  const candidates = [
    value.providerCode,
    error?.providerCode,
    error && isRecord(error) ? error.code : undefined,
    value.code,
  ];
  const raw = candidates.find((candidate) => typeof candidate === "number" || typeof candidate === "string");
  const code = typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
  return /^[0-9A-Za-z_.-]{1,32}$/u.test(code) ? code : undefined;
}

/** Maps one billing/entitlement HTTP exchange onto a discriminated verdict.
 * Provider business codes follow the official observed contract: 3007 =
 * captcha rejection, 3012 = unusual activity, 3001 = billing parameter
 * error. Quota and entitlement facts come from the response body, never
 * from the status code alone. */
export function classifyEntitlementFailure(input: {
  statusCode: number;
  providerCode?: string;
  body?: Record<string, unknown>;
  model?: string;
  responseTimeSeconds?: number;
}): {
  status: EntitlementStatus;
  reason: string;
  providerCode?: string;
  failureClass: EntitlementFailureClass;
} {
  const code = input.providerCode?.trim();
  const providerCode = code ? code : undefined;
  if (code === "3007") return { status: "captcha_required", reason: "provider requested captcha verification", providerCode, failureClass: "captcha_required" };
  if (code === "3012") return { status: "unusual_activity", reason: "provider blocked this identity due to unusual activity", providerCode, failureClass: "unusual_activity" };
  if (code === "3001") return { status: "billing_parameter_error", reason: "billing request parameters were rejected", providerCode, failureClass: "billing_parameter_error" };
  if (input.statusCode === 401) return { status: "unauthorized", reason: "credential was rejected as unauthenticated", failureClass: "unauthorized" };
  if (input.statusCode === 403) return { status: "forbidden", reason: "credential is authenticated but forbidden from this plan or model", failureClass: "forbidden" };
  // Body-derived entitlement facts are only provable on a 200 exchange;
  // 429/5xx responses must keep their status-based classification even when
  // the body carries an entitled-looking envelope.
  const rawEnvelope = input.statusCode === 200 ? asOfficialBillingEnvelope(input.body) : undefined;
  const envelope = rawEnvelope
    ? normalizeBillingAvailabilityEnvelope(rawEnvelope, input.responseTimeSeconds)
    : undefined;
  const activePlans = envelope ? activeStartPlans(envelope) : [];
  if (envelope && isSuccessfulBusinessEnvelope(envelope) && activePlans.length > 0) {
    const balances = stringKeyedArray(envelope.data?.balances);
    const attributedBalances = balances.filter((balance) =>
      activePlans.some((plan) => balanceBelongsToPlan(balance, plan)));
    const models = startPlanBalanceModelIds(attributedBalances);
    const requested = input.model?.trim().toLowerCase();
    if (!requested) {
      return { status: "unavailable", reason: "billing response had no requested model identity to authorize", failureClass: "response_malformed" };
    }
    if (hasPendingActivation(envelope)) {
      return {
        status: "unavailable",
        reason: "active Start Plan has not taken effect",
        failureClass: "activation_pending",
      };
    }
    if (models.length === 0) {
      return {
        status: "unavailable",
        reason: "billing response did not prove available model quota for this Start Plan",
        failureClass: "model_quota_unproven",
      };
    }
    if (!models.includes(requested)) {
      return { status: "model_unavailable", reason: "active Start Plan does not list the requested model", failureClass: "requested_model_absent" };
    }
    const relevant = requestedModelBalances(attributedBalances, requested);
    const units = relevant.map((balance) => numericUnit(balance.remaining_units));
    if (relevant.length === 0 || units.some((unit) => unit === null || unit < 0)) {
      return {
        status: "unavailable",
        reason: "billing response did not prove positive remaining quota for the requested model",
        failureClass: "model_quota_unproven",
      };
    }
    if (units.every((unit) => unit === 0)) {
      return {
        status: "quota_exhausted",
        reason: "Start Plan quota is exhausted for the requested model",
        failureClass: "quota_exhausted",
      };
    }
    return { status: "entitled", reason: "active Start Plan has positive quota for the requested model", failureClass: "unknown" };
  } else if (envelope && isSuccessfulBusinessEnvelope(envelope) && !hasActiveStartPlan(envelope)) {
    return { status: "no_entitlement", reason: "no active Start Plan was present in the billing response", failureClass: "active_plan_absent" };
  }
  if (input.statusCode === 429) return { status: "rate_limited", reason: "rate limited; quota state unknown from status alone", failureClass: "rate_limited" };
  if (input.statusCode >= 500) return { status: "unavailable", reason: "entitlement service error", failureClass: "service_error" };
  if (input.statusCode >= 400) return { status: "unavailable", reason: "entitlement query rejected without a recognized provider code", failureClass: "http_rejected" };
  if (envelope) return { status: "unavailable", reason: "billing response reported an unsuccessful business outcome", failureClass: "business_rejected" };
  return { status: "unavailable", reason: "entitlement response could not be interpreted", failureClass: "response_malformed" };
}

function sanitizeHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[\x20-\x7e]+$/u.test(trimmed) ? trimmed : undefined;
}

function clientLanguage(): string {
  try {
    return sanitizeHeaderValue(process.env.ZCODE_CLIENT_LANGUAGE)
      ?? sanitizeHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale)
      ?? "unknown";
  } catch {
    return sanitizeHeaderValue(process.env.ZCODE_CLIENT_LANGUAGE) ?? "unknown";
  }
}

function clientTimezone(): string {
  try {
    return sanitizeHeaderValue(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function osCategory(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function officialBillingHeaders(input: {
  readonly origin: string;
  readonly appVersion: string;
  readonly deviceMid: string;
  readonly jwt: string;
}): HeadersInit {
  return {
    Authorization: `Bearer ${input.jwt}`,
    "X-Device-Mid": input.deviceMid,
    "User-Agent": `ZCode/${input.appVersion}`,
    "HTTP-Referer": input.origin,
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": input.appVersion,
    "X-Release-Channel": process.env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production",
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Client-Language": clientLanguage(),
    "X-Client-Timezone": clientTimezone(),
    "X-Os-Category": osCategory(),
    "X-Os-Version": sanitizeHeaderValue(readOsVersion()) ?? "unknown",
  };
}

function failureVerdict(status: EntitlementStatus): EntitlementVerdict {
  return status === "no_entitlement" || status === "model_unavailable" || status === "quota_exhausted"
    ? "not_entitled"
    : "unavailable";
}

function withFailureFacts(
  verdict: {
    readonly status: EntitlementStatus;
    readonly reason: string;
    readonly providerCode?: string;
    readonly failureClass: EntitlementFailureClass;
  },
  input: {
    readonly observedAt: number;
    readonly requestAttempted: boolean | null;
    readonly httpStatus: number | null;
  },
): EntitlementCheckResult {
  const providerCode = verdict.providerCode ?? null;
  return {
    status: verdict.status,
    reason: verdict.reason,
    ...(providerCode ? { providerCode } : {}),
    observedAt: input.observedAt,
    failureFacts: Object.freeze({
      request_attempted: input.requestAttempted,
      http_status: input.httpStatus,
      provider_code: providerCode,
      failure_class: verdict.failureClass,
      entitlement_verdict: failureVerdict(verdict.status),
    }),
  };
}

export interface BillingEntitlementOptions {
  /** Official endpoint origin. Overridable so tests run against a local
   * fake; production uses the official origin. */
  readonly origin?: string;
  /** Official CLI version resolver. Implementations must read the version
   * from the official runtime (for example `zcode.cjs --version`); never
   * hardcode or fabricate a version. Returning undefined fails the check
   * closed instead of sending a guessed value. */
  readonly getAppVersion: () => Promise<string | undefined>;
  /** Injectable transport for tests; production uses global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

const OFFICIAL_START_PLAN_ORIGIN = "https://zcode.z.ai";
const BILLING_REQUEST_TIMEOUT_MS = 15_000;

/** Production-shaped live entitlement client. One attempt per check, no
 * retries, no caching: every credential delivery re-checks live state. */
export class StartPlanBillingEntitlement implements StartPlanLiveEntitlement {
  readonly #origin: string;
  readonly #getAppVersion: () => Promise<string | undefined>;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;

  constructor(options: BillingEntitlementOptions) {
    this.#origin = (options.origin ?? OFFICIAL_START_PLAN_ORIGIN).replace(/\/+$/, "");
    this.#getAppVersion = options.getAppVersion;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async check(input: EntitlementCheckInput): Promise<EntitlementCheckResult> {
    const observedAt = this.#now();
    const appVersion = await this.#getAppVersion();
    if (!appVersion || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(appVersion)) {
      return withFailureFacts({
        status: "unavailable",
        reason: "official cli version unavailable; refusing to guess",
        failureClass: "not_attempted",
      }, { observedAt, requestAttempted: false, httpStatus: null });
    }
    const deviceMid = sanitizeHeaderValue(input.deviceMid);
    if (!deviceMid) {
      return withFailureFacts({
        status: "unavailable",
        reason: "official device identity unavailable; refusing to guess",
        failureClass: "not_attempted",
      }, { observedAt, requestAttempted: false, httpStatus: null });
    }
    // Official 3.18.2 sends device identity only in X-Device-Mid for this
    // endpoint. Do not add a private `mid` query parameter.
    const url = `${this.#origin}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}`;
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: "GET",
        headers: officialBillingHeaders({
          origin: this.#origin,
          appVersion,
          deviceMid,
          jwt: input.jwt,
        }),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      return withFailureFacts({
        status: "unavailable",
        reason: "entitlement transport failed",
        failureClass: "transport",
      }, { observedAt: this.#now(), requestAttempted: true, httpStatus: null });
    }
    if (response.status === 200) {
      let body: Record<string, unknown> | undefined;
      let providerCode: string | undefined;
      try {
        const parsed: unknown = await response.json();
        if (isRecord(parsed)) {
          body = parsed;
          providerCode = extractProviderCode(parsed);
        }
      } catch { /* malformed success transport is not entitlement evidence */ }
      const classified = this.#interpretBillingBody({
        statusCode: response.status,
        providerCode,
        body,
        model: input.model,
        responseTimeSeconds: responseTimeSeconds(response),
      });
      if (classified.status === "entitled") {
        let requestId = "";
        try { requestId = (response.headers.get("x-request-id") ?? "").trim(); } catch { /* header access is safe, keep empty */ }
        return { status: "entitled", observedAt: this.#now(), requestId };
      }
      return withFailureFacts(classified, {
        observedAt: this.#now(),
        requestAttempted: true,
        httpStatus: response.status,
      });
    }
    let body: Record<string, unknown> | undefined;
    let providerCode: string | undefined;
    try {
      const parsed: unknown = await response.json();
      if (isRecord(parsed)) {
        body = parsed;
        providerCode = extractProviderCode(parsed);
      }
    } catch { /* body unreadable; classification falls back to status */ }
    return withFailureFacts(this.#interpretBillingBody({
      statusCode: response.status,
      providerCode,
      body,
      model: input.model,
      responseTimeSeconds: responseTimeSeconds(response),
    }), { observedAt, requestAttempted: true, httpStatus: response.status });
  }

  #interpretBillingBody(input: {
    statusCode: number;
    providerCode?: string;
    body?: Record<string, unknown>;
    model: string;
    responseTimeSeconds?: number;
  }): {
    status: EntitlementStatus;
    reason: string;
    providerCode?: string;
    failureClass: EntitlementFailureClass;
  } {
    return classifyEntitlementFailure(input);
  }

}

function responseTimeSeconds(response: Response): number | undefined {
  try {
    const parsed = Date.parse(response.headers.get("date") ?? "");
    return Number.isFinite(parsed) ? parsed / 1000 : undefined;
  } catch {
    return undefined;
  }
}

export interface ProductionAuthIssuerOptions {
  /** Fixed Official Host projection used for every task-scoped read. */
  readonly authentication: OfficialStartPlanAuthenticationResolver;
  /** Aborted when the Host shuts down or the account is invalidated. */
  readonly signal: AbortSignal;
  readonly entitlement: StartPlanLiveEntitlement;
  readonly now?: () => number;
}

export type ProductionAuthIssuer = NonNullable<import("../store/lifecycle-gate.js").ClaimOnlyDriverOptions["startPlanPrivateAuth"]>;

export class StartPlanEntitlementRejectionError extends Error {
  constructor(
    readonly entitlementStatus: EntitlementStatus,
    readonly failureFacts: StartPlanEntitlementFailureFacts,
    providerCode?: string,
  ) {
    super(`start_plan_entitlement_rejected:${entitlementStatus}${providerCode ? `:${providerCode}` : ""}`);
    this.name = "StartPlanEntitlementRejectionError";
  }
}

export function readStartPlanEntitlementFailureFacts(
  error: unknown,
): StartPlanEntitlementFailureFacts | null {
  return error instanceof StartPlanEntitlementRejectionError
    ? error.failureFacts
    : null;
}

export function formatStartPlanEntitlementFailureFactsIssue(
  facts: StartPlanEntitlementFailureFacts,
): string {
  return `${STARTPLAN_ENTITLEMENT_FACTS_ISSUE_PREFIX}${JSON.stringify({
    request_attempted: facts.request_attempted,
    http_status: facts.http_status,
    provider_code: facts.provider_code,
    failure_class: facts.failure_class,
    entitlement_verdict: facts.entitlement_verdict,
  })}`;
}

/** Builds the production `startPlanPrivateAuth` issuer for the SQLite
 * lifecycle driver. The caller constructs it only after the official
 * credential read succeeded; Coding Plan providers never enter this path. */
export async function createProductionStartPlanAuth(
  options: ProductionAuthIssuerOptions,
): Promise<ProductionAuthIssuer | null> {
  const now = options.now ?? Date.now;
  const resolveAuthentication = async (
    signal: AbortSignal,
  ): Promise<OfficialStartPlanAuthentication | null> => {
    try {
      return normalizeOfficialStartPlanAuthentication(
        await options.authentication.resolveStartPlanAuthentication({
          family: "bigmodel",
          signal,
        }),
      );
    } catch {
      return null;
    }
  };
  const initial = await resolveAuthentication(options.signal);
  if (!initial) return null;
  interface EntitlementContext {
    readonly account: string;
    readonly provider: string;
    readonly model: string;
    readonly deviceMid: string;
    readonly sessionRevision: string | null;
    readonly credentialDigest: string;
    readonly credentialExpiresAt: number | null;
    readonly verdict: EntitlementCheckResult;
  }
  let entitlementContext: EntitlementContext | null = null;
  let issuedTask: string | null = null;
  const sameEntitlementContext = (
    context: EntitlementContext,
    credential: OfficialStartPlanAuthentication,
    provider: string,
    model: string,
    credentialDigest: string,
  ): boolean => context.account === credential.accountIdentity && context.provider === provider
    && context.model === model && context.deviceMid === credential.deviceMid
    && context.sessionRevision === credential.sessionRevision
    && context.credentialDigest === credentialDigest
    && context.credentialExpiresAt === credential.credentialExpiresAt;
  const rejection = (verdict: EntitlementCheckResult): Error => {
    const providerCode = verdict.status === "entitled" ? undefined : verdict.providerCode;
    if (verdict.status === "entitled") throw new Error("start_plan_entitlement_rejection_invalid");
    const failureFacts = verdict.failureFacts ?? Object.freeze({
      request_attempted: null,
      http_status: null,
      provider_code: providerCode ?? null,
      failure_class: "unknown" as const,
      entitlement_verdict: failureVerdict(verdict.status),
    });
    return new StartPlanEntitlementRejectionError(verdict.status, failureFacts, providerCode);
  };
  const authoritativeEntitlement = async (
    credential: OfficialStartPlanAuthentication,
    provider: string,
    model: string,
    signal: AbortSignal,
  ): Promise<EntitlementCheckResult> => {
    const credentialDigest = createHash("sha256").update(credential.requestCredential).digest("hex");
    if (entitlementContext) {
      if (!sameEntitlementContext(entitlementContext, credential, provider, model, credentialDigest)) {
        throw new Error("start_plan_entitlement_identity_invalid");
      }
      return entitlementContext.verdict;
    }
    const verdict = await options.entitlement.check({
      account: credential.accountIdentity,
      provider,
      model,
      deviceMid: credential.deviceMid,
      jwt: credential.requestCredential,
      signal,
    });
    entitlementContext = Object.freeze({
      account: credential.accountIdentity,
      provider,
      model,
      deviceMid: credential.deviceMid,
      sessionRevision: credential.sessionRevision,
      credentialDigest,
      credentialExpiresAt: credential.credentialExpiresAt,
      verdict,
    });
    return verdict;
  };
  return {
    // Captured from the official credential at construction; issue() re-reads
    // the credential and rejects if the account identity changed mid-run.
    account: initial.accountIdentity,
    signal: options.signal,
    async prepare(provider, model, signal) {
      if (provider !== "account:bigmodel-start-plan" || !model || signal.aborted) return false;
      const credential = await resolveAuthentication(signal);
      if (!credential || credential.accountIdentity !== initial.accountIdentity
        || credential.sessionRevision !== initial.sessionRevision
        || credential.credentialExpiresAt !== null && credential.credentialExpiresAt <= now()) return false;
      const credentialDigest = createHash("sha256").update(credential.requestCredential).digest("hex");
      if (entitlementContext && !sameEntitlementContext(entitlementContext, credential, provider, model, credentialDigest)) return false;
      const verdict = await authoritativeEntitlement(credential, provider, model, signal);
      if (signal.aborted) return false;
      if (verdict.status !== "entitled") {
        // Mirror the issue() rejection shape so the lifecycle gate can stage
        // a sanitized classification; the gate treats throw and false the
        // same (fail-closed), this only preserves the diagnosable verdict.
        throw rejection(verdict);
      }
      return true;
    },
    async issue(binding, signal) {
      const credential = await resolveAuthentication(signal);
      if (!credential) throw new Error("start_plan_credential_unavailable");
      if (binding.account !== credential.accountIdentity) throw new Error("start_plan_account_identity_invalid");
      if (credential.sessionRevision !== initial.sessionRevision) {
        throw new Error("start_plan_account_identity_invalid");
      }
      if (credential.credentialExpiresAt !== null && credential.credentialExpiresAt <= now()) {
        throw new Error("start_plan_credential_expired");
      }
      if (signal.aborted) throw new Error("start_plan_issuer_cancelled");
      if (binding.provider !== "account:bigmodel-start-plan" || !binding.model) {
        throw new Error("start_plan_identity_invalid");
      }
      if (issuedTask !== null) throw new Error("start_plan_lease_already_issued");
      if (!entitlementContext) throw new Error("start_plan_entitlement_not_prepared");
      issuedTask = binding.task;
      const verdict = await authoritativeEntitlement(credential, binding.provider, binding.model, signal);
      if (verdict.status !== "entitled") {
        throw rejection(verdict);
      }
      const createdAt = now();
      // Observed Start Plan JWTs may omit `exp`. In that case the Worker cache
      // is bounded by the task's parent-lifetime channel rather than a local
      // short TTL. Delivery itself remains one-shot and bounded to 30 seconds.
      const credentialExpiresAt = credential.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER;
      const deliveryDeadline = Math.min(credentialExpiresAt, createdAt + 30_000);
      return new PrivateCredentialLease(
        binding,
        credential.requestCredential,
        credentialExpiresAt,
        now,
        deliveryDeadline,
      );
    },
  };
}

const officialCliVersionCache = new Map<string, string>();

/** Reads the official CLI version by running the official entry with
 * `--version` once and caching the answer. Read-only; no network, no task. */
export async function readOfficialCliVersion(zcodeEntrypoint: string): Promise<string | undefined> {
  const key = path.resolve(zcodeEntrypoint);
  const cached = officialCliVersionCache.get(key);
  if (cached) return cached;
  const version = await new Promise<string | undefined>((resolve) => {
    const child = spawn(process.execPath, [key, "--version"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 15_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(undefined); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const value = out.trim();
      resolve(code === 0 && /^\d+\.\d+\.\d+/.test(value) ? value : undefined);
    });
  });
  if (version) officialCliVersionCache.set(key, version);
  return version;
}
