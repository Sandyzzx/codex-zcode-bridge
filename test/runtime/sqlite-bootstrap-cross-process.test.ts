import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const fixtureRoot = path.join(process.cwd(), ".run", `bootstrap-lock-evidence-${Date.now()}`);
const workerPath = path.join(process.cwd(), "test", "runtime", "bootstrap-lock-worker.mjs");
const active = new Set<ChildProcess>();
let fixtureSequence = 0;

test.before(() => { mkdirSync(fixtureRoot, { recursive: true }); });
test.after(() => {
  for (const child of active) {
    if (child.exitCode === null) child.kill();
  }
});

interface WorkerStatus {
  readonly schema_version: number;
  readonly pid: number;
  readonly status: "starting" | "stage" | "completed" | "failed";
  readonly stage?: string;
  readonly stages: readonly { readonly stage: string; readonly at: string }[];
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
}

interface WorkerRun {
  readonly child: ChildProcess;
  readonly statusFile: string;
  readonly releaseFile: string;
  readonly evidenceFile: string;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

function checkedTest(name: string, body: () => Promise<void>): void {
  test(name, process.platform === "win32"
    ? { timeout: 90_000 }
    : { skip: "Windows exclusive-file-handle lock coverage" }, async () => {
    try {
      await body();
    } catch (error) {
      throw error;
    }
  });
}

function fixture(_name: string): string {
  const root = path.join(fixtureRoot, `r${fixtureSequence++}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function startWorker(root: string, name: string, options: { readonly holdStage?: string; readonly lockTimeoutMs?: number } = {}): WorkerRun {
  const controlDirectory = `${root}.control`;
  mkdirSync(controlDirectory, { recursive: true });
  const statusFile = path.join(controlDirectory, `${name}-status.json`);
  const releaseFile = path.join(controlDirectory, `${name}-release`);
  const evidenceFile = path.join(controlDirectory, `${name}-exit.json`);
  const config = {
    dataRoot: root,
    databaseFileName: "bridge.sqlite",
    statusFile,
    releaseFile,
    holdStage: options.holdStage,
    holdTimeoutMs: 60_000,
    lockTimeoutMs: options.lockTimeoutMs ?? 30_000,
  };
  const child = spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZCODE_BOOTSTRAP_TEST_CONFIG: JSON.stringify(config),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  active.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      active.delete(child);
      resolve({ code, signal });
    });
  });
  Object.defineProperty(child, "testOutput", {
    configurable: true,
    get: () => ({ stdout, stderr }),
  });
  return { child, statusFile, releaseFile, evidenceFile, exit };
}

function readStatus(run: WorkerRun): WorkerStatus | null {
  try {
    return JSON.parse(readFileSync(run.statusFile, "utf8")) as WorkerStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function waitForStatus(
  run: WorkerRun,
  predicate: (status: WorkerStatus) => boolean,
  timeoutMs = 30_000,
): Promise<WorkerStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatus(run);
    if (status && predicate(status)) return status;
    if (run.child.exitCode !== null) {
      const output = (run.child as ChildProcess & { readonly testOutput?: { readonly stdout: string; readonly stderr: string } }).testOutput;
      throw new Error(`bootstrap worker ${run.child.pid} exited before the expected status; stdout=${output?.stdout}; stderr=${output?.stderr}`);
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for bootstrap worker ${run.child.pid}`);
}

async function waitForStage(run: WorkerRun, stage: string): Promise<WorkerStatus> {
  return waitForStatus(run, (status) => status.status === "stage" && status.stage === stage);
}

async function finish(run: WorkerRun): Promise<WorkerStatus> {
  const exit = await run.exit;
  const output = (run.child as ChildProcess & { readonly testOutput?: { readonly stdout: string; readonly stderr: string } }).testOutput;
  const status = readStatus(run);
  writeFileSync(run.evidenceFile, `${JSON.stringify({
    schema_version: 1,
    pid: run.child.pid,
    exit,
    stderr: output?.stderr ?? "",
    final_status: status,
  }, null, 2)}\n`, "utf8");
  assert.equal(exit.code, 0, `bootstrap worker ${run.child.pid} failed: ${output?.stderr ?? ""}`);
  assert.ok(status);
  assert.equal(status.status, "completed");
  return status;
}

async function stopHeldWorker(run: WorkerRun): Promise<void> {
  assert.equal(run.child.exitCode, null);
  run.child.kill();
  const exit = await run.exit;
  writeFileSync(run.evidenceFile, `${JSON.stringify({
    schema_version: 1,
    pid: run.child.pid,
    requested_action: "force_terminate_test_owned_holder",
    exit,
    final_status: readStatus(run),
  }, null, 2)}\n`, "utf8");
}

function release(run: WorkerRun): void {
  writeFileSync(run.releaseFile, "release\n", "utf8");
}

function directChildren(parentPid: number | undefined): readonly { readonly pid: number; readonly name: string }[] {
  assert.ok(parentPid);
  const systemRoot = process.env["SystemRoot"];
  const candidate = systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const script = `Get-CimInstance Win32_Process -Filter \"ParentProcessId=${parentPid}\" | Select-Object ProcessId,Name | ConvertTo-Json -Compress`;
  const output = execFileSync(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as { ProcessId?: number; Name?: string } | Array<{ ProcessId?: number; Name?: string }>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => Number.isSafeInteger(row.ProcessId) && Number(row.ProcessId) > 0
    ? [{ pid: Number(row.ProcessId), name: String(row.Name ?? "") }]
    : []);
}

async function waitForLockHelperPid(ownerPid: number | undefined): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const helpers = directChildren(ownerPid).filter((child) => /^powershell(?:\.exe)?$/iu.test(child.name));
    if (helpers.length === 1) return helpers[0]!.pid;
    if (helpers.length > 1) throw new Error(`expected one bootstrap lock helper, found ${helpers.length}`);
    await delay(25);
  }
  throw new Error("timed out locating the bootstrap lock helper");
}

