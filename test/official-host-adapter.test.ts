import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ZCodeAppServerAdapter,
  type AdapterCloseDiagnostic,
  type AppServerCloseResult,
  type ExternalHostClientFactoryContext,
  type ExternalHostClientHandle,
} from "../src/adapters/zcode-app-server-adapter.js";
import {
  OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES,
  OfficialHostAdapter,
  createOfficialHostClientFactory,
  loadOfficialHostProductVersion,
  verifyOfficialHostAssets,
  type OfficialHostAssets,
  type OfficialHostModule,
} from "../src/adapters/official-host-adapter.js";
import type { BrowserBackendDescriptor } from "../src/browser/backend.js";
import type { BrowserControlPort } from "../src/browser/contracts.js";
import type { BrowserCommandResult } from "../src/browser/result.js";
import type { AgentHandle, TaskPackage, WorkspaceRef, ZCodeRuntimeConfig } from "../src/interfaces.js";
import { BridgeError } from "../src/runtime/errors.js";
import type { ProcessProbe } from "../src/runtime/process-probe.js";
import { readOfficialCliVersion } from "../src/runtime/start-plan-production-auth.js";
import { fakeConfig, makeTask, makeTempDir, removeTempDir, validReport } from "./helpers.js";

const SESSION_ID = "sess_official_11111111-aaaa-4bbb-8ccc-cccccccccccc";
const TURN_ID = "turn_official_1";
const ROOT_PID = 42_424;
const ROOT_FINGERPRINT = "official-root-exact-fingerprint";
const WORKSPACE = path.join(process.cwd(), ".run", "official-host-workspace");
const OFFICIAL_HOST_SUPPORTED = process.platform === "win32" && process.arch === "x64";

type EventSink = Array<{ type: string; summary: string; details?: Record<string, unknown> }>;
type Reply = Record<string, unknown>;

function cleanTreeScan(overrides: Partial<NonNullable<AppServerCloseResult["recordedTreeScan"]>> = {}) {
  return {
    rootPid: ROOT_PID,
    rootFingerprint: ROOT_FINGERPRINT,
    evidenceDigest: "a".repeat(64),
    observedMemberCount: 1,
    ...overrides,
  };
}

function cleanClose(overrides: Partial<AppServerCloseResult> = {}): AppServerCloseResult {
  return {
    owner: "official_host",
    receipt: null,
    recordedTreeScan: cleanTreeScan(),
    close: {
      status: "resolved",
      stage: "official_manager_dispose",
      managerProcessCountAfter: 0,
      treeScanStatus: "verified",
    },
    ...overrides,
  };
}

function rejectedClose(
  treeScanStatus: AdapterCloseDiagnostic["treeScanStatus"],
  recordedTreeScan?: NonNullable<AppServerCloseResult["recordedTreeScan"]>,
): AppServerCloseResult {
  return {
    owner: "official_host",
    receipt: null,
    ...(recordedTreeScan ? { recordedTreeScan } : {}),
    error: new Error("official manager dispose failed"),
    close: {
      status: "rejected",
      stage: "official_manager_workspace_dispose",
      errorName: "Error",
      errorMessage: "official manager dispose failed",
      managerProcessCountAfter: 0,
      treeScanStatus,
    },
  };
}

class FakeExternalHost implements ExternalHostClientHandle {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly responses: Reply[] = [];
  readonly emitted: Array<Record<string, unknown>> = [];
  readonly workspace: WorkspaceRef = { requestedPath: WORKSPACE, canonicalPath: WORKSPACE, mode: "direct" };
  readonly child = {
    pid: ROOT_PID,
    get exitCode(): number | null { return exitState.code; },
    get signalCode(): NodeJS.Signals | null { return exitState.signal; },
  };
  readonly runtimeRootIdentity = {
    pid: ROOT_PID,
    fingerprint: ROOT_FINGERPRINT,
    generation: 1,
  };
  readonly closeResult: AppServerCloseResult;
  onSend: (() => void) | null = null;
  resumeSessionId: string | null = SESSION_ID;
  model = {
    providerId: "provider-default",
    modelId: "model-default",
    options: { reasoningLevel: "high" },
  };
  closeCount = 0;
  readonly #notificationListeners = new Set<(message: unknown) => void>();
  readonly #requestListeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(event: unknown) => void>();
  readonly #restartListeners = new Set<(event: unknown) => void>();
  readonly #replyHandlers = new Map<string | number, (message: Record<string, unknown>) => void>();

