import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_OFFICIAL_SOURCE,
  DEFAULT_RUN_ROOT,
  EXPECTED_OFFICIAL_SOURCE,
  PROJECT_ROOT,
  auditOfficialAssemblySources,
} from "./official-assembly-probe.mjs";
import {
  NETWORK_TARGET_INVENTORY,
  compareIdentitySurfaces,
  coverageSummary,
  correlateRpcToHttp,
  modelRequestShape,
  readWireEvidence,
  sanitizeOfficialCapture,
  summarizeRequestAuth,
} from "./network-observer.mjs";

export const OFFICIAL_HOST_ROOT = path.join(
  PROJECT_ROOT,
  "plugins",
  "codex-zcode-bridge",
  "worker",
  "vendor",
  "official-host",
  "win32-x64-node24.16.0-zcode3.18.2-fec97590",
);

const INSTALLED_ZCODE_ROOT = path.join(
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
  "Programs",
  "ZCode",
);

const HOST_ASSETS = Object.freeze({
  hostModule: {
    relativePath: "official-host-runtime.mjs",
    bytes: 1_829_872,
    sha256: "7e2b8b772f1dd83135903b64d569d634c7e7fc6f303460e08c98e27d311b6a91",
  },
  appServerEntry: {
    relativePath: "app-server/zcode.cjs",
    bytes: 31_009_692,
    sha256: "b55ba68c3b7939afaffb4d373d15594817ad3319fdecfbe26640ce4b218cf639",
  },
  builtinProviderConfig: {
    relativePath: "app-server/provider/zcode-builtin.json",
    bytes: 265_884,
    sha256: "bc760a3b0c6d096ea07ee4e963471f135ae75ab207db6ed4c372e1b183c856cd",
  },
  runtimeHost: {
    relativePath: "zcode-runtime-host.exe",
    bytes: 179_608,
    sha256: "c2c8ff5ff28cbddc4f177c094aa67c322830889612251bd173baaabc89379ab4",
  },
});

const INSTALLED_OFFICIAL_ASSETS = Object.freeze({
  zcodeExecutable: {
    relativePath: "ZCode.exe",
    bytes: 246_332_312,
    sha256: "e853398ea2023e3e472fd2799389ad02445df5c2bfd36b2ed1f1e3dfe3dc958e",
  },
  appServerEntry: {
    relativePath: path.join("resources", "glm", "zcode.cjs"),
    bytes: 15_675_386,
    sha256: "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c",
  },
  builtinProviderConfig: {
    relativePath: path.join("resources", "config", "provider", "zcode-builtin.json"),
    bytes: 261_659,
    sha256: "ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69",
  },
  runtimeHost: {
    relativePath: path.join("resources", "tools", "runtime-host", "zcode-runtime-host.exe"),
    bytes: 179_608,
    sha256: "c2c8ff5ff28cbddc4f177c094aa67c322830889612251bd173baaabc89379ab4",
  },
});

const TARGET_PROVIDER_ID = "account:bigmodel-individual-coding-plan";
const TARGET_MODEL_ID = "GLM-5.3-Flash";
const PROJECT_LOCATION_PREFIX = "project-key-location:v1:";
const OFFICIAL_TELEMETRY_STATE_RELATIVE = path.join(".zcode", "v2", "telemetry-state.json");
const BILLING_VARIANTS = Object.freeze({
  baseline: Object.freeze({
    experimentId: "bridge-b-official-assembly-v2",
    projectLocationMode: "in-memory",
    deviceIdentityMode: "fixture-generated",
  }),
  "v4-project-location-cache": Object.freeze({
    experimentId: "bridge-b-v4-project-location-cache",
    projectLocationMode: "official-read-only",
    deviceIdentityMode: "fixture-generated",
  }),
  "v4-official-device-mid": Object.freeze({
    experimentId: "bridge-b-v4-official-device-mid",
    projectLocationMode: "in-memory",
    deviceIdentityMode: "official-reused",
  }),
  "v5-installed-official-app-server": Object.freeze({
    experimentId: "bridge-b-v5-installed-official-app-server",
    projectLocationMode: "official-read-only",
    deviceIdentityMode: "official-reused",
    runtimeSource: "installed-official",
  }),
  "v5-installed-official-bundle-node": Object.freeze({
    experimentId: "bridge-b-v5-installed-official-bundle-node",
    projectLocationMode: "official-read-only",
    deviceIdentityMode: "official-reused",
    runtimeSource: "installed-bundle-node",
  }),
  "v5-installed-official-bundle-node-isolated-context": Object.freeze({
    experimentId: "bridge-b-v5-installed-official-bundle-node-isolated-context",
    projectLocationMode: "in-memory",
    deviceIdentityMode: "fixture-generated",
    runtimeSource: "installed-bundle-node",
  }),
});
const APPROVED_TRANSIENT_LOCK = "credentials.json.keyring.lock";
const DEFAULT_OFFICIAL_DATA_BASE = "D:\\Program Files";
const RPC_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = 120_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const NETWORK_CAPTURE_LIMIT = 1_000;
const NETWORK_PRELOAD_PATH = path.join(
  PROJECT_ROOT,
  "tools",
  "cost-lab",
  "network-observer-preload.cjs",
);

const SHARED_STATE_FILES = [
  "credential-source",
  "credentials.json",
  "credentials.json.lock",
  "setting.json",
  "settings.json",
  "telemetry-state.json",
  "provider_config.json",
  "config.json",
  "coding-plan-cache.json",
  "certs/zcode-network-ca.pem",
  "certs/zcode-network-ca.key",
];

function projectRelative(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, "/");
}

function appendNodeOption(existing, required) {
  const options = typeof existing === "string" ? existing.trim() : "";
  if (options.includes(required)) return options;
  return [options, required].filter(Boolean).join(" ");
}

function variantFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--variant") continue;
    const value = args[index + 1];
    return value && BILLING_VARIANTS[value] ? value : "baseline";
  }
  return "baseline";
}

function liveExperimentId(mode, args = []) {
  if (mode === "billing") {
    return BILLING_VARIANTS[variantFromArgs(args)].experimentId;
  }
  if (mode === "protocol-smoke") return "official-protocol-smoke";
  return "official-network-smoke";
}

export function ensureHarnessNetworkObserver({ runRoot, mode, args }) {
  if (globalThis[Symbol.for("costLab.networkObserver.v1")]) return null;
  if (process.env.COST_LAB_HARNESS_REEXEC === "1") {
    throw new Error("harness network observer preload did not initialize");
  }
  const networkDirectory = isolatedPaths(runRoot).networkDirectory;
  mkdirSync(networkDirectory, { recursive: true });
  const requiredOption = `--require=${NETWORK_PRELOAD_PATH}`;
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), ...args],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        COST_LAB_HARNESS_REEXEC: "1",
        COST_LAB_NETWORK_DIR: networkDirectory,
        COST_LAB_EXPERIMENT_ID: liveExperimentId(mode, args),
        COST_LAB_PROCESS_ROLE: "bridge_main_or_experiment_harness",
        NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, requiredOption),
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (child.error) throw child.error;
  return child;
}

export function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." ||
      path.isAbsolute(relative)) {
    throw new Error(`path must resolve inside ${root}: ${candidate}`);
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function verifyLiveHostAssets(root = OFFICIAL_HOST_ROOT) {
  return verifyAssetDefinition(root, HOST_ASSETS, "official host");
}

async function verifyAssetDefinition(root, definitions, label) {
  const verified = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const fullPath = path.resolve(root, definition.relativePath);
    assertInside(root, fullPath);
    const facts = await stat(fullPath);
    if (!facts.isFile() || facts.size !== definition.bytes) {
      throw new Error(`${label} asset size mismatch: ${name}`);
    }
    if (definition.sha256 !== "UNVERIFIED_BY_MANIFEST") {
      const digest = await sha256File(fullPath);
      if (digest !== definition.sha256) {
        throw new Error(`${label} asset digest mismatch: ${name}`);
      }
    }
    verified[name] = fullPath;
  }
  return verified;
}

export async function verifyInstalledOfficialAssets(
  root = INSTALLED_ZCODE_ROOT,
) {
  return verifyAssetDefinition(root, INSTALLED_OFFICIAL_ASSETS, "installed official");
}

async function resolveVariantAssets(variantConfig) {
  const hostAssets = await verifyLiveHostAssets();
  if (!["installed-official", "installed-bundle-node"].includes(
    variantConfig.runtimeSource,
  )) {
    return {
      ...hostAssets,
      runtimeSource: "vendored-official",
      command: process.execPath,
      useElectronAsNode: false,
    };
  }
  const installed = await verifyInstalledOfficialAssets();
  return {
    ...hostAssets,
    appServerEntry: installed.appServerEntry,
    builtinProviderConfig: installed.builtinProviderConfig,
    runtimeHost: installed.runtimeHost,
    runtimeSource: variantConfig.runtimeSource,
    command: variantConfig.runtimeSource === "installed-official"
      ? installed.zcodeExecutable
      : process.execPath,
    useElectronAsNode: variantConfig.runtimeSource === "installed-official",
  };
}

export function patchReadOnlyRuntimeExports(source) {
  const finalExport = `export {
  ZCODE_VERSION as ZCODE_PRODUCT_VERSION,
  ZCodeAgentProcessManager,
  ZCodeProtocolClient,
  ZCodeStdioTransport,
  createOAuthProviderRuntimeAuthService,
  createOfficialStartPlanAuthenticationResolver
};`;
  const body = source.replace(/\r?\n$/u, "");
  const trailingLineEnding = source.slice(body.length);
  if (!body.endsWith(finalExport)) {
    throw new Error("official host runtime export block changed");
  }
  if (!source.includes("function createCredentialService(dependencies = {})") ||
      !source.includes("function setDataBaseDir(")) {
    throw new Error("official read-only credential implementation is unavailable");
  }
  return `${body.slice(0, -finalExport.length)}export {
  ZCODE_VERSION as ZCODE_PRODUCT_VERSION,
  ZCodeAgentProcessManager,
  ZCodeProtocolClient,
  ZCodeStdioTransport,
  createCredentialService,
  createOAuthProviderRuntimeAuthService,
  createOfficialStartPlanAuthenticationResolver,
  setDataBaseDir
};${trailingLineEnding}`;
}

export function assessCredentialReadIsolation(runtimeSource, officialDataBase) {
  const sharedLockCall = "withFileLock(`${filePath}.keyring`";
  if (!runtimeSource.includes(sharedLockCall)) {
    return {
      status: "BLOCKED",
      reason: "official_credential_read_isolation_unproven",
    };
  }
  return {
    status: "PASS",
    reason: "official_read_only_key_lookup_uses_approved_transient_lock",
    shared_lock_root: projectRelative(
      path.join(officialDataBase, ".zcode", "v2", "credentials.json.keyring.lock"),
    ),
  };
}

