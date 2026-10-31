// Worker process shell (ARCHITECTURE component 6): one detached Bridge worker
// per active task. Uses the app-server adapter and persists progress/results
// so MCP server restarts do not erase task evidence.
//
// Usage: node worker-main.js <dataRoot> <taskId>
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { BRIDGE_WORKER_LAUNCH_MARKER, fingerprintRuntimeArtifact, verifyWorkerProvenance } from "../runtime/build-provenance.js";
import { validateHostProfile, type BridgeHostProfile } from "../host/profile.js";
import { activateWorkerJsonWriter, jsonWriterParticipationRequired, releaseWorkerJsonWriter } from "../store/json-writer-quiescence.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import type { TaskPackage, WorkspaceRef } from "../interfaces.js";
import type {
  CandidateExecutionCleanupProof,
  CandidateTaskResult,
  CandidateWorkerResultFrame,
} from "../sqlite-candidate/wp6c/fake-result-adapter.js";

const workerArgs = process.argv.slice(2);
const bridgeLaunchMarker = workerArgs.at(-1) === BRIDGE_WORKER_LAUNCH_MARKER;
const interactionMode = workerArgs.includes("--bridge-sqlite-interaction-v1");
const dropAfterPrepared = workerArgs.includes("--bridge-sqlite-interaction-drop-after-prepared-v1");
const positionalArgs = bridgeLaunchMarker ? workerArgs.slice(0, -1).filter(argument =>
  argument !== "--bridge-sqlite-interaction-v1" && argument !== "--bridge-sqlite-interaction-drop-after-prepared-v1") : workerArgs;
