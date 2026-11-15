import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlatformProbe } from "../../../src/runtime/process-probe.js";
import { runWorkerMain } from "../../../src/worker/worker-main.js";
import {
  ZCodeAgentProcessManager,
  ZCodeProtocolClient,
} from "./official-host-loopback-module.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workerModuleUrl = pathToFileURL(path.join(
  projectRoot,
  "plugins",
  "codex-zcode-bridge",
  "worker",
  "worker-main.mjs",
));

await runWorkerMain({
  testOnlyOfficialHostModule: {
    ZCODE_PRODUCT_VERSION: "3.18.2",
    ZCodeAgentProcessManager,
    ZCodeProtocolClient,
  },
  testOnlyWorkerModuleUrl: workerModuleUrl,
  testOnlyProbe: createPlatformProbe({ timeoutMs: 10_000 }),
  testOnlyVerifyTreeClean: async (targets) => ({
    clean: true,
    livePids: [],
    observedPids: targets.map((target) => target.pid),
  }),
});
