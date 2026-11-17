import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_VERIFICATION_CONTRACT,
  PROJECT_ROOT,
  createProductionCodingPlanVerificationRunner,
} from "../production-verification-runner.mjs";

const RUN_ROOT = path.join(PROJECT_ROOT, ".run");
const FIXED_ID = "00000000-0000-4000-8000-000000000002";

function beforeSnapshot() {
  return {
    kind: "coding_plan_billing_snapshot",
    provider: { id: PRODUCTION_VERIFICATION_CONTRACT.provider },
  };
}

function verifiedRuntime() {
  return {
    runtime_status: "OFFICIAL_RUNTIME_VERIFIED",
    discount_status: "OFFICIAL_DISCOUNT_VERIFIED",
    manifest: {
      version: "3.18.2.10443",
      request_security_capability: "OfficialRequestSecurity",
    },
    assets: {
      bundle: { status: "VERIFIED", bytes: 15_675_386, sha256: "a".repeat(64) },
      runtime_host: { status: "VERIFIED", bytes: 179_608, sha256: "b".repeat(64) },
    },
  };
}

async function fixtureFiles(root) {
  const userHome = path.join(root, "user-home");
  const install = path.join(root, "install");
  const files = [
    path.join(userHome, ".zcode", "v2", "provider_config.json"),
    path.join(install, "resources", "glm", "zcode.cjs"),
    path.join(install, "resources", "tools", "runtime-host", "zcode-runtime-host.exe"),
    path.join(install, "resources", "config", "provider", "zcode-builtin.json"),
  ];
  for (const file of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "synthetic\n", "utf8");
  }
  const bridgeEntryPath = path.join(root, "dist", "src", "mcp", "main.js");
  await mkdir(path.dirname(bridgeEntryPath), { recursive: true });
  await writeFile(bridgeEntryPath, "// synthetic bridge\n", "utf8");
  return { userHome, install, bridgeEntryPath };
}

