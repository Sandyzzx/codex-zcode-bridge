// Stdio entry tests: the compiled main.js must speak pure JSON-RPC on stdout,
// keep diagnostics on stderr, start without any ZCode provider configuration,
// and honor ZCODE_BRIDGE_DATA_DIR. Uses real child processes but never starts
// a ZCode worker (only initialize/initialized/tools/list/status-on-unknown-id).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { after, before } from "node:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import test from "node:test";
import { resolveDataRoot, resolveMaxConcurrentWorkers } from "../src/mcp/main.js";

const MAIN_JS = fileURLToPath(new URL("../src/mcp/main.js", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/codex-zcode-bridge/", import.meta.url));
const fixtureRoot = path.join(process.cwd(), ".run", `mcp-stdio-entry-${randomUUID()}`);
const ownedSystemTempRoots: string[] = [];
let failed = false;

before(() => { mkdirSync(fixtureRoot, { recursive: true }); });
after(() => {
  for (const ownedRoot of ownedSystemTempRoots) rmSync(ownedRoot, { recursive: true, force: true });
  if (!failed) rmSync(fixtureRoot, { recursive: true, force: true });
});

function isolatedInstall(name: string, copyPlugin = false) {
  const root = path.join(fixtureRoot, name);
  const userProfile = path.join(root, "user-profile");
  const localAppDataBase = process.env["LOCALAPPDATA"];
  assert.ok(localAppDataBase && path.isAbsolute(localAppDataBase), "test requires an absolute real LOCALAPPDATA base");
  const tempBase = path.join(localAppDataBase, "Temp");
  const systemTemp = mkdtempSync(path.join(tempBase, "zcode-bridge-e2e-"));
  ownedSystemTempRoots.push(systemTemp);
  const realTempBase = realpathSync(tempBase);
  const realSystemTemp = realpathSync(systemTemp);
  const tempRelative = path.relative(realTempBase, realSystemTemp);
  assert.ok(tempRelative !== "" && tempRelative !== ".." && !tempRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(tempRelative), "owned temporary root must remain under LOCALAPPDATA\\Temp");
  assert.equal(lstatSync(systemTemp).isSymbolicLink(), false, "owned temporary root must not be a link");
  const localAppData = path.join(systemTemp, "local-app-data");
  const tempDirectory = path.join(systemTemp, "temp");
  const pluginRoot = path.join(root, "plugin-install");
  const settingsDirectory = path.join(userProfile, ".codex", "codex-zcode-bridge");
  const legacyResult = path.join(settingsDirectory, ".tasks", "old-task", "result.json");
  mkdirSync(path.dirname(legacyResult), { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(tempDirectory, { recursive: true });
  writeFileSync(legacyResult, "old JSON history must remain untouched", "utf8");
  if (copyPlugin) cpSync(PLUGIN_ROOT, pluginRoot, { recursive: true });
  return { root, userProfile, localAppData, tempDirectory, systemTemp, pluginRoot, legacyResult };
}

function isolatedEnvironment(extra: NodeJS.ProcessEnv, profile: ReturnType<typeof isolatedInstall>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    USERPROFILE: profile.userProfile,
    HOME: profile.userProfile,
    LOCALAPPDATA: profile.localAppData,
    TEMP: profile.tempDirectory,
    TMP: profile.tempDirectory,
    TMPDIR: profile.tempDirectory,
  };
  delete env.ZCODE_BRIDGE_DATA_DIR;
  return env;
}

function assertFreshDatabase(dataRoot: string): void {
  const database = new DatabaseSync(path.join(dataRoot, "bridge.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM fresh_install_receipt").get()?.n, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM manager_operations").get()?.n, 1);
    assert.equal(database.prepare("SELECT operation_id FROM manager_operations").get()?.operation_id, "fresh-install-capacity-v1");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM manager_operation_events").get()?.n, 1);
  } finally { database.close(); }
}

const PROTOCOL_MESSAGES = [
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-probe", version: "0.0.0" },
    },
  }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "zcode_status", arguments: { task_id: "ghost" } },
  }),
].join("\n") + "\n";

