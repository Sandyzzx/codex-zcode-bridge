// ADR-066: official runtime Built-in registry path and selection rules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBridgeDoctor } from "../src/runtime/doctor.js";
import {
   forwardOfficialEndpointEnv,
  officialClientPlatform,
  officialDesktopAppVersion,
  officialEndpointOrigin,
  officialRuntimeRegistryPath,
  selectOfficialBuiltinRegistry,
} from "../src/runtime/official-builtin-registry.js";
import { buildAccountProviderPayload } from "../src/runtime/account-provider.js";
import { createWorkerEnv } from "../src/runtime/child-env.js";
import {
   OfficialAppServerRuntimeResolver,
   type OfficialAppServerRuntimeManifestEntry,
} from "../src/runtime/official-app-server-runtime.js";
import { NodeRuntimeResolver } from "../src/runtime/resolver.js";
import type { ZCodeRuntimeConfig } from "../src/interfaces.js";
import {
  hostClientPlatform,
   registryRelease,
   runtimeRegistryFile,
   writeDesktopAsar,
   writeRuntimeRegistry,
} from "./official-registry-fixture.js";

/** Observed on the investigation machine: Desktop 4.0.0 against the production endpoint. */
const OBSERVED_PRODUCTION_ENDPOINT_KEY = "78d7c3bef4024722642626fe3669a799";

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "official-builtin-registry-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("endpoint origin follows the Observed official precedence and defaults", () => {
  assert.equal(officialEndpointOrigin({}), "https://zcode.z.ai");
  assert.equal(officialEndpointOrigin({ ZCODE_ENV: " TEST " }), "https://zcode.chatglm.site");
  assert.equal(
    createHash("sha256").update(officialEndpointOrigin({})).digest("hex").slice(0, 32),
    OBSERVED_PRODUCTION_ENDPOINT_KEY,
  );
  assert.equal(
    officialEndpointOrigin({ ZCODE_BASE_URL: " https://example.test/api/path ", ZCODE_ENDPOINT_ORIGIN: "https://ignored.test" }),
    "https://example.test",
  );
  assert.equal(officialEndpointOrigin({ ZCODE_ENDPOINT_ORIGIN: "http://localhost:3000" }), "http://localhost:3000");
  assert.equal(officialEndpointOrigin({ ZCODE_PRODUCTION_BASE_URL: "https://prod.test" }), "https://prod.test");
  assert.equal(
    officialEndpointOrigin({ ZCODE_ENV: "test", ZCODE_TEST_BASE_URL: "https://stage.test", ZCODE_PRODUCTION_BASE_URL: "https://prod.test" }),
    "https://stage.test",
  );
  assert.throws(() => officialEndpointOrigin({ ZCODE_BASE_URL: "file:///tmp/registry" }), /http or https/u);
});

test("client platform mirrors the Observed labels", () => {
  assert.equal(officialClientPlatform("win32", "x64"), "windows-x86_64");
  assert.equal(officialClientPlatform("win32", "arm64"), "windows-aarch64");
  assert.equal(officialClientPlatform("darwin", "arm64"), "darwin-aarch64");
  assert.equal(officialClientPlatform("linux", "x64"), "linux-x86_64");
  assert.equal(officialClientPlatform("linux", "ia32"), "linux-ia32");
});

