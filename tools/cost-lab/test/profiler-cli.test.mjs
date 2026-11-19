import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import * as profiler from "../profiler/index.mjs";
import { main } from "../cli.mjs";
import { PROJECT_ROOT } from "../profiler-service.mjs";

function capture() {
  let text = "";
  return {
    stream: {
      write(value) {
        text += String(value);
        return true;
      },
    },
    value() {
      return text;
    },
  };
}

function record(type, payload, timestamp = "2026-11-19T08:00:00.000Z") {
  return {
    timestamp,
    ordinal: null,
    type,
    payload,
  };
}

function usage(total = 120) {
  return {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: total,
  };
}

async function fixture() {
  await mkdir(path.join(PROJECT_ROOT, ".run"), { recursive: true });
  const root = await mkdtemp(path.join(PROJECT_ROOT, ".run", "cost-lab-profiler-cli-test-"));
  const codexHome = path.join(root, "codex");
  const threadId = "thread-cli-synthetic";
  const rollout = path.join(codexHome, "sessions", "2026", "11", "19", `rollout-2026-11-19T08-00-00-${threadId}.jsonl`);
  await mkdir(path.dirname(rollout), { recursive: true });
  const records = [
    record("session_meta", {
      id: threadId,
      session_id: threadId,
      parent_thread_id: null,
      thread_source: "user",
      model_provider: "synthetic",
      cli_version: "synthetic",
      context_window: 100_000,
    }),
    record("turn_context", {
      turn_id: "turn-1",
      root_turn_id: "turn-1",
      model: "synthetic-model",
      effort: "low",
    }),
    record("token_usage_record", {
      thread_id: threadId,
      turn_id: "turn-1",
      root_turn_id: "turn-1",
      session_id: threadId,
      response_id: "response-1",
      usage: usage(),
      turn_token_usage: usage(),
      thread_token_usage: usage(),
    }, "2026-11-19T08:00:01.000Z"),
    record("response_item", {
      type: "function_call",
      name: "zcode_events",
      call_id: "call-1",
      arguments: "{\"task_id\":\"task-1\"}",
      status: "completed",
    }, "2026-11-19T08:00:02.000Z"),
    record("response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: "bounded synthetic receipt",
    }, "2026-11-19T08:00:03.000Z"),
  ].map((entry, ordinal) => ({ ...entry, ordinal }));
  await writeFile(rollout, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return {
    root,
    codexHome,
    threadId,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("CLI sessions, analyze, report, reports, and compare share the profiler core", async () => {
  const data = await fixture();
  const common = [
    "--codex-home",
    data.codexHome,
    "--no-default-bridge",
  ];
  try {
    const sessions = capture();
    assert.equal(await main(
      ["profiler", "sessions", "--json", ...common],
      { projectRoot: data.root, stdout: sessions.stream },
    ), 0);
    const sessionOutput = JSON.parse(sessions.value());
    assert.equal(sessionOutput.sessions.length, 1);
    assert.equal(sessionOutput.sessions[0].agent_id, data.threadId);
    assert.equal(sessionOutput.sessions[0].total_tokens, 120);

    const analyzed = capture();
    assert.equal(await main(
      ["profiler", "analyze", "--agent", data.threadId, "--json", ...common],
      { projectRoot: data.root, stdout: analyzed.stream },
    ), 0);
    const report = JSON.parse(analyzed.value());
    profiler.assertProfilerReport(report);
    assert.equal(report.usage.overall.total_tokens, 120);
    assert.equal(report.mcp.calls.length, 1);
    assert.ok(report.timeline.some((entry) => entry.kind === "MCP_TOOL"));

    const loaded = capture();
    assert.equal(await main(
      ["profiler", "report", "--id", report.report_id.slice(0, 12), "--json"],
      { projectRoot: data.root, stdout: loaded.stream },
    ), 0);
    assert.equal(JSON.parse(loaded.value()).report_id, report.report_id);

    const listing = capture();
    assert.equal(await main(
      ["profiler", "reports", "--json"],
      { projectRoot: data.root, stdout: listing.stream },
    ), 0);
    assert.equal(JSON.parse(listing.value())[0].report_id, report.report_id);

    const compared = capture();
    assert.equal(await main(
      [
        "profiler",
        "compare",
        "--before",
        report.report_id,
        "--after",
        report.report_id,
        "--json",
      ],
      { projectRoot: data.root, stdout: compared.stream },
    ), 0);
    const comparison = JSON.parse(compared.value());
    assert.equal(comparison.kind, "profiler_comparison");
    assert.equal(comparison.before_report_id, report.report_id);
  } finally {
    await data.cleanup();
  }
});
