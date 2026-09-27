// src/adapters/zcode-app-server-adapter.ts
import { spawn as spawn2 } from "node:child_process";

// src/adapters/agent-report.ts
var TEST_STATUSES = /* @__PURE__ */ new Set(["passed", "failed", "not_run"]);
var MAX_SCAN_CHARS = 4e5;
function parseAgentReport(responseText) {
  let lastError = null;
  for (const candidate of extractJsonObjects(responseText)) {
    const validated = validateAgentReport(candidate);
    if (validated.ok) {
      return { report: validated.report, error: null };
    }
    lastError = validated.error;
  }
  return {
    report: null,
    error: lastError ?? "no JSON object found in the response text"
  };
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
    "You are a subordinate coding agent executing one bounded task inside the current working directory. Stay inside the workspace; do not touch files outside it.",
    `TASK ID: ${task.task_id}`,
    ...task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : [],
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
    )
  ];
  if (task.context && task.context.trim().length > 0) {
    sections.push(`CONTEXT
${bounded(task.context, MAX_CONTEXT_CHARS)}`);
  }
  sections.push(OUTPUT_CONTRACT);
  return joinBounded(sections);
}
function buildContinuePrompt(input) {
  const { task, feedback, additionalRequirements, previousSessionId, previousResult } = input;
  const sections = [
    "You are a subordinate coding agent continuing a previous task in the same workspace. Stay inside the workspace.",
    `TASK ID: ${task.task_id}`,
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
  }
  sections.push(`MASTER FEEDBACK (address every point)
${bounded(feedback, MAX_SECTION_CHARS)}`);
  if (additionalRequirements.length > 0) {
    sections.push(renderList("ADDITIONAL REQUIREMENTS", [...additionalRequirements]));
  }
  sections.push(`ORIGINAL TASK
${buildTaskPrompt(task)}`);
  return joinBounded(sections);
}
var OUTPUT_CONTRACT = [
  "OUTPUT CONTRACT (mandatory)",
  "Your final response must be exactly one JSON object with no markdown fences and no text before or after it, matching this shape:",
  '{"summary": string, "files_changed": string[], "tests": [{"command": string, "status": "passed" | "failed" | "not_run", "details"?: string}], "issues": string[], "needs_master_decision": boolean}',
  "List every file you created or modified in files_changed (workspace-relative paths). Give one tests entry per applicable test command; use status not_run when a command was not applicable or could not run. Record problems in issues. Set needs_master_decision=true only when a required decision is outside your authority; never guess."
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
function joinBounded(sections) {
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_PROMPT_CHARS) return joined;
  return `${joined.slice(0, MAX_PROMPT_CHARS)}\u2026[truncated]`;
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
    const env = this.#env;
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
        const candidates = [env["ZCODE_DATA_BASE_DIR"]?.trim(), this.#homeDir].filter((base) => Boolean(base)).map((base) => path.join(base, ".zcode", "v2", "provider_config.json"));
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
    env["LOCALAPPDATA"]?.trim() ? path.join(env["LOCALAPPDATA"].trim(), "Programs", "ZCode") : null
  ].filter((root) => Boolean(root));
  return roots.map((root) => path.join(root, ...relative));
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

// src/adapters/zcode-app-server-adapter.ts
var DEFAULT_TIMEOUT_MS = 30 * 60 * 1e3;
var RPC_TIMEOUT_MS = 3e4;
var MAX_CAPTURE_CHARS = 2e6;
var ZCodeAppServerAdapter = class {
  #resolver;
  #onEvent;
  #timeoutMs;
  #childEnvBase;
  #now;
  #runs = /* @__PURE__ */ new Map();
  #workspaceByTask = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.#resolver = options.resolver ?? new NodeRuntimeResolver();
    this.#onEvent = options.onEvent ?? (() => void 0);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#childEnvBase = options.childEnvBase ?? process.env;
    this.#now = options.now ?? (() => /* @__PURE__ */ new Date());
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
      lastEventSeq: 0
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
    let timer;
    try {
      const config = await this.#resolver.resolve();
      const childEnv = this.#buildChildEnv(config);
      entry.onEvent({ type: "zcode_starting", summary: "Starting ZCode streaming runtime" });
      const client = this.#startAppServer(config, workspace.canonicalPath, childEnv, entry);
      entry.client = client;
      entry.child = client.child;
      timer = setTimeout(() => {
        entry.timedOut = true;
        const pid = entry.child?.pid;
        if (pid) void terminateProcessTree(pid).catch(() => void 0);
        entry.rejectTurn(new Error(`ZCode run exceeded ${this.#timeoutMs}ms wall-clock budget`));
      }, this.#timeoutMs);
      timer.unref();
      let snapshot;
      if (resumeSessionId) {
        snapshot = asRecord(await client.request("session/resume", {
          sessionId: resumeSessionId,
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath }
        }));
        const returnedId = nestedString(snapshot, ["session", "sessionId"]);
        if (returnedId && returnedId !== resumeSessionId) {
          throw new Error(`resume session mismatch: requested ${resumeSessionId}, runtime returned ${returnedId}`);
        }
      } else {
        snapshot = asRecord(await client.request("session/create", {
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath },
          mode: "yolo",
          persistence: "immediate"
        }));
      }
      const sessionId = nestedString(snapshot, ["session", "sessionId"]);
      if (!sessionId) throw new Error("ZCode app-server session snapshot did not contain session.sessionId");
      entry.sessionId = sessionId;
      if (task.model) {
        const requested = `${task.model.provider_id}/${task.model.model_id}`;
        const current = readSelectedModelSelection(snapshot);
        const modelState = current?.providerId === task.model.provider_id && current.modelId === task.model.model_id ? snapshot : asRecord(await client.request("session/setModel", {
          sessionId,
          model: {
            providerId: task.model.provider_id,
            modelId: task.model.model_id,
            ...task.model.reasoning_level ? { options: { reasoningLevel: task.model.reasoning_level } } : {}
          },
          // Keep the override scoped to this session; do not change the
          // user's project-wide last-used model.
          persistAsWorkspaceLastUsed: false
        }));
        const selected = readSelectedModelSelection(modelState);
        if (!selected) {
          throw new Error(`ZCode accepted model override ${requested} but did not report the selected model`);
        }
        if (selected.providerId !== task.model.provider_id || selected.modelId !== task.model.model_id) {
          throw new Error(
            `ZCode model override mismatch: requested ${requested}, runtime selected ${selected.providerId}/${selected.modelId}`
          );
        }
        entry.selectedModel = readSelectedModel(modelState) ?? requested;
        entry.onEvent({
          type: "model_selected",
          summary: `ZCode selected requested model ${entry.selectedModel}`,
          details: {
            requested_model: requested,
            selected_model: entry.selectedModel,
            provider_id: selected.providerId,
            model_id: selected.modelId
          }
        });
      }
      const model = readSelectedModel(snapshot);
      entry.selectedModel = entry.selectedModel ?? model;
      entry.onEvent({
        type: "session_ready",
        summary: `ZCode session ready${entry.selectedModel ? `; selected model ${entry.selectedModel}` : "; selected model not reported"}`,
        details: {
          session_id: sessionId,
          source_path: task.workspace,
          workspace_path: workspace.canonicalPath,
          execution_mode: "yolo",
          ...entry.selectedModel ? { selected_model: entry.selectedModel } : {}
        }
      });
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
        timedOut: false
      };
      if (!parsed.report) {
        return {
          ...base,
          agentReport: null,
          reportError: parsed.error,
          errorCode: "invalid_agent_report"
        };
      }
      entry.onEvent({
        type: "report_ready",
        summary: "ZCode produced its structured execution report",
        details: { needs_master_decision: parsed.report.needs_master_decision }
      });
      return { ...base, agentReport: parsed.report, reportError: null, errorCode: null };
    } catch (error) {
      if (entry.child?.pid) await terminateProcessTree(entry.child.pid).catch(() => void 0);
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
          this.#handleMessage(message, entry, pending, (reply) => {
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
  #handleMessage(message, entry, pending, write) {
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
      const params = asRecord(message.params);
      if (typeof params.seq === "number") entry.lastEventSeq = params.seq;
      const type = typeof params.type === "string" ? params.type : "";
      const payload = asRecord(params.payload);
      this.#publishSessionEvent(type, payload, entry);
      if (type === "turn.completed") {
        entry.resolveTurn({
          response: typeof payload.response === "string" ? payload.response : "",
          usage: isRecord(payload.usage) ? payload.usage : null,
          resultType: typeof payload.resultType === "string" ? payload.resultType : null
        });
      } else if (type === "turn.failed") {
        const problem = asRecord(payload.error);
        entry.rejectTurn(new Error(typeof problem.message === "string" ? problem.message : "ZCode turn failed"));
      }
      return;
    }
    if (message.method === "state.updated") {
      const params = asRecord(message.params);
      const patch = asRecord(params.patch);
      const state = typeof patch.status === "string" ? patch.status : void 0;
      if (state) entry.onEvent({ type: "runtime_state", summary: `ZCode runtime state: ${state}` });
      return;
    }
    if (message.id !== void 0 && typeof message.method === "string") {
      write({ id: message.id, error: { code: -32601, message: `Unsupported ZCode app-server request: ${message.method}` } });
    }
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
          ...isRecord(payload.usage) ? { usage: payload.usage } : {}
        }
      });
    } else if (type === "turn.failed") {
      const problem = asRecord(payload.error);
      entry.onEvent({
        type: "turn_failed",
        summary: typeof problem.message === "string" ? problem.message : "ZCode turn failed"
      });
    }
  }
  #buildChildEnv(config) {
    const env = createMinimalOsEnv(this.#childEnvBase);
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
    return env;
  }
  #require(handle, method) {
    const entry = this.#runs.get(handle);
    if (!entry) throw new Error(`${method}: unknown agent handle (task ${handle.taskId})`);
    return entry;
  }
};
function readSelectedModel(snapshot) {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  const modelId = typeof current.modelId === "string" ? current.modelId : null;
  const providerId = typeof current.providerId === "string" ? current.providerId : null;
  if (!modelId) return null;
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  const match = available.find((entry) => {
    const ref = asRecord(asRecord(entry).ref);
    return ref.modelId === modelId && (providerId === null || ref.providerId === providerId);
  });
  const label = match && typeof asRecord(match).label === "string" ? asRecord(match).label : modelId;
  return providerId ? `${label} (${providerId}/${modelId})` : label;
}
function readSelectedModelSelection(snapshot) {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  if (typeof current.providerId !== "string" || typeof current.modelId !== "string") return null;
  return { providerId: current.providerId, modelId: current.modelId };
}
function nestedString(record, path3) {
  let value = record;
  for (const part of path3) value = asRecord(value)[part];
  return typeof value === "string" ? value : null;
}
function nestedNumber(record, path3) {
  let value = record;
  for (const part of path3) value = asRecord(value)[part];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asRecord(value) {
  return isRecord(value) ? value : {};
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      error_code: code
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
import { appendFileSync, chmodSync, existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, readdirSync, renameSync, rmSync, rmdirSync, statSync as statSync2, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path2 from "node:path";
var TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
var TaskStore = class {
  #dataRoot;
  #tasksRoot;
  #maxLogBytes;
  #maxEventBytes;
  constructor(dataRoot2, options = {}) {
    this.#dataRoot = dataRoot2;
    this.#tasksRoot = path2.join(dataRoot2, ".tasks");
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
    return path2.join(this.#tasksRoot, taskId2);
  }
  hasTask(taskId2) {
    try {
      return existsSync2(path2.join(this.taskDir(taskId2), "status.json"));
    } catch {
      return false;
    }
  }
  listTaskIds() {
    if (!existsSync2(this.#tasksRoot)) return [];
    return readdirSync(this.#tasksRoot).filter(
      (entry) => existsSync2(path2.join(this.#tasksRoot, entry, "status.json"))
    );
  }
  createTask(task, createdAt) {
    this.assertValidTaskId(task.task_id);
    const dir = this.taskDir(task.task_id);
    if (existsSync2(path2.join(dir, "task.json"))) {
      throw new Error(`task already exists: ${task.task_id}`);
    }
    privateMkdir(path2.join(dir, "attempts"));
    this.#writeJsonAtomic(path2.join(dir, "task.json"), task);
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
    this.#writeJsonAtomic(path2.join(dir, "status.json"), status);
  }
  readTask(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "task.json");
    const parsed = this.#readJson(file);
    return parsed;
  }
  writeWorkspaceRef(taskId2, workspace) {
    this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "workspace.json"), workspace);
  }
  readWorkspaceRef(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "workspace.json");
    if (!existsSync2(file)) return null;
    return this.#readJson(file);
  }
  readStatus(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "status.json");
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
    this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "status.json"), next);
    return next;
  }
  readResult(taskId2) {
    const file = path2.join(this.taskDir(taskId2), "result.json");
    if (!existsSync2(file)) return null;
    return this.#readJson(file);
  }
  writeResult(taskId2, result) {
    this.#writeJsonAtomic(path2.join(this.taskDir(taskId2), "result.json"), result);
  }
  /** Moves the current terminal result.json to attempts/<attempt>/result.json. */
  archiveResultToAttempt(taskId2, attempt) {
    const dir = this.taskDir(taskId2);
    const source = path2.join(dir, "result.json");
    if (!existsSync2(source)) return;
    const targetDir = this.attemptDir(taskId2, attempt);
    privateMkdir(targetDir);
    renameSync(source, path2.join(targetDir, "result.json"));
  }
  readArchivedResult(taskId2, attempt) {
    const file = path2.join(this.attemptDir(taskId2, attempt), "result.json");
    if (!existsSync2(file)) return null;
    return this.#readJson(file);
  }
  attemptDir(taskId2, attempt) {
    return path2.join(this.taskDir(taskId2), "attempts", String(attempt));
  }
  writeAttemptFile(taskId2, attempt, fileName, content) {
    const dir = this.attemptDir(taskId2, attempt);
    privateMkdir(dir);
    this.#writeTextAtomic(path2.join(dir, fileName), content);
  }
  writeAttemptMeta(taskId2, attempt, fileName, meta) {
    const dir = this.attemptDir(taskId2, attempt);
    privateMkdir(dir);
    this.#writeJsonAtomic(path2.join(dir, fileName), meta);
  }
  readAttemptMeta(taskId2, attempt, fileName) {
    const file = path2.join(this.attemptDir(taskId2, attempt), fileName);
    if (!existsSync2(file)) return null;
    return this.#readJson(file);
  }
  readAttemptText(taskId2, attempt, fileName) {
    const file = path2.join(this.attemptDir(taskId2, attempt), fileName);
    if (!existsSync2(file)) return null;
    return readFileSync2(file, "utf8");
  }
  /** Append-only, byte-bounded. Returns whether the chunk was truncated. */
  appendLog(taskId2, kind, text) {
    if (!text) return { truncated: false };
    const dir = this.taskDir(taskId2);
    privateMkdir(dir);
    const file = path2.join(dir, `${kind}.log`);
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
    const file = path2.join(this.taskDir(taskId2), `${kind}.log`);
    return existsSync2(file) ? readFileSync2(file, "utf8") : "";
  }
  appendEvent(taskId2, type, summary, details, at = (/* @__PURE__ */ new Date()).toISOString()) {
    const dir = this.taskDir(taskId2);
    mkdirSync(dir, { recursive: true });
    const lockDir = path2.join(dir, "events.lock");
    return withEventLock(lockDir, () => {
      const file = path2.join(dir, "events.jsonl");
      const seqFile = path2.join(dir, "events.seq");
      let bytes = 0;
      let previousSeq = 0;
      let needsSeparator = false;
      try {
        const info = statSync2(file);
        bytes = info.size;
        const lastByte = bytes > 0 ? readFileSync2(file).at(-1) : void 0;
        needsSeparator = bytes > 0 && lastByte !== 10;
      } catch {
        bytes = 0;
      }
      try {
        previousSeq = Number.parseInt(readFileSync2(seqFile, "utf8"), 10) || 0;
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
      if (lineBytes > 64e3 || bytes + lineBytes > this.#maxEventBytes) return null;
      this.#writeTextAtomic(seqFile, String(event.seq));
      appendFileSync(file, `${needsSeparator ? "\n" : ""}${line}`, { encoding: "utf8", mode: 384 });
      privateFile(file);
      return event;
    });
  }
  readEvents(taskId2, afterSeq = 0, limit = 100) {
    const file = path2.join(this.taskDir(taskId2), "events.jsonl");
    if (!existsSync2(file)) return { events: [], nextSeq: afterSeq, hasMore: false };
    const all = [];
    for (const line of readFileSync2(file, "utf8").split(/\r?\n/u)) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (Number.isInteger(event.seq) && event.seq > afterSeq) all.push(event);
      } catch {
      }
    }
    const events = all.slice(0, limit);
    return {
      events,
      nextSeq: events.at(-1)?.seq ?? afterSeq,
      hasMore: all.length > events.length
    };
  }
  #readJson(file) {
    return JSON.parse(readFileSync2(file, "utf8"));
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
  if (!existsSync2(file)) return 0;
  for (const line of readFileSync2(file, "utf8").trimEnd().split("\n").reverse()) {
    try {
      const event = JSON.parse(line);
      if (Number.isInteger(event.seq)) return event.seq;
    } catch {
    }
  }
  return 0;
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
  try {
    if (options.resolver) {
      await options.resolver.resolve();
    }
    const adapter = options.adapter ?? new ZCodeAppServerAdapter({
      onEvent: (event) => {
        store.appendEvent(taskId2, event.type, event.summary, event.details);
        const sessionId = event.type === "session_ready" ? event.details?.["session_id"] : void 0;
        if (typeof sessionId === "string") store.writeStatus(taskId2, { zcode_session_id: sessionId });
      }
    });
    const workspaceRef = store.readWorkspaceRef(taskId2) ?? {
      requestedPath: task.workspace,
      canonicalPath: task.workspace,
      mode: "direct"
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
  } catch (error) {
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
      agentReport: outcome.agentReport
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
