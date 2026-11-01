import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidencePath = resolve(root, ".evidence", "magpie-usage-evidence.json");
const endpoint = "http://127.0.0.1:3425";
const hash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

function parseThreadIds(argv) {
  const ids = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--thread-id" || !argv[i + 1]) throw new Error("usage: --thread-id <thread-id> [repeat]");
    ids.push(argv[++i]);
  }
  if (ids.length === 0) throw new Error("at least one thread id is required");
  return [...new Set(ids)];
}

async function getJson(path) {
  const response = await fetch(new URL(path, endpoint), { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000) });
  let body = null;
  try { body = await response.json(); } catch { /* store no response text */ }
  return { status: response.status, body };
}

function safeRow(row) {
  return {
    observedAt: row.t ?? null,
    sessionId: typeof row.session === "string" ? `session#${hash(row.session)}` : null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    sessionRole: row.session_role ?? null,
    requestId: typeof row.req === "string" || typeof row.req === "number" ? `request#${hash(row.req)}` : null,
    responseId: typeof row.response_id === "string" ? `response#${hash(row.response_id)}` : null,
    inputTokens: Number.isSafeInteger(row.in) ? row.in : null,
    outputTokens: Number.isSafeInteger(row.out) ? row.out : null,
    cachedInputTokens: Number.isSafeInteger(row.cache_read) ? row.cache_read : null,
    cacheWriteInputTokens: Number.isSafeInteger(row.cache_write) ? row.cache_write : null,
    reasoningTokens: Number.isSafeInteger(row.reasoning) ? row.reasoning : null,
    cost: typeof row.cost === "number" && Number.isFinite(row.cost) ? row.cost : null,
    priced: typeof row.priced === "boolean" ? row.priced : null,
    status: Number.isSafeInteger(row.status) ? row.status : null,
    compaction: typeof row.compaction === "boolean" ? row.compaction : null,
    usageSource: row.source === "log" ? "codex_session_log_reader" : row.route_id !== undefined ? "magpie_gateway_record" : "unknown",
    routeId: Number.isSafeInteger(row.route_id) ? `route#${hash(row.route_id)}` : null,
    usageFieldsPresent: {
      input: Object.hasOwn(row, "in"), output: Object.hasOwn(row, "out"), cached: Object.hasOwn(row, "cache_read"),
      cacheWrite: Object.hasOwn(row, "cache_write"), reasoning: Object.hasOwn(row, "reasoning"), cost: Object.hasOwn(row, "cost"),
    },
  };
}

const threadIds = parseThreadIds(process.argv.slice(2));
const evidence = {
  probe: "magpie-usage-readonly-probe",
  observedAt: new Date().toISOString(),
  installedVersion: "0.1.1333",
  auth: "loopback GET only; no Authorization, API key, cookie, or credential read",
  requestsEndpoint: { status: null, total: null, pagesRead: 0, results: [] },
  summaryEndpoint: null,
};

