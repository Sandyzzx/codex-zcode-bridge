import type { FeedbackCodexTokens } from "./template.js";
import { formatTokens } from "./template.js";
import type {
  CodexMasterTokenUsageResult,
} from "../observability/codex-master-token-usage.js";

/**
 * Map one explicit Rollout result into the pre-existing Master token field.
 * The field's single-call meaning is preserved by requiring an explicit
 * baseline. Detailed Rollout telemetry stays on the source result.
 */
export function codexMasterTokenFeedback(result: CodexMasterTokenUsageResult): FeedbackCodexTokens {
  if (result.status !== "ok") {
    return {
      state: "unavailable",
      note: "未取得",
    };
  }

  if (result.reportWindowTotalTokens === null || result.reportWindowBasis !== "absolute_total_delta") {
    return {
      state: "unavailable",
      note: "未取得",
    };
  }

  return {
    state: "reported",
    note: formatTokens(result.reportWindowTotalTokens),
  };
}
