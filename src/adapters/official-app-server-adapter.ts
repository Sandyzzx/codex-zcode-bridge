import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeResolver, ZCodeRuntimeConfig } from "../interfaces.js";
import {
  OfficialAppServerRuntimeResolver,
  type OfficialAppServerRuntimeDescriptor,
  type OfficialProviderRuntimeCapability,
} from "../runtime/official-app-server-runtime.js";
import { BridgeError } from "../runtime/errors.js";
import {
  ZCodeAppServerAdapter,
  type ExternalHostClientFactory,
  type ZCodeAppServerAdapterOptions,
} from "./zcode-app-server-adapter.js";
import {
  createOfficialHostClientFactory,
  verifyOfficialHostAssets,
  type OfficialHostAssets,
  type OfficialHostModule,
  type OfficialHostModuleSource,
} from "./official-host-adapter.js";

export interface OfficialInstalledRuntimeResolver extends RuntimeResolver {
  inspect(): Promise<OfficialAppServerRuntimeDescriptor>;
}

export interface OfficialAppServerWorkerAdapterOptions extends ZCodeAppServerAdapterOptions {
  readonly officialRuntimeResolver?: OfficialInstalledRuntimeResolver;
  /**
   * The provider-specific capability that must be verified before this
   * installed runtime may create a model session. Runtime identity alone is
   * not a Coding Plan or Start Plan compatibility verdict.
   */
  readonly providerCapability?: OfficialProviderRuntimeCapability;
  /** Test-only seam. Production always resolves from the installed Desktop. */
  readonly testOnlyOfficialHostModule?: OfficialHostModuleSource;
  /** Test-only seam relative to a Worker-shaped module URL. */
  readonly testOnlyWorkerModuleUrl?: string | URL;
  /** Test-only seam replacing the packaged ProcessManager/auth module assets. */
  readonly testOnlyOfficialHostAssets?: OfficialHostAssets;
}

/**
 * Production BigModel Coding Plan/Start Plan adapter. It keeps the official
 * Host process manager, protocol adapter, provider-specific auth service, and
 * cleanup ownership, while making the installed Desktop AppServer the only
 * verified model-execution runtime.
 */
export class OfficialAppServerWorkerAdapter extends ZCodeAppServerAdapter {
  constructor(options: OfficialAppServerWorkerAdapterOptions = {}) {
    const providerCapability = options.providerCapability ?? "coding_plan_discount";
    const runtimeResolver = options.officialRuntimeResolver
      ?? new OfficialAppServerRuntimeResolver({
        env: options.childEnvBase,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(options.host ? { host: options.host } : {}),
      });
    const packagedAssets = options.testOnlyOfficialHostAssets
      ? Promise.resolve(options.testOnlyOfficialHostAssets)
      : verifyOfficialHostAssets(options.testOnlyWorkerModuleUrl);
    const moduleSource: OfficialHostModuleSource = options.testOnlyOfficialHostModule
      ?? (async () => loadOfficialHostModule((await packagedAssets).hostModulePath));
    let resolved: Promise<{ readonly descriptor: OfficialAppServerRuntimeDescriptor; readonly assets: OfficialHostAssets }>
      | undefined;
    const assets = (): Promise<{ readonly descriptor: OfficialAppServerRuntimeDescriptor; readonly assets: OfficialHostAssets }> => {
      resolved ??= Promise.all([runtimeResolver.inspect(), packagedAssets]).then(([descriptor, packaged]) => {
        const capabilityFailure = officialProviderCapabilityFailure(descriptor, providerCapability);
        const missingRuntimeAsset = !descriptor.bundle_path
          || !descriptor.builtin_provider_config_path
          || !descriptor.runtime_host_path;
        if (capabilityFailure || missingRuntimeAsset) {
          const failure = capabilityFailure
            ?? `OFFICIAL_RUNTIME_UNVERIFIED: installed runtime descriptor is missing required assets`;
          try {
            options.onEvent?.({
              type: "official_runtime_unverified",
              summary: failure,
              details: {
                status: descriptor.status,
                discount_capability: descriptor.discount_capability,
                start_plan_static_compatibility: descriptor.start_plan_static_compatibility,
                provider_capability: providerCapability,
                reason: failure,
              },
            });
          } catch {
            // Observation cannot change the fail-closed decision.
          }
          throw new BridgeError("provider_config_invalid", failure);
        }
        return {
          descriptor,
          assets: {
            root: descriptor.install_dir!,
            hostModulePath: packaged.hostModulePath,
            appServerEntryPath: descriptor.bundle_path,
            builtinProviderConfigPath: descriptor.builtin_provider_config_path,
            runtimeHostPath: descriptor.runtime_host_path,
            manifestDigest: descriptor.bundle_sha256!,
          },
        };
      });
      return resolved;
    };

    const factory = createOfficialHostClientFactory({
      assets: async () => (await assets()).assets,
      moduleSource,
    });
    const externalHostClientFactory: ExternalHostClientFactory = async (context) => {
      const runtime = await assets();
      const client = await factory(context);
      try {
        options.onEvent?.({
          type: "official_runtime_verified",
          summary: "Using verified installed ZCode AppServer",
          details: {
            status: runtime.descriptor.status,
            discount_capability: runtime.descriptor.discount_capability,
            start_plan_static_compatibility: runtime.descriptor.start_plan_static_compatibility,
            provider_capability: providerCapability,
            desktop_version: runtime.descriptor.desktop_version,
            bundle_sha256: runtime.descriptor.bundle_sha256,
            runtime_host_sha256: runtime.descriptor.runtime_host_sha256,
            node_version: runtime.descriptor.node_version,
            install_source: runtime.descriptor.install_source,
          },
        });
      } catch {
        // Observation cannot change the selected runtime or task outcome.
      }
      return client;
    };

    super({
      ...options,
      resolver: runtimeResolver,
      providerRetryLimit: 0,
      externalHostClientFactory,
    });
  }
}

export function officialProviderCapabilityFailure(
  descriptor: OfficialAppServerRuntimeDescriptor,
  capability: OfficialProviderRuntimeCapability,
): string | null {
  if (descriptor.status !== "OFFICIAL_RUNTIME_VERIFIED") {
    return `OFFICIAL_RUNTIME_UNVERIFIED: ${descriptor.reason ?? "installed Official AppServer is unavailable"}`;
  }
  if (capability === "coding_plan_discount") {
    return descriptor.discount_capability === "OFFICIAL_DISCOUNT_VERIFIED"
      ? null
      : `OFFICIAL_RUNTIME_UNVERIFIED: ${descriptor.reason ?? "installed runtime has no verified Coding Plan discount capability"}; ` +
        "OFFICIAL_DISCOUNT_NOT_VERIFIED";
  }
  return descriptor.start_plan_static_compatibility === "OFFLINE_COMPATIBLE"
    ? null
    : `STARTPLAN_RUNTIME_INCOMPATIBLE: ${descriptor.reason ?? "installed runtime is not offline-compatible with Start Plan"}; ` +
      `START_PLAN_COMPATIBILITY_${descriptor.start_plan_static_compatibility ?? "UNVERIFIED"}`;
}

async function loadOfficialHostModule(modulePath: string): Promise<OfficialHostModule> {
  const value = await import(pathToFileURL(path.resolve(modulePath)).href) as Partial<OfficialHostModule>;
  if (!value || typeof value.ZCodeAgentProcessManager !== "function"
    || typeof value.ZCodeProtocolClient !== "function") {
    throw new BridgeError(
      "provider_config_invalid",
      "The Official Host module is missing required exports.",
    );
  }
  return value as OfficialHostModule;
}