function inspectAuthority(root: string) {
  const databasePath = path.join(root, "bridge.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const receipt = database.prepare("SELECT receipt_id FROM fresh_install_receipt").all();
    const capacity = database.prepare("SELECT operation_id FROM manager_operations WHERE operation_kind='capacity_policy_change'").all();
    return {
      integrity: database.prepare("PRAGMA integrity_check").get()?.integrity_check,
      receiptCount: receipt.length,
      receiptId: receipt[0]?.receipt_id,
      capacityOperationCount: capacity.length,
      capacityOperationId: capacity[0]?.operation_id,
      taskCount: database.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n,
      attemptCount: database.prepare("SELECT COUNT(*) AS n FROM attempts").get()?.n,
    };
  } finally {
    database.close();
  }
}

checkedTest("two independent processes initializing the same fresh root serialize to one authority", async () => {
  const root = fixture("simultaneous-first-start");
  const first = startWorker(root, "first");
  const second = startWorker(root, "second");
  const [firstResult, secondResult] = await Promise.all([finish(first), finish(second)]);
  assert.equal(firstResult.result?.receiptId, secondResult.result?.receiptId);
  const authority = inspectAuthority(root);
  assert.equal(authority.integrity, "ok");
  assert.equal(authority.receiptCount, 1);
  assert.equal(authority.capacityOperationCount, 1);
  assert.equal(authority.taskCount, 0);
  assert.equal(authority.attemptCount, 0);
  assert.ok(existsSync(path.join(root, "bridge.sqlite.bootstrap.lock")), "the durable lock file remains");
});

checkedTest("a waiting process cannot remove or rewrite the active owner's marker temp", async () => {
  const root = fixture("active-owner-temp");
  const owner = startWorker(root, "owner", { holdStage: "marker_temp_written" });
  await waitForStage(owner, "marker_temp_written");
  const markerTemp = path.join(root, "bridge.sqlite.bootstrap-marker.tmp");
  assert.ok(existsSync(markerTemp));
  const before = createHash("sha256").update(readFileSync(markerTemp)).digest("hex");

  const waiter = startWorker(root, "waiter", { lockTimeoutMs: 30_000 });
  await waitForStatus(waiter, (status) => status.status === "starting");
  await delay(750);
  assert.ok(existsSync(markerTemp), "the waiter must not remove the active owner's marker temp");
  assert.equal(createHash("sha256").update(readFileSync(markerTemp)).digest("hex"), before);
  assert.equal(waiter.child.exitCode, null);

  await stopHeldWorker(owner);
  const recovered = await finish(waiter);
  assert.equal(recovered.status, "completed");
  assert.equal(inspectAuthority(root).receiptCount, 1);
});

checkedTest("a waiting process times out without touching the active owner's root", async () => {
  const root = fixture("lock-timeout");
  const owner = startWorker(root, "owner", { holdStage: "lock_acquired" });
  await waitForStage(owner, "lock_acquired");
  const waiter = startWorker(root, "waiter", { lockTimeoutMs: 750 });
  const exit = await waiter.exit;
  writeFileSync(waiter.evidenceFile, `${JSON.stringify({
    schema_version: 1,
    pid: waiter.child.pid,
    exit,
    final_status: readStatus(waiter),
  }, null, 2)}\n`, "utf8");
  assert.notEqual(exit.code, 0);
  const status = readStatus(waiter);
  assert.equal(status?.status, "failed");
  assert.equal(status?.error?.code, "sqlite_bootstrap_lock_timeout");
  assert.equal(existsSync(path.join(root, "bridge.sqlite.bootstrap-marker.tmp")), false);
  assert.equal(existsSync(path.join(root, "bridge.sqlite.bootstrap-pending.json")), false);
  assert.equal(existsSync(path.join(root, "bridge.sqlite")), false);
  await stopHeldWorker(owner);
});

