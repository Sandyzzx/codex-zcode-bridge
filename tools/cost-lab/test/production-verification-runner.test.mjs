import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CODE_EDIT_EXPECTED_CONTENT,
  CODE_EDIT_RELATIVE_PATH,
  PRODUCTION_VERIFICATION_CONTRACT,
  PROJECT_ROOT,
  VERIFIED_START_PLAN_PROVIDER,
  createProductionCodingPlanVerificationRunner,
} from "../production-verification-runner.mjs";

const RUN_ROOT = path.join(PROJECT_ROOT, ".run");
const FIXED_ID = "00000000-0000-4000-8000-000000000002";
const FAILURE_FACTS = Object.freeze({
  schema_version: "1",
  source: "turn_event",
  phase: "turn_terminal",
  rpc_method: null,
  rpc_code: null,
  rpc_data_code: null,
  error_type: "model_error",
  error_code: "model_request_failed",
  provider_code: null,
  http_status: null,
  accepted_before_error: "yes",
  category: "execution_failed",
  confidence: "inferred",
  evidence_basis: "result_type",
  evidence_conflict: false,
  runtime_retryable: null,
  runtime_retryable_basis: null,
  result_type: "error_during_execution",
  process_errno: null,
});

function beforeSnapshot() {
  return {
    kind: "coding_plan_billing_snapshot",
    provider: { id: PRODUCTION_VERIFICATION_CONTRACT.provider },
  };
}

function verifiedRuntime(install) {
  return {
    install_root: install,
    runtime_status: "OFFICIAL_RUNTIME_VERIFIED",
    discount_status: "OFFICIAL_DISCOUNT_VERIFIED",
    manifest: {
      version: "3.18.2.10443",
      request_security_capability: "OfficialRequestSecurity",
    },
    assets: {
      bundle: { relative_path: "resources/glm/zcode.cjs", status: "VERIFIED", bytes: 15_675_386, sha256: "a".repeat(64) },
      builtin_provider_config: { relative_path: "resources/config/provider/zcode-builtin.json" },
      runtime_host: { relative_path: "resources/tools/runtime-host/zcode-runtime-host.exe", status: "VERIFIED", bytes: 179_608, sha256: "b".repeat(64) },
    },
  };
}

