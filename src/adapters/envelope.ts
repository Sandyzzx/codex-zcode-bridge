// CLI JSON envelope parsing per docs/ARCHITECTURE.md: parse exactly one JSON
// envelope; require `sessionId` and `response`; validate expected optional
// fields. Only called for exit code 0 by the adapter.
import type { ZcodeEnvelope } from "./zcode-envelope-types.js";

export type EnvelopeParseResult =
  | { envelope: ZcodeEnvelope; error: null }
  | { envelope: null; error: string };

export function parseZcodeEnvelope(stdoutText: string): EnvelopeParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutText);
  } catch (error) {
    return {
      envelope: null,
      error: `stdout is not a single JSON document (${summarize(error)})`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { envelope: null, error: "stdout JSON is not an object" };
  }

  const sessionId = parsed["sessionId"];
  if (typeof sessionId !== "string" || !/^sess_\S+$/.test(sessionId)) {
    return {
      envelope: null,
      error: "envelope field sessionId is missing or not a sess_… identifier",
    };
  }

  const response = parsed["response"];
  if (typeof response !== "string" || response.trim().length === 0) {
    return { envelope: null, error: "envelope field response is missing or empty" };
  }

  let usage: Record<string, unknown> | null = null;
  if (parsed["usage"] !== undefined) {
    if (!isPlainObject(parsed["usage"])) {
      return { envelope: null, error: "envelope field usage is present but not an object" };
    }
    usage = parsed["usage"];
  }

  if (parsed["projection"] !== undefined && !isPlainObject(parsed["projection"])) {
    return { envelope: null, error: "envelope field projection is present but not an object" };
  }

  return { envelope: { sessionId, response, usage }, error: null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