if (bridgeLaunchMarker && positionalArgs.length === 0) {
  let claimOnlyStage = "start";
  let interactionStreamsCreated = false;
  try {
    if (dropAfterPrepared && !interactionMode) throw new Error("interaction test mode required");
    await runClaimOnlyHandshake({ interactionMode, dropAfterPrepared, onStage: (stage) => {
      claimOnlyStage = stage;
      // The interaction harness uses only fixed diagnostic stage labels; it
      // never writes Bootstrap, identity, request, or token values to stderr.
      if (interactionMode) process.stderr.write(`[bridge-worker] claim-only stage=${stage}\n`);
    }, onInteractionStreamsCreated: () => { interactionStreamsCreated = true; } });
    process.exitCode = 0;
  } catch (error) {
    // Do not print a Bootstrap or token-derived value. A Claim-only Worker has
    // no Adapter/TaskStore path and exits closed on every invalid handshake.
    if (interactionMode && !interactionStreamsCreated) {
      // Inherited interaction pipes are owned by this test-only harness. Close
      // them on every failure so setting exitCode cannot leave a detached
      // Worker alive solely because its unused descriptors remain open.
      for (const fd of [7, 8, 9]) {
        try { closeSync(fd); } catch { /* descriptor may already be closed */ }
      }
    }
    const failureCode = error && typeof error === "object" && "code" in error
      && typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code : "unclassified";
    console.error(`[bridge-worker] claim-only handshake rejected${interactionMode ? ` at ${claimOnlyStage} code=${failureCode}` : ""}`);
    process.exitCode = 3;
  }
} else {
  const [dataRoot, taskId, attemptText] = positionalArgs;
  if (positionalArgs.length !== 3 || !dataRoot || !taskId || !attemptText || !/^[1-9]\d*$/u.test(attemptText) || !Number.isSafeInteger(Number(attemptText))) {
    console.error("usage: node worker-main.js <dataRoot> <taskId> <attempt>");
    process.exit(2);
  }

  try {
    // Keep the JSON TaskStore/Adapter graph lazy: the isolated Claim-only
    // branch above must never load or enter it.
    const leaseToken = process.env["ZCODE_BRIDGE_JSON_WRITER_LEASE"];
    const writerQuiescence = jsonWriterParticipationRequired(dataRoot);
    if (writerQuiescence && !leaseToken) throw new Error("JSON writer participant lease is required");
    const probe = writerQuiescence ? createPlatformProbe() : undefined;
    let leaseActivated = false;
    try {
      if (leaseToken && probe) {
        const identity = await probe.selfIdentity();
        await activateWorkerJsonWriter(dataRoot, leaseToken, taskId, Number(attemptText), identity);
        leaseActivated = true;
      }
      const { runWorkerTask } = await import("./run-task.js");
      const hostText = process.env["ZCODE_BRIDGE_HOST_PROFILE"];
      const host = hostText ? validateHostProfile(JSON.parse(hostText) as BridgeHostProfile) : undefined;
      const rawEnvelope = process.env["ZCODE_BRIDGE_RUNTIME_PROVENANCE"];
      const worker = fingerprintRuntimeArtifact(process.argv[1]);
      const { status } = await runWorkerTask({
        dataRoot,
        taskId,
        host,
        attempt: Number(attemptText),
        probe,
        writerQuiescence,
        writerLeaseToken: leaseToken,
        runtimeProvenance: { bridgeLaunchMarker, rawEnvelope, worker },
      });
      process.exitCode = 0;
      void status;
    } finally {
      if (leaseActivated && leaseToken) await releaseWorkerJsonWriter(dataRoot, leaseToken);
    }
  } catch (error) {
    // Store-level or unexpected failure: leave the record for the manager to
    // reconcile to worker_lost on restart.
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runClaimOnlyHandshake(options: { readonly interactionMode: boolean; readonly dropAfterPrepared: boolean;
  readonly onStage?: (stage: string) => void; readonly onInteractionStreamsCreated?: () => void }): Promise<void> {
  options.onStage?.("provenance verification");
  if (process.argv.at(-1) !== BRIDGE_WORKER_LAUNCH_MARKER) throw new Error("launch marker required");
  const rawEnvelope = process.env["ZCODE_BRIDGE_RUNTIME_PROVENANCE"];
  const worker = fingerprintRuntimeArtifact(process.argv[1]);
  const provenance = verifyWorkerProvenance({ bridgeLaunchMarker: true, rawEnvelope, actualWorker: worker });
  if (provenance.status !== "verified") throw new Error("worker provenance rejected");

  options.onStage?.("bootstrap read");
  const frame = readPrivateFrame(3, 8_192);
  options.onStage?.("bootstrap decode");
  const { decodeLaunchBootstrap } = await import("../sqlite-candidate/wp6b2b1/launch-bootstrap.js");
  const bootstrap = decodeLaunchBootstrap(frame);
  options.onStage?.("execution profile validation");
  const { resolveTrustedLocalExecutionProfile } = await import("../runtime/trusted-local-profile.js");
  const profile = resolveTrustedLocalExecutionProfile(bootstrap.execution_profile_id);
  if (!profile || profile.sessionMode !== "build" || profile.unrestricted !== false) throw new Error("worker execution profile rejected");
  options.onStage?.("process probe module load");
  const { createPlatformProbe } = await import("../runtime/process-probe.js");
  options.onStage?.("process probe initialization");
  // Match the bounded Windows identity budget used by the isolated launch
  // identity verifier. Unknown identity still fails closed at the limit.
  const probe = createPlatformProbe({ timeoutMs: 10_000 });
  options.onStage?.("identity platform check");
  if (probe.platform !== "win32") throw new Error("claim-only identity requires verified Windows process identity");
  options.onStage?.("process identity probe");
  const identity = await probe.identityOf(process.pid);
  options.onStage?.("process identity validation");
  if (identity.platform !== "win32" || identity.fingerprint_precision !== "exact"
    || typeof identity.fingerprint !== "string" || !identity.fingerprint) {
    options.onStage?.(`process identity rejected platform=${identity.platform} precision=${identity.fingerprint_precision} fingerprint=${identity.fingerprint ? "present" : "missing"}`);
    throw new Error("worker identity unavailable");
  }

  const report = {
    worker_id: randomUUID(),
    operation_id: bootstrap.operation_id,
    task_id: bootstrap.task_id,
    attempt: bootstrap.attempt,
    launch_id: bootstrap.launch_id,
    launch_epoch: bootstrap.launch_epoch,
    generation: bootstrap.generation,
    process_id: process.pid,
    start_fingerprint: identity.fingerprint,
    authorization_source: bootstrap.authorization_source,
    workspace_ref: bootstrap.workspace_ref,
    policy_revision: bootstrap.policy_revision,
    policy_digest: bootstrap.policy_digest,
    execution_profile_id: bootstrap.execution_profile_id,
    execution_mode: profile.sessionMode,
    unrestricted: profile.unrestricted,
    policy_snapshot_digest: bootstrap.policy_snapshot_digest,
    provenance_digest: digestProvenance(provenance.expected),
  };
  options.onStage?.("identity report write");
  writePrivateFrame(4, report);
  options.onStage?.("Claim decision read");
  const decision = readPrivateFrame(5, 1_100_000);
  const value = JSON.parse(decision.subarray(0, -1).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("claim was not committed");
  const decisionRecord = value as Record<string, unknown>;
  const decisionKeys = Object.keys(decisionRecord).sort().join("|");
  if (decisionKeys !== "execution|protocol|state") throw new Error("claim decision fields rejected");
  if (decisionRecord.protocol !== "bridge-claim-decision-v1" || decisionRecord.state !== "claim_committed") {
    throw new Error("claim was not committed");
  }
  const execution = validateExecutionEnvelope(decisionRecord.execution, bootstrap, profile);

  let closeInteraction: (() => Promise<void>) | undefined;
  let candidateInteraction: Awaited<ReturnType<typeof import("../sqlite-candidate/wp6b2b1/interaction-channel.mjs").createCandidateWorkerInteractionChannel>> | undefined;
  if (options.interactionMode) {
    options.onStage?.("interaction channel setup");
    const { createCandidateWorkerInteractionChannel } = await import("../sqlite-candidate/wp6b2b1/interaction-channel.mjs");
    // The supplied descriptors are already-open inherited pipes; the path
    // argument is only the stream API's required placeholder and is not opened.
    const requestStream = createWriteStream(process.execPath, { fd: 7 });
    const replyStream = new Socket({ fd: 8, readable: true, writable: false });
    const acknowledgementStream = createWriteStream(process.execPath, { fd: 9 });
    const streams = [requestStream, replyStream, acknowledgementStream];
    options.onInteractionStreamsCreated?.();
    closeInteraction = () => closeOwnedStreams(streams);
    let interaction: Awaited<ReturnType<typeof createCandidateWorkerInteractionChannel>> | undefined;
    try {
      interaction = await createCandidateWorkerInteractionChannel({
        requestStream,
        replyStream,
        ackStream: acknowledgementStream,
        processId: process.pid,
        verifySelfIdentity: async ({ processId, expected }: { readonly processId: number; readonly expected: { readonly start_fingerprint: string } }) => {
          // Reuse the exact OS identity captured before the Worker report. A
          // running process cannot change its own PID generation; the Manager
          // independently re-probes it before each channel transition.
          return identity.pid === processId && processId === process.pid && identity.platform === "win32"
            && identity.fingerprint_precision === "exact" && identity.fingerprint === expected.start_fingerprint
            ? { state: "verified", process_id: identity.pid, start_fingerprint: identity.fingerprint } : false;
        },
        onStage: (stage: string) => options.onStage?.(stage),
      });
      candidateInteraction = interaction;
      closeInteraction = () => interaction!.close();
      if (execution.adapter_mode === "test_fake" && options.interactionMode) {
        const requestId = `synthetic-interaction-${bootstrap.operation_id}`;
        options.onStage?.("interaction request delivery");
        await interaction.sendRequest({ method: "interaction/requestUserInput", request_id: requestId,
          params: { questions: [{ question: "Synthetic interaction response" }] } });
        if (options.dropAfterPrepared) process.exit(0);
        options.onStage?.("committed interaction reply acceptance");
        await interaction.acceptCommittedReply();
      }
    } catch (error) {
      await closeInteraction();
      throw error;
    }
  }

  try {
    options.onStage?.(execution.adapter_mode === "test_fake" ? "test adapter start" : "zcode adapter start");
    const resultFrame = execution.adapter_mode === "test_fake"
      ? await runExplicitFakeAdapter(bootstrap, execution, candidateInteraction)
      : await runZCodeAdapter(bootstrap, execution, candidateInteraction);
    options.onStage?.("adapter result frame prepared");
    writePrivateFrame(6, resultFrame);
    options.onStage?.("adapter result frame written");
  } finally {
    // The Manager closes its interaction endpoints after observing the result.
    // Emit the result first so Worker shutdown does not wait on its own peer.
    options.onStage?.("worker interaction close start");
    await closeInteraction?.();
    options.onStage?.("worker interaction close complete");
    options.onStage?.(`worker active resources ${process.getActiveResourcesInfo().join(",")}`);
  }
}

interface SqliteExecutionEnvelope {
  readonly protocol: "bridge-sqlite-execution-envelope-v1";
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly workspace_ref: string;
  readonly policy_snapshot_digest: string;
  readonly execution_profile_id: string;
  readonly adapter_mode: "zcode_app_server" | "test_fake";
  readonly task: TaskPackage;
  readonly host_profile: BridgeHostProfile;
  readonly continuation: Readonly<Record<string, unknown>> | null;
  readonly previous_result: CandidateTaskResult | null;
}

function validateExecutionEnvelope(value: unknown, bootstrap: {
  readonly operation_id: string; readonly task_id: string; readonly attempt: number; readonly generation: number;
  readonly workspace_ref: string; readonly execution_profile_id: string; readonly policy_snapshot_digest: string;
}, profile: { readonly id: string; readonly sessionMode: "build"; readonly unrestricted: false }): SqliteExecutionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("post-Claim execution envelope is required");
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join("|") !== "adapter_mode|attempt|continuation|execution_profile_id|generation|host_profile|operation_id|policy_snapshot_digest|previous_result|protocol|task|task_id|workspace_ref"
    || envelope.protocol !== "bridge-sqlite-execution-envelope-v1"
    || envelope.operation_id !== bootstrap.operation_id || envelope.task_id !== bootstrap.task_id
    || envelope.attempt !== bootstrap.attempt || envelope.generation !== bootstrap.generation
    || envelope.workspace_ref !== bootstrap.workspace_ref || envelope.policy_snapshot_digest !== bootstrap.policy_snapshot_digest
    || envelope.execution_profile_id !== profile.id || !["zcode_app_server", "test_fake"].includes(String(envelope.adapter_mode))) {
    throw new Error("post-Claim execution envelope binding rejected");
  }
  const task = envelope.task as TaskPackage | null;
  if (!task || typeof task !== "object" || task.task_id !== bootstrap.task_id
    || typeof task.workspace !== "string" || !Array.isArray(task.requirements)
    || !Array.isArray(task.allowed_paths) || !Array.isArray(task.forbidden_paths)
    || !Array.isArray(task.acceptance_criteria) || !Array.isArray(task.test_commands)
    || typeof task.objective !== "string" || task.model && typeof task.model !== "object") {
    throw new Error("post-Claim TaskPackage rejected");
  }
  if (!envelope.host_profile || typeof envelope.host_profile !== "object" || Array.isArray(envelope.host_profile)) {
    throw new Error("post-Claim Host profile is required");
  }
  validateHostProfile(envelope.host_profile as BridgeHostProfile);
  return envelope as unknown as SqliteExecutionEnvelope;
}

async function runExplicitFakeAdapter(
  bootstrap: { readonly operation_id: string; readonly task_id: string; readonly attempt: number; readonly generation: number; readonly workspace_ref: string; readonly policy_snapshot_digest: string },
  execution: SqliteExecutionEnvelope,
  interaction: Awaited<ReturnType<typeof import("../sqlite-candidate/wp6b2b1/interaction-channel.mjs").createCandidateWorkerInteractionChannel>> | undefined,
): Promise<CandidateWorkerResultFrame> {
  if (execution.adapter_mode !== "test_fake") throw new Error("fake Adapter is restricted to explicit test mode");
  if (interaction && execution.task.task_id !== bootstrap.task_id) throw new Error("test Adapter task binding mismatch");
  const { executeFakeResultAdapter } = await import("../sqlite-candidate/wp6c/fake-result-adapter.js");
  return executeFakeResultAdapter(bootstrap as Parameters<typeof executeFakeResultAdapter>[0]);
}

async function runZCodeAdapter(
  bootstrap: { readonly operation_id: string; readonly task_id: string; readonly attempt: number; readonly generation: number; readonly workspace_ref: string; readonly policy_snapshot_digest: string },
  execution: SqliteExecutionEnvelope,
  interaction: Awaited<ReturnType<typeof import("../sqlite-candidate/wp6b2b1/interaction-channel.mjs").createCandidateWorkerInteractionChannel>> | undefined,
): Promise<CandidateWorkerResultFrame> {
  if (execution.adapter_mode !== "zcode_app_server") throw new Error("real ZCode Adapter mode is required");
  const { ZCodeAppServerAdapter } = await import("../adapters/zcode-app-server-adapter.js");
  const { buildTaskResult } = await import("../manager/normalize.js");
  const startedAt = new Date().toISOString();
  let outcome: import("../adapters/zcode-adapter.js").ZCodeRunOutcome | null = null;
  let failure: { code: string; message: string } | null = null;
  const adapter = new ZCodeAppServerAdapter({
    host: execution.host_profile,
    executionProfileId: execution.execution_profile_id,
    onEvent: () => undefined,
    resolveInteraction: interaction ? async (request, signal) => {
      if (signal.aborted) return { action: "decline" };
      await interaction.sendRequest(request);
      if (signal.aborted) return { action: "decline" };
      return (await interaction.acceptCommittedReply()).answer;
    } : undefined,
  });
  try {
    const workspace: WorkspaceRef = {
      requestedPath: execution.task.workspace,
      canonicalPath: bootstrap.workspace_ref,
      mode: execution.task.worktree_path ? "worktree" : "direct",
      ...(execution.task.worktree_path ? { sourcePath: execution.task.workspace } : {}),
    };
    const handle = execution.continuation
      ? await adapter.continueTask({
          task: execution.task,
          workspace,
          attempt: bootstrap.attempt,
          feedback: requiredString(execution.continuation.feedback, "continuation feedback missing"),
          additionalRequirements: requiredStringArray(execution.continuation.additional_requirements, "continuation requirements invalid"),
          previousSessionId: nullableString(execution.previous_result?.session_id),
          previousResult: execution.previous_result as import("../interfaces.js").TaskResult | null,
        })
      : await adapter.startTask({ task: execution.task, workspace, attempt: bootstrap.attempt });
    outcome = await adapter.getResult(handle);
    if (outcome.cleanupError) failure = { code: "cleanup_failed", message: outcome.cleanupError };
  } catch (error) {
    failure = { code: error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code : "worker_error", message: error instanceof Error ? error.message : String(error) };
  }
  const finishedAt = new Date().toISOString();
  const taskResult = buildTaskResult({ task: execution.task, attempt: bootstrap.attempt, startedAt, finishedAt, outcome, failure });
  const result: CandidateTaskResult = {
    task_id: taskResult.task_id,
    attempt: taskResult.attempt,
    status: taskResult.status,
    summary: taskResult.summary,
    files_changed: taskResult.files_changed,
    tests: taskResult.tests,
    issues: taskResult.issues,
    needs_master_decision: taskResult.needs_master_decision,
    zcode_output: taskResult.zcode_output,
    exit_code: taskResult.exit_code,
    session_id: taskResult.session_id,
    started_at: taskResult.started_at,
    finished_at: taskResult.finished_at,
    ...(taskResult.usage !== undefined ? { usage: taskResult.usage as Record<string, unknown> | null } : {}),
    ...(taskResult.model !== undefined ? { model: taskResult.model as Record<string, unknown> | null } : {}),
    ...(taskResult.timing !== undefined ? { timing: taskResult.timing as Record<string, unknown> | null } : {}),
    ...(taskResult.error_code ? { error_code: taskResult.error_code } : {}),
    ...(taskResult.report_candidate ? { report_candidate: taskResult.report_candidate as Record<string, unknown> } : {}),
  };
  const executionCleanup = buildExecutionCleanupProof(outcome);
  return {
    protocol: "bridge-sqlite-candidate-result-v1",
    operation_id: bootstrap.operation_id,
    task_id: bootstrap.task_id,
    attempt: bootstrap.attempt,
    generation: bootstrap.generation,
    workspace_ref: bootstrap.workspace_ref,
    policy_snapshot_digest: bootstrap.policy_snapshot_digest,
    execution_cleanup_verified: executionCleanup !== null,
    execution_cleanup: executionCleanup,
    result,
  };
}

function buildExecutionCleanupProof(
  outcome: import("../adapters/zcode-adapter.js").ZCodeRunOutcome | null,
): CandidateExecutionCleanupProof | null {
  const receipt = outcome?.cleanupTreeReceipt;
  if (outcome?.cleanupVerified !== true || outcome.cleanupError || !receipt) return null;
  const root = receipt.members.find((member) => member.pid === receipt.rootPid);
  if (!root || !root.fingerprint || receipt.members.length < 1
    || !Number.isSafeInteger(receipt.rootPid) || receipt.rootPid < 1) return null;
  return {
    contract: "candidate-execution-cleanup-proof-v1",
    source: "zcode_app_server_adapter",
    method: "identity_bound_windows_tree_cleanup",
    complete: true,
    workspace_retained: true,
    adapter_process_id: receipt.rootPid,
    adapter_start_fingerprint: root.fingerprint,
    process_tree_receipt_digest: createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex"),
    process_tree_member_count: receipt.members.length,
    managed_browser_cleanup_verified: true,
  };
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(error);
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

function requiredStringArray(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(error);
  return [...value];
}

function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }

async function closeOwnedStreams(streams: ReadonlyArray<{ readonly closed: boolean; destroy(): unknown; once(event: "close", listener: () => void): unknown }>): Promise<void> {
  await Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
    if (stream.closed) { resolve(); return; }
    stream.once("close", resolve);
    stream.destroy();
  })));
}

function digestProvenance(value: { readonly bridge: { readonly path: string | null; readonly sha256: string | null }; readonly worker: { readonly path: string | null; readonly sha256: string | null } }): string {
  const canonical = JSON.stringify({
    bridge: { path: value.bridge.path, sha256: value.bridge.sha256 },
    worker: { path: value.worker.path, sha256: value.worker.sha256 },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function readPrivateFrame(fd: number, maximum: number): Buffer {
  const frame = readFileSync(fd);
  closeSync(fd);
  if (frame.byteLength > maximum) throw new Error("private frame exceeded limit");
  return frame;
}

function writePrivateFrame(fd: number, value: unknown): void {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  writeFileSync(fd, frame);
  closeSync(fd);
}
