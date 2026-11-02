// Streaming ZCode Protocol adapter. The wire protocol is versioned with the
// installed ZCode runtime; docs/INTERFACES.md records the event cursor and
// replay boundary, and docs/ZCODE_RUNTIME.md the runtime configuration edge.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentHandle,
  AgentProcessStatus,
  CodingAgentAdapter,
  RuntimeResolver,
  TaskPackage,
  TaskResult,
  WorkspaceRef,
  ZCodeInteractionRequest,
  ZCodeRuntimeConfig,
} from "../interfaces.js";
import { parseAgentReport } from "./agent-report.js";
import type { ZCodeRunOutcome } from "./zcode-adapter.js";
import { buildContinuePrompt, buildTaskPrompt } from "../prompts/task-prompt.js";
import { BridgeError } from "../runtime/errors.js";
import { loadPersistedRuntimeEnvironment, NodeRuntimeResolver } from "../runtime/resolver.js";
import { captureSpawnGenerationIdentity, childStillOnSpawnGeneration, isProcessRunning, terminateProcessTree, verifyProcessTreeClaimantsClean, type TerminateProcessTree, type TreeClaimantTarget } from "./process-spawn.js";
import { createPlatformProbe, type ProcessProbe } from "../runtime/process-probe.js";
import { WindowsTreeCleanupError, type WindowsTerminationReceipt } from "./windows-process-cleanup.js";
import {
  buildFailureFacts,
  classifyFailureEvidence,
  evaluateAcceptedUpgrade,
  matchesExplicitQuotaText,
  registeredCode,
  registeredPhase,
  MODEL_ERROR_CODES,
  PROVIDER_BUSINESS_CODES,
  ERROR_TYPE_REGISTRY,
  RPC_DATA_CODE_REGISTRY,
  RESULT_TYPE_REGISTRY,
  REVIEWED_REASON_TOKENS,
  type FailureEvidenceInput,
  type FailureFactsV1,
  type ProcessErrno,
} from "../diagnostics/failure-facts.js";
import { randomUUID } from "node:crypto";
import { createMinimalOsEnv } from "../runtime/child-env.js";
import { catalogProviderId, buildAccountProviderPayload, runtimeAuthReply, zcodeDataBaseDir, zcodeTasksIndexPath } from "../runtime/account-provider.js";
import { resolveSessionPreferences } from "../runtime/session-preferences.js";
import { resolveTaskTimeout } from "../runtime/task-timeout.js";
import { registerDesktopTask, updateDesktopTaskStatus, type DesktopTaskIndexEntry, type DesktopTaskStatus } from "./task-index-sync.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "../host/profile.js";
import { browserListParamsSchema, browserExecuteParamsSchema, type BrowserListParams, type BrowserExecuteParams } from "../browser/params.js";
import { createBrowserHost, type BrowserHost, type BrowserHostMode, type BrowserHostOptions } from "../browser/host.js";
import { createDefaultBrowserBackendFactory } from "../browser/load-backend.js";
import type { BrowserControlPort } from "../browser/contracts.js";

/** 可选浏览器宿主配置（ADR-007）；生产从持久化运行配置解析，测试可注入。 */
export interface AdapterBrowserOptions {
  mode?: BrowserHostMode;
  executablePath?: string;
  backendFactory?: () => Promise<BrowserControlPort>;
  commandTimeoutMs?: number;
  listTimeoutMs?: number;
}

type ProgressEvent = { type: string; summary: string; details?: Record<string, unknown> };
type ProgressSink = (event: ProgressEvent) => void;
type JsonRecord = Record<string, unknown>;

