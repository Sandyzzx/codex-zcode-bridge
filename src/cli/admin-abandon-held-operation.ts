#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProcessTreeClaimantsClean } from "../adapters/process-spawn.js";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessIdentity } from "../runtime/process-probe.js";
import { IsolatedAdmissionStore } from "../sqlite-candidate/wp6b2b1/store.mjs";

export interface CliOptions {
  readonly execute: boolean;
  readonly preflight: boolean;
  readonly dataRoot: string;
  readonly databaseFileName: string;
  readonly operationId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly generation: number;
  readonly revision: number;
  readonly claimId: string;
  readonly workerIdentityDigest: string;
  readonly confirmation: string;
}

export interface ProcessInventoryEntry {
  readonly processId: number;
  readonly name: string;
  readonly commandLine: string;
}

interface ProcessInventoryEvidence {
  readonly hostsClosed: boolean;
  readonly writersClosed: boolean;
  readonly relatedProcessCount: number;
  readonly digest: string;
}

interface PlatformProbeEvidence {
  readonly count: number;
  readonly state: string | null;
}

interface ClaimantScanEvidence {
  readonly clean: boolean;
  readonly livePids: readonly number[];
  readonly observedPids: readonly number[];
}

export interface AdminRecoveryDependencies {
  readonly windowsBootTime: () => Promise<string>;
  readonly processInventory: () => Promise<readonly ProcessInventoryEntry[]>;
  readonly probeWorkerExit: (identity: ProcessIdentity) => Promise<PlatformProbeEvidence>;
  readonly claimantScan: (processId: number, fingerprint: string) => Promise<ClaimantScanEvidence>;
}

class AdminRecoveryBlockedError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "AdminRecoveryBlockedError";
  }
}

const RELATION_HOST_COMMAND_RE = /(?:^|[\\/\s"'=])(?:launch-node24\.mjs|bridge\.mjs)(?:$|[\s"'])/iu;
const RELATION_WRITER_COMMAND_RE = /(?:^|[\\/\s"'=])(?:launch-node24\.mjs|bridge\.mjs|worker-main\.(?:js|mjs))(?:$|[\s"'])/iu;

function parsePositiveInteger(value: string | undefined, option: string): number {
  if (!value || !/^[1-9]\d*$/u.test(value)) throw new AdminRecoveryBlockedError("invalid_cli_argument", `${option} requires a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AdminRecoveryBlockedError("invalid_cli_argument", `${option} is outside the safe integer range`);
  return parsed;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let execute = false;
  let preflight = false;
  let dataRoot = "";
  let databaseFileName = "bridge.sqlite";
  let operationId = "";
  let taskId = "";
  let attempt = 0;
  let generation = 0;
  let revision = 0;
  let claimId = "";
  let workerIdentityDigest = "";
  let confirmation = "";
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${help()}\n`);
      process.exit(0);
    }
    if (argument === "--execute" || argument === "--preflight") {
      if (seen.has(argument)) throw new AdminRecoveryBlockedError("duplicate_cli_argument");
      seen.add(argument);
      if (argument === "--execute") execute = true;
      else preflight = true;
      continue;
    }
    const valueOptions = new Set([
      "--data-root",
      "--database",
      "--operation-id",
      "--task-id",
      "--attempt",
      "--generation",
      "--revision",
      "--claim-id",
      "--worker-identity-digest",
      "--confirmation",
    ]);
    if (!valueOptions.has(argument)) throw new AdminRecoveryBlockedError("unknown_cli_argument");
    if (seen.has(argument)) throw new AdminRecoveryBlockedError("duplicate_cli_argument");
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AdminRecoveryBlockedError("invalid_cli_argument", `${argument} requires a value`);
    index += 1;
    if (argument === "--data-root") dataRoot = value;
    else if (argument === "--database") databaseFileName = value;
    else if (argument === "--operation-id") operationId = value;
    else if (argument === "--task-id") taskId = value;
    else if (argument === "--attempt") attempt = parsePositiveInteger(value, argument);
    else if (argument === "--generation") generation = parsePositiveInteger(value, argument);
    else if (argument === "--revision") revision = parsePositiveInteger(value, argument);
    else if (argument === "--claim-id") claimId = value;
    else if (argument === "--worker-identity-digest") workerIdentityDigest = value;
    else confirmation = value;
  }
  if (execute === preflight) throw new AdminRecoveryBlockedError("selection_mode_required", "choose exactly one of --preflight or --execute");
  if (!path.isAbsolute(dataRoot) || !operationId || !taskId || attempt < 1 || generation < 1 || revision < 1
    || !claimId || !/^[0-9a-f]{64}$/u.test(workerIdentityDigest)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(databaseFileName)) {
    throw new AdminRecoveryBlockedError("invalid_cli_binding");
  }
  if (execute && confirmation !== `ADMIN-ABANDON:${operationId}`) {
    throw new AdminRecoveryBlockedError("confirmation_mismatch");
  }
  return { execute, preflight, dataRoot, databaseFileName, operationId, taskId, attempt, generation,
    revision, claimId, workerIdentityDigest, confirmation };
}

function help(): string {
  return [
    "Usage:",
    "  node dist/src/cli/admin-abandon-held-operation.js --preflight --data-root <path> --operation-id <id> --task-id <id> --attempt <n> --generation <n> --revision <n> --claim-id <id> --worker-identity-digest <sha256>",
    "  node dist/src/cli/admin-abandon-held-operation.js --execute --confirmation ADMIN-ABANDON:<operation-id> --data-root <path> --operation-id <id> --task-id <id> --attempt <n> --generation <n> --revision <n> --claim-id <id> --worker-identity-digest <sha256>",
    "",
    "This command is intentionally bound to one cleanup_incomplete Hold. It never terminates",
    "processes, creates a Result, or marks Cleanup Verified. Run it only while Codex and all",
    "related Bridge/Worker processes are closed after a Windows restart.",
  ].join("\n");
}

function powershell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 1_000_000 },
      (error, stdout) => {
        if (error) reject(new AdminRecoveryBlockedError("windows_query_failed"));
        else resolve(stdout);
      },
    );
  });
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readWindowsBootTime(): Promise<string> {
  const output = await powershell(
    "$ErrorActionPreference='Stop'; $value=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime(); $value.ToString('o')",
    10_000,
  );
  const parsed = new Date(output.trim());
  if (!Number.isFinite(parsed.getTime())) throw new AdminRecoveryBlockedError("windows_boot_time_unverified");
  if (parsed.getTime() > Date.now() + 300_000) throw new AdminRecoveryBlockedError("windows_boot_time_unverified");
  return parsed.toISOString();
}

