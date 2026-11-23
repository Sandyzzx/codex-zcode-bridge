import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveBillingDataBaseDir } from "./path-discovery.mjs";
import { inspectOfficialRuntimeAssets } from "./official-runtime-manifest.mjs";
import { shanghaiHourForTimestamp } from "./coding-plan-billing.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
export const VERIFIED_PROVIDER = "account:bigmodel-individual-coding-plan";
export const VERIFIED_START_PLAN_PROVIDER = "account:bigmodel-start-plan";
export const VERIFIED_MODEL = "GLM-5.3-Flash";
export const RESPONSE_MARKER = "COSTLAB_PRODUCTION_VERIFICATION_OK";
export const CODE_EDIT_RELATIVE_PATH = "src/value.js";
export const CODE_EDIT_SEED_CONTENT =
  'export const value = 0;\n';
export const CODE_EDIT_EXPECTED_CONTENT =
  'export const value = 42;\n';
const PROVIDER_SNAPSHOT_KINDS = Object.freeze({
  [VERIFIED_PROVIDER]: "coding_plan_billing_snapshot",
  [VERIFIED_START_PLAN_PROVIDER]: "start_plan_billing_snapshot",
});
const CONFIG_KEYS = Object.freeze([
  "ZCODE_BRIDGE_ZCODE_CJS",
  "ZCODE_BRIDGE_DATA_DIR",
  "ZCODE_BRIDGE_TIMEOUT_MS",
  "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS",
  "ZCODE_BRIDGE_MODE",
  "ZCODE_BRIDGE_PREFER_STARTPLAN",
  "ZCODE_WINDOWS_APP_INSTALL_DIR",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_HOME",
  "ZCODE_DATA_BASE_DIR",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "waiting_for_master"]);
const FAILURE_FACTS_PREFIX = "[bridge] worker failure-facts ";
const FAILURE_FACTS_KEYS = Object.freeze([
  "schema_version",
  "source",
  "phase",
  "rpc_method",
  "rpc_code",
  "rpc_data_code",
  "error_type",
  "error_code",
  "provider_code",
  "http_status",
  "accepted_before_error",
  "category",
  "confidence",
  "evidence_basis",
  "evidence_conflict",
  "runtime_retryable",
  "runtime_retryable_basis",
  "result_type",
  "process_errno",
]);
const FAILURE_FACTS_KEY_SET = new Set(FAILURE_FACTS_KEYS);
const MODEL_EVENT_TYPES = new Set([
  "model_output_started",
  "model_output",
  "model_tool_call",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "provider_retry_scheduled",
  "provider_retry_send_accepted",
]);

export async function runProductionCodingPlanVerification(input, options = {}) {
  return createProductionCodingPlanVerificationRunner(options)(input);
}