test("compiled stdio entry speaks pure JSON-RPC on stdout and diagnostics on stderr", { timeout: 30_000 }, () => {
  const profile = isolatedInstall("source-entry");
  const dataRoot = path.join(profile.localAppData, "CodexZCodeBridge", "state");
  try {
    const run = spawnSync(process.execPath, [MAIN_JS], {
      input: PROTOCOL_MESSAGES,
      encoding: "utf8",
      env: isolatedEnvironment({}, profile),
      timeout: 20_000,
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const lines = run.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    assert.ok(lines.length >= 3, `expected protocol responses on stdout, got: ${run.stdout}`);
    const parsed = lines.map((line) => {
      let value: unknown;
      assert.doesNotThrow(() => {
        value = JSON.parse(line);
      }, `stdout contained a non-JSON line: ${line}`);
      return value as { jsonrpc?: string; id?: number; result?: Record<string, unknown> };
    });
    for (const message of parsed) {
      assert.equal(message.jsonrpc, "2.0");
    }

    const initialize = parsed.find((message) => message.id === 1);
    assert.ok(initialize?.result, "initialize must succeed");
    const toolsList = parsed.find((message) => message.id === 2);
    const toolNames = (
      (toolsList?.result?.tools as Array<{ name: string }> | undefined) ?? []
    )
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(toolNames, [
      "zcode_cancel",
      "zcode_clear_default_model",
      "zcode_continue",
      "zcode_default_model",
      "zcode_doctor",
      "zcode_events",
      "zcode_feedback",
      "zcode_interaction_reply",
      "zcode_model_catalog",
      "zcode_result",
      "zcode_set_default_model",
      "zcode_status",
      "zcode_task",
    ]);

    const statusCall = parsed.find((message) => message.id === 3);
    const isError = (
      statusCall?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
    );
    assert.equal(isError?.isError, true, "unknown task must be a tool error, not success");
    assert.match(isError?.content?.[0]?.text ?? "", /TASK_NOT_FOUND/);

    assert.match(run.stderr, /\[bridge\]/, "diagnostics must go to stderr");
    assert.match(run.stderr, /data root/);
    assert.ok(run.stderr.indexOf("SQLITE_INITIALIZING") < run.stderr.indexOf("SQLITE_READY"));
    assert.ok(run.stderr.indexOf("SQLITE_READY") < run.stderr.indexOf("stdio MCP server ready"));
    assert.doesNotMatch(run.stdout, /\[bridge\]/, "stdout must contain protocol messages only");
    assertFreshDatabase(dataRoot);
    assert.equal(readFileSync(profile.legacyResult, "utf8"), "old JSON history must remain untouched");
  } catch (error) { preserveFailedInstall(profile); failed = true; throw error; }
});

test("worker concurrency defaults to eight and rejects out-of-range configuration", () => {
  assert.deepEqual(resolveMaxConcurrentWorkers({}), { maxConcurrentWorkers: 8 });
  assert.deepEqual(resolveMaxConcurrentWorkers({ ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS: "3" }), {
    maxConcurrentWorkers: 3,
  });
  const invalid = resolveMaxConcurrentWorkers({ ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS: "9" });
  assert.equal(invalid.maxConcurrentWorkers, 1);
  assert.match(invalid.warning ?? "", /integer from 1 to 8/);
});

test("marketplace bundle starts through the shipped launcher without repo-local dependencies", { timeout: 30_000 }, () => {
  const profile = isolatedInstall("marketplace-install", true);
  const dataRoot = path.join(profile.localAppData, "CodexZCodeBridge", "state");
  try {
    const run = spawnSync(process.execPath, ["./launch-node24.mjs"], {
      cwd: profile.pluginRoot,
      input: PROTOCOL_MESSAGES,
      encoding: "utf8",
      env: isolatedEnvironment({
        ZCODE_BRIDGE_PLUGIN_MODE: "1",
      }, profile),
      timeout: 20_000,
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const lines = run.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    const messages = lines.map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });
    assert.ok(messages.some((message) => message.id === 1 && message.result), "bundle must initialize over stdio");
    const toolsList = messages.find((message) => message.id === 2)?.result;
    const toolNames = ((toolsList?.["tools"] as Array<{ name: string }> | undefined) ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "zcode_cancel", "zcode_clear_default_model", "zcode_continue", "zcode_default_model", "zcode_doctor", "zcode_events", "zcode_feedback", "zcode_interaction_reply", "zcode_model_catalog", "zcode_result", "zcode_set_default_model", "zcode_status", "zcode_task",
    ]);
    assert.ok(existsSync(path.join(profile.pluginRoot, "worker", "worker-main.mjs")), "detached worker bundle must ship beside the MCP server");
    assert.match(run.stderr, /data root/);
    const provenanceLine = run.stderr.split(/\r?\n/u).find((line) => line.startsWith("[bridge] runtime provenance: "));
    assert.ok(provenanceLine, "the live Bridge bundle reports its runtime provenance on stderr");
    const provenance = JSON.parse(provenanceLine.slice("[bridge] runtime provenance: ".length)) as {
      bridge: { sha256: string | null };
      worker: { sha256: string | null };
    };
    const bridgePath = realpathSync(path.join(profile.pluginRoot, "dist", "bridge.mjs"));
    const workerPath = realpathSync(path.join(profile.pluginRoot, "worker", "worker-main.mjs"));
    const sha256 = (filePath: string) => createHash("sha256").update(readFileSync(filePath)).digest("hex").toUpperCase();
    assert.equal(provenance.bridge.sha256, sha256(bridgePath));
    assert.equal(provenance.worker.sha256, sha256(workerPath));
    assert.equal(provenanceLine.includes(bridgePath), false, "stderr must not expose the Bridge bundle path");
    assert.equal(provenanceLine.includes(workerPath), false, "stderr must not expose the Worker bundle path");
    assertFreshDatabase(dataRoot);
    assert.equal(readFileSync(profile.legacyResult, "utf8"), "old JSON history must remain untouched");
  } catch (error) { preserveFailedInstall(profile); failed = true; throw error; }
});

function preserveFailedInstall(profile: ReturnType<typeof isolatedInstall>): void {
  const destination = path.join(profile.root, "failed-system-temp-evidence");
  if (existsSync(profile.systemTemp)) cpSync(profile.systemTemp, destination, { recursive: true });
}

test("resolveDataRoot honors an absolute override and falls back on invalid input", () => {
  const absolute = path.join(tmpdir(), "bridge-data");
  assert.deepEqual(resolveDataRoot({ ZCODE_BRIDGE_DATA_DIR: absolute }), {
    dataRoot: path.normalize(absolute),
  });

  const relative = resolveDataRoot({ ZCODE_BRIDGE_DATA_DIR: "relative/dir" });
  assert.ok(relative.warning, "a relative override must produce a warning");
  assert.ok(path.isAbsolute(relative.dataRoot));

  const fallback = resolveDataRoot({});
  assert.ok(path.isAbsolute(fallback.dataRoot));
  assert.equal(fallback.warning, undefined);
});
