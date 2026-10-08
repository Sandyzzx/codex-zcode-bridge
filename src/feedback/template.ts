// A4 fixed feedback template: one stable, human-judgeable structure answering
// four questions in fixed positions — what was delivered, what was verified,
// what it cost (time/tokens), and what needs a decision. Stable facts go in
// tables; the worker's JSON AgentReport contract is unchanged — this renders
// the projection for the calling host. Missing information is shown as
// 未报告/未取得/未知, never as blank cells, fake zeros, or inferred totals.
import type { AttemptTiming, ExecutionProfile, NormalizedUsage, TaskObservation, TaskResult, TaskStatusRecord } from "../interfaces.js";

export type FeedbackFact = { state: "yes" | "no" | "unknown" | "not_applicable"; evidence: string };

export interface FeedbackVerificationItem {
  item: string;
  /** 独立实测 by the calling host, worker 自报, 历史记录, or NOT RUN. */
  result: "独立实测通过" | "独立实测未通过" | "worker自报" | "历史记录" | "NOT RUN" | "未验证";
  evidence: string;
}

export interface FeedbackInput {
  objective: string;
  task_id: string;
  attempt: number;
  /** Bridge raw execution status; never a review verdict. */
  bridge_status: string;
  status_note?: string;
  delivered: string[];
  /** Master-side independent verification record (absent = 未验证). */
  verification?: { outcome: "通过" | "未通过" | "未验证" | "部分验证"; scope: string; items: FeedbackVerificationItem[] } | null;
  delivery?: { accepted?: FeedbackFact; committed?: FeedbackFact; pushed?: FeedbackFact; released?: FeedbackFact };
  /** Codex main-session tokens: unavailable until the host provides a
   * per-turn source. Never substituted from quotas or text estimates. */
  codex_tokens?: { state: "unavailable" | "reported"; note: string } | null;
  usage?: NormalizedUsage | null;
  usage_note?: string;
  model?: ExecutionProfile | null;
  timing?: { queue_ms?: number | null; execution_ms?: number | null; verify_ms?: number | null; wall_ms?: number | null; derived?: boolean; notes?: string[] } | null;
  /** A1 unified observation for the running/terminal task. */
  observation?: TaskObservation | null;
  /** Terminal TaskResult when one exists (worker report evidence). */
  result?: TaskResult | null;
  /** Running-task progress: phase, elapsed, last business progress, blockers. */
  running?: { phase: string; elapsed_ms: number | null; last_progress_at: string | null; blockers: string[]; tokens_note: string } | null;
  blockers: string[];
  decisions: string[];
  next_steps: string[];
  /** Report-period caveat, e.g. 截至报告生成时. */
  as_of_note?: string;
}

const UNKNOWN = "未知";
const NOT_REPORTED = "未报告";

export function escapeCell(text: string): string {
  return text
    .replace(/\r/gu, " ")
    .replace(/\n/gu, " ")
    .replace(/\|/gu, "\\|")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/gu, "[$1](($2))")
    .slice(0, 2_000);
}

