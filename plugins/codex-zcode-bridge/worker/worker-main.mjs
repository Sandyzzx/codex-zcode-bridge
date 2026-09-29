// src/adapters/zcode-app-server-adapter.ts
import { spawn as spawn2 } from "node:child_process";

// src/adapters/agent-report.ts
var TEST_STATUSES = /* @__PURE__ */ new Set(["passed", "failed", "not_run"]);
var MAX_SCAN_CHARS = 4e5;
function parseAgentReport(responseText) {
  let lastError = null;
  let lastCandidate = null;
  for (const candidate of extractJsonObjects(responseText)) {
    const validated = validateAgentReport(candidate);
    if (validated.ok) {
      return { report: validated.report, candidate: validated.report, error: null };
    }
    lastError = validated.error;
    lastCandidate = extractReportCandidate(candidate);
  }
  return {
    report: null,
    candidate: lastCandidate,
    error: lastError ?? "no JSON object found in the response text"
  };
}
function extractReportCandidate(value) {
  if (!isPlainObject(value)) return null;
  const candidate = {};
  if (typeof value["summary"] === "string") candidate.summary = value["summary"];
  if (isStringArray(value["files_changed"])) candidate.files_changed = value["files_changed"];
  if (isStringArray(value["issues"])) candidate.issues = value["issues"];
  if (typeof value["needs_master_decision"] === "boolean") candidate.needs_master_decision = value["needs_master_decision"];
  if (Array.isArray(value["tests"])) {
    const tests = [];
    for (const entry of value["tests"]) {
      const test = validateTestReport(entry);
      if (!test.ok) return candidate;
      tests.push(test.test);
    }
    candidate.tests = tests;
  }
  return Object.keys(candidate).length ? candidate : null;
}
function validateAgentReport(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: "report is not a JSON object" };
  }
  const summary = value["summary"];
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { ok: false, error: "report.summary must be a non-empty string" };
  }
  const filesChanged = value["files_changed"];
  if (!isStringArray(filesChanged)) {
    return { ok: false, error: "report.files_changed must be an array of strings" };
  }
  const testsRaw = value["tests"];
  if (!Array.isArray(testsRaw)) {
    return { ok: false, error: "report.tests must be an array" };
  }
  const tests = [];
  for (const entry of testsRaw) {
    const test = validateTestReport(entry);
    if (!test.ok) {
      return { ok: false, error: `report.tests entry invalid: ${test.error}` };
    }
    tests.push(test.test);
  }
  const issues = value["issues"];
  if (!isStringArray(issues)) {
    return { ok: false, error: "report.issues must be an array of strings" };
  }
  const needsMasterDecision = value["needs_master_decision"];
  if (typeof needsMasterDecision !== "boolean") {
    return { ok: false, error: "report.needs_master_decision must be a boolean" };
  }
  return {
    ok: true,
    report: {
      summary,
      files_changed: filesChanged,
      tests,
      issues,
      needs_master_decision: needsMasterDecision
    }
  };
}
function validateTestReport(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: "entry is not an object" };
  }
  const command = value["command"];
  if (typeof command !== "string") {
    return { ok: false, error: "command must be a string" };
  }
  const status = value["status"];
  if (typeof status !== "string" || !TEST_STATUSES.has(status)) {
    return { ok: false, error: "status must be one of passed|failed|not_run" };
  }
  const details = value["details"];
  if (details !== void 0 && typeof details !== "string") {
    return { ok: false, error: "details must be a string when present" };
  }
  return {
    ok: true,
    test: details === void 0 ? { command, status } : { command, status, details }
  };
}
function* extractJsonObjects(text) {
  if (text.trimStart().startsWith("{")) {
    try {
      yield JSON.parse(text);
    } catch {
    }
  }
  const limit = Math.min(text.length, MAX_SCAN_CHARS);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          try {
            yield JSON.parse(slice);
          } catch {
          }
          start = -1;
        }
      }
    }
  }
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/prompts/task-prompt.ts
var MAX_PROMPT_CHARS = 6e4;
var MAX_SECTION_CHARS = 4e3;
var MAX_CONTEXT_CHARS = 2e3;
function buildTaskPrompt(task) {
  const sections = [
    `TASK ID: ${task.task_id}`,
    "You are a subordinate coding agent executing one bounded task inside the current working directory. Stay inside the workspace; do not touch files outside it.",
    `PROJECT WORKSPACE: ${task.workspace}`,
    ...task.worktree_path ? [`CODEX-SELECTED EXECUTION WORKTREE: ${task.worktree_path}. Make task changes in the current working directory, which is this worktree; the project workspace above identifies its parent project.`] : [],
    ...task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : [],
    ...task.timeout_ms ? [`EXECUTION TIME LIMIT: ${task.timeout_ms} ms for this attempt.`] : [],
    `OBJECTIVE
${bounded(task.objective, MAX_SECTION_CHARS)}`,
    renderList("REQUIREMENTS", task.requirements),
    renderPaths("ALLOWED PATHS (write only inside these when provided)", task.allowed_paths),
    renderPaths("FORBIDDEN PATHS (never create, modify, or delete)", task.forbidden_paths),
    renderList(
      "ACCEPTANCE CRITERIA (the master verifies these independently; do not self-certify)",
      task.acceptance_criteria
    ),
    renderList(
      "TEST COMMANDS (run the applicable ones and report a status for each)",
      task.test_commands
    ),
    DECISION_RULE
  ];
  if (task.context && task.context.trim().length > 0) {
    sections.push(`CONTEXT
${bounded(task.context, MAX_CONTEXT_CHARS)}`);
  }
  return joinBoundedPreservingTail([...sections, OUTPUT_CONTRACT], OUTPUT_CONTRACT);
}
function buildContinuePrompt(input) {
  const { task, feedback, additionalRequirements, previousSessionId, previousResult } = input;
  const sections = [
    `TASK ID: ${task.task_id}`,
    "You are a subordinate coding agent continuing a previous task in the same workspace. Stay inside the workspace.",
    ...task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : []
  ];
  if (previousSessionId) {
    sections.push(
      `This run resumes persisted session ${previousSessionId}; earlier conversation context may be available.`
    );
  }
  if (previousResult) {
    sections.push(
      `PREVIOUS RESULT (normalized claims from the previous attempt)
${bounded(
        JSON.stringify(previousResult, null, 2),
        MAX_SECTION_CHARS
      )}`
    );
    if (previousResult.error_code === "invalid_agent_report") {
      sections.push(
        "REPORT REPAIR MODE: The previous attempt's execution has already ended; only its final report failed validation. Do not edit files, rerun tests, or repeat task work. Reconstruct the final JSON report from the previous response and report_candidate. Do not guess missing facts. If a required boolean or other fact cannot be established, set needs_master_decision=true and describe the uncertainty in issues."
      );
    }
  }
  sections.push(`MASTER FEEDBACK (address every point)
${bounded(feedback, MAX_SECTION_CHARS)}`);
  if (additionalRequirements.length > 0) {
    sections.push(renderList("ADDITIONAL REQUIREMENTS", [...additionalRequirements]));
  }
  sections.push(`ORIGINAL TASK
${buildTaskPrompt(task)}`);
  return joinBoundedPreservingTail(sections, OUTPUT_CONTRACT);
}
var OUTPUT_CONTRACT = [
  "OUTPUT CONTRACT (mandatory)",
  "Your final response must be exactly one JSON object with no markdown fences and no text before or after it, matching this shape:",
  '{"summary": string, "files_changed": string[], "tests": [{"command": string, "status": "passed" | "failed" | "not_run", "details"?: string}], "issues": string[], "needs_master_decision": boolean}',
  "List every file you created or modified in files_changed (workspace-relative paths). Give one tests entry per applicable test command; use status not_run when a command was not applicable or could not run. Record problems in issues. Set needs_master_decision=true only when a required decision is outside your authority; never guess."
].join("\n");
var DECISION_RULE = [
  "DECISION RULE",
  "Use only this task package, this prompt, repository files you inspect, and available tools; do not assume access to Codex's conversation.",
  "Do not choose unresolved items explicitly listed under OPEN DECISIONS; a later explicit Master Feedback decision resolves that item. Also escalate conflicting requirements or missing decisions that would materially change externally visible behavior, even when Codex did not list them. Record the exact question in issues and set needs_master_decision=true. Continue independent work that does not depend on the decision. For low-impact implementation choices, use the simplest consistent option and state the assumption in issues."
].join("\n");
function renderList(title, items) {
  if (items.length === 0) {
    return `${title}
- (none)`;
  }
  return `${title}
${items.map((item) => `- ${item}`).join("\n")}`;
}
function renderPaths(title, paths) {
  if (paths.length === 0) {
    return `${title}
- (unspecified; still write only within the workspace)`;
  }
  return `${title}
${paths.map((item) => `- ${item}`).join("\n")}`;
}
function bounded(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\u2026[truncated]`;
}
function joinBoundedPreservingTail(sections, requiredTail) {
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_PROMPT_CHARS) return joined;
  const headBudget = MAX_PROMPT_CHARS - requiredTail.length - 24;
  const head = joined.slice(0, Math.max(0, headBudget));
  return `${head}\u2026[middle truncated to preserve required output contract]

${requiredTail}`;
}

// src/runtime/errors.ts
var BridgeError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
  }
};

// src/runtime/resolver.ts
import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var PERSISTED_RUNTIME_KEYS = [
  "ZCODE_BRIDGE_NODE",
  "ZCODE_BRIDGE_ZCODE_CJS",
  "ZCODE_BRIDGE_DATA_DIR",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_HOME",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_WINDOWS_APP_INSTALL_DIR",
  "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID",
  "ZCODE_BRIDGE_DEFAULT_MODEL_ID",
  "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL",
  "ZCODE_BRIDGE_MODE",
  "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS",
  "ZCODE_BRIDGE_TIMEOUT_MS"
];
function loadPersistedRuntimeEnvironment(source, homeDir = homedir()) {
  const settingsPaths = [path.join(homeDir, ".codex", "codex-zcode-bridge", "runtime-config.json")];
  const legacyDataRoot = source["ZCODE_BRIDGE_DATA_DIR"]?.trim();
  if (legacyDataRoot && path.isAbsolute(legacyDataRoot)) {
    settingsPaths.push(path.join(legacyDataRoot, "runtime-config.json"));
  }
  let parsed = null;
  const seenPaths = /* @__PURE__ */ new Set();
  for (const settingsPath of settingsPaths) {
    const normalized = path.resolve(settingsPath);
    const identity = process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
    if (seenPaths.has(identity)) continue;
    seenPaths.add(identity);
    try {
      if (statSync(normalized).size > 64 * 1024) continue;
      const candidate = JSON.parse(readFileSync(normalized, "utf8"));
      if (isPlainObject2(candidate)) {
        parsed = candidate;
        break;
      }
    } catch {
    }
  }
  if (!parsed) return { ...source };
  const env = { ...source };
  for (const key of PERSISTED_RUNTIME_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    const value = parsed[key];
    if (typeof value === "string") env[key] = value.trim();
    else if (value === null) env[key] = "";
  }
  return env;
}
var NodeRuntimeResolver = class {
  #env;
  #homeDir;
  #packageRoot;
  constructor(options = {}) {
    this.#env = options.env ?? process.env;
    this.#homeDir = options.homeDir ?? homedir();
    this.#packageRoot = options.packageRoot ?? null;
  }
  async resolve() {
    const env = loadPersistedRuntimeEnvironment(this.#env, this.#homeDir);
    const zcodeHome = resolveZcodeHome(env);
    let nodeExecutable = "node";
    const nodeOverride = env["ZCODE_BRIDGE_NODE"]?.trim();
    if (nodeOverride) {
      this.#assertReadableFile(
        nodeOverride,
        "ZCODE_BRIDGE_NODE is set but is not a readable file"
      );
      nodeExecutable = nodeOverride;
    }
    let zcodeEntrypoint;
    const entryOverride = env["ZCODE_BRIDGE_ZCODE_CJS"]?.trim();
    if (entryOverride) {
      this.#assertReadableFile(
        entryOverride,
        "ZCODE_BRIDGE_ZCODE_CJS is set but is not a readable file"
      );
      zcodeEntrypoint = entryOverride;
    } else {
      const candidates = installCandidates(env, ["resources", "glm", "zcode.cjs"]);
      const discovered = candidates.find(isReadableFile);
      if (!discovered) {
        throw new BridgeError(
          "runtime_not_found",
          `zcode.cjs was not found; searched: ${candidates.join(", ") || "(no installation roots available)"}`
        );
      }
      zcodeEntrypoint = discovered;
    }
    const builtinEnv = env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim() || null;
    const personalEnv = env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]?.trim() || null;
    let builtinConfigFile;
    let personalConfigFile;
    if (builtinEnv && personalEnv) {
      this.#validateBuiltinConfig(builtinEnv);
      this.#validatePersonalConfig(personalEnv);
      builtinConfigFile = builtinEnv;
      personalConfigFile = personalEnv;
    } else {
      if (builtinEnv) {
        this.#validateBuiltinConfig(builtinEnv);
        builtinConfigFile = builtinEnv;
      } else {
        const candidates = installCandidates(env, [
          "resources",
          "config",
          "provider",
          "zcode-builtin.json"
        ]);
        const discovered = candidates.find(isReadableFile);
        if (!discovered) {
          throw new BridgeError(
            "provider_config_missing",
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE is not set and no builtin provider config was found in the ZCode installation; searched: " + (candidates.join(", ") || "(no installation roots available)")
          );
        }
        this.#validateBuiltinConfig(discovered);
        builtinConfigFile = discovered;
      }
      if (personalEnv) {
        this.#validatePersonalConfig(personalEnv);
        personalConfigFile = personalEnv;
      } else {
        const candidates = zcodeHome ? [path.join(zcodeHome, "v2", "provider_config.json")] : [
          env["ZCODE_DATA_BASE_DIR"]?.trim(),
          ...configuredDataBaseDirs(this.#homeDir),
          this.#homeDir
        ].filter((base) => Boolean(base)).filter((base, index, values) => values.indexOf(base) === index).map((base) => path.join(base, ".zcode", "v2", "provider_config.json"));
        const existing = candidates.filter((candidate) => existsSync(candidate));
        if (existing.length === 0) {
          throw new BridgeError(
            "provider_config_missing",
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE is not set and no personal provider config exists at any of: " + candidates.join(", ")
          );
        }
        let accepted = null;
        let lastError = null;
        for (const candidate of existing) {
          try {
            this.#validatePersonalConfig(candidate);
            accepted = candidate;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        if (!accepted) {
          throw new BridgeError(
            "provider_config_invalid",
            `No usable personal provider config among: ${existing.join(", ")}; last validation failure: ${lastError ?? "unknown"}`
          );
        }
        personalConfigFile = accepted;
      }
    }
    if (zcodeHome && !samePath(personalConfigFile, path.join(zcodeHome, "v2", "provider_config.json"))) {
      throw new BridgeError(
        "provider_config_invalid",
        `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE must be ZCODE_HOME/v2/provider_config.json (${zcodeHome})`
      );
    }
    const dataOverride = env["ZCODE_BRIDGE_DATA_DIR"]?.trim();
    let dataRoot2;
    if (dataOverride) {
      if (!path.isAbsolute(dataOverride)) {
        throw new Error(
          `ZCODE_BRIDGE_DATA_DIR must be an absolute path when set, got: ${dataOverride}`
        );
      }
      dataRoot2 = path.normalize(dataOverride);
    } else {
      dataRoot2 = this.#packageRoot ?? findPackageRoot();
    }
    return {
      nodeExecutable,
      zcodeEntrypoint,
      providerBuiltinConfigFile: builtinConfigFile,
      providerPersonalConfigFile: personalConfigFile,
      dataRoot: dataRoot2
    };
  }
  #assertReadableFile(filePath, label) {
    if (!isReadableFile(filePath)) {
      throw new BridgeError("runtime_not_found", `${label}: ${filePath}`);
    }
  }
  /**
   * Structure validation only. The verified differential signal for the
   * CLI-created stub is an empty providerRules map (see docs/ZCODE_RUNTIME.md);
   * rejecting it implements "never silently select a known stub".
   */
  #validatePersonalConfig(filePath) {
    const parsed = this.#readJsonConfig(filePath, "personal provider config");
    const config = parsed["config"];
    if (!isPlainObject2(config)) {
      throw new BridgeError(
        "provider_config_invalid",
        `Personal provider config has no config object: ${filePath}`
      );
    }
    const providerConfigRules = config["providerConfigRules"];
    const rules = isPlainObject2(providerConfigRules) ? providerConfigRules["providerRules"] : void 0;
    if (!isNonEmptyCollection(rules)) {
      throw new BridgeError(
        "provider_config_invalid",
        `Personal provider config contains no provider rules (this matches the known CLI-created stub shape): ${filePath}`
      );
    }
  }
  #validateBuiltinConfig(filePath) {
    const parsed = this.#readJsonConfig(filePath, "builtin provider config");
    if (!isPlainObject2(parsed["config"])) {
      throw new BridgeError(
        "provider_config_invalid",
        `Builtin provider config has no config object: ${filePath}`
      );
    }
  }
  #readJsonConfig(filePath, label) {
    if (!isReadableFile(filePath)) {
      throw new BridgeError("provider_config_missing", `${label} not found: ${filePath}`);
    }
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new BridgeError(
        "provider_config_invalid",
        `${label} is not readable: ${filePath} (${errorText(error)})`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BridgeError(
        "provider_config_invalid",
        `${label} is not valid JSON: ${filePath} (${errorText(error)})`
      );
    }
    if (!isPlainObject2(parsed)) {
      throw new BridgeError("provider_config_invalid", `${label} is not a JSON object: ${filePath}`);
    }
    return parsed;
  }
};
function installCandidates(env, relative) {
  const roots = [
    env["ZCODE_WINDOWS_APP_INSTALL_DIR"]?.trim(),
    env["LOCALAPPDATA"]?.trim() ? path.join(env["LOCALAPPDATA"].trim(), "Programs", "ZCode") : null,
    env["ProgramFiles"]?.trim() ? path.join(env["ProgramFiles"].trim(), "ZCode") : null
  ].filter((root) => Boolean(root));
  return roots.map((root) => path.join(root, ...relative));
}
function configuredDataBaseDirs(homeDir) {
  const candidates = [path.join(homeDir, ".zcode", "v2", "setting.json")];
  for (const settingPath of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(settingPath, "utf8"));
      if (!isPlainObject2(parsed)) continue;
      const dataBaseDir = parsed["dataBaseDir"];
      if (typeof dataBaseDir === "string" && path.isAbsolute(dataBaseDir.trim())) {
        return [path.normalize(dataBaseDir.trim())];
      }
    } catch {
    }
  }
  return [];
}
function resolveZcodeHome(env) {
  const configured = env["ZCODE_HOME"]?.trim();
  if (!configured) return null;
  if (!path.isAbsolute(configured)) {
    throw new BridgeError("provider_config_invalid", "ZCODE_HOME must be an absolute path");
  }
  const resolved = path.normalize(configured);
  if (path.basename(resolved).toLowerCase() !== ".zcode") {
    throw new BridgeError(
      "provider_config_invalid",
      "ZCODE_HOME must name a .zcode directory so app-server can use the same data root"
    );
  }
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new BridgeError("provider_config_invalid", `ZCODE_HOME is not a directory: ${resolved}`);
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("provider_config_missing", `ZCODE_HOME directory does not exist: ${resolved}`);
  }
  return resolved;
}
function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32" ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}
function isReadableFile(filePath) {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}
function findPackageRoot(startDir) {
  let current = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Cannot locate the Bridge package root (no package.json above ${startDir ?? "module directory"})`
  );
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyCollection(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject2(value)) return Object.keys(value).length > 0;
  return false;
}
function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}\u2026` : message;
}

// src/adapters/process-spawn.ts
import { spawn } from "node:child_process";
function appendBounded(current, chunk, maxBytes) {
  if (!(maxBytes > 0)) return { value: current.value + chunk, truncated: current.truncated };
  const remaining = maxBytes - Buffer.byteLength(current.value, "utf8");
  if (remaining <= 0) return chunk ? { value: current.value, truncated: true } : current;
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.length <= remaining) {
    return { value: current.value + chunk, truncated: current.truncated };
  }
  return {
    value: current.value + bytes.subarray(0, remaining).toString("utf8"),
    truncated: true
  };
}
function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
var terminateProcessTree = async (pid, options = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`A positive integer PID is required, got: ${pid}`);
  }
  if (process.platform === "win32") {
    const result = await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], {
      timeoutMs: 15e3
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `taskkill exited with code ${String(result.code)}`
      );
    }
    if (!await waitForPidExit(pid, options.killWaitMs ?? 2e3)) {
      throw new Error(`Process tree ${pid} still running after taskkill reported success`);
    }
    return { pid, signal: "SIGKILL", verified: true };
  }
  signalProcessTree(pid, "SIGTERM");
  if (await waitForProcessTreeExit(pid, options.graceMs ?? 500)) {
    return { pid, signal: "SIGTERM", verified: true };
  }
  signalProcessTree(pid, "SIGKILL");
  if (!await waitForProcessTreeExit(pid, options.killWaitMs ?? 2e3)) {
    throw new Error(`Process tree ${pid} did not exit after SIGKILL`);
  }
  return { pid, signal: "SIGKILL", verified: true };
};
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = { value: "", truncated: false };
    let stderr = { value: "", truncated: false };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, options.maxOutputBytes ?? 1e6);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, options.maxOutputBytes ?? 1e6);
    });
    let timedOut = false;
    const timer = options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, options.timeoutMs) : null;
    timer?.unref();
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? null : code,
        signal: timedOut ? "SIGKILL" : signal,
        stdout: stdout.value,
        stderr: stderr.value
      });
    });
  });
}
function signalProcessTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (inner) {
        if (inner.code !== "ESRCH") throw inner;
      }
    } else {
      throw error;
    }
  }
}
function isProcessTreeRunning(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return isProcessRunning(pid);
    throw error;
  }
}
async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await sleep(20);
  }
  return !isProcessRunning(pid);
}
async function waitForProcessTreeExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeRunning(pid) && Date.now() < deadline) {
    await sleep(20);
  }
  return !isProcessTreeRunning(pid);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/runtime/child-env.ts
var WINDOWS_OS_ENV = /* @__PURE__ */ new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS"
]);
var POSIX_OS_ENV = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME"
]);
function createMinimalOsEnv(source) {
  const allowed = process.platform === "win32" ? WINDOWS_OS_ENV : POSIX_OS_ENV;
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && value !== void 0) env[key] = value;
  }
  return env;
}

// src/runtime/account-provider.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import path2 from "node:path";
function buildAccountProviderPayload(config) {
  const table = readJson(config.providerBuiltinConfigFile);
  const providerRules = readProviderRules(table).filter(isRecord).map((rule) => rule).filter((rule) => rule.config?.access?.type === "zhipu-account" && typeof rule.providerId === "string");
  if (!providerRules.length) return null;
  const dataDir = zcodeV2DataDir(config.providerPersonalConfigFile);
  if (!dataDir) return null;
  const credentials = readJson(path2.join(dataDir, "config.json"));
  const credentialProviders = asRecord(credentials?.provider);
  const cache = readJson(path2.join(dataDir, "coding-plan-cache.json"));
  const cacheItems = asRecord(asRecord(cache?.entryStatus).items);
  const providers = {};
  const states = {};
  for (const rule of providerRules) {
    const providerId = rule.providerId;
    const legacyId = configProviderId(providerId, rule);
    const cacheStatus = asRecord(cacheItems[legacyId]).status;
    const legacyConfig = asRecord(credentialProviders[legacyId]);
    const options = asRecord(legacyConfig.options);
    const entitled = cacheStatus === "available" || legacyConfig.enabled === true && typeof options.apiKey === "string" && options.apiKey.trim().length > 0;
    providers[providerId] = {
      ...Array.isArray(rule.config?.builtinModelIds) ? { builtinModelIds: rule.config.builtinModelIds } : {},
      access: { type: "zhipu-account", entitled }
    };
    states[providerId] = {
      availability: entitled ? "available" : "unavailable",
      entitled,
      current: entitled
    };
  }
  const revision = typeof table?.revision === "number" ? table.revision : 0;
  const resolvedBuiltinPath = path2.resolve(config.providerBuiltinConfigFile);
  return {
    revision: `account:codex-zcode-bridge:${Date.now()}`,
    basedOnZCodeBuiltinRevision: `zcode-builtin:${revision}:${createHash("sha256").update(resolvedBuiltinPath).digest("hex")}`,
    providers,
    states
  };
}
function accountProviderId(providerId, config) {
  if (providerId.startsWith("account:")) return providerId;
  const table = readJson(config.providerBuiltinConfigFile);
  for (const rawRule of readProviderRules(table)) {
    if (!isRecord(rawRule)) continue;
    const rule = rawRule;
    if (!providerId.startsWith("builtin:") && rule.providerId === providerId && rule.config?.access?.type === "zhipu-account") {
      return `account:${providerId}`;
    }
    if (typeof rule.providerId === "string" && configProviderId(rule.providerId, rule) === providerId) {
      return rule.providerId;
    }
  }
  return providerId;
}
function runtimeAuthReply(providerId, config) {
  const unavailable = {
    headersApplied: false,
    errorMessage: "Start Plan requires a ZCode desktop captcha session; this headless app-server bridge cannot provide it."
  };
  if (!providerId?.startsWith("account:")) return unavailable;
  const table = readJson(config.providerBuiltinConfigFile);
  const rule = readProviderRules(table).find(
    (candidate) => isRecord(candidate) && candidate.providerId === providerId
  );
  if (rule?.config?.access?.mode !== "individual-coding-plan") return unavailable;
  const legacyId = configProviderId(providerId, rule);
  const dataDir = zcodeV2DataDir(config.providerPersonalConfigFile);
  if (!dataDir) return unavailable;
  const credentials = readJson(path2.join(dataDir, "config.json"));
  const cache = readJson(path2.join(dataDir, "coding-plan-cache.json"));
  const status = asRecord(asRecord(asRecord(cache?.entryStatus).items)[legacyId]).status;
  const provider = asRecord(asRecord(credentials?.provider)[legacyId]);
  const options = asRecord(provider.options);
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  if (!apiKey || status !== "available" && provider.enabled !== true) return unavailable;
  return { headersApplied: true, requestAuth: { apiKey } };
}
function zcodeDataBaseDir(personalProviderConfigFile) {
  const dataDir = zcodeV2DataDir(personalProviderConfigFile);
  return dataDir ? path2.dirname(path2.dirname(dataDir)) : null;
}
function zcodeTasksIndexPath(personalProviderConfigFile) {
  const dataDir = zcodeV2DataDir(personalProviderConfigFile);
  return dataDir ? path2.join(dataDir, "tasks-index.sqlite") : null;
}
function zcodeV2DataDir(personalProviderConfigFile) {
  const absolute = path2.resolve(personalProviderConfigFile);
  if (path2.basename(absolute).toLowerCase() !== "provider_config.json") return null;
  const v2Dir = path2.dirname(absolute);
  if (path2.basename(v2Dir).toLowerCase() !== "v2") return null;
  const zcodeDir = path2.dirname(v2Dir);
  if (path2.basename(zcodeDir).toLowerCase() !== ".zcode") return null;
  return v2Dir;
}
function configProviderId(providerId, rule) {
  const access = rule.config?.access;
  if (!providerId.startsWith("account:") || !access?.accountType || !access.mode) return providerId;
  const plan = access.mode === "individual-coding-plan" ? "coding-plan" : access.mode;
  return `builtin:${access.accountType}-${plan}`;
}
function readProviderRules(table) {
  const providerConfigRules = asRecord(asRecord(table?.config).providerConfigRules);
  return Array.isArray(providerConfigRules.providerRules) ? providerConfigRules.providerRules : [];
}
function readJson(filePath) {
  try {
    if (!existsSync2(filePath)) return null;
    const value = JSON.parse(readFileSync2(filePath, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
function asRecord(value) {
  return isRecord(value) ? value : {};
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/runtime/session-preferences.ts
var ZCODE_SESSION_MODES = ["plan", "build", "edit", "yolo"];
function resolveSessionPreferences(taskModel, env) {
  const providerId = env["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() ?? "";
  const modelId = env["ZCODE_BRIDGE_DEFAULT_MODEL_ID"]?.trim() ?? "";
  const reasoningLevel = env["ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL"]?.trim() ?? "";
  const configuredMode = env["ZCODE_BRIDGE_MODE"]?.trim() || "yolo";
  if (Boolean(providerId) !== Boolean(modelId)) {
    throw new BridgeError(
      "provider_config_invalid",
      "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID and ZCODE_BRIDGE_DEFAULT_MODEL_ID must be set together"
    );
  }
  if (!isSessionMode(configuredMode)) {
    throw new BridgeError(
      "provider_config_invalid",
      `ZCODE_BRIDGE_MODE must be one of: ${ZCODE_SESSION_MODES.join(", ")}`
    );
  }
  if (reasoningLevel && !taskModel && !providerId) {
    throw new BridgeError(
      "provider_config_invalid",
      "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL requires a default model pair or a per-task model"
    );
  }
  const model = taskModel ? {
    provider_id: taskModel.provider_id.trim(),
    model_id: taskModel.model_id.trim(),
    ...taskModel.reasoning_level?.trim() || reasoningLevel ? { reasoning_level: taskModel.reasoning_level?.trim() || reasoningLevel } : {}
  } : providerId && modelId ? {
    provider_id: providerId,
    model_id: modelId,
    ...reasoningLevel ? { reasoning_level: reasoningLevel } : {}
  } : null;
  if (model && (!model.provider_id || !model.model_id)) {
    throw new BridgeError("provider_config_invalid", "Configured provider and model IDs must not be blank");
  }
  return {
    mode: configuredMode,
    model,
    modelSource: taskModel ? "task" : model ? "user_default" : "zcode_default"
  };
}
function isSessionMode(value) {
  return ZCODE_SESSION_MODES.includes(value);
}

// src/runtime/task-timeout.ts
var DEFAULT_TASK_TIMEOUT_MS = 60 * 60 * 1e3;
var MAX_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1e3;
var MIN_TASK_TIMEOUT_MS = 60 * 1e3;
function resolveTaskTimeout(task, env) {
  if (task.timeout_ms !== void 0) return validateTaskTimeout(task.timeout_ms);
  const raw = env["ZCODE_BRIDGE_TIMEOUT_MS"]?.trim();
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TASK_TIMEOUT_MS || value > MAX_TASK_TIMEOUT_MS) {
    return DEFAULT_TASK_TIMEOUT_MS;
  }
  return value;
}
function validateTaskTimeout(value) {
  if (!Number.isSafeInteger(value) || value < MIN_TASK_TIMEOUT_MS || value > MAX_TASK_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer from ${MIN_TASK_TIMEOUT_MS} to ${MAX_TASK_TIMEOUT_MS}`);
  }
  return value;
}

