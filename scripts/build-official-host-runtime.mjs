import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SOURCE_COMMIT = "fec975905a2abd4c07e35c40d51fa097a2258ec9";
const SOURCE_TREE = "5e90fec80706b8381f94e4eef48cf821b9868916";
const SOURCE_VERSION = "3.18.2";
const BUILD_NODE = "24.16.0";
const HOST_BUNDLER = "0.28.2";
const SCOPE = "win32-x64-node24.16.0-zcode3.18.2-fec97590";
const PATCH_ROOT = "upstream/zcode-3.18.2/patches/";
const RUNTIME_HOST = Object.freeze({
  path: "zcode-runtime-host.exe",
  role: "official Authenticode-signed Windows process-ownership helper from ZCode Desktop 3.18.2.10443",
  bytes: 179608,
  sha256: "C2C8FF5FF28CBDDC4F177C094AA67C322830889612251BD173BAAABC89379AB4",
  license: "ZCode project terms; redistribution approved by the repository owner; LICENSE and NOTICE.md included",
  verification: Object.freeze({
    architecture: "win32-x64",
    peMachine: "0x8664",
    authenticode: "Valid",
    signerCommonName: "北京智谱华章科技股份有限公司",
    signerOrganization: "北京智谱华章科技股份有限公司",
    reportedVersion: "zcode-runtime-host 1",
    verifiedOn: "2026-11-15",
  }),
});
const RUNTIME_HOST_BUILD = Object.freeze({
  sourceKind: "OFFICIAL_INSTALLED_DISTRIBUTION",
  desktopProductVersion: "3.18.2.10443",
  zcodeVersion: SOURCE_VERSION,
  zcodeSourceCommit: SOURCE_COMMIT,
  bytes: RUNTIME_HOST.bytes,
  sha256: RUNTIME_HOST.sha256,
  architecture: RUNTIME_HOST.verification.architecture,
  peMachine: RUNTIME_HOST.verification.peMachine,
  authenticode: RUNTIME_HOST.verification.authenticode,
  signerCommonName: RUNTIME_HOST.verification.signerCommonName,
  signerOrganization: RUNTIME_HOST.verification.signerOrganization,
  reportedVersion: RUNTIME_HOST.verification.reportedVersion,
});
const HOST_SOURCE_FILES = [
  "packages/shared/src/credential-security/contract.ts",
  "packages/shared/src/credential-security/systemCredentialCipher.ts",
  "packages/shared/src/version.ts",
  "packages/services/src/credential/credentialService.ts",
  "packages/services/src/oauth/repo/oauthCredentialRepo.ts",
  "packages/services/src/official-host/runtimeHostEntry.ts",
  "packages/services/src/official-host/startPlanAuthentication.ts",
  "packages/services/src/zcode-agent/zcodeAgentProcessManager.ts",
  "packages/services/src/zcode-agent/zcodeProtocolClient.ts",
  "packages/services/src/zcode-agent/zcodeStdioTransport.ts",
  "packages/services/src/model-provider/oauthProviderRuntimeAuthService.ts",
  "packages/services/src/oauth/oauthService.ts",
  "packages/services/src/oauth/providers/providerAdapter.ts",
  "packages/services/src/telemetry/telemetryCore.ts",
];
const HOST_EXPORTS = [
  "ZCODE_PRODUCT_VERSION",
  "ZCodeAgentProcessManager",
  "ZCodeProtocolClient",
  "ZCodeStdioTransport",
  "createOAuthProviderRuntimeAuthService",
  "createOfficialStartPlanAuthenticationResolver",
];
const NATIVE_VENDOR_FILES = [
  {
    source: "node_modules/@napi-rs/keyring/LICENSE",
    path: "node_modules/@napi-rs/keyring/LICENSE",
    role: "keyring package license",
    license: "MIT",
  },
  {
    source: "node_modules/@napi-rs/keyring/index.js",
    path: "node_modules/@napi-rs/keyring/index.js",
    role: "Node-API keyring loader",
    license: "MIT",
  },
  {
    source: "node_modules/@napi-rs/keyring/package.json",
    path: "node_modules/@napi-rs/keyring/package.json",
    role: "Node-API keyring package metadata",
    license: "MIT",
  },
  {
    source: "node_modules/@napi-rs/keyring-win32-x64-msvc/LICENSE.third-party.md",
    path: "node_modules/@napi-rs/keyring-win32-x64-msvc/LICENSE.third-party.md",
    role: "Windows x64 keyring binary license and third-party notices",
    license: "MIT and bundled third-party terms",
  },
  {
    source: "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
    path: "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
    role: "Windows x64 Node-API keyring binding",
    license: "MIT",
  },
  {
    source: "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
    path: "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
    role: "Windows x64 keyring package metadata",
    license: "MIT",
  },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(
  repoRoot,
  "plugins",
  "codex-zcode-bridge",
  "worker",
  "vendor",
  "official-host",
  SCOPE,
);
const artifactBomPath = path.join(artifactRoot, "ARTIFACT_BOM.json");
const provenancePath = path.join(artifactRoot, "BUILD_PROVENANCE.json");
const outputPath = path.join(artifactRoot, "official-host-runtime.mjs");

const sourceArg = parseArgs(process.argv.slice(2));
if (!sourceArg) {
  throw new Error("usage: node scripts/build-official-host-runtime.mjs --source <fixed-upstream-worktree>");
}
const sourceRoot = path.resolve(sourceArg);
const sourcePackage = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
const sourceProductVersion = sourcePackage?.version;

assertEqual(process.version, `v${BUILD_NODE}`, "build Node version");
assertEqual((await import("esbuild/package.json", { with: { type: "json" } })).default.version, HOST_BUNDLER, "esbuild version");
assertEqual(sourceProductVersion, SOURCE_VERSION, "source version");
assertEqual(await git(sourceRoot, ["rev-parse", "HEAD"]), SOURCE_COMMIT, "source commit");
assertEqual(await git(sourceRoot, ["rev-parse", "HEAD^{tree}"]), SOURCE_TREE, "source tree");

const bom = JSON.parse(await readFile(artifactBomPath, "utf8"));
assertEqual(bom.scope?.zcodeVersion, sourceProductVersion, "BOM product version");
await validateRuntimeHost(bom);
const patches = await validateArtifactBomPatches(bom);
const sourceState = await validateSourceState(sourceRoot, patches);
const nativeFiles = await installNativeClosure(sourceRoot);

const stagingRoot = await mkdtemp(path.join(repoRoot, ".run", "official-host-build-"));
const stagedOutput = path.join(stagingRoot, "official-host-runtime.mjs");
let replaced = false;
try {
  await build({
    stdin: {
      contents: [
        'export { ZCODE_VERSION as ZCODE_PRODUCT_VERSION } from "./packages/shared/src/version.ts";',
        'export { ZCodeAgentProcessManager } from "./packages/services/src/zcode-agent/zcodeAgentProcessManager.ts";',
        'export { ZCodeProtocolClient } from "./packages/services/src/zcode-agent/zcodeProtocolClient.ts";',
        'export { ZCodeStdioTransport } from "./packages/services/src/zcode-agent/zcodeStdioTransport.ts";',
        'export { createOAuthProviderRuntimeAuthService, createOfficialStartPlanAuthenticationResolver } from "./packages/services/src/official-host/runtimeHostEntry.ts";',
      ].join("\n"),
      resolveDir: sourceRoot,
      sourcefile: "official-host-runtime-entry.ts",
      loader: "ts",
    },
    outfile: stagedOutput,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "eof",
    define: {
      __ZCODE_VERSION__: JSON.stringify(sourceProductVersion),
    },
    logLevel: "info",
    external: ["@napi-rs/keyring"],
    banner: {
      js: `// Built from ZCode ${SOURCE_COMMIT} (${SOURCE_VERSION}) for the Bridge Official Host runtime.`,
    },
  });

  const outputBytes = await readFile(stagedOutput);
  const outputSha256 = sha256(outputBytes);
  await rename(stagedOutput, outputPath);
  replaced = true;

  const sourceAggregateDiffSha256 = sourceState.aggregateDiffSha256;
  updateBomOutput(
    bom,
    outputBytes.length,
    outputSha256,
    nativeFiles,
    sourceAggregateDiffSha256,
  );
  await writeJson(artifactBomPath, bom);
  const bomBytes = await readFile(artifactBomPath);

  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.generatedOn = new Date().toISOString().slice(0, 10);
  provenance.source.trackedSourceModifiedByBuild = false;
  provenance.source.userDesktopInstallationUsedAsInput = true;
  provenance.source.aggregateDiffSha256 = sourceAggregateDiffSha256;
  provenance.patches = patches.map(({ order, path: patchPath, bytes, sha256: patchSha256 }) => ({
    order,
    path: patchPath,
    bytes,
    sha256: patchSha256,
  }));
  provenance.build.hostModule = {
    command: "npm run build:official-host -- --source <fixed-upstream-worktree>",
    output: "official-host-runtime.mjs",
    entry: {
      exports: HOST_EXPORTS,
      sourceFiles: HOST_SOURCE_FILES,
    },
  };
  provenance.build.runtimeHost = {
    command: "Adopt the Authenticode-signed zcode-runtime-host.exe from the official ZCode Desktop 3.18.2.10443 distribution",
    output: RUNTIME_HOST.path,
    ...RUNTIME_HOST_BUILD,
    redistribution: "APPROVED_BY_REPOSITORY_OWNER",
  };
  provenance.bom = {
    path: "ARTIFACT_BOM.json",
    bytes: bomBytes.length,
    sha256: sha256(bomBytes),
  };
  provenance.output = {
    path: "official-host-runtime.mjs",
    bytes: outputBytes.length,
    sha256: outputSha256,
  };
  provenance.verification.artifactReproducibility = "DETERMINISTIC_SAME_SOURCE_TREE";
  await writeJson(provenancePath, provenance);

  console.log(JSON.stringify({
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
    sourceAggregateDiffSha256,
    outputBytes: outputBytes.length,
    outputSha256,
    bomBytes: bomBytes.length,
    bomSha256: sha256(bomBytes),
  }, null, 2));
} catch (error) {
  if (!replaced) {
    try {
      await stat(stagedOutput);
      await rm(stagedOutput, { force: true });
    } catch {
      // The build may have failed before producing an output.
    }
  }
  throw error;
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

function parseArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--source") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--source requires a path");
      return value;
    }
  }
  return null;
}