try {
  const info = await getJson("/v1");
  evidence.installedVersionFromEndpoint = info.body?.version ?? null;
  const summary = await getJson("/v1/magpie/usage?period=all");
  evidence.summaryEndpoint = {
    status: summary.status,
    period: summary.body?.period ?? null,
    summaryFieldsPresent: ["calls", "input", "output", "cache_read", "cache_write", "reasoning", "cost", "sessions", "sessionCount"]
      .filter(key => Object.hasOwn(summary.body ?? {}, key)),
    sessionSummaryPresent: Array.isArray(summary.body?.sessions),
  };

  for (const threadId of threadIds) {
    const q = new URLSearchParams({ q: threadId, period: "all", limit: "500", offset: "0" });
    const first = await getJson(`/v1/magpie/usage/requests?${q}`);
    evidence.requestsEndpoint.status ??= first.status;
    if (first.status === 401 || first.status === 403) {
      evidence.requestsEndpoint.authState = "API_AUTH_BLOCKED";
      continue;
    }
    if (first.status !== 200 || !Array.isArray(first.body?.rows)) {
      evidence.requestsEndpoint.authState = first.status === 404 ? "API_UNSUPPORTED" : "API_FAILED";
      evidence.requestsEndpoint.errorStatus = first.status;
      continue;
    }
    const total = Number.isSafeInteger(first.body.total) ? first.body.total : first.body.rows.length;
    const pages = [first.body.rows];
    const pageLimit = 10;
    for (let offset = first.body.rows.length; offset < total && pages.length < pageLimit; offset += 500) {
      const nextQuery = new URLSearchParams({ q: threadId, period: "all", limit: "500", offset: String(offset) });
      const page = await getJson(`/v1/magpie/usage/requests?${nextQuery}`);
      if (page.status !== 200 || !Array.isArray(page.body?.rows)) break;
      pages.push(page.body.rows);
    }
    const rows = pages.flat();
    const exact = rows.filter(row => row.session === threadId);
    const normalized = exact.map(safeRow);
    const bySource = normalized.reduce((acc, row) => { acc[row.usageSource] = (acc[row.usageSource] ?? 0) + 1; return acc; }, {});
    const sum = field => normalized.reduce((acc, row) => acc + (Number.isSafeInteger(row[field]) ? row[field] : 0), 0);
    const byStatus = normalized.reduce((acc, row) => { const key = String(row.status ?? "unknown"); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
    const totalsFor = predicate => {
      const selected = normalized.filter(predicate);
      const total = field => selected.reduce((acc, row) => acc + (Number.isSafeInteger(row[field]) ? row[field] : 0), 0);
      return {
        rows: selected.length,
        inputTokens: total("inputTokens"),
        outputTokens: total("outputTokens"),
        cachedInputTokens: total("cachedInputTokens"),
        cacheWriteInputTokens: total("cacheWriteInputTokens"),
        reasoningTokens: total("reasoningTokens"),
        cost: selected.reduce((acc, row) => acc + (typeof row.cost === "number" ? row.cost : 0), 0),
      };
    };
    evidence.requestsEndpoint.pagesRead += pages.length;
    evidence.requestsEndpoint.results.push({
      threadId: `thread#${hash(threadId)}`,
      qFilterTotal: total,
      qFilterRowsRead: rows.length,
      exactSessionRows: exact.length,
      queryMatchedOtherSessions: rows.length - exact.length,
      allPagesRead: rows.length >= total,
      bySource,
      byStatus,
      totals: {
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        cachedInputTokens: sum("cachedInputTokens"),
        cacheWriteInputTokens: sum("cacheWriteInputTokens"),
        reasoningTokens: sum("reasoningTokens"),
        cost: normalized.reduce((acc, row) => acc + (typeof row.cost === "number" ? row.cost : 0), 0),
      },
      successfulTotals: totalsFor(row => row.status !== null && row.status >= 200 && row.status < 300),
      nullFieldCounts: Object.fromEntries(["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens", "cost", "status"]
        .map(field => [field, normalized.filter(row => row[field] === null).length])),
      firstObservedAt: normalized.at(-1)?.observedAt ?? null,
      lastObservedAt: normalized[0]?.observedAt ?? null,
      providerModels: [...new Set(normalized.map(row => `${row.provider ?? "unknown"}/${row.model ?? "unknown"}`))].sort(),
      records: normalized,
    });
  }
} catch (error) {
  evidence.requestsEndpoint.networkError = error?.cause?.code ?? error?.name ?? "unknown";
  evidence.requestsEndpoint.authState ??= "API_FAILED";
}

await mkdir(resolve(root, ".evidence"), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: ".evidence/magpie-usage-evidence.json", installedVersionFromEndpoint: evidence.installedVersionFromEndpoint, summaryEndpoint: evidence.summaryEndpoint, requestsEndpoint: { status: evidence.requestsEndpoint.status, authState: evidence.requestsEndpoint.authState ?? "OK", results: evidence.requestsEndpoint.results.map(({ records, ...rest }) => rest) } }, null, 2)}\n`);
