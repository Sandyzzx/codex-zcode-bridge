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
  type OfficialAppServerRuntimeManifestEntry,
  type OfficialWindowsExecutableIdentity,
} from "../src/runtime/official-app-server-runtime.js";

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
  readonly hashFile?: (filePath: string) => Promise<string>;
  readonly probeNodeVersion?: (executable: string) => Promise<string>;
  readonly probeDesktopVersion?: (executable: string) => Promise<string>;
  readonly inspectExecutable?: (filePath: string) => Promise<OfficialWindowsExecutableIdentity>;
  readonly readDesktopLaunch?: (bundlePath: string) => Readonly<{
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>;
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
    baseResolver: { resolve: async () => base },
    hashFile: overrides.hashFile ?? (async (filePath) => (await identity(filePath)).sha256),
    probeNodeVersion: overrides.probeNodeVersion ?? (async () => overrides.nodeVersion ?? "v24.16.0"),
    probeDesktopVersion: overrides.probeDesktopVersion ?? (async () => overrides.version ?? fixture.manifest.desktop_version),
    inspectExecutable: overrides.inspectExecutable ?? (async () => ({
      architecture: "x64",
      signature_status: "Valid",
      signer_subject: "CN=北京智谱华章科技股份有限公司, O=北京智谱华章科技股份有限公司",
      signer_thumbprint: "6F7B147DC610F91425750D2449C46002C3385BCF",
    })),
    readDesktopLaunch: overrides.readDesktopLaunch ?? (() => ({
      args: ["app-server", "--stdio", "--surface", "desktop"],
      env: overrides.launchIdentity ?? {
        ZCODE_APP_VERSION: fixture.manifest.desktop_app_version,
        ZCODE_BUILD_COMMIT_ID: fixture.manifest.desktop_build_commit_id,
      },
    })),
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

test("unknown bundle identity remains unverified but is executable", async () => {
  const fixture = await makeFixture();
  const changed = { ...fixture.manifest, bundle_sha256: "0".repeat(64) };
  try {
    const runtime = resolver(fixture, { manifest: [changed] });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_SAFE");
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    assert.equal(descriptor.start_plan_static_compatibility, "OFFLINE_RESEARCH_PENDING");
    assert.match(descriptor.reason ?? "", /compatibility manifest/iu);
    const config = await runtime.resolve();
    assert.equal(config.zcodeEntrypoint, fixture.bundle);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unknown Desktop version and incompatible Node remain diagnostics rather than execution gates", async () => {
  const fixture = await makeFixture();
  try {
    const changedVersion = await resolver(fixture, { version: "3.18.2.99999" }).inspect();
    assert.equal(changedVersion.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(changedVersion.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    await resolver(fixture, { version: "3.18.2.99999" }).resolve();

    const changedNode = await resolver(fixture, { nodeVersion: "v25.0.0" }).inspect();
    assert.equal(changedNode.status, "OFFICIAL_RUNTIME_VERIFIED");
    assert.equal(changedNode.node_compatible, false);
    await resolver(fixture, { nodeVersion: "v25.0.0" }).resolve();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("mixed Desktop launch identity changes compatibility diagnostics without blocking startup", async () => {
  const fixture = await makeFixture();
  try {
    for (const launchIdentity of [
      { ZCODE_APP_VERSION: "3.18.3", ZCODE_BUILD_COMMIT_ID: "2681f4af" },
      { ZCODE_APP_VERSION: "3.18.2", ZCODE_BUILD_COMMIT_ID: "01234567" },
    ]) {
      const runtime = resolver(fixture, { launchIdentity });
      const descriptor = await runtime.inspect();
      assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
      assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
      assert.match(descriptor.reason ?? "", /Desktop launch identity/u);
      await runtime.resolve();
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
    await assert.rejects(resolver(fixture).resolve(), (error: unknown) =>
      error instanceof BridgeError
      && error.code === "provider_config_invalid");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a safe unknown installation is executable without an authorization file", async () => {
  const fixture = await makeFixture({ version: "4.0.0.10870", appVersion: "4.0.0", buildCommitId: "3bc8a247" });
  try {
    const runtime = resolver(fixture, {
      manifest: [],
      env: {
        ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.root,
        ZCODE_BRIDGE_EXPERIMENTAL_RUNTIME_AUTHORIZATION_FILE: path.join(fixture.root, "absent.json"),
      },
    });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_SAFE");
    assert.match(descriptor.installation_fingerprint ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    assert.equal(descriptor.start_plan_static_compatibility, "OFFLINE_RESEARCH_PENDING");
    assert.equal(descriptor.manifest, null);
    const config = await runtime.resolve();
    assert.equal(config.zcodeEntrypoint, fixture.bundle);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("non-x64 executables remain a hard installation-safety failure", async () => {
  const fixture = await makeFixture({ version: "4.0.0.10870", appVersion: "4.0.0", buildCommitId: "3bc8a247" });
  try {
    const runtime = resolver(fixture, {
      manifest: [],
      inspectExecutable: async () => ({
        architecture: "unknown",
        signature_status: "NotSigned",
        signer_subject: null,
        signer_thumbprint: null,
      }),
    });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_UNVERIFIED");
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_UNSAFE");
    assert.match(descriptor.reason ?? "", /x64 PE executable/u);
    await assert.rejects(runtime.resolve(), /OFFICIAL_INSTALLATION_UNSAFE/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("signature state and publisher are diagnostic for an x64 executable", async () => {
  const fixture = await makeFixture({ version: "4.0.0.10870", appVersion: "4.0.0", buildCommitId: "3bc8a247" });
  try {
    const runtime = resolver(fixture, {
      manifest: [],
      inspectExecutable: async () => ({
        architecture: "x64",
        signature_status: "NotSigned",
        signer_subject: "CN=Unexpected Publisher",
        signer_thumbprint: null,
      }),
    });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_SAFE");
    assert.equal(descriptor.desktop_executable_signer_subject, "CN=Unexpected Publisher");
    assert.equal(descriptor.runtime_host_signer_subject, "CN=Unexpected Publisher");
    await runtime.resolve();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("hash, launch metadata, Desktop version and Node probe failures remain diagnostic", async () => {
  const fixture = await makeFixture({ version: "4.0.0.10870", appVersion: "4.0.0", buildCommitId: "3bc8a247" });
  try {
    const runtime = resolver(fixture, {
      manifest: [],
      hashFile: async () => {
        throw new Error("hash unavailable");
      },
      readDesktopLaunch: () => {
        throw new Error("launch metadata unavailable");
      },
      probeDesktopVersion: async () => {
        throw new Error("desktop version unavailable");
      },
      probeNodeVersion: async () => {
        throw new Error("node version unavailable");
      },
    });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.installation_safety, "OFFICIAL_INSTALLATION_SAFE");
    assert.equal(descriptor.bundle_sha256, null);
    assert.equal(descriptor.desktop_executable_sha256, null);
    assert.equal(descriptor.desktop_version, "unavailable");
    assert.equal(descriptor.desktop_app_version, "unavailable");
    assert.equal(descriptor.node_version, null);
    assert.match(descriptor.installation_fingerprint ?? "", /^[0-9a-f]{64}$/u);
    const config = await runtime.resolve();
    assert.equal(config.zcodeEntrypoint, fixture.bundle);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an experimental manifest annotation does not require authorization", async () => {
  const fixture = await makeFixture({ version: "3.19.0.10774", appVersion: "3.19.0", buildCommitId: "a7ed1054" });
  const candidate = {
    ...fixture.manifest,
    verification_stage: "EXPERIMENTAL" as const,
    coding_plan_discount_verified: false,
    start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING" as const,
  };
  try {
    const runtime = resolver(fixture, { manifest: [candidate] });
    const descriptor = await runtime.inspect();
    assert.equal(descriptor.status, "OFFICIAL_RUNTIME_EXPERIMENTAL");
    assert.equal(descriptor.manifest, candidate);
    assert.equal(descriptor.discount_capability, "OFFICIAL_DISCOUNT_NOT_VERIFIED");
    await runtime.resolve();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function identity(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
