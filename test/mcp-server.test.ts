// Protocol-level MCP server tests using the official SDK Client and
// InMemoryTransport with an injected fake TaskManager. No real ZCode workers,
// no model calls, no filesystem access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { summarizeTaskResult } from "../src/result-summary.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  createBridgeServer,
  SERVER_NAME,
  SERVER_VERSION,
} from "../src/mcp/server.js";
import { TaskManagerError } from "../src/task-errors.js";
import type {
  ContinueTaskInput,
  ProgressTaskManager,
  TaskAttentionSnapshot,
  TaskManager,
  TaskPackage,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  TaskFeedbackSnapshotV01,
  TaskProgressPage,
  ZCodeInteractionReplyInput,
} from "../src/interfaces.js";
import { SESSION_ID, makeTask } from "./helpers.js";

const CREATED_AT = "2026-09-27T00:00:00.000Z";
const PUBLIC_SCHEMA_SNAPSHOT = path.join(import.meta.dirname, "..", "..", "test", "fixtures", "mcp-public-schema.json");

class FakeTaskManager implements TaskManager {
  readonly calls: Array<{ method: string; args: unknown }> = [];
  receipt: TaskReceipt = { task_id: "task_1", status: "running", created_at: CREATED_AT };
  statusRecord: TaskStatusRecord = {
    task_id: "task_1",
    status: "running",
    attempt: 1,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    started_at: CREATED_AT,
    finished_at: null,
    worker_pid: 4242,
    zcode_session_id: null,
    exit_code: null,
  };
  result: TaskResult = {
    task_id: "task_1",
    status: "completed",
    summary: "Created the requested file",
    files_changed: ["bridge-smoke.txt"],
    tests: [{ command: "pytest -q", status: "passed" }],
    issues: [],
    needs_master_decision: false,
    zcode_output: "{\"summary\": \"...\"}",
    exit_code: 0,
    session_id: SESSION_ID,
    attempt: 1,
    started_at: CREATED_AT,
    finished_at: CREATED_AT,
  };
  feedback: TaskFeedbackSnapshotV01 = {
    schema_version: "0.1",
    task_id: "task_1",
    attempt: 1,
    status: "running",
    model: null,
    phase: null,
    progress: null,
    activity: null,
    interaction: { state: "not_observed", kind: null },
    result: null,
  };
  attention: TaskAttentionSnapshot = {
    task_id: "task_1",
    attempt: 1,
    status: "running",
    pending_requests: ["permission-1"],
  };
  error: TaskManagerError | null = null;
  events: TaskProgressPage = {
    task_id: "task_1",
    status: "running",
    events: [],
    next_seq: 0,
    has_more: false,
  };

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    this.calls.push({ method: "createTask", args: task });
    if (this.error) throw this.error;
    return { ...this.receipt, task_id: task.task_id };
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    this.calls.push({ method: "getStatus", args: taskId });
    if (this.error) throw this.error;
    return { ...this.statusRecord, task_id: taskId };
  }

  async getResult(taskId: string, view?: "summary" | "full"): Promise<TaskResult> {
    this.calls.push({ method: "getResult", args: view === undefined ? taskId : `${taskId}:${view}` });
    if (this.error) throw this.error;
    const full = { ...this.result, task_id: taskId };
    // Mirror the Executor-side projection so summary assertions hold.
    return view === "summary" ? summarizeTaskResult(full) as unknown as TaskResult : full;
  }

  async getResultPage(taskId: string, offsetBytes: number, maxBytes: number): Promise<Record<string, unknown>> {
    this.calls.push({ method: "getResultPage", args: `${taskId}:${offsetBytes}:${maxBytes}` });
    if (this.error) throw this.error;
    return {
      task_id: taskId,
      attempt: 1,
      status: "completed",
      summary: "paged result",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false,
      exit_code: 0,
      session_id: null,
      started_at: null,
      finished_at: null,
      result_status: "completed",
      result_digest: "a".repeat(64),
      result_commit_ref: "result-" + "a".repeat(64),
      page: {
        offset_bytes: offsetBytes,
        next_offset: null,
        total_bytes: 12,
        data: "{\"task_id\":1}",
      },
    };
  }

  async getFeedback(taskId: string): Promise<TaskFeedbackSnapshotV01> {
    this.calls.push({ method: "getFeedback", args: taskId });
    if (this.error) throw this.error;
    return { ...this.feedback, task_id: taskId };
  }

  async getAttention(taskId: string): Promise<TaskAttentionSnapshot> {
    this.calls.push({ method: "getAttention", args: taskId });
    if (this.error) throw this.error;
    return { ...this.attention, task_id: taskId };
  }

  async getEvents(input: Parameters<NonNullable<ProgressTaskManager["getEvents"]>>[0]): Promise<TaskProgressPage> {
    this.calls.push({ method: "getEvents", args: input });
    if (this.error) throw this.error;
    return { ...this.events, task_id: input.task_id };
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    this.calls.push({ method: "continueTask", args: input });
    if (this.error) throw this.error;
    return { ...this.receipt, task_id: input.task_id, status: "queued" };
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    this.calls.push({ method: "cancelTask", args: taskId });
    if (this.error) throw this.error;
    return { ...this.statusRecord, task_id: taskId, status: "cancelled", finished_at: CREATED_AT };
  }

  async replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }> {
    this.calls.push({ method: "replyToInteraction", args: input });
    if (this.error) throw this.error;
    return { task_id: input.task_id, request_id: input.request_id, state: "answered" };
  }
}

