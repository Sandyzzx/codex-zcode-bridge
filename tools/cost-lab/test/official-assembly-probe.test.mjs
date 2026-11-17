import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_OFFICIAL_SOURCE,
  PROJECT_ROOT,
  assertNoSecretMaterial,
  assessLiveProbeGate,
  auditOfficialAssemblySources,
  buildOfflineEvidence,
  compareNormalizedAuthContexts,
  normalizeAuthContext,
  writeOfflineEvidence,
} from "../official-assembly-probe.mjs";

const OFFICIAL_SOURCE_AVAILABLE = existsSync(DEFAULT_OFFICIAL_SOURCE);

function context(overrides = {}) {
  return {
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    account: {
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "individual-coding-plan",
    },
    requestAuth: {
      apiKey: "fixture-project-token-not-real",
      apiKeyId: "fixture-key-id",
      accountScope: "b".repeat(64),
      headers: {},
    },
    usageScene: "coding_plan",
    transportKind: "fixture",
    ...overrides,
  };
}

test("official source audit pins 3.18.2 and records request-auth boundaries", {
  skip: !OFFICIAL_SOURCE_AVAILABLE,
}, async () => {
  const audit = await auditOfficialAssemblySources();
  assert.equal(audit.official_source.version, "3.18.2");
  assert.equal(audit.official_source.commit, "fec975905a2abd4c07e35c40d51fa097a2258ec9");
  assert.equal(audit.official_source.tree, "5e90fec80706b8381f94e4eef48cf821b9868916");
  assert.equal(audit.official_source.clean, true);
  assert.equal(audit.network_requests, 0);
  assert.equal(audit.model_requests, 0);
  assert.equal(audit.experiment_bundle_isolated_from_production_build, true);
  assert.equal(
    audit.observations.discount_or_campaign_field_in_model_request_auth,
    "NOT_FOUND",
  );
  assert.ok(audit.network_entrypoints.some((entry) =>
    entry.id === "host_api_undici_fetch" && entry.present));
  assert.ok(audit.network_entrypoints.some((entry) =>
    entry.id === "official_undici_capture" && entry.present));
  assert.equal(audit.network_bypass_scan.direct_http2, "NOT_OBSERVED");
  assert.equal(audit.network_bypass_scan.direct_tls_connect, "NOT_OBSERVED");
  assert.equal(audit.network_bypass_scan.direct_net_connect, "NOT_OBSERVED");
  assert.ok(audit.markers.some((marker) =>
    marker.id === "official_request_auth_material" && marker.present));
  assert.ok(audit.markers.some((marker) =>
    marker.id === "bridge_simplified_access_callback" && marker.present));
});

test("normalization strips the Project Token and preserves only approved metadata", () => {
  const normalized = normalizeAuthContext(context({
    requestAuth: {
      apiKey: "SECRET_VALUE_MUST_NOT_SURVIVE",
      apiKeyId: "key-id",
      accountScope: "c".repeat(64),
      headers: { "X-Trace": "fixture", Authorization: "also-secret" },
    },
  }));
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("SECRET_VALUE_MUST_NOT_SURVIVE"), false);
  assert.equal(serialized.includes("also-secret"), false);
  assert.equal(normalized.request_auth.api_key_present, true);
  assert.deepEqual(normalized.request_auth.header_names, ["authorization", "x-trace"]);
  assert.deepEqual(normalized.account.scope, { present: true, format: "sha256_hex" });
  assert.equal(normalized.discount_fields_present, false);
});

test("identical final auth surfaces remain equal across transport assembly variants", () => {
  const comparison = compareNormalizedAuthContexts(
    context({ transportKind: "bridge_default_node_api_client" }),
    context({ transportKind: "native_host_api_network_transport" }),
  );
  assert.equal(comparison.normalized_equal, false);
  assert.equal(comparison.final_request_auth_surface_delta, "NONE");
  assert.equal(comparison.transport_delta, "PRESENT");
  assert.equal(comparison.left.request_auth.api_key_id, comparison.right.request_auth.api_key_id);
  const same = compareNormalizedAuthContexts(context(), context());
  assert.equal(same.normalized_equal, true);
  assert.equal(same.final_request_auth_surface_delta, "NONE");
  assert.equal(same.transport_delta, "NONE");
  assert.equal(same.project_identity_parity, "FIXTURE_EQUAL");
});