export function createProductionCodingPlanVerificationRunner(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const bridgeEntryPath = path.resolve(
    options.bridgeEntryPath ?? path.join(
      projectRoot,
      "plugins",
      "codex-zcode-bridge",
      "dist",
      "bridge.mjs",
    ),
  );
  const executorEntryPath = path.resolve(
    options.executorEntryPath ?? path.join(
      projectRoot,
      "plugins",
      "codex-zcode-bridge",
      "dist",
      "executor.mjs",
    ),
  );
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const connectClient = options.connectClient ?? connectBridgeMcpClient;
  const manageExecutor = options.manageExecutor ?? options.connectClient === undefined;
  const startExecutorProcess = options.startExecutorProcess ?? startIsolatedExecutor;
  const inspectRuntime = options.inspectRuntime ?? inspectOfficialRuntimeAssets;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const taskTimeoutMs = options.taskTimeoutMs ?? 900_000;
  const bridgeShutdownTimeoutMs = options.bridgeShutdownTimeoutMs ?? 60_000;
  const executorReadyTimeoutMs = options.executorReadyTimeoutMs ?? 30_000;
  const executorShutdownTimeoutMs = options.executorShutdownTimeoutMs ?? 120_000;
  // Cleanup may legitimately spend the lifecycle gate's full 90 second
  // process-tree probe budget before it can persist cleanup_verified and
  // released. Keep observation strictly longer than that bounded work.
  const releaseTimeoutMs = options.releaseTimeoutMs ?? 120_000;

  return async function runVerification(input) {
    validateVerificationInput(input);
    const id = createId();
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("verification_id_invalid");
    const startedAt = now().toISOString();
    const roots = verificationRoots(projectRoot, id, options.stateRootParent);
    await assertPathAbsent(roots.runRoot);
    await assertPathAbsent(roots.stateRoot);
    const layout = verificationLayout(roots.runRoot, roots.stateRoot);
    let phase = "isolated_layout";
    let cleanupSafe = true;
    let partialEvidence = null;
    try {
      await createIsolatedLayout(layout, input.taskMode);

      phase = "account_discovery";
      const account = resolveBillingDataBaseDir(null, {
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
        fallbackHomeDir: options.fallbackHomeDir,
      });
      phase = "runtime_discovery";
      const runtime = await inspectRuntime({
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
      });
      // ADR-054: the paid experiment gates on installation safety, not on a
      // compatibility-manifest verdict. The observed runtime_status is still
      // recorded for evidence grading.
      if (runtime.installation_safety !== "OFFICIAL_INSTALLATION_SAFE" || !runtime.install_root) {
        throw new Error("installed_official_runtime_unsafe");
      }
      const official = {
        installRoot: runtime.install_root,
        dataBaseDir: account.dataBaseDir,
        bundle: path.join(runtime.install_root, runtime.assets.bundle.relative_path),
        runtimeHost: path.join(runtime.install_root, runtime.assets.runtime_host.relative_path),
        builtinProviderConfig: path.join(runtime.install_root, runtime.assets.builtin_provider_config.relative_path),
        personalProviderConfig: path.join(account.dataBaseDir, ".zcode", "v2", "provider_config.json"),
        zcodeHome: path.join(account.dataBaseDir, ".zcode"),
        runtimeStatus: runtime.runtime_status,
      };
      for (const filePath of [
        official.bundle,
        official.runtimeHost,
        official.builtinProviderConfig,
        official.personalProviderConfig,
      ]) {
        await access(filePath);
      }
      await assertFile(bridgeEntryPath, "bridge_build_missing");

      phase = "bridge_config";
      const config = buildRuntimeConfig(layout, official, taskTimeoutMs, input.provider);
      await writeRuntimeConfig(layout, config);
      const env = buildIsolatedMcpEnvironment(layout, process.env);
      const stderr = createBoundedStderrCollector();
      let executor;
      let connected;
      let runtimeEvidence;
      let taskId = null;
      let released = false;
      let status = null;
      let events = null;
      let executorStartAttempted = false;
      let bridgeConnectAttempted = false;
      try {
        phase = "executor_start";
        cleanupSafe = false;
        if (manageExecutor) {
          executorStartAttempted = true;
          executor = await startExecutorProcess({
            command: options.nodeExecutable ?? process.execPath,
            executorEntryPath,
            bridgeEntryPath,
            dataRoot: layout.bridgeData,
            settingsDirectory: layout.settings,
            cwd: projectRoot,
            env,
            stderr,
            readyTimeoutMs: executorReadyTimeoutMs,
            shutdownTimeoutMs: executorShutdownTimeoutMs,
          });
          assertNotAborted(input.signal);
        }
        phase = "bridge_connect";
        bridgeConnectAttempted = true;
        connected = await connectClient({
          command: options.nodeExecutable ?? process.execPath,
          args: [bridgeEntryPath],
          cwd: projectRoot,
          env,
          stderr,
          maxBufferSize: 16 * 1024 * 1024,
          clientName: "cost-lab-production-verification",
          clientVersion: "1.0.0",
        });
        const client = connected.client;
        assertNotAborted(input.signal);
        taskId = `costlab-${id}`;
        phase = "task_dispatch";
        const task = buildTask(taskId, layout.workspace, input);
        const receipt = await callBridgeTool(client, "zcode_task", task);
        if (receipt.task_id !== taskId) throw new Error("bridge_task_receipt_mismatch");

        phase = "task_poll";
        status = await waitForTerminalStatus(client, taskId, {
          signal: input.signal,
          timeoutMs: taskTimeoutMs,
          pollIntervalMs,
        });
        phase = "result_read";
        const result = await callBridgeTool(client, "zcode_result", { task_id: taskId });
        phase = "events_read";
        events = await collectTaskEvents(client, taskId);
        phase = "release_wait";
        released = await waitForRelease(client, taskId, status, events, releaseTimeoutMs, pollIntervalMs);
        if (!released) throw new Error("bridge_release_unverified");
        const usageEvidence = extractUsageEvidence(result, events);
        const modelEvents = events.filter((event) => MODEL_EVENT_TYPES.has(event.type));
        const toolEvents = events.filter((event) => event.type === "model_tool_call");
        const eventTypeCounts = Object.fromEntries(
          [...new Set(events.map((event) => event.type))]
            .filter((type) => typeof type === "string" && type.length > 0)
            .sort()
            .map((type) => [type, events.filter((event) => event.type === type).length]),
        );
        const workspaceEvidence = await inspectWorkspaceMutation(
          layout.workspace,
          input.taskMode,
        );
        const candidateDigest = runtime.assets.bundle.sha256;
        const installedRuntimeObserved = typeof candidateDigest === "string" &&
          /^[0-9a-f]{64}$/u.test(candidateDigest) &&
          stderr.markers().includes(`[bridge] worker installed-runtime ${taskId} ${status.attempt} ${candidateDigest}`);
        runtimeEvidence = {
          status: installedRuntimeObserved
            ? runtime.runtime_status === "OFFICIAL_RUNTIME_EXPERIMENTAL"
              ? "EXPERIMENTAL"
              : "PASS"
            : "UNVERIFIED",
          bridge_path: "BUILT_MCP_STDIO_WITH_INDEPENDENT_EXECUTOR",
          executor: executor
            ? {
                pid: executor.pid,
                lease_id: executor.ready?.lease_id ?? null,
                ready_observed: true,
                shutdown: "PENDING",
              }
            : {
                pid: null,
                lease_id: null,
                ready_observed: false,
                shutdown: "EXTERNAL_TEST_FIXTURE",
              },
          isolated_host_profile: true,
          task_id: taskId,
          attempt: status.attempt,
          terminal_status: status.status,
          exit_code: result.exit_code ?? status.exit_code ?? null,
          session_id: result.session_id ?? status.zcode_session_id ?? null,
          provider: result.model?.provider_id ?? null,
          model: result.model?.model_id ?? null,
          requested_reasoning: "low",
          effective_reasoning: result.model?.effective_reasoning_level ?? null,
          installation_safety: runtime.installation_safety ?? null,
          installation_fingerprint: runtime.installation_fingerprint ?? null,
          experimental_authorization_state: runtime.experimental_authorization?.state ?? null,
          experimental_authorization_scopes: runtime.experimental_authorization?.scopes ?? [],
          runtime: {
            status: installedRuntimeObserved ? runtime.runtime_status : "WORKER_RUNTIME_UNOBSERVED",
            version: runtime.manifest?.version ?? runtime.desktop_version ?? null,
            desktop_app_version: runtime.desktop_app_version ?? null,
            desktop_build_commit_id: runtime.desktop_build_commit_id ?? null,
            bundle_sha256: runtime.assets?.bundle?.sha256 ?? null,
            bundle_bytes: runtime.assets?.bundle?.bytes ?? null,
            runtime_host_sha256: runtime.assets?.runtime_host?.sha256 ?? null,
            request_security_capability: runtime.manifest?.request_security_capability ?? "UNKNOWN",
          },
          request_security: {
            expected: "OfficialRequestSecurity",
            installed_bundle_verified: installedRuntimeObserved ? true : null,
            signing_handshake_observation: "NOT_EXPOSED_BY_MCP",
          },
          event_coverage: {
            event_count: events.length,
            model_related_event_count: modelEvents.length,
            model_tool_call_count: toolEvents.length,
            event_type_counts: eventTypeCounts,
            auxiliary_usage_coverage: usageEvidence.auxiliary_usage_coverage,
            model_http_requests: null,
          },
          result_evidence: {
            status: result.status ?? null,
            summary: typeof result.summary === "string" ? result.summary.slice(0, 1_000) : null,
            files_changed: Array.isArray(result.files_changed) ? result.files_changed.slice(0, 100) : [],
            tests: Array.isArray(result.tests)
              ? result.tests.slice(0, 100).map((entry) => ({
                  command: typeof entry?.command === "string" ? entry.command.slice(0, 500) : null,
                  status: typeof entry?.status === "string" ? entry.status : null,
                  details: typeof entry?.details === "string" ? entry.details.slice(0, 1_000) : null,
                }))
              : [],
          },
          failure_facts: stderr.failureFacts(),
          operation_release_observed: true,
          events: modelEvents.map(publicEvidenceEvent),
          workspace_evidence: workspaceEvidence,
          stderr_markers: stderr.markers(),
        };
        partialEvidence = {
          ...runtimeEvidence,
          model_requests: countLogicalModelAttempts(modelEvents),
          usage: usageEvidence.usage,
          hour: verificationHour(usageEvidence.usage, startedAt),
        };
        phase = "result_validation";
        if (result.status === "failed" || result.status === "cancelled" || status.status !== "completed") {
          throw new Error(`bridge_task_terminal_${String(result.status ?? status.status)}`);
        }
        if (input.taskMode === "code_edit" && workspaceEvidence.content_changed !== true) {
          throw new Error("bridge_code_edit_unverified");
        }
        if (!usageEvidence.usage) {
          return {
            model_requests: countLogicalModelAttempts(modelEvents),
            usage: null,
            hour: verificationHour(null, startedAt),
            runtime_evidence: runtimeEvidence,
          };
        }
        return {
          model_requests: countLogicalModelAttempts(modelEvents),
          usage: usageEvidence.usage,
          hour: verificationHour(usageEvidence.usage, startedAt),
          runtime_evidence: {
            ...runtimeEvidence,
            usage_sources: usageEvidence.sources,
          },
        };
      } catch (error) {
        if (error && typeof error === "object") {
          error.executor_pid ??= executor?.pid ?? null;
          if (executor) error.executor_lease_id = executor.ready?.lease_id ?? null;
          if (!released && taskId && connected?.client) {
            error.release_diagnostics = await captureReleaseDiagnostics({
              client: connected.client,
              taskId,
              status,
              events,
              stderr,
              executor,
              releaseTimeoutMs,
            });
          }
        }
        if (taskId && connected?.client && !released) {
          await withTimeout(
            callBridgeTool(connected.client, "zcode_cancel", { task_id: taskId }).catch(() => undefined),
            10_000,
            "bridge_cancel_timeout",
          ).catch(() => undefined);
        }
        if (partialEvidence && error && typeof error === "object" && error.evidence === undefined) {
          error.evidence = partialEvidence;
        }
        const markerCode = bridgeMarkerCode(stderr.markers());
        if (markerCode && error && typeof error === "object") error.code = markerCode;
        throw error;
      } finally {
        let mcpClosed = connected === undefined && !bridgeConnectAttempted;
        if (connected) {
          const closed = await withTimeout(
            connected.close(),
            bridgeShutdownTimeoutMs,
            "bridge_mcp_shutdown_timeout",
          ).then(() => true, () => false);
          mcpClosed = closed;
          if (released && !closed) {
            phase = "bridge_shutdown";
            throw new Error("bridge_mcp_shutdown_unverified");
          }
        }
        let executorClosed = executor === undefined && !executorStartAttempted;
        if (executor) {
          const shutdown = await withTimeout(
            executor.stop(),
            executorShutdownTimeoutMs,
            "cost_lab_executor_shutdown_timeout",
          ).catch((error) => ({
            status: "release_unknown",
            blockers: [error instanceof Error ? error.message : String(error)],
          }));
          executorClosed = shutdown?.status === "closed";
          if (partialEvidence?.executor) {
            partialEvidence.executor.shutdown = shutdown?.status ?? "UNKNOWN";
          }
          if (runtimeEvidence?.executor) {
            runtimeEvidence.executor.shutdown = shutdown?.status ?? "UNKNOWN";
          }
          if (taskId && !released) {
            // A blocked task must keep the Executor, Store, and ownership record
            // available for diagnosis. Do not force process termination.
            cleanupSafe = false;
          } else if (!executorClosed) {
            cleanupSafe = false;
            phase = "executor_shutdown";
            throw new Error(`cost_lab_executor_shutdown_${shutdown?.status ?? "unknown"}`);
          }
        }
        cleanupSafe = mcpClosed && executorClosed && (!taskId || released);
      }
    } catch (error) {
      decorateVerificationError(error, phase);
      throw error;
    } finally {
      if (cleanupSafe) await cleanupVerificationRoots(roots);
    }
  };
}

