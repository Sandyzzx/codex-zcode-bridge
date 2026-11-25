import { appendFileSync } from "node:fs";
import path from "node:path";
import { runWorkerMain } from "../../src/worker/worker-main.js";

const tempDirectory = process.env["TEMP"] ?? process.env["TMP"];
if (!tempDirectory || !path.isAbsolute(tempDirectory)) {
  throw new Error("the Worker fixture requires an absolute TEMP directory");
}
const spawnLog = path.join(tempDirectory, "executor-recovery-worker-spawns.log");
appendFileSync(spawnLog, `${String(process.pid)}\n`, "utf8");
await runWorkerMain();
