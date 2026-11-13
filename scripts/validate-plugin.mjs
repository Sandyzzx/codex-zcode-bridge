import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoRootLeakPattern } from "./lib/repo-root-pattern.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "codex-zcode-bridge");
const EXPECTED_OFFICIAL_HOST_SOURCE_DIFF_SHA256 =
  "A3F5B7BD7A653403B8362ADC121323404FB4F334B1CFFA0DF3C3E617F9F09AB2";

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();
}

const pkg = await readJson(path.join(root, "package.json"), "package.json");
const plugin = await readJson(path.join(pluginRoot, "plugin.json"), "plugin.json");
const codexPlugin = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), ".codex-plugin/plugin.json");
const portableMcp = await readJson(path.join(pluginRoot, "mcp.json"), "mcp.json");
const codexMcp = await readJson(path.join(pluginRoot, ".mcp.json"), ".mcp.json");

for (const [label, manifest] of [["plugin.json", plugin], [".codex-plugin/plugin.json", codexPlugin]]) {
  const hasLocalCachebuster =
    label === ".codex-plugin/plugin.json" &&
    typeof manifest.version === "string" &&
    manifest.version.startsWith(`${pkg.version}+codex.`) &&
    /^[a-z0-9-]+$/.test(manifest.version.slice(`${pkg.version}+codex.`.length));
  if (manifest.name !== pkg.name || (manifest.version !== pkg.version && !hasLocalCachebuster)) {
    throw new Error(`${label} identity/version must match package.json (${pkg.name}@${pkg.version})`);
  }
}
for (const [label, mcp] of [["mcp.json", portableMcp], [".mcp.json", codexMcp]]) {
  const server = mcp.mcpServers?.zcode_bridge;
  if (server?.command !== "node" || !Array.isArray(server.args) || server.args[0] !== "./launch-node24.mjs") {
    throw new Error(`${label} must launch ./launch-node24.mjs with node`);
  }
  if (server.env?.ZCODE_BRIDGE_PLUGIN_MODE !== "1") {
    throw new Error(`${label} must set ZCODE_BRIDGE_PLUGIN_MODE=1`);
  }
}

for (const relativePath of [
  "launch-node24.mjs",
  "dist/bridge.mjs",
  "dist/wait-task.mjs",
  "dist/schema.sql",
  "dist/runtime-events.sql",
  "dist/schema-v13.sql",
  "dist/upgrade-sqlite-v14.mjs",
  "dist/admin-abandon-held-operation.mjs",
  "dist/admin-abandonment.sql",
  "worker/worker-main.mjs",
  "worker/vendor/pkg/browser-host.cjs",
  "worker/vendor/browsers.json",
  "worker/vendor/package.json",
  "hooks/hooks.json",
  "hooks/session-start.mjs",
  "hooks/configure-runtime.ps1",
  "skills/zcode-bridge/SKILL.md",
  "skills/zcode-bridge/scripts/codex-master-token-usage.mjs",
]) {
  await access(path.join(pluginRoot, relativePath));
}

const packagedSchema = await readFile(path.join(pluginRoot, "dist", "schema.sql"));
const sourceSchema = await readFile(path.join(root, "src", "sqlite-candidate", "wp6b2b1", "schema.sql"));
if (!packagedSchema.equals(sourceSchema)) throw new Error("bundled SQLite schema does not match source");
const packagedRuntimeEvents = await readFile(path.join(pluginRoot, "dist", "runtime-events.sql"));
const sourceRuntimeEvents = await readFile(path.join(root, "src", "sqlite-candidate", "wp6b2b1", "runtime-events.sql"));
if (!packagedRuntimeEvents.equals(sourceRuntimeEvents)) throw new Error("bundled runtime event schema does not match source");
const packagedV13 = await readFile(path.join(pluginRoot, "dist", "schema-v13.sql"));
const sourceV13 = await readFile(path.join(root, "src", "sqlite-candidate", "wp6b2b1", "schema-v13.sql"));
if (!packagedV13.equals(sourceV13)) throw new Error("bundled v13 upgrade schema does not match source");
const packagedAdminSchema = await readFile(path.join(pluginRoot, "dist", "admin-abandonment.sql"));
const sourceAdminSchema = await readFile(path.join(root, "src", "sqlite-candidate", "wp6b2b1", "admin-abandonment.sql"));
if (!packagedAdminSchema.equals(sourceAdminSchema)) throw new Error("bundled administrative SQLite schema does not match source");
const sourceStore = await readFile(path.join(root, "src", "sqlite-candidate", "wp6b2b1", "store.mjs"), "utf8");
const sourceSchemaVersion = sourceStore.match(/const SCHEMA_VERSION = (\d+);/u)?.[1];
if (!sourceSchemaVersion) throw new Error("SQLite Store schema version is missing from source");
const adminBundle = await readFile(path.join(pluginRoot, "dist", "admin-abandon-held-operation.mjs"), "utf8");
if (!adminBundle.includes(`SCHEMA_VERSION = ${sourceSchemaVersion};`)) {
  throw new Error(`bundled administrative recovery CLI does not embed SQLite schema v${sourceSchemaVersion}`);
}

