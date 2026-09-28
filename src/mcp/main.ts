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
import { pathToFileURL } from "node:url";
import { findPackageRoot, loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import { TaskStore } from "../store/task-store.js";
import { DirectWorkspaceProvider } from "../workspace/direct-provider.js";
import { BridgeTaskManager } from "../manager/task-manager.js";
import { createBridgeServer } from "./server.js";

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

async function main(): Promise<void> {
  const runtimeEnv = loadPersistedRuntimeEnvironment(process.env);
  // Keep task records and worktrees outside the versioned marketplace cache.
  // Plugin mode uses this stable per-user data location unless the config file
  // selects a separate task data directory.
  if (process.env["ZCODE_BRIDGE_PLUGIN_MODE"] === "1" && !runtimeEnv["ZCODE_BRIDGE_DATA_DIR"]?.trim()) {
    runtimeEnv["ZCODE_BRIDGE_DATA_DIR"] = path.join(homedir(), ".codex", "codex-zcode-bridge");
  }
  const { dataRoot, warning } = resolveDataRoot(runtimeEnv);
  if (warning) {
    console.error(`[bridge] ${warning}`);
  }
  console.error(`[bridge] data root: ${dataRoot}`);

  const workerLimit = resolveMaxConcurrentWorkers(runtimeEnv);
  if (workerLimit.warning) console.error(`[bridge] ${workerLimit.warning}`);
  console.error(`[bridge] max concurrent workers: ${workerLimit.maxConcurrentWorkers}`);

  const store = new TaskStore(dataRoot);
  const manager = new BridgeTaskManager({
    store,
    workspaceProvider: new DirectWorkspaceProvider(),
    maxConcurrentWorkers: workerLimit.maxConcurrentWorkers,
  });
  const server = createBridgeServer({ taskManager: manager });
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

  console.error("[bridge] codex-zcode-bridge stdio MCP server ready");
}

// Run the server only when this file is the process entry point (importing
// the module — e.g. from tests — must not start listening on stdin).
const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  void main().catch((error: unknown) => {
    console.error(`[bridge] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