function countLogicalModelAttempts(events) {
  const terminal = events.filter((event) =>
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "provider_retry_send_accepted",
  ).length;
  return terminal || null;
}

async function waitForRelease(client, taskId, status, events, timeoutMs, pollIntervalMs) {
  // A fresh isolated task has one attempt. The public event projection
  // does not expose attempt IDs, so never adopt a release for a later attempt.
  if (status.task_id !== taskId || status.attempt !== 1) return false;
  const hasRelease = (batch) => batch.some((event) =>
    event.type === "released" && /^[0-9a-f]{64}$/u.test(event.details?.cleanup_digest));
  if (hasRelease(events)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.min(pollIntervalMs, deadline - Date.now()));
    const current = await callBridgeTool(client, "zcode_status", { task_id: taskId });
    if (current.task_id !== taskId || current.attempt !== 1 || !TERMINAL_STATUSES.has(current.status)) return false;
    if (hasRelease(await collectTaskEvents(client, taskId))) return true;
  }
  return false;
}

async function captureReleaseDiagnostics(input) {
  const diagnostics = {
    stage: "release_wait",
    release_timeout_ms: input.releaseTimeoutMs,
    task_id: input.taskId,
    initial: summarizeTaskEvents(input.status, input.events),
    executor: {
      pid: input.executor?.pid ?? null,
      lease_id: input.executor?.ready?.lease_id ?? null,
    },
    stderr_markers: input.stderr?.markers?.() ?? [],
    final: null,
    final_read_error: null,
  };
  try {
    const status = await callBridgeTool(input.client, "zcode_status", { task_id: input.taskId });
    const events = await collectTaskEvents(input.client, input.taskId);
    diagnostics.final = summarizeTaskEvents(status, events);
  } catch (error) {
    diagnostics.final_read_error = {
      code: typeof error?.code === "string" ? error.code : null,
      message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }
  return diagnostics;
}

function summarizeTaskEvents(status, events) {
  const rows = Array.isArray(events) ? events : [];
  const eventTypeCounts = Object.fromEntries(
    [...new Set(rows.map((event) => event?.type).filter((type) => typeof type === "string"))]
      .sort()
      .map((type) => [type, rows.filter((event) => event?.type === type).length]),
  );
  const lifecycleTypes = new Set([
    "result_committed",
    "cleanup_pending",
    "cleanup_verified",
    "cleanup_unverified",
    "cleanup_reverified",
    "released",
  ]);
  const lifecycleEvents = rows
    .filter((event) => lifecycleTypes.has(event?.type))
    .slice(-20)
    .map((event) => ({
      seq: Number.isSafeInteger(event?.seq) ? event.seq : null,
      at: typeof event?.at === "string" ? event.at.slice(0, 64) : null,
      type: typeof event?.type === "string" ? event.type : "unknown",
      summary: typeof event?.summary === "string" ? event.summary.slice(0, 500) : "",
      details: pickReleaseDetails(event?.details),
    }));
  return {
    status: summarizeStatus(status),
    event_count: rows.length,
    event_type_counts: eventTypeCounts,
    lifecycle_events: lifecycleEvents,
  };
}

function summarizeStatus(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  const execution = status.execution_observation;
  return {
    task_id: typeof status.task_id === "string" ? status.task_id : null,
    status: typeof status.status === "string" ? status.status : null,
    attempt: Number.isSafeInteger(status.attempt) ? status.attempt : null,
    worker_pid: Number.isSafeInteger(status.worker_pid) ? status.worker_pid : null,
    error_code: typeof status.error_code === "string" ? status.error_code.slice(0, 200) : null,
    execution_observation: execution && typeof execution === "object"
      ? {
          state: typeof execution.state === "string" ? execution.state : null,
          observed_at: typeof execution.observed_at === "string" ? execution.observed_at.slice(0, 64) : null,
          evidence_ref: typeof execution.evidence_ref === "string" ? execution.evidence_ref : null,
        }
      : null,
  };
}

function pickReleaseDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const keys = [
    "cleanup_digest",
    "reason",
    "probe_state",
    "outcome",
    "recovery_disposition",
    "process_tree_scan_clean",
    "process_tree_root_observed",
    "process_tree_probe_status",
  ];
  const selected = {};
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string") selected[key] = value.slice(0, 256);
    else if (typeof value === "boolean" || Number.isSafeInteger(value)) selected[key] = value;
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

function verificationHour(usage, fallbackTimestamp) {
  const observedAt = usage?.observed_at;
  const timestamp = typeof observedAt === "string" && !Number.isNaN(new Date(observedAt).getTime())
    ? observedAt
    : fallbackTimestamp;
  return shanghaiHourForTimestamp(timestamp);
}

function validateVerificationInput(input) {
  if (!input || typeof input !== "object") throw new Error("verification_input_required");
  const snapshotKind = PROVIDER_SNAPSHOT_KINDS[input.provider];
  if (!snapshotKind) throw new Error("verification_provider_not_allowed");
  if (input.model !== VERIFIED_MODEL) throw new Error("verification_model_not_allowed");
  if (input.reasoning !== "low") throw new Error("verification_reasoning_not_allowed");
  if (input.taskMode !== undefined && input.taskMode !== "marker" && input.taskMode !== "code_edit") {
    throw new Error("verification_task_mode_not_allowed");
  }
  const snapshotProvider =
    input.beforeSnapshot?.provider?.id ??
    input.beforeSnapshot?.provider_scope ??
    input.beforeSnapshot?.account?.provider_scope ??
    null;
  if (!input.beforeSnapshot ||
      input.beforeSnapshot.kind !== snapshotKind ||
      snapshotProvider !== input.provider) {
    throw new Error("verification_before_snapshot_invalid");
  }
}

function verificationRoots(projectRoot, id, configuredStateRootParent) {
  const runRoot = path.join(projectRoot, ".run", "cost-lab-web", "verifications", id);
  assertInside(path.join(projectRoot, ".run"), runRoot);
  const stateRootParent = configuredStateRootParent
    ? canonicalExistingPath(configuredStateRootParent)
    : defaultVerificationStateRootParent(projectRoot);
  // Keep the canonical SQLite root short enough for the bootstrap stage file
  // on Windows hosts whose temporary directory is exposed through an 8.3 alias.
  const stateRoot = path.join(stateRootParent, "runs", id);
  if (isWithin(projectRoot, stateRoot)) {
    throw new Error("cost_lab_verification_state_inside_package_root");
  }
  assertVerificationPathBudget(stateRoot);
  return Object.freeze({ runRoot, stateRoot });
}

function canonicalExistingPath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    // Windows temporary roots can expose an 8.3 alias (RUNNER~1). The
    // Authority compares this path with realpath(native), so seal the parent
    // identity before appending the isolated state directory.
    return realpathSync.native(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    throw error;
  }
}

