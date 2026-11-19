import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PROJECT_ROOT, createCostLabWebServer } from "../web-server.mjs";

const RUN_ROOT = path.join(PROJECT_ROOT, ".run");
const REPORT_ID = "a".repeat(64);

function snapshot() {
  return {
    schema_version: 1,
    kind: "profiler_snapshot",
    snapshot_id: "b".repeat(64),
    captured_at: "2026-11-19T08:00:00.000Z",
    generated_at: "2026-11-19T08:00:00.000Z",
    event_horizon_at: "2026-11-19T07:59:00.000Z",
    read_only: true,
    collection_mode: "FULL",
    sources: [{ source_id: "source-1", kind: "codex_rollout_jsonl" }],
    warnings: [],
    agents: [{
      agent_id: "master-thread",
      kind: "MASTER",
      thread_id: "master-thread",
      parent_thread_id: null,
      parent_agent_id: null,
      root_agent_id: "master-thread",
      goal_id: "master-thread",
      nickname: null,
      task_id: null,
      provider: "synthetic",
      model: "synthetic-model",
      reasoning_effort: "low",
      started_at: "2026-11-19T07:00:00.000Z",
      ended_at: "2026-11-19T08:00:00.000Z",
      duration_ms: 3_600_000,
      response_count: 2,
      unknown_usage_response_count: 0,
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        uncached_input_tokens: 60,
        output_tokens: 20,
        reasoning_tokens: 5,
        total_tokens: 120,
        evidence_level: "OBSERVED",
      },
      correlation: { status: "ROOT" },
    }],
  };
}

function report() {
  return {
    schema_version: 1,
    kind: "profiler_report",
    report_id: REPORT_ID,
    source_snapshot_id: snapshot().snapshot_id,
    generated_at: "2026-11-19T08:01:00.000Z",
    usage: {
      overall: {
        total_tokens: 120,
        response_count: 2,
        unknown_usage_response_count: 0,
        evidence_level: "OBSERVED",
      },
      by_agent_kind: {},
      by_provider: [],
    },
    agents: snapshot().agents,
    phases: {
      summary: [],
      rows: [],
      conservation: { status: "CONSERVED" },
    },
    mcp: {
      calls: [],
      by_tool: [],
      waiting: {
        mcp_call_duration_ms: { total: 0 },
        pure_wait_ms: 0,
        model_driven_poll_count: 0,
        model_driven_poll_usage: { total_tokens: 0 },
        model_driven_poll_share_of_master_tokens: 0,
        worker_execution_ms: 0,
        master_parallel_work_ms: 0,
      },
    },
    context: {
      cache: {
        overall_cache_hit_rate: 0.4,
        overall_uncached_input_ratio: 0.6,
      },
      context: { sources: [], total_observed_content_bytes: 0, total_estimated_content_tokens: 0 },
      compactions: { count: 0 },
      repeated_reads: { repeated_read_count: 0 },
    },
    diagnostics: [],
    timeline: [{
      timeline_id: "response:response-1",
      kind: "RESPONSE",
      at: "2026-11-19T07:30:00.000Z",
      end_at: "2026-11-19T07:30:00.000Z",
      agent_id: "master-thread",
      turn_id: "turn-1",
      response_id: "response-1",
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      total_tokens: 120,
      status: "OBSERVED",
      evidence_level: "OBSERVED",
      content: "must not be exported",
    }],
    timeline_meta: {
      event_count: 1,
      total_event_count: 1,
      truncated: false,
      limit: 500,
      content_retained: false,
      arbitrary_content: "RAW_SECRET_BODY",
    },
    limitations: ["Synthetic test report."],
  };
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Markdown export is not JSON.
  }
  return { response, text, json };
}

