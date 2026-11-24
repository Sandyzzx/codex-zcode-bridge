import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ClaimOnlyWorkerProcess } from "../../../src/manager/spawn-worker.js";

import { SqliteLifecycleMcpAuthority } from "../../../src/manager/sqlite-lifecycle-mcp-authority.js";

import { createTrustedLocalCandidateContext, createHostStartPlanIssuer } from "../../../src/executor/production-composition.js";

import type { ProductionAuthIssuer } from "../../../src/runtime/start-plan-production-auth.js";
import { loadLifecycleCandidateModules } from "../../../src/store/lifecycle-gate.js";
import { PrivateCredentialLease } from "../../../src/runtime/start-plan-private-lease.js";
import { createPlatformProbe } from "../../../src/runtime/process-probe.js";

import { workerEntryPath, contentObject, syntheticTask, waitForTerminal, waitForLifecycleEvent, waitForInteractionRequest, withRealAdapterMcp, operationFor, HOST_ACCOUNT, HOST_DEVICE_MID, HOST_JWT, fakeHostBillingGate, hostIssuerFactory } from "./mvp-real-adapter-harness.js";
import type { FakeRuntimeFixture } from "./mvp-real-adapter-harness.js";

test("Start Plan without official auth is rejected before task persistence or Provider requests", { timeout: 120_000 }, async () => {
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `private-auth-missing-${randomUUID()}`;
    const rejected = await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId),
      model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } });
    assert.equal(rejected.isError, true);
    const error = rejected.structuredContent as { error?: { code?: string; message?: string } } | undefined;
    assert.equal(error?.error?.code, "TASK_INVALID");
    assert.match(error?.error?.message ?? "", /Start Plan credentials are unavailable/u);
    const status = await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } });
    assert.equal(status.isError, true);
    assert.equal(existsSync(runtime.requestLog), false, "no app-server Provider or model request may start");
  }, { preserveFixtureOnFailure: true });
});

for (const variant of ["private-auth", "private-auth-echo", "private-auth-split-echo"] as const) test(`SQLite Worker private auth ${variant} keeps synthetic credential out of persisted output`, { timeout: 120_000 }, async () => {
  const stderr = { lines: [] as string[] };
  let workerArgs: readonly string[] | undefined;
  await withRealAdapterMcp(async (client, manager, dataRoot, workspace, runtime) => {
    const taskId = `private-auth-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId),
      model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal(created.status, "queued");
    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, "completed");
    if (variant === "private-auth-split-echo") {
      const events = contentObject(await client.callTool({
        name: "zcode_events",
        arguments: { task_id: taskId, after_seq: 0, limit: 200 },
      })).events as Array<Record<string, unknown>>;
      const visibleOutput = events.filter((event) => event.type === "model_output")
        .map((event) => String(event.summary)).join("");
      assert.match(visibleOutput, /before \[REDACTED\] after/u,
        "credential fragments must be redacted after consecutive deltas are joined");
    }
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.filter((item) => item.auth_applied === true).length, 1);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const item = path.join(directory, name); const stat = lstatSync(item);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) scan(item);
        else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`);
      }
    };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
    assert.equal(Buffer.from(stderr.lines.join("")).includes(marker), false);
    assert.ok(workerArgs);
    assert.equal(Buffer.from(JSON.stringify(workerArgs)).includes(marker), false);
    assert.equal(JSON.stringify({ status, result }).includes(marker.toString()), false);
  }, { runtimeVariant: variant, stderrCollector: stderr, onWorkerSpawn: (child) => { workerArgs = [...child.spawnargs]; }, preserveFixtureOnFailure: true });
});

