import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelRoutingCatalog,
  createTaskModelRouter,
  resolvePreferStartPlan,
  RecordingStartPlanEntitlement,
  routeTaskModel,
  START_PLAN_PROVIDER_ID,
  StartPlanEntitlementJournal,
  startPlanAliasCatalogEntries,
  stripStartPlanAlias,
} from "../src/runtime/model-routing.js";
import type { DynamicModelRoutingEntry, TaskModelRouterOptions } from "../src/runtime/model-routing.js";
import type { TaskPackage } from "../src/interfaces.js";

type RawTaskPackage = Omit<TaskPackage, "model"> & {
  model?: { provider_id?: string; model_id: string; reasoning_level?: string };
};

const CODING = "account:bigmodel-individual-coding-plan";

function entry(providerId: string, modelId: string, reasoning: string[] = ["low", "high", "max"], fallback: string | null = "max"): DynamicModelRoutingEntry {
  return { providerId, modelId, reasoningLevels: reasoning, reasoningDefaultLevel: fallback };
}

function catalog(...entries: DynamicModelRoutingEntry[]) {
  return buildModelRoutingCatalog(entries.map(({ providerId, modelId, reasoningLevels, reasoningDefaultLevel }) => ({
    provider_id: providerId,
    model_id: modelId,
    reasoning_levels: reasoningLevels.map((value) => ({ value })),
    reasoning_default_level: reasoningDefaultLevel ?? undefined,
  })));
}

function settings(preferStartPlan = true): TaskModelRouterOptions["settings"] extends () => infer T ? T : never {
  return { preferStartPlan, defaultProviderId: "" };
}

function task(overrides: Partial<RawTaskPackage> = {}): RawTaskPackage {
  return {
    task_id: "route_test",
    workspace: "C:\\tmp\\ws",
    objective: "o",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
    ...overrides,
  };
}

const BOTH = catalog(
  entry(START_PLAN_PROVIDER_ID, "GLM-5.3-Flash"),
  entry(CODING, "GLM-5.3-Flash"),
);

test("aliases strip to the runtime model family without deleting the requested suffix", () => {
  assert.equal(stripStartPlanAlias("GLM-5.3-Flash-StartPlan"), "GLM-5.3-Flash");
  assert.equal(stripStartPlanAlias("GLM-5.3-Flash"), null);
  assert.equal(stripStartPlanAlias("-StartPlan"), null);
});

test("prefer_startplan setting is a strict boolean defaulting to true", () => {
  assert.equal(resolvePreferStartPlan({}), true);
  assert.equal(resolvePreferStartPlan({ ZCODE_BRIDGE_PREFER_STARTPLAN: " false " }), false);
  assert.equal(resolvePreferStartPlan({ ZCODE_BRIDGE_PREFER_STARTPLAN: "TRUE" }), true);
  assert.throws(() => resolvePreferStartPlan({ ZCODE_BRIDGE_PREFER_STARTPLAN: "yes" }), /must be true or false/u);
});