export function calculateCreditBreakdown({
  uncachedInputTokens,
  cachedInputTokens,
  outputTokens,
  offPeak,
  actualCredits = null,
}) {
  for (const [name, value] of Object.entries({
    uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  }
  const baseCredits =
    (uncachedInputTokens * 2.3) / 10_000 +
    (cachedInputTokens * 0.56) / 10_000 +
    (outputTokens * 8) / 10_000;
  const timeMultiplier = offPeak ? 0.5 : 1;
  const expectedWithoutDiscount = baseCredits * timeMultiplier;
  const expectedWithZeroPointSixSeven = expectedWithoutDiscount * 0.67;
  const actual = Number.isFinite(actualCredits) ? actualCredits : null;
  return {
    base_credits: baseCredits,
    time_multiplier: timeMultiplier,
    expected_without_extra_discount: expectedWithoutDiscount,
    expected_with_zero_point_six_seven: expectedWithZeroPointSixSeven,
    actual_credits: actual,
    effective_extra_discount_ratio:
      actual !== null && expectedWithoutDiscount > 0 ? actual / expectedWithoutDiscount : null,
  };
}

export function createProjectLocationCredentialService(
  credentialService,
  mode = "in-memory",
) {
  if (mode !== "in-memory" && mode !== "official-read-only") {
    throw new Error(`unsupported project location mode: ${mode}`);
  }
  const isolatedLocations = new Map();
  const metrics = {
    mode,
    load_calls: 0,
    cache_hits: 0,
    cache_misses: 0,
    write_attempts: 0,
    writes_blocked: 0,
  };
  const isLocationKey = (key) =>
    typeof key === "string" && key.startsWith(PROJECT_LOCATION_PREFIX);
  const allLocationKeys = (keys) => keys.every(isLocationKey);
  const blockWrite = async (key) => {
    if (!isLocationKey(key)) return false;
    metrics.write_attempts += 1;
    metrics.writes_blocked += 1;
    throw new Error("cost_lab_project_location_write_blocked");
  };
  const observeLoadedLocation = (key, value) => {
    if (!isLocationKey(key)) return value;
    metrics.load_calls += 1;
    if (value === null || value === undefined || value === "") {
      metrics.cache_misses += 1;
    } else {
      metrics.cache_hits += 1;
    }
    return value;
  };
  const service = new Proxy(credentialService, {
    get(target, property) {
      if (property === "load") {
        return async (key) => {
          if (!isLocationKey(key)) return target.load(key);
          const value = mode === "official-read-only"
            ? await target.load(key)
            : isolatedLocations.get(key) ?? null;
          return observeLoadedLocation(key, value);
        };
      }
      if (property === "loadMany") {
        return async (keys) => Object.fromEntries(await Promise.all(keys.map(async (key) => [
          key,
          isLocationKey(key)
            ? mode === "official-read-only"
              ? observeLoadedLocation(key, await target.load(key))
              : observeLoadedLocation(key, isolatedLocations.get(key) ?? null)
            : await target.load(key),
        ])));
      }
      if (property === "save") {
        return async (key, value, assertCurrent) => {
          if (mode === "official-read-only" && isLocationKey(key)) {
            await blockWrite(key);
          }
          if (!isLocationKey(key)) return target.save(key, value, assertCurrent);
          metrics.write_attempts += 1;
          assertCurrent?.();
          isolatedLocations.set(key, value);
        };
      }
      if (property === "saveIfAbsent") {
        return async (key, value) => {
          if (mode === "official-read-only" && isLocationKey(key)) {
            await blockWrite(key);
          }
          if (!isLocationKey(key)) return target.saveIfAbsent(key, value);
          metrics.write_attempts += 1;
          if (isolatedLocations.has(key)) return isolatedLocations.get(key);
          isolatedLocations.set(key, value);
          return value;
        };
      }
      if (property === "delete") {
        return async (key, assertCurrent) => {
          if (mode === "official-read-only" && isLocationKey(key)) {
            await blockWrite(key);
          }
          if (!isLocationKey(key)) return target.delete(key, assertCurrent);
          metrics.write_attempts += 1;
          assertCurrent?.();
          isolatedLocations.delete(key);
        };
      }
      if (property === "deleteIfEquals") {
        return async (key, expected) => {
          if (mode === "official-read-only" && isLocationKey(key)) {
            await blockWrite(key);
          }
          if (!isLocationKey(key)) return target.deleteIfEquals(key, expected);
          metrics.write_attempts += 1;
          if (isolatedLocations.get(key) === expected) isolatedLocations.delete(key);
        };
      }
      if (property === "updateMany") {
        return async (changes, options) => {
          const keys = Object.keys(changes);
          if (mode === "official-read-only" && keys.some(isLocationKey)) {
            metrics.write_attempts += 1;
            metrics.writes_blocked += 1;
            throw new Error("cost_lab_project_location_write_blocked");
          }
          if (!allLocationKeys(keys)) return target.updateMany(changes, options);
          metrics.write_attempts += 1;
          options?.assertCurrent?.();
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) isolatedLocations.delete(key);
            else isolatedLocations.set(key, value);
          }
          return true;
        };
      }
      if (property === "recoverUnreadable") {
        return async (key, assertCurrent) => {
          if (mode === "official-read-only" && isLocationKey(key)) {
            await blockWrite(key);
          }
          if (!isLocationKey(key)) return target.recoverUnreadable(key, assertCurrent);
          metrics.write_attempts += 1;
          assertCurrent?.();
          const value = isolatedLocations.get(key) ?? null;
          isolatedLocations.delete(key);
          return value;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { service, metrics };
}

export async function prepareDeviceIdentity({
  officialDataBase,
  fixtureHome,
  mode = "fixture-generated",
}) {
  if (mode !== "fixture-generated" && mode !== "official-reused") {
    throw new Error(`unsupported device identity mode: ${mode}`);
  }
  if (mode === "fixture-generated") {
    return {
      mode: "FIXTURE_GENERATED_IF_MISSING",
      device_mid_fingerprint: null,
    };
  }

  const source = path.join(officialDataBase, OFFICIAL_TELEMETRY_STATE_RELATIVE);
  const target = path.join(fixtureHome, OFFICIAL_TELEMETRY_STATE_RELATIVE);
  assertInside(fixtureHome, target);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(source, "utf8"));
  } catch {
    throw new Error("official_device_identity_unavailable");
  }
  const deviceMid = typeof parsed?.deviceMid === "string" ? parsed.deviceMid.trim() : "";
  if (!deviceMid || !/^[\x20-\x7e]+$/u.test(deviceMid)) {
    throw new Error("official_device_identity_invalid");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    JSON.stringify({ deviceMid }, null, 2),
    { encoding: "utf8", flag: "w", mode: 0o600 },
  );
  return {
    mode: "OFFICIAL_DEVICE_MID_REUSED",
    source_relative: OFFICIAL_TELEMETRY_STATE_RELATIVE.replaceAll(path.sep, "/"),
    device_mid_fingerprint: createHash("sha256").update(deviceMid).digest("hex"),
  };
}

export async function cleanupPreparedDeviceIdentity({ fixtureHome }) {
  const target = path.join(fixtureHome, OFFICIAL_TELEMETRY_STATE_RELATIVE);
  assertInside(fixtureHome, target);
  let existed = false;
  try {
    existed = (await stat(target)).isFile();
    await rm(target, { force: true });
    return {
      status: "PASS",
      raw_fixture_removed: existed,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        status: "PASS",
        raw_fixture_removed: false,
      };
    }
    return {
      status: "FAIL",
      raw_fixture_removed: false,
    };
  }
}

function getWindowsPowerShellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function listProcesses() {
  const script = [
    "$ErrorActionPreference='Stop';",
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine |",
    "ConvertTo-Json -Compress",
  ].join("\n");
  const output = execFileSync(getWindowsPowerShellPath(), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processTreePids(processes, rootPid) {
  const children = new Map();
  for (const processInfo of processes) {
    const parent = Number(processInfo.ParentProcessId);
    const current = Number(processInfo.ProcessId);
    if (!Number.isSafeInteger(parent) || !Number.isSafeInteger(current)) continue;
    const list = children.get(parent) ?? [];
    list.push(current);
    children.set(parent, list);
  }
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (!Number.isSafeInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) pending.push(child);
  }
  return [...seen].sort((left, right) => left - right);
}

function processFingerprint(processInfo) {
  return {
    pid: Number(processInfo.ProcessId),
    parent_pid: Number(processInfo.ParentProcessId),
    name: String(processInfo.Name || ""),
    creation_date: processInfo.CreationDate || null,
    command_kind: classifyCommand(String(processInfo.CommandLine || "")),
  };
}

function classifyCommand(commandLine) {
  const lower = commandLine.toLowerCase();
  if (lower.includes("host-event-wake-probe-20261116")) return "host_wake_probe";
  if (lower.includes("native-agent-wake-20261116")) return "native_agent_wake";
  if (lower.includes("coding-plan-assembly-ab-20261116")) return "assembly_ab";
  if (lower.includes("worker-main")) return "bridge_worker";
  if (lower.includes("app-server")) return "zcode_app_server";
  if (lower.includes("cua-repl")) return "codex_cua";
  if (lower.includes("server.mjs")) return "local_server";
  if (lower.includes("zcode.exe")) return "zcode_desktop";
  return "other";
}

function processStillExists(processes, pid) {
  return processes.some((processInfo) => Number(processInfo.ProcessId) === pid);
}

export function isolatedPaths(runRoot) {
  const root = path.join(runRoot, "live-probe");
  const home = path.join(root, "home");
  const v2 = path.join(home, ".zcode", "v2");
  return {
    root,
    home,
    v2,
    workspace: path.join(root, "workspace"),
    providerConfig: path.join(v2, "provider_config.json"),
    config: path.join(v2, "config.json"),
    codingPlanCache: path.join(v2, "coding-plan-cache.json"),
    runtimeDirectory: path.join(root, "runtime"),
    authRuntime: path.join(root, "runtime", "official-host-runtime-readonly.mjs"),
    evidence: path.join(root, "smoke-evidence.json"),
    networkDirectory: path.join(root, "network"),
    networkEvidence: path.join(root, "network-evidence.json"),
    officialNetworkCapture: path.join(root, "official-network-capture.json"),
    billingStarted: path.join(root, "billing-started.json"),
    billingEvidence: path.join(root, "billing-evidence.json"),
  };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporary, filePath);
}

function syntheticProviderConfig() {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: "isolated-fixture-provider",
          providerName: "Isolated fixture provider",
          enabled: false,
          config: {
            group: "standard-personal",
            access: {
              type: "api-key",
              apiKey: "fixture-not-a-real-credential",
            },
            api: {
              type: "openai-responses",
              baseUrl: "https://example.invalid",
            },
            personalModelIds: [],
            modelOrder: [],
          },
        }],
      },
      modelConfigRules: { providerModelRules: [] },
      defaultModelSelection: {
        providerId: TARGET_PROVIDER_ID,
        modelId: TARGET_MODEL_ID,
      },
    },
  };
}

function syntheticOfficialConfig() {
  return {
    provider: {
      "builtin:bigmodel-coding-plan": {
        enabled: false,
        options: {},
      },
    },
  };
}

function syntheticCodingPlanCache() {
  return {
    entryStatus: {
      items: {
        "builtin:bigmodel-coding-plan": {
          status: "available",
        },
      },
    },
  };
}

async function prepareIsolatedFixture(
  runRoot,
  {
    experimentId = "isolated-smoke",
    officialDataBase = DEFAULT_OFFICIAL_DATA_BASE,
    deviceIdentityMode = "fixture-generated",
    assets = null,
  } = {},
) {
  const paths = isolatedPaths(runRoot);
  assets ??= await verifyLiveHostAssets();
  await mkdir(paths.v2, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.runtimeDirectory, { recursive: true });
  await mkdir(paths.networkDirectory, { recursive: true });
  await writeJsonAtomic(paths.providerConfig, syntheticProviderConfig());
  await writeJsonAtomic(paths.config, syntheticOfficialConfig());
  await writeJsonAtomic(paths.codingPlanCache, syntheticCodingPlanCache());
  await writeFile(
    path.join(paths.workspace, "fixture.txt"),
    "Isolated official assembly probe workspace.\n",
    { encoding: "utf8", flag: "w" },
  );
  const deviceIdentity = await prepareDeviceIdentity({
    officialDataBase,
    fixtureHome: paths.home,
    mode: deviceIdentityMode,
  });

  const nodeOptions = appendNodeOption(
    process.env.NODE_OPTIONS,
    `--require=${NETWORK_PRELOAD_PATH}`,
  );
  const env = {
    ...process.env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    ZCODE_DESKTOP_HOME_DIR: paths.home,
    ZCODE_DATA_BASE_DIR: paths.home,
    ZCODE_HOME: path.join(paths.home, ".zcode"),
    ZCODE_BRIDGE_NODE: process.execPath,
    ZCODE_BRIDGE_ZCODE_CJS: assets.appServerEntry,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: assets.builtinProviderConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.providerConfig,
    ZCODE_BRIDGE_DATA_DIR: path.join(paths.root, "bridge-data"),
    ZCODE_BRIDGE_MODE: "plan",
    ZCODE_BRIDGE_BROWSER_USE: "off",
    NODE_OPTIONS: nodeOptions,
    COST_LAB_NETWORK_DIR: paths.networkDirectory,
    COST_LAB_EXPERIMENT_ID: experimentId,
    TEMP: path.join(paths.root, "tmp"),
    TMP: path.join(paths.root, "tmp"),
  };
  await mkdir(env.TEMP, { recursive: true });
  return { paths, env, deviceIdentity };
}

