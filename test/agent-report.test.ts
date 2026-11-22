// AgentReport parsing/validation tests: extraction from prose, field
// validation, and the never-synthesize rule for needs_master_decision.
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentReport, validateAgentReport } from "../src/adapters/agent-report.js";
import { validReport } from "./helpers.js";

test("a bare JSON response parses directly", () => {
  const result = parseAgentReport(JSON.stringify(validReport()));
  assert.equal(result.error, null);
  assert.equal(result.report?.summary, "Created the requested file");
});

test("a report fenced in markdown prose is extracted", () => {
  const response = [
    "I completed the task. Here is the report:",
    "",
    "```json",
    JSON.stringify(validReport(), null, 2),
    "```",
    "",
    "Let me know if anything else is needed.",
  ].join("\n");
  const result = parseAgentReport(response);
  assert.equal(result.error, null);
  assert.equal(result.report?.files_changed.length, 1);
});

test("the first valid JSON object wins when prose contains distractor objects", () => {
  const report = validReport();
  const response = `Config used: {"unrelated": true}\n${JSON.stringify(report)}`;
  const result = parseAgentReport(response);
  assert.equal(result.error, null);
  assert.equal(result.report?.summary, report.summary);
});

test("a JSON object containing braces inside strings is extracted intact", () => {
  const report = validReport({ summary: "wrote { and } and \"quotes\"" });
  const result = parseAgentReport(`Report: ${JSON.stringify(report)} end`);
  assert.equal(result.error, null);
  assert.match(result.report!.summary, /\{ and \}/);
});

test("a report after the former 400_000-character scan boundary is found", () => {
  const report = validReport({ summary: "tail report after 400_000 chars" });
  const filler = ".".repeat(400_001);
  const response = `${filler}${JSON.stringify(report)} tail prose`;
  const result = parseAgentReport(response);
  assert.equal(result.error, null);
  assert.equal(result.report?.summary, "tail report after 400_000 chars");
});

test("string escapes inside a long report keep the candidate balanced", () => {
  const summary = `escaped after filler: {brace} and "quotes" and \\backslash`;
  const report = validReport({ summary });
  const response = `x${".".repeat(400_000)}${JSON.stringify(report)}`;
  const result = parseAgentReport(response);
  assert.equal(result.error, null);
  assert.equal(result.report?.summary, summary);
});

test("malformed JSON candidates are skipped and a later schema-invalid object stays rejected", () => {
  const response = `${".".repeat(400_001)}{not-json}${JSON.stringify({
    summary: "missing required fields",
    files_changed: [],
    tests: [],
    issues: [],
  })}`;
  const result = parseAgentReport(response);
  assert.equal(result.report, null);
  assert.match(result.error!, /needs_master_decision/);
});

test("missing needs_master_decision is rejected, never defaulted", () => {
  const partial = { summary: "s", files_changed: [], tests: [], issues: [] };
  const result = parseAgentReport(JSON.stringify(partial));
  assert.equal(result.report, null);
  assert.match(result.error!, /needs_master_decision/);
});

test("wrong field types are rejected with concrete messages", () => {
  const errorOf = (value: unknown): string => {
    const result = validateAgentReport(value);
    assert.equal(result.ok, false);
    return (result as { error: string }).error;
  };
  assert.match(errorOf({ ...validReport(), summary: "" }), /summary/);
  assert.match(errorOf({ ...validReport(), files_changed: "a.txt" }), /files_changed/);
  assert.match(errorOf({ ...validReport(), issues: [1] }), /issues/);
  assert.match(errorOf({ ...validReport(), tests: [{ command: "x", status: "skipped" }] }), /status/);
  assert.match(errorOf({ ...validReport(), tests: [{ status: "passed" }] }), /command/);
  assert.match(errorOf("not an object"), /not a JSON object/);
  assert.match(errorOf(null), /not a JSON object/);
});

test("optional test details survive normalization and no response yields a clear error", () => {
  const withDetails = validReport({
    tests: [{ command: "pytest -q", status: "failed", details: "1 failed" }],
  });
  const parsed = parseAgentReport(JSON.stringify(withDetails));
  assert.equal(parsed.report?.tests[0]?.details, "1 failed");

  const empty = parseAgentReport("The task is done, no report though.");
  assert.equal(empty.report, null);
  assert.match(empty.error!, /no JSON object found/);
});
