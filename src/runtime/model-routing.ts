/** Model Routing v2: resolve one user-visible task model selection from the
 * live ZCode AppServer model catalog. Routing never authorizes anything,
 * never sends Billing requests, and never changes the exact model id selected
 * from the runtime catalog. */
import { BridgeError } from "./errors.js";
import type { TaskPackage, ZCodeModelSelection } from "../interfaces.js";
import { isOfficialCodingPlanProvider } from "./official-app-server-runtime.js";
import type { EntitlementStatus, StartPlanLiveEntitlement } from "./start-plan-production-auth.js";

export const START_PLAN_PROVIDER_ID = "account:bigmodel-start-plan";
export const START_PLAN_ALIAS_SUFFIX = "-StartPlan";

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
  | "passthrough";

export interface ModelRoutingDecision {
  readonly mode: ModelRoutingMode;
  readonly requested: RawTaskModelSelection | null;
  readonly resolved: ZCodeModelSelection | null;
  readonly reason?: string;
}

export interface DynamicModelRoutingEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevels: readonly string[];
  readonly reasoningDefaultLevel: string | null;
}

export interface DynamicModelRoutingCatalog {
  readonly entries: readonly DynamicModelRoutingEntry[];
  readonly startPlanUnavailableReason?: string | null;
}

export interface RoutingSettings {
  readonly preferStartPlan: boolean;
  readonly defaultProviderId: string;
}

export interface TaskModelRouterOptions {
  readonly settings: () => RoutingSettings;
  /** `plan` lets a caller that only needs one account's catalog avoid the other live read. */
  readonly catalog: (workspace: string, plan?: RoutingCatalogPlan) => Promise<DynamicModelRoutingCatalog>;
  readonly cacheLimit?: number;
}

/** Which live catalog a caller reads: the current account's, the Start Plan one, or both (default). */
export type RoutingCatalogPlan = "current" | "start_plan" | "all";

export function stripStartPlanAlias(modelId: string): string | null {
  if (!modelId.endsWith(START_PLAN_ALIAS_SUFFIX)) return null;
  const base = modelId.slice(0, -START_PLAN_ALIAS_SUFFIX.length).trim();
  return base || null;
}

export function buildModelRoutingCatalog(
  models: ReadonlyArray<{
    readonly provider_id: string;
    readonly model_id: string;
    readonly reasoning_levels?: readonly { readonly value: string }[];
    readonly reasoning_default_level?: string;
  }>,
): DynamicModelRoutingCatalog {
  return {
    entries: models.map((model) => ({
      providerId: model.provider_id,
      modelId: model.model_id,
      reasoningLevels: (model.reasoning_levels ?? []).map((level) => level.value),
      reasoningDefaultLevel: model.reasoning_default_level ?? null,
    })),
  };
}

export function startPlanAliasCatalogEntries(
  models: ReadonlyArray<{ provider_id: string; model_id: string }>,
): Array<{ provider_id: string; model_id: string; label: string; provider_label: string }> {
  return models
    .filter((model) => model.provider_id === START_PLAN_PROVIDER_ID)
    .map((model) => ({ model, base: stripStartPlanAlias(model.model_id) ?? model.model_id }))
    .filter(({ model, base }) => Boolean(base)
      && !models.some((candidate) => candidate.provider_id === model.provider_id
        && candidate.model_id === `${base}${START_PLAN_ALIAS_SUFFIX}`))
    .map(({ model, base }) => ({
      provider_id: model.provider_id,
      model_id: `${base}${START_PLAN_ALIAS_SUFFIX}`,
      label: `${base} (Start Plan)`,
      provider_label: "Start Plan",
    }));
}

export function resolvePreferStartPlan(env: NodeJS.ProcessEnv): boolean {
  const raw = env["ZCODE_BRIDGE_PREFER_STARTPLAN"]?.trim();
  if (!raw) return true;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new BridgeError("provider_config_invalid", "ZCODE_BRIDGE_PREFER_STARTPLAN must be true or false");
}

export class StartPlanEntitlementJournal {
  readonly #verdicts = new Map<string, { status: EntitlementStatus; observedAt: number }>();