async function captureSharedState(officialDataBase) {
  const v2 = path.join(officialDataBase, ".zcode", "v2");
  const candidates = new Set([
    ...SHARED_STATE_FILES.map((relative) => path.join(v2, relative)),
    path.join(v2, APPROVED_TRANSIENT_LOCK),
  ]);
  try {
    for (const name of await readdir(v2)) {
      if (/\.(?:db|db-wal|db-shm|sqlite|sqlite-wal|sqlite-shm)$/iu.test(name)) {
        candidates.add(path.join(v2, name));
      }
    }
  } catch {
    // Missing data roots are reported by the credential preflight.
  }
  const result = [];
  for (const filePath of [...candidates].sort()) {
    try {
      const facts = await stat(filePath);
      result.push({
        relative_path: path.relative(v2, filePath).replaceAll(path.sep, "/"),
        exists: true,
        size: facts.size,
        mtime_ms: facts.mtimeMs,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      result.push({
        relative_path: path.relative(v2, filePath).replaceAll(path.sep, "/"),
        exists: false,
        size: null,
        mtime_ms: null,
      });
    }
  }
  return result;
}

export function compareSharedState(before, after) {
  const beforeByPath = new Map(before.map((entry) => [entry.relative_path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.relative_path, entry]));
  const changed = [];
  for (const relativePath of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    if (relativePath === APPROVED_TRANSIENT_LOCK) continue;
    const left = beforeByPath.get(relativePath);
    const right = afterByPath.get(relativePath);
    if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(relativePath);
  }
  return { unchanged: changed.length === 0, changed_paths: changed };
}

export function approvedLockLifecycle(before, after) {
  const observed = before.find((entry) => entry.relative_path === APPROVED_TRANSIENT_LOCK);
  const released = after.find((entry) => entry.relative_path === APPROVED_TRANSIENT_LOCK);
  return {
    path: APPROVED_TRANSIENT_LOCK,
    observed_during_operation: observed?.exists === true,
    released_after_operation: released?.exists === false,
    observed_size: observed?.exists === true ? observed.size : null,
    observed_mtime_ms: observed?.exists === true ? observed.mtime_ms : null,
  };
}

async function observeApprovedLockDuring(officialDataBase, operation) {
  const lockPath = path.join(
    officialDataBase,
    ".zcode",
    "v2",
    APPROVED_TRANSIENT_LOCK,
  );
  let observed = null;
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      try {
        const facts = await stat(lockPath);
        if (!observed) {
          observed = { size: facts.size, mtime_ms: facts.mtimeMs };
        }
      } catch {
        // Absence is expected before acquisition and after normal release.
      }
      await new Promise(setImmediate);
    }
  })();
  try {
    const value = await operation();
    watching = false;
    await watcher;
    let released = false;
    try {
      await stat(lockPath);
    } catch (error) {
      released = error?.code === "ENOENT";
    }
    return {
      value,
      lock_lifecycle: {
        status: observed && released ? "PASS" : observed ? "FAIL" : "NOT_OBSERVED",
        path: APPROVED_TRANSIENT_LOCK,
        observed_during_operation: observed !== null,
        released_after_operation: released,
        observed_size: observed?.size ?? null,
        observed_mtime_ms: observed?.mtime_ms ?? null,
      },
    };
  } finally {
    watching = false;
  }
}

export function buildAccountConfigRevision(builtinProviderConfig, builtinConfigPath) {
  const releaseRevision = JSON.parse(builtinProviderConfig)?.revision;
  if (!Number.isSafeInteger(releaseRevision) || releaseRevision < 0) {
    throw new Error("official builtin provider revision is invalid");
  }
  const sourceKey = createHash("sha256").update(path.resolve(builtinConfigPath)).digest("hex");
  return `zcode-builtin:${releaseRevision}:${sourceKey}`;
}

function buildAccountProviderPayload(builtinProviderConfig, revision) {
  const parsed = JSON.parse(builtinProviderConfig);
  const rules = parsed?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) throw new Error("official builtin provider rules are unavailable");
  const providers = {};
  const states = {};
  for (const rawRule of rules) {
    if (!rawRule || typeof rawRule !== "object") continue;
    const access = rawRule.config?.access;
    if (access?.type !== "zhipu-account" || typeof rawRule.providerId !== "string") continue;
    const target = rawRule.providerId === TARGET_PROVIDER_ID;
    providers[rawRule.providerId] = {
      ...(Array.isArray(rawRule.config?.builtinModelIds)
        ? { builtinModelIds: [...rawRule.config.builtinModelIds] }
        : {}),
      access: {
        type: "zhipu-account",
        entitled: target,
      },
    };
    states[rawRule.providerId] = {
      availability: target ? "available" : "unavailable",
      entitled: target,
      current: target,
    };
  }
  if (!providers[TARGET_PROVIDER_ID]) {
    throw new Error("target Coding Plan provider is absent from the official registry");
  }
  return {
    revision,
    basedOnZCodeBuiltinRevision: revision,
    providers,
    states,
  };
}

function nested(record, parts) {
  let value = record;
  for (const part of parts) {
    if (!value || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

function selectedModel(snapshot) {
  const current = nested(snapshot, ["settings", "model", "current"]);
  if (!current || typeof current !== "object" ||
      typeof current.providerId !== "string" || typeof current.modelId !== "string") {
    return null;
  }
  return {
    providerId: current.providerId,
    modelId: current.modelId,
    ...(current.options && typeof current.options === "object"
      ? { options: { ...current.options } }
      : {}),
  };
}

function collectUsageNumbers(value, output = {}, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 64)) collectUsageNumbers(item, output, depth + 1);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "number" && Number.isFinite(child) &&
        /(?:tokens?|cache(?:read|write)|credits?)/iu.test(key)) {
      output[key] = child;
    } else if (child && typeof child === "object" && /usage|token|credit/iu.test(key)) {
      collectUsageNumbers(child, output, depth + 1);
    }
  }
  return output;
}

function unavailableAuthReply() {
  return {
    headersApplied: false,
    errorMessage: "Provider runtime authorization is unavailable.",
  };
}

function interactionReply(method) {
  if (method === "interaction/requestPermission") {
    return { decision: "deny", reason: "Isolated billing probe does not permit tools." };
  }
  return { action: "decline", reason: "Isolated billing probe does not accept user input." };
}

async function createReadOnlyAuthService({
  paths,
  officialDataBase,
  assets,
  events,
  projectLocationMode = "in-memory",
}) {
  const runtimeSource = await readFile(assets.hostModule, "utf8");
  const isolation = assessCredentialReadIsolation(runtimeSource, officialDataBase);
  if (isolation.status !== "PASS") return isolation;
  const patched = patchReadOnlyRuntimeExports(runtimeSource);
  await writeFile(paths.authRuntime, patched, { encoding: "utf8", flag: "w" });
  const nativeKeyringSource = path.join(
    OFFICIAL_HOST_ROOT,
    "node_modules",
    "@napi-rs",
    "keyring",
  );
  const nativeKeyringLink = path.join(
    path.dirname(paths.authRuntime),
    "node_modules",
    "@napi-rs",
    "keyring",
  );
  await mkdir(path.dirname(nativeKeyringLink), { recursive: true });
  try {
    await symlink(nativeKeyringSource, nativeKeyringLink, "junction");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const runtime = await import(`${pathToFileURL(paths.authRuntime).href}?run=${Date.now()}`);
  runtime.setDataBaseDir(officialDataBase);
  const realReadOnly = runtime.createCredentialService({
    readOnly: true,
    migrateOnRead: false,
    readOnlyKeyMaterial: true,
  });
  const credentialRead = await observeApprovedLockDuring(
    officialDataBase,
    async () => {
      const storeStatus = await realReadOnly.inspectStore();
      let credentialMaterialPresent = false;
      try {
        const activeProvider = await realReadOnly.load("oauth:active_provider");
        if (typeof activeProvider === "string" && activeProvider.length > 0) {
          const sessionKeys = [
            "zcodejwttoken",
            `oauth:${activeProvider}:access_token`,
            `oauth:${activeProvider}:user_info`,
            "oauth:linked_bigmodel",
          ];
          const session = await realReadOnly.loadMany(sessionKeys);
          const hasToken = typeof session[sessionKeys[1]] === "string" &&
            session[sessionKeys[1]].length > 0;
          const hasProfile = typeof session[sessionKeys[2]] === "string" &&
            session[sessionKeys[2]].length > 0;
          const hasZcodeJwt = typeof session.zcodejwttoken === "string" &&
            session.zcodejwttoken.length > 0;
          const hasLinkedBigmodel = typeof session["oauth:linked_bigmodel"] === "string" &&
            session["oauth:linked_bigmodel"].length > 0;
          credentialMaterialPresent = hasToken && hasProfile && hasZcodeJwt &&
            (activeProvider === "bigmodel" || hasLinkedBigmodel);
        }
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : null;
        return {
          status: "BLOCKED",
          reason: code === "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"
            ? "official_credential_key_material_unavailable"
            : "official_read_only_credential_decryption_failed",
          store_status: storeStatus?.status ?? "unknown",
        };
      }
      if (!credentialMaterialPresent) {
        return {
          status: "BLOCKED",
          reason: "official_oauth_session_material_absent",
          store_status: storeStatus?.status ?? "unknown",
        };
      }
      return {
        status: "PASS",
        store_status: storeStatus?.status ?? "unknown",
      };
    },
  );
  if (credentialRead.value.status !== "PASS") {
    return {
      ...credentialRead.value,
      lock_lifecycle: credentialRead.lock_lifecycle,
    };
  }
  if (credentialRead.lock_lifecycle.status !== "PASS") {
    return {
      status: "BLOCKED",
      reason: credentialRead.lock_lifecycle.status === "NOT_OBSERVED"
        ? "approved_keyring_lock_lifecycle_not_observed"
        : "approved_keyring_lock_was_not_released",
      store_status: credentialRead.value.store_status,
      lock_lifecycle: credentialRead.lock_lifecycle,
    };
  }

  const projectLocations = createProjectLocationCredentialService(
    realReadOnly,
    projectLocationMode,
  );
  const credentialService = projectLocations.service;

  const service = runtime.createOAuthProviderRuntimeAuthService({
    credentialService,
    resolveCurrentAccountAccess: async (currentAccess) => {
      if (
        currentAccess?.type !== "zhipu-account" ||
        currentAccess?.accountType !== "bigmodel" ||
        currentAccess?.mode !== "individual-coding-plan" ||
        currentAccess?.entitled !== true
      ) {
        return null;
      }
      events.push({ type: "official_account_access_resolved" });
      return {
        type: "zhipu-account",
        family: "bigmodel",
        planKind: "individual-coding-plan",
      };
    },
  });
  return {
    status: "PASS",
    service,
    store_status: credentialRead.value.store_status,
    lock_lifecycle: credentialRead.lock_lifecycle,
    project_token_locations: projectLocationMode === "official-read-only"
      ? "OFFICIAL_READ_ONLY_CACHE"
      : "IN_MEMORY_ONLY",
    project_location_metrics: projectLocations.metrics,
    credential_store: "OFFICIAL_READ_ONLY",
  };
}

function isolatedWriteEvidence(runRoot) {
  const root = isolatedPaths(runRoot).root;
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const facts = await stat(fullPath);
        result.push({
          relative_path: path.relative(root, fullPath).replaceAll(path.sep, "/"),
          size: facts.size,
        });
      }
    }
  }
  return walk(root).then(() => result.sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path)));
}

function createManager(module, assets, env, paths) {
  return new module.ZCodeAgentProcessManager({
    useSharedTaskRuntime: () => false,
    maxFrameBytes: MAX_FRAME_BYTES,
    requestTimeoutMs: RPC_TIMEOUT_MS,
    processLifecycleReporter: {
      onSpawn: () => undefined,
      onExit: () => undefined,
      onError: () => undefined,
      onException: () => undefined,
    },
    commandResolver: async ({ workspacePath }) => {
      const childEnv = {
        ...env,
        COST_LAB_PROCESS_ROLE: "official_app_server",
        ZCODE_APP_VERSION: "3.18.2",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: assets.builtinProviderConfig,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.providerConfig,
        ZCODE_RUNTIME_HOST_PATH: assets.runtimeHost,
        ...(assets.useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      };
      return {
        command: assets.command,
        args: [
          assets.appServerEntry,
          "app-server",
          "--stdio",
          "--surface",
          "desktop",
        ],
        cwd: workspacePath,
        env: childEnv,
      };
    },
  });
}

async function withScopedRuntimeHostPath(runtimeHostPath, callback) {
  const previous = process.env.ZCODE_RUNTIME_HOST_PATH;
  process.env.ZCODE_RUNTIME_HOST_PATH = runtimeHostPath;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.ZCODE_RUNTIME_HOST_PATH;
    else process.env.ZCODE_RUNTIME_HOST_PATH = previous;
  }
}

