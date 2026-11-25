import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from "playwright-core";
import { IsolatedAdmissionStore, digest } from "../src/sqlite-candidate/wp6b2b1/store.mjs";
import { SqliteLifecycleMcpAuthority } from "../src/manager/sqlite-lifecycle-mcp-authority.js";
import { createTrustedLocalCandidateContext } from "../src/executor/production-composition.js";
import { startExecutorControlServer } from "../src/executor/control-server.js";
import { ExecutorControlClient } from "../src/executor/control-client.js";
import { RemoteTaskManager } from "../src/executor/remote-task-manager.js";
import { executorPipeName } from "../src/executor/pipe.js";
import { createTaskConsoleServer } from "../src/web/server.js";

const chromePath = resolveChromeExecutable();
const OWNER_THREAD_ID = "019c0000-0000-7000-8000-000000000001";
const CODING_PLAN = "account:bigmodel-individual-coding-plan";
const START_PLAN = "account:bigmodel-start-plan";

function resolveChromeExecutable(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function iso(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

function allow(): { readonly state: "allow"; readonly fixture: true } {
  return { state: "allow", fixture: true };
}

function taskPackage(taskId: string, workspace: string, objective: string): Record<string, unknown> {
  return {
    task_id: taskId,
    workspace,
    objective,
    requirements: ["Synthetic browser fixture"],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: ["Exercise the Console"],
    test_commands: ["npm test"],
  };
}

function model(providerId: string, modelId: string): Record<string, unknown> {
  return {
    executor: "zcode",
    provider_id: providerId,
    model_id: modelId,
    requested_model: modelId,
    requested_reasoning_level: "low",
    effective_reasoning_level: "low",
    effective_reasoning_level_source: "runtime",
    selection_source: "browser-fixture",
    effective_at: iso(1),
    session_id: "synthetic-session",
    turn_id: "synthetic-turn",
  };
}

function usage(input: number | null, output: number | null, total: number | null): Record<string, unknown> {
  return {
    source: "runtime",
    scope: "attempt",
    observed_at: iso(2),
    finality: "reported",
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cached_input_tokens: input === 0 ? 0 : null,
    cached_write_input_tokens: null,
    reasoning_tokens: null,
    conflicts: [],
    dropped_unknown_keys: 0,
  };
}

function result(
  taskId: string,
  attempt: number,
  status: "completed" | "failed",
  summary: string,
  executionModel: Record<string, unknown>,
  executionUsage: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    task_id: taskId,
    attempt,
    status,
    summary,
    files_changed: ["src/example.ts"],
    tests: [{ command: "npm test", status: "passed" }],
    issues: status === "failed" ? ["Synthetic first-attempt failure"] : [],
    needs_master_decision: false,
    zcode_output: "SYNTHETIC WORKER / NOT REAL MODEL",
    exit_code: status === "completed" ? 0 : 1,
    session_id: "synthetic-session",
    started_at: iso(10),
    finished_at: iso(20),
    ...(status === "failed" ? { error_code: "synthetic_failure" } : {}),
    ...(executionUsage ? { usage: executionUsage } : {}),
    model: executionModel,
  };
}

function openAttempt(
  store: any,
  taskId: string,
  attempt: number,
  workspace: string,
  suffix: string,
): Record<string, any> {
  const operationId = `operation-${suffix}`;
  const launchId = `launch-${suffix}`;
  const admitted = store.admitOperation(
    { operation_id: operationId, task_id: taskId, attempt, workspace_ref: workspace },
    { workspaceValidator: allow, executionPermissionCheck: allow },
  );
  const launch = {
    operation_id: operationId,
    task_id: taskId,
    attempt,
    generation: admitted.generation,
    revision: admitted.revision,
    launch_id: launchId,
    launch_epoch: 1,
    launch_token: `synthetic-browser-token-${suffix}-012345`,
  };
  const intent = store.createLaunchIntent(launch);
  const processId = 45000 + attempt + suffix.length;
  const startFingerprint = `synthetic-start-${suffix}`;
  const receipt = store.recordLaunchReceipt({
    ...launch,
    revision: intent.revision,
    receipt_id: `receipt-${suffix}`,
    launch_identity: { source: "synthetic_fixture", fixture: true, process_id: processId, start_fingerprint: startFingerprint },
  });
  store.commitPermanentClaim({
    ...launch,
    revision: receipt.revision,
    claim_id: `claim-${suffix}`,
    worker_identity: {
      source: "synthetic_fixture",
      fixture: true,
      worker_id: `worker-${suffix}`,
      incarnation: `incarnation-${suffix}`,
      process_id: processId,
      start_fingerprint: startFingerprint,
    },
  });
  const operation = store.readOperation(operationId);
  return {
    operation_id: operationId,
    task_id: taskId,
    attempt,
    generation: operation.generation,
    revision: operation.revision,
    claim_id: operation.claim_id,
    claim_worker_identity_digest: operation.claim_worker_identity_digest,
    launch_receipt_digest: operation.launch_receipt_digest,
    process_id: processId,
    start_fingerprint: startFingerprint,
  };
}

function commit(
  store: any,
  ref: Record<string, any>,
  value: Record<string, unknown>,
): void {
  const operation = store.readOperation(ref.operation_id);
  store.commitResult({
    operation_id: ref.operation_id,
    task_id: ref.task_id,
    attempt: ref.attempt,
    generation: ref.generation,
    revision: operation.revision,
    claim_id: ref.claim_id,
    claim_worker_identity_digest: ref.claim_worker_identity_digest,
    result_status: value.status,
    result: value,
  });
}

function cleanupEvidence(store: any, ref: Record<string, any>): Record<string, unknown> {
  const operation = store.readOperation(ref.operation_id);
  return {
    source: "synthetic_fixture",
    fixture: true,
    operation_id: ref.operation_id,
    task_id: ref.task_id,
    attempt: ref.attempt,
    generation: ref.generation,
    claim_id: ref.claim_id,
    worker_identity_digest: ref.claim_worker_identity_digest,
    launch_receipt_digest: ref.launch_receipt_digest,
    result_commit_ref: operation.result_commit_ref,
    process_tree_digest: digest({ root: ref.process_id, start: ref.start_fingerprint, children: [] }),
    resources_digest: digest({ operation: ref.operation_id, resources: [] }),
    root_process_id: ref.process_id,
    root_start_fingerprint: ref.start_fingerprint,
    worker_tree_complete: true,
    operation_resources_complete: true,
    workspace_touched: false,
  };
}

function release(store: any, ref: Record<string, any>): number {
  const operation = store.readOperation(ref.operation_id);
  const fence = {
    operation_id: ref.operation_id,
    task_id: ref.task_id,
    attempt: ref.attempt,
    generation: ref.generation,
    revision: operation.revision,
    claim_id: ref.claim_id,
    claim_worker_identity_digest: ref.claim_worker_identity_digest,
  };
  const pending = store.beginCleanup(fence);
  const verified = store.recordCleanupEvidence({
    ...fence,
    revision: pending.revision,
    outcome: "verified",
    cleanup_evidence: cleanupEvidence(store, ref),
  });
  const released = store.releaseCapacity({
    ...fence,
    revision: verified.revision,
    cleanup_digest: verified.cleanup_digest,
  });
  return released.revision;
}

function leaveCleanupUnverified(store: any, ref: Record<string, any>): void {
  const operation = store.readOperation(ref.operation_id);
  const fence = {
    operation_id: ref.operation_id,
    task_id: ref.task_id,
    attempt: ref.attempt,
    generation: ref.generation,
    revision: operation.revision,
    claim_id: ref.claim_id,
    claim_worker_identity_digest: ref.claim_worker_identity_digest,
  };
  const pending = store.beginCleanup(fence);
  store.recordCleanupEvidence({
    ...fence,
    revision: pending.revision,
    outcome: "unverified",
    probe_state: "unknown",
    reason: "synthetic_browser_cleanup_unknown",
  });
}

function appendSyntheticEvents(store: any, ref: Record<string, any>, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    store.appendRuntimeTaskEvent({
      operation_id: ref.operation_id,
      task_id: ref.task_id,
      attempt: ref.attempt,
      generation: ref.generation,
      claim_id: ref.claim_id,
      worker_sequence: index,
      event_type: index % 2 === 1 ? "model_output" : "tool_status",
      at: iso(1000 + index),
      summary: `Synthetic Worker event ${index} / NOT REAL MODEL`,
      details: { index, fixture: "SYNTHETIC WORKER / NOT REAL MODEL" },
    });
  }
}