checkedTest("an independently terminated lock helper fails closed and blocks takeover until the owner exits", async () => {
  const root = fixture("helper-terminated");
  const owner = startWorker(root, "owner", { holdStage: "marker_temp_written" });
  await waitForStage(owner, "marker_temp_written");
  const helperPid = await waitForLockHelperPid(owner.child.pid);
  process.kill(helperPid, "SIGTERM");

  const contender = startWorker(root, "contender", { lockTimeoutMs: 30_000 });
  const contenderExit = await contender.exit;
  writeFileSync(contender.evidenceFile, `${JSON.stringify({
    schema_version: 1,
    pid: contender.child.pid,
    requested_action: "start_after_owner_lock_helper_was_terminated",
    exit: contenderExit,
    final_status: readStatus(contender),
  }, null, 2)}\n`, "utf8");
  assert.notEqual(contenderExit.code, 0);
  assert.equal(readStatus(contender)?.error?.code, "sqlite_bootstrap_previous_owner_still_alive");

  release(owner);
  const ownerExit = await owner.exit;
  const ownerOutput = (owner.child as ChildProcess & { readonly testOutput?: { readonly stdout: string; readonly stderr: string } }).testOutput;
  writeFileSync(owner.evidenceFile, `${JSON.stringify({
    schema_version: 1,
    pid: owner.child.pid,
    requested_action: "independently_terminate_test_owned_lock_helper",
    helper_pid: helperPid,
    exit: ownerExit,
    stdout: ownerOutput?.stdout ?? "",
    stderr: ownerOutput?.stderr ?? "",
    final_status: readStatus(owner),
  }, null, 2)}\n`, "utf8");
  assert.notEqual(ownerExit.code, 0);
  assert.equal(readStatus(owner)?.error?.code, "sqlite_bootstrap_lock_lost");

  const recovery = startWorker(root, "recovery");
  await finish(recovery);
  const authority = inspectAuthority(root);
  assert.equal(authority.integrity, "ok");
  assert.equal(authority.receiptCount, 1);
  assert.equal(authority.capacityOperationCount, 1);
});

for (const stage of ["intent_written", "schema_initialized", "before_ready_receipt", "capacity_provisioned"]) {
  checkedTest(`an owner terminated at ${stage} is safely recovered by a new process`, async () => {
    const root = fixture(`crash-${stage}`);
    const owner = startWorker(root, "owner", { holdStage: stage });
    await waitForStage(owner, stage);
    await stopHeldWorker(owner);

    const recovery = startWorker(root, "recovery");
    await finish(recovery);
    const authority = inspectAuthority(root);
    assert.equal(authority.integrity, "ok");
    assert.equal(authority.receiptCount, 1);
    assert.equal(authority.capacityOperationCount, 1);
    assert.equal(authority.capacityOperationId, "fresh-install-capacity-v1");
    assert.equal(authority.taskCount, 0);
    assert.equal(authority.attemptCount, 0);
  });
}

checkedTest("multiple recovery processes converge on one complete authority without duplicate capacity", async () => {
  const root = fixture("multiple-recovery");
  const owner = startWorker(root, "owner", { holdStage: "capacity_provisioned" });
  await waitForStage(owner, "capacity_provisioned");
  await stopHeldWorker(owner);

  const recoveries = [
    startWorker(root, "recovery-a"),
    startWorker(root, "recovery-b"),
    startWorker(root, "recovery-c"),
  ];
  const completed = await Promise.all(recoveries.map(finish));
  const receiptIds = new Set(completed.map((status) => status.result?.receiptId));
  assert.equal(receiptIds.size, 1);
  const authority = inspectAuthority(root);
  assert.equal(authority.integrity, "ok");
  assert.equal(authority.receiptCount, 1);
  assert.equal(authority.capacityOperationCount, 1);
});

checkedTest("an existing valid SQLite authority is preserved across concurrent restart checks", async () => {
  const root = fixture("existing-authority");
  const initial = startWorker(root, "initial");
  await finish(initial);
  const before = inspectAuthority(root);
  const first = startWorker(root, "restart-a");
  const second = startWorker(root, "restart-b");
  const results = await Promise.all([finish(first), finish(second)]);
  assert.deepEqual(new Set(results.map((status) => status.result?.receiptId)), new Set([before.receiptId]));
  const after = inspectAuthority(root);
  assert.deepEqual(after, before);
});