function beginRpcTrace(state, { direction, method, requestId = null, params }) {
  const sequence = (state.rpc_sequence ?? 0) + 1;
  state.rpc_sequence = sequence;
  const entry = {
    rpc_id: `rpc_${direction}_${String(sequence).padStart(4, "0")}`,
    direction,
    method,
    request_id: requestId === null ? null : createHash("sha256")
      .update(String(requestId))
      .digest("hex"),
    parent_rpc_id: null,
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: null,
    request_shape: rpcParamShape(params),
    response_shape: null,
    status: "pending",
    error: null,
  };
  state.rpc_trace?.push(entry);
  return entry;
}

function finishRpcTrace(entry, { status, response = null, error = null }) {
  entry.status = status;
  entry.response_shape = response === null ? { type: "none" } : response;
  entry.error = error;
  entry.completed_at = new Date().toISOString();
  const duration = Date.parse(entry.completed_at) - Date.parse(entry.started_at);
  entry.duration_ms = Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function runtimeAuthResponseShape(result) {
  return {
    headers_applied: result?.headersApplied === true,
    request_auth: summarizeRequestAuth(result?.requestAuth),
    error_present: typeof result?.errorMessage === "string" && result.errorMessage.length > 0,
  };
}

function bindProtocolHandlers(client, state) {
  const disposables = [];
  disposables.push(client.onRequest(async (message) => {
    const method = typeof message?.method === "string" ? message.method : "";
    const id = message?.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const trace = beginRpcTrace(state, {
      direction: "inbound",
      method,
      requestId: id,
      params: message.params,
    });
    const reply = async (payload, responseShape) => {
      try {
        await client.respond(id, payload);
        finishRpcTrace(trace, {
          status: "PASS",
          response: responseShape ?? safeProtocolResult(method, payload),
        });
      } catch (error) {
        finishRpcTrace(trace, {
          status: "FAIL",
          response: { type: "respond_error" },
          error: safeProtocolError(error),
        });
        throw error;
      }
    };
    const replyError = async (payload) => {
      try {
        await client.respondError(id, payload);
        finishRpcTrace(trace, {
          status: "PASS",
          response: {
            error_response: true,
            code: Number.isFinite(payload?.code) ? payload.code : null,
          },
        });
      } catch (error) {
        finishRpcTrace(trace, {
          status: "FAIL",
          response: { type: "respond_error" },
          error: safeProtocolError(error),
        });
        throw error;
      }
    };
    if (method === "session/requestRuntimePreferences") {
      await reply({
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      });
      return;
    }
    if (method === "interaction/requestOfficialMcpAuthHeaders") {
      await reply({ ok: false, reason: "official_auth_unavailable" });
      return;
    }
    if (method === "interaction/requestProviderRuntimeHeaders") {
      state.runtime_auth_calls += 1;
      const providerId = message.params?.modelSelection?.providerId ?? message.params?.providerId;
      const modelId = message.params?.modelSelection?.modelId;
      if (providerId !== TARGET_PROVIDER_ID || modelId !== TARGET_MODEL_ID ||
          state.auth_service_status !== "PASS" || !state.auth_service) {
        await reply(unavailableAuthReply(), runtimeAuthResponseShape(unavailableAuthReply()));
        return;
      }
      try {
        const result = await state.auth_service.resolveProviderRuntimeRequest(
          message.params,
          { signal: state.abort_controller.signal },
        );
        state.runtime_auth_applied = result?.headersApplied === true;
        state.runtime_request_auth = summarizeRequestAuth(result?.requestAuth);
        await reply(result, runtimeAuthResponseShape(result));
      } catch {
        const unavailable = unavailableAuthReply();
        await reply(
          unavailable,
          runtimeAuthResponseShape(unavailable),
        );
      }
      return;
    }
    if (method === "interaction/requestPermission" ||
        method === "interaction/requestUserInput") {
      const response = interactionReply(method);
      await reply(response, safeProtocolResult(method, response));
      return;
    }
    await replyError({
      code: -32601,
      message: `Unsupported isolated probe request: ${method.slice(0, 120)}`,
    });
  }));
  disposables.push(client.onNotification((message) => {
    if (message?.method !== "process/networkRequests") return;
    const params = message.params;
    if (!params || params.captureId !== state.official_network_capture_id) return;
    if (Array.isArray(params.records)) {
      state.official_network_records.push(...params.records);
    }
    state.official_network_dropped += Number.isSafeInteger(params.dropped)
      ? params.dropped
      : 0;
    state.official_network_batches += 1;
  }));
  disposables.push(client.onNotification((message) => {
    if (message?.method !== "session/event") return;
    const params = message.params;
    if (!params || typeof params !== "object") return;
    if (params.sessionId !== state.session_id) return;
    const type = typeof params.type === "string" ? params.type : "";
    state.events_seen += 1;
    if (type === "turn.started") state.turn_id = params.payload?.turnId ?? params.turnId ?? null;
    if (type !== "turn.completed" && type !== "turn.failed") return;
    state.terminal_type = type;
    state.turn_id = params.payload?.turnId ?? params.turnId ?? state.turn_id;
    state.usage_numeric = collectUsageNumbers(params.payload?.usage ?? {});
    state.response_length = typeof params.payload?.response === "string"
      ? params.payload.response.length
      : null;
    state.result_type = typeof params.payload?.resultType === "string"
      ? params.payload.resultType
      : null;
    const trace = beginRpcTrace(state, {
      direction: "notification",
      method: "session/event:terminal",
      params: {
        type,
        resultType: state.result_type,
        usageKeys: Object.keys(params.payload?.usage ?? {}).sort(),
      },
    });
    finishRpcTrace(trace, {
      status: type === "turn.completed" ? "PASS" : "FAIL",
      response: {
        terminal_type: type,
        result_type: state.result_type,
      },
    });
    state.terminal_resolve?.();
  }));
  disposables.push(client.onClose(() => {
    state.connection_closed = true;
    state.terminal_resolve?.();
  }));
  return disposables;
}

async function beginOfficialNetworkCapture(client, state, experimentId) {
  const captureId = `${experimentId}-${Date.now()}`.slice(0, 100);
  state.official_network_capture_id = captureId;
  state.official_network_started_at = new Date().toISOString();
  await client.notify("process/networkCapture", { captureId });
  return captureId;
}

async function endOfficialNetworkCapture(client, state) {
  if (!client || !state.official_network_capture_id) return;
  await new Promise((resolve) => setTimeout(resolve, 350));
  await client.notify("process/networkCapture", { captureId: null }).catch(() => undefined);
  state.official_network_ended_at = new Date().toISOString();
}

async function collectNetworkEvidence({
  paths,
  state,
  experimentId,
  runtimePid,
  rpcTrace = [],
}) {
  const wireEvidence = await readWireEvidence(paths.networkDirectory);
  const experimentEvents = wireEvidence.events.filter((event) =>
    event?.experiment_id === experimentId);
  const records = wireEvidence.records.filter((record) =>
    record?.experiment_id === experimentId);
  const officialCaptures = state.official_network_records
    .filter((record) => Number.isFinite(record?.timestamp))
    .slice(0, NETWORK_CAPTURE_LIMIT)
    .map(sanitizeOfficialCapture);
  const initEvents = experimentEvents.filter((event) =>
    event?.kind === "cost_lab_network_probe_init");
  const appServerInit = initEvents.find((event) =>
    Number(event.process_id) === Number(runtimePid));
  const identity = compareIdentitySurfaces(state.runtime_request_auth, records);
  const coverage = coverageSummary({
    records,
    officialCaptures,
    officialDropped: state.official_network_dropped,
    invalidLines: wireEvidence.invalid_lines,
    preloadInitEvents: initEvents,
    rpcTrace,
    identity,
  });
  const officialCaptureEvidence = {
    schema_version: 1,
    experiment_id: experimentId,
    capture_id: state.official_network_capture_id,
    started_at: state.official_network_started_at,
    ended_at: state.official_network_ended_at,
    batch_count: state.official_network_batches,
    dropped: state.official_network_dropped,
    records: officialCaptures,
  };
  await writeJsonAtomic(paths.officialNetworkCapture, officialCaptureEvidence);
  const networkEvidence = {
    schema_version: 1,
    kind: "cost_lab_network_evidence",
    experiment_id: experimentId,
    generated_at: new Date().toISOString(),
    target_inventory: NETWORK_TARGET_INVENTORY,
    preload: {
      path: projectRelative(NETWORK_PRELOAD_PATH),
      init_processes: initEvents.map((event) => ({
        process_role: event.process_role,
        process_id: event.process_id,
        parent_process_id: event.parent_process_id,
        process_command_kind: event.process_command_kind,
      })),
      app_server_injected: Boolean(appServerInit),
      app_server_process_id: runtimePid,
    },
    official_capture: {
      available: officialCaptures.length > 0,
      control_sent: Boolean(state.official_network_capture_id),
      records: officialCaptures.length,
      dropped: state.official_network_dropped,
      batches: state.official_network_batches,
    },
    coverage,
    identity,
    rpc_trace: rpcTrace,
    rpc_to_http: correlateRpcToHttp(rpcTrace, records),
    model_requests: records
      .filter((record) => record.endpoint_kind === "model_provider")
      .map((record) => ({
        record_id: record.record_id,
        http_method: record.http_method,
        endpoint_host: record.endpoint_host,
        endpoint_path: record.endpoint_path,
        http_status: record.http_status,
        request_status: record.request_status,
        usage_status: record.usage_status,
        usage: record.usage,
        provider_response_id: record.provider_response_id,
        request_shape: modelRequestShape(record),
        auth: record.request_auth,
      })),
    records,
  };
  await writeJsonAtomic(paths.networkEvidence, networkEvidence);
  return {
    ...networkEvidence,
    wire_file_count: wireEvidence.files.length,
    invalid_lines: wireEvidence.invalid_lines,
    coverage,
    identity,
    preload_injected_in_app_server: Boolean(appServerInit),
  };
}

async function waitForTerminal(state, timeoutMs) {
  if (state.terminal_type) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.timeout = true;
      resolve();
    }, timeoutMs);
    timer.unref();
    state.terminal_resolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function disposeManager(manager, workspace) {
  const errors = [];
  try {
    await manager.disposeWorkspace(workspace);
  } catch (error) {
    errors.push(error instanceof Error ? error.name : "workspace_dispose_error");
  }
  try {
    await manager.disposeAllAndWait();
  } catch (error) {
    errors.push(error instanceof Error ? error.name : "dispose_all_error");
  }
  return errors;
}

