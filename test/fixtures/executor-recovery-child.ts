import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createExecutorRecoveryCoordinator } from "../../src/executor/recovery.js";

const [dataRoot, settingsDirectory] = process.argv.slice(2);
if (!dataRoot || !settingsDirectory) throw new Error("data root and settings directory are required");

const readyFile = path.join(dataRoot, "recovery-child-ready.json");
const spawnCountFile = path.join(dataRoot, "recovery-child-spawns.txt");
const coordinator = createExecutorRecoveryCoordinator({
  dataRoot,
  settingsDirectory,
  bridgeEntryPath: path.join(dataRoot, "bridge.mjs"),
  startupTimeoutMs: 5_000,
  lockTimeoutMs: 15_000,
  dependencies: {
    probeStatus: async () => {
      if (!existsSync(readyFile)) return null;
      return { lease_id: readFileSync(readyFile, "utf8").trim() };
    },
    spawnExecutor: () => {
      appendFileSync(spawnCountFile, `${String(process.pid)}\n`, "utf8");
      writeFileSync(readyFile, "cross-process-lease", { encoding: "utf8", flag: "wx" });
      return { pid: process.pid };
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
});

const result = await coordinator.ensureRunning();
process.stdout.write(`${JSON.stringify(result)}\n`);
