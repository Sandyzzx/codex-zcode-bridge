import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  analyzeProfilerSnapshot,
  collectProfilerSnapshot,
} from "../profiler/index.mjs";

function record(timestamp, ordinal, type, payload) {
  return JSON.stringify({ timestamp, ordinal, type, payload });
}

function usage(input, cached, output, total = input + output) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: total,
  };
}

function tokenCount(timestamp, ordinal, total, last) {
  return record(timestamp, ordinal, "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: total,
      last_token_usage: last,
      last_usage_includes_reasoning: false,
      model_context_window: 100000,
    },
  });
}

function sessionMeta() {
  return record("2026-11-19T00:00:00.000Z", 0, "session_meta", {
    id: "master-thread",
    session_id: "master-thread",
    parent_thread_id: null,
    thread_source: "user",
    originator: "Codex Desktop",
    cli_version: "0.169.0-alpha.11.1",
    model_provider: "openai",
    context_window: 100000,
    source: "vscode",
  });
}

function functionCall(timestamp, ordinal, name, callId, args) {
  return record(timestamp, ordinal, "response_item", {
    type: "function_call",
    status: "completed",
    id: `fc-${ordinal}`,
    call_id: callId,
    name,
    namespace: name.startsWith("zcode_") ? "mcp__zcode_bridge" : undefined,
    arguments: JSON.stringify(args),
  });
}

function functionOutput(timestamp, ordinal, callId, output) {
  return record(timestamp, ordinal, "response_item", {
    type: "function_call_output",
    call_id: callId,
    output: typeof output === "string" ? output : JSON.stringify(output),
  });
}

function responseUsage(timestamp, ordinal, responseId, turnId, last, cumulative) {
  return record(timestamp, ordinal, "token_usage_record", {
    thread_id: "master-thread",
    session_id: "master-thread",
    turn_id: turnId,
    response_id: responseId,
    usage: last,
    thread_token_usage: cumulative,
  });
}