export async function runIsolatedSmoke({
  runRoot = DEFAULT_RUN_ROOT,
  officialDataBase = DEFAULT_OFFICIAL_DATA_BASE,
  officialSourceRoot = DEFAULT_OFFICIAL_SOURCE,
  variant = "baseline",
  protocolDiagnostic = false,
} = {}) {
  const variantConfig = BILLING_VARIANTS[variant];
  if (!variantConfig) throw new Error(`unknown billing variant: ${variant}`);
  for (const [root, candidate] of [
    [PROJECT_ROOT, runRoot],
    [runRoot, isolatedPaths(runRoot).root],
  ]) {
    assertInside(root, candidate);
  }
  const sourceAudit = await auditOfficialAssemblySources({ officialSourceRoot });
  const assets = await resolveVariantAssets(variantConfig);
  const experimentId = protocolDiagnostic ? "official-protocol-smoke" : "official-network-smoke";
  const { paths, env, deviceIdentity } = await prepareIsolatedFixture(runRoot, {
    experimentId,
    officialDataBase,
    deviceIdentityMode: variantConfig.deviceIdentityMode,
    assets,
  });
  const sharedBefore = await captureSharedState(officialDataBase);
  const processesBefore = listProcesses();
  const hostWakeBefore = processesBefore
    .map(processFingerprint)
    .filter((entry) => entry.command_kind === "host_wake_probe" ||
      entry.command_kind === "native_agent_wake");
  const events = [];
  const auth = await createReadOnlyAuthService({
    paths,
    officialDataBase,
    assets,
    events,
    projectLocationMode: variantConfig.projectLocationMode,
  });
  if (auth.status !== "PASS") {
    const processesAfter = listProcesses();
    const sharedAfter = await captureSharedState(officialDataBase);
    const sharedComparison = compareSharedState(sharedBefore, sharedAfter);
    const hostWakeAfter = processesAfter
      .map(processFingerprint)
      .filter((entry) => entry.command_kind === "host_wake_probe" ||
        entry.command_kind === "native_agent_wake");
    const evidence = {
      schema_version: 1,
      kind: "coding_plan_official_assembly_isolated_smoke",
      generated_at: new Date().toISOString(),
      status: "BLOCKED",
      reason: auth.reason,
      credential_store_status: auth.store_status,
      official_source: sourceAudit.official_source,
      device_identity: deviceIdentity,
      isolated_paths: {
        root: projectRelative(paths.root),
        home: projectRelative(paths.home),
        workspace: projectRelative(paths.workspace),
      },
      official_services: {
        initialized: false,
        app_server_initialized: false,
        app_server_source: assets.runtimeSource,
        credential_read_attempted: false,
        shared_lock_path: auth.shared_lock_root ?? null,
        keyring_lock_lifecycle: auth.lock_lifecycle ?? null,
      },
      shared_state: {
        unchanged: sharedComparison.unchanged,
        changed_paths: sharedComparison.changed_paths,
        monitored_files: sharedAfter.length,
      },
      cleanup: {
        status: "PASS",
        not_required_reason: "blocked_before_resource_initialization",
        errors: [],
        managed_processes_after: 0,
        owned_pids: [],
        owned_pids_still_alive: [],
      },
      host_wake: {
        status: JSON.stringify(hostWakeBefore) === JSON.stringify(hostWakeAfter)
          ? "PASS"
          : "FAIL",
        before: hostWakeBefore,
        after: hostWakeAfter,
      },
      writes: {
        isolated_files: await isolatedWriteEvidence(runRoot),
      },
      model_requests: 0,
      network_requests: 0,
      events,
    };
    await writeJsonAtomic(paths.evidence, evidence);
    return evidence;
  }

  const module = await import(`${pathToFileURL(assets.hostModule).href}?smoke=${Date.now()}`);
  const manager = createManager(module, assets, env, paths);
  const workspace = {
    workspacePath: paths.workspace,
    workspaceIdentity: paths.workspace,
  };
  const state = {
    abort_controller: new AbortController(),
    auth_service: auth.service,
    auth_service_status: auth.status,
    runtime_auth_calls: 0,
    runtime_auth_applied: false,
    events_seen: 0,
    session_id: null,
    terminal_type: null,
    terminal_resolve: null,
    timeout: false,
    connection_closed: false,
    rpc_trace: [],
    rpc_sequence: 0,
    rpc_last_success: null,
    rpc_first_failure: null,
    runtime_request_auth: null,
    official_network_capture_id: null,
    official_network_started_at: null,
    official_network_ended_at: null,
    official_network_records: [],
    official_network_batches: 0,
    official_network_dropped: 0,
  };
  let runtimePid = null;
  let treePids = [];
  const disposables = [];
  let cleanupErrors = [];
  let sessionId = null;
  let client = null;
  try {
    client = await withScopedRuntimeHostPath(
      assets.runtimeHost,
      () => manager.getClient(workspace),
    );
    const identity = await manager.getRuntimeIdentity(workspace);
    runtimePid = identity.processId ?? null;
    treePids = processTreePids(listProcesses(), runtimePid);
    disposables.push(...bindProtocolHandlers(client, state));
    await beginOfficialNetworkCapture(client, state, experimentId);
    if (protocolDiagnostic) {
      const builtinSource = await readFile(assets.builtinProviderConfig, "utf8");
      const accountProviderPayload = buildAccountProviderPayload(
        builtinSource,
        buildAccountConfigRevision(builtinSource, assets.builtinProviderConfig),
      );
      const conversation = await runProbeConversation({
        client,
        state,
        paths,
        assets,
        accountProviderPayload,
        skipModelSend: true,
      });
      sessionId = conversation.session_id;
    } else {
      const snapshot = await tracedRequest(client, state, "session/create", {
        workspace: {
          workspacePath: paths.workspace,
          workspaceKey: paths.workspace,
        },
        mode: "plan",
        persistence: "immediate",
      });
      sessionId = nested(snapshot, ["session", "sessionId"]) ?? null;
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("isolated AppServer did not return a session ID");
      }
    }
    state.session_id = sessionId;
  } catch (error) {
    events.push({
      type: "smoke_error",
      ...safeProtocolError(error),
    });
  } finally {
    await endOfficialNetworkCapture(client, state);
    state.abort_controller.abort();
    for (const disposable of disposables.splice(0)) {
      try { disposable.dispose(); } catch { /* evidence records the primary path */ }
    }
    cleanupErrors = await disposeManager(manager, workspace);
  }

  const processesAfter = listProcesses();
  const sharedAfter = await captureSharedState(officialDataBase);
  const sharedComparison = compareSharedState(sharedBefore, sharedAfter);
  const hostWakeAfter = processesAfter
    .map(processFingerprint)
    .filter((entry) => entry.command_kind === "host_wake_probe" ||
      entry.command_kind === "native_agent_wake");
  const ownedPidsStillAlive = treePids.filter((pid) => processStillExists(processesAfter, pid));
  const managedAfter = manager.listManagedProcesses();
  const cleanupPassed =
    cleanupErrors.length === 0 &&
    managedAfter.length === 0 &&
    ownedPidsStillAlive.length === 0;
  const hostWakeUnchanged = JSON.stringify(hostWakeBefore) === JSON.stringify(hostWakeAfter);
  const network = await collectNetworkEvidence({
    paths,
    state,
    experimentId,
    runtimePid,
    rpcTrace: state.rpc_trace,
  });
  const harnessPreloadInitialized = network.preload.init_processes.some((entry) =>
    entry.process_role === "bridge_main_or_experiment_harness");
  const networkProbeReady =
    harnessPreloadInitialized &&
    network.preload_injected_in_app_server &&
    network.official_capture.control_sent;
  const deviceIdentityCleanup = await cleanupPreparedDeviceIdentity({
    fixtureHome: paths.home,
  });
  const passed =
    events.every((event) => event.type !== "smoke_error") &&
    (!protocolDiagnostic || state.rpc_trace.every((entry) => entry.status === "PASS")) &&
    typeof sessionId === "string" &&
    auth.status === "PASS" &&
    auth.lock_lifecycle?.status === "PASS" &&
    sharedComparison.unchanged &&
    cleanupPassed &&
    hostWakeUnchanged &&
    networkProbeReady &&
    deviceIdentityCleanup.status === "PASS";
  const evidence = {
    schema_version: 1,
    kind: "coding_plan_official_assembly_isolated_smoke",
    generated_at: new Date().toISOString(),
    variant,
    status: passed ? "PASS" : "FAIL",
    official_source: sourceAudit.official_source,
    device_identity: deviceIdentity,
    device_identity_cleanup: deviceIdentityCleanup,
    isolated_paths: {
      root: projectRelative(paths.root),
      home: projectRelative(paths.home),
      workspace: projectRelative(paths.workspace),
    },
    official_services: {
      app_server_initialized: typeof sessionId === "string",
      app_server_source: assets.runtimeSource,
      app_server_entry: projectRelative(assets.appServerEntry),
      app_server_command: path.basename(assets.command),
      session_created: typeof sessionId === "string",
      app_server_pid: runtimePid,
      credential_service: auth.credential_store,
      credential_store_status: auth.store_status,
      keyring_lock_lifecycle: auth.lock_lifecycle,
      project_token_locations: auth.project_token_locations,
      project_location_metrics: auth.project_location_metrics ?? null,
      runtime_auth_service_initialized: auth.status === "PASS",
    },
    writes: {
      isolated_files: await isolatedWriteEvidence(runRoot),
    },
    shared_state: {
      unchanged: sharedComparison.unchanged,
      changed_paths: sharedComparison.changed_paths,
      monitored_files: sharedAfter.length,
    },
    cleanup: {
      status: cleanupPassed ? "PASS" : "FAIL",
      errors: cleanupErrors,
      managed_processes_after: managedAfter.length,
      owned_pids: treePids,
      owned_pids_still_alive: ownedPidsStillAlive,
    },
    host_wake: {
      status: hostWakeUnchanged ? "PASS" : "FAIL",
      before: hostWakeBefore,
      after: hostWakeAfter,
    },
    network_probe: {
      ready: networkProbeReady,
      harness_preload_initialized: harnessPreloadInitialized,
      preload_injected_in_app_server: network.preload_injected_in_app_server,
      official_capture_control_sent: network.official_capture.control_sent,
      coverage: network.coverage,
      identity: network.identity,
      model_request_count: network.model_requests.length,
      wire_record_count: network.records.length,
      rpc_to_http: network.rpc_to_http,
    },
    model_requests: 0,
    network_requests: network.records.length,
    events,
    protocol_diagnostic: protocolDiagnostic ? {
      model_send: "SKIPPED",
      model_requests: 0,
      rpc_trace: state.rpc_trace,
      last_successful_rpc: state.rpc_last_success,
      first_failing_rpc: state.rpc_first_failure,
    } : null,
  };
  await writeJsonAtomic(paths.evidence, evidence);
  return evidence;
}

function minimalTask() {
  return {
    task_id: "official_assembly_b_minimal",
    workspace: "isolated",
    objective:
      'Reply exactly OFFICIAL_ASSEMBLY_B_OK. Do not read files, call tools, or perform any other action.',
    requirements: [
      "Return only the requested marker.",
      "Do not call tools or make additional requests.",
    ],
    allowed_paths: [],
    forbidden_paths: ["**/*"],
    acceptance_criteria: ["The response is exactly OFFICIAL_ASSEMBLY_B_OK"],
    test_commands: [],
    model: {
      provider_id: TARGET_PROVIDER_ID,
      model_id: TARGET_MODEL_ID,
    },
    timeout_ms: MODEL_TIMEOUT_MS,
  };
}

function buildProbePrompt(task) {
  return [
    task.objective,
    "",
    "Return exactly one JSON object with these fields:",
    '{"summary":"OFFICIAL_ASSEMBLY_B_OK","files_changed":[],"tests":[],"issues":[],"needs_master_decision":false}',
    "",
    "Do not call tools, read files, run commands, or make network requests.",
  ].join("\n");
}

export function rpcParamShape(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (!value || typeof value !== "object") return { type: typeof value };
  const shape = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "providerId" || key === "modelId" || key === "mode" ||
        key === "persistence" || key === "deliveryKind" || key === "includeSnapshot" ||
        key === "thoughtLevel" || key === "reasoningLevel" ||
        key === "persistAsWorkspaceLastUsed") {
      shape[key] = nestedValue;
    } else if (Array.isArray(nestedValue)) {
      shape[key] = { type: "array", length: nestedValue.length };
    } else if (nestedValue && typeof nestedValue === "object") {
      shape[key] = rpcParamShape(nestedValue);
    } else {
      shape[key] = { type: typeof nestedValue };
    }
  }
  return shape;
}

export function safeProtocolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : "unknown_error",
    code: Number.isFinite(error?.code) ? error.code : null,
    message: message
      .replace(/[A-Za-z]:\\[^\s"']+/gu, "<path>")
      .replace(/(token|api[_ -]?key|authorization|secret|credential)\s*[:=]\s*[^,\s]+/giu,
        "$1=<redacted>")
      .slice(0, 240),
    data_type: error?.data === undefined ? "undefined" : typeof error.data,
  };
}

function safeProtocolResult(method, result) {
  if (!result || typeof result !== "object") return { type: typeof result };
  if (method === "provider/updateAccountConfig") {
    return {
      status: typeof result.status === "string" ? result.status : null,
      provider_count: Number.isSafeInteger(result.providerCount) ? result.providerCount : null,
    };
  }
  if (method === "session/create") {
    return {
      session_created: typeof nested(result, ["session", "sessionId"]) === "string",
      selected_model: selectedModel(result),
      thought_level: nested(result, ["settings", "thoughtLevel", "current"]) ?? null,
    };
  }
  return { type: typeof result };
}

