// stdio entry point for the Bridge MCP server (ARCHITECTURE component 1).
//
// Startup never resolves the ZCode provider configuration, so a missing or
// broken ZCode setup cannot prevent the server from starting; such problems
// surface per task through the existing failure flow. All protocol traffic
// goes to stdout via the SDK's serveStdio transport; every log line here is
// written to stderr. SIGINT/SIGTERM close the transport and dispose the
// manager's reconcile timer without touching detached workers, which must
// survive server restarts.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { homedir } from "node:os";
import path from "node:path";
import { findPackageRoot, loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import { TaskStore } from "../store/task-store.js";
import { DirectWorkspaceProvider } from "../workspace/direct-provider.js";
import { BridgeTaskManager } from "../manager/task-manager.js";
import { createBridgeServer } from "../mcp/server.js";
import { DEFAULT_TASK_TIMEOUT_MS, validateTaskTimeout } from "../runtime/task-timeout.js";
import { runBridgeDoctor } from "../runtime/doctor.js";
import { ZCodeModelSettings } from "../runtime/model-settings.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "./profile.js";
import { createWorkerSpawner } from "../manager/spawn-worker.js";
import { SERVER_VERSION } from "../mcp/server.js";

export interface DataRootResolution {
  readonly dataRoot: string;
  readonly warning?: string;
}

/** Frozen rule: use a valid ZCODE_BRIDGE_DATA_DIR, else the Bridge install dir. */
export function resolveDataRoot(env: NodeJS.ProcessEnv): DataRootResolution {
  const override = env["ZCODE_BRIDGE_DATA_DIR"]?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        dataRoot: findPackageRoot(),
        warning: `ZCODE_BRIDGE_DATA_DIR must be an absolute path; ignoring ${override} and using the Bridge installation directory`,
      };
    }
    return { dataRoot: path.normalize(override) };
  }
  return { dataRoot: findPackageRoot() };
}

export interface WorkerLimitResolution {
  readonly maxConcurrentWorkers: number;
  readonly warning?: string;
}

/** Defaults to eight concurrent workers; invalid values fail safely back to one worker. */
export function resolveMaxConcurrentWorkers(env: NodeJS.ProcessEnv): WorkerLimitResolution {
  const raw = env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"]?.trim();
  if (!raw) return { maxConcurrentWorkers: 8 };
  if (!/^[1-8]$/u.test(raw)) {
    return {
      maxConcurrentWorkers: 1,
      warning: "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS must be an integer from 1 to 8; using 1",
    };
  }
  return { maxConcurrentWorkers: Number(raw) };
}

export async function startBridge(host: BridgeHostProfile = codexHostProfile(), version = SERVER_VERSION): Promise<void> {
  validateHostProfile(host);
  const runtimeEnv = loadPersistedRuntimeEnvironment(process.env, homedir(), host);
  if (!runtimeEnv["ZCODE_BRIDGE_DATA_DIR"]?.trim() && host.defaultDataRoot) runtimeEnv["ZCODE_BRIDGE_DATA_DIR"] = host.defaultDataRoot;
  // Keep task records and worktrees outside the versioned marketplace cache.
  // Plugin mode uses this stable per-user data location unless the config file
  // selects a separate task data directory.
  if (process.env["ZCODE_BRIDGE_PLUGIN_MODE"] === "1" && !runtimeEnv["ZCODE_BRIDGE_DATA_DIR"]?.trim()) {
    runtimeEnv["ZCODE_BRIDGE_DATA_DIR"] = host.settingsDirectory;
  }
  const { dataRoot, warning } = resolveDataRoot(runtimeEnv);
  if (warning) {
    console.error(`[bridge] ${warning}`);
  }
  console.error(`[bridge] data root: ${dataRoot}`);

  const workerLimit = resolveMaxConcurrentWorkers(runtimeEnv);
  if (workerLimit.warning) console.error(`[bridge] ${workerLimit.warning}`);
  console.error(`[bridge] max concurrent workers: ${workerLimit.maxConcurrentWorkers}`);
  const timeoutSetting = runtimeEnv["ZCODE_BRIDGE_TIMEOUT_MS"]?.trim();
  if (timeoutSetting) {
    try {
      validateTaskTimeout(Number(timeoutSetting));
    } catch (error) {
      console.error(`[bridge] ${error instanceof Error ? error.message : String(error)}; using the ${DEFAULT_TASK_TIMEOUT_MS / 60_000} minute default`);
    }
  }

  const store = new TaskStore(dataRoot);
  const manager = new BridgeTaskManager({
    store,
    workspaceProvider: new DirectWorkspaceProvider(),
    maxConcurrentWorkers: workerLimit.maxConcurrentWorkers,
    spawnWorker: createWorkerSpawner(host),
  });
  const modelSettings = new ZCodeModelSettings(process.env, { host });
  const server = createBridgeServer({
    taskManager: manager,
    doctor: () => runBridgeDoctor({ env: runtimeEnv, dataRoot, resolver: { host } }),
    modelSettings,
    serverInfo: { name: host.name, version },
    instructions: host.instructions,
  });
  const handle = serveStdio(() => server);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.error(`[bridge] received ${signal}; closing MCP transport (detached workers keep running)`);
    void handle
      .close()
      .catch((error: unknown) => {
        console.error(`[bridge] transport close failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        manager.dispose();
        process.exit(0);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  console.error(`[bridge] ${host.name} stdio MCP server ready`);
}
