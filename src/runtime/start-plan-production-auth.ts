import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

export interface OfficialStartPlanCredential {
  /** OAuth JWT from the official credentials store. Model requests use it as
   * the X-Coding-Plan-Api-Key value through the private delivery channel. */
  readonly jwt: string;
  /** Authenticated account identity parsed from the official OAuth record. */
  readonly account: string;
  /** Absolute epoch ms when the JWT expires, or null when it carries no exp. */
  readonly expiresAt: number | null;
  /** Official persistent device identity from the production data root. */
  readonly deviceMid: string;
}

interface OfficialCredentialRecord {
  readonly zcodejwttoken?: unknown;
  readonly "oauth:bigmodel:user_info"?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const payload = jwt.split(".")[1]!;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads the official Start Plan credential from the real production data
 * root. The value exists in memory only; callers must never persist it. */
export function readOfficialStartPlanCredential(dataRoot: string): OfficialStartPlanCredential | null {
  const credentialsPath = path.join(dataRoot, ".zcode", "v2", "credentials.json");
  let parsed: OfficialCredentialRecord;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as OfficialCredentialRecord;
  } catch {
    return null;
  }
  const jwt = typeof parsed.zcodejwttoken === "string" ? parsed.zcodejwttoken.trim() : "";
  if (!jwt || !looksLikeJwt(jwt)) return null;
  const userInfo = isRecord(parsed["oauth:bigmodel:user_info"]) ? parsed["oauth:bigmodel:user_info"] : null;
  const accountCandidates = [userInfo?.id, userInfo?.user_id, userInfo?.account_id, userInfo?.email];
  const account = accountCandidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  if (!account) return null;
  const payload = decodeJwtPayload(jwt);
  const exp = payload?.exp;
  const expiresAt = typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1_000 : null;
  let deviceMid = "";
  try {
    const telemetry = JSON.parse(readFileSync(path.join(dataRoot, ".zcode", "v2", "telemetry-state.json"), "utf8")) as { deviceMid?: unknown };
    if (typeof telemetry.deviceMid === "string" && telemetry.deviceMid.trim()) deviceMid = telemetry.deviceMid.trim();
  } catch { /* deviceMid stays empty; entitlement check treats it as required */ }
  if (!deviceMid) return null;
  return { jwt, account, expiresAt, deviceMid };
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
}): { status: EntitlementStatus; reason: string } {
  const code = input.providerCode?.trim();
  if (code === "3007") return { status: "captcha_required", reason: "provider requested captcha verification" };
  if (code === "3012") return { status: "unusual_activity", reason: "provider blocked this identity due to unusual activity" };
  if (code === "3001") return { status: "billing_parameter_error", reason: "billing request parameters were rejected" };
  if (input.statusCode === 401) return { status: "unauthorized", reason: "credential was rejected as unauthenticated" };
  if (input.statusCode === 403) return { status: "forbidden", reason: "credential is authenticated but forbidden from this plan or model" };
  const data = isRecord(input.body?.data) ? input.body.data : input.body;
  if (isRecord(data)) {
    const quota = data.quota_remaining ?? data.balance ?? data.remaining;
    if (typeof quota === "number" && quota <= 0) return { status: "quota_exhausted", reason: "plan quota is exhausted" };
    const models = data.models ?? data.available_models;
    if (Array.isArray(models) && models.length > 0) {
      return { status: "no_entitlement", reason: "plan exists but the requested model is not in its entitlement list" };
    }
  }
  if (input.statusCode === 429) return { status: "unavailable", reason: "rate limited; quota state unknown from status alone" };
  if (input.statusCode >= 500) return { status: "unavailable", reason: "entitlement service error" };
  if (input.statusCode >= 400) return { status: "no_entitlement", reason: "entitlement query rejected without a recognized provider code" };
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
    const url = `${this.#origin}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}`;
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: "GET",
        headers: {
          // Official-observed header shapes for the Start Plan control plane
          // (billing query). This is not a model request and must never be
          // used as one; app version and device identity come from the
          // official runtime sources, never from TaskPackage input.
          Authorization: `Bearer ${input.jwt}`,
          "X-Device-Mid": input.deviceMid,
          "User-Agent": `ZCode/${appVersion}`,
          "X-ZCode-App-Version": appVersion,
          "HTTP-Referer": this.#origin,
          "X-Title": "Z Code@cli",
        },
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      return { status: "unavailable", reason: "entitlement transport failed", observedAt };
    }
    if (response.status === 200) {
      let requestId = "";
      try { requestId = response.headers.get("x-request-id") ?? ""; } catch { /* header access is safe, keep empty */ }
      return { status: "entitled", observedAt: this.#now(), requestId };
    }
    let body: Record<string, unknown> | undefined;
    let providerCode: string | undefined;
    try {
      const parsed: unknown = await response.json();
      if (isRecord(parsed)) {
        body = parsed;
        const error = isRecord(parsed.error) ? parsed.error : null;
        const raw = error?.providerCode ?? parsed.providerCode ?? (error ? (error as Record<string, unknown>).code : undefined) ?? parsed.code;
        if (typeof raw === "number" || typeof raw === "string") providerCode = String(raw);
      }
    } catch { /* body unreadable; classification falls back to status */ }
    return { ...classifyEntitlementFailure({ statusCode: response.status, providerCode, body }), observedAt };
  }

}

export interface ProductionAuthIssuerOptions {
  /** Real production data root (the parent of `.zcode`). */
  readonly dataRoot: string;
  /** Aborted when the Host shuts down or the account is invalidated. */
  readonly signal: AbortSignal;
  readonly entitlement: StartPlanLiveEntitlement;
  readonly now?: () => number;
}

export type ProductionAuthIssuer = NonNullable<import("../store/lifecycle-gate.js").ClaimOnlyDriverOptions["startPlanPrivateAuth"]>;

/** Builds the production `startPlanPrivateAuth` issuer for the SQLite
 * lifecycle driver. The caller constructs it only after the official
 * credential read succeeded; Coding Plan providers never enter this path. */
export function createProductionStartPlanAuth(options: ProductionAuthIssuerOptions): ProductionAuthIssuer | null {
  const now = options.now ?? Date.now;
  const initial = readOfficialStartPlanCredential(options.dataRoot);
  if (!initial) return null;
  return {
    // Captured from the official credential at construction; issue() re-reads
    // the credential and rejects if the account identity changed mid-run.
    account: initial.account,
    signal: options.signal,
    async issue(binding, signal) {
      const credential = readOfficialStartPlanCredential(options.dataRoot);
      if (!credential) throw new Error("start_plan_credential_unavailable");
      if (binding.account !== credential.account) throw new Error("start_plan_account_identity_invalid");
      if (signal.aborted) throw new Error("start_plan_issuer_cancelled");
      const entitlement = options.entitlement;
      const verdict = await entitlement.check({
        account: credential.account,
        provider: binding.provider,
        model: binding.model,
        deviceMid: credential.deviceMid,
        jwt: credential.jwt,
        signal,
      });
      if (verdict.status !== "entitled") {
        throw new Error(`start_plan_entitlement_rejected:${verdict.status}${verdict.providerCode ? `:${verdict.providerCode}` : ""}`);
      }
      const createdAt = now();
      // Observed Start Plan JWTs may omit `exp`; without it the lease stays
      // inside the one-shot delivery window only. The lease constructor caps
      // any lifetime at 60 seconds.
      const expiresAt = Math.min(credential.expiresAt ?? Number.MAX_SAFE_INTEGER, createdAt + 30_000);
      return new PrivateCredentialLease(binding, credential.jwt, expiresAt, now);
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