for (const variant of ["private-auth-multi-iteration", "private-auth-concurrent"] as const) {
  test(`SQLite Worker ${variant} reuses one delivered credential for repeated runtime-header requests`, { timeout: 120_000 }, async () => {
    const issueCount = { count: 0 };
    const stderr = { lines: [] as string[] };
    try {
      await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
        const taskId = `auth-repeat-${variant === "private-auth-concurrent" ? "parallel" : "sequential"}-${randomUUID()}`;
        contentObject(await client.callTool({ name: "zcode_task", arguments: {
          ...syntheticTask(workspace, taskId),
          model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
        } }));
        if (variant === "private-auth-multi-iteration") {
          const interaction = await waitForInteractionRequest(client, taskId);
          const details = interaction.details as Record<string, unknown>;
          const requestId = String(details.request_id ?? (details.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
          contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: {
            task_id: taskId,
            request_id: requestId,
            decision: "allow",
          } }));
        }
        assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
        await waitForLifecycleEvent(client, taskId, "released");
        const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const authResults = requests.filter((item) => item.auth_applied === true);
        assert.equal(authResults.length, 2, "both runtime-header requests must receive the credential");
        assert.ok(authResults.every((item) => item.same_credential === true), "the second request must reuse the cached credential");
        assert.equal(issueCount.count, 1, "repeated requests must not create a conflicting private lease");
        const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
        const scan = (directory: string): void => {
          for (const name of readdirSync(directory)) {
            const item = path.join(directory, name);
            const stat = lstatSync(item);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) scan(item);
            else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`);
          }
        };
        scan(dataRoot);
        assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
        assert.equal(Buffer.from(stderr.lines.join("")).includes(marker), false);
      }, { runtimeVariant: variant, issueCount, stderrCollector: stderr, preserveFixtureOnFailure: true });
    } catch (error) {
      console.error("worker stderr:\n" + stderr.lines.join("\n"));
      throw error;
    }
  });
}

for (const variant of ["private-auth-wrong-turn", "private-auth-wrong-claim", "private-auth-account-switch"] as const) {
  test(`SQLite Worker rejects ${variant} without provider fallback`, { timeout: 120_000 }, async () => {
    const issueCount = { count: 0 };
    const lifecycleCollector = { lines: [] as string[] };
    const stderrCollector = { lines: [] as string[] };
    let fixtureRuntime: FakeRuntimeFixture | undefined;
    try { await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
      fixtureRuntime = runtime;
      const taskId = `private-reject-${randomUUID()}`;
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
        ...syntheticTask(workspace, taskId),
        model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
      } }));
      assert.equal(created.status, "queued");
      const status = await waitForTerminal(client, taskId, 1);
      assert.equal(status.status, "failed");
      await waitForLifecycleEvent(client, taskId, "released");
      const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(requests.filter((item) => item.auth_applied === true).length, 0);
      assert.equal(issueCount.count, variant === "private-auth-wrong-turn" ? 0 : 1);
      const selection = requests.filter((item) => item.method === "session/setModel");
      assert.equal(selection.length, 1);
      const model = (selection[0]?.params as { model?: { providerId?: string } } | undefined)?.model;
      assert.equal(model?.providerId, "account:bigmodel-start-plan");
    const providerSync = requests.find((item) => item.method === "provider/updateAccountConfig");
    assert.ok(providerSync, "live entitlement must be followed by native Provider registration");
    const syncParams = providerSync.params as { states?: Record<string, { entitled?: boolean; current?: boolean }> };
    assert.equal(syncParams.states?.["account:bigmodel-start-plan"]?.entitled, true);
    // Runtime authorization is task/model scoped: the selected Start Plan
    // provider is current for this task even when another account family is
    // selected in Desktop.
    assert.equal(syncParams.states?.["account:bigmodel-start-plan"]?.current, true);
    assert.equal(JSON.stringify(providerSync).includes("SYNTHETIC_GATE2_SECRET_93d9422b"), false);
      const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
      const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
      scan(dataRoot);
    }, { runtimeVariant: variant, issueCount, lifecycleCollector, stderrCollector, preserveFixtureOnFailure: true });
    } catch (error) {
      console.error("worker stderr:\n" + stderrCollector.lines.join("\n"));
      if (fixtureRuntime && existsSync(fixtureRuntime.exitLog)) {
        console.error("fake app-server lifecycle:\n" + readFileSync(fixtureRuntime.exitLog, "utf8"));
      }
      throw error;
    }
  });
}

test("Start Plan Billing preflight rejection withholds the private lease; execution proceeds without credentials and still releases (ADR-058)", { timeout: 120_000 }, async () => {
  const issueCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `private-preflight-reject-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId),
      model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    // ADR-058: a rejected Billing preflight withholds the private lease but
    // no longer blocks execution. The session starts; the turn settles
    // through the official account authentication that remains wired, and
    // Release completes normally either way.
    const terminalStatus = (await waitForTerminal(client, taskId, 1)).status;
    assert.ok(terminalStatus === "completed" || terminalStatus === "failed",
      `the attempt must reach a terminal status without Bridge gating (got ${terminalStatus})`);
    await waitForLifecycleEvent(client, taskId, "released");
    // ADR-058: with the Bridge entitlement gate removed, the official private
    // channel serves credential requests on its own terms; what matters is
    // that the withheld synthetic lease secret never reaches the runtime wire.
    assert.equal(existsSync(runtime.requestLog), true, "the AppServer starts and records provider/session requests");
    const requestsText = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requestsText.includes("SYNTHETIC_GATE2_SECRET_93d9422b"), false,
      "the withheld private lease secret must never reach the runtime wire");
  }, { runtimeVariant: "private-auth-preflight-reject", issueCount, preserveFixtureOnFailure: true });
});