export async function tracedRequest(client, state, method, params) {
  const entry = beginRpcTrace(state, {
    direction: "outbound",
    method,
    params,
  });
  try {
    const result = await client.request(method, params);
    entry.params_shape = entry.request_shape;
    entry.result = safeProtocolResult(method, result);
    finishRpcTrace(entry, {
      status: "PASS",
      response: safeProtocolResult(method, result),
    });
    if (state.rpc_last_success !== undefined) state.rpc_last_success = method;
    return result;
  } catch (error) {
    entry.params_shape = entry.request_shape;
    finishRpcTrace(entry, {
      status: "FAIL",
      response: { type: "error" },
      error: safeProtocolError(error),
    });
    if (state.rpc_first_failure === null) {
      state.rpc_first_failure = { method, ...entry.error };
    }
    throw error;
  }
}

export async function runProbeConversation({
  client,
  state,
  paths,
  assets,
  accountProviderPayload,
  skipModelSend = false,
}) {
  const providerResult = await tracedRequest(
    client,
    state,
    "provider/updateAccountConfig",
    accountProviderPayload,
  );
  const providerStatus =
    providerResult && typeof providerResult.status === "string"
      ? providerResult.status
      : "accepted";

  const snapshot = await tracedRequest(client, state, "session/create", {
    workspace: {
      workspacePath: paths.workspace,
      workspaceKey: paths.workspace,
    },
    mode: "plan",
    model: {
      providerId: TARGET_PROVIDER_ID,
      modelId: TARGET_MODEL_ID,
      options: { reasoningLevel: "low" },
    },
    thoughtLevel: "low",
    persistence: "immediate",
  });
  const sessionId = nested(snapshot, ["session", "sessionId"]);
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("isolated AppServer did not return a session ID");
  }
  state.session_id = sessionId;

  const selection = selectedModel(snapshot);
  if (selection?.providerId !== TARGET_PROVIDER_ID || selection?.modelId !== TARGET_MODEL_ID) {
    throw new Error("isolated AppServer did not select GLM-5.3-Flash");
  }

  const reasoningLevel = nested(snapshot, ["settings", "thoughtLevel", "current"]) ?? null;

  const runtimeSeq = nested(snapshot, ["runtime", "eventSeq"]);
  await tracedRequest(client, state, "session/subscribe", {
    sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: false,
    afterSeq: typeof runtimeSeq === "number" ? runtimeSeq : 0,
  });
  if (skipModelSend) {
    return {
      session_id: sessionId,
      selected_model: selection,
      reasoning_requested: "low",
      reasoning_level: reasoningLevel,
      provider_registration_status: providerStatus,
      assets_verified: Object.keys(assets).length,
      model_send_skipped: true,
    };
  }
  await tracedRequest(client, state, "session/send", {
    sessionId,
    content: buildProbePrompt(minimalTask()),
  });
  await waitForTerminal(state, MODEL_TIMEOUT_MS);
  return {
    session_id: sessionId,
    selected_model: selection,
    reasoning_requested: "low",
    reasoning_level: reasoningLevel,
    provider_registration_status: providerStatus,
    assets_verified: Object.keys(assets).length,
  };
}

function shanghaiDateParts(timestamp) {
  const dateValue = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(dateValue.getTime())) throw new Error("invalid billing timestamp");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dateValue);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("unable to resolve Asia/Shanghai billing hour");
  }
  const dateKey = `${values.year}-${values.month}-${values.day}`;
  return {
    date: dateKey,
    hour,
    weekday: new Date(`${dateKey}T00:00:00.000Z`).getUTCDay(),
  };
}

export function billingHourForTimestamp(timestamp) {
  return shanghaiDateParts(timestamp).hour;
}

export function isOffPeakBillingTime(timestamp) {
  const { hour, weekday } = shanghaiDateParts(timestamp);
  const weekdayPeak = weekday >= 1 && weekday <= 5 && hour >= 14 && hour < 18;
  return !weekdayPeak;
}

export function billingSnapshotView(snapshot) {
  if (snapshot?.schema_version === 1 &&
      snapshot?.time_zone === "Asia/Shanghai" &&
      snapshot?.source_provider?.id &&
      Array.isArray(snapshot?.model_usage?.modelDataList)) {
    return snapshot;
  }
  const official = snapshot?.official_snapshot;
  if (snapshot?.schema_version === 1 &&
      snapshot?.query?.time_zone === "Asia/Shanghai" &&
      snapshot?.provider?.id &&
      official &&
      Array.isArray(official?.modelUsage?.modelDataList)) {
    return {
      ...snapshot,
      time_zone: snapshot.query.time_zone,
      source_provider: official.sourceProvider ?? snapshot.provider,
      range_start_date: snapshot.range?.start_date ?? official.rangeStartDate,
      range_end_date: snapshot.range?.end_date ?? official.rangeEndDate,
      model_usage: official.modelUsage,
    };
  }
  throw new Error("official billing snapshot shape is unsupported");
}

function modelHourBucket(snapshot, modelId, hour, { missingAsZero = false } = {}) {
  const rows = snapshot?.model_usage?.modelDataList;
  if (!Array.isArray(rows)) throw new Error("official snapshot model rows are missing");
  const row = rows.find((entry) => entry?.modelName === modelId);
  const keys = [
    "tokensUsage",
    "creditsUsage",
    "cachedInputTokensUsage",
    "uncachedInputTokensUsage",
    "outputTokensUsage",
    "cachedInputCreditsUsage",
    "uncachedInputCreditsUsage",
    "outputCreditsUsage",
  ];
  if (!row && missingAsZero) {
    return Object.fromEntries(keys.map((key) => [key, 0]));
  }
  if (!row) throw new Error(`official model row is missing: ${modelId}`);
  const bucket = {};
  for (const key of keys) {
    if (!Array.isArray(row[key]) || row[key].length !== 24) {
      throw new Error(`official model bucket is invalid: ${modelId}.${key}`);
    }
    const value = Number(row[key][hour]);
    if (!Number.isFinite(value)) {
      throw new Error(`official model bucket is not numeric: ${modelId}.${key}[${hour}]`);
    }
    bucket[key] = value;
  }
  return bucket;
}

export function validateBeforeBillingSnapshot(snapshot, now = new Date()) {
  snapshot = billingSnapshotView(snapshot);
  if (snapshot?.schema_version !== 1 ||
      snapshot?.time_zone !== "Asia/Shanghai" ||
      snapshot?.source_provider?.id !== TARGET_PROVIDER_ID ||
      !Array.isArray(snapshot?.model_usage?.modelDataList)) {
    throw new Error("official before snapshot metadata is invalid");
  }
  const capturedAt = new Date(snapshot.captured_at);
  const captured = shanghaiDateParts(capturedAt);
  const current = shanghaiDateParts(now);
  if (captured.date !== current.date ||
      snapshot.range_start_date !== current.date ||
      snapshot.range_end_date !== current.date) {
    throw new Error("official before snapshot is not for the current Asia/Shanghai day");
  }
  const ageMs = now.getTime() - capturedAt.getTime();
  if (ageMs < 0 || ageMs > 10 * 60_000) {
    throw new Error("official before snapshot is stale or from the future");
  }

  const target = modelHourBucket(
    snapshot,
    TARGET_MODEL_ID,
    current.hour,
    { missingAsZero: true },
  );
  const activeModelBuckets = [];
  for (const row of snapshot.model_usage.modelDataList) {
    if (typeof row?.modelName !== "string" || row.modelName === TARGET_MODEL_ID) continue;
    const bucket = modelHourBucket(snapshot, row.modelName, current.hour);
    if (bucket.tokensUsage !== 0 || bucket.creditsUsage !== 0) {
      activeModelBuckets.push({
        model: row.modelName,
        tokens_usage: bucket.tokensUsage,
        credits_usage: bucket.creditsUsage,
      });
    }
  }
  if (activeModelBuckets.length > 0) {
    throw new Error("another model already has activity in the current billing hour");
  }
  return {
    status: "PASS",
    date: current.date,
    hour: current.hour,
    off_peak: isOffPeakBillingTime(now),
    captured_at: capturedAt.toISOString(),
    age_ms: ageMs,
    target_bucket_before: target,
    other_active_model_buckets: activeModelBuckets,
  };
}