async function withServer(
  run: (client: Client, manager: FakeTaskManager) => Promise<void>,
  doctor?: () => Promise<{ checked_at: string; execution_mode: string; checks: Array<{ name: string; status: "ok" | "warning" | "error" | "unknown"; summary: string }> }>,
  supportedProtocolVersions?: string[],
  modelSettings?: Parameters<typeof createBridgeServer>[0]["modelSettings"],
): Promise<void> {
  const manager = new FakeTaskManager();
  const server = createBridgeServer({ taskManager: manager, doctor, modelSettings });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "protocol-test-client", version: "0.0.1" }, { supportedProtocolVersions });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client, manager);
  } finally {
    await client.close();
    await server.close();
  }
}

function fullTaskArguments(): Record<string, unknown> {
  return {
    task_id: "task_1",
    workspace: "C:\\work\\demo",
    objective: "Create bridge-smoke.txt",
    requirements: [],
    allowed_paths: ["bridge-smoke.txt"],
    forbidden_paths: [],
    acceptance_criteria: ["Content matches"],
    test_commands: [],
  };
}

test("the frozen tools and additive progress, feedback, interaction, and doctor tools are registered", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["zcode_cancel", "zcode_clear_default_model", "zcode_continue", "zcode_default_model", "zcode_doctor", "zcode_events", "zcode_feedback", "zcode_interaction_reply", "zcode_model_catalog", "zcode_result", "zcode_set_default_model", "zcode_status", "zcode_task"],
    );
    const task = tools.find((tool) => tool.name === "zcode_task")!;
    assert.match(task.description!, /calling host/);
    assert.match(task.description!, /NOT/);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
    }
  });
});

test("the public MCP tool schemas match the frozen compatibility snapshot", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const publicSchema = tools
      .map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const expected = JSON.parse(readFileSync(PUBLIC_SCHEMA_SNAPSHOT, "utf8")) as unknown;
    assert.deepEqual(publicSchema, expected);
  });
});

test("zcode_doctor returns read-only setup diagnostics", async () => {
  const report = {
    checked_at: CREATED_AT,
    execution_mode: "build",
    checks: [
      { name: "execution_mode", status: "ok" as const, summary: "build" },
      { name: "permission_roundtrip", status: "unknown" as const, summary: "Not verified against a real ZCode runtime" },
    ],
  };
  await withServer(async (client) => {
    const result = (await client.callTool({ name: "zcode_doctor", arguments: {} })) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, report);
  }, async () => report);
});