test("runtime registry path is scoped to data root, Desktop version and Endpoint", () => {
  const dataBaseDir = path.resolve("synthetic-data-base");
  const file = officialRuntimeRegistryPath({
    dataBaseDir,
    appVersion: "4.0.0",
    env: {},
    platform: "win32",
    architecture: "x64",
  });
  assert.equal(
    file,
    path.join(dataBaseDir, ".zcode", "v2", "runtime", "provider", "windows-x86_64", "4.0.0", `endpoint-${OBSERVED_PRODUCTION_ENDPOINT_KEY}`, "zcode-builtin.json"),
  );
  assert.notEqual(
    officialRuntimeRegistryPath({ dataBaseDir, appVersion: "3.19.0", env: {}, platform: "win32", architecture: "x64" }),
    file,
    "another Desktop version is another registry",
  );
  assert.notEqual(
    officialRuntimeRegistryPath({ dataBaseDir, appVersion: "4.0.0", env: { ZCODE_ENV: "test" }, platform: "win32", architecture: "x64" }),
    file,
    "another Endpoint is another registry",
  );
  assert.equal(officialRuntimeRegistryPath({ dataBaseDir, appVersion: null, env: {} }), null);
  assert.equal(officialRuntimeRegistryPath({ dataBaseDir: "relative", appVersion: "4.0.0", env: {} }), null);
  assert.equal(
    officialRuntimeRegistryPath({ dataBaseDir, appVersion: "../4.0.0", env: {}, platform: "win32", architecture: "x64" }),
    null,
    "a version segment must stay a single path segment",
  );
  assert.equal(
    officialRuntimeRegistryPath({ dataBaseDir, appVersion: "4.0.0", env: { ZCODE_BASE_URL: "ftp://endpoint.test" }, platform: "win32", architecture: "x64" }),
    null,
    "an unusable Endpoint means no runtime discovery, never a guess",
  );
});

test("Desktop version comes from the installed app.asar build metadata", async () => {
  await withTempRoot(async (root) => {
    const install = path.join(root, "ZCode");
    await mkdir(path.join(install, "resources", "glm"), { recursive: true });
    const entrypoint = path.join(install, "resources", "glm", "zcode.cjs");
    await writeFile(entrypoint, "// fixture", "utf8");
    assert.equal(officialDesktopAppVersion(entrypoint), null, "no archive: no version");
    await writeDesktopAsar(install, { appVersion: "4.0.0", buildCommitId: "3bc8a247" });
    assert.equal(officialDesktopAppVersion(entrypoint), "4.0.0");
  });
});

test("selection uses a usable runtime registry and keeps the bundled identity as fallback", async () => {
  await withTempRoot(async (root) => {
    const bundledPath = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
    await mkdir(path.dirname(bundledPath), { recursive: true });
    await writeFile(bundledPath, registryRelease(44, "bundled"), "utf8");
    const runtimePath = await writeRuntimeRegistry(root, registryRelease(48, "runtime"), { appVersion: "4.0.0" });

    const newer = await selectOfficialBuiltinRegistry({ bundledPath, runtimePath });
    assert.equal(newer.source, "runtime");
    assert.equal(newer.path, runtimePath);
    assert.equal(newer.revision, 48);
    assert.equal(newer.bundledPath, bundledPath);
    assert.equal(newer.runtimeStatus, "selected");

    const unresolved = await selectOfficialBuiltinRegistry({ bundledPath, runtimePath: null });
    assert.deepEqual(
      { path: unresolved.path, source: unresolved.source, status: unresolved.runtimeStatus },
      { path: bundledPath, source: "bundled", status: "unresolved" },
    );

    const missing = await selectOfficialBuiltinRegistry({
      bundledPath,
      runtimePath: runtimeRegistryFile(path.join(root, "other-data"), { appVersion: "4.0.0" }),
    });
    assert.equal(missing.source, "bundled");
    assert.equal(missing.runtimeStatus, "not_found");
  });
});

test("selection falls back to the bundled registry only for unusable runtime files", async () => {
  await withTempRoot(async (root) => {
    const bundledPath = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
    await mkdir(path.dirname(bundledPath), { recursive: true });
    await writeFile(bundledPath, registryRelease(44, "bundled"), "utf8");
    const options = { appVersion: "4.0.0" };

    const corrupt = await writeRuntimeRegistry(root, "{not json", options);
    assert.equal((await selectOfficialBuiltinRegistry({ bundledPath, runtimePath: corrupt })).runtimeStatus, "invalid");

    const wrongSchema = await writeRuntimeRegistry(root, JSON.stringify({ schemaVersion: 2, revision: 90, config: {} }), options);
    assert.equal((await selectOfficialBuiltinRegistry({ bundledPath, runtimePath: wrongSchema })).runtimeStatus, "invalid");

    const missingRules = await writeRuntimeRegistry(
      root,
      JSON.stringify({ schemaVersion: 1, revision: 90, config: { providerConfigRules: {} } }),
      options,
    );
    assert.equal((await selectOfficialBuiltinRegistry({ bundledPath, runtimePath: missingRules })).runtimeStatus, "invalid");

    const retired = await writeRuntimeRegistry(
      root,
      JSON.stringify({
        schemaVersion: 1,
        revision: 90,
        config: {
          providerConfigRules: { providerRules: [{ providerId: "builtin:zapi" }] },
          modelConfigRules: {},
        },
      }),
      options,
    );
    assert.equal((await selectOfficialBuiltinRegistry({ bundledPath, runtimePath: retired })).runtimeStatus, "invalid");

    const older = await writeRuntimeRegistry(root, registryRelease(40, "older"), options);
    const selected = await selectOfficialBuiltinRegistry({ bundledPath, runtimePath: older });
    assert.equal(selected.source, "runtime");
    assert.equal(selected.path, older);
    assert.equal(selected.runtimeStatus, "selected");
    assert.equal(selected.revision, 40);
  });
});