function assertVerificationPathBudget(stateRoot) {
  if (process.platform !== "win32") return;
  const bootstrapStage = path.join(
    stateRoot,
    "bridge-data",
    "state",
    `bridge.sqlite.bootstrap-${"0".repeat(36)}.stage`,
  );
  if (bootstrapStage.length >= 260) {
    throw new Error("cost_lab_verification_state_root_too_long");
  }
}

function defaultVerificationStateRootParent(projectRoot) {
  const commonProjectRoot = resolveCommonProjectRoot(projectRoot);
  if (commonProjectRoot) {
    const candidate = path.join(commonProjectRoot, ".run");
    if (!isWithin(projectRoot, candidate) && !isWithin(os.tmpdir(), candidate)) return candidate;
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new Error("cost_lab_verification_state_parent_unavailable");
  }
  const candidate = path.join(localAppData, "CodexZCodeBridge-CostLab");
  if (isWithin(projectRoot, candidate) || isWithin(os.tmpdir(), candidate)) {
    throw new Error("cost_lab_verification_state_parent_reserved");
  }
  return candidate;
}

function resolveCommonProjectRoot(projectRoot) {
  try {
    const dotGit = path.join(projectRoot, ".git");
    const metadata = lstatSync(dotGit);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const marker = "gitdir:";
    const text = readFileSync(dotGit, "utf8").trim();
    if (!text.startsWith(marker)) return null;
    const configured = text.slice(marker.length).trim();
    if (!configured) return null;
    const gitDir = path.resolve(projectRoot, configured);
    if (path.basename(gitDir) === ".git") return path.dirname(gitDir);
    const worktreesDir = path.dirname(gitDir);
    if (path.basename(worktreesDir) !== "worktrees" || path.basename(path.dirname(worktreesDir)) !== ".git") {
      return null;
    }
    return path.dirname(path.dirname(worktreesDir));
  } catch {
    return null;
  }
}