function publicUsage(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens", "input_tokens", "output_tokens", "total_tokens", "cost"]) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}

interface PendingRpc {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingInteraction {
  readonly requestIds: Array<string | number>;
  readonly method: ZCodeInteractionRequest["method"];
  readonly paramsSignature: string;
  response?: Record<string, unknown>;
  resolving: boolean;
}

interface AppServerClient {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params: JsonRecord): Promise<unknown>;
  replayEvents(events: unknown[]): void;
  close(): Promise<WindowsTerminationReceipt | null>;
  readonly stderr: string;
}

/**
 * ADR-011: in-memory candidate facts attached (non-enumerably) to the error
 * that terminates an attempt. Candidates are extracted where the evidence
 * appears; only the selected termination path may submit the root-cause slot.
 */
type FactsCandidate =
  | { kind: "rpc"; method: string; code: number | null; dataCode: string | null }
  | { kind: "spawn"; errno: ProcessErrno | null }
  | { kind: "process_exit" }
  | { kind: "transport"; method: string }
  | { kind: "turn"; input: FailureEvidenceInput }
  | { kind: "protocol" };

const FACTS_CANDIDATE: unique symbol = Symbol("zcodeFailureFactsCandidate");

interface MarkedError extends Error {
  [FACTS_CANDIDATE]?: FactsCandidate;
}

function withFactsCandidate<T extends Error>(error: T, candidate: FactsCandidate): T {
  Object.defineProperty(error, FACTS_CANDIDATE, { value: candidate, enumerable: false, configurable: true });
  return error;
}

function readFactsCandidate(error: unknown): FactsCandidate | null {
  if (!(error instanceof Error)) return null;
  return (error as MarkedError)[FACTS_CANDIDATE] ?? null;
}

interface RunEntry {
  handle: AgentHandle;
  child: ChildProcessWithoutNullStreams | null;
  /** ADR-009: spawn-generation identity of `child`, captured while the
   * libuv-held native handle keeps the PID unrecyclable (before 'exit'). */
  childIdentity: { pid: number; fingerprint: string } | null;
  /** True once the child's 'exit' fired (native handle released; the PID may
   * be recycled from that point and must never be signalled again). */
  childExitSeen: boolean;
  client: AppServerClient | null;
  sessionId: string | null;
  finished: boolean;
  timedOut: boolean;
  cancelRequested: boolean;
  outcome: ZCodeRunOutcome | null;
  error: unknown;
  runPromise: Promise<ZCodeRunOutcome>;
  resolveTurn: (value: TurnResult) => void;
  rejectTurn: (error: Error) => void;
  onEvent: ProgressSink;
  textOutputStarted: boolean;
  selectedModel: string | null;
  selectedModelSelection: { providerId: string; modelId: string } | null;
  selectedReasoningLevel: string | null;
  reasoningLevelSource: "runtime" | "not_reported";
  modelSource: string | null;
  requestedModel: string | null;
  requestedReasoningLevel: string | null;
  lastEventSeq: number;
  lastEventAt: number;
  readonly interactions: Map<string, PendingInteraction>;
  readonly abort: AbortController;
  acceptingTurn: boolean;
  turnId: string | null;
  awaitingTurnStart: boolean;
  // ADR-007 browser host state: bound once the session exists, closed with
  // the attempt in every terminal path; a failed browser teardown keeps the
  // final outcome unverified instead of being swallowed by app-server cleanup.
  browserConfig: ResolvedBrowserConfig | null;
  browserHost: BrowserHost | null;
  browserHostClosed: boolean;
  browserCleanupError: string | null;
  browserNoticeEmitted: boolean;
  browserScope: { workspacePath: string; workspaceKey: string } | null;
  // B2 correlation state: one pending completion at most, settled only after
  // the turn binding exists or the bounded compat window expires.
  rpcAcceptedAt: string | null;
  turnStartedAt: string | null;
  turnCompletedAt: string | null;
  turnBinding: "strict" | "compat" | "pending";
  pendingCompletion: { payload: JsonRecord; event: JsonRecord; heldAt: number } | null;
  bindingTimer: NodeJS.Timeout | null;
  pendingTimer: NodeJS.Timeout | null;
  replayConsecutiveFailures: number;
  // ADR-011 send-acceptance evidence (M2) and root-cause slot state (M1).
  sendAttempted: boolean;
  sendAcknowledged: boolean;
  acceptedEvidence: "no" | "unknown" | "yes";
  sendSeqBaseline: number | null;
  submitCorrelationId: string | null;
  boundTurnIds: Set<string>;
  terminalFactsSubmitted: boolean;
  /** ADR-011 S1: set by the child error handler; whichever rejection wins the
   * race, the termination is adjudicated from this spawn fact, not from the
   * public event order. */
  spawnFailure: { errno: ProcessErrno | null } | null;
}

interface TurnResult {
  response: string;
  usage: Record<string, unknown> | null;
  resultType: string | null;
  binding: "strict" | "compat";
  startedAt: string | null;
  completedAt: string;
  rpcAcceptedAt: string | null;
  /** ADR-008: captured turn text over MAX_CAPTURE_CHARS is bounded and flagged. */
  responseTruncated: boolean;
}

interface ResolvedBrowserConfig {
  mode: BrowserHostMode;
  executablePath?: string;
  backendFactory?: () => Promise<BrowserControlPort>;
  commandTimeoutMs?: number;
  listTimeoutMs?: number;
}

export interface ZCodeAppServerAdapterOptions {
  resolver?: RuntimeResolver;
  onEvent?: ProgressSink;
  timeoutMs?: number;
  childEnvBase?: NodeJS.ProcessEnv;
  /** 浏览器宿主覆盖项；缺省按持久化运行配置解析（默认 off）。 */
  browser?: AdapterBrowserOptions;
  /**
   * Home directory for persisted Bridge settings discovery. Defaults to the
   * real home; tests point it at an empty directory to stay hermetic against
   * machine-level runtime-config.json state.
   */
  homeDir?: string;
  host?: BridgeHostProfile;
  /** Candidate-only execution profile; omitted JSON path behavior is unchanged. */
  executionProfileId?: string;
  now?: () => Date;
  resolveInteraction?: (request: ZCodeInteractionRequest, signal: AbortSignal) => Promise<Record<string, unknown>>;
  onOutcomeCheckpoint?: (outcome: ZCodeRunOutcome) => void;
  /** Worker-facing interaction activity hint (waiting → resumed). */
  onInteractionState?: (state: "waiting" | "resumed") => void;
  /** Bounded pending-completion window when completion races turn binding. */
  turnBindingCompatMs?: number;
  /** Idle time before a replay poll (default 10_000); tests lower it. */
  replayIdleMs?: number;
  /** Platform probe used for the spawn-generation identity capture (ADR-009);
   * defaults to the real platform probe. */
  probe?: ProcessProbe;
  /** Test seam for identity-bound cleanup and its recorded-tree fallback. */
  terminateProcessTreeImpl?: TerminateProcessTree;
  verifyTreeClean?: (targets: readonly TreeClaimantTarget[]) => Promise<{ clean: boolean; livePids: readonly number[]; observedPids: readonly number[] }>;
  /** Synchronous, best-effort test observation; contains no process identity. */
  onCleanupDecisionTrace?: (decision: "root_exited_branch") => void;
  /**
   * ADR-011 private failure-facts sink, invoked once per attempt after the
   * termination cause is established. The sink runs behind a diagnostic
   * boundary: the adapter isolates synchronous throws and asynchronous
   * rejections so evidence delivery can never alter execution or cleanup.
   */
  onFailureFacts?: (facts: FailureFactsV1) => void;
  /**
   * M2: enable the strict no-ACK acceptance upgrade. Only fixture runtimes
   * with a *verified* native send-correlation echo may set this; production
   * keeps it disabled, so without an ACK the evidence stays "unknown" (NOT RUN
   * on real runtimes — no unverified protocol parameter is added).
   */
  nativeSendCorrelationVerified?: boolean;
  /**
   * Test/diagnostic observation of the locally generated send boundary. The
   * correlation ID is never sent to the runtime in P0; fixtures use this hook
   * to simulate a verified native echo. Production leaves it unset.
   */
  onSendBoundary?: (boundary: { submitCorrelationId: string }) => void;
}

const RPC_TIMEOUT_MS = 30_000;
/** ADR-008: captured turn text stays bounded at 2,000,000 characters. */
const MAX_CAPTURE_CHARS = 2_000_000;
/** ADR-008: complete JSON-RPC frames get an independent 16 MiB UTF-8 byte
 * limit, separate from text capture. The production resume frame was
 * 2,139,927 bytes; the old whole-buffer 2,000,000-char check misread it as a
 * timeout. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Runs one task in a ZCode app-server session and persists safe progress
 * events through onEvent. Only visible text deltas and bounded interaction
 * requests are emitted; hidden reasoning and tool outputs are excluded.
 */
export class ZCodeAppServerAdapter implements CodingAgentAdapter {
  readonly #resolver: RuntimeResolver;
  readonly #onEvent: ProgressSink;
  readonly #timeoutMs: number | null;
  readonly #childEnvBase: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #host: BridgeHostProfile;
  readonly #executionProfileId: string | undefined;
  readonly #now: () => Date;
  readonly #resolveInteraction: ZCodeAppServerAdapterOptions["resolveInteraction"];
  readonly #onOutcomeCheckpoint: ZCodeAppServerAdapterOptions["onOutcomeCheckpoint"];
  readonly #onInteractionState: ZCodeAppServerAdapterOptions["onInteractionState"];
  readonly #terminateProcessTree: TerminateProcessTree;
  readonly #verifyTreeClean: NonNullable<ZCodeAppServerAdapterOptions["verifyTreeClean"]>;
  readonly #onCleanupDecisionTrace: ZCodeAppServerAdapterOptions["onCleanupDecisionTrace"];
  readonly #turnBindingCompatMs: number;
  readonly #replayIdleMs: number;
  readonly #onFailureFacts: ZCodeAppServerAdapterOptions["onFailureFacts"];
  readonly #nativeSendCorrelationVerified: boolean;
  readonly #onSendBoundary: ZCodeAppServerAdapterOptions["onSendBoundary"];
  readonly #browser: AdapterBrowserOptions | undefined;
  readonly #probe: ProcessProbe;
  readonly #runs = new Map<AgentHandle, RunEntry>();
  readonly #workspaceByTask = new Map<string, string>();

  constructor(options: ZCodeAppServerAdapterOptions = {}) {
    this.#resolver = options.resolver ?? new NodeRuntimeResolver({ env: options.childEnvBase, homeDir: options.homeDir, host: options.host });
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#timeoutMs = options.timeoutMs ?? null;
    this.#childEnvBase = options.childEnvBase ?? process.env;
    this.#homeDir = options.homeDir ?? homedir();
    this.#host = validateHostProfile(options.host ?? codexHostProfile(this.#homeDir));
    this.#executionProfileId = options.executionProfileId;
    this.#now = options.now ?? (() => new Date());
    this.#probe = options.probe ?? createPlatformProbe();
    this.#resolveInteraction = options.resolveInteraction;
    this.#onOutcomeCheckpoint = options.onOutcomeCheckpoint;
    this.#onInteractionState = options.onInteractionState;
    this.#terminateProcessTree = options.terminateProcessTreeImpl ?? terminateProcessTree;
    this.#verifyTreeClean = options.verifyTreeClean ?? verifyProcessTreeClaimantsClean;
    this.#onCleanupDecisionTrace = options.onCleanupDecisionTrace;
    this.#turnBindingCompatMs = options.turnBindingCompatMs ?? 5_000;
    this.#replayIdleMs = options.replayIdleMs ?? 10_000;
    this.#onFailureFacts = options.onFailureFacts;
    this.#nativeSendCorrelationVerified = options.nativeSendCorrelationVerified === true;
    this.#onSendBoundary = options.onSendBoundary;
    this.#browser = options.browser;
  }

  async startTask(input: { task: TaskPackage; workspace: WorkspaceRef; attempt: number }): Promise<AgentHandle> {
    return this.#launch(input.task, input.workspace, input.attempt, buildTaskPrompt(input.task), null);
  }

  async continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: TaskResult | null;
  }): Promise<AgentHandle> {
    const priorWorkspace = this.#workspaceByTask.get(input.task.task_id);
    if (priorWorkspace !== undefined && priorWorkspace !== input.workspace.canonicalPath) {
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
        previousResult: input.previousResult,
      }),
      input.previousSessionId,
    );
  }

  async getStatus(handle: AgentHandle): Promise<AgentProcessStatus> {
    const entry = this.#require(handle, "getStatus");
    return {
      state: entry.finished ? "exited" : entry.child ? "running" : "starting",
      workerPid: handle.workerPid,
      zcodePid: entry.child?.pid ?? null,
      exitCode: entry.outcome?.exitCode ?? null,
      signal: entry.outcome?.signal ?? null,
    };
  }

  async getResult(handle: AgentHandle): Promise<ZCodeRunOutcome> {
    const entry = this.#require(handle, "getResult");
    if (entry.error) throw entry.error;
    if (entry.outcome) return entry.outcome;
    return entry.runPromise;
  }

  async cancelTask(handle: AgentHandle): Promise<void> {
    const entry = this.#require(handle, "cancelTask");
    if (entry.finished) return;
    entry.cancelRequested = true;
    entry.abort.abort();
    entry.rejectTurn(new Error("ZCode task cancelled"));
    // #execute owns process cleanup. Killing here as well races its close()
    // path and can turn a verified cancellation into cleanup_failed.
    try { await entry.runPromise; }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "cancelled") throw error;
    }
  }

  async #launch(
    task: TaskPackage,
    workspace: WorkspaceRef,
    attempt: number,
    prompt: string,
    resumeSessionId: string | null,
  ): Promise<AgentHandle> {
    const handle: AgentHandle = {
      taskId: task.task_id,
      attempt,
      workerPid: process.pid,
      zcodePid: null,
      startedAt: this.#now().toISOString(),
    };
    let resolveTurn!: RunEntry["resolveTurn"];
    let rejectTurn!: RunEntry["rejectTurn"];
    const turn = new Promise<TurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    void turn.catch(() => undefined);
    const entry: RunEntry = {
      handle,
      child: null,
      childIdentity: null,
      childExitSeen: false,
      client: null,
      sessionId: resumeSessionId,
      finished: false,
      timedOut: false,
      cancelRequested: false,
      outcome: null,
      error: null,
      runPromise: Promise.resolve(null as unknown as ZCodeRunOutcome),
      resolveTurn,
      rejectTurn,
      onEvent: this.#onEvent,
      textOutputStarted: false,
      selectedModel: null,
      selectedModelSelection: null,
      selectedReasoningLevel: null,
      reasoningLevelSource: "not_reported",
      modelSource: null,
      requestedModel: null,
      requestedReasoningLevel: null,
      lastEventSeq: 0,
      lastEventAt: Date.now(),
      interactions: new Map(),
      abort: new AbortController(),
      acceptingTurn: false,
      turnId: null,
      awaitingTurnStart: false,
      rpcAcceptedAt: null,
      turnStartedAt: null,
      turnCompletedAt: null,
      turnBinding: "pending",
      pendingCompletion: null,
      bindingTimer: null,
      pendingTimer: null,
      replayConsecutiveFailures: 0,
      sendAttempted: false,
      sendAcknowledged: false,
      acceptedEvidence: "no",
      sendSeqBaseline: null,
      submitCorrelationId: null,
      boundTurnIds: new Set<string>(),
      terminalFactsSubmitted: false,
      spawnFailure: null,
      browserConfig: null,
      browserHost: null,
      browserHostClosed: false,
      browserCleanupError: null,
      browserNoticeEmitted: false,
      browserScope: null,
    };
    this.#runs.set(handle, entry);
    this.#workspaceByTask.set(task.task_id, workspace.canonicalPath);
    entry.runPromise = this.#execute(entry, task, workspace, prompt, resumeSessionId, turn);
    void entry.runPromise.then(
      (outcome) => { entry.outcome = outcome; entry.finished = true; },
      (error) => { entry.error = error; entry.finished = true; },
    );
    return handle;
  }

  async #execute(
    entry: RunEntry,
    task: TaskPackage,
    workspace: WorkspaceRef,
    prompt: string,
    resumeSessionId: string | null,
    turn: Promise<TurnResult>,
  ): Promise<ZCodeRunOutcome> {
    const startedAt = this.#now();
    const projectPath = workspace.sourcePath ?? workspace.canonicalPath;
    let timer: NodeJS.Timeout | undefined;
    let warningTimer: NodeJS.Timeout | undefined;
    let desktopTask: DesktopTaskIndexEntry | null = null;
    try {
      const runtimeEnv = loadPersistedRuntimeEnvironment(this.#childEnvBase, this.#homeDir, this.#host);
      const timeoutMs = this.#timeoutMs ?? resolveTaskTimeout(task, runtimeEnv);
      const config = await this.#resolver.resolve();
      const preferences = resolveSessionPreferences(task.model, runtimeEnv, this.#executionProfileId);
      const childEnv = this.#buildChildEnv(config, runtimeEnv);
      entry.onEvent({ type: "zcode_starting", summary: "Starting ZCode streaming runtime" });
      const client = this.#startAppServer(config, workspace.canonicalPath, childEnv, entry);
      entry.client = client;
      entry.child = client.child;
      entry.onEvent({ type: "app_server_started", summary: "ZCode app-server process started", details: { pid: client.child.pid } });
      timer = setTimeout(() => {
        entry.timedOut = true;
        entry.abort.abort();
        entry.rejectTurn(new Error(`ZCode run exceeded ${timeoutMs}ms wall-clock budget`));
      }, timeoutMs);
      timer.unref();
      warningTimer = setTimeout(() => {
        entry.onEvent({
          type: "timeout_warning",
          summary: `Task is approaching its ${timeoutMs}ms execution limit`,
          details: { timeout_ms: timeoutMs, remaining_ms: Math.min(300_000, Math.floor(timeoutMs / 2)) },
        });
      }, Math.max(15_000, timeoutMs - Math.min(300_000, Math.floor(timeoutMs / 2))));
      warningTimer.unref();

      const accountProviderPayload = buildAccountProviderPayload(config);
      if (accountProviderPayload) {
        try {
          const syncResult = asRecord(await client.request(
            "provider/updateAccountConfig",
            accountProviderPayload as unknown as JsonRecord,
          ));
          entry.onEvent({
            type: "account_provider_sync",
            summary: `Synchronized ${Object.keys(accountProviderPayload.providers).length} ZCode account provider(s)`,
            details: {
              provider_count: Object.keys(accountProviderPayload.providers).length,
              entitled_provider_count: Object.values(accountProviderPayload.states).filter((state) => state.entitled).length,
              runtime_status: typeof syncResult.status === "string" ? syncResult.status : "accepted",
            },
          });
        } catch (error) {
          entry.onEvent({
            type: "account_provider_sync_failed",
            summary: error instanceof Error ? error.message : "ZCode account provider synchronization failed",
          });
        }
      }

      let snapshot: JsonRecord;
      if (resumeSessionId) {
        snapshot = asRecord(await client.request("session/resume", {
          sessionId: resumeSessionId,
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: projectPath },
        }));
        const returnedId = nestedString(snapshot, ["session", "sessionId"]);
        if (returnedId && returnedId !== resumeSessionId) {
          throw new Error(`resume session mismatch: requested ${resumeSessionId}, runtime returned ${returnedId}`);
        }
        await client.request("session/setMode", { sessionId: resumeSessionId, mode: preferences.mode });
      } else {
        snapshot = asRecord(await client.request("session/create", {
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: projectPath },
          mode: preferences.mode,
          persistence: "immediate",
        }));
      }
      const sessionId = nestedString(snapshot, ["session", "sessionId"]);
      if (!sessionId) throw new Error("ZCode app-server session snapshot did not contain session.sessionId");
      entry.sessionId = sessionId;
      // ADR-007: browser scope binds to this attempt's session and workspace.
      // The official protocol broker keys requests by
      // workspaceIdentity ?? workspacePath of the session record; this adapter
      // never sends a workspaceIdentity, and workspacePath is the execution
      // directory it passed to session/create. Bind accordingly (the session
      // snapshot's identity wins when the runtime reports one), so a worktree
      // execution directory is not mis-keyed to the project directory.
      const snapshotWorkspace = asRecord(asRecord(snapshot).workspace);
      const reportedIdentity = typeof snapshotWorkspace.workspaceIdentity === "string" && snapshotWorkspace.workspaceIdentity.trim()
        ? snapshotWorkspace.workspaceIdentity.trim()
        : null;
      entry.browserScope = {
        workspacePath: workspace.canonicalPath,
        workspaceKey: reportedIdentity ?? workspace.canonicalPath,
      };
      entry.browserConfig = this.#resolveBrowserConfig(runtimeEnv);
      let selectedReasoningLevel: string | null = null;
      if (preferences.model) {
        const availableModels = readAvailableModels(snapshot);
        const requestedProviderId = catalogProviderId(preferences.model.provider_id, preferences.model.model_id, availableModels, config);
        const requested = `${requestedProviderId}/${preferences.model.model_id}`;
        entry.onEvent({
          type: "model_catalog",
          summary: `ZCode runtime advertised ${availableModels.length} selectable model${availableModels.length === 1 ? "" : "s"}`,
          details: {
            session_id: sessionId,
            project_path: projectPath,
            execution_path: workspace.canonicalPath,
            requested_model: { provider_id: requestedProviderId, model_id: preferences.model.model_id },
            available_models: availableModels.slice(0, 100),
            truncated: availableModels.length > 100,
          },
        });
        // The initial list is advisory: ZCode may accept a configured model
        // through session/setModel even when it is absent from this snapshot.
        // Let the runtime validate the actual selection and report its exact
        // error rather than rejecting a model that the registry can resolve.
        // session/create already selected this exact model. Keeping its
        // effective options is important for models requiring reasoningLevel.
        const current = readSelectedModelSelection(snapshot);
        const reasoningLevel = preferences.model.reasoning_level ?? readModelReasoningDefault(
          snapshot,
          requestedProviderId,
          preferences.model.model_id,
        );
        const modelState = current?.providerId === requestedProviderId && current.modelId === preferences.model.model_id && !preferences.model.reasoning_level
          ? snapshot
          : asRecord(await client.request("session/setModel", {
              sessionId,
              model: {
                providerId: requestedProviderId,
                modelId: preferences.model.model_id,
                ...(reasoningLevel
                  ? { options: { reasoningLevel } }
                  : {}),
              },
              // Keep the override scoped to this session; do not change the
              // user's project-wide last-used model.
              persistAsWorkspaceLastUsed: false,
            }));
        const selected = readSelectedModelSelection(modelState);
        if (!selected) {
          throw new Error(`ZCode accepted model override ${requested} but did not report the selected model`);
        }
        if (
          selected.providerId !== requestedProviderId ||
          selected.modelId !== preferences.model.model_id
        ) {
          throw new Error(
            `ZCode model override mismatch: requested ${requested}, runtime selected ${selected.providerId}/${selected.modelId}`,
          );
        }
        snapshot = modelState;
        entry.selectedModel = readSelectedModel(modelState) ?? requested;
        entry.selectedModelSelection = selected;
        entry.modelSource = preferences.modelSource;
        entry.requestedModel = `${preferences.model.provider_id}/${preferences.model.model_id}`;
        entry.requestedReasoningLevel = reasoningLevel;
        selectedReasoningLevel = readEffectiveReasoningLevel(modelState);
        entry.selectedReasoningLevel = selectedReasoningLevel;
        entry.reasoningLevelSource = selectedReasoningLevel ? "runtime" : "not_reported";
        entry.onEvent({
          type: "model_selected",
          summary: `ZCode selected requested model ${entry.selectedModel}${selectedReasoningLevel ? ` with reasoning level ${selectedReasoningLevel}` : "; runtime did not report its reasoning level"}`,
          details: {
            requested_model: entry.requestedModel,
            selected_model: entry.selectedModel,
            provider_id: selected.providerId,
            model_id: selected.modelId,
            model_source: preferences.modelSource,
            ...(selectedReasoningLevel ? { reasoning_level: selectedReasoningLevel, reasoning_level_source: "runtime" } : {}),
            ...(reasoningLevel ? { requested_reasoning_level: reasoningLevel } : {}),
          },
        });
      }
      const model = readSelectedModel(snapshot);
      entry.selectedModel = entry.selectedModel ?? model;
      const defaultSelection = readSelectedModelSelection(snapshot);
      entry.selectedModelSelection = entry.selectedModelSelection ?? defaultSelection;
      if (!entry.selectedModel) {
        const availableModels = readAvailableModels(snapshot);
        entry.onEvent({
          type: "model_unresolved",
          summary: "ZCode runtime did not report a selected model; task was stopped before sending the prompt",
          details: { session_id: sessionId, available_model_count: availableModels.length },
        });
        throw new BridgeError(
          "provider_config_invalid",
          "ZCode runtime did not report its selected model; refusing to start a task whose model cannot be identified.",
        );
      }
      if (!preferences.model) {
        const selected = readSelectedModelSelection(snapshot);
        selectedReasoningLevel = readEffectiveReasoningLevel(snapshot);
        entry.selectedReasoningLevel = selectedReasoningLevel;
        entry.reasoningLevelSource = selectedReasoningLevel ? "runtime" : "not_reported";
        entry.modelSource = preferences.modelSource;
        entry.onEvent({
          type: "model_selected",
          summary: `ZCode runtime selected its session model ${entry.selectedModel}${selectedReasoningLevel ? ` with reasoning level ${selectedReasoningLevel}` : ""}`,
          details: {
            selected_model: entry.selectedModel,
            model_source: preferences.modelSource,
            ...(selected ? { provider_id: selected.providerId, model_id: selected.modelId } : {}),
            ...(selectedReasoningLevel ? { reasoning_level: selectedReasoningLevel, reasoning_level_source: "runtime" } : {}),
          },
        });
      }
      entry.onEvent({
        type: "session_ready",
        summary: `ZCode session ready; selected model ${entry.selectedModel}${selectedReasoningLevel ? `; reasoning level ${selectedReasoningLevel}` : "; reasoning level not reported"}`,
        details: {
          session_id: sessionId,
          project_path: projectPath,
          execution_path: workspace.canonicalPath,
          ...(workspace.mode === "worktree" ? { worktree_path: workspace.canonicalPath } : {}),
          execution_mode: preferences.mode,
          model_source: preferences.modelSource,
          ...(entry.selectedModel ? { selected_model: entry.selectedModel } : {}),
          ...(selectedReasoningLevel ? { reasoning_level: selectedReasoningLevel, reasoning_level_source: "runtime" } : {}),
        },
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
          mode: preferences.mode,
        };
        try {
          await registerDesktopTask(desktopTask);
          entry.onEvent({
            type: "desktop_task_registered",
            summary: "ZCode session registered in Desktop task index; refresh the task list to see it",
            details: { session_id: sessionId, project_path: projectPath, execution_path: workspace.canonicalPath },
          });
        } catch (error) {
          reportDesktopIndexIssue(entry.onEvent, error);
          desktopTask = null;
        }
      }
      const runtimeSeq = nestedNumber(snapshot, ["runtime", "eventSeq"]) ?? 0;
      entry.lastEventSeq = runtimeSeq;
      entry.awaitingTurnStart = runtimeSeq > 0;
      await client.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
        afterSeq: runtimeSeq,
      });
      entry.acceptingTurn = true;
      await client.request("session/send", { sessionId, content: prompt });
      entry.rpcAcceptedAt = this.#now().toISOString();
      entry.onEvent({ type: "turn_started", summary: "ZCode accepted the task and started a turn", details: { rpc_accepted: true, ...(entry.turnId ? { turn_id: entry.turnId } : {}) } });
      // B2: if the runtime does not deliver turn.started for the accepted
      // send within a bounded window, degrade to the documented compat path
      // (session exclusivity + replay boundary), visibly — never silently.
      entry.bindingTimer = setTimeout(() => {
        if (!entry.awaitingTurnStart) return;
        entry.awaitingTurnStart = false;
        entry.turnBinding = "compat";
        entry.onEvent({
          type: "turn_binding_compat",
          summary: "turn.started did not arrive after the accepted send; binding degraded to session-exclusivity compatibility mode",
        });
        this.#settlePendingCompletion(entry);
      }, Math.max(this.#turnBindingCompatMs, 5_000));
      entry.bindingTimer.unref();
      let replayInFlight = false;
      let replayDisabled = false;
      const replayTimer = setInterval(() => {
        if (!entry.acceptingTurn || replayInFlight || replayDisabled || Date.now() - entry.lastEventAt < this.#replayIdleMs) return;
        void 0;
        replayInFlight = true;
        void client.request("session/events", { sessionId, afterSeq: entry.lastEventSeq, limit: 500 })
          .then((value) => {
            entry.replayConsecutiveFailures = 0;
            const events = asRecord(value).events;
            if (Array.isArray(events)) client.replayEvents(events);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("Unsupported ZCode app-server request")) {
              replayDisabled = true;
              entry.onEvent({ type: "session_event_replay_unavailable", summary: "ZCode session event replay is unsupported by this runtime; continuing with live event subscription" });
              return;
            }
            // Transient replay failures must not permanently condemn the
            // capability (B2-05): retry, and only give up after several
            // consecutive failures, with the degradation visible.
            entry.replayConsecutiveFailures += 1;
            if (entry.replayConsecutiveFailures >= 3) {
              replayDisabled = true;
              entry.onEvent({ type: "session_event_replay_unavailable", summary: `ZCode session event replay failed ${String(entry.replayConsecutiveFailures)} times consecutively; continuing with live subscription` });
            }
          })
          .finally(() => { replayInFlight = false; });
      }, Math.max(50, Math.min(5_000, this.#replayIdleMs)));
      replayTimer.unref();
      let turnResult: TurnResult;
      try { turnResult = await turn; }
      finally {
        clearInterval(replayTimer);
        if (entry.bindingTimer) { clearTimeout(entry.bindingTimer); entry.bindingTimer = null; }
        if (entry.pendingTimer) { clearTimeout(entry.pendingTimer); entry.pendingTimer = null; }
      }
      entry.turnCompletedAt = turnResult.completedAt;
      const desktopStatus: DesktopTaskStatus = turnResult.resultType === "cancelled"
        ? null
        : turnResult.resultType && turnResult.resultType !== "success" ? "error" : "completed";
      let outcome: ZCodeRunOutcome;
      if (turnResult.resultType && turnResult.resultType !== "success") {
        // R1: an execution-terminal resultType is an established root cause;
        // the specific value stays private while the public code stays generic.
        if (turnResult.resultType !== "cancelled" && !entry.terminalFactsSubmitted) {
          this.#emitFailureFacts(entry, {
            source: "turn_event",
            phase: "turn_terminal",
            resultType: turnResult.resultType,
            accepted: entry.acceptedEvidence,
          });
        }
        outcome = {
          attempts: 1,
          cancelled: turnResult.resultType === "cancelled",
          stdout: turnResult.response,
          stderr: "",
          exitCode: 1,
          signal: null,
          sessionId,
          response: turnResult.response,
          usage: turnResult.usage,
          timedOut: false,
          stdoutTruncated: turnResult.responseTruncated,
          stderrTruncated: false,
          agentReport: null,
          reportCandidate: null,
          reportError: `ZCode turn ended with resultType ${turnResult.resultType}`,
          errorCode: turnResult.resultType === "cancelled" ? "cancelled" : "zcode_nonzero_exit",
          phaseTimestamps: {
            rpc_accepted_at: turnResult.rpcAcceptedAt,
            turn_started_at: turnResult.startedAt,
            turn_completed_at: turnResult.completedAt,
          },
          modelProfile: this.#modelProfile(entry),
        };
      } else if (turnResult.resultType === null) {
        // Unknown terminal: event name alone never proves success (B2).
        if (!entry.terminalFactsSubmitted) {
          this.#emitFailureFacts(entry, {
            source: "turn_event",
            phase: "turn_terminal",
            accepted: entry.acceptedEvidence,
          });
        }
        const parsedUnknown = parseAgentReport(turnResult.response);
        outcome = {
          attempts: 1,
          cancelled: false,
          stdout: turnResult.response,
          stderr: "",
          exitCode: 1,
          signal: null,
          sessionId,
          response: turnResult.response,
          usage: turnResult.usage,
          timedOut: false,
          stdoutTruncated: turnResult.responseTruncated,
          stderrTruncated: false,
          agentReport: null,
          reportCandidate: parsedUnknown.candidate,
          reportError: `ZCode turn completed without a resultType (binding: ${turnResult.binding}); treated as an unknown terminal state, not a success`,
          errorCode: "unknown_turn_terminal",
          phaseTimestamps: {
            rpc_accepted_at: turnResult.rpcAcceptedAt,
            turn_started_at: turnResult.startedAt,
            turn_completed_at: turnResult.completedAt,
          },
          modelProfile: this.#modelProfile(entry),
        };
      } else {
        const parsed = parseAgentReport(turnResult.response);
        const stdout = turnResult.response;
        const base = {
        attempts: 1,
        cancelled: false,
        stdoutTruncated: turnResult.responseTruncated,
        stderrTruncated: false,
        stdout,
        stderr: "",
        exitCode: 0,
        signal: null,
        sessionId,
        response: turnResult.response,
        usage: turnResult.usage,
        timedOut: false,
        reportCandidate: parsed.candidate,
        };
        if (!parsed.report) {
          outcome = {
            ...base,
            agentReport: null,
            reportCandidate: parsed.candidate,
            reportError: parsed.error,
            errorCode: "invalid_agent_report",
            phaseTimestamps: {
              rpc_accepted_at: turnResult.rpcAcceptedAt,
              turn_started_at: turnResult.startedAt,
              turn_completed_at: turnResult.completedAt,
            },
            modelProfile: this.#modelProfile(entry),
          };
        } else {
          entry.onEvent({
            type: "report_ready",
            summary: "ZCode produced its structured execution report",
            details: { needs_master_decision: parsed.report.needs_master_decision },
          });
          outcome = {
            ...base,
            agentReport: parsed.report,
            reportCandidate: parsed.report,
            reportError: null,
            errorCode: null,
            phaseTimestamps: {
              rpc_accepted_at: turnResult.rpcAcceptedAt,
              turn_started_at: turnResult.startedAt,
              turn_completed_at: turnResult.completedAt,
            },
            modelProfile: this.#modelProfile(entry),
          };
        }
      }
      // Persist the complete, bounded response and normalized report before
      // cleanup. A taskkill race must not erase work already completed by ZCode.
      outcome = { ...outcome, cleanupVerified: false };
      try { this.#onOutcomeCheckpoint?.(outcome); }
      catch (error) {
        entry.onEvent({ type: "outcome_checkpoint_failed", summary: error instanceof Error ? error.message : String(error) });
      }
      try {
        await syncDesktopStatus(desktopTask, desktopStatus, entry.onEvent);
      } catch (error) {
        entry.onEvent({ type: "desktop_status_sync_failed", summary: error instanceof Error ? error.message : String(error) });
      }
      // The browser host belongs to this attempt; close it before the
      // app-server so its bounded teardown is reported independently. The
      // final cleanup verdict combines both resources: a browser that could
      // not be closed keeps the outcome unverified even when the app-server
      // itself exited cleanly.
      await this.#closeBrowserHost(entry);
      try {
        const cleanupTreeReceipt = await client.close();
        entry.child = null;
        if (entry.browserCleanupError) {
          outcome = { ...outcome, cleanupError: `Managed browser cleanup could not be verified: ${entry.browserCleanupError}`, cleanupVerified: false };
        } else if (cleanupTreeReceipt) {
          outcome = { ...outcome, cleanupVerified: true, cleanupTreeReceipt };
        } else if (process.platform !== "win32") {
          // POSIX termination resolves only after the process group is absent;
          // its contract has no Windows identity-bound receipt.
          outcome = { ...outcome, cleanupVerified: true };
        } else {
          outcome = {
            ...outcome,
            cleanupError: "Identity-bound Windows process-tree cleanup receipt was unavailable",
            cleanupVerified: false,
          };
        }
        try { this.#onOutcomeCheckpoint?.(outcome); }
        catch (error) {
          entry.onEvent({ type: "outcome_checkpoint_failed", summary: error instanceof Error ? error.message : String(error) });
        }
      } catch (error) {
        const cleanupError = error instanceof Error ? error.message : String(error);
        const cleanupScan = await this.#scanRootExitedCleanup(client, entry, error);
        const cleanupMemberPids = cleanupScan?.memberPids ?? this.#cleanupMemberPids(error);
        const cleanupVerifiedByRecordedScan = cleanupScan?.clean === true;
        if (cleanupVerifiedByRecordedScan && !entry.browserCleanupError) entry.onEvent({
          type: "cleanup_verified",
          summary: "The captured app-server generation had exited; an ADR-009 recorded-tree claimant scan found no live claimants",
          details: { pid: client.child.pid, evidence: "recorded_tree_claimant_scan" },
        });
        const combined = entry.browserCleanupError
          ? `Managed browser cleanup could not be verified: ${entry.browserCleanupError} (app-server cleanup also unverified: ${cleanupError})`
          : cleanupError;
        const cleanupVerified = cleanupVerifiedByRecordedScan && !entry.browserCleanupError;
        if (!cleanupVerified) entry.onEvent({ type: "cleanup_unverified", summary: combined.slice(0, 1_500), details: { pid: client.child.pid } });
        outcome = {
          ...outcome,
          cleanupError: cleanupVerified ? null : combined,
          cleanupVerified,
          ...(cleanupMemberPids.length > 0 ? { cleanupMemberPids } : {}),
        };
        try { this.#onOutcomeCheckpoint?.(outcome); }
        catch (checkpointError) {
          entry.onEvent({ type: "outcome_checkpoint_failed", summary: checkpointError instanceof Error ? checkpointError.message : String(checkpointError) });
        }
      }
      return outcome;
    } catch (error) {
      // Runtime timeout bounds an active ZCode turn. Once the turn has failed
      // or been cancelled, cleanup follows its own bounded process-tree
      // budget and must not relabel that already-observed terminal event.
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (warningTimer) { clearTimeout(warningTimer); warningTimer = undefined; }
      await syncDesktopStatus(desktopTask, entry.cancelRequested ? null : "error", entry.onEvent);
      entry.abort.abort();
      // ADR-011 M1: the root-cause slot is filled only here, after this error
      // is established as the attempt's termination (never on timeout,
      // cancellation, or cleanup-only failures), and before cleanup so the
      // evidence survives a failing teardown. Timeout/cancel/cleanup keep
      // their lifecycle semantics and never fabricate provider facts.
      // ADR-011 S1: an observed child spawn error adjudicates the termination
      // regardless of which rejection won the race with the event loop.
      const spawnRecovery = entry.spawnFailure && !entry.timedOut && !entry.cancelRequested ? entry.spawnFailure : null;
      if (!entry.terminalFactsSubmitted && !entry.timedOut && !entry.cancelRequested) {
        if (spawnRecovery) {
          this.#emitFailureFacts(entry, {
            source: "process",
            phase: "spawn",
            processErrno: spawnRecovery.errno,
            accepted: entry.acceptedEvidence,
          });
        } else {
          this.#submitTerminalFactsFromError(entry, error);
        }
      }
      await this.#closeBrowserHost(entry);
      let cleanupFailure: unknown;
      try {
        if (entry.client) await entry.client.close();
        else if (entry.child?.pid) await this.#terminateOwnedChild(entry);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      if (cleanupFailure) {
        const cleanupScan = entry.client
          ? await this.#scanRootExitedCleanup(entry.client, entry, cleanupFailure)
          : null;
        const memberPids = cleanupScan?.memberPids ?? this.#cleanupMemberPids(cleanupFailure);
        if (cleanupScan?.clean) entry.onEvent({
          type: "cleanup_verified",
          summary: "The captured app-server generation had exited; an ADR-009 recorded-tree claimant scan found no live claimants",
          details: { pid: entry.child?.pid ?? null, evidence: "recorded_tree_claimant_scan" },
        });
        if (!cleanupScan?.clean) {
          const browserSuffix = entry.browserCleanupError ? ` Managed browser cleanup is also unverified: ${entry.browserCleanupError}` : "";
          entry.onEvent({
            type: "cleanup_unverified",
            summary: `ZCode process termination could not be verified; workspace remains occupied.${browserSuffix}`,
            details: { pid: entry.child?.pid ?? null, member_pids: memberPids },
          });
          throw new BridgeError("cleanup_failed", `ZCode process termination could not be verified; workspace remains occupied.${browserSuffix}`, {
            cause: cleanupFailure,
            memberPids,
          });
        }
      }
      if (entry.browserCleanupError) {
        throw new BridgeError(
          "cleanup_failed",
          `ZCode process termination was verified, but the managed browser cleanup could not be verified: ${entry.browserCleanupError}`,
          { cause: error },
        );
      }
      entry.child = null;
      const baseMessage = error instanceof Error ? error.message : String(error);
      let message = entry.timedOut ? "ZCode run exceeded its wall-clock budget" : entry.cancelRequested ? "ZCode task cancelled" : baseMessage;
      let code = entry.timedOut ? "timeout" : entry.cancelRequested ? "cancelled" : error instanceof BridgeError ? error.code : "zcode_nonzero_exit";
      if (spawnRecovery) {
        code = "spawn_failed";
        message = spawnRecovery.errno
          ? `ZCode app-server could not be started (${spawnRecovery.errno}); the configured runtime executable was not found or cannot be executed.`
          : "ZCode app-server process failed before or during startup";
      }
      entry.onEvent({ type: "error", summary: message.slice(0, 1_500), details: { error_code: code } });
      if (spawnRecovery) throw new BridgeError("spawn_failed", message);
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(code, message);
    } finally {
      if (timer) clearTimeout(timer);
      if (warningTimer) clearTimeout(warningTimer);
      entry.abort.abort();
      entry.finished = true;
      void startedAt;
    }
  }

  #cleanupMemberPids(error: unknown): number[] {
    const value = (error as { memberPids?: unknown } | null)?.memberPids;
    return Array.isArray(value)
      ? [...new Set(value.filter((pid): pid is number => Number.isSafeInteger(pid) && (pid as number) > 0))]
      : [];
  }

  async #scanRootExitedCleanup(
    client: AppServerClient,
    entry: RunEntry,
    error: unknown,
  ): Promise<{ clean: boolean; memberPids: number[] } | null> {
    let memberPids = this.#cleanupMemberPids(error);
    if ((error as { code?: unknown } | null)?.code !== "process_tree_root_exited" || !client.child.pid) return null;
    const pid = client.child.pid;
    memberPids = [...new Set([pid, ...memberPids])];
    const fingerprint = entry.childIdentity?.pid === pid ? entry.childIdentity.fingerprint : null;
    if (!fingerprint) return { clean: false, memberPids };
    try {
      const scan = await this.#verifyTreeClean([{ pid, fingerprint }]);
      memberPids = [...new Set([...memberPids, ...scan.observedPids])];
      return { clean: scan.clean && scan.livePids.length === 0, memberPids };
    } catch (scanError) {
      // An unavailable, malformed, or rejected scan is not cleanup evidence.
      // A failed scan can already have observed intermediate members. Keep
      // them for the checkpoint/recovery union even if those parents exit.
      memberPids = [...new Set([...memberPids, ...this.#cleanupMemberPids(scanError)])];
      return { clean: false, memberPids };
    }
  }

  #startAppServer(
    config: ZCodeRuntimeConfig,
    cwd: string,
    env: NodeJS.ProcessEnv,
    entry: RunEntry,
  ): AppServerClient {
    const child = spawn(config.nodeExecutable, [config.zcodeEntrypoint, "app-server", "--stdio"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdoutBuffer = "";
    let rpcId = 0;
    let closed = false;
    // ADR-009 spawn-generation binding: libuv releases the child's native
    // handle when it delivers 'exit' (before stdio close), so continuity is
    // tracked from the exit state. The shared capture re-verifies the
    // generation after every await and discards fingerprints that raced an
    // exit — a recycled PID's identity is never stored as this spawn's.
    child.once("exit", () => {
      entry.childExitSeen = true;
    });
    const generationChild = {
      get pid() { return child.pid; },
      get exitCode() { return child.exitCode; },
      get signalCode() { return child.signalCode; },
      get exitSeen() { return entry.childExitSeen; },
    };
    let identityCapture: Promise<{ pid: number; fingerprint: string } | null> | null = null;
    if (process.platform === "win32" && child.pid) {
      identityCapture = captureSpawnGenerationIdentity(generationChild, this.#probe).then((identity) => {
        entry.childIdentity = identity;
        return identity;
      });
    }
    let spawned = false;
    child.once("spawn", () => { spawned = true; });
    // ADR-011 S1: an async spawn failure (ENOENT/EACCES/EPERM) must not be
    // masked by later "closed before ..." rejections; every subsequent request
    // surfaces the same marked spawn error so the termination path maps it.
    let spawnFailure: Error | null = null;
    const pending = new Map<string | number, PendingRpc>();
    // ADR-008: a fatal wire-format failure ends every pending RPC and the turn
    // wait immediately, stops buffering, and reports stable reason + safe size
    // fields — never the frame content. The first fatal reason is latched: it
    // rejects every later request too, so the protocol error surfaces instead
    // of being masked by an RPC or wall-clock timeout. Until then frames are
    // consumed one newline-delimited line at a time; the sum of coalesced
    // frames is never treated as a single frame.
    let protocolFatal: Error | null = null;
    const failProtocol = (code: "frame_over_limit" | "invalid_frame", frameBytes: number, detail?: string): void => {
      if (protocolFatal) return;
      const message = code === "frame_over_limit"
        ? `ZCode app-server protocol frame exceeded the 16 MiB UTF-8 limit (observed ${frameBytes} bytes, limit ${MAX_FRAME_BYTES} bytes)`
        : `ZCode app-server protocol stream delivered an invalid JSON frame (${frameBytes} bytes)${detail ? `: ${detail}` : ""}`;
      protocolFatal = withFactsCandidate(new Error(message), { kind: "protocol" });
      stdoutBuffer = "";
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(withFactsCandidate(new Error(`${message}; ended pending ${call.method} request`), { kind: "protocol" }));
      }
      pending.clear();
      entry.onEvent({
        type: "protocol_error",
        summary: message,
        details: { error_code: code, frame_bytes: frameBytes, limit_bytes: MAX_FRAME_BYTES },
      });
      entry.rejectTurn(protocolFatal);
    };
    entry.abort.signal.addEventListener("abort", () => {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("ZCode task attempt ended")); }
      pending.clear();
    }, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Browser reverse-RPC replies settle asynchronously and may race the
    // attempt's stdin teardown after cancel/timeout; a late write must fail
    // silently instead of raising an unhandled stream error.
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: string) => {
      if (protocolFatal) return;
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const rawLine = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        // The limit is judged on the raw untrimmed frame bytes (ADR-008): a
        // frame padded past the limit with whitespace must not shrink below
        // it through trimming.
        const frameBytes = Buffer.byteLength(rawLine, "utf8");
        if (frameBytes > MAX_FRAME_BYTES) {
          failProtocol("frame_over_limit", frameBytes);
          return;
        }
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          failProtocol("invalid_frame", frameBytes);
          return;
        }
        // A JSON-RPC frame's top level must be an object; null, arrays, and
        // scalars are wire-format defects, not handler inputs (ADR-008).
        if (!isRecord(parsed)) {
          failProtocol("invalid_frame", frameBytes, "the top-level frame value must be a JSON object");
          return;
        }
        const message = parsed;
        try {
          this.#handleMessage(message, entry, pending, config, (reply) => {
            child.stdin.write(`${JSON.stringify(reply)}\n`);
          });
        } catch (error) {
          // Handler failures are runtime errors, not wire-format defects; they
          // end the turn without condemning the transport.
          entry.rejectTurn(error instanceof Error ? error : new Error(String(error)));
        }
      }
      // An unterminated frame already over the limit must fail now, not when a
      // newline (or the RPC timeout) ever arrives.
      if (!protocolFatal) {
        const bufferedBytes = Buffer.byteLength(stdoutBuffer, "utf8");
        if (bufferedBytes > MAX_FRAME_BYTES) failProtocol("frame_over_limit", bufferedBytes);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk.slice(0, 64_000 - stderr.length);
    });
    child.on("error", (error) => {
      if (!spawned) closed = true;
      // ADR-011 M4/S1: a spawn failure's raw message can carry the configured
      // executable path/arguments, so public propagation uses fixed text and
      // the errno only. ENOENT/EACCES/EPERM map to the existing spawn_failed
      // code (an async error is spawn evidence even after app_server_started);
      // facts keep the process-plane evidence without guessing a provider.
      const rawErrno = typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code as string : null;
      const errno = rawErrno === "ENOENT" || rawErrno === "EACCES" || rawErrno === "EPERM" ? rawErrno as ProcessErrno : null;
      const startupFailure = !spawned && errno !== null;
      const sanitized = withFactsCandidate(
        startupFailure
          ? new BridgeError("spawn_failed", `ZCode app-server could not be started (${errno}); the configured runtime executable was not found or cannot be executed.`)
          : new Error("ZCode app-server process failed before or during startup"),
        startupFailure ? { kind: "spawn", errno } : { kind: "process_exit" },
      );
      if (startupFailure) {
        spawnFailure = sanitized;
        entry.spawnFailure = { errno };
      }
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(withFactsCandidate(new Error(`ZCode app-server process failed; ended pending ${call.method} request`), startupFailure ? { kind: "spawn", errno } : { kind: "process_exit" }));
      }
      pending.clear();
      entry.rejectTurn(sanitized);
    });
    child.on("close", (code, signal) => {
      closed = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(withFactsCandidate(new Error(`ZCode app-server exited (${String(code)}${signal ? `, ${signal}` : ""})`), { kind: "process_exit" }));
      }
      pending.clear();
      if (!entry.finished && !entry.timedOut && !entry.cancelRequested) {
        entry.rejectTurn(withFactsCandidate(new Error(`ZCode app-server exited before turn completion (${String(code)})`), { kind: "process_exit" }));
      }
    });

    const request = (method: string, params: JsonRecord): Promise<unknown> => {
      if (entry.abort.signal.aborted) return Promise.reject(new Error("ZCode task attempt ended"));
      // A latched fatal protocol reason blocks every later request, so the
      // original wire-format failure surfaces instead of a later timeout
      // (ADR-008).
      if (protocolFatal) return Promise.reject(withFactsCandidate(new Error(`${protocolFatal.message}; blocked ${method} request after the fatal protocol error`), { kind: "protocol" }));
      if (closed) {
        if (spawnFailure) return Promise.reject(spawnFailure);
        return Promise.reject(withFactsCandidate(new Error(`ZCode app-server is closed before ${method}`), { kind: "rpc", method, code: null, dataCode: null }));
      }
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(withFactsCandidate(new Error(`ZCode app-server request timed out: ${method}`), { kind: "rpc", method, code: null, dataCode: null }));
        }, RPC_TIMEOUT_MS);
        timer.unref();
        pending.set(id, { method, resolve, reject, timer });
        // ADR-011 M2: attempting the send moves the acceptance evidence from
        // "no" to "unknown"; only an ACK (or verified strict correlation) may
        // later establish "yes". The correlation ID is generated locally and
        // never sent as a protocol parameter in P0.
        if (method === "session/send") this.#beginSendBoundary(entry);
        const rejectWrite = (): void => {
          clearTimeout(timer);
          pending.delete(id);
          reject(withFactsCandidate(new Error("ZCode app-server transport write failed"), { kind: "transport", method }));
        };
        try {
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) rejectWrite(); });
        } catch { rejectWrite(); }
      });
    };
    const replayEvents = (events: unknown[]): void => {
      for (const event of events) {
        const params = asRecord(event);
        if (typeof params.type !== "string") continue;
        this.#handleMessage({ method: "session/event", params }, entry, pending, config, (reply) => {
          child.stdin.write(`${JSON.stringify(reply)}\n`);
        });
      }
    };
    let terminationStarted = false;
    const traceRootExitedDecision = (): void => {
      try { this.#onCleanupDecisionTrace?.("root_exited_branch"); } catch { /* Diagnostic callbacks cannot affect cleanup. */ }
    };
    const closeWindowsTree = async (): Promise<WindowsTerminationReceipt | null> => {
      if (!child.pid) return null;
      const identity = entry.childIdentity?.pid === child.pid ? entry.childIdentity : null;
      if (!terminationStarted && entry.childExitSeen && identity?.fingerprint) {
        traceRootExitedDecision();
        // The original ChildProcess exit was observed; no signal can reach
        // that generation now. Do not start a termination transaction solely
        // to rediscover this fact. This is NOT a clean-tree verdict: the
        // caller must still run the identity-bound recorded claimant scan,
        // including its PID-reuse and unknown-descendant safety gates.
        throw new WindowsTreeCleanupError("process_tree_root_exited", "process_tree_root_exited: original child exit observed; recorded-tree verification required (no termination transaction started)", [child.pid]);
      }
      // A previous transaction may have observed members before failing.
      // Never replace such a failure with the original-child-exit shortcut.
      terminationStarted = true;
      try {
        const terminated = await this.#terminateProcessTree(child.pid, {
          graceMs: 500,
          killWaitMs: 5_000,
          expectedRootFingerprint: identity?.fingerprint ?? null,
        });
        return terminated.windows ?? null;
      } catch (error) {
        // A transaction can discover the same root-exited race after its
        // identity and enumeration work began. Keep the trace bound to the
        // actual decision while preserving the original exception unchanged.
        if ((error as { code?: unknown } | null)?.code === "process_tree_root_exited") traceRootExitedDecision();
        throw error;
      }
    };
    const close = async (): Promise<WindowsTerminationReceipt | null> => {
      if (closed) {
        if (child.pid) {
          if (process.platform === "win32") {
            return closeWindowsTree();
          } else {
            await terminateProcessTree(child.pid);
          }
        }
        return null;
      }
      // Keep the original process generation alive until its caller-bound
      // identity probe settles. Ending stdin first can let a short-lived
      // runtime exit while the OS probe is still running; the capture then
      // correctly rejects the now-unverifiable PID, and cleanup must fail
      // closed. The probe itself is bounded by ProcessProbe's configured
      // timeout; a missing identity still remains a cleanup failure.
      if (process.platform === "win32" && childStillOnSpawnGeneration(generationChild)) {
        await identityCapture;
      }
      if (process.platform === "win32" && child.pid) {
        try {
          // The turn result is already persisted before close() is called.
          // Keep the original root generation alive until the identity-bound
          // tree transaction has captured its receipt. Ending stdin first can
          // let a short-lived app-server exit naturally and downgrade a valid
          // cleanup to the weaker recorded-tree claimant-scan fallback.
          return await closeWindowsTree();
        } finally {
          child.stdin.end();
        }
      }
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 1_000);
        timer.unref();
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      if (child.pid && isProcessRunning(child.pid)) {
        if (entry.childExitSeen) return null;
        await this.#terminateProcessTree(child.pid, {
          graceMs: 500,
          killWaitMs: 5_000,
          expectedRootFingerprint: entry.childIdentity?.pid === child.pid ? entry.childIdentity.fingerprint : null,
        });
      }
      return null;
    };
    return { child, request, replayEvents, close, get stderr() { return stderr; } };
  }

  /** ADR-009: terminate the adapter's own spawned child with the identity
   * captured while its native handle was still held. Windows refuses to
   * signal without it (a bare current PID is never trusted), and a child
   * whose 'exit' already fired is never signalled again. POSIX keeps its
   * existing process-group behaviour. */
  async #terminateOwnedChild(entry: RunEntry): Promise<void> {
    const pid = entry.child?.pid;
    if (!pid) return;
    if (entry.childExitSeen) return;
    const fingerprint = entry.childIdentity?.pid === pid ? entry.childIdentity.fingerprint : null;
    await terminateProcessTree(pid, { graceMs: 500, killWaitMs: 5_000, expectedRootFingerprint: fingerprint });
  }

  #handleMessage(
    message: JsonRecord,
    entry: RunEntry,
    pending: Map<string | number, PendingRpc>,
    config: ZCodeRuntimeConfig,
    write: (message: JsonRecord) => void,
  ): void {
    if (message.method === "session/requestRuntimePreferences") {
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        write({
          id,
          result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
          },
        });
      }
      return;
    }
    if (message.method === "interaction/requestProviderRuntimeHeaders") {
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        const params = asRecord(message.params);
        const selection = asRecord(params.modelSelection);
        const providerId = typeof selection.providerId === "string"
          ? selection.providerId
          : typeof params.providerId === "string" ? params.providerId : undefined;
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
    if (message.id !== undefined && message.method === undefined) {
      const id = message.id as string | number;
      const call = pending.get(id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonRecord;
        // ADR-011: keep the public rejection message unchanged (method and
        // numeric JSON-RPC code only); the registered business codes from
        // error.data.code become an in-memory candidate for the termination
        // path, never a public field (G-03, M1).
        const data = asRecord(error.data);
        const rpcCode = typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : null;
        const dataCode = registeredCode(data.code, RPC_DATA_CODE_REGISTRY);
        call.reject(withFactsCandidate(
          new Error(`ZCode app-server request failed for ${call.method}${typeof error.code === "number" ? ` (code ${error.code})` : ""}`),
          { kind: "rpc", method: call.method, code: rpcCode, dataCode },
        ));
      } else {
        call.resolve(message.result);
        // ADR-011 M2: the send ACK is the strongest acceptance evidence.
        if (call.method === "session/send") {
          entry.sendAcknowledged = true;
          entry.acceptedEvidence = "yes";
        }
      }
      return;
    }
    if (message.method === "session/event") {
      const params = asRecord(message.params);
      if (params.sessionId !== undefined && params.sessionId !== entry.sessionId) return;
      const type = typeof params.type === "string" ? params.type : "";
      const payload = asRecord(params.payload);
      const turnId = typeof params.turnId === "string" ? params.turnId : typeof payload.turnId === "string" ? payload.turnId : null;
      // ADR-011 M2: acceptance evidence is evaluated independently of the
      // compat progress filters below. Without an ACK, "yes" requires verified
      // native send correlation (production keeps this disabled, so late or
      // replayed turn events can never upgrade "unknown" — A6).
      if (
        this.#nativeSendCorrelationVerified &&
        typeof params.seq === "number" && params.seq > entry.lastEventSeq &&
        (!entry.turnId || turnId === entry.turnId) &&
        entry.sendAttempted &&
        !entry.sendAcknowledged &&
        entry.acceptedEvidence === "unknown"
      ) {
        const upgrade = evaluateAcceptedUpgrade({
          sessionId: entry.sessionId ?? "",
          seqBaseline: entry.sendSeqBaseline,
          boundTurnIds: entry.boundTurnIds,
          submitCorrelationId: entry.submitCorrelationId ?? "",
          nativeCorrelationVerified: true,
        }, {
          sessionId: typeof params.sessionId === "string" ? params.sessionId : null,
          seq: typeof params.seq === "number" ? params.seq : null,
          turnId,
          correlationEcho: this.#extractSubmitCorrelationEcho(payload),
        });
        if (upgrade === "yes") entry.acceptedEvidence = "yes";
      }
      if (turnId) entry.boundTurnIds.add(turnId);
      if (!entry.acceptingTurn) return;
      if (entry.awaitingTurnStart && type !== "turn.started") return;
      if (entry.turnId && turnId && entry.turnId !== turnId) return;
      if (typeof params.seq === "number") {
        if (!Number.isSafeInteger(params.seq) || params.seq <= entry.lastEventSeq) return;
        entry.lastEventSeq = params.seq;
      }
      entry.lastEventAt = Date.now();
      if (type === "turn.started") {
        // Strict binding wins: the send-accepted turn is now identified. A
        // completion held in the pending boundary settles only after this
        // binding is in place (B2-01).
        if (turnId) entry.turnId = turnId;
        entry.awaitingTurnStart = false;
        entry.turnStartedAt = this.#now().toISOString();
        if (entry.bindingTimer) { clearTimeout(entry.bindingTimer); entry.bindingTimer = null; }
      }
      if (type === "turn.completed") {
        if (entry.awaitingTurnStart) {
          // Completion before binding: hold a bounded pending boundary.
          entry.pendingCompletion = { payload, event: params, heldAt: Date.now() };
          entry.acceptingTurn = false;
          if (!entry.pendingTimer) {
            entry.pendingTimer = setTimeout(() => this.#settlePendingCompletion(entry), this.#turnBindingCompatMs);
            entry.pendingTimer.unref();
          }
          return;
        }
        entry.acceptingTurn = false;
        entry.turnCompletedAt = this.#now().toISOString();
        entry.turnBinding = entry.turnId ? "strict" : "compat";
        // Publish first so the worker persists the turn correlation, then
        // settle the turn exactly once.
        this.#publishSessionEvent(type, payload, entry, params);
        this.#resolveTurnCompleted(entry, payload, params);
        return;
      }
      if (type === "turn.failed") {
        entry.acceptingTurn = false;
        entry.turnCompletedAt = this.#now().toISOString();
        // ADR-011: evidence-strength adjudication replaces the old text-only
        // quota boolean. Structured rate-limit codes defeat quota-flavored
        // text (false-positive fix); explicit quota business codes keep
        // zcode_usage_exhausted and cover a generic HTTP 429. The failure is
        // associated error carries its facts to the selected termination
        // path; a competing RPC rejection must not inherit this candidate.
        const extraction = extractTurnFailureEvidence(payload.error);
        const upstreamPhase = typeof asRecord(payload.error).turnPhase === "string"
          ? asRecord(payload.error).turnPhase as string
          : typeof payload.turnPhase === "string" ? payload.turnPhase as string : null;
        const classification = classifyFailureEvidence({
          source: "turn_event",
          phase: upstreamPhase === null ? "turn_terminal" : registeredPhase(upstreamPhase),
          accepted: entry.acceptedEvidence,
          ...extraction,
        });
        const factsInput: FailureEvidenceInput = {
          source: "turn_event",
          phase: upstreamPhase === null ? "turn_terminal" : registeredPhase(upstreamPhase),
          accepted: entry.acceptedEvidence,
          ...extraction,
        };
        const quotaExhausted = classification.category === "quota_exhausted";
        const failure = quotaExhausted
          ? new BridgeError(
              "zcode_usage_exhausted",
              "ZCode 提供方明确报告用量额度已耗尽；当前执行已中断。请立即停止当前任务并告知用户；不要继续工作、自动重试或续作，等待用户确认额度恢复后再继续。",
            )
          : new Error("ZCode turn failed");
        this.#publishSessionEvent(type, payload, entry, params, quotaExhausted ? "zcode_usage_exhausted" : "zcode_nonzero_exit");
        entry.rejectTurn(withFactsCandidate(failure, { kind: "turn", input: factsInput }));
        return;
      }
      this.#publishSessionEvent(type, payload, entry, params);
      if (type === "turn.started" && entry.pendingCompletion) {
        // Binding landed after a held completion; correlation is now
        // persisted by the worker, so settle the held completion (B2-01).
        this.#settlePendingCompletion(entry);
      }
    }
    if (message.method === "state.updated") {
      const params = asRecord(message.params);
      const patch = asRecord(params.patch);
      const state = typeof patch.status === "string" ? patch.status : undefined;
      if (state) entry.onEvent({ type: "runtime_state", summary: `ZCode runtime state: ${state}` });
      return;
    }
    if (message.method === "interaction/browserList" || message.method === "interaction/browserExecute") {
      if (typeof message.id === "string" || typeof message.id === "number") {
        this.#handleBrowserRequest(message, entry, write);
      }
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      write({ id: message.id, error: { code: -32601, message: `Unsupported ZCode app-server request: ${message.method}` } });
    }
  }

  #handleInteractionRequest(
    message: JsonRecord,
    entry: RunEntry,
    write: (message: JsonRecord) => void,
  ): void {
    const rpcId = message.id as string | number;
    const method = message.method as ZCodeInteractionRequest["method"];
    const params = asRecord(message.params);
    if (entry.abort.signal.aborted || (params.sessionId !== undefined && params.sessionId !== entry.sessionId)) {
      write({ id: rpcId, result: interactionDecline(method, "Interaction does not belong to the active task session") });
      return;
    }
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
          details: { request_id: requestId, method },
        });
        return;
      }
      if (!pending.requestIds.includes(rpcId)) pending.requestIds.push(rpcId);
      if (pending.response) write({ id: rpcId, result: pending.response });
      return;
    }
    pending = { requestIds: [rpcId], method, paramsSignature, resolving: true };
    entry.interactions.set(requestId, pending);
    this.#onInteractionState?.("waiting");
    const request: ZCodeInteractionRequest = { request_id: requestId, method, params };
    const fallback = interactionDecline(method, "Bridge interaction reply is unavailable");
    void (async () => {
      let response = fallback;
      try {
        if (this.#resolveInteraction) response = await this.#resolveInteraction(request, entry.abort.signal);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        entry.onEvent({
          type: "interaction_reply_failed",
          summary: `Could not deliver the calling host's response to ZCode: ${messageText}`.slice(0, 1_500),
          details: { request_id: requestId, method },
        });
      }
      pending!.response = response;
      pending!.resolving = false;
      if (entry.abort.signal.aborted) return;
      this.#onInteractionState?.("resumed");
      for (const id of pending!.requestIds) write({ id, result: response });
      entry.onEvent({
        type: "interaction_replied",
        summary: `the calling host replied to ZCode ${method === "interaction/requestPermission" ? "permission request" : "user input request"}`,
        details: { request_id: requestId, method },
      });
      while (entry.interactions.size > 128) {
        const oldest = entry.interactions.keys().next().value as string | undefined;
        if (!oldest || entry.interactions.get(oldest)?.resolving) break;
        entry.interactions.delete(oldest);
      }
    })().catch(() => entry.rejectTurn(new Error("ZCode interaction delivery failed")));
  }

  /** ADR-007 browser host: resolve config, validate scope, dispatch, clean up. */
  #resolveBrowserConfig(env: NodeJS.ProcessEnv): ResolvedBrowserConfig {
    const override = this.#browser;
    const rawMode = override?.mode ?? env["ZCODE_BRIDGE_BROWSER_USE"]?.trim() ?? "";
    let mode: BrowserHostMode;
    if (rawMode === "" || rawMode === "off") mode = "off";
    else if (rawMode === "headless") mode = "headless";
    else mode = "off";
    const executablePath = override?.executablePath ?? (env["ZCODE_BRIDGE_BROWSER_EXECUTABLE"]?.trim() || undefined);
    return {
      mode,
      ...(executablePath ? { executablePath } : {}),
      ...(override?.backendFactory ? { backendFactory: override.backendFactory } : {}),
      ...(override?.commandTimeoutMs !== undefined ? { commandTimeoutMs: override.commandTimeoutMs } : {}),
      ...(override?.listTimeoutMs !== undefined ? { listTimeoutMs: override.listTimeoutMs } : {}),
    };
  }

  #browserHostFor(entry: RunEntry): BrowserHost | null {
    if (!entry.browserConfig) return null;
    if (entry.browserHost) return entry.browserHost;
    const config = entry.browserConfig;
    const options: BrowserHostOptions = {
      mode: config.mode,
      ...(config.executablePath ? { executablePath: config.executablePath } : {}),
      backendFactory: config.backendFactory
        ?? createDefaultBrowserBackendFactory({ ...(config.executablePath ? { executablePath: config.executablePath } : {}) }),
      ...(config.commandTimeoutMs !== undefined ? { commandTimeoutMs: config.commandTimeoutMs } : {}),
      ...(config.listTimeoutMs !== undefined ? { listTimeoutMs: config.listTimeoutMs } : {}),
    };
    entry.browserHost = createBrowserHost(options, (event) => {
      entry.onEvent({ type: event.type, summary: event.summary, ...(event.details ? { details: event.details } : {}) });
    });
    return entry.browserHost;
  }

  #browserScopeAllows(entry: RunEntry, params: BrowserListParams | BrowserExecuteParams): boolean {
    if (params.sessionId !== entry.sessionId) return false;
    const scope = entry.browserScope;
    if (scope) {
      if (params.workspacePath !== undefined && !sameWorkspacePath(params.workspacePath, scope.workspacePath)) return false;
      if (params.workspaceKey !== undefined && !sameWorkspacePath(params.workspaceKey, scope.workspaceKey)) return false;
    }
    if (entry.turnId && params.turnId && entry.turnId !== params.turnId) return false;
    return true;
  }

  #handleBrowserRequest(message: JsonRecord, entry: RunEntry, write: (message: JsonRecord) => void): void {
    const rpcId = message.id as string | number;
    const method = message.method as "interaction/browserList" | "interaction/browserExecute";
    void (async () => {
      if (entry.browserHostClosed || entry.abort.signal.aborted) {
        if (method === "interaction/browserList") {
          write({ id: rpcId, error: { code: -32000, message: "Bridge browser host is closed for this task attempt" } });
        } else {
          write({ id: rpcId, result: browserHostClosedResult() });
        }
        return;
      }
      const parsed = method === "interaction/browserList"
        ? browserListParamsSchema.safeParse(asRecord(message.params))
        : browserExecuteParamsSchema.safeParse(asRecord(message.params));
      if (!parsed.success) {
        write({ id: rpcId, error: { code: -32602, message: `Invalid ${method} params: ${zodIssueSummary(parsed.error)}` } });
        return;
      }
      const params: BrowserListParams | BrowserExecuteParams = parsed.data;
      if (!this.#browserScopeAllows(entry, params)) {
        // Scope refusals never leak which session/workspace is active.
        if (method === "interaction/browserList") {
          write({ id: rpcId, error: { code: -32000, message: "Browser request does not belong to the active task session" } });
        } else {
          write({ id: rpcId, result: {
            ok: false,
            error: { code: "backend_unavailable", message: "Browser request does not belong to the active task session" },
            elapsedMs: 0,
          } });
        }
        return;
      }
      const host = this.#browserHostFor(entry);
      if (!host) {
        // No session binding (should not happen post-session/create): refuse.
        if (method === "interaction/browserList") {
          write({ id: rpcId, error: { code: -32000, message: "Browser host is not bound to a task session" } });
        } else {
          write({ id: rpcId, result: browserHostClosedResult() });
        }
        return;
      }
      if (host.mode === "off" && !entry.browserNoticeEmitted) {
        entry.browserNoticeEmitted = true;
        entry.onEvent({
          type: "browser_host_disabled",
          summary: "ZCode requested browser access; the Bridge browser host is disabled by default (ZCODE_BRIDGE_BROWSER_USE=off)",
        });
      }
      if (method === "interaction/browserList") {
        if (paramsHasCommand(params)) {
          write({ id: rpcId, error: { code: -32602, message: "Invalid interaction/browserList params: unexpected execute fields" } });
          return;
        }
        const outcome = await host.handleList(params, entry.abort.signal);
        if (outcome.kind === "ok") write({ id: rpcId, result: { browsers: outcome.browsers } });
        else write({ id: rpcId, error: { code: -32000, message: outcome.message } });
        return;
      }
      if (!paramsHasCommand(params)) {
        write({ id: rpcId, error: { code: -32602, message: "Invalid interaction/browserExecute params: missing browserId/browserGeneration/command" } });
        return;
      }
      const result = await host.handleExecute(params, entry.abort.signal);
      write({ id: rpcId, result });
    })().catch((error: unknown) => {
      const messageText = error instanceof Error ? error.message : String(error);
      if (method === "interaction/browserList") {
        write({ id: rpcId, error: { code: -32000, message: `Browser host request failed: ${messageText.slice(0, 300)}` } });
      } else {
        write({ id: rpcId, result: {
          ok: false,
          error: { code: "execution_error", message: `Browser host request failed: ${messageText.slice(0, 300)}` },
          elapsedMs: 0,
        } });
      }
    });
  }

  async #closeBrowserHost(entry: RunEntry): Promise<void> {
    if (!entry.browserHost || entry.browserHostClosed) return;
    entry.browserHostClosed = true;
    try {
      const outcome = await entry.browserHost.close();
      if (!outcome.closed) {
        entry.browserCleanupError = outcome.error ?? "browser close could not be verified";
      }
    } catch (error) {
      entry.browserCleanupError = error instanceof Error ? error.message : String(error);
    }
    // The host emits its own verified/unverified close events; this adapter
    // only records the fact for the final outcome merge.
  }

  /** Settles a completion that was held in the pending boundary. */
  #settlePendingCompletion(entry: RunEntry): void {
    if (entry.pendingTimer) { clearTimeout(entry.pendingTimer); entry.pendingTimer = null; }
    const held = entry.pendingCompletion;
    if (!held) return;
    entry.pendingCompletion = null;
    if (entry.awaitingTurnStart) {
      entry.awaitingTurnStart = false;
      entry.turnBinding = "compat";
      entry.onEvent({
        type: "turn_binding_compat",
        summary: "turn.started never arrived for the accepted send; completion settled through the bounded compatibility window",
      });
    }
    entry.turnCompletedAt = this.#now().toISOString();
    this.#resolveTurnCompleted(entry, held.payload, held.event);
  }

  /** Single settle path for turn completions; resultType is validated here so
   * an unknown terminal is never mistaken for success (B2). Captured text
   * keeps the 2,000,000-character boundary with an explicit truncation flag
   * (ADR-008); the full text has already streamed through model_output events
   * up to the event-log capacity. */
  #resolveTurnCompleted(entry: RunEntry, payload: JsonRecord, event: JsonRecord): void {
    if (entry.turnBinding === "pending") entry.turnBinding = entry.turnId ? "strict" : "compat";
    const rawResponse = typeof payload.response === "string" ? payload.response : "";
    entry.resolveTurn({
      response: rawResponse.length > MAX_CAPTURE_CHARS ? rawResponse.slice(0, MAX_CAPTURE_CHARS) : rawResponse,
      usage: publicUsage(payload.usage),
      resultType: registeredCode(payload.resultType, RESULT_TYPE_REGISTRY),
      binding: entry.turnBinding,
      startedAt: entry.turnStartedAt,
      completedAt: entry.turnCompletedAt ?? this.#now().toISOString(),
      rpcAcceptedAt: entry.rpcAcceptedAt,
      responseTruncated: rawResponse.length > MAX_CAPTURE_CHARS,
    });
    void event;
  }

  #modelProfile(entry: RunEntry): import("../interfaces.js").ExecutionProfile | null {
    if (!entry.selectedModel && !entry.selectedModelSelection) return null;
    return {
      executor: "zcode",
      provider_id: entry.selectedModelSelection?.providerId ?? null,
      model_id: entry.selectedModelSelection?.modelId ?? entry.selectedModel,
      requested_model: entry.requestedModel,
      requested_reasoning_level: entry.requestedReasoningLevel,
      effective_reasoning_level: entry.selectedReasoningLevel,
      effective_reasoning_level_source: entry.reasoningLevelSource,
      selection_source: entry.modelSource ?? "runtime",
      effective_at: entry.turnStartedAt ?? entry.rpcAcceptedAt ?? null,
      session_id: entry.sessionId,
      turn_id: entry.turnId,
    };
  }

  /** ADR-011 M2: the send boundary snapshot taken when session/send is first
   * attempted. Acceptance starts as "no", becomes "unknown" at the write
   * attempt, and only an ACK (or verified strict correlation) reaches "yes". */
  #beginSendBoundary(entry: RunEntry): void {
    if (entry.sendAttempted) return;
    entry.sendAttempted = true;
    entry.submitCorrelationId = randomUUID();
    entry.sendSeqBaseline = entry.lastEventSeq > 0 ? entry.lastEventSeq : null;
    if (entry.acceptedEvidence === "no") entry.acceptedEvidence = "unknown";
    try {
      this.#onSendBoundary?.({ submitCorrelationId: entry.submitCorrelationId });
    } catch {
      // observation hook failures are diagnostics too
    }
  }

  /**
   * Reads the runtime's echo of this send's correlation ID from a turn event.
   * P0 adds no unverified protocol parameter to session/send, so production
   * never produces an echo; the location is only meaningful for fixture
   * runtimes whose native correlation ability has been verified.
   */
  #extractSubmitCorrelationEcho(payload: JsonRecord): string | null {
    const correlation = asRecord(payload.correlation);
    return typeof correlation.submit_id === "string" ? correlation.submit_id : null;
  }

  /**
   * ADR-011 M1: fills the root-cause slot exactly once per attempt. The
   * snapshot is whitelist-built and validated; an invalid snapshot is dropped.
   * The sink runs behind a diagnostic boundary — synchronous throws and
   * asynchronous rejections are isolated, never forwarded to public events or
   * error causes, and can never alter execution, cleanup, or the result.
   */
  #emitFailureFacts(entry: RunEntry, input: FailureEvidenceInput): void {
    if (entry.terminalFactsSubmitted) return;
    entry.terminalFactsSubmitted = true;
    let facts: FailureFactsV1;
    try {
      facts = buildFailureFacts(input);
    } catch {
      return; // an invalid snapshot is dropped, not repaired
    }
    const callback = this.#onFailureFacts;
    if (!callback) return;
    try {
      const result = callback(facts) as unknown;
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // diagnostic boundary: the sink failure never escapes (ADR-011)
    }
  }

  /** Submits candidate facts derived from the error that was selected as the
   * termination cause. Errors without a candidate marker are Bridge-side
   * refusals (config, session snapshot, report parsing) whose worker/report/
   * cleanup plane does not fit the four fact sources — no facts are invented. */
  #submitTerminalFactsFromError(entry: RunEntry, error: unknown): void {
    const candidate = readFactsCandidate(error);
    if (!candidate) return;
    const accepted = entry.acceptedEvidence;
    if (candidate.kind === "turn") {
      this.#emitFailureFacts(entry, candidate.input);
      return;
    }
    if (candidate.kind === "transport") {
      this.#emitFailureFacts(entry, { source: "transport", phase: "transport_lost", rpcMethod: candidate.method, accepted });
      return;
    }
    if (candidate.kind === "rpc") {
      this.#emitFailureFacts(entry, {
        source: "rpc",
        phase: entry.sendAttempted ? "rpc_rejected" : "pre_send",
        rpcMethod: candidate.method,
        rpcCode: candidate.code,
        rpcDataCode: candidate.dataCode,
        accepted,
      });
      return;
    }
    if (candidate.kind === "spawn") {
      this.#emitFailureFacts(entry, {
        source: "process",
        phase: "spawn",
        processErrno: candidate.errno,
        accepted,
      });
      return;
    }
    if (candidate.kind === "process_exit") {
      this.#emitFailureFacts(entry, { source: "process", phase: "process_exit", accepted });
      return;
    }
    this.#emitFailureFacts(entry, { source: "transport", phase: "protocol_guard", protocolGuard: true, accepted });
  }

  #publishSessionEvent(type: string, payload: JsonRecord, entry: RunEntry, event: JsonRecord, failureCode?: string): void {
    if (type === "turn.started") {
      entry.onEvent({
        type: "turn_started",
        summary: `ZCode turn started${entry.selectedModel ? ` with selected model ${entry.selectedModel}` : ""}`,
        details: {
          ...(typeof event.turnId === "string" ? { turn_id: event.turnId } : typeof payload.turnId === "string" ? { turn_id: payload.turnId } : {}),
          ...(typeof event.seq === "number" ? { event_seq: event.seq } : {}),
        },
      });
    } else if (type === "model.streaming") {
      const kind = payload.kind;
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if ((kind === "text_start" || kind === "text_delta") && !entry.textOutputStarted) {
        entry.textOutputStarted = true;
        entry.onEvent({
          type: "model_output_started",
          summary: `ZCode began returning visible model output${entry.selectedModel ? ` (${entry.selectedModel})` : ""}`,
          details: entry.selectedModel ? { selected_model: entry.selectedModel } : undefined,
        });
      }
      if (kind === "text_delta" && delta) {
        entry.onEvent({ type: "model_output", summary: delta });
      } else if (kind === "tool_call") {
        const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
        const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        entry.onEvent({
          type: "model_tool_call",
          summary: `Model requested tool ${name}`,
          details: { tool_name: name, ...(callId ? { tool_call_id: callId } : {}) },
        });
      }
    } else if (type === "tool.updated") {
      const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
      const state = typeof payload.kind === "string" ? payload.kind : "updated";
      const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
      entry.onEvent({
        type: "tool_status",
        summary: `${name}: ${state}`,
        details: { tool_name: name, state, ...(callId ? { tool_call_id: callId } : {}) },
      });
    } else if (type === "turn.completed") {
      entry.onEvent({
        type: "turn_completed",
        summary: "ZCode turn completed",
        details: {
          ...(typeof payload.tokenCount === "number" ? { token_count: payload.tokenCount } : {}),
          ...(typeof payload.toolCallCount === "number" ? { tool_call_count: payload.toolCallCount } : {}),
          ...(typeof event.seq === "number" ? { event_seq: event.seq } : {}),
          ...(typeof event.turnId === "string" ? { turn_id: event.turnId } : {}),
          ...(publicUsage(payload.usage) ? { usage: publicUsage(payload.usage) } : {}),
        },
      });
    } else if (type === "turn.failed") {
      entry.onEvent({
        type: "turn_failed",
        summary: failureCode === "zcode_usage_exhausted"
          ? "ZCode 提供方报告用量额度已耗尽；当前执行已中断。请立即停止当前任务并告知用户，等待用户确认额度恢复。"
          : "ZCode turn failed",
        ...(failureCode ? { details: { error_code: failureCode } } : {}),
      });
    }
  }

  #buildChildEnv(config: ZCodeRuntimeConfig, source = this.#childEnvBase): NodeJS.ProcessEnv {
    const env = createMinimalOsEnv(source);
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
    if (source.ZCODE_HOME) env.ZCODE_HOME = source.ZCODE_HOME;
    const dataBaseDir = zcodeDataBaseDir(config.providerPersonalConfigFile);
    if (dataBaseDir) env.ZCODE_DATA_BASE_DIR = dataBaseDir;
    return env;
  }

  #require(handle: AgentHandle, method: string): RunEntry {
    const entry = this.#runs.get(handle);
    if (!entry) throw new Error(`${method}: unknown agent handle (task ${handle.taskId})`);
    return entry;
  }
}

