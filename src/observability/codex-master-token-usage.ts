import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  CodexRolloutTailReader,
  discoverCodexRolloutByThreadId,
  type CodexRolloutUsageBreakdown,
} from "./codex-rollout-token-source.js";

export type CodexMasterTokenUsageStatus =
  | "ok"
  | "thread_id_missing"
  | "thread_identity_unverified"
  | "rollout_not_found"
  | "rollout_ambiguous"
  | "no_token_count"
  | "file_changed"
  | "source_unavailable";

export interface CodexMasterTokenUsageResult {
  status: CodexMasterTokenUsageStatus;
  source: "codex_rollout";
  threadId: string | null;
  threadIdSource: "explicit_argument" | "codex_environment" | null;
  codexHomeSource: "explicit_argument" | "codex_environment" | "default_user_profile";
  readMode: "initial" | "incremental" | null;
  tailStatus: string | null;
  resetReason: "initial" | "truncated" | "replaced" | null;
  total: CodexRolloutUsageBreakdown | null;
  last: CodexRolloutUsageBreakdown | null;
  modelContextWindow: number | null;
  observedAt: string | null;
  baselineTotalTokens: number | null;
  reportWindowTotalTokens: number | null;
  reportWindowBasis: "absolute_total_delta" | null;
  detail: string | null;
}

export interface CodexMasterTokenUsageSourceOptions {
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  maxReaders?: number;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function unavailable(
  status: Exclude<CodexMasterTokenUsageStatus, "ok">,
  input: {
    threadId: string | null;
    threadIdSource: CodexMasterTokenUsageResult["threadIdSource"];
    codexHomeSource: CodexMasterTokenUsageResult["codexHomeSource"];
    baselineTotalTokens: number | null;
    detail?: string;
  },
): CodexMasterTokenUsageResult {
  return {
    status,
    source: "codex_rollout",
    threadId: input.threadId,
    threadIdSource: input.threadIdSource,
    codexHomeSource: input.codexHomeSource,
    readMode: null,
    tailStatus: null,
    resetReason: null,
    total: null,
    last: null,
    modelContextWindow: null,
    observedAt: null,
    baselineTotalTokens: input.baselineTotalTokens,
    reportWindowTotalTokens: null,
    reportWindowBasis: null,
    detail: input.detail ?? null,
  };
}

/**
 * Read-only adapter from one explicitly identified Codex main Thread to the
 * existing Master feedback token field. It never discovers an active Thread by
 * recency and never writes offsets or token data to Bridge storage.
 */
export class CodexMasterTokenUsageSource {
  private readonly env: NodeJS.ProcessEnv;
  private readonly codexHome: string;
  private readonly codexHomeSource: CodexMasterTokenUsageResult["codexHomeSource"];
  private readonly maxReaders: number;
  private readonly readers = new Map<string, CodexRolloutTailReader>();

  constructor(options: CodexMasterTokenUsageSourceOptions = {}) {
    this.env = options.env ?? process.env;
    const explicitHome = options.codexHome?.trim();
    const environmentHome = this.env["CODEX_HOME"]?.trim();
    if (explicitHome) {
      this.codexHome = resolve(explicitHome);
      this.codexHomeSource = "explicit_argument";
    } else if (environmentHome && isAbsolute(environmentHome)) {
      this.codexHome = resolve(environmentHome);
      this.codexHomeSource = "codex_environment";
    } else {
      this.codexHome = resolve(homedir(), ".codex");
      this.codexHomeSource = "default_user_profile";
    }
    const maxReaders = options.maxReaders ?? 8;
    if (!Number.isSafeInteger(maxReaders) || maxReaders < 1 || maxReaders > 32) {
      throw new Error("max_readers_out_of_range");
    }
    this.maxReaders = maxReaders;
  }

  private threadId(input: { threadId?: string }): {
    threadId: string | null;
    threadIdSource: CodexMasterTokenUsageResult["threadIdSource"];
  } {
    if (Object.hasOwn(input, "threadId")) {
      const explicit = input.threadId?.trim() ?? "";
      return { threadId: explicit || null, threadIdSource: "explicit_argument" };
    }
    const fromCodex = this.env["CODEX_THREAD_ID"]?.trim() ?? "";
    return {
      threadId: fromCodex || null,
      threadIdSource: fromCodex ? "codex_environment" : null,
    };
  }

  private cache(threadId: string, reader: CodexRolloutTailReader): void {
    this.readers.delete(threadId);
    this.readers.set(threadId, reader);
    while (this.readers.size > this.maxReaders) {
      const oldest = this.readers.keys().next().value as string | undefined;
      if (!oldest) break;
      this.readers.delete(oldest);
    }
  }

