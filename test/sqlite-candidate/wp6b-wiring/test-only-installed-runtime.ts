import path from "node:path";
import type { ZCodeRuntimeConfig } from "../../../src/interfaces.js";
import type { OfficialInstalledRuntimeResolver } from "../../../src/adapters/official-app-server-adapter.js";
import type { OfficialHostAssets } from "../../../src/adapters/official-host-adapter.js";
import type { OfficialAppServerRuntimeDescriptor } from "../../../src/runtime/official-app-server-runtime.js";
import { NodeRuntimeResolver } from "../../../src/runtime/resolver.js";

interface TestOnlyInstalledRuntime {
  readonly resolver: OfficialInstalledRuntimeResolver;
  readonly assets: OfficialHostAssets;
}

/**
 * The loopback Worker exercises production routing and lifecycle code while
 * substituting only the installed-runtime identity and official Host process
 * manager. No real Desktop files or account state are consulted.
 */
export function createTestOnlyInstalledRuntime(options: {
  readonly codingPlanDiscountVerified?: boolean;
} = {}): TestOnlyInstalledRuntime {
  const appServerEntryPath = process.env["ZCODE_BRIDGE_ZCODE_CJS"]?.trim();
  const builtinProviderConfigPath = process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (!appServerEntryPath || !builtinProviderConfigPath) {
    throw new Error("test-only installed runtime requires the fake AppServer environment");
  }
  const installRoot = path.dirname(path.dirname(path.dirname(appServerEntryPath)));
  const runtimeHostPath = path.join(
    installRoot,
    "resources",
    "tools",
    "runtime-host",
    "zcode-runtime-host.exe",
  );
  const base = new NodeRuntimeResolver({ env: process.env });
  let cached: Promise<ZCodeRuntimeConfig> | undefined;
  const resolve = (): Promise<ZCodeRuntimeConfig> => {
    cached ??= base.resolve();
    return cached;
  };
  const resolver: OfficialInstalledRuntimeResolver = {
    resolve,
    inspect: async (): Promise<OfficialAppServerRuntimeDescriptor> => {
      const config = await resolve();
      return {
        status: "OFFICIAL_RUNTIME_VERIFIED",
        discount_capability: options.codingPlanDiscountVerified === false
          ? "OFFICIAL_DISCOUNT_NOT_VERIFIED"
          : "OFFICIAL_DISCOUNT_VERIFIED",
        start_plan_static_compatibility: "OFFLINE_COMPATIBLE",
        reason: null,
        install_dir: installRoot,
        install_source: "test_only_loopback",
        desktop_version: "3.18.2.10443",
        bundle_path: config.zcodeEntrypoint,
        bundle_bytes: 1,
        bundle_sha256: "a".repeat(64),
        builtin_provider_config_path: config.providerBuiltinConfigFile,
        builtin_provider_config_bytes: 1,
        builtin_provider_config_sha256: "b".repeat(64),
        runtime_host_path: runtimeHostPath,
        runtime_host_bytes: 1,
        runtime_host_sha256: "c".repeat(64),
        node_executable: config.nodeExecutable,
        node_version: process.versions.node,
        node_compatible: true,
        manifest: null,
      };
    },
  };
  return {
    resolver,
    assets: {
      root: installRoot,
      hostModulePath: path.join(installRoot, "official-host-runtime.mjs"),
      appServerEntryPath,
      builtinProviderConfigPath,
      runtimeHostPath,
      manifestDigest: "d".repeat(64),
    },
  };
}
