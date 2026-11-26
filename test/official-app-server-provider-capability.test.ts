import assert from "node:assert/strict";
import test from "node:test";
import { officialProviderCapabilityWarning } from "../src/adapters/official-app-server-adapter.js";
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
    active_builtin_provider_config_path: "C:\\synthetic-zcode\\resources\\config\\provider\\zcode-builtin.json",
    active_builtin_provider_config_source: "bundled" as const,
    active_builtin_provider_config_revision: null,
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

test("Coding Plan discount evidence is diagnostic, not an execution gate", () => {
  assert.equal(officialProviderCapabilityWarning(descriptor(), "coding_plan_discount"), null);
  const warning = officialProviderCapabilityWarning(
    descriptor({ discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED" }),
    "coding_plan_discount",
  );
  assert.match(warning ?? "", /OFFICIAL_DISCOUNT_DIAGNOSTIC/u);
  assert.match(warning ?? "", /OFFICIAL_DISCOUNT_NOT_VERIFIED/u);
});

test("Start Plan static compatibility is diagnostic and never depends on the Coding Plan discount", () => {
  assert.equal(
    officialProviderCapabilityWarning(
      descriptor({ discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED" }),
      "start_plan_static",
    ),
    null,
  );
  for (const compatibility of ["OFFLINE_INCOMPATIBLE", "OFFLINE_RESEARCH_PENDING", null] as const) {
    assert.match(
      officialProviderCapabilityWarning(
        descriptor({ start_plan_static_compatibility: compatibility }),
        "start_plan_static",
      ) ?? "",
      /STARTPLAN_STATIC_DIAGNOSTIC/u,
    );
  }
});

test("other Providers warn for an unverified manifest but do not inherit plan-specific diagnostics", () => {
  assert.equal(
    officialProviderCapabilityWarning(
      descriptor({
        discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
        start_plan_static_compatibility: null,
      }),
      "installed_runtime",
    ),
    null,
  );
  assert.match(
    officialProviderCapabilityWarning(
      descriptor({ status: "OFFICIAL_RUNTIME_UNVERIFIED", reason: "synthetic identity mismatch" }),
      "installed_runtime",
    ) ?? "",
    /OFFICIAL_RUNTIME_MANIFEST_UNVERIFIED/u,
  );
});

test("safe unverified runtimes produce warnings without authorization failures", () => {
  const unverified = descriptor({
    status: "OFFICIAL_RUNTIME_UNVERIFIED",
    installation_safety: "OFFICIAL_INSTALLATION_SAFE",
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    start_plan_static_compatibility: null,
    reason: "SAFE_INSTALLATION_MANIFEST_UNVERIFIED: synthetic identity mismatch",
  });
  const warnings = [
    officialProviderCapabilityWarning(unverified, "coding_plan_discount"),
    officialProviderCapabilityWarning(unverified, "start_plan_static"),
    officialProviderCapabilityWarning(unverified, "installed_runtime"),
  ];
  assert.ok(warnings.every((warning) => warning !== null));
  assert.ok(warnings.every((warning) => !/AUTHORIZATION/u.test(warning ?? "")));
  assert.ok(warnings.every((warning) => /DIAGNOSTIC|MANIFEST_UNVERIFIED/u.test(warning ?? "")));
});

test("experimental manifest annotations do not create Provider-scoped authorization requirements", () => {
  const experimental = descriptor({
    status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
    installation_safety: "OFFICIAL_INSTALLATION_SAFE",
    installation_fingerprint: "a".repeat(64),
    discount_capability: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
    reason: "SAFE_INSTALLATION_EXPERIMENTAL_MANIFEST",
  });
  const warnings = [
    officialProviderCapabilityWarning(experimental, "coding_plan_discount"),
    officialProviderCapabilityWarning(experimental, "start_plan_static"),
    officialProviderCapabilityWarning(experimental, "installed_runtime"),
  ];
  assert.ok(warnings.every((warning) => !/AUTHORIZATION/u.test(warning ?? "")));
  assert.equal(warnings[2], null);
});
