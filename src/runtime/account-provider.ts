import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ZCodeRuntimeConfig } from "../interfaces.js";

type JsonRecord = Record<string, unknown>;

interface ProviderRule {
  providerId?: string;
  config?: {
    builtinModelIds?: string[];
    access?: { type?: string; mode?: string; accountType?: string };
  };
}

type AccountPlanKind =
  | "start-plan"
  | "individual-coding-plan"
  | "team-coding-plan"
  | "off-peak"
  | "highspeed";

export const BIGMODEL_START_PLAN_PROVIDER_ID = "account:bigmodel-start-plan" as const;

interface AccountProviderPayload {
  revision: string;
  basedOnZCodeBuiltinRevision: string;
  providers: Record<string, { builtinModelIds?: string[]; access: { type: string; entitled: boolean } }>;
  states: Record<string, { availability: "available" | "unavailable"; entitled: boolean; current?: boolean }>;
}

interface AccountProviderSourceEntry {
  readonly providerId: string;
  readonly legacyId: string;
  readonly planKind: AccountPlanKind | null;
  readonly accessType: string;
  readonly builtinModelIds: readonly string[];
  readonly entitled: boolean;
  readonly availability: "available" | "unavailable";
  readonly current?: boolean;
  readonly apiKey: string;
}

interface AccountProviderSource {
  readonly officialDataRoot: string;
  readonly officialV2Dir: string;
  readonly settingFile: string;
  readonly builtinRevision: string;
  readonly entries: readonly AccountProviderSourceEntry[];
}

export interface VerifiedAccountProviderSelection {
  readonly providerId: typeof BIGMODEL_START_PLAN_PROVIDER_ID;
  readonly modelId: string;
}

export interface AccountProviderRuleFacts {
  readonly planKind: AccountPlanKind | null;
  readonly accountType: string | null;
}

/** Build the account entitlement snapshot expected by hosted ZCode app-server. */
export function buildAccountProviderPayload(
  config: ZCodeRuntimeConfig,
  verifiedSelection?: VerifiedAccountProviderSelection,
  homeDir?: string,
  taskProviderId?: string,
): AccountProviderPayload | null {
  const source = readAccountProviderSource(config, verifiedSelection, homeDir, taskProviderId);
  if (!source) return null;
  const providers: AccountProviderPayload["providers"] = {};
  const states: AccountProviderPayload["states"] = {};

  for (const entry of source.entries) {
    providers[entry.providerId] = {
      ...(entry.builtinModelIds.length ? { builtinModelIds: [...entry.builtinModelIds] } : {}),
      access: { type: entry.accessType, entitled: entry.entitled },
    };
    states[entry.providerId] = {
      availability: entry.availability,
      entitled: entry.entitled,
      ...(entry.current === undefined ? {} : { current: entry.current }),
    };
  }

  return {
    revision: accountProviderRevision(source.builtinRevision, providers, states),
    basedOnZCodeBuiltinRevision: source.builtinRevision,
    providers,
    states,
  };
}

/** Official account settings live under the user's original .zcode directory. */
export function accountSettingFile(homeDir: string): string {
  return path.join(homeDir, ".zcode", "v2", "setting.json");
}

/** Resolve the plan kind from the same Built-in Provider registry used by snapshots. */
export function accountProviderPlanKind(
  providerId: string | undefined,
  config: ZCodeRuntimeConfig,
): AccountPlanKind | null {
  return accountProviderRuleFacts(providerId, config)?.planKind ?? null;
}

/** Resolve the provider's official access classification without inferring it
 * from its ID. A missing or malformed registry entry is not Start Plan. */
export function accountProviderRuleFacts(
  providerId: string | undefined,
  config: ZCodeRuntimeConfig,
): AccountProviderRuleFacts | null {
  if (!providerId?.startsWith("account:")) return null;
  const table = readJson(config.providerBuiltinConfigFile);
  const rule = readProviderRules(table).find((candidate) =>
    isRecord(candidate) && candidate.providerId === providerId,
  ) as ProviderRule | undefined;
  if (!rule) return null;
  const access = rule.config?.access;
  if (access?.type !== "zhipu-account") {
    return { planKind: null, accountType: null };
  }
  return {
    planKind: normalizePlanKind(access.mode),
    accountType: typeof access.accountType === "string" ? access.accountType : null,
  };
}

/** Resolve a legacy config provider id to the provider id used in app-server. */
export function accountProviderId(providerId: string, config: ZCodeRuntimeConfig): string {
  // The runtime model catalog already uses this namespace for account-backed
  // providers. Keep it idempotent when callers supply the exact catalog ID.
  if (providerId.startsWith("account:")) return providerId;
  const rules = [config.providerBuiltinConfigFile, config.providerPersonalConfigFile]
    .flatMap((file) => readProviderRules(readJson(file)));
  for (const rawRule of rules) {
    if (!isRecord(rawRule)) continue;
    const rule = rawRule as ProviderRule;
    if (!providerId.startsWith("builtin:") && rule.providerId === `account:${providerId}`) return rule.providerId;
    if (
      !providerId.startsWith("builtin:") &&
      rule.providerId === providerId &&
      rule.config?.access?.type === "zhipu-account"
    ) {
      return `account:${providerId}`;
    }
    if (typeof rule.providerId === "string" && configProviderId(rule.providerId, rule) === providerId) {
      return rule.providerId;
    }
  }
  return providerId;
}

