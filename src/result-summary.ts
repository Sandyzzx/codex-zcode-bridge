import type { TaskResult } from "./interfaces.js";
import { withoutRpcStack } from "./adapters/rpc-diagnostics.js";

const INLINE_RESULT_BYTES = 2_048;
const MAX_ITEM_CHARS = 256;
/** ADR-066: compact RPC message of the summary projection; the full Result keeps 500. */
const MAX_RPC_MESSAGE_PREVIEW_CHARS = 240;

/** Shared ADR-047 Result projection used by MCP and the Task CLI. */
export function summarizeTaskResult(result: TaskResult) {
  // ADR-066: the stack of an RPC rejection is read only through the full
  // Result, so even an inline-sized summary never carries it.
  const diagnostics = result.rpc_diagnostics?.map(withoutRpcStack);
  const source = diagnostics ? { ...result, rpc_diagnostics: diagnostics } : result;
  if (source.zcode_output.length <= INLINE_RESULT_BYTES
    && Buffer.byteLength(JSON.stringify(source)) <= INLINE_RESULT_BYTES) {
    return source;
  }

  const { summary, files_changed, tests, issues, zcode_output, report_candidate, model, usage, timing, rpc_diagnostics, ...identity } = source;
  const omittedFields = ["zcode_output"];
  const summaryPreview = summary.slice(0, 768).replace(/[\uD800-\uDBFF]$/u, "");
  if (summaryPreview !== summary) omittedFields.push("summary");
  // Paths and commands must be shown whole or left out.
  const filesPreview = files_changed.slice(0, 12).filter((file) => file.length <= MAX_ITEM_CHARS);
  if (filesPreview.length !== files_changed.length) omittedFields.push("files_changed");
  const issuesPreview = issues.slice(0, 8).filter((issue) => issue.length <= MAX_ITEM_CHARS);
  if (issuesPreview.length !== issues.length) omittedFields.push("issues");

  const testCounts = { passed: 0, failed: 0, not_run: 0 };
  for (const { status } of tests) testCounts[status] += 1;
  const testPreview = tests.slice(0, 12)
    .filter(({ command }) => command.length <= MAX_ITEM_CHARS)
    .map(({ command, status }) => ({ command, status }));
  if (testPreview.length !== tests.length || tests.some(({ details }) => details !== undefined)) {
    omittedFields.push("tests");
  }
  if (report_candidate !== undefined) omittedFields.push("report_candidate");
  if (model !== undefined) omittedFields.push("model");
  if (usage !== undefined) omittedFields.push("usage");
  if (timing !== undefined) omittedFields.push("timing");
  if (result.rpc_diagnostics?.some((diagnostic) => diagnostic.stack !== undefined)) omittedFields.push("rpc_diagnostics.stack");

  return {
    ...identity,
    summary: summaryPreview,
    files_changed: filesPreview,
    tests: testPreview,
    issues: issuesPreview,
    ...(rpc_diagnostics ? {
      rpc_diagnostics: rpc_diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: diagnostic.message.length <= MAX_RPC_MESSAGE_PREVIEW_CHARS
          ? diagnostic.message
          : diagnostic.message.slice(0, MAX_RPC_MESSAGE_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/u, ""),
      })),
    } : {}),
    projection: { omitted_fields: omittedFields, test_counts: testCounts },
  };
}