export function formatTokens(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_REPORTED;
  return value.toLocaleString("en-US");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} 小时 ${restMinutes} 分 ${seconds} 秒`;
}

function factLabel(fact: FeedbackFact | undefined, yesText: string, noText: string, naText = "不适用"): string {
  if (!fact) return `${noText}（未提供证据）`;
  const state = fact.state === "yes" ? yesText : fact.state === "no" ? noText : fact.state === "not_applicable" ? naText : `${UNKNOWN}`;
  return `${state}；依据：${fact.evidence || "未提供"}`;
}

function usageSummary(usage: NormalizedUsage | null | undefined, note?: string): string {
  if (!usage) return `${NOT_REPORTED}${note ? `（${note}）` : "（本次未取得任何运行时统计）"}`;
  const parts = [
    `输入 ${formatTokens(usage.input_tokens)}`,
    `输出 ${formatTokens(usage.output_tokens)}`,
    `总量 ${formatTokens(usage.total_tokens)}`,
  ];
  if (usage.cached_input_tokens !== null) parts.push(`缓存输入 ${formatTokens(usage.cached_input_tokens)}`);
  if (usage.reasoning_tokens !== null) parts.push(`推理 ${formatTokens(usage.reasoning_tokens)}`);
  const completeness = usage.total_tokens !== null && usage.input_tokens !== null && usage.output_tokens !== null ? "字段完整" : "字段不完整（缺失项未报告）";
  const conflicts = usage.conflicts.length ? `；冲突：${usage.conflicts.join("、")}` : "";
  const suffix = note ? `；${note}` : "";
  return `${parts.join("，")}（${completeness}${conflicts}）${suffix}`;
}

function modelSummary(model: ExecutionProfile | null | undefined): string {
  if (!model) return `ZCode 模型：${NOT_REPORTED}；推理档位：${NOT_REPORTED}（runtime 未确认）`;
  const requested = model.requested_model ? `请求 ${model.requested_model}` : null;
  const effective = model.provider_id && model.model_id ? `实际 ${model.provider_id}/${model.model_id}` : `实际 ${NOT_REPORTED}`;
  const reasoning = model.effective_reasoning_level
    ? `档位 ${model.effective_reasoning_level}（${model.effective_reasoning_level_source === "runtime" ? "runtime 确认" : "来源未确认"}）`
    : `档位 未报告（runtime 未确认）`;
  const requestedLevel = model.requested_reasoning_level ? `；请求档位 ${model.requested_reasoning_level}` : "";
  const mismatch = model.requested_model && model.provider_id && !`${model.provider_id}/${model.model_id}`.includes(model.requested_model) ? "；⚠ 请求与实际不一致" : "";
  return [`ZCode 模型：${effective}`, reasoning, requested, requestedLevel].filter(Boolean).join("；") + mismatch;
}

function observationSummary(observation: TaskObservation | null | undefined): string {
  if (!observation) return UNKNOWN;
  return `${observation.activity.code}（${observation.activity.reason_code}）；worker ${observation.worker.state}/${observation.worker.reason_code}；runtime ${observation.runtime.state}/${observation.runtime.reason_code}；result ${observation.result}；cleanup ${observation.cleanup}${observation.stalled ? "；⚠ 停滞提示（仅观测，不自动处理）" : ""}`;
}

/**
 * Renders the fixed feedback document. Every outcome shape fills the same
 * core fields; a missing verification record can never be rendered as a pass
 * (A4-01/02), and unexecuted publish steps are shown as not performed with
 * that fact stated (A4-03).
 */
export function renderFeedback(input: FeedbackInput): string {
  const lines: string[] = [];
  const delivery = input.delivery ?? {};
  const headline = input.running
    ? `任务 ${input.task_id}（attempt ${input.attempt}）仍在运行：当前阶段 ${input.running.phase}。`
    : `${input.bridge_status === "completed" ? "执行已完成（不等于验收通过）" : `Bridge 状态 ${input.bridge_status}`}：任务 ${input.task_id}（attempt ${input.attempt}）。`;
  lines.push(`## ${headline}`);
  if (input.as_of_note) lines.push(`> ${input.as_of_note}`);
  lines.push("", "### 任务总览", "", "| 项目 | 内容 |", "| --- | --- |");
  lines.push(`| 目标与交付 | ${escapeCell(input.objective)} 交付：${input.delivered.length ? input.delivered.map(escapeCell).join("、") : "未报告交付文件"} |`);
  lines.push(`| 执行标识 | task_id \`${escapeCell(input.task_id)}\`；attempt ${input.attempt} |`);
  lines.push(`| 执行状态 | Bridge 原始状态：\`${escapeCell(input.bridge_status)}\`${input.status_note ? `；${escapeCell(input.status_note)}` : "（执行状态，不等同验收通过）"} |`);
  const verification = input.verification;
  const verdictText = verification ? `${verification.outcome}（${verification.scope}）` : "未验证（无独立验收记录；worker 自报不构成通过）";
  lines.push(`| 独立验收 | ${verdictText} |`);
  lines.push(`| 接收与发布 | 接收：${factLabel(delivery.accepted, "已接收", "未接收")}；提交：${factLabel(delivery.committed, "已提交", "未提交")}；推送：${factLabel(delivery.pushed, "已推送", "未推送")}；发布：${factLabel(delivery.released, "已发布", "未发布")} |`);
  const timing = input.timing;
  const queue = timing ? formatDuration(timing.queue_ms ?? null) : UNKNOWN;
  const execution = timing ? formatDuration(timing.execution_ms ?? null) : UNKNOWN;
  const verify = timing ? formatDuration(timing.verify_ms ?? null) : UNKNOWN;
  const wall = timing ? formatDuration(timing.wall_ms ?? null) : UNKNOWN;
  const derivedMark = timing?.derived ? "（derived：跨重启/续跑由墙钟推导）" : "";
  lines.push(`| 本次耗时 | 排队 ${queue}；执行 ${execution}${derivedMark}；独立验证 ${verify}；报告周期合计 ${wall}。未知项不并入总数。 |`);
  lines.push(`| Codex 主会话 token | ${input.codex_tokens ? (input.codex_tokens.state === "unavailable" ? escapeCell(input.codex_tokens.note) : escapeCell(input.codex_tokens.note)) : "未取得：当前宿主未提供本次调用统计"} |`);
  const usageText = input.running
    ? input.running.tokens_note
    : usageSummary(input.usage, input.usage_note);
  lines.push(`| ZCode 执行 token | ${escapeCell(usageText)} |`);
  lines.push(`| 模型与推理档位 | ${escapeCell(modelSummary(input.model))} |`);
  lines.push(`| 观测（运行期） | ${escapeCell(observationSummary(input.observation))} |`);
  lines.push(`| 后续动作 | ${input.blockers.length || input.decisions.length || input.next_steps.length ? "见下方待处理事项" : "无"} |`);

  lines.push("", "### 验收证据", "", "| 检查项 | 结果 | 证据 |", "| --- | --- | --- |");
  const evidenceRows: FeedbackVerificationItem[] = [...(verification?.items ?? [])];
  if (input.result) {
    const result = input.result as TaskResult;
    for (const test of result.tests.slice(0, 20)) {
      evidenceRows.push({
        item: `worker 测试 ${escapeCell(test.command)}`,
        result: "worker自报",
        evidence: `${test.status}${test.details ? `：${test.details.slice(0, 200)}` : ""}`,
      });
    }
    if (result.error_code) evidenceRows.push({ item: "执行错误码", result: "历史记录", evidence: result.error_code });
    if (result.report_candidate) evidenceRows.push({ item: "结构化报告", result: "历史记录", evidence: "候选报告已保留（report_candidate）；不构成宿主独立验收" });
  }
  if (input.observation?.cleanup === "unverified") {
    evidenceRows.push({ item: "进程清理", result: "未验证", evidence: "cleanup 未确认：现有证据无法确认进程树退出；目录保留" });
  } else if (input.observation?.cleanup === "verified") {
    evidenceRows.push({ item: "当前进程清理", result: "历史记录", evidence: "Bridge 当前观测 cleanup=verified；不改写原 attempt 结果或代替代码验收" });
    if (input.result?.error_code === "cleanup_failed") {
      evidenceRows.push({ item: "原 attempt 清理结果", result: "历史记录", evidence: "cleanup_failed 记录当时未能确认清理；后续验证已确认退出，原 failed 仍保留" });
    }
  }
  if (!evidenceRows.length) evidenceRows.push({ item: "（无证据记录）", result: "未验证", evidence: "本任务没有可展示的检查项" });
  for (const row of evidenceRows.slice(0, 50)) {
    lines.push(`| ${escapeCell(row.item)} | ${row.result} | ${escapeCell(row.evidence)} |`);
  }

  if (input.running) {
    lines.push("", `运行中：已执行 ${formatDuration(input.running.elapsed_ms)}；最后业务进展 ${input.running.last_progress_at ?? UNKNOWN}。`);
    if (input.running.blockers.length) lines.push(`当前阻塞：${input.running.blockers.map(escapeCell).join("；")}`);
  }

  const pending: string[] = [];
  for (const blocker of input.blockers) pending.push(`阻塞：${blocker}`);
  for (const decision of input.decisions) pending.push(`需决定：${decision}`);
  for (const step of input.next_steps) pending.push(`下一步：${step}`);
  lines.push("", "### 待处理事项", "");
  if (pending.length) for (const item of pending) lines.push(`- ${item}`);
  else lines.push("- 无");
  return lines.join("\n");
}

