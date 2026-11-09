import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { captureSpawnGenerationIdentity, createPlatformProbe, terminateProcessTree, verifyProcessTreeClaimantsClean } from "../src/adapters/process-spawn.js";
import { ZCodeModelSettings } from "../src/runtime/model-settings.js";
import { runtimeFixture } from "./runtime-fixture.js";
import { makeTask, makeWorkspace } from "./helpers.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const workerEntry = fileURLToPath(new URL("../src/worker/worker-main.js", import.meta.url));

test("replayed, foreign-session and foreign-turn events cannot complete a run; usage is projected", async () => {
  const fixture = await runtimeFixture({ replay: true });
  try {
    const events: unknown[] = [];
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => fixture.config }, homeDir: fixture.home, host: fixture.host, timeoutMs: 3_000, onEvent: (event) => events.push(event) });
    const handle = await adapter.startTask({ task: makeTask({ workspace: fixture.root }), workspace: makeWorkspace(fixture.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.agentReport?.summary, "Created the requested file");
    assert.deepEqual(result.usage, { totalTokens: 9 });
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
  } finally { await fixture.cleanup(); }
});

test("interaction timeout aborts the resolver rather than leaving a pending polling loop", async () => {
  const fixture = await runtimeFixture({ interaction: true });
  try {
    let ended = false;
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => fixture.config }, homeDir: fixture.home, host: fixture.host, timeoutMs: 3_000,
      resolveInteraction: async (_request, signal) => { while (!signal.aborted) await delay(10); ended = true; return { decision: "deny" }; } });
    const handle = await adapter.startTask({ task: makeTask({ workspace: fixture.root }), workspace: makeWorkspace(fixture.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), /budget/);
    await delay(50);
    assert.equal(ended, true);
  } finally { await fixture.cleanup(); }
});

test("raw runtime failure messages never enter public progress", async () => {
  const fixture = await runtimeFixture({ fail: true });
  try {
    const events: unknown[] = [];
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => fixture.config }, homeDir: fixture.home, host: fixture.host, timeoutMs: 3_000, onEvent: (event) => events.push(event) });
    const handle = await adapter.startTask({ task: makeTask({ workspace: fixture.root }), workspace: makeWorkspace(fixture.root), attempt: 1 });
    await assert.rejects(adapter.getResult(handle), /turn failed/);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RUNTIME_ERROR/);
  } finally { await fixture.cleanup(); }
});

test("host-specific defaults and cache remain isolated, preserve unknown settings, and refresh on provider change", async () => {
  const fixture = await runtimeFixture();
  try {
    const settings = new ZCodeModelSettings(fixture.env, { homeDir: fixture.home, host: fixture.host });
    const configPath = path.join(fixture.host.settingsDirectory, "runtime-config.json");
    await writeFile(configPath, JSON.stringify({ ZCODE_BRIDGE_MODE: "build", ZCODE_BRIDGE_TIMEOUT_MS: "60000", extension: { kept: true } }));
    await settings.setDefaultModel({ provider_id: "fake", model_id: "fake" });
    const other = new ZCodeModelSettings({}, { homeDir: fixture.home, host: { name: "other-host", settingsDirectory: path.join(fixture.home, ".other", "bridge") } });
    assert.equal((await other.getDefaultModel()).configured, false);
    assert.equal((await settings.getDefaultModel()).model?.model_id, "fake");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.extension, { kept: true });
    assert.equal(config.ZCODE_BRIDGE_TIMEOUT_MS, "60000");
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    const initialLog = await readFile(fixture.log, "utf8");
    assert.equal((await settings.listModels(fixture.root)).cache_status, "fresh");
    assert.equal(await readFile(fixture.log, "utf8"), initialLog);
    await writeFile(fixture.config.providerBuiltinConfigFile, JSON.stringify({ config: { revision: 2 } }));
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    const cacheDirectory = path.join(fixture.host.settingsDirectory, "model-catalog");
    const cache = (await readdir(cacheDirectory))[0]!;
    const originalCache = JSON.parse(await readFile(path.join(cacheDirectory, cache), "utf8"));
    originalCache.models[0].private_metadata = { secret: "PRIVATE_CACHE" };
    await writeFile(path.join(cacheDirectory, cache), JSON.stringify(originalCache));
    assert.doesNotMatch(JSON.stringify(await settings.listModels(fixture.root)), /PRIVATE_CACHE|private_metadata/);
    await writeFile(path.join(cacheDirectory, cache), "{broken");
    assert.equal((await settings.listModels(fixture.root)).cache_status, "refreshed");
    await settings.clearDefaultModel();
    assert.equal((await settings.getDefaultModel()).configured, false);
  } finally { await fixture.cleanup(); }
});
