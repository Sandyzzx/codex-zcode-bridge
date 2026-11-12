import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlatformProbe } from "../../../src/runtime/process-probe.js";
import { runWorkerMain } from "../../../src/worker/worker-main.js";
import {
  ZCodeAgentProcessManager as LoopbackProcessManager,
  ZCodeProtocolClient,
} from "./official-host-loopback-module.js";

class CloseFailureProcessManager extends LoopbackProcessManager {
  override async disposeWorkspace(): Promise<void> {
    await super.disposeWorkspace();
    const error = new Error("synthetic official manager close failure") as NodeJS.ErrnoException;
    error.code = "E_SYNTHETIC_CLOSE";
    throw error;
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
await runWorkerMain({
  testOnlyOfficialHostModule: {
    ZCodeAgentProcessManager: CloseFailureProcessManager,
    ZCodeProtocolClient,
  },
  testOnlyWorkerModuleUrl: pathToFileURL(path.join(
    projectRoot,
    "plugins",
    "codex-zcode-bridge",
    "worker",
    "worker-main.mjs",
  )),
  testOnlyProbe: createPlatformProbe({ timeoutMs: 10_000 }),
  testOnlyVerifyTreeClean: async (targets) => ({
    clean: true,
    livePids: [],
    observedPids: targets.map((target) => target.pid),
  }),
});