function verificationLayout(root, stateRoot) {
  return Object.freeze({
    root,
    home: path.join(root, "home"),
    appData: path.join(root, "app-data"),
    localAppData: path.join(stateRoot, "local-app-data"),
    temp: path.join(root, "temp"),
    bridgeDataRoot: path.join(stateRoot, "bridge-data"),
    bridgeData: path.join(stateRoot, "bridge-data", "state"),
    settings: path.join(root, "home", ".codex", "codex-zcode-bridge"),
    workspace: path.join(root, "workspace"),
  });
}

async function assertPathAbsent(target) {
  try {
    await lstat(target);
    throw new Error("cost_lab_verification_root_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cleanupVerificationRoots(roots) {
  for (const target of [roots.stateRoot, roots.runRoot]) {
    const resolved = await realpath(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (resolved === null) continue;
    assertInside(path.dirname(target), resolved);
    if (path.relative(target, resolved) !== "") throw new Error("cost_lab_verification_cleanup_path_changed");
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

async function createIsolatedLayout(layout, taskMode) {
  for (const directory of [
    layout.home,
    layout.appData,
    layout.localAppData,
    layout.temp,
    layout.bridgeDataRoot,
    layout.bridgeData,
    layout.settings,
    layout.workspace,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(layout.workspace, "VERIFICATION_TASK.txt"), [
    "This is an isolated Cost Lab billing verification workspace.",
    taskMode === "code_edit"
      ? `Edit ${CODE_EDIT_RELATIVE_PATH} exactly as requested and read it back.`
      : `Return exactly ${RESPONSE_MARKER}.`,
    taskMode === "code_edit" ? "Do not run shell commands." : "Do not modify, create, or delete files.",
    "",
  ].join("\n"), { encoding: "utf8", flag: "wx" });
  if (taskMode === "code_edit") {
    const target = path.join(layout.workspace, CODE_EDIT_RELATIVE_PATH);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, CODE_EDIT_SEED_CONTENT, { encoding: "utf8", flag: "wx" });
  }
}

function buildRuntimeConfig(layout, official, timeoutMs, provider) {
  return Object.freeze({
    ZCODE_BRIDGE_ZCODE_CJS: official.bundle,
    ZCODE_BRIDGE_DATA_DIR: layout.bridgeDataRoot,
    ZCODE_BRIDGE_TIMEOUT_MS: String(timeoutMs),
    ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS: "1",
    ZCODE_BRIDGE_MODE: "yolo",
    ZCODE_BRIDGE_PREFER_STARTPLAN: provider === VERIFIED_START_PLAN_PROVIDER ? "true" : "false",
    ZCODE_WINDOWS_APP_INSTALL_DIR: official.installRoot,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: official.builtinProviderConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: official.personalProviderConfig,
    ZCODE_HOME: official.zcodeHome,
    ZCODE_DATA_BASE_DIR: official.dataBaseDir,
  });
}

async function writeRuntimeConfig(layout, config) {
  const pathValue = path.join(layout.settings, "runtime-config.json");
  await writeFile(pathValue, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const authorityPath = path.join(layout.settings, "authority.json");
  await writeFile(authorityPath, `${JSON.stringify({
    schema_version: 1,
    authority: "sqlite",
    data_root: layout.bridgeDataRoot,
  }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function buildIsolatedMcpEnvironment(layout, source) {
  const homeDrive = path.parse(layout.home).root.replace(/[\\/]+$/u, "");
  const homePath = layout.home.slice(path.parse(layout.home).root.length - 1);
  const env = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    ZCODE_BRIDGE_PLUGIN_MODE: "1",
    HOME: layout.home,
    USERPROFILE: layout.home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: homePath,
    APPDATA: layout.appData,
    LOCALAPPDATA: layout.localAppData,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
  };
}

async function startIsolatedExecutor(options) {
  await assertFile(options.executorEntryPath, "executor_build_missing");
  const child = spawn(options.command, [
    options.executorEntryPath,
    "--data-root",
    options.dataRoot,
    "--bridge-entry",
    options.bridgeEntryPath,
    "--settings-directory",
    options.settingsDirectory,
  ], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => options.stderr?.capture(chunk));

  let ready;
  try {
    ready = await waitForExecutorReady(child, options.readyTimeoutMs);
  } catch (error) {
    if (error && typeof error === "object") error.executor_pid = child.pid ?? null;
    await terminateStartupFailure(child);
    throw error;
  }
  let stopPromise;
  return {
    pid: child.pid ?? null,
    ready,
    stop() {
      stopPromise ??= stopExecutorProcess(child, ready.pipe_name, options);
      return stopPromise;
    },
  };
}

function waitForExecutorReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `cost_lab_executor_ready_timeout${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
      ));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onStdout = (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-32_768);
      const line = stdout.split(/\r?\n/u).find((value) => value.startsWith("EXECUTOR_READY "));
      if (!line) return;
      let value;
      try {
        value = JSON.parse(line.slice("EXECUTOR_READY ".length));
      } catch {
        cleanup();
        reject(new Error("cost_lab_executor_ready_invalid"));
        return;
      }
      if (typeof value?.lease_id !== "string" || typeof value?.pipe_name !== "string") {
        cleanup();
        reject(new Error("cost_lab_executor_ready_invalid"));
        return;
      }
      cleanup();
      child.stdout.resume();
      resolve(value);
    };
    const onStderr = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    };
    const onError = () => {
      cleanup();
      reject(new Error("cost_lab_executor_spawn_failed"));
    };
    const onExit = () => {
      cleanup();
      const code = executorFailureCode(stderr);
      reject(new Error(
        `${code ? `cost_lab_executor_start_${code}` : "cost_lab_executor_exited_before_ready"}`
        + `\n${stderr.trim()}`,
      ));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function terminateStartupFailure(child) {
  if (child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    return;
  }
  await waitForChildExit(child, 5_000).catch(() => undefined);
}

async function stopExecutorProcess(child, pipeName, options) {
  if (child.exitCode !== null) {
    return { status: child.exitCode === 0 ? "closed" : "release_unknown", blockers: [] };
  }
  let client;
  try {
    const module = await import(pathToFileURL(options.executorEntryPath).href);
    if (typeof module.ExecutorControlClient !== "function") {
      return { status: "release_unknown", blockers: ["executor_control_client_unavailable"] };
    }
    client = new module.ExecutorControlClient({ pipeName, connectTimeoutMs: 5_000 });
    await client.connect();
    const response = await client.request("shutdown", {});
    const decision = response?.result;
    if (!response?.ok || !decision || typeof decision.status !== "string") {
      return {
        status: "release_unknown",
        blockers: [response?.error?.code ?? "executor_shutdown_response_invalid"],
      };
    }
    if (decision.status !== "accepted") {
      return {
        status: decision.status,
        blockers: Array.isArray(decision.blockers) ? decision.blockers : [],
      };
    }
    const exitCode = await waitForChildExit(child, options.shutdownTimeoutMs);
    return exitCode === 0
      ? { status: "closed", blockers: [] }
      : { status: "release_unknown", blockers: ["executor_exit_nonzero_or_unknown"] };
  } catch (error) {
    const exitCode = child.exitCode === null
      ? await waitForChildExit(child, Math.min(options.shutdownTimeoutMs, 5_000)).catch(() => null)
      : child.exitCode;
    if (exitCode === 0) return { status: "closed", blockers: [] };
    return {
      status: "release_unknown",
      blockers: [error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : "executor_shutdown_unknown"],
    };
  } finally {
    client?.close();
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("cost_lab_executor_exit_timeout"));
    }, timeoutMs);
    const onExit = (code) => {
      clearTimeout(timer);
      resolve(code);
    };
    child.once("exit", onExit);
  });
}

function executorFailureCode(stderr) {
  const match = /EXECUTOR_(?:START_FAILED|STARTUP_FAILED)\s+([a-z0-9_:.-]+)/iu.exec(stderr);
  return match?.[1]?.slice(0, 80) ?? null;
}

function buildTask(taskId, workspace, input) {
  if (input.taskMode === "code_edit") {
    return {
      task_id: taskId,
      workspace,
      model: {
        provider_id: input.provider,
        model_id: input.model,
        reasoning_level: input.reasoning,
      },
      objective:
        `Edit ${CODE_EDIT_RELATIVE_PATH} so its complete UTF-8 content is exactly ` +
        `${JSON.stringify(CODE_EDIT_EXPECTED_CONTENT)}. Read the file back after editing.`,
      requirements: [
        "Use the selected official provider and model.",
        `Modify only ${CODE_EDIT_RELATIVE_PATH}.`,
        "Use file tools; do not simulate the edit only in the final response.",
        "Read the edited file back before reporting completion.",
      ],
      allowed_paths: [CODE_EDIT_RELATIVE_PATH],
      forbidden_paths: ["..", ".git/**"],
      acceptance_criteria: [
        `${CODE_EDIT_RELATIVE_PATH} contains exactly the requested content.`,
        "The final response confirms the file was read back.",
      ],
      test_commands: [],
      context:
        "This is an owner-authorized Cost Lab end-to-end task. Keep the edit minimal and deterministic.",
    };
  }
  return {
    task_id: taskId,
    workspace,
    model: {
      provider_id: input.provider,
      model_id: input.model,
      reasoning_level: input.reasoning,
    },
    objective: `Return exactly ${RESPONSE_MARKER}. Do not modify, create, or delete files.`,
    requirements: [
      "Use the already selected Coding Plan provider and model.",
      "Do not run shell commands or edit the workspace.",
      `Return ${RESPONSE_MARKER} as the final response.`,
    ],
    allowed_paths: [],
    forbidden_paths: ["**/*"],
    acceptance_criteria: [
      `The final response contains ${RESPONSE_MARKER}.`,
      "No workspace files are changed.",
    ],
    test_commands: [],
    context: "This is an owner-authorized Cost Lab billing verification. Keep the task minimal.",
  };
}

async function inspectWorkspaceMutation(workspace, taskMode) {
  if (taskMode !== "code_edit") return null;
  const absolutePath = path.join(workspace, CODE_EDIT_RELATIVE_PATH);
  const [content, metadata] = await Promise.all([
    readFile(absolutePath, "utf8"),
    lstat(absolutePath),
  ]);
  return {
    relative_path: CODE_EDIT_RELATIVE_PATH,
    seed_sha256: createHash("sha256").update(CODE_EDIT_SEED_CONTENT, "utf8").digest("hex"),
    expected_sha256: createHash("sha256").update(CODE_EDIT_EXPECTED_CONTENT, "utf8").digest("hex"),
    observed_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: metadata.size,
    content_changed: content !== CODE_EDIT_SEED_CONTENT,
    content_match: content === CODE_EDIT_EXPECTED_CONTENT,
    content_preview: content.slice(0, 512),
  };
}

async function connectBridgeMcpClient(options) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ]);
  const stderr = options.stderr?.stream();
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    stderr: "pipe",
    maxBufferSize: options.maxBufferSize,
  });
  if (stderr) transport.stderr?.on("data", (chunk) => options.stderr.capture(chunk));
  const client = new Client({
    name: options.clientName,
    version: options.clientVersion,
  });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      let clientError;
      let transportError;
      try {
        await client.close();
      } catch (error) {
        clientError = error;
      }
      try {
        await transport.close();
      } catch (error) {
        transportError = error;
      }
      if (clientError ?? transportError) {
        throw clientError ?? transportError;
      }
    },
  };
}

