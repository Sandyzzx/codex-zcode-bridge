import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";
import { makeWorkspace, SESSION_ID, validReport } from "./helpers.js";

const task: TaskPackage = {
  task_id: "model_override_test",
  workspace: "C:\\unused",
  objective: "Return the requested report",
  requirements: [],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: [],
  test_commands: [],
};

async function makeFakeRuntime(
  selectedModel: { providerId: string; modelId: string; options?: { reasoningLevel: string } } = { providerId: "provider-default", modelId: "model-default" },
  includeRequestedModel = true,
  interactionRequest = false,
): Promise<{ root: string; config: ZCodeRuntimeConfig; requestLog: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-app-server-test-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const script = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const sessionId = ${JSON.stringify(SESSION_ID)};
const requestLog = ${JSON.stringify(requestLog)};
let selected = ${JSON.stringify(selectedModel)};
const available = [selected, ${includeRequestedModel ? '{ providerId: "provider-123", modelId: "model-x" }, { providerId: "provider-123", modelId: "reasoning-model" }' : ""}];
const report = ${JSON.stringify(validReport())};
let turnFinished = false;
function finishTurn() {
  if (turnFinished) return;
  turnFinished = true;
  process.stdout.write(JSON.stringify({ method: "session/event", params: {
    seq: 1, type: "turn.completed", payload: {
      response: JSON.stringify(report), usage: { totalTokens: 4 }, resultType: "success"
    }
  }}) + "\n");
}
function snapshot() {
  return {
    session: { sessionId },
    settings: { model: { current: selected, available: available.map((ref) => ({ ref, label: "Test Model" })) } },
    runtime: { eventSeq: 0 },
  };
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "session/create") {
    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\n");
  } else if (message.method === "session/setModel") {
    selected = message.params.model;
    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\n");
  } else if (message.method === "session/subscribe") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  } else if (message.method === "session/send") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    if (${interactionRequest}) {
      for (const rpcId of ["interaction-rpc-1", "interaction-rpc-2"]) {
        process.stdout.write(JSON.stringify({ id: rpcId, method: "interaction/requestPermission", params: {
          requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash",
          reason: "Run a build command", input: { command: "npm run build" },
          options: [{ kind: "allow_once" }, { kind: "deny" }]
        }}) + "\n");
      }
    } else {
      finishTurn();
    }
  } else if (message.id === "interaction-rpc-1" || message.id === "interaction-rpc-2") {
    if (message.result && message.result.decision) finishTurn();
  } else {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } }) + "\n");
  }
});
`;
  await writeFile(entrypoint, script, "utf8");
  return {
    root,
    requestLog,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: path.join(root, "builtin.json"),
      providerPersonalConfigFile: path.join(root, "personal.json"),
      dataRoot: root,
    },
  };
}

test("applies a per-task model override, verifies the selection, and does not persist it as the workspace default", async () => {
  const runtime = await makeFakeRuntime();
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "provider-123", model_id: "model-x" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, SESSION_ID);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const setModel = requests.find((request) => request.method === "session/setModel");
    assert.ok(setModel);
    assert.deepEqual(setModel.params, {
      sessionId: SESSION_ID,
      model: { providerId: "provider-123", modelId: "model-x" },
      persistAsWorkspaceLastUsed: false,
    });
    assert.ok(events.some((event) => event.type === "model_selected" && event.details?.["model_id"] === "model-x"));
    assert.ok(events.some((event) => event.type === "session_ready" && String(event.details?.["selected_model"]).includes("provider-123/model-x")));
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("lets the app-server resolve a requested model omitted from the initial catalog", async () => {
  const runtime = await makeFakeRuntime({ providerId: "provider-default", modelId: "model-default" }, false);
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "account:zai-start-plan", model_id: "GLM-5.3-Flash" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    assert.equal((await adapter.getResult(handle)).exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.some((request) => request.method === "session/setModel"), true);
    assert.equal(requests.some((request) => request.method === "session/send"), true);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("omitting model leaves the ZCode session default untouched", async () => {
  const runtime = await makeFakeRuntime();
  try {
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => runtime.config }, timeoutMs: 10_000, childEnvBase: { PATH: process.env.PATH } });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.some((request) => request.method === "session/setModel"), false);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("starts ZCode runtime without a Bridge-specific execution opt-in", async () => {
  const runtime = await makeFakeRuntime();
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      childEnvBase: { PATH: process.env.PATH, PRIVATE_API_TOKEN: "not-forwarded" },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("passes an explicit reasoning level when selecting a model that requires it", async () => {
  const runtime = await makeFakeRuntime();
  try {
    const adapter = new ZCodeAppServerAdapter({ resolver: { resolve: async () => runtime.config }, timeoutMs: 10_000, childEnvBase: { PATH: process.env.PATH } });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "provider-123", model_id: "reasoning-model", reasoning_level: "high" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    const result = await adapter.getResult(handle);
    assert.equal(result.exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((request) => JSON.parse(request) as Record<string, unknown>);
    const setModel = requests.find((request) => request.method === "session/setModel");
    assert.deepEqual((setModel?.params as Record<string, unknown>)?.["model"], {
      providerId: "provider-123",
      modelId: "reasoning-model",
      options: { reasoningLevel: "high" },
    });
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("keeps the runtime-selected reasoning options when the requested model is already active", async () => {
  const runtime = await makeFakeRuntime({ providerId: "provider-123", modelId: "model-x", options: { reasoningLevel: "high" } });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({
      task: { ...task, model: { provider_id: "provider-123", model_id: "model-x" } },
      workspace: makeWorkspace(runtime.root),
      attempt: 1,
    });
    assert.equal((await adapter.getResult(handle)).exitCode, 0);
    const requests = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((request) => JSON.parse(request) as Record<string, unknown>);
    assert.equal(requests.some((request) => request.method === "session/setModel"), false);
    assert.ok(events.some((event) => event.type === "model_selected" && event.details?.["model_id"] === "model-x"));
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("forwards a permission decision to ZCode and resolves duplicate request IDs once", async () => {
  const runtime = await makeFakeRuntime(undefined, true, true);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const requests: Array<{ request_id: string; method: string }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      resolveInteraction: async (request) => {
        requests.push({ request_id: request.request_id, method: request.method });
        return { decision: "deny", reason: "Not authorized" };
      },
      timeoutMs: 10_000,
      childEnvBase: { PATH: process.env.PATH },
    });
    const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
    assert.equal((await adapter.getResult(handle)).exitCode, 0);
    assert.deepEqual(requests, [{ request_id: "permission-1", method: "interaction/requestPermission" }]);
    assert.equal(events.filter((event) => event.type === "interaction_replied").length, 1);
    const messages = (await readFile(runtime.requestLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const replies = messages.filter((message) => message.id === "interaction-rpc-1" || message.id === "interaction-rpc-2");
    assert.deepEqual(replies, [
      { id: "interaction-rpc-1", result: { decision: "deny", reason: "Not authorized" } },
      { id: "interaction-rpc-2", result: { decision: "deny", reason: "Not authorized" } },
    ]);
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});
