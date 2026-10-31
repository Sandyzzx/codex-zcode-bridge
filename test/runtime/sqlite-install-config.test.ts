import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadInstallAuthoritySelection,
  prepareFreshSqliteStateDirectory,
  prepareFreshSqliteStateDirectoryForTest,
} from "../../src/runtime/sqlite-install-config.js";

const fixtureRoot = path.join(process.cwd(), ".run", "wp6-fresh-sqlite-20261026", `config-tests-${randomUUID()}`);
let failed = false;

before(() => { mkdirSync(fixtureRoot, { recursive: true }); });
after(() => { if (!failed) rmSync(fixtureRoot, { recursive: true, force: true }); });

function checkedTest(name: string, body: () => void): void {
  test(name, () => {
    try { body(); }
    catch (error) { failed = true; throw error; }
  });
}

function fixture(name: string) {
  const root = path.join(fixtureRoot, name);
  const settingsDirectory = path.join(root, "settings");
  mkdirSync(settingsDirectory, { recursive: true });
  return { root, settingsDirectory, host: { name: "sqlite-install-test", settingsDirectory } };
}

function writeAuthority(settingsDirectory: string, value: unknown): string {
  const file = path.join(settingsDirectory, "authority.json");
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

checkedTest("missing authority config preserves JSON and never infers from a database", () => {
  const fx = fixture("missing-config");
  mkdirSync(path.join(fx.root, "state"), { recursive: true });
  writeFileSync(path.join(fx.root, "state", "bridge.sqlite"), "unrelated bytes");
  assert.equal(loadInstallAuthoritySelection(fx.host).state, "json");
});

checkedTest("an explicit malformed authority config rejects instead of falling back to JSON", () => {
  const fx = fixture("invalid-config");
  const configPath = writeAuthority(fx.settingsDirectory, { schema_version: 1, authority: "sqlite", data_root: "..\\outside" });
  assert.throws(() => loadInstallAuthoritySelection(fx.host), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error
      && (error as { code: unknown }).code === "authority_config_data_root_invalid");
  assert.ok(readFileSync(configPath, "utf8").includes("sqlite"));
});

checkedTest("valid explicit SQLite config creates and revalidates only the configured default state root", () => {
  const fx = fixture("default-root");
  writeAuthority(fx.settingsDirectory, { schema_version: 1, authority: "sqlite" });
  const localAppData = path.join(fx.root, "local-app-data");
  const selection = loadInstallAuthoritySelection(fx.host);
  assert.equal(selection.state, "sqlite");
  if (selection.state !== "sqlite") return;
  const prepared = prepareFreshSqliteStateDirectoryForTest(selection, { LOCALAPPDATA: localAppData } as NodeJS.ProcessEnv, {
    packageRoot: path.join(fx.root, "synthetic-plugin-install"),
    tempRoot: path.join(fx.root, "synthetic-temp-root"),
  });
  assert.equal(prepared.dataRoot, path.join(localAppData, "CodexZCodeBridge", "state"));
  assert.equal(prepared.databaseFileName, "bridge.sqlite");
});

checkedTest("custom local data root is reused without overwriting an existing database", () => {
  const fx = fixture("custom-root");
  const customRoot = path.join(fx.root, "custom-data");
  writeAuthority(fx.settingsDirectory, { schema_version: 1, authority: "sqlite", data_root: customRoot });
  const selection = loadInstallAuthoritySelection(fx.host);
  assert.equal(selection.state, "sqlite");
  if (selection.state !== "sqlite") return;
  const prepared = prepareFreshSqliteStateDirectoryForTest(selection, {} as NodeJS.ProcessEnv, {
    packageRoot: path.join(fx.root, "synthetic-plugin-install"),
    tempRoot: path.join(fx.root, "synthetic-temp-root"),
  });
  const database = path.join(prepared.dataRoot, prepared.databaseFileName);
  const bytes = Buffer.from("existing synthetic database bytes");
  writeFileSync(database, bytes);
  const reopened = prepareFreshSqliteStateDirectoryForTest(selection, {} as NodeJS.ProcessEnv, {
    packageRoot: path.join(fx.root, "synthetic-plugin-install"),
    tempRoot: path.join(fx.root, "synthetic-temp-root"),
  });
  assert.equal(reopened.dataRoot, prepared.dataRoot);
  assert.deepEqual(readFileSync(database), bytes);
});

checkedTest("SQLite data root inside the OS temporary directory is rejected", () => {
  const fx = fixture("temporary-root");
  const tempRoot = os.tmpdir();
  writeAuthority(fx.settingsDirectory, { schema_version: 1, authority: "sqlite", data_root: tempRoot });
  const selection = loadInstallAuthoritySelection(fx.host);
  assert.equal(selection.state, "sqlite");
  if (selection.state !== "sqlite") return;
  assert.throws(() => prepareFreshSqliteStateDirectory(selection, {} as NodeJS.ProcessEnv), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error
      && (error as { code: unknown }).code === "sqlite_data_root_reserved_location");
});

checkedTest("SQLite state directory cannot coincide with the plugin root", () => {
  const fx = fixture("state-overlaps-plugin");
  writeAuthority(fx.settingsDirectory, { schema_version: 1, authority: "sqlite", data_root: fx.root });
  const selection = loadInstallAuthoritySelection(fx.host);
  assert.equal(selection.state, "sqlite");
  if (selection.state !== "sqlite") return;
  assert.throws(() => prepareFreshSqliteStateDirectoryForTest(selection, {}, {
    packageRoot: path.join(fx.root, "state"), tempRoot: path.join(fx.root, "other-temp"),
  }), (error: unknown) => typeof error === "object" && error !== null && "code" in error
    && (error as { code: unknown }).code === "sqlite_data_root_reserved_location");
  assert.equal(existsSync(path.join(fx.root, "state")), false);
});