test("SQLite interaction persistence redacts a synthetic credential echoed by AppServer", { timeout: 120_000 }, async () => {
  const stderr = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-interaction-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    assert.equal(Buffer.from(JSON.stringify(interaction)).includes(marker), false);
    const details = interaction.details as Record<string, unknown>;
    const requestId = String(details.request_id ?? (details.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: { task_id: taskId, request_id: requestId, decision: "allow" } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const events = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(Buffer.from(JSON.stringify({ events, result })).includes(marker), false);
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
    assert.equal(Buffer.from(stderr.lines.join("")).includes(marker), false);
  }, { runtimeVariant: "private-auth-interaction", stderrCollector: stderr, preserveFixtureOnFailure: true });
});

test("SQLite Worker environment block excludes the delivered synthetic credential", { timeout: 120_000 }, async () => {
  let binding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `private-env-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!existsSync(runtime.requestLog) || !readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'))) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'));
    assert.ok(binding && binding.pid > 0 && binding.creation);
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "worker-env-probe.ps1");
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-TargetPid", String(binding.pid), "-ExpectedTicks", binding.creation],
      { encoding: "utf8", timeout: 30_000, windowsHide: true });
    assert.equal(probe.status, 0, "identity-bound environment probe must succeed without exposing its contents");
    const observed = JSON.parse(probe.stdout.trim()) as { identity_verified?: boolean; marker_found?: boolean; bounded?: boolean };
    assert.deepEqual(observed, { identity_verified: true, marker_found: false, control_found: false, system_root_found: true, bounded: true });
    // Positive control: this independent fixture contains only a non-JWT
    // sentinel in its environment, proving the scanner can find a value.
    const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        GATE2_ENV_CONTROL: "GATE2_ENV_CONTROL_PLAINTEXT_SENTINEL" }, stdio: "ignore", windowsHide: true,
    });
    const controlClosed = new Promise<void>((resolve) => control.once("close", () => resolve()));
    try {
      assert.ok(control.pid);
      const identity = await createPlatformProbe().identityOf(control.pid);
      assert.equal(identity.fingerprint_precision, "exact");
      assert.ok(identity.fingerprint);
      const positive = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-TargetPid", String(control.pid), "-ExpectedTicks", identity.fingerprint],
        { encoding: "utf8", timeout: 30_000, windowsHide: true });
      assert.equal(positive.status, 0, "identity-bound positive-control probe must succeed");
      assert.deepEqual(JSON.parse(positive.stdout.trim()), { identity_verified: true, marker_found: false, control_found: true, system_root_found: true, bounded: true });
    } finally { if (control.exitCode === null && control.signalCode === null) control.kill(); await controlClosed; }
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, issueOverride: (scope) => {
    binding = scope;
    return new PrivateCredentialLease(scope, "SYNTHETIC_GATE2_SECRET_93d9422b", Date.now() + 30_000);
  } });
});

test("SQLite cancellation after private credential delivery verifies Worker cleanup and Release", { timeout: 120_000 }, async () => {
  const stderr = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-cancel-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal(created.status, "queued");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!existsSync(runtime.requestLog) || !readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), "synthetic credential must be delivered before cancellation");
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(stderr.lines.join("")).includes(marker), false);
    assert.equal(JSON.stringify({ cancelled, result }).includes(marker.toString()), false);
  }, { runtimeVariant: "private-auth-hold", stderrCollector: stderr, preserveFixtureOnFailure: true });
});

test("SQLite cancellation before a delayed issuer returns revokes its late lease", { timeout: 120_000 }, async () => {
  let release!: (lease: PrivateCredentialLease) => void;
  let markIssued!: (lease: PrivateCredentialLease) => void;
  let child: ChildProcess | undefined;
  let issuedBinding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  const issued = new Promise<PrivateCredentialLease>((resolve) => { markIssued = resolve; });
  const pending = new Promise<PrivateCredentialLease>((resolve) => { release = resolve; });
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-before-issue-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const lease = await issued;
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    // Settle the late issuer only after the cancelled Worker generation has
    // exited; otherwise the EOF race can commit a Worker failure after the
    // Manager has already verified cancellation.
    await new Promise<void>((resolve, reject) => {
      const owned = child;
      if (!owned?.pid) return reject(new Error("cancelled Worker handle was unavailable"));
      if (owned.exitCode !== null || owned.signalCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error("cancelled Worker did not exit")), 15_000);
      owned.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    release(lease);
    await new Promise((resolve) => setImmediate(resolve));
    await waitForLifecycleEvent(client, taskId, "released");
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    await assert.rejects(lease.redeem(issuedBinding, async () => true, async () => assert.fail(), new AbortController().signal));
    const marker = Buffer.from("SYNTHETIC_LATE_ISSUER");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value; }, issueOverride: (binding) => {
    const lease = new PrivateCredentialLease(binding, "SYNTHETIC_LATE_ISSUER", Date.now() + 30_000);
    issuedBinding = binding;
    markIssued(lease);
    return pending;
  } });
});

test("SQLite Worker exit while issuer is pending revokes a late lease", { timeout: 120_000 }, async () => {
  let child: ChildProcess | undefined;
  let release!: (lease: PrivateCredentialLease) => void;
  let issued!: (value: { lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }) => void;
  const ready = new Promise<{ lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }>((resolve) => { issued = resolve; });
  const pending = new Promise<PrivateCredentialLease>((resolve) => { release = resolve; });
  await withRealAdapterMcp(async (client, manager, dataRoot, workspace, runtime) => {
    const taskId = `private-worker-exit-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const { lease, binding } = await ready;
    assert.ok(child && child.pid === binding.pid && child.exitCode === null && child.signalCode === null);
    const owned = child;
    const exited = new Promise<void>((resolve) => owned.once("exit", () => resolve()));
    assert.equal(owned.kill(), true);
    await exited;
    release(lease);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), new AbortController().signal));
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_EXIT_ISSUER");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
    const cancelResponse = await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } });
    const cancelled = contentObject(cancelResponse);
    assert.equal(cancelled.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
    await manager.shutdown();
    const settingsDirectory = path.join(path.dirname(dataRoot), "settings");
    const recoveryStages: Array<{ stage: string; detail: Record<string, unknown> }> = [];
    const restarted = await SqliteLifecycleMcpAuthority.create({
      dataRoot, workerEntryPath, bridgeEntryPath: fileURLToPath(import.meta.url),
      hostProfile: { name: "mvp-real-adapter-test", settingsDirectory },
      trustedLocalContext: createTrustedLocalCandidateContext({ name: "mvp-real-adapter-test", settingsDirectory }),
      // The replacement probe still uses the suite's controlled fake
      // AppServer, so it must remain on the retained direct rollback path.
      testOnScheduler: (stage, detail) => { recoveryStages.push({ stage, detail }); },
    });
    try {
      assert.ok(recoveryStages.some((entry) => entry.stage === "operation_recovery_classified" && entry.detail.state === "complete"), "restart must classify the verified-cancelled crashed Attempt as complete");
      assert.ok(!recoveryStages.some((entry) => entry.stage === "recovery_root_read_only"), "a released Attempt must not fence new dispatch");
      const receipt = await restarted.createTask(syntheticTask(workspace, `recovery-probe-${randomUUID()}`) as unknown as import("../../../src/interfaces.js").TaskPackage);
      assert.ok(receipt.task_id, "a released Attempt must allow new dispatch");
      const probeDeadline = Date.now() + 60_000;
      let probeStatus = "";
      while (Date.now() < probeDeadline) {
        probeStatus = (await restarted.getStatus(receipt.task_id)).status;
        if (["completed", "failed", "cancelled"].includes(probeStatus)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(["completed", "failed", "cancelled"].includes(probeStatus), `recovery-probe task must reach a terminal state before restart shutdown (last status: ${probeStatus || "unknown"})`);
      console.error("[gate2] cancelled crashed Attempt released; restart observes no hold and dispatch is available");
    } finally { await restarted.shutdown(); }
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value; }, issueOverride: (binding) => {
    const lease = new PrivateCredentialLease(binding, "SYNTHETIC_EXIT_ISSUER", Date.now() + 30_000);
    issued({ lease, binding });
    return pending;
  } });
});

