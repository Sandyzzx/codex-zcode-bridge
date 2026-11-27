import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createMinimalOsEnv } from "./child-env.js";
import { buildZCodeAppServerLaunch } from "./desktop-host-launch.js";
import { buildAccountProviderPayload, zcodeDataBaseDir } from "./account-provider.js";
import { BridgeError } from "./errors.js";
import { forwardOfficialEndpointEnv } from "./official-builtin-registry.js";
import { startPlanAliasCatalogEntries, type RoutingCatalogPlan } from "./model-routing.js";
import { loadPersistedRuntimeEnvironment } from "./resolver.js";
import { ZCODE_SESSION_MODES, type ZCodeSessionMode } from "./session-preferences.js";
import type { ZCodeRuntimeConfig } from "../interfaces.js";
import { createPlatformProbe, verifyProcessTreeClaimantsClean } from "../adapters/process-spawn.js";
import {
  createInstalledOfficialHostSessionFactory,
  type ExternalHostClientFactoryContext,
  type ExternalHostClientHandle,
  type OfficialHostSessionFactory,
} from "../adapters/official-host-adapter.js";
import {
  createOfficialProviderRuntimeAuthResolver,
} from "./official-provider-runtime-auth.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "./host-profile.js";
import { withProcessLock } from "../store/process-lock.js";
import { atomicRename } from "../store/atomic-rename.js";

type JsonRecord = Record<string, unknown>;

export interface ZCodeModelCatalogEntry {
  provider_id: string;
  model_id: string;
  label: string;
  provider_label?: string;
  context_window?: number;
  max_output_tokens?: number;
  reasoning_levels?: Array<{ value: string; label: string }>;
  reasoning_default_level?: string;
  disabled_reason?: string;
}

export interface ZCodeModelCatalog {
  workspace: string;
  current_model: { provider_id: string; model_id: string } | null;
  models: ZCodeModelCatalogEntry[];
  account_provider_sync: "not_needed" | "applied" | "failed";
  cache_status?: "fresh" | "refreshed";
  cached_at?: string;
  warning?: string;
}

export interface DefaultModelSelection {
  provider_id: string;
  model_id: string;
  reasoning_level?: string;
}

interface CatalogSource {
  config: ZCodeRuntimeConfig;
  runtimeEnv: NodeJS.ProcessEnv;
  cachePath: string;
  fingerprint: string;
}

const RPC_TIMEOUT_MS = 30_000;

export interface ZCodeModelSettingsOptions {
  readonly homeDir?: string;
  readonly host?: BridgeHostProfile;
  /** Worker-shaped URL for the shipped Official Host assets. */
  readonly workerModuleUrl?: string | URL;
  /** Test-only shared factory seam; production uses the installed Official Host. */
  readonly testOnlyOfficialHostSessionFactory?: OfficialHostSessionFactory;
  /** Test-only official Provider Runtime Auth factory seam. */
  readonly testOnlyOfficialProviderRuntimeAuthFactoryLoader?: Parameters<
    typeof createOfficialProviderRuntimeAuthResolver
  >[0]["testOnlyFactoryLoader"];
}

/** Read the live app-server catalog and manage Bridge's persistent model default. */
export class ZCodeModelSettings {
  readonly #sourceEnv: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #host: BridgeHostProfile;
  readonly #workerModuleUrl: string | URL | undefined;
  readonly #sessionFactory: OfficialHostSessionFactory;
  readonly #providerRuntimeAuthFactoryLoader:
    Parameters<typeof createOfficialProviderRuntimeAuthResolver>[0]["testOnlyFactoryLoader"];
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(sourceEnv: NodeJS.ProcessEnv = process.env, options: ZCodeModelSettingsOptions = {}) {
    this.#sourceEnv = sourceEnv;
    this.#homeDir = options.homeDir ?? homedir();
    this.#host = validateHostProfile(options.host ?? codexHostProfile(this.#homeDir));
    this.#workerModuleUrl = options.workerModuleUrl;
    this.#sessionFactory = options.testOnlyOfficialHostSessionFactory
      ?? createInstalledOfficialHostSessionFactory({
        env: sourceEnv,
        homeDir: this.#homeDir,
        host: this.#host,
        workerModuleUrl: options.workerModuleUrl,
      });
    this.#providerRuntimeAuthFactoryLoader = options.testOnlyOfficialProviderRuntimeAuthFactoryLoader;
  }

