import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { zcodeTasksIndexPath } from "./account-provider.js";
import { BridgeError } from "./errors.js";
import { createWorkerEnv } from "./child-env.js";
import { discoverZCodeData, discoverZCodeInstall, isAbsolutePathForPlatform, isPermissionDeniedCode, resolveUserHome, sameFileSystemPath } from "./paths.js";
import { resolveSessionPreferences } from "./session-preferences.js";
import { loadPersistedRuntimeEnvironment, NodeRuntimeResolver, type RuntimeResolverOptions } from "./resolver.js";
import type { ZCodeRuntimeConfig } from "../interfaces.js";

export type DoctorStatus = "ok" | "warning" | "error" | "unknown";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  summary: string;
}

export interface DoctorReport {
  checked_at: string;
  execution_mode: string;
  checks: DoctorCheck[];
}

export interface BridgeDoctorOptions {
  env?: NodeJS.ProcessEnv;
  resolver?: RuntimeResolverOptions;
  dataRoot?: string;
  /** Bound lifecycle Authority; production must not infer SQLite health from JSON files. */
  lifecycleChecks?: () => readonly DoctorCheck[] | Promise<readonly DoctorCheck[]>;
  /** Test-only read seam for injected setting.json failures; never used to expose contents. */
  settingReadFile?: (filePath: string) => string;
  /** Test-only stat seam for directory access failures. */
  dataDirStat?: (filePath: string) => { isDirectory(): boolean };
  /** Explicit task-data root for the A1 active-task observation check. */
  observationDataRoot?: string;
}