  constructor(options: { readonly closeResult?: AppServerCloseResult } = {}) {
    this.closeResult = options.closeResult ?? cleanClose();
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "session/create" || method === "session/resume") {
      return this.snapshot();
    }
    if (method === "session/setModel") {
      this.model = params.model as typeof this.model;
      return this.snapshot();
    }
    if (method === "session/subscribe" || method === "session/events" || method === "session/setMode") {
      return method === "session/events" ? { events: [] } : {};
    }
    if (method === "session/send") {
      setTimeout(() => this.onSend?.(), 0);
      return {};
    }
    if (method === "provider/updateAccountConfig") return {};
    throw new Error(`unexpected official host request ${method}`);
  }

  async respond(message: Record<string, unknown>): Promise<void> {
    this.responses.push(message);
    const id = message.id;
    if (typeof id === "string" || typeof id === "number") this.#replyHandlers.get(id)?.(message);
  }

  replayEvents(events: unknown[]): void {
    for (const event of events) this.emitNotification({ method: "session/event", params: event });
  }

  prewarmCleanup(): void {}

  async close(): Promise<AppServerCloseResult> {
    this.closeCount += 1;
    return this.closeResult;
  }

  get stderr(): string { return ""; }

  onNotification(listener: (message: unknown) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onRequest(listener: (message: unknown) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  onClose(listener: (event: unknown) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onRuntimeRestarted(listener: (event: unknown) => void): () => void {
    this.#restartListeners.add(listener);
    return () => this.#restartListeners.delete(listener);
  }

  emitEvent(type: string, payload: Record<string, unknown>, options: {
    readonly seq?: number;
    readonly turnId?: string | null;
    readonly sessionId?: string;
  } = {}): void {
    const params = {
      sessionId: options.sessionId ?? SESSION_ID,
      seq: options.seq ?? 1,
      ...(options.turnId === null ? {} : { turnId: options.turnId ?? TURN_ID }),
      type,
      payload,
    };
    this.emitNotification({ method: "session/event", params });
  }

  emitRequest(message: Record<string, unknown>, handler?: (reply: Record<string, unknown>) => void): void {
    this.emitted.push(message);
    const id = message.id;
    if (handler && (typeof id === "string" || typeof id === "number")) this.#replyHandlers.set(id, handler);
    for (const listener of this.#requestListeners) listener(message);
  }

  emitNotification(message: Record<string, unknown>): void {
    this.emitted.push(message);
    for (const listener of this.#notificationListeners) listener(message);
  }

  emitRuntimeRestarted(event: Record<string, unknown>): void {
    for (const listener of this.#restartListeners) listener(event);
  }

  emitClose(event: Record<string, unknown>): void {
    exitState = {
      code: typeof event.exitCode === "number" ? event.exitCode : null,
      signal: typeof event.signal === "string" ? event.signal as NodeJS.Signals : null,
    };
    for (const listener of this.#closeListeners) listener(event);
  }

  startTurn(onStarted?: () => void): void {
    this.emitEvent("turn.started", { turnId: TURN_ID }, { seq: 1 });
    onStarted?.();
  }

  complete(options: {
    readonly resultType?: string | null;
    readonly usage?: Record<string, unknown>;
    readonly seq?: number;
    readonly turnId?: string;
  } = {}): void {
    this.emitEvent("turn.completed", {
      response: JSON.stringify(validReport()),
      usage: options.usage ?? {
        inputTokens: 11,
        outputTokens: 4,
        totalTokens: 15,
        cachedInputTokens: 3,
        reasoningTokens: 2,
      },
      ...(options.resultType === null ? {} : { resultType: options.resultType ?? "success" }),
    }, { seq: options.seq ?? 2, ...(options.turnId ? { turnId: options.turnId } : {}) });
  }

  snapshot(): Record<string, unknown> {
    return {
      session: { sessionId: this.resumeSessionId },
      settings: {
        model: {
          current: this.model,
          available: [{ ref: this.model, label: "Official Host Model" }],
        },
      },
      runtime: { eventSeq: 0 },
    };
  }
}

let exitState: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };

function makeAdapter(
  host: FakeExternalHost,
  overrides: Partial<ConstructorParameters<typeof ZCodeAppServerAdapter>[0]> & {
    readonly onFactory?: (context: ExternalHostClientFactoryContext) => void;
  } = {},
): ZCodeAppServerAdapter {
  const { onFactory, ...adapterOverrides } = overrides;
  return new ZCodeAppServerAdapter({
    resolver: { resolve: async () => fakeConfig() },
    childEnvBase: { PATH: process.env.PATH },
    timeoutMs: 2_000,
    turnBindingCompatMs: 25,
    replayIdleMs: 60_000,
    ...adapterOverrides,
    externalHostClientFactory: (context) => {
      onFactory?.(context);
      return host;
    },
  });
}

function taskWithModel(model?: TaskPackage["model"]): TaskPackage {
  return makeTask({
    task_id: `official_host_${Math.random().toString(16).slice(2)}`,
    workspace: WORKSPACE,
    ...(model ? { model } : {}),
  });
}

async function runToResult(
  host: FakeExternalHost,
  options: {
    readonly task?: TaskPackage;
    readonly adapter?: Partial<ConstructorParameters<typeof ZCodeAppServerAdapter>[0]>;
    readonly continueFrom?: string;
  } = {},
) {
  const adapter = makeAdapter(host, options.adapter);
  const task = options.task ?? taskWithModel();
  const workspace: WorkspaceRef = { requestedPath: WORKSPACE, canonicalPath: WORKSPACE, mode: "direct" };
  const handle = options.continueFrom
    ? await adapter.continueTask({
        task,
        workspace,
        attempt: 2,
        feedback: "Continue",
        additionalRequirements: [],
        previousSessionId: options.continueFrom,
        previousResult: null,
      })
    : await adapter.startTask({ task, workspace, attempt: 1 });
  return { adapter, handle, outcome: await adapter.getResult(handle) };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("official protocol path creates, subscribes before one send, and maps usage/model/reasoning", async () => {
  exitState = { code: null, signal: null };
  const host = new FakeExternalHost();
  host.onSend = () => {
    host.startTurn();
    host.complete();
  };
  const { outcome } = await runToResult(host, {
    task: taskWithModel({
      provider_id: "provider-default",
      model_id: "model-default",
    }),
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, SESSION_ID);
  assert.equal(outcome.cleanupVerified, true);
  assert.equal(outcome.usage?.totalTokens, 15);
  assert.equal(outcome.modelProfile?.provider_id, "provider-default");
  assert.equal(outcome.modelProfile?.model_id, "model-default");
  assert.equal(outcome.modelProfile?.effective_reasoning_level, "high");
  const methods = host.requests.map((request) => request.method);
  assert.equal(methods.filter((method) => method === "session/send").length, 1);
  assert.ok(methods.indexOf("session/subscribe") < methods.indexOf("session/send"));
  assert.equal(methods.includes("session/resume"), false);
  assert.equal(host.closeCount, 1);
});

test("strict resume requires an exact runtime-returned session id and sends nothing on mismatch", async () => {
  for (const returned of [null, "sess_other"] as const) {
    exitState = { code: null, signal: null };
    const host = new FakeExternalHost();
    host.resumeSessionId = returned;
    const adapter = makeAdapter(host);
    const task = taskWithModel();
    const handle = await adapter.continueTask({
      task,
      workspace: { requestedPath: WORKSPACE, canonicalPath: WORKSPACE, mode: "direct" },
      attempt: 2,
      feedback: "Continue",
      additionalRequirements: [],
      previousSessionId: SESSION_ID,
      previousResult: null,
    });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => {
      assert.equal(error instanceof BridgeError, true);
      assert.match(String((error as Error).message), /resume snapshot|resume session mismatch|session\/sessionId/iu);
      return true;
    });
    assert.equal(host.requests.some((request) => request.method === "session/send"), false);
    assert.equal(host.requests.some((request) => request.method === "session/create"), false);
  }
});

test("strict resume uses setMode and then the same subscribe-before-send protocol", async () => {
  exitState = { code: null, signal: null };
  const host = new FakeExternalHost();
  host.onSend = () => {
    host.startTurn();
    host.complete();
  };
  const { outcome } = await runToResult(host, { continueFrom: SESSION_ID });
  assert.equal(outcome.exitCode, 0);
  const methods = host.requests.map((request) => request.method);
  assert.ok(methods.indexOf("session/resume") < methods.indexOf("session/setMode"));
  assert.ok(methods.indexOf("session/subscribe") < methods.indexOf("session/send"));
  assert.equal(methods.filter((method) => method === "session/send").length, 1);
});

test("unknown or missing terminal result types fail closed and duplicate/foreign terminals stay inert", async () => {
  for (const resultType of [null, "mystery"] as const) {
    exitState = { code: null, signal: null };
    const host = new FakeExternalHost();
    host.onSend = () => {
      host.startTurn();
      host.emitEvent("turn.completed", {
        response: JSON.stringify(validReport()),
        usage: { totalTokens: 1 },
        resultType: "success",
      }, { seq: 2, turnId: "foreign-turn" });
      host.complete({ resultType, seq: 3 });
      host.complete({ resultType: "success", seq: 4 });
    };
    const { outcome } = await runToResult(host);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.errorCode, "unknown_turn_terminal");
    assert.equal(host.requests.filter((request) => request.method === "session/send").length, 1);
  }
});

test("cancellation and timeout close once without resending session/send", async () => {
  exitState = { code: null, signal: null };
  const cancelledHost = new FakeExternalHost();
  cancelledHost.onSend = () => cancelledHost.startTurn();
  const cancelledAdapter = makeAdapter(cancelledHost);
  const cancelHandle = await cancelledAdapter.startTask({
    task: taskWithModel(),
    workspace: cancelledHost.workspace,
    attempt: 1,
  });
  await waitFor(() => cancelledHost.requests.some((request) => request.method === "session/send"), "initial send");
  await cancelledAdapter.cancelTask(cancelHandle);
  await assert.rejects(cancelledAdapter.getResult(cancelHandle), (error: unknown) =>
    error instanceof BridgeError && error.code === "cancelled");
  assert.equal(cancelledHost.requests.filter((request) => request.method === "session/send").length, 1);
  assert.equal(cancelledHost.closeCount, 1);

  exitState = { code: null, signal: null };
  const timedOutHost = new FakeExternalHost();
  timedOutHost.onSend = () => timedOutHost.startTurn();
  const timedOutAdapter = makeAdapter(timedOutHost, { timeoutMs: 30 });
  const timeoutHandle = await timedOutAdapter.startTask({
    task: taskWithModel(),
    workspace: timedOutHost.workspace,
    attempt: 1,
  });
  await assert.rejects(timedOutAdapter.getResult(timeoutHandle), (error: unknown) =>
    error instanceof BridgeError && error.code === "timeout");
  assert.equal(timedOutHost.requests.filter((request) => request.method === "session/send").length, 1);
  assert.equal(timedOutHost.closeCount, 1);
});

test("runtime close or generation change terminates the attempt and never resends", async () => {
  for (const kind of ["close", "restart"] as const) {
    exitState = { code: null, signal: null };
    const host = new FakeExternalHost();
    host.onSend = () => {
      host.startTurn();
      if (kind === "close") host.emitClose({ exitCode: 17, signal: null });
      else host.emitRuntimeRestarted({ reason: "replacement_generation" });
    };
    const { adapter, handle } = await runToResultSetup(host);
    await assert.rejects(adapter.getResult(handle), (error: unknown) =>
      error instanceof BridgeError && error.code === "zcode_nonzero_exit");
    assert.equal(host.requests.filter((request) => request.method === "session/send").length, 1);
    assert.equal(host.closeCount, 1);
  }
});

async function runToResultSetup(host: FakeExternalHost) {
  const adapter = makeAdapter(host);
  const handle = await adapter.startTask({
    task: taskWithModel(),
    workspace: host.workspace,
    attempt: 1,
  });
  await waitFor(() => host.requests.some((request) => request.method === "session/send"), "initial send");
  return { adapter, handle };
}

class FakeBrowserBackend implements BrowserControlPort {
  readonly descriptor: BrowserBackendDescriptor = {
    id: "cdp:official-host-test",
    generation: 3,
    type: "cdp",
    name: "Official Host Test Browser",
    capabilities: { browser: [], tab: [] },
    metadata: { provider: "codex-zcode-bridge", launchMode: "managed", headless: "true" },
  };
  closed = false;
  async list(): Promise<BrowserBackendDescriptor[]> {
    return [this.descriptor];
  }
  async execute(input: { command: { method: string } }): Promise<BrowserCommandResult> {
    return input.command.method === "newTab"
      ? {
          ok: true,
          tab: {
            tabId: "tab:official",
            url: "about:blank",
            title: "",
            viewport: { width: 800, height: 600 },
            lifecycle: "active",
          },
          meta: {
            browserUse: true,
            backendType: "cdp",
            browserId: this.descriptor.id,
            browserGeneration: this.descriptor.generation,
            openTabIds: ["tab:official"],
            tabId: "tab:official",
            lifecycle: "active",
          },
          elapsedMs: 1,
        }
      : { ok: true, elapsedMs: 1 };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

test("runtime preferences, permissions, user input, provider headers, and browser reverse RPCs stay session-scoped", async () => {
  exitState = { code: null, signal: null };
  const host = new FakeExternalHost();
  const backend = new FakeBrowserBackend();
  let interactionCalls = 0;
  host.onSend = () => {
    host.startTurn();
    host.emitRequest({ id: "prefs", method: "session/requestRuntimePreferences", params: {} }, () => {
      host.emitRequest({
        id: "permission",
        method: "interaction/requestPermission",
        params: {
          requestId: "permission-1",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          toolName: "Bash",
          input: { command: "npm test" },
          options: [{ kind: "allow_once" }, { kind: "deny" }],
        },
      }, () => {
        host.emitRequest({
          id: "user-input",
          method: "interaction/requestUserInput",
          params: {
            requestId: "question-1",
            sessionId: SESSION_ID,
            turnId: TURN_ID,
            questions: [{ id: "q1", header: "Continue", question: "Continue?", options: [] }],
          },
        }, () => {
          host.emitRequest({
            id: "provider-headers",
            method: "interaction/requestProviderRuntimeHeaders",
            params: { sessionId: SESSION_ID, turnId: TURN_ID, providerId: "provider-default" },
          }, () => {
            host.emitRequest({
              id: "browser-list",
              method: "interaction/browserList",
              params: {
                requestId: "browser-list-1",
                sessionId: SESSION_ID,
                turnId: TURN_ID,
                workspaceKey: WORKSPACE,
                workspacePath: WORKSPACE,
              },
            }, () => {
              host.emitRequest({
                id: "browser-exec",
                method: "interaction/browserExecute",
                params: {
                  requestId: "browser-exec-1",
                  sessionId: SESSION_ID,
                  turnId: TURN_ID,
                  workspaceKey: WORKSPACE,
                  workspacePath: WORKSPACE,
                  browserId: backend.descriptor.id,
                  browserGeneration: backend.descriptor.generation,
                  command: { method: "newTab" },
                },
              }, () => host.complete());
            });
          });
        });
      });
    });
  };
  const { outcome } = await runToResult(host, {
    adapter: {
      browser: { mode: "headless", backendFactory: async () => backend },
      resolveInteraction: async (request) => {
        interactionCalls += 1;
        return request.method === "interaction/requestPermission"
          ? { decision: "allow_once" }
          : { customResponse: "continue" };
      },
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(interactionCalls, 2);
  assert.equal(backend.closed, true);
  const byId = new Map(host.responses.map((message) => [String(message.id), message]));
  assert.deepEqual((byId.get("prefs")?.result as Record<string, unknown>).nativeSearchEnhancementsEnabled, false);
  assert.deepEqual((byId.get("permission")?.result as Record<string, unknown>).decision, "allow_once");
  assert.deepEqual((byId.get("user-input")?.result as Record<string, unknown>).customResponse, "continue");
  assert.equal((byId.get("provider-headers")?.result as Record<string, unknown>).headersApplied, false);
  assert.equal(((byId.get("browser-list")?.result as { browsers?: unknown[] }).browsers ?? []).length, 1);
  assert.equal((byId.get("browser-exec")?.result as { ok?: boolean }).ok, true);
});

test("private Start Plan auth rejects a foreign turn and injects the secret only into the exact accepted turn", async () => {
  exitState = { code: null, signal: null };
  const root = await makeTempDir("official-host-start-plan");
  try {
    const builtin = path.join(root, "builtin.json");
    const personal = path.join(root, "provider_config.json");
    await writeFile(builtin, JSON.stringify({
      revision: 1,
      config: { providerConfigRules: { providerRules: [{
        providerId: "account:bigmodel-start-plan",
        config: {
          builtinModelIds: ["GLM-5.3-Flash"],
          access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" },
        },
      }] } },
    }), "utf8");
    await writeFile(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }), "utf8");
    const host = new FakeExternalHost();
    host.model = {
      providerId: "account:bigmodel-start-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "high" },
    };
    host.onSend = () => {
      host.startTurn();
      host.emitRequest({
        id: "foreign-auth",
        method: "interaction/requestProviderRuntimeHeaders",
        params: {
          sessionId: SESSION_ID,
          turnId: "foreign-turn",
          modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
        },
      }, () => {
        host.emitRequest({
          id: "exact-auth",
          method: "interaction/requestProviderRuntimeHeaders",
          params: {
            sessionId: SESSION_ID,
            turnId: TURN_ID,
            modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
          },
        }, () => host.complete());
      });
    };
    let authCalls = 0;
    const config: ZCodeRuntimeConfig = {
      ...fakeConfig(),
      providerBuiltinConfigFile: builtin,
      providerPersonalConfigFile: personal,
      zcodeDataRoot: path.join(root, ".zcode"),
    };
    const adapter = makeAdapter(host, {
      resolver: { resolve: async () => config },
      homeDir: root,
      startPlanProviderEntitled: true,
      resolveStartPlanRuntimeAuth: async (scope) => {
        authCalls += 1;
        assert.deepEqual(scope, {
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          providerId: "account:bigmodel-start-plan",
          modelId: "GLM-5.3-Flash",
        });
        return { apiKey: "synthetic-private-marker", expiresAt: Date.now() + 10_000, isValid: () => true };
      },
    });
    const handle = await adapter.startTask({
      task: taskWithModel({ provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" }),
      workspace: host.workspace,
      attempt: 1,
    });
    const outcome = await adapter.getResult(handle);
    assert.equal(outcome.exitCode, 0);
    assert.equal(authCalls, 1);
    const byId = new Map(host.responses.map((message) => [String(message.id), message]));
    assert.equal((byId.get("foreign-auth")?.result as Record<string, unknown>).headersApplied, false);
    assert.deepEqual((byId.get("exact-auth")?.result as Record<string, unknown>).requestAuth, {
      apiKey: "synthetic-private-marker",
    });
    assert.equal(JSON.stringify(host.requests).includes("synthetic-private-marker"), false);
    assert.equal(JSON.stringify(host.emitted.filter((message) => message.id !== "exact-auth")).includes("synthetic-private-marker"), false);
  } finally {
    await removeTempDir(root);
  }
});

test("clean recorded-tree scan can verify cleanup while a close failure remains visible", async () => {
  exitState = { code: null, signal: null };
  const host = new FakeExternalHost({
    closeResult: rejectedClose("verified", cleanTreeScan()),
  });
  host.onSend = () => {
    host.startTurn();
    host.complete();
  };
  const { outcome } = await runToResult(host);
  assert.equal(outcome.cleanupVerified, true);
  assert.equal(outcome.adapterCleanup?.close.status, "rejected");
  assert.equal(outcome.adapterCleanup?.close.stage, "official_manager_workspace_dispose");
  assert.equal(outcome.adapterCleanup?.treeScanStatus, "verified");
  assert.equal(outcome.cleanupTreeScan?.rootPid, ROOT_PID);
});

test("missing, live, or incomplete recorded-tree evidence keeps cleanup unverified", async () => {
  for (const scanStatus of ["missing", "live", "incomplete"] as const) {
    exitState = { code: null, signal: null };
    const host = new FakeExternalHost({
      closeResult: rejectedClose(scanStatus === "missing" ? "not_applicable" : scanStatus),
    });
    host.onSend = () => {
      host.startTurn();
      host.complete();
    };
    const { outcome } = await runToResult(host);
    assert.equal(outcome.cleanupVerified, false);
    assert.match(outcome.cleanupError ?? "", /official manager dispose failed/iu);
    assert.equal(outcome.adapterCleanup?.treeScanStatus, scanStatus === "missing" ? "not_applicable" : scanStatus);
  }
});

interface FakeManagerOptions extends Record<string, unknown> {
  readonly useSharedTaskRuntime: (workspace: unknown) => boolean;
  readonly maxFrameBytes: number;
  readonly commandResolver: (input: { workspacePath: string }) => Promise<{
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
}

class FakeProcessManager {
  static lastOptions: FakeManagerOptions | null = null;
  static helperPathSeen: string | undefined;
  static exitListener: ((event: unknown) => void) | null = null;
  static disposeWorkspaceError: Error | null = null;
  static managedCount = 0;
  readonly #client: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    FakeProcessManager.lastOptions = options as FakeManagerOptions;
    this.#client = {
      isDisposed: false,
      request: async () => ({}),
      respond: async () => undefined,
      respondError: async () => undefined,
      onNotification: () => ({ dispose() {} }),
      onRequest: () => ({ dispose() {} }),
      onClose: () => ({ dispose() {} }),
    };
  }
  async getClient(): Promise<Record<string, unknown>> {
    FakeProcessManager.helperPathSeen = process.env.ZCODE_RUNTIME_HOST_PATH;
    return this.#client;
  }
  async getRuntimeIdentity() {
    return { generation: 1, identity: "official-root", processId: ROOT_PID, workspaceKey: WORKSPACE };
  }
  isSharedRuntime(): boolean { return false; }
  listManagedProcesses() {
    return Array.from({ length: FakeProcessManager.managedCount }, () => ({
      pid: ROOT_PID,
      workspacePath: WORKSPACE,
      workspaceIdentity: WORKSPACE,
    }));
  }
  async disposeWorkspace(): Promise<void> {
    if (FakeProcessManager.disposeWorkspaceError) throw FakeProcessManager.disposeWorkspaceError;
    FakeProcessManager.managedCount = 0;
  }
  async disposeAllAndWait(): Promise<void> {
    FakeProcessManager.managedCount = 0;
  }
  onRuntimeExited(listener: (event: unknown) => void) {
    FakeProcessManager.exitListener = listener;
    return { dispose() { FakeProcessManager.exitListener = null; } };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
}

class FakeOfficialProtocolClient {}

function factoryContext(config: ZCodeRuntimeConfig, assets: OfficialHostAssets): ExternalHostClientFactoryContext {
  const probe: ProcessProbe = {
    platform: process.platform,
    identityOf: async (pid) => ({
      pid,
      fingerprint: ROOT_FINGERPRINT,
      fingerprint_precision: "exact",
      identity_version: 1,
      platform: process.platform,
      captured_at: new Date().toISOString(),
    }),
    selfIdentity: async () => ({
      pid: process.pid,
      fingerprint: "self",
      fingerprint_precision: "exact",
      identity_version: 1,
      platform: process.platform,
      captured_at: new Date().toISOString(),
    }),
    probe: async () => [],
  };
  return {
    config,
    workspace: { requestedPath: WORKSPACE, canonicalPath: WORKSPACE, mode: "direct" },
    cwd: WORKSPACE,
    env: {},
    launch: {
      args: ["app-server", "--stdio", "--surface", "desktop"],
      env: { PATH: process.env.PATH ?? "" },
    },
    requestTimeoutMs: 1_000,
    probe,
    verifyTreeClean: async (targets) => ({
      clean: true,
      livePids: [],
      observedPids: targets.map((target) => target.pid),
    }),
  };
}

test("official factory scopes the fixed helper path, pins transport options, maps exitCode, and verifies the close scan", {
  skip: !OFFICIAL_HOST_SUPPORTED,
}, async () => {
  exitState = { code: null, signal: null };
  FakeProcessManager.lastOptions = null;
  FakeProcessManager.helperPathSeen = undefined;
  FakeProcessManager.disposeWorkspaceError = null;
  FakeProcessManager.managedCount = 1;
  const previousHelper = process.env.ZCODE_RUNTIME_HOST_PATH;
  const root = path.join(process.cwd(), ".run", "official-host-assets");
  const assets: OfficialHostAssets = {
    root,
    hostModulePath: path.join(root, "official-host-runtime.mjs"),
    appServerEntryPath: path.join(root, "app-server", "zcode.cjs"),
    builtinProviderConfigPath: path.join(root, "app-server", "provider", "zcode-builtin.json"),
    runtimeHostPath: path.join(root, "zcode-runtime-host.exe"),
    manifestDigest: "f".repeat(64),
  };
  const config = fakeConfig({
    zcodeEntrypoint: assets.appServerEntryPath,
    providerBuiltinConfigFile: assets.builtinProviderConfigPath,
  });
  const factory = createOfficialHostClientFactory({
    assets: async () => assets,
    moduleSource: {
      ZCODE_PRODUCT_VERSION: "3.18.2",
      ZCodeAgentProcessManager: FakeProcessManager as never,
      ZCodeProtocolClient: FakeOfficialProtocolClient as never,
    },
  });
  try {
    const handle = await factory(factoryContext(config, assets));
    assert.equal(FakeProcessManager.helperPathSeen, assets.runtimeHostPath);
    assert.equal(process.env.ZCODE_RUNTIME_HOST_PATH, previousHelper);
    const managerOptions = FakeProcessManager.lastOptions as unknown as FakeManagerOptions;
    assert.equal(managerOptions.useSharedTaskRuntime({}), false);
    assert.equal(managerOptions.maxFrameBytes, OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES);
    const commandResolver = managerOptions.commandResolver;
    const command = await commandResolver({ workspacePath: WORKSPACE });
    assert.equal(command.command, config.nodeExecutable);
    assert.deepEqual(command.args, [
      assets.appServerEntryPath,
      "app-server",
      "--stdio",
      "--surface",
      "desktop",
    ]);
    assert.equal(command.env.ZCODE_APP_VERSION, "3.18.2");
    assert.equal(command.env.ZCODE_BUILD_COMMIT_ID, undefined);
    assert.equal(command.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, assets.builtinProviderConfigPath);
    assert.equal(command.env.ZCODE_RUNTIME_HOST_PATH, assets.runtimeHostPath);
    FakeProcessManager.exitListener?.({ exitCode: 17, signal: "SIGTERM" });
    assert.equal(handle.child.exitCode, 17);
    assert.equal(handle.child.signalCode, "SIGTERM");
    const close = await handle.close();
    assert.equal(close.recordedTreeScan?.rootPid, ROOT_PID);
    assert.equal(close.recordedTreeScan?.rootFingerprint, ROOT_FINGERPRINT);
    assert.equal(close.close.treeScanStatus, "verified");
  } finally {
    if (previousHelper === undefined) delete process.env.ZCODE_RUNTIME_HOST_PATH;
    else process.env.ZCODE_RUNTIME_HOST_PATH = previousHelper;
  }
});

test("official factory rejects a foreign app-server entrypoint before constructing the manager", {
  skip: !OFFICIAL_HOST_SUPPORTED,
}, async () => {
  let managerConstructed = 0;
  class CountingManager extends FakeProcessManager {
    constructor(options: Record<string, unknown>) {
      managerConstructed += 1;
      super(options);
    }
  }
  const root = path.join(process.cwd(), ".run", "official-host-assets");
  const assets: OfficialHostAssets = {
    root,
    hostModulePath: path.join(root, "official-host-runtime.mjs"),
    appServerEntryPath: path.join(root, "app-server", "zcode.cjs"),
    builtinProviderConfigPath: path.join(root, "app-server", "provider", "zcode-builtin.json"),
    runtimeHostPath: path.join(root, "zcode-runtime-host.exe"),
    manifestDigest: "e".repeat(64),
  };
  const factory = createOfficialHostClientFactory({
    assets: async () => assets,
    moduleSource: {
      ZCodeAgentProcessManager: CountingManager as never,
      ZCodeProtocolClient: FakeOfficialProtocolClient as never,
    },
  });
  await assert.rejects(
    Promise.resolve(factory(factoryContext(fakeConfig({ zcodeEntrypoint: "C:\\foreign\\zcode.cjs" }), assets))),
    (error: unknown) => error instanceof BridgeError && error.code === "provider_config_invalid",
  );
  assert.equal(managerConstructed, 0);
});

test("official factory rejects missing or malformed product versions before constructing the manager", {
  skip: !OFFICIAL_HOST_SUPPORTED,
}, async () => {
  const root = path.join(process.cwd(), ".run", "official-host-assets");
  const assets: OfficialHostAssets = {
    root,
    hostModulePath: path.join(root, "official-host-runtime.mjs"),
    appServerEntryPath: path.join(root, "app-server", "zcode.cjs"),
    builtinProviderConfigPath: path.join(root, "app-server", "provider", "zcode-builtin.json"),
    runtimeHostPath: path.join(root, "zcode-runtime-host.exe"),
    manifestDigest: "c".repeat(64),
  };
  const config = fakeConfig({
    zcodeEntrypoint: assets.appServerEntryPath,
    providerBuiltinConfigFile: assets.builtinProviderConfigPath,
  });

  for (const productVersion of [undefined, "cli-0.17.1"]) {
    let managerConstructed = 0;
    class CountingManager extends FakeProcessManager {
      constructor(options: Record<string, unknown>) {
        managerConstructed += 1;
        super(options);
      }
    }
    const factory = createOfficialHostClientFactory({
      assets: async () => assets,
      moduleSource: {
        ZCODE_PRODUCT_VERSION: productVersion,
        ZCodeAgentProcessManager: CountingManager as never,
        ZCodeProtocolClient: FakeOfficialProtocolClient as never,
      },
    });
    await assert.rejects(
      Promise.resolve(factory(factoryContext(config, assets))),
      (error: unknown) => error instanceof BridgeError && error.code === "provider_config_invalid",
    );
    assert.equal(managerConstructed, 0);
  }
});

test("official factory fails closed outside Windows x64", {
  skip: OFFICIAL_HOST_SUPPORTED,
}, async () => {
  const root = path.join(process.cwd(), ".run", "official-host-assets");
  const assets: OfficialHostAssets = {
    root,
    hostModulePath: path.join(root, "official-host-runtime.mjs"),
    appServerEntryPath: path.join(root, "app-server", "zcode.cjs"),
    builtinProviderConfigPath: path.join(root, "app-server", "provider", "zcode-builtin.json"),
    runtimeHostPath: path.join(root, "zcode-runtime-host.exe"),
    manifestDigest: "d".repeat(64),
  };
  const config = fakeConfig({
    zcodeEntrypoint: assets.appServerEntryPath,
    providerBuiltinConfigFile: assets.builtinProviderConfigPath,
  });
  const factory = createOfficialHostClientFactory({
    assets: async () => assets,
    moduleSource: {
      ZCodeAgentProcessManager: FakeProcessManager as never,
      ZCodeProtocolClient: FakeOfficialProtocolClient as never,
    },
  });

  await assert.rejects(
    Promise.resolve(factory(factoryContext(config, assets))),
    (error: unknown) => error instanceof BridgeError && error.code === "runtime_not_found",
  );
});

test("production asset verification fails closed for absent and invalid shipped trees", async () => {
  const root = await makeTempDir("official-host-invalid-assets");
  try {
    const absentWorker = path.join(root, "absent", "worker-main.mjs");
    await assert.rejects(
      verifyOfficialHostAssets(pathToFileURL(absentWorker)),
      (error: unknown) => error instanceof BridgeError && error.code === "runtime_not_found",
    );

    const invalidWorker = path.join(root, "worker-main.mjs");
    const vendor = path.join(
      root,
      "vendor",
      "official-host",
      "win32-x64-node24.16.0-zcode3.18.2-fec97590",
    );
    await mkdir(path.join(vendor, "app-server", "provider"), { recursive: true });
    await writeFile(invalidWorker, "", "utf8");
    await Promise.all([
      writeFile(path.join(vendor, "official-host-runtime.mjs"), "wrong", "utf8"),
      writeFile(path.join(vendor, "app-server", "zcode.cjs"), "wrong", "utf8"),
      writeFile(path.join(vendor, "app-server", "provider", "zcode-builtin.json"), "wrong", "utf8"),
      writeFile(path.join(vendor, "zcode-runtime-host.exe"), "wrong", "utf8"),
    ]);
    await assert.rejects(
      verifyOfficialHostAssets(pathToFileURL(invalidWorker)),
      (error: unknown) => error instanceof BridgeError && error.code === "provider_config_invalid",
    );
  } finally {
    await removeTempDir(root);
  }
});

test("OfficialHostAdapter is lazy before execution and resolves the test source tree through the Worker-shaped URL", {
  skip: !OFFICIAL_HOST_SUPPORTED,
}, async () => {
  let moduleCalls = 0;
  const workerUrl = pathToFileURL(path.join(
    process.cwd(),
    "plugins",
    "codex-zcode-bridge",
    "worker",
    "worker-main.mjs",
  ));
  const adapter = new OfficialHostAdapter({
    testOnlyWorkerModuleUrl: workerUrl,
    testOnlyOfficialHostModule: async () => {
      moduleCalls += 1;
      throw new Error("module should not be invoked by status");
    },
  });
  const handle: AgentHandle = {
    taskId: "not_started",
    attempt: 1,
    workerPid: process.pid,
    zcodePid: null,
    startedAt: new Date().toISOString(),
  };
  await assert.rejects(adapter.getStatus(handle), /unknown agent handle/u);
  assert.equal(moduleCalls, 0);

  const assets = await verifyOfficialHostAssets(workerUrl);
  assert.equal(path.basename(assets.hostModulePath), "official-host-runtime.mjs");
  assert.equal(assets.manifestDigest.length, 64);
  assert.equal(await loadOfficialHostProductVersion(workerUrl), "3.18.2");
  assert.equal(await readOfficialCliVersion(assets.appServerEntryPath), "0.17.1");
});

test("the shipped host module applies the exact 16 MiB transport frame limit and fails closed above it", {
  skip: !OFFICIAL_HOST_SUPPORTED,
}, async () => {
  const workerUrl = pathToFileURL(path.join(
    process.cwd(),
    "plugins",
    "codex-zcode-bridge",
    "worker",
    "worker-main.mjs",
  ));
  const assets = await verifyOfficialHostAssets(workerUrl);
  const module = await import(pathToFileURL(assets.hostModulePath).href) as unknown as OfficialHostModule & {
    readonly ZCodeStdioTransport: new (
      child: unknown,
      options?: { readonly maxFrameBytes?: number },
    ) => {
      readonly onClose: (listener: (event: { reason?: string }) => void) => { dispose(): void };
    };
  };
  const manager = new module.ZCodeAgentProcessManager({
    maxFrameBytes: OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES,
  });
  assert.equal(
    (manager as unknown as { maxFrameBytes?: number }).maxFrameBytes,
    OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES,
  );

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
    killed: boolean;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 100;
  child.killed = false;
  const transport = new module.ZCodeStdioTransport(child, {
    maxFrameBytes: OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES,
  });
  const closes: Array<{ reason?: string }> = [];
  const listener = transport.onClose((event) => closes.push(event));
  try {
    stdout.write(Buffer.alloc(OFFICIAL_HOST_TRANSPORT_MAX_FRAME_BYTES + 1, 0x20));
    assert.equal(closes.length, 1);
    assert.match(closes[0]!.reason ?? "", /stdout_frame_too_large/u);
  } finally {
    listener.dispose();
    stdout.end();
    stderr.end();
    stdin.end();
  }
});

test("the shipped Host exports and native keyring closure load outside the build workspace", {
  skip: !OFFICIAL_HOST_SUPPORTED,
}, async () => {
  const workerUrl = pathToFileURL(path.join(
    process.cwd(),
    "plugins",
    "codex-zcode-bridge",
    "worker",
    "worker-main.mjs",
  ));
  const assets = await verifyOfficialHostAssets(workerUrl);
  const module = await import(pathToFileURL(assets.hostModulePath).href) as unknown as Record<string, unknown>;
  for (const name of [
    "ZCODE_PRODUCT_VERSION",
    "ZCodeAgentProcessManager",
    "ZCodeProtocolClient",
    "ZCodeStdioTransport",
    "createOAuthProviderRuntimeAuthService",
    "createOfficialStartPlanAuthenticationResolver",
  ]) {
    if (name === "ZCODE_PRODUCT_VERSION") assert.equal(module[name], "3.18.2");
    else assert.equal(typeof module[name], "function", `${name} must be exported`);
  }

  const artifactRequire = createRequire(path.join(assets.root, "app-server", "zcode.cjs"));
  const keyring = artifactRequire(path.join(assets.root, "node_modules", "@napi-rs", "keyring")) as {
    readonly Entry?: unknown;
  };
  assert.equal(typeof keyring.Entry, "function");
  const keyringPackage = JSON.parse(await readFile(
    path.join(assets.root, "node_modules", "@napi-rs", "keyring", "package.json"),
    "utf8",
  )) as { readonly version?: unknown; readonly license?: unknown };
  assert.equal(keyringPackage.version, "2.1.2");
  assert.equal(keyringPackage.license, "MIT");
});
