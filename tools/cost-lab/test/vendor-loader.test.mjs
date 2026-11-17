import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OFFICIAL_KEYRING_NATIVE_PATH,
  OFFICIAL_RUNTIME_PATH,
  PROJECT_ROOT,
  prepareOfficialBillingVendor,
  verifyOfficialVendor,
} from "../vendor-loader.mjs";

test("official billing runtime and keyring native file hashes match provenance", async () => {
  const integrity = await verifyOfficialVendor();
  assert.match(integrity.runtime_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    integrity.keyring_native_sha256,
    "52b16658275b7848f8081a6542fee3448f1b1c5d3a36487107ae0e7cec95ac6f",
  );
  assert.ok((await readFile(OFFICIAL_RUNTIME_PATH)).length > 0);
  assert.ok((await readFile(OFFICIAL_KEYRING_NATIVE_PATH)).length > 0);
});

test("vendor preparation points keyring at the tracked official Host native file", async () => {
  const env = {};
  const integrity = await prepareOfficialBillingVendor({
    env,
    platform: "win32",
    arch: "x64",
  });
  assert.equal(env.NAPI_RS_NATIVE_LIBRARY_PATH, OFFICIAL_KEYRING_NATIVE_PATH);
  assert.equal(integrity.keyring_native_source, "official_host_vendor");
});

test("vendor preparation refuses unsupported native targets", async () => {
  await assert.rejects(
    prepareOfficialBillingVendor({
      env: {},
      platform: "linux",
      arch: "x64",
    }),
    /official_billing_vendor_unsupported_platform/,
  );
});

test("Cost Lab is not referenced by production package or plugin build inputs", async () => {
  const packageJson = JSON.parse(
    await readFile(`${PROJECT_ROOT}/package.json`, "utf8"),
  );
  assert.equal(packageJson.files.some((entry) => entry.includes("tools/cost-lab")), false);
  const buildCore = await readFile(`${PROJECT_ROOT}/scripts/build-core.mjs`, "utf8");
  const buildPlugin = await readFile(`${PROJECT_ROOT}/scripts/build-plugin.mjs`, "utf8");
  assert.equal(buildCore.includes("tools/cost-lab"), false);
  assert.equal(buildPlugin.includes("tools/cost-lab"), false);
});