async function readProcessInventory(): Promise<readonly ProcessInventoryEntry[]> {
  const output = await powershell(
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ processId=[int]$_.ProcessId; name=[string]$_.Name; commandLine=[string]$_.CommandLine } }) | ConvertTo-Json -Compress",
    15_000,
  );
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new AdminRecoveryBlockedError("process_inventory_unreadable"); }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessInventoryEntry[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") throw new AdminRecoveryBlockedError("process_inventory_invalid");
    const row = value as Record<string, unknown>;
    if (!Number.isSafeInteger(row.processId) || typeof row.name !== "string" || typeof row.commandLine !== "string") {
      throw new AdminRecoveryBlockedError("process_inventory_invalid");
    }
    rows.push({ processId: Number(row.processId), name: row.name, commandLine: row.commandLine });
  }
  return rows;
}

function relatedProcessFacts(rows: readonly ProcessInventoryEntry[]): ProcessInventoryEvidence {
  let hostPresent = false;
  let writerPresent = false;
  let relatedProcessCount = 0;
  for (const row of rows) {
    if (row.processId === process.pid) continue;
    const hostMatch = row.name.toLowerCase() === "codex.exe" || RELATION_HOST_COMMAND_RE.test(row.commandLine);
    const writerMatch = RELATION_WRITER_COMMAND_RE.test(row.commandLine);
    if (hostMatch) hostPresent = true;
    if (writerMatch) writerPresent = true;
    if (hostMatch || writerMatch) relatedProcessCount += 1;
    RELATION_HOST_COMMAND_RE.lastIndex = 0;
    RELATION_WRITER_COMMAND_RE.lastIndex = 0;
  }
  const hostsClosed = !hostPresent;
  const writersClosed = !writerPresent;
  return {
    hostsClosed,
    writersClosed,
    relatedProcessCount,
    digest: digestJson({ hosts_closed: hostsClosed, related_process_count: relatedProcessCount, writers_closed: writersClosed }),
  };
}

function readAllEvents(store: IsolatedAdmissionStore, operationId: string): readonly Readonly<Record<string, unknown>>[] {
  const events: Readonly<Record<string, unknown>>[] = [];
  let afterSequence = 0;
  while (true) {
    const page = store.readLifecycleEvents(operationId, { afterSequence, limit: 200 });
    events.push(...page);
    if (page.length < 200) return events;
    const next = Number(page.at(-1)?.sequence);
    if (!Number.isSafeInteger(next) || next <= afterSequence) throw new AdminRecoveryBlockedError("lifecycle_event_cursor_invalid");
    afterSequence = next;
  }
}

