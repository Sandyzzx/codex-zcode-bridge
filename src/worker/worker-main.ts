// Worker process shell (ARCHITECTURE component 6): one detached Bridge worker
// per active task. Uses the app-server adapter and persists progress/results
// so MCP server restarts do not erase task evidence.
//
// Usage: node worker-main.js <dataRoot> <taskId>
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createWriteStream, readFileSync, writeFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { BRIDGE_WORKER_LAUNCH_MARKER, fingerprintRuntimeArtifact, verifyWorkerProvenance } from "../runtime/build-provenance.js";
import { validateHostProfile, type BridgeHostProfile } from "../host/profile.js";
import { activateWorkerJsonWriter, jsonWriterParticipationRequired, releaseWorkerJsonWriter } from "../store/json-writer-quiescence.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { StartPlanSecretRedactor } from "../runtime/start-plan-secret-redactor.js";
import type { TaskPackage, WorkspaceRef } from "../interfaces.js";
import type {
  CandidateExecutionCleanupProof,
  CandidateTaskResult,
  CandidateWorkerResultFrame,
} from "../sqlite-candidate/wp6c/fake-result-adapter.js";

const workerArgs = process.argv.slice(2);
const bridgeLaunchMarker = workerArgs.at(-1) === BRIDGE_WORKER_LAUNCH_MARKER;
const interactionMode = workerArgs.includes("--bridge-sqlite-interaction-v1");
const privateAuthMode = workerArgs.includes("--bridge-sqlite-private-auth-v1");
const dropAfterPrepared = workerArgs.includes("--bridge-sqlite-interaction-drop-after-prepared-v1");
const positionalArgs = bridgeLaunchMarker ? workerArgs.slice(0, -1).filter(argument =>
  argument !== "--bridge-sqlite-interaction-v1" && argument !== "--bridge-sqlite-interaction-drop-after-prepared-v1" && argument !== "--bridge-sqlite-private-auth-v1") : workerArgs;
