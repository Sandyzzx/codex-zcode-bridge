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

interface AccountProviderPayload {
  revision: string;
  basedOnZCodeBuiltinRevision: string;
  providers: Record<string, { builtinModelIds?: string[]; access: { type: string; entitled: boolean } }>;
  states: Record<string, { availability: "available" | "unavailable"; entitled: boolean; current: boolean }>;
}

interface AccountProviderSourceEntry {
  readonly providerId: string;
  readonly legacyId: string;
  readonly planKind: AccountPlanKind | null;
  readonly accessType: string;
  readonly builtinModelIds: readonly string[];
  readonly entitled: boolean;
  readonly availability: "available" | "unavailable";
  readonly current: boolean;
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
  readonly providerId: "account:bigmodel-start-plan";
  readonly modelId: string;
}

/** Build the account entitlement snapshot expected by hosted ZCode app-server. */
export function buildAccountProviderPayload(
  config: ZCodeRuntimeConfig,
  verifiedSelection?: VerifiedAccountProviderSelection,
  homeDir?: string,
): AccountProviderPayload | null {
  const source = readAccountProviderSource(config, verifiedSelection, homeDir);
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
      current: entry.current,
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
  if (!providerId?.startsWith("account:")) return null;
  const table = readJson(config.providerBuiltinConfigFile);
  const rule = readProviderRules(table).find((candidate) =>
    isRecord(candidate) && candidate.providerId === providerId,
  ) as ProviderRule | undefined;
  return normalizePlanKind(rule?.config?.access?.mode);
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
  const connectionSelections = asRecord(settings?.providerFamilyConnectionSelections);

  const entries = providerRules.map((rule): AccountProviderSourceEntry => {
    const providerId = rule.providerId!;
    const legacyId = configProviderId(providerId, rule);
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
    const entitled = normalizePlanKind(rule.config?.access?.mode) === "start-plan"
      ? selectedEntitled
      : cacheStatus === "available" || (legacyConfig.enabled === true && apiKey.length > 0);
    return {
      providerId,
      legacyId,
      planKind: normalizePlanKind(rule.config?.access?.mode),
      accessType: rule.config?.access?.type ?? "zhipu-account",
      builtinModelIds: [...(rule.config?.builtinModelIds ?? [])].sort(),
      entitled,
      availability: entitled ? "available" : "unavailable",
      current: isCurrentProvider(rule, legacyId, selectedKeys, connectionSelections),
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
  connectionSelections: JsonRecord,
): boolean {
  const access = rule.config?.access;
  if (!access?.accountType) return false;
  const selected = selectedKeys[access.accountType];
  if (typeof selected === "string") {
    return selected === legacyId || selected.endsWith(`:${legacyId}`);
  }
  const connection = asRecord(connectionSelections[access.accountType]);
  return typeof connection.kind === "string" && connection.kind === access.mode;
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