/** Convenience projection from a Bridge status/result pair (running or terminal).
 * A running record never inherits a previous attempt's usage/timing facts. */
export function feedbackInputFromRecord(record: TaskStatusRecord, result: TaskResult | null): FeedbackInput {
  const terminal = record.status !== "queued" && record.status !== "running";
  const currentResult = terminal && result?.task_id === record.task_id && result.attempt === record.attempt && result.status === record.status ? result : null;
  const elapsed = record.started_at ? Math.max(0, Date.now() - Date.parse(record.started_at)) || null : null;
  return {
    objective: `task ${record.task_id}`,
    task_id: record.task_id,
    attempt: record.attempt,
    bridge_status: record.status,
    delivered: currentResult?.files_changed ?? [],
    usage: currentResult?.usage ?? null,
    model: currentResult?.model ?? null,
    timing: currentResult?.timing ? { ...currentResult.timing, verify_ms: null } : null,
    observation: record.observation ?? null,
    result: currentResult,
    running: terminal ? null : {
      phase: record.observation?.activity.code ?? record.status,
      elapsed_ms: elapsed,
      last_progress_at: record.observation?.evidence.last_event_age_ms !== null && record.observation?.evidence.last_event_age_ms !== undefined
        ? new Date(Date.parse(record.observation.activity.observed_at) - record.observation.evidence.last_event_age_ms).toISOString()
        : null,
      blockers: record.status === "waiting_for_master" ? ["任务等待 Master 反馈"] : [],
      tokens_note: "截至当前未取得最终 token（任务未结束）",
    },
    blockers: [],
    decisions: currentResult?.needs_master_decision ? ["worker 报告标记需要 Master 决定"] : [],
    next_steps: [],
  };
}