test("the four model tools delegate to the injected settings service", async () => {
  const calls: string[] = [];
  await withServer(async (client) => {
    for (const [name, args] of [
      ["zcode_model_catalog", { workspace: "C:\\work\\demo" }],
      ["zcode_default_model", {}],
      ["zcode_set_default_model", { provider_id: "provider-a", model_id: "model-a" }],
      ["zcode_clear_default_model", {}],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
    }
  }, undefined, undefined, {
    async listModels(workspace: string) {
      calls.push(`list:${workspace}`);
      return { workspace, current_model: null, models: [], account_provider_sync: "not_needed" };
    },
    async getDefaultModel() {
      calls.push("get");
      return { configured: false, model: null };
    },
    async setDefaultModel(selection: { provider_id: string; model_id: string; reasoning_level?: string }) {
      calls.push(`set:${selection.provider_id}:${selection.model_id}`);
      return { configured: true as const, model: selection };
    },
    async clearDefaultModel() {
      calls.push("clear");
      return { configured: false as const, model: null };
    },
  });
  assert.deepEqual(calls, [
    "list:C:\\work\\demo",
    "get",
    "set:provider-a:model-a",
    "clear",
  ]);
});

test("zcode_events maps the optional attention wait and returns the nested snapshot", async () => {
  await withServer(async (client, manager) => {
    manager.events = {
      ...manager.events,
      attention: manager.attention,
    };
    const result = (await client.callTool({
      name: "zcode_events",
      arguments: { task_id: "task_1", after_seq: 7, wait_ms: 250, wait_for: "attention" },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { attention?: TaskAttentionSnapshot };
    assert.deepEqual(structured.attention, manager.attention);
    assert.equal(manager.calls[0]?.method, "getEvents");
    assert.deepEqual(manager.calls[0]?.args, {
      task_id: "task_1",
      after_seq: 7,
      wait_ms: 250,
      wait_for: "attention",
    });
  });
});

test("zcode_events attention mode propagates uncertain reply state, never an empty success", async () => {
  await withServer(async (client, manager) => {
    manager.error = new TaskManagerError(
      "interaction_reply_outcome_unknown",
      "interaction_reply_outcome_unknown",
    );
    const result = (await client.callTool({
      name: "zcode_events",
      arguments: { task_id: "task_1", wait_for: "attention" },
    })) as CallToolResult;
    assert.equal(result.isError, true);
    const structured = result.structuredContent as { error: { code: string; message: string } };
    assert.equal(structured.error.code, "interaction_reply_outcome_unknown");
    assert.match(structured.error.message, /interaction_reply_outcome_unknown/u);
  });
});

test("zcode_events rejects an unknown wait_for value before the manager runs", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_events",
      arguments: { task_id: "task_1", wait_for: "terminal" },
    })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.equal(manager.calls.length, 0);
  });
});

test("zcode_interaction_reply forwards a bounded explicit decision", async () => {
  await withServer(async (client, manager) => {
    const args = { task_id: "task_1", request_id: "permission-1", decision: "deny", reason: "Not authorized" };
    const result = (await client.callTool({ name: "zcode_interaction_reply", arguments: args })) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { task_id: "task_1", request_id: "permission-1", state: "answered" });
    assert.equal(manager.calls[0]!.method, "replyToInteraction");
    assert.deepEqual(manager.calls[0]!.args, args);

    const invalid = (await client.callTool({
      name: "zcode_interaction_reply",
      arguments: { ...args, extra: true },
    })) as CallToolResult;
    assert.equal(invalid.isError, true, "unknown fields must be rejected before the manager runs");
    assert.equal(manager.calls.length, 1);
  });
});

test("zcode_task maps the full TaskPackage and returns a receipt as structured content", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_task",
      arguments: fullTaskArguments(),
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      task_id: "task_1",
      status: "running",
      created_at: CREATED_AT,
    });
    const call = manager.calls[0]!;
    assert.equal(call.method, "createTask");
    const task = call.args as TaskPackage;
    assert.equal(task.task_id, "task_1");
    assert.equal(task.workspace, "C:\\work\\demo");
    assert.deepEqual(task.requirements, []);
    assert.deepEqual(task.allowed_paths, ["bridge-smoke.txt"]);
    assert.deepEqual(task.forbidden_paths, []);
    assert.deepEqual(task.acceptance_criteria, ["Content matches"]);
    assert.deepEqual(task.test_commands, []);
    assert.equal(task.context, undefined);
    assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /task_1/);
  });
});

test("zcode_task accepts empty arrays and an optional context", async () => {
  await withServer(async (client, manager) => {
    await client.callTool({
      name: "zcode_task",
      arguments: { ...fullTaskArguments(), context: "Extra context" },
    });
    const task = manager.calls[0]!.args as TaskPackage;
    assert.equal(task.context, "Extra context");
  });
});

test("zcode_task accepts and forwards an optional provider/model selection", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_task",
      arguments: { ...fullTaskArguments(), model: { provider_id: "provider-1", model_id: "model-x", reasoning_level: "high" } },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    const task = manager.calls[0]!.args as TaskPackage;
    assert.deepEqual(task.model, { provider_id: "provider-1", model_id: "model-x", reasoning_level: "high" });
  });
});

