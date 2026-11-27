// ADR-066: bounded, redacted diagnostics of a rejected official RPC. A failed
// Result carries them so a failure before any model turn can be diagnosed
// from persisted evidence instead of a reproduction. Nothing here keeps a
// request or response payload, params, headers or a filesystem directory.
import { canonical } from "../result-contract.mjs";
import type { RpcDiagnostic } from "../interfaces.js";

export const MAX_RPC_DIAGNOSTICS = 4;
export const MAX_RPC_DIAGNOSTICS_BYTES = 8 * 1024;
export const MAX_RPC_MESSAGE_CHARS = 500;
export const MAX_RPC_STACK_FRAMES = 12;
export const MAX_RPC_STACK_CHARS = 1200;

const MAX_DATA_NAME_CHARS = 64;
const MAX_DATA_CODE_CHARS = 128;
/** Only this much of an upstream stack is inspected. */
const MAX_RAW_STACK_CHARS = 64_000;
const TRUNCATED_MARKER = "…[truncated]";

/** Official RPC method shape, e.g. `session/setModel`. Anything else is not recorded. */
const RPC_METHOD = /^[a-z]+(?:\/[A-Za-z0-9_]+){1,2}$/u;
const DATA_NAME_TOKEN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const DATA_CODE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const FUNCTION_NAME = /^(?:(?:new |async )*[A-Za-z0-9_$.[\]<> ]{1,100})?$/u;

/**
 * Diagnose one rejected RPC from the rejection the official client produced
 * (`{ code, message, data: { name, code, stack } }`). Null when nothing
 * diagnosable is present or the method is not an official RPC method.
 */
export function extractRpcDiagnostic(method: string, error: unknown): RpcDiagnostic | null {
  if (!RPC_METHOD.test(method)) return null;
  const rejection = asRecord(error);
  const rawCode = rejection?.code;
  const code = typeof rawCode === "number" && Number.isSafeInteger(rawCode) ? rawCode : null;
  const data = asRecord(rejection?.data);
  const dataName = token(data?.name, DATA_NAME_TOKEN, MAX_DATA_NAME_CHARS);
  const dataCode = token(data?.code, DATA_CODE_TOKEN, MAX_DATA_CODE_CHARS);
  const message = singleLine(rejection?.message, MAX_RPC_MESSAGE_CHARS);
  const stack = sanitizeStack(data?.stack);
  if (code === null && message === "" && dataName === null && dataCode === null && stack === undefined) return null;
  return { method, code, message, data_name: dataName, data_code: dataCode, ...(stack === undefined ? {} : { stack }) };
}

/**
 * Keep the diagnostics of one Attempt: first occurrence wins per
 * method + code + data_code, at most 4 entries and 8 KiB in total. An entry
 * that does not fit is retried without its stack, then left out.
 */
export function appendRpcDiagnostic(
  list: readonly RpcDiagnostic[],
  diagnostic: RpcDiagnostic,
): readonly RpcDiagnostic[] {
  if (list.some((entry) => sameRejection(entry, diagnostic))) return list;
  if (list.length >= MAX_RPC_DIAGNOSTICS) return list;
  const withStack = [...list, diagnostic];
  if (diagnosticsBytes(withStack) <= MAX_RPC_DIAGNOSTICS_BYTES) return withStack;
  const { stack: _omitted, ...withoutStack } = diagnostic;
  return diagnosticsBytes([...list, withoutStack]) <= MAX_RPC_DIAGNOSTICS_BYTES
    ? [...list, withoutStack]
    : list;
}

/** The summary projection of a Result never returns a stack (ADR-066). */
export function withoutRpcStack(diagnostic: RpcDiagnostic): RpcDiagnostic {
  if (diagnostic.stack === undefined) return diagnostic;
  const { stack: _omitted, ...rest } = diagnostic;
  return rest;
}

function sameRejection(left: RpcDiagnostic, right: RpcDiagnostic): boolean {
  return left.method === right.method && left.code === right.code && left.data_code === right.data_code;
}

function diagnosticsBytes(list: readonly RpcDiagnostic[]): number {
  return Buffer.byteLength(String(canonical(list)), "utf8");
}

function token(value: unknown, pattern: RegExp, maxChars: number): string | null {
  return typeof value === "string" && value.length <= maxChars && pattern.test(value) ? value : null;
}

function singleLine(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return limit(redactDiagnosticText(value).replace(/\s+/gu, " ").trim(), maxChars);
}

/**
 * Reduce a stack to `at <function> (<basename>:<line>:<column>)` frames. The
 * leading `<name>: <message>` line, every directory and every unparsable
 * frame are dropped; `node:` and `native` locations are kept as they are.
 */
function sanitizeStack(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const frames: string[] = [];
  for (const line of value.slice(0, MAX_RAW_STACK_CHARS).split(/\r?\n/u)) {
    const frame = /^at\s+(.+)$/u.exec(line.trim());
    if (!frame) continue;
    const rendered = sanitizeFrame(frame[1]!);
    if (rendered === null) continue;
    if (frames.length >= MAX_RPC_STACK_FRAMES || frames.join("\n").length + rendered.length + 1 > MAX_RPC_STACK_CHARS) break;
    frames.push(rendered);
  }
  return frames.length ? frames.join("\n") : undefined;
}

function sanitizeFrame(frame: string): string | null {
  const group = /^(.*?)\s*\(([^()]*)\)$/u.exec(frame);
  const rawFunction = (group?.[1] ?? "").trim();
  const rawLocation = (group?.[2] ?? frame).trim();
  const location = sanitizeLocation(rawLocation);
  if (location === null) return null;
  if (!group) return `at ${location}`;
  return `at ${rawFunction && FUNCTION_NAME.test(rawFunction) ? rawFunction : "<anonymous>"} (${location})`;
}

function sanitizeLocation(raw: string): string | null {
  const wrapped = /\(([^()]+)\)$/u.exec(raw);
  // `eval at <anonymous> (<location>)` and `new Function (...)` wrappers.
  const location = (wrapped && /^(?:eval|function)\b/iu.test(raw) ? wrapped[1]! : raw).trim();
  if (/^(?:node:|native$|<anonymous>$)/u.test(location)) return location.length <= 160 ? location : null;
  const baseName = location.slice(Math.max(location.lastIndexOf("\\"), location.lastIndexOf("/")) + 1);
  const match = /^([^\s:()[\]]{1,120})(?::(\d{1,9})(?::(\d{1,9}))?)?\)?$/u.exec(baseName);
  if (!match) return null;
  return `${match[1]}${match[2] ? `:${match[2]}${match[3] ? `:${match[3]}` : ""}` : ""}`;
}

/**
 * Remove credential shapes from upstream text: bearer and JWT tokens, API
 * keys, `key/token/secret` assignments, long hexadecimal strings, ANSI
 * escapes and control characters.
 */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/giu, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu, "[REDACTED_JWT]")
    .replace(/\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/giu, "[REDACTED_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, "[REDACTED_KEY]")
    .replace(
      /\b(api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|keys?|tokens?|secrets?|passwords?|passwd|authorizations?|cookies?|credentials?)\s*[:=]\s*["']?[^\s,"';&)}\]]{4,}/giu,
      "$1=[REDACTED]",
    )
    .replace(/\b[0-9a-f]{32,}\b/giu, "[REDACTED_HEX]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
}

function limit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars - TRUNCATED_MARKER.length);
  return `${/[\uD800-\uDBFF]$/u.test(head) ? head.slice(0, -1) : head}${TRUNCATED_MARKER}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
