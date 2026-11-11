/** Model Routing v1 (ADR-031): resolve one user-visible task model selection
 * to the actual provider/model executed by ZCode. Routing is a task-creation
 * concern only: it never authorizes anything, never sends Billing requests,
 * and never changes the official model id sent to the AppServer. */
import { existsSync, readFileSync } from "node:fs";
import { BridgeError } from "./errors.js";
import type { TaskPackage, ZCodeModelSelection } from "../interfaces.js";
import type { EntitlementStatus, StartPlanLiveEntitlement } from "./start-plan-production-auth.js";

export const START_PLAN_PROVIDER_ID = "account:bigmodel-start-plan";
export const START_PLAN_ALIAS_SUFFIX = "-StartPlan";

/** `zcode_task.model` as accepted by the public MCP schema: `provider_id` is
 * optional and routing resolves it before a TaskPackage is persisted. */
export type RawTaskModelSelection = {
  readonly provider_id?: string;
  readonly model_id: string;
  readonly reasoning_level?: string;
};

export type ModelRoutingMode =
  | "explicit-start-plan"
  | "explicit-provider"
  | "prefer-off-coding-plan"
  | "auto-start-plan"
  | "fallback-coding-plan"
  | "passthrough";

export interface ModelRoutingDecision {
  readonly mode: ModelRoutingMode;
  /** Selection exactly as provided; alias names are preserved here. */
  readonly requested: RawTaskModelSelection | null;
  /** Persisted TaskPackage selection: always fully resolved. */
  readonly resolved: ZCodeModelSelection | null;
  /** Bounded, credential-free explanation of why this route was taken. */
  readonly reason?: string;
}

export interface StartPlanRoutingRegistry {
  /** Official Start Plan model ids from the provider registry. Empty when
   * the registry is unreadable; alias validation then defers to the task
   * preflight instead of guessing. */
  readonly startPlanModelIds: readonly string[];
  /** Coding Plan providers (official `individual-coding-plan` access) with
   * their advertised builtin model ids, in registry order. */
  readonly codingPlanProviders: ReadonlyArray<{ readonly providerId: string; readonly modelIds: readonly string[] }>;
}

interface RoutingSettings {
  readonly preferStartPlan: boolean;
  readonly defaultProviderId: string;
}

export interface TaskModelRouterOptions {
  /** Persisted-runtime settings; re-read per task so config edits apply without a Host restart. */
  readonly settings: () => RoutingSettings;
  /** Non-authoritative verdict cache fed by live Billing checks. */
  readonly journal: StartPlanEntitlementJournal;
  /** Official provider registry snapshot; may return null when ZCode runtime
   * configuration cannot be resolved (routing then fails closed for
   * provider-less models and defers alias validation for explicit ones). */
  readonly registry: () => Promise<StartPlanRoutingRegistry | null>;
  /** Maximum cached task_id routings; the oldest entry is evicted first. */
  readonly cacheLimit?: number;
}

/** Strips the `-StartPlan` suffix. Returns null when the name does not carry it. */
export function stripStartPlanAlias(modelId: string): string | null {
  if (!modelId.endsWith(START_PLAN_ALIAS_SUFFIX)) return null;
  const base = modelId.slice(0, -START_PLAN_ALIAS_SUFFIX.length).trim();
  return base ? base : null;
}

/** Reads the official provider registry rules (same source as the account
 * provider snapshot). Read-only; never logs or returns file contents. */
