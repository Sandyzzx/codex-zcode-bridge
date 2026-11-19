import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import {
  collectProfilerSnapshot,
  validateProfilerSnapshot,
} from "../profiler/index.mjs";

function record(timestamp, ordinal, type, payload) {
  return JSON.stringify({ timestamp, ordinal, type, payload });
}

function usage(input, cached, output, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function meta({
  id,
  sessionId,
  parent = null,
  nickname = null,
  agentPath = null,
  subagent = false,
}) {
  return {
    id,
    session_id: sessionId,
    parent_thread_id: parent,
    agent_nickname: nickname,
    agent_path: agentPath,
    thread_source: subagent ? "subagent" : "user",
    originator: "Codex Desktop",
    cli_version: "0.169.0-alpha.11.1",
    model_provider: "openai",
    context_window: 100000,
    source: subagent
      ? {
          subagent: {
            thread_spawn: {
              parent_thread_id: parent,
              depth: 1,
              agent_path: agentPath,
              agent_nickname: nickname,
            },
          },
        }
      : "vscode",
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

function writeMaster(filePath) {
  const lines = [
    record("2026-11-19T00:00:00.000Z", 0, "session_meta", meta({
      id: "root-thread",
      sessionId: "root-thread",
    })),
    record("2026-11-19T00:00:00.500Z", 1, "turn_context", {
      turn_id: "turn-1",
      root_turn_id: "turn-1",
      model: "gpt-test",
      effort: "high",
      model_context_window: 100000,
    }),
    record("2026-11-19T00:00:01.000Z", 2, "response_item", {
      type: "function_call",
      status: "completed",
      id: "fc-1",
      call_id: "call-1",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "Get-Content SECRET_COMMAND_PATH",
        workdir: "D:\\project",
      }),
    }),
    record("2026-11-19T00:00:02.000Z", 3, "token_usage_record", {
      thread_id: "root-thread",
      session_id: "root-thread",
      turn_id: "turn-1",
      response_id: "resp-1",
      usage: usage(100, 40, 10, 3),
      turn_token_usage: usage(100, 40, 10, 3),
      thread_token_usage: usage(100, 40, 10, 3),
    }),
    tokenCount(
      "2026-11-19T00:00:02.100Z",
      4,
      usage(100, 40, 10, 3),
      usage(100, 40, 10, 3),
    ),
    record("2026-11-19T00:00:03.000Z", 5, "response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: `SENTINEL_OUTPUT_${"x".repeat(400)}`,
    }),
    record("2026-11-19T00:00:04.000Z", 6, "response_item", {
      type: "custom_tool_call",
      status: "completed",
      id: "fc-2",
      call_id: "call-2",
      name: "apply_patch",
      input: "CRITICAL_SENTINEL_PATCH",
    }),
    record("2026-11-19T00:00:04.100Z", 7, "response_item", {
      type: "custom_tool_call_output",
      call_id: "call-2",
      status: "completed",
      output: "CUSTOM_SENTINEL_OUTPUT",
    }),
    record("2026-11-19T00:00:04.200Z", 8, "response_item", {
      type: "message",
      role: "user",
      content: "USER_SENTINEL_CONTEXT",
    }),
    record("2026-11-19T00:00:04.300Z", 9, "response_item", {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "REASONING_SENTINEL" }],
    }),
    record("2026-11-19T00:00:04.400Z", 10, "response_item", {
      type: "tool_search_call",
      call_id: "call-search",
      status: "completed",
      arguments: { query: "TOOL_SEARCH_SENTINEL" },
    }),
    record("2026-11-19T00:00:04.500Z", 11, "response_item", {
      type: "tool_search_output",
      call_id: "call-search",
      status: "completed",
      tools: [{ name: "TOOL_SCHEMA_SENTINEL" }],
    }),
    record("2026-11-19T00:00:05.000Z", 12, "token_usage_record", {
      thread_id: "root-thread",
      session_id: "root-thread",
      turn_id: "turn-1",
      response_id: "resp-2",
      usage: usage(200, 100, 20, 4),
      turn_token_usage: usage(200, 100, 20, 4),
      thread_token_usage: usage(300, 140, 30, 7),
    }),
    tokenCount(
      "2026-11-19T00:00:05.100Z",
      13,
      usage(300, 140, 30, 7),
      usage(200, 100, 20, 4),
    ),
    record("2026-11-19T00:00:06.000Z", 14, "compacted", {
      window_number: 1,
      previous_window_id: "window-0",
      window_id: "window-1",
      replacement_history: [{ type: "message" }, { type: "message" }],
      retained_context: { user_messages: 1, assistant_messages: 2 },
      latest_token_usage_record: {
        usage: usage(150, 80, 5, 2),
        thread_token_usage: usage(300, 140, 30, 7),
      },
    }),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeChild(filePath) {
  const lines = [
    record("2026-11-19T00:00:07.000Z", 0, "session_meta", meta({
      id: "child-thread",
      sessionId: "root-thread",
      parent: "root-thread",
      nickname: "Child",
      agentPath: "/root/child",
      subagent: true,
    })),
    record("2026-11-19T00:00:07.100Z", 1, "turn_context", {
      turn_id: "child-turn",
      root_turn_id: "turn-1",
      model: "gpt-test-child",
      effort: "medium",
    }),
    record("2026-11-19T00:00:07.200Z", 2, "response_item", {
      type: "function_call",
      status: "completed",
      id: "fc-child",
      call_id: "call-child",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "rg --files" }),
    }),
    record("2026-11-19T00:00:08.000Z", 3, "token_usage_record", {
      thread_id: "child-thread",
      session_id: "root-thread",
      turn_id: "child-turn",
      response_id: "resp-child",
      usage: usage(50, 0, 5, 1),
      thread_token_usage: usage(50, 0, 5, 1),
    }),
    tokenCount(
      "2026-11-19T00:00:08.100Z",
      4,
      usage(50, 0, 5, 1),
      usage(50, 0, 5, 1),
    ),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

