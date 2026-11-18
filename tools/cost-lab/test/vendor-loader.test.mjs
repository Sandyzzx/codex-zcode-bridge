import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  OFFICIAL_KEYRING_JS_PATH,
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

test("official billing provenance records a clean deterministic patch build", async () => {
  const provenance = JSON.parse(
    await readFile(
      path.join(PROJECT_ROOT, "tools", "cost-lab", "vendor", "BUILD_PROVENANCE.json"),
      "utf8",
    ),
  );
  const bundle = await readFile(OFFICIAL_RUNTIME_PATH);
  const bundleSha = createHash("sha256").update(bundle).digest("hex").toUpperCase();
  const patch = await readFile(
    path.join(PROJECT_ROOT, provenance.source_patch.path),
  );
  const sidecar = await readFile(
    path.join(PROJECT_ROOT, `${provenance.source_patch.path}.sha256`),
    "utf8",
  );
  const patchSha = createHash("sha256").update(patch).digest("hex").toUpperCase();

  assert.equal(provenance.source_tree_dirty, false);
  assert.equal(provenance.source_patch.sha256, patchSha);
  assert.equal(
    sidecar.trim(),
    `${patchSha}  ${path.basename(provenance.source_patch.path)}`,
  );
  assert.deepEqual(provenance.source_patch.files, [
    "packages/services/src/credential/credentialService.ts",
    "packages/services/src/official-host/costLabBillingRuntime.ts",
    "packages/services/src/official-host/runtimeHostEntry.ts",
    "packages/shared/src/credential-security/contract.ts",
    "packages/shared/src/credential-security/systemCredentialCipher.ts",
  ]);
  assert.equal(provenance.bundle_bytes, bundle.length);
  assert.equal(provenance.bundle_sha256, bundleSha);
  assert.equal(provenance.builder.reproducibility.result, "BYTE_IDENTICAL");
  assert.equal(new Set(provenance.builder.reproducibility.sha256).size, 1);
  const base = bundle.toString("utf8").replace(
    "      costLabBillingSource: modelUsage === null ? null : {\n        xTime: modelUsage.xTime,\n        modelDataList: modelUsage.modelDataList\n      },\n",
    "",
  );
  const baseSha = createHash("sha256").update(base).digest("hex").toUpperCase();
  assert.notEqual(baseSha, bundleSha);
  assert.equal(provenance.bundle_integration_edit.base_sha256, baseSha);
  assert.equal(provenance.builder.reproducibility.sha256[0], baseSha);
});

test("official billing runtime blocks foreign origins, redirects, and extra writes", async () => {
  const runtime = await import(pathToFileURL(OFFICIAL_RUNTIME_PATH).href);
  const calls = [];
  const guarded = runtime.createCostLabReadOnlyApiClient({
    async request(input, init) {
      calls.push({ input: input.toString(), init });
      return new Response("{}");
    },
  });

  await assert.rejects(
    guarded.request("https://example.com/api/monitor/usage", { method: "GET" }),
    /cost_lab_read_only_api_blocked_origin/u,
  );
  await assert.rejects(
    guarded.request("https://bigmodel.cn/api/monitor/usage", { method: "POST" }),
    /cost_lab_read_only_api_blocked_write/u,
  );
  await guarded.request("https://bigmodel.cn/api/monitor/usage", {
    method: "GET",
    redirect: "follow",
  });
  assert.equal(calls[0].init.redirect, "error");

  const tokenPath =
    "/api/biz/v1/organization/org/projects/project/api_keys/key/access_tokens";
  await guarded.request(`https://bigmodel.cn${tokenPath}`, { method: "POST" });
  assert.equal(calls[1].input, `https://bigmodel.cn${tokenPath}`);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.redirect, "error");
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

test("the billing bundle resolves the tracked JS package and native binding without opening credentials", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const env = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  try {
    await prepareOfficialBillingVendor();
    const fromBillingBundle = createRequire(OFFICIAL_RUNTIME_PATH);
    assert.equal(fromBillingBundle.resolve("@napi-rs/keyring"), OFFICIAL_KEYRING_JS_PATH);
    assert.equal(typeof fromBillingBundle("@napi-rs/keyring").AsyncEntry, "function");
  } finally {
    if (env === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = env;
  }
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
