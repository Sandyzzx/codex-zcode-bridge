#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SIGNAL_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/u;
const MAX_CHILD_STDOUT = 64 * 1024;
const MAX_CHILD_STDERR = 8 * 1024;
const HARD_TIMEOUT_GRACE_MS = 30_000;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    "usage: node signal-only-wait.mjs --waiter <dist/wait-task.mjs> --task <task_id> "
      + "--data-dir <ABS_SQLITE_STATE_DIR> [--timeout-s S] [--poll-ms MS]\n",
  );
  process.exit(0);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`WAIT_ERROR ${diagnostic(error)}\n`);
  process.exit(2);
}

const child = spawn(
  process.execPath,
  [
    options.waiter,
    "--task",
    options.task,
    "--timeout-s",
    String(options.timeoutS),
    "--poll-ms",
    String(options.pollMs),
    "--data-dir",
    options.dataDir,
  ],
  {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
let stdoutBytes = 0;
let stderrBytes = 0;
let settled = false;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBytes += Buffer.byteLength(chunk, "utf8");
  if (stdoutBytes <= MAX_CHILD_STDOUT) stdout += chunk;
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrBytes += Buffer.byteLength(chunk, "utf8");
  if (stderrBytes <= MAX_CHILD_STDERR) stderr += chunk;
});

const hardTimeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  child.kill();
  process.stderr.write("WAIT_ERROR code=waiter_hard_timeout\n");
  process.exitCode = 2;
}, options.timeoutS * 1_000 + HARD_TIMEOUT_GRACE_MS);
hardTimeout.unref();

child.on("error", (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(hardTimeout);
  process.stderr.write(`WAIT_ERROR ${diagnostic(error)}\n`);
  process.exitCode = 2;
});

child.on("close", (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(hardTimeout);
  const exitCode = Number.isInteger(code) ? code : 2;

  if (stdoutBytes > MAX_CHILD_STDOUT || stderrBytes > MAX_CHILD_STDERR) {
    process.stderr.write("WAIT_ERROR code=waiter_output_too_large\n");
    process.exitCode = 2;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
    validatePayload(payload, options.task);
  } catch (error) {
    const detail = signal ? `signal=${signal}` : `exit=${exitCode}`;
    process.stderr.write(`WAIT_ERROR code=invalid_waiter_output ${detail} ${diagnostic(error)}\n`);
    process.exitCode = exitCode === 0 ? 2 : exitCode;
    return;
  }

  if (exitCode === 3 && payload.reason === "timeout") {
    process.stdout.write("WAIT_TIMEOUT\n");
    process.exitCode = 3;
    return;
  }

  if (exitCode !== 0) {
    process.stderr.write(`WAIT_ERROR code=waiter_exit_${exitCode}\n`);
    process.exitCode = exitCode;
    return;
  }

  process.stdout.write(
    `ATTENTION task=${options.task} attempt=${payload.attempt} `
      + `status=${payload.status} reason=${payload.reason}\n`,
  );
  process.exitCode = 0;
});

function parseArgs(argv) {
  const options = {
    waiter: null,
    task: null,
    dataDir: null,
    timeoutS: 300,
    pollMs: 2_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--waiter") options.waiter = requireAbsolute(value, "--waiter");
    else if (flag === "--task") options.task = value;
    else if (flag === "--data-dir") options.dataDir = requireAbsolute(value, "--data-dir");
    else if (flag === "--timeout-s") options.timeoutS = integer(flag, value, 1, 86_400);
    else if (flag === "--poll-ms") options.pollMs = integer(flag, value, 250, 60_000);
    else throw new Error(`unknown option ${flag}`);
  }

  if (!options.waiter) throw new Error("--waiter is required");
  if (!options.task || !TASK_ID.test(options.task)) {
    throw new Error("--task must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
  }
  if (!options.dataDir) throw new Error("--data-dir is required");
  return options;
}

function validatePayload(value, expectedTask) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("output is not an object");
  if (value.schema !== "zcode-bridge/wait-task-v2") throw new Error("unexpected waiter schema");
  if (value.task_id !== expectedTask) throw new Error("waiter task mismatch");
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new Error("invalid attempt");
  if (typeof value.status !== "string" || !SIGNAL_VALUE.test(value.status)) throw new Error("invalid status");
  if (value.reason !== "interaction" && value.reason !== "terminal" && value.reason !== "attempt_changed" && value.reason !== "timeout") {
    throw new Error("invalid reason");
  }
}

function integer(flag, value, min, max) {
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be within ${min}..${max}`);
  }
  return parsed;
}

function requireAbsolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.normalize(value);
}

function diagnostic(error) {
  return `code=wrapper_error diagnostic=${String(error instanceof Error ? error.message : error)
    .replace(/\s+/gu, " ")
    .slice(0, 240)
    .replace(/[^\x20-\x7E]/gu, "?")}`;
}