async function makeServer(calls) {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "cost-lab-profiler-web-test-"));
  let currentSnapshot = null;
  const currentReport = report();
  const server = createCostLabWebServer({
    projectRoot: PROJECT_ROOT,
    historyPath: path.join(root, "history.json"),
    profilerLatest: async () => currentSnapshot,
    profilerCollect: async () => {
      calls.collect += 1;
      currentSnapshot = snapshot();
      return {
        snapshot: currentSnapshot,
        collected_at: currentSnapshot.generated_at,
      };
    },
    profilerAnalyze: async (options) => {
      calls.analyze.push(options);
      return { report: currentReport, snapshot: currentSnapshot };
    },
    profilerReports: async () => [{
      report_id: REPORT_ID,
      generated_at: currentReport.generated_at,
      captured_at: currentSnapshot?.captured_at ?? null,
      total_tokens: 120,
      response_count: 2,
      diagnostics_count: 0,
    }],
    profilerReport: async (id) => {
      assert.equal(id, REPORT_ID);
      return currentReport;
    },
    profilerCompare: async ({ before, after }) => ({
      kind: "profiler_comparison",
      before_report_id: before,
      after_report_id: after,
      compatibility: { status: "COMPARABLE" },
      metrics: {},
      phases: [],
      mcp: { tools: [] },
    }),
  });
  const address = await server.start();
  return {
    address,
    cleanup: async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function headers(base, token) {
  return {
    "Content-Type": "application/json",
    Origin: base,
    "X-Cost-Lab-CSRF": token,
    "Sec-Fetch-Site": "same-origin",
  };
}

test("profiler Web API stays read-only until an explicit CSRF-authorized collection", async () => {
  const calls = { collect: 0, analyze: [] };
  const fixture = await makeServer(calls);
  try {
    const latest = await request(fixture.address.origin, "/api/profiler/latest");
    assert.equal(latest.response.status, 200);
    assert.equal(latest.json.data.status, "NO_SNAPSHOT");
    assert.equal(calls.collect, 0);

    const rejected = await request(fixture.address.origin, "/api/profiler/collect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.address.origin,
      },
      body: "{}",
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(calls.collect, 0);

    const session = (await request(fixture.address.origin, "/api/session")).json.data;
    const collected = await request(fixture.address.origin, "/api/profiler/collect", {
      method: "POST",
      headers: headers(fixture.address.origin, session.csrf_token),
      body: "{}",
    });
    assert.equal(collected.response.status, 200);
    assert.equal(collected.json.data.status, "READY");
    assert.equal(collected.json.data.sessions.length, 1);
    assert.equal(calls.collect, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("Web UI serves bilingual assets with the same loopback-only static contract", async () => {
  const calls = { collect: 0, analyze: [] };
  const fixture = await makeServer(calls);
  try {
    const page = await request(fixture.address.origin, "/");
    assert.equal(page.response.status, 200);
    assert.match(page.text, /data-language="zh-CN"/u);
    assert.match(page.text, /data-i18n="profiler\.title"/u);
    assert.match(page.text, /id="profiler-timeline-body" class="timeline-body" hidden/u);
    assert.match(page.text, /id="export-profiler-timeline"/u);

    const module = await request(fixture.address.origin, "/i18n.mjs");
    assert.equal(module.response.status, 200);
    assert.match(module.response.headers.get("content-type"), /text\/javascript/u);
    assert.match(module.text, /LANGUAGE_STORAGE_KEY/u);
    assert.doesNotMatch(module.text, /Bearer\s+[A-Za-z0-9._-]{16,}/u);

    const startPlanStatus = await request(fixture.address.origin, "/startplan-status.mjs");
    assert.equal(startPlanStatus.response.status, 200);
    assert.match(startPlanStatus.response.headers.get("content-type"), /text\/javascript/u);
    assert.match(startPlanStatus.text, /resolveStartPlanStatus/u);
  } finally {
    await fixture.cleanup();
  }
});

test("profiler Web API creates, exports, and compares shared-core reports", async () => {
  const calls = { collect: 0, analyze: [] };
  const fixture = await makeServer(calls);
  try {
    const base = fixture.address.origin;
    const session = (await request(base, "/api/session")).json.data;
    await request(base, "/api/profiler/collect", {
      method: "POST",
      headers: headers(base, session.csrf_token),
      body: "{}",
    });

    const analyzed = await request(base, "/api/profiler/analyze", {
      method: "POST",
      headers: headers(base, session.csrf_token),
      body: JSON.stringify({ agent_id: "master-thread" }),
    });
    assert.equal(analyzed.response.status, 200, JSON.stringify(analyzed.json));
    assert.equal(analyzed.json.data.report_id, REPORT_ID);
    assert.equal(calls.analyze[0].agentId, "master-thread");

    const invalid = await request(base, "/api/profiler/analyze", {
      method: "POST",
      headers: headers(base, session.csrf_token),
      body: JSON.stringify({ prompt: "not accepted" }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.json.error.code, "PROFILER_SELECTION_INPUT_REJECTED");

    const exported = await request(base, `/api/profiler/reports/${REPORT_ID}/export`);
    assert.equal(exported.response.status, 200, exported.text);
    assert.match(exported.response.headers.get("content-disposition"), /attachment/u);
    assert.match(exported.text, /# Agent Token Profiler/u);

    const timelineExport = await request(
      base,
      `/api/profiler/reports/${REPORT_ID}/timeline/export`,
    );
    assert.equal(timelineExport.response.status, 200, timelineExport.text);
    assert.equal(timelineExport.json.kind, "cost_lab_profiler_timeline_export");
    assert.equal(timelineExport.json.report_id, REPORT_ID);
    assert.equal(timelineExport.json.timeline.length, 1);
    assert.equal(timelineExport.json.timeline[0].response_id, "response-1");
    assert.equal("content" in timelineExport.json.timeline[0], false);
    assert.equal("arbitrary_content" in timelineExport.json.timeline_meta, false);
    assert.equal(timelineExport.text.includes("RAW_SECRET_BODY"), false);

    const compared = await request(base, "/api/profiler/compare", {
      method: "POST",
      headers: headers(base, session.csrf_token),
      body: JSON.stringify({ before: REPORT_ID, after: REPORT_ID }),
    });
    assert.equal(compared.response.status, 200);
    assert.equal(compared.json.data.kind, "profiler_comparison");
  } finally {
    await fixture.cleanup();
  }
});