function interactionDecline(
  method: ZCodeInteractionRequest["method"],
  reason: string,
): Record<string, unknown> {
  return method === "interaction/requestPermission"
    ? { decision: "deny", reason }
    : { action: "decline", reason };
}

function browserHostClosedResult(): Record<string, unknown> {
  return {
    ok: false,
    error: { code: "backend_unavailable", message: "Bridge browser host is closed for this task attempt" },
    elapsedMs: 0,
  };
}

/** 工作区路径比较按平台归一大小写；browser scope 拒绝不区分分隔符风格。 */
function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.normalize(value).replace(/[/\\]+/gu, (match) => (match.includes("\\") || process.platform === "win32" ? "\\" : "/"));
  const resolvedLeft = normalize(left);
  const resolvedRight = normalize(right);
  return process.platform === "win32"
    ? resolvedLeft.toLocaleLowerCase("en-US") === resolvedRight.toLocaleLowerCase("en-US")
    : resolvedLeft === resolvedRight;
}

function zodIssueSummary(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const first = error.issues[0];
  if (!first) return "validation failed";
  return `${first.path.map((part) => String(part)).join(".")}: ${first.message}`.slice(0, 300);
}

function paramsHasCommand(params: BrowserListParams | BrowserExecuteParams): params is BrowserExecuteParams {
  return (params as BrowserExecuteParams).command !== undefined;
}

