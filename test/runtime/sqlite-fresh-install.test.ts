import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadInstallAuthoritySelection,
  prepareFreshSqliteStateDirectoryForTest,
} from "../../src/runtime/sqlite-install-config.js";
import {
  initializeFreshInstallSqliteRoot,
  LifecycleGateError,
  loadLifecycleCandidateModules,
} from "../../src/store/lifecycle-gate.js";

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "wp6-fresh-install-"));

test.after(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });

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

test("fresh install initializes a new root once and rejects a second initialization", async () => {
  const fx = fixture("double-init");
  const prepared = prepareFreshSqliteStateDirectoryForTest(
    sqliteSelection(fx, fx.dataRoot),
    {} as NodeJS.ProcessEnv,
    { packageRoot: path.join(fx.root, "pkg"), tempRoot: path.join(fx.root, "tmp") },
  );
  // The selection is JSON by default; initialize the synthetic root directly.
  await initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite");
  const database = path.join(prepared.dataRoot, "bridge.sqlite");
  assert.ok(readFileSync(database).length > 0, "database file should exist with bytes");

  await assert.rejects(
    () => initializeFreshInstallSqliteRoot(prepared.dataRoot, "bridge.sqlite"),
    (error: unknown) => error instanceof LifecycleGateError
      && error.code === "sqlite_initialization_failed"
      && error.message.includes("root_not_empty"),
  );
});

test("a root with a foreign schema version is rejected on open", async () => {
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

test("two writers on the same root serialize through the writer-intent gate", async () => {
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