const pluginNotice = await readFile(path.join(pluginRoot, "NOTICE"), "utf8");
if (!pluginNotice.includes("PR #49 of")
  || !pluginNotice.includes("13ab83626a7fa7f35319a21244215c2915ecb112")
  || !pluginNotice.includes("Bill <chen.pengyu1@student.zy.cdut.edu.cn>")) {
  throw new Error("plugin NOTICE must preserve the PR #49 waiter attribution");
}
const waiterBundle = await readFile(path.join(pluginRoot, "dist", "wait-task.mjs"), "utf8");
if (!waiterBundle.includes("PR #49 of codex-zcode-bridge") || !waiterBundle.includes("13ab83626a7fa7f35319a21244215c2915ecb112")) {
  throw new Error("bundled wait-task.mjs must retain the PR #49 attribution banner");
}

// The installed plugin must load without the development checkout: bundles
// must not embed the repository's absolute path, and the ESM bundles must not
// statically import playwright-core — the pinned runtime ships only inside
// the vendored CommonJS backend, which resolves its registry data relative to
// its own directory (module-label comments inside the bundle legitimately
// mention the packaging path and are not an external dependency).
const repoRootPattern = buildRepoRootLeakPattern(root);
for (const relativePath of ["dist/bridge.mjs", "dist/wait-task.mjs", "dist/upgrade-sqlite-v14.mjs", "dist/admin-abandon-held-operation.mjs", "worker/worker-main.mjs", "worker/vendor/pkg/browser-host.cjs", "skills/zcode-bridge/scripts/codex-master-token-usage.mjs"]) {
  const bundle = await readFile(path.join(pluginRoot, relativePath), "utf8");
  if (repoRootPattern.test(bundle)) {
    throw new Error(`${relativePath} embeds the development repository's absolute path`);
  }
}
for (const relativePath of ["dist/bridge.mjs", "dist/wait-task.mjs", "worker/worker-main.mjs"]) {
  const bundle = await readFile(path.join(pluginRoot, relativePath), "utf8");
  if (/(?:from|import)\s*["']playwright-core["']/u.test(bundle)) {
    throw new Error(`${relativePath} statically imports playwright-core; the browser backend must load through the vendored bundle`);
  }
}
const vendorPackage = await readJson(path.join(pluginRoot, "worker", "vendor", "package.json"), "worker/vendor/package.json");
if (vendorPackage.name !== "playwright-core") {
  throw new Error("worker/vendor/package.json must be the vendored playwright-core package manifest");
}
const vendorBrowsers = await readJson(path.join(pluginRoot, "worker", "vendor", "browsers.json"), "worker/vendor/browsers.json");
if (!Array.isArray(vendorBrowsers.browsers) || vendorBrowsers.browsers.length === 0) {
  throw new Error("worker/vendor/browsers.json must be the vendored playwright-core registry data");
}
const workerBundle = await readFile(path.join(pluginRoot, "worker", "worker-main.mjs"), "utf8");
if (!workerBundle.includes("vendor") || !workerBundle.includes("browser-host.cjs")) {
  throw new Error("worker-main.mjs no longer references the vendored browser backend; update the loader or this check");
}
const bridgeBundle = await readFile(path.join(pluginRoot, "dist", "bridge.mjs"), "utf8");
if (!/loadOfficialStartPlanAuthenticationResolverFactory\d*\(\s*pathToFileURL\d*\(workerEntryPath\(\)\)/u.test(
  bridgeBundle,
)) {
  throw new Error("bridge.mjs must resolve Start Plan Official Host assets through the Worker-shaped module URL");
}

const officialHostRoot = path.join(
  pluginRoot,
  "worker",
  "vendor",
  "official-host",
  "win32-x64-node24.16.0-zcode3.18.2-fec97590",
);
const officialHostBomPath = path.join(officialHostRoot, "ARTIFACT_BOM.json");
const officialHostBom = await readJson(officialHostBomPath, "Official Host ARTIFACT_BOM.json");
if (officialHostBom.schemaVersion !== 1
  || officialHostBom.scope?.platform !== "win32"
  || officialHostBom.scope?.architecture !== "x64"
  || officialHostBom.scope?.node !== "24.16.0"
  || officialHostBom.scope?.zcodeVersion !== "3.18.2"
  || officialHostBom.source?.commit !== "fec975905a2abd4c07e35c40d51fa097a2258ec9"
  || officialHostBom.source?.tree !== "5e90fec80706b8381f94e4eef48cf821b9868916") {
  throw new Error("Official Host ARTIFACT_BOM.json has an unsupported schema, source, or scope");
}
if (!Array.isArray(officialHostBom.patches) || officialHostBom.patches.length === 0) {
  throw new Error("Official Host ARTIFACT_BOM.json must record the ordered upstream patch set");
}
const patchOrders = new Set();
for (const patch of officialHostBom.patches) {
  if (!Number.isSafeInteger(patch.order) || patch.order < 1 || patchOrders.has(patch.order)
    || typeof patch.path !== "string" || !patch.path.startsWith("upstream/zcode-3.18.2/patches/")
    || path.isAbsolute(patch.path) || !Number.isSafeInteger(patch.bytes) || patch.bytes < 1
    || typeof patch.sha256 !== "string" || !/^[0-9A-F]{64}$/.test(patch.sha256)) {
    throw new Error("Official Host ARTIFACT_BOM.json contains an invalid patch entry");
  }
  patchOrders.add(patch.order);
  const patchPath = path.resolve(root, patch.path);
  const relativePatchPath = path.relative(root, patchPath);
  if (relativePatchPath.startsWith("..") || path.isAbsolute(relativePatchPath)) {
    throw new Error(`Official Host patch path escapes the repository: ${patch.path}`);
  }
  const bytes = await readFile(patchPath);
  if (bytes.length !== patch.bytes || createHash("sha256").update(bytes).digest("hex").toUpperCase() !== patch.sha256) {
    throw new Error(`Official Host patch failed byte or SHA-256 validation: ${patch.path}`);
  }
  const sidecar = await readFile(`${patchPath}.sha256`, "utf8");
  const sidecarMatch = /^([0-9A-F]{64})  ([^\r\n]+)\r?\n?$/.exec(sidecar);
  if (!sidecarMatch
    || sidecarMatch[1] !== patch.sha256
    || sidecarMatch[2] !== path.basename(patch.path)) {
    throw new Error(`Official Host patch sidecar disagrees with its BOM: ${patch.path}`);
  }
}
const orderedPatchOrders = [...patchOrders].sort((left, right) => left - right);
if (orderedPatchOrders.some((order, index) => order !== index + 1)) {
  throw new Error("Official Host patch order must be contiguous and start at 1");
}
if (!Array.isArray(officialHostBom.files) || officialHostBom.files.length === 0) {
  throw new Error("Official Host ARTIFACT_BOM.json must record its shipped files");
}
const requiredOfficialHostFiles = new Set([
  "app-server/provider/zcode-builtin.json",
  "app-server/THIRD-PARTY-NOTICES.md",
  "app-server/zcode.cjs",
  "LICENSE",
  "NOTICE.md",
  "node_modules/@napi-rs/keyring/LICENSE",
  "node_modules/@napi-rs/keyring/index.js",
  "node_modules/@napi-rs/keyring/package.json",
  "node_modules/@napi-rs/keyring-win32-x64-msvc/LICENSE.third-party.md",
  "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
  "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
  "official-host-runtime.mjs",
  "zcode-runtime-host.exe",
]);
const recordedOfficialHostFiles = new Set();
for (const entry of officialHostBom.files) {
  if (typeof entry.path !== "string" || !entry.path || path.isAbsolute(entry.path)
    || entry.path.includes("\\") || entry.path.split("/").some((part) => !part || part === "." || part === "..")
    || recordedOfficialHostFiles.has(entry.path)
    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
    || typeof entry.sha256 !== "string" || !/^[0-9A-F]{64}$/.test(entry.sha256)) {
    throw new Error("Official Host ARTIFACT_BOM.json contains an invalid shipped-file entry");
  }
  recordedOfficialHostFiles.add(entry.path);
  if (!requiredOfficialHostFiles.has(entry.path)) {
    throw new Error(`Official Host ARTIFACT_BOM.json contains an unexpected shipped file: ${entry.path}`);
  }
  const filePath = path.resolve(officialHostRoot, entry.path);
  const relativeFilePath = path.relative(officialHostRoot, filePath);
  if (relativeFilePath.startsWith("..") || path.isAbsolute(relativeFilePath)) {
    throw new Error(`Official Host shipped-file path escapes the artifact root: ${entry.path}`);
  }
  await access(filePath);
  const bytes = await readFile(filePath);
  if (bytes.length !== entry.bytes
    || createHash("sha256").update(bytes).digest("hex").toUpperCase() !== entry.sha256) {
    throw new Error(`Official Host shipped file failed byte or SHA-256 validation: ${entry.path}`);
  }
}
for (const requiredPath of requiredOfficialHostFiles) {
  if (!recordedOfficialHostFiles.has(requiredPath)) {
    throw new Error(`Official Host ARTIFACT_BOM.json is missing required shipped file: ${requiredPath}`);
  }
}
const officialHostProvenance = await readJson(
  path.join(officialHostRoot, "BUILD_PROVENANCE.json"),
  "Official Host BUILD_PROVENANCE.json",
);
const officialHostBomBytes = await readFile(officialHostBomPath);
if (officialHostProvenance.source?.commit !== officialHostBom.source.commit
  || officialHostProvenance.source?.tree !== officialHostBom.source.tree
  || officialHostProvenance.source?.version !== officialHostBom.source.version
  || officialHostBom.build?.sourceAggregateDiffSha256 !== EXPECTED_OFFICIAL_HOST_SOURCE_DIFF_SHA256
  || officialHostProvenance.source?.aggregateDiffSha256 !== EXPECTED_OFFICIAL_HOST_SOURCE_DIFF_SHA256
  || officialHostProvenance.bom?.path !== "ARTIFACT_BOM.json"
  || officialHostProvenance.bom?.bytes !== officialHostBomBytes.length
  || officialHostProvenance.bom?.sha256 !== createHash("sha256").update(officialHostBomBytes).digest("hex").toUpperCase()
  || officialHostProvenance.output?.sha256 !== officialHostBom.files.find(
    (entry) => entry.path === "official-host-runtime.mjs",
  )?.sha256) {
  throw new Error("Official Host BUILD_PROVENANCE.json disagrees with ARTIFACT_BOM.json");
}
const officialHostModuleText = await readFile(path.join(officialHostRoot, "official-host-runtime.mjs"), "utf8");
if (repoRootPattern.test(officialHostModuleText)) {
  throw new Error("official-host-runtime.mjs embeds the development repository's absolute path");
}
if (!officialHostModuleText.includes("createOAuthProviderRuntimeAuthService")
  || !officialHostModuleText.includes("createOfficialStartPlanAuthenticationResolver")) {
  throw new Error("official-host-runtime.mjs is missing an official authentication factory");
}
if (!workerBundle.includes("OfficialHostAdapter")
  || !workerBundle.includes("official-host-runtime.mjs")
  || !workerBundle.includes("maxFrameBytes")) {
  throw new Error("worker-main.mjs is missing the shipped Official Host integration");
}

console.log(`Plugin package is structurally valid (${plugin.name}@${plugin.version}).`);

