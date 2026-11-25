// Thin MCP stdio entry point. The Executor owns every lifecycle and SQLite
// write; this process only translates MCP traffic into Control IPC calls.
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { ExecutorControlClient } from "../executor/control-client.js";
import { RemoteModelSettings } from "../executor/remote-model-settings.js";
import { RemoteTaskManager } from "../executor/remote-task-manager.js";
import { executorPipeName } from "../executor/pipe.js";
import { createExecutorRecoveryCoordinator } from "../executor/recovery.js";
import { createBridgeServer, SERVER_VERSION } from "../mcp/server.js";
import type { McpDoctorReport } from "../mcp/contracts.js";
import type { TaskConsoleLink } from "../interfaces.js";
import { findPackageRoot, loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import {
  loadInstallAuthoritySelection,
  resolveSqliteStateDirectory,
} from "../runtime/sqlite-install-config.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "../runtime/host-profile.js";
import { resolveTaskConsoleLink, taskConsoleAutostartEnabled } from "../web/console-link.js";

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

export interface StdioLifecycleHost {
  /** Begin or retry transport shutdown. False means the MCP wire remains available. */
  shutdown(reason: string): Promise<boolean>;
}

/** Closing stdio only disconnects the client; Executor-owned Tasks are untouched. */
export function serveStdioThinHost(
  server: ReturnType<typeof createBridgeServer>,
  client: ExecutorControlClient,
  options: {
    readonly stdin?: Readable;
    readonly stdout?: Writable;
    readonly onShutdownFailure?: (reason: string, error: unknown) => void;
    readonly onShutdownComplete?: (reason: string) => void;
  } = {},
): StdioLifecycleHost {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  let handle: StdioServerHandle;
  let closed = false;
  let current: Promise<boolean> | null = null;
  let shutdown!: (reason: string) => Promise<boolean>;
  const disconnect = (): void => {
    if (closed) return;
    closed = true;
    client.close();
  };
  stdin.once("end", disconnect);
  stdin.once("close", disconnect);

  shutdown = (reason: string): Promise<boolean> => {
    if (closed) return Promise.resolve(true);
    if (current) return current;
    let attempt!: Promise<boolean>;
    attempt = (async () => {
      try {
        await handle.close();
        disconnect();
        options.onShutdownComplete?.(reason);
        return true;
      } catch (error) {
        options.onShutdownFailure?.(reason, error);
        return false;
      } finally {
        if (current === attempt) current = null;
      }
    })();
    current = attempt;
    return attempt;
  };

  handle = serveStdio(() => server, { transport });
  if (stdin.readableEnded || stdin.destroyed) queueMicrotask(disconnect);
  return { shutdown };
}

export function resolveMcpTransport(env: NodeJS.ProcessEnv): "control" {
  const raw = env["ZCODE_BRIDGE_MCP_TRANSPORT"]?.trim().toLowerCase() || "control";
  if (raw !== "control") {
    throw new Error("ZCODE_BRIDGE_MCP_TRANSPORT=in_process has been removed; start the Executor and use control transport");
  }
  return "control";
}

/**
 * Automatic recovery is the production default. The explicit disable switch
 * keeps transport-only diagnostics deterministic without spawning a service.
 */
export function executorAutoRecoveryEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env["ZCODE_BRIDGE_EXECUTOR_AUTO_RECOVER"]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

async function readExecutorDoctor(client: ExecutorControlClient): Promise<McpDoctorReport> {
  await client.connect();
  const response = await client.request("doctor", {});
  if (!response.ok) {
    const error = new Error(response.error?.message ?? "EXECUTOR_REQUEST_FAILED") as Error & { code?: string };
    error.code = response.error?.code ?? "EXECUTOR_REQUEST_FAILED";
    throw error;
  }
  return response.result as unknown as McpDoctorReport;
}

async function startThinBridge(host: BridgeHostProfile, version: string, bridgeEntryPath: string): Promise<void> {
  validateHostProfile(host);
  const authoritySelection = loadInstallAuthoritySelection(host);
  const resolved = resolveSqliteStateDirectory(authoritySelection, process.env);
  const pipeName = executorPipeName(resolved.dataRoot);
  const autoRecovery = executorAutoRecoveryEnabled(process.env);
  const recovery = autoRecovery
    ? createExecutorRecoveryCoordinator({
      dataRoot: resolved.dataRoot,
      settingsDirectory: host.settingsDirectory,
      bridgeEntryPath,
      pipeName,
    })
    : null;
  const client = new ExecutorControlClient({
    pipeName,
    ...(recovery
      ? { recoverUnavailable: () => recovery.ensureRunning().then(() => undefined) }
      : {}),
  });
  const taskConsoleAutostart = taskConsoleAutostartEnabled(
    loadPersistedRuntimeEnvironment(process.env, undefined, host),
  );
  const taskConsoleLink = async (taskId: string): Promise<TaskConsoleLink> => {
    if (!taskConsoleAutostart) {
      return {
        available: false,
        web_url: null,
        console_id: null,
        console_reused: null,
        reason_code: "WEB_CONSOLE_DISABLED",
      };
    }
    await client.connect();
    const status = await client.request("executorStatus", {});
    const leaseId = status.ok && typeof status.result?.lease_id === "string"
      ? status.result.lease_id
      : null;
    if (!leaseId) {
      throw Object.assign(new Error("Executor lease identity is unavailable"), {
        code: "EXECUTOR_LEASE_UNKNOWN",
      });
    }
    const link = await resolveTaskConsoleLink({
      dataRoot: resolved.dataRoot,
      settingsDirectory: host.settingsDirectory,
      taskId,
      leaseId,
    });
    return {
      available: true,
      web_url: link.web_url,
      console_id: link.console_id,
      console_reused: link.console_reused,
      reason_code: null,
    };
  };
  const server = createBridgeServer({
    taskManager: new RemoteTaskManager(client, { taskConsoleLink }),
    doctor: () => readExecutorDoctor(client),
    modelSettings: new RemoteModelSettings(client),
    serverInfo: { name: host.name, version },
    instructions: host.instructions,
  });
  const stdioHost = serveStdioThinHost(server, client, {
    onShutdownFailure: (reason, error) => {
      process.exitCode = 1;
      console.error(`[bridge] ${reason} thin MCP disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    },
    onShutdownComplete: (reason) => {
      if (reason !== "EOF") process.exit(0);
    },
  });
  const shutdown = (signal: string): void => {
    console.error(`[bridge] received ${signal}; closing thin MCP transport without cancelling Executor Tasks`);
    void stdioHost.shutdown(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  console.error(`[bridge] data root: ${resolved.dataRoot}`);
  console.error("[bridge] Executor control transport enabled; no local SQLite Manager is constructed");
  console.error(`[bridge] Executor automatic recovery ${autoRecovery ? "enabled" : "disabled"}`);
  console.error(`[bridge] ${host.name} thin stdio MCP server ready`);
}

export async function startBridge(
  host: BridgeHostProfile = codexHostProfile(),
  version = SERVER_VERSION,
  bridgeEntryPath = process.argv[1],
): Promise<void> {
  resolveMcpTransport(process.env);
  if (!bridgeEntryPath) throw new Error("Bridge entry path is unavailable");
  await startThinBridge(host, version, path.resolve(bridgeEntryPath));
}
