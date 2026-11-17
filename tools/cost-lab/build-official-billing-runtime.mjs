import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

const SOURCE_COMMIT = "fec975905a2abd4c07e35c40d51fa097a2258ec9";
const SOURCE_TREE = "5e90fec80706b8381f94e4eef48cf821b9868916";
const SOURCE_VERSION = "3.18.2";
const BUILD_NODE = "24.16.0";
const EXPECTED_ESBUILD = "0.28.2";
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
const PATCH_PATH = path.join(
  SCRIPT_ROOT,
  "vendor",
  "patches",
  "cost-lab-billing-runtime.patch",
);
const DEFAULT_OUTPUT = path.join(
  SCRIPT_ROOT,
  "vendor",
  "official-billing-runtime.mjs",
);

const options = parseArgs(process.argv.slice(2));
if (!options.source) {
  throw new Error("usage: node tools/cost-lab/build-official-billing-runtime.mjs --source <clean-zcode-worktree> [--output <file>]");
}

assertEqual(process.version, `v${BUILD_NODE}`, "Node version");
assertEqual(esbuildVersion, EXPECTED_ESBUILD, "esbuild version");

const sourceRoot = path.resolve(options.source);
const outputPath = path.resolve(options.output ?? DEFAULT_OUTPUT);
const sourcePackage = JSON.parse(
  await readFile(path.join(sourceRoot, "package.json"), "utf8"),
);
assertEqual(sourcePackage.version, SOURCE_VERSION, "source version");
assertEqual(await git(sourceRoot, ["rev-parse", "HEAD"]), SOURCE_COMMIT, "source commit");
assertEqual(
  await git(sourceRoot, ["rev-parse", "HEAD^{tree}"]),
  SOURCE_TREE,
  "source tree",
);
const sourceStatus = await git(sourceRoot, [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
], false);
if (sourceStatus.trim()) throw new Error("official source worktree must be clean");

const patchBytes = await readFile(PATCH_PATH);
const patchSha256 = sha256(patchBytes);
await git(sourceRoot, ["apply", "--check", "--whitespace=nowarn", PATCH_PATH]);

await mkdir(path.join(PROJECT_ROOT, ".run"), { recursive: true });
const temporaryRoot = path.join(
  PROJECT_ROOT,
  ".run",
  `cost-lab-billing-build-${process.pid}-${randomUUID()}`,
);
let worktreeCreated = false;
let patchApplied = false;
let workspaceLinks = [];

try {
  await git(sourceRoot, [
    "worktree",
    "add",
    "--detach",
    temporaryRoot,
    SOURCE_COMMIT,
  ]);
  worktreeCreated = true;
  await git(temporaryRoot, ["apply", "--whitespace=nowarn", PATCH_PATH]);
  patchApplied = true;
  workspaceLinks = await linkWorkspacePackages(temporaryRoot);

  const sourceStatusAfterPatch = await git(temporaryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ], false);
  const expectedPaths = patchPaths(patchBytes.toString("utf8"));
  const actualPaths = sourceStatusAfterPatch
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).trimStart());
  assertSameSet(actualPaths, expectedPaths, "patched source paths");

  const stagedOutput = path.join(temporaryRoot, "official-billing-runtime.mjs");
  await build({
    stdin: {
      contents:
        'export { createCostLabBillingRuntime, createCostLabReadOnlyApiClient, createCostLabReadOnlyLocationStore } from "./packages/services/src/official-host/runtimeHostEntry.ts";',
      resolveDir: temporaryRoot,
      sourcefile: "cost-lab-billing-runtime-entry.ts",
      loader: "ts",
    },
    outfile: stagedOutput,
    absWorkingDir: temporaryRoot,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "eof",
    define: {
      __ZCODE_VERSION__: JSON.stringify(SOURCE_VERSION),
    },
    external: ["@napi-rs/keyring"],
    banner: {
      js: `// Built from ZCode ${SOURCE_COMMIT} (${SOURCE_VERSION}) with the Cost Lab billing patch.`,
    },
    logLevel: "info",
  });

  const outputBytes = await readFile(stagedOutput);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await copyFile(stagedOutput, `${outputPath}.tmp`);
  await rename(`${outputPath}.tmp`, outputPath);

  console.log(JSON.stringify({
    source_commit: SOURCE_COMMIT,
    source_tree: SOURCE_TREE,
    source_version: SOURCE_VERSION,
    source_tree_dirty: false,
    patch: {
      path: path.relative(PROJECT_ROOT, PATCH_PATH).replaceAll("\\", "/"),
      bytes: patchBytes.length,
      sha256: patchSha256,
    },
    builder: {
      node: process.version.slice(1),
      esbuild: esbuildVersion,
      target: "node24",
      format: "esm",
    },
    output: {
      path: path.relative(PROJECT_ROOT, outputPath).replaceAll("\\", "/"),
      bytes: outputBytes.length,
      sha256: sha256(outputBytes),
    },
  }, null, 2));
} finally {
  await removeWorkspaceLinks(workspaceLinks);
  if (patchApplied) {
    await git(temporaryRoot, ["apply", "-R", "--whitespace=nowarn", PATCH_PATH])
      .catch(() => undefined);
  }
  await rm(path.join(temporaryRoot, "official-billing-runtime.mjs"), { force: true })
    .catch(() => undefined);
  if (worktreeCreated) {
    const status = await git(temporaryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ], false).catch(() => "STATUS_FAILED");
    if (status.trim()) {
      console.error(`temporary source worktree retained for inspection: ${temporaryRoot}`);
    } else {
      await git(sourceRoot, ["worktree", "remove", temporaryRoot]);
    }
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const parsed = { source: null, output: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--source" && arg !== "--output") {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    parsed[arg.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

async function linkWorkspacePackages(sourceRootPath) {
  const packagesRoot = path.join(sourceRootPath, "packages");
  const nodeModulesRoot = path.join(sourceRootPath, "node_modules");
  const links = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(packagesRoot, entry.name);
    const packageJsonPath = path.join(packageRoot, "package.json");
    const metadata = await stat(packageJsonPath).catch(() => null);
    if (!metadata?.isFile()) continue;
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (typeof packageJson.name !== "string" || !packageJson.name) continue;
    const [scope, name] = packageJson.name.startsWith("@")
      ? packageJson.name.split("/")
      : [null, packageJson.name];
    const destinationParent = scope
      ? path.join(nodeModulesRoot, scope)
      : nodeModulesRoot;
    const destination = path.join(destinationParent, name);
    await mkdir(destinationParent, { recursive: true });
    await symlink(packageRoot, destination, "junction");
    links.push(destination);
  }
  return links;
}

async function removeWorkspaceLinks(links) {
  for (const link of links.reverse()) {
    await unlink(link).catch(() => undefined);
  }
  const nodeModulesRoot = path.join(temporaryRoot, "node_modules");
  const scopeRoot = path.join(nodeModulesRoot, "@zcode");
  await rmdir(scopeRoot).catch(() => undefined);
  await rmdir(path.join(nodeModulesRoot, "@zcode-dev")).catch(() => undefined);
  await rmdir(nodeModulesRoot).catch(() => undefined);
}

function patchPaths(text) {
  return [...text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu)]
    .map((match) => match[1]);
}

function assertSameSet(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((entry) => !actualSet.has(entry));
  const unexpected = [...actualSet].filter((entry) => !expectedSet.has(entry));
  if (missing.length || unexpected.length) {
    throw new Error(
      `${label}: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }
}

async function git(cwd, args, trim = true) {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
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
        reject(
          new Error(
            `git ${args.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      resolve(trim ? output.trim() : output);
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
