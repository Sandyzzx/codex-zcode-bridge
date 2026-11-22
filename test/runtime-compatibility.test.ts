import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RuntimeCompatibilityError,
  RuntimeCompatibilityService,
  type RuntimeEvidenceRecord,
} from "../src/web/runtime-compatibility.js";

const SAFE = "OFFICIAL_INSTALLATION_SAFE";
const VERIFIED = "OFFICIAL_RUNTIME_VERIFIED";
const EXPERIMENTAL = "OFFICIAL_RUNTIME_EXPERIMENTAL";
const UNVERIFIED = "OFFICIAL_RUNTIME_UNVERIFIED";

function fixture(fingerprint: string, options: {
  readonly runtimeStatus?: string;
  readonly installationSafety?: string;
  readonly authorization?: { readonly state: string; readonly scopes: readonly string[] };
  readonly bundleSha?: string;
} = {}): Record<string, unknown> {
  const bundleSha = options.bundleSha ?? "1".repeat(64);
  return {
    host: {
      platform: "win32",
      arch: "x64",
      node_version: "24.16.0",
    },
    zcode: {
      installation_fingerprint: fingerprint,
      installation_safety: options.installationSafety ?? SAFE,
      runtime_status: options.runtimeStatus ?? VERIFIED,
      experimental_authorization: options.authorization ?? { state: "not_configured", scopes: [] },
      version: "3.19.0.10774",
      desktop_app_version: "3.19.0.10774",
      desktop_build_commit_id: "abc123",
      manifest: {
        desktop_version: "3.18.2",
        appserver_protocol: "test",
      },
      assets: {
        bundle: { bytes: 100, sha256: bundleSha },
        runtime_host: { bytes: 50, sha256: "2".repeat(64) },
        builtin_provider_config: { bytes: 20, sha256: "3".repeat(64) },
      },
      desktop_executable: { bytes: 1000, sha256: "4".repeat(64) },
      desktop_archive: { bytes: 900, sha256: "5".repeat(64) },
    },
    billing_reader: { status: "PASS" },
    credential_readability: { status: "AVAILABLE", content_read: false },
    secrets: {
      authorization: "must-not-be-persisted",
      cookie: "must-not-be-persisted",
    },
    warnings: [],
  };
}