test("SQLite Worker crash after execution evidence stays held instead of replaying side effects", { timeout: 120_000 }, async () => {
  let child: ChildProcess | undefined;
  let release!: (lease: PrivateCredentialLease) => void;
  let issued!: (value: { lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }) => void;
  const ready = new Promise<{ lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }>((resolve) => { issued = resolve; });
  const pending = new Promise<PrivateCredentialLease>((resolve) => { release = resolve; });
  let driverReturned: ((detail: Record<string, unknown>) => void) | undefined;
  const driverDone = new Promise<Record<string, unknown>>((resolve) => { driverReturned = resolve; });
  await withRealAdapterMcp(async (client, manager, dataRoot, workspace, _runtime) => {
    const taskId = `private-crash-hold-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const { binding } = await ready;
    assert.ok(child && child.pid === binding.pid);
    const owned = child;
    const exited = new Promise<void>((resolve) => owned.once("exit", () => resolve()));
    assert.equal(owned.kill(), true);
    await exited;
    const outcome = await driverDone;
    assert.equal(outcome.task_id, taskId);
    // The crashed Attempt stays `running` in the Store with no committed
    // result; no cancellation is requested in this scenario.
    await manager.shutdown();
    const settingsDirectory = path.join(path.dirname(dataRoot), "settings");
    const recoveryStages: Array<{ stage: string; detail: Record<string, unknown> }> = [];
    const admissionStages: Array<{ stage: string; detail: Record<string, unknown> }> = [];
    const restarted = await SqliteLifecycleMcpAuthority.create({
      dataRoot, workerEntryPath, bridgeEntryPath: fileURLToPath(import.meta.url),
      hostProfile: { name: "mvp-real-adapter-test", settingsDirectory },
      trustedLocalContext: createTrustedLocalCandidateContext({ name: "mvp-real-adapter-test", settingsDirectory }),
      testOnScheduler: (stage, detail) => {
        recoveryStages.push({ stage, detail });
        if (stage === "dispatch_deferred_workspace_occupied") admissionStages.push({ stage, detail });
      },
    });
    try {
      assert.ok(recoveryStages.some((entry) => entry.stage === "recovery_workspace_scoped"
        && entry.detail.reason === "execution_side_effect_unverified"),
      "the restarted Host must retain a Worker that reached Runtime execution as a scoped Hold");
      assert.equal(recoveryStages.some((entry) => entry.stage === "driver_run_returned"
        && entry.detail.task_id === taskId && entry.detail.attempt === 2), false,
      "Recovery must not create or dispatch a continuation after execution evidence");
      const held = await restarted.getStatus(taskId) as unknown as Record<string, unknown>;
      assert.equal(held.status, "running", "the interrupted Attempt remains the current held execution");
      assert.equal(held.attempt, 1, "Recovery must not advance to a second Attempt");
      assert.equal((await operationFor(dataRoot, taskId)).phase, "running",
        "the interrupted Operation remains occupied for management review");
      // The held Operation occupies the same execution path. A different Task
      // on that path may queue, but it must not acquire a parallel Worker slot.
      const probeTaskId = `recovery-probe-${randomUUID()}`;
      const probeReceipt = await restarted.createTask(syntheticTask(workspace, probeTaskId) as unknown as import("../../../src/interfaces.js").TaskPackage);
      assert.equal(probeReceipt.status, "queued");
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const check = () => admissionStages.length > 0 ? resolve() : Date.now() < deadline ? setTimeout(check, 50) : reject(new Error("same-path admission was not deferred"));
        check();
      });
      assert.equal(admissionStages[0]?.detail.task_id, probeTaskId);
      assert.equal(admissionStages[0]?.detail.occupied_path, workspace);
      assert.equal(admissionStages[0]?.detail.execution_path, workspace);
      assert.equal((await restarted.getStatus(probeTaskId)).status, "queued");
      console.error("[gate2] crashed Attempt with execution evidence remains held; same-path admission stays fenced");
    } finally { await restarted.shutdown(); }
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value; }, onDriverRunReturned: (detail) => driverReturned?.(detail), issueOverride: (binding) => {
    const lease = new PrivateCredentialLease(binding, "SYNTHETIC_CRASH_HOLD", Date.now() + 30_000);
    issued({ lease, binding });
    return pending;
  } });
});

test("SQLite cancellation during a partially written credential frame aborts delivery once and releases", { timeout: 120_000 }, async () => {
  let writeStarted!: () => void;
  let writeHandoffFailed!: (error: Error) => void;
  let releaseWrite!: () => void;
  const writeBegun = new Promise<void>((resolve, reject) => { writeStarted = resolve; writeHandoffFailed = reject; });
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writeEndCalls = 0;
  let frameWriteCalls = 0;
  const stderr = { lines: [] as string[] };
  const lifecycle = { lines: [] as string[] };
  try {
    await withRealAdapterMcp(async (client, manager, dataRoot, workspace, runtime) => {
    const taskId = `private-write-cancel-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    // The harness splits the Manager-side credential frame: the 4-byte
    // prefix plus the first body slice are handed to the OS socket, and the
    // remainder is withheld until this test releases it, so the cancel below
    // lands after a partial frame has genuinely been written.
    await writeBegun;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cancelResponse = await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } });
    releaseWrite();
    const cancelled = contentObject(cancelResponse);
    assert.ok(["cancelled", "failed"].includes(String(cancelled.status)), `cancellation must win or lose to a failed result, got ${String(cancelled.status)}`);
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(frameWriteCalls, 1, "the credential frame must be written at most once (never retransmitted)");
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    if (cancelled.status === "failed") {
      const failedResult = await manager.getResult(taskId);
      assert.ok(String(failedResult.summary).includes("private_auth_receive_failed"), `a committed Worker failure must identify the mid-frame receive failure: ${String(failedResult.summary)}`);
    }
    const marker = Buffer.from("SYNTHETIC_WRITE_CANCEL");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
    console.error("[gate2] cancellation during outstanding credential write completed; release verified, no retransmission");
    }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, stderrCollector: stderr, lifecycleCollector: lifecycle, onWorkerSpawn: (value) => {
    const responseChannel = (value as unknown as { privateAuthResponseChannel?: { readonly destroyed?: boolean; readonly writableEnded?: boolean; write: (chunk: Buffer, callback?: (error?: Error | null) => void) => boolean; end: (chunk?: Buffer) => unknown } }).privateAuthResponseChannel;
    if (responseChannel) {
      const originalWrite = responseChannel.write.bind(responseChannel);
      const originalEnd = responseChannel.end.bind(responseChannel);
      responseChannel.end = (chunk?: Buffer) => {
        writeEndCalls += 1;
        if (chunk) frameWriteCalls += 1;
        if (!chunk) {
          writeStarted();
          void writeReleased.then(() => { if (!responseChannel.destroyed && !responseChannel.writableEnded) originalEnd(); });
          return responseChannel;
        }
        // Prefix plus the first body slice: a genuine partial frame reaches
        // the OS socket; `writeStarted` fires from the write callback, which
        // proves the bytes were handed off before the test cancels.
        const split = Math.min(chunk.length, 4 + 64);
        originalWrite(chunk.subarray(0, split), (handoffError?: Error | null) => {
          // The write callback proves the partial bytes were handed to the
          // OS socket; a handoff error must fail the test, not be ignored.
          if (handoffError) writeHandoffFailed(new Error(`partial frame handoff failed: ${String(handoffError)}`));
          else writeStarted();
        });
        void writeReleased.then(() => {
          if (!responseChannel.destroyed && !responseChannel.writableEnded) {
            originalWrite(chunk.subarray(split));
            originalEnd();
          }
        });
        return responseChannel;
      };
    }
    }, issueOverride: (binding) => new PrivateCredentialLease(binding, "SYNTHETIC_WRITE_CANCEL", Date.now() + 30_000) });
  } finally {
    if (process.env["MVP_KEEP_FIXTURE"] === "1") {
      console.error("write-cancel stderr:\n" + stderr.lines.join(""));
      console.error("write-cancel lifecycle:\n" + lifecycle.lines.join("\n"));
    }
  }
});