function latestCleanupIncompleteHold(
  events: readonly Readonly<Record<string, unknown>>[],
  claimId: string,
  workerIdentityDigest: string,
): { readonly failedAt: string } {
  let latestAt = "";
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.event_type !== "observation_recorded" || typeof event.evidence_json !== "string") continue;
    let evidence: Record<string, unknown>;
    try { evidence = JSON.parse(event.evidence_json) as Record<string, unknown>; }
    catch { throw new AdminRecoveryBlockedError("cleanup_hold_evidence_invalid"); }
    if (evidence.reason !== "recovery_hold" || evidence.reason_code !== "cleanup_incomplete"
      || evidence.claim_id !== claimId || evidence.worker_identity_digest !== workerIdentityDigest) continue;
    if (typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) {
      throw new AdminRecoveryBlockedError("cleanup_hold_time_invalid");
    }
    if (Date.parse(event.at) >= latestMs) {
      latestMs = Date.parse(event.at);
      latestAt = event.at;
    }
  }
  if (!latestAt) throw new AdminRecoveryBlockedError("cleanup_incomplete_hold_missing");
  return { failedAt: latestAt };
}

async function probeWorkerExit(identity: ProcessIdentity): Promise<PlatformProbeEvidence> {
  const probe = createPlatformProbe({ timeoutMs: 5_000 });
  const verdicts = await probe.probe([{ pid: identity.pid, identity }]);
  const verdict = verdicts.length === 1 ? verdicts[0] : undefined;
  return {
    count: verdicts.length,
    state: typeof verdict?.state === "string" ? verdict.state : null,
  };
}

async function scanWorkerClaimants(processId: number, fingerprint: string): Promise<ClaimantScanEvidence> {
  const scan = await verifyProcessTreeClaimantsClean([{ pid: processId, fingerprint }]);
  return { clean: scan.clean, livePids: scan.livePids, observedPids: scan.observedPids };
}

const defaultAdminRecoveryDependencies: AdminRecoveryDependencies = {
  windowsBootTime: readWindowsBootTime,
  processInventory: readProcessInventory,
  probeWorkerExit,
  claimantScan: scanWorkerClaimants,
};

