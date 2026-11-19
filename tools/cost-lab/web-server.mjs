#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_PROVIDER_ID,
  DEFAULT_TIME_ZONE,
  RECONCILIATION_SCHEMA_VERSION,
  atomicWriteJson,
  captureSnapshot,
  reconcileBillingSnapshots,
  safeError,
  sanitizeErrorMessage,
} from "./coding-plan-billing.mjs";
import { runOfficialAppServerProtocolSmoke } from "./official-app-server-protocol-smoke.mjs";
import { resolveBillingDataBaseDir } from "./path-discovery.mjs";
import {
  collectAndStoreProfilerSnapshot,
  createStoredProfilerComparison,
  createStoredProfilerReport,
  listStoredProfilerReports,
  loadStoredProfilerReportById,
  profilerSessions,
  readLatestStoredProfilerSnapshot,
} from "./profiler-service.mjs";
import { renderProfilerMarkdown } from "./profiler/index.mjs";
import { readOfficialStartPlanBilling } from "./startplan-reader.mjs";
import { createStartPlanBillingService } from "./startplan-web.mjs";
import { inspectCostLabEnvironment, redactValue } from "./web-services.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
export const DEFAULT_HISTORY_PATH = path.join(PROJECT_ROOT, ".run", "cost-lab-web", "history.json");
export const DEFAULT_STARTPLAN_HISTORY_PATH =
  path.join(PROJECT_ROOT, ".run", "cost-lab-web", "startplan-history.json");
export const LOOPBACK_HOST = "127.0.0.1";
export const CONFIRMATION_PHRASE = "START REAL CODING PLAN VERIFICATION";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_HISTORY_ITEMS = 50;
const STATIC_FILES = Object.freeze({
  "/": Object.freeze({ file: "index.html", type: "text/html; charset=utf-8" }),
  "/index.html": Object.freeze({ file: "index.html", type: "text/html; charset=utf-8" }),
  "/app.js": Object.freeze({ file: "app.js", type: "text/javascript; charset=utf-8" }),
  "/i18n.mjs": Object.freeze({ file: "i18n.mjs", type: "text/javascript; charset=utf-8" }),
  "/startplan-view.mjs": Object.freeze({
    file: "startplan-view.mjs",
    type: "text/javascript; charset=utf-8",
  }),
  "/startplan-status.mjs": Object.freeze({
    file: "startplan-status.mjs",
    type: "text/javascript; charset=utf-8",
  }),
  "/styles.css": Object.freeze({ file: "styles.css", type: "text/css; charset=utf-8" }),
  "/favicon.svg": Object.freeze({ file: "favicon.svg", type: "image/svg+xml" }),
});

