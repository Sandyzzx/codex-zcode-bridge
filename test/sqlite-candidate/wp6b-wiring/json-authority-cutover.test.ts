import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { TaskResult } from "../../../src/interfaces.js";
import {
  assertFreshInstallLegacyJsonEmpty,
  SqliteAuthorityStartupError,
} from "../../../src/host/stdio.js";
import { createPlatformProbe } from "../../../src/runtime/process-probe.js";
import type { ProcessProbe } from "../../../src/runtime/process-probe.js";
import {
  defaultDurableFileOperations,
  type DurableFileOperations,
} from "../../../src/runtime/durable-file-system.js";
import { currentSqliteRuntimeRosterDigest } from "../../../src/runtime/sqlite-runtime-roster.js";
import {
  beginJsonWriterDrain,
  registerManagerJsonWriter,
  releaseManagerJsonWriter,
  sealJsonWriterRoot,
} from "../../../src/store/json-writer-quiescence.js";
import {
  JsonAuthorityCutoverError,
  publishJsonAuthority,
  scanJsonAuthority,
} from "../../../src/store/json-authority-cutover.js";
import {
  initializeFreshInstallSqliteRoot,
  loadLifecycleCandidateModules,
} from "../../../src/store/lifecycle-gate.js";
import {
  createJsonHistoryArchive,
  readArchivedJsonHistoryFile,
  readJsonHistoryArchive,
} from "../../../src/store/json-history-archive.js";
import { historicalResultExceptionSetDigest } from "../../../src/store/json-history-result-exceptions.mjs";
import { TaskStore } from "../../../src/store/task-store.js";
import { makeTask, makeTempDir, removeTempDir } from "../../helpers.js";

const CUTOVER_VERIFIER = "wp6-json-cutover-v1";

function terminalResult(taskId: string, startedAt: string, finishedAt: string): TaskResult {
  return {
    task_id: taskId,
    status: "completed",
    summary: "terminal history",
    files_changed: ["kept.txt"],
    tests: [{ command: "node --test", status: "passed", details: "kept in raw Result" }],
    issues: [],
    needs_master_decision: false,
    zcode_output: "terminal output",
    exit_code: 0,
    session_id: "session-cutover",
    attempt: 1,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function exitedProbe(): ProcessProbe {
  const base = createPlatformProbe();
  return {
    ...base,
    probe: async (requests) => requests.map(() => ({
      state: "exited",
      reason_code: "pid_absent_after_complete_query",
      observed_at: new Date().toISOString(),
    })),
  };
}

function syntheticIdentity(pid: number): Record<string, unknown> {
  return {
    pid,
    fingerprint: `synthetic:${pid}`,
    fingerprint_precision: "exact",
    identity_version: 1,
    platform: process.platform,
    captured_at: "2026-10-31T00:00:00.000Z",
  };
}

function recordExitedAttempt(store: TaskStore, taskId: string, attempt = 1): void {
  const workerPid = 4_100_000 + attempt;
  store.writeAttemptMeta(taskId, attempt, "started.json", { worker_pid: workerPid });
  store.writeAttemptMeta(taskId, attempt, "execution.claim", { pid: workerPid });
  store.writeExecutorIdentity(taskId, attempt, { worker: syntheticIdentity(workerPid), runtime: null });
}

async function archiveFixtureRoot(root: string, archiveDirectory: string): Promise<{
  archiveDirectory: string;
  manifestDigest: string;
}> {
  const archive = await createJsonHistoryArchive(path.join(root, ".tasks"), archiveDirectory, { mode: "raw" });
  assert.equal(archive.manifest.archive_mode, "raw");
  assert.equal(archive.manifest.archive_status, "archived", JSON.stringify(archive.manifest.anomalies));
  return {
    archiveDirectory: archive.archive_directory,
    manifestDigest: archive.identity.manifest_digest,
  };
}

async function sealFixtureRoot(root: string, probe: ProcessProbe = createPlatformProbe()): Promise<void> {
  const lease = await registerManagerJsonWriter(root, null);
  await releaseManagerJsonWriter(root, lease);
  assert.equal(await beginJsonWriterDrain(root), "draining");
  const sealed = await sealJsonWriterRoot(root, new TaskStore(root), probe);
  assert.equal(sealed.sealed, true, JSON.stringify(sealed.blockers));
}

async function assertCutoverCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof JsonAuthorityCutoverError && error.code === code,
  );
}

