import { runWorkerMain } from "../../../src/worker/worker-main.js";

await runWorkerMain({ testOnlyLegacyDirectAdapter: true });
