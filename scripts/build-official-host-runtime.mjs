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

const SOURCE_COMMIT = "b95ebaffeab641907b38652f45c1502bd762972d";
const SOURCE_TREE = "d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d";
const SOURCE_VERSION = "3.18.0";
const BUILD_NODE = "24.16.0";
const HOST_BUNDLER = "0.28.2";
const SCOPE = "win32-x64-node24.16.0-zcode3.18.0-b95ebaff";
const HOST_SOURCE_FILES = [
  "packages/services/src/official-host/runtimeHostEntry.ts",
  "packages/services/src/zcode-agent/zcodeAgentProcessManager.ts",
  "packages/services/src/zcode-agent/zcodeProtocolClient.ts",
  "packages/services/src/zcode-agent/zcodeStdioTransport.ts",
  "packages/services/src/model-provider/oauthProviderRuntimeAuthService.ts",
  "packages/services/src/oauth/oauthService.ts",
];
const HOST_EXPORTS = [
  "ZCodeAgentProcessManager",
  "ZCodeProtocolClient",
  "ZCodeStdioTransport",
  "createOAuthProviderRuntimeAuthService",
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

assertEqual(process.version, `v${BUILD_NODE}`, "build Node version");
assertEqual((await import("esbuild/package.json", { with: { type: "json" } })).default.version, HOST_BUNDLER, "esbuild version");
assertEqual(JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8")).version, SOURCE_VERSION, "source version");
assertEqual(await git(sourceRoot, ["rev-parse", "HEAD"]), SOURCE_COMMIT, "source commit");
assertEqual(await git(sourceRoot, ["rev-parse", "HEAD^{tree}"]), SOURCE_TREE, "source tree");

const bom = JSON.parse(await readFile(artifactBomPath, "utf8"));
const patches = await validateArtifactBomPatches(bom);
await validateSourceState(sourceRoot, patches);
const nativeFiles = await installNativeClosure(sourceRoot);

const stagingRoot = await mkdtemp(path.join(repoRoot, ".run", "official-host-build-"));
const stagedOutput = path.join(stagingRoot, "official-host-runtime.mjs");
let replaced = false;
try {
  await build({
    stdin: {
      contents: [
        'export { ZCodeAgentProcessManager } from "./packages/services/src/zcode-agent/zcodeAgentProcessManager.ts";',
        'export { ZCodeProtocolClient } from "./packages/services/src/zcode-agent/zcodeProtocolClient.ts";',
        'export { ZCodeStdioTransport } from "./packages/services/src/zcode-agent/zcodeStdioTransport.ts";',
        'export { createOAuthProviderRuntimeAuthService } from "./packages/services/src/official-host/runtimeHostEntry.ts";',
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

  const sourceAggregateDiffSha256 = await aggregateSourceDiffSha256(sourceRoot);
  updateBomOutput(bom, outputBytes.length, outputSha256, nativeFiles);
  await writeJson(artifactBomPath, bom);
  const bomBytes = await readFile(artifactBomPath);

  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.generatedOn = new Date().toISOString().slice(0, 10);
  provenance.source.trackedSourceModifiedByBuild = false;
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

async function validateArtifactBomPatches(value) {
  if (!Array.isArray(value.patches) || value.patches.length !== 3) {
    throw new Error("ARTIFACT_BOM.json must list the three ordered upstream patches");
  }
  const ordered = [...value.patches].sort((left, right) => left.order - right.order);
  for (let index = 0; index < ordered.length; index += 1) {
    const patch = ordered[index];
    if (patch.order !== index + 1
      || typeof patch.path !== "string"
      || !patch.path.startsWith("upstream/zcode-3.18.0/patches/")
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
    ordered[index] = { ...patch, absolutePath: patchPath };
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
}

async function aggregateSourceDiffSha256(sourceRootPath) {
  const proofRoot = await mkdtemp(path.join(repoRoot, ".run", "official-host-source-proof-"));
  const indexPath = path.join(proofRoot, "index");
  try {
    await git(sourceRootPath, ["read-tree", "HEAD"], { GIT_INDEX_FILE: indexPath });
    await git(sourceRootPath, ["add", "-A"], { GIT_INDEX_FILE: indexPath });
    const diff = await git(
      sourceRootPath,
      ["diff", "--cached", "--no-ext-diff", "--binary", "--full-index", "HEAD"],
      { GIT_INDEX_FILE: indexPath },
    );
    return sha256(Buffer.from(diff));
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

function updateBomOutput(bomValue, bytes, hash, nativeEntries) {
  const hostModulePath = "official-host-runtime.mjs";
  if (!Array.isArray(bomValue.files)) throw new Error("ARTIFACT_BOM.json is missing its file inventory");
  const entry = bomValue.files.find((file) => file.path === hostModulePath);
  if (!entry) throw new Error(`ARTIFACT_BOM.json is missing ${hostModulePath}`);
  entry.bytes = bytes;
  entry.sha256 = hash;
  bomValue.build.hostModuleCommand = "npm run build:official-host -- --source <fixed-upstream-worktree>";
  bomValue.build.hostModuleInputs = HOST_SOURCE_FILES;
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
