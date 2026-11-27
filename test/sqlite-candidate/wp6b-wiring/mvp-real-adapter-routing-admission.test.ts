import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { StartPlanEntitlementJournal } from "../../../src/runtime/model-routing.js";

import { contentObject, syntheticTask, waitForTerminal, waitForLifecycleEvent, waitForInteractionRequest, withRealAdapterMcp, HOST_ACCOUNT, HOST_DEVICE_MID, fakeHostBillingGate, routingEnvIssuerFactory } from "./mvp-real-adapter-harness.js";

test("ADR-031 Gate E1: a post-startup login is observed by the next dispatch and account switches never cross identities", { timeout: 240_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: null as string | null };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    // Logged out at startup: the plain model routes to Start Plan and the
    // task is refused at creation (pre-intent, ADR-028 semantics), never
    // silently re-routed to Coding Plan.
    const loggedOut = `routing-logged-out-${randomUUID()}`;
    const refusal = await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, loggedOut), model: { model_id: "GLM-5.3-Flash" },
    } });
    assert.equal(refusal.isError, true, "a logged-out Start Plan task must be refused at creation");
    assert.match(JSON.stringify(refusal), /official Start Plan credentials are unavailable/u);
    assert.equal(gate.checks.length, 0, "a missing credential must fail before any Billing request");

    // User logs in inside ZCode: the next task reads the fresh credential.
    loginState.account = HOST_ACCOUNT;
    const loggedIn = `routing-logged-in-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, loggedIn), model: { model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, loggedIn, 1)).status, "completed");
    await waitForLifecycleEvent(client, loggedIn, "released");

    // Account switch: the new task binds to the new account; running tasks
    // keep their bound identity (covered by the private-auth-account-switch
    // lifecycle variant).
    loginState.account = "synthetic-account-b";
    const switched = `routing-account-b-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, switched), model: { model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, switched, 1)).status, "completed");
    await waitForLifecycleEvent(client, switched, "released");

    assert.deepEqual(gate.checks.map(({ account, provider, model, deviceMid }) => ({ account, provider, model, deviceMid })), [
      { account: HOST_ACCOUNT, provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
      { account: "synthetic-account-b", provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
    ]);
    assert.equal(journal.latest("GLM-5.3-Flash"), "entitled", "live Billing verdicts must feed the routing journal");
    const log = readFileSync(runtime.requestLog, "utf8");
    assert.ok(log.includes("GLM-5.3-Flash"), "the AppServer must receive the raw official model id");
    assert.equal(log.includes("-StartPlan"), false, "the user-visible alias must never reach the AppServer");
    assert.equal(log.includes("synthetic-signature"), false, "the official credential must never appear in app-server traffic");
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031: a persisted Start Plan task replays after logout without Billing or execution", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: HOST_ACCOUNT as string | null };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `routing-logout-replay-${randomUUID()}`;
    const submit = () => client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5.3-Flash-StartPlan" },
    } });
    const requestLogLines = () => existsSync(runtime.requestLog) ? readFileSync(runtime.requestLog, "utf8").trim().split("\n").length : 0;

    const accepted = contentObject(await submit());
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const billingChecks = gate.checks.length;
    const executions = requestLogLines();

    loginState.account = null;
    const replay = contentObject(await submit());
    assert.deepEqual(replay, accepted, "logout must not hide the persisted task's original receipt");
    assert.equal(gate.checks.length, billingChecks, "an equality replay must not consume a Billing request");
    assert.equal(requestLogLines(), executions, "an equality replay must not execute the task again");
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031: a persisted Start Plan task conflicts on a changed model after logout", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: HOST_ACCOUNT as string | null };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `routing-logout-conflict-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5.3-Flash-StartPlan" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const billingChecks = gate.checks.length;
    const executions = existsSync(runtime.requestLog) ? readFileSync(runtime.requestLog, "utf8").trim().split("\n").length : 0;

    loginState.account = null;
    const changed = await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5-Air-StartPlan" },
    } });
    assert.equal(changed.isError, true, "a changed model must conflict before credential discovery");
    assert.match(JSON.stringify(changed), /TASK_ID_CONFLICT/u);
    assert.doesNotMatch(JSON.stringify(changed), /official Start Plan credentials are unavailable/u);
    assert.equal(gate.checks.length, billingChecks, "a conflict must not consume a Billing request");
    assert.equal(existsSync(runtime.requestLog) ? readFileSync(runtime.requestLog, "utf8").trim().split("\n").length : 0,
      executions, "a conflict must not execute the task again");
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031: a new Start Plan task is refused after logout and remains unpersisted", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: HOST_ACCOUNT as string | null };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const acceptedTaskId = `routing-logout-baseline-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, acceptedTaskId), model: { model_id: "GLM-5.3-Flash-StartPlan" },
    } }));
    assert.equal((await waitForTerminal(client, acceptedTaskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, acceptedTaskId, "released");
    const billingChecks = gate.checks.length;
    const executions = existsSync(runtime.requestLog) ? readFileSync(runtime.requestLog, "utf8").trim().split("\n").length : 0;

    loginState.account = null;
    const newTaskId = `routing-logout-new-${randomUUID()}`;
    const refused = await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, newTaskId), model: { model_id: "GLM-5.3-Flash-StartPlan" },
    } });
    assert.equal(refused.isError, true, "a genuinely new Start Plan task must still require credentials");
    assert.match(JSON.stringify(refused), /official Start Plan credentials are unavailable/u);
    assert.equal((await client.callTool({ name: "zcode_status", arguments: { task_id: newTaskId } })).isError, true,
      "the refused new task must not be persisted");
    assert.equal(gate.checks.length, billingChecks, "the credential refusal must not consume a Billing request");
    assert.equal(existsSync(runtime.requestLog) ? readFileSync(runtime.requestLog, "utf8").trim().split("\n").length : 0,
      executions, "the credential refusal must not execute the task");
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031 Gate E1: an explicit -StartPlan alias executes the raw model id over Start Plan", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: HOST_ACCOUNT };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `routing-alias-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5.3-Flash-StartPlan" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.deepEqual(gate.checks.map(({ account, model }) => ({ account, model })), [
      { account: HOST_ACCOUNT, model: "GLM-5.3-Flash" },
    ]);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const setModel = requests.find((message) => message.method === "session/setModel") as { params?: { model?: { providerId?: string; modelId?: string } } } | undefined;
    assert.equal(setModel?.params?.model?.modelId, "GLM-5.3-Flash");
    assert.equal(setModel?.params?.model?.providerId, "account:bigmodel-start-plan");
    assert.equal(JSON.stringify(requests).includes("-StartPlan"), false);
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031: a Billing verdict cannot silently reroute a model offered by both plans", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  journal.record("GLM-5.3-Flash", "no_entitlement", Date.now());
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `routing-fallback-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { model_id: "GLM-9-CodingOnly" },
    } }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const request = interaction.details as Record<string, unknown>;
    const requestId = String(request.request_id ?? (request.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: { task_id: taskId, request_id: requestId, decision: "allow" } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(gate.checks.length, 0, "the execution-time fallback must not consume a Billing request");
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const setModel = requests.find((message) => message.method === "session/setModel") as { params?: { model?: { providerId?: string; modelId?: string } } } | undefined;
    assert.equal(setModel?.params?.model?.providerId, "account:bigmodel-individual-coding-plan");
    assert.equal(setModel?.params?.model?.modelId, "GLM-9-CodingOnly", "a Coding-only model routes without changing its official id");
  }, { runtimeVariant: "success", routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031 Gate E1: billing rejections never trigger a silent fallback", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("billing_parameter_error");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: HOST_ACCOUNT };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace) => {
    for (const round of [1, 2]) {
      const taskId = `routing-no-fallback-${round}-${randomUUID()}`;
      contentObject(await client.callTool({ name: "zcode_task", arguments: {
        ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5.3-Flash" },
      } }));
      assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed", `round ${round}: an unresolved Billing verdict must not fall back to Coding Plan`);
      await waitForLifecycleEvent(client, taskId, "released");
    }
    assert.equal(gate.checks.length, 2, "each task performs exactly one rejected preflight and no lease delivery");
    assert.equal(journal.latest("GLM-5.3-Flash"), "billing_parameter_error");
  }, { runtimeVariant: "private-auth-preflight-reject", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031: the routing cache never masks a changed model selection; identical requests replay the accepted routing", { timeout: 240_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: null as string | null };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `routing-idem-${randomUUID()}`;
    const submit = (model: Record<string, unknown>) => client.callTool({ name: "zcode_task", arguments: { ...syntheticTask(workspace, taskId), model } });
    const requestLogLines = () => existsSync(runtime.requestLog) ? readFileSync(runtime.requestLog, "utf8").trim().split("\n").length : 0;

    // 1. Logged out: routing succeeds, but the Start Plan credential preflight
    //    refuses before persistence. The task_id must keep no cache
    //    reservation so a re-submission is evaluated from current inputs.
    const refused = await submit({ model_id: "GLM-5.3-Flash-StartPlan" });
    assert.equal(refused.isError, true, "a logged-out Start Plan task must be refused at creation");
    assert.match(JSON.stringify(refused), /official Start Plan credentials are unavailable/u);
    assert.equal((await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } })).isError, true,
      "a refused task must not be persisted");
    assert.equal(gate.checks.length, 0, "the refusal must not consume a Billing request");

    // 2. Login: the same task_id and raw alias input are re-evaluated and
    //    accepted; the first accepted routing becomes the replay baseline.
    loginState.account = HOST_ACCOUNT;
    const accepted = contentObject(await submit({ model_id: "GLM-5.3-Flash-StartPlan" }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(gate.checks.length, 1, "the accepted task performs exactly one live Billing check");
    const executions = requestLogLines();

    // 3. A Billing journal change after acceptance must not re-route an
    //    identical request: the first accepted routing replays its original
    //    receipt without a second execution.
    journal.record("GLM-5.3-Flash", "no_entitlement", Date.now());
    const replay = contentObject(await submit({ model_id: "GLM-5.3-Flash-StartPlan" }));
    assert.deepEqual(replay, accepted, "an identical request must replay the original receipt");
    assert.equal(gate.checks.length, 1, "the replay must not consume a Billing request");
    assert.equal(requestLogLines(), executions, "the replay must not execute the task again");

    // 4. Start Plan boundary: the explicit provider form is a distinct raw
    //    request identity, resolves to the same persisted TaskPackage, and
    //    replays through Authority equality instead of a false conflict.
    const explicit = contentObject(await submit({ provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" }));
    assert.deepEqual(explicit, accepted, "the alias and the explicit Start Plan provider share one persisted TaskPackage");
    assert.equal(gate.checks.length, 1);
    assert.equal(requestLogLines(), executions);

    // 5. A materially changed selection must surface TASK_ID_CONFLICT from the
    //    SQLite Authority, never a masked replay.
    const changedModel = await submit({ model_id: "GLM-5-Air-StartPlan" });
    assert.equal(changedModel.isError, true, "a changed model_id must conflict");
    assert.match(JSON.stringify(changedModel), /TASK_ID_CONFLICT/u);
    const changedProvider = await submit({ provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash" });
    assert.equal(changedProvider.isError, true, "a changed provider_id must conflict");
    assert.match(JSON.stringify(changedProvider), /TASK_ID_CONFLICT/u);
    const changedReasoning = await submit({ model_id: "GLM-5.3-Flash-StartPlan", reasoning_level: "high" });
    assert.equal(changedReasoning.isError, true, "a changed reasoning_level must conflict");
    assert.match(JSON.stringify(changedReasoning), /TASK_ID_CONFLICT/u);
    assert.equal(gate.checks.length, 1, "conflicting submissions must not consume Billing requests");
    assert.equal(requestLogLines(), executions, "conflicting submissions must not execute the task again");
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});