export function readStartPlanRoutingRegistry(config: { providerBuiltinConfigFile: string; providerPersonalConfigFile: string }): StartPlanRoutingRegistry {
  const rules = [config.providerBuiltinConfigFile, config.providerPersonalConfigFile]
    .flatMap((file) => readProviderRules(readJson(file)));
  const startPlanModelIds: string[] = [];
  const codingPlanProviders: Array<{ providerId: string; modelIds: string[] }> = [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.providerId !== "string") continue;
    const access = isRecord(rule.config) && isRecord((rule.config as JsonRecord).access)
      ? (rule.config as JsonRecord).access as JsonRecord
      : null;
    const builtin = isRecord(rule.config) && Array.isArray((rule.config as JsonRecord).builtinModelIds)
      ? ((rule.config as JsonRecord).builtinModelIds as unknown[]).filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    if (rule.providerId === START_PLAN_PROVIDER_ID) {
      for (const id of builtin) if (!startPlanModelIds.includes(id)) startPlanModelIds.push(id);
      continue;
    }
    if (access?.mode === "individual-coding-plan" && builtin.length > 0) {
      codingPlanProviders.push({ providerId: rule.providerId, modelIds: builtin });
    }
  }
  return { startPlanModelIds, codingPlanProviders };
}

/** Derives `<OfficialModelId>-StartPlan` catalog entries for the Start Plan
 * provider. Presentation only: alias entries carry no entitlement claim. */
export function startPlanAliasCatalogEntries(registry: StartPlanRoutingRegistry): Array<{ provider_id: string; model_id: string; label: string; provider_label: string }> {
  return registry.startPlanModelIds.map((modelId) => ({
    provider_id: START_PLAN_PROVIDER_ID,
    model_id: `${modelId}${START_PLAN_ALIAS_SUFFIX}`,
    label: `${modelId} (Start Plan)`,
    provider_label: "Start Plan",
  }));
}

/** Only confirmed plan/model facts may drive an execution-time fallback.
 * Unknown, transport, risk-control, and identity verdicts never fall back. */
const FALLBACK_VERDICTS: ReadonlySet<EntitlementStatus> = new Set(["no_entitlement", "quota_exhausted", "model_unavailable"]);

/** `ZCODE_BRIDGE_PREFER_STARTPLAN` is a strict boolean; default true. */
export function resolvePreferStartPlan(env: NodeJS.ProcessEnv): boolean {
  const raw = env["ZCODE_BRIDGE_PREFER_STARTPLAN"]?.trim();
  if (!raw) return true;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new BridgeError("provider_config_invalid", "ZCODE_BRIDGE_PREFER_STARTPLAN must be true or false");
}

/**
 * Non-authoritative, process-local record of live Start Plan Billing verdicts.
 * Entries are advisory execution-routing facts only; they never replace the
 * per-task live entitlement check and never persist anywhere.
 */
export class StartPlanEntitlementJournal {
  readonly #verdicts = new Map<string, { status: EntitlementStatus; observedAt: number }>();

  record(model: string, status: EntitlementStatus, observedAt: number): void {
    this.#verdicts.set(model, { status, observedAt });
  }

  latest(model: string): EntitlementStatus | null {
    return this.#verdicts.get(model)?.status ?? null;
  }
}

/** Delegating entitlement wrapper that feeds the routing journal from every
 * live Billing check without adding any request. */
export class RecordingStartPlanEntitlement implements StartPlanLiveEntitlement {
  readonly #inner: StartPlanLiveEntitlement;
  readonly #journal: StartPlanEntitlementJournal;

  constructor(inner: StartPlanLiveEntitlement, journal: StartPlanEntitlementJournal) {
    this.#inner = inner;
    this.#journal = journal;
  }

  async check(input: Parameters<StartPlanLiveEntitlement["check"]>[0]): Promise<Awaited<ReturnType<StartPlanLiveEntitlement["check"]>>> {
    const verdict = await this.#inner.check(input);
    this.#journal.record(input.model, verdict.status, verdict.observedAt);
    return verdict;
  }
}

/** Task as accepted from the public schema: `model.provider_id` may be absent
 * and is resolved before persistence. */
export type RoutingTaskInput = Omit<TaskPackage, "model"> & { readonly model?: RawTaskModelSelection };

/** Task-creation routing hook wired into the SQLite Authority (ADR-031).
 * `route` runs before TaskPackage validation/persistence; `confirmRouting`
 * promotes the pending routing to the accepted idempotency cache only after
 * the Authority has durably persisted the TaskPackage, so a routing,
 * validation, Admission, or Start Plan preflight failure before the first
 * persistence leaves no cache reservation behind. */