test("catalog aliases are derived only from live Start Plan entries and remain idempotent", () => {
  const models = [
    { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3-Flash" },
    { provider_id: CODING, model_id: "GLM-5.3-Flash" },
  ];
  const aliases = startPlanAliasCatalogEntries(models);
  assert.deepEqual(aliases, [{
    provider_id: START_PLAN_PROVIDER_ID,
    model_id: "GLM-5.3-Flash-StartPlan",
    label: "GLM-5.3-Flash (Start Plan)",
    provider_label: "Start Plan",
  }]);
  assert.deepEqual(startPlanAliasCatalogEntries([...models, aliases[0]!]), [], "an existing alias must not be appended again");
});

test("a model never seen by Bridge is selected from the live AppServer catalog", () => {
  const runtime = catalog(entry(START_PLAN_PROVIDER_ID, "GLM-9-New"), entry(CODING, "GLM-9-New"));
  const decision = routeTaskModel({ model_id: "GLM-9-New" }, settings(), runtime);
  assert.equal(decision.mode, "auto-start-plan");
  assert.deepEqual(decision.resolved, { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-9-New", reasoning_level: "max" });
});

test("when both plans offer the model, no explicit plan selects Start Plan", () => {
  const decision = routeTaskModel({ model_id: "GLM-5.3-Flash" }, settings(), BOTH);
  assert.equal(decision.mode, "auto-start-plan");
  assert.equal(decision.resolved!.provider_id, START_PLAN_PROVIDER_ID);
});

test("an explicit Coding Plan selection wins even when Start Plan offers the model", () => {
  const decision = routeTaskModel({ provider_id: CODING, model_id: "GLM-5.3-Flash" }, settings(), BOTH);
  assert.equal(decision.mode, "explicit-provider");
  assert.equal(decision.resolved!.provider_id, CODING);
});

test("an explicit Start Plan selection wins and never falls back to Coding Plan", () => {
  for (const modelId of ["GLM-5.3-Flash", "GLM-5.3-Flash-StartPlan"]) {
    const decision = routeTaskModel({ provider_id: START_PLAN_PROVIDER_ID, model_id: modelId }, settings(), BOTH);
    assert.equal(decision.mode, "explicit-start-plan");
    assert.equal(decision.resolved!.provider_id, START_PLAN_PROVIDER_ID);
    assert.equal(decision.resolved!.model_id, "GLM-5.3-Flash");
  }
});

test("a plan-only model routes to the plan that advertises it", () => {
  const startOnly = routeTaskModel({ model_id: "GLM-9-StartOnly" }, settings(), catalog(entry(START_PLAN_PROVIDER_ID, "GLM-9-StartOnly")));
  assert.equal(startOnly.resolved!.provider_id, START_PLAN_PROVIDER_ID);
  const codingOnly = routeTaskModel({ model_id: "GLM-9-CodingOnly" }, settings(), catalog(entry(CODING, "GLM-9-CodingOnly")));
  assert.equal(codingOnly.resolved!.provider_id, CODING);
});

test("an absent model rejects dispatch instead of using a static fallback", () => {
  assert.throws(() => routeTaskModel({ model_id: "GLM-9-Missing" }, settings(), BOTH), /does not contain GLM-9-Missing/u);
  assert.throws(() => routeTaskModel({ provider_id: CODING, model_id: "GLM-9-Missing" }, settings(), BOTH), /does not contain/u);
});

test("Start Plan suffix resolution preserves the exact runtime model id and does not append twice", () => {
  const baseRuntime = routeTaskModel({ model_id: "GLM-5.3-Flash-StartPlan" }, settings(), BOTH);
  assert.equal(baseRuntime.resolved!.model_id, "GLM-5.3-Flash");
  const suffixRuntime = routeTaskModel({ model_id: "GLM-5.3-Flash" }, settings(), catalog(entry(START_PLAN_PROVIDER_ID, "GLM-5.3-Flash-StartPlan")));
  assert.equal(suffixRuntime.resolved!.model_id, "GLM-5.3-Flash-StartPlan");
  const suffixRequest = routeTaskModel({ model_id: "GLM-5.3-Flash-StartPlan" }, settings(), suffixRuntime.resolved! ? catalog(entry(START_PLAN_PROVIDER_ID, "GLM-5.3-Flash-StartPlan")) : catalog());
  assert.equal(suffixRequest.resolved!.model_id, "GLM-5.3-Flash-StartPlan");
});

test("reasoning metadata stays scoped to the selected Provider/Model", () => {
  const runtime = catalog(
    { ...entry(START_PLAN_PROVIDER_ID, "GLM-5.3-Flash", ["low", "high"], "low") },
    { ...entry(CODING, "GLM-5.3-Flash", ["high", "max"], "high") },
  );
  const start = routeTaskModel({ model_id: "GLM-5.3-Flash" }, settings(), runtime);
  assert.equal(start.resolved!.reasoning_level, "low");
  const coding = routeTaskModel({ provider_id: CODING, model_id: "GLM-5.3-Flash" }, settings(), runtime);
  assert.equal(coding.resolved!.reasoning_level, "high");
  assert.throws(() => routeTaskModel({ provider_id: CODING, model_id: "GLM-5.3-Flash", reasoning_level: "low" }, settings(), runtime), /reasoning level low is not available/u);
});

test("missing reasoning metadata adds no inferred level and explicit levels fail verification", () => {
  const runtime = catalog(entry(START_PLAN_PROVIDER_ID, "GLM-9-New", [], null));
  const decision = routeTaskModel({ model_id: "GLM-9-New" }, settings(), runtime);
  assert.equal(decision.resolved!.reasoning_level, undefined);
  assert.throws(() => routeTaskModel({ model_id: "GLM-9-New", reasoning_level: "max" }, settings(), runtime), /reasoning level max is not available/u);
});

test("each task_id routing reads the current catalog and never consults Billing verdicts", async () => {
  const reads: string[][] = [];
  const journal = new StartPlanEntitlementJournal();
  journal.record("GLM-5.3-Flash", "quota_exhausted", Date.now());
  const options: TaskModelRouterOptions = {
    settings,
    catalog: async (workspace) => {
      reads.push([workspace]);
      return BOTH;
    },
  };
  const router = createTaskModelRouter(options);
  const first = await router.route(task({ task_id: "current_one", model: { model_id: "GLM-5.3-Flash" } }));
  const second = await router.route(task({ task_id: "current_two", model: { model_id: "GLM-5.3-Flash" } }));
  assert.equal(first.model!.provider_id, START_PLAN_PROVIDER_ID);
  assert.equal(second.model!.provider_id, START_PLAN_PROVIDER_ID);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0], ["C:\\tmp\\ws"]);
  assert.deepEqual(reads[1], ["C:\\tmp\\ws"]);
});

test("catalog updates are used by the next task_id routing", async () => {
  let models = BOTH;
  const router = createTaskModelRouter({ settings, catalog: async () => models });
  await assert.rejects(
    router.route(task({ task_id: "update_before", model: { model_id: "GLM-9-New" } })),
    /does not contain GLM-9-New/u,
  );
  models = catalog(entry(START_PLAN_PROVIDER_ID, "GLM-9-New"), entry(CODING, "GLM-9-New"));
  const after = await router.route(task({ task_id: "update_after", model: { model_id: "GLM-9-New" } }));
  assert.equal(after.model!.provider_id, START_PLAN_PROVIDER_ID);
});

test("identical accepted requests replay, while changed raw selections re-route", async () => {
  const router = createTaskModelRouter({ settings, catalog: async () => BOTH });
  const first = await router.route(task({ task_id: "same_raw", model: { model_id: "GLM-5.3-Flash" } }));
  router.confirmRouting(first);
  const replay = await router.route(task({ task_id: "same_raw", model: { model_id: "GLM-5.3-Flash" } }));
  assert.deepEqual(replay.model, first.model);
  const changed = await router.route(task({ task_id: "same_raw", model: { provider_id: CODING, model_id: "GLM-5.3-Flash" } }));
  assert.equal(changed.model!.provider_id, CODING);
});

test("recording entitlement remains diagnostic and adds no routing request", async () => {
  let checks = 0;
  const journal = new StartPlanEntitlementJournal();
  const entitlement = new RecordingStartPlanEntitlement({
    async check() {
      checks += 1;
      return { status: "quota_exhausted", reason: "synthetic", observedAt: 42 };
    },
  }, journal);
  await entitlement.check({ account: "a", provider: START_PLAN_PROVIDER_ID, model: "GLM-5.3-Flash", deviceMid: "d", jwt: "j", signal: new AbortController().signal });
  assert.equal(checks, 1);
  assert.equal(journal.latest("GLM-5.3-Flash"), "quota_exhausted");
});

function persistedTask(model: { provider_id: string; model_id: string; reasoning_level?: string }): TaskPackage {
  return { ...task({ task_id: "persisted_task" }), model } as TaskPackage;
}

test("a continuation validates its persisted selection without rewriting it", async () => {
  const plans: Array<string | undefined> = [];
  const router = createTaskModelRouter({
    settings,
    catalog: async (_workspace, plan) => {
      plans.push(plan);
      return catalog(entry(CODING, "GLM-5.4"));
    },
  });
  const selected = persistedTask({ provider_id: CODING, model_id: "GLM-5.4", reasoning_level: "max" });
  const before = { ...selected.model! };
  await router.validatePersisted(selected);
  assert.deepEqual(selected.model, before, "validation must never re-route or switch the persisted model");
  assert.deepEqual(plans, ["current"]);
});

test("a continuation keeps the persisted model when the live catalog dropped it", async () => {
  const router = createTaskModelRouter({ settings, catalog: async () => catalog(entry(CODING, "GLM-5.3")) });
  const selected = persistedTask({ provider_id: CODING, model_id: "GLM-5.4", reasoning_level: "max" });
  await assert.rejects(router.validatePersisted(selected), (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === "provider_config_invalid"
      && /no longer contains account:bigmodel-individual-coding-plan\/GLM-5\.4/u.test(error.message));
  assert.deepEqual(selected.model, { provider_id: CODING, model_id: "GLM-5.4", reasoning_level: "max" });
});

test("a continuation rejects an unavailable reasoning level instead of silently changing it", async () => {
  const router = createTaskModelRouter({
    settings,
    catalog: async () => catalog(entry(CODING, "GLM-5.4", ["low", "high"], "high")),
  });
  const selected = persistedTask({ provider_id: CODING, model_id: "GLM-5.4", reasoning_level: "max" });
  await assert.rejects(router.validatePersisted(selected), /reasoning level max is not available/u);
  assert.equal(selected.model!.reasoning_level, "max");
});

test("a persisted bare provider id is accepted when the catalog advertises its account namespace", async () => {
  const router = createTaskModelRouter({ settings, catalog: async () => catalog(entry(CODING, "GLM-5.4")) });
  await router.validatePersisted(persistedTask({
    provider_id: "bigmodel-individual-coding-plan",
    model_id: "GLM-5.4",
  }));
});

test("a Start Plan continuation reads only the Start Plan catalog and reports its absence", async () => {
  const plans: Array<string | undefined> = [];
  const router = createTaskModelRouter({
    settings,
    catalog: async (_workspace, plan) => {
      plans.push(plan);
      return { entries: [], startPlanUnavailableReason: "no Start Plan entitlement" };
    },
  });
  await assert.rejects(
    router.validatePersisted(persistedTask({ provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3" })),
    /no Start Plan entitlement/u,
  );
  assert.deepEqual(plans, ["start_plan"]);
});

test("a catalog read failure blocks the continuation with a bounded provider error", async () => {
  const router = createTaskModelRouter({
    settings,
    catalog: async () => { throw new Error("runtime unavailable"); },
  });
  await assert.rejects(
    router.validatePersisted(persistedTask({ provider_id: CODING, model_id: "GLM-5.4" })),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === "provider_config_invalid"
      && /catalog could not be read/u.test(error.message),
  );
});
