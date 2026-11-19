import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlatformProbe } from "../../../src/runtime/process-probe.js";
import { runWorkerMain } from "../../../src/worker/worker-main.js";
import {
  ZCodeAgentProcessManager,
  ZCodeProtocolClient,
} from "./official-host-loopback-module.js";
import { createTestOnlyInstalledRuntime } from "./test-only-installed-runtime.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const installedRuntime = createTestOnlyInstalledRuntime({ codingPlanDiscountVerified: false });

await runWorkerMain({
  testOnlyOfficialHostModule: {
    ZCODE_PRODUCT_VERSION: "3.18.2",
    ZCodeAgentProcessManager,
    ZCodeProtocolClient,
  },
  testOnlyWorkerModuleUrl: pathToFileURL(path.join(
    projectRoot,
    "plugins",
    "codex-zcode-bridge",
    "worker",
    "worker-main.mjs",
  )),
  testOnlyOfficialRuntimeResolver: installedRuntime.resolver,
  testOnlyOfficialHostAssets: installedRuntime.assets,
  testOnlyProbe: createPlatformProbe({ timeoutMs: 10_000 }),
  testOnlyVerifyTreeClean: async (targets) => ({
    clean: true,
    livePids: [],
    observedPids: targets.map((target) => target.pid),
  }),
});