export async function runBillingProbe({
  runRoot = DEFAULT_RUN_ROOT,
  officialDataBase = DEFAULT_OFFICIAL_DATA_BASE,
  officialSourceRoot = DEFAULT_OFFICIAL_SOURCE,
  beforeSnapshotPath,
  variant = "baseline",
} = {}) {
  const variantConfig = BILLING_VARIANTS[variant];
  if (!variantConfig) throw new Error(`unknown billing variant: ${variant}`);
  const experimentId = variantConfig.experimentId;
  const paths = isolatedPaths(runRoot);
  assertInside(PROJECT_ROOT, runRoot);
  assertInside(runRoot, paths.root);
  if (!existsSync(paths.evidence)) {
    throw new Error("isolated smoke evidence is missing");
  }
  const smoke = JSON.parse(await readFile(paths.evidence, "utf8"));
  if (smoke.status !== "PASS" || smoke.shared_state?.unchanged !== true ||
      smoke.cleanup?.status !== "PASS" ||
      smoke.network_probe?.ready !== true) {
    throw new Error("isolated smoke gate is not PASS");
  }
  if (smoke.variant !== undefined && smoke.variant !== variant) {
    throw new Error("isolated smoke variant does not match billing variant");
  }
  if (existsSync(paths.billingStarted)) {
    throw new Error("B billing probe was already attempted; refusing a second real request");
  }
  if (!beforeSnapshotPath) throw new Error("--before-snapshot is required");
  const beforeSnapshot = billingSnapshotView(
    JSON.parse(await readFile(beforeSnapshotPath, "utf8")),
  );
  if (beforeSnapshot.schema_version !== 1 ||
      !Array.isArray(beforeSnapshot.model_usage?.modelDataList)) {
    throw new Error("official before snapshot is invalid");
  }
  const beforeWindow = validateBeforeBillingSnapshot(beforeSnapshot);
  const sourceAudit = await auditOfficialAssemblySources({ officialSourceRoot });
  const assets = await resolveVariantAssets(variantConfig);
  const { env, deviceIdentity } = await prepareIsolatedFixture(runRoot, {
    experimentId,
    officialDataBase,
    deviceIdentityMode: variantConfig.deviceIdentityMode,
    assets,
  });
  const sharedBefore = await captureSharedState(officialDataBase);
  const processesBefore = listProcesses();
  const hostWakeBefore = processesBefore
    .map(processFingerprint)
    .filter((entry) => entry.command_kind === "host_wake_probe" ||
      entry.command_kind === "native_agent_wake");
  const events = [];
  const auth = await createReadOnlyAuthService({
    paths,
    officialDataBase,
    assets,
    events,
    projectLocationMode: variantConfig.projectLocationMode,
  });
  if (auth.status !== "PASS") {
    return {
      schema_version: 1,
      kind: "coding_plan_official_assembly_b_billing",
      status: "BLOCKED",
      reason: auth.reason,
      real_model_requests: 0,
    };
  }
  const startedAt = new Date().toISOString();
  await writeJsonAtomic(paths.billingStarted, {
    started_at: startedAt,
    before_snapshot_path: path.resolve(beforeSnapshotPath),
    real_model_request_budget: 1,
  });
  const module = await import(`${pathToFileURL(assets.hostModule).href}?billing=${Date.now()}`);
  const manager = createManager(module, assets, env, paths);
  const workspace = {
    workspacePath: paths.workspace,
    workspaceIdentity: paths.workspace,
  };
  const state = {
    abort_controller: new AbortController(),
    auth_service: auth.service,
    auth_service_status: auth.status,
    runtime_auth_calls: 0,
    runtime_auth_applied: false,
    events_seen: 0,
    session_id: null,
    terminal_type: null,
    terminal_resolve: null,
    timeout: false,
    usage_numeric: {},
    connection_closed: false,
    rpc_trace: [],
    rpc_sequence: 0,
    rpc_last_success: null,
    rpc_first_failure: null,
    runtime_request_auth: null,
    official_network_capture_id: null,
    official_network_started_at: null,
    official_network_ended_at: null,
    official_network_records: [],
    official_network_batches: 0,
    official_network_dropped: 0,
  };
  let runtimePid = null;
  let treePids = [];
  const disposables = [];
  let cleanupErrors = [];
  let conversation = null;
  let primaryError = null;
  let client = null;
  try {
    client = await withScopedRuntimeHostPath(
      assets.runtimeHost,
      () => manager.getClient(workspace),
    );
    const identity = await manager.getRuntimeIdentity(workspace);
    runtimePid = identity.processId ?? null;
    treePids = processTreePids(listProcesses(), runtimePid);
    disposables.push(...bindProtocolHandlers(client, state));
    await beginOfficialNetworkCapture(
      client,
      state,
      experimentId,
    );
    const builtinSource = await readFile(assets.builtinProviderConfig, "utf8");
    const accountProviderPayload = buildAccountProviderPayload(
      builtinSource,
      buildAccountConfigRevision(builtinSource, assets.builtinProviderConfig),
    );
    conversation = await runProbeConversation({
      client,
      state,
      paths,
      assets,
      accountProviderPayload,
    });
  } catch (error) {
    primaryError = error instanceof Error ? error.name : "unknown_error";
  } finally {
    await endOfficialNetworkCapture(client, state);
    state.abort_controller.abort();
    for (const disposable of disposables.splice(0)) {
      try { disposable.dispose(); } catch { /* cleanup evidence remains explicit */ }
    }
    cleanupErrors = await disposeManager(manager, workspace);
  }
  const finishedAt = new Date().toISOString();
  const startParts = shanghaiDateParts(startedAt);
  const finishParts = shanghaiDateParts(finishedAt);
  const sameBillingHour =
    startParts.date === finishParts.date && startParts.hour === finishParts.hour;
  const processesAfter = listProcesses();
  const sharedAfter = await captureSharedState(officialDataBase);
  const sharedComparison = compareSharedState(sharedBefore, sharedAfter);
  const hostWakeAfter = processesAfter
    .map(processFingerprint)
    .filter((entry) => entry.command_kind === "host_wake_probe" ||
      entry.command_kind === "native_agent_wake");
  const ownedPidsStillAlive = treePids.filter((pid) => processStillExists(processesAfter, pid));
  const managedAfter = manager.listManagedProcesses();
  const cleanupPassed =
    cleanupErrors.length === 0 &&
    managedAfter.length === 0 &&
    ownedPidsStillAlive.length === 0;
  const hostWakeUnchanged = JSON.stringify(hostWakeBefore) === JSON.stringify(hostWakeAfter);
  const network = await collectNetworkEvidence({
    paths,
    state,
    experimentId,
    runtimePid,
    rpcTrace: state.rpc_trace,
  });
  const harnessPreloadInitialized = network.preload.init_processes.some((entry) =>
    entry.process_role === "bridge_main_or_experiment_harness");
  const networkGatePassed =
    harnessPreloadInitialized &&
    network.preload_injected_in_app_server &&
    network.official_capture.control_sent &&
    network.coverage.PROBE_COVERAGE === "COMPLETE";
  const deviceIdentityCleanup = await cleanupPreparedDeviceIdentity({
    fixtureHome: paths.home,
  });
  const completed = !primaryError && !state.timeout &&
    state.terminal_type === "turn.completed" &&
    state.result_type === "success" &&
    state.runtime_auth_calls > 0 &&
    state.runtime_auth_applied === true;
  const safetyGatePassed =
    sameBillingHour &&
    sharedComparison.unchanged &&
    cleanupPassed &&
    hostWakeUnchanged &&
    deviceIdentityCleanup.status === "PASS";
  const evidence = {
    schema_version: 1,
    kind: "coding_plan_official_assembly_b_billing",
    generated_at: finishedAt,
    variant,
    status: completed && safetyGatePassed && networkGatePassed
      ? "PASS"
      : "FAIL",
    execution_gate: completed ? "PASS" : "FAIL",
    safety_gate: safetyGatePassed ? "PASS" : "FAIL",
    network_gate: networkGatePassed ? "PASS" : "FAIL",
    official_source: sourceAudit.official_source,
    experiment: {
      started_at: startedAt,
      finished_at: finishedAt,
      before_snapshot_path: path.resolve(beforeSnapshotPath),
      billing_date: startParts.date,
      billing_hour: startParts.hour,
      same_billing_hour: sameBillingHour,
      provider_id: TARGET_PROVIDER_ID,
      model_id: TARGET_MODEL_ID,
      variant,
      project_location_mode: variantConfig.projectLocationMode,
      device_identity_mode: variantConfig.deviceIdentityMode,
      reasoning_level: conversation?.reasoning_level ?? null,
      prompt_kind: "exact_marker_json",
      app_server_source: assets.runtimeSource,
      app_server_entry: projectRelative(assets.appServerEntry),
      app_server_command: path.basename(assets.command),
      real_model_requests: 1,
      automatic_retries: 0,
      before_window: beforeWindow,
    },
    session: conversation,
    runtime: {
      app_server_pid: runtimePid,
      runtime_auth_calls: state.runtime_auth_calls,
      runtime_auth_applied: state.runtime_auth_applied,
      connection_closed: state.connection_closed === true,
      events_seen: state.events_seen,
      terminal_type: state.terminal_type,
      result_type: state.result_type ?? null,
      timed_out: state.timeout === true,
      response_length: state.response_length ?? null,
      usage_numeric: state.usage_numeric,
      primary_error: primaryError,
      rpc_trace: state.rpc_trace,
      rpc_sequence: state.rpc_sequence,
      last_successful_rpc: state.rpc_last_success,
      first_failing_rpc: state.rpc_first_failure,
    },
    network: {
      gate: networkGatePassed ? "PASS" : "FAIL",
      harness_preload_initialized: harnessPreloadInitialized,
      app_server_preload_initialized: network.preload_injected_in_app_server,
      official_capture_control_sent: network.official_capture.control_sent,
      coverage: network.coverage,
      identity: network.identity,
      rpc_to_http: network.rpc_to_http,
      model_requests: network.model_requests,
    },
    cleanup: {
      status: cleanupPassed ? "PASS" : "FAIL",
      errors: cleanupErrors,
      managed_processes_after: managedAfter.length,
      owned_pids: treePids,
      owned_pids_still_alive: ownedPidsStillAlive,
    },
    shared_state: {
      unchanged: sharedComparison.unchanged,
      changed_paths: sharedComparison.changed_paths,
      monitored_files: sharedAfter.length,
    },
    host_wake: {
      status: hostWakeUnchanged ? "PASS" : "FAIL",
      before: hostWakeBefore,
      after: hostWakeAfter,
    },
    model_evidence: {
      actual_provider: conversation?.selected_model?.providerId ?? null,
      actual_model: conversation?.selected_model?.modelId ?? null,
    },
    billing_capture_required: true,
    auth_service: {
      credential_store: auth.credential_store,
      credential_store_status: auth.store_status,
      keyring_lock_lifecycle: auth.lock_lifecycle,
      project_token_locations: auth.project_token_locations,
      project_location_metrics: auth.project_location_metrics ?? null,
    },
    device_identity: deviceIdentity,
    device_identity_cleanup: deviceIdentityCleanup,
  };
  await writeJsonAtomic(paths.billingEvidence, evidence);
  return evidence;
}

export async function analyzeBillingEvidence({
  beforeSnapshotPath,
  afterSnapshotPath,
  billingEvidencePath,
}) {
  const before = JSON.parse(await readFile(beforeSnapshotPath, "utf8"));
  const after = JSON.parse(await readFile(afterSnapshotPath, "utf8"));
  const run = JSON.parse(await readFile(billingEvidencePath, "utf8"));
  return analyzeBillingSnapshots(before, after, run);
}

function fingerprintOpaque(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return createHash("sha256").update(value.trim()).digest("hex");
}

function identityParity(snapshotValue, observedHashes) {
  const snapshotHash = fingerprintOpaque(snapshotValue);
  const hashes = [...new Set(observedHashes ?? [])].filter(Boolean);
  if (!snapshotHash || hashes.length === 0) return "UNKNOWN";
  return hashes.length === 1 && hashes[0] === snapshotHash ? "MATCH" : "DIFFERENT";
}

