import type { ZCodeRuntimeConfig } from "../interfaces.js";
import {
  loadOfficialHostProviderRuntimeAuthFactory,
  type OfficialHostRuntimeAuthService,
  type OfficialHostRuntimeAuthServiceFactory,
} from "../adapters/official-host-adapter.js";
import { accountProviderRuleFacts, zcodeDataBaseDir } from "./account-provider.js";

type JsonRecord = Record<string, unknown>;

export interface OfficialProviderRuntimeAuthOptions {
  readonly config: ZCodeRuntimeConfig;
  /** Worker-shaped URL for the shipped Official Host module. */
  readonly workerModuleUrl?: string | URL;
  /**
   * Optional task-scoped selection guard. The model catalog leaves this unset
   * because it has no turn model; the Worker uses it to bind auth to the
   * resolved TaskPackage model.
   */
  readonly isSelected?: (providerId: string, modelId: string) => boolean;
  /** Test-only seam; production loads the packaged Official Host factory. */
  readonly testOnlyFactoryLoader?: (
    workerModuleUrl?: string | URL,
  ) => Promise<OfficialHostRuntimeAuthServiceFactory>;
}

/**
 * Resolves account-provider runtime headers through the official OAuth
 * service. It intentionally supports only the individual Coding Plan: Start
 * Plan authentication is owned by the private credential broker.
 */
export function createOfficialProviderRuntimeAuthResolver(
  options: OfficialProviderRuntimeAuthOptions,
): (request: Record<string, unknown>, signal: AbortSignal) => Promise<JsonRecord> {
  let factoryPromise: Promise<OfficialHostRuntimeAuthServiceFactory> | undefined;
  const services = new Map<string, Promise<OfficialHostRuntimeAuthService>>();
  const unavailable = (): JsonRecord => ({
    headersApplied: false,
    errorMessage: "Provider runtime authorization is unavailable.",
  });

  return async (request, signal) => {
    if (signal.aborted) return unavailable();
    const providerId = typeof request.providerId === "string" ? request.providerId : "";
    const modelSelection = asRecord(request.modelSelection);
    const modelId = typeof modelSelection.modelId === "string" ? modelSelection.modelId : "";
    if (
      !providerId
      || !modelId
      || (typeof modelSelection.providerId === "string" && modelSelection.providerId !== providerId)
      || (options.isSelected && !options.isSelected(providerId, modelId))
    ) {
      return unavailable();
    }

    const facts = accountProviderRuleFacts(providerId, options.config);
    const access = asRecord(request.accountAccess);
    if (
      !facts?.accountType
      || facts.planKind !== "individual-coding-plan"
      || access.type !== "zhipu-account"
      || access.accountType !== facts.accountType
      || access.mode !== facts.planKind
      || access.entitled !== true
    ) {
      return unavailable();
    }

    const dataBaseDir = zcodeDataBaseDir(options.config.providerPersonalConfigFile);
    if (!dataBaseDir) return unavailable();
    const cacheKey = `${dataBaseDir}\0${providerId}`;
    let service = services.get(cacheKey);
    if (!service) {
      factoryPromise ??= (options.testOnlyFactoryLoader
        ?? loadOfficialHostProviderRuntimeAuthFactory)(options.workerModuleUrl);
      service = factoryPromise.then((factory) =>
        factory({
          dataBaseDir,
          resolveCurrentAccountAccess: async (currentAccess) => {
            if (
              currentAccess.type !== "zhipu-account"
              || currentAccess.accountType !== facts.accountType
              || currentAccess.mode !== facts.planKind
              || currentAccess.entitled !== true
            ) {
              return null;
            }
            return {
              type: "zhipu-account",
              family: facts.accountType,
              planKind: "individual-coding-plan",
            };
          },
        }),
      );
      services.set(cacheKey, service);
    }
    return (await service).resolveProviderRuntimeRequest(request, { signal });
  };
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}
