import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { build } from "esbuild";
import { createBridgeServer } from "../src/mcp/server.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { ZCodeModelSettings } from "../src/runtime/model-settings.js";

test("MCP identity and instructions are supplied by the host", async () => {
  const manager = { createTask: async () => { throw new Error("unused"); }, getStatus: async () => { throw new Error("unused"); }, getResult: async () => { throw new Error("unused"); }, cancelTask: async () => { throw new Error("unused"); }, continueTask: async () => { throw new Error("unused"); } };
  const server = createBridgeServer({ taskManager: manager, serverInfo: { name: "dsh-test-bridge", version: "0.0.test" }, instructions: "Host-supplied instructions" });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.equal(client.getServerVersion()?.name, "dsh-test-bridge");
    assert.equal(client.getInstructions(), "Host-supplied instructions");
    assert.equal((await client.listTools()).tools.some((tool) => tool.name === "zcode_progress_probe"), false);
  } finally { await Promise.all([client.close(), server.close()]); }
});

test("a bundled fork can import the core without implicitly starting a Codex server", async () => {
  const fixture = await runtimeFixture();
  try {
    const outfile = path.join(fixture.root, "host.mjs");
    const result = await build({ stdin: { contents: `import { codexHostProfile } from './src/core.ts'; console.log(codexHostProfile().name);`, resolveDir: path.resolve("."), sourcefile: "host.ts" }, outfile, bundle: true, platform: "node", format: "esm", target: "node22.18", logLevel: "silent" });
    assert.equal(result.errors.length, 0);
    const run = spawnSync(process.execPath, [outfile], { env: fixture.env, encoding: "utf8", timeout: 5_000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "codex-zcode-bridge");
    assert.doesNotMatch(run.stderr, /server ready|data root/);
  } finally { await fixture.cleanup(); }
});

test("model-default migration preserves legacy mode and unknown fields without changing legacy files", async () => {
  const fixture = await runtimeFixture();
  try {
    const legacyDirectory = path.join(fixture.root, "legacy");
    await mkdir(legacyDirectory);
    const legacyPath = path.join(legacyDirectory, "runtime-config.json");
    const legacy = JSON.stringify({ ZCODE_BRIDGE_MODE: "build", extension: { keep: true } });
    await writeFile(legacyPath, legacy);
    const settings = new ZCodeModelSettings({}, { homeDir: fixture.home, host: { name: "migrated", settingsDirectory: path.join(fixture.root, "canonical"), legacySettingsDirectories: [legacyDirectory] } });
    await settings.setDefaultModel({ provider_id: "fake", model_id: "fake" });
    const saved = JSON.parse(await readFile(path.join(fixture.root, "canonical", "runtime-config.json"), "utf8"));
    assert.equal(saved.ZCODE_BRIDGE_MODE, "build");
    assert.deepEqual(saved.extension, { keep: true });
    assert.equal(await readFile(legacyPath, "utf8"), legacy);
  } finally { await fixture.cleanup(); }
});

test("Windows startup hook preserves timeout and extension settings and refuses corrupt settings", { skip: process.platform !== "win32" }, async () => {
  const fixture = await runtimeFixture();
  try {
    const check = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$HOME"], { env: fixture.env, encoding: "utf8", windowsHide: true });
    assert.equal(path.resolve(check.stdout.trim()), fixture.home, "refuse to run setup against the real home");
    const configPath = path.join(fixture.home, ".codex", "codex-zcode-bridge", "runtime-config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ ZCODE_BRIDGE_TIMEOUT_MS: "60000", ZCODE_BRIDGE_MODE: "build", extension: { keep: true } }));
    const hook = fileURLToPath(new URL("../../plugins/codex-zcode-bridge/hooks/configure-runtime.ps1", import.meta.url));
    // dist-test/test needs the repository plugin, not a plugin inside dist-test.
    const actualHook = path.resolve(path.dirname(hook), "../../../plugins/codex-zcode-bridge/hooks/configure-runtime.ps1");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", actualHook, "-NodeExecutablePath", process.execPath, "-ZCodeRuntimePath", fixture.config.zcodeEntrypoint, "-BuiltinProviderConfigPath", fixture.config.providerBuiltinConfigFile, "-PersonalProviderConfigPath", fixture.config.providerPersonalConfigFile, "-ZCodeHome", path.join(fixture.home, ".zcode")];
    const setup = spawnSync("powershell.exe", args, { env: fixture.env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.equal(setup.status, 0, setup.stderr);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.ZCODE_BRIDGE_TIMEOUT_MS, "60000");
    assert.deepEqual(saved.extension, { keep: true });
    await writeFile(configPath, "{invalid");
    const bad = spawnSync("powershell.exe", args, { env: fixture.env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.notEqual(bad.status, 0);
    assert.equal(await readFile(configPath, "utf8"), "{invalid");
  } finally { await fixture.cleanup(); }
});
