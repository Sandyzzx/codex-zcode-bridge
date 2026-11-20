import assert from "node:assert/strict";
import test from "node:test";
import { officialProviderCapabilityFailure } from "../src/adapters/official-app-server-adapter.js";
import type { OfficialAppServerRuntimeDescriptor } from "../src/runtime/official-app-server-runtime.js";

function descriptor(overrides: Partial<OfficialAppServerRuntimeDescriptor> = {}): OfficialAppServerRuntimeDescriptor {
  return {
    status: "OFFICIAL_RUNTIME_VERIFIED",
    discount_capability: "OFFICIAL_DISCOUNT_VERIFIED",
    start_plan_static_compatibility: "OFFLINE_COMPATIBLE",
    reason: null,
    install_dir: "C:\\synthetic-zcode",
    install_source: "test",
    desktop_version: "3.18.2.10443",
    bundle_path: "C:\\synthetic-zcode\\resources\\glm\\zcode.cjs",
    bundle_bytes: 1,
    bundle_sha256: "a".repeat(64),
    builtin_provider_config_path: "C:\\synthetic-zcode\\resources\\config\\provider\\zcode-builtin.json",
    builtin_provider_config_bytes: 1,
    builtin_provider_config_sha256: "b".repeat(64),
    runtime_host_path: "C:\\synthetic-zcode\\resources\\tools\\runtime-host\\zcode-runtime-host.exe",
    runtime_host_bytes: 1,
    runtime_host_sha256: "c".repeat(64),
    node_executable: "node",
    node_version: "24.16.0",
    node_compatible: true,
    manifest: null,
    ...overrides,
  };
}

test("Coding Plan requires its verified discount capability", () => {
  assert.equal(officialProviderCapabilityFailure(descriptor(), "coding_plan_discount"), null);
  assert.match(
    officialProviderCapabilityFailure(
      descriptor({ discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED" }),
      "coding_plan_discount",
    ) ?? "",
    /OFFICIAL_DISCOUNT_NOT_VERIFIED/u,
  );
});

test("Start Plan requires offline compatibility and never depends on the Coding Plan discount", () => {
  assert.equal(
    officialProviderCapabilityFailure(
      descriptor({ discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED" }),
      "start_plan_static",
    ),
    null,
  );
  for (const compatibility of ["OFFLINE_INCOMPATIBLE", "OFFLINE_RESEARCH_PENDING", null] as const) {
    assert.match(
      officialProviderCapabilityFailure(
        descriptor({ start_plan_static_compatibility: compatibility }),
        "start_plan_static",
      ) ?? "",
      /STARTPLAN_RUNTIME_INCOMPATIBLE/u,
    );
  }
});

test("other Providers require runtime identity without inheriting plan-specific gates", () => {
  assert.equal(
    officialProviderCapabilityFailure(
      descriptor({
        discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
        start_plan_static_compatibility: null,
      }),
      "installed_runtime",
    ),
    null,
  );
  assert.match(
    officialProviderCapabilityFailure(
      descriptor({ status: "OFFICIAL_RUNTIME_UNVERIFIED", reason: "synthetic identity mismatch" }),
      "installed_runtime",
    ) ?? "",
    /OFFICIAL_RUNTIME_UNVERIFIED/u,
  );
});

test("unverified runtime descriptors cannot satisfy either provider capability", () => {
  const unverified = descriptor({
    status: "OFFICIAL_RUNTIME_UNVERIFIED",
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    start_plan_static_compatibility: null,
    reason: "synthetic identity mismatch",
  });
  assert.notEqual(officialProviderCapabilityFailure(unverified, "coding_plan_discount"), null);
  assert.notEqual(officialProviderCapabilityFailure(unverified, "start_plan_static"), null);
});

test("experimental runtime authorization is Provider-scoped and does not claim verification", () => {
  const experimental = descriptor({
    status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
    installation_safety: "OFFICIAL_INSTALLATION_SAFE",
    installation_fingerprint: "a".repeat(64),
    experimental_authorization: {
      state: "authorized",
      file_path: "C:\\synthetic-authorization.json",
      reason: null,
      record: {
        installation_fingerprint: "a".repeat(64),
        desktop_version: "3.19.0.10774",
        authorized_at: "2026-11-20T00:00:00.000Z",
        authorized_by: "owner",
        scopes: ["coding_plan_probe"],
      },
      scopes: ["coding_plan_probe"],
    },
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
    reason: "explicit experimental authorization accepted",
  });
  assert.equal(officialProviderCapabilityFailure(experimental, "coding_plan_discount"), null);
  assert.match(
    officialProviderCapabilityFailure(experimental, "start_plan_static") ?? "",
    /start_plan_probe/u,
  );
  assert.match(
    officialProviderCapabilityFailure(experimental, "installed_runtime") ?? "",
    /other_provider_probe/u,
  );
  assert.equal(experimental.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
});

test("experimental status without a matching authorization record cannot satisfy any Provider gate", () => {
  const experimental = descriptor({
    status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
    installation_safety: "OFFICIAL_INSTALLATION_SAFE",
    installation_fingerprint: "b".repeat(64),
    experimental_authorization: {
      state: "required",
      file_path: "C:\\synthetic-authorization.json",
      reason: null,
      record: null,
      scopes: [],
    },
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
  });
  for (const capability of ["coding_plan_discount", "start_plan_static", "installed_runtime"] as const) {
    assert.match(
      officialProviderCapabilityFailure(experimental, capability) ?? "",
      /EXPERIMENTAL_AUTHORIZATION_MISSING/u,
    );
  }
});

test("experimental scope does not elevate a Provider to a verified capability label", () => {
  const experimental = descriptor({
    status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
    installation_safety: "OFFICIAL_INSTALLATION_SAFE",
    installation_fingerprint: "c".repeat(64),
    experimental_authorization: {
      state: "authorized",
      file_path: "C:\\synthetic-authorization.json",
      reason: null,
      record: {
        installation_fingerprint: "c".repeat(64),
        desktop_version: "3.20.0.1",
        authorized_at: "2026-11-20T00:00:00.000Z",
        authorized_by: "owner",
        scopes: ["other_provider_probe"],
      },
      scopes: ["other_provider_probe"],
    },
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
  });
  assert.equal(officialProviderCapabilityFailure(experimental, "installed_runtime"), null);
  assert.equal(experimental.status, "OFFICIAL_RUNTIME_EXPERIMENTAL");
  assert.equal(experimental.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
  assert.equal(experimental.start_plan_static_compatibility, "OFFLINE_RESEARCH_PENDING");
});