  async listModels(workspace: string): Promise<ZCodeModelCatalog> {
    const requestedWorkspace = workspace.trim();
    if (!path.isAbsolute(requestedWorkspace)) {
      throw new BridgeError("provider_config_invalid", "workspace must be an absolute existing directory");
    }
    let workspacePath: string;
    try {
      workspacePath = await realpath(requestedWorkspace);
      if (!(await stat(workspacePath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new BridgeError("provider_config_invalid", `workspace is not an accessible directory: ${requestedWorkspace}`);
    }

    let source: CatalogSource;
    try {
      source = await this.#resolveCatalogSource(workspacePath);
    } catch {
      // Provider files can be replaced while we read them. Resolve once more
      // before asking the caller to repair a persistent configuration error.
      try {
        source = await this.#resolveCatalogSource(workspacePath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const code = error instanceof BridgeError ? error.code : "provider_config_invalid";
        throw new BridgeError(code, `Could not load the ZCode runtime/provider configuration after retrying: ${reason}. Run zcode_doctor for the failing path, correct it, then call zcode_model_catalog again.`, { cause: error });
      }
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Re-read the persisted settings and provider files after a failed
        // attempt, so a concurrent Desktop/config update can recover here.
        const currentSource = attempt === 0 ? source : await this.#resolveCatalogSource(workspacePath);
        return await this.#readLiveCatalog(workspacePath, currentSource);
      } catch (error) {
        lastError = error;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    const code = lastError instanceof BridgeError ? lastError.code : "zcode_nonzero_exit";
    throw new BridgeError(code, `Model catalog refresh failed after re-reading provider config and retrying: ${reason}. Run zcode_doctor to identify a missing or invalid runtime/provider file; after correcting it, call zcode_model_catalog again.`, { cause: lastError });
  }

  async #resolveCatalogSource(workspacePath: string): Promise<CatalogSource> {
    const runtimeEnv = loadPersistedRuntimeEnvironment(this.#sourceEnv, this.#homeDir, this.#host);
    const config = await this.#sessionFactory.resolver.resolve();
    const cachePath = modelCatalogCachePath(workspacePath, config, runtimeEnv, this.#host.settingsDirectory);
    const fingerprint = await modelCatalogSourceFingerprint(config, runtimeEnv, this.#homeDir);
    return { config, runtimeEnv, cachePath, fingerprint };
  }

  /** Live catalog for plan routing. The default snapshot exposes the account
   * selected by ZCode; a second zero-model read exposes the Start Plan catalog
   * when that Provider is configured. No model or Billing request is sent.
   * A Start read failure is preserved for explicit Start selections and does
   * not erase Coding models. */
  async listRoutingCatalog(workspace: string, options: { readonly plan?: RoutingCatalogPlan } = {}): Promise<{
    models: ZCodeModelCatalogEntry[];
    startPlanUnavailableReason: string | null;
  }> {
    const plan = options.plan ?? "all";
    if (plan === "start_plan") {
      // ADR-066: a Start Plan selection is validated against its own catalog,
      // so a failed read is reported instead of degraded to Coding models.
      return { models: (await this.#readStartPlanCatalog(workspace)).models, startPlanUnavailableReason: null };
    }
    const currentCatalog = await this.listModels(workspace);
    if (plan === "current") return { models: currentCatalog.models, startPlanUnavailableReason: null };
    let startModels: ZCodeModelCatalogEntry[] = [];
    let startPlanUnavailableReason: string | null = null;
    try {
      const startCatalog = await this.#readStartPlanCatalog(workspace);
      startModels = startCatalog.models;
    } catch (error) {
      startPlanUnavailableReason = error instanceof Error ? error.message : String(error);
    }
    const seen = new Set(currentCatalog.models.map((model) => `${model.provider_id}\n${model.model_id}`));
    const additions = startModels.filter((model) => !seen.has(`${model.provider_id}\n${model.model_id}`));
    return {
      models: [...currentCatalog.models, ...additions],
      startPlanUnavailableReason,
    };
  }

  /** One zero-model live read of the Start Plan catalog. */
  async #readStartPlanCatalog(workspace: string): Promise<ZCodeModelCatalog> {
    const workspacePath = await realpath(workspace.trim());
    const source = await this.#resolveCatalogSource(workspacePath);
    return this.#readLiveCatalog(workspacePath, source, "start_plan");
  }

  async #readLiveCatalog(workspacePath: string, source: CatalogSource, catalogPlan: "current" | "start_plan" = "current"): Promise<ZCodeModelCatalog> {
    const { config, runtimeEnv, cachePath, fingerprint } = source;
    const childEnv = buildRuntimeChildEnv(config, runtimeEnv);
    const launch = buildZCodeAppServerLaunch(config.zcodeEntrypoint, childEnv);
    const controller = new AbortController();
    const providerRuntimeAuth = createOfficialProviderRuntimeAuthResolver({
      config,
      workerModuleUrl: this.#workerModuleUrl,
      ...(this.#providerRuntimeAuthFactoryLoader
        ? { testOnlyFactoryLoader: this.#providerRuntimeAuthFactoryLoader } : {}),
    });
    let client: ExternalHostClientHandle;
    try {
      client = await this.#sessionFactory.createClient({
        config,
        workspace: {
          requestedPath: workspacePath,
          canonicalPath: workspacePath,
          mode: "direct",
        },
        cwd: workspacePath,
        env: childEnv,
        launch,
        requestTimeoutMs: RPC_TIMEOUT_MS,
        probe: createPlatformProbe(),
        verifyTreeClean: verifyProcessTreeClaimantsClean,
      } satisfies ExternalHostClientFactoryContext);
    } catch (error) {
      throw error instanceof BridgeError
        ? error
        : new BridgeError("zcode_nonzero_exit", error instanceof Error ? error.message : String(error), { cause: error });
    }
    const requestDisposable = client.onRequest?.((message: unknown) => {
      void handleRuntimeRequest(client, message, providerRuntimeAuth, controller.signal);
    });
    let sessionId: string | null = null;
    let accountSync: ZCodeModelCatalog["account_provider_sync"] = "not_needed";
    let warning: string | undefined;
    let primaryError: unknown;
    try {
      const accountPayload = prepareCatalogAccountPayload(
        buildAccountProviderPayload(config, undefined, this.#homeDir),
        catalogPlan,
      );
      if (accountPayload) {
        try {
          await client.request("provider/updateAccountConfig", accountPayload as unknown as JsonRecord);
          accountSync = "applied";
        } catch (error) {
          throw new BridgeError("zcode_nonzero_exit", `Account provider synchronization failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }

      const configuredMode = runtimeEnv["ZCODE_BRIDGE_MODE"]?.trim() ?? "build";
      const mode: ZCodeSessionMode = (ZCODE_SESSION_MODES as readonly string[]).includes(configuredMode)
        ? configuredMode as ZCodeSessionMode
        : "build";
      const snapshot = asRecord(await client.request("session/create", {
        workspace: { workspacePath, workspaceKey: workspacePath },
        mode,
        persistence: "deferred",
      }));
      sessionId = nestedString(snapshot, ["session", "sessionId"]);
      if (!sessionId) throw new BridgeError("zcode_nonzero_exit", "ZCode app-server did not return a session ID");

      const settings = asRecord(snapshot.settings);
      const modelSettings = asRecord(settings.model);
      const rawAvailable = Array.isArray(modelSettings.available) ? modelSettings.available : [];
      // ADR-031: expose the Start Plan aliases next to the runtime catalog so
      // Masters can select `<ModelId>-StartPlan` without knowing provider ids.
      const models = withStartPlanAliasEntries(rawAvailable.map(toCatalogEntry).filter((entry): entry is ZCodeModelCatalogEntry => entry !== null));
      const current = toModelRef(modelSettings.current);
      if (models.length === 0) throw new BridgeError("zcode_nonzero_exit", "ZCode app-server returned an empty model catalog for this workspace");
      const cachedAt = Date.now();
      await writeModelCatalogCache(cachePath, models).catch(() => undefined);
      warning = startPlanCatalogWarning(accountPayload, models);
      return {
        workspace: workspacePath,
        current_model: current,
        models,
        account_provider_sync: accountSync,
        cache_status: "refreshed",
        cached_at: new Date(cachedAt).toISOString(),
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      primaryError = error;
      if (error instanceof BridgeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new BridgeError(
        "zcode_nonzero_exit",
        message,
        { cause: error },
      );
    } finally {
      controller.abort();
      if (sessionId) await client.request("session/close", { sessionId }).catch(() => undefined);
      if (typeof requestDisposable === "function") requestDisposable();
      else requestDisposable?.dispose();
      const closed = await client.close();
      if (!primaryError && (closed.error || closed.close.status !== "resolved")) {
        throw new BridgeError(
          "cleanup_failed",
          closed.close.errorMessage
            ?? (closed.error instanceof Error ? closed.error.message : "Official Host model catalog cleanup failed."),
        );
      }
    }
  }

  async getDefaultModel(): Promise<{ configured: boolean; model: DefaultModelSelection | null }> {
    const env = loadPersistedRuntimeEnvironment(this.#sourceEnv, this.#homeDir, this.#host);
    const providerId = env["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() ?? "";
    const modelId = env["ZCODE_BRIDGE_DEFAULT_MODEL_ID"]?.trim() ?? "";
    const reasoningLevel = env["ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL"]?.trim() ?? "";
    if (Boolean(providerId) !== Boolean(modelId)) {
      throw new BridgeError("provider_config_invalid", "Stored default model is incomplete; provider_id and model_id must be set together");
    }
    if (!providerId) return { configured: false, model: null };
    return {
      configured: true,
      model: { provider_id: providerId, model_id: modelId, ...(reasoningLevel ? { reasoning_level: reasoningLevel } : {}) },
    };
  }

  async setDefaultModel(selection: DefaultModelSelection): Promise<{ configured: true; model: DefaultModelSelection }> {
    const providerId = selection.provider_id.trim();
    const modelId = selection.model_id.trim();
    const reasoningLevel = selection.reasoning_level?.trim();
    if (!providerId || !modelId || (selection.reasoning_level !== undefined && !reasoningLevel)) {
      throw new BridgeError("provider_config_invalid", "provider_id, model_id, and any supplied reasoning_level must be non-empty");
    }
    await this.#updateConfig((config) => {
      config.ZCODE_BRIDGE_DEFAULT_PROVIDER_ID = providerId;
      config.ZCODE_BRIDGE_DEFAULT_MODEL_ID = modelId;
      if (reasoningLevel) config.ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL = reasoningLevel;
      else config.ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL = null;
    });
    return { configured: true, model: { provider_id: providerId, model_id: modelId, ...(reasoningLevel ? { reasoning_level: reasoningLevel } : {}) } };
  }

  async clearDefaultModel(): Promise<{ configured: false; model: null }> {
    await this.#updateConfig((config) => {
      // Explicit nulls override inherited environment values in
      // loadPersistedRuntimeEnvironment and make clear durable.
      config.ZCODE_BRIDGE_DEFAULT_PROVIDER_ID = null;
      config.ZCODE_BRIDGE_DEFAULT_MODEL_ID = null;
      config.ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL = null;
    });
    return { configured: false, model: null };
  }

  #updateConfig(update: (config: JsonRecord) => void): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      await mkdir(this.#host.settingsDirectory, { recursive: true });
      return withProcessLock(path.join(this.#host.settingsDirectory, ".settings.lock"), async () => {
        const configPath = path.join(this.#host.settingsDirectory, "runtime-config.json");
        let config: JsonRecord = {};
        try {
          const info = await stat(configPath);
          if (!info.isFile() || info.size > 64 * 1024) {
            throw new BridgeError("provider_config_invalid", "Bridge runtime config is not a small regular JSON file");
          }
          const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
          if (!isRecord(parsed)) throw new BridgeError("provider_config_invalid", "Bridge runtime config must contain a JSON object");
          config = parsed;
        } catch (error) {
          if (isMissingFile(error)) {
            config = {};
            for (const directory of this.#host.legacySettingsDirectories ?? []) {
              const legacyPath = path.join(directory, "runtime-config.json");
              try {
                if ((await stat(legacyPath)).size > 64 * 1024) throw new Error("legacy settings exceed size limit");
                const legacy: unknown = JSON.parse(await readFile(legacyPath, "utf8"));
                if (!isRecord(legacy)) throw new Error("invalid legacy settings");
                loadPersistedRuntimeEnvironment(this.#sourceEnv, this.#homeDir, this.#host);
                config = legacy;
                break;
              } catch (legacyError) {
                if (!isMissingFile(legacyError)) throw new BridgeError("provider_config_invalid", "Could not migrate host runtime settings", { cause: legacyError });
              }
            }
          }
          else if (error instanceof BridgeError) throw error;
          else throw new BridgeError("provider_config_invalid", "Could not read Bridge runtime config", { cause: error });
        }
        update(config);
        const serialized = `${JSON.stringify(config, null, 2)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
          throw new BridgeError("provider_config_invalid", "Updated Bridge runtime config would exceed 64 KiB");
        }
        const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
          await atomicRename(tempPath, configPath);
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          throw new BridgeError("provider_config_invalid", `Could not save Bridge runtime config: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

async function handleRuntimeRequest(
  client: ExternalHostClientHandle,
  message: unknown,
  resolveProviderRuntimeAuth: (
    request: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const request = asRecord(message);
  const id = request.id;
  if (typeof id !== "string" && typeof id !== "number") return;
  let reply: Record<string, unknown>;
  if (request.method === "session/requestRuntimePreferences") {
    reply = {
      id,
      result: {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      },
    };
  } else if (request.method === "interaction/requestProviderRuntimeHeaders") {
    reply = {
      id,
      result: await resolveProviderRuntimeAuth(asRecord(request.params), signal).catch(() => ({
        headersApplied: false,
        errorMessage: "Provider runtime authorization is unavailable.",
      })),
    };
  } else {
    reply = {
      id,
      error: {
        code: -32601,
        message: "Unsupported ZCode app-server request during model catalog read",
      },
    };
  }
  if (!signal.aborted) await client.respond(reply).catch(() => undefined);
}

function buildRuntimeChildEnv(config: ZCodeRuntimeConfig, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = createMinimalOsEnv(source);
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
  if (source.ZCODE_HOME) env.ZCODE_HOME = source.ZCODE_HOME;
  const dataBaseDir = zcodeDataBaseDir(config.providerPersonalConfigFile);
  if (dataBaseDir) env.ZCODE_DATA_BASE_DIR = dataBaseDir;
  // ADR-066: the catalog AppServer must load the Endpoint's registry the
  // resolver selected.
  forwardOfficialEndpointEnv(env, source);
  return env;
}

function prepareCatalogAccountPayload(
  payload: ReturnType<typeof buildAccountProviderPayload> | null,
  catalogPlan: "current" | "start_plan",
): ReturnType<typeof buildAccountProviderPayload> | null {
  if (!payload || catalogPlan !== "start_plan") return payload;
  const startProviderId = "account:bigmodel-start-plan";
  const codingProviderId = "account:bigmodel-individual-coding-plan";
  if (!payload.providers[startProviderId] || !payload.states[startProviderId]
      || !payload.states[codingProviderId]) return payload;
  const result = {
    ...payload,
    providers: {
      ...payload.providers,
      [startProviderId]: {
        ...payload.providers[startProviderId]!,
        access: {
          ...payload.providers[startProviderId]!.access,
          entitled: true,
        },
      },
    },
    states: {
      ...payload.states,
      [startProviderId]: {
        ...payload.states[startProviderId]!,
        entitled: true,
        current: true,
      },
      [codingProviderId]: {
        ...payload.states[codingProviderId]!,
        current: false,
      },
    },
  };
  return result;
}

function toCatalogEntry(value: unknown): ZCodeModelCatalogEntry | null {
  const entry = asRecord(value);
  const ref = toModelRef(entry.ref);
  if (!ref) return null;
  const reasoning = asRecord(entry.reasoning);
  const rawLevels = Array.isArray(reasoning.levels) ? reasoning.levels : [];
  const reasoningLevels = rawLevels.flatMap((raw) => {
    const level = asRecord(raw);
    if (typeof level.value !== "string" || !level.value.trim()) return [];
    return [{ value: level.value, label: typeof level.label === "string" && level.label.trim() ? level.label : level.value }];
  });
  const defaultLevel = typeof reasoning.defaultLevel === "string" && reasoningLevels.some((level) => level.value === reasoning.defaultLevel)
    ? reasoning.defaultLevel
    : undefined;
  return {
    ...ref,
    label: typeof entry.label === "string" ? entry.label : ref.model_id,
    ...(typeof entry.providerLabel === "string" ? { provider_label: entry.providerLabel } : {}),
    ...(typeof entry.contextWindow === "number" ? { context_window: entry.contextWindow } : {}),
    ...(typeof entry.maxOutputTokens === "number" ? { max_output_tokens: entry.maxOutputTokens } : {}),
    ...(reasoningLevels.length ? { reasoning_levels: reasoningLevels } : {}),
    ...(defaultLevel ? { reasoning_default_level: defaultLevel } : {}),
    ...(typeof entry.disabledReason === "string" ? { disabled_reason: entry.disabledReason } : {}),
  };
}

function toModelRef(value: unknown): { provider_id: string; model_id: string } | null {
  const ref = asRecord(value);
  return typeof ref.providerId === "string" && typeof ref.modelId === "string"
    ? { provider_id: ref.providerId, model_id: ref.modelId }
    : null;
}

function nestedString(record: JsonRecord, keys: string[]): string | null {
  let value: unknown = record;
  for (const key of keys) value = asRecord(value)[key];
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function modelCatalogCachePath(workspace: string, config: ZCodeRuntimeConfig, env: NodeJS.ProcessEnv, settingsDirectory: string): string {
  const identity = JSON.stringify({
    workspace,
    node: config.nodeExecutable,
    entrypoint: config.zcodeEntrypoint,
    builtin: config.providerBuiltinConfigFile,
    personal: config.providerPersonalConfigFile,
    zcodeHome: env.ZCODE_HOME ?? "",
  });
  const key = createHash("sha256").update(identity).digest("hex");
  return path.join(settingsDirectory, "model-catalog", `${key}.json`);
}

async function modelCatalogSourceFingerprint(
  config: ZCodeRuntimeConfig,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<string> {
  const digest = createHash("sha256");
  digest.update("start-plan-task-scoped-live-billing-v1");
  // Hash only: provider contents and credentials are never written to cache.
  for (const file of [config.providerBuiltinConfigFile, config.providerPersonalConfigFile]) {
    digest.update(file);
    digest.update(await readFile(file));
  }
  const entry = await stat(config.zcodeEntrypoint);
  digest.update(JSON.stringify({ entrypoint: config.zcodeEntrypoint, size: entry.size, mtimeMs: entry.mtimeMs, mode: env.ZCODE_BRIDGE_MODE ?? "build" }));
  const account = buildAccountProviderPayload(config, undefined, homeDir);
  if (account) digest.update(JSON.stringify({ providers: account.providers, states: account.states, builtinRevision: account.basedOnZCodeBuiltinRevision }));
  return digest.digest("hex");
}

function startPlanCatalogWarning(
  account: ReturnType<typeof buildAccountProviderPayload>,
  models: readonly ZCodeModelCatalogEntry[],
): string | undefined {
  const providerId = "account:bigmodel-start-plan";
  if (!account?.providers[providerId] || account.states[providerId]?.entitled === true
    || models.some((model) => model.provider_id === providerId)) return undefined;
  return "Start Plan models are checked for a selected task; this catalog read does not send Billing requests.";
}

/** Appends `<ModelId>-StartPlan` catalog entries derived from the official
 * provider registry. Presentation only: alias entries carry no entitlement
 * claim and never replace a runtime-advertised entry. */
function withStartPlanAliasEntries(models: ZCodeModelCatalogEntry[]): ZCodeModelCatalogEntry[] {
  const aliases = startPlanAliasCatalogEntries(models);
  if (!aliases.length) return models;
  const seen = new Set(models.map((model) => `${model.provider_id}\n${model.model_id}`));
  const additions = aliases
    .filter((alias) => !seen.has(`${alias.provider_id}\n${alias.model_id}`))
    .map((alias) => ({ ...alias }));
  return [...models, ...additions];
}

async function writeModelCatalogCache(cachePath: string, models: ZCodeModelCatalogEntry[]): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify({
      cached_at_ms: Date.now(),
      source: "live_app_server_snapshot",
      models,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await atomicRename(tempPath, cachePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