async function validateRuntimeHost(bomValue) {
  if (bomValue.build?.userDesktopInstallationUsedAsInput !== true
    || bomValue.build?.runtimeHostCommand
      !== "Adopt the Authenticode-signed zcode-runtime-host.exe from the official ZCode Desktop 3.18.2.10443 distribution"
    || JSON.stringify(bomValue.build?.runtimeHostInputs)
      !== JSON.stringify(["resources/tools/runtime-host/zcode-runtime-host.exe"])
    || JSON.stringify(bomValue.build?.runtimeHostProvenance) !== JSON.stringify(RUNTIME_HOST_BUILD)
    || bomValue.toolchain?.runtimeHostToolchain !== "UPSTREAM_SIGNED_RELEASE_BINARY") {
    throw new Error("ARTIFACT_BOM.json does not record the adopted official signed runtime host");
  }

  const hostFile = bomValue.files?.find((entry) => entry.path === RUNTIME_HOST.path);
  if (!hostFile
    || hostFile.bytes !== RUNTIME_HOST.bytes
    || hostFile.sha256 !== RUNTIME_HOST.sha256
    || hostFile.role !== RUNTIME_HOST.role
    || hostFile.license !== RUNTIME_HOST.license
    || JSON.stringify(hostFile.verification) !== JSON.stringify(RUNTIME_HOST.verification)) {
    throw new Error("ARTIFACT_BOM.json contains stale or incomplete runtime-host provenance");
  }

  const bytes = await readFile(path.join(artifactRoot, RUNTIME_HOST.path));
  if (bytes.length !== RUNTIME_HOST.bytes || sha256(bytes) !== RUNTIME_HOST.sha256) {
    throw new Error("zcode-runtime-host.exe failed its pinned byte or SHA-256 validation");
  }
  validatePeX64(bytes);
}

