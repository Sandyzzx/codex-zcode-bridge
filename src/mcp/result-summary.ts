import type { TaskResult } from "../interfaces.js";

const INLINE_RESULT_BYTES = 2_048;
const MAX_ITEM_CHARS = 256;

export function summarizeTaskResult(result: TaskResult) {
  if (result.zcode_output.length <= INLINE_RESULT_BYTES
    && Buffer.byteLength(JSON.stringify(result)) <= INLINE_RESULT_BYTES) {
    return result;
  }

  const { summary, files_changed, tests, issues, zcode_output, report_candidate, model, usage, timing, ...identity } = result;
  const omittedFields = ["zcode_output"];
  const summaryPreview = summary.slice(0, 768).replace(/[\uD800-\uDBFF]$/, "");
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

  return {
    ...identity,
    summary: summaryPreview,
    files_changed: filesPreview,
    tests: testPreview,
    issues: issuesPreview,
    projection: { omitted_fields: omittedFields, test_counts: testCounts },
  };
}
