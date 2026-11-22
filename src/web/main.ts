#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { codexHostProfile, type BridgeHostProfile } from "../runtime/host-profile.js";
import {
  loadInstallAuthoritySelection,
  resolveSqliteStateDirectory,
} from "../runtime/sqlite-install-config.js";
import { executorPipeName } from "../executor/pipe.js";
import { ExecutorControlClient } from "../executor/control-client.js";
import { RemoteTaskManager } from "../executor/remote-task-manager.js";
import { createTaskConsoleServer } from "./server.js";

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
  try {
    await client.connect();
    const manager = new RemoteTaskManager(client);
    consoleServer = createTaskConsoleServer({
      manager,
      executorStatus: async () => {
        const response = await client.request("executorStatus", {});
        if (!response.ok) throw Object.assign(new Error(response.error?.message ?? "EXECUTOR_STATUS_FAILED"), {
          code: response.error?.code ?? "EXECUTOR_STATUS_FAILED",
        });
        return response.result ?? {};
      },
      port: options.port,
    });
    const address = await consoleServer.start();
    console.log(`TASK_CONSOLE_READY ${JSON.stringify(address)}`);
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
    await consoleServer?.close();
    client.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void runTaskConsoleMain().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