test("production runner drives the built MCP task and returns runtime/usage evidence", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "production-runner-test-"));
  const synthetic = await fixtureFiles(root);
  const stateRootParent = path.join(RUN_ROOT, "production-runner-state");
  const stateRoot = path.join(stateRootParent, "cost-lab-web", "verification-state", FIXED_ID);
  const calls = [];
  let closed = 0;
  let statusCalls = 0;
  try {
    const runner = createProductionCodingPlanVerificationRunner({
      projectRoot: root,
      bridgeEntryPath: synthetic.bridgeEntryPath,
      createId: () => FIXED_ID,
      pollIntervalMs: 1,
      taskTimeoutMs: 5_000,
      stateRootParent,
      env: {
        HOME: synthetic.userHome,
        USERPROFILE: synthetic.userHome,
        ZCODE_WINDOWS_APP_INSTALL_DIR: synthetic.install,
        ProgramFiles: "C:\\Program Files",
      },
      inspectRuntime: async () => verifiedRuntime(),
      connectClient: async (options) => {
        const runtimeConfig = JSON.parse(await readFile(
          path.join(root, ".run", "cost-lab-web", "verifications", FIXED_ID, "home", ".codex", "codex-zcode-bridge", "runtime-config.json"),
          "utf8",
        ));
        assert.equal(options.args[0], synthetic.bridgeEntryPath);
        assert.equal(options.env.HOME.endsWith("home"), true);
        assert.equal(isWithin(root, options.env.LOCALAPPDATA), false);
        assert.equal(isWithin(root, runtimeConfig.ZCODE_BRIDGE_DATA_DIR), false);
        assert.equal(runtimeConfig.ZCODE_BRIDGE_PREFER_STARTPLAN, "false");
        return {
          client: {
            callTool: async ({ name, arguments: args }) => {
              calls.push({ name, args });
              if (name === "zcode_task") {
                return { structuredContent: { task_id: args.task_id, status: "queued" } };
              }
              if (name === "zcode_status") {
                statusCalls += 1;
                return {
                  structuredContent: {
                    task_id: args.task_id,
                    attempt: 1,
                    status: statusCalls === 1 ? "running" : "completed",
                    exit_code: 0,
                    zcode_session_id: "sess_synthetic",
                  },
                };
              }
              if (name === "zcode_result") {
                return {
                  structuredContent: {
                    task_id: args.task_id,
                    status: "completed",
                    exit_code: 0,
                    session_id: "sess_synthetic",
                    model: {
                      provider_id: PRODUCTION_VERIFICATION_CONTRACT.provider,
                      model_id: PRODUCTION_VERIFICATION_CONTRACT.model,
                      effective_reasoning_level: "low",
                    },
                    usage: {
                      source: "runtime",
                      scope: "turn",
                      observed_at: "2026-11-17T02:03:00.000Z",
                      finality: "reported",
                      input_tokens: 13_355,
                      output_tokens: 47,
                      total_tokens: 13_402,
                      cached_input_tokens: 64,
                      reasoning_tokens: null,
                      conflicts: [],
                      dropped_unknown_keys: 0,
                    },
                  },
                };
              }
              if (name === "zcode_events") {
                return {
                  structuredContent: {
                    task_id: args.task_id,
                    status: "completed",
                    events: [
                      { seq: 1, at: "2026-11-17T02:00:01.000Z", type: "turn_started", summary: "started", details: { turn_id: "turn-1" } },
                      {
                        seq: 2,
                        at: "2026-11-17T02:03:00.000Z",
                        type: "turn_completed",
                        summary: "completed",
                        details: {
                          usage: {
                            input_tokens: 13_355,
                            output_tokens: 47,
                            total_tokens: 13_402,
                            cached_input_tokens: 64,
                          },
                        },
                      },
                    ],
                    next_seq: 3,
                    has_more: false,
                  },
                };
              }
              if (name === "zcode_cancel") return { structuredContent: { status: "cancelled" } };
              throw new Error(`unexpected tool ${name}`);
            },
          },
          close: async () => {
            closed += 1;
          },
        };
      },
    });
    const result = await runner({
      signal: new AbortController().signal,
      provider: PRODUCTION_VERIFICATION_CONTRACT.provider,
      model: PRODUCTION_VERIFICATION_CONTRACT.model,
      reasoning: PRODUCTION_VERIFICATION_CONTRACT.reasoning,
      beforeSnapshot: beforeSnapshot(),
    });
    assert.equal(result.model_requests, 1);
    assert.equal(result.usage.total_tokens, 13_402);
    assert.equal(result.hour, 10);
    assert.equal(result.runtime_evidence.runtime.bundle_sha256, "a".repeat(64));
    assert.equal(result.runtime_evidence.provider, PRODUCTION_VERIFICATION_CONTRACT.provider);
    assert.equal(result.runtime_evidence.request_security.expected, "OfficialRequestSecurity");
    assert.deepEqual(calls.map((call) => call.name), [
      "zcode_task",
      "zcode_status",
      "zcode_status",
      "zcode_result",
      "zcode_events",
    ]);
    assert.equal(closed, 1);
    await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRootParent, { recursive: true, force: true }),
    ]);
  }
});

test("production runner rejects unsupported model input before creating a bridge client", async () => {
  let connected = 0;
  const runner = createProductionCodingPlanVerificationRunner({
    projectRoot: PROJECT_ROOT,
    connectClient: async () => {
      connected += 1;
      throw new Error("unexpected");
    },
  });
  await assert.rejects(
    runner({
      provider: PRODUCTION_VERIFICATION_CONTRACT.provider,
      model: "another-model",
      reasoning: "low",
      beforeSnapshot: beforeSnapshot(),
    }),
    /verification_model_not_allowed/u,
  );
  assert.equal(connected, 0);
});