export function createCostLabWebServer(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const uiRoot = path.join(SCRIPT_ROOT, "web");
  const historyPath = path.resolve(options.historyPath ?? path.join(projectRoot, ".run", "cost-lab-web", "history.json"));
  const startPlanHistoryPath = path.resolve(
    options.startPlanHistoryPath
      ?? path.join(projectRoot, ".run", "cost-lab-web", "startplan-history.json"),
  );
  assertInside(path.join(projectRoot, ".run"), historyPath);
  assertInside(path.join(projectRoot, ".run"), startPlanHistoryPath);
  const dependencies = {
    captureSnapshot: options.captureSnapshot ?? captureSnapshot,
    inspectEnvironment: options.inspectEnvironment ?? inspectCostLabEnvironment,
    verificationRunner: options.verificationRunner ?? loadOptionalVerificationRunner(),
    protocolSmoke: options.protocolSmoke ?? runOfficialAppServerProtocolSmoke,
    profilerCollect: options.profilerCollect ?? collectAndStoreProfilerSnapshot,
    profilerLatest: options.profilerLatest ?? readLatestStoredProfilerSnapshot,
    profilerAnalyze: options.profilerAnalyze ?? createStoredProfilerReport,
    profilerReports: options.profilerReports ?? listStoredProfilerReports,
    profilerReport: options.profilerReport ?? loadStoredProfilerReportById,
    profilerCompare: options.profilerCompare ?? createStoredProfilerComparison,
    now: options.now ?? (() => new Date()),
    createId: options.createId ?? randomUUID,
    afterRetryDelaysMs: options.afterRetryDelaysMs ?? [
      0,
      5_000,
      15_000,
      30_000,
      45_000,
      60_000,
    ],
  };
  const officialHostWorker = path.resolve(
    options.officialHostWorker
      ?? path.join(
        projectRoot,
        "plugins",
        "codex-zcode-bridge",
        "worker",
        "worker-main.mjs",
      ),
  );
  const startPlanReadBilling = options.readStartPlanBilling ?? (async ({ signal }) => {
    const data = resolveBillingDataBaseDir(options.startPlanDataBaseDir ?? null, {
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
    });
    return readOfficialStartPlanBilling({
      projectRoot,
      dataBaseDir: data.dataBaseDir,
      officialHostWorker,
      signal,
      now: () => dependencies.now().getTime(),
    });
  });
  const startPlanBilling = options.startPlanBillingService ?? createStartPlanBillingService({
    historyPath: startPlanHistoryPath,
    readBilling: startPlanReadBilling,
    now: dependencies.now,
    createId: dependencies.createId,
    cooldownMs: options.startPlanCooldownMs,
  });
  const state = {
    csrfToken: options.csrfToken ?? randomBytes(32).toString("base64url"),
    server: null,
    origin: null,
    port: null,
    closed: false,
    activeVerificationId: null,
    activeAbortController: null,
    activeVerificationPromise: null,
    historyLoaded: false,
    history: [],
  };
  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(response, status, {
        ok: false,
        error: {
          code: typeof error?.code === "string" ? error.code : "COST_LAB_INTERNAL_ERROR",
          message: redactValue(sanitizeErrorMessage(error)),
        },
      });
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  state.server = server;

  async function start() {
    if (state.server.listening) return publicAddress();
    await mkdir(path.dirname(historyPath), { recursive: true });
    await ensureHistoryLoaded();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        state.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        state.server.off("error", onError);
        resolve();
      };
      state.server.once("error", onError);
      state.server.once("listening", onListening);
      // The Cost Lab server is intentionally pinned to the IPv4 loopback
      // address. No caller-supplied host or wildcard bind is supported.
      state.server.listen(options.port ?? 0, LOOPBACK_HOST);
    });
    const address = state.server.address();
    if (!address || typeof address === "string") throw new Error("cost_lab_server_address_unavailable");
    state.port = address.port;
    state.origin = `http://${LOOPBACK_HOST}:${state.port}`;
    return publicAddress();
  }

  async function close({ abortActive = true, timeoutMs = 150_000 } = {}) {
    state.closed = true;
    const listenerClosed = new Promise((resolve) => {
      if (!state.server.listening) {
        resolve();
        return;
      }
      const timer = setTimeout(() => state.server.closeAllConnections(), Math.min(timeoutMs, 10_000));
      state.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (abortActive && state.activeAbortController) {
      state.activeAbortController.abort(new Error("cost_lab_server_shutdown"));
    }
    // Keep the runner alive through its capture, cancellation, and MCP shutdown deadlines.
    await Promise.all([
      listenerClosed,
      withTimeout(
        state.activeVerificationPromise?.catch(() => undefined) ?? Promise.resolve(),
        timeoutMs,
        "cost_lab_verification_shutdown_timeout",
      ),
      withTimeout(
        startPlanBilling.close({ abort: abortActive }),
        Math.min(timeoutMs, 25_000),
        "cost_lab_startplan_shutdown_timeout",
      ),
    ]);
  }

  function publicAddress() {
    return {
      host: LOOPBACK_HOST,
      port: state.port,
      origin: state.origin,
      url: state.origin ? `${state.origin}/` : null,
    };
  }

  async function handleRequest(request, response) {
    applySecurityHeaders(response);
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, {
        ok: false,
        error: { code: "COST_LAB_LOCAL_ONLY", message: "Cost Lab accepts loopback connections only." },
      });
      return;
    }
    if (!validHostHeader(request, state.port)) {
      sendJson(response, 403, {
        ok: false,
        error: { code: "COST_LAB_HOST_REJECTED", message: "The request Host header is not the local Cost Lab origin." },
      });
      return;
    }
    const url = new URL(request.url ?? "/", state.origin ?? `http://${LOOPBACK_HOST}`);
    if (request.method === "GET" || request.method === "HEAD") {
      const staticFile = STATIC_FILES[url.pathname];
      if (staticFile) {
        await serveStatic(uiRoot, staticFile, request.method, response);
        return;
      }
    }
    if (!url.pathname.startsWith("/api/")) {
      sendJson(response, 404, {
        ok: false,
        error: { code: "COST_LAB_NOT_FOUND", message: "Unknown Cost Lab route." },
      });
      return;
    }
    if (request.method === "OPTIONS") {
      sendJson(response, 405, {
        ok: false,
        error: { code: "COST_LAB_PREFLIGHT_REJECTED", message: "Cross-origin requests are not supported." },
      }, { Allow: "GET, HEAD, POST" });
      return;
    }
    if (request.method === "POST" && !validStateChangingRequest(request, state.origin, state.csrfToken)) {
      sendJson(response, 403, {
        ok: false,
        error: { code: "COST_LAB_CSRF_REJECTED", message: "Origin or CSRF validation failed." },
      });
      return;
    }
    const body = request.method === "POST" ? await readJsonBody(request) : null;
    await routeApi(request.method, url, body, response);
  }

  async function routeApi(method, url, body, response) {
    if (method === "GET" && url.pathname === "/api/session") {
      await ensureHistoryLoaded();
      sendJson(response, 200, {
        ok: true,
        data: {
          schema_version: 1,
          csrf_token: state.csrfToken,
          confirmation_phrase: CONFIRMATION_PHRASE,
          provider: DEFAULT_PROVIDER_ID,
          model: "GLM-5.3-Flash",
          time_zone: DEFAULT_TIME_ZONE,
          model_requests_on_page_load: 0,
          active_verification_id: state.activeVerificationId,
        },
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, data: { status: "READY", local_only: true } });
      return;
    }
    if (method === "GET" && url.pathname === "/api/environment") {
      const environment = await dependencies.inspectEnvironment({ deep: false });
      sendJson(response, 200, { ok: true, data: redactValue(environment) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/environment/check") {
      const deep = body?.deep === true;
      const environment = await dependencies.inspectEnvironment({
        deep,
        protocolSmoke: dependencies.protocolSmoke,
      });
      sendJson(response, 200, { ok: true, data: redactValue(environment) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/profiler/latest") {
      const snapshot = await dependencies.profilerLatest({ projectRoot });
      if (!snapshot) {
        sendJson(response, 200, {
          ok: true,
          data: {
            status: "NO_SNAPSHOT",
            sessions: [],
            reports: await dependencies.profilerReports({ projectRoot }),
          },
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        data: redactValue({
          status: "READY",
          snapshot_id: snapshot.snapshot_id,
          captured_at: snapshot.captured_at,
          generated_at: snapshot.generated_at,
          collection_mode: snapshot.collection_mode,
          sources: snapshot.sources,
          warnings: snapshot.warnings,
          sessions: profilerSessions(snapshot),
          reports: await dependencies.profilerReports({ projectRoot }),
        }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/profiler/collect") {
      assertEmptyProfilerAction(body, "Profiler collection");
      const collected = await dependencies.profilerCollect({ projectRoot });
      sendJson(response, 200, {
        ok: true,
        data: redactValue({
          status: "READY",
          snapshot_id: collected.snapshot.snapshot_id,
          captured_at: collected.snapshot.captured_at,
          generated_at: collected.snapshot.generated_at,
          collected_at: collected.collected_at,
          collection_mode: collected.snapshot.collection_mode,
          sources: collected.snapshot.sources,
          warnings: collected.snapshot.warnings,
          sessions: profilerSessions(collected.snapshot),
          reports: await dependencies.profilerReports({ projectRoot }),
        }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/profiler/analyze") {
      const selection = profilerSelection(body);
      const latest = await dependencies.profilerLatest({ projectRoot });
      if (!latest) {
        throw httpError(
          409,
          "PROFILER_SNAPSHOT_REQUIRED",
          "Collect a local profiler snapshot before creating a report.",
        );
      }
      const created = await dependencies.profilerAnalyze({
        projectRoot,
        snapshot: latest,
        ...selection,
        now: dependencies.now,
      });
      sendJson(response, 200, {
        ok: true,
        data: redactValue(created.report),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/profiler/reports") {
      sendJson(response, 200, {
        ok: true,
        data: { reports: await dependencies.profilerReports({ projectRoot }) },
      });
      return;
    }
    const profilerTimelineExport =
      /^\/api\/profiler\/reports\/([0-9a-f]{8,64})\/timeline\/export$/u.exec(url.pathname);
    if (method === "GET" && profilerTimelineExport) {
      const report = await dependencies.profilerReport(profilerTimelineExport[1], { projectRoot });
      const exported = {
        schema_version: 1,
        kind: "cost_lab_profiler_timeline_export",
        exported_at: dependencies.now().toISOString(),
        report_id: report.report_id,
        source_snapshot_id: report.source_snapshot_id,
        report_generated_at: report.generated_at ?? null,
        agents: (report.agents ?? []).map((agent) => ({
          agent_id: agent.agent_id,
          kind: agent.kind,
          thread_id: agent.thread_id ?? null,
          parent_agent_id: agent.parent_agent_id ?? null,
          task_id: agent.task_id ?? null,
        })),
        timeline_meta: {
          event_count: report.timeline_meta?.event_count ?? 0,
          total_event_count: report.timeline_meta?.total_event_count ?? 0,
          truncated: report.timeline_meta?.truncated === true,
          limit: report.timeline_meta?.limit ?? null,
          content_retained: report.timeline_meta?.content_retained === true,
        },
        timeline: (report.timeline ?? []).map(timelineExportEntry),
      };
      const bodyText = `${JSON.stringify(redactValue(exported), null, 2)}\n`;
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition":
          `attachment; filename="cost-lab-profiler-timeline-${profilerTimelineExport[1]}.json"`,
        "Cache-Control": "no-store",
      });
      response.end(bodyText);
      return;
    }
    const profilerExport = /^\/api\/profiler\/reports\/([0-9a-f]{8,64})\/export$/u.exec(url.pathname);
    if (method === "GET" && profilerExport) {
      const report = await dependencies.profilerReport(profilerExport[1], { projectRoot });
      const markdown = renderProfilerMarkdown(report);
      response.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="cost-lab-profiler-${profilerExport[1]}.md"`,
        "Cache-Control": "no-store",
      });
      response.end(markdown);
      return;
    }
    const profilerReport = /^\/api\/profiler\/reports\/([0-9a-f]{8,64})$/u.exec(url.pathname);
    if (method === "GET" && profilerReport) {
      const report = await dependencies.profilerReport(profilerReport[1], { projectRoot });
      sendJson(response, 200, { ok: true, data: redactValue(report) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/profiler/compare") {
      if (!body || typeof body.before !== "string" || typeof body.after !== "string") {
        throw httpError(400, "PROFILER_COMPARE_INPUT_REQUIRED", "Before and after report IDs are required.");
      }
      const comparison = await dependencies.profilerCompare({
        projectRoot,
        before: body.before,
        after: body.after,
        now: dependencies.now,
      });
      sendJson(response, 200, { ok: true, data: redactValue(comparison) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/billing/snapshot") {
      const snapshot = await dependencies.captureSnapshot(snapshotOptions(body));
      sendJson(response, 200, {
        ok: true,
        data: redactValue(snapshot),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/billing/startplan/latest") {
      const result = await startPlanBilling.latest();
      sendJson(response, 200, { ok: true, data: redactValue(result) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/billing/startplan/history") {
      const result = await startPlanBilling.history({
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        limit: url.searchParams.get("limit"),
      });
      sendJson(response, 200, { ok: true, data: redactValue(result) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/billing/startplan/refresh") {
      if (body !== null && body !== undefined && Object.keys(body).length !== 0) {
        throw httpError(
          400,
          "STARTPLAN_REFRESH_INPUT_REJECTED",
          "Start Plan refresh uses the discovered official account context only.",
        );
      }
      try {
        const result = await startPlanBilling.refresh();
        sendJson(response, 200, { ok: true, data: redactValue(result) });
      } catch (error) {
        throw mapStartPlanError(error);
      }
      return;
    }
    const startPlanExport =
      /^\/api\/billing\/startplan\/history\/([0-9a-f-]{36})\/export$/u.exec(url.pathname);
    if (method === "GET" && startPlanExport) {
      const exported = await startPlanBilling.exportSnapshot(startPlanExport[1]);
      const bodyText = `${JSON.stringify(redactValue(exported), null, 2)}\n`;
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="cost-lab-startplan-${startPlanExport[1]}.json"`,
        "Cache-Control": "no-store",
      });
      response.end(bodyText);
      return;
    }
    if (method === "POST" && url.pathname === "/api/verifications") {
      const started = await startVerification(body);
      sendJson(response, 202, { ok: true, data: redactValue(started) });
      return;
    }
    const verification = /^\/api\/verifications\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (method === "GET" && verification) {
      const record = findRecord(verification[1]);
      if (!record) {
        sendJson(response, 404, { ok: false, error: { code: "VERIFICATION_NOT_FOUND", message: "Verification not found." } });
        return;
      }
      sendJson(response, 200, { ok: true, data: redactValue(record) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/history") {
      await ensureHistoryLoaded();
      sendJson(response, 200, {
        ok: true,
        data: {
          items: state.history.map(historySummary).reverse(),
          limit: MAX_HISTORY_ITEMS,
        },
      });
      return;
    }
    const exportMatch = /^\/api\/history\/([0-9a-f-]{36})\/export$/u.exec(url.pathname);
    if (method === "GET" && exportMatch) {
      const record = findRecord(exportMatch[1]);
      if (!record) {
        sendJson(response, 404, { ok: false, error: { code: "VERIFICATION_NOT_FOUND", message: "Verification not found." } });
        return;
      }
      const bodyText = `${JSON.stringify({
        schema_version: 1,
        exported_at: dependencies.now().toISOString(),
        redaction: "credential_fields_and_absolute_user_paths_omitted",
        verification: redactValue(record),
      }, null, 2)}\n`;
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="cost-lab-${record.id}.json"`,
        "Cache-Control": "no-store",
      });
      response.end(bodyText);
      return;
    }
    if (method === "GET" && url.pathname === "/api/start-plan") {
      sendJson(response, 200, {
        ok: true,
        data: {
          status: "START_PLAN_READ_ONLY_BILLING",
          live_test: "AVAILABLE_ON_EXPLICIT_REFRESH",
          billing_api: "/api/billing/startplan/refresh",
          discount: "NOT_VERIFIED",
          execution_button: false,
          reason: "Start Plan exposes read-only official balance access. It does not expose model execution.",
        },
      });
      return;
    }
    sendJson(response, 404, {
      ok: false,
      error: { code: "COST_LAB_API_NOT_FOUND", message: "Unknown Cost Lab API route." },
    });
  }

  async function startVerification(body) {
    if (typeof dependencies.verificationRunner !== "function") {
      throw httpError(503, "REAL_VERIFICATION_NOT_CONFIGURED", "The production verification runner is not configured.");
    }
    if (!body || body.confirmation !== CONFIRMATION_PHRASE) {
      throw httpError(400, "REAL_VERIFICATION_CONFIRMATION_REQUIRED", "Explicit verification confirmation is required.");
    }
    if (body.provider !== DEFAULT_PROVIDER_ID || body.model !== "GLM-5.3-Flash" || body.reasoning !== "low") {
      throw httpError(400, "REAL_VERIFICATION_INPUT_REJECTED", "Only the verified Coding Plan provider/model/reasoning tuple is allowed.");
    }
    if (state.closed || state.activeVerificationId) {
      throw httpError(409, "REAL_VERIFICATION_ALREADY_RUNNING", "A real verification is already running or the service is closing.");
    }
    const id = dependencies.createId();
    state.activeVerificationId = id;
    const startedAt = dependencies.now().toISOString();
    const record = {
      schema_version: 1,
      id,
      status: "QUEUED",
      started_at: startedAt,
      updated_at: startedAt,
      finished_at: null,
      provider: DEFAULT_PROVIDER_ID,
      model: "GLM-5.3-Flash",
      reasoning: "low",
      billing_window: {
        time_zone: DEFAULT_TIME_ZONE,
        before: null,
        after: null,
      },
      model_requests: 0,
      request_usage: null,
      runtime_evidence: null,
      reconciliation: null,
      error: null,
      warnings: [
        "Auxiliary official requests may consume credits.",
        "A clean billing observation window is required.",
      ],
    };
    const abortController = new AbortController();
    state.activeAbortController = abortController;
    const enqueue = (async () => {
      await ensureHistoryLoaded();
      assertNotAborted(abortController.signal);
      state.history.push(record);
      try {
        await persistHistory();
      } catch (error) {
        state.history = state.history.filter((item) => item !== record);
        throw error;
      }
    })();
    const verificationPromise = enqueue
      .then(() => executeVerification(record, abortController.signal))
      .finally(() => {
        if (state.activeVerificationId === id) state.activeVerificationId = null;
        if (state.activeAbortController === abortController) state.activeAbortController = null;
        if (state.activeVerificationPromise === verificationPromise) state.activeVerificationPromise = null;
      });
    state.activeVerificationPromise = verificationPromise;
    void verificationPromise.catch(() => undefined);
    await enqueue;
    return {
      id,
      status: "QUEUED",
      poll_url: `/api/verifications/${id}`,
      confirmation: "REAL_MODEL_REQUEST_AUTHORIZED",
    };
  }

  async function executeVerification(record, signal) {
    try {
      updateRecord(record, { status: "RUNNING" });
      await persistHistory();
      const before = await dependencies.captureSnapshot({
        provider: DEFAULT_PROVIDER_ID,
        model: "GLM-5.3-Flash",
        range: "today",
        start: null,
        end: null,
        timeZone: DEFAULT_TIME_ZONE,
        dataRoot: null,
        timeoutMs: 60_000,
      });
      assertNotAborted(signal);
      record.billing_window.before = redactValue(before);
      updateRecord(record, { status: "MODEL_REQUESTED", model_requests: null });
      await persistHistory();
      const verification = await dependencies.verificationRunner({
        signal,
        provider: DEFAULT_PROVIDER_ID,
        model: "GLM-5.3-Flash",
        reasoning: "low",
        beforeSnapshot: record.billing_window.before,
      });
      assertNotAborted(signal);
      record.model_requests = Number.isSafeInteger(verification?.model_requests)
        ? verification.model_requests
        : null;
      record.request_usage = redactValue(verification?.usage ?? null);
      record.runtime_evidence = redactValue(verification?.runtime_evidence ?? null);
      updateRecord(record, { status: "AWAITING_SETTLEMENT" });
      await persistHistory();
      const { after, reconciliation } = await captureAfterWithRetry(signal, {
        before,
        usage: verification?.usage ?? null,
        hour: Number.isInteger(verification?.hour) ? verification.hour : null,
      });
      record.billing_window.after = redactValue(after);
      record.reconciliation = redactValue(reconciliation);
      await persistHistoryWithRecordPatch(record, {
        status: "SUCCEEDED",
        finished_at: dependencies.now().toISOString(),
      });
    } catch (error) {
      const interrupted = signal.aborted;
      updateRecord(record, {
        status: interrupted ? "INTERRUPTED" : "FAILED",
        finished_at: dependencies.now().toISOString(),
        error: {
          code: interrupted ? "VERIFICATION_INTERRUPTED" : "VERIFICATION_FAILED",
          message: safeErrorCode(error),
        },
      });
    } finally {
      await persistHistory().catch(() => undefined);
    }
  }

  async function captureAfterWithRetry(signal, { before, usage, hour }) {
    let lastError;
    let observation = null;
    for (const delay of dependencies.afterRetryDelaysMs) {
      if (delay > 0) await delayWithSignal(delay, signal);
      assertNotAborted(signal);
      try {
        const snapshot = await dependencies.captureSnapshot({
          provider: DEFAULT_PROVIDER_ID,
          model: "GLM-5.3-Flash",
          range: "today",
          start: null,
          end: null,
          timeZone: DEFAULT_TIME_ZONE,
          dataRoot: null,
          timeoutMs: 60_000,
        });
        assertNotAborted(signal);
        if (!usage) {
          return { after: snapshot, reconciliation: inconclusiveBilling("USAGE_MISSING") };
        }
        let reconciliation;
        try {
          reconciliation = reconcileBillingSnapshots(before, snapshot, usage, {
            model: "GLM-5.3-Flash",
            hour,
          });
        } catch (error) {
          return {
            after: snapshot,
            reconciliation: inconclusiveBilling("BILLING_NOT_COMPARABLE", safeErrorCode(error)),
          };
        }
        observation = { after: snapshot, reconciliation };
        if (reconciliation.calculation.actual_credits !== null) return observation;
      } catch (error) {
        assertNotAborted(signal);
        lastError = error;
      }
    }
    return observation ?? {
      after: null,
      reconciliation: inconclusiveBilling("BILLING_UNAVAILABLE", safeErrorCode(lastError)),
    };
  }

  function snapshotOptions(body) {
    if (body !== null && body !== undefined) {
      const keys = Object.keys(body).sort();
      if (keys.length !== 0) throw httpError(400, "BILLING_INPUT_REJECTED", "Billing snapshots use the discovered account context only.");
    }
    return {
      provider: DEFAULT_PROVIDER_ID,
      model: "GLM-5.3-Flash",
      range: "today",
      start: null,
      end: null,
      timeZone: DEFAULT_TIME_ZONE,
      dataRoot: null,
      timeoutMs: 60_000,
    };
  }

  function findRecord(id) {
    return state.history.find((record) => record.id === id) ?? null;
  }

  function updateRecord(record, patch) {
    Object.assign(record, patch, { updated_at: dependencies.now().toISOString() });
  }

  async function ensureHistoryLoaded() {
    if (state.historyLoaded) return;
    try {
      const parsed = JSON.parse(await readFile(historyPath, "utf8"));
      if (!parsed || parsed.schema_version !== 1 || !Array.isArray(parsed.items)) {
        throw new Error("cost_lab_history_schema_invalid");
      }
      state.history = parsed.items.filter(validHistoryRecord).slice(-MAX_HISTORY_ITEMS)
        .map(normalizeHistoricReconciliation);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state.history = [];
    }
    state.historyLoaded = true;
  }

  async function persistHistory() {
    if (state.historyLoaded) {
      trimHistory();
      await atomicWriteJson(historyPath, {
        schema_version: 1,
        updated_at: dependencies.now().toISOString(),
        items: state.history,
      });
    }
  }

  async function persistHistoryWithRecordPatch(record, patch) {
    if (!state.historyLoaded) throw new Error("cost_lab_history_not_loaded");
    trimHistory();
    const updatedAt = dependencies.now().toISOString();
    const items = state.history.map((item) => item === record
      ? { ...item, ...patch, updated_at: updatedAt }
      : item);
    await atomicWriteJson(historyPath, {
      schema_version: 1,
      updated_at: updatedAt,
      items,
    });
    Object.assign(record, patch, { updated_at: updatedAt });
  }

  function trimHistory() {
    if (state.history.length > MAX_HISTORY_ITEMS) {
      state.history.splice(0, state.history.length - MAX_HISTORY_ITEMS);
    }
  }

  return {
    start,
    close,
    address: publicAddress,
    server,
  };
}

async function serveStatic(root, definition, method, response) {
  const filePath = path.join(root, definition.file);
  assertInside(root, filePath);
  response.writeHead(200, {
    "Content-Type": definition.type,
    "Cache-Control": "no-store",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.once("error", reject);
    stream.once("end", resolve);
    stream.pipe(response);
  });
}

function applySecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "));
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const text = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(text);
}

async function readJsonBody(request) {
  if (!/^application\/json(?:;|$)/iu.test(request.headers["content-type"] ?? "")) {
    throw httpError(415, "COST_LAB_JSON_REQUIRED", "Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw httpError(413, "COST_LAB_BODY_TOO_LARGE", "JSON body exceeds 64 KiB.");
    chunks.push(chunk);
  }
  if (size === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "COST_LAB_JSON_INVALID", "JSON body is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw httpError(400, "COST_LAB_JSON_OBJECT_REQUIRED", "JSON body must be an object.");
  }
  return parsed;
}

function validStateChangingRequest(request, origin, csrfToken) {
  if (request.headers.origin !== origin) return false;
  if (request.headers["x-cost-lab-csrf"] !== csrfToken) return false;
  return request.headers["sec-fetch-site"] === undefined
    || request.headers["sec-fetch-site"] === "same-origin";
}

function validHostHeader(request, port) {
  if (!port) return true;
  const host = request.headers.host;
  return host === `${LOOPBACK_HOST}:${port}` || host === `localhost:${port}`;
}

export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  return address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1";
}

function historySummary(record) {
  const settlementStatus = record.reconciliation?.settlement_status ?? null;
  return redactValue({
    id: record.id,
    status: record.status,
    started_at: record.started_at,
    finished_at: record.finished_at,
    provider: record.provider,
    model: record.model,
    model_requests: record.model_requests,
    billing_reconciliation: record.reconciliation?.billing_reconciliation ?? null,
    credit_class: record.reconciliation?.credit_class ?? null,
    settlement_status: settlementStatus,
    actual_credits: record.reconciliation?.calculation?.actual_credits ?? null,
    effective_extra_ratio: record.reconciliation?.billing_reconciliation === "PASS"
      ? record.reconciliation.calculation?.effective_extra_ratio ?? null
      : null,
  });
}

function timelineExportEntry(entry) {
  const fields = [
    "timeline_id",
    "kind",
    "at",
    "end_at",
    "agent_id",
    "turn_id",
    "response_id",
    "tool_name",
    "tool_event_id",
    "task_id",
    "attempt",
    "compaction_id",
    "window_number",
    "replacement_item_count",
    "estimated_retained_context_tokens",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "total_tokens",
    "duration_ms",
    "output_bytes",
    "duplicate",
    "failure",
    "turn_count",
    "tool_call_count",
    "status",
    "evidence_level",
  ];
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(entry, field))
      .map((field) => [field, entry[field]]),
  );
}

function inconclusiveBilling(settlementStatus, limitation = null) {
  return {
    billing_reconciliation: "INCONCLUSIVE",
    credit_class: "INCONCLUSIVE",
    settlement_status: settlementStatus,
    ...(limitation ? { limitation } : {}),
  };
}

function normalizeHistoricReconciliation(record) {
  const reconciliation = record.reconciliation;
  const { before, after } = record.billing_window ?? {};
  if (!reconciliation?.calculation) return record;
  if (reconciliation.schema_version === RECONCILIATION_SCHEMA_VERSION &&
      before?.official_snapshot?.modelUsage?.costLabBillingSource &&
      after?.official_snapshot?.modelUsage?.costLabBillingSource) return record;
  let updated;
  try {
    updated = reconcileBillingSnapshots(before, after, record.request_usage ?? reconciliation.request_usage, {
      model: record.model,
      hour: Number.parseInt(reconciliation.hour, 10),
    });
  } catch (error) {
    updated = inconclusiveBilling("BILLING_NOT_COMPARABLE", safeErrorCode(error));
  }
  return {
    ...record,
    reconciliation: {
      ...updated,
      ...(updated.captured_at ? { captured_at: reconciliation.captured_at } : {}),
    },
  };
}

function validHistoryRecord(value) {
  return value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    /^[0-9a-f-]{36}$/u.test(value.id) &&
    typeof value.status === "string";
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("cost_lab_path_outside_allowed_root");
  }
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  return error;
}

function assertEmptyProfilerAction(body, label) {
  if (body !== null && body !== undefined && (
    typeof body !== "object"
    || Array.isArray(body)
    || Object.keys(body).length !== 0
  )) {
    throw httpError(400, "PROFILER_ACTION_INPUT_REJECTED", `${label} does not accept client input.`);
  }
}

function profilerSelection(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "PROFILER_SELECTION_REQUIRED", "A profiler thread, goal, agent, or time range is required.");
  }
  const allowed = new Set(["thread_id", "goal_id", "agent_id", "from", "to"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw httpError(400, "PROFILER_SELECTION_INPUT_REJECTED", "The profiler selection contains unsupported fields.");
  }
  for (const key of allowed) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].trim() === "")) {
      throw httpError(400, "PROFILER_SELECTION_INPUT_REJECTED", "Profiler selection values must be non-empty strings.");
    }
  }
  const selection = {
    threadId: body.thread_id?.trim() || undefined,
    goalId: body.goal_id?.trim() || undefined,
    agentId: body.agent_id?.trim() || undefined,
    from: body.from?.trim() || undefined,
    to: body.to?.trim() || undefined,
  };
  if (!selection.threadId && !selection.goalId && !selection.agentId && !selection.from && !selection.to) {
    throw httpError(400, "PROFILER_SELECTION_REQUIRED", "A profiler thread, goal, agent, or time range is required.");
  }
  return selection;
}

function safeErrorCode(error) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 120);
  }
  return sanitizeErrorMessage(error);
}

function mapStartPlanError(error) {
  if (Number.isInteger(error?.statusCode)) return error;
  const code = typeof error?.code === "string" ? error.code : "STARTPLAN_REFRESH_FAILED";
  const message = {
    startplan_billing_timeout: "Official Start Plan billing timed out.",
    startplan_billing_unauthorized: "Official Start Plan authentication was rejected.",
    startplan_billing_forbidden: "Official Start Plan billing access was forbidden.",
    startplan_billing_rate_limited: "Official Start Plan billing rate-limited the request.",
    startplan_authentication_unavailable: "Official Start Plan authentication is unavailable.",
    startplan_official_reader_build_missing: "Build the official Bridge sources before refreshing Start Plan billing.",
    startplan_keyring_lock_present_before_capture:
      "The official keyring lock was already present; the refresh was not attempted.",
  }[code] ?? "Official Start Plan billing refresh failed.";
  const mapped = httpError(
    code === "startplan_official_reader_build_missing" ? 503
      : code === "startplan_billing_timeout" ? 504
        : code === "startplan_billing_rate_limited" ? 502
          : 502,
    code.toUpperCase(),
    message,
  );
  mapped.cause = error;
  return mapped;
}

function assertNotAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new Error("verification_aborted");
}

function delayWithSignal(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("verification_aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("verification_aborted"));
    }, { once: true });
  });
}

function withTimeout(promise, milliseconds, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function loadOptionalVerificationRunner() {
  // Master can pass the production runner explicitly. A fixed adjacent module
  // is also accepted so the CLI and tests never expose a path-controlled hook.
  const fixedModule = path.join(SCRIPT_ROOT, "production-verification-runner.mjs");
  return async (input) => {
    let module;
    try {
      module = await import(pathToFileURL(fixedModule).href);
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND") {
        throw httpError(503, "REAL_VERIFICATION_NOT_CONFIGURED", "The production verification runner is not configured.");
      }
      throw error;
    }
    if (typeof module.runProductionCodingPlanVerification !== "function") {
      throw httpError(503, "REAL_VERIFICATION_NOT_CONFIGURED", "The production verification runner export is missing.");
    }
    return module.runProductionCodingPlanVerification(input);
  };
}

async function main() {
  const port = Number(process.env.COST_LAB_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("COST_LAB_PORT must be an integer between 0 and 65535");
  }
  const app = createCostLabWebServer({ port });
  const address = await app.start();
  process.stdout.write(`Cost Lab Web: ${address.url}\n`);
  process.stdout.write("Press Ctrl+C to stop. Bound to 127.0.0.1 only.\n");
  const shutdown = async () => {
    try {
      await app.close();
    } catch (error) {
      process.stderr.write(`Cost Lab shutdown: ${safeErrorCode(error)}; inspect persisted verification history.\n`);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