test("SQLite Worker rejects subsequent runtime auth after lifetime pipe EOF", { timeout: 120_000 }, async () => {
  let child: ClaimOnlyWorkerProcess | undefined;
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-eof-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!existsSync(runtime.requestLog) || !readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'))) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'));
    assert.ok(child?.privateAuthLifetimeChannel);
    child.privateAuthLifetimeChannel.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, "the same Worker must still be alive for the EOF recheck");
    assert.equal(child.signalCode, null);
    writeFileSync(path.join(runtime.runtimeRoot, "recheck-trigger"), "recheck", "utf8");
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    const entries = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.filter((item) => item.auth_applied === true).length, 1);
    assert.deepEqual(entries.filter((item) => "recheck_auth_applied" in item).map((item) => item.recheck_auth_applied), [false]);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth-eof-recheck", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value as ClaimOnlyWorkerProcess; } });
});

test("SQLite Worker ACK channel loss never retransmits a private credential", { timeout: 120_000 }, async () => {
  let lease: PrivateCredentialLease | undefined;
  let issuedBinding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  const issuedCount = { count: 0 };
  let responseFinished = 0;
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-ack-loss-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(issuedCount.count, 1);
    assert.equal(responseFinished, 1, "exactly one credential frame must finish writing before ACK failure");
    assert.ok(lease);
    await assert.rejects(lease.redeem(issuedBinding, async () => true, async () => assert.fail(), new AbortController().signal));
    const marker = Buffer.from("SYNTHETIC_ACK_LOSS");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => { const worker = child as ClaimOnlyWorkerProcess; const channel = worker.privateAuthAcknowledgementChannel; assert.ok(channel); assert.ok(worker.privateAuthResponseChannel); worker.privateAuthResponseChannel.once("finish", () => { responseFinished++; }); channel.destroy(); },
    issueOverride: (binding) => { issuedBinding = binding; lease = new PrivateCredentialLease(binding, "SYNTHETIC_ACK_LOSS", Date.now() + 30_000); return lease; },
  });
});

