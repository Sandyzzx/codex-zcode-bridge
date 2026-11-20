import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ZCodeRuntimeConfig } from "../src/interfaces.js";
import { BridgeError } from "../src/runtime/errors.js";
import {
  OFFICIAL_APPSERVER_COMPATIBILITY_MANIFEST,
  OfficialAppServerRuntimeResolver,
  type OfficialAppServerRuntimeDescriptor,
  type OfficialAppServerRuntimeManifestEntry,
} from "../src/runtime/official-app-server-runtime.js";
import type { OfficialRuntimeProbeScope } from "../src/runtime/official-runtime-authorization.js";

interface Fixture {
  readonly root: string;
  readonly bundle: string;
  readonly builtin: string;
  readonly runtimeHost: string;
  readonly manifest: OfficialAppServerRuntimeManifestEntry;
}

async function makeFixture(options: {
  readonly bundle?: string;
  readonly builtin?: string;
  readonly runtimeHost?: string;
  readonly version?: string;
  readonly appVersion?: string;
  readonly buildCommitId?: string;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "official-app-server-runtime-"));
  const bundle = path.join(root, "resources", "glm", "zcode.cjs");
  const builtin = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
  const runtimeHost = path.join(root, "resources", "tools", "runtime-host", "zcode-runtime-host.exe");
  const desktopExecutable = path.join(root, "ZCode.exe");
  await Promise.all([
    mkdir(path.dirname(bundle), { recursive: true }),
    mkdir(path.dirname(builtin), { recursive: true }),
    mkdir(path.dirname(runtimeHost), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(bundle, options.bundle ?? "synthetic-installed-bundle\n", "utf8"),
    writeFile(builtin, options.builtin ?? "{\"config\":{}}\n", "utf8"),
    writeFile(runtimeHost, options.runtimeHost ?? "synthetic-runtime-host\n", "utf8"),
    writeFile(desktopExecutable, "synthetic-desktop-executable\n", "utf8"),
    writeFile(path.join(root, "resources", "app.asar"), "synthetic-asar\n", "utf8"),
  ]);
  const [bundleIdentity, builtinIdentity, hostIdentity] = await Promise.all([
    identity(bundle),
    identity(builtin),
    identity(runtimeHost),
  ]);
  return {
    root,
    bundle,
    builtin,
    runtimeHost,
    manifest: {
      desktop_version: options.version ?? "3.18.2.10443",
      desktop_app_version: options.appVersion ?? "3.18.2",
      desktop_build_commit_id: options.buildCommitId ?? "2681f4af",
      bundle_sha256: bundleIdentity.sha256,
      bundle_bytes: bundleIdentity.bytes,
      builtin_provider_config_sha256: builtinIdentity.sha256,
      builtin_provider_config_bytes: builtinIdentity.bytes,
      runtime_host_sha256: hostIdentity.sha256,
      runtime_host_bytes: hostIdentity.bytes,
      node_compatibility: ">=24.16.0 <25",
      appserver_protocol: "zcode-app-server-stdio-desktop-v1",
      request_security_capability: "official-installed-bundle-signing",
      coding_plan_discount_verified: true,
      start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
      verification_date: "2026-11-18",
    },
  };
}