function experimentalRuntime(install, authorizationFile) {
  return {
    install_root: install,
    runtime_status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
    installation_safety: "OFFICIAL_INSTALLATION_SAFE",
    installation_fingerprint: "d".repeat(64),
    desktop_version: "3.19.0.10774",
    desktop_app_version: "3.19.0",
    desktop_build_commit_id: "a7ed1054",
    experimental_authorization: {
      state: "authorized",
      file_path: authorizationFile,
      reason: null,
      record: {
        installation_fingerprint: "d".repeat(64),
        desktop_version: "3.19.0.10774",
        authorized_at: "2026-11-20T00:00:00.000Z",
        authorized_by: "synthetic-test",
        scopes: ["coding_plan_probe"],
      },
      scopes: ["coding_plan_probe"],
    },
    discount_status: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    manifest: null,
    assets: {
      bundle: { relative_path: "resources/glm/zcode.cjs", status: "EXPERIMENTAL", bytes: 15_843_692, sha256: "a".repeat(64) },
      builtin_provider_config: { relative_path: "resources/config/provider/zcode-builtin.json" },
      runtime_host: { relative_path: "resources/tools/runtime-host/zcode-runtime-host.exe", status: "EXPERIMENTAL", bytes: 179_608, sha256: "b".repeat(64) },
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
  let reportInstalledRuntime = true;
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
      inspectRuntime: async () => verifiedRuntime(synthetic.install),
      connectClient: async (options) => {
        const runtimeConfig = JSON.parse(await readFile(
          path.join(root, ".run", "cost-lab-web", "verifications", FIXED_ID, "home", ".codex", "codex-zcode-bridge", "runtime-config.json"),
          "utf8",
        ));
        assert.equal(options.args[0], synthetic.bridgeEntryPath);
        assert.equal(options.env.HOME.endsWith("home"), true);
        assert.equal(options.env.ZCODE_BRIDGE_PLUGIN_MODE, "1");
        assert.equal(isWithin(root, options.env.LOCALAPPDATA), false);
        assert.equal(isWithin(root, runtimeConfig.ZCODE_BRIDGE_DATA_DIR), false);
        assert.equal(runtimeConfig.ZCODE_BRIDGE_PREFER_STARTPLAN, "false");
        return {
          client: {
            callTool: async ({ name, arguments: args }) => {
              calls.push({ name, args });
              if (name === "zcode_task") {
                const digest = reportInstalledRuntime ? "a".repeat(64) : "c".repeat(64);
                options.stderr.capture(`[bridge] worker installed-runtime ${args.task_id} 1 ${digest}\n`);
                options.stderr.capture('[bridge] runtime-auth {"stage":"resolved","headers_applied":true}\n');
                options.stderr.capture(`[bridge] worker failure-facts ${JSON.stringify(FAILURE_FACTS)}\n`);
                options.stderr.capture('[bridge] worker failure-facts {"secret":"do-not-capture"}\n');
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
                      { seq: 3, type: "released", details: { cleanup_digest: "a".repeat(64) } },
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
    const input = {
      signal: new AbortController().signal,
      provider: PRODUCTION_VERIFICATION_CONTRACT.provider,
      model: PRODUCTION_VERIFICATION_CONTRACT.model,
      reasoning: PRODUCTION_VERIFICATION_CONTRACT.reasoning,
      beforeSnapshot: beforeSnapshot(),
    };
    const result = await runner(input);
    assert.equal(result.model_requests, 1);
    assert.equal(result.usage.total_tokens, 13_402);
    assert.equal(result.hour, 10);
    assert.equal(result.runtime_evidence.runtime.bundle_sha256, "a".repeat(64));
    assert.equal(result.runtime_evidence.status, "PASS");
    assert.equal(result.runtime_evidence.request_security.installed_bundle_verified, true);
    assert.equal(result.runtime_evidence.provider, PRODUCTION_VERIFICATION_CONTRACT.provider);
    assert.equal(result.runtime_evidence.request_security.expected, "OfficialRequestSecurity");
    assert.deepEqual(result.runtime_evidence.failure_facts, FAILURE_FACTS);
    assert.ok(result.runtime_evidence.stderr_markers.includes(
      '[bridge] runtime-auth {"stage":"resolved","headers_applied":true}',
    ));
    assert.deepEqual(calls.map((call) => call.name), [
      "zcode_task",
      "zcode_status",
      "zcode_status",
      "zcode_result",
      "zcode_events",
    ]);
    assert.equal(closed, 1);
    await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
    reportInstalledRuntime = false;
    const mismatch = await runner(input);
    assert.equal(mismatch.runtime_evidence.status, "UNVERIFIED");
    assert.equal(mismatch.runtime_evidence.request_security.installed_bundle_verified, null);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRootParent, { recursive: true, force: true }),
    ]);
  }
});

test("production runner records an experimental runtime without promoting it to verified", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "production-runner-experimental-"));
  const synthetic = await fixtureFiles(root);
  const authorizationFile = path.join(root, "experimental-runtime-authorization.json");
  await writeFile(authorizationFile, "{}\n", "utf8");
  const stateRootParent = path.join(RUN_ROOT, "production-runner-experimental-state");
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
      inspectRuntime: async () => experimentalRuntime(synthetic.install, authorizationFile),
      connectClient: async (options) => {
        const runtimeConfig = JSON.parse(await readFile(
          path.join(
            root,
            ".run",
            "cost-lab-web",
            "verifications",
            FIXED_ID,
            "home",
            ".codex",
            "codex-zcode-bridge",
            "runtime-config.json",
          ),
          "utf8",
        ));
        assert.equal(
          runtimeConfig.ZCODE_BRIDGE_EXPERIMENTAL_RUNTIME_AUTHORIZATION_FILE,
          authorizationFile,
        );
        return {
          client: {
            callTool: async ({ name, arguments: args }) => {
              if (name === "zcode_task") {
                options.stderr.capture(`[bridge] worker installed-runtime ${args.task_id} 1 ${"a".repeat(64)}\n`);
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
                    zcode_session_id: "sess_experimental",
                  },
                };
              }
              if (name === "zcode_result") {
                return {
                  structuredContent: {
                    task_id: args.task_id,
                    status: "completed",
                    exit_code: 0,
                    session_id: "sess_experimental",
                    model: {
                      provider_id: PRODUCTION_VERIFICATION_CONTRACT.provider,
                      model_id: PRODUCTION_VERIFICATION_CONTRACT.model,
                      effective_reasoning_level: "low",
                    },
                    usage: {
                      source: "runtime",
                      scope: "turn",
                      observed_at: "2026-11-20T07:00:00.000Z",
                      finality: "reported",
                      input_tokens: 100,
                      output_tokens: 10,
                      total_tokens: 110,
                      cached_input_tokens: 0,
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
                      {
                        seq: 1,
                        at: "2026-11-20T06:59:50.000Z",
                        type: "turn_completed",
                        summary: "completed",
                        details: {
                          usage: {
                            input_tokens: 100,
                            output_tokens: 10,
                            total_tokens: 110,
                            cached_input_tokens: 0,
                          },
                        },
                      },
                      { seq: 2, type: "released", details: { cleanup_digest: "a".repeat(64) } },
                    ],
                    next_seq: 2,
                    has_more: false,
                  },
                };
              }
              if (name === "zcode_cancel") return { structuredContent: { status: "cancelled" } };
              throw new Error(`unexpected tool ${name}`);
            },
          },
          close: async () => undefined,
        };
      },
    });
    const result = await runner({
      signal: new AbortController().signal,
      provider: PRODUCTION_VERIFICATION_CONTRACT.provider,
      model: PRODUCTION_VERIFICATION_CONTRACT.model,
      reasoning: "low",
      beforeSnapshot: beforeSnapshot(),
    });
    assert.equal(result.runtime_evidence.status, "EXPERIMENTAL");
    assert.equal(result.runtime_evidence.runtime.status, "OFFICIAL_RUNTIME_EXPERIMENTAL");
    assert.equal(result.runtime_evidence.runtime.version, "3.19.0.10774");
    assert.equal(result.runtime_evidence.runtime.desktop_app_version, "3.19.0");
    assert.equal(result.runtime_evidence.runtime.desktop_build_commit_id, "a7ed1054");
    assert.equal(result.runtime_evidence.installation_safety, "OFFICIAL_INSTALLATION_SAFE");
    assert.equal(result.runtime_evidence.installation_fingerprint, "d".repeat(64));
    assert.equal(result.runtime_evidence.experimental_authorization_state, "authorized");
    assert.deepEqual(result.runtime_evidence.experimental_authorization_scopes, ["coding_plan_probe"]);
    assert.equal(result.runtime_evidence.request_security.installed_bundle_verified, true);
    assert.equal(result.runtime_evidence.runtime.request_security_capability, "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stateRootParent, { recursive: true, force: true });
  }
});