test("production runner fails before model dispatch when the installed runtime is unverified", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "production-runner-unverified-"));
  const synthetic = await fixtureFiles(root);
  const stateRootParent = path.join(RUN_ROOT, "production-runner-unverified-state");
  const stateRoot = path.join(stateRootParent, "cost-lab-web", "verification-state", FIXED_ID);
  let connected = 0;
  try {
    const runner = createProductionCodingPlanVerificationRunner({
      projectRoot: root,
      bridgeEntryPath: synthetic.bridgeEntryPath,
      createId: () => FIXED_ID,
      stateRootParent,
      env: {
        HOME: synthetic.userHome,
        USERPROFILE: synthetic.userHome,
        ZCODE_WINDOWS_APP_INSTALL_DIR: synthetic.install,
      },
      inspectRuntime: async () => ({
        runtime_status: "OFFICIAL_RUNTIME_UNVERIFIED",
        discount_status: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
      }),
      connectClient: async () => {
        connected += 1;
        throw new Error("unexpected");
      },
    });
    await assert.rejects(
      runner({
        provider: PRODUCTION_VERIFICATION_CONTRACT.provider,
        model: PRODUCTION_VERIFICATION_CONTRACT.model,
        reasoning: "low",
        beforeSnapshot: beforeSnapshot(),
      }),
      /installed_official_runtime_unverified/u,
    );
    assert.equal(connected, 0);
    await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRootParent, { recursive: true, force: true }),
    ]);
  }
});

test("production runner preserves a safe Bridge SQLite marker when MCP startup is wrapped", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "production-runner-marker-"));
  const synthetic = await fixtureFiles(root);
  const stateRootParent = path.join(RUN_ROOT, "production-runner-marker-state");
  const stateRoot = path.join(stateRootParent, "cost-lab-web", "verification-state", FIXED_ID);
  try {
    const runner = createProductionCodingPlanVerificationRunner({
      projectRoot: root,
      bridgeEntryPath: synthetic.bridgeEntryPath,
      createId: () => FIXED_ID,
      stateRootParent,
      env: {
        HOME: synthetic.userHome,
        USERPROFILE: synthetic.userHome,
        ZCODE_WINDOWS_APP_INSTALL_DIR: synthetic.install,
      },
      inspectRuntime: async () => verifiedRuntime(),
      connectClient: async (options) => {
        options.stderr.capture("[bridge] SQLITE_INITIALIZATION_FAILED: sqlite_data_root_reserved_location\n");
        const error = new Error("wrapped");
        error.code = "ERR_INVALID_ARG_VALUE";
        throw error;
      },
    });
    await assert.rejects(
      runner({
        provider: PRODUCTION_VERIFICATION_CONTRACT.provider,
        model: PRODUCTION_VERIFICATION_CONTRACT.model,
        reasoning: "low",
        beforeSnapshot: beforeSnapshot(),
      }),
      { code: "SQLITE_INITIALIZATION_FAILED" },
    );
    await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRootParent, { recursive: true, force: true }),
    ]);
  }
});

test("production runner preserves a structured MCP task rejection code", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "production-runner-rejection-"));
  const synthetic = await fixtureFiles(root);
  const stateRootParent = path.join(RUN_ROOT, "production-runner-rejection-state");
  try {
    const runner = createProductionCodingPlanVerificationRunner({
      projectRoot: root,
      bridgeEntryPath: synthetic.bridgeEntryPath,
      createId: () => FIXED_ID,
      stateRootParent,
      env: {
        HOME: synthetic.userHome,
        USERPROFILE: synthetic.userHome,
        ZCODE_WINDOWS_APP_INSTALL_DIR: synthetic.install,
      },
      inspectRuntime: async () => verifiedRuntime(),
      connectClient: async () => ({
        client: {
          callTool: async ({ name }) => {
            if (name !== "zcode_task") throw new Error(`unexpected tool ${name}`);
            return {
              isError: true,
              structuredContent: { error: { code: "TASK_ALREADY_EXISTS", message: "duplicate" } },
            };
          },
        },
        close: async () => undefined,
      }),
    });
    await assert.rejects(
      runner({
        provider: PRODUCTION_VERIFICATION_CONTRACT.provider,
        model: PRODUCTION_VERIFICATION_CONTRACT.model,
        reasoning: "low",
        beforeSnapshot: beforeSnapshot(),
      }),
      { code: "TASK_ALREADY_EXISTS" },
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRootParent, { recursive: true, force: true }),
    ]);
  }
});

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