for (const invalid of [Buffer.from([2, 2]), Buffer.from([0])] as const) test(`SQLite Worker rejects malformed confirmation ${invalid.toString("hex")}`, { timeout: 120_000 }, async () => {
  let injected = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-invalid-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(injected, 1);
    assert.equal(issuedCount.count, 1);
    assert.equal(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_INVALID");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) { injected++; return (originalWrite as (...values: unknown[]) => boolean)(invalid, ...args); }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_INVALID", Date.now() + 30_000),
  });
});

test("SQLite Worker refuses credentials when lifetime EOF precedes Manager confirmation", { timeout: 120_000 }, async () => {
  let interrupted = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-eof-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(interrupted, 1);
    assert.equal(issuedCount.count, 1);
    assert.equal(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_EOF");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) { interrupted++; lifetime.destroy(); return false; }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_EOF", Date.now() + 30_000),
  });
});

test("SQLite cancellation while Worker awaits Manager confirmation revokes delivery", { timeout: 120_000 }, async () => {
  let dropped = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-cancel-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && dropped === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(dropped, 1, "cancel only after Manager accepted ACK and confirmation was dropped");
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(issuedCount.count, 1);
    assert.equal(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_CANCEL");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) {
          dropped++;
          const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
          if (callback) queueMicrotask(callback);
          return true;
        }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_CANCEL", Date.now() + 30_000),
  });
});

