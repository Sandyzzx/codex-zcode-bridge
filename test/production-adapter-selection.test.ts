import assert from "node:assert/strict";
import test from "node:test";
import { selectProductionAdapter } from "../src/worker/production-adapter-selection.js";

test("production adapter selection follows the frozen platform matrix", () => {
  assert.equal(selectProductionAdapter("win32", "x64"), "official_host");
  for (const platform of ["linux", "darwin"] as const) {
    for (const architecture of ["x64", "arm64"]) {
      assert.equal(selectProductionAdapter(platform, architecture), "direct_app_server");
    }
  }
  for (const [platform, architecture] of [
    ["win32", "arm64"],
    ["win32", "ia32"],
    ["freebsd", "x64"],
    ["aix", "ppc64"],
  ] as const) {
    assert.throws(
      () => selectProductionAdapter(platform, architecture),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "unsupported_worker_platform",
    );
  }
});

test("environment variables cannot redirect production adapter selection", () => {
  const previous = process.env.ZCODE_BRIDGE_ADAPTER;
  try {
    for (const value of ["official_host", "direct_app_server", "test_fake"]) {
      process.env.ZCODE_BRIDGE_ADAPTER = value;
      assert.equal(selectProductionAdapter("win32", "x64"), "official_host");
      assert.equal(selectProductionAdapter("linux", "x64"), "direct_app_server");
    }
  } finally {
    if (previous === undefined) delete process.env.ZCODE_BRIDGE_ADAPTER;
    else process.env.ZCODE_BRIDGE_ADAPTER = previous;
  }
});