test("a runtime registry is authoritative even when its revision equals the bundled file", async () => {
  await withTempRoot(async (root) => {
    const bundledPath = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
    await mkdir(path.dirname(bundledPath), { recursive: true });
    await writeFile(bundledPath, registryRelease(44, "same"), "utf8");
    const options = { appVersion: "4.0.0" };

    const conflict = await writeRuntimeRegistry(root, registryRelease(44, "different"), options);
    const conflicted = await selectOfficialBuiltinRegistry({ bundledPath, runtimePath: conflict });
    assert.equal(conflicted.source, "runtime");
    assert.equal(conflicted.path, conflict);
    assert.equal(conflicted.runtimeStatus, "selected");
  });
});

test("a symlinked runtime registry is never selected", async () => {
  await withTempRoot(async (root) => {
    const bundledPath = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
    await mkdir(path.dirname(bundledPath), { recursive: true });
    await writeFile(bundledPath, registryRelease(44, "bundled"), "utf8");
    const runtimePath = runtimeRegistryFile(root, { appVersion: "4.0.0" });
    const selection = await selectOfficialBuiltinRegistry({
      bundledPath,
      runtimePath,
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }),
      readFile: async () => registryRelease(99, "linked"),
    });
    assert.equal(selection.source, "bundled");
    assert.equal(selection.runtimeStatus, "invalid");
  });
});

const PERSONAL_CONFIG = JSON.stringify({
  schemaVersion: 1,
  config: { providerConfigRules: { providerRules: { "p-1": {} } } },
});

interface DesktopFixture {
  readonly install: string;
  readonly entrypoint: string;
  readonly bundled: string;
  readonly dataBase: string;
  readonly personal: string;
}

/** An installation (bundle + asar identity + bundled registry) and its data root. */
async function makeDesktop(root: string, options: { readonly bundledRevision: number } = { bundledRevision: 44 }): Promise<DesktopFixture> {
  const install = path.join(root, "ZCode");
  const entrypoint = path.join(install, "resources", "glm", "zcode.cjs");
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, "// fixture", "utf8");
  await writeDesktopAsar(install, { appVersion: "4.0.0", buildCommitId: "3bc8a247" });
  const bundled = path.join(install, "resources", "config", "provider", "zcode-builtin.json");
  await mkdir(path.dirname(bundled), { recursive: true });
  await writeFile(bundled, registryRelease(options.bundledRevision, "bundled"), "utf8");
  const dataBase = path.join(root, "data base");
  const personal = path.join(dataBase, ".zcode", "v2", "provider_config.json");
  await mkdir(path.dirname(personal), { recursive: true });
  await writeFile(personal, PERSONAL_CONFIG, "utf8");
  return { install, entrypoint, bundled, dataBase, personal };
}

function nodeResolver(fixture: DesktopFixture, env: NodeJS.ProcessEnv, observations: string[] = []) {
  return new NodeRuntimeResolver({
    env: {
      ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.install,
      ZCODE_DATA_BASE_DIR: fixture.dataBase,
      ...env,
    },
    homeDir: path.join(fixture.dataBase, "home"),
    packageRoot: fixture.dataBase,
    onBuiltinRegistrySelection: (selection) => {
      observations.push(`${selection.source}:${selection.runtimeStatus}`);
    },
  });
}