function writeMasterRollout(filePath) {
  const statusArgs = {
    task_id: "task-1",
    view: "summary",
    wait_ms: 5000,
    wait_for: "attention",
  };
  const statusOutput = JSON.stringify({
    ok: true,
    events: [],
    padding: "z".repeat(2048),
  });
  const lines = [
    sessionMeta(),
    record("2026-11-19T00:00:00.500Z", 1, "turn_context", {
      turn_id: "turn-dispatch",
      root_turn_id: "turn-dispatch",
      model: "gpt-test",
      effort: "high",
      model_context_window: 100000,
    }),
    functionCall("2026-11-19T00:00:01.000Z", 2, "zcode_task", "call-dispatch", {
      task_id: "task-1",
      objective: "synthetic task",
    }),
    responseUsage(
      "2026-11-19T00:00:01.010Z",
      3,
      "resp-dispatch",
      "turn-dispatch",
      usage(100, 50, 10),
      usage(100, 50, 10),
    ),
    tokenCount("2026-11-19T00:00:01.020Z", 4, usage(100, 50, 10), usage(100, 50, 10)),
    functionOutput("2026-11-19T00:00:01.200Z", 5, "call-dispatch", {
      ok: true,
      task_id: "task-1",
    }),

    functionCall("2026-11-19T00:00:02.000Z", 6, "zcode_events", "call-wait-1", statusArgs),
    responseUsage(
      "2026-11-19T00:00:02.010Z",
      7,
      "resp-wait-1",
      "turn-wait-1",
      usage(20, 10, 0),
      usage(120, 60, 10),
    ),
    tokenCount("2026-11-19T00:00:02.020Z", 8, usage(120, 60, 10), usage(20, 10, 0)),
    functionOutput("2026-11-19T00:00:07.000Z", 9, "call-wait-1", statusOutput),

    functionCall("2026-11-19T00:00:08.000Z", 10, "zcode_events", "call-wait-2", statusArgs),
    responseUsage(
      "2026-11-19T00:00:08.010Z",
      11,
      "resp-wait-2",
      "turn-wait-2",
      usage(30, 15, 0),
      usage(150, 75, 10),
    ),
    tokenCount("2026-11-19T00:00:08.020Z", 12, usage(150, 75, 10), usage(30, 15, 0)),
    functionOutput("2026-11-19T00:00:13.000Z", 13, "call-wait-2", statusOutput),

    functionCall("2026-11-19T00:00:14.000Z", 14, "zcode_result", "call-result", {
      task_id: "task-1",
    }),
    responseUsage(
      "2026-11-19T00:00:14.010Z",
      15,
      "resp-result",
      "turn-result",
      usage(10, 5, 0),
      usage(160, 80, 10),
    ),
    tokenCount("2026-11-19T00:00:14.020Z", 16, usage(160, 80, 10), usage(10, 5, 0)),
    functionOutput("2026-11-19T00:00:16.000Z", 17, "call-result", {
      ok: false,
      error: "not ready",
      task_id: "task-1",
    }),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeSubagentRollout(filePath) {
  const lines = [
    record("2026-11-19T00:00:20.000Z", 0, "session_meta", {
      id: "subagent-thread",
      session_id: "master-thread",
      parent_thread_id: "master-thread",
      thread_source: "subagent",
      agent_nickname: "Synthetic Subagent",
      agent_path: "/root/synthetic_subagent",
      originator: "Codex Desktop",
      cli_version: "0.169.0-alpha.11.1",
      model_provider: "openai",
      context_window: 100000,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "master-thread",
            depth: 1,
            agent_path: "/root/synthetic_subagent",
          },
        },
      },
    }),
    record("2026-11-19T00:00:20.100Z", 1, "turn_context", {
      turn_id: "subagent-turn",
      root_turn_id: "turn-dispatch",
      model: "gpt-subagent",
      effort: "medium",
      model_context_window: 100000,
    }),
    record("2026-11-19T00:00:21.000Z", 2, "token_usage_record", {
      thread_id: "subagent-thread",
      session_id: "master-thread",
      turn_id: "subagent-turn",
      response_id: "resp-subagent",
      usage: usage(40, 10, 5),
      thread_token_usage: usage(40, 10, 5),
    }),
    tokenCount(
      "2026-11-19T00:00:21.100Z",
      3,
      usage(40, 10, 5),
      usage(40, 10, 5),
    ),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function createBridgeDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA user_version=14;
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      task_json TEXT NOT NULL,
      status TEXT NOT NULL,
      current_attempt INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE attempts (
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      generation INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id,attempt)
    );
    CREATE TABLE runtime_task_events (
      event_cursor INTEGER PRIMARY KEY,
      operation_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      claim_id TEXT NOT NULL,
      worker_sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      at TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT,
      details_digest TEXT
    );
    CREATE TABLE manager_operations (
      operation_id TEXT PRIMARY KEY,
      operation_kind TEXT NOT NULL,
      task_id TEXT,
      attempt INTEGER,
      generation INTEGER,
      phase TEXT NOT NULL,
      created_at TEXT NOT NULL,
      result_status TEXT,
      result_json TEXT
    );
    CREATE TABLE manager_operation_events (
      event_cursor INTEGER PRIMARY KEY,
      operation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      to_phase TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?)").run(
    "task-1",
    JSON.stringify({ model: { provider_id: "zai", model_id: "worker-model" } }),
    "completed",
    1,
    "2026-11-19T00:00:01.000Z",
  );
  db.prepare("INSERT INTO attempts VALUES (?,?,?,?,?)").run(
    "task-1",
    1,
    1,
    "completed",
    "2026-11-19T00:00:01.000Z",
  );
  const insertEvent = db.prepare(`
    INSERT INTO runtime_task_events
    (event_cursor,operation_id,task_id,attempt,generation,claim_id,worker_sequence,
     event_type,at,summary,details_json,details_digest)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const events = [
    [1, "session_ready", "2026-11-19T00:00:02.000Z", "session ready", {
      session_id: "worker-session",
      selected_model: "worker-model (zai)",
      reasoning_level: "low",
    }],
    [2, "turn_started", "2026-11-19T00:00:02.100Z", "turn started", {
      turn_id: "worker-turn",
    }],
    [3, "model_tool_call", "2026-11-19T00:00:03.000Z", "tool call", {
      tool_name: "exec_command",
      tool_call_id: "worker-call",
      arguments: { cmd: "npm test" },
    }],
    [4, "tool_status", "2026-11-19T00:00:04.000Z", "tool completed", {
      tool_call_id: "worker-call",
      state: "completed",
      output_bytes: 100,
      duration_ms: 1000,
    }],
    [5, "turn_completed", "2026-11-19T00:00:51.000Z", "turn completed", {
      turn_id: "worker-turn",
      usage: {
        inputTokens: 50,
        cachedInputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 55,
      },
    }],
  ];
  for (const [cursor, type, at, summary, details] of events) {
    insertEvent.run(
      cursor,
      "operation-1",
      "task-1",
      1,
      1,
      "claim-1",
      cursor,
      type,
      at,
      summary,
      JSON.stringify(details),
      "a".repeat(64),
    );
  }
  db.prepare("INSERT INTO manager_operations VALUES (?,?,?,?,?,?,?,?,?)").run(
    "operation-1",
    "attempt_lifecycle",
    "task-1",
    1,
    1,
    "result_committed",
    "2026-11-19T00:00:01.000Z",
    "completed",
    JSON.stringify({
      model: "worker-model",
      usage: {
        input_tokens: 50,
        cached_input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 2,
        total_tokens: 55,
      },
    }),
  );
  db.prepare("INSERT INTO manager_operation_events VALUES (?,?,?,?,?)").run(
    1,
    "operation-1",
    "claim_committed",
    "running",
    "2026-11-19T00:00:02.000Z",
  );
  db.prepare("INSERT INTO manager_operation_events VALUES (?,?,?,?,?)").run(
    2,
    "operation-1",
    "result_committed",
    "result_committed",
    "2026-11-19T00:00:51.000Z",
  );
  db.close();
}

test("MCP analysis separates pure wait, model-driven polling, failures, and parallel worker time", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-mcp-"));
  try {
    const rolloutFile = path.join(root, "rollout-master.jsonl");
    const databaseFile = path.join(root, "bridge.sqlite");
    writeMasterRollout(rolloutFile);
    createBridgeDatabase(databaseFile);
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
      bridgeDatabasePaths: [databaseFile],
    });
    const worker = snapshot.agents.find((agent) => agent.kind === "WORKER");
    const master = snapshot.agents.find((agent) => agent.kind === "MASTER");
    assert.equal(worker.parent_agent_id, master.agent_id);
    assert.equal(worker.correlation.evidence, "mcp_task_dispatch");
    assert.equal(master.usage.total_tokens, 170);
    assert.equal(worker.usage.total_tokens, 55);

    const report = analyzeProfilerSnapshot(snapshot);
    assert.equal(report.usage.by_agent_kind.MASTER.total_tokens, 170);
    assert.equal(report.usage.by_agent_kind.WORKER.total_tokens, 55);
    assert.equal(report.phases.conservation.status, "CONSERVED");
    assert.equal(report.mcp.waiting.pure_wait_call_count, 1);
    assert.equal(report.mcp.waiting.pure_wait_ms, 5000);
    assert.equal(report.mcp.waiting.model_driven_poll_count, 1);
    assert.equal(report.mcp.waiting.model_driven_poll_usage.total_tokens, 30);
    assert.equal(report.mcp.waiting.worker_execution_ms, 49000);
    assert.equal(report.mcp.waiting.master_parallel_work_ms, 49000);
    assert.ok(report.mcp.waiting.master_parallel_worker_tasks.length >= 1);
    const eventsTool = report.mcp.by_tool.find((row) => row.tool_name === "zcode_events");
    assert.equal(eventsTool.call_count, 2);
    assert.equal(eventsTool.duplicate_count, 1);
    assert.equal(eventsTool.state_unchanged_duplicate_count, 1);
    assert.equal(eventsTool.output_bytes.total, 4168);
    assert.equal(eventsTool.failure_count, 0);
    const resultTool = report.mcp.by_tool.find((row) => row.tool_name === "zcode_result");
    assert.equal(resultTool.failure_count, 1);
    assert.equal(resultTool.output_bytes.total, 51);
    assert.ok(report.mcp.output_ranking[0].output_bytes >= 4168);
    assert.ok(report.mcp.output_ranking[0].estimated_output_tokens >= 1042);
    assert.equal(report.phases.summary.find((row) => row.phase === "FailureRetry").response_count, 1);
    assert.equal(JSON.stringify(report).includes("z".repeat(100)), false);
    const threadReport = analyzeProfilerSnapshot(snapshot, { threadId: "master-thread" });
    assert.deepEqual(threadReport.scope.agent_ids, [master.agent_id, worker.agent_id].sort());
    assert.equal(threadReport.usage.overall.total_tokens, 225);
    assert.equal(threadReport.usage.by_agent_kind.MASTER.total_tokens, 170);
    assert.equal(threadReport.usage.by_agent_kind.WORKER.total_tokens, 55);
    assert.equal(threadReport.timeline_meta.content_retained, false);
    assert.ok(threadReport.timeline.some((entry) => entry.kind === "MCP_TOOL"));
    assert.ok(threadReport.timeline.some((entry) => entry.kind === "WORKER"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge incremental collection resumes an open tool call until its status event arrives", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-bridge-incremental-"));
  try {
    const databaseFile = path.join(root, "bridge.sqlite");
    createBridgeDatabase(databaseFile);
    let db = new DatabaseSync(databaseFile);
    db.prepare("DELETE FROM runtime_task_events WHERE event_cursor=4").run();
    db.close();

    const options = {
      env: {},
      codexHome: root,
      sessionRoots: [],
      includeArchived: false,
      includeDefaultBridge: false,
      bridgeDatabasePaths: [databaseFile],
    };
    const beforeStatus = await collectProfilerSnapshot(options);
    const pendingTool = beforeStatus.tools.find((tool) => tool.call_id === "worker-call");
    assert.equal(pendingTool.status, "UNKNOWN");
    assert.equal(pendingTool.ended_at, null);

    db = new DatabaseSync(databaseFile);
    db.prepare(`
      INSERT INTO runtime_task_events
      (event_cursor,operation_id,task_id,attempt,generation,claim_id,worker_sequence,
       event_type,at,summary,details_json,details_digest)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      6,
      "operation-1",
      "task-1",
      1,
      1,
      "claim-1",
      6,
      "tool_status",
      "2026-11-19T00:00:06.000Z",
      "tool completed",
      JSON.stringify({
        tool_call_id: "worker-call",
        state: "completed",
        output_bytes: 100,
      }),
      "b".repeat(64),
    );
    db.close();

    const completed = await collectProfilerSnapshot({
      ...options,
      previousSnapshot: beforeStatus,
      incrementalState: beforeStatus.next_incremental_state,
    });
    const completedTool = completed.tools.find((tool) => tool.call_id === "worker-call");
    assert.equal(completedTool.status, "SUCCESS");
    assert.equal(completedTool.ended_at, "2026-11-19T00:00:06.000Z");
    assert.equal(completedTool.duration_ms, 3_000);
    assert.equal(completedTool.output_bytes, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("McpToolCall item timestamps and nanosecond duration are analyzed without retaining payloads", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-mcp-item-"));
  try {
    const file = path.join(root, "rollout-mcp-item.jsonl");
    const startedAt = "2026-11-19T02:00:00.000Z";
    const completedAt = "2026-11-19T02:00:00.130Z";
    writeFileSync(file, [
      sessionMeta(),
      record("2026-11-19T02:00:00.000Z", 1, "event_msg", {
        type: "item_completed",
        started_at_ms: Date.parse(startedAt),
        completed_at_ms: Date.parse(startedAt) + 130.7872,
        item: {
          type: "McpToolCall",
          id: "mcp-item-1",
          server: "mcp__zcode_bridge",
          tool: "zcode_events",
          status: "completed",
          duration: { secs: 0, nanos: 130787200 },
          arguments: {
            task_id: "task-item",
            token: "SENTINEL_MCP_ARGUMENT",
          },
          result: {
            isError: false,
            content: [{ type: "text", text: "SENTINEL_MCP_RESULT" }],
          },
        },
      }),
    ].join("\n") + "\n", "utf8");
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
    });
    assert.equal(snapshot.tools.length, 1);
    const tool = snapshot.tools[0];
    assert.equal(tool.name, "zcode_events");
    assert.equal(tool.started_at, startedAt);
    assert.equal(tool.ended_at, completedAt);
    assert.equal(tool.duration_ms, 130.7872);
    assert.equal(tool.status, "SUCCESS");
    assert.equal(tool.failed, false);
    assert.equal(tool.output_bytes, null);
    assert.equal(tool.content_retained, false);
    assert.equal(JSON.stringify(snapshot).includes("SENTINEL_MCP_ARGUMENT"), false);
    assert.equal(JSON.stringify(snapshot).includes("SENTINEL_MCP_RESULT"), false);
    const report = analyzeProfilerSnapshot(snapshot);
    const row = report.mcp.by_tool.find((entry) => entry.tool_name === "zcode_events");
    assert.equal(row.duration_ms.total, 130.7872);
    assert.equal(report.timeline.find((entry) => entry.kind === "MCP_TOOL").duration_ms, 130.7872);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("thread analysis includes Master, Subagent, and dispatched Worker without double counting", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-lineage-"));
  try {
    const rolloutFile = path.join(root, "rollout-master.jsonl");
    const subagentFile = path.join(root, "rollout-subagent.jsonl");
    const databaseFile = path.join(root, "bridge.sqlite");
    writeMasterRollout(rolloutFile);
    writeSubagentRollout(subagentFile);
    createBridgeDatabase(databaseFile);
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
      bridgeDatabasePaths: [databaseFile],
    });
    const threadReport = analyzeProfilerSnapshot(snapshot, { threadId: "master-thread" });
    assert.equal(threadReport.usage.by_agent_kind.MASTER.total_tokens, 170);
    assert.equal(threadReport.usage.by_agent_kind.SUBAGENT.total_tokens, 45);
    assert.equal(threadReport.usage.by_agent_kind.WORKER.total_tokens, 55);
    assert.equal(threadReport.usage.overall.total_tokens, 270);
    assert.deepEqual(
      threadReport.scope.agent_ids,
      ["master-thread", "subagent-thread", "worker:task-1:1"].sort(),
    );
    assert.equal(
      threadReport.usage.overall.total_tokens,
      threadReport.usage.by_agent_kind.MASTER.total_tokens
        + threadReport.usage.by_agent_kind.SUBAGENT.total_tokens
        + threadReport.usage.by_agent_kind.WORKER.total_tokens,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
