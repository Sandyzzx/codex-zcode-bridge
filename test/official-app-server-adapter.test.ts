import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OfficialAppServerWorkerAdapter } from "../src/adapters/official-app-server-adapter.js";
import type {
  OfficialHostAssets,
  OfficialHostModule,
} from "../src/adapters/official-host-adapter.js";
import type { AgentHandle, TaskPackage, WorkspaceRef, ZCodeRuntimeConfig } from "../src/interfaces.js";
import type { OfficialAppServerRuntimeDescriptor } from "../src/runtime/official-app-server-runtime.js";
import type { ProcessProbe } from "../src/runtime/process-probe.js";
import {
  fakeConfig,
  makeTask,
  makeTempDir,
  removeTempDir,
  validReport,
} from "./helpers.js";

const WINDOWS_X64 = process.platform === "win32" && process.arch === "x64";
const SESSION_ID = "sess_official_installed_11111111-aaaa-4bbb-8ccc-cccccccccccc";
const TURN_ID = "turn_official_installed_1";
const ROOT_FINGERPRINT = "installed-official-root-exact-fingerprint";

interface FakeModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly options: { readonly reasoningLevel: string };
}

class FakeProtocolClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  isDisposed = false;
  readonly #notificationListeners = new Set<(message: unknown) => void>();
  #model: FakeModel = {
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "low" },
  };

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "provider/updateAccountConfig") return {};
    if (method === "session/create" || method === "session/resume") return this.snapshot();
    if (method === "session/setModel") {
      this.#model = params.model as FakeModel;
      return this.snapshot();
    }
    if (method === "session/subscribe" || method === "session/setMode") return {};
    if (method === "session/events") return { events: [] };
    if (method === "session/send") {
      queueMicrotask(() => {
        this.emit({
          method: "session/event",
          params: {
            sessionId: SESSION_ID,
            seq: 1,
            turnId: TURN_ID,
            type: "turn.started",
            payload: { turnId: TURN_ID },
          },
        });
        this.emit({
          method: "session/event",
          params: {
            sessionId: SESSION_ID,
            seq: 2,
            turnId: TURN_ID,
            type: "turn.completed",
            payload: {
              resultType: "success",
              response: JSON.stringify(validReport()),
              usage: {
                inputTokens: 21,
                cachedInputTokens: 3,
                outputTokens: 7,
                totalTokens: 28,
              },
            },
          },
        });
      });
      return {};
    }
    throw new Error(`unexpected request ${method}`);
  }

  async respond(): Promise<void> {}
  async respondError(): Promise<void> {}
  onNotification(listener: (message: unknown) => void) {
    this.#notificationListeners.add(listener);
    return { dispose: () => this.#notificationListeners.delete(listener) };
  }
  onRequest() { return { dispose() {} }; }
  onClose() { return { dispose() {} }; }

  private emit(message: unknown): void {
    for (const listener of this.#notificationListeners) listener(message);
  }

  private snapshot(): Record<string, unknown> {
    return {
      session: { sessionId: SESSION_ID },
      workspace: { workspacePath: process.cwd(), workspaceIdentity: process.cwd() },
      settings: {
        model: {
          current: this.#model,
          available: [{ ref: this.#model, label: "GLM-5.3-Flash" }],
        },
      },
      runtime: { eventSeq: 0 },
    };
  }
}

interface ManagerOptions extends Record<string, unknown> {
  readonly commandResolver: (input: { readonly workspacePath: string }) => Promise<{
    readonly command: string;
    readonly args: string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
  }>;
}

class FakeProcessManager {
  static options: ManagerOptions | null = null;
  static client = new FakeProtocolClient();
  static helperPath: string | undefined;
  static constructCount = 0;
  static disposeCount = 0;
  readonly #client = FakeProcessManager.client;

  constructor(options: Record<string, unknown>) {
    FakeProcessManager.constructCount += 1;
    FakeProcessManager.options = options as ManagerOptions;
  }

  async getClient(): Promise<FakeProtocolClient> {
    FakeProcessManager.helperPath = process.env.ZCODE_RUNTIME_HOST_PATH;
    return this.#client;
  }

  async getRuntimeIdentity() {
    return {
      generation: 1,
      identity: "installed-official-runtime",
      processId: process.pid,
      workspaceKey: process.cwd(),
    };
  }

  isSharedRuntime(): boolean { return false; }
  listManagedProcesses(): Array<{ pid: number; workspacePath: string }> { return []; }
  async disposeWorkspace(): Promise<void> { FakeProcessManager.disposeCount += 1; }
  async disposeAllAndWait(): Promise<void> { FakeProcessManager.disposeCount += 1; }
  onRuntimeRestarted() { return { dispose() {} }; }
  onRuntimeExited() { return { dispose() {} }; }
}

class FakeOfficialProtocolClient {}

test("installed official adapter selects the installed bundle and preserves the official protocol lifecycle", {
  skip: !WINDOWS_X64,
  timeout: 30_000,
}, async () => {
  const root = await makeTempDir("official-app-server-adapter-");
  try {
    const builtinConfig = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
    await mkdir(path.dirname(builtinConfig), { recursive: true });
    await writeFile(builtinConfig, JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [{
            providerId: "account:bigmodel-individual-coding-plan",
            config: {
              builtinModelIds: ["GLM-5.3-Flash"],
              access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" },
            },
          }],
        },
      },
    }), "utf8");
    const personalConfig = path.join(root, ".zcode", "v2", "provider_config.json");
    await mkdir(path.dirname(personalConfig), { recursive: true });
    await writeFile(personalConfig, JSON.stringify({
      config: { providerConfigRules: { providerRules: [] } },
    }), "utf8");
    const bundle = path.join(root, "resources", "glm", "zcode.cjs");
    const runtimeHost = path.join(root, "resources", "tools", "runtime-host", "zcode-runtime-host.exe");
    const config: ZCodeRuntimeConfig = fakeConfig({
      nodeExecutable: process.execPath,
      zcodeEntrypoint: bundle,
      providerBuiltinConfigFile: builtinConfig,
      providerPersonalConfigFile: personalConfig,
      zcodeDataRoot: path.join(root, ".zcode"),
      dataRoot: root,
    });
    const descriptor: OfficialAppServerRuntimeDescriptor = {
      status: "OFFICIAL_RUNTIME_VERIFIED",
      discount_capability: "OFFICIAL_DISCOUNT_VERIFIED",
      reason: null,
      install_dir: root,
      install_source: "ZCODE_WINDOWS_APP_INSTALL_DIR",
      desktop_version: "3.18.2.10443",
      bundle_path: bundle,
      bundle_bytes: 15_675_386,
      bundle_sha256: "a".repeat(64),
      builtin_provider_config_path: builtinConfig,
      builtin_provider_config_bytes: 1,
      builtin_provider_config_sha256: "b".repeat(64),
      runtime_host_path: runtimeHost,
      runtime_host_bytes: 1,
      runtime_host_sha256: "c".repeat(64),
      node_executable: process.execPath,
      node_version: "24.16.0",
      node_compatible: true,
      manifest: null,
    };
    const hostAssets: OfficialHostAssets = {
      root,
      hostModulePath: path.join(root, "official-host-runtime.mjs"),
      appServerEntryPath: bundle,
      builtinProviderConfigPath: builtinConfig,
      runtimeHostPath: runtimeHost,
      manifestDigest: "d".repeat(64),
    };
    const events: Array<{ type: string; details?: Record<string, unknown> }> = [];
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
        fingerprint: ROOT_FINGERPRINT,
        fingerprint_precision: "exact",
        identity_version: 1,
        platform: process.platform,
        captured_at: new Date().toISOString(),
      }),
      probe: async () => [],
    };
    const adapter = new OfficialAppServerWorkerAdapter({
      officialRuntimeResolver: {
        inspect: async () => descriptor,
        resolve: async () => config,
      },
      testOnlyOfficialHostAssets: hostAssets,
      testOnlyOfficialHostModule: {
        ZCODE_PRODUCT_VERSION: "3.18.2",
        ZCodeAgentProcessManager: FakeProcessManager as never,
        ZCodeProtocolClient: FakeOfficialProtocolClient as never,
      } satisfies OfficialHostModule,
      childEnvBase: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      turnBindingCompatMs: 25,
      replayIdleMs: 60_000,
      probe,
      verifyTreeClean: async (targets) => ({
        clean: true,
        livePids: [],
        observedPids: targets.map((target) => target.pid),
      }),
      onEvent: (event) => events.push(event),
    });
    const task: TaskPackage = makeTask({
      task_id: "official_installed_adapter",
      workspace: root,
      model: {
        provider_id: "account:bigmodel-individual-coding-plan",
        model_id: "GLM-5.3-Flash",
        reasoning_level: "low",
      },
    });
    const workspace: WorkspaceRef = { requestedPath: root, canonicalPath: root, mode: "direct" };
    const handle: AgentHandle = await adapter.startTask({ task, workspace, attempt: 1 });
    const outcome = await adapter.getResult(handle);

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.cleanupVerified, true);
    assert.equal(outcome.sessionId, SESSION_ID);
    assert.equal(outcome.modelProfile?.model_id, "GLM-5.3-Flash");
    assert.equal(outcome.modelProfile?.effective_reasoning_level, "low");
    assert.equal(FakeProcessManager.helperPath, runtimeHost);
    const managerOptions = FakeProcessManager.options!;
    const command = await managerOptions.commandResolver({ workspacePath: root });
    assert.equal(command.command, process.execPath);
    assert.equal(command.args[0], bundle);
    assert.deepEqual(command.args.slice(1), ["app-server", "--stdio", "--surface", "desktop"]);
    assert.equal(command.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, builtinConfig);
    assert.equal(command.env.ZCODE_RUNTIME_HOST_PATH, runtimeHost);
    assert.ok(FakeProcessManager.client.requests.some((request) => request.method === "session/create"));
    assert.ok(FakeProcessManager.client.requests.some((request) => request.method === "session/subscribe"));
    assert.ok(FakeProcessManager.client.requests.some((request) => request.method === "session/send"));
    assert.equal(FakeProcessManager.disposeCount, 2);
    assert.ok(events.some((event) =>
      event.type === "official_runtime_verified"
      && event.details?.bundle_sha256 === descriptor.bundle_sha256
      && event.details?.discount_capability === "OFFICIAL_DISCOUNT_VERIFIED"));

    const managerCount = FakeProcessManager.constructCount;
    const unverifiedEvents: Array<{ type: string; details?: Record<string, unknown> }> = [];
    const unverifiedAdapter = new OfficialAppServerWorkerAdapter({
      officialRuntimeResolver: {
        inspect: async () => ({
          ...descriptor,
          status: "OFFICIAL_RUNTIME_UNVERIFIED",
          discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
          reason: "synthetic unknown bundle",
        }),
        resolve: async () => config,
      },
      testOnlyOfficialHostAssets: hostAssets,
      testOnlyOfficialHostModule: {
        ZCODE_PRODUCT_VERSION: "3.18.2",
        ZCodeAgentProcessManager: FakeProcessManager as never,
        ZCodeProtocolClient: FakeOfficialProtocolClient as never,
      },
      childEnvBase: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      probe,
      verifyTreeClean: async () => ({ clean: true, livePids: [], observedPids: [] }),
      onEvent: (event) => unverifiedEvents.push(event),
    });
    const unverifiedHandle = await unverifiedAdapter.startTask({ task, workspace, attempt: 1 });
    await assert.rejects(
      unverifiedAdapter.getResult(unverifiedHandle),
      /OFFICIAL_RUNTIME_UNVERIFIED: synthetic unknown bundle/u,
    );
    assert.equal(FakeProcessManager.constructCount, managerCount, "unknown installed runtimes must not construct or start the official process manager");
    assert.ok(unverifiedEvents.some((event) =>
      event.type === "official_runtime_unverified"
      && event.details?.discount_capability === "OFFICIAL_DISCOUNT_NOT_VERIFIED"));
  } finally {
    await removeTempDir(root);
  }
});
