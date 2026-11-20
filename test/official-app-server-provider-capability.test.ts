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
