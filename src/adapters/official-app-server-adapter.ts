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
  officialProviderCapabilityWarning,
  type OfficialHostPackagedAssets,
  type OfficialHostModuleSource,
} from "./official-host-adapter.js";

export type { OfficialInstalledRuntimeResolver } from "./official-host-adapter.js";
import type { OfficialInstalledRuntimeResolver } from "./official-host-adapter.js";
export { officialProviderCapabilityWarning } from "./official-host-adapter.js";

export interface OfficialAppServerWorkerAdapterOptions extends ZCodeAppServerAdapterOptions {
  readonly officialRuntimeResolver?: OfficialInstalledRuntimeResolver;
  /**
   * Selects the Provider-specific diagnostic scope. Static compatibility
   * observations never become an execution gate; live account capability is
   * validated independently by the selected Provider.
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
            : descriptor.status === "OFFICIAL_RUNTIME_VERIFIED"
              ? "official_runtime_verified"
              : "official_runtime_manifest_unverified",
          summary: descriptor.status === "OFFICIAL_RUNTIME_EXPERIMENTAL"
            ? "Using explicitly authorized experimental installed ZCode AppServer"
            : descriptor.status === "OFFICIAL_RUNTIME_VERIFIED"
              ? "Using verified installed ZCode AppServer"
              : "Using a safe installed ZCode AppServer whose manifest compatibility is unverified",
          details: {
            status: descriptor.status,
            installation_safety: descriptor.installation_safety,
            installation_fingerprint: descriptor.installation_fingerprint,
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
            discount_capability: descriptor.discount_capability,
            start_plan_static_compatibility: descriptor.start_plan_static_compatibility,
            provider_capability: providerCapability,
            reason,
          },
        });
      },
      onDiagnostic: (descriptor, reason) => {
        options.onEvent?.({
          type: "official_runtime_capability_diagnostic",
          summary: reason,
          details: {
            status: descriptor.status,
            installation_safety: descriptor.installation_safety,
            installation_fingerprint: descriptor.installation_fingerprint,
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
        if (!resolved.failure) {
          const warning = officialProviderCapabilityWarning(descriptor, resolved.capability);
          if (warning) {
            try {
              options.onEvent?.({
                type: "official_runtime_capability_diagnostic",
                summary: warning,
                details: {
                  status: descriptor.status,
                  discount_capability: descriptor.discount_capability,
                  start_plan_static_compatibility: descriptor.start_plan_static_compatibility,
                  provider_capability: resolved.capability,
                  selected_provider_id: selection.providerId,
                  selected_model_id: selection.modelId,
                  reason: warning,
                },
              });
            } catch {
              // Diagnostics cannot change execution.
            }
          }
          return;
        }
        const failure = resolved.failure;
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
