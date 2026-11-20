import {
  accountProviderSelectionCapability,
} from "../runtime/account-provider.js";
import { BridgeError } from "../runtime/errors.js";
import type {
  OfficialAppServerRuntimeDescriptor,
  OfficialProviderRuntimeCapability,
} from "../runtime/official-app-server-runtime.js";
import {
  ZCodeAppServerAdapter,
  type ZCodeAppServerAdapterOptions,
} from "./zcode-app-server-adapter.js";
import {
  createInstalledOfficialHostSessionFactory,
  officialProviderCapabilityFailure,
  type OfficialHostPackagedAssets,
  type OfficialHostModuleSource,
} from "./official-host-adapter.js";

export type { OfficialInstalledRuntimeResolver } from "./official-host-adapter.js";
import type { OfficialInstalledRuntimeResolver } from "./official-host-adapter.js";
export { officialProviderCapabilityFailure } from "./official-host-adapter.js";

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
  /** Worker-shaped URL used to resolve the shipped Host module. */
  readonly workerModuleUrl?: string | URL;
  /** Test-only seam replacing the packaged ProcessManager/auth module assets. */
  readonly testOnlyOfficialHostPackagedAssets?: OfficialHostPackagedAssets;
}

/**
 * Production adapter for the installed Official ZCode AppServer. The exact
 * Provider ID only selects an authentication/entitlement gate; every Provider
 * shares the same Official Host process manager, protocol adapter, and cleanup
 * ownership.
 */
export class OfficialAppServerWorkerAdapter extends ZCodeAppServerAdapter {
  constructor(options: OfficialAppServerWorkerAdapterOptions = {}) {
    const providerCapability = options.providerCapability ?? "installed_runtime";
    let verifiedDescriptor: OfficialAppServerRuntimeDescriptor | undefined;
    const sessionFactory = createInstalledOfficialHostSessionFactory({
      officialRuntimeResolver: options.officialRuntimeResolver,
      env: options.childEnvBase,
      homeDir: options.homeDir,
      host: options.host,
      providerCapability,
      testOnlyOfficialHostModule: options.testOnlyOfficialHostModule,
      workerModuleUrl: options.workerModuleUrl,
      testOnlyOfficialHostPackagedAssets: options.testOnlyOfficialHostPackagedAssets,
      onVerified: (descriptor) => {
        verifiedDescriptor = descriptor;
        options.onEvent?.({
          type: descriptor.status === "OFFICIAL_RUNTIME_EXPERIMENTAL"
            ? "official_runtime_experimental"
            : "official_runtime_verified",
          summary: descriptor.status === "OFFICIAL_RUNTIME_EXPERIMENTAL"
            ? "Using explicitly authorized experimental installed ZCode AppServer"
            : "Using verified installed ZCode AppServer",
          details: {
            status: descriptor.status,
            installation_safety: descriptor.installation_safety,
            installation_fingerprint: descriptor.installation_fingerprint,
            experimental_authorization_state: descriptor.experimental_authorization?.state ?? null,
            experimental_authorization_scopes: descriptor.experimental_authorization?.scopes ?? [],
            discount_capability: descriptor.discount_capability,
            start_plan_static_compatibility: descriptor.start_plan_static_compatibility,
            provider_capability: providerCapability,
            desktop_version: descriptor.desktop_version,
            bundle_sha256: descriptor.bundle_sha256,
            runtime_host_sha256: descriptor.runtime_host_sha256,
            node_version: descriptor.node_version,
            install_source: descriptor.install_source,
          },
        });
      },
      onUnverified: (descriptor, reason) => {
        options.onEvent?.({
          type: "official_runtime_unverified",
          summary: reason,
          details: {
            status: descriptor.status,
            installation_safety: descriptor.installation_safety,
            installation_fingerprint: descriptor.installation_fingerprint,
            experimental_authorization_state: descriptor.experimental_authorization?.state ?? null,
            experimental_authorization_scopes: descriptor.experimental_authorization?.scopes ?? [],
            discount_capability: descriptor.discount_capability,
            start_plan_static_compatibility: descriptor.start_plan_static_compatibility,
            provider_capability: providerCapability,
            reason,
          },
        });
      },
    });

    super({
      ...options,
      resolver: sessionFactory.resolver,
      providerRetryLimit: 0,
      externalHostClientFactory: (context) => sessionFactory.createClient(context),
      verifySelectedProviderCapability: async (selection, config, signal) => {
        signal.throwIfAborted();
        const resolved = accountProviderSelectionCapability(
          selection.providerId,
          selection.modelId,
          config,
        );
        const descriptor = verifiedDescriptor;
        if (!descriptor) {
          throw new BridgeError(
            "provider_config_invalid",
            "The Official AppServer runtime identity was not verified before provider capability validation.",
          );
        }
        const failure = resolved.failure
          ?? officialProviderCapabilityFailure(descriptor, resolved.capability);
        if (!failure) return;
        try {
          options.onEvent?.({
            type: "official_runtime_unverified",
            summary: failure,
            details: {
              status: descriptor.status,
              discount_capability: descriptor.discount_capability,
              start_plan_static_compatibility: descriptor.start_plan_static_compatibility,
              provider_capability: resolved.capability,
              selected_provider_id: selection.providerId,
              selected_model_id: selection.modelId,
              reason: failure,
            },
          });
        } catch {
          // Observation cannot alter the fail-closed decision.
        }
        throw new BridgeError("provider_config_invalid", failure);
      },
    });
  }
}
