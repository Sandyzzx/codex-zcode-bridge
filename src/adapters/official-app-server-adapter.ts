import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeResolver, ZCodeRuntimeConfig } from "../interfaces.js";
import {
  OfficialAppServerRuntimeResolver,
  type OfficialAppServerRuntimeDescriptor,
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
  /** Test-only seam. Production always resolves from the installed Desktop. */
  readonly testOnlyOfficialHostModule?: OfficialHostModuleSource;
  /** Test-only seam relative to a Worker-shaped module URL. */
  readonly testOnlyWorkerModuleUrl?: string | URL;
  /** Test-only seam replacing the packaged ProcessManager/auth module assets. */
  readonly testOnlyOfficialHostAssets?: OfficialHostAssets;
}

/**
 * Production Coding Plan adapter. It keeps the existing official Host process
 * manager, protocol adapter, auth service, and cleanup ownership, while making
 * the installed Desktop AppServer the only verified model-execution runtime.
 */
export class OfficialAppServerWorkerAdapter extends ZCodeAppServerAdapter {
  constructor(options: OfficialAppServerWorkerAdapterOptions = {}) {
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
        if (descriptor.status !== "OFFICIAL_RUNTIME_VERIFIED"
          || !descriptor.bundle_path
          || !descriptor.builtin_provider_config_path
          || !descriptor.runtime_host_path) {
          try {
            options.onEvent?.({
              type: "official_runtime_unverified",
              summary: "Installed ZCode AppServer is not verified for the Coding Plan discount",
              details: {
                status: descriptor.status,
                discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
                reason: descriptor.reason,
              },
            });
          } catch {
            // Observation cannot change the fail-closed decision.
          }
          throw new BridgeError(
            "provider_config_invalid",
            `OFFICIAL_RUNTIME_UNVERIFIED: ${descriptor.reason ?? "installed Official AppServer is unavailable"}; ` +
              "OFFICIAL_DISCOUNT_NOT_VERIFIED",
          );
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
      try {
        options.onEvent?.({
          type: "official_runtime_verified",
          summary: "Using verified installed ZCode AppServer",
          details: {
            status: runtime.descriptor.status,
            discount_capability: runtime.descriptor.discount_capability,
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
      return factory(context);
    };

    super({
      ...options,
      resolver: runtimeResolver,
      providerRetryLimit: 0,
      externalHostClientFactory,
    });
  }
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
