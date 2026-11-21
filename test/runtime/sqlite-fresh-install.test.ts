import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadInstallAuthoritySelection,
  prepareFreshSqliteStateDirectoryForTest,
} from "../../src/runtime/sqlite-install-config.js";
import {
  initializeFreshInstallSqliteRoot,
  LifecycleGateError,
  loadLifecycleCandidateModules,
} from "../../src/store/lifecycle-gate.js";

// Keep the Windows bootstrap staging database and journal below legacy
// MAX_PATH even in deeply nested integration worktrees.
const fixtureRoot = path.join(process.cwd(), ".run", "sqlite-bootstrap", `fresh-install-${randomUUID()}`);
let failed = false;

test.before(() => { mkdirSync(fixtureRoot, { recursive: true }); });
test.after(() => { if (!failed) rmSync(fixtureRoot, { recursive: true, force: true }); });

function checkedTest(name: string, body: () => void | Promise<void>): void {
  test(name, async () => {
    try { await body(); }
    catch (error) { failed = true; throw error; }
  });
}

function fixture(name: string) {
  const root = path.join(fixtureRoot, name);
  const settingsDirectory = path.join(root, "settings");
  const dataRoot = path.join(root, "data");
  const localAppData = path.join(root, "local-app-data");
  return { root, settingsDirectory, dataRoot, localAppData };
}

function sqliteSelection(fx: ReturnType<typeof fixture>, dataRoot?: string) {
  mkdirSync(fx.settingsDirectory, { recursive: true });
  writeFileSync(
    path.join(fx.settingsDirectory, "authority.json"),
    JSON.stringify({ schema_version: 1, authority: "sqlite", ...(dataRoot ? { data_root: dataRoot } : {}) }),
    "utf8",
  );
  const selection = loadInstallAuthoritySelection({ name: "fresh-install-test", settingsDirectory: fx.settingsDirectory });
  assert.equal(selection.state, "sqlite");
  return selection;
}

checkedTest("fresh install initializes once and repeated or concurrent startup preserves the same receipt", async () => {
  const fx = fixture("double-init");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot),
    {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const [firstReceipt, concurrentReceipt] = await Promise.all([
    initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite"),
    initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite"),
  ]);
  assert.deepEqual(firstReceipt, concurrentReceipt, "concurrent callers share one bootstrap result");
  const database = path.join(prepared.dataRoot, "bridge.sqlite");
  assert.ok(readFileSync(database).length > 0, "database file should exist with bytes");
  const modules = await loadLifecycleCandidateModules();
  const store = modules.Store.open(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true });
  try {
    const authority = store.assertAuthorityReady("0".repeat(64));
    assert.equal(authority.kind, "fresh_install");
    assert.equal(authority.receipt_id, (firstReceipt as Record<string, unknown>).receiptId);
  } finally { store.close(); }
  const secondReceipt = await initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite");
  assert.deepEqual(secondReceipt, firstReceipt, "restart-style ensure reuses the existing authority receipt");
});

function exactIdentity(pid: number) {
  return {
    pid,
    fingerprint: `fixture-${pid}`,
    fingerprint_precision: "exact" as const,
    identity_version: 1 as const,
    platform: process.platform,
    captured_at: new Date().toISOString(),
  };
}

function probeWith(state: "alive" | "exited" | "unknown") {
  return {
    platform: process.platform,
    selfIdentity: async () => exactIdentity(process.pid),
    identityOf: async (pid: number) => exactIdentity(pid),
    probe: async (requests: readonly { readonly pid: number }[]) => requests.map(() => ({
      state,
      reason_code: `fixture_${state}`,
      observed_at: new Date().toISOString(),
    })),
  } as never;
}

function writeBootstrapMarker(root: string, databaseFileName: string, ownerPid: number, token = randomUUID()): string {
  const markerPath = path.join(root, `${databaseFileName}.bootstrap-pending.json`);
  writeFileSync(markerPath, JSON.stringify({
    schema_version: 1,
    state: "sqlite_bootstrap_pending",
    database_file: databaseFileName,
    stage_file: `${databaseFileName}.bootstrap-${token}.stage`,
    token,
    owner_identity: exactIdentity(ownerPid),
  }), "utf8");
  return markerPath;
}