function resolver(fixture: Fixture, overrides: {
  readonly version?: string;
  readonly nodeVersion?: string;
  readonly manifest?: readonly OfficialAppServerRuntimeManifestEntry[];
  readonly env?: NodeJS.ProcessEnv;
  readonly launchIdentity?: NodeJS.ProcessEnv;
  readonly experimentalAuthorizationFile?: string | null;
} = {}): OfficialAppServerRuntimeResolver {
  const base: ZCodeRuntimeConfig = {
    nodeExecutable: "node",
    zcodeEntrypoint: fixture.bundle,
    providerBuiltinConfigFile: fixture.builtin,
    providerPersonalConfigFile: path.join(fixture.root, ".zcode", "v2", "provider_config.json"),
    zcodeDataRoot: path.join(fixture.root, ".zcode"),
    dataRoot: fixture.root,
  };
  return new OfficialAppServerRuntimeResolver({
    env: overrides.env ?? { ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.root },
    homeDir: fixture.root,
    platform: "win32",
    architecture: "x64",
    manifest: overrides.manifest ?? [fixture.manifest],
    experimentalAuthorizationFile: overrides.experimentalAuthorizationFile ?? null,
    baseResolver: { resolve: async () => base },
    hashFile: async (filePath) => (await identity(filePath)).sha256,
    probeNodeVersion: async () => overrides.nodeVersion ?? "v24.16.0",
    probeDesktopVersion: async () => overrides.version ?? fixture.manifest.desktop_version,
    inspectExecutable: async () => ({
      architecture: "x64",
      signature_status: "Valid",
      signer_subject: "CN=北京智谱华章科技股份有限公司, O=北京智谱华章科技股份有限公司",
      signer_thumbprint: "6F7B147DC610F91425750D2449C46002C3385BCF",
    }),
    readDesktopLaunch: () => ({
      args: ["app-server", "--stdio", "--surface", "desktop"],
      env: overrides.launchIdentity ?? {
        ZCODE_APP_VERSION: fixture.manifest.desktop_app_version,
        ZCODE_BUILD_COMMIT_ID: fixture.manifest.desktop_build_commit_id,
      },
    }),
  });
}