export function compareBillingIdentitySurfaces(before, after, run) {
  const beforeIdentity = before?.identity ?? {};
  const afterIdentity = after?.identity ?? {};
  const completeIdentity =
    typeof beforeIdentity.api_key_id === "string" &&
    typeof beforeIdentity.organization_id === "string" &&
    typeof beforeIdentity.project_id === "string" &&
    typeof afterIdentity.api_key_id === "string" &&
    typeof afterIdentity.organization_id === "string" &&
    typeof afterIdentity.project_id === "string";
  const stable =
    completeIdentity &&
    beforeIdentity.api_key_id === afterIdentity.api_key_id &&
    beforeIdentity.organization_id === afterIdentity.organization_id &&
    beforeIdentity.project_id === afterIdentity.project_id;
  const pathFingerprints =
    run?.network?.identity?.project_identity_parameter_fingerprints ?? {};
  const apiKeyIdParity = identityParity(
    afterIdentity.api_key_id,
    pathFingerprints.api_key_id,
  );
  const organizationIdParity = identityParity(
    afterIdentity.organization_id,
    pathFingerprints.organization_id,
  );
  const projectIdParity = identityParity(
    afterIdentity.project_id,
    pathFingerprints.project_id,
  );
  const parityValues = [apiKeyIdParity, organizationIdParity, projectIdParity];
  return {
    snapshot_identity_complete: completeIdentity,
    snapshot_stable: stable,
    api_key_id_parity: apiKeyIdParity,
    organization_id_parity: organizationIdParity,
    project_id_parity: projectIdParity,
    project_identity_parity: !completeIdentity
      ? "UNKNOWN"
      : !stable || parityValues.includes("DIFFERENT")
      ? "DIFFERENT"
      : parityValues.every((value) => value === "MATCH")
        ? "MATCH"
        : "UNKNOWN",
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function analyzeBillingSnapshots(before, after, run) {
  before = billingSnapshotView(before);
  after = billingSnapshotView(after);
  const startedAt = new Date(run?.experiment?.started_at);
  const finishedAt = new Date(run?.experiment?.finished_at);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(finishedAt.getTime())) {
    throw new Error("billing evidence timestamps are missing");
  }
  const startParts = shanghaiDateParts(startedAt);
  const finishParts = shanghaiDateParts(finishedAt);
  const hour = startParts.hour;
  const beforeCapturedAt = new Date(before?.captured_at);
  const afterCapturedAt = new Date(after?.captured_at);
  const sameBillingHour =
    startParts.date === finishParts.date && startParts.hour === finishParts.hour;
  const beforeBracketsRequest =
    Number.isFinite(beforeCapturedAt.getTime()) &&
    beforeCapturedAt.getTime() <= startedAt.getTime();
  const afterBracketsRequest =
    Number.isFinite(afterCapturedAt.getTime()) &&
    afterCapturedAt.getTime() >= finishedAt.getTime();
  const snapshotMetadataValid =
    before?.schema_version === 1 &&
    after?.schema_version === 1 &&
    before?.time_zone === "Asia/Shanghai" &&
    after?.time_zone === "Asia/Shanghai" &&
    before?.source_provider?.id === TARGET_PROVIDER_ID &&
    after?.source_provider?.id === TARGET_PROVIDER_ID &&
    before?.range_start_date === startParts.date &&
    before?.range_end_date === startParts.date &&
    after?.range_start_date === startParts.date &&
    after?.range_end_date === startParts.date;

  const beforeRows = before?.model_usage?.modelDataList;
  const afterRows = after?.model_usage?.modelDataList;
  if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
    throw new Error("official model rows are missing from before/after snapshots");
  }
  const afterModel = afterRows.find((entry) => entry?.modelName === TARGET_MODEL_ID);
  if (!afterModel) {
    throw new Error("target official model row is missing from after snapshot");
  }
  const sourceKeys = [
    "tokensUsage",
    "creditsUsage",
    "cachedInputTokensUsage",
    "uncachedInputTokensUsage",
    "outputTokensUsage",
    "cachedInputCreditsUsage",
    "uncachedInputCreditsUsage",
    "outputCreditsUsage",
  ];
  const beforeModelBucket = modelHourBucket(
    before,
    TARGET_MODEL_ID,
    hour,
    { missingAsZero: true },
  );
  const delta = {};
  for (const key of sourceKeys) {
    const left = finiteNumber(beforeModelBucket[key]);
    const right = finiteNumber(afterModel[key]?.[hour]);
    delta[key] = left !== null && right !== null ? right - left : null;
  }
  const usage = run.runtime?.usage_numeric ?? {};
  const runtimeCachedInputTokens = finiteNumber(
    usage.cachedInputTokens ?? usage.cacheReadTokens,
  );
  const runtimeInputTokens = finiteNumber(usage.inputTokens);
  const runtimeUncachedInputTokens = finiteNumber(usage.uncachedInputTokens) ??
    (runtimeInputTokens !== null && runtimeCachedInputTokens !== null
      ? runtimeInputTokens - runtimeCachedInputTokens
      : null);
  const runtimeOutputTokens = finiteNumber(usage.outputTokens);
  const runtimeUsageComplete =
    runtimeCachedInputTokens !== null &&
    runtimeUncachedInputTokens !== null &&
    runtimeOutputTokens !== null;
  const runtimeUsageMatchesOfficial =
    runtimeUsageComplete &&
    delta.cachedInputTokensUsage !== null &&
    delta.uncachedInputTokensUsage !== null &&
    delta.outputTokensUsage !== null &&
    Math.abs(runtimeCachedInputTokens - delta.cachedInputTokensUsage) < 1e-6 &&
    Math.abs(runtimeUncachedInputTokens - delta.uncachedInputTokensUsage) < 1e-6 &&
    Math.abs(runtimeOutputTokens - delta.outputTokensUsage) < 1e-6;
  const requestUsageSource = runtimeUsageMatchesOfficial
    ? "RUNTIME_USAGE"
    : "OFFICIAL_HOURLY_DELTA";
  const cachedInputTokens = runtimeUsageMatchesOfficial
    ? runtimeCachedInputTokens
    : delta.cachedInputTokensUsage;
  const uncachedInputTokens = runtimeUsageMatchesOfficial
    ? runtimeUncachedInputTokens
    : delta.uncachedInputTokensUsage;
  const outputTokens = runtimeUsageMatchesOfficial
    ? runtimeOutputTokens
    : delta.outputTokensUsage;
  const actualCredits = finiteNumber(delta.creditsUsage);
  const requestTokenTotal =
    cachedInputTokens !== null && uncachedInputTokens !== null && outputTokens !== null
      ? cachedInputTokens + uncachedInputTokens + outputTokens
      : null;
  const officialCategoryTotal =
    delta.cachedInputTokensUsage !== null &&
    delta.uncachedInputTokensUsage !== null &&
    delta.outputTokensUsage !== null
      ? delta.cachedInputTokensUsage +
        delta.uncachedInputTokensUsage +
        delta.outputTokensUsage
      : null;
  const officialUsageSelfConsistent =
    delta.tokensUsage !== null &&
    officialCategoryTotal !== null &&
    Math.abs(officialCategoryTotal - delta.tokensUsage) < 1e-6;
  const tokenMatch =
    requestTokenTotal !== null &&
    delta.tokensUsage !== null &&
    Math.abs(requestTokenTotal - delta.tokensUsage) < 1e-6;

  const targetBucketBefore = beforeModelBucket;
  const contaminatingModelBuckets = [];
  const modelNames = new Set([
    ...beforeRows.map((entry) => entry?.modelName).filter((name) => typeof name === "string"),
    ...afterRows.map((entry) => entry?.modelName).filter((name) => typeof name === "string"),
  ]);
  for (const modelName of modelNames) {
    if (modelName === TARGET_MODEL_ID) continue;
    const beforeBucket = modelHourBucket(
      before,
      modelName,
      hour,
      { missingAsZero: true },
    );
    const afterBucket = modelHourBucket(
      after,
      modelName,
      hour,
      { missingAsZero: true },
    );
    if (beforeBucket.tokensUsage !== afterBucket.tokensUsage ||
        beforeBucket.creditsUsage !== afterBucket.creditsUsage) {
      contaminatingModelBuckets.push({
        model: modelName,
        token_delta: afterBucket.tokensUsage - beforeBucket.tokensUsage,
        credit_delta: afterBucket.creditsUsage - beforeBucket.creditsUsage,
      });
    }
  }
  const runGatePassed = run?.execution_gate
    ? run.execution_gate === "PASS"
    : run?.status === "PASS";
  const windowClean =
    runGatePassed &&
    sameBillingHour &&
    snapshotMetadataValid &&
    beforeBracketsRequest &&
    afterBracketsRequest &&
    contaminatingModelBuckets.length === 0 &&
    officialUsageSelfConsistent &&
    tokenMatch;
  const windowReasons = [];
  if (!runGatePassed) windowReasons.push("billing_run_not_pass");
  if (!sameBillingHour) windowReasons.push("request_crossed_billing_hour");
  if (!snapshotMetadataValid) windowReasons.push("snapshot_metadata_mismatch");
  if (!beforeBracketsRequest) windowReasons.push("before_snapshot_not_before_request");
  if (!afterBracketsRequest) windowReasons.push("after_snapshot_not_after_request");
  if (contaminatingModelBuckets.length > 0) windowReasons.push("other_model_activity_in_hour");
  if (!officialUsageSelfConsistent) windowReasons.push("official_usage_categories_mismatch");
  if (!tokenMatch) windowReasons.push("official_token_delta_mismatch");

  const breakdown = requestTokenTotal !== null && actualCredits !== null
    ? calculateCreditBreakdown({
        uncachedInputTokens,
        cachedInputTokens,
        outputTokens,
        offPeak: isOffPeakBillingTime(startedAt),
        actualCredits,
      })
    : null;
  const ratio = breakdown?.effective_extra_discount_ratio ?? null;
  const discount = !windowClean
    ? "INCONCLUSIVE"
    : ratio !== null && Math.abs(ratio - 0.67) <= 0.02
    ? "PASS"
    : ratio !== null && Math.abs(ratio - 1) <= 0.02
      ? "FAIL"
      : "INCONCLUSIVE";
  const identity = compareBillingIdentitySurfaces(before, after, run);
  return {
    status: windowClean ? "PASS" : "INCONCLUSIVE",
    window: {
      clean: windowClean,
      reasons: windowReasons,
      billing_date: startParts.date,
      billing_hour: hour,
      off_peak: isOffPeakBillingTime(startedAt),
      same_billing_hour: sameBillingHour,
      before_captured_at: before?.captured_at ?? null,
      after_captured_at: after?.captured_at ?? null,
      before_brackets_request: beforeBracketsRequest,
      after_brackets_request: afterBracketsRequest,
      target_bucket_before: targetBucketBefore,
      contaminating_model_buckets: contaminatingModelBuckets,
    },
    hour,
    model: TARGET_MODEL_ID,
    request_usage_source: requestUsageSource,
    request_usage: {
      cached_input_tokens: cachedInputTokens,
      uncached_input_tokens: uncachedInputTokens,
      output_tokens: outputTokens,
      total_tokens: requestTokenTotal,
      runtime_usage_complete: runtimeUsageComplete,
      runtime_usage_matches_official: runtimeUsageMatchesOfficial,
      official_usage_complete: officialUsageSelfConsistent,
    },
    official_delta: delta,
    token_match: tokenMatch ? "PASS" : "FAIL",
    billing_identity: identity,
    ...(breakdown ?? {
      base_credits: null,
      time_multiplier: null,
      expected_without_extra_discount: null,
      expected_with_zero_point_six_seven: null,
      actual_credits: actualCredits,
      effective_extra_discount_ratio: null,
    }),
    discount,
  };
}

export function parseArgs(argv) {
  const options = {
    mode: "help",
    runRoot: DEFAULT_RUN_ROOT,
    officialSourceRoot: DEFAULT_OFFICIAL_SOURCE,
    officialDataBase: DEFAULT_OFFICIAL_DATA_BASE,
    variant: "baseline",
    beforeSnapshotPath: null,
    afterSnapshotPath: null,
    billingEvidencePath: path.join(isolatedPaths(DEFAULT_RUN_ROOT).root, "billing-evidence.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--smoke") options.mode = "smoke";
    else if (argument === "--protocol-smoke") options.mode = "protocol-smoke";
    else if (argument === "--billing") options.mode = "billing";
    else if (argument === "--analyze") options.mode = "analyze";
    else if (["--run-root", "--official-source", "--official-data-base", "--variant",
      "--before-snapshot", "--after-snapshot", "--billing-evidence"].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--run-root") options.runRoot = path.resolve(value);
      if (argument === "--official-source") options.officialSourceRoot = path.resolve(value);
      if (argument === "--official-data-base") options.officialDataBase = path.resolve(value);
      if (argument === "--variant") {
        if (!BILLING_VARIANTS[value]) throw new Error(`unknown variant: ${value}`);
        options.variant = value;
      }
      if (argument === "--before-snapshot") options.beforeSnapshotPath = path.resolve(value);
      if (argument === "--after-snapshot") options.afterSnapshotPath = path.resolve(value);
      if (argument === "--billing-evidence") options.billingEvidencePath = path.resolve(value);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const options = parseArgs(rawArgs);
  if (["smoke", "protocol-smoke", "billing"].includes(options.mode)) {
    const child = ensureHarnessNetworkObserver({
      runRoot: options.runRoot,
      mode: options.mode,
      args: rawArgs,
    });
    if (child) {
      process.exitCode = Number.isInteger(child.status) ? child.status : 1;
      return;
    }
  }
  if (options.mode === "smoke") {
    const evidence = await runIsolatedSmoke(options);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      reason: evidence.reason ?? null,
      credential_store_status: evidence.credential_store_status ?? null,
      official_source: evidence.official_source,
      app_server_initialized: evidence.official_services?.app_server_initialized ?? false,
      shared_state_unchanged: evidence.shared_state?.unchanged ?? false,
      cleanup: evidence.cleanup?.status ?? "FAIL",
      host_wake: evidence.host_wake?.status ?? "FAIL",
      model_requests: evidence.model_requests,
    }, null, 2)}\n`);
    return;
  }
  if (options.mode === "protocol-smoke") {
    const evidence = await runIsolatedSmoke({ ...options, protocolDiagnostic: true });
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      protocol_diagnostic: evidence.protocol_diagnostic,
      cleanup: evidence.cleanup?.status ?? "FAIL",
      shared_state_unchanged: evidence.shared_state?.unchanged ?? false,
      host_wake: evidence.host_wake?.status ?? "FAIL",
      model_requests: evidence.protocol_diagnostic?.model_requests ?? 0,
    }, null, 2)}\n`);
    return;
  }
  if (options.mode === "billing") {
    const evidence = await runBillingProbe(options);
    process.stdout.write(`${JSON.stringify({
      status: evidence.status,
      real_model_requests: evidence.experiment?.real_model_requests ?? 0,
      actual_provider: evidence.model_evidence?.actual_provider ?? null,
      actual_model: evidence.model_evidence?.actual_model ?? null,
      runtime_auth_calls: evidence.runtime?.runtime_auth_calls ?? 0,
      runtime_auth_applied: evidence.runtime?.runtime_auth_applied ?? false,
      cleanup: evidence.cleanup?.status ?? "FAIL",
      shared_state_unchanged: evidence.shared_state?.unchanged ?? false,
      host_wake: evidence.host_wake?.status ?? "FAIL",
      usage_numeric: evidence.runtime?.usage_numeric ?? null,
    }, null, 2)}\n`);
    return;
  }
  if (options.mode === "analyze") {
    if (!options.beforeSnapshotPath || !options.afterSnapshotPath) {
      throw new Error("--analyze requires --before-snapshot and --after-snapshot");
    }
    const result = await analyzeBillingEvidence(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    "Usage:",
    "  node tools/cost-lab/official-assembly-live-probe.mjs --smoke",
    "  node tools/cost-lab/official-assembly-live-probe.mjs --protocol-smoke",
    "  node tools/cost-lab/official-assembly-live-probe.mjs --billing --before-snapshot <json>",
    "  node tools/cost-lab/official-assembly-live-probe.mjs --billing --variant v4-project-location-cache --before-snapshot <json>",
    "  node tools/cost-lab/official-assembly-live-probe.mjs --analyze --before-snapshot <json> --after-snapshot <json>",
    "",
    "Live modes write only under the task .run directory. No mode is enabled by default.",
    "",
  ].join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