// src/adapters/task-index-sync.ts
import { existsSync as existsSync3 } from "node:fs";
var databaseSyncPromise = null;
async function loadDatabaseSync() {
  databaseSyncPromise ??= import("node:sqlite").then((module) => module.DatabaseSync).catch(() => null);
  return databaseSyncPromise;
}
async function registerDesktopTask(entry) {
  await withDatabase(entry.databasePath, (database) => {
    requireTaskTable(database);
    const now = Date.now();
    const title = entry.title.trim().slice(0, 80) || entry.bridgeTaskId;
    const metaJson = JSON.stringify({
      taskId: entry.sessionId,
      traceId: entry.bridgeTaskId,
      title,
      titleOverridden: false,
      workspaceKey: entry.workspaceKey,
      workspacePath: entry.workspacePath,
      createdAt: now,
      updatedAt: now,
      mode: entry.mode,
      model: entry.model,
      provider: entry.provider,
      status: "running",
      target: null
    });
    database.prepare(
      "INSERT OR IGNORE INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider, mode, model, created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden, meta_json, searchable_text) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, ?, ?)"
    ).run(
      entry.workspaceKey,
      entry.workspacePath,
      entry.sessionId,
      title,
      "running",
      entry.provider,
      entry.mode,
      entry.model,
      now,
      now,
      metaJson,
      entry.bridgeTaskId
    );
    if (!updateOwnedStatus(database, entry, "running")) {
      throw new Error("Desktop task row already exists and is not owned by this Bridge task");
    }
  });
}
async function updateDesktopTaskStatus(entry, status) {
  await withDatabase(entry.databasePath, (database) => {
    requireTaskTable(database);
    if (!updateOwnedStatus(database, entry, status)) {
      throw new Error("Desktop task row is missing or is not owned by this Bridge task");
    }
  });
}
function updateOwnedStatus(database, entry, status) {
  const row = database.prepare(
    "SELECT meta_json FROM tasks WHERE workspace_key = ? AND task_id = ?"
  ).get(entry.workspaceKey, entry.sessionId);
  if (!row || typeof row.meta_json !== "string") return false;
  let meta;
  try {
    const parsed = JSON.parse(row.meta_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    meta = parsed;
  } catch {
    return false;
  }
  if (meta["traceId"] !== entry.bridgeTaskId || meta["taskId"] !== entry.sessionId) return false;
  const now = Date.now();
  meta["updatedAt"] = now;
  if (status === null) delete meta["status"];
  else meta["status"] = status;
  database.prepare(
    "UPDATE tasks SET task_status = ?, updated_at = ?, meta_json = ? WHERE workspace_key = ? AND task_id = ?"
  ).run(status, now, JSON.stringify(meta), entry.workspaceKey, entry.sessionId);
  return true;
}
function requireTaskTable(database) {
  const columns = new Set(
    database.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name).filter((name) => typeof name === "string")
  );
  const required = [
    "workspace_key",
    "workspace_path",
    "workspace_identity",
    "task_id",
    "title",
    "task_status",
    "provider",
    "mode",
    "model",
    "created_at",
    "updated_at",
    "unread_at",
    "pinned",
    "archived",
    "deleted",
    "title_overridden",
    "meta_json",
    "searchable_text"
  ];
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new Error(`ZCode tasks-index schema is missing columns: ${missing.join(", ")}`);
  }
}
async function withDatabase(databasePath, operation) {
  if (!existsSync3(databasePath)) {
    throw new Error("ZCode Desktop tasks-index database does not exist");
  }
  const DatabaseSync = await loadDatabaseSync();
  if (!DatabaseSync) throw new Error("node:sqlite is unavailable in the Bridge runtime");
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let database = null;
    try {
      database = new DatabaseSync(databasePath, { timeout: 1e3 });
      return operation(database);
    } catch (error) {
      lastError = error;
      if (attempt < 2 && isDatabaseBusy(error)) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      throw error;
    } finally {
      database?.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ZCode tasks-index write failed");
}
function isDatabaseBusy(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /database is (busy|locked)/i.test(message);
}

// src/adapters/zcode-app-server-adapter.ts
var RPC_TIMEOUT_MS = 3e4;
var MAX_CAPTURE_CHARS = 2e6;
var ZCodeAppServerAdapter = class {
  #resolver;
  #onEvent;
  #timeoutMs;
  #childEnvBase;
  #now;
  #resolveInteraction;
  #runs = /* @__PURE__ */ new Map();
  #workspaceByTask = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.#resolver = options.resolver ?? new NodeRuntimeResolver();
    this.#onEvent = options.onEvent ?? (() => void 0);
    this.#timeoutMs = options.timeoutMs ?? null;
    this.#childEnvBase = options.childEnvBase ?? process.env;
    this.#now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.#resolveInteraction = options.resolveInteraction;
  }
  async startTask(input) {
    return this.#launch(input.task, input.workspace, input.attempt, buildTaskPrompt(input.task), null);
  }
  async continueTask(input) {
    const priorWorkspace = this.#workspaceByTask.get(input.task.task_id);
    if (priorWorkspace !== void 0 && priorWorkspace !== input.workspace.canonicalPath) {
      throw new Error(`continuation workspace mismatch for task ${input.task.task_id}`);
    }
    return this.#launch(
      input.task,
      input.workspace,
      input.attempt,
      buildContinuePrompt({
        task: input.task,
        feedback: input.feedback,
        additionalRequirements: input.additionalRequirements,
        previousSessionId: input.previousSessionId,
        previousResult: input.previousResult
      }),
      input.previousSessionId
    );
  }
  async getStatus(handle) {
    const entry = this.#require(handle, "getStatus");
    return {
      state: entry.finished ? "exited" : entry.child ? "running" : "starting",
      workerPid: handle.workerPid,
      zcodePid: entry.child?.pid ?? null,
      exitCode: entry.outcome?.exitCode ?? null,
      signal: entry.outcome?.signal ?? null
    };
  }
  async getResult(handle) {
    const entry = this.#require(handle, "getResult");
    if (entry.error) throw entry.error;
    if (entry.outcome) return entry.outcome;
    return entry.runPromise;
  }
  async cancelTask(handle) {
    const entry = this.#require(handle, "cancelTask");
    if (entry.finished) return;
    entry.cancelRequested = true;
    const pid = entry.child?.pid;
    if (pid) await terminateProcessTree(pid);
  }
  async #launch(task, workspace, attempt, prompt, resumeSessionId) {
    const handle = {
      taskId: task.task_id,
      attempt,
      workerPid: process.pid,
      zcodePid: null,
      startedAt: this.#now().toISOString()
    };
    let resolveTurn;
    let rejectTurn;
    const turn = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    void turn.catch(() => void 0);
    const entry = {
      handle,
      child: null,
      client: null,
      sessionId: resumeSessionId,
      finished: false,
      timedOut: false,
      cancelRequested: false,
      outcome: null,
      error: null,
      runPromise: Promise.resolve(null),
      resolveTurn,
      rejectTurn,
      onEvent: this.#onEvent,
      textOutputStarted: false,
      selectedModel: null,
      lastEventSeq: 0,
      interactions: /* @__PURE__ */ new Map()
    };
    this.#runs.set(handle, entry);
    this.#workspaceByTask.set(task.task_id, workspace.canonicalPath);
    entry.runPromise = this.#execute(entry, task, workspace, prompt, resumeSessionId, turn);
    void entry.runPromise.then(
      (outcome) => {
        entry.outcome = outcome;
        entry.finished = true;
      },
      (error) => {
        entry.error = error;
        entry.finished = true;
      }
    );
    return handle;
  }
  async #execute(entry, task, workspace, prompt, resumeSessionId, turn) {
    const startedAt = this.#now();
    const projectPath = workspace.sourcePath ?? workspace.canonicalPath;
    let timer;
    let warningTimer;
    let desktopTask = null;
    try {
      const runtimeEnv = loadPersistedRuntimeEnvironment(this.#childEnvBase);
      const timeoutMs = this.#timeoutMs ?? resolveTaskTimeout(task, runtimeEnv);
      const config = await this.#resolver.resolve();
      const preferences = resolveSessionPreferences(task.model, runtimeEnv);
      const childEnv = this.#buildChildEnv(config, runtimeEnv);
      entry.onEvent({ type: "zcode_starting", summary: "Starting ZCode streaming runtime" });
      const client = this.#startAppServer(config, workspace.canonicalPath, childEnv, entry);
      entry.client = client;
      entry.child = client.child;
      timer = setTimeout(() => {
        entry.timedOut = true;
        const pid = entry.child?.pid;
        if (pid) void terminateProcessTree(pid).catch(() => void 0);
        entry.rejectTurn(new Error(`ZCode run exceeded ${timeoutMs}ms wall-clock budget`));
      }, timeoutMs);
      timer.unref();
      warningTimer = setTimeout(() => {
        entry.onEvent({
          type: "timeout_warning",
          summary: `Task is approaching its ${timeoutMs}ms execution limit`,
          details: { timeout_ms: timeoutMs, remaining_ms: Math.min(3e5, Math.floor(timeoutMs / 2)) }
        });
      }, Math.max(15e3, timeoutMs - Math.min(3e5, Math.floor(timeoutMs / 2))));
      warningTimer.unref();
      const accountProviderPayload = buildAccountProviderPayload(config);
      if (accountProviderPayload) {
        try {
          const syncResult = asRecord2(await client.request(
            "provider/updateAccountConfig",
            accountProviderPayload
          ));
          entry.onEvent({
            type: "account_provider_sync",
            summary: `Synchronized ${Object.keys(accountProviderPayload.providers).length} ZCode account provider(s)`,
            details: {
              provider_count: Object.keys(accountProviderPayload.providers).length,
              entitled_provider_count: Object.values(accountProviderPayload.states).filter((state) => state.entitled).length,
              runtime_status: typeof syncResult.status === "string" ? syncResult.status : "accepted"
            }
          });
        } catch (error) {
          entry.onEvent({
            type: "account_provider_sync_failed",
            summary: error instanceof Error ? error.message : "ZCode account provider synchronization failed"
          });
        }
      }
      let snapshot;
      if (resumeSessionId) {
        snapshot = asRecord2(await client.request("session/resume", {
          sessionId: resumeSessionId,
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: projectPath }
        }));
        const returnedId = nestedString(snapshot, ["session", "sessionId"]);
        if (returnedId && returnedId !== resumeSessionId) {
          throw new Error(`resume session mismatch: requested ${resumeSessionId}, runtime returned ${returnedId}`);
        }
        await client.request("session/setMode", { sessionId: resumeSessionId, mode: preferences.mode });
      } else {
        snapshot = asRecord2(await client.request("session/create", {
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: projectPath },
          mode: preferences.mode,
          persistence: "immediate"
        }));
      }
      const sessionId = nestedString(snapshot, ["session", "sessionId"]);
      if (!sessionId) throw new Error("ZCode app-server session snapshot did not contain session.sessionId");
      entry.sessionId = sessionId;
      if (preferences.model) {
        const requestedProviderId = accountProviderId(preferences.model.provider_id, config);
        const requested = `${requestedProviderId}/${preferences.model.model_id}`;
        const availableModels = readAvailableModels(snapshot);
        const isAvailable = availableModels.some(
          (model2) => model2.providerId === requestedProviderId && model2.modelId === preferences.model.model_id
        );
        entry.onEvent({
          type: "model_catalog",
          summary: `ZCode runtime advertised ${availableModels.length} selectable model${availableModels.length === 1 ? "" : "s"}`,
          details: {
            session_id: sessionId,
            project_path: projectPath,
            execution_path: workspace.canonicalPath,
            requested_model: { provider_id: requestedProviderId, model_id: preferences.model.model_id },
            available_models: availableModels.slice(0, 100),
            truncated: availableModels.length > 100
          }
        });
        if (!isAvailable) {
          const available = availableModels.length ? availableModels.slice(0, 30).map((model2) => `${model2.providerId}/${model2.modelId}`).join(", ") : "none";
          throw new BridgeError(
            "provider_config_invalid",
            `Requested ZCode model ${requested} is not present in the app-server model registry. The runtime advertised ${availableModels.length} selectable model(s): ${available}. Account-backed models must be synchronized into the app-server before they can be selected.`
          );
        }
        const current = readSelectedModelSelection(snapshot);
        const reasoningLevel = preferences.model.reasoning_level ?? readModelReasoningDefault(
          snapshot,
          requestedProviderId,
          preferences.model.model_id
        );
        const modelState = current?.providerId === requestedProviderId && current.modelId === preferences.model.model_id && !preferences.model.reasoning_level ? snapshot : asRecord2(await client.request("session/setModel", {
          sessionId,
          model: {
            providerId: requestedProviderId,
            modelId: preferences.model.model_id,
            ...reasoningLevel ? { options: { reasoningLevel } } : {}
          },
          // Keep the override scoped to this session; do not change the
          // user's project-wide last-used model.
          persistAsWorkspaceLastUsed: false
        }));
        const selected = readSelectedModelSelection(modelState);
        if (!selected) {
          throw new Error(`ZCode accepted model override ${requested} but did not report the selected model`);
        }
        if (selected.providerId !== requestedProviderId || selected.modelId !== preferences.model.model_id) {
          throw new Error(
            `ZCode model override mismatch: requested ${requested}, runtime selected ${selected.providerId}/${selected.modelId}`
          );
        }
        snapshot = modelState;
        entry.selectedModel = readSelectedModel(modelState) ?? requested;
        entry.onEvent({
          type: "model_selected",
          summary: `ZCode selected requested model ${entry.selectedModel}`,
          details: {
            requested_model: requested,
            selected_model: entry.selectedModel,
            provider_id: selected.providerId,
            model_id: selected.modelId,
            model_source: preferences.modelSource,
            ...reasoningLevel ? { reasoning_level: reasoningLevel } : {}
          }
        });
      }
      const model = readSelectedModel(snapshot);
      entry.selectedModel = entry.selectedModel ?? model;
      if (!entry.selectedModel) {
        const availableModels = readAvailableModels(snapshot);
        entry.onEvent({
          type: "model_unresolved",
          summary: "ZCode runtime did not report a selected model; task was stopped before sending the prompt",
          details: { session_id: sessionId, available_model_count: availableModels.length }
        });
        throw new BridgeError(
          "provider_config_invalid",
          "ZCode runtime did not report its selected model; refusing to start a task whose model cannot be identified."
        );
      }
      entry.onEvent({
        type: "session_ready",
        summary: `ZCode session ready; selected model ${entry.selectedModel}`,
        details: {
          session_id: sessionId,
          project_path: projectPath,
          execution_path: workspace.canonicalPath,
          ...workspace.mode === "worktree" ? { worktree_path: workspace.canonicalPath } : {},
          execution_mode: preferences.mode,
          model_source: preferences.modelSource,
          ...entry.selectedModel ? { selected_model: entry.selectedModel } : {}
        }
      });
      const indexPath = zcodeTasksIndexPath(config.providerPersonalConfigFile);
      if (indexPath) {
        const selected = readSelectedModelSelection(snapshot);
        desktopTask = {
          databasePath: indexPath,
          workspaceKey: projectPath,
          workspacePath: workspace.canonicalPath,
          sessionId,
          bridgeTaskId: task.task_id,
          title: task.task_id,
          model: selected ? `${selected.providerId}/${selected.modelId}` : null,
          provider: "glm",
          mode: preferences.mode
        };
        try {
          await registerDesktopTask(desktopTask);
          entry.onEvent({
            type: "desktop_task_registered",
            summary: "ZCode session registered in Desktop task index; refresh the task list to see it",
            details: { session_id: sessionId, project_path: projectPath, execution_path: workspace.canonicalPath }
          });
        } catch (error) {
          reportDesktopIndexIssue(entry.onEvent, error);
          desktopTask = null;
        }
      }
      const runtimeSeq = nestedNumber(snapshot, ["runtime", "eventSeq"]) ?? 0;
      entry.lastEventSeq = runtimeSeq;
      await client.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
        afterSeq: runtimeSeq
      });
      await client.request("session/send", { sessionId, content: prompt });
      entry.onEvent({ type: "turn_started", summary: "ZCode accepted the task and started a turn" });
      const turnResult = await turn;
      const desktopStatus = turnResult.resultType === "cancelled" ? null : turnResult.resultType && turnResult.resultType !== "success" ? "error" : "completed";
      await syncDesktopStatus(desktopTask, desktopStatus, entry.onEvent);
      await client.close().catch(() => void 0);
      entry.child = null;
      if (turnResult.resultType && turnResult.resultType !== "success") {
        return {
          attempts: 1,
          cancelled: turnResult.resultType === "cancelled",
          stdout: turnResult.response,
          stderr: client.stderr,
          exitCode: 1,
          signal: null,
          sessionId,
          response: turnResult.response,
          usage: turnResult.usage,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          agentReport: null,
          reportCandidate: null,
          reportError: `ZCode turn ended with resultType ${turnResult.resultType}`,
          errorCode: turnResult.resultType === "cancelled" ? "cancelled" : "zcode_nonzero_exit"
        };
      }
      const parsed = parseAgentReport(turnResult.response);
      const stdout = turnResult.response;
      const base = {
        attempts: 1,
        cancelled: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdout,
        stderr: client.stderr,
        exitCode: 0,
        signal: null,
        sessionId,
        response: turnResult.response,
        usage: turnResult.usage,
        timedOut: false,
        reportCandidate: parsed.candidate
      };
      if (!parsed.report) {
        return {
          ...base,
          agentReport: null,
          reportCandidate: parsed.candidate,
          reportError: parsed.error,
          errorCode: "invalid_agent_report"
        };
      }
      entry.onEvent({
        type: "report_ready",
        summary: "ZCode produced its structured execution report",
        details: { needs_master_decision: parsed.report.needs_master_decision }
      });
      return { ...base, agentReport: parsed.report, reportCandidate: parsed.report, reportError: null, errorCode: null };
    } catch (error) {
      await syncDesktopStatus(desktopTask, entry.cancelRequested ? null : "error", entry.onEvent);
      if (entry.client) await entry.client.close().catch(() => void 0);
      else if (entry.child?.pid) await terminateProcessTree(entry.child.pid).catch(() => void 0);
      entry.child = null;
      const baseMessage = error instanceof Error ? error.message : String(error);
      const runtimeStderr = entry.client?.stderr.trim();
      const message = runtimeStderr ? baseMessage + "; app-server stderr: " + runtimeStderr.slice(0, 1500) : baseMessage;
      const code = entry.timedOut ? "timeout" : entry.cancelRequested ? "cancelled" : "zcode_nonzero_exit";
      entry.onEvent({ type: "error", summary: message.slice(0, 1500), details: { error_code: code } });
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(code, message);
    } finally {
      if (timer) clearTimeout(timer);
      if (warningTimer) clearTimeout(warningTimer);
      entry.finished = true;
      void startedAt;
    }
  }
  #startAppServer(config, cwd, env, entry) {
    const child = spawn2(config.nodeExecutable, [config.zcodeEntrypoint, "app-server", "--stdio"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    let stdoutBuffer = "";
    let rpcId = 0;
    let closed = false;
    const pending = /* @__PURE__ */ new Map();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_CAPTURE_CHARS) stdoutBuffer = stdoutBuffer.slice(-MAX_CAPTURE_CHARS);
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          this.#handleMessage(message, entry, pending, config, (reply) => {
            child.stdin.write(`${JSON.stringify(reply)}
`);
          });
        } catch (error) {
          if (error instanceof SyntaxError) {
            entry.rejectTurn(new Error(`invalid ZCode app-server protocol line: ${line.slice(0, 500)}`));
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64e3) stderr += chunk.slice(0, 64e3 - stderr.length);
    });
    child.on("error", (error) => entry.rejectTurn(error));
    child.on("close", (code, signal) => {
      closed = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error(`ZCode app-server exited (${String(code)}${signal ? `, ${signal}` : ""})`));
      }
      pending.clear();
      if (!entry.finished && !entry.timedOut && !entry.cancelRequested) {
        entry.rejectTurn(new Error(`ZCode app-server exited before turn completion (${String(code)})`));
      }
    });
    const request = (method, params) => {
      if (closed) return Promise.reject(new Error(`ZCode app-server is closed before ${method}`));
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ZCode app-server request timed out: ${method}`));
        }, RPC_TIMEOUT_MS);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}
`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
      });
    };
    const close = async () => {
      if (closed) return;
      child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), 1e3);
        timer.unref();
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!closed && child.pid) await terminateProcessTree(child.pid).catch(() => void 0);
    };
    return { child, request, close, get stderr() {
      return stderr;
    } };
  }
  #handleMessage(message, entry, pending, config, write) {
    if (message.method === "session/requestRuntimePreferences") {
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        write({
          id,
          result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false
          }
        });
      }
      return;
    }
    if (message.method === "interaction/requestProviderRuntimeHeaders") {
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        const params = asRecord2(message.params);
        const selection = asRecord2(params.modelSelection);
        const providerId = typeof selection.providerId === "string" ? selection.providerId : typeof params.providerId === "string" ? params.providerId : void 0;
        write({ id, result: runtimeAuthReply(providerId, config) });
      }
      return;
    }
    if (message.method === "interaction/requestPermission" || message.method === "interaction/requestUserInput") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        this.#handleInteractionRequest(message, entry, write);
      }
      return;
    }
    if (message.id !== void 0 && message.method === void 0) {
      const id = message.id;
      const call = pending.get(id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const error = message.error;
        call.reject(new Error(typeof error.message === "string" ? error.message : "ZCode app-server request failed"));
      } else {
        call.resolve(message.result);
      }
      return;
    }
    if (message.method === "session/event") {
      const params = asRecord2(message.params);
      if (typeof params.seq === "number") entry.lastEventSeq = params.seq;
      const type = typeof params.type === "string" ? params.type : "";
      const payload = asRecord2(params.payload);
      this.#publishSessionEvent(type, payload, entry);
      if (type === "turn.completed") {
        entry.resolveTurn({
          response: typeof payload.response === "string" ? payload.response : "",
          usage: isRecord2(payload.usage) ? payload.usage : null,
          resultType: typeof payload.resultType === "string" ? payload.resultType : null
        });
      } else if (type === "turn.failed") {
        const problem = asRecord2(payload.error);
        entry.rejectTurn(new Error(typeof problem.message === "string" ? problem.message : "ZCode turn failed"));
      }
      return;
    }
    if (message.method === "state.updated") {
      const params = asRecord2(message.params);
      const patch = asRecord2(params.patch);
      const state = typeof patch.status === "string" ? patch.status : void 0;
      if (state) entry.onEvent({ type: "runtime_state", summary: `ZCode runtime state: ${state}` });
      return;
    }
    if (message.id !== void 0 && typeof message.method === "string") {
      write({ id: message.id, error: { code: -32601, message: `Unsupported ZCode app-server request: ${message.method}` } });
    }
  }
  #handleInteractionRequest(message, entry, write) {
    const rpcId = message.id;
    const method = message.method;
    const params = asRecord2(message.params);
    const suppliedId = typeof params.requestId === "string" ? params.requestId : "";
    const requestId = suppliedId || `rpc-${String(rpcId)}`;
    const paramsSignature = stableSerialize(params);
    let pending = entry.interactions.get(requestId);
    if (pending) {
      if (pending.method !== method || pending.paramsSignature !== paramsSignature) {
        write({ id: rpcId, result: interactionDecline(method, "Conflicting ZCode interaction request id") });
        entry.onEvent({
          type: "interaction_request_conflict",
          summary: "ZCode reused an interaction request id with different request data; the conflicting request was declined",
          details: { request_id: requestId, method }
        });
        return;
      }
      if (!pending.requestIds.includes(rpcId)) pending.requestIds.push(rpcId);
      if (pending.response) write({ id: rpcId, result: pending.response });
      return;
    }
    pending = { requestIds: [rpcId], method, paramsSignature, resolving: true };
    entry.interactions.set(requestId, pending);
    const request = { request_id: requestId, method, params };
    const fallback = interactionDecline(method, "Bridge interaction reply is unavailable");
    void (async () => {
      let response = fallback;
      try {
        if (this.#resolveInteraction) response = await this.#resolveInteraction(request);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        entry.onEvent({
          type: "interaction_reply_failed",
          summary: `Could not deliver Codex's response to ZCode: ${messageText}`.slice(0, 1500),
          details: { request_id: requestId, method }
        });
      }
      pending.response = response;
      pending.resolving = false;
      for (const id of pending.requestIds) write({ id, result: response });
      entry.onEvent({
        type: "interaction_replied",
        summary: `Codex replied to ZCode ${method === "interaction/requestPermission" ? "permission request" : "user input request"}`,
        details: { request_id: requestId, method }
      });
      while (entry.interactions.size > 128) {
        const oldest = entry.interactions.keys().next().value;
        if (!oldest || entry.interactions.get(oldest)?.resolving) break;
        entry.interactions.delete(oldest);
      }
    })();
  }
  #publishSessionEvent(type, payload, entry) {
    if (type === "turn.started") {
      entry.onEvent({
        type: "turn_started",
        summary: `ZCode turn started${entry.selectedModel ? ` with selected model ${entry.selectedModel}` : ""}`
      });
    } else if (type === "model.streaming") {
      const kind = payload.kind;
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if ((kind === "text_start" || kind === "text_delta") && !entry.textOutputStarted) {
        entry.textOutputStarted = true;
        entry.onEvent({
          type: "model_output_started",
          summary: `ZCode began returning visible model output${entry.selectedModel ? ` (${entry.selectedModel})` : ""}`,
          details: entry.selectedModel ? { selected_model: entry.selectedModel } : void 0
        });
      }
      if (kind === "text_delta" && delta) {
        entry.onEvent({ type: "model_output", summary: delta });
      } else if (kind === "tool_call") {
        const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
        const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : void 0;
        entry.onEvent({
          type: "model_tool_call",
          summary: `Model requested tool ${name}`,
          details: { tool_name: name, ...callId ? { tool_call_id: callId } : {} }
        });
      }
    } else if (type === "tool.updated") {
      const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
      const state = typeof payload.kind === "string" ? payload.kind : "updated";
      const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : void 0;
      entry.onEvent({
        type: "tool_status",
        summary: `${name}: ${state}`,
        details: { tool_name: name, state, ...callId ? { tool_call_id: callId } : {} }
      });
    } else if (type === "turn.completed") {
      entry.onEvent({
        type: "turn_completed",
        summary: "ZCode turn completed",
        details: {
          ...typeof payload.tokenCount === "number" ? { token_count: payload.tokenCount } : {},
          ...typeof payload.toolCallCount === "number" ? { tool_call_count: payload.toolCallCount } : {},
          ...isRecord2(payload.usage) ? { usage: payload.usage } : {}
        }
      });
    } else if (type === "turn.failed") {
      const problem = asRecord2(payload.error);
      entry.onEvent({
        type: "turn_failed",
        summary: typeof problem.message === "string" ? problem.message : "ZCode turn failed"
      });
    }
  }
  #buildChildEnv(config, source = this.#childEnvBase) {
    const env = createMinimalOsEnv(source);
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
    if (source.ZCODE_HOME) env.ZCODE_HOME = source.ZCODE_HOME;
    const dataBaseDir = zcodeDataBaseDir(config.providerPersonalConfigFile);
    if (dataBaseDir) env.ZCODE_DATA_BASE_DIR = dataBaseDir;
    return env;
  }
  #require(handle, method) {
    const entry = this.#runs.get(handle);
    if (!entry) throw new Error(`${method}: unknown agent handle (task ${handle.taskId})`);
    return entry;
  }
};
function interactionDecline(method, reason) {
  return method === "interaction/requestPermission" ? { decision: "deny", reason } : { action: "decline", reason };
}
function readSelectedModel(snapshot) {
  const settings = asRecord2(snapshot.settings);
  const modelSettings = asRecord2(settings.model);
  const current = asRecord2(modelSettings.current);
  const modelId = typeof current.modelId === "string" ? current.modelId : null;
  const providerId = typeof current.providerId === "string" ? current.providerId : null;
  if (!modelId) return null;
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  const match = available.find((entry) => {
    const ref = asRecord2(asRecord2(entry).ref);
    return ref.modelId === modelId && (providerId === null || ref.providerId === providerId);
  });
  const label = match && typeof asRecord2(match).label === "string" ? asRecord2(match).label : modelId;
  return providerId ? `${label} (${providerId}/${modelId})` : label;
}
function readSelectedModelSelection(snapshot) {
  const settings = asRecord2(snapshot.settings);
  const modelSettings = asRecord2(settings.model);
  const current = asRecord2(modelSettings.current);
  if (typeof current.providerId !== "string" || typeof current.modelId !== "string") return null;
  return { providerId: current.providerId, modelId: current.modelId };
}
function readAvailableModels(snapshot) {
  const settings = asRecord2(snapshot.settings);
  const modelSettings = asRecord2(settings.model);
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  const refs = /* @__PURE__ */ new Map();
  for (const entry of available) {
    const ref = asRecord2(asRecord2(entry).ref);
    if (typeof ref.providerId !== "string" || typeof ref.modelId !== "string") continue;
    const key = `${ref.providerId}\0${ref.modelId}`;
    refs.set(key, { providerId: ref.providerId, modelId: ref.modelId });
  }
  return [...refs.values()];
}
function readModelReasoningDefault(snapshot, providerId, modelId) {
  const settings = asRecord2(snapshot.settings);
  const modelSettings = asRecord2(settings.model);
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  for (const item of available) {
    const entry = asRecord2(item);
    const ref = asRecord2(entry.ref);
    if (ref.providerId !== providerId || ref.modelId !== modelId) continue;
    const reasoning = asRecord2(entry.reasoning);
    if (typeof reasoning.defaultLevel === "string" && reasoning.defaultLevel.trim()) {
      return reasoning.defaultLevel;
    }
    const levels = Array.isArray(reasoning.levels) ? reasoning.levels : [];
    if (levels.length === 1) {
      const value = asRecord2(levels[0]).value;
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}
function nestedString(record, path4) {
  let value = record;
  for (const part of path4) value = asRecord2(value)[part];
  return typeof value === "string" ? value : null;
}
function nestedNumber(record, path4) {
  let value = record;
  for (const part of path4) value = asRecord2(value)[part];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asRecord2(value) {
  return isRecord2(value) ? value : {};
}
async function syncDesktopStatus(entry, status, onEvent) {
  if (!entry) return;
  try {
    await updateDesktopTaskStatus(entry, status);
  } catch (error) {
    reportDesktopIndexIssue(onEvent, error);
  }
}
function reportDesktopIndexIssue(onEvent, error) {
  const message = error instanceof Error ? error.message : String(error);
  onEvent({
    type: "desktop_task_index_warning",
    summary: `ZCode Desktop task index could not be updated: ${message.slice(0, 500)}`
  });
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord2(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

// src/manager/normalize.ts
function buildTaskResult(input) {
  const { task, attempt, startedAt, finishedAt, outcome } = input;
  const base = {
    task_id: task.task_id,
    attempt,
    started_at: startedAt,
    finished_at: finishedAt,
    zcode_output: outcome?.response ?? "",
    exit_code: outcome?.exitCode ?? null,
    session_id: outcome?.sessionId ?? null
  };
  if (input.cancelled) {
    return {
      ...base,
      status: "cancelled",
      summary: input.failure?.message ?? "cancelled by request",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false
    };
  }
  const failure = input.failure ?? (outcome ? null : { code: "worker_lost", message: "no adapter outcome was recorded" });
  if (failure || !outcome) {
    const resolved = failure ?? { code: "worker_lost", message: "no adapter outcome was recorded" };
    return {
      ...base,
      status: "failed",
      summary: truncate(`${resolved.code}: ${resolved.message}`, 2e3),
      files_changed: [],
      tests: [],
      issues: [truncate(resolved.message, 2e3)],
      needs_master_decision: true,
      error_code: resolved.code
    };
  }
  if (outcome.errorCode || outcome.reportError) {
    const code = outcome.errorCode ?? "invalid_agent_report";
    const message = outcome.reportError ?? "the subordinate report was invalid";
    return {
      ...base,
      status: "failed",
      summary: truncate(`${code}: ${message}`, 2e3),
      files_changed: [],
      tests: [],
      issues: [truncate(message, 2e3)],
      needs_master_decision: true,
      error_code: code,
      ...outcome.reportCandidate ? { report_candidate: outcome.reportCandidate } : {}
    };
  }
  const report = outcome.agentReport;
  if (!report) {
    return {
      ...base,
      status: "failed",
      summary: "the adapter reported success without a normalized report",
      files_changed: [],
      tests: [],
      issues: ["missing AgentReport despite a clean exit"],
      needs_master_decision: true,
      error_code: "invalid_agent_report"
    };
  }
  return {
    ...base,
    status: report.needs_master_decision ? "waiting_for_master" : "completed",
    summary: report.summary,
    files_changed: report.files_changed,
    tests: report.tests,
    issues: report.issues,
    needs_master_decision: report.needs_master_decision
  };
}
function truncate(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\u2026[truncated]`;
}

// src/store/task-store.ts
import { appendFileSync, chmodSync, closeSync, existsSync as existsSync4, mkdirSync, openSync, readFileSync as readFileSync3, readSync, readdirSync, renameSync, rmSync, rmdirSync, statSync as statSync2, writeFileSync } from "node:fs";
import { createHash as createHash2, randomUUID } from "node:crypto";
import path3 from "node:path";
import { StringDecoder } from "node:string_decoder";
var TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
var MAX_CRITICAL_EVENT_RESERVE_BYTES = 256 * 1024;
var CRITICAL_EVENT_TYPES = /* @__PURE__ */ new Set([
  "error",
  "task_finished",
  "turn_completed",
  "report_ready",
  "session_ready",
  "turn_started",
  "worker_started",
  "workspace_ready",
  "timeout_warning",
  "model_catalog",
  "account_provider_sync_failed",
  "interaction_requested",
  "interaction_reply_submitted",
  "cancelled",
  "cancel_failed"
]);
var TaskStore = class {
  #dataRoot;
  #tasksRoot;
  #maxLogBytes;
  #maxEventBytes;
  constructor(dataRoot2, options = {}) {
    this.#dataRoot = dataRoot2;
    this.#tasksRoot = path3.join(dataRoot2, ".tasks");
    this.#maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.#maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_LOG_BYTES;
    privateMkdir(this.#tasksRoot);
  }
  get dataRoot() {
    return this.#dataRoot;
  }
  get tasksRoot() {
    return this.#tasksRoot;
  }
  assertValidTaskId(taskId2) {
    if (typeof taskId2 !== "string" || !TASK_ID_PATTERN.test(taskId2)) {
      throw new Error(`invalid task_id (must match ${TASK_ID_PATTERN.source}): ${String(taskId2)}`);
    }
  }
  taskDir(taskId2) {
    this.assertValidTaskId(taskId2);
    return path3.join(this.#tasksRoot, taskId2);
  }
  hasTask(taskId2) {
    try {
      return existsSync4(path3.join(this.taskDir(taskId2), "status.json"));
    } catch {
      return false;
    }
  }
  listTaskIds() {
    if (!existsSync4(this.#tasksRoot)) return [];
    return readdirSync(this.#tasksRoot).filter(
      (entry) => existsSync4(path3.join(this.#tasksRoot, entry, "status.json"))
    );
  }
  createTask(task, createdAt) {
    this.assertValidTaskId(task.task_id);
    const dir = this.taskDir(task.task_id);
    if (existsSync4(path3.join(dir, "task.json"))) {
      throw new Error(`task already exists: ${task.task_id}`);
    }
    privateMkdir(path3.join(dir, "attempts"));
    this.#writeJsonAtomic(path3.join(dir, "task.json"), task);
    const status = {
      task_id: task.task_id,
      status: "queued",
      attempt: 1,
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_session_id: null,
      exit_code: null
    };
    this.#writeJsonAtomic(path3.join(dir, "status.json"), status);
  }
  readTask(taskId2) {
    const file = path3.join(this.taskDir(taskId2), "task.json");
    const parsed = this.#readJson(file);
    return parsed;
  }
  writeWorkspaceRef(taskId2, workspace) {
    this.#writeJsonAtomic(path3.join(this.taskDir(taskId2), "workspace.json"), workspace);
  }
  readWorkspaceRef(taskId2) {
    const file = path3.join(this.taskDir(taskId2), "workspace.json");
    if (!existsSync4(file)) return null;
    return this.#readJson(file);
  }
  readStatus(taskId2) {
    const file = path3.join(this.taskDir(taskId2), "status.json");
    const parsed = this.#readJson(file);
    if (typeof parsed?.status !== "string") {
      throw new Error(`corrupt status record: ${file}`);
    }
    return parsed;
  }
  /** Read-merge-write with an updated timestamp; atomic via temp file + rename. */
  writeStatus(taskId2, patch) {
    const current = this.readStatus(taskId2);
    const next = {
      ...current,
      ...patch,
      task_id: current.task_id,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.#writeJsonAtomic(path3.join(this.taskDir(taskId2), "status.json"), next);
    return next;
  }
  readResult(taskId2) {
    const file = path3.join(this.taskDir(taskId2), "result.json");
    if (!existsSync4(file)) return null;
    return this.#readJson(file);
  }
  writeResult(taskId2, result) {
    this.#writeJsonAtomic(path3.join(this.taskDir(taskId2), "result.json"), result);
  }
  /** Moves the current terminal result.json to attempts/<attempt>/result.json. */
  archiveResultToAttempt(taskId2, attempt) {
    const dir = this.taskDir(taskId2);
    const source = path3.join(dir, "result.json");
    if (!existsSync4(source)) return;
    const targetDir = this.attemptDir(taskId2, attempt);
    privateMkdir(targetDir);
    renameSync(source, path3.join(targetDir, "result.json"));
  }
  readArchivedResult(taskId2, attempt) {
    const file = path3.join(this.attemptDir(taskId2, attempt), "result.json");
    if (!existsSync4(file)) return null;
    return this.#readJson(file);
  }
  attemptDir(taskId2, attempt) {
    return path3.join(this.taskDir(taskId2), "attempts", String(attempt));
  }
  writeAttemptFile(taskId2, attempt, fileName, content) {
    const dir = this.attemptDir(taskId2, attempt);
    privateMkdir(dir);
    this.#writeTextAtomic(path3.join(dir, fileName), content);
  }
  writeAttemptMeta(taskId2, attempt, fileName, meta) {
    const dir = this.attemptDir(taskId2, attempt);
    privateMkdir(dir);
    this.#writeJsonAtomic(path3.join(dir, fileName), meta);
  }
  readAttemptMeta(taskId2, attempt, fileName) {
    const file = path3.join(this.attemptDir(taskId2, attempt), fileName);
    if (!existsSync4(file)) return null;
    return this.#readJson(file);
  }
  readAttemptText(taskId2, attempt, fileName) {
    const file = path3.join(this.attemptDir(taskId2, attempt), fileName);
    if (!existsSync4(file)) return null;
    return readFileSync3(file, "utf8");
  }
  /** Append-only, byte-bounded. Returns whether the chunk was truncated. */
  appendLog(taskId2, kind, text) {
    if (!text) return { truncated: false };
    const dir = this.taskDir(taskId2);
    privateMkdir(dir);
    const file = path3.join(dir, `${kind}.log`);
    let currentBytes = 0;
    try {
      currentBytes = statSync2(file).size;
    } catch {
      currentBytes = 0;
    }
    const bytes = Buffer.from(text, "utf8");
    const room = this.#maxLogBytes - currentBytes;
    if (room <= 0) return { truncated: true };
    appendFileSync(file, bytes.length <= room ? bytes : bytes.subarray(0, room), { mode: 384 });
    privateFile(file);
    return { truncated: bytes.length > room };
  }
  readLog(taskId2, kind) {
    const file = path3.join(this.taskDir(taskId2), `${kind}.log`);
    return existsSync4(file) ? readFileSync3(file, "utf8") : "";
  }
  appendEvent(taskId2, type, summary, details, at = (/* @__PURE__ */ new Date()).toISOString()) {
    const dir = this.taskDir(taskId2);
    mkdirSync(dir, { recursive: true });
    const lockDir = path3.join(dir, "events.lock");
    return withEventLock(lockDir, () => {
      const file = path3.join(dir, "events.jsonl");
      const seqFile = path3.join(dir, "events.seq");
      let bytes = 0;
      let previousSeq = 0;
      let needsSeparator = false;
      try {
        const info = statSync2(file);
        bytes = info.size;
        const lastByte = bytes > 0 ? readFileSync3(file).at(-1) : void 0;
        needsSeparator = bytes > 0 && lastByte !== 10;
      } catch {
        bytes = 0;
      }
      try {
        previousSeq = Number.parseInt(readFileSync3(seqFile, "utf8"), 10) || 0;
      } catch {
        previousSeq = readLastEventSeq(file);
      }
      const event = {
        seq: previousSeq + 1,
        at,
        type: type.slice(0, 80),
        summary: summary.slice(0, 2e3),
        ...details && Object.keys(details).length ? { details } : {}
      };
      const line = `${JSON.stringify(event)}
`;
      const lineBytes = Buffer.byteLength(line, "utf8") + (needsSeparator ? 1 : 0);
      const critical = CRITICAL_EVENT_TYPES.has(type);
      const capacity = this.#maxEventBytes + (critical ? MAX_CRITICAL_EVENT_RESERVE_BYTES : 0);
      if (lineBytes > 64e3 || bytes + lineBytes > capacity) return null;
      this.#writeTextAtomic(seqFile, String(event.seq));
      const eventOffset = bytes + (needsSeparator ? 1 : 0);
      appendFileSync(file, `${needsSeparator ? "\n" : ""}${line}`, { encoding: "utf8", mode: 384 });
      privateFile(file);
      if (event.seq % 100 === 0) {
        const index = path3.join(dir, "events.index");
        appendFileSync(index, `${event.seq}	${eventOffset}
`, { encoding: "utf8", mode: 384 });
        privateFile(index);
      }
      return event;
    });
  }
  readEvents(taskId2, afterSeq = 0, limit = 100, view = "raw") {
    const file = path3.join(this.taskDir(taskId2), "events.jsonl");
    if (!existsSync4(file)) return { events: [], nextSeq: afterSeq, hasMore: false, omittedEvents: 0 };
    let offset = 0;
    const indexFile = path3.join(this.taskDir(taskId2), "events.index");
    if (existsSync4(indexFile)) {
      for (const row of readFileSync3(indexFile, "utf8").split(/\r?\n/u)) {
        const [seqText, offsetText] = row.split("	");
        const seq = Number(seqText);
        const candidateOffset = Number(offsetText);
        if (Number.isInteger(seq) && Number.isSafeInteger(candidateOffset) && seq <= afterSeq) offset = candidateOffset;
        if (seq > afterSeq) break;
      }
    }
    const fd = openSync(file, "r");
    const page = [];
    let hasMore = false;
    let position = offset;
    let pending = "";
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (true) {
        const count = readSync(fd, buffer, 0, buffer.length, position);
        if (count <= 0) break;
        position += count;
        const lines = `${pending}${decoder.write(buffer.subarray(0, count))}`.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseProgressEvent(line);
          if (!event || event.seq <= afterSeq) continue;
          if (page.length === limit) {
            hasMore = true;
            break;
          }
          page.push(event);
        }
        if (hasMore) break;
      }
      pending += decoder.end();
      if (!hasMore && pending) {
        const event = parseProgressEvent(pending);
        if (event && event.seq > afterSeq) {
          if (page.length === limit) hasMore = true;
          else page.push(event);
        }
      }
    } finally {
      closeSync(fd);
    }
    let events = page;
    let omittedEvents = 0;
    if (view === "summary") {
      events = [];
      for (const event of page) {
        const previous = events.at(-1);
        if (event.type === "model_output" && previous?.type === "model_output") {
          const combined = previous.summary + event.summary;
          events[events.length - 1] = {
            ...previous,
            seq: event.seq,
            at: event.at,
            summary: combined.length <= 5e3 ? combined : `${combined.slice(0, 4950)}\u2026[output compacted]`
          };
          omittedEvents += 1;
        } else {
          events.push(event);
        }
      }
    }
    return {
      events,
      nextSeq: page.at(-1)?.seq ?? afterSeq,
      hasMore,
      omittedEvents
    };
  }
  writeInteractionRequest(taskId2, request, createdAt = (/* @__PURE__ */ new Date()).toISOString()) {
    const directory = path3.join(this.taskDir(taskId2), "interactions");
    privateMkdir(directory);
    const file = this.interactionFile(taskId2, request.request_id);
    return withEventLock(path3.join(this.taskDir(taskId2), "interactions.lock"), () => {
      if (existsSync4(file)) {
        const record2 = this.#readJson(file);
        if (record2.request_id !== request.request_id || record2.method !== request.method) {
          throw new Error("interaction request id collision");
        }
        return { record: record2, created: false };
      }
      if (Buffer.byteLength(JSON.stringify(request.params), "utf8") > 32e3) {
        throw new Error("ZCode interaction request exceeded the 32 KB persistence limit");
      }
      const record = {
        ...request,
        state: "pending",
        created_at: createdAt
      };
      this.#writeJsonAtomic(file, record);
      return { record, created: true };
    });
  }
  readInteractionRequest(taskId2, requestId) {
    const file = this.interactionFile(taskId2, requestId);
    if (!existsSync4(file)) return null;
    const record = this.#readJson(file);
    if (record.request_id !== requestId) throw new Error("interaction request id hash mismatch");
    return record;
  }
  answerInteractionRequest(taskId2, requestId, answer, answeredAt = (/* @__PURE__ */ new Date()).toISOString()) {
    const file = this.interactionFile(taskId2, requestId);
    return withEventLock(path3.join(this.taskDir(taskId2), "interactions.lock"), () => {
      if (!existsSync4(file)) throw new Error(`unknown ZCode interaction request: ${requestId}`);
      const current = this.#readJson(file);
      if (current.request_id !== requestId) throw new Error("interaction request id hash mismatch");
      if (current.state === "answered") return "already_answered";
      this.#writeJsonAtomic(file, {
        ...current,
        state: "answered",
        answer,
        answered_at: answeredAt
      });
      return "answered";
    });
  }
  interactionFile(taskId2, requestId) {
    if (!requestId || requestId.length > 512) throw new Error("invalid ZCode interaction request_id");
    const key = createHash2("sha256").update(requestId).digest("hex");
    return path3.join(this.taskDir(taskId2), "interactions", `${key}.json`);
  }
  #readJson(file) {
    return JSON.parse(readFileSync3(file, "utf8"));
  }
  #writeJsonAtomic(file, value) {
    this.#writeTextAtomic(file, JSON.stringify(value, null, 2));
  }
  #writeTextAtomic(file, text) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, text, { encoding: "utf8", mode: 384 });
      privateFile(tmp);
      renameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
      }
      throw error;
    }
  }
};
function withEventLock(lockDir, operation) {
  const deadline = Date.now() + 1e4;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 448 });
      privateDirectory(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync2(lockDir).mtimeMs > 3e4) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for task event lock: ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
    }
  }
}
function privateMkdir(directory) {
  mkdirSync(directory, { recursive: true, mode: 448 });
  privateDirectory(directory);
}
function privateDirectory(directory) {
  if (process.platform !== "win32") chmodSync(directory, 448);
}
function privateFile(file) {
  if (process.platform !== "win32") chmodSync(file, 384);
}
function readLastEventSeq(file) {
  if (!existsSync4(file)) return 0;
  for (const line of readFileSync3(file, "utf8").trimEnd().split("\n").reverse()) {
    try {
      const event = JSON.parse(line);
      if (Number.isInteger(event.seq)) return event.seq;
    } catch {
    }
  }
  return 0;
}
function parseProgressEvent(line) {
  if (!line) return null;
  try {
    const event = JSON.parse(line);
    return Number.isInteger(event.seq) ? event : null;
  } catch {
    return null;
  }
}

// src/worker/run-task.ts
async function runWorkerTask(options) {
  const store = new TaskStore(options.dataRoot);
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const taskId2 = options.taskId;
  const task = store.readTask(taskId2);
  const initialStatus = store.readStatus(taskId2);
  const attempt = initialStatus.attempt;
  if (initialStatus.cancel_requested === true) {
    const finishedAt2 = now().toISOString();
    const result2 = buildTaskResult({
      task,
      attempt,
      startedAt: initialStatus.started_at,
      finishedAt: finishedAt2,
      outcome: null,
      failure: { code: "cancelled", message: "cancelled by request before the worker started the agent" },
      cancelled: true
    });
    store.writeResult(taskId2, result2);
    store.writeStatus(taskId2, { status: "cancelled", finished_at: finishedAt2, worker_pid: null });
    return { status: result2.status, result: result2 };
  }
  const startedAt = initialStatus.started_at ?? now().toISOString();
  store.writeStatus(taskId2, { status: "running", started_at: startedAt, worker_pid: process.pid });
  store.appendEvent(taskId2, "worker_running", "Task worker is preparing the ZCode runtime");
  store.writeAttemptMeta(taskId2, attempt, "started.json", {
    worker_pid: process.pid,
    started_at: startedAt
  });
  const continueSpec = store.readAttemptMeta(taskId2, attempt, "continue.json");
  const previousResult = continueSpec ? store.readArchivedResult(taskId2, continueSpec.previous_attempt ?? attempt - 1) : null;
  const promptText = continueSpec ? buildContinuePrompt({
    task,
    feedback: continueSpec.feedback,
    additionalRequirements: continueSpec.additional_requirements ?? [],
    previousSessionId: continueSpec.previous_session_id,
    previousResult
  }) : buildTaskPrompt(task);
  store.writeAttemptFile(taskId2, attempt, "prompt.txt", promptText);
  let outcome = null;
  let failure = null;
  let pendingModelOutput = "";
  let lastModelOutputAt = 0;
  const flushModelOutput = () => {
    if (!pendingModelOutput) return;
    store.appendEvent(taskId2, "model_output", pendingModelOutput);
    pendingModelOutput = "";
    lastModelOutputAt = Date.now();
  };
  try {
    if (options.resolver) {
      await options.resolver.resolve();
    }
    const adapter = options.adapter ?? new ZCodeAppServerAdapter({
      onEvent: (event) => {
        if (event.type === "model_output") {
          pendingModelOutput += event.summary;
          if (pendingModelOutput.length >= 4e3 || Date.now() - lastModelOutputAt >= 500) flushModelOutput();
          return;
        }
        flushModelOutput();
        store.appendEvent(taskId2, event.type, event.summary, event.details);
        const sessionId = event.type === "session_ready" ? event.details?.["session_id"] : void 0;
        if (typeof sessionId === "string") store.writeStatus(taskId2, { zcode_session_id: sessionId });
      },
      resolveInteraction: async (request) => {
        const safeRequest = sanitizeInteractionRequest(request);
        const { record, created } = store.writeInteractionRequest(taskId2, safeRequest, now().toISOString());
        if (created) {
          const interactionEvent = store.appendEvent(
            taskId2,
            "interaction_requested",
            interactionSummary(safeRequest),
            { ...publicInteractionDetails(safeRequest) },
            record.created_at
          );
          if (!interactionEvent) {
            const fallback = interactionDecline2(request.method, "Bridge could not publish this request to Codex");
            store.answerInteractionRequest(taskId2, request.request_id, fallback, now().toISOString());
            return fallback;
          }
        }
        while (true) {
          const current = store.readInteractionRequest(taskId2, request.request_id);
          if (current?.state === "answered" && current.answer) return current.answer;
          await sleep2(250);
        }
      }
    });
    const workspaceRef = store.readWorkspaceRef(taskId2) ?? {
      requestedPath: task.workspace,
      canonicalPath: task.worktree_path ?? task.workspace,
      mode: task.worktree_path ? "worktree" : "direct",
      ...task.worktree_path ? { sourcePath: task.workspace } : {}
    };
    const handle = continueSpec ? await adapter.continueTask({
      task,
      workspace: workspaceRef,
      attempt,
      feedback: continueSpec.feedback,
      additionalRequirements: [...continueSpec.additional_requirements ?? []],
      previousSessionId: continueSpec.previous_session_id,
      previousResult
    }) : await adapter.startTask({ task, workspace: workspaceRef, attempt });
    outcome = await adapter.getResult(handle);
    flushModelOutput();
  } catch (error) {
    flushModelOutput();
    failure = {
      code: error instanceof BridgeError ? error.code : "worker_error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
  const finishedAt = now().toISOString();
  const stdoutLog = store.appendLog(taskId2, "stdout", outcome?.stdout ? `${outcome.stdout}
` : "");
  const stderrLog = store.appendLog(
    taskId2,
    "stderr",
    outcome?.stderr ? `${outcome.stderr}
` : failure ? `${failure.code}: ${failure.message}
` : ""
  );
  store.writeAttemptMeta(taskId2, attempt, "outcome.json", {
    started_at: startedAt,
    finished_at: finishedAt,
    failure,
    outcome: outcome ? {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      sessionId: outcome.sessionId,
      response: outcome.response,
      usage: outcome.usage,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      attempts: outcome.attempts,
      errorCode: outcome.errorCode,
      reportError: outcome.reportError,
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
      agentReport: outcome.agentReport,
      reportCandidate: outcome.reportCandidate
    } : null,
    logs: { stdout_truncated: stdoutLog.truncated, stderr_truncated: stderrLog.truncated }
  });
  const result = buildTaskResult({
    task,
    attempt,
    startedAt,
    finishedAt,
    outcome,
    failure,
    cancelled: false
  });
  store.appendEvent(taskId2, "task_finished", `Task reached terminal status: ${result.status}`, {
    status: result.status,
    needs_master_decision: result.needs_master_decision
  }, finishedAt);
  store.writeResult(taskId2, result);
  store.writeStatus(taskId2, {
    status: result.status,
    finished_at: finishedAt,
    exit_code: result.exit_code,
    zcode_session_id: result.session_id,
    error_code: result.error_code ?? null,
    error: result.status === "failed" ? result.summary : null
  });
  return { status: result.status, result };
}
function interactionSummary(request) {
  const params = request.params;
  if (request.method === "interaction/requestPermission") {
    const toolName = typeof params.toolName === "string" ? params.toolName : "tool";
    const reason = typeof params.reason === "string" ? `: ${params.reason}` : "";
    return `ZCode is waiting for Codex to decide whether ${toolName} may proceed${reason}`;
  }
  if (asRecord3(params.schema).interaction === "plan_approval") {
    return "ZCode is waiting for Codex to approve or reject its plan";
  }
  return "ZCode is waiting for Codex to answer a question";
}
function publicInteractionDetails(request) {
  const params = request.params;
  const details = {
    request_id: request.request_id,
    method: request.method,
    ...typeof params.sessionId === "string" ? { session_id: params.sessionId } : {},
    ...typeof params.toolCallId === "string" ? { tool_call_id: params.toolCallId } : {}
  };
  for (const key of ["toolName", "reason", "input", "options", "schema", "questions"]) {
    if (params[key] !== void 0) details[key] = params[key];
  }
  if (details["questions"] === void 0 && Array.isArray(asRecord3(params.input).questions)) {
    details["questions"] = asRecord3(params.input).questions;
  }
  return details;
}
function sanitizeInteractionRequest(request) {
  const params = {};
  for (const key of ["sessionId", "toolCallId", "toolName", "reason", "input", "options", "schema", "questions"]) {
    if (request.params[key] !== void 0) params[key] = request.params[key];
  }
  if (params["questions"] === void 0 && Array.isArray(asRecord3(params["input"]).questions)) {
    params["questions"] = asRecord3(params["input"]).questions;
  }
  return { request_id: request.request_id, method: request.method, params };
}
function interactionDecline2(method, reason) {
  return method === "interaction/requestPermission" ? { decision: "deny", reason } : { action: "decline" };
}
function asRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/worker/worker-main.ts
var [dataRoot, taskId] = process.argv.slice(2);
if (!dataRoot || !taskId) {
  console.error("usage: node worker-main.js <dataRoot> <taskId>");
  process.exit(2);
}
try {
  const { status } = await runWorkerTask({ dataRoot, taskId });
  process.exitCode = 0;
  void status;
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