test("rollout collection deduplicates cumulative usage and correlates explicit parent IDs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-rollout-"));
  try {
    const masterFile = path.join(root, "rollout-master.jsonl");
    const childFile = path.join(root, "rollout-child.jsonl");
    writeMaster(masterFile);
    writeChild(childFile);
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
    });
    assert.equal(validateProfilerSnapshot(snapshot).valid, true);
    assert.equal(snapshot.agents.length, 2);
    const master = snapshot.agents.find((agent) => agent.thread_id === "root-thread");
    const child = snapshot.agents.find((agent) => agent.thread_id === "child-thread");
    assert.equal(master.kind, "MASTER");
    assert.equal(master.usage.total_tokens, 330);
    assert.equal(master.usage.response_count, 2);
    assert.equal(master.usage.accounting_mode, "CUMULATIVE");
    assert.equal(child.kind, "SUBAGENT");
    assert.equal(child.parent_agent_id, master.agent_id);
    assert.equal(child.goal_id, master.goal_id);
    assert.equal(child.usage.total_tokens, 55);
    assert.equal(snapshot.responses.length, 3);
    assert.equal(snapshot.compactions.length, 1);
    assert.equal(snapshot.compactions[0].before_usage.input_tokens, 200);
    assert.equal(snapshot.compactions[0].after_usage.input_tokens, 150);
    assert.equal(snapshot.compactions[0].input_change_tokens, -50);
    assert.equal(JSON.stringify(snapshot).includes("SECRET_COMMAND_PATH"), false);
    assert.equal(JSON.stringify(snapshot).includes("SENTINEL_OUTPUT"), false);
    assert.equal(JSON.stringify(snapshot).includes("CRITICAL_SENTINEL_PATCH"), false);
    assert.equal(JSON.stringify(snapshot).includes("CUSTOM_SENTINEL_OUTPUT"), false);
    assert.equal(JSON.stringify(snapshot).includes("USER_SENTINEL_CONTEXT"), false);
    assert.equal(JSON.stringify(snapshot).includes("REASONING_SENTINEL"), false);
    assert.equal(JSON.stringify(snapshot).includes("TOOL_SEARCH_SENTINEL"), false);
    assert.equal(JSON.stringify(snapshot).includes("TOOL_SCHEMA_SENTINEL"), false);
    const applyPatch = snapshot.tools.find((tool) => tool.name === "apply_patch");
    assert.equal(applyPatch.command_class, "IMPLEMENTATION");
    assert.equal(applyPatch.status, "SUCCESS");
    assert.equal(snapshot.context_items.some((item) => item.category === "user_message"), true);
    assert.equal(snapshot.context_items.some((item) => item.category === "mcp_tool_schema"), true);

    const state = snapshot.next_incremental_state;
    appendFileSync(masterFile, [
      record("2026-11-19T00:00:09.000Z", 15, "turn_context", {
        turn_id: "turn-2",
        root_turn_id: "turn-2",
        model: "gpt-test",
        effort: "high",
      }),
      record("2026-11-19T00:00:09.100Z", 16, "response_item", {
        type: "function_call",
        status: "completed",
        id: "fc-3",
        call_id: "call-3",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "npm test" }),
      }),
      record("2026-11-19T00:00:10.000Z", 17, "token_usage_record", {
        thread_id: "root-thread",
        session_id: "root-thread",
        turn_id: "turn-2",
        response_id: "resp-3",
        usage: usage(30, 10, 5, 1),
        thread_token_usage: usage(330, 150, 35, 8),
      }),
      "",
    ].join("\n"), "utf8");
    const incremental = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
      previousSnapshot: snapshot,
      incrementalState: state,
    });
    const incrementalMaster = incremental.agents.find(
      (agent) => agent.thread_id === "root-thread",
    );
    assert.equal(incremental.collection_mode, "INCREMENTAL");
    assert.equal(incremental.responses.length, 4);
    assert.equal(incrementalMaster.usage.total_tokens, 365);
    assert.equal(incrementalMaster.usage.response_count, 3);
    const pendingTool = incremental.tools.find((tool) => tool.call_id === "call-3");
    assert.equal(pendingTool.status, "UNKNOWN");
    assert.equal(pendingTool.ended_at, null);

    appendFileSync(masterFile, [
      record("2026-11-19T00:00:11.000Z", 18, "response_item", {
        type: "function_call_output",
        call_id: "call-3",
        status: "completed",
        output: "incremental output",
      }),
      "",
    ].join("\n"), "utf8");
    const completed = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
      previousSnapshot: incremental,
      incrementalState: incremental.next_incremental_state,
    });
    const completedTool = completed.tools.find((tool) => tool.call_id === "call-3");
    assert.equal(completedTool.status, "SUCCESS");
    assert.equal(completedTool.ended_at, "2026-11-19T00:00:11.000Z");
    assert.equal(completedTool.response_id, "resp-3");
    assert.equal(completedTool.output_bytes, "incremental output".length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token_count provides a bounded response fallback when response-level records are absent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-token-fallback-"));
  try {
    const file = path.join(root, "rollout-token-count-only.jsonl");
    const first = usage(100, 40, 10, 3);
    const second = usage(120, 60, 20, 4);
    const total = usage(220, 100, 30, 7);
    writeFileSync(file, [
      record("2026-11-19T01:00:00.000Z", 0, "session_meta", meta({
        id: "token-count-thread",
        sessionId: "token-count-thread",
      })),
      record("2026-11-19T01:00:00.100Z", 1, "turn_context", {
        turn_id: "turn-token-count",
        root_turn_id: "turn-token-count",
        model: "gpt-test",
        effort: "high",
      }),
      tokenCount("2026-11-19T01:00:01.000Z", 2, first, first),
      tokenCount("2026-11-19T01:00:02.000Z", 3, total, second),
    ].join("\n") + "\n", "utf8");
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
    });
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.agents[0].usage.total_tokens, 250);
    assert.equal(snapshot.agents[0].usage.response_count, 2);
    assert.equal(snapshot.agents[0].usage.accounting_mode, "CUMULATIVE");
    assert.equal(snapshot.agents[0].usage.reconciliation.status, "RECONCILED");
    assert.equal(snapshot.responses.length, 2);
    assert.ok(snapshot.responses.every((response) => (
      response.usage_source === "TOKEN_COUNT_LAST_USAGE_FALLBACK"
    )));
    assert.ok(snapshot.warnings.some((warning) => (
      warning.code === "rollout_token_count_usage_fallback"
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compressed rollouts are decoded read-only and preserve collection time separately", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-zstd-"));
  try {
    const plainFile = path.join(root, "rollout-master.jsonl");
    const compressedFile = `${plainFile}.zst`;
    writeMaster(plainFile);
    writeFileSync(compressedFile, zstdCompressSync(readFileSync(plainFile)));
    rmSync(plainFile);
    const generatedAt = "2026-11-20T12:00:00.000Z";
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
      generatedAt,
    });
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.agents[0].usage.total_tokens, 330);
    assert.equal(snapshot.responses.length, 2);
    assert.equal(snapshot.compactions.length, 1);
    assert.equal(snapshot.captured_at, generatedAt);
    assert.equal(snapshot.generated_at, generatedAt);
    assert.equal(snapshot.event_horizon_at, "2026-11-19T00:00:06.000Z");
    assert.equal(
      snapshot.next_incremental_state[snapshot.sources[0].source_id].offset,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compressed rollouts fall back to UNKNOWN when zstd is unavailable", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-zstd-unavailable-"));
  try {
    const plainFile = path.join(root, "rollout-master.jsonl");
    const compressedFile = `${plainFile}.zst`;
    writeMaster(plainFile);
    writeFileSync(compressedFile, zstdCompressSync(readFileSync(plainFile)));
    rmSync(plainFile);
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
      zstdCodec: null,
    });
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.agents[0].usage.total_tokens, null);
    assert.equal(snapshot.agents[0].usage.evidence_level, "UNKNOWN");
    assert.ok(snapshot.warnings.some((warning) => (
      warning.code === "rollout_zstd_unavailable"
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid complete lines and a partial tail are reported without fabricating usage", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-truncated-"));
  try {
    const file = path.join(root, "rollout-truncated.jsonl");
    writeFileSync(file, [
      record("2026-11-19T00:00:00.000Z", 0, "session_meta", meta({
        id: "truncated-thread",
        sessionId: "truncated-thread",
      })),
      "{invalid-json",
      "{\"timestamp\":\"2026-11-19T00:00:01.000Z\",\"ordinal\":2,",
    ].join("\n"), "utf8");
    const snapshot = await collectProfilerSnapshot({
      env: {},
      codexHome: root,
      sessionRoots: [root],
      includeArchived: false,
      includeDefaultBridge: false,
    });
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.agents[0].usage.total_tokens, null);
    assert.equal(snapshot.agents[0].usage.evidence_level, "UNKNOWN");
    assert.ok(snapshot.warnings.some((warning) => warning.code === "rollout_invalid_json_lines"));
    assert.ok(snapshot.warnings.some((warning) => warning.code === "rollout_partial_tail_deferred"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
