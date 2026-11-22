#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { codexHostProfile, type BridgeHostProfile } from "../runtime/host-profile.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import {
  loadInstallAuthoritySelection,
  resolveSqliteStateDirectory,
} from "../runtime/sqlite-install-config.js";
import { authorityRootDigest } from "../executor/lease.js";
import { executorPipeName } from "../executor/pipe.js";
import { ExecutorControlClient } from "../executor/control-client.js";
import { RemoteTaskManager } from "../executor/remote-task-manager.js";
import {
  createUnifiedCostLabApplication,
  resolveConsoleProjectRoot,
} from "./cost-lab-integration.js";
import { RuntimeCompatibilityService } from "./runtime-compatibility.js";
import { createTaskConsoleServer } from "./server.js";
import {
  fetchTaskConsoleSession,
  inspectTaskConsoleDiscovery,
  publishTaskConsoleDiscovery,
  removeTaskConsoleDiscovery,
  TaskConsoleDiscoveryError,
  type TaskConsoleDiscoveryRecord,
} from "./discovery.js";

const WEB_CONSOLE_USAGE = [
  "usage: node dist/src/web/main.js --data-root ABS [--settings-directory ABS] [--port 0..65535]",
].join("\n");

interface ConsoleOptions {
  readonly dataRoot: string;
  readonly settingsDirectory: string;
  readonly port: number;
}

function fail(message: string): never {
  console.error(`TASK_CONSOLE_FAILED ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseArguments(argv: readonly string[], host: BridgeHostProfile): ConsoleOptions {
  let dataRoot: string | null = null;
  let settingsDirectory: string = host.settingsDirectory;
  let port = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--data-root") {
      if (!value || !path.isAbsolute(value)) fail("data_root_absolute_required");
      dataRoot = path.normalize(value);
      index += 1;
    } else if (argument === "--settings-directory") {
      if (!value || !path.isAbsolute(value)) fail("settings_directory_absolute_required");
      settingsDirectory = path.normalize(value);
      index += 1;
    } else if (argument === "--port") {
      if (!value || !/^\d+$/u.test(value)) fail("port_invalid");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) fail("port_invalid");
      port = parsed;
      index += 1;
    } else {
      fail(`unknown_argument:${argument}`);
    }
  }
  const effectiveHost = { ...host, settingsDirectory };
  const selection = loadInstallAuthoritySelection(effectiveHost);
  const resolvedRoot = dataRoot ?? resolveSqliteStateDirectory(selection, process.env).dataRoot;
  return { dataRoot: resolvedRoot, settingsDirectory, port };
}

export async function runTaskConsoleMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(WEB_CONSOLE_USAGE);
    return;
  }
  const host = codexHostProfile();
  const options = parseArguments(argv, host);
  const client = new ExecutorControlClient({ pipeName: executorPipeName(options.dataRoot) });
  let consoleServer: ReturnType<typeof createTaskConsoleServer> | undefined;
  let ownDiscovery: TaskConsoleDiscoveryRecord | undefined;
  try {
    await client.connect();
    const executorResponse = await client.request("executorStatus", {});
    if (!executorResponse.ok || typeof executorResponse.result?.lease_id !== "string") {
      throw Object.assign(new Error("Task Console requires an active Executor lease"), {
        code: "EXECUTOR_UNAVAILABLE",
      });
    }
    const consoleId = randomUUID();
    const manager = new RemoteTaskManager(client);
    const costLab = createUnifiedCostLabApplication({
      moduleUrl: import.meta.url,
      dataRoot: options.dataRoot,
    });
    const projectRoot = resolveConsoleProjectRoot(import.meta.url);
    const runtimeCompatibility = new RuntimeCompatibilityService({
      projectRoot,
      historyPath: path.join(
        options.dataRoot,
        ".run",
        "bridge-console",
        "runtime-compatibility.json",
      ),
      inspectEnvironment: () => costLab.inspectEnvironment(),
      runProtocolProbe: () => costLab.runProtocolProbe(),
    });
    consoleServer = createTaskConsoleServer({
      manager,
      costLab,
      runtimeCompatibility,
      executorStatus: async () => {
        const response = await client.request("executorStatus", {});
        if (!response.ok) throw Object.assign(new Error(response.error?.message ?? "EXECUTOR_STATUS_FAILED"), {
          code: response.error?.code ?? "EXECUTOR_STATUS_FAILED",
        });
        return response.result ?? {};
      },
      port: options.port,
      consoleId,
      authorityRootDigest: authorityRootDigest(options.dataRoot),
    });
    const address = await consoleServer.start();
    const processProbe = createPlatformProbe();
    try {
      ownDiscovery = await publishTaskConsoleDiscovery({
        dataRoot: options.dataRoot,
        consoleId,
        origin: address.origin,
        url: address.url,
        port: address.port,
        processProbe,
      });
    } catch (error) {
      if (!(error instanceof TaskConsoleDiscoveryError) || error.code !== "WEB_CONSOLE_DISCOVERY_EXISTS") {
        throw error;
      }
      const existing = await inspectTaskConsoleDiscovery(options.dataRoot, processProbe);
      if (existing.state === "stale_owner" && existing.record) {
        removeTaskConsoleDiscovery(options.dataRoot, existing.record);
        ownDiscovery = await publishTaskConsoleDiscovery({
          dataRoot: options.dataRoot,
          consoleId,
          origin: address.origin,
          url: address.url,
          port: address.port,
          processProbe,
        });
      } else if (existing.state === "active_owner" && existing.record) {
        const session = await fetchTaskConsoleSession(existing.record);
        if (session.executor.lease_id !== executorResponse.result.lease_id) {
          throw new TaskConsoleDiscoveryError(
            "WEB_CONSOLE_DISCOVERY_CHANGED",
            "Task Console discovery is bound to a different Executor lease",
          );
        }
        console.log(`TASK_CONSOLE_READY ${JSON.stringify({
          ...existing.record,
          executor: session.executor,
          reused: true,
        })}`);
        return;
      } else {
        throw new TaskConsoleDiscoveryError(
          existing.state === "owner_unknown" ? "WEB_CONSOLE_OWNER_UNRESPONSIVE" : "WEB_CONSOLE_DISCOVERY_INVALID",
          "Task Console discovery already has an owner that cannot be safely reused",
        );
      }
    }
    console.log(`TASK_CONSOLE_READY ${JSON.stringify({
      ...address,
      console_id: ownDiscovery.console_id,
      pid: ownDiscovery.pid,
      reused: false,
    })}`);
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } finally {
    try {
      await consoleServer?.close();
      if (ownDiscovery) {
        try {
          removeTaskConsoleDiscovery(options.dataRoot, ownDiscovery);
        } catch (error) {
          if (!(error instanceof TaskConsoleDiscoveryError) || error.code !== "WEB_CONSOLE_DISCOVERY_CHANGED") {
            console.error(`TASK_CONSOLE_DISCOVERY_RELEASE_UNKNOWN ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } finally {
      client.close();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void runTaskConsoleMain().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