function readSelectedModel(snapshot: JsonRecord): string | null {
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
  const label = match && typeof asRecord(match).label === "string" ? asRecord(match).label as string : modelId;
  return providerId ? `${label} (${providerId}/${modelId})` : label;
}

function readSelectedModelSelection(snapshot: JsonRecord): { providerId: string; modelId: string } | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  if (typeof current.providerId !== "string" || typeof current.modelId !== "string") return null;
  return { providerId: current.providerId, modelId: current.modelId };
}

function readAvailableModels(snapshot: JsonRecord): Array<{ providerId: string; modelId: string }> {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  const refs = new Map<string, { providerId: string; modelId: string }>();
  for (const entry of available) {
    const ref = asRecord(asRecord(entry).ref);
    if (typeof ref.providerId !== "string" || typeof ref.modelId !== "string") continue;
    const key = `${ref.providerId}\u0000${ref.modelId}`;
    refs.set(key, { providerId: ref.providerId, modelId: ref.modelId });
  }
  return [...refs.values()];
}

function readModelReasoningDefault(snapshot: JsonRecord, providerId: string, modelId: string): string | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  for (const item of available) {
    const entry = asRecord(item);
    const ref = asRecord(entry.ref);
    if (ref.providerId !== providerId || ref.modelId !== modelId) continue;
    const reasoning = asRecord(entry.reasoning);
    if (typeof reasoning.defaultLevel === "string" && reasoning.defaultLevel.trim()) {
      return reasoning.defaultLevel;
    }
    const levels = Array.isArray(reasoning.levels) ? reasoning.levels : [];
    if (levels.length === 1) {
      const value = asRecord(levels[0]).value;
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

/** Read the active level reported by the session, never substitute catalog defaults. */
function readEffectiveReasoningLevel(snapshot: JsonRecord): string | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  const options = asRecord(current.options);
  const currentOption = options.reasoningLevel;
  if (typeof currentOption === "string" && currentOption.trim()) return currentOption.trim();
  const thoughtLevel = asRecord(settings.thoughtLevel);
  const level = thoughtLevel.current;
  return typeof level === "string" && level.trim() ? level.trim() : null;
}

function nestedString(record: JsonRecord, path: string[]): string | null {
  let value: unknown = record;
  for (const part of path) value = asRecord(value)[part];
  return typeof value === "string" ? value : null;
}

function nestedNumber(record: JsonRecord, path: string[]): number | null {
  let value: unknown = record;
  for (const part of path) value = asRecord(value)[part];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

/**
 * ADR-011: bounded in-memory extraction from one turn.failed error payload.
 * Only registered structured codes are kept; reasons are reduced to reviewed
 * tokens; the ADR-006 top-level quota text is reduced to a boolean. Raw
 * messages, underlyingErrorMessage, stacks, headers, and unknown values never
 * cross this boundary and are never persisted (M4).
 */
function extractTurnFailureEvidence(value: unknown): {
  providerCode: string | null;
  errorCode: string | null;
  errorType: string | null;
  reviewedReason: string | null;
  httpStatus: number | null;
  retryableBooleans: boolean[];
  quotaText: boolean;
} {
  if (typeof value === "string") {
    return { providerCode: null, errorCode: null, errorType: null, reviewedReason: null, httpStatus: null, retryableBooleans: [], quotaText: matchesExplicitQuotaText(value) };
  }
  const error = asRecord(value);
  const attribution = asRecord(error.attribution);
  const retryableBooleans: boolean[] = [];
  if (typeof attribution.retryable === "boolean") retryableBooleans.push(attribution.retryable);
  if (typeof error.retryable === "boolean") retryableBooleans.push(error.retryable);
  const rawReason = typeof attribution.reason === "string" ? attribution.reason : null;
  return {
    providerCode: registeredCode(attribution.providerErrorCode, PROVIDER_BUSINESS_CODES),
    errorCode: registeredCode(error.code, MODEL_ERROR_CODES),
    errorType: registeredCode(error.type, ERROR_TYPE_REGISTRY),
    reviewedReason: rawReason !== null && REVIEWED_REASON_TOKENS.has(rawReason) ? rawReason : null,
    httpStatus: typeof attribution.statusCode === "number" && Number.isSafeInteger(attribution.statusCode) && attribution.statusCode >= 100 && attribution.statusCode <= 599
      ? attribution.statusCode
      : null,
    retryableBooleans,
    quotaText: matchesExplicitQuotaText(error),
  };
}

async function syncDesktopStatus(
  entry: DesktopTaskIndexEntry | null,
  status: DesktopTaskStatus,
  onEvent: ProgressSink,
): Promise<void> {
  if (!entry) return;
  try {
    await updateDesktopTaskStatus(entry, status);
  } catch (error) {
    reportDesktopIndexIssue(onEvent, error);
  }
}

function reportDesktopIndexIssue(onEvent: ProgressSink, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  onEvent({
    type: "desktop_task_index_warning",
    summary: `ZCode Desktop task index could not be updated: ${message.slice(0, 500)}`,
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