export interface TaskModelRouter {
  route(task: RoutingTaskInput): Promise<TaskPackage>;
  confirmRouting(taskId: string): void;
}

interface RoutingCacheEntry {
  /** Stable, credential-free identity of the normalized raw model request. */
  readonly identity: string;
  readonly resolved: ZCodeModelSelection;
}

/** Stable, credential-free identity of one normalized raw model request.
 * Distinct raw identities — e.g. the provider-less `<ModelId>-StartPlan` alias
 * versus the explicit Start Plan provider with the raw official model id —
 * never share a cache slot even when they resolve to the same persisted
 * TaskPackage; the SQLite Authority then replays through TaskPackage equality.
 * Resolved-result equality alone is never a cache identity. */
function normalizedRawRequestIdentity(raw: RawTaskModelSelection): string {
  return JSON.stringify([raw.provider_id ?? null, raw.model_id, raw.reasoning_level ?? null]);
}

export function createTaskModelRouter(options: TaskModelRouterOptions): TaskModelRouter {
  const cacheLimit = options.cacheLimit ?? 500;
  // Accepted entries replay the first persisted decision for an identical
  // normalized raw request (ADR-031); pending entries hold this call's
  // routing until the Authority confirms persistence and never satisfy a
  // cache lookup, so re-routing always evaluates current inputs.
  const accepted = new Map<string, RoutingCacheEntry>();
  const pending = new Map<string, RoutingCacheEntry>();

  const route = async (task: RoutingTaskInput): Promise<TaskPackage> => {
    if (!task.model) return task as TaskPackage;
    const raw: RawTaskModelSelection = {
      model_id: task.model.model_id.trim(),
      ...(task.model.provider_id?.trim() ? { provider_id: task.model.provider_id.trim() } : {}),
      ...(task.model.reasoning_level?.trim() ? { reasoning_level: task.model.reasoning_level.trim() } : {}),
    };
    if (!raw.model_id) throw new BridgeError("provider_config_invalid", "model_id must not be blank");
    const identity = normalizedRawRequestIdentity(raw);
    const cached = accepted.get(task.task_id);
    if (cached && cached.identity === identity) return { ...task, model: cached.resolved };

    const settings = options.settings();
    const registry = await options.registry();
    const routed = routeTaskModel(raw, settings, registry, options.journal);
    const entry: RoutingCacheEntry = { identity, resolved: routed.resolved! };
    // A content-changed re-submission must not overwrite the first accepted
    // routing: the SQLite Authority compares it against the persisted
    // TaskPackage to decide TASK_ID_CONFLICT or an equality replay.
    if (!accepted.has(task.task_id)) {
      pending.set(task.task_id, entry);
      if (pending.size > cacheLimit) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
    }
    return { ...task, model: routed.resolved! };
  };

  return {
    route,
    confirmRouting(taskId: string): void {
      const entry = pending.get(taskId);
      if (!entry) return;
      pending.delete(taskId);
      accepted.set(taskId, entry);
      if (accepted.size > cacheLimit) {
        const oldest = accepted.keys().next().value;
        if (oldest !== undefined) accepted.delete(oldest);
      }
    },
  };
}

/** Pure routing matrix (ADR-031 priority order). Throws BridgeError for
 * unresolvable selections; never substitutes a different model id. */
