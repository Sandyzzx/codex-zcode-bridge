import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTaskModelRouter,
  readStartPlanRoutingRegistry,
  resolvePreferStartPlan,
  RecordingStartPlanEntitlement,
  routeTaskModel,
  START_PLAN_PROVIDER_ID,
  StartPlanEntitlementJournal,
  startPlanAliasCatalogEntries,
  stripStartPlanAlias,
} from "../src/runtime/model-routing.js";
import type { TaskPackage } from "../src/interfaces.js";

type RawTaskPackage = Omit<TaskPackage, "model"> & {
  model?: { provider_id?: string; model_id: string; reasoning_level?: string };
};

const REGISTRY = {
  startPlanModelIds: ["GLM-5.3-Flash", "GLM-5-Air"],
  codingPlanProviders: [{ providerId: "builtin:bigmodel-coding-plan", modelIds: ["GLM-5.3-Flash"] }],
};

function baseSettings(): { preferStartPlan: boolean; defaultProviderId: string } {
  return { preferStartPlan: true, defaultProviderId: "" };
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

test("start plan aliases strip to the official model id", () => {
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

test("registry reader derives start plan models and coding plan providers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "model-routing-registry-"));
  try {
    const builtin = path.join(root, "builtin.json");
    const personal = path.join(root, "personal.json");
    writeFileSync(builtin, JSON.stringify({ config: { providerConfigRules: { providerRules: [
      { providerId: START_PLAN_PROVIDER_ID, config: { access: { type: "zhipu-account" }, builtinModelIds: ["GLM-5.3-Flash", "GLM-5-Air"] } },
      { providerId: "builtin:bigmodel-coding-plan", config: { access: { type: "api-key", mode: "individual-coding-plan" }, builtinModelIds: ["GLM-5.3-Flash"] } },
    ] } } }));
    writeFileSync(personal, JSON.stringify({ config: {} }));
    const registry = readStartPlanRoutingRegistry({ providerBuiltinConfigFile: builtin, providerPersonalConfigFile: personal });
    assert.deepEqual(registry.startPlanModelIds, ["GLM-5.3-Flash", "GLM-5-Air"]);
    assert.deepEqual(registry.codingPlanProviders, [{ providerId: "builtin:bigmodel-coding-plan", modelIds: ["GLM-5.3-Flash"] }]);
    assert.deepEqual(startPlanAliasCatalogEntries(registry), [
      { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3-Flash-StartPlan", label: "GLM-5.3-Flash (Start Plan)", provider_label: "Start Plan" },
      { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5-Air-StartPlan", label: "GLM-5-Air (Start Plan)", provider_label: "Start Plan" },
    ]);
  } finally {
    // temp dir cleanup is handled by the OS tmp policy; no fixture reuse
  }
});

test("plain model with prefer_startplan routes to start plan and keeps the raw model id", () => {
  const decision = routeTaskModel({ model_id: "GLM-5.3-Flash" }, baseSettings(), REGISTRY, new StartPlanEntitlementJournal());
  assert.equal(decision.mode, "auto-start-plan");
  assert.deepEqual(decision.resolved, { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3-Flash" });
});

test("confirmed unavailable verdicts fall back to a coding plan provider for the same model", () => {
  for (const verdict of ["no_entitlement", "quota_exhausted", "model_unavailable"] as const) {
    const journal = new StartPlanEntitlementJournal();
    journal.record("GLM-5.3-Flash", verdict, Date.now());
    const decision = routeTaskModel({ model_id: "GLM-5.3-Flash" }, baseSettings(), REGISTRY, journal);
    assert.equal(decision.mode, "fallback-coding-plan");
    assert.deepEqual(decision.resolved, { provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash" });
  }
});

test("unknown, risk-control, and identity verdicts never fall back silently", () => {
  for (const verdict of ["rate_limited", "unavailable", "unusual_activity", "captcha_required", "unauthorized", "forbidden", "billing_parameter_error"] as const) {
    const journal = new StartPlanEntitlementJournal();
    journal.record("GLM-5.3-Flash", verdict, Date.now());
    const decision = routeTaskModel({ model_id: "GLM-5.3-Flash" }, baseSettings(), REGISTRY, journal);
    assert.equal(decision.mode, "auto-start-plan");
    assert.equal(decision.resolved!.provider_id, START_PLAN_PROVIDER_ID);
  }
});

test("fallback keeps start plan when no coding plan provider supports the model", () => {
  const journal = new StartPlanEntitlementJournal();
  journal.record("GLM-5-Air", "no_entitlement", Date.now());
  const decision = routeTaskModel({ model_id: "GLM-5-Air" }, baseSettings(), REGISTRY, journal);
  assert.equal(decision.mode, "auto-start-plan");
  assert.equal(decision.resolved!.provider_id, START_PLAN_PROVIDER_ID);
  assert.match(decision.reason!, /no coding plan provider supports/u);
});

test("prefer_startplan=false resolves a plain model to the coding plan provider", () => {
  const decision = routeTaskModel({ model_id: "GLM-5.3-Flash" }, { preferStartPlan: false, defaultProviderId: "" }, REGISTRY, new StartPlanEntitlementJournal());
  assert.equal(decision.mode, "prefer-off-coding-plan");
  assert.deepEqual(decision.resolved, { provider_id: "builtin:bigmodel-coding-plan", model_id: "GLM-5.3-Flash" });
  assert.throws(() => routeTaskModel({ model_id: "GLM-5-Air" }, { preferStartPlan: false, defaultProviderId: "" }, REGISTRY, new StartPlanEntitlementJournal()), /no coding plan provider supports/u);
});

test("the bridge default coding plan provider wins when it advertises the model", () => {
  const registry = { startPlanModelIds: REGISTRY.startPlanModelIds, codingPlanProviders: [
    { providerId: "other-coding-plan", modelIds: ["GLM-5.3-Flash"] },
    REGISTRY.codingPlanProviders[0]!,
  ] };
  const decision = routeTaskModel({ model_id: "GLM-5.3-Flash" }, { preferStartPlan: false, defaultProviderId: "builtin:bigmodel-coding-plan" }, registry, new StartPlanEntitlementJournal());
  assert.equal(decision.resolved!.provider_id, "builtin:bigmodel-coding-plan");
});

test("explicit -StartPlan aliases resolve dynamically and unknown aliases fail closed", () => {
  const decision = routeTaskModel({ model_id: "GLM-5-Air-StartPlan" }, baseSettings(), REGISTRY, new StartPlanEntitlementJournal());
  assert.equal(decision.mode, "explicit-start-plan");
  assert.deepEqual(decision.resolved, { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5-Air" });
  assert.throws(() => routeTaskModel({ model_id: "GLM-9-Unknown-StartPlan" }, baseSettings(), REGISTRY, new StartPlanEntitlementJournal()), /unknown Start Plan model alias/u);
  assert.throws(() => routeTaskModel({ model_id: "GLM-5.3-Flash-StartPlan" }, baseSettings(), null, new StartPlanEntitlementJournal()), /unknown Start Plan model alias/u);
});

test("explicit start plan provider accepts alias and raw ids and rejects unregistered models", () => {
  const alias = routeTaskModel({ provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3-Flash-StartPlan" }, baseSettings(), REGISTRY, new StartPlanEntitlementJournal());
  assert.deepEqual(alias.resolved, { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3-Flash" });
  const raw = routeTaskModel({ provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3-Flash" }, baseSettings(), REGISTRY, new StartPlanEntitlementJournal());
  assert.equal(raw.mode, "explicit-start-plan");
  assert.throws(() => routeTaskModel({ provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-9-Unknown" }, baseSettings(), REGISTRY, new StartPlanEntitlementJournal()), /not present in the official provider registry/u);
});

test("explicit coding plan providers bypass automatic routing", () => {
  const journal = new StartPlanEntitlementJournal();
  journal.record("GLM-5.3-Flash", "no_entitlement", Date.now());
  const decision = routeTaskModel({ provider_id: "my-coding-plan", model_id: "GLM-5.3-Flash" }, baseSettings(), REGISTRY, journal);
  assert.equal(decision.mode, "explicit-provider");
  assert.deepEqual(decision.resolved, { provider_id: "my-coding-plan", model_id: "GLM-5.3-Flash" });
});

test("reasoning level and explicit start plan requests survive routing", () => {
  const decision = routeTaskModel({ model_id: "GLM-5.3-Flash", reasoning_level: "high" }, baseSettings(), REGISTRY, new StartPlanEntitlementJournal());
  assert.deepEqual(decision.resolved, { provider_id: START_PLAN_PROVIDER_ID, model_id: "GLM-5.3-Flash", reasoning_level: "high" });
});

test("recording entitlement feeds the journal without adding requests", async () => {
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

test("task router resolves provider-less models and keeps task_id idempotent", async () => {
  const journal = new StartPlanEntitlementJournal();
  const router = createTaskModelRouter({
    settings: baseSettings,
    journal,
    registry: async () => REGISTRY,
  });
  const first = await router(task({ model: { model_id: "GLM-5.3-Flash" } }));
  assert.equal(first.model!.provider_id, START_PLAN_PROVIDER_ID);
  assert.equal(first.model!.model_id, "GLM-5.3-Flash");
  // A later confirmed verdict must not re-route an existing task_id.
  journal.record("GLM-5.3-Flash", "no_entitlement", Date.now());
  const second = await router(task({ model: { model_id: "GLM-5.3-Flash" } }));
  assert.deepEqual(second.model, first.model);
  const other = await router(task({ task_id: "route_other", model: { model_id: "GLM-5.3-Flash" } }));
  assert.equal(other.model!.provider_id, "builtin:bigmodel-coding-plan");
});

test("task router passes through tasks without a model and preserves explicit selections", async () => {
  const router = createTaskModelRouter({ settings: baseSettings, journal: new StartPlanEntitlementJournal(), registry: async () => REGISTRY });
  const noModel = await router(task());
  assert.equal(noModel.model, undefined);
  const explicit = await router(task({ model: { provider_id: "my-coding-plan", model_id: "GLM-5.3-Flash" } }));
  assert.equal(explicit.model!.provider_id, "my-coding-plan");
});