function wake(store: any, ref: Record<string, any>, state: string, suffix: string, extra: Record<string, unknown> = {}): void {
  store.recordExecutorWakeObservation({
    operation_id: ref.operation_id,
    task_id: ref.task_id,
    attempt: ref.attempt,
    generation: ref.generation,
    state,
    thread_id: OWNER_THREAD_ID,
    delivery_id: digest({ contract: "browser-e2e-wake-delivery-v1", task: ref.task_id, attempt: ref.attempt, suffix }),
    policy_digest: digest({ policy: "browser-e2e" }),
    authorization_digest: digest({ authorization: "browser-e2e" }),
    reason_code: "loaded_idle_exact_config",
    ...extra,
  });
}

interface SeededConsole {
  readonly dataRoot: string;
  readonly settingsDirectory: string;
  readonly doneTaskId: string;
  readonly doneWorkspace: string;
  readonly cleanupTaskId: string;
  readonly cleanupWorkspace: string;
  readonly attentionTaskId: string;
  readonly attentionWorkspace: string;
  readonly queuedTaskId: string;
  readonly queuedWorkspace: string;
  readonly wakeUnknownTaskId: string;
  readonly wakeUnknownWorkspace: string;
}

function seedConsole(dataRoot: string): SeededConsole {
  const workspaceRoot = path.join(dataRoot, "workspaces");
  mkdirSync(workspaceRoot, { recursive: true });
  const store: any = IsolatedAdmissionStore.initialize(dataRoot, { managedDataDirectory: true });
  try {
    store.provisionCapacity({
      operation_id: "browser-policy",
      capacity_limit: 8,
      expected_generation: 0,
      maintenance: { dispatch_blocked: true, writers_drained: true },
    });
    const doneWorkspace = path.join(workspaceRoot, "done");
    const cleanupWorkspace = path.join(workspaceRoot, "cleanup");
    const attentionWorkspace = path.join(workspaceRoot, "attention");
    const queuedWorkspace = path.join(workspaceRoot, "queued");
    const wakeUnknownWorkspace = path.join(workspaceRoot, "wake-unknown");
    for (const workspace of [doneWorkspace, cleanupWorkspace, attentionWorkspace, queuedWorkspace, wakeUnknownWorkspace]) mkdirSync(workspace, { recursive: true });

    const doneTaskId = "task-done";
    store.createTask(taskPackage(doneTaskId, doneWorkspace, "Deliver the completed Attempt"), iso(0));
    const first = openAttempt(store, doneTaskId, 1, doneWorkspace, "done-a1");
    commit(store, first, result(doneTaskId, 1, "failed", "Synthetic first attempt failed.", model(CODING_PLAN, "GLM-5.3-Flash"), usage(0, 0, 0)));
    const firstReleasedRevision = release(store, first);
    store.createNextAttempt({
      operation_id: "continue-done-a2",
      task_id: doneTaskId,
      feedback: "Retry after the synthetic first-attempt failure.",
      additional_requirements: [],
      previous_attempt: 1,
      previous_operation_id: first.operation_id,
      expected_generation: first.generation,
      expected_revision: firstReleasedRevision,
      claim_id: first.claim_id,
      claim_worker_identity_digest: first.claim_worker_identity_digest,
    }, { workspaceValidator: allow, executionPermissionCheck: allow });
    const second = openAttempt(store, doneTaskId, 2, doneWorkspace, "done-a2");
    appendSyntheticEvents(store, second, 245);
    commit(store, second, result(doneTaskId, 2, "completed", "Synthetic second attempt delivered the reviewed change.", model(START_PLAN, "GLM-5.3"), usage(120, 30, 150)));
    release(store, second);
    wake(store, second, "intent", "done-delivery");
    wake(store, second, "queued", "done-delivery", { queue_message_id: "019c0000-0000-7000-8000-000000000099" });
    wake(store, second, "turn_started", "done-delivery");

    const cleanupTaskId = "task-cleanup";
    store.createTask(taskPackage(cleanupTaskId, cleanupWorkspace, "Hold an unverified Cleanup for review"), iso(30));
    const cleanupAttempt = openAttempt(store, cleanupTaskId, 1, cleanupWorkspace, "cleanup-a1");
    commit(store, cleanupAttempt, result(cleanupTaskId, 1, "completed", "Synthetic Result with unverified Cleanup.", model(CODING_PLAN, "GLM-5.3-Flash"), null));
    leaveCleanupUnverified(store, cleanupAttempt);

    const attentionTaskId = "task-attention";
    store.createTask(taskPackage(attentionTaskId, attentionWorkspace, "Ask for an explicit permission decision"), iso(40));
    const attentionAttempt = openAttempt(store, attentionTaskId, 1, attentionWorkspace, "attention-a1");
    const attentionOperation = store.readOperation(attentionAttempt.operation_id);
    store.recordInteractionRequest({
      operation_id: attentionAttempt.operation_id,
      task_id: attentionAttempt.task_id,
      attempt: attentionAttempt.attempt,
      generation: attentionAttempt.generation,
      claim_id: attentionAttempt.claim_id,
      worker_identity_digest: attentionAttempt.claim_worker_identity_digest,
      expected_revision: attentionOperation.revision,
      request: {
        request_id: "request-permission-browser",
        method: "interaction/requestPermission",
        params: { tool: "shell", command: "npm test", description: "Synthetic permission request" },
      },
    });

    const queuedTaskId = "task-queued";
    store.createTask(taskPackage(queuedTaskId, queuedWorkspace, "Remain queued behind the dispatch fence"), iso(50));

    const wakeUnknownTaskId = "task-wake-unknown";
    store.createTask(taskPackage(wakeUnknownTaskId, wakeUnknownWorkspace, "Require Wake reconciliation before action"), iso(60));
    const wakeUnknownAttempt = openAttempt(store, wakeUnknownTaskId, 1, wakeUnknownWorkspace, "wake-unknown-a1");
    commit(store, wakeUnknownAttempt, result(wakeUnknownTaskId, 1, "completed", "Synthetic Result with an unknown Queue submission.", model(CODING_PLAN, "GLM-5.3-Flash"), usage(10, 5, 15)));
    release(store, wakeUnknownAttempt);
    wake(store, wakeUnknownAttempt, "intent", "wake-unknown-delivery");
    wake(store, wakeUnknownAttempt, "submission_unknown", "wake-unknown-delivery");

    return {
      dataRoot,
      settingsDirectory: path.join(dataRoot, "settings"),
      doneTaskId,
      doneWorkspace,
      cleanupTaskId,
      cleanupWorkspace,
      attentionTaskId,
      attentionWorkspace,
      queuedTaskId,
      queuedWorkspace,
      wakeUnknownTaskId,
      wakeUnknownWorkspace,
    };
  } finally {
    store.close();
  }
}