export async function run(
  options: CliOptions,
  dependencies: AdminRecoveryDependencies = defaultAdminRecoveryDependencies,
): Promise<Readonly<Record<string, unknown>>> {
  if (process.platform !== "win32") throw new AdminRecoveryBlockedError("windows_required");
  const store = IsolatedAdmissionStore.open(options.dataRoot, {
    databaseFileName: options.databaseFileName,
    managedDataDirectory: true,
  });
  try {
    const operation = store.readOperation(options.operationId);
    if (!operation) throw new AdminRecoveryBlockedError("operation_not_found");
    if (operation.operation_kind !== "attempt_lifecycle" || operation.task_id !== options.taskId
      || operation.attempt !== options.attempt || operation.generation !== options.generation
      || operation.claim_id !== options.claimId
      || operation.claim_worker_identity_digest !== options.workerIdentityDigest) {
      throw new AdminRecoveryBlockedError("operation_binding_mismatch");
    }
    const hold = latestCleanupIncompleteHold(readAllEvents(store, options.operationId), options.claimId, options.workerIdentityDigest);
    const bootTime = await dependencies.windowsBootTime();
    if (Date.parse(bootTime) <= Date.parse(hold.failedAt)) {
      throw new AdminRecoveryBlockedError("post_failure_restart_unverified");
    }
    const initialProcesses = relatedProcessFacts(await dependencies.processInventory());
    if (!initialProcesses.hostsClosed || !initialProcesses.writersClosed) {
      throw new AdminRecoveryBlockedError("host_or_writer_still_running");
    }

    let worker: Record<string, unknown>;
    let launch: Record<string, unknown>;
    try {
      worker = JSON.parse(String(operation.claim_worker_identity_json)) as Record<string, unknown>;
      launch = JSON.parse(String(operation.launch_identity_json)) as Record<string, unknown>;
    } catch {
      throw new AdminRecoveryBlockedError("worker_identity_unreadable");
    }
    if (!Number.isSafeInteger(worker.process_id) || Number(worker.process_id) < 1
      || typeof worker.start_fingerprint !== "string" || worker.start_fingerprint.length === 0
      || worker.source !== "manager_verified_process_probe" || worker.fixture !== false
      || worker.platform !== "win32" || worker.fingerprint_precision !== "exact"
      || launch.source !== "manager_os_spawn_observation" || launch.fixture !== false
      || launch.platform !== "win32" || launch.fingerprint_precision !== "exact"
      || launch.process_id !== worker.process_id || launch.start_fingerprint !== worker.start_fingerprint) {
      throw new AdminRecoveryBlockedError("worker_identity_invalid");
    }
    const processId = Number(worker.process_id);
    const fingerprint = String(worker.start_fingerprint);
    const identity: ProcessIdentity = {
      pid: processId,
      fingerprint,
      fingerprint_precision: "exact",
      identity_version: PROCESS_IDENTITY_VERSION,
      platform: "win32",
      captured_at: typeof worker.captured_at === "string" ? worker.captured_at : "",
    };
    const probeEvidence = await dependencies.probeWorkerExit(identity);
    if (probeEvidence.count !== 1 || probeEvidence.state !== "exited") {
      throw new AdminRecoveryBlockedError("worker_exit_unverified");
    }
    let claimantScan;
    try { claimantScan = await dependencies.claimantScan(processId, fingerprint); }
    catch { throw new AdminRecoveryBlockedError("claimant_scan_failed"); }
    if (!claimantScan.clean || claimantScan.livePids.length !== 0) {
      throw new AdminRecoveryBlockedError("claimant_scan_not_clean");
    }

    // Recheck the exclusion fence immediately before the single CAS write.
    const finalProcesses = relatedProcessFacts(await dependencies.processInventory());
    if (!finalProcesses.hostsClosed || !finalProcesses.writersClosed) {
      throw new AdminRecoveryBlockedError("host_or_writer_started_during_preflight");
    }
    const processInventoryDigest = digestJson({
      final: finalProcesses.digest,
      initial: initialProcesses.digest,
    });
    const platformProbeDigest = digestJson({
      probe: probeEvidence,
      worker_identity_digest: options.workerIdentityDigest,
    });
    const observedPidSetDigest = digestJson([...claimantScan.observedPids].sort((left, right) => left - right));
    const claimantScanDigest = digestJson({
      clean: claimantScan.clean,
      live_pid_count: claimantScan.livePids.length,
      observed_pid_count: claimantScan.observedPids.length,
      observed_pid_set_digest: observedPidSetDigest,
    });
    const observedAt = new Date().toISOString();
    const evidence = {
      boot_time: bootTime,
      claimant_scan_clean: true,
      claimant_scan_digest: claimantScanDigest,
      failed_at: hold.failedAt,
      hosts_closed: true,
      observed_at: observedAt,
      platform_probe_digest: platformProbeDigest,
      process_inventory_digest: processInventoryDigest,
      worker_exited: true,
      worker_process_id: processId,
      worker_start_fingerprint: fingerprint,
      writer_closed: true,
    };
    if (!options.execute) {
      return {
        status: "preflight_ok",
        operation_id: options.operationId,
        task_id: options.taskId,
        attempt: options.attempt,
        generation: options.generation,
        revision: options.revision,
        worker_exited: true,
        claimant_scan_clean: true,
        hosts_closed: true,
        writer_closed: true,
        post_failure_restart_verified: true,
        claimant_scan_digest: claimantScanDigest,
        platform_probe_digest: platformProbeDigest,
        process_inventory_digest: processInventoryDigest,
      };
    }
    const result = store.adminAbandonHeldOperation({
      operation_id: options.operationId,
      task_id: options.taskId,
      attempt: options.attempt,
      generation: options.generation,
      revision: options.revision,
      claim_id: options.claimId,
      claim_worker_identity_digest: options.workerIdentityDigest,
      evidence,
    });
    return {
      ...result,
      result_absent: true,
      cleanup_verified: false,
      administration_kind: "admin_abandoned",
      claimant_scan_digest: claimantScanDigest,
      platform_probe_digest: platformProbeDigest,
      process_inventory_digest: processInventoryDigest,
    };
  } finally {
    store.close();
  }
}

export async function executeCli(
  argv: readonly string[],
  dependencies: AdminRecoveryDependencies = defaultAdminRecoveryDependencies,
): Promise<Readonly<Record<string, unknown>>> {
  return run(parseArgs(argv), dependencies);
}

async function main(): Promise<void> {
  const result = await executeCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isEntry = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "admin_recovery_failed";
    process.stderr.write(`${JSON.stringify({ status: "blocked", error_code: code })}\n`);
    process.exitCode = 1;
  });
}