  async query(input: { threadId?: string; baselineTotalTokens?: number | null } = {}): Promise<CodexMasterTokenUsageResult> {
    const resolvedThread = this.threadId(input);
    const baselineTotalTokens = safeInteger(input.baselineTotalTokens);
    if (!resolvedThread.threadId) {
      return unavailable("thread_id_missing", {
        ...resolvedThread,
        codexHomeSource: this.codexHomeSource,
        baselineTotalTokens,
        detail: "CODEX_THREAD_ID 未设置；不会扫描或猜测当前活动 Thread",
      });
    }

    const threadId = resolvedThread.threadId;
    let reader = this.readers.get(threadId) ?? null;
    const readMode = reader ? "incremental" : "initial";
    if (!reader) {
      let discovery;
      try {
        discovery = await discoverCodexRolloutByThreadId({
          codexHome: this.codexHome,
          expectedThreadId: threadId,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_thread_id") {
          return unavailable("thread_identity_unverified", {
            ...resolvedThread,
            codexHomeSource: this.codexHomeSource,
            baselineTotalTokens,
            detail: "Thread ID 格式无效",
          });
        }
        return unavailable("source_unavailable", {
          ...resolvedThread,
          codexHomeSource: this.codexHomeSource,
          baselineTotalTokens,
          detail: error instanceof Error ? error.message : "Rollout discovery failed",
        });
      }

      if (discovery.state !== "found" || !discovery.sourceFile) {
        const status = discovery.state === "not_found"
          ? "rollout_not_found"
          : discovery.state === "ambiguous"
            ? "rollout_ambiguous"
            : "thread_identity_unverified";
        return unavailable(status, {
          ...resolvedThread,
          codexHomeSource: this.codexHomeSource,
          baselineTotalTokens,
          detail: `discovery_state=${discovery.state}`,
        });
      }

      try {
        reader = await CodexRolloutTailReader.open({
          codexHome: this.codexHome,
          rolloutFile: discovery.sourceFile,
          expectedThreadId: threadId,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const status = code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM"
          ? "file_changed"
          : "thread_identity_unverified";
        return unavailable(status, {
          ...resolvedThread,
          codexHomeSource: this.codexHomeSource,
          baselineTotalTokens,
          detail: error instanceof Error ? error.message : "Rollout reader could not be opened",
        });
      }
      this.cache(threadId, reader);
    }

    let poll;
    try {
      poll = await reader.poll();
    } catch (error) {
      this.readers.delete(threadId);
      return unavailable("source_unavailable", {
        ...resolvedThread,
        codexHomeSource: this.codexHomeSource,
        baselineTotalTokens,
        detail: error instanceof Error ? error.message : "Rollout poll failed",
      });
    }

    if (poll.status === "file_changed") {
      this.readers.delete(threadId);
      return unavailable("file_changed", {
        ...resolvedThread,
        codexHomeSource: this.codexHomeSource,
        baselineTotalTokens,
        detail: "Rollout 文件暂时缺失、替换或读取期间发生变化；下一次查询会重新发现",
      });
    }
    if (poll.status === "identity_unverified") {
      this.readers.delete(threadId);
      return unavailable("thread_identity_unverified", {
        ...resolvedThread,
        codexHomeSource: this.codexHomeSource,
        baselineTotalTokens,
        detail: "Rollout 文件名或 session_meta 身份与显式 Thread ID 不一致",
      });
    }

    const snapshot = poll.state.lastValidSnapshot;
    if (!snapshot || snapshot.threadId !== threadId) {
      this.readers.delete(threadId);
      return unavailable("no_token_count", {
        ...resolvedThread,
        codexHomeSource: this.codexHomeSource,
        baselineTotalTokens,
        detail: "Rollout 中尚无有效且身份匹配的 TokenCount",
      });
    }

    const currentTotal = snapshot.total?.totalTokens ?? null;
    const reportWindowTotalTokens = baselineTotalTokens !== null &&
      currentTotal !== null && currentTotal >= baselineTotalTokens
      ? currentTotal - baselineTotalTokens
      : null;
    return {
      status: "ok",
      source: "codex_rollout",
      threadId,
      threadIdSource: resolvedThread.threadIdSource,
      codexHomeSource: this.codexHomeSource,
      readMode,
      tailStatus: poll.status,
      resetReason: poll.resetReason,
      total: snapshot.total,
      last: snapshot.last,
      modelContextWindow: snapshot.modelContextWindow,
      observedAt: snapshot.observedAt,
      baselineTotalTokens,
      reportWindowTotalTokens,
      reportWindowBasis: reportWindowTotalTokens === null ? null : "absolute_total_delta",
      detail: poll.state.pendingBytes > 0
        ? `tail_pending_bytes=${poll.state.pendingBytes}`
        : null,
    };
  }
}