function validatePeX64(bytes) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error("zcode-runtime-host.exe is not a PE executable");
  }
  const peOffset = bytes.readInt32LE(0x3c);
  if (peOffset < 0
    || peOffset + 6 > bytes.length
    || bytes.readUInt32LE(peOffset) !== 0x00004550
    || bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error("zcode-runtime-host.exe is not a Windows x64 PE executable");
  }
}

async function validateArtifactBomPatches(value) {
  if (!Array.isArray(value.patches) || value.patches.length !== 3) {
    throw new Error("ARTIFACT_BOM.json must list the three ordered upstream patches");
  }
  const ordered = [...value.patches].sort((left, right) => left.order - right.order);
  for (let index = 0; index < ordered.length; index += 1) {
    const patch = ordered[index];
    if (patch.order !== index + 1
      || typeof patch.path !== "string"
      || !patch.path.startsWith(PATCH_ROOT)
      || path.isAbsolute(patch.path)
      || !Number.isSafeInteger(patch.bytes)
      || patch.bytes < 1
      || typeof patch.sha256 !== "string"
      || !/^[0-9A-F]{64}$/u.test(patch.sha256)) {
      throw new Error("ARTIFACT_BOM.json contains an invalid ordered patch entry");
    }
    const patchPath = path.resolve(repoRoot, patch.path);
    const relative = path.relative(repoRoot, patchPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Official Host patch escapes the repository: ${patch.path}`);
    }
    const bytes = await readFile(patchPath);
    if (bytes.length !== patch.bytes || sha256(bytes) !== patch.sha256) {
      throw new Error(`Official Host patch failed byte or SHA-256 validation: ${patch.path}`);
    }
    const sidecarPath = `${patchPath}.sha256`;
    const sidecar = await readFile(sidecarPath, "utf8");
    const sidecarMatch = /^([0-9A-F]{64})  ([^\r\n]+)\r?\n?$/u.exec(sidecar);
    if (!sidecarMatch
      || sidecarMatch[1] !== patch.sha256
      || sidecarMatch[2] !== path.basename(patch.path)) {
      throw new Error(`Official Host patch sidecar disagrees with its BOM: ${patch.path}`);
    }
    ordered[index] = { ...patch, absolutePath: patchPath, sidecarPath };
  }
  return ordered;
}

async function validateSourceState(sourceRootPath, patchEntries) {
  const expectedPaths = new Set();
  for (const patch of patchEntries) {
    const text = await readFile(patch.absolutePath, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
      if (!match) continue;
      if (match[1] !== match[2]) throw new Error(`rename patches are unsupported: ${line}`);
      expectedPaths.add(match[1]);
    }
  }
  if (expectedPaths.size === 0) throw new Error("Official Host patches contain no file diffs");

  const status = await git(
    sourceRootPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {},
    false,
  );
  const actualPaths = new Set();
  for (const line of status.split(/\r?\n/u).filter(Boolean)) {
    if (line.length < 4 || line[2] !== " ") throw new Error(`invalid Git status entry: ${line}`);
    if (line.slice(0, 2).includes("R") || line.slice(0, 2).includes("C")) {
      throw new Error(`rename/copy status is unsupported: ${line}`);
    }
    actualPaths.add(line.slice(3));
  }
  const missing = [...expectedPaths].filter((entry) => !actualPaths.has(entry));
  const unexpected = [...actualPaths].filter((entry) => !expectedPaths.has(entry));
  if (missing.length || unexpected.length) {
    throw new Error(
      `fixed source tree does not contain exactly the ordered patch set; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }

  const proofRoot = await mkdtemp(path.join(repoRoot, ".run", "official-host-source-proof-"));
  const expectedIndexPath = path.join(proofRoot, "expected-index");
  const actualIndexPath = path.join(proofRoot, "actual-index");
  try {
    await git(sourceRootPath, ["read-tree", "HEAD"], { GIT_INDEX_FILE: expectedIndexPath });
    for (const patch of patchEntries) {
      await git(
        sourceRootPath,
        ["apply", "--cached", "--whitespace=nowarn", patch.absolutePath],
        { GIT_INDEX_FILE: expectedIndexPath },
      );
    }
    const expectedTree = await git(
      sourceRootPath,
      ["write-tree"],
      { GIT_INDEX_FILE: expectedIndexPath },
    );

    await git(sourceRootPath, ["read-tree", "HEAD"], { GIT_INDEX_FILE: actualIndexPath });
    await git(sourceRootPath, ["add", "-A"], { GIT_INDEX_FILE: actualIndexPath });
    const actualTree = await git(
      sourceRootPath,
      ["write-tree"],
      { GIT_INDEX_FILE: actualIndexPath },
    );
    if (actualTree !== expectedTree) {
      throw new Error(
        `fixed source tree content does not match the ordered patch set; expected-tree=${expectedTree} actual-tree=${actualTree}`,
      );
    }
    const diff = await git(
      sourceRootPath,
      ["diff", "--cached", "--no-ext-diff", "--binary", "--full-index", "HEAD"],
      { GIT_INDEX_FILE: actualIndexPath },
    );
    return {
      aggregateDiffSha256: sha256(Buffer.from(diff)),
      expectedTree,
      actualTree,
    };
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
  }
}

async function installNativeClosure(sourceRootPath) {
  const entries = [];
  for (const definition of NATIVE_VENDOR_FILES) {
    const sourcePath = path.join(sourceRootPath, definition.source);
    const destinationPath = path.join(artifactRoot, definition.path);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    const bytes = await readFile(destinationPath);
    entries.push({
      path: definition.path,
      role: definition.role,
      bytes: bytes.length,
      sha256: sha256(bytes),
      license: definition.license,
    });
  }
  return entries;
}

function updateBomOutput(bomValue, bytes, hash, nativeEntries, sourceAggregateDiffSha256) {
  const hostModulePath = "official-host-runtime.mjs";
  if (!Array.isArray(bomValue.files)) throw new Error("ARTIFACT_BOM.json is missing its file inventory");
  const entry = bomValue.files.find((file) => file.path === hostModulePath);
  if (!entry) throw new Error(`ARTIFACT_BOM.json is missing ${hostModulePath}`);
  entry.bytes = bytes;
  entry.sha256 = hash;
  bomValue.build.hostModuleCommand = "npm run build:official-host -- --source <fixed-upstream-worktree>";
  bomValue.build.hostModuleInputs = HOST_SOURCE_FILES;
  bomValue.build.sourceAggregateDiffSha256 = sourceAggregateDiffSha256;
  bomValue.toolchain.runtimeHostToolchain = "UPSTREAM_SIGNED_RELEASE_BINARY";
  bomValue.build.runtimeHostCommand =
    "Adopt the Authenticode-signed zcode-runtime-host.exe from the official ZCode Desktop 3.18.2.10443 distribution";
  bomValue.build.runtimeHostInputs = ["resources/tools/runtime-host/zcode-runtime-host.exe"];
  bomValue.build.runtimeHostProvenance = { ...RUNTIME_HOST_BUILD };
  bomValue.build.userDesktopInstallationUsedAsInput = true;
  const runtimeHostEntry = bomValue.files.find((file) => file.path === RUNTIME_HOST.path);
  if (!runtimeHostEntry) throw new Error(`ARTIFACT_BOM.json is missing ${RUNTIME_HOST.path}`);
  Object.assign(runtimeHostEntry, {
    role: RUNTIME_HOST.role,
    bytes: RUNTIME_HOST.bytes,
    sha256: RUNTIME_HOST.sha256,
    license: RUNTIME_HOST.license,
    verification: { ...RUNTIME_HOST.verification },
  });
  for (const nativeEntry of nativeEntries) {
    const existing = bomValue.files.find((file) => file.path === nativeEntry.path);
    if (existing) Object.assign(existing, nativeEntry);
    else bomValue.files.push(nativeEntry);
  }
  bomValue.files.sort((left, right) => left.path.localeCompare(right.path));
  bomValue.closure.hostModuleExternalRuntimeImports = ["@napi-rs/keyring", "node:*"];
  bomValue.closure.nativeDependencyClosure = "WIN32_X64_KEYRING_INCLUDED";
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function git(cwd, args, extraEnv = {}, trimOutput = true) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      resolve(trimOutput ? output.trim() : output);
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