async function callBridgeTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const structured = result?.structuredContent;
  if (result?.isError) {
    const structuredError = structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured.error
      : null;
    if (structuredError && typeof structuredError === "object" && typeof structuredError.code === "string") {
      const detail = typeof structuredError.message === "string" && structuredError.message.trim()
        ? `:${structuredError.message.trim()}`
        : "";
      const error = new Error(`${name}_rejected:${structuredError.code}${detail}`);
      error.code = structuredError.code;
      throw error;
    }
    const message = Array.isArray(result.content)
      ? result.content.map((item) => item?.type === "text" ? item.text : "").join("\n")
      : "Bridge MCP tool failed";
    throw new Error(`${name}_failed:${message.slice(0, 500)}`);
  }
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured;
  }
  const text = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text")?.text
    : null;
  if (typeof text !== "string") throw new Error(`${name}_structured_result_missing`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name}_structured_result_invalid`);
  }
}

async function waitForTerminalStatus(client, taskId, options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    assertNotAborted(options.signal);
    const status = await callBridgeTool(client, "zcode_status", { task_id: taskId });
    lastStatus = status;
    if (TERMINAL_STATUSES.has(status.status)) return status;
    await delay(options.pollIntervalMs, options.signal);
  }
  throw new Error(`bridge_task_timeout:${String(lastStatus?.status ?? "unknown")}`);
}

async function collectTaskEvents(client, taskId) {
  const events = [];
  let afterSeq = 0;
  for (let page = 0; page < 20; page += 1) {
    const result = await callBridgeTool(client, "zcode_events", {
      task_id: taskId,
      after_seq: afterSeq,
      limit: 200,
      wait_ms: 0,
      view: "raw",
      max_bytes: 16 * 1024 * 1024,
    });
    if (result.task_id !== taskId || !Array.isArray(result.events)) throw new Error("bridge_task_events_mismatch");
    const batch = result.events;
    events.push(...batch);
    const next = Number(result.next_seq);
    if (!Number.isSafeInteger(next) || next <= afterSeq || result.has_more !== true) break;
    afterSeq = next;
  }
  return events;
}

function extractUsageEvidence(result, events) {
  const sources = [];
  const candidates = [];
  if (result?.usage && hasTokenUsage(result.usage)) {
    sources.push("task_result.usage");
    candidates.push(result.usage);
  }
  for (const event of events) {
    const usage = event?.details?.usage;
    if (hasTokenUsage(usage)) {
      sources.push(`event.${event.seq}.turn_completed.usage`);
      candidates.push(usage);
    }
  }
  const selected = candidates.at(-1) ?? null;
  const observedAt = candidates
    .map((candidate) => candidate?.observed_at)
    .find((value) => typeof value === "string" && !Number.isNaN(new Date(value).getTime()));
  const usage = selected && observedAt && selected.observed_at === undefined
    ? { ...selected, observed_at: observedAt }
    : selected;
  return {
    usage,
    sources,
    auxiliary_usage_coverage: usage
      ? sources.length > 1 ? "PARTIAL_OR_AGGREGATE" : "MAIN_OR_AGGREGATE_ONLY"
      : "USAGE_MISSING",
  };
}

function hasTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cached_input_tokens",
  ].some((key) => Number.isSafeInteger(value[key]));
}

function publicEvidenceEvent(event) {
  return {
    seq: event.seq,
    at: event.at,
    type: event.type,
    summary: typeof event.summary === "string" ? event.summary.slice(0, 500) : "",
    details: event.details && typeof event.details === "object" ? event.details : undefined,
  };
}

function createBoundedStderrCollector() {
  const lines = [];
  let pending = "";
  let failureFacts = null;
  const stream = new PassThrough();
  return {
    stream: () => stream,
    capture(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (pending.length > 65_536) pending = pending.slice(-32_768);
      for (;;) {
        const index = pending.indexOf("\n");
        if (index < 0) break;
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        const parsedFailureFacts = parseWorkerFailureFactsMarker(line);
        if (parsedFailureFacts) failureFacts = parsedFailureFacts;
        if (isSafeBridgeMarker(line)) {
          lines.push(line.slice(0, 500));
          if (lines.length > 80) lines.shift();
        }
      }
    },
    markers() {
      return [...lines];
    },
    failureFacts() {
      return failureFacts ? { ...failureFacts } : null;
    },
  };
}

function parseWorkerFailureFactsMarker(line) {
  if (!line.startsWith(FAILURE_FACTS_PREFIX)) return null;
  const serialized = line.slice(FAILURE_FACTS_PREFIX.length);
  if (Buffer.byteLength(serialized, "utf8") > 4_096) return null;
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== FAILURE_FACTS_KEYS.length ||
      keys.some((key) => !FAILURE_FACTS_KEY_SET.has(key)) ||
      value.schema_version !== "1") {
    return null;
  }
  for (const key of FAILURE_FACTS_KEYS) {
    const item = value[key];
    if (item === null) continue;
    const type = typeof item;
    if (!["string", "number", "boolean"].includes(type)) return null;
    if (type === "string" && item.length > 128) return null;
    if (type === "number" && !Number.isFinite(item)) return null;
  }
  return Object.fromEntries(FAILURE_FACTS_KEYS.map((key) => [key, value[key]]));
}

function isSafeBridgeMarker(line) {
  return /^\[bridge\] (SQLITE_|runtime provenance|data root|max concurrent workers|received |[A-Za-z0-9_.+-]+ stdio MCP server ready)/u.test(line) ||
    /^\[bridge\] worker installed-runtime [a-zA-Z0-9][a-zA-Z0-9_-]{0,63} [1-9]\d{0,8} [0-9a-f]{64}$/u.test(line) ||
    /^\[bridge\] runtime-auth \{[^\r\n]{1,1024}\}$/u.test(line);
}

function bridgeMarkerCode(markers) {
  for (const marker of [...markers].reverse()) {
    const match = /^\[bridge\] (SQLITE_[A-Z0-9_]+):/u.exec(marker);
    if (match) return match[1];
  }
  return null;
}

function decorateVerificationError(error, phase) {
  if (!error || typeof error !== "object") return;
  if (error.code === "ERR_INVALID_ARG_VALUE") {
    error.code = `COST_LAB_${phase.toUpperCase()}_INVALID_ARGUMENT`;
  } else if (typeof error.code !== "string" || error.code.length === 0) {
    error.code = `COST_LAB_${phase.toUpperCase()}_FAILED`;
  }
}

async function assertFile(filePath, code) {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(code);
  } catch {
    throw new Error(code);
  }
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("cost_lab_verification_path_outside_run_root");
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("verification_aborted");
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("verification_aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("verification_aborted"));
    }, { once: true });
  });
}

function withTimeout(promise, milliseconds, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const PRODUCTION_VERIFICATION_CONTRACT = Object.freeze({
  provider: VERIFIED_PROVIDER,
  model: VERIFIED_MODEL,
  reasoning: "low",
  bridge_entry_relative: "plugins/codex-zcode-bridge/dist/bridge.mjs",
  host_profile: "isolated HOME + isolated ZCODE_BRIDGE_DATA_DIR",
  billing: "owned by coding-plan-billing.mjs, never this runner",
  model_call: "only after explicit web confirmation",
});