if (bridgeLaunchMarker && positionalArgs.length === 0) {
  let claimOnlyStage = "start";
  let interactionStreamsCreated = false;
  // CI evidence: the Worker once died silently with exit code 1 after the
  // Result frame was written. Worker stderr is a pipe here, so the default
  // fatal report is an async write that can be truncated by the immediate
  // exit. Flush a bounded, sanitized reason synchronously and keep the same
  // exit-code semantics the Manager verifies.
  const writeFatalDiagnostic = (origin: string, error: unknown): void => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const frames = error instanceof Error && typeof error.stack === "string"
      ? error.stack.split("\n").slice(1, 6).join("\n") : "";
    writeDiagnostic(`[bridge-worker] fatal ${origin} at ${claimOnlyStage}: ${message.slice(0, 300)}\n${frames.slice(0, 1_200)}\n`);
  };
  const reallyExit = (process as NodeJS.Process & { reallyExit(code?: number): void }).reallyExit.bind(process);
  process.on("exit", (code) => {
    // Keep the final lifecycle marker synchronous: Manager-side result and
    // close decisions depend on the process exit code, not on async stderr.
    writeDiagnostic(`[bridge-worker] exit code=${String(code)}\n`);
  });
  process.on("uncaughtException", (error) => { writeFatalDiagnostic("uncaught_exception", error); reallyExit(1); });
  process.on("unhandledRejection", (reason) => { writeFatalDiagnostic("unhandled_rejection", reason); reallyExit(1); });
  try {
    if (dropAfterPrepared && !interactionMode) throw new Error("interaction test mode required");
    await runClaimOnlyHandshake({ interactionMode, privateAuthMode, dropAfterPrepared, onStage: (stage) => {
      claimOnlyStage = stage;
      // The interaction harness uses only fixed diagnostic stage labels; it
      // never writes Bootstrap, identity, request, or token values to stderr.
      if (interactionMode) writeDiagnostic(`[bridge-worker] claim-only stage=${stage}\n`);
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
    if (privateAuthMode) for (const fd of [10, 11, 12, 13]) { try { closeSync(fd); } catch { /* already closed */ } }
    const failureCode = error && typeof error === "object" && "code" in error
      && typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code : "unclassified";
    writeDiagnostic(`[bridge-worker] claim-only handshake rejected${interactionMode ? ` at ${claimOnlyStage} code=${failureCode}` : ""}\n`);
    process.exitCode = 3;
  }
  // At this point the Result frame has been written synchronously and owned
  // interaction streams are closed. CI repeatedly showed that relying on the
  // event loop to drain can leave teardown handles alive (or expose the idle
  // Worker to a cleanup race), so exit deterministically with the same code
  // the Manager already verifies.
  process.exit(process.exitCode ?? 0);
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

async function runClaimOnlyHandshake(options: { readonly interactionMode: boolean; readonly privateAuthMode: boolean; readonly dropAfterPrepared: boolean;
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
  if (!profile || profile.sessionMode !== "yolo" || profile.unrestricted !== false) throw new Error("worker execution profile rejected");
  options.onStage?.("process probe module load");
  const { createPlatformProbe } = await import("../runtime/process-probe.js");
  options.onStage?.("process probe initialization");
  // Match the bounded Windows identity budget used by the isolated launch
  // identity verifier. Unknown identity still fails closed at the limit.
  let processProbeFailure: string | undefined;
  const probe = createPlatformProbe({
    timeoutMs: 10_000,
    onWindowsQueryFailure: (reason) => { processProbeFailure = reason; },
  });
  options.onStage?.("identity platform check");
  if (probe.platform !== "win32") throw new Error("claim-only identity requires verified Windows process identity");
  options.onStage?.("process identity probe");
  const identity = await probe.identityOf(process.pid);
  options.onStage?.("process identity validation");
  if (identity.platform !== "win32" || identity.fingerprint_precision !== "exact"
    || typeof identity.fingerprint !== "string" || !identity.fingerprint) {
    options.onStage?.(`process identity rejected platform=${identity.platform} precision=${identity.fingerprint_precision} fingerprint=${identity.fingerprint ? "present" : "missing"}`);
    const error = new Error("worker identity unavailable") as Error & { code?: string };
    error.code = `worker_identity_${processProbeFailure ?? "unknown"}`;
    throw error;
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
  if (options.privateAuthMode !== Boolean(execution.private_auth)) throw new Error("private auth mode mismatch");

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
      : await runZCodeAdapter(bootstrap, execution, candidateInteraction, options.privateAuthMode ? identity : undefined);
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
  readonly private_auth?: {
    readonly account: string;
    readonly claim: string;
    readonly provider: "account:bigmodel-start-plan";
    readonly model: string;
    readonly entitled: boolean;
  };
}

function validateExecutionEnvelope(value: unknown, bootstrap: {
  readonly operation_id: string; readonly task_id: string; readonly attempt: number; readonly generation: number;
  readonly workspace_ref: string; readonly execution_profile_id: string; readonly policy_snapshot_digest: string;
}, profile: { readonly id: string; readonly sessionMode: "yolo"; readonly unrestricted: false }): SqliteExecutionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("post-Claim execution envelope is required");
  const envelope = value as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope).sort().join("|");
  if (!["adapter_mode|attempt|continuation|execution_profile_id|generation|host_profile|operation_id|policy_snapshot_digest|previous_result|protocol|task|task_id|workspace_ref", "adapter_mode|attempt|continuation|execution_profile_id|generation|host_profile|operation_id|policy_snapshot_digest|previous_result|private_auth|protocol|task|task_id|workspace_ref"].includes(envelopeKeys)
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
  if (envelope.private_auth !== undefined) {
    const auth = envelope.private_auth as Record<string, unknown> | null;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)
      || Object.keys(auth).sort().join("|") !== "account|claim|entitled|model|provider"
      || typeof auth.account !== "string" || !auth.account || typeof auth.claim !== "string" || !auth.claim
      || auth.provider !== "account:bigmodel-start-plan" || typeof auth.model !== "string" || !auth.model
      || typeof auth.entitled !== "boolean"
      || task.model?.provider_id !== auth.provider || task.model.model_id !== auth.model) {
      throw new Error("private auth binding rejected");
    }
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
  workerIdentity?: import("../runtime/process-probe.js").ProcessIdentity,
): Promise<CandidateWorkerResultFrame> {
  if (execution.adapter_mode !== "zcode_app_server") throw new Error("real ZCode Adapter mode is required");
  const { ZCodeAppServerAdapter } = await import("../adapters/zcode-app-server-adapter.js");
  const { buildTaskResult } = await import("../manager/normalize.js");
  const startedAt = new Date().toISOString();
  let outcome: import("../adapters/zcode-adapter.js").ZCodeRunOutcome | null = null;
  let failureCleanupReceipt: import("../adapters/windows-process-cleanup.js").WindowsTerminationReceipt | null = null;
  let failure: { code: string; message: string } | null = null;
  let cachedAuth: { readonly apiKey: string; readonly expiresAt: number; readonly sessionId: string; readonly turnId: string; readonly providerId: string; readonly modelId: string } | null = null;
  let privateAuthExpiryTimer: NodeJS.Timeout | undefined;
  let privateAuthStarted = false;
  const secretRedactor = execution.private_auth ? new StartPlanSecretRedactor() : undefined;
  let privateAuthParentLive = false;
  let privateAuthConfirmed = false;
  let notifyPrivateAuthConfirmation: (() => void) | undefined;
  const privateAuthLifetime = execution.private_auth ? new Socket({ fd: 13, readable: true, writable: false }) : undefined;
  privateAuthLifetime?.on("data", (chunk: Buffer) => {
    for (const byte of chunk) {
      if (!privateAuthParentLive && !privateAuthConfirmed && byte === 1) privateAuthParentLive = true;
      else if (privateAuthParentLive && !privateAuthConfirmed && byte === 2) { privateAuthConfirmed = true; notifyPrivateAuthConfirmation?.(); }
      else { revokeParentLease(); privateAuthLifetime.destroy(); break; }
    }
  });
  const clearCachedAuth = (): void => { cachedAuth = null; if (privateAuthExpiryTimer) { clearTimeout(privateAuthExpiryTimer); privateAuthExpiryTimer = undefined; } };
  const revokeParentLease = (): void => { privateAuthParentLive = false; clearCachedAuth(); notifyPrivateAuthConfirmation?.(); };
  privateAuthLifetime?.once("end", revokeParentLease);
  privateAuthLifetime?.once("close", revokeParentLease);
  privateAuthLifetime?.once("error", revokeParentLease);
  const adapter = new ZCodeAppServerAdapter({
    host: execution.host_profile,
    executionProfileId: execution.execution_profile_id,
    ...(execution.private_auth ? { startPlanProviderEntitled: execution.private_auth.entitled } : {}),
    onEvent: (event) => {
      // Bounded lifecycle evidence without request payloads. This distinguishes
      // a Worker that reached adapter cleanup from one killed before cleanup.
      if (!interactionMode) return;
      if (event.type === "cleanup_unverified") {
        const summary = event.summary;
        const reason = summary.startsWith("Managed browser cleanup")
          ? "browser_cleanup"
          : summary.includes("process_tree_root_exited")
            ? "root_exited_scan_unverified"
            : summary.includes("Identity-bound Windows process-tree cleanup receipt")
              ? "receipt_unavailable"
              : "unclassified";
        // cleanup summaries are Adapter-generated, already exposed through task
        // events, and contain bounded failure classifications rather than task
        // payloads. Keep the same text in Worker stderr for lifecycle triage.
        writeDiagnostic(`[bridge-worker] adapter event=${event.type} reason=${reason} summary=${summary.slice(0, 500)}\n`);
        return;
      }
      writeDiagnostic(`[bridge-worker] adapter event=${event.type}\n`);
    },
    onVerifiedFailureCleanup: (receipt) => { failureCleanupReceipt = receipt; },
    ...(secretRedactor ? {
      sanitizeStartPlanFrame: (value: Record<string, unknown>) => secretRedactor.value(value) as Record<string, unknown>,
      sanitizeStartPlanText: (value: string) => secretRedactor.text(value),
    } : {}),
    resolveStartPlanRuntimeAuth: execution.private_auth ? async (scope, signal) => {
      if (signal.aborted || !privateAuthParentLive || !workerIdentity || workerIdentity.pid !== process.pid || workerIdentity.fingerprint_precision !== "exact" || !workerIdentity.fingerprint) throw new Error("private auth unavailable");
      if (cachedAuth) {
        if (cachedAuth.sessionId !== scope.sessionId || cachedAuth.turnId !== scope.turnId || cachedAuth.providerId !== scope.providerId || cachedAuth.modelId !== scope.modelId || cachedAuth.expiresAt <= Date.now()) throw new Error("private auth unavailable");
        const current = cachedAuth;
        return { ...current, isValid: () => privateAuthParentLive && !signal.aborted && cachedAuth === current && current.expiresAt > Date.now() };
      }
      if (privateAuthStarted) throw new Error("private auth unavailable");
      privateAuthStarted = true;
      const { receivePrivateCredential } = await import("../runtime/start-plan-private-channel.js");
      const auth = execution.private_auth!;
      const request = createWriteStream(process.execPath, { fd: 10 });
      const acknowledgement = createWriteStream(process.execPath, { fd: 12 });
      let responseOpened = false;
      let result: Awaited<ReturnType<typeof receivePrivateCredential>>;
      try { result = await receivePrivateCredential({ request, response: () => { responseOpened = true; return new Socket({ fd: 11, readable: true, writable: false }); }, acknowledgement,
        binding: { account: auth.account, provider: scope.providerId, model: scope.modelId, task: bootstrap.task_id,
          attempt: bootstrap.attempt, operation: bootstrap.operation_id, generation: bootstrap.generation, claim: auth.claim,
          session: scope.sessionId, turn: scope.turnId, pid: workerIdentity.pid, creation: workerIdentity.fingerprint },
        signal, timeoutMs: 15_000 }); }
      finally { if (!responseOpened) { try { closeSync(11); } catch { /* not open */ } } }
      // The Worker has only written an ACK at this point. Wait for the
      // Manager to confirm it accepted that ACK before using the credential.
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const cleanup = (): void => { if (timer) clearTimeout(timer); signal.removeEventListener("abort", check); notifyPrivateAuthConfirmation = undefined; };
        const check = (): void => {
          if (signal.aborted || !privateAuthParentLive || result.expiresAt <= Date.now()) { cleanup(); reject(new Error("private auth unavailable")); }
          else if (privateAuthConfirmed) { cleanup(); resolve(); }
        };
        notifyPrivateAuthConfirmation = check;
        signal.addEventListener("abort", check, { once: true });
        timer = setTimeout(() => { cleanup(); reject(new Error("private auth unavailable")); }, Math.max(0, Math.min(15_000, result.expiresAt - Date.now())));
        timer.unref();
        check();
      });
      if (signal.aborted || !privateAuthParentLive) throw new Error("private auth unavailable");
      secretRedactor?.register(result.jwt);
      cachedAuth = { apiKey: result.jwt, expiresAt: result.expiresAt, ...scope };
      privateAuthExpiryTimer = setTimeout(clearCachedAuth, Math.max(0, result.expiresAt - Date.now()));
      privateAuthExpiryTimer.unref();
      signal.addEventListener("abort", clearCachedAuth, { once: true });
      const current = cachedAuth;
      return { ...current, isValid: () => privateAuthParentLive && !signal.aborted && cachedAuth === current && current.expiresAt > Date.now() };
    } : undefined,
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
  } finally {
    clearCachedAuth();
    privateAuthLifetime?.destroy();
    if (execution.private_auth && !privateAuthStarted) for (const fd of [10, 11, 12]) { try { closeSync(fd); } catch { /* not open */ } }
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
  const executionCleanup = buildExecutionCleanupProof(outcome, failureCleanupReceipt);
  secretRedactor?.close();
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
  failureReceipt: import("../adapters/windows-process-cleanup.js").WindowsTerminationReceipt | null = null,
): CandidateExecutionCleanupProof | null {
  const receipt = failureReceipt ?? outcome?.cleanupTreeReceipt;
  if (!failureReceipt && outcome?.cleanupVerified === true && !outcome.cleanupError
    && outcome.cleanupNotRequired === "start_plan_preflight_rejected"
    && outcome.errorCode === "provider_config_invalid" && outcome.sessionId === null && !outcome.cleanupTreeReceipt) {
    return {
      contract: "candidate-execution-cleanup-proof-v1",
      source: "zcode_app_server_adapter",
      method: "adapter_not_started",
      reason: "start_plan_preflight_rejected",
      complete: true,
      workspace_retained: true,
      managed_browser_cleanup_verified: true,
    };
  }
  if (!receipt || (!failureReceipt && (outcome?.cleanupVerified !== true || outcome.cleanupError))) return null;
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

function writeDiagnostic(line: string): void {
  try { writeSync(2, line); } catch { /* stderr may already be gone */ }
}

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