test("SQLite Worker refuses credentials when Manager confirmation is lost", { timeout: 120_000 }, async () => {
  let dropped = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-lost-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(dropped, 1);
    assert.equal(issuedCount.count, 1);
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_LOST");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) {
          dropped++;
          const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
          if (callback) queueMicrotask(callback);
          return true;
        }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_LOST", Date.now() + 6_000),
  });
});

test("SQLite Worker ACK received then discarded never causes credential retransmission", { timeout: 120_000 }, async () => {
  let lease: PrivateCredentialLease | undefined;
  let binding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  let discarded = 0;
  let responseFinished = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-ack-discard-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "failed", "Worker must not use credentials before Manager accepts ACK");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(discarded, 1, "the Manager must observe and discard the Worker's ACK bytes");
    assert.equal(responseFinished, 1);
    assert.equal(issuedCount.count, 1);
    assert.ok(lease);
    await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), new AbortController().signal));
    const marker = Buffer.from("SYNTHETIC_ACK_DISCARDED");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
    const entries = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.filter((item) => item.auth_applied === true).length, 0);
    console.error(`[gate2] discarded ACK bytes; task_status=${String(status.status)} frame_finishes=${responseFinished} issues=${issuedCount.count} discarded=${discarded}`);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const worker = child as ClaimOnlyWorkerProcess;
      const ack = worker.privateAuthAcknowledgementChannel;
      assert.ok(ack); assert.ok(worker.privateAuthResponseChannel);
      worker.privateAuthResponseChannel.once("finish", () => { responseFinished++; });
      const originalRead = ack.read.bind(ack);
      ack.read = (size?: number) => { const chunk: unknown = originalRead(size); if (chunk !== null) { discarded++; ack.destroy(); return null; } return null; };
    },
    issueOverride: (scope) => { binding = scope; lease = new PrivateCredentialLease(scope, "SYNTHETIC_ACK_DISCARDED", Date.now() + 30_000); return lease; },
  });
});

test("SQLite continuation cannot redeem a prior Attempt's private lease", { timeout: 120_000 }, async () => {
  let priorLease: PrivateCredentialLease | undefined;
  const attempts: number[] = [];
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-old-attempt-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    contentObject(await client.callTool({ name: "zcode_continue", arguments: { task_id: taskId, feedback: "Run the isolated continuation", operation_id: `continue-${randomUUID()}` } }));
    assert.equal((await waitForTerminal(client, taskId, 2)).status, "failed");
    const operationId = `sqlite-${createHash("sha256").update(`${taskId}\0${2}`, "utf8").digest("hex").slice(0, 32)}`;
    const modules = await loadLifecycleCandidateModules();
    const store = modules.Store.openForRecovery(dataRoot);
    assert.ok(store);
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !modules.createPort(store).readLifecycleEvents(operationId).some((event) => event.event_type === "released")) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(modules.createPort(store).readLifecycleEvents(operationId).some((event) => event.event_type === "released"), "second Attempt must Release");
    } finally { store.close(); }
    assert.deepEqual(attempts, [1, 2]);
    const entries = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.filter((entry) => entry.auth_applied === true).length, 1);
    const markers = [Buffer.from("SYNTHETIC_OLD_ATTEMPT"), Buffer.from("SYNTHETIC_FIRST_ATTEMPT")];
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) for (const marker of markers) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    for (const marker of markers) assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueOverride: (binding) => {
    attempts.push(binding.attempt);
    if (!priorLease) {
      priorLease = new PrivateCredentialLease(binding, "SYNTHETIC_OLD_ATTEMPT", Date.now() + 60_000);
      return new PrivateCredentialLease(binding, "SYNTHETIC_FIRST_ATTEMPT", Date.now() + 60_000);
    }
    return priorLease;
  } });
});