test("different fixture Project identity stays distinct while live parity remains unknown", () => {
  const comparison = compareNormalizedAuthContexts(
    context({ requestAuth: { ...context().requestAuth, apiKeyId: "key-a" } }),
    context({ requestAuth: { ...context().requestAuth, apiKeyId: "key-b" } }),
  );
  assert.equal(comparison.final_request_auth_surface_delta, "PRESENT");
  assert.equal(comparison.project_identity_parity, "FIXTURE_DIFFERENT");
});

test("secret redaction rejects token-bearing fields and token-like values", () => {
  assert.throws(
    () => assertNoSecretMaterial({ requestAuth: { apiKey: "secret" } }),
    /secret-bearing field/u,
  );
  assert.throws(
    () => assertNoSecretMaterial({ text: "Authorization: Bearer abcdefghijklmnop" }),
    /secret-like material/u,
  );
  assert.equal(assertNoSecretMaterial({ api_key_present: true }), true);
});

test("live gate fails closed unless every isolation and billing condition is proven", () => {
  const blocked = assessLiveProbeGate();
  assert.equal(blocked.status, "LIVE_PROBE_BLOCKED");
  assert.equal(blocked.authorization_to_launch_model_request, false);
  assert.ok(blocked.blockers.includes("settings_initialization_read_only"));
  assert.ok(blocked.blockers.includes("official_billing_snapshot_access"));

  const ready = assessLiveProbeGate({
    officialSourcePinned: true,
    settingsInitialization: "PROVEN_READ_ONLY",
    credentialStoreMutation: "PROVEN_NON_MUTATING",
    officialBillingSnapshotAccess: "PASS",
    exclusiveBillingWindow: "PROVEN",
    deterministicCleanup: "PROVEN",
    outputInsideProject: true,
  });
  assert.equal(ready.status, "LIVE_PROBE_READY");
  assert.deepEqual(ready.blockers, []);
});

test("offline evidence is deterministic in its safety conclusions", {
  skip: !OFFICIAL_SOURCE_AVAILABLE,
}, async () => {
  const evidence = await buildOfflineEvidence();
  assert.equal(evidence.real_model_tasks, 0);
  assert.equal(evidence.real_http_requests, 0);
  assert.equal(evidence.live_probe_gate.status, "LIVE_PROBE_BLOCKED");
  assert.equal(evidence.conclusions.runtime_assembly_delta, "CONFIRMED");
  assert.equal(evidence.conclusions.project_identity_parity, "UNKNOWN");
  assert.equal(evidence.conclusions.b_discount, "INCONCLUSIVE");
  assert.equal(evidence.synthetic_fixture_comparison.normalized_equal, false);
  assert.equal(
    evidence.synthetic_fixture_comparison.final_request_auth_surface_delta,
    "NONE",
  );
  assert.equal(evidence.synthetic_fixture_comparison.transport_delta, "PRESENT");
  assert.equal(evidence.synthetic_fixture_comparison.project_identity_parity, "FIXTURE_EQUAL");
});

test("output writer rejects paths outside the task run root", {
  skip: !OFFICIAL_SOURCE_AVAILABLE,
}, async () => {
  await assert.rejects(
    () => writeOfflineEvidence(path.join(PROJECT_ROOT, "outside-run-root.json")),
    /must resolve inside the task/u,
  );
});

test("experimental tool remains outside production build entries", async () => {
  const scripts = await Promise.all(
    ["build-core.mjs", "build-plugin.mjs", "build-official-host-runtime.mjs"].map((file) =>
      readFile(path.join(PROJECT_ROOT, "scripts", file), "utf8")),
  );
  assert.equal(scripts.some((source) => source.includes("tools/cost-lab")), false);
});