test("the runtime resolver prefers the official runtime registry of the same data root, Desktop version and Endpoint", async () => {
  await withTempRoot(async (root) => {
    const fixture = await makeDesktop(root);
    const observations: string[] = [];

    const before = await nodeResolver(fixture, {}, observations).resolve();
    assert.equal(before.providerBuiltinConfigFile, fixture.bundled);
    assert.deepEqual(observations, ["bundled:not_found"]);

    const runtimePath = await writeRuntimeRegistry(fixture.dataBase, registryRelease(48, "runtime"), { appVersion: "4.0.0" });
    observations.length = 0;
    const after = await nodeResolver(fixture, {}, observations).resolve();
    assert.equal(after.providerBuiltinConfigFile, runtimePath);
    assert.equal(after.providerPersonalConfigFile, fixture.personal);
    assert.deepEqual(observations, ["runtime:selected"]);

    // Another Desktop version, Endpoint, data root or platform never
    // contributes a registry, even when its revision is higher.
    await writeRuntimeRegistry(fixture.dataBase, registryRelease(90, "other-version"), { appVersion: "3.19.0" });
    await writeRuntimeRegistry(fixture.dataBase, registryRelease(91, "other-endpoint"), { appVersion: "4.0.0", origin: "https://zcode.chatglm.site" });
    await writeRuntimeRegistry(path.join(root, "other-data"), registryRelease(92, "other-data-root"), { appVersion: "4.0.0" });
    const otherPlatform = hostClientPlatform() === "windows-x86_64" ? "linux-x86_64" : "windows-x86_64";
    await writeRuntimeRegistry(fixture.dataBase, registryRelease(93, "other-platform"), { appVersion: "4.0.0", platform: otherPlatform });
    assert.equal((await nodeResolver(fixture, {}).resolve()).providerBuiltinConfigFile, runtimePath);
    const testEndpoint = await nodeResolver(fixture, { ZCODE_ENV: "test" }).resolve();
    assert.equal(testEndpoint.providerBuiltinConfigFile, runtimeRegistryFile(fixture.dataBase, { appVersion: "4.0.0", origin: "https://zcode.chatglm.site" }));
    const testObservations: string[] = [];
    await nodeResolver(fixture, { ZCODE_ENV: "test", ZCODE_BASE_URL: "https://zcode.z.ai" }, testObservations).resolve();
    assert.deepEqual(testObservations, ["runtime:selected"], "ZCODE_BASE_URL outranks ZCODE_ENV");
  });
});

test("the bundled path persisted by older installers is a default that follows the runtime registry; any other explicit file is a pin", async () => {
  await withTempRoot(async (root) => {
    const fixture = await makeDesktop(root);
    const runtimePath = await writeRuntimeRegistry(fixture.dataBase, registryRelease(48, "runtime"), { appVersion: "4.0.0" });

    const legacyDefault = await nodeResolver(fixture, {
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fixture.bundled,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fixture.personal,
    }).resolve();
    assert.equal(legacyDefault.providerBuiltinConfigFile, runtimePath);

    const pinnedFile = path.join(root, "pinned", "zcode-builtin.json");
    await mkdir(path.dirname(pinnedFile), { recursive: true });
    await writeFile(pinnedFile, registryRelease(2, "pinned"), "utf8");
    const observations: string[] = [];
    const pinned = await nodeResolver(fixture, {
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: pinnedFile,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fixture.personal,
    }, observations).resolve();
    assert.equal(pinned.providerBuiltinConfigFile, pinnedFile);
    assert.deepEqual(observations, [], "an explicit pin skips runtime discovery");
  });
});

