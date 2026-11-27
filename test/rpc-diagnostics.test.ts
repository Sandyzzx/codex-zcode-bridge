import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRpcDiagnostic,
  extractRpcDiagnostic,
  redactDiagnosticText,
  withoutRpcStack,
  MAX_RPC_DIAGNOSTICS_BYTES,
  MAX_RPC_MESSAGE_CHARS,
} from "../src/adapters/rpc-diagnostics.js";
import { canonicalTaskResult } from "../src/result-contract.mjs";
import { summarizeTaskResult } from "../src/result-summary.js";
import type { RpcDiagnostic, TaskResult } from "../src/interfaces.js";

function diagnostic(overrides: Partial<RpcDiagnostic> = {}): RpcDiagnostic {
  return {
    method: "session/setModel",
    code: -32603,
    message: "Provider Registry 中不存在 Model: account:bigmodel-individual-coding-plan/GLM-5.4",
    data_name: "ModelProtocolError",
    data_code: "model_not_found",
    ...overrides,
  };
}

function taskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    task_id: "rpc_task",
    attempt: 1,
    status: "failed",
    summary: "failed before the first turn",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "",
    exit_code: null,
    session_id: "sess-rpc",
    started_at: null,
    finished_at: null,
    error_code: "provider_config_invalid",
    rpc_diagnostics: [diagnostic()],
    ...overrides,
  };
}

test("a structured official rejection keeps method, code, message, data and a path-free stack", () => {
  const extracted = extractRpcDiagnostic("session/setModel", {
    code: -32603,
    message: "Provider Registry 中不存在 Model: account:example/GLM-5.4",
    data: {
      name: "ModelProtocolError",
      code: "model_not_found",
      stack: [
        "Error: Provider Registry 中不存在 Model",
        "    at ModelRegistry.resolve (C:\\Users\\secret\\zcode.js:12:3)",
        "    at async Session.setModel (/home/secret/app/session.js:40:9)",
        "    at node:internal/process/task_queues:95:5",
      ].join("\n"),
    },
  });
  assert.deepEqual(extracted, {
    method: "session/setModel",
    code: -32603,
    message: "Provider Registry 中不存在 Model: account:example/GLM-5.4",
    data_name: "ModelProtocolError",
    data_code: "model_not_found",
    stack: [
      "at ModelRegistry.resolve (zcode.js:12:3)",
      "at async Session.setModel (session.js:40:9)",
      "at node:internal/process/task_queues:95:5",
    ].join("\n"),
  });
  assert.ok(!JSON.stringify(extracted).includes("secret"));
});

test("only an official RPC method with diagnosable content is extracted", () => {
  assert.equal(extractRpcDiagnostic("constructor", { code: -32603 }), null);
  assert.equal(extractRpcDiagnostic("session/", { code: -32603 }), null);
  assert.equal(extractRpcDiagnostic("session/setModel", null), null);
  assert.equal(extractRpcDiagnostic("session/setModel", {}), null);
  assert.equal(extractRpcDiagnostic("session/setModel", {
    data: { name: "has space", code: "bad code", stack: "no frames" },
  }), null);
  assert.equal(extractRpcDiagnostic("session/setModel", { code: 1.5 }), null);
});

test("credentials never survive message or stack inspection", () => {
  const text = [
    "Bearer abc.def-ghi",
    "Authorization: Bearer sk-live-abcdefghijk",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureABC",
    "api_key=supersecretvalue",
    "token: abcdefgh",
    "0123456789abcdef0123456789abcdef0123456789abcdef",
  ].join(" ");
  const redacted = redactDiagnosticText(text);
  for (const secret of ["abc.def-ghi", "sk-live-abcdefghijk", "eyJhbGciOiJIUzI1NiJ9", "supersecretvalue", "abcdefgh", "0123456789abcdef"]) {
    assert.ok(!redacted.includes(secret), `${secret} must be redacted: ${redacted}`);
  }
  assert.match(redacted, /\[REDACTED/u);

  const extracted = extractRpcDiagnostic("session/send", {
    code: -32000,
    message: "upstream said Bearer sk-live-abcdefghijk",
    data: { stack: "at f (https://user:pass@example.test/app.js:1:2)" },
  });
  assert.ok(!JSON.stringify(extracted).includes("sk-live-abcdefghijk"));
  assert.ok(!JSON.stringify(extracted).includes("user:pass"));
});

test("messages are one line, bounded, and marked when truncated", () => {
  const long = `first line\nsecond line ${"错".repeat(600)}`;
  const extracted = extractRpcDiagnostic("session/resume", { code: -32603, message: long });
  assert.ok(extracted);
  assert.ok(!extracted.message.includes("\n"));
  assert.ok(extracted.message.length <= MAX_RPC_MESSAGE_CHARS);
  assert.match(extracted.message, /…\[truncated\]$/u);
});

test("diagnostics are deduplicated by method, code and data code and capped at four", () => {
  let list: readonly RpcDiagnostic[] = [];
  list = appendRpcDiagnostic(list, diagnostic());
  list = appendRpcDiagnostic(list, diagnostic({ message: "same rejection, new text" }));
  assert.equal(list.length, 1);
  for (const code of ["a", "b", "c", "d"]) {
    list = appendRpcDiagnostic(list, diagnostic({ data_code: code }));
  }
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((entry) => entry.data_code), ["model_not_found", "a", "b", "c"]);
});