test("production runner supports a real code-edit task through the Start Plan production path", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const id = "00000000-0000-4000-8000-000000000003";
  const root = await mkdtemp(path.join(RUN_ROOT, "production-runner-start-plan-"));
  const synthetic = await fixtureFiles(root);
  const stateRootParent = path.join(RUN_ROOT, "production-runner-start-plan-state");
  let closed = 0;
  let statusCalls = 0;
  try {
    const runner = createProductionCodingPlanVerificationRunner({
      projectRoot: root,
      bridgeEntryPath: synthetic.bridgeEntryPath,
      createId: () => id,
      pollIntervalMs: 1,
      taskTimeoutMs: 5_000,
      stateRootParent,
      env: {
        HOME: synthetic.userHome,
        USERPROFILE: synthetic.userHome,
        ZCODE_WINDOWS_APP_INSTALL_DIR: synthetic.install,
        ProgramFiles: "C:\\Program Files",
      },
      inspectRuntime: async () => verifiedRuntime(synthetic.install),
      connectClient: async (options) => {
        const runtimeConfig = JSON.parse(await readFile(
          path.join(
            root,
            ".run",
            "cost-lab-web",
            "verifications",
            id,
            "home",
            ".codex",
            "codex-zcode-bridge",
            "runtime-config.json",
          ),
          "utf8",
        ));
        assert.equal(runtimeConfig.ZCODE_BRIDGE_PREFER_STARTPLAN, "true");
        return {
          client: {
            callTool: async ({ name, arguments: args }) => {
              if (name === "zcode_task") {
                assert.equal(args.model.provider_id, VERIFIED_START_PLAN_PROVIDER);
                assert.deepEqual(args.allowed_paths, [CODE_EDIT_RELATIVE_PATH]);
                await writeFile(
                  path.join(args.workspace, CODE_EDIT_RELATIVE_PATH),
                  CODE_EDIT_EXPECTED_CONTENT,
                  "utf8",
                );
                options.stderr.capture(`[bridge] worker installed-runtime ${args.task_id} 1 ${"a".repeat(64)}\n`);
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
                    zcode_session_id: "sess_start_plan",
                  },
                };
              }
              if (name === "zcode_result") {
                return {
                  structuredContent: {
                    task_id: args.task_id,
                    status: "completed",
                    files_changed: [CODE_EDIT_RELATIVE_PATH],
                    exit_code: 0,
                    session_id: "sess_start_plan",
                    model: {
                      provider_id: VERIFIED_START_PLAN_PROVIDER,
                      model_id: PRODUCTION_VERIFICATION_CONTRACT.model,
                      effective_reasoning_level: "low",
                    },
                    usage: {
                      source: "runtime",
                      scope: "turn",
                      observed_at: "2026-11-20T01:25:00.000Z",
                      finality: "reported",
                      input_tokens: 1_000,
                      output_tokens: 20,
                      total_tokens: 1_020,
                      cached_input_tokens: 0,
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
                      {
                        seq: 1,
                        at: "2026-11-20T01:24:50.000Z",
                        type: "turn_started",
                        summary: "started",
                        details: { turn_id: "turn-start-plan" },
                      },
                      {
                        seq: 2,
                        at: "2026-11-20T01:24:55.000Z",
                        type: "model_tool_call",
                        summary: "edit",
                        details: { tool_name: "write" },
                      },
                      {
                        seq: 3,
                        at: "2026-11-20T01:25:00.000Z",
                        type: "turn_completed",
                        summary: "completed",
                        details: {
                          usage: {
                            input_tokens: 1_000,
                            output_tokens: 20,
                            total_tokens: 1_020,
                            cached_input_tokens: 0,
                          },
                        },
                      },
                      { seq: 4, type: "released", details: { cleanup_digest: "a".repeat(64) } },
                    ],
                    next_seq: 4,
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
      provider: VERIFIED_START_PLAN_PROVIDER,
      model: PRODUCTION_VERIFICATION_CONTRACT.model,
      reasoning: "low",
      taskMode: "code_edit",
      beforeSnapshot: {
        kind: "start_plan_billing_snapshot",
        provider: { id: VERIFIED_START_PLAN_PROVIDER },
      },
    });
    assert.equal(result.model_requests, 1);
    assert.equal(result.runtime_evidence.provider, VERIFIED_START_PLAN_PROVIDER);
    assert.equal(result.runtime_evidence.workspace_evidence.content_match, true);
    assert.equal(result.runtime_evidence.event_coverage.model_tool_call_count, 1);
    assert.equal(closed, 1);
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

test("production runner preserves the Bridge SQLite marker and roots when startup cleanup is unknown", async () => {
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
      inspectRuntime: async () => verifiedRuntime(synthetic.install),
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
    assert.equal((await lstat(stateRoot)).isDirectory(), true);
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
      inspectRuntime: async () => verifiedRuntime(synthetic.install),
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
      (error) => {
        assert.equal(error.code, "TASK_ALREADY_EXISTS");
        assert.match(error.message, /duplicate/u);
        return true;
      },
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(stateRootParent, { recursive: true, force: true }),
    ]);
  }
});

test("production runner retains result evidence when a code-edit task makes no change", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "production-runner-unedited-"));
  const synthetic = await fixtureFiles(root);
  const stateRootParent = path.join(RUN_ROOT, "production-runner-unedited-state");
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
      },
      inspectRuntime: async () => verifiedRuntime(synthetic.install),
      connectClient: async () => ({
        client: {
          callTool: async ({ name, arguments: args }) => {
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
                  zcode_session_id: "sess_unedited",
                },
              };
            }
            if (name === "zcode_result") {
              return {
                structuredContent: {
                  task_id: args.task_id,
                  status: "completed",
                  files_changed: [],
                  exit_code: 0,
                  session_id: "sess_unedited",
                  model: {
                    provider_id: PRODUCTION_VERIFICATION_CONTRACT.provider,
                    model_id: PRODUCTION_VERIFICATION_CONTRACT.model,
                    effective_reasoning_level: "low",
                  },
                  usage: {
                    source: "runtime",
                    scope: "turn",
                    observed_at: "2026-11-20T01:38:00.000Z",
                    finality: "reported",
                    input_tokens: 100,
                    output_tokens: 10,
                    total_tokens: 110,
                    cached_input_tokens: 0,
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
                    {
                      seq: 1,
                      at: "2026-11-20T01:37:50.000Z",
                      type: "turn_completed",
                      summary: "completed",
                      details: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0 } },
                    },
                    { seq: 2, type: "released", details: { cleanup_digest: "a".repeat(64) } },
                  ],
                  next_seq: 2,
                  has_more: false,
                },
              };
            }
            if (name === "zcode_cancel") return { structuredContent: { status: "cancelled" } };
            throw new Error(`unexpected tool ${name}`);
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
        taskMode: "code_edit",
        beforeSnapshot: beforeSnapshot(),
      }),
      (error) => {
        assert.equal(error.code, "COST_LAB_RESULT_VALIDATION_FAILED");
        assert.match(error.message, /bridge_code_edit_unverified/u);
        assert.equal(error.evidence.result_evidence.status, "completed");
        assert.equal(error.evidence.model_requests, 1);
        assert.equal(error.evidence.usage.total_tokens, 110);
        assert.equal(error.evidence.hour, 9);
        assert.equal(error.evidence.workspace_evidence.content_changed, false);
        return true;
      },
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
