import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOfficialProviderRuntimeAuthDispatcher,
  createOfficialProviderRuntimeAuthResolver,
  type OfficialProviderRuntimeAuthOptions,
} from "../src/runtime/official-provider-runtime-auth.js";

const PROVIDER_ID = "account:bigmodel-individual-coding-plan";
const MODEL_ID = "GLM-5.3-Flash";

async function fixture(): Promise<{
  config: NonNullable<OfficialProviderRuntimeAuthOptions["config"]>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-runtime-auth-diagnostic-"));
  const personal = path.join(root, ".zcode", "v2", "provider_config.json");
  const builtin = path.join(root, "builtin.json");
  await mkdir(path.dirname(personal), { recursive: true });
  await writeFile(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }));
  await writeFile(builtin, JSON.stringify({
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: PROVIDER_ID,
          config: {
            builtinModelIds: [MODEL_ID],
            access: {
              type: "zhipu-account",
              mode: "individual-coding-plan",
              accountType: "bigmodel",
            },
          },
        }],
      },
    },
  }));
  return {
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: path.join(root, "zcode.cjs"),
      providerBuiltinConfigFile: builtin,
      providerPersonalConfigFile: personal,
      zcodeDataRoot: path.join(root, ".zcode"),
      dataRoot: root,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function request(modelId = MODEL_ID): Record<string, unknown> {
  return {
    providerId: PROVIDER_ID,
    modelSelection: { providerId: PROVIDER_ID, modelId },
    accountAccess: {
      type: "zhipu-account",
      accountType: "bigmodel",
      mode: "individual-coding-plan",
      entitled: true,
    },
  };
}

test("runtime auth diagnostics report resolved state without credential material", async () => {
  const current = await fixture();
  try {
    const diagnostics: Array<Readonly<Record<string, string | number | boolean | null>>> = [];
    const resolver = createOfficialProviderRuntimeAuthResolver({
      config: current.config,
      onDiagnostic: (facts) => diagnostics.push(facts),
      testOnlyFactoryLoader: async () => () => ({
        resolveProviderRuntimeRequest: async () => ({
          headersApplied: true,
          requestAuth: { apiKey: "synthetic-secret-marker" },
        }),
      }),
    });

    const result = await resolver(request(), new AbortController().signal);

    assert.deepEqual(result, {
      headersApplied: true,
      requestAuth: { apiKey: "synthetic-secret-marker" },
    });
    assert.deepEqual(diagnostics, [{
      stage: "resolved",
      headers_applied: true,
      request_auth_present: true,
    }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-secret-marker|apiKey|requestAuth/u);
  } finally {
    await current.cleanup();
  }
});

test("runtime auth dispatcher binds after Adapter options capture without changing resolver identity", async () => {
  const current = await fixture();
  try {
    const dispatcher = createOfficialProviderRuntimeAuthDispatcher();
    const capturedByAdapterOptions = { resolveProviderRuntimeAuth: dispatcher.resolve };
    const signal = new AbortController().signal;

    assert.equal(
      (await capturedByAdapterOptions.resolveProviderRuntimeAuth(request(), current.config, signal))
        .headersApplied,
      false,
    );

    dispatcher.bind(async (received, config, receivedSignal) => {
      assert.deepEqual(received, request());
      assert.equal(config, current.config);
      assert.equal(receivedSignal, signal);
      return { headersApplied: true, requestAuth: { apiKey: "synthetic-bound-marker" } };
    });
    assert.deepEqual(
      await capturedByAdapterOptions.resolveProviderRuntimeAuth(request(), current.config, signal),
      { headersApplied: true, requestAuth: { apiKey: "synthetic-bound-marker" } },
    );
  } finally {
    await current.cleanup();
  }
});

test("runtime auth diagnostics classify selection rejection before loading credentials", async () => {
  const current = await fixture();
  try {
    const diagnostics: Array<Readonly<Record<string, string | number | boolean | null>>> = [];
    let factoryCalls = 0;
    const resolver = createOfficialProviderRuntimeAuthResolver({
      config: current.config,
      isSelected: () => false,
      onDiagnostic: (facts) => diagnostics.push(facts),
      testOnlyFactoryLoader: async () => {
        factoryCalls += 1;
        throw new Error("factory must not run");
      },
    });

    const result = await resolver(request(), new AbortController().signal);

    assert.equal(result.headersApplied, false);
    assert.equal(factoryCalls, 0);
    assert.deepEqual(diagnostics, [{ stage: "input_rejected", reason: "selection_mismatch" }]);
  } finally {
    await current.cleanup();
  }
});

test("runtime auth diagnostics classify service failures without affecting fail-closed replies", async () => {
  const current = await fixture();
  try {
    const diagnostics: Array<Readonly<Record<string, string | number | boolean | null>>> = [];
    const rejected = createOfficialProviderRuntimeAuthResolver({
      config: current.config,
      onDiagnostic: (facts) => diagnostics.push(facts),
      testOnlyFactoryLoader: async () => () => ({
        resolveProviderRuntimeRequest: async () => ({
          headersApplied: false,
        }),
      }),
    });

    const result = await rejected(request(), new AbortController().signal);
    assert.equal(result.headersApplied, false);
    assert.deepEqual(diagnostics, [{
      stage: "service_rejected",
      headers_applied: false,
      request_auth_present: false,
    }]);

    const failureDiagnostics: Array<Readonly<Record<string, string | number | boolean | null>>> = [];
    const throwing = createOfficialProviderRuntimeAuthResolver({
      config: current.config,
      onDiagnostic: (facts) => failureDiagnostics.push(facts),
      testOnlyFactoryLoader: async () => () => ({
        resolveProviderRuntimeRequest: async () => {
          throw new Error("synthetic-secret-marker");
        },
      }),
    });
    await assert.rejects(
      () => throwing(request(), new AbortController().signal),
      /synthetic-secret-marker/u,
    );
    assert.deepEqual(failureDiagnostics, [{ stage: "resolver_rejected", error_class: "Error" }]);
    assert.doesNotMatch(JSON.stringify(failureDiagnostics), /synthetic-secret-marker/u);
  } finally {
    await current.cleanup();
  }
});