async function waitForText(page: Page, selector: string, text: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    ({ selector: target, text: expected }) => document.querySelector(target)?.textContent?.includes(expected) === true,
    { selector, text },
    { timeout },
  );
}

async function waitForCount(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForFunction(
    ({ selector: target, value: expected }) => document.querySelector(target)?.textContent?.trim() === expected,
    { selector, value },
    { timeout: 15_000 },
  );
}

test("real SQLite Authority drives the single-page Task Console in Chromium", {
  timeout: 180_000,
  skip: chromePath === null ? "Google Chrome is not installed for the browser E2E" : false,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "web-console-authority-"));
  const seeded = seedConsole(root);
  mkdirSync(seeded.settingsDirectory, { recursive: true });
  const host = { name: "web-console-browser", settingsDirectory: seeded.settingsDirectory };
  const workerEntryPath = path.resolve("dist-test/src/worker/worker-main.js");
  const bridgeEntryPath = fileURLToPath(import.meta.url);
  let authority: SqliteLifecycleMcpAuthority | null = null;
  let control: Awaited<ReturnType<typeof startExecutorControlServer>> | null = null;
  let client: ExecutorControlClient | null = null;
  let consoleServer: ReturnType<typeof createTaskConsoleServer> | null = null;
  let browser: BrowserContext | null = null;
  const profileBase = path.join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp");
  mkdirSync(profileBase, { recursive: true });
  const profile = mkdtempSync(path.join(profileBase, `bridge-web-console-authority-${process.pid}-`));
  const pageErrors: string[] = [];
  const pageRequests: string[] = [];
  try {
    authority = await SqliteLifecycleMcpAuthority.create({
      dataRoot: seeded.dataRoot,
      databaseFileName: "operations.sqlite3",
      managedDataDirectory: true,
      workerEntryPath,
      bridgeEntryPath,
      hostProfile: host,
      trustedLocalContext: createTrustedLocalCandidateContext(host),
      testOnlyFakeAdapter: true,
      testProcessProbeTimeoutMs: 25,
      testShutdownWaitMs: 2_000,
      dispatchFence: () => "browser_e2e_dispatch_fence",
    });
    const pipeName = executorPipeName(seeded.dataRoot);
    control = await startExecutorControlServer({
      pipeName,
      manager: authority,
      leaseId: "lease-browser-console",
      executorIdleState: () => ({ idle: true, blockers: [] }),
    });
    client = new ExecutorControlClient({ pipeName });
    await client.connect();
    const remote = new RemoteTaskManager(client);
    consoleServer = createTaskConsoleServer({
      manager: remote,
      consoleId: "console-browser-authority",
      authorityRootDigest: "a".repeat(64),
      settingsDirectory: seeded.settingsDirectory,
      executorStatus: async () => {
        const response = await client!.request("executorStatus", {});
        if (!response.ok) throw Object.assign(new Error(response.error?.message ?? "EXECUTOR_STATUS_FAILED"), {
          code: response.error?.code ?? "EXECUTOR_STATUS_FAILED",
        });
        return response.result ?? {};
      },
    });
    const address = await consoleServer.start();

    browser = await chromium.launchPersistentContext(profile, {
      executablePath: chromePath!,
      headless: true,
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
      args: ["--disable-background-networking", "--no-first-run"],
      env: { ...process.env, HOME: userInfo().homedir, USERPROFILE: userInfo().homedir },
    });
    const page = browser.pages()[0] ?? await browser.newPage();
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("request", (request: PlaywrightRequest) => pageRequests.push(request.url()));

    await page.goto(`${address.origin}/?task_id=${seeded.doneTaskId}`, { waitUntil: "domcontentloaded" });
    await page.selectOption("#language", "en");
    await page.waitForFunction(
      () => document.querySelector("#task-detail .detail-context .mono")?.textContent === "task-done",
      undefined,
      { timeout: 15_000 },
    );
    await waitForText(page, "#task-detail", "Completed is not acceptance");
    await waitForCount(page, "#count-running", "1");
    await waitForCount(page, "#count-attention", "3");
    await waitForCount(page, "#count-completed", "1");
    assert.equal(new URL(page.url()).searchParams.get("task_id"), "task-done");
    assert.equal(await page.locator("#executor-state").textContent(), "ACTIVE");
    assert.equal(await page.locator(".detail-panel .panel-head h2").textContent(), "Task workspace");
    assert.equal(
      await page.locator("#experimental-notice").innerText(),
      "Experimental: task status and recovery operations are still being refined.",
    );
    assert.equal(
      await page.locator(".task-row[data-task-id='task-done'] .task-workspace").textContent(),
      seeded.doneWorkspace,
    );
    assert.equal(await page.locator(".task-list .table-head").count(), 0);
    assert.equal(await page.locator(".task-row .task-main").count(), 5);
    assert.equal(
      await page.locator(".task-row[data-task-id='task-done'] .review-chip").textContent(),
      "Review ready",
    );
    assert.equal(
      await page.locator(".task-row[data-task-id='task-wake-unknown'] .review-chip").textContent(),
      "Review blocked",
    );
    assert.match(
      await page.locator(".task-row[data-task-id='task-wake-unknown'] .task-attention").textContent() ?? "",
      /Wake submission unknown/u,
    );
    assert.match(
      await page.locator(".task-row[data-task-id='task-done'] .task-usage-line").textContent() ?? "",
      /total 150 \/ in 120 \/ out 30/u,
    );
    const visibleEnglishCopy = await page.locator("body").innerText();
    for (const forbidden of [
      "DURABLE TASK AUTHORITY",
      "Follow the original Attempt",
      "SQLite Authority",
      "Executor 的持久事实",
      "Choose a Task to inspect durable evidence",
      "READ-ONLY PROJECTION",
      "Cost Lab",
      "0.67",
    ]) {
      assert.equal(
        visibleEnglishCopy.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `retired internal copy must not be visible: ${forbidden}`,
      );
    }
    const doneCapabilities = await page.evaluate(async () => {
      const response = await fetch("/api/tasks/task-done/console");
      return (await response.json() as { result: { action_capabilities: Record<string, unknown> } }).result.action_capabilities;
    });
    assert.equal(doneCapabilities.can_continue, true);
    assert.equal(doneCapabilities.can_rework, true);
    assert.deepEqual(doneCapabilities.blockers, []);

    const sections = await page.locator("#task-detail [data-section]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-section")));
    assert.deepEqual(sections, [
      "overview",
      "actions",
      "acceptance",
      "attempts",
      "result",
      "usage",
      "execution-facts",
      "events",
    ]);
    await waitForText(page, "#task-detail", "Start Plan");
    await waitForText(page, "#task-detail", "150");
    assert.equal(await page.getByRole("button", { name: "Create related rework" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Continue" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Accept" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Force release" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Clear Hold" }).count(), 0);
    await waitForText(page, "#task-detail", "Plan · Start Plan");
    await waitForText(page, "#task-detail", "Discount · Not applicable");
    await waitForText(page, "#task-detail", "Effort: low");
    assert.equal(await page.locator(".usage-column").count(), 2);
    assert.equal(
      await page.locator(".usage-fact").filter({ hasText: "Cache read" }).locator("strong").textContent(),
      "Not observed",
    );

    await page.locator(".filter[data-filter='attention']").click();
    assert.equal(await page.locator(".task-row").count(), 3);
    assert.ok(await page.locator(".task-row").first().evaluate((node) => node.classList.contains("attention")));
    await page.locator(".filter[data-filter='attention']").click();
    assert.equal(await page.locator(".task-row").count(), 5);

    await page.locator(".attempt").filter({ hasText: "Attempt #1" }).click();
    await waitForText(page, "#task-detail", "Result for Attempt 1");
    await waitForText(page, "#task-detail", "Coding Plan");
    const firstInput = page.locator(".usage-fact").filter({ hasText: "Input tokens" }).locator("strong");
    assert.equal(await firstInput.textContent(), "0", "a real zero must remain zero instead of becoming missing");
    await page.locator(".attempt").filter({ hasText: "Attempt #2" }).click();
    await waitForText(page, "#task-detail", "Result for Attempt 2");
    const secondTotal = page.locator(".usage-fact").filter({ hasText: "Total tokens" }).locator("strong");
    assert.equal(await secondTotal.textContent(), "150");
    await waitForText(page, "#task-detail", "Provider actual cost: Not observed");
    await waitForText(page, "#task-detail", "No provider settlement was recorded for this Attempt.");
    const providerCosts = await page.evaluate(async () => {
      const response = await fetch("/api/tasks/task-done/console");
      const body = await response.json() as {
        result: { attempts: Array<{ usage: { provider_cost: Record<string, unknown> } }> };
      };
      return body.result.attempts.map((attempt) => attempt.usage.provider_cost);
    });
    assert.ok(providerCosts.length >= 2);
    for (const providerCost of providerCosts) {
      assert.deepEqual(providerCost, {
        state: "not_observed",
        scope: "per_attempt",
        amount: null,
        currency: null,
        reason_code: "bridge_authority_has_no_provider_settlement",
      });
    }

    await page.locator("details.events > summary").click();
    await waitForText(page, "#events-body", "All Events loaded", 20_000);
    const eventRows = await page.locator("#events-body .event-row").count();
    assert.ok(eventRows >= 245, `full Events pagination must load past the 200-row page, got ${eventRows}`);
    await page.locator("details.events > summary").click();

    await page.getByRole("button", { name: "Diagnostics" }).click();
    await page.waitForFunction(() => document.querySelector("#diagnostics")?.hasAttribute("open") === true);
    await waitForText(page, "#diag-output", "Settings loaded");
    assert.equal(
      pageRequests.some((url) => url.includes("/api/runtime") || url.includes("/api/cost-lab")),
      false,
      "opening Diagnostics must not run Runtime or Billing reads",
    );
    const evidenceDirectory = process.env.BRIDGE_BROWSER_EVIDENCE_DIR
      ?? path.resolve("docs/reports/preview17-c-webui-20261125/screenshots");
    mkdirSync(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDirectory, "diagnostics.png"), fullPage: true });
    await page.getByRole("button", { name: "Close" }).click();

    await page.selectOption("#theme", "light");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    await page.screenshot({ path: path.join(evidenceDirectory, "tasks-desktop-light.png"), fullPage: true });
    await page.selectOption("#theme", "dark");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.screenshot({ path: path.join(evidenceDirectory, "tasks-desktop-dark.png"), fullPage: true });
    await page.selectOption("#language", "zh-CN");
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    await waitForText(page, "#task-detail", "Completed 不等于验收");
    await waitForText(page, "#experimental-notice", "实验性功能：任务状态与恢复操作仍在持续完善。");
    assert.equal(await page.locator(".detail-panel .panel-head h2").textContent(), "任务工作台");
    await page.screenshot({ path: path.join(evidenceDirectory, "task-detail-attempts.png"), fullPage: true });
    await page.selectOption("#language", "en");
    await waitForText(page, "#experimental-notice", "Experimental: task status and recovery operations are still being refined.");

    await page.getByRole("button", { name: "Create related rework" }).click();
    await page.locator(".form-card textarea[name='feedback']").fill("Synthetic reviewer asks for a linked rework.");
    const [reworkResponse] = await Promise.all([
      page.waitForResponse((response: PlaywrightResponse) =>
        response.request().method() === "POST" && response.url().endsWith("/api/tasks/task-done/rework")),
      page.getByRole("button", { name: "Create rework Task" }).click(),
    ]);
    const reworkReceipt = (await reworkResponse.json() as {
      result: { task_id: string; relationship: string; source_task_id: string; source_attempt: number };
    }).result;
    assert.equal(reworkReceipt.relationship, "context_only");
    assert.equal(reworkReceipt.source_task_id, "task-done");
    assert.equal(reworkReceipt.source_attempt, 2);
    await page.waitForFunction(
      (taskId: string) => Array.from(document.querySelectorAll(".task-row"))
        .some((row) => (row as HTMLElement).getAttribute("data-task-id") === taskId),
      reworkReceipt.task_id,
      { timeout: 20_000 },
    );
    const linkedProjection = await page.evaluate(async (taskId: string) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId!)}/console`);
      return response.json();
    }, reworkReceipt.task_id);
    assert.equal(linkedProjection.result.task_id, reworkReceipt.task_id);
    assert.equal(linkedProjection.result.task.context, undefined);

    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".form-card textarea[name='feedback']").fill("Continue the synthetic Task after review.");
    const [continueResponse] = await Promise.all([
      page.waitForResponse((response: PlaywrightResponse) =>
        response.request().method() === "POST" && response.url().endsWith("/api/tasks/task-done/continue")),
      page.getByRole("button", { name: "Start continuation" }).click(),
    ]);
    const continueBody = await continueResponse.text();
    assert.equal(continueResponse.status(), 200, continueBody);
    await page.waitForFunction(
      () => document.querySelector("#task-detail")?.textContent?.includes("Attempt #3") === true,
      undefined,
      { timeout: 20_000 },
    );
    await waitForText(page, "#task-detail", "A Worker or dispatch is active");
    assert.equal(await page.getByRole("button", { name: "Create related rework" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Continue" }).count(), 0);

    await page.locator(".task-row").filter({ hasText: "task-cleanup" }).click();
    await waitForText(page, "#task-detail", "Cleanup unverified");
    await waitForText(page, "#task-detail", "Usage was not observed. This is not zero.");
    await waitForText(page, "#task-detail", "Provider actual cost: Not observed");
    await waitForText(page, "#task-detail", "No provider settlement was recorded for this Attempt.");
    const cleanupCapabilities = await page.evaluate(async () => {
      const response = await fetch("/api/tasks/task-cleanup/console");
      return (await response.json() as { result: { action_capabilities: Record<string, unknown> } }).result.action_capabilities;
    });
    assert.equal(cleanupCapabilities.can_continue, false);
    assert.equal(cleanupCapabilities.can_rework, false);
    assert.equal(cleanupCapabilities.can_recover_cleanup, true);
    assert.ok((cleanupCapabilities.blockers as string[]).includes("cleanup_unverified"));
    assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Create related rework", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Recover Cleanup" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Force release" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Clear Hold" }).count(), 0);
    let cleanupDialog = "";
    page.once("dialog", async (dialog) => {
      cleanupDialog = dialog.message();
      await dialog.accept();
    });
    const [cleanupRecoveryResponse] = await Promise.all([
      page.waitForResponse((response: PlaywrightResponse) =>
        response.request().method() === "POST" && response.url().endsWith("/api/tasks/task-cleanup/recover-cleanup")),
      page.getByRole("button", { name: "Recover Cleanup" }).click(),
    ]);
    const cleanupRecoveryBody = await cleanupRecoveryResponse.text();
    assert.equal(cleanupRecoveryResponse.status(), 500, cleanupRecoveryBody);
    assert.match(cleanupDialog, /Cleanup/u);
    const cleanupFailure = JSON.parse(cleanupRecoveryBody) as {
      error: { code: string; message: string };
    };
    assert.equal(cleanupFailure.error.code, "CANCEL_FAILED");
    assert.match(cleanupFailure.error.message, /worker_identity_unverifiable/u);
    await waitForText(page, "#task-detail", "Cleanup unverified");
    assert.equal(await page.getByRole("button", { name: "Recover Cleanup" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Create related rework", exact: true }).count(), 0);
    await page.screenshot({ path: path.join(evidenceDirectory, "cleanup-blocked.png"), fullPage: true });

    await page.locator(".task-row").filter({ hasText: "task-attention" }).click();
    await waitForText(page, "#task-detail", "request-permission-browser");
    const attentionCapabilities = await page.evaluate(async () => {
      const response = await fetch("/api/tasks/task-attention/console");
      return (await response.json() as { result: { action_capabilities: Record<string, unknown> } }).result.action_capabilities;
    });
    assert.equal(attentionCapabilities.can_continue, false);
    assert.equal(attentionCapabilities.can_rework, false);
    assert.ok((attentionCapabilities.blockers as string[]).includes("pending_interaction"));
    assert.ok((attentionCapabilities.blockers as string[]).includes("worker_active"));
    assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Create related rework", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Reply", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Send reply" }).count(), 1);

    await page.locator(".task-row").filter({ hasText: "task-queued" }).click();
    await waitForText(page, "#task-detail", "task-queued");
    const queuedCapabilities = await page.evaluate(async () => {
      const response = await fetch("/api/tasks/task-queued/console");
      return (await response.json() as { result: { action_capabilities: Record<string, unknown> } }).result.action_capabilities;
    });
    assert.equal(queuedCapabilities.can_continue, false);
    assert.equal(queuedCapabilities.can_rework, false);
    assert.ok((queuedCapabilities.blockers as string[]).includes("worker_active"));
    assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Create related rework", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Request cancel", exact: true }).count(), 1);

    await page.locator(".task-row").filter({ hasText: "task-wake-unknown" }).click();
    await waitForText(page, "#task-detail", "Wake submission unknown");
    const wakeUnknownCapabilities = await page.evaluate(async () => {
      const response = await fetch("/api/tasks/task-wake-unknown/console");
      return (await response.json() as { result: { action_capabilities: Record<string, unknown> } }).result.action_capabilities;
    });
    assert.equal(wakeUnknownCapabilities.can_continue, false);
    assert.equal(wakeUnknownCapabilities.can_rework, false);
    assert.ok((wakeUnknownCapabilities.blockers as string[]).includes("wake_submission_unknown"));
    assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Create related rework", exact: true }).count(), 0);

    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator(".task-row").filter({ hasText: "task-done" }).click();
    await waitForText(page, "#task-detail", "task-done");
    await page.screenshot({ path: path.join(evidenceDirectory, "tasks-narrow.png"), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `narrow layout must not overflow horizontally (${overflow}px)`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#task-detail .detail-context .mono")?.textContent === "task-done",
      undefined,
      { timeout: 15_000 },
    );
    assert.equal(new URL(page.url()).searchParams.get("task_id"), "task-done");
    assert.equal(await page.evaluate(() => localStorage.getItem("bridge.ui.theme")), "dark");
    assert.equal(await page.evaluate(() => localStorage.getItem("bridge.ui.language")), "en");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close().catch(() => undefined);
    await consoleServer?.close().catch(() => undefined);
    client?.close();
    await control?.close().catch(() => undefined);
    await authority?.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