test("zcode_task rejects malformed model selections before the manager runs", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_task",
      arguments: { ...fullTaskArguments(), model: { provider_id: "provider-1", model_id: "model-x", extra: true } },
    })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.equal(manager.calls.length, 0);
  });
});

test("zcode_task rejects unknown fields, missing arrays, and invalid task ids before the manager runs", async () => {
  await withServer(async (client, manager) => {
    const badCases: Array<Record<string, unknown>> = [
      { ...fullTaskArguments(), extra_field: true },
      { ...fullTaskArguments(), requirements: undefined },
      { ...fullTaskArguments(), taskId: "task_1" }, // camelCase must not pass
      { ...fullTaskArguments(), task_id: "bad id!" },
      { ...fullTaskArguments(), objective: "" },
    ];
    for (const arguments_ of badCases) {
      const result = (await client.callTool({
        name: "zcode_task",
        arguments: arguments_,
      })) as CallToolResult;
      assert.equal(
        result.isError,
        true,
        `expected a tool error for ${JSON.stringify(arguments_)}`,
      );
      const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
      assert.ok(text.length > 0, "the rejection must carry a human-readable reason");
    }
    assert.equal(
      manager.calls.length,
      0,
      "invalid input must never reach the TaskManager",
    );
  });
});

test("zcode_status returns the TaskStatusRecord and maps the argument", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_status",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    const record = result.structuredContent as unknown as TaskStatusRecord;
    assert.equal(record.status, "running");
    assert.equal(record.attempt, 1);
    assert.equal(record.worker_pid, 4242);
    assert.equal(manager.calls[0]!.method, "getStatus");
    assert.equal(manager.calls[0]!.args, "task_1");
  });
});

test("zcode_status accepts the additive execution observation", async () => {
  await withServer(async (client, manager) => {
    manager.statusRecord = {
      ...manager.statusRecord,
      execution_observation: {
        state: "cleanup_held",
        observed_at: CREATED_AT,
        evidence_ref: "sha256:test-evidence",
      },
    };

    const result = (await client.callTool({
      name: "zcode_status",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;

    assert.equal(result.isError, undefined);
    const record = result.structuredContent as unknown as TaskStatusRecord;
    assert.deepEqual(record.execution_observation, manager.statusRecord.execution_observation);
  });
});

test("zcode_feedback returns the additive v0.1 snapshot", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_feedback",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, manager.feedback);
    const rendered = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    const projection = JSON.parse(rendered) as {
      task_id: string;
      attempt: number;
      status: string;
      result: unknown;
    };
    assert.equal(projection.task_id, "task_1");
    assert.equal(projection.attempt, 1);
    assert.equal(projection.status, "running");
    assert.equal(projection.result, null);
    assert.equal(manager.calls[0]!.method, "getFeedback");
    assert.equal(manager.calls[0]!.args, "task_1");
  });
});

test("zcode_result returns TASK_NOT_FINISHED as a tool error with a stable code", async () => {
  await withServer(async (client, manager) => {
    manager.error = new TaskManagerError("TASK_NOT_FINISHED", "task task_1 is not finished (status: running)");
    const result = (await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;
    assert.equal(result.isError, true, "a semantic tool error must never look like success");
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.match(text, /TASK_NOT_FINISHED/);
    const structured = result.structuredContent as { error: { code: string; message: string } };
    assert.equal(structured.error.code, "TASK_NOT_FINISHED");
    assert.match(structured.error.message, /not finished/);
    assert.deepEqual(await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1", view: "summary", expected_attempt: 1 },
    }), result);
  });
});

