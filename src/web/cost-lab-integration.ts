import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOfficialHostProductVersion,
  loadOfficialStartPlanAuthenticationResolverFactory,
} from "../adapters/official-host-adapter.js";
import { OfficialAppServerRuntimeResolver } from "../runtime/official-app-server-runtime.js";
import { StartPlanBillingEntitlement } from "../runtime/start-plan-production-auth.js";
import { inspectCostLabEnvironment } from "../../tools/cost-lab/web-services.mjs";
import { resolveBillingDataBaseDir } from "../../tools/cost-lab/path-discovery.mjs";
import { runOfficialAppServerProtocolSmoke } from "../../tools/cost-lab/official-app-server-protocol-smoke.mjs";
import { readOfficialStartPlanBilling } from "../../tools/cost-lab/startplan-reader.mjs";
import { createCostLabWebServer } from "../../tools/cost-lab/web-server.mjs";

export interface UnifiedCostLabApplication {
  mountEndpoints(input: { readonly origin: string; readonly port: number }): Promise<void>;
  handleRequest(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void>;
  close(options?: { readonly abortActive?: boolean }): Promise<void>;
  inspectEnvironment(): Promise<Record<string, unknown>>;
  runProtocolProbe(): Promise<Record<string, unknown>>;
}

export interface UnifiedCostLabOptions {
  readonly moduleUrl: string;
  readonly dataRoot: string;
}

export function createUnifiedCostLabApplication(
  options: UnifiedCostLabOptions,
): UnifiedCostLabApplication {
  const layout = consoleLayout(options.moduleUrl);
  const inspectRuntime = (input: RuntimeInspectionInput = {}) => inspectInstalledRuntime(input);
  const protocolSmoke = (input: ProtocolSmokeInput = {}) => runOfficialAppServerProtocolSmoke({
    ...input,
    projectRoot: layout.costLabProjectRoot,
    hostModulePath: layout.officialHostModule,
    runRootParent: path.join(options.dataRoot, ".run"),
    inspectRuntime,
  });
  const readStartPlanBilling = async ({ signal }: { readonly signal?: AbortSignal } = {}) => {
    const data = resolveBillingDataBaseDir(null, {
      env: process.env,
      platform: process.platform,
    });
    return readOfficialStartPlanBilling({
      projectRoot: layout.costLabProjectRoot,
      dataBaseDir: data.dataBaseDir,
      officialHostWorker: layout.officialHostWorker,
      signal,
      officialDependencies: {
        StartPlanBillingEntitlement,
        loadOfficialHostProductVersion,
        loadOfficialStartPlanAuthenticationResolverFactory,
      },
    });
  };
  return createCostLabWebServer({
    projectRoot: layout.costLabProjectRoot,
    evidenceRoot: path.join(options.dataRoot, ".run"),
    historyPath: path.join(options.dataRoot, ".run", "cost-lab-web", "history.json"),
    startPlanHistoryPath: path.join(options.dataRoot, ".run", "cost-lab-web", "startplan-history.json"),
    apiMountPath: "/api/cost-lab",
    officialHostWorker: layout.officialHostWorker,
    inspectEnvironment: (input: Record<string, unknown> = {}) =>
      inspectCostLabEnvironment({ ...input, inspectRuntime }),
    protocolSmoke,
    readStartPlanBilling,
  });
}

export function resolveConsoleProjectRoot(moduleUrl: string): string {
  return consoleLayout(moduleUrl).costLabProjectRoot;
}

interface RuntimeInspectionInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

interface ProtocolSmokeInput {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly modelRequests?: 0;
}

interface ConsoleLayout {
  readonly costLabProjectRoot: string;
  readonly officialHostWorker: string;
  readonly officialHostModule: string;
}

function consoleLayout(moduleUrl: string): ConsoleLayout {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const bundleRoot = path.basename(moduleDirectory) === "dist"
    && existsSync(path.join(path.dirname(moduleDirectory), "worker", "worker-main.mjs"))
    ? path.dirname(moduleDirectory)
    : null;
  if (bundleRoot) {
    return {
      costLabProjectRoot: bundleRoot,
      officialHostWorker: path.join(bundleRoot, "worker", "worker-main.mjs"),
      officialHostModule: path.join(
        bundleRoot,
        "worker",
        "vendor",
        "official-host",
        "win32-x64-node24.16.0-zcode3.18.2-fec97590",
        "official-host-runtime.mjs",
      ),
    };
  }
  const repositoryRoot = findRepositoryRoot(moduleDirectory);
  const pluginRoot = path.join(repositoryRoot, "plugins", "codex-zcode-bridge");
  return {
    costLabProjectRoot: repositoryRoot,
    officialHostWorker: path.join(pluginRoot, "worker", "worker-main.mjs"),
    officialHostModule: path.join(
      pluginRoot,
      "worker",
      "vendor",
      "official-host",
      "win32-x64-node24.16.0-zcode3.18.2-fec97590",
      "official-host-runtime.mjs",
    ),
  };
}

function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, "plugins", "codex-zcode-bridge", "worker", "worker-main.mjs"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("cost_lab_repository_root_unavailable");
}

async function inspectInstalledRuntime(input: RuntimeInspectionInput = {}): Promise<Record<string, unknown>> {
  const runtime = await new OfficialAppServerRuntimeResolver({
    env: input.env,
    platform: input.platform,
    architecture: input.arch,
  }).inspect();
  const root = runtime.install_dir;
  const assets: Record<string, unknown> = {};
  for (const name of ["bundle", "runtime_host", "builtin_provider_config"]) {
    const file = runtime[`${name}_path` as keyof typeof runtime] as string | null | undefined;
    if (root && typeof file === "string") {
      assets[name] = {
        relative_path: path.relative(root, file).split(path.sep).join("/"),
        bytes: runtime[`${name}_bytes` as keyof typeof runtime],
        sha256: runtime[`${name}_sha256` as keyof typeof runtime],
      };
    }
  }
  return {
    install_root: root,
    install_source: runtime.install_source,
    install_root_fingerprint: root
      ? createHash("sha256").update(root).digest("hex")
      : null,
    runtime_status: runtime.status,
    installation_safety: runtime.installation_safety ?? "OFFICIAL_INSTALLATION_INCOMPLETE",
    installation_fingerprint: runtime.installation_fingerprint ?? null,
    experimental_authorization: runtime.experimental_authorization ?? null,
    discount_status: runtime.discount_capability,
    desktop_version: runtime.desktop_version,
    desktop_app_version: runtime.desktop_app_version ?? null,
    desktop_build_commit_id: runtime.desktop_build_commit_id ?? null,
    node_executable: runtime.node_executable,
    reason: runtime.reason,
    manifest: runtime.manifest && { ...runtime.manifest, version: runtime.manifest.desktop_version },
    desktop_executable: runtime.desktop_executable_path ? {
      bytes: runtime.desktop_executable_bytes,
      sha256: runtime.desktop_executable_sha256,
      signer_subject: runtime.desktop_executable_signer_subject,
      signer_thumbprint: runtime.desktop_executable_signer_thumbprint,
    } : null,
    desktop_archive: runtime.desktop_archive_path ? {
      bytes: runtime.desktop_archive_bytes,
      sha256: runtime.desktop_archive_sha256,
    } : null,
    runtime_host_signer: {
      subject: runtime.runtime_host_signer_subject ?? null,
      thumbprint: runtime.runtime_host_signer_thumbprint ?? null,
    },
    assets,
  };
}
