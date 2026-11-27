import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type {
  ExternalHostClientHandle,
  OfficialHostSessionFactory,
  OfficialHostRuntimeAuthServiceFactory,
} from "../src/adapters/official-host-adapter.js";
import { ZCodeModelSettings } from "../src/runtime/model-settings.js";
import { runtimeFixture } from "./runtime-fixture.js";

test("model catalog uses the official Provider Runtime Auth path and never returns the persisted Coding Plan key", async () => {
  const fixture = await runtimeFixture();
  try {
    const codingProvider = "account:bigmodel-individual-coding-plan";
    const startProvider = "account:bigmodel-start-plan";
    await writeFile(fixture.config.providerBuiltinConfigFile, JSON.stringify({
      revision: 3,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: codingProvider,
              config: {
                builtinModelIds: ["GLM-5.3-Flash"],
                access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" },
              },
            },
            {
              providerId: startProvider,
              config: {
                builtinModelIds: ["GLM-5.3-Flash"],
                access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" },
              },
            },
          ],
        },
      },
    }));
    await writeFile(fixture.config.providerPersonalConfigFile, JSON.stringify({
      config: { providerConfigRules: { providerRules: [] } },
      provider: {
        "builtin:bigmodel-coding-plan": {
          enabled: true,
          options: { apiKey: "synthetic-persisted-coding-key" },
        },
      },
    }));

    const replies: Record<string, unknown>[] = [];
    let sessions = 0;
    let authFactoryCalls = 0;
    let authFactoryWorkerUrl: string | URL | undefined;
    const sessionFactory = fakeSessionFactory(fixture.config, replies, () => {
      sessions += 1;
    });
    const authFactory: OfficialHostRuntimeAuthServiceFactory = () => {
      authFactoryCalls += 1;
      return {
        resolveProviderRuntimeRequest: async () => ({
          headersApplied: true,
          requestAuth: { apiKey: "synthetic-official-runtime-auth" },
        }),
      };
    };
    const settings = new ZCodeModelSettings(fixture.env, {
      homeDir: fixture.home,
      host: fixture.host,
      testOnlyOfficialHostSessionFactory: sessionFactory,
      workerModuleUrl: "file:///bridge/worker/worker-main.mjs",
      testOnlyOfficialProviderRuntimeAuthFactoryLoader: async (workerModuleUrl) => {
        authFactoryWorkerUrl = workerModuleUrl;
        return authFactory;
      },
    });

    const catalog = await settings.listModels(fixture.root);
    assert.equal(sessions, 1);
    assert.equal(authFactoryCalls, 1);
    assert.equal(authFactoryWorkerUrl, "file:///bridge/worker/worker-main.mjs");
    assert.equal(catalog.models[0]?.label, "Official auth accepted:yes start:no");
    const codingReply = replies.find((reply) =>
      (reply.result as Record<string, unknown> | undefined)?.requestAuth,
    );
    assert.deepEqual(codingReply?.result, {
      headersApplied: true,
      requestAuth: { apiKey: "synthetic-official-runtime-auth" },
    });
    const startReply = replies.find((reply) =>
      (reply.result as Record<string, unknown> | undefined)?.errorMessage,
    );
    assert.equal((startReply?.result as Record<string, unknown>).headersApplied, false);
    assert.doesNotMatch(JSON.stringify(replies), /synthetic-persisted-coding-key/u);
  } finally {
    await fixture.cleanup();
  }
});

function fakeSessionFactory(
  config: {
    readonly nodeExecutable: string;
    readonly zcodeEntrypoint: string;
    readonly providerBuiltinConfigFile: string;
    readonly providerPersonalConfigFile: string;
    readonly zcodeDataRoot: string;
    readonly dataRoot: string;
  },
  replies: Record<string, unknown>[],
  onSession: () => void,
): OfficialHostSessionFactory {
  const inspect = async () => ({
    status: "OFFICIAL_RUNTIME_VERIFIED" as const,
    discount_capability: "OFFICIAL_DISCOUNT_VERIFIED" as const,
    start_plan_static_compatibility: "OFFLINE_COMPATIBLE" as const,
    reason: null,
    install_dir: path.dirname(config.zcodeEntrypoint),
    install_source: "test",
    desktop_version: "test",
    bundle_path: config.zcodeEntrypoint,
    bundle_bytes: 0,
    bundle_sha256: "a".repeat(64),
    builtin_provider_config_path: config.providerBuiltinConfigFile,
    builtin_provider_config_bytes: 0,
    builtin_provider_config_sha256: "b".repeat(64),
    active_builtin_provider_config_path: config.providerBuiltinConfigFile,
    active_builtin_provider_config_source: "bundled" as const,
    active_builtin_provider_config_revision: null,
    runtime_host_path: config.zcodeEntrypoint,
    runtime_host_bytes: 0,
    runtime_host_sha256: "c".repeat(64),
    node_executable: config.nodeExecutable,
    node_version: "24.16.0",
    node_compatible: true,
    manifest: null,
  });
  return {
    resolver: { resolve: async () => config, inspect },
    inspect,
    async createClient(): Promise<ExternalHostClientHandle> {
      onSession();
      const listeners = new Set<(message: unknown) => void>();
      const waiters = new Map<string, (reply: Record<string, unknown>) => void>();
      const emit = async (id: string, method: string, params: Record<string, unknown>) => {
        const replied = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
        for (const listener of listeners) listener({ id, method, params });
        return replied;
      };
      return {
        child: { pid: undefined, exitCode: null, signalCode: null },
        runtimeRootIdentity: null,
        async request(method) {
          if (method !== "session/create") return {};
          const coding = await emit("coding-auth", "interaction/requestProviderRuntimeHeaders", {
            providerId: "account:bigmodel-individual-coding-plan",
            modelSelection: {
              providerId: "account:bigmodel-individual-coding-plan",
              modelId: "GLM-5.3-Flash",
            },
            accountAccess: {
              type: "zhipu-account",
              accountType: "bigmodel",
              mode: "individual-coding-plan",
              entitled: true,
            },
          });
          const start = await emit("start-auth", "interaction/requestProviderRuntimeHeaders", {
            providerId: "account:bigmodel-start-plan",
            modelSelection: {
              providerId: "account:bigmodel-start-plan",
              modelId: "GLM-5.3-Flash",
            },
            accountAccess: {
              type: "zhipu-account",
              accountType: "bigmodel",
              mode: "start-plan",
              entitled: true,
            },
          });
          return {
            session: { sessionId: "catalog-official-auth" },
            settings: {
              model: {
                current: {
                  providerId: "account:bigmodel-individual-coding-plan",
                  modelId: "GLM-5.3-Flash",
                },
                available: [{
                  ref: {
                    providerId: "account:bigmodel-individual-coding-plan",
                    modelId: "GLM-5.3-Flash",
                  },
                  label: `Official auth accepted:${(coding.result as Record<string, unknown>).headersApplied === true ? "yes" : "no"} ` +
                    `start:${(start.result as Record<string, unknown>).headersApplied === true ? "yes" : "no"}`,
                }],
              },
            },
          };
        },
        async respond(message) {
          replies.push(message);
          const id = String(message.id);
          waiters.get(id)?.(message);
          waiters.delete(id);
        },
        replayEvents() {},
        prewarmCleanup() {},
        async close() {
          return {
            owner: "official_host",
            receipt: null,
            close: { status: "resolved", stage: "test_close", treeScanStatus: "verified" },
          };
        },
        get stderr() { return ""; },
        onRequest(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      };
    },
  };
}