for (const version of ["2025-11-25", "2025-06-18"]) {
  test(`zcode_result preserves full evidence and adds an object-root summary (${version})`, async () => {
    await withServer(async (client, manager) => {
      assert.equal(client.getNegotiatedProtocolVersion(), version);
      const tools = await client.listTools();
      assert.equal(tools.tools.filter((tool) => tool.outputSchema !== undefined).length, 12);
      const schema = tools.tools.find((tool) => tool.name === "zcode_result")!.outputSchema;
      assert.equal(schema?.type, "object");
      assert.deepEqual(schema?.oneOf, [{ required: ["zcode_output"] }, { required: ["projection"] }, { required: ["page"] }]);
      const read = (args: Record<string, unknown> = {}) => client.callTool({
        name: "zcode_result", arguments: { task_id: "task_1", ...args },
      }) as Promise<CallToolResult>;
      assert.deepEqual(await read({ view: "summary" }), await read());

      manager.result = {
        ...manager.result,
        attempt: 2,
        status: "failed",
        error_code: "execution_side_effect_unverified",
        needs_master_decision: true,
        report_candidate: { summary: "unverified claims" },
        zcode_output: "output\n".repeat(2_000),
        files_changed: ["intact.txt", "x".repeat(300)],
        tests: [
          ...Array.from({ length: 12 }, () => ({ command: "check", status: "passed" as const, details: "log" })),
          { command: "failed check", status: "failed" },
          { command: "skipped check", status: "not_run" },
        ],
      };
      const compact = await read({ view: "summary" });
      assert.equal(compact.isError, undefined);
      const content = compact.structuredContent as Record<string, unknown>;
      assert.equal(content.attempt, 2);
      assert.equal(content.status, "failed");
      assert.equal(content.error_code, "execution_side_effect_unverified");
      assert.equal(content.needs_master_decision, true);
      assert.deepEqual(content.files_changed, ["intact.txt"]);
      assert.ok(!("zcode_output" in content));
      assert.deepEqual(content.projection, {
        omitted_fields: ["zcode_output", "files_changed", "tests", "report_candidate"],
        test_counts: { passed: 12, failed: 1, not_run: 1 },
      });
      assert.deepEqual(JSON.parse((compact.content[0] as { text: string }).text), content);

      const full = await read({ view: "full", expected_attempt: 2 });
      assert.deepEqual(full.structuredContent, manager.result);
      assert.deepEqual(full, await read());
      manager.result.attempt++;
      const mismatch = await read({ view: "full", expected_attempt: 2 });
      assert.equal(mismatch.isError, true);
      assert.match((mismatch.content[0] as { text: string }).text, /^TASK_STATE: Expected Result Attempt 2, found 3/);
      const callCount = manager.calls.length;
      for (const args of [{ view: "other" }, { expected_attempt: 0 }, { unknown: true }]) {
        assert.equal((await read(args)).isError, true);
      }
      assert.equal(manager.calls.length, callCount);
    }, undefined, [version]);
  });
}

test("zcode_result for waiting_for_master surfaces the subordinate decision verbatim", async () => {
  await withServer(async (client, manager) => {
    manager.result = {
      ...manager.result,
      status: "waiting_for_master",
      needs_master_decision: true,
      issues: ["unsure about scope"],
    };
    const result = (await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as unknown as TaskResult;
    assert.equal(structured.status, "waiting_for_master");
    assert.equal(structured.needs_master_decision, true);
    assert.deepEqual(structured.issues, ["unsure about scope"]);
  });
});

test("zcode_continue passes snake_case fields through unchanged", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_continue",
      arguments: {
        task_id: "task_1",
        feedback: "Fix the failing test",
        additional_requirements: ["Keep the API stable"],
      },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    const input = manager.calls[0]!.args as ContinueTaskInput;
    assert.equal(input.task_id, "task_1");
    assert.equal(input.feedback, "Fix the failing test");
    assert.deepEqual(input.additional_requirements, ["Keep the API stable"]);
    const structured = result.structuredContent as unknown as TaskReceipt;
    assert.equal(structured.status, "queued");

    // Invalid continuation input is rejected before the manager runs.
    for (const bad of [
      { task_id: "task_1", feedback: "" },
      { task_id: "task_1", feedback: "x", additionalRequirements: [] },
      { task_id: "task_1", feedback: "x", unknown_field: 1 },
    ]) {
      const badResult = (await client.callTool({
        name: "zcode_continue",
        arguments: bad,
      })) as CallToolResult;
      assert.equal(badResult.isError, true, `expected a tool error for ${JSON.stringify(bad)}`);
    }
    assert.equal(manager.calls.length, 1, "invalid input must never reach the TaskManager");
  });
});

