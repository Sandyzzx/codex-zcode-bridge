import { existsSync, writeFileSync } from "node:fs";
import { initializeFreshInstallSqliteRoot } from "../../dist-test/src/store/lifecycle-gate.js";

const config = JSON.parse(process.env.ZCODE_BOOTSTRAP_TEST_CONFIG ?? "{}");
if (typeof config.dataRoot !== "string" || typeof config.statusFile !== "string") {
  throw new Error("bootstrap worker config is incomplete");
}

const statusFile = config.statusFile;
const stages = [];
const startedAt = new Date().toISOString();

function publish(status, extra = {}) {
  const value = {
    schema_version: 1,
    pid: process.pid,
    status,
    started_at: startedAt,
    at: new Date().toISOString(),
    stages,
    ...extra,
  };
  writeFileSync(statusFile, `${JSON.stringify(value)}\n`, "utf8");
}

function hold(stage) {
  stages.push({ stage, at: new Date().toISOString() });
  publish("stage", { stage });
  if (stage !== config.holdStage) return;
  const releaseFile = String(config.releaseFile ?? "");
  const deadline = Date.now() + Number(config.holdTimeoutMs ?? 60_000);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releaseFile)) {
    if (Date.now() >= deadline) throw new Error(`timed out holding stage ${stage}`);
    Atomics.wait(sleeper, 0, 0, 25);
  }
}

publish("starting");

try {
  const result = await initializeFreshInstallSqliteRoot(
    config.dataRoot,
    String(config.databaseFileName ?? "bridge.sqlite"),
    process.versions.node,
    undefined,
    {
      lockTimeoutMs: Number(config.lockTimeoutMs ?? 30_000),
      onStage: hold,
    },
  );
  publish("completed", { result });
  process.stdout.write(`${JSON.stringify({ pid: process.pid, status: "completed", result })}\n`);
} catch (error) {
  publish("failed", {
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : null,
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