test("two SQLite Workers cannot consume the same private credential lease", { timeout: 120_000 }, async () => {
  let shared: PrivateCredentialLease | undefined;
  const claims = new Set<string>();
  const count = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const firstWorkspace = path.join(workspace, "first"), secondWorkspace = path.join(workspace, "second");
    mkdirSync(firstWorkspace); mkdirSync(secondWorkspace);
    const first = `private-first-${randomUUID()}`, second = `private-second-${randomUUID()}`;
    for (const [taskId, directory] of [[first, firstWorkspace], [second, secondWorkspace]]) {
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
        ...syntheticTask(directory!, taskId!), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
      } }));
      assert.equal(created.status, "queued");
    }
    const statuses = await Promise.all([waitForTerminal(client, first, 1), waitForTerminal(client, second, 1)]);
    assert.deepEqual(statuses.map((status) => status.status).sort(), ["completed", "failed"]);
    await Promise.all([waitForLifecycleEvent(client, first, "released"), waitForLifecycleEvent(client, second, "released")]);
    assert.equal(count.count, 2);
    assert.equal(claims.size, 2);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.filter((item) => item.auth_applied === true).length, 1);
    assert.equal(JSON.stringify(statuses).includes("SYNTHETIC_GATE2_SECRET_93d9422b"), false);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
  }, { runtimeVariant: "private-auth", issueCount: count, preserveFixtureOnFailure: true,
    issueOverride: (binding) => { claims.add(binding.claim); shared ??= new PrivateCredentialLease(binding, "SYNTHETIC_GATE2_SECRET_93d9422b", Date.now() + 30_000); return shared; } });
});

test("host-wired issuer surfaces a sanitized Billing rejection, withholds the lease, and execution proceeds without credentials (ADR-058)", { timeout: 120_000 }, async () => {
  const gate = fakeHostBillingGate("billing_parameter_error");
  const lifecycle = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `host-wired-reject-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    // ADR-058: the sanitized Billing rejection withholds the private lease
    // and stays as staged Manager evidence; execution itself proceeds
    // without the lease and the AppServer records its session requests.
    const terminalStatus = (await waitForTerminal(client, taskId, 1)).status;
    assert.ok(terminalStatus === "completed" || terminalStatus === "failed",
      `the attempt must reach a terminal status without Bridge gating (got ${terminalStatus})`);
    await waitForLifecycleEvent(client, taskId, "released");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    const publicResult = JSON.stringify(result);
    assert.equal(publicResult.includes(HOST_JWT), false, "the Result must not contain the synthetic JWT");
    assert.equal(publicResult.includes(HOST_ACCOUNT), false, "the Result must not contain the account identity");
    assert.equal(publicResult.includes(HOST_DEVICE_MID), false, "the Result must not contain the device identity");
    assert.equal(gate.checks.length, 1, "the Billing observation must run exactly once before lease delivery");
    assert.equal(existsSync(runtime.requestLog), true, "the AppServer starts and records session requests");
    const rejection = lifecycle.lines.find((line) => line.includes("start_plan_entitlement_preflight_rejected"));
    assert.ok(rejection, "the gate must stage a sanitized entitlement rejection classification");
    const detail = JSON.parse(rejection.slice(rejection.indexOf("{"))) as Record<string, unknown>;
    assert.equal(detail.classification, "billing_parameter_error");
    const stagedFacts = (detail.failure_facts ?? detail) as Record<string, unknown>;
    assert.deepEqual(stagedFacts, {
      request_attempted: true,
      http_status: 200,
      provider_code: "3001",
      failure_class: "billing_parameter_error",
      entitlement_verdict: "unavailable",
    });
    const stagedDiagnostic = JSON.stringify(detail);
    assert.equal(stagedDiagnostic.includes(HOST_JWT), false, "staged diagnostic must not contain the synthetic JWT");
    assert.equal(stagedDiagnostic.includes(HOST_ACCOUNT), false, "staged diagnostic must not contain the account identity");
    assert.equal(stagedDiagnostic.includes(HOST_DEVICE_MID), false, "staged diagnostic must not contain the device identity");
    assert.equal(stagedDiagnostic.includes("3001:") || stagedDiagnostic.toLowerCase().includes("synthetic"), false,
      "the staged diagnostic must stay within the sanitized classification shape");
  }, { runtimeVariant: "private-auth-preflight-reject", issuerFactory: hostIssuerFactory(gate.entitlement), lifecycleCollector: lifecycle, preserveFixtureOnFailure: true });
});

test("missing Start Plan credentials keep the host issuer unavailable without affecting Coding Plan", { timeout: 120_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  let issuerObserved: ProductionAuthIssuer | null | undefined;
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    assert.equal(issuerObserved, null, "missing official credentials must keep the host issuer unavailable");
    const taskId = `host-wired-coding-plan-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const request = interaction.details as Record<string, unknown>;
    const requestId = String(request.request_id ?? (request.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: { task_id: taskId, request_id: requestId, decision: "allow" } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(gate.checks.length, 0, "Coding Plan must never touch the Start Plan Billing gate");
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(requests.some((message) => message.method === "session/send"), "the Coding Plan path must run the full Worker turn");
  }, { runtimeVariant: "success", issuerFactory: async (runtime, host) => {
    issuerObserved = await createHostStartPlanIssuer({
      env: { ...process.env, HOME: runtime.runtimeRoot, USERPROFILE: runtime.runtimeRoot },
      homeDir: runtime.runtimeRoot, host, signal: new AbortController().signal, entitlement: gate.entitlement,
    });
    return issuerObserved;
  }, preserveFixtureOnFailure: true });
});