/** Read-only diagnostics. This does not create a ZCode session or modify either app's data. */
export async function runBridgeDoctor(options: BridgeDoctorOptions = {}): Promise<DoctorReport> {
  const sourceEnv = options.env ?? process.env;
  let env = sourceEnv;
  const checks: DoctorCheck[] = [];
  try { env = loadPersistedRuntimeEnvironment(sourceEnv, options.resolver?.homeDir, options.resolver?.host); }
  catch (error) {
    return { checked_at: new Date().toISOString(), execution_mode: "unknown", checks: [{ name: "runtime_settings", status: "error", summary: safeError(error) }] };
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major! > 22 || (major === 22 && minor! >= 18);
  checks.push({
    name: "node",
    status: nodeOk ? "ok" : "error",
    summary: nodeOk ? `Bridge is running on Node.js ${process.versions.node}` : `Node.js ${process.versions.node}; 22.18 or newer is required`,
  });

  try {
    const gitVersion = execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    checks.push({ name: "git", status: "ok", summary: gitVersion });
  } catch {
    checks.push({ name: "git", status: "error", summary: "Git was not found or could not be started" });
  }

  let mode = "unknown";
  try {
    mode = resolveSessionPreferences(undefined, env).mode;
    checks.push({
      name: "execution_mode",
      status: mode === "yolo" ? "warning" : "ok",
      summary: mode === "yolo"
        ? "yolo: ordinary tool operations may run without approval and use the current OS account's permissions"
        : mode,
    });
  } catch (error) {
    checks.push({ name: "execution_mode", status: "error", summary: safeError(error) });
  }

  let config: ZCodeRuntimeConfig | null = null;
  // Unified path discovery diagnostics (ADR-021). These checks only report
  // locations and discovery sources; they never read or print settings or
  // provider config contents, credentials, or keys.
  let dataDiscovery: ReturnType<typeof discoverZCodeData> | null = null;
  try {
    const home = resolveUserHome(env, { fallbackHomeDir: options.resolver?.homeDir });
    dataDiscovery = discoverZCodeData(env, {
      fallbackHomeDir: options.resolver?.homeDir,
      ...(options.settingReadFile ? { readFile: options.settingReadFile } : {}),
    });
    const homeSource = home.source === "HOME"
      ? "HOME (verified against USERPROFILE)"
      : home.source === "USERPROFILE"
        ? `USERPROFILE${home.homeConflict ? `; HOME was rejected: ${home.homeConflict}` : ""}`
        : "fallback (os.homedir)";
    checks.push({
      name: "user_home",
      status: home.homeConflict ? "warning" : "ok",
      summary: `User directory: ${home.userHome} (from ${homeSource})`,
    });
  } catch (error) {
    checks.push({ name: "user_home", status: "error", summary: `User directory discovery failed: ${safeError(error)}` });
  }

  if (dataDiscovery) {
    const setting = dataDiscovery;
    const settingStatusText: Record<string, string> = {
      absent: "setting.json is not present; the default data location applies",
      ok: setting.migrated
        ? `setting.json is valid and moves the data directory to ${setting.dataBaseDir}`
        : "setting.json is valid; no dataBaseDir override, so the default data location applies",
      invalid_json: "setting.json is not valid JSON; the default data location applies",
      invalid_shape: `setting.json has an unexpected shape${setting.settingError ? ` (${setting.settingError})` : ""}; the default data location applies`,
      unreadable: `setting.json could not be read${setting.settingError ? ` (${setting.settingError})` : ""}; the default data location applies`,
      permission_denied: "setting.json is not readable due to permissions; the default data location applies",
    };
    const relativeDataBaseDir = setting.settingStatus === "ok"
      && setting.settingError?.includes("dataBaseDir is a relative path");
    const settingSummary = relativeDataBaseDir
      ? `${settingStatusText.ok}; dataBaseDir is a relative path and was ignored`
      : settingStatusText[setting.settingStatus] ?? "setting.json status unknown";
    checks.push({
      name: "desktop_settings",
      status: relativeDataBaseDir
        ? "warning"
        : setting.settingStatus === "ok" || setting.settingStatus === "absent"
          ? "ok"
          : setting.settingStatus === "permission_denied" ? "error" : "warning",
      summary: settingSummary,
    });
    const explicitHome = env["ZCODE_HOME"]?.trim();
    const explicitBase = env["ZCODE_DATA_BASE_DIR"]?.trim();
    const homeValid = explicitHome ? isAbsolutePathForPlatform(explicitHome) : false;
    const baseValid = explicitBase ? isAbsolutePathForPlatform(explicitBase) : false;
    let effectiveBase = setting.dataBaseDir;
    let baseSource: string;
    if (explicitHome && homeValid) {
      effectiveBase = path.dirname(path.resolve(explicitHome));
      baseSource = explicitBase
        ? "explicit ZCODE_HOME and ZCODE_DATA_BASE_DIR (consistent)"
        : "explicit ZCODE_HOME (parent directory)";
    } else if (explicitBase && baseValid) {
      effectiveBase = path.resolve(explicitBase);
      baseSource = "explicit ZCODE_DATA_BASE_DIR";
    } else if (explicitHome || explicitBase) {
      effectiveBase = path.resolve(explicitHome ?? explicitBase!);
      baseSource = `explicit ${explicitHome ? "ZCODE_HOME" : "ZCODE_DATA_BASE_DIR"} (invalid absolute path)`;
    } else {
      baseSource = setting.migrated
        ? "setting.json dataBaseDir"
        : "default (user directory)";
    }
    let dataDirStatus: DoctorStatus = "ok";
    let dataDirSummary = `ZCode data base directory: ${effectiveBase} (from ${baseSource})`;
    if (explicitHome && explicitBase) {
      if (!sameFileSystemPath(path.dirname(path.resolve(explicitHome)), path.resolve(explicitBase))) {
        dataDirStatus = "error";
        dataDirSummary = `ZCODE_HOME (${explicitHome}) and ZCODE_DATA_BASE_DIR (${explicitBase}) conflict; ZCODE_HOME must be <ZCODE_DATA_BASE_DIR>/.zcode`;
      }
    }
    if (dataDirStatus === "ok" && ((explicitHome && !homeValid) || (explicitBase && !baseValid))) {
      dataDirStatus = "error";
      dataDirSummary += "; the explicit value must be a full Windows absolute path";
    }
    if (dataDirStatus === "ok") {
      try {
        const inspectDirectory = options.dataDirStat ?? statSync;
        const directoryInfo = inspectDirectory(effectiveBase);
        if (!directoryInfo.isDirectory()) {
          dataDirStatus = "error";
          dataDirSummary += "; path exists but is not a directory";
        } else {
          dataDirSummary += !explicitHome && !explicitBase && setting.migrated ? "; migrated data directory exists" : "; directory exists";
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          dataDirStatus = "warning";
          dataDirSummary += "; directory does not exist yet (the Bridge never creates ZCode data directories)";
        } else {
          dataDirStatus = isPermissionDeniedCode(error) ? "error" : "warning";
          dataDirSummary += isPermissionDeniedCode(error) ? "; permission denied while inspecting the directory" : `; could not be inspected (${safeError(error)})`;
        }
      }
    }
    checks.push({ name: "zcode_data_dir", status: dataDirStatus, summary: dataDirSummary });
  }

  const install = discoverZCodeInstall(env, { requireBuiltin: !env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim() });
  const explicitRuntime = env["ZCODE_BRIDGE_ZCODE_CJS"]?.trim();
  if (explicitRuntime) {
    let explicitRuntimeStatus: DoctorStatus = "ok";
    const automaticDiscovery = install.installDir
      ? `; auto-discovery would choose ${install.installDir} (${install.source})`
      : "; auto-discovery found no complete installation";
    let explicitRuntimeSummary = `Runtime is explicitly configured (ZCODE_BRIDGE_ZCODE_CJS); the builtin provider config is derived from the same installation: ${path.dirname(path.dirname(explicitRuntime))}${automaticDiscovery}`;
    try {
      if (!isAbsolutePathForPlatform(explicitRuntime)) throw new Error("not a full absolute path");
      const runtimeStat = statSync(explicitRuntime);
      if (!runtimeStat.isFile()) throw new Error("not a regular file");
      accessSync(explicitRuntime, constants.R_OK);
    } catch (error) {
      explicitRuntimeStatus = "error";
      explicitRuntimeSummary = isPermissionDeniedCode(error)
        ? `Explicit runtime exists but is not readable: ${explicitRuntime}`
        : `Explicit runtime was configured but is not a readable file: ${explicitRuntime}`;
    }
    checks.push({
      name: "zcode_install",
      status: explicitRuntimeStatus,
      summary: explicitRuntimeSummary,
    });
  } else if (install.installDir) {
    checks.push({
      name: "zcode_install",
      status: "ok",
      summary: `ZCode installation: ${install.installDir} (discovered via ${install.source}); runtime and builtin provider config come from the same installation`,
    });
  } else {
    checks.push({
      name: "zcode_install",
      status: "warning",
      summary: `No ZCode installation was auto-discovered; searched: ${install.candidates.map((candidate) => `${candidate.root} (runtime: ${candidate.runtimeExists}, builtin: ${candidate.builtinExists})`).join(", ") || "(no installation roots available)"}`,
    });
  }

  try {
    const workerEnv = createWorkerEnv(sourceEnv);
    const mainHome = resolveUserHome(env, { fallbackHomeDir: options.resolver?.homeDir });
    const workerHome = resolveUserHome(workerEnv, { fallbackHomeDir: options.resolver?.homeDir });
    const sameHome = sameFileSystemPath(mainHome.userHome, workerHome.userHome);
    checks.push({
      name: "worker_env_consistency",
      status: sameHome ? "ok" : "error",
      summary: sameHome
        ? `Detached worker environment resolves the same user directory as the Bridge: ${mainHome.userHome}`
        : `Detached worker user directory (${workerHome.userHome}) differs from the Bridge (${mainHome.userHome})`,
    });
  } catch (error) {
    checks.push({ name: "worker_env_consistency", status: "unknown", summary: `Worker environment consistency could not be determined: ${safeError(error)}` });
  }

  try {
    config = await new NodeRuntimeResolver({ ...options.resolver, env }).resolve();
    checks.push({ name: "zcode_runtime", status: "ok", summary: "ZCode runtime was found and its configured path is readable" });
    checks.push({ name: "provider_config", status: "ok", summary: "Builtin and personal provider configs passed validation" });
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : null;
    if (code === "runtime_not_found") {
      checks.push({ name: "zcode_runtime", status: "error", summary: safeError(error) });
      checks.push({ name: "provider_config", status: "unknown", summary: "Not checked because the ZCode runtime could not be resolved" });
    } else if (code === "provider_config_missing" || code === "provider_config_invalid") {
      checks.push({ name: "zcode_runtime", status: "ok", summary: "ZCode runtime was found" });
      checks.push({ name: "provider_config", status: "error", summary: safeError(error) });
    } else {
      checks.push({ name: "zcode_runtime", status: "unknown", summary: safeError(error) });
      checks.push({ name: "provider_config", status: "unknown", summary: "Could not determine provider config status" });
    }
  }

  if (config) {
    try {
      const runtimeNodeVersion = execFileSync(config.nodeExecutable, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
      const match = /^v?(\d+)\.(\d+)\./u.exec(runtimeNodeVersion);
      const supported = Boolean(match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 18)));
      checks.push({
        name: "runtime_node",
        status: supported ? "ok" : "error",
        summary: supported ? `Configured worker Node.js is ${runtimeNodeVersion}` : `Configured worker Node.js is ${runtimeNodeVersion}; 22.18 or newer is required`,
      });
    } catch {
      checks.push({ name: "runtime_node", status: "error", summary: "Configured worker Node.js could not be started" });
    }
    const modelConfigured = Boolean(env["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() && env["ZCODE_BRIDGE_DEFAULT_MODEL_ID"]?.trim());
    checks.push({
      name: "model",
      status: "unknown",
      summary: modelConfigured
        ? "A Bridge default model is configured; actual app-server availability is checked when a task starts"
        : "No Bridge model override; the ZCode account default will be used and cannot be confirmed without starting a session",
    });
    // ADR-007 browser host: read-only status only. Doctor never launches a
    // browser; headless resolution is confirmed on first browser use instead.
    const browserUse = env["ZCODE_BRIDGE_BROWSER_USE"]?.trim() ?? "";
    const browserExecutable = env["ZCODE_BRIDGE_BROWSER_EXECUTABLE"]?.trim() ?? "";
    if (browserUse === "" || browserUse === "off") {
      checks.push({
        name: "browser_host",
        status: "ok",
        summary: browserUse === "off"
          ? "Browser host is explicitly disabled; browser RPCs answer with an empty browser list"
          : "Browser host is disabled by default; browser RPCs answer with an empty browser list",
      });
    } else if (browserUse === "headless") {
      if (browserExecutable) {
        if (!path.isAbsolute(browserExecutable)) {
          checks.push({ name: "browser_host", status: "error", summary: `ZCODE_BRIDGE_BROWSER_EXECUTABLE must be an absolute path: ${browserExecutable}` });
        } else if (existsSync(browserExecutable)) {
          checks.push({ name: "browser_host", status: "ok", summary: `Headless browser host is enabled with the configured executable (${path.basename(browserExecutable)})` });
        } else {
          checks.push({ name: "browser_host", status: "error", summary: `Configured browser executable does not exist: ${browserExecutable}` });
        }
      } else {
        checks.push({ name: "browser_host", status: "unknown", summary: "Headless browser host is enabled; the managed runtime resolves an installed Chromium/Edge at first use and is not probed here" });
      }
    } else {
      checks.push({ name: "browser_host", status: "warning", summary: `ZCODE_BRIDGE_BROWSER_USE must be "off" or "headless"; got "${browserUse}" — the browser host stays disabled` });
    }
    const dataRoot = options.dataRoot ?? env["ZCODE_BRIDGE_DATA_DIR"]?.trim() ?? null;
    if (dataRoot && existsSync(dataRoot)) {
      try {
        const info = statSync(dataRoot);
        accessSync(dataRoot, constants.W_OK);
        checks.push({ name: "task_data", status: info.isDirectory() ? "ok" : "error", summary: info.isDirectory() ? "Bridge task data directory exists and is writable" : "Bridge task data path is not a directory" });
      } catch {
        checks.push({ name: "task_data", status: "error", summary: "Bridge task data directory exists but is not writable" });
      }
    } else {
      checks.push({ name: "task_data", status: "unknown", summary: "Task data directory is not configured or has not been created yet" });
    }
    const indexPath = zcodeTasksIndexPath(config.providerPersonalConfigFile);
    checks.push({
      name: "desktop_index",
      status: indexPath && existsSync(indexPath) ? "ok" : "warning",
      summary: indexPath && existsSync(indexPath)
        ? "ZCode Desktop task index file exists; Desktop refresh timing is not tested"
        : "ZCode Desktop task index file was not found at the configured data location",
    });
  } else {
    checks.push({ name: "runtime_node", status: "unknown", summary: "Not checked because runtime validation did not complete" });
    checks.push({ name: "model", status: "unknown", summary: "Not checked because runtime/provider validation did not complete" });
    checks.push({ name: "task_data", status: "unknown", summary: "Not checked because runtime validation did not complete" });
    checks.push({ name: "desktop_index", status: "unknown", summary: "Not checked because the active ZCode data location is unknown" });
  }

  checks.push({ name: "app_server", status: "unknown", summary: "Not probed; doctor does not start an app-server session" });
  checks.push({ name: "start_plan", status: "warning", summary: "Unsupported through the headless Bridge; ZCode Start Plan requires a Desktop captcha session" });
  checks.push({ name: "permission_roundtrip", status: "unknown", summary: "Bridge protocol tests exist; a real ZCode permission-approval roundtrip has not been verified" });

  // A2: report the process-identity probe capability for this platform.
  checks.push({
    name: "process_probe",
    status: process.platform === "win32" || process.platform === "linux" ? "ok" : "warning",
    summary: process.platform === "win32"
      ? "Windows process identity uses .NET Process.StartTime ticks through a bounded PowerShell query"
      : process.platform === "linux"
        ? "Linux process identity uses /proc/<pid>/stat starttime plus boot identity"
        : process.platform === "darwin"
          ? "macOS process identity uses ps lstart (second precision; coarse, not an absolute unique identity)"
          : `Process identity probing is not implemented for ${process.platform}; verdicts stay unknown`,
  });

  // B4: the Master Skill can query the explicit Codex Thread's rollout through
  // its read-only helper. Doctor itself has no thread-bound execution context,
  // so it reports the capability as not probed rather than selecting a session.
  checks.push({
    name: "codex_host_tokens",
    status: "unknown",
    summary: "Not probed here: use the Master Skill helper with the explicit CODEX_THREAD_ID; codex_rollout values require a report-window baseline and must not be replaced by account quotas or text estimates",
  });

  // Read the bound lifecycle Authority first. JSON observations remain only
  // for explicit legacy callers and never stand in for a SQLite snapshot.
  const observedRoot: string | null = options.observationDataRoot ?? options.dataRoot ?? env["ZCODE_BRIDGE_DATA_DIR"]?.trim() ?? null;
  if (options.lifecycleChecks) {
    try { checks.push(...await options.lifecycleChecks()); }
    catch (error) {
      checks.push({ name: "active_tasks", status: "unknown", summary: `SQLite lifecycle diagnostics unavailable: ${safeError(error)}` });
      checks.push({ name: "recovery_lock", status: "unknown", summary: "SQLite Recovery state is unknown; the bound Authority could not be read" });
    }
  } else if (observedRoot && existsSync(path.join(observedRoot, "bridge.sqlite"))) {
    checks.push({ name: "active_tasks", status: "unknown", summary: "SQLite data root is present but no lifecycle Authority diagnostics are bound" });
    checks.push({ name: "recovery_lock", status: "unknown", summary: "SQLite Recovery state is unknown; JSON recovery locks are not authoritative" });
  } else if (observedRoot && existsSync(observedRoot)) {
    try {
      const { TaskStore: Store } = await import("../store/task-store.js");
      const { buildTaskObservation, inferExecutionStage } = await import("../observation/build.js");
      const store = new Store(observedRoot);
      const activeAll = store.listTaskIds()
        .map((taskId) => {
          try {
            const status = store.readStatus(taskId);
            return { taskId, status };
          } catch { return null; }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .filter((entry) => entry.status.status === "running" || entry.status.status === "queued" || entry.status.cleanup_unverified === true);
      const queued = activeAll.filter((entry) => entry.status.status === "queued");
      const cleanupPending = activeAll.filter((entry) => entry.status.cleanup_unverified === true);
      const running = activeAll.filter((entry) => entry.status.status === "running");
      const active = activeAll.slice(0, 32);
      if (active.length === 0) {
        checks.push({ name: "active_tasks", status: "ok", summary: "No queued/running tasks" });
      } else {
        const lines = active.map((entry) => {
          try {
            const observation = buildTaskObservation(store, entry.taskId, entry.status);
            const stage = inferExecutionStage(store, entry.taskId, entry.status);
            return `${entry.taskId}#${entry.status.attempt}: ${observation.activity.code} (stage ${stage}, worker ${observation.worker.state}, runtime ${observation.runtime.state}, result ${observation.result}, cleanup ${observation.cleanup}${observation.stalled ? ", stalled-hint" : ""})`;
          } catch (error) {
            return `${entry.taskId}#${entry.status.attempt}: observation unavailable (${safeError(error)})`;
          }
        });
        const oldestQueuedAt = queued
          .map((entry) => Date.parse(entry.status.created_at))
          .filter(Number.isFinite)
          .sort((a, b) => a - b)[0];
        const queueAge = oldestQueuedAt === undefined ? "unknown" : `${Math.floor(Math.max(0, Date.now() - oldestQueuedAt) / 60_000)}m`;
        const blocked = queued.length > 0 || cleanupPending.length > 0;
        const summary = `${running.length} running, ${queued.length} queued, ${cleanupPending.length} cleanup-unverified; oldest queue ${queueAge}${blocked ? "; dispatch may be blocked" : ""}. ${lines.join("; ")}`;
        checks.push({ name: "active_tasks", status: blocked ? "warning" : "ok", summary: summary.slice(0, 1_200) });
      }

      checks.push(inspectRecoveryLock(path.join(store.tasksRoot, ".recovery.lock")));
    } catch (error) {
      checks.push({ name: "active_tasks", status: "unknown", summary: safeError(error) });
    }
  }

  return { checked_at: new Date().toISOString(), execution_mode: mode, checks };
}

function inspectRecoveryLock(lockDirectory: string): DoctorCheck {
  if (!existsSync(lockDirectory)) {
    return { name: "recovery_lock", status: "ok", summary: "No persisted recovery lock is blocking task reconciliation" };
  }
  try {
    const lockStat = statSync(lockDirectory);
    const raw = readFileSync(path.join(lockDirectory, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: number; token?: string };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0 || typeof owner.token !== "string" || !owner.token) {
      throw new Error("invalid lock owner record");
    }
    const ageMs = Date.now() - lockStat.mtimeMs;
    if (ageMs <= 30_000) {
      return { name: "recovery_lock", status: "ok", summary: "A recent recovery pass owns the reconciliation lock" };
    }
    try {
      process.kill(owner.pid!, 0);
      return { name: "recovery_lock", status: "warning", summary: "Recovery lock is older than 30 seconds and its owner PID still exists; reconciliation may be stalled" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { name: "recovery_lock", status: "warning", summary: "Recovery lock owner PID is absent; the next recovery pass should reclaim the lock" };
      }
      return { name: "recovery_lock", status: "warning", summary: "Recovery lock owner liveness could not be confirmed" };
    }
  } catch (error) {
    const ageMs = Date.now() - statSync(lockDirectory).mtimeMs;
    if (ageMs <= 30_000) {
      return { name: "recovery_lock", status: "warning", summary: "Recovery lock owner record is being published or is unreadable; check again if it persists" };
    }
    return { name: "recovery_lock", status: "error", summary: `Recovery lock owner record is unreadable; automated reconciliation is blocked and needs repair (${safeError(error)})` };
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]/gu, " ").slice(0, 500);
}