/** Prefer an exact catalog entry; namespace aliases require runtime evidence
 * for the same model. Never substitute a different provider by model name. */
export function catalogProviderId(
  providerId: string,
  modelId: string,
  catalog: readonly { providerId: string; modelId: string }[],
  config: ZCodeRuntimeConfig,
): string {
  const advertised = (candidate: string): boolean => catalog.some((model) => model.providerId === candidate && model.modelId === modelId);
  if (advertised(providerId)) return providerId;
  const configured = accountProviderId(providerId, config);
  if (advertised(configured)) return configured;
  if (!providerId.startsWith("account:") && !providerId.startsWith("builtin:") && advertised(`account:${providerId}`)) {
    return `account:${providerId}`;
  }
  return configured;
}

/** Supply coding-plan credentials in memory; Start Plan requires a desktop captcha host. */
export function runtimeAuthReply(
  providerId: string | undefined,
  config: ZCodeRuntimeConfig,
): JsonRecord {
  const unavailable = {
    headersApplied: false,
    errorMessage: "Start Plan requires a ZCode desktop captcha session; this headless app-server bridge cannot provide it.",
  };
  const source = readAccountProviderSource(config, undefined, undefined);
  const entry = source?.entries.find((candidate) => candidate.providerId === providerId);
  if (entry?.planKind !== "individual-coding-plan" || !entry.entitled || !entry.apiKey) return unavailable;
  return { headersApplied: true, requestAuth: { apiKey: entry.apiKey } };
}

/** ZCode reads its data root from the parent of `.zcode`; the resolver already selected this exact tree. */
export function zcodeDataBaseDir(personalProviderConfigFile: string): string | null {
  const dataDir = zcodeV2DataDir(personalProviderConfigFile);
  return dataDir ? path.dirname(path.dirname(dataDir)) : null;
}

/** Desktop task index lives alongside provider_config.json in the active v2 data root. */
export function zcodeTasksIndexPath(personalProviderConfigFile: string): string | null {
  const dataDir = zcodeV2DataDir(personalProviderConfigFile);
  return dataDir ? path.join(dataDir, "tasks-index.sqlite") : null;
}

function zcodeV2DataDir(personalProviderConfigFile: string): string | null {
  const absolute = path.resolve(personalProviderConfigFile);
  if (path.basename(absolute).toLowerCase() !== "provider_config.json") return null;
  const v2Dir = path.dirname(absolute);
  if (path.basename(v2Dir).toLowerCase() !== "v2") return null;
  const zcodeDir = path.dirname(v2Dir);
  if (path.basename(zcodeDir).toLowerCase() !== ".zcode") return null;
  return v2Dir;
}

function readAccountProviderSource(
  config: ZCodeRuntimeConfig,
  verifiedSelection?: VerifiedAccountProviderSelection,
  homeDir?: string,
  taskProviderId?: string,
): AccountProviderSource | null {
  const table = readJson(config.providerBuiltinConfigFile);
  const providerRules = readProviderRules(table)
    .filter(isRecord)
    .map((rule) => rule as ProviderRule)
    .filter((rule) => rule.config?.access?.type === "zhipu-account" && typeof rule.providerId === "string")
    .sort((left, right) => left.providerId!.localeCompare(right.providerId!));
  if (!providerRules.length) return null;

  const officialDataRoot = path.resolve(config.zcodeDataRoot);
  const officialV2Dir = zcodeV2Dir(officialDataRoot);
  if (!officialV2Dir) return null;
  const credentials = readJson(path.join(officialV2Dir, "config.json"));
  const credentialProviders = asRecord(credentials?.provider);
  const cache = readJson(path.join(officialV2Dir, "coding-plan-cache.json"));
  const cacheItems = asRecord(asRecord(cache?.entryStatus).items);
  const settingFile = homeDir ? accountSettingFile(homeDir) : path.join(officialV2Dir, "setting.json");
  const settings = readJson(settingFile);
  const selectedKeys = asRecord(settings?.modelProviderFamilySelectedKeys);
  const rawConnectionSelections = settings?.providerFamilyConnectionSelections;
  const connectionSelectionsPresent = settings !== null
    && Object.prototype.hasOwnProperty.call(settings, "providerFamilyConnectionSelections");
  const connectionSelections = asRecord(rawConnectionSelections);
  const connectionSelectionsInvalid = connectionSelectionsPresent && !isRecord(rawConnectionSelections);
  const taskAccountProviderId = taskProviderId && providerRules.some((rule) => rule.providerId === taskProviderId)
    ? taskProviderId
    : null;

  const entries = providerRules.map((rule): AccountProviderSourceEntry => {
    const providerId = rule.providerId!;
    const legacyId = configProviderId(providerId, rule);
    const planKind = normalizePlanKind(rule.config?.access?.mode);
    const cacheStatus = asRecord(cacheItems[legacyId]).status;
    const legacyConfig = asRecord(credentialProviders[legacyId]);
    const options = asRecord(legacyConfig.options);
    const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    const selectedEntitled = verifiedSelection?.providerId === providerId
      && Array.isArray(rule.config?.builtinModelIds)
      && rule.config.builtinModelIds.includes(verifiedSelection.modelId);
    if (verifiedSelection?.providerId === providerId && !selectedEntitled) {
      throw new Error("start_plan_model_not_registered");
    }
    // Start Plan's live Billing verdict is task/model scoped. A legacy cache
    // entry or old apiKey must never make this provider executable or visible
    // as entitled; only the exact verified selection can do so.
    const entitled = planKind === "start-plan"
      ? selectedEntitled
      : cacheStatus === "available" || (legacyConfig.enabled === true && apiKey.length > 0);
    const desktopCurrent = isCurrentProvider(
      rule,
      legacyId,
      selectedKeys,
      connectionSelectionsInvalid,
      connectionSelections,
    );
    const current = taskAccountProviderId
      ? (planKind === "off-peak" || planKind === "highspeed"
          ? undefined
          : providerId === taskAccountProviderId
            ? true
            : desktopCurrent === true ? undefined : desktopCurrent)
      : desktopCurrent;
    return {
      providerId,
      legacyId,
      planKind,
      accessType: rule.config?.access?.type ?? "zhipu-account",
      builtinModelIds: [...(rule.config?.builtinModelIds ?? [])],
      entitled,
      availability: entitled ? "available" : "unavailable",
      current,
      apiKey,
    };
  });

  const builtinRevision = zcodeBuiltinRevision(table, config.providerBuiltinConfigFile);
  return { officialDataRoot, officialV2Dir, settingFile, builtinRevision, entries };
}

