// Structured subordinate report parsing per docs/INTERFACES.md (frozen):
// "The adapter parses the CLI JSON envelope first, then parses/validates
// `response` as AgentReport." The response may contain surrounding prose, so
// balanced JSON-object candidates are scanned; `needs_master_decision` is
// required and never synthesized.
import type { AgentReport, TestReport } from "../interfaces.js";
import { validateAgentReport as sharedValidateAgentReport, validateTestReport as sharedValidateTestReport } from "../result-contract.mjs";

export type ReportParseResult =
  | { report: AgentReport; candidate: AgentReport; error: null }
  | { report: null; candidate: Partial<AgentReport> | null; error: string };

const MAX_SCAN_CHARS = 400_000;

export function parseAgentReport(responseText: string): ReportParseResult {
  let lastError: string | null = null;
  let lastCandidate: Partial<AgentReport> | null = null;
  for (const candidate of extractJsonObjects(responseText)) {
    const validated = validateAgentReport(candidate);
    if (validated.ok) {
      return { report: validated.report, candidate: validated.report, error: null };
    }
    lastError = validated.error;
    lastCandidate = extractReportCandidate(candidate);
  }
  return {
    report: null,
    candidate: lastCandidate,
    error: lastError ?? "no JSON object found in the response text",
  };
}

function extractReportCandidate(value: unknown): Partial<AgentReport> | null {
  if (!isPlainObject(value)) return null;
  const candidate: Partial<AgentReport> = {};
  if (typeof value["summary"] === "string") candidate.summary = value["summary"];
  if (isStringArray(value["files_changed"])) candidate.files_changed = value["files_changed"];
  if (isStringArray(value["issues"])) candidate.issues = value["issues"];
  if (typeof value["needs_master_decision"] === "boolean") candidate.needs_master_decision = value["needs_master_decision"];
  if (Array.isArray(value["tests"])) {
    const tests: TestReport[] = [];
    for (const entry of value["tests"]) {
      const test = validateTestReport(entry);
      if (!test.ok) return candidate;
      tests.push(test.test);
    }
    candidate.tests = tests;
  }
  return Object.keys(candidate).length ? candidate : null;
}

export function validateAgentReport(value: unknown): {ok:true;report:AgentReport}|{ok:false;error:string} {
  return sharedValidateAgentReport(value) as {ok:true;report:AgentReport}|{ok:false;error:string};
}
function validateTestReport(value:unknown): {ok:true;test:TestReport}|{ok:false;error:string} {
  return sharedValidateTestReport(value) as {ok:true;test:TestReport}|{ok:false;error:string};
}

/** Yields JSON.parse results for balanced top-level `{…}` blocks, string-aware. */
function* extractJsonObjects(text: string): Generator<unknown> {
  if (text.trimStart().startsWith("{")) {
    try {
      yield JSON.parse(text);
    } catch {
      // fall through to scanning
    }
  }
  const limit = Math.min(text.length, MAX_SCAN_CHARS);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          try {
            yield JSON.parse(slice);
          } catch {
            // malformed candidate; keep scanning
          }
          start = -1;
        }
      }
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
