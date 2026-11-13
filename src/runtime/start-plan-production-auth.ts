import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  | { readonly status: EntitlementStatus; readonly reason: string; readonly providerCode?: string; readonly observedAt: number };

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
  return envelope.success === true
    && (envelope.code === undefined || envelope.code === 0 || envelope.code === 200);
}

function stringKeyedArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(isRecord) as Array<Record<string, unknown>>
    : [];
}

function hasActiveStartPlan(envelope: OfficialBillingEnvelope): boolean {
  const plans = stringKeyedArray(envelope.data?.plans);
  return plans.some((plan) => {
    const status = typeof plan.status === "string" ? plan.status.trim().toLowerCase() : "";
    const planId = typeof plan.plan_id === "string" ? plan.plan_id.trim().toLowerCase() : "";
    const name = typeof plan.name === "string" ? plan.name.trim().toLowerCase() : "";
    const startPlanIdentity = planId.includes("start-plan") || planId.includes("start plan")
      || name.includes("start-plan") || name.includes("start plan");
    return status === "active" && startPlanIdentity;
  });
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

function numericUnit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function requestedModelQuotaVerdict(
  balances: Array<Record<string, unknown>>,
  requestedModel: string,
): "exhausted" | "unproven" | "available" {
  const relevant = balances.filter((balance) => {
    const capabilities = Array.isArray(balance.capabilities) ? balance.capabilities : [];
    const models = capabilities.flatMap((capability) => {
      const raw = typeof capability === "string" ? capability.trim().toLowerCase() : "";
      return raw.startsWith("model:") ? [raw.slice(6).trim()] : [];
    }).filter(Boolean);
    return models.length > 0 ? models.includes(requestedModel)
      : typeof balance.show_name === "string" && balance.show_name.trim().toLowerCase() === requestedModel;
  });
  if (relevant.length === 0) return "unproven";
  const units = relevant.map((balance) => numericUnit(balance.remaining_units));
  // A missing, non-numeric, or negative remaining_units value is not quota
  // evidence; entitlement must fail closed instead of being presumed.
  if (units.some((unit) => unit === null || unit < 0)) return "unproven";
  return units.every((unit) => unit === 0) ? "exhausted" : "available";
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
  return typeof raw === "number" || typeof raw === "string" ? String(raw) : undefined;
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
}): { status: EntitlementStatus; reason: string; providerCode?: string } {
  const code = input.providerCode?.trim();
  const providerCode = code ? code : undefined;
  if (code === "3007") return { status: "captcha_required", reason: "provider requested captcha verification", providerCode };
  if (code === "3012") return { status: "unusual_activity", reason: "provider blocked this identity due to unusual activity", providerCode };
  if (code === "3001") return { status: "billing_parameter_error", reason: "billing request parameters were rejected", providerCode };
  if (input.statusCode === 401) return { status: "unauthorized", reason: "credential was rejected as unauthenticated" };
  if (input.statusCode === 403) return { status: "forbidden", reason: "credential is authenticated but forbidden from this plan or model" };
  // Body-derived entitlement facts are only provable on a 200 exchange;
  // 429/5xx responses must keep their status-based classification even when
  // the body carries an entitled-looking envelope.
  const envelope = input.statusCode === 200 ? asOfficialBillingEnvelope(input.body) : undefined;
  if (envelope && isSuccessfulBusinessEnvelope(envelope) && hasActiveStartPlan(envelope)) {
    const balances = stringKeyedArray(envelope.data?.balances);
    const models = startPlanBalanceModelIds(balances);
    if (models.length === 0) {
      return { status: "unavailable", reason: "billing response proved the plan but not the requested model" };
    }
    const requested = input.model?.trim().toLowerCase();
    if (!requested) return { status: "unavailable", reason: "billing response had no requested model identity to authorize" };
    if (!models.includes(requested)) {
      return { status: "model_unavailable", reason: "active Start Plan does not list the requested model" };
    }
    const quota = requestedModelQuotaVerdict(balances, requested);
    if (quota === "unproven") {
      return { status: "unavailable", reason: "billing response did not prove available quota for the requested model" };
    }
    if (quota === "exhausted") {
      return { status: "quota_exhausted", reason: "plan quota is exhausted for the requested model" };
    }
    return { status: "entitled", reason: "active Start Plan lists the requested model" };
  } else if (envelope && isSuccessfulBusinessEnvelope(envelope) && !hasActiveStartPlan(envelope)) {
    return { status: "no_entitlement", reason: "no active Start Plan was present in the billing response" };
  }
  if (input.statusCode === 429) return { status: "rate_limited", reason: "rate limited; quota state unknown from status alone" };
  if (input.statusCode >= 500) return { status: "unavailable", reason: "entitlement service error" };
  if (input.statusCode >= 400) return { status: "unavailable", reason: "entitlement query rejected without a recognized provider code" };
  return { status: "unavailable", reason: "entitlement response could not be interpreted" };
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
    if (!appVersion) return { status: "unavailable", reason: "official cli version unavailable; refusing to guess", observedAt };
    if (!input.deviceMid.trim()) return { status: "unavailable", reason: "official device identity unavailable; refusing to guess", observedAt };
    const url = `${this.#origin}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}&mid=${encodeURIComponent(input.deviceMid)}`;
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: "GET",
        headers: {
          // Observed official balance requests carry the persistent device
          // identity in both the `mid` query and the `X-Device-Mid` header
          // (2026-11-06 native request audit); omitting them is rejected
          // with provider code 3001. This is a read-only billing query,
          // never a model request; app version comes from the official
          // runtime and identity remains in memory.
          Authorization: `Bearer ${input.jwt}`,
          "X-Device-Mid": input.deviceMid,
        },
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      return { status: "unavailable", reason: "entitlement transport failed", observedAt };
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
      });
      if (classified.status === "entitled") {
        let requestId = "";
        try { requestId = (response.headers.get("x-request-id") ?? "").trim(); } catch { /* header access is safe, keep empty */ }
        return { status: "entitled", observedAt: this.#now(), requestId };
      }
      return { ...classified, observedAt: this.#now() };
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
    return { ...this.#interpretBillingBody({ statusCode: response.status, providerCode, body, model: input.model }), observedAt };
  }

  #interpretBillingBody(input: {
    statusCode: number;
    providerCode?: string;
    body?: Record<string, unknown>;
    model: string;
  }): { status: EntitlementStatus; reason: string } {
    return classifyEntitlementFailure(input);
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
    return new Error(`start_plan_entitlement_rejected:${verdict.status}${providerCode ? `:${providerCode}` : ""}`);
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
