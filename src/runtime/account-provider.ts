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

interface AccountProviderPayload {
  revision: string;
  basedOnZCodeBuiltinRevision: string;
  providers: Record<string, { builtinModelIds?: string[]; access: { type: string; entitled: boolean } }>;
  states: Record<string, { availability: "available" | "unavailable"; entitled: boolean; current: boolean }>;
}

/** Build the account entitlement snapshot expected by hosted ZCode app-server. */
export function buildAccountProviderPayload(config: ZCodeRuntimeConfig): AccountProviderPayload | null {
  const table = readJson(config.providerBuiltinConfigFile);
  const providerRules = readProviderRules(table)
    .filter(isRecord)
    .map((rule) => rule as ProviderRule)
    .filter((rule) => rule.config?.access?.type === "zhipu-account" && typeof rule.providerId === "string");
  if (!providerRules.length) return null;

  const dataDir = zcodeV2DataDir(config.providerPersonalConfigFile);
  if (!dataDir) return null;
  const credentials = readJson(path.join(dataDir, "config.json"));
  const credentialProviders = asRecord(credentials?.provider);
  const cache = readJson(path.join(dataDir, "coding-plan-cache.json"));
  const cacheItems = asRecord(asRecord(cache?.entryStatus).items);
  const providers: AccountProviderPayload["providers"] = {};
  const states: AccountProviderPayload["states"] = {};

  for (const rule of providerRules) {
    const providerId = rule.providerId!;
    const legacyId = configProviderId(providerId, rule);
    const cacheStatus = asRecord(cacheItems[legacyId]).status;
    const legacyConfig = asRecord(credentialProviders[legacyId]);
    const options = asRecord(legacyConfig.options);
    const entitled = cacheStatus === "available" ||
      (legacyConfig.enabled === true && typeof options.apiKey === "string" && options.apiKey.trim().length > 0);
    providers[providerId] = {
      ...(Array.isArray(rule.config?.builtinModelIds) ? { builtinModelIds: rule.config.builtinModelIds } : {}),
      access: { type: "zhipu-account", entitled },
    };
    states[providerId] = {
      availability: entitled ? "available" : "unavailable",
      entitled,
      current: entitled,
    };
  }

  const revision = typeof table?.revision === "number" ? table.revision : 0;
  const resolvedBuiltinPath = path.resolve(config.providerBuiltinConfigFile);
  return {
    revision: `account:codex-zcode-bridge:${Date.now()}`,
    basedOnZCodeBuiltinRevision: `zcode-builtin:${revision}:${createHash("sha256").update(resolvedBuiltinPath).digest("hex")}`,
    providers,
    states,
  };
}

/** Resolve a legacy config provider id to the provider id used in app-server. */
export function accountProviderId(providerId: string, config: ZCodeRuntimeConfig): string {
  // The runtime model catalog already uses this namespace for account-backed
  // providers. Keep it idempotent when callers supply the exact catalog ID.
  if (providerId.startsWith("account:")) return providerId;
  const table = readJson(config.providerBuiltinConfigFile);
  for (const rawRule of readProviderRules(table)) {
    if (!isRecord(rawRule)) continue;
    const rule = rawRule as ProviderRule;
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

/** Supply coding-plan credentials in memory; Start Plan requires a desktop captcha host. */
export function runtimeAuthReply(
  providerId: string | undefined,
  config: ZCodeRuntimeConfig,
): JsonRecord {
  const unavailable = {
    headersApplied: false,
    errorMessage: "Start Plan requires a ZCode desktop captcha session; this headless app-server bridge cannot provide it.",
  };
  if (!providerId?.startsWith("account:")) return unavailable;
  const table = readJson(config.providerBuiltinConfigFile);
  const rule = readProviderRules(table).find((candidate) =>
    isRecord(candidate) && candidate.providerId === providerId,
  ) as ProviderRule | undefined;
  if (rule?.config?.access?.mode !== "individual-coding-plan") return unavailable;

  const legacyId = configProviderId(providerId, rule);
  const dataDir = zcodeV2DataDir(config.providerPersonalConfigFile);
  if (!dataDir) return unavailable;
  const credentials = readJson(path.join(dataDir, "config.json"));
  const cache = readJson(path.join(dataDir, "coding-plan-cache.json"));
  const status = asRecord(asRecord(asRecord(cache?.entryStatus).items)[legacyId]).status;
  const provider = asRecord(asRecord(credentials?.provider)[legacyId]);
  const options = asRecord(provider.options);
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  if (!apiKey || (status !== "available" && provider.enabled !== true)) return unavailable;
  return { headersApplied: true, requestAuth: { apiKey } };
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
