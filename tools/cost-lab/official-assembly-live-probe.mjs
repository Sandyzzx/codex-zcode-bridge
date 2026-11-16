import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
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

export const OFFICIAL_HOST_ROOT = path.join(
  PROJECT_ROOT,
  "plugins",
  "codex-zcode-bridge",
  "worker",
  "vendor",
  "official-host",
  "win32-x64-node24.16.0-zcode3.18.2-fec97590",
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

const TARGET_PROVIDER_ID = "account:bigmodel-individual-coding-plan";
const TARGET_MODEL_ID = "GLM-5.3-Flash";
const PROJECT_LOCATION_PREFIX = "project-key-location:v1:";
const DEFAULT_OFFICIAL_DATA_BASE = "D:\\Program Files";
const RPC_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = 120_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const SHARED_STATE_FILES = [
  "credential-source",
  "credentials.json",
  "credentials.json.keyring.lock",
  "credentials.json.lock",
  "setting.json",
  "settings.json",
  "provider_config.json",
  "config.json",
  "coding-plan-cache.json",
  "certs/zcode-network-ca.pem",
  "certs/zcode-network-ca.key",
];

function projectRelative(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, "/");
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
  const verified = {};
  for (const [name, definition] of Object.entries(HOST_ASSETS)) {
    const fullPath = path.resolve(root, definition.relativePath);
    assertInside(root, fullPath);
    const facts = await stat(fullPath);
    if (!facts.isFile() || facts.size !== definition.bytes) {
      throw new Error(`official host asset size mismatch: ${name}`);
    }
    const digest = await sha256File(fullPath);
    if (digest !== definition.sha256) {
      throw new Error(`official host asset digest mismatch: ${name}`);
    }
    verified[name] = fullPath;
  }
  return verified;
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
    status: "BLOCKED",
    reason: "official_credential_read_requires_shared_transient_lock",
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

async function prepareIsolatedFixture(runRoot) {
  const paths = isolatedPaths(runRoot);
  await mkdir(paths.v2, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.runtimeDirectory, { recursive: true });
  await writeJsonAtomic(paths.providerConfig, syntheticProviderConfig());
  await writeJsonAtomic(paths.config, syntheticOfficialConfig());
  await writeJsonAtomic(paths.codingPlanCache, syntheticCodingPlanCache());
  await writeFile(
    path.join(paths.workspace, "fixture.txt"),
    "Isolated official assembly probe workspace.\n",
    { encoding: "utf8", flag: "w" },
  );

  const env = {
    ...process.env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    ZCODE_DESKTOP_HOME_DIR: paths.home,
    ZCODE_DATA_BASE_DIR: paths.home,
    ZCODE_HOME: path.join(paths.home, ".zcode"),
    ZCODE_BRIDGE_NODE: process.execPath,
    ZCODE_BRIDGE_ZCODE_CJS: (await verifyLiveHostAssets()).appServerEntry,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: (await verifyLiveHostAssets()).builtinProviderConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.providerConfig,
    ZCODE_BRIDGE_DATA_DIR: path.join(paths.root, "bridge-data"),
    ZCODE_BRIDGE_MODE: "plan",
    ZCODE_BRIDGE_BROWSER_USE: "off",
    TEMP: path.join(paths.root, "tmp"),
    TMP: path.join(paths.root, "tmp"),
  };
  await mkdir(env.TEMP, { recursive: true });
  return { paths, env };
}

async function captureSharedState(officialDataBase) {
  const v2 = path.join(officialDataBase, ".zcode", "v2");
  const candidates = new Set(SHARED_STATE_FILES.map((relative) => path.join(v2, relative)));
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
    const left = beforeByPath.get(relativePath);
    const right = afterByPath.get(relativePath);
    if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(relativePath);
  }
  return { unchanged: changed.length === 0, changed_paths: changed };
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
  return { providerId: current.providerId, modelId: current.modelId };
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
}) {
  const runtimeSource = await readFile(assets.hostModule, "utf8");
  const isolation = assessCredentialReadIsolation(runtimeSource, officialDataBase);
  if (isolation.status !== "PASS") return isolation;
  const patched = patchReadOnlyRuntimeExports(runtimeSource);
  await writeFile(paths.authRuntime, patched, { encoding: "utf8", flag: "w" });
  const runtime = await import(`${pathToFileURL(paths.authRuntime).href}?run=${Date.now()}`);
  runtime.setDataBaseDir(officialDataBase);
  const realReadOnly = runtime.createCredentialService({
    readOnly: true,
    migrateOnRead: false,
    readOnlyKeyMaterial: true,
  });
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

  const isolatedLocations = new Map();
  const locationKeys = (keys) => keys.every((key) =>
    typeof key === "string" && key.startsWith(PROJECT_LOCATION_PREFIX));
  const credentialService = new Proxy(realReadOnly, {
    get(target, property) {
      if (property === "load") {
        return async (key) => key.startsWith(PROJECT_LOCATION_PREFIX)
          ? isolatedLocations.get(key) ?? null
          : target.load(key);
      }
      if (property === "loadMany") {
        return async (keys) => Object.fromEntries(await Promise.all(keys.map(async (key) => [
          key,
          key.startsWith(PROJECT_LOCATION_PREFIX)
            ? isolatedLocations.get(key) ?? null
            : await target.load(key),
        ])));
      }
      if (property === "save") {
        return async (key, value, assertCurrent) => {
          if (!key.startsWith(PROJECT_LOCATION_PREFIX)) return target.save(key, value, assertCurrent);
          assertCurrent?.();
          isolatedLocations.set(key, value);
        };
      }
      if (property === "saveIfAbsent") {
        return async (key, value) => {
          if (!key.startsWith(PROJECT_LOCATION_PREFIX)) return target.saveIfAbsent(key, value);
          if (isolatedLocations.has(key)) return isolatedLocations.get(key);
          isolatedLocations.set(key, value);
          return value;
        };
      }
      if (property === "delete") {
        return async (key, assertCurrent) => {
          if (!key.startsWith(PROJECT_LOCATION_PREFIX)) return target.delete(key, assertCurrent);
          assertCurrent?.();
          isolatedLocations.delete(key);
        };
      }
      if (property === "deleteIfEquals") {
        return async (key, expected) => {
          if (!key.startsWith(PROJECT_LOCATION_PREFIX)) return target.deleteIfEquals(key, expected);
          if (isolatedLocations.get(key) === expected) isolatedLocations.delete(key);
        };
      }
      if (property === "updateMany") {
        return async (changes, options) => {
          if (!locationKeys(Object.keys(changes))) return target.updateMany(changes, options);
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
          if (!key.startsWith(PROJECT_LOCATION_PREFIX)) return target.recoverUnreadable(key, assertCurrent);
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
    store_status: storeStatus?.status ?? "unknown",
    project_token_locations: "IN_MEMORY_ONLY",
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
        ZCODE_APP_VERSION: "3.18.2",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: assets.builtinProviderConfig,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.providerConfig,
        ZCODE_RUNTIME_HOST_PATH: assets.runtimeHost,
      };
      return {
        command: process.execPath,
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

function bindProtocolHandlers(client, state) {
  const disposables = [];
  disposables.push(client.onRequest(async (message) => {
    const method = typeof message?.method === "string" ? message.method : "";
    const id = message?.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    if (method === "session/requestRuntimePreferences") {
      await client.respond(id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      });
      return;
    }
    if (method === "interaction/requestProviderRuntimeHeaders") {
      state.runtime_auth_calls += 1;
      const providerId = message.params?.modelSelection?.providerId ?? message.params?.providerId;
      const modelId = message.params?.modelSelection?.modelId;
      if (providerId !== TARGET_PROVIDER_ID || modelId !== TARGET_MODEL_ID ||
          state.auth_service_status !== "PASS" || !state.auth_service) {
        await client.respond(id, unavailableAuthReply());
        return;
      }
      try {
        const result = await state.auth_service.resolveProviderRuntimeRequest(
          message.params,
          { signal: state.abort_controller.signal },
        );
        state.runtime_auth_applied = result?.headersApplied === true;
        // Never persist or log requestAuth; only the boolean crosses the boundary.
        await client.respond(id, result);
      } catch {
        await client.respond(id, unavailableAuthReply());
      }
      return;
    }
    if (method === "interaction/requestPermission" ||
        method === "interaction/requestUserInput") {
      await client.respond(id, interactionReply(method));
      return;
    }
    await client.respondError(id, {
      code: -32601,
      message: `Unsupported isolated probe request: ${method.slice(0, 120)}`,
    });
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
    state.terminal_resolve?.();
  }));
  disposables.push(client.onClose(() => {
    state.connection_closed = true;
    state.terminal_resolve?.();
  }));
  return disposables;
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
} = {}) {
  for (const [root, candidate] of [
    [PROJECT_ROOT, runRoot],
    [runRoot, isolatedPaths(runRoot).root],
  ]) {
    assertInside(root, candidate);
  }
  const sourceAudit = await auditOfficialAssemblySources({ officialSourceRoot });
  const assets = await verifyLiveHostAssets();
  const { paths, env } = await prepareIsolatedFixture(runRoot);
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
      isolated_paths: {
        root: projectRelative(paths.root),
        home: projectRelative(paths.home),
        workspace: projectRelative(paths.workspace),
      },
      official_services: {
        initialized: false,
        app_server_initialized: false,
        credential_read_attempted: false,
        shared_lock_path: auth.shared_lock_root ?? null,
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
  };
  let runtimePid = null;
  let treePids = [];
  const disposables = [];
  let cleanupErrors = [];
  let sessionId = null;
  try {
    const client = await withScopedRuntimeHostPath(
      assets.runtimeHost,
      () => manager.getClient(workspace),
    );
    const identity = await manager.getRuntimeIdentity(workspace);
    runtimePid = identity.processId ?? null;
    treePids = processTreePids(listProcesses(), runtimePid);
    disposables.push(...bindProtocolHandlers(client, state));
    const snapshot = await client.request("session/create", {
      workspace: {
        workspacePath: paths.workspace,
        workspaceKey: paths.workspace,
      },
      mode: "plan",
      persistence: "immediate",
    });
    sessionId = nested(snapshot, ["session", "sessionId"]) ?? null;
    state.session_id = sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("isolated AppServer did not return a session ID");
    }
  } catch (error) {
    events.push({
      type: "smoke_error",
      code: error instanceof Error ? error.name : "unknown_error",
    });
  } finally {
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
  const passed =
    events.every((event) => event.type !== "smoke_error") &&
    typeof sessionId === "string" &&
    auth.status === "PASS" &&
    sharedComparison.unchanged &&
    cleanupPassed &&
    hostWakeUnchanged;
  const evidence = {
    schema_version: 1,
    kind: "coding_plan_official_assembly_isolated_smoke",
    generated_at: new Date().toISOString(),
    status: passed ? "PASS" : "FAIL",
    official_source: sourceAudit.official_source,
    isolated_paths: {
      root: projectRelative(paths.root),
      home: projectRelative(paths.home),
      workspace: projectRelative(paths.workspace),
    },
    official_services: {
      app_server_initialized: typeof sessionId === "string",
      session_created: typeof sessionId === "string",
      app_server_pid: runtimePid,
      credential_service: auth.credential_store,
      credential_store_status: auth.store_status,
      project_token_locations: auth.project_token_locations,
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
    model_requests: 0,
    network_requests: 0,
    events,
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

async function runProbeConversation({
  client,
  state,
  paths,
  assets,
  accountProviderPayload,
}) {
  const providerResult = await client.request(
    "provider/updateAccountConfig",
    accountProviderPayload,
  );
  const providerStatus =
    providerResult && typeof providerResult.status === "string"
      ? providerResult.status
      : "accepted";

  let snapshot = await client.request("session/create", {
    workspace: {
      workspacePath: paths.workspace,
      workspaceKey: paths.workspace,
    },
    mode: "plan",
    persistence: "immediate",
  });
  const sessionId = nested(snapshot, ["session", "sessionId"]);
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("isolated AppServer did not return a session ID");
  }
  state.session_id = sessionId;

  let selection = selectedModel(snapshot);
  if (selection?.providerId !== TARGET_PROVIDER_ID || selection?.modelId !== TARGET_MODEL_ID) {
    snapshot = await client.request("session/setModel", {
      sessionId,
      model: {
        providerId: TARGET_PROVIDER_ID,
        modelId: TARGET_MODEL_ID,
      },
      persistAsWorkspaceLastUsed: false,
    });
    selection = selectedModel(snapshot);
  }
  if (selection?.providerId !== TARGET_PROVIDER_ID || selection?.modelId !== TARGET_MODEL_ID) {
    throw new Error("isolated AppServer did not select GLM-5.3-Flash");
  }

  const runtimeSeq = nested(snapshot, ["runtime", "eventSeq"]);
  await client.request("session/subscribe", {
    sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: false,
    afterSeq: typeof runtimeSeq === "number" ? runtimeSeq : 0,
  });
  await client.request("session/send", {
    sessionId,
    content: buildProbePrompt(minimalTask()),
  });
  await waitForTerminal(state, MODEL_TIMEOUT_MS);
  return {
    session_id: sessionId,
    selected_model: selection,
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

function modelHourBucket(snapshot, modelId, hour) {
  const rows = snapshot?.model_usage?.modelDataList;
  if (!Array.isArray(rows)) throw new Error("official snapshot model rows are missing");
  const row = rows.find((entry) => entry?.modelName === modelId);
  if (!row) throw new Error(`official model row is missing: ${modelId}`);
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

  const target = modelHourBucket(snapshot, TARGET_MODEL_ID, current.hour);
  if (target.tokensUsage !== 0 || target.creditsUsage !== 0) {
    throw new Error("target model already has activity in the current billing hour");
  }
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
} = {}) {
  const paths = isolatedPaths(runRoot);
  assertInside(PROJECT_ROOT, runRoot);
  assertInside(runRoot, paths.root);
  if (!existsSync(paths.evidence)) {
    throw new Error("isolated smoke evidence is missing");
  }
  const smoke = JSON.parse(await readFile(paths.evidence, "utf8"));
  if (smoke.status !== "PASS" || smoke.shared_state?.unchanged !== true ||
      smoke.cleanup?.status !== "PASS") {
    throw new Error("isolated smoke gate is not PASS");
  }
  if (existsSync(paths.billingStarted)) {
    throw new Error("B billing probe was already attempted; refusing a second real request");
  }
  if (!beforeSnapshotPath) throw new Error("--before-snapshot is required");
  const beforeSnapshot = JSON.parse(await readFile(beforeSnapshotPath, "utf8"));
  if (beforeSnapshot.schema_version !== 1 ||
      !Array.isArray(beforeSnapshot.model_usage?.modelDataList)) {
    throw new Error("official before snapshot is invalid");
  }
  const beforeWindow = validateBeforeBillingSnapshot(beforeSnapshot);
  const sourceAudit = await auditOfficialAssemblySources({ officialSourceRoot });
  const assets = await verifyLiveHostAssets();
  const { env } = await prepareIsolatedFixture(runRoot);
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
  };
  let runtimePid = null;
  let treePids = [];
  const disposables = [];
  let cleanupErrors = [];
  let conversation = null;
  let primaryError = null;
  try {
    const client = await withScopedRuntimeHostPath(
      assets.runtimeHost,
      () => manager.getClient(workspace),
    );
    const identity = await manager.getRuntimeIdentity(workspace);
    runtimePid = identity.processId ?? null;
    treePids = processTreePids(listProcesses(), runtimePid);
    disposables.push(...bindProtocolHandlers(client, state));
    const builtinSource = await readFile(assets.builtinProviderConfig, "utf8");
    const revisionDigest = createHash("sha256").update(builtinSource).digest("hex");
    const accountProviderPayload = buildAccountProviderPayload(
      builtinSource,
      `zcode-builtin:44:${revisionDigest}`,
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
  const completed = !primaryError && !state.timeout &&
    state.terminal_type === "turn.completed" &&
    state.result_type === "success" &&
    state.runtime_auth_calls > 0 &&
    state.runtime_auth_applied === true;
  const evidence = {
    schema_version: 1,
    kind: "coding_plan_official_assembly_b_billing",
    generated_at: finishedAt,
    status: completed && sameBillingHour && sharedComparison.unchanged &&
      cleanupPassed && hostWakeUnchanged
      ? "PASS"
      : "FAIL",
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
      reasoning_level: null,
      prompt_kind: "exact_marker_json",
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
      project_token_locations: auth.project_token_locations,
    },
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

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function analyzeBillingSnapshots(before, after, run) {
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
  const beforeModel = beforeRows.find((entry) => entry?.modelName === TARGET_MODEL_ID);
  const afterModel = afterRows.find((entry) => entry?.modelName === TARGET_MODEL_ID);
  if (!beforeModel || !afterModel) {
    throw new Error("target official model row is missing from before/after snapshots");
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
  const delta = {};
  for (const key of sourceKeys) {
    const left = finiteNumber(beforeModel[key]?.[hour]);
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
  const cachedInputTokens = runtimeCachedInputTokens ?? delta.cachedInputTokensUsage;
  const uncachedInputTokens = runtimeUncachedInputTokens ?? delta.uncachedInputTokensUsage;
  const outputTokens = runtimeOutputTokens ?? delta.outputTokensUsage;
  const runtimeUsageComplete =
    runtimeCachedInputTokens !== null &&
    runtimeUncachedInputTokens !== null &&
    runtimeOutputTokens !== null;
  const requestUsageSource = runtimeUsageComplete
    ? "RUNTIME_USAGE"
    : "OFFICIAL_HOURLY_DELTA";
  const actualCredits = finiteNumber(delta.creditsUsage);
  const requestTokenTotal =
    cachedInputTokens !== null && uncachedInputTokens !== null && outputTokens !== null
      ? cachedInputTokens + uncachedInputTokens + outputTokens
      : null;
  const tokenMatch =
    requestTokenTotal !== null &&
    delta.tokensUsage !== null &&
    Math.abs(requestTokenTotal - delta.tokensUsage) < 1e-6;

  const targetBucketBefore = modelHourBucket(before, TARGET_MODEL_ID, hour);
  const contaminatingModelBuckets = [];
  const modelNames = new Set([
    ...beforeRows.map((entry) => entry?.modelName).filter((name) => typeof name === "string"),
    ...afterRows.map((entry) => entry?.modelName).filter((name) => typeof name === "string"),
  ]);
  for (const modelName of modelNames) {
    if (modelName === TARGET_MODEL_ID) continue;
    const beforeBucket = modelHourBucket(before, modelName, hour);
    const afterBucket = modelHourBucket(after, modelName, hour);
    if (beforeBucket.tokensUsage !== afterBucket.tokensUsage ||
        beforeBucket.creditsUsage !== afterBucket.creditsUsage) {
      contaminatingModelBuckets.push({
        model: modelName,
        token_delta: afterBucket.tokensUsage - beforeBucket.tokensUsage,
        credit_delta: afterBucket.creditsUsage - beforeBucket.creditsUsage,
      });
    }
  }
  const targetBucketWasEmpty =
    targetBucketBefore.tokensUsage === 0 && targetBucketBefore.creditsUsage === 0;
  const runGatePassed = run?.status === "PASS";
  const windowClean =
    runGatePassed &&
    sameBillingHour &&
    snapshotMetadataValid &&
    beforeBracketsRequest &&
    afterBracketsRequest &&
    targetBucketWasEmpty &&
    contaminatingModelBuckets.length === 0 &&
    tokenMatch;
  const windowReasons = [];
  if (!runGatePassed) windowReasons.push("billing_run_not_pass");
  if (!sameBillingHour) windowReasons.push("request_crossed_billing_hour");
  if (!snapshotMetadataValid) windowReasons.push("snapshot_metadata_mismatch");
  if (!beforeBracketsRequest) windowReasons.push("before_snapshot_not_before_request");
  if (!afterBracketsRequest) windowReasons.push("after_snapshot_not_after_request");
  if (!targetBucketWasEmpty) windowReasons.push("target_hour_not_empty_before_request");
  if (contaminatingModelBuckets.length > 0) windowReasons.push("other_model_activity_in_hour");
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
    },
    official_delta: delta,
    token_match: tokenMatch ? "PASS" : "FAIL",
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

function parseArgs(argv) {
  const options = {
    mode: "help",
    runRoot: DEFAULT_RUN_ROOT,
    officialSourceRoot: DEFAULT_OFFICIAL_SOURCE,
    officialDataBase: DEFAULT_OFFICIAL_DATA_BASE,
    beforeSnapshotPath: null,
    afterSnapshotPath: null,
    billingEvidencePath: path.join(isolatedPaths(DEFAULT_RUN_ROOT).root, "billing-evidence.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--smoke") options.mode = "smoke";
    else if (argument === "--billing") options.mode = "billing";
    else if (argument === "--analyze") options.mode = "analyze";
    else if (["--run-root", "--official-source", "--official-data-base",
      "--before-snapshot", "--after-snapshot", "--billing-evidence"].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--run-root") options.runRoot = path.resolve(value);
      if (argument === "--official-source") options.officialSourceRoot = path.resolve(value);
      if (argument === "--official-data-base") options.officialDataBase = path.resolve(value);
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
  const options = parseArgs(process.argv.slice(2));
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
    "  node tools/cost-lab/official-assembly-live-probe.mjs --billing --before-snapshot <json>",
    "  node tools/cost-lab/official-assembly-live-probe.mjs --analyze --before-snapshot <json> --after-snapshot <json>",
    "",
    "Live modes write only under the task .run directory. No mode is enabled by default.",
    "",
  ].join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