test("a refreshed official registry is discovered on the next resolution without caching", async () => {
  await withTempRoot(async (root) => {
    const fixture = await makeDesktop(root);
    const runtimePath = runtimeRegistryFile(fixture.dataBase, { appVersion: "4.0.0" });
    await mkdir(path.dirname(runtimePath), { recursive: true });
    await writeFile(runtimePath, "{not json", "utf8");
    const invalid = await nodeResolver(fixture, {}).resolve();
    assert.equal(invalid.providerBuiltinConfigFile, fixture.bundled);

    await writeFile(runtimePath, registryRelease(40, "older"), "utf8");
    assert.equal((await nodeResolver(fixture, {}).resolve()).providerBuiltinConfigFile, runtimePath);

    const refreshed = JSON.stringify({
      schemaVersion: 1,
      revision: 48,
      config: {
        providerConfigRules: {
          templateRules: [],
          providerRules: [{
            providerId: "account:bigmodel-individual-coding-plan",
            config: {
              builtinModelIds: ["MODEL-ADDED-BY-REFRESH"],
              access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" },
            },
          }],
        },
        modelConfigRules: { modelRules: [] },
      },
    });
    await writeFile(runtimePath, refreshed, "utf8");
    const resolved = await nodeResolver(fixture, {}).resolve();
    assert.equal(resolved.providerBuiltinConfigFile, runtimePath);
    const overlay = buildAccountProviderPayload(resolved, undefined, fixture.dataBase, "account:bigmodel-individual-coding-plan");
    assert.equal(overlay?.providers["account:bigmodel-individual-coding-plan"]?.access.entitled, false);
    assert.equal(JSON.stringify(overlay).includes("builtinModelIds"), false);
  });
});

test("ZCODE_HOME naming the .zcode directory and ZCODE_DATA_BASE_DIR locate the same runtime registry", async () => {
  await withTempRoot(async (root) => {
    const fixture = await makeDesktop(root);
    const runtimePath = await writeRuntimeRegistry(fixture.dataBase, registryRelease(48, "runtime"), { appVersion: "4.0.0" });
    const byHome = await nodeResolver(fixture, {
      ZCODE_HOME: path.join(fixture.dataBase, ".zcode"),
    }).resolve();
    assert.equal(byHome.providerBuiltinConfigFile, runtimePath);

    const noDesktopIdentity = path.join(root, "NoAsar");
    await mkdir(path.join(noDesktopIdentity, "resources", "glm"), { recursive: true });
    await writeFile(path.join(noDesktopIdentity, "resources", "glm", "zcode.cjs"), "// fixture", "utf8");
    await mkdir(path.join(noDesktopIdentity, "resources", "config", "provider"), { recursive: true });
    const bundled = path.join(noDesktopIdentity, "resources", "config", "provider", "zcode-builtin.json");
    await writeFile(bundled, registryRelease(44, "bundled"), "utf8");
    const observations: string[] = [];
    const unresolved = await nodeResolver(fixture, { ZCODE_WINDOWS_APP_INSTALL_DIR: noDesktopIdentity }, observations).resolve();
    assert.equal(unresolved.providerBuiltinConfigFile, bundled);
    assert.deepEqual(observations, ["bundled:unresolved"], "without a Desktop identity nothing is guessed");
  });
});

async function officialManifest(install: string): Promise<OfficialAppServerRuntimeManifestEntry> {
  const entry = async (relativePath: string) => {
    const content = await readFile(path.join(install, relativePath));
    return { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength };
  };
  const [bundle, builtin, runtimeHost] = await Promise.all([
    entry(path.join("resources", "glm", "zcode.cjs")),
    entry(path.join("resources", "config", "provider", "zcode-builtin.json")),
    entry(path.join("resources", "tools", "runtime-host", "zcode-runtime-host.exe")),
  ]);
  return {
    desktop_version: "4.0.0.10870",
    desktop_app_version: "4.0.0",
    desktop_build_commit_id: "3bc8a247",
    bundle_sha256: bundle.sha256,
    bundle_bytes: bundle.bytes,
    builtin_provider_config_sha256: builtin.sha256,
    builtin_provider_config_bytes: builtin.bytes,
    runtime_host_sha256: runtimeHost.sha256,
    runtime_host_bytes: runtimeHost.bytes,
    node_compatibility: ">=24.16.0 <25",
    appserver_protocol: "zcode-app-server-stdio-desktop-v1",
    request_security_capability: "official-installed-bundle-signing",
    coding_plan_discount_verified: true,
    start_plan_static_compatibility: "OFFLINE_RESEARCH_PENDING",
    verification_date: "2026-11-26",
  };
}