test("zcode_cancel returns the updated status record", async () => {
  await withServer(async (client, manager) => {
    const result = (await client.callTool({
      name: "zcode_cancel",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as unknown as TaskStatusRecord;
    assert.equal(structured.status, "cancelled");
    assert.equal(manager.calls[0]!.method, "cancelTask");
    assert.equal(manager.calls[0]!.args, "task_1");
  });
});

test("TASK_ALREADY_EXISTS and TASK_NOT_FOUND become tool errors with their stable codes", async () => {
  await withServer(async (client, manager) => {
    manager.error = new TaskManagerError("TASK_ALREADY_EXISTS", "task_id already used: task_1");
    const create = (await client.callTool({
      name: "zcode_task",
      arguments: fullTaskArguments(),
    })) as CallToolResult;
    assert.equal(create.isError, true);
    const createStructured = create.structuredContent as { error: { code: string } };
    assert.equal(createStructured.error.code, "TASK_ALREADY_EXISTS");

    manager.error = new TaskManagerError("TASK_NOT_FOUND", "unknown task_id: ghost");
    const status = (await client.callTool({
      name: "zcode_status",
      arguments: { task_id: "ghost" },
    })) as CallToolResult;
    assert.equal(status.isError, true);
    const statusStructured = status.structuredContent as { error: { code: string } };
    assert.equal(statusStructured.error.code, "TASK_NOT_FOUND");
  });
});

test("calling an unregistered tool is rejected by the MCP protocol", async () => {
  await withServer(async (client) => {
    await assert.rejects(
      client.callTool({ name: "unrelated_tool", arguments: {} }),
      /Tool unrelated_tool not found/i,
    );
  });
});

test("large zcode_result payloads retain both the compatible text and structured representation", async () => {
  await withServer(async (client, manager) => {
    const output = `official-output:${"x".repeat(64 * 1024)}`;
    manager.result = { ...manager.result, zcode_output: output };
    const result = (await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as unknown as TaskResult;
    assert.equal(structured.zcode_output.length, output.length);
    assert.equal(result.content.length, 1);
    const content = result.content[0];
    assert.equal(content?.type, "text");
    const textResult = JSON.parse((content as { type: "text"; text: string }).text) as TaskResult;
    assert.equal(textResult.zcode_output, output);
  });
});

test("server info matches the frozen project identity", async () => {
  await withServer(async (client) => {
    const serverInfo = client.getServerVersion();
    assert.equal(serverInfo?.name, SERVER_NAME);
    assert.equal(serverInfo?.version, SERVER_VERSION);
    const packageJson = JSON.parse(
      (await import("node:fs")).readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(SERVER_VERSION, packageJson.version);
  });
});

test("task package fixture matches the frozen shape", () => {
  const task = makeTask();
  for (const field of [
    "requirements",
    "allowed_paths",
    "forbidden_paths",
    "acceptance_criteria",
    "test_commands",
  ] as const) {
    assert.ok(Array.isArray(task[field]));
  }
});

test("zcode_result paging parameters reach the manager and reject partial combinations (ADR-056)", async () => {
  await withServer(async (client, manager) => {
    const paged = (await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1", offset_bytes: 0, max_bytes: 1024 },
    })) as CallToolResult;
    assert.notEqual(paged.isError, true);
    const structured = paged.structuredContent as { page?: { next_offset: unknown; data: string } };
    assert.ok(structured.page, "the paged read returns the page object");
    assert.deepEqual(manager.calls.filter((call) => call.method === "getResultPage").map((call) => call.args), ["task_1:0:1024"]);
    const partial = await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1", offset_bytes: 0 },
    }) as CallToolResult;
    assert.equal(partial.isError, true);
    const summaryCombo = await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1", view: "summary", offset_bytes: 0, max_bytes: 1024 },
    }) as CallToolResult;
    assert.equal(summaryCombo.isError, true);
    // View now reaches the manager instead of being projected client-side.
    await client.callTool({ name: "zcode_result", arguments: { task_id: "task_1", view: "summary" } });
    assert.ok(manager.calls.some((call) => call.method === "getResult" && call.args === "task_1:summary"));
  });
});

test("an oversized okResult keeps structuredContent authoritative and bounds the text channel (P1 §3.4C)", async () => {
  await withServer(async (client, manager) => {
    manager.result = {
      ...manager.result,
      zcode_output: "y".repeat(1_200_000),
    } as typeof manager.result;
    const result = (await client.callTool({
      name: "zcode_result",
      arguments: { task_id: "task_1" },
    })) as CallToolResult;
    assert.notEqual(result.isError, true);
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.ok(Buffer.byteLength(text, "utf8") < 2_000, "the duplicated text channel must stay bounded for large payloads");
    const notice = JSON.parse(text) as { notice: string; text_sha256: string };
    assert.equal(notice.notice, "response_too_large_for_text_channel");
    assert.match(notice.text_sha256, /^[0-9a-f]{64}$/u);
    const structured = result.structuredContent as { zcode_output?: string };
    assert.equal(structured.zcode_output?.length, 1_200_000, "structuredContent still carries the full payload");
  });
});