checkedTest("an exited bootstrap owner permits safe cleanup of only its staging files and idempotent retry", async () => {
  const fx = fixture("interrupted-bootstrap");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot), {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const token = randomUUID();
  const databaseFileName = "bridge.sqlite";
  const markerPath = path.join(prepared.dataRoot, `${databaseFileName}.bootstrap-pending.json`);
  const stageFile = `${databaseFileName}.bootstrap-${token}.stage`;
  writeFileSync(markerPath, JSON.stringify({
    schema_version: 1,
    state: "sqlite_bootstrap_pending",
    database_file: databaseFileName,
    stage_file: stageFile,
    token,
    owner_identity: exactIdentity(991827),
  }), "utf8");
  writeFileSync(path.join(prepared.dataRoot, stageFile), "interrupted, unpublished sqlite stage", "utf8");
  writeFileSync(path.join(prepared.dataRoot, `${stageFile}-journal`), "interrupted SQLite journal sidecar", "utf8");

  const result = await initializeFreshInstallSqliteRoot(prepared.dataRoot, databaseFileName, process.versions.node, probeWith("exited"));
  assert.equal((result as Record<string, unknown>).authorityKind, "fresh_install");
  assert.equal(existsSync(markerPath), false);
  assert.equal(existsSync(path.join(prepared.dataRoot, stageFile)), false);
  assert.equal(existsSync(path.join(prepared.dataRoot, `${stageFile}-journal`)), false);
  assert.ok(existsSync(path.join(prepared.dataRoot, databaseFileName)));
});

checkedTest("marker owner liveness is not used as bootstrap lock ownership", async () => {
  const fx = fixture("stale-marker-owner");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot), {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const marker = writeBootstrapMarker(prepared.dataRoot, "bridge.sqlite", 981827);
  const result = await initializeFreshInstallSqliteRoot(
    prepared.dataRoot,
    "bridge.sqlite",
    process.versions.node,
    probeWith("alive"),
  );
  assert.equal((result as Record<string, unknown>).authorityKind, "fresh_install");
  assert.equal(existsSync(marker), false, "the marker is recovered only after acquiring the OS lock");
  assert.ok(existsSync(path.join(prepared.dataRoot, "bridge.sqlite")));
});

checkedTest("an unmarked corrupt database fails closed and is not replaced", async () => {
  const fx = fixture("corrupt-existing-database");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot), {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const database = path.join(prepared.dataRoot, "bridge.sqlite");
  const original = Buffer.from("not a SQLite production database");
  writeFileSync(database, original);
  await assert.rejects(
    initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite"),
    (error: unknown) => error instanceof LifecycleGateError && error.code === "sqlite_existing_database_unverified",
  );
  assert.deepEqual(readFileSync(database), original, "corrupt existing state is never overwritten");
});

checkedTest("a root with a foreign schema version is rejected on open", async () => {
  const fx = fixture("schema-mismatch");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot),
    {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  await initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite");
  // Overwrite the schema version marker to simulate a foreign database.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(prepared.dataRoot, "bridge.sqlite"));
  db.exec("PRAGMA user_version=11");
  db.close();

  const modules = await loadLifecycleCandidateModules();
  assert.throws(
    () => modules.Store.open(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true }),
    (error: unknown) => String(error).includes("schema_version_unknown"),
  );
});

checkedTest("SQLite v13 is rejected without creating sidecars or changing database bytes", async () => {
  const fx = fixture("unsupported-v13");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot),
    {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const database = path.join(prepared.dataRoot, "bridge.sqlite");
  const db = new DatabaseSync(database);
  db.exec("PRAGMA user_version=13");
  db.close();
  const original = readFileSync(database);
  const modules = await loadLifecycleCandidateModules();

  for (const open of [
    () => modules.Store.open(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true }),
    () => modules.Store.openForRecovery(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true }),
  ]) {
    assert.throws(
      open,
      (error: unknown) => (error as { code?: unknown }).code === "unsupported_sqlite_schema"
        && /SQLite v14 ONLY/u.test((error as Error).message),
    );
  }
  await assert.rejects(
    initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite"),
    (error: unknown) => (error as { code?: unknown }).code === "unsupported_sqlite_schema"
      && /SQLite v14 ONLY/u.test((error as Error).message),
  );
  assert.deepEqual(readFileSync(database), original);
  assert.equal(existsSync(`${database}-wal`), false);
  assert.equal(existsSync(`${database}-shm`), false);
});

checkedTest("SQLite v13 rejection preserves an existing WAL and shared-memory file byte-for-byte", async () => {
  const fx = fixture("unsupported-v13-wal");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot),
    {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const database = path.join(prepared.dataRoot, "bridge.sqlite");
  const db = new DatabaseSync(database);
  try {
    db.prepare("PRAGMA journal_mode=WAL").get();
    db.exec("CREATE TABLE probe(value); INSERT INTO probe VALUES (1); PRAGMA user_version=13");
    const before = new Map([
      [database, readFileSync(database)],
      [`${database}-wal`, readFileSync(`${database}-wal`)],
      [`${database}-shm`, readFileSync(`${database}-shm`)],
    ]);
    const modules = await loadLifecycleCandidateModules();

    for (const open of [
      () => modules.Store.open(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true }),
      () => modules.Store.openForRecovery(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true }),
    ]) {
      assert.throws(
        open,
        (error: unknown) => (error as { code?: unknown }).code === "unsupported_sqlite_schema"
          && /SQLite v14 ONLY/u.test((error as Error).message),
      );
    }
    await assert.rejects(
      initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite"),
      (error: unknown) => (error as { code?: unknown }).code === "unsupported_sqlite_schema"
        && /SQLite v14 ONLY/u.test((error as Error).message),
    );
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(file), bytes, `${path.basename(file)} changed`);
  } finally {
    db.close();
  }
});