function tempService(options: {
  readonly inspect: () => Promise<Record<string, unknown>>;
  readonly probe?: () => Promise<Record<string, unknown>>;
}): { service: RuntimeCompatibilityService; root: string; history: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "runtime-compatibility-"));
  const history = path.join(root, ".run", "bridge-console", "runtime-compatibility.json");
  let tick = 0;
  let id = 0;
  const service = new RuntimeCompatibilityService({
    projectRoot: root,
    historyPath: history,
    inspectEnvironment: options.inspect,
    runProtocolProbe: options.probe ?? (async () => fixture("f".repeat(64))),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    createId: () => `evidence-${++id}`,
  });
  return {
    service,
    root,
    history,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("Runtime static evidence is fingerprint-bound, deduplicated, and never changes the manifest", async () => {
  const fingerprint = "a".repeat(64);
  const runtime = fixture(fingerprint);
  const fixtureSet = tempService({ inspect: async () => runtime });
  try {
    const first = await fixtureSet.service.inspect();
    assert.equal(first.fingerprint, fingerprint);
    assert.equal(first.runtime_changed, false);
    assert.equal(first.evidence_count, 1);
    assert.equal(first.capabilities.installation_safety?.status, "SAFE");
    assert.equal(first.capabilities.manifest_compatibility?.status, "VERIFIED");
    assert.equal(first.capabilities.protocol?.status, "NOT_RUN");
    assert.equal(first.capabilities.coding_plan_execution?.status, "NOT_RUN");
    assert.equal(first.capabilities.coding_plan_billing?.status, "NOT_RUN");
    assert.equal(first.manifest_modified, false);
    assert.equal(first.model_requests, 0);
    assert.doesNotMatch(JSON.stringify(first), /must-not-be-persisted/u);

    const second = await fixtureSet.service.inspect();
    assert.equal(second.evidence_count, 1);
    assert.equal(second.evidence[0]?.evidence_digest, first.evidence[0]?.evidence_digest);

    const candidate = await fixtureSet.service.candidateReport();
    assert.equal(candidate.kind, "runtime_compatibility_candidate");
    assert.deepEqual(candidate.approval, {
      production_manifest_modified: false,
      experimental_promoted: false,
      provider_authorization_granted: false,
      owner_review_required: true,
    });
  } finally {
    fixtureSet.cleanup();
  }
});

test("Unknown and unsafe Runtimes cannot run the protocol probe", async () => {
  let probes = 0;
  let runtime = fixture("b".repeat(64), {
    runtimeStatus: UNVERIFIED,
    authorization: { state: "required", scopes: [] },
  });
  const fixtureSet = tempService({
    inspect: async () => runtime,
    probe: async () => {
      probes += 1;
      return runtime;
    },
  });
  try {
    await fixtureSet.service.inspect();
    await assert.rejects(
      fixtureSet.service.runAuthorizedProtocolProbe(),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError
        && error.code === "RUNTIME_PROBE_AUTHORIZATION_REQUIRED",
    );
    assert.equal(probes, 0);

    runtime = fixture("c".repeat(64), {
      runtimeStatus: UNVERIFIED,
      installationSafety: "OFFICIAL_INSTALLATION_UNSAFE",
      authorization: { state: "authorized", scopes: ["coding_plan_probe"] },
    });
    await assert.rejects(
      fixtureSet.service.runAuthorizedProtocolProbe(),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError && error.code === "RUNTIME_UNSAFE",
    );
    assert.equal(probes, 0);
  } finally {
    fixtureSet.cleanup();
  }
});

test("Exact Fingerprint authorization permits a zero-model protocol probe without elevating providers", async () => {
  const fingerprint = "d".repeat(64);
  const runtime = fixture(fingerprint, {
    runtimeStatus: EXPERIMENTAL,
    authorization: { state: "authorized", scopes: ["coding_plan_probe"] },
  });
  let probes = 0;
  const fixtureSet = tempService({
    inspect: async () => runtime,
    probe: async () => {
      probes += 1;
      return {
        ...runtime,
        appserver_protocol_smoke: {
          status: "PASS",
          model_requests: 0,
          evidence: {
            session_created: false,
            installation_fingerprint: fingerprint,
          },
        },
      };
    },
  });
  try {
    const snapshot = await fixtureSet.service.runAuthorizedProtocolProbe();
    assert.equal(probes, 1);
    assert.equal(snapshot.capabilities.protocol?.status, "PASS");
    assert.equal(snapshot.capabilities.cleanup?.status, "VERIFIED");
    assert.equal(snapshot.capabilities.coding_plan_execution?.status, "NOT_RUN");
    assert.equal(snapshot.capabilities.start_plan_execution?.status, "NOT_RUN");
    assert.equal(snapshot.capabilities.other_providers?.status, "NOT_RUN");
    assert.equal(snapshot.capabilities.coding_plan_billing?.status, "NOT_RUN");
    assert.equal(snapshot.installation?.manifest_status, "EXPERIMENTAL");
    assert.equal(snapshot.manifest_modified, false);
    assert.equal(snapshot.model_requests, 0);
  } finally {
    fixtureSet.cleanup();
  }
});

test("Fingerprint transitions are reported once and preserve separate evidence histories", async () => {
  let runtime = fixture("1".repeat(64), { bundleSha: "a".repeat(64) });
  const fixtureSet = tempService({ inspect: async () => runtime });
  try {
    const first = await fixtureSet.service.inspect();
    assert.equal(first.runtime_changed, false);

    runtime = fixture("2".repeat(64), { bundleSha: "b".repeat(64) });
    const changed = await fixtureSet.service.inspect();
    assert.equal(changed.runtime_changed, true);
    assert.equal(changed.previous_fingerprint, "1".repeat(64));
    assert.ok(changed.changed_assets.includes("bundle"));
    assert.equal(changed.evidence_count, 1);

    const stable = await fixtureSet.service.inspect();
    assert.equal(stable.runtime_changed, false);
    assert.equal(stable.previous_fingerprint, null);
    assert.equal(stable.evidence_count, 1);

    runtime = fixture("1".repeat(64), { bundleSha: "a".repeat(64) });
    const returned = await fixtureSet.service.inspect();
    assert.equal(returned.runtime_changed, true);
    assert.equal(returned.previous_fingerprint, "2".repeat(64));
    assert.equal(returned.evidence_count, 1);
  } finally {
    fixtureSet.cleanup();
  }
});

test("Billing evidence remains INCONCLUSIVE unless its own verification says VERIFIED", async () => {
  const fingerprint = "e".repeat(64);
  const runtime = fixture(fingerprint);
  const fixtureSet = tempService({ inspect: async () => runtime });
  try {
    const initial = await fixtureSet.service.inspect();
    const staticRecord = initial.evidence[0]!;
    const billing = sealEvidence({
      schema_version: 1,
      evidence_id: "billing-inconclusive",
      fingerprint,
      captured_at: "2026-01-01T00:10:00.000Z",
      installation: initial.installation!,
      probe_type: "billing",
      probe_scope: "coding_plan/credits",
      result: "PASS",
      classification: "BILLING_UNATTRIBUTED",
      provider: "account:bigmodel-individual-coding-plan",
      model: "GLM-5.3-Flash",
      evidence_source: "official billing snapshot",
      limitations: ["The billing hour could not be attributed."],
    });
    mkdirSync(path.dirname(fixtureSet.history), { recursive: true });
    writeFileSync(fixtureSet.history, `${JSON.stringify({
      schema_version: 1,
      updated_at: "2026-01-01T00:10:00.000Z",
      records: [staticRecord, billing],
    }, null, 2)}\n`, "utf8");

    const snapshot = await fixtureSet.service.inspect();
    assert.equal(snapshot.capabilities.coding_plan_billing?.status, "INCONCLUSIVE");
    assert.equal(snapshot.capabilities.coding_plan_billing?.evidence_id, billing.evidence_id);
  } finally {
    fixtureSet.cleanup();
  }
});

test("Corrupt compatibility evidence fails closed instead of becoming a compatibility claim", async () => {
  const fixtureSet = tempService({
    inspect: async () => fixture("f".repeat(64)),
  });
  try {
    mkdirSync(path.dirname(fixtureSet.history), { recursive: true });
    writeFileSync(fixtureSet.history, JSON.stringify({
      schema_version: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
      records: [{ evidence_id: "incomplete" }],
    }), "utf8");
    await assert.rejects(
      fixtureSet.service.inspect(),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError
        && error.code === "RUNTIME_EVIDENCE_STORE_INVALID",
    );
  } finally {
    fixtureSet.cleanup();
  }
});

function sealEvidence(
  value: Omit<RuntimeEvidenceRecord, "evidence_digest">,
): RuntimeEvidenceRecord {
  return {
    ...value,
    evidence_digest: semanticDigest(value),
  };
}

function semanticDigest(
  value: Pick<
    RuntimeEvidenceRecord,
    | "schema_version"
    | "fingerprint"
    | "installation"
    | "probe_type"
    | "probe_scope"
    | "result"
    | "classification"
    | "provider"
    | "model"
    | "evidence_source"
    | "limitations"
  >,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      schema_version: value.schema_version,
      fingerprint: value.fingerprint,
      installation: value.installation,
      probe_type: value.probe_type,
      probe_scope: value.probe_scope,
      result: value.result,
      classification: value.classification,
      provider: value.provider,
      model: value.model,
      evidence_source: value.evidence_source,
      limitations: value.limitations,
    }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value)) ?? "null";
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortObject(item)]));
}