test("the total diagnostic budget drops stacks before it drops evidence", () => {
  let list: readonly RpcDiagnostic[] = [];
  const stack = Array.from({ length: 12 }, (_, index) => `at ${"f".repeat(80)} (app.js:${index + 1}:1)`).join("\n");
  for (const dataCode of ["a", "b", "c", "d"]) {
    const entry = extractRpcDiagnostic("session/setModel", {
      code: -32603,
      message: '"'.repeat(500),
      data: { name: "ModelProtocolError", code: dataCode, stack },
    });
    assert.ok(entry);
    list = appendRpcDiagnostic(list, entry);
  }
  assert.equal(list.length, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(list), "utf8") <= MAX_RPC_DIAGNOSTICS_BYTES);
  assert.equal(list.some((entry) => entry.stack === undefined), true);
});

test("the summary projection never returns a stack and keeps only a short message", () => {
  const longMessage = "错".repeat(400);
  const result = taskResult({
    zcode_output: "x".repeat(3_000),
    rpc_diagnostics: [diagnostic({ message: longMessage, stack: "at f (app.js:1:1)" })],
  });
  const summary = summarizeTaskResult(result) as unknown as Record<string, unknown>;
  const diagnostics = summary["rpc_diagnostics"] as RpcDiagnostic[];
  assert.equal(diagnostics[0]?.stack, undefined);
  assert.equal(diagnostics[0]?.message.length, 240);
  assert.ok((summary["projection"] as { omitted_fields: string[] }).omitted_fields.includes("rpc_diagnostics.stack"));
  assert.ok(!JSON.stringify(summary).includes("at f (app.js:1:1)"));
  assert.deepEqual(withoutRpcStack(diagnostic({ stack: "at f (app.js:1:1)" })), diagnostic());
});

test("the Result contract accepts bounded diagnostics only on a failed Result", () => {
  const context = { task_id: "rpc_task", attempt: 1, result_status: "failed" as const };
  const json = canonicalTaskResult(taskResult(), context);
  assert.deepEqual((JSON.parse(json) as TaskResult).rpc_diagnostics, [diagnostic()]);

  assert.throws(
    () => canonicalTaskResult(taskResult({ status: "completed" }), { ...context, result_status: "completed" }),
    /invalid_result_payload/u,
  );
  assert.throws(
    () => canonicalTaskResult(taskResult({ rpc_diagnostics: [] }) as TaskResult, context),
    /invalid_result_payload/u,
  );
  assert.throws(
    () => canonicalTaskResult(taskResult({ rpc_diagnostics: [diagnostic({ message: "a\nb" })] }), context),
    /invalid_result_payload/u,
  );
  assert.throws(
    () => canonicalTaskResult(taskResult({ rpc_diagnostics: [diagnostic({ message: "x".repeat(501) })] }), context),
    /invalid_result_payload/u,
  );
  assert.throws(
    () => canonicalTaskResult(taskResult({ rpc_diagnostics: [diagnostic({ data_code: "bad code" })] }), context),
    /invalid_result_payload/u,
  );
  assert.throws(
    () => canonicalTaskResult(taskResult({
      rpc_diagnostics: [diagnostic({ stack: "at f (C:\\secret\\app.js:1:1)" })],
    }), context),
    /invalid_result_payload/u,
  );
  assert.throws(
    () => canonicalTaskResult(taskResult({
      rpc_diagnostics: Array.from({ length: 5 }, (_, index) => diagnostic({ data_code: `c${index}` })),
    }), context),
    /invalid_result_payload/u,
  );
});