  record(model: string, status: EntitlementStatus, observedAt: number): void {
    this.#verdicts.set(model, { status, observedAt });
  }

  latest(model: string): EntitlementStatus | null {
    return this.#verdicts.get(model)?.status ?? null;
  }
}

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

export type RoutingTaskInput = Omit<TaskPackage, "model"> & { readonly model?: RawTaskModelSelection };

export interface TaskModelRouter {
  route(task: RoutingTaskInput): Promise<TaskPackage>;
  confirmRouting(routedTask: TaskPackage): void;
  /**
   * ADR-066: exact check of an already persisted selection against the live
   * catalog. It never re-routes or rewrites the Task: a selection the catalog
   * no longer offers fails with `provider_config_invalid` instead of being
   * swapped for another provider, model or plan.
   */
  validatePersisted(task: TaskPackage): Promise<void>;
}

interface RoutingCacheEntry {
  readonly identity: string;
  readonly resolved: ZCodeModelSelection;
}

function normalizedRawRequestIdentity(raw: RawTaskModelSelection): string {
  return JSON.stringify([raw.provider_id ?? null, raw.model_id, raw.reasoning_level ?? null]);
}

export function createTaskModelRouter(options: TaskModelRouterOptions): TaskModelRouter {
  const cacheLimit = options.cacheLimit ?? 500;
  const accepted = new Map<string, RoutingCacheEntry>();
  const pending = new WeakMap<TaskPackage, RoutingCacheEntry>();

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

    const catalog = await options.catalog(task.worktree_path ?? task.workspace);
    const routed = routeTaskModel(raw, options.settings(), catalog);
    const entry: RoutingCacheEntry = { identity, resolved: routed.resolved! };
    const routedTask: TaskPackage = { ...task, model: routed.resolved! };
    if (!accepted.has(task.task_id)) pending.set(routedTask, entry);
    return routedTask;
  };

  const validatePersisted = async (task: TaskPackage): Promise<void> => {
    const selection = task.model;
    if (!selection) return;
    const providerId = selection.provider_id.trim();
    const modelId = selection.model_id.trim();
    const label = `${providerId}/${modelId}`;
    let catalog: DynamicModelRoutingCatalog;
    try {
      catalog = await options.catalog(task.worktree_path ?? task.workspace,
        providerId === START_PLAN_PROVIDER_ID ? "start_plan" : "current");
    } catch (error) {
      throw new BridgeError("provider_config_invalid",
        `the live ZCode AppServer model catalog could not be read to validate ${label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error });
    }
    // Same namespace rule as the Adapter: a bare provider id may be advertised as `account:<id>`.
    const entry = findCatalogEntry(catalog, providerId, modelId)
      ?? (!providerId.startsWith("account:") && !providerId.startsWith("builtin:")
        ? findCatalogEntry(catalog, `account:${providerId}`, modelId)
        : undefined);
    if (!entry) {
      const reason = providerId === START_PLAN_PROVIDER_ID ? catalog.startPlanUnavailableReason : null;
      throw new BridgeError("provider_config_invalid",
        `the live ZCode AppServer model catalog no longer contains ${label}; the Task keeps its persisted model, so correct the runtime catalog before continuing${reason ? `: ${reason}` : ""}`);
    }
    const level = selection.reasoning_level?.trim();
    if (level && !entry.reasoningLevels.includes(level)) {
      throw new BridgeError("provider_config_invalid",
        `reasoning level ${level} is not available for ${entry.providerId}/${entry.modelId} in the live ZCode AppServer model catalog`);
    }
  };

  return {
    route,
    validatePersisted,
    confirmRouting(routedTask: TaskPackage): void {
      const entry = pending.get(routedTask);
      if (!entry) return;
      pending.delete(routedTask);
      if (accepted.has(routedTask.task_id)) return;
      accepted.set(routedTask.task_id, entry);
      if (accepted.size > cacheLimit) {
        const oldest = accepted.keys().next().value;
        if (oldest !== undefined) accepted.delete(oldest);
      }
    },
  };
}

export function routeTaskModel(
  raw: RawTaskModelSelection,
  settings: RoutingSettings,
  catalog: DynamicModelRoutingCatalog,
): ModelRoutingDecision {
  const requestedReasoning = raw.reasoning_level?.trim();
  const withReasoning = (entry: DynamicModelRoutingEntry): ZCodeModelSelection => ({
    provider_id: entry.providerId,
    model_id: entry.modelId,
    ...reasoningFor(entry, requestedReasoning),
  });

  if (raw.provider_id === START_PLAN_PROVIDER_ID) {
    const entry = findStartPlanEntry(catalog, raw.model_id);
    if (!entry) throw startPlanNotAvailable(raw, catalog);
    return { mode: "explicit-start-plan", requested: raw, resolved: withReasoning(entry) };
  }
  if (raw.provider_id) {
    const entry = catalog.entries.find((candidate) =>
      candidate.providerId === raw.provider_id && candidate.modelId === raw.model_id);
    if (!entry) throw modelNotAvailable(raw);
    return { mode: "explicit-provider", requested: raw, resolved: withReasoning(entry) };
  }

  if (stripStartPlanAlias(raw.model_id)) {
    const entry = findStartPlanEntry(catalog, raw.model_id);
    if (!entry) throw startPlanNotAvailable(raw, catalog);
    return { mode: "explicit-start-plan", requested: raw, resolved: withReasoning(entry) };
  }

  const startMatches = catalog.entries.filter((entry) =>
    entry.providerId === START_PLAN_PROVIDER_ID && sameModelFamily(entry.modelId, raw.model_id));
  const codingMatches = catalog.entries.filter((entry) =>
    isOfficialCodingPlanProvider(entry.providerId) && entry.modelId === raw.model_id);
  if (!startMatches.length && !codingMatches.length) throw modelNotAvailable(raw);
  if ((settings.preferStartPlan || !codingMatches.length) && startMatches.length) {
    return { mode: "auto-start-plan", requested: raw, resolved: withReasoning(startMatches[0]!) };
  }
  return { mode: "prefer-off-coding-plan", requested: raw, resolved: withReasoning(codingMatches[0]!) };
}

function findStartPlanEntry(catalog: DynamicModelRoutingCatalog, requestedModelId: string): DynamicModelRoutingEntry | null {
  return catalog.entries.find((entry) =>
    entry.providerId === START_PLAN_PROVIDER_ID && sameModelFamily(entry.modelId, requestedModelId)) ?? null;
}

function findCatalogEntry(
  catalog: DynamicModelRoutingCatalog,
  providerId: string,
  modelId: string,
): DynamicModelRoutingEntry | undefined {
  return catalog.entries.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
}

function sameModelFamily(catalogModelId: string, requestedModelId: string): boolean {
  if (catalogModelId === requestedModelId) return true;
  const catalogBase = stripStartPlanAlias(catalogModelId);
  const requestedBase = stripStartPlanAlias(requestedModelId);
  return (catalogBase ?? catalogModelId) === (requestedBase ?? requestedModelId);
}

function reasoningFor(entry: DynamicModelRoutingEntry, requestedLevel: string | undefined): { reasoning_level?: string } {
  if (!requestedLevel) {
    return entry.reasoningDefaultLevel ? { reasoning_level: entry.reasoningDefaultLevel } : {};
  }
  if (!entry.reasoningLevels.includes(requestedLevel)) {
    throw new BridgeError("provider_config_invalid", `reasoning level ${requestedLevel} is not available for ${entry.providerId}/${entry.modelId}`);
  }
  return { reasoning_level: requestedLevel };
}

function modelNotAvailable(raw: RawTaskModelSelection): BridgeError {
  return new BridgeError(
    "provider_config_invalid",
    `the live ZCode AppServer model catalog does not contain ${raw.provider_id ? `${raw.provider_id}/` : ""}${raw.model_id}`,
  );
}

function startPlanNotAvailable(raw: RawTaskModelSelection, catalog: DynamicModelRoutingCatalog): BridgeError {
  const reason = catalog.startPlanUnavailableReason;
  return new BridgeError(
    "provider_config_invalid",
    `the live Start Plan model catalog does not contain ${raw.model_id}${reason ? `: ${reason}` : ""}`,
  );
}