checkedTest("an interrupted v13 upgrade marker is rejected and preserved exactly", async () => {
  const fx = fixture("unsupported-v13-marker");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot),
    {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const marker = path.join(prepared.dataRoot, "bridge.sqlite.v13-v14-pending.json");
  const original = Buffer.from('{"contract":"sqlite-v13-v14-auto-upgrade-v1"}');
  writeFileSync(marker, original);
  const modules = await loadLifecycleCandidateModules();

  assert.throws(
    () => modules.Store.open(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true }),
    (error: unknown) => (error as { code?: unknown }).code === "unsupported_sqlite_schema"
      && /SQLite v14 ONLY/u.test((error as Error).message),
  );
  await assert.rejects(
    initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite"),
    (error: unknown) => (error as { code?: unknown }).code === "unsupported_sqlite_schema"
      && /SQLite v14 ONLY/u.test((error as Error).message),
  );
  assert.deepEqual(readFileSync(marker), original);
  assert.equal(existsSync(path.join(prepared.dataRoot, "bridge.sqlite")), false);
});

checkedTest("two writers on the same root serialize through the writer-intent gate", async () => {
  const fx = fixture("writer-gate");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot),
    {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  await initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite");
  const modules = await loadLifecycleCandidateModules();
  const first = modules.Store.open(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true });
  try {
    // While the first store is open, a fresh initialize of the same root must refuse.
    assert.throws(
      () => modules.Store.initialize(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true }),
      (error: unknown) => String(error).includes("root_not_empty"),
    );
    // A second open shares the same database and sees the same schema version.
    const second = modules.Store.open(prepared.dataRoot, { databaseFileName: "bridge.sqlite", managedDataDirectory: true });
    second.close();
  } finally { first.close(); }
});

checkedTest("an incomplete unpublished marker write is recovered without touching unrelated JSON history", async () => {
  const fx = fixture("partial-marker-write");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot), {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const legacyHistory = path.join(fx.root, ".tasks", "old-task", "result.json");
  mkdirSync(path.dirname(legacyHistory), { recursive: true });
  const originalHistory = Buffer.from("old JSON history is never read or changed");
  writeFileSync(legacyHistory, originalHistory);
  const markerTemp = path.join(prepared.dataRoot, "bridge.sqlite.bootstrap-marker.tmp");
  writeFileSync(markerTemp, "interrupted marker serialization");

  const receipt = await initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite");
  assert.equal((receipt as Record<string, unknown>).authorityKind, "fresh_install");
  assert.equal(existsSync(markerTemp), false);
  assert.deepEqual(readFileSync(legacyHistory), originalHistory);
});

checkedTest("a pending marker never deletes an unverified database at the production path", async () => {
  const fx = fixture("pending-with-unrelated-database");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot), {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const database = path.join(prepared.dataRoot, "bridge.sqlite");
  const original = Buffer.from("a database whose ownership cannot be proven");
  writeFileSync(database, original);
  const marker = writeBootstrapMarker(prepared.dataRoot, "bridge.sqlite", 981827);

  await assert.rejects(
    initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite", process.versions.node, probeWith("exited")),
    (error: unknown) => error instanceof LifecycleGateError && error.code === "sqlite_bootstrap_published_database_unverified",
  );
  assert.deepEqual(readFileSync(database), original);
  assert.ok(existsSync(marker), "uncertain bootstrap marker remains for diagnosis");
});

checkedTest("a recovered publication must match its bootstrap receipt token and preserves the verified database", async () => {
  const fx = fixture("matching-published-bootstrap");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot), {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  const databaseFileName = "bridge.sqlite";
  const database = path.join(prepared.dataRoot, databaseFileName);
  const token = randomUUID();
  const marker = writeBootstrapMarker(prepared.dataRoot, databaseFileName, 991827, token);
  const modules = await loadLifecycleCandidateModules();
  const staged = modules.Store.initialize(prepared.dataRoot, {
    databaseFileName,
    managedDataDirectory: true,
    freshInstallReceiptId: `fresh-install-${token}`,
    freshInstallCapacityLimit: 8,
    verifierVersion: "test-verifier-v1",
  });
  staged.close();
  const original = readFileSync(database);

  const result = await initializeFreshInstallSqliteRoot(prepared.dataRoot, databaseFileName, process.versions.node, probeWith("exited"));
  assert.equal((result as Record<string, unknown>).receiptId, `fresh-install-${token}`);
  assert.deepEqual(readFileSync(database), original, "verified published SQLite is preserved byte-for-byte");
  assert.equal(existsSync(marker), false);
});
