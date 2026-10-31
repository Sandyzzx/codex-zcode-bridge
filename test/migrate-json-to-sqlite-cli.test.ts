import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPlatformProbe } from "../src/runtime/process-probe.js";
import {
  beginJsonWriterDrain,
  jsonWriterFenceState,
  registerManagerJsonWriter,
  releaseManagerJsonWriter,
  sealJsonWriterRoot,
} from "../src/store/json-writer-quiescence.js";
import { readJsonHistoryArchive } from "../src/store/json-history-archive.js";
import { scanJsonAuthority } from "../src/store/json-authority-cutover.js";
import { TaskStore } from "../src/store/task-store.js";
import { makeTask, makeTempDir, removeTempDir } from "./helpers.js";

interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(argumentsList: readonly string[]): Promise<CliResult> {
  const cli = new URL("../src/cli/migrate-json-to-sqlite.js", import.meta.url);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [fileURLToPath(cli), ...argumentsList], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timer: NodeJS.Timeout | undefined;
  try {
    const [code, signal] = await Promise.race([
      once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("cutover prepare CLI did not settle")), 20_000);
      }),
    ]);
    return {
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPrepare(dataRoot: string): Promise<CliResult> {
  return runCli(["--prepare", "--json-data-root", dataRoot]);
}

test("cutover prepare CLI seals and is idempotent", async () => {
  const root = await makeTempDir("cutover-prepare-sealed");
  let managerLease: string | undefined;
  try {
    const probe = createPlatformProbe({ timeoutMs: 5_000 });
    managerLease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;

    const first = await runPrepare(root);
    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.equal(first.signal, null);
    const firstResult = JSON.parse(first.stdout) as Record<string, unknown>;
    assert.deepEqual(firstResult, {
      status: "sealed",
      drain_state: "draining",
      sealed: true,
      state: "sealed",
      blockers: [],
      reaped_leases: 0,
    });

    const second = await runPrepare(root);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    assert.equal(second.signal, null);
    const secondResult = JSON.parse(second.stdout) as Record<string, unknown>;
    assert.deepEqual(secondResult, {
      status: "sealed",
      drain_state: "sealed",
      sealed: true,
      state: "sealed",
      blockers: [],
      reaped_leases: 0,
    });
    assert.equal(jsonWriterFenceState(root), "sealed");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("cutover prepare CLI keeps a live writer root draining and exits nonzero", async () => {
  const root = await makeTempDir("cutover-prepare-live");
  let managerLease: string | undefined;
  try {
    managerLease = await registerManagerJsonWriter(root, await createPlatformProbe({ timeoutMs: 5_000 }).selfIdentity());
    const result = await runPrepare(root);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.status, "blocked");
    assert.equal(output.sealed, false);
    assert.equal(output.state, "draining");
    assert.ok(Array.isArray(output.blockers));
    assert.ok((output.blockers as string[]).some((blocker) => blocker.startsWith(`writer_not_confirmed_exited:${managerLease}:`)));
    assert.equal(jsonWriterFenceState(root), "draining");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("cutover prepare CLI keeps an unknown writer identity draining and exits nonzero", async () => {
  const root = await makeTempDir("cutover-prepare-unknown");
  let managerLease: string | undefined;
  try {
    managerLease = await registerManagerJsonWriter(root, null);
    const result = await runPrepare(root);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.status, "blocked");
    assert.equal(output.sealed, false);
    assert.equal(output.state, "draining");
    assert.ok((output.blockers as string[]).includes(`writer_identity_unknown:${managerLease}`));
    assert.equal(jsonWriterFenceState(root), "draining");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("cutover apply CLI requires and verifies a complete JSON archive before publishing SQLite", async () => {
  const root = await makeTempDir("cutover-apply-archive");
  const jsonRoot = path.join(root, "json");
  const sqliteRoot = path.join(root, "sqlite");
  const backupRoot = path.join(root, "backup");
  mkdirSync(jsonRoot);
  mkdirSync(sqliteRoot);
  let managerLease: string | undefined;
  try {
    const taskId = "queued-before-cutover";
    const taskStore = new TaskStore(jsonRoot);
    taskStore.createTask(makeTask({ task_id: taskId, workspace: root }), "2026-10-31T00:00:00.000Z");
    const probe = createPlatformProbe({ timeoutMs: 5_000 });
    managerLease = await registerManagerJsonWriter(jsonRoot, await probe.selfIdentity());
    await releaseManagerJsonWriter(jsonRoot, managerLease);
    managerLease = undefined;
    assert.equal(await beginJsonWriterDrain(jsonRoot), "draining");
    const seal = await sealJsonWriterRoot(jsonRoot, new TaskStore(jsonRoot), probe);
    assert.equal(seal.sealed, true, JSON.stringify(seal.blockers));

    const before = await scanJsonAuthority(jsonRoot);
    const result = await runCli([
      "--apply",
      "--json-data-root", jsonRoot,
      "--sqlite-root", sqliteRoot,
      "--backup-root", backupRoot,
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.status, "published");
    assert.equal(output.task_count, 1);
    assert.equal(existsSync(String(output.publication_receipt_path)), true);
    assert.equal(existsSync(path.join(sqliteRoot, "bridge.sqlite.cutover-pending.json")), false);
    const backup = output.backup as Record<string, unknown>;
    assert.equal(backup.disposition, "created");
    assert.equal(backup.archive_directory, backupRoot);
    assert.match(String(backup.archive_manifest_digest), /^[a-f0-9]{64}$/u);
    assert.equal(backup.archive_source_tasks_root, before.tasks_root);
    assert.equal(backup.archive_status, "archived");
    assert.equal(backup.source_file_count, before.manifest.artifact_count);
    assert.equal(backup.source_byte_count, before.manifest.artifact_bytes);
    const archive = await readJsonHistoryArchive(backupRoot);
    assert.equal(archive.archive_status, "archived");
    assert.equal(String(backup.archive_manifest_digest), (output.archive as Record<string, unknown>).manifest_digest);
    assert.equal(archive.source_file_count, before.manifest.artifact_count);
    assert.equal(archive.source_byte_count, before.manifest.artifact_bytes);
  } finally {
    if (managerLease) await releaseManagerJsonWriter(jsonRoot, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});
