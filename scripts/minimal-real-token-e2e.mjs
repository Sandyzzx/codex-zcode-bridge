import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidenceDir = resolve(root, ".evidence");
const startedAt = new Date().toISOString();
const evidence = {
  task: "CODEX_THREAD_TOKEN_USAGE_E2E_20261030",
  probe: "minimal-real-appserver-token-e2e",
  startedAt,
  desktopVersion: "26.1027.3384.0",
  cliVersion: null,
  appServerUserAgent: null,
  experimentalApi: false,
  config: null,
  accountRead: null,
  modelList: null,
  modelRequest: null,
  tokenNotifications: [],
  classification: null,
};

const pseudonym = (kind, value) => `${kind}#${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
const safeCode = error => typeof error?.code === "string" || typeof error?.code === "number" ? error.code : null;
const tokenFields = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"];
function safeCounters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(tokenFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function readProviderSummary(configText) {
  const provider = configText.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const providerHeader = provider ? new RegExp(`^\\s*\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\]\\s*$`, "m") : null;
  const start = providerHeader?.exec(configText)?.index ?? -1;
  let section = "";
  if (start >= 0) {
    const rest = configText.slice(start).replace(providerHeader, "");
    section = rest.split(/^\s*\[[^\]]+\]\s*$/m, 1)[0];
  }
  const stringValue = key => section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;
  const boolValue = key => section.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, "m"))?.[1] === "true";
  const bearer = stringValue("experimental_bearer_token");
  const envKey = stringValue("env_key");
  const envKeyConfigured = typeof envKey === "string" && envKey.length > 0;
  return {
    modelProvider: provider,
    configuredModel: configText.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    providerType: stringValue("wire_api") ?? "unspecified",
    baseUrlHost: (() => { try { return new URL(stringValue("base_url")).host; } catch { return null; } })(),
    configSource: "effective Codex config.toml; CODEX_HOME env or default user profile",
    codexHomeExplicitlySet: Boolean(process.env.CODEX_HOME),
    configPath: "<redacted>\\config.toml",
    requiresOpenaiAuthExplicit: section.match(/^\s*requires_openai_auth\s*=\s*(true|false)/m)?.[1] ?? null,
    experimentalBearerConfigured: Boolean(bearer),
    experimentalBearerSupportedSettingUsed: Boolean(bearer),
    envKeyConfigured: envKeyConfigured,
    envKeyPresent: envKeyConfigured ? Boolean(process.env[envKey]) : null,
    authConfigState: bearer || (envKeyConfigured && process.env[envKey]) ? "SUPPORTED_PROVIDER_AUTH_CONFIG_PRESENT" : "NO_AUTH_CONFIG",
    otherAuthFlags: { experimentalUseFileSecret: boolValue("experimental_use_file_secret") },
  };
}

class Client {
  constructor(executable) {
    this.child = spawn(executable, ["app-server", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.lines = createInterface({ input: this.child.stdout });
    this.pending = new Map();
    this.events = [];
    this.sequence = 0;
    this.exit = new Promise(resolveExit => this.child.once("exit", (code, signal) => resolveExit({ code, signal })));
    this.child.stderr.resume();
    this.lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && this.pending.has(String(message.id))) {
        const pending = this.pending.get(String(message.id));
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(Object.assign(new Error("rpc_error"), { code: message.error.code, dataKeys: Object.keys(message.error.data ?? {}) }));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) this.events.push({ observedAt: new Date().toISOString(), method: message.method, emittedAtMs: message.emittedAtMs ?? null, params: message.params ?? {} });
    });
  }

  call(method, params, timeoutMs = 30_000) {
    const id = ++this.sequence;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); rejectCall(Object.assign(new Error("rpc_timeout"), { code: "timeout" })); }, timeoutMs);
      this.pending.set(String(id), { resolve: value => { clearTimeout(timer); resolveCall(value); }, reject: error => { clearTimeout(timer); rejectCall(error); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }

  async wait(predicate, from, timeoutMs = 120_000) {
    const find = () => this.events.find((event, index) => index >= from && predicate(event) ? { event, index } : false);
    const ready = find();
    if (ready) return ready;
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => { this.lines.off("line", onLine); rejectWait(Object.assign(new Error("notification_timeout"), { code: "timeout" })); }, timeoutMs);
      const onLine = () => { const next = find(); if (!next) return; clearTimeout(timer); this.lines.off("line", onLine); resolveWait(next); };
      this.lines.on("line", onLine);
    });
  }

  async initialize() {
    const result = await this.call("initialize", { clientInfo: { name: "thread-token-usage-minimal-e2e", version: "0.1.0" }, capabilities: { experimentalApi: false } });
    evidence.appServerUserAgent = result?.userAgent ?? result?.serverInfo?.version ?? null;
    this.notify("notifications/initialized", {});
  }

  async close() {
    if (this.child.exitCode !== null) return this.exit;
    this.child.stdin.end();
    const timer = new Promise(resolveTimer => setTimeout(() => resolveTimer(null), 10_000));
    if (!await Promise.race([this.exit, timer])) this.child.kill();
    return this.exit;
  }
}

await mkdir(evidenceDir, { recursive: true });
const codexPath = spawnSync("where.exe", ["codex"], { encoding: "utf8" });
const executable = codexPath.status === 0 ? codexPath.stdout.split(/\r?\n/).find(Boolean)?.trim() : null;
if (!executable) {
  evidence.classification = "APPSERVER_BINARY_UNAVAILABLE";
} else {
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  evidence.cliVersion = version.status === 0 ? version.stdout.trim() : null;
  const home = process.env.CODEX_HOME || resolve(process.env.USERPROFILE ?? "", ".codex");
  const configPath = resolve(home, "config.toml");
  let configText = "";
  try { configText = await readFile(configPath, "utf8"); evidence.config = readProviderSummary(configText); }
  catch { evidence.config = { configPath: "<redacted>\\config.toml", state: "CONFIG_UNREADABLE", codexHomeExplicitlySet: Boolean(process.env.CODEX_HOME) }; }

  const client = new Client(executable);
  try {
    await client.initialize();
    try {
      const account = await client.call("account/read", { refreshToken: false });
      evidence.accountRead = { succeeded: true, accountPresent: Boolean(account?.account), requiresOpenaiAuth: account?.requiresOpenaiAuth ?? null };
    } catch (error) { evidence.accountRead = { succeeded: false, errorCode: safeCode(error) }; }

    let models;
    try {
      const catalog = await client.call("model/list", { includeHidden: false, limit: 100 });
      const rows = Array.isArray(catalog?.data) ? catalog.data : [];
      models = rows.filter(model => model && typeof model.id === "string" && !model.hidden);
      evidence.modelList = { succeeded: true, visibleCount: models.length, configuredModelFound: models.some(model => model.id === evidence.config?.configuredModel), defaultModelFound: models.some(model => model.isDefault) };
    } catch (error) {
      evidence.modelList = { succeeded: false, errorCode: safeCode(error), errorDataKeys: error.dataKeys ?? [] };
      evidence.classification = "MODEL_LIST_FAILED";
    }

    if (evidence.modelList?.succeeded) {
      const selected = models.find(model => model.id === evidence.config?.configuredModel) ?? models.find(model => model.isDefault) ?? models[0];
      evidence.modelList.selectedModel = selected ? { id: selected.id, provider: selected.modelProvider ?? selected.provider ?? null, modelContextWindow: selected.modelContextWindow ?? null } : null;
      if (!selected) evidence.classification = "MODEL_LIST_FAILED";
      else if (evidence.config?.authConfigState === "NO_AUTH_CONFIG") evidence.classification = "NO_AUTH_CONFIG";
      else {
        let threadId = null;
        try {
          const thread = await client.call("thread/start", { cwd: root, model: selected.id, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, threadSource: "appServer" });
          threadId = thread?.thread?.id;
          if (typeof threadId !== "string" || !threadId) throw Object.assign(new Error("thread_start_missing_id"), { code: "invalid_thread_start" });
          const turnBefore = client.events.length;
          const text = "Reply with exactly: ok";
          let turn;
          try { turn = await client.call("turn/start", { threadId, input: [{ type: "text", text }], approvalPolicy: "never" }, 150_000); }
          catch (error) {
            evidence.modelRequest = { succeeded: false, errorCode: safeCode(error), promptLengthChars: text.length, threadId: pseudonym("thread", threadId) };
            evidence.classification = "MODEL_REQUEST_FAILED";
            throw null;
          }
          const turnId = turn?.turn?.id;
          if (typeof turnId !== "string" || !turnId) {
            evidence.modelRequest = { succeeded: false, errorCode: "turn_start_missing_id", promptLengthChars: text.length, threadId: pseudonym("thread", threadId) };
            evidence.classification = "MODEL_REQUEST_FAILED";
          } else {
            evidence.modelRequest = { succeeded: false, promptLengthChars: text.length, threadId: pseudonym("thread", threadId), turnId: pseudonym("turn", turnId) };
            try {
              const completion = await client.wait(event => event.method === "turn/completed" && event.params?.threadId === threadId && event.params?.turn?.id === turnId, turnBefore, 180_000);
              const completionStatus = completion.event.params?.turn?.status ?? null;
              const completionErrorCode = completion.event.params?.turn?.error?.code ?? null;
              if (completionStatus !== "completed") {
                evidence.modelRequest = { ...evidence.modelRequest, succeeded: false, turnCompletedObserved: true, completionStatus, completionErrorCode };
                evidence.classification = "MODEL_REQUEST_FAILED";
              } else {
                const tokenResult = await client.wait(event => event.method === "thread/tokenUsage/updated" && event.params?.threadId === threadId && event.params?.turnId === turnId, turnBefore, 45_000);
                const params = tokenResult.event.params;
                const usage = params.tokenUsage ?? {};
                evidence.tokenNotifications.push({
                  observedAt: tokenResult.event.observedAt,
                  emittedAtMs: Number.isSafeInteger(tokenResult.event.emittedAtMs) ? tokenResult.event.emittedAtMs : null,
                  method: tokenResult.event.method,
                  params: {
                    threadId: pseudonym("thread", params.threadId),
                    turnId: pseudonym("turn", params.turnId),
                    tokenUsage: {
                      total: safeCounters(usage.total),
                      last: safeCounters(usage.last),
                      ...(Object.hasOwn(usage, "modelContextWindow") ? { modelContextWindow: usage.modelContextWindow } : {}),
                    },
                  },
                });
                evidence.modelRequest = { ...evidence.modelRequest, succeeded: true, turnCompletedObserved: true, completionStatus, tokenNotificationObserved: true };
                evidence.classification = "REAL_APPSERVER_TOKEN_E2E_PASS";
              }
            } catch (error) {
              evidence.modelRequest = { ...evidence.modelRequest, succeeded: true, turnCompletedObserved: true, completionStatus, tokenNotificationObserved: false, failureReason: "TOKEN_USAGE_NOTIFICATION_MISSING", tokenWaitErrorCode: safeCode(error) };
              evidence.classification = "MODEL_REQUEST_FAILED";
            }
          }
        } catch (error) {
          if (error) {
            evidence.modelRequest ??= { succeeded: false, errorCode: safeCode(error), threadId: threadId ? pseudonym("thread", threadId) : null };
            evidence.classification = evidence.classification === "MODEL_REQUEST_FAILED" ? evidence.classification : "MODEL_REQUEST_FAILED";
          }
        }
      }
    }
  } catch (error) {
    evidence.classification = evidence.config?.authConfigState === "NO_AUTH_CONFIG" ? "NO_AUTH_CONFIG" : "PROVIDER_AUTH_FAILED";
    evidence.appServerErrorCode = safeCode(error);
  } finally {
    await client.close().catch(() => null);
  }
}

evidence.finishedAt = new Date().toISOString();
await writeFile(resolve(evidenceDir, "minimal-real-token-e2e.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ classification: evidence.classification, cliVersion: evidence.cliVersion, appServerUserAgent: evidence.appServerUserAgent, config: evidence.config, accountRead: evidence.accountRead, modelList: evidence.modelList, modelRequest: evidence.modelRequest, tokenNotificationCount: evidence.tokenNotifications.length }, null, 2)}\n`);