function zcodeV2Dir(zcodeDataRoot: string): string | null {
  if (path.basename(zcodeDataRoot).toLowerCase() !== ".zcode") return null;
  return path.join(zcodeDataRoot, "v2");
}

function zcodeBuiltinRevision(table: JsonRecord | null, sourceFile: string): string {
  const revision = typeof table?.revision === "number" ? table.revision : 0;
  const sourceDigest = createHash("sha256").update(path.resolve(sourceFile)).digest("hex");
  return `zcode-builtin:${revision}:${sourceDigest}`;
}

function accountProviderRevision(
  builtinRevision: string,
  providers: AccountProviderPayload["providers"],
  states: AccountProviderPayload["states"],
): string {
  return `account:${JSON.stringify([builtinRevision, providers, states])}`;
}

function isCurrentProvider(
  rule: ProviderRule,
  legacyId: string,
  selectedKeys: JsonRecord,
  connectionSelectionsInvalid: boolean,
  connectionSelections: JsonRecord,
): boolean | undefined {
  const access = rule.config?.access;
  if (!access?.accountType) return false;
  // The modern connection selection union does not define these transient
  // card/off-peak modes. Omitting current keeps the resolver's
  // `current !== false` contract without inventing a paid connection.
  if (access.mode === "off-peak" || access.mode === "highspeed") return undefined;

  if (connectionSelectionsInvalid) return false;
  if (Object.prototype.hasOwnProperty.call(connectionSelections, access.accountType)) {
    const connection = asRecord(connectionSelections[access.accountType]);
    if (!isConnectionSelectionKind(connection.kind)) return false;
    if (
      connection.kind === "team-coding-plan"
      && (!isNonEmptyString(connection.productId)
        || !isNonEmptyString(connection.organizationId)
        || !isNonEmptyString(connection.projectId))
    ) {
      return false;
    }
    return connection.kind === access.mode;
  }

  // Legacy keys are migration compatibility only. Consult them after the
  // modern family selection is absent; a malformed modern value fails closed.
  const selected = selectedKeys[access.accountType];
  return typeof selected === "string"
    && (selected === legacyId || selected.endsWith(`:${legacyId}`));
}

function isConnectionSelectionKind(value: unknown): value is Exclude<AccountPlanKind, "off-peak" | "highspeed"> {
  return value === "start-plan"
    || value === "individual-coding-plan"
    || value === "team-coding-plan";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePlanKind(value: unknown): AccountPlanKind | null {
  return value === "start-plan"
    || value === "individual-coding-plan"
    || value === "team-coding-plan"
    || value === "off-peak"
    || value === "highspeed"
    ? value
    : null;
}

function configProviderId(providerId: string, rule: ProviderRule): string {
  const access = rule.config?.access;
  if (!providerId.startsWith("account:") || !access?.accountType || !access.mode) return providerId;
  const plan = access.mode === "individual-coding-plan" ? "coding-plan" : access.mode;
  return `builtin:${access.accountType}-${plan}`;
}

function readProviderRules(table: JsonRecord | null): unknown[] {
  const providerConfigRules = asRecord(asRecord(table?.config).providerConfigRules);
  return Array.isArray(providerConfigRules.providerRules) ? providerConfigRules.providerRules : [];
}

function readJson(filePath: string): JsonRecord | null {
  try {
    if (!existsSync(filePath)) return null;
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
