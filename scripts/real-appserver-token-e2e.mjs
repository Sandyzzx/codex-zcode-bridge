import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = resolve(root, ".evidence");
const startedAt = new Date().toISOString();
const turns = [];
const actualTurnIds = [];
const tokenNotifications = [];
const lifecycle = [];
const compact = { state: "NOT_RUN" };
const resume = { state: "NOT_RUN" };
const multiAgent = { state: "NOT_RUN" };
let auth = { state: "unknown" };
let modelInfo = null;
let threadHash = null;
let threadId = null;
let serverVersion = null;
let activeServer = null;
let rpcSequence = 0;

function pseudonym(prefix, value) {
  return `${prefix}#${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

function safeFailure(error) {
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? error.code : null;
  const message = String(error?.message ?? "").toLowerCase();
  const category = /auth|sign.?in|credential|token|unauthori[sz]ed/.test(message)
    ? "authentication_unavailable"
    : "request_failed";
  return { code, category };
}

function rpcError(message) {
  const error = new Error("app_server_rpc_failed");
  error.code = message?.error?.code ?? null;
  error.rpcError = true;
  return error;
}

class AppServerClient {
  constructor(executable) {
    this.child = spawn(executable, ["app-server", "--stdio"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.pending = new Map();
    this.events = [];
    this.exit = new Promise(resolveExit => this.child.once("exit", (code, signal) => resolveExit({ code, signal })));
    this.child.stderr.resume();
    this.lines.on("line", line => this.onLine(line));
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(String(message.id))) {
      const settle = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (message.error) settle.reject(rpcError(message));
      else settle.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      const event = { at: new Date().toISOString(), method: message.method, params: message.params, emittedAtMs: message.emittedAtMs };
      this.events.push(event);
      if (message.method === "thread/tokenUsage/updated") {
        tokenNotifications.push({
          observedAt: event.at,
          emittedAtMs: Number.isSafeInteger(event.emittedAtMs) ? event.emittedAtMs : null,
          method: message.method,
          params: message.params,
        });
      } else if (["turn/started", "turn/completed", "thread/compacted", "thread/started", "model/rerouted"].includes(message.method)) {
        lifecycle.push(event);
      }
    }
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async call(method, params, timeoutMs = 30_000) {
    const id = ++rpcSequence;
    const key = String(id);
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        rejectResponse(Object.assign(new Error("rpc_timeout"), { code: "timeout" }));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: value => { clearTimeout(timer); resolveResponse(value); },
        reject: error => { clearTimeout(timer); rejectResponse(error); },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return response;
  }

  findEvent(predicate, afterIndex = 0) {
    for (let index = afterIndex; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (predicate(event)) return { event, index };
    }
    return null;
  }

  async waitForEvent(predicate, afterIndex = 0, timeoutMs = 45_000) {
    const found = this.findEvent(predicate, afterIndex);
    if (found) return found;
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        this.lines.off("line", onLine);
        rejectEvent(Object.assign(new Error("notification_timeout"), { code: "timeout" }));
      }, timeoutMs);
      const onLine = () => {
        const next = this.findEvent(predicate, afterIndex);
        if (!next) return;
        clearTimeout(timer);
        this.lines.off("line", onLine);
        resolveEvent(next);
      };
      this.lines.on("line", onLine);
    });
  }

  async initialize() {
    const response = await this.call("initialize", {
      clientInfo: { name: "thread-token-usage-e2e", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    serverVersion = response?.userAgent ?? response?.serverInfo?.version ?? null;
    this.notify("notifications/initialized");
    return response;
  }

  async close() {
    if (this.child.exitCode !== null) return this.exit;
    this.child.stdin.end();
    const timeout = new Promise(resolveTimeout => setTimeout(() => resolveTimeout(null), 15_000));
    const exited = await Promise.race([this.exit, timeout]);
    if (exited) return exited;
    // This client owns this exact child process; terminate only it if EOF did not stop it.
    this.child.kill();
    return this.exit;
  }
}

function tokenEvidence(notification) {
  const source = notification.params ?? {};
  const counters = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const safe = {};
    for (const key of ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"]) {
      if (Object.hasOwn(value, key)) safe[key] = value[key];
    }
    return safe;
  };
  const tokenUsage = source.tokenUsage && typeof source.tokenUsage === "object" ? {
    total: counters(source.tokenUsage.total),
    last: counters(source.tokenUsage.last),
    ...(Object.hasOwn(source.tokenUsage, "modelContextWindow") ? { modelContextWindow: source.tokenUsage.modelContextWindow } : {}),
  } : null;
  return {
    observedAt: notification.observedAt,
    emittedAtMs: notification.emittedAtMs,
    method: notification.method,
    params: {
      threadId: typeof source.threadId === "string" ? pseudonym("thread", source.threadId) : null,
      turnId: typeof source.turnId === "string" ? pseudonym("turn", source.turnId) : null,
      tokenUsage,
    },
  };
}

function safeLifecycleEvent(event) {
  const params = event.params ?? {};
  const result = { observedAt: event.at, method: event.method };
  const eventThreadId = params.threadId ?? params.thread?.id;
  if (typeof eventThreadId === "string") result.threadId = pseudonym("thread", eventThreadId);
  const turnId = params.turn?.id ?? params.turnId;
  if (typeof turnId === "string") result.turnId = pseudonym("turn", turnId);
  if (event.method === "turn/completed" && params.turn) {
    result.status = params.turn.status ?? null;
    result.errorCode = params.turn.error?.code ?? null;
  }
  if (event.method === "model/rerouted") result.model = params.model ?? null;
  if (event.method === "thread/started" && params.thread) {
    result.parentThreadId = typeof params.thread.parentThreadId === "string"
      ? pseudonym("thread", params.thread.parentThreadId) : null;
    result.threadSource = params.thread.source ?? null;
  }
  return result;
}

async function saveEvidence(outcome) {
  await mkdir(evidenceDir, { recursive: true });
  const record = {
    task: "CODEX_THREAD_TOKEN_USAGE_E2E_20261030",
    classification: outcome.tokenE2e === "REAL_APPSERVER_TOKEN_E2E_PASS"
      ? "REAL_INSTALLED_APPSERVER_AND_MODEL"
      : outcome.tokenE2e === "BLOCKED_AUTH_UNAVAILABLE"
        ? "REAL_INSTALLED_APPSERVER_AUTH_BLOCKED"
        : "REAL_INSTALLED_APPSERVER_ATTEMPT",
    startedAt,
    finishedAt: new Date().toISOString(),
    desktopVersion: "26.1027.3384.0",
    cliVersion: "0.166.0-alpha.5.1",
    appServerUserAgent: serverVersion,
    experimentalApi: false,
    auth,
    model: modelInfo,
    threadId: threadHash,
    tokenE2e: outcome.tokenE2e,
    turns,
    tokenNotifications: tokenNotifications.map(tokenEvidence),
    lifecycle: lifecycle.map(safeLifecycleEvent),
    compact,
    resume,
    multiAgent,
  };
  await writeFile(resolve(evidenceDir, "real-appserver-token-e2e.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

let outcome = { tokenE2e: "BLOCKED" };
try {
  await mkdir(evidenceDir, { recursive: true });
  const found = spawnSync("where.exe", ["codex"], { encoding: "utf8" });
  if (found.status !== 0) throw Object.assign(new Error("codex_executable_unavailable"), { code: "executable_unavailable" });
  const executable = found.stdout.split(/\r?\n/).find(Boolean)?.trim();
  if (!executable) throw Object.assign(new Error("codex_executable_unavailable"), { code: "executable_unavailable" });
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (version.status !== 0 || !version.stdout.includes("0.166.0-alpha.5.1")) {
    throw Object.assign(new Error("unexpected_codex_version"), { code: "version_mismatch" });
  }

  activeServer = new AppServerClient(executable);
  await activeServer.initialize();
  const account = await activeServer.call("account/read", { refreshToken: false });
  const accountType = account?.account?.type ?? null;
  auth = {
    state: accountType ? "available" : "unavailable",
    accountType,
    planType: account?.account?.planType ?? null,
    requiresOpenaiAuth: account?.requiresOpenaiAuth ?? null,
  };
  if (!accountType || account.requiresOpenaiAuth === true) {
    outcome = { tokenE2e: "BLOCKED_AUTH_UNAVAILABLE", reason: "account_read_did_not_confirm_an_authenticated_account" };
    await saveEvidence(outcome);
    process.stdout.write("REAL_APPSERVER_TOKEN_E2E=BLOCKED_AUTH_UNAVAILABLE\n");
    process.exitCode = 0;
  } else {
    const catalog = await activeServer.call("model/list", { includeHidden: false, limit: 100 });
    const models = Array.isArray(catalog?.data) ? catalog.data : [];
    const selected = models.find(model => model.isDefault && !model.hidden) ?? models.find(model => !model.hidden);
    if (!selected?.id) throw Object.assign(new Error("no_available_model"), { code: "model_unavailable" });
    modelInfo = {
      id: selected.id,
      displayName: selected.displayName ?? null,
      provider: selected.modelProvider ?? selected.provider ?? null,
      multiAgentVersion: selected.multiAgentVersion ?? null,
    };

    const started = await activeServer.call("thread/start", {
      cwd: root,
      model: selected.id,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      threadSource: "appServer",
    });
    threadId = started?.thread?.id;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw Object.assign(new Error("thread_start_missing_id"), { code: "invalid_thread_start" });
    }
    threadHash = pseudonym("thread", threadId);

    const prompts = [
      "Reply exactly: real-token-probe-one",
      "Reply exactly: real-token-probe-two. Add no explanation, heading, punctuation, or extra words.",
      `Reply exactly: real-token-probe-three. Add no explanation, heading, punctuation, or extra words. This is the third independent request in a real App Server thread. ${"The purpose of this longer prompt is to observe whether the latest context snapshot changes while the thread total accumulates across turns. ".repeat(4)}`,
    ];
    for (let index = 0; index < prompts.length; index += 1) {
      const before = activeServer.events.length;
      const result = await activeServer.call("turn/start", {
        threadId,
        input: [{ type: "text", text: prompts[index] }],
        approvalPolicy: "never",
      });
      const turnId = result?.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        throw Object.assign(new Error("turn_start_missing_id"), { code: "invalid_turn_start" });
      }
      await activeServer.waitForEvent(event =>
        event.method === "turn/completed" && event.params?.threadId === threadId && event.params?.turn?.id === turnId,
      before, 180_000);
      const token = tokenNotifications.findLast(notification =>
        notification.params?.threadId === threadId && notification.params?.turnId === turnId,
      );
      turns.push({
        index: index + 1,
        turnId: pseudonym("turn", turnId),
        promptLengthChars: prompts[index].length,
        completionObserved: true,
        tokenNotificationObserved: Boolean(token),
        usage: token ? {
          total: token.params.tokenUsage?.total ?? null,
          last: token.params.tokenUsage?.last ?? null,
          modelContextWindow: token.params.tokenUsage?.modelContextWindow ?? null,
        } : null,
      });
      actualTurnIds.push(turnId);
      if (!token) throw Object.assign(new Error("token_usage_notification_missing"), { code: "token_usage_missing" });
    }
    const snapshots = turns.map(turn => turn.usage);
    const fieldsPresent = snapshots.every(snapshot => snapshot && snapshot.total && snapshot.last &&
      Number.isSafeInteger(snapshot.total.totalTokens) && Number.isSafeInteger(snapshot.last.totalTokens));
    const threadMatches = tokenNotifications
      .filter(notification => notification.params?.threadId === threadId)
      .every(notification => notification.params.threadId === threadId);
    const differentTurnsMatch = turns.every((_turn, index) => tokenNotifications.some(notification =>
      notification.params?.threadId === threadId && notification.params?.turnId === actualTurnIds[index] &&
      notification.params?.tokenUsage?.total,
    ));
    const cumulativeNondecreasing = fieldsPresent && snapshots.every((snapshot, index) =>
      index === 0 || snapshot.total.totalTokens >= snapshots[index - 1].total.totalTokens,
    );
    const latestContextChanged = fieldsPresent && new Set(snapshots.map(snapshot => snapshot.last.totalTokens)).size > 1;
    outcome = {
      tokenE2e: threadMatches && differentTurnsMatch && fieldsPresent ? "REAL_APPSERVER_TOKEN_E2E_PASS" : "PARTIAL",
      multiTurn: turns.length >= 3 && turns.every(turn => turn.completionObserved && turn.tokenNotificationObserved) && cumulativeNondecreasing
        ? "MULTI_TURN_E2E_PASS" : "PARTIAL",
      cumulativeNondecreasing,
      latestContextChanged,
      modelContextWindowValues: snapshots.map(snapshot => snapshot.modelContextWindow),
    };

    const compactStart = activeServer.events.length;
    const compactTokenStart = tokenNotifications.length;
    try {
      await activeServer.call("thread/compact/start", { threadId }, 30_000);
      const compacted = await activeServer.waitForEvent(event =>
        event.method === "thread/compacted" && event.params?.threadId === threadId,
      compactStart, 180_000);
      let compactionToken = tokenNotifications.slice(compactTokenStart)
        .findLast(notification => notification.params?.threadId === threadId);
      if (!compactionToken) {
        await activeServer.waitForEvent(event =>
          event.method === "thread/tokenUsage/updated" && event.params?.threadId === threadId,
        compacted.index, 90_000).catch(() => null);
        compactionToken = tokenNotifications.slice(compactTokenStart)
          .findLast(notification => notification.params?.threadId === threadId);
      }
      compact.state = "REAL_COMPACTION_EVENT_PASS";
      compact.observedAt = compacted.event.at;
      compact.latestUsage = compactionToken ? {
        totalTokens: compactionToken.params.tokenUsage?.total?.totalTokens ?? null,
        lastTokens: compactionToken.params.tokenUsage?.last?.totalTokens ?? null,
        modelContextWindow: compactionToken.params.tokenUsage?.modelContextWindow ?? null,
      } : null;
    } catch (error) {
      compact.state = error.code === "-32601" || error.code === -32601
        ? "BLOCKED_METHOD_UNSUPPORTED" : "PARTIAL_OR_FAILED";
      compact.failure = safeFailure(error);
    }

    await activeServer.close();
    activeServer = null;
    activeServer = new AppServerClient(executable);
    await activeServer.initialize();
    const resumeIndex = activeServer.events.length;
    try {
      const resumed = await activeServer.call("thread/resume", { threadId, cwd: root, sandbox: "read-only", approvalPolicy: "never" });
      if (resumed?.thread?.id !== threadId) throw Object.assign(new Error("resume_thread_identity_mismatch"), { code: "resume_identity_mismatch" });
      const replay = await activeServer.waitForEvent(event =>
        event.method === "thread/tokenUsage/updated" && event.params?.threadId === threadId,
      resumeIndex, 30_000);
      resume.state = "REAL_RESUME_REPLAY_PASS";
      resume.observedAt = replay.event.at;
      resume.latestUsage = {
        totalTokens: replay.event.params?.tokenUsage?.total?.totalTokens ?? null,
        lastTokens: replay.event.params?.tokenUsage?.last?.totalTokens ?? null,
        modelContextWindow: replay.event.params?.tokenUsage?.modelContextWindow ?? null,
      };
    } catch (error) {
      resume.state = "PARTIAL_OR_FAILED";
      resume.failure = safeFailure(error);
    }

    if (selected.multiAgentVersion === "disabled" || selected.multiAgentVersion === null || selected.multiAgentVersion === undefined) {
      multiAgent.state = "BLOCKED_MODEL_DOES_NOT_ADVERTISE_MULTI_AGENT";
      multiAgent.capability = selected.multiAgentVersion ?? null;
    } else {
      multiAgent.capability = selected.multiAgentVersion;
      try {
        const eventStart = activeServer.events.length;
        const tokenStart = tokenNotifications.length;
        const delegated = await activeServer.call("turn/start", {
          threadId,
          input: [{
            type: "text",
            text: "Use exactly one independent subagent to calculate 17 + 25. Do not calculate it yourself. Wait for the subagent result, then reply with only that result.",
          }],
          approvalPolicy: "never",
        });
        const delegatedTurnId = delegated?.turn?.id;
        if (typeof delegatedTurnId !== "string") throw Object.assign(new Error("multi_agent_turn_start_missing_id"), { code: "invalid_turn_start" });
        await activeServer.waitForEvent(event =>
          event.method === "turn/completed" && event.params?.threadId === threadId && event.params?.turn?.id === delegatedTurnId,
        eventStart, 180_000);

        const startedChildren = activeServer.events.slice(eventStart)
          .filter(event => event.method === "thread/started" && event.params?.thread?.parentThreadId === threadId)
          .map(event => event.params.thread);
        let child = startedChildren.at(-1);
        if (!child?.id) {
          const listed = await activeServer.call("thread/list", { sourceKinds: ["subAgent"], limit: 100 });
          child = (listed?.data ?? []).find(item => item.parentThreadId === threadId);
        }
        if (!child?.id) {
          multiAgent.state = "BLOCKED_NO_CHILD_THREAD_OBSERVED";
        } else {
          const childThreadId = child.id;
          multiAgent.childThreadId = pseudonym("thread", childThreadId);
          multiAgent.parentThreadId = threadHash;
          let childUsage = tokenNotifications.slice(tokenStart).find(notification => notification.params?.threadId === childThreadId);
          if (!childUsage) {
            await activeServer.waitForEvent(event =>
              event.method === "thread/tokenUsage/updated" && event.params?.threadId === childThreadId,
            eventStart, 30_000).catch(() => null);
            childUsage = tokenNotifications.slice(tokenStart).find(notification => notification.params?.threadId === childThreadId);
          }
          const mainUsage = tokenNotifications.slice(tokenStart).findLast(notification => notification.params?.threadId === threadId);
          multiAgent.childTokenUsageObserved = Boolean(childUsage);
          multiAgent.mainTokenUsageObserved = Boolean(mainUsage);
          multiAgent.threadIdsDistinct = childThreadId !== threadId;
          multiAgent.state = childUsage && mainUsage && childThreadId !== threadId
            ? "MULTI_AGENT_E2E_PASS"
            : "PARTIAL_THREAD_CREATED_BUT_TOKEN_OWNERSHIP_NOT_PROVEN";
          if (childUsage) multiAgent.childTotalTokens = childUsage.params.tokenUsage?.total?.totalTokens ?? null;
          if (mainUsage) multiAgent.mainTotalTokens = mainUsage.params.tokenUsage?.total?.totalTokens ?? null;
        }
      } catch (error) {
        multiAgent.state = "PARTIAL_OR_FAILED";
        multiAgent.failure = safeFailure(error);
      }
    }
  }
} catch (error) {
  outcome = {
    tokenE2e: error.code === "unauthorized" || error.code === "authentication_unavailable"
      ? "BLOCKED_AUTH_UNAVAILABLE" : "PARTIAL_OR_FAILED",
    failure: safeFailure(error),
  };
} finally {
  if (activeServer) await activeServer.close().catch(() => null);
}

const finalRecord = await saveEvidence(outcome);
process.stdout.write(`${JSON.stringify({
  tokenE2e: finalRecord.tokenE2e,
  multiTurn: finalRecord.multiTurn ?? "NOT_RUN",
  compaction: finalRecord.compact.state,
  resume: finalRecord.resume.state,
  multiAgent: finalRecord.multiAgent.state,
  auth: finalRecord.auth.state,
  model: finalRecord.model?.id ?? null,
  threadId: finalRecord.threadId,
  notificationCount: finalRecord.tokenNotifications.length,
}, null, 2)}\n`);
