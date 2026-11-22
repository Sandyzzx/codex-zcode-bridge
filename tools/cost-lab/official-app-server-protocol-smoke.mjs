import { randomUUID } from "node:crypto";
import { access, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectOfficialRuntimeAssets } from "./official-runtime-manifest.mjs";
import { resolveBillingDataBaseDir } from "./path-discovery.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
export const OFFICIAL_PROTOCOL_SMOKE_METHOD = "runtime/capabilities";
const DEFAULT_TIMEOUT_MS = 30_000;
const RUNTIME_HOST_TRANSPORT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const FIXED_HOST_MODULE_RELATIVE_PATH = path.join(
  "plugins",
  "codex-zcode-bridge",
  "worker",
  "vendor",
  "official-host",
  "win32-x64-node24.16.0-zcode3.18.2-fec97590",
  "official-host-runtime.mjs",
);

let runtimeHostEnvironmentTail = Promise.resolve();

/**
 * Start and stop the installed official AppServer without creating a session
 * or sending a model request. The smoke reuses the fixed official Host module
 * and the same protocol/process lifecycle as production.
 */
export async function runOfficialAppServerProtocolSmoke(options = {}) {
  const startedAt = Date.now();
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") {
    return failed("unsupported_platform", startedAt);
  }

  const env = options.env ?? process.env;
  const inspectRuntime = options.inspectRuntime ?? inspectOfficialRuntimeAssets;
  const resolveDataRoot = options.resolveDataRoot ?? resolveBillingDataBaseDir;
  const createId = options.createId ?? randomUUID;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    return failed("timeout_invalid", startedAt);
  }

  const runtime = await inspectRuntime({ env, platform, arch });
  if ((runtime.runtime_status !== "OFFICIAL_RUNTIME_VERIFIED"
      && runtime.runtime_status !== "OFFICIAL_RUNTIME_EXPERIMENTAL")
    || !runtime.install_root) {
    return failed("installed_official_runtime_unverified", startedAt);
  }
  if (!runtime.desktop_version
    || !runtime.desktop_app_version
    || !runtime.desktop_build_commit_id
    || !runtime.assets?.bundle?.relative_path
    || !runtime.assets?.runtime_host?.relative_path
    || !runtime.assets?.builtin_provider_config?.relative_path) {
    return failed("runtime_manifest_incomplete", startedAt);
  }

  const account = resolveDataRoot(null, {
    env,
    platform,
    fallbackHomeDir: options.fallbackHomeDir,
  });
  const zcodeHome = path.join(account.dataBaseDir, ".zcode");
  const personalProviderConfig = path.join(zcodeHome, "v2", "provider_config.json");
  try {
    await access(personalProviderConfig);
    await stat(personalProviderConfig);
  } catch {
    return failed("personal_provider_config_unavailable", startedAt);
  }

  const runRootParent = path.resolve(options.runRootParent ?? path.join(projectRoot, ".run"));
  const runRoot = path.join(runRootParent, "cost-lab-web", `protocol-smoke-${createId()}`);
  assertInside(runRootParent, runRoot);
  const layout = {
    root: runRoot,
    home: path.join(runRoot, "home"),
    appData: path.join(runRoot, "app-data"),
    localAppData: path.join(runRoot, "local-app-data"),
    temp: path.join(runRoot, "temp"),
    workspace: path.join(runRoot, "workspace"),
  };
  let manager = null;
  let workspace = null;
  let capabilities = null;
  let disposeError = null;
  try {
    options.signal?.throwIfAborted();
    for (const directory of Object.values(layout).slice(1)) {
      await mkdir(directory, { recursive: true });
    }
    const hostModulePath = path.resolve(
      options.hostModulePath ?? path.join(projectRoot, FIXED_HOST_MODULE_RELATIVE_PATH),
    );
    if (!options.loadHostModule) await stat(hostModulePath);
    const module = await (options.loadHostModule
      ? options.loadHostModule(hostModulePath)
      : import(pathToFileURL(hostModulePath).href));
    if (typeof module.ZCodeAgentProcessManager !== "function") {
      return failed("official_host_manager_missing", startedAt);
    }

    const bundlePath = path.join(runtime.install_root, runtime.assets.bundle.relative_path);
    const runtimeHostPath = path.join(runtime.install_root, runtime.assets.runtime_host.relative_path);
    const builtinProviderConfig = path.join(
      runtime.install_root,
      runtime.assets.builtin_provider_config.relative_path,
    );
    const childEnv = buildSmokeEnvironment(layout, env, {
      version: runtime.desktop_app_version,
      buildCommitId: runtime.desktop_build_commit_id,
      builtinProviderConfig,
      personalProviderConfig,
      runtimeHostPath,
      zcodeHome,
      dataBaseDir: account.dataBaseDir,
    });
    const managerOptions = {
      useSharedTaskRuntime: () => false,
      maxFrameBytes: RUNTIME_HOST_TRANSPORT_MAX_FRAME_BYTES,
      requestTimeoutMs: timeoutMs,
      processLifecycleReporter: {
        onSpawn: () => undefined,
        onExit: () => undefined,
        onError: () => undefined,
        onException: () => undefined,
      },
      commandResolver: async ({ workspacePath }) => ({
        command: runtime.node_executable ?? process.execPath,
        args: [bundlePath, "app-server", "--stdio", "--surface", "desktop"],
        cwd: workspacePath,
        env: childEnv,
      }),
    };
    manager = options.createManager
      ? options.createManager(module, managerOptions)
      : new module.ZCodeAgentProcessManager(managerOptions);
    workspace = {
      workspacePath: layout.workspace,
      workspaceIdentity: layout.workspace,
    };
    const client = await withRuntimeHostEnvironment(
      runtimeHostPath,
      () => {
        options.signal?.throwIfAborted();
        return manager.getClient(workspace);
      },
    );
    options.signal?.throwIfAborted();
    const runtimeIdentity = await manager.getRuntimeIdentity(workspace);
    options.signal?.throwIfAborted();
    capabilities = await client.request(
      OFFICIAL_PROTOCOL_SMOKE_METHOD,
      {},
      undefined,
      { signal: options.signal, timeoutMs, invalidateConnectionOnTimeout: false },
    );
    options.signal?.throwIfAborted();
    if (!runtimeIdentity || !Number.isSafeInteger(runtimeIdentity.processId)
      || runtimeIdentity.processId < 1) {
      return failed("official_process_identity_missing", startedAt, {
        protocol_initialized: true,
        model_requests: 0,
      });
    }
    return {
      status: "PASS",
      duration_ms: Date.now() - startedAt,
      evidence: {
        protocol_initialized: true,
        protocol_method: OFFICIAL_PROTOCOL_SMOKE_METHOD,
        capabilities_received: capabilities !== null && typeof capabilities === "object",
        process_started: true,
        session_created: false,
        model_requests: 0,
        runtime_status: runtime.runtime_status,
        installation_fingerprint: runtime.installation_fingerprint,
        installation_safety: runtime.installation_safety,
        experimental_authorization_state: runtime.experimental_authorization?.state ?? null,
        desktop_version: runtime.desktop_version,
        bundle_sha256: runtime.assets.bundle.sha256,
      },
    };
  } catch (error) {
    return failed(safeErrorCode(error), startedAt, {
      protocol_initialized: capabilities !== null,
      model_requests: 0,
    });
  } finally {
    if (manager && workspace) {
      try {
        await manager.disposeWorkspace(workspace);
      } catch (error) {
        disposeError = error;
      }
    }
    if (manager) {
      try {
        await manager.disposeAllAndWait();
      } catch (error) {
        disposeError ??= error;
      }
    }
    let managedProcessesAfter = null;
    try {
      managedProcessesAfter = manager?.listManagedProcesses?.().length ?? null;
    } catch {
      managedProcessesAfter = null;
    }
    if (!disposeError && (managedProcessesAfter ?? 0) === 0) {
      await rm(runRoot, { recursive: true, force: true }).catch((error) => { disposeError = error; });
    }
    if (disposeError || (managedProcessesAfter ?? 0) > 0) {
      // A cleanup failure must not be reported as a successful zero-model smoke.
      return failed(
        disposeError ? "official_protocol_smoke_cleanup_failed" : "official_protocol_smoke_process_leak",
        startedAt,
        { protocol_initialized: capabilities !== null, model_requests: 0, managed_processes_after: managedProcessesAfter },
      );
    }
  }
}