/** Complete the Desktop fixture with the executables the official resolver inspects. */
async function makeOfficialDesktop(root: string): Promise<DesktopFixture & { readonly manifest: OfficialAppServerRuntimeManifestEntry }> {
  const fixture = await makeDesktop(root);
  await mkdir(path.join(fixture.install, "resources", "tools", "runtime-host"), { recursive: true });
  await Promise.all([
    writeFile(path.join(fixture.install, "resources", "tools", "runtime-host", "zcode-runtime-host.exe"), "synthetic-runtime-host\n", "utf8"),
    writeFile(path.join(fixture.install, "ZCode.exe"), "synthetic-desktop-executable\n", "utf8"),
  ]);
  return { ...fixture, manifest: await officialManifest(fixture.install) };
}

function officialResolver(fixture: Awaited<ReturnType<typeof makeOfficialDesktop>>, env: NodeJS.ProcessEnv = {}) {
  const base: ZCodeRuntimeConfig = {
    nodeExecutable: "node",
    zcodeEntrypoint: fixture.entrypoint,
    providerBuiltinConfigFile: fixture.bundled,
    providerPersonalConfigFile: fixture.personal,
    zcodeDataRoot: path.join(fixture.dataBase, ".zcode"),
    dataRoot: fixture.dataBase,
  };
  return new OfficialAppServerRuntimeResolver({
    env: { ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.install, ...env },
    homeDir: fixture.dataBase,
    platform: "win32",
    architecture: "x64",
    manifest: [fixture.manifest],
    baseResolver: { resolve: async () => base },
    hashFile: async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex"),
    probeNodeVersion: async () => "v24.16.0",
    probeDesktopVersion: async () => fixture.manifest.desktop_version,
    inspectExecutable: async () => ({
      architecture: "x64",
      signature_status: "Valid",
      signer_subject: "CN=synthetic",
      signer_thumbprint: "SYNTHETIC",
    }),
  });
}

test("the official runtime resolver reports the active registry and keeps the installation identity bound to the bundled file", async () => {
  await withTempRoot(async (root) => {
    const fixture = await makeOfficialDesktop(root);
    const bundledDescriptor = await officialResolver(fixture).inspect();
    assert.equal(bundledDescriptor.status, "OFFICIAL_RUNTIME_VERIFIED");
    assert.equal(bundledDescriptor.active_builtin_provider_config_path, fixture.bundled);
    assert.equal(bundledDescriptor.active_builtin_provider_config_source, "bundled");
    assert.equal(bundledDescriptor.builtin_provider_config_sha256, fixture.manifest.builtin_provider_config_sha256);

    const runtimePath = await writeRuntimeRegistry(fixture.dataBase, registryRelease(48, "runtime"), { appVersion: "4.0.0" });
    const runtimeResolver = officialResolver(fixture);
    const descriptor = await runtimeResolver.inspect();
    assert.equal(descriptor.active_builtin_provider_config_path, runtimePath);
    assert.equal(descriptor.active_builtin_provider_config_source, "runtime");
    assert.equal(descriptor.active_builtin_provider_config_revision, 48);
    assert.equal(descriptor.builtin_provider_config_path, fixture.bundled);
    assert.equal(descriptor.builtin_provider_config_sha256, fixture.manifest.builtin_provider_config_sha256);
    assert.equal(descriptor.installation_fingerprint, bundledDescriptor.installation_fingerprint);
    assert.equal(descriptor.manifest?.desktop_version, "4.0.0.10870");

    const config = await runtimeResolver.resolve();
    assert.equal(config.providerBuiltinConfigFile, runtimePath);
    assert.equal(config.zcodeEntrypoint, fixture.entrypoint);

    const pinnedFile = path.join(root, "pinned", "zcode-builtin.json");
    await mkdir(path.dirname(pinnedFile), { recursive: true });
    await writeFile(pinnedFile, registryRelease(2, "pinned"), "utf8");
    const pinnedDescriptor = await officialResolver(fixture, {
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: pinnedFile,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: fixture.personal,
    }).inspect();
    assert.equal(pinnedDescriptor.active_builtin_provider_config_path, fixture.bundled);
    assert.equal(pinnedDescriptor.active_builtin_provider_config_source, "bundled");
  });
});