export function routeTaskModel(
  raw: RawTaskModelSelection,
  settings: RoutingSettings,
  registry: StartPlanRoutingRegistry | null,
  journal: Pick<StartPlanEntitlementJournal, "latest">,
): ModelRoutingDecision {
  const reasoning = raw.reasoning_level?.trim();
  const withReasoning = (modelId: string): ZCodeModelSelection => ({
    provider_id: "",
    model_id: modelId,
    ...(reasoning ? { reasoning_level: reasoning } : {}),
  });

  if (raw.provider_id) {
    if (raw.provider_id === START_PLAN_PROVIDER_ID) {
      const base = stripStartPlanAlias(raw.model_id) ?? raw.model_id;
      if (registry && registry.startPlanModelIds.length > 0 && !registry.startPlanModelIds.includes(base)) {
        throw new BridgeError("provider_config_invalid", `the requested Start Plan model is not present in the official provider registry: ${base}`);
      }
      return { mode: "explicit-start-plan", requested: raw, resolved: { ...withReasoning(base), provider_id: START_PLAN_PROVIDER_ID } };
    }
    return { mode: "explicit-provider", requested: raw, resolved: { ...withReasoning(raw.model_id), provider_id: raw.provider_id } };
  }

  const aliasBase = stripStartPlanAlias(raw.model_id);
  if (aliasBase) {
    if (!registry || registry.startPlanModelIds.length === 0 || !registry.startPlanModelIds.includes(aliasBase)) {
      throw new BridgeError("provider_config_invalid", `unknown Start Plan model alias: ${raw.model_id}`);
    }
    return {
      mode: "explicit-start-plan",
      requested: raw,
      resolved: { ...withReasoning(aliasBase), provider_id: START_PLAN_PROVIDER_ID },
    };
  }

  if (settings.preferStartPlan) {
    const verdict = journal.latest(raw.model_id);
    if (verdict && FALLBACK_VERDICTS.has(verdict)) {
      const providerId = resolveCodingPlanProvider(raw.model_id, settings, registry);
      if (providerId) {
        return {
          mode: "fallback-coding-plan",
          requested: raw,
          resolved: { ...withReasoning(raw.model_id), provider_id: providerId },
          reason: `start plan verdict ${verdict} for this model; routing to the coding plan provider`,
        };
      }
      // No Coding Plan provider supports this model: keep Start Plan so the
      // task fails with the live preflight classification instead of a guess.
      return {
        mode: "auto-start-plan",
        requested: raw,
        resolved: { ...withReasoning(raw.model_id), provider_id: START_PLAN_PROVIDER_ID },
        reason: `start plan verdict ${verdict} but no coding plan provider supports this model; deferring to the live preflight`,
      };
    }
    return { mode: "auto-start-plan", requested: raw, resolved: { ...withReasoning(raw.model_id), provider_id: START_PLAN_PROVIDER_ID } };
  }

  const providerId = resolveCodingPlanProvider(raw.model_id, settings, registry);
  if (!providerId) {
    throw new BridgeError("provider_config_invalid", `no coding plan provider supports the model: ${raw.model_id}`);
  }
  return { mode: "prefer-off-coding-plan", requested: raw, resolved: { ...withReasoning(raw.model_id), provider_id: providerId } };
}

/** Bridge default provider wins when it advertises the model; otherwise the
 * first official Coding Plan provider that does. */
function resolveCodingPlanProvider(modelId: string, settings: RoutingSettings, registry: StartPlanRoutingRegistry | null): string | null {
  if (settings.defaultProviderId && settings.defaultProviderId !== START_PLAN_PROVIDER_ID
    && (!registry || registry.codingPlanProviders.some((provider) => provider.providerId === settings.defaultProviderId && provider.modelIds.includes(modelId)))) {
    return settings.defaultProviderId;
  }
  return registry?.codingPlanProviders.find((provider) => provider.modelIds.includes(modelId))?.providerId ?? null;
}

type JsonRecord = Record<string, unknown>;

function readJson(filePath: string): JsonRecord | null {
  try {
    if (!existsSync(filePath)) return null;
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readProviderRules(table: JsonRecord | null): unknown[] {
  const providerConfigRules = isRecord(table?.config) ? (table!.config as JsonRecord) : {};
  const rules = isRecord(providerConfigRules.providerConfigRules)
    ? (providerConfigRules.providerConfigRules as JsonRecord).providerRules
    : undefined;
  return Array.isArray(rules) ? rules : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