test("resolver verifies same-root installed assets and returns installed runtime config", async () => {
  const fixture = await makeFixture();
  try {
    const runtime = resolver(fixture);
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_VERIFIED");
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_VERIFIED");
    assert.equal(descriptor.start_plan_static_compatibility, "OFFLINE_RESEARCH_PENDING");
    assert.equal(descriptor.install_dir, fixture.root);
    assert.equal(descriptor.bundle_path, fixture.bundle);
    assert.equal(descriptor.bundle_sha256, fixture.manifest.bundle_sha256);
    assert.equal(descriptor.node_version, "24.16.0");
    assert.equal(descriptor.manifest?.desktop_asset_pinning, undefined);

    const config = await runtime.resolve();
    assert.equal(config.zcodeEntrypoint, descriptor.bundle_path);
    assert.equal(config.providerBuiltinConfigFile, descriptor.builtin_provider_config_path);
    assert.equal(config.providerPersonalConfigFile, path.join(fixture.root, ".zcode", "v2", "provider_config.json"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("manifest distinguishes the legacy 3.18 safety boundary from full 3.19 pinning", () => {
  const legacy = OFFICIAL_APPSERVER_COMPATIBILITY_MANIFEST.find(
    (entry) => entry.desktop_version === "3.18.2.10443",
  );
  const experimental = OFFICIAL_APPSERVER_COMPATIBILITY_MANIFEST.find(
    (entry) => entry.desktop_version === "3.19.0.10774",
  );
  assert.equal(legacy?.desktop_asset_pinning, "LEGACY_SAFETY_ONLY");
  assert.equal(experimental?.desktop_asset_pinning, "FULL");
  assert.equal(experimental?.verification_stage, "EXPERIMENTAL");
  assert.equal(experimental?.coding_plan_discount_verified, false);
});

test("resolver honors persisted Bridge runtime settings without a process environment override", async () => {
  const fixture = await makeFixture();
  try {
    const settingsDir = path.join(fixture.root, ".codex", "codex-zcode-bridge");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(path.join(settingsDir, "runtime-config.json"), JSON.stringify({
      ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.root,
    }), "utf8");
    const descriptor = await resolver(fixture, { env: {} }).inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_VERIFIED");
    assert.equal(descriptor.install_source, "ZCODE_WINDOWS_APP_INSTALL_DIR");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unsupported platforms cannot select an installed runtime", async () => {
  const runtime = new OfficialAppServerRuntimeResolver({
    platform: "linux",
    architecture: "x64",
    env: {},
    hashFile: async () => assert.fail("unsupported platform inspected an asset"),
  });
  const descriptor = await runtime.inspect();
  assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
  assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
  assert.match(descriptor.reason ?? "", /requires Windows x64/u);
});

test("unknown bundle identity fails closed as OFFICIAL_RUNTIME_UNVERIFIED", async () => {
  const fixture = await makeFixture();
  const changed = { ...fixture.manifest, bundle_sha256: "0".repeat(64) };
  try {
    const runtime = resolver(fixture, { manifest: [changed] });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    assert.equal(descriptor.start_plan_static_compatibility, null);
    assert.match(descriptor.reason ?? "", /compatibility manifest/iu);
    await assert.rejects(runtime.resolve(), (error: unknown) =>
      error instanceof BridgeError
      && error.code === "provider_config_invalid"
      && /OFFICIAL_RUNTIME_UNVERIFIED/u.test(error.message));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unknown Desktop version and incompatible Node never inherit verified discount state", async () => {
  const fixture = await makeFixture();
  try {
    const changedVersion = await resolver(fixture, { version: "3.18.2.99999" }).inspect();
    assert.equal(changedVersion.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(changedVersion.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");

    const changedNode = await resolver(fixture, { nodeVersion: "v25.0.0" }).inspect();
    assert.equal(changedNode.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.match(changedNode.reason ?? "", /Node 25\.0\.0/iu);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mixed Desktop archive identity fails closed even when the executable and AppServer match", async () => {
  const fixture = await makeFixture();
  try {
    for (const launchIdentity of [
      { ZCODE_APP_VERSION: "3.18.3", ZCODE_BUILD_COMMIT_ID: "2681f4af" },
      { ZCODE_APP_VERSION: "3.18.2", ZCODE_BUILD_COMMIT_ID: "01234567" },
    ]) {
      const descriptor = await resolver(fixture, { launchIdentity }).inspect();
      assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
      assert.match(descriptor.reason ?? "", /Desktop launch identity/u);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing installation, relative install roots, and missing runtime-host fail closed", async () => {
  const missing = new OfficialAppServerRuntimeResolver({
    env: {},
    homeDir: path.join(tmpdir(), "official-app-server-runtime-empty-home"),
    platform: "win32",
    architecture: "x64",
    hashFile: async () => "0".repeat(64),
    probeNodeVersion: async () => "v24.16.0",
    probeDesktopVersion: async () => "3.18.2.10443",
  });
  const missingDescriptor = await missing.inspect();
  assert.equal(missingDescriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
  assert.match(missingDescriptor.reason ?? "", /was not found/iu);

  const relative = new OfficialAppServerRuntimeResolver({
    env: { ZCODE_WINDOWS_APP_INSTALL_DIR: ".\\relative-zcode" },
    homeDir: path.join(tmpdir(), "official-app-server-runtime-relative-home"),
    platform: "win32",
    architecture: "x64",
    hashFile: async () => "0".repeat(64),
    probeNodeVersion: async () => "v24.16.0",
    probeDesktopVersion: async () => "3.18.2.10443",
  });
  const relativeDescriptor = await relative.inspect();
  assert.equal(relativeDescriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
  assert.match(relativeDescriptor.reason ?? "", /was not found|not absolute/iu);

  const fixture = await makeFixture();
  try {
    await rm(fixture.runtimeHost);
    const absentHost = await resolver(fixture).inspect();
    assert.equal(absentHost.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.match(absentHost.reason ?? "", /runtime-host/iu);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a safe unknown installation is exposed by fingerprint but remains blocked without explicit authorization", async () => {
  const fixture = await makeFixture({ version: "3.20.0.1", appVersion: "3.20.0", buildCommitId: "1234abcd" });
  try {
    const descriptor = await resolver(fixture, { manifest: [] }).inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_SAFE");
    assert.match(descriptor.installation_fingerprint ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(descriptor.experimental_authorization?.state, "not_configured");
    assert.match(descriptor.reason ?? "", /EXPERIMENTAL_AUTHORIZATION_REQUIRED/u);
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    assert.equal(descriptor.start_plan_static_compatibility, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact fingerprint authorization enables only experimental status and never promotes Provider capabilities", async () => {
  const fixture = await makeFixture({ version: "3.20.0.1", appVersion: "3.20.0", buildCommitId: "1234abcd" });
  try {
    const unverified = await resolver(fixture, { manifest: [] }).inspect();
    const authorizationFile = await writeAuthorization(fixture.root, unverified, [
      "coding_plan_probe",
      "start_plan_probe",
      "other_provider_probe",
    ]);
    const descriptor = await resolver(fixture, {
      manifest: [],
      experimentalAuthorizationFile: authorizationFile,
    }).inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_EXPERIMENTAL");
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_SAFE");
    assert.equal(descriptor.installation_fingerprint, unverified.installation_fingerprint);
    assert.equal(descriptor.experimental_authorization?.state, "authorized");
    assert.deepEqual(descriptor.experimental_authorization?.scopes, [
      "coding_plan_probe",
      "start_plan_probe",
      "other_provider_probe",
    ]);
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    assert.equal(descriptor.start_plan_static_compatibility, "OFFLINE_RESEARCH_PENDING");
    assert.equal(descriptor.manifest, null);

    const config = await resolver(fixture, {
      manifest: [],
      experimentalAuthorizationFile: authorizationFile,
    }).resolve();
    assert.equal(config.zcodeEntrypoint, fixture.bundle);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("changing any fingerprinted asset invalidates a prior experimental authorization", async () => {
  const fixture = await makeFixture({ version: "3.20.0.1", appVersion: "3.20.0", buildCommitId: "1234abcd" });
  try {
    const before = await resolver(fixture, { manifest: [] }).inspect();
    const authorizationFile = await writeAuthorization(fixture.root, before);
    await writeFile(fixture.runtimeHost, "changed-runtime-host\n", "utf8");
    const changed = await resolver(fixture, {
      manifest: [],
      experimentalAuthorizationFile: authorizationFile,
    }).inspect();
    assert.equal(changed.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.notEqual(changed.installation_fingerprint, before.installation_fingerprint);
    assert.equal(changed.experimental_authorization?.state, "required");
    assert.match(changed.reason ?? "", /EXPERIMENTAL_AUTHORIZATION_REQUIRED/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed, unsupported-scope, and duplicate authorization records fail closed", async () => {
  const fixture = await makeFixture({ version: "3.20.0.1", appVersion: "3.20.0", buildCommitId: "1234abcd" });
  try {
    const descriptor = await resolver(fixture, { manifest: [] }).inspect();
    if (!descriptor.installation_fingerprint || !descriptor.desktop_version) {
      throw new Error("synthetic descriptor is missing an installation identity");
    }
    const prefix = `experimental-invalid-${Date.now()}`;
    const validRecord = {
      installation_fingerprint: descriptor.installation_fingerprint,
      desktop_version: descriptor.desktop_version,
      authorized_at: "2026-11-20T00:00:00.000Z",
      authorized_by: "synthetic-test",
      scopes: ["coding_plan_probe"],
    };
    const cases = [
      {
        label: "malformed JSON",
        value: "{",
        pattern: /not valid JSON/u,
      },
      {
        label: "malformed record",
        value: JSON.stringify({
          schema_version: 1,
          authorizations: [{ ...validRecord, authorized_at: "not-a-date" }],
        }),
        pattern: /malformed record/u,
      },
      {
        label: "unsupported scope",
        value: JSON.stringify({
          schema_version: 1,
          authorizations: [{ ...validRecord, scopes: ["unbounded_probe"] }],
        }),
        pattern: /malformed record/u,
      },
      {
        label: "duplicate matching records",
        value: JSON.stringify({
          schema_version: 1,
          authorizations: [validRecord, validRecord],
        }),
        pattern: /duplicate records/u,
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const authorizationFile = path.join(fixture.root, `${prefix}-${index}.json`);
      await writeFile(authorizationFile, entry.value, "utf8");
      const blocked = await resolver(fixture, {
        manifest: [],
        experimentalAuthorizationFile: authorizationFile,
      }).inspect();
      assert.equal(blocked.status, "OFFICIAL_RUNTIME_UNVERIFIED", entry.label);
      assert.equal(blocked.experimental_authorization?.state, "invalid", entry.label);
      assert.match(blocked.reason ?? "", entry.pattern, entry.label);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unsafe executable identity is hard-blocked even when its fingerprint is authorized", async () => {
  const fixture = await makeFixture({ version: "3.20.0.1", appVersion: "3.20.0", buildCommitId: "1234abcd" });
  try {
    const safe = await resolver(fixture, { manifest: [] }).inspect();
    const authorizationFile = await writeAuthorization(fixture.root, safe);
    const runtime = new OfficialAppServerRuntimeResolver({
      env: { ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.root },
      homeDir: fixture.root,
      platform: "win32",
      architecture: "x64",
      manifest: [],
      experimentalAuthorizationFile: authorizationFile,
      baseResolver: { resolve: async () => {
        throw new Error("must not resolve unsafe runtime");
      } },
      hashFile: async (filePath) => (await identity(filePath)).sha256,
      probeNodeVersion: async () => "v24.16.0",
      probeDesktopVersion: async () => "3.20.0.1",
      inspectExecutable: async () => ({
        architecture: "unknown",
        signature_status: "NotSigned",
        signer_subject: null,
        signer_thumbprint: null,
      }),
      readDesktopLaunch: () => ({
        args: [],
        env: { ZCODE_APP_VERSION: "3.20.0", ZCODE_BUILD_COMMIT_ID: "1234abcd" },
      }),
    });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_UNSAFE");
    assert.match(descriptor.reason ?? "", /x64 PE executable/u);
    await assert.rejects(runtime.resolve(), /OFFICIAL_RUNTIME_UNVERIFIED/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a valid signature from an unexpected publisher is hard-blocked", async () => {
  const fixture = await makeFixture({ version: "3.20.0.1", appVersion: "3.20.0", buildCommitId: "1234abcd" });
  try {
    const runtime = new OfficialAppServerRuntimeResolver({
      env: { ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.root },
      homeDir: fixture.root,
      platform: "win32",
      architecture: "x64",
      manifest: [],
      experimentalAuthorizationFile: null,
      baseResolver: { resolve: async () => {
        throw new Error("must not resolve an unexpected publisher");
      } },
      hashFile: async (filePath) => (await identity(filePath)).sha256,
      probeNodeVersion: async () => "v24.16.0",
      probeDesktopVersion: async () => "3.20.0.1",
      inspectExecutable: async () => ({
        architecture: "x64",
        signature_status: "Valid",
        signer_subject: "CN=Unexpected Publisher, O=Unexpected Publisher",
        signer_thumbprint: "A".repeat(40),
      }),
      readDesktopLaunch: () => ({
        args: [],
        env: { ZCODE_APP_VERSION: "3.20.0", ZCODE_BUILD_COMMIT_ID: "1234abcd" },
      }),
    });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_UNSAFE");
    assert.match(descriptor.reason ?? "", /official Zhipu publisher/u);
    await assert.rejects(runtime.resolve(), /OFFICIAL_RUNTIME_UNVERIFIED/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("experimental manifest candidates still require authorization and retain pending Provider status", async () => {
  const fixture = await makeFixture({ version: "3.19.0.10774", appVersion: "3.19.0", buildCommitId: "a7ed1054" });
  const candidate = {
    ...fixture.manifest,
    verification_stage: "EXPERIMENTAL" as const,
    coding_plan_discount_verified: false,
    start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING" as const,
  };
  try {
    const required = await resolver(fixture, { manifest: [candidate] }).inspect();
    assert.equal(required.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.match(required.reason ?? "", /EXPERIMENTAL_AUTHORIZATION_REQUIRED/u);
    const authorizationFile = await writeAuthorization(fixture.root, required);
    const descriptor = await resolver(fixture, {
      manifest: [candidate],
      experimentalAuthorizationFile: authorizationFile,
    }).inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_EXPERIMENTAL");
    assert.equal(descriptor.manifest, candidate);
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    assert.equal(descriptor.start_plan_static_compatibility, "OFFLINE_RESEARCH_PENDING");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function writeAuthorization(
  root: string,
  descriptor: OfficialAppServerRuntimeDescriptor,
  scopes: readonly OfficialRuntimeProbeScope[] = [
    "coding_plan_probe",
    "start_plan_probe",
    "other_provider_probe",
  ],
): Promise<string> {
  if (!descriptor.installation_fingerprint || !descriptor.desktop_version) {
    throw new Error("test descriptor is missing an installation fingerprint");
  }
  const filePath = path.join(root, `experimental-authorization-${Date.now()}.json`);
  await writeFile(filePath, JSON.stringify({
    schema_version: 1,
    authorizations: [{
      installation_fingerprint: descriptor.installation_fingerprint,
      desktop_version: descriptor.desktop_version,
      authorized_at: "2026-11-20T00:00:00.000Z",
      authorized_by: "synthetic-test",
      scopes,
    }],
  }), "utf8");
  return filePath;
}

async function identity(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
