import { createHash } from "node:crypto";
import { CodexMasterTokenUsageSource } from "./codex-master-token-usage.js";
import { codexMasterTokenFeedback } from "../feedback/codex-master-token.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name}_requires_value`);
  return value;
}

function parseBaseline(): number | null {
  const value = option("--baseline-total");
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("baseline_total_invalid");
  return parsed;
}

function threadRef(threadId: string | null): string | null {
  return threadId
    ? `thread#${createHash("sha256").update(threadId).digest("hex").slice(0, 12)}`
    : null;
}

const explicitThreadId = option("--thread-id");
const baselineTotalTokens = parseBaseline();
const source = new CodexMasterTokenUsageSource();
const result = await source.query({
  ...(explicitThreadId === null ? {} : { threadId: explicitThreadId }),
  ...(baselineTotalTokens === null ? {} : { baselineTotalTokens }),
});

process.stdout.write(`${JSON.stringify({
  query: {
    status: result.status,
    source: result.source,
    thread_ref: threadRef(result.threadId),
    thread_id_source: result.threadIdSource,
    codex_home_source: result.codexHomeSource,
    read_mode: result.readMode,
    tail_status: result.tailStatus,
    reset_reason: result.resetReason,
    total: result.total,
    last: result.last,
    model_context_window: result.modelContextWindow,
    observed_at: result.observedAt,
    baseline_total_tokens: result.baselineTotalTokens,
    report_window_total_tokens: result.reportWindowTotalTokens,
    report_window_basis: result.reportWindowBasis,
    detail: result.detail,
  },
  feedback_codex_tokens: codexMasterTokenFeedback(result),
}, null, 2)}\n`);