async function withSealedTask(
  prefix: string,
  mutate: (store: TaskStore, root: string, taskId: string) => void | Promise<void>,
  verify: (root: string, taskId: string) => Promise<void>,
  probe: ProcessProbe = createPlatformProbe(),
): Promise<void> {
  const root = await makeTempDir(prefix);
  try {
    mkdirSync(root, { recursive: true });
    const taskId = "task_safe_id";
    const store = new TaskStore(root);
    store.createTask(makeTask({ task_id: taskId }), "2026-10-30T01:00:00.000Z");
    await mutate(store, root, taskId);
    await sealFixtureRoot(root, probe);
    await verify(root, taskId);
  } finally {
    await removeTempDir(root);
  }
}

test("stop-the-world migration preserves raw history and starts an empty SQLite Authority", async () => {
  const root = await makeTempDir("json-authority-cutover");
  const jsonRoot = path.join(root, "json-root");
  const archiveRoot = path.join(root, "archive-root");
  const sqliteRoot = path.join(root, "sqlite-root");
  const terminalId = "terminal-history";
  const queuedId = "queued-carry-forward";
  const postMigrationId = "post-migration-task";
  mkdirSync(jsonRoot, { recursive: true });
  mkdirSync(sqliteRoot, { recursive: true });
  const startedAt = "2026-10-30T01:00:00.000Z";
  const finishedAt = "2026-10-30T01:01:00.000Z";
  try {
    const store = new TaskStore(jsonRoot);
    store.createTask(makeTask({ task_id: terminalId }), "2026-10-30T00:59:00.000Z");
    recordExitedAttempt(store, terminalId);
    store.writeStatus(terminalId, {
      status: "completed",
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: 0,
    }, 1);
    store.writeResult(terminalId, terminalResult(terminalId, startedAt, finishedAt));
    store.appendEvent(terminalId, "turn.started", "started", { retained: true }, startedAt);
    store.appendEvent(terminalId, "turn.completed", "completed", { result: "historical" }, finishedAt);
    const eventPath = path.join(store.taskDir(terminalId), "events.jsonl");
    const eventRows = readFileSync(eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    eventRows[1]!.seq = 3;
    writeFileSync(eventPath, `${eventRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    writeFileSync(path.join(store.taskDir(terminalId), "events.seq"), "3\n", "utf8");
    const interactionRequestId = "request-1";
    store.writeInteractionRequest(terminalId, {
      request_id: interactionRequestId,
      method: "interaction/requestUserInput",
      params: { questions: [{ question: "retain this interaction?" }] },
    }, startedAt);
    const interactionRelativePath = path.relative(
      store.taskDir(terminalId),
      store.interactionRequestPath(terminalId, interactionRequestId),
    ).split(path.sep).join("/");
    store.writeAttemptMeta(terminalId, 1, "heartbeat.json", { heartbeat: "historical" });
    store.writeAttemptFile(terminalId, 1, "worker-stderr.log", "bounded historical worker stderr\n");
    writeFileSync(
      path.join(jsonRoot, ".tasks", ".recovery-last-run"),
      `${JSON.stringify({ schema_version: 1, recovered_at: "2026-10-30T01:00:30.000Z" })}\n`,
      "utf8",
    );

    store.createTask(makeTask({ task_id: queuedId }), "2026-10-30T01:02:00.000Z");
    await sealFixtureRoot(jsonRoot, exitedProbe());
    const archive = await archiveFixtureRoot(jsonRoot, archiveRoot);

    const scan = await scanJsonAuthority(jsonRoot);
    assert.equal(scan.manifest.task_count, 2);
    assert.equal(scan.manifest.result_count, 1);
    assert.equal(scan.manifest.event_count, 2);
    assert.ok(scan.manifest.artifact_count >= 8);

    const published = await publishJsonAuthority({
      jsonDataRoot: jsonRoot,
      sqliteRoot,
      archiveDirectory: archive.archiveDirectory,
      expectedArchiveManifestDigest: archive.manifestDigest,
    });
    assert.equal(published.status, "published");
    assert.equal(published.archive.manifest_digest, archive.manifestDigest);
    assert.equal(published.task_count, 0);
    assert.equal(published.result_count, 0);
    assert.equal(published.event_count, 0);
    assert.equal(published.final_event_cursor, 1);
    assert.equal(published.artifact_count, (await readJsonHistoryArchive(archiveRoot)).source_file_count);
    assert.equal(published.historical_exception_count, 0);
    assert.equal(published.historical_exception_digest, historicalResultExceptionSetDigest([]));
    assert.equal(existsSync(path.join(sqliteRoot, "bridge.sqlite.cutover-pending.json")), false);
    assert.equal(existsSync(published.publication_receipt_path), true);
    assert.deepEqual(
      readdirSync(sqliteRoot).filter((name) => name.includes(".staging")),
      [],
      "a successful publish must not leave staging database or sidecar files",
    );
    await assert.rejects(
      registerManagerJsonWriter(jsonRoot, null),
      /new writer registration is closed/u,
      "the sealed JSON root cannot regain write Authority after SQLite publication",
    );
    const afterPublish = await scanJsonAuthority(jsonRoot);
    assert.equal(
      afterPublish.manifest.manifest_digest,
      scan.manifest.manifest_digest,
      "publishing SQLite must not mutate the sealed JSON authority",
    );

    const modules = await loadLifecycleCandidateModules();
    const migrated = modules.Store.open(sqliteRoot, {
      databaseFileName: "bridge.sqlite",
      managedDataDirectory: true,
    });
    try {
      assert.equal(
        (migrated.assertAuthorityReady(currentSqliteRuntimeRosterDigest()) as Record<string, unknown>).kind,
        "authority_switch",
      );
      const port = modules.createPort(migrated);
      assert.deepEqual(migrated.readMigratedHistoryExceptions(), []);
      assert.equal(port.readTaskLifecycle(terminalId), null);
      assert.equal(port.readTaskLifecycle(queuedId), null);

      assert.throws(
        () => port.readTaskEvents(queuedId, { afterCursor: 0, limit: 200 }),
        /task_not_found/u,
        "legacy JSON events are not part of the online SQLite Authority",
      );
      assert.throws(
        () => port.readTaskEvents(terminalId, { afterCursor: 0, limit: 200 }),
        /task_not_found/u,
        "legacy JSON events are not part of the online SQLite Authority",
      );

      const created = port.createTask(makeTask({
        task_id: postMigrationId,
        workspace: root,
      })) as Record<string, unknown>;
      assert.equal(created.task_id, postMigrationId);
      assert.equal(created.status, "queued");
      const postMigration = port.readTaskLifecycle(postMigrationId) as Record<string, unknown>;
      assert.equal((postMigration.projection as Record<string, unknown>).status, "queued");
      assert.equal(postMigration.result, null);
      const cancellation = port.cancelQueuedAttempt({ task_id: postMigrationId, expected_attempt: 1 }) as Record<string, unknown>;
      const after = port.readTaskEvents(postMigrationId, { afterCursor: 0, limit: 200 });
      assert.equal(after.events.length, 1);
      assert.equal(after.events[0]?.event_type, "cancelled");
      assert.equal(Number(cancellation.event_cursor), Number(after.events[0]?.cursor));

      for (const relativePath of [
        `${terminalId}/result.json`,
        `${terminalId}/events.jsonl`,
        `${terminalId}/${interactionRelativePath}`,
        `${terminalId}/attempts/1/heartbeat.json`,
        `${terminalId}/attempts/1/worker-stderr.log`,
        `.recovery-last-run`,
      ]) {
        assert.equal(migrated.readMigratedArtifact(relativePath), null);
        assert.deepEqual(
          await readArchivedJsonHistoryFile(archiveRoot, relativePath),
          readFileSync(path.join(jsonRoot, ".tasks", relativePath)),
        );
      }
      const authority = migrated.assertAuthorityReady(currentSqliteRuntimeRosterDigest()) as Record<string, unknown>;
      assert.equal(authority.archive_directory, archive.archiveDirectory);
      assert.equal(authority.archive_manifest_digest, archive.manifestDigest);
      assert.equal(authority.historical_exception_count, 0);
      assert.equal(authority.historical_exception_digest, historicalResultExceptionSetDigest([]));
    } finally {
      migrated.close();
    }

    const publication = JSON.parse(readFileSync(published.publication_receipt_path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      published.publication_receipt_path,
      `${JSON.stringify({ ...publication, cutover_id: "tampered-cutover" })}\n`,
      "utf8",
    );
    assert.throws(
      () => modules.Store.open(sqliteRoot, {
        databaseFileName: "bridge.sqlite",
        managedDataDirectory: true,
      }),
      /cutover_publication_receipt_mismatch/u,
    );
    rmSync(published.publication_receipt_path);
    assert.throws(
      () => modules.Store.openForRecovery(sqliteRoot, {
        databaseFileName: "bridge.sqlite",
        managedDataDirectory: true,
      }),
      /cutover_publication_receipt_missing/u,
    );
  } finally {
    await removeTempDir(root);
  }
});

test("raw history archive records legacy anomalies without following workspace links", async () => {
  const root = await makeTempDir("json-history-raw-anomalies");
  const jsonRoot = path.join(root, "json-root");
  const tasksRoot = path.join(jsonRoot, ".tasks");
  const archiveRoot = path.join(root, "archive-root");
  const externalRoot = path.join(root, "external-workspace");
  const taskId = "legacy-anomaly-task";
  mkdirSync(externalRoot, { recursive: true });
  writeFileSync(path.join(externalRoot, "outside.txt"), "external workspace remains untouched\n", "utf8");
  mkdirSync(path.join(tasksRoot, "workspaces"), { recursive: true });
  writeFileSync(path.join(tasksRoot, "workspaces", ".git"), "gitdir: ../external-workspace/.git\n", "utf8");

  try {
    const store = new TaskStore(jsonRoot);
    store.createTask(makeTask({ task_id: taskId }), "2026-10-30T01:00:00.000Z");
    mkdirSync(path.join(store.taskDir(taskId), "interactions"), { recursive: true });
    mkdirSync(path.join(store.taskDir(taskId), "attempts", "2"), { recursive: true });
    writeFileSync(path.join(store.taskDir(taskId), "interactions", "legacy-request.json"), "{}\n", "utf8");
    writeFileSync(path.join(store.taskDir(taskId), "attempts", "2", "respawn.claim"), "legacy respawn claim\n", "utf8");
    writeFileSync(path.join(store.taskDir(taskId), "worker-stderr-repro.log"), "legacy worker stderr\n", "utf8");
    writeFileSync(
      path.join(store.taskDir(taskId), "result.json"),
      `${JSON.stringify({ task_id: taskId, attempt: 99, status: "completed" })}\n`,
      "utf8",
    );
    symlinkSync(externalRoot, path.join(tasksRoot, "workspaces", "external-workspace"), "junction");

    const archive = await createJsonHistoryArchive(tasksRoot, archiveRoot, { mode: "raw" });
    assert.equal(archive.manifest.archive_status, "archived");
    assert.deepEqual(archive.manifest.tasks, []);
    assert.equal(
      archive.manifest.anomalies.some((anomaly) =>
        anomaly.code === "unsafe_entry"
        && anomaly.path === "workspaces/external-workspace"
        && anomaly.detail === "symlink_target_recorded_but_not_followed"),
      true,
    );
    for (const relativePath of [
      "workspaces/.git",
      `${taskId}/interactions/legacy-request.json`,
      `${taskId}/attempts/2/respawn.claim`,
      `${taskId}/worker-stderr-repro.log`,
      `${taskId}/result.json`,
    ]) {
      assert.deepEqual(
        await readArchivedJsonHistoryFile(archiveRoot, relativePath),
        readFileSync(path.join(tasksRoot, relativePath)),
      );
    }
    await assert.rejects(
      readArchivedJsonHistoryFile(archiveRoot, "workspaces/external-workspace"),
      /archive_file_not_found/u,
    );
    assert.equal(
      readFileSync(path.join(externalRoot, "outside.txt"), "utf8"),
      "external workspace remains untouched\n",
    );
  } finally {
    await removeTempDir(root);
  }
});

test("a failed durable publication marker transition remains fail-closed", async () => {
  const root = await makeTempDir("cutover-finalize-fail");
  const jsonRoot = path.join(root, "json-root");
  const sqliteRoot = path.join(root, "sqlite-root");
  const archiveRoot = path.join(root, "archive-root");
  mkdirSync(jsonRoot, { recursive: true });
  mkdirSync(sqliteRoot, { recursive: true });
  try {
    const store = new TaskStore(jsonRoot);
    store.createTask(makeTask({ task_id: "publication_failure" }), "2026-10-30T01:00:00.000Z");
    await sealFixtureRoot(jsonRoot, exitedProbe());
    const archive = await archiveFixtureRoot(jsonRoot, archiveRoot);
    const durability: DurableFileOperations = {
      ...defaultDurableFileOperations,
      moveFileSync(source, destination) {
        if (source.endsWith(".cutover-pending.json")) {
          throw new Error("injected publication finalization failure");
        }
        defaultDurableFileOperations.moveFileSync(source, destination);
      },
    };
    await assert.rejects(
      publishJsonAuthority({
        jsonDataRoot: jsonRoot,
        sqliteRoot,
        archiveDirectory: archive.archiveDirectory,
        expectedArchiveManifestDigest: archive.manifestDigest,
        durability,
      }),
      /injected publication finalization failure/u,
    );
    assert.equal(existsSync(path.join(sqliteRoot, "bridge.sqlite")), true);
    assert.equal(existsSync(path.join(sqliteRoot, "bridge.sqlite.cutover-pending.json")), true);
    assert.equal(existsSync(path.join(sqliteRoot, "bridge.sqlite.cutover-published.json")), false);
    const modules = await loadLifecycleCandidateModules();
    assert.throws(
      () => modules.Store.open(sqliteRoot, {
        databaseFileName: "bridge.sqlite",
        managedDataDirectory: true,
      }),
      /cutover_publish_pending/u,
    );
  } finally {
    await removeTempDir(root);
  }
});

test("archive-first migration rejects archive identity drift before creating a SQLite target", async () => {
  const root = await makeTempDir("json-authority-archive-source-drift");
  const jsonRoot = path.join(root, "json-root");
  const archiveRoot = path.join(root, "archive-root");
  const sqliteRoot = path.join(root, "sqlite-root");
  mkdirSync(jsonRoot, { recursive: true });
  mkdirSync(sqliteRoot, { recursive: true });
  try {
    new TaskStore(jsonRoot).createTask(
      makeTask({ task_id: "queued_after_archive" }),
      "2026-10-31T00:00:00.000Z",
    );
    await sealFixtureRoot(jsonRoot);
    const archive = await archiveFixtureRoot(jsonRoot, archiveRoot);
    await assertCutoverCode(
      publishJsonAuthority({
        jsonDataRoot: jsonRoot,
        sqliteRoot,
        archiveDirectory: archive.archiveDirectory,
        expectedArchiveManifestDigest: "0".repeat(64),
      }),
      "json_archive_changed_after_archive",
    );
    assert.deepEqual(readdirSync(sqliteRoot), [], "source drift must fail before opening a staging database");
    assert.equal(existsSync(path.join(sqliteRoot, "bridge.sqlite")), false);
  } finally {
    await removeTempDir(root);
  }
});

test("archive payload tampering fails before a SQLite target is created", async () => {
  const root = await makeTempDir("json-authority-archive-tamper");
  const jsonRoot = path.join(root, "json-root");
  const archiveRoot = path.join(root, "archive-root");
  const sqliteRoot = path.join(root, "sqlite-root");
  const taskId = "tampered_archive_task";
  mkdirSync(jsonRoot, { recursive: true });
  mkdirSync(sqliteRoot, { recursive: true });
  try {
    new TaskStore(jsonRoot).createTask(
      makeTask({ task_id: taskId }),
      "2026-10-31T00:00:00.000Z",
    );
    await sealFixtureRoot(jsonRoot);
    const archive = await archiveFixtureRoot(jsonRoot, archiveRoot);
    const archivedTaskPath = path.join(archiveRoot, "payload", taskId, "task.json");
    writeFileSync(archivedTaskPath, `${readFileSync(archivedTaskPath, "utf8")} `, "utf8");

    await assertCutoverCode(
      publishJsonAuthority({
        jsonDataRoot: jsonRoot,
        sqliteRoot,
        archiveDirectory: archive.archiveDirectory,
        expectedArchiveManifestDigest: archive.manifestDigest,
      }),
      "json_archive_invalid",
    );
    assert.deepEqual(readdirSync(sqliteRoot), [], "tampered archive must fail before staging");
  } finally {
    await removeTempDir(root);
  }
});

test("sealed JSON drift after archive creation fails before a SQLite target is created", async () => {
  const root = await makeTempDir("json-authority-sealed-source-drift");
  const jsonRoot = path.join(root, "json-root");
  const archiveRoot = path.join(root, "archive-root");
  const sqliteRoot = path.join(root, "sqlite-root");
  const taskId = "drifted_sealed_task";
  mkdirSync(jsonRoot, { recursive: true });
  mkdirSync(sqliteRoot, { recursive: true });
  try {
    new TaskStore(jsonRoot).createTask(
      makeTask({ task_id: taskId }),
      "2026-10-31T00:00:00.000Z",
    );
    await sealFixtureRoot(jsonRoot);
    const archive = await archiveFixtureRoot(jsonRoot, archiveRoot);
    const taskPath = path.join(jsonRoot, ".tasks", taskId, "task.json");
    const task = JSON.parse(readFileSync(taskPath, "utf8")) as Record<string, unknown>;
    writeFileSync(taskPath, `${JSON.stringify({ ...task, objective: "unexpected drift" })}\n`, "utf8");

    await assertCutoverCode(
      publishJsonAuthority({
        jsonDataRoot: jsonRoot,
        sqliteRoot,
        archiveDirectory: archive.archiveDirectory,
        expectedArchiveManifestDigest: archive.manifestDigest,
      }),
      "json_archive_source_mismatch",
    );
    assert.deepEqual(readdirSync(sqliteRoot), [], "sealed source drift must fail before staging");
  } finally {
    await removeTempDir(root);
  }
});

test("fresh SQLite requires an empty legacy JSON root and a durable receipt", async () => {
  const root = await makeTempDir("json-authority-startup-gate");
  const legacyRoot = path.join(root, "legacy");
  const sqliteRoot = path.join(root, "sqlite");
  mkdirSync(path.join(legacyRoot, ".tasks"), { recursive: true });
  mkdirSync(sqliteRoot, { recursive: true });
  try {
    assertFreshInstallLegacyJsonEmpty(legacyRoot);
    mkdirSync(path.join(legacyRoot, ".tasks", "existing-task"), { recursive: true });
    assert.throws(
      () => assertFreshInstallLegacyJsonEmpty(legacyRoot),
      (error: unknown) => error instanceof SqliteAuthorityStartupError
        && error.code === "migration_required_for_existing_json_authority",
    );

    const modules = await loadLifecycleCandidateModules();
    const unreceipted = modules.Store.initialize(sqliteRoot, {
      databaseFileName: "bridge.sqlite",
      managedDataDirectory: true,
    });
    try {
      assert.throws(
        () => unreceipted.assertAuthorityReady(currentSqliteRuntimeRosterDigest()),
        /authority_receipt_missing_or_ambiguous/u,
      );
    } finally {
      unreceipted.close();
    }

    const pendingMarker = path.join(sqliteRoot, "bridge.sqlite.cutover-pending.json");
    writeFileSync(pendingMarker, `${JSON.stringify({
      schema_version: 1,
      state: "authority_switch_pending",
    })}\n`, "utf8");
    assert.throws(
      () => modules.Store.open(sqliteRoot, {
        databaseFileName: "bridge.sqlite",
        managedDataDirectory: true,
      }),
      /cutover_publish_pending/u,
    );
    assert.throws(
      () => modules.Store.openForRecovery(sqliteRoot, {
        databaseFileName: "bridge.sqlite",
        managedDataDirectory: true,
      }),
      /cutover_publish_pending/u,
    );
    const inspectPending = modules.Store.openForRecovery(sqliteRoot, {
      databaseFileName: "bridge.sqlite",
      managedDataDirectory: true,
      allowCutoverPending: true,
    });
    assert.ok(inspectPending);
    inspectPending.close();
    rmSync(pendingMarker);

    const freshRoot = path.join(root, "fresh-sqlite");
    mkdirSync(freshRoot, { recursive: true });
    const receipt = await initializeFreshInstallSqliteRoot(freshRoot, "bridge.sqlite");
    assert.equal(receipt.verifierVersion, CUTOVER_VERIFIER);
    const fresh = modules.Store.open(freshRoot, {
      databaseFileName: "bridge.sqlite",
      managedDataDirectory: true,
    });
    try {
      assert.equal(
        (fresh.assertAuthorityReady("0".repeat(64)) as Record<string, unknown>).kind,
        "fresh_install",
      );
    } finally {
      fresh.close();
    }
  } finally {
    await removeTempDir(root);
  }
});

test("migration rejects unsafe source records and unknown files before staging", async () => {
  await withSealedTask(
    "json-authority-running",
    () => {},
    async (root, taskId) => {
      const statusPath = path.join(root, ".tasks", taskId, "status.json");
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
      writeFileSync(statusPath, JSON.stringify({ ...status, status: "running" }), "utf8");
      await assertCutoverCode(scanJsonAuthority(root), "source_task_not_migratable");
    },
  );

  await withSealedTask(
    "json-authority-cleanup-unverified",
    () => {},
    async (root, taskId) => {
      const statusPath = path.join(root, ".tasks", taskId, "status.json");
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
      writeFileSync(statusPath, JSON.stringify({ ...status, status: "completed", cleanup_unverified: true }), "utf8");
      await assertCutoverCode(scanJsonAuthority(root), "cleanup_unverified_task_not_migratable");
    },
  );

  await withSealedTask(
    "json-authority-unknown-attempt-file",
    (_store, root, taskId) => {
      const attemptDir = path.join(root, ".tasks", taskId, "attempts", "1");
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(path.join(attemptDir, "unclassified.bin"), "raw", "utf8");
    },
    async (root) => assertCutoverCode(scanJsonAuthority(root), "unknown_source_entry"),
  );

  await withSealedTask(
    "json-authority-malformed-attempt-json",
    (_store, root, taskId) => {
      const attemptDir = path.join(root, ".tasks", taskId, "attempts", "1");
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(path.join(attemptDir, "heartbeat.json"), "{not-json", "utf8");
    },
    async (root) => assertCutoverCode(scanJsonAuthority(root), "source_json_invalid"),
  );

  await withSealedTask(
    "json-authority-unsafe-interaction-name",
    (_store, root, taskId) => {
      const interactions = path.join(root, ".tasks", taskId, "interactions");
      mkdirSync(interactions, { recursive: true });
      writeFileSync(path.join(interactions, "request-1.json"), "{}", "utf8");
    },
    async (root) => assertCutoverCode(scanJsonAuthority(root), "unknown_source_entry"),
  );

  await withSealedTask(
    "json-authority-malformed-interaction",
    (_store, root, taskId) => {
      const interactions = path.join(root, ".tasks", taskId, "interactions");
      mkdirSync(interactions, { recursive: true });
      const requestId = "request-malformed";
      const digest = createHash("sha256").update(requestId).digest("hex");
      writeFileSync(path.join(interactions, `1-${digest}.json`), "{}", "utf8");
    },
    async (root) => assertCutoverCode(scanJsonAuthority(root), "source_record_invalid"),
  );

  await withSealedTask(
    "json-authority-cross-bound-result",
    (store, _root, taskId) => {
      recordExitedAttempt(store, taskId);
      store.writeStatus(taskId, {
        status: "completed",
        finished_at: "2026-10-30T01:02:00.000Z",
        exit_code: 0,
      }, 1);
      store.writeResult(taskId, terminalResult(taskId, "2026-10-30T01:00:00.000Z", "2026-10-30T01:02:00.000Z"));
    },
    async (root, taskId) => {
      const resultPath = path.join(root, ".tasks", taskId, "result.json");
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
      writeFileSync(resultPath, JSON.stringify({ ...result, task_id: "other-task" }), "utf8");
      await assertCutoverCode(scanJsonAuthority(root), "cross_bound_result");
    },
    exitedProbe(),
  );

  await withSealedTask(
    "json-authority-linked-source",
    (_store, root, taskId) => {
      const target = path.join(root, "external");
      mkdirSync(target);
      symlinkSync(target, path.join(root, ".tasks", taskId, "linked-source"), "junction");
    },
    async (root) => assertCutoverCode(scanJsonAuthority(root), "source_symlink_rejected"),
  );
});
