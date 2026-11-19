import { createHash } from "node:crypto";
import path from "node:path";

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanString(value, maxLength = 512) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

export function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function timestampMs(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonNegativeSafeInteger(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

export function positiveSafeInteger(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

export function stableStringify(value) {
  return JSON.stringify(sortRecursively(value));
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = sortRecursively(value[key]);
  }
  return result;
}

export function sha256(value) {
  const input = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(value, length = 16) {
  return sha256(value).slice(0, Math.max(8, Math.min(64, length)));
}

export function noPath(value) {
  return value ? path.basename(String(value)) : null;
}

export function valueBytes(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(stableStringify(value), "utf8");
  } catch {
    return null;
  }
}

export function estimatedTokensFromBytes(bytes, bytesPerToken = 4) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) return null;
  return Math.ceil(bytes / bytesPerToken);
}

export function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

export function nullableAdd(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return null;
  }
  return left + right;
}

export function nullableSubtract(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return null;
  }
  return left - right;
}

export function difference(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return null;
  }
  return right - left;
}

export function sumNumbers(values) {
  let sum = 0;
  let observed = 0;
  for (const value of values) {
    if (Number.isSafeInteger(value) && value >= 0) {
      sum += value;
      observed += 1;
    }
  }
  return observed === 0 ? null : sum;
}

export function summarizeObserved(values) {
  const known = values.filter((value) => (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  ));
  if (known.length === 0) {
    return {
      total: null,
      average: null,
      maximum: null,
      observed_count: 0,
      unknown_count: values.length,
      complete: values.length === 0,
    };
  }
  const total = known.reduce((sum, value) => sum + value, 0);
  return {
    total,
    average: total / known.length,
    maximum: Math.max(...known),
    observed_count: known.length,
    unknown_count: values.length - known.length,
    complete: known.length === values.length,
  };
}

export function uniqueBy(values, keyFn) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function parseJsonLoose(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeToolName(name, namespace = null) {
  const source = cleanString(name, 160) ?? "unknown";
  const prefix = typeof namespace === "string" ? namespace.replace(/^mcp__/u, "") : "";
  if (prefix && source.startsWith(`${prefix}__`)) return source.slice(prefix.length + 2);
  const lastDouble = source.lastIndexOf("__");
  return lastDouble >= 0 ? source.slice(lastDouble + 2) : source;
}

export function isMcpTool(name, namespace) {
  return (typeof namespace === "string" && /^mcp__/u.test(namespace))
    || /^mcp__/u.test(name ?? "")
    || /^zcode_/u.test(normalizeToolName(name, namespace));
}

export function classifyCommand(command) {
  if (typeof command !== "string" || !command.trim()) return "OTHER";
  const value = command.toLowerCase();
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint|build)\b/u.test(value)
    || /\b(?:node\s+--test|pytest|vitest|jest|go\s+test|cargo\s+test)\b/u.test(value)
    || /\bgit\s+diff\s+--check\b/u.test(value)) {
    return "TESTING";
  }
  if (/\b(?:apply_patch|set-content|out-file|tee-object)\b/u.test(value)
    || /(?:^|\s)(?:>|>>)\s*[^|&]/u.test(value)
    || /\b(?:writefile|editfile|write_file|edit_file)\b/u.test(value)) {
    return "IMPLEMENTATION";
  }
  if (/\b(?:docs?|readme|report|markdown)\b/u.test(value)) return "DOCUMENTATION";
  if (/\bgit\s+(?:diff|show|log|status|blame)\b/u.test(value)
    || /\b(?:audit|review|inspect|code review)\b/u.test(value)) {
    return "REVIEW";
  }
  if (/\b(?:update_plan|create_goal|plan|roadmap|brainstorm)\b/u.test(value)) return "PLANNING";
  return "OTHER";
}

export function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