function buildSmokeEnvironment(layout, source, official) {
  const homeDrive = path.parse(layout.home).root.replace(/[\\/]+$/u, "");
  const homePath = layout.home.slice(path.parse(layout.home).root.length - 1);
  const retained = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ]) {
    if (source[key] !== undefined) retained[key] = source[key];
  }
  return {
    ...retained,
    HOME: layout.home,
    USERPROFILE: layout.home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: homePath,
    APPDATA: layout.appData,
    LOCALAPPDATA: layout.localAppData,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
    ZCODE_APP_VERSION: official.version,
    ZCODE_BUILD_COMMIT_ID: official.buildCommitId,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: official.builtinProviderConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: official.personalProviderConfig,
    ZCODE_RUNTIME_HOST_PATH: official.runtimeHostPath,
    ZCODE_HOME: official.zcodeHome,
    ZCODE_DATA_BASE_DIR: official.dataBaseDir,
  };
}

async function withRuntimeHostEnvironment(runtimeHostPath, action) {
  const previous = runtimeHostEnvironmentTail;
  let release;
  runtimeHostEnvironmentTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const priorValue = process.env.ZCODE_RUNTIME_HOST_PATH;
  process.env.ZCODE_RUNTIME_HOST_PATH = runtimeHostPath;
  try {
    return await action();
  } finally {
    if (priorValue === undefined) delete process.env.ZCODE_RUNTIME_HOST_PATH;
    else process.env.ZCODE_RUNTIME_HOST_PATH = priorValue;
    release();
  }
}

function failed(reason, startedAt, evidence = {}) {
  return {
    status: "FAIL",
    duration_ms: Date.now() - startedAt,
    reason,
    evidence: {
      protocol_initialized: false,
      session_created: false,
      model_requests: 0,
      ...evidence,
    },
  };
}

function safeErrorCode(error) {
  const code = error && typeof error === "object" && "code" in error
    ? error.code
    : error instanceof Error ? error.message : String(error);
  return String(code)
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|project[_-]?token)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu, "$1=<redacted>")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer <redacted>")
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t"'<>|]*/gu, "<redacted-path>")
    .replace(/\\\\[^\\/\s]+[\\/][^\r\n\t"'<>|]*/gu, "<redacted-path>")
    .slice(0, 200);
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("protocol_smoke_path_outside_run_root");
  }
}