test("Executor and Worker AppServer environments carry the same non-secret Endpoint selectors", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows",
    ZCODE_ENV: "test",
    ZCODE_BASE_URL: " https://endpoint.example ",
    ZCODE_TEST_BASE_URL: "https://stage.example",
    ZCODE_API_KEY: "must-not-forward",
    BEARER_TOKEN: "must-not-forward",
  };
  const workerEnv = createWorkerEnv(source, { platform: "win32" });
  assert.equal(workerEnv.ZCODE_ENV, "test");
  assert.equal(workerEnv.ZCODE_BASE_URL, " https://endpoint.example ");
  assert.equal(workerEnv.ZCODE_TEST_BASE_URL, "https://stage.example");
  assert.equal(workerEnv.ZCODE_API_KEY, undefined);
  assert.equal(workerEnv.BEARER_TOKEN, undefined);

  const childEnv: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
  forwardOfficialEndpointEnv(childEnv, source);
  assert.deepEqual(
    { ...childEnv, PATH: undefined },
    { PATH: undefined, ZCODE_ENV: "test", ZCODE_BASE_URL: " https://endpoint.example ", ZCODE_TEST_BASE_URL: "https://stage.example" },
  );
  assert.equal(officialEndpointOrigin(childEnv), "https://endpoint.example");
});

test("doctor reports which official Built-in registry is in effect", async () => {
  await withTempRoot(async (root) => {
    const fixture = await makeDesktop(root);
    const env = {
      ZCODE_WINDOWS_APP_INSTALL_DIR: fixture.install,
      ZCODE_DATA_BASE_DIR: fixture.dataBase,
      ZCODE_HOME: path.join(fixture.dataBase, ".zcode"),
    };
    const doctor = async () => {
      const report = await runBridgeDoctor({
        env,
        resolver: { env, homeDir: path.join(root, "home"), packageRoot: root },
      });
      return report.checks.find((check) => check.name === "builtin_registry")?.summary ?? "";
    };
    assert.match(await doctor(), /installation fallback .*not written an official runtime registry/u);
    await writeRuntimeRegistry(fixture.dataBase, registryRelease(48, "runtime"), { appVersion: "4.0.0" });
    const summary = await doctor();
    assert.match(summary, /official runtime registry \(revision 48\)/u);
    assert.match(summary, new RegExp(`installation fallback ${escapeRegExp(fixture.bundled)}`));
  });
});

test("configure-runtime.ps1 persists only an explicit Built-in pin and clears the derived default", { skip: process.platform !== "win32" }, async () => {
  await withTempRoot(async (root) => {
    const fixture = await makeDesktop(root);
    const home = path.join(root, "user-home");
    await mkdir(home, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of Object.keys(env)) if (key.startsWith("ZCODE_")) delete env[key as keyof typeof env];
    const homeCheck = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$HOME"], {
      env, encoding: "utf8", windowsHide: true,
    });
    assert.equal(path.resolve(homeCheck.stdout.trim()), home, "refuse to run setup against the real home");
    const hook = fileURLToPath(new URL("../../plugins/codex-zcode-bridge/hooks/configure-runtime.ps1", import.meta.url));
    const configPath = path.join(home, ".codex", "codex-zcode-bridge", "runtime-config.json");
    const setup = (builtin: string) => spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hook,
      "-NodeExecutablePath", process.execPath,
      "-ZCodeRuntimePath", fixture.entrypoint,
      "-BuiltinProviderConfigPath", builtin,
      "-PersonalProviderConfigPath", fixture.personal,
      "-ZCodeHome", path.join(fixture.dataBase, ".zcode"),
    ], { env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    const saved = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

    const installationDefault = setup(fixture.bundled);
    assert.equal(installationDefault.status, 0, installationDefault.stderr);
    assert.equal((await saved()).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, null);
    assert.match(installationDefault.stdout, /prefers the official runtime registry/u);

    const pinnedFile = path.join(root, "pinned", "zcode-builtin.json");
    await mkdir(path.dirname(pinnedFile), { recursive: true });
    await writeFile(pinnedFile, registryRelease(2, "pinned"), "utf8");
    const pinned = setup(pinnedFile);
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal((await saved()).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, pinnedFile);
    assert.match(pinned.stdout, /explicitly pinned/u);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
