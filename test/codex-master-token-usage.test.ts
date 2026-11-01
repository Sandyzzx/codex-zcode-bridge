import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CodexMasterTokenUsageSource } from "../src/observability/codex-master-token-usage.js";
import { codexMasterTokenFeedback } from "../src/feedback/codex-master-token.js";
import { renderFeedback, type FeedbackInput } from "../src/feedback/template.js";

let sandbox: string;
let codexHome: string;

test.beforeEach(() => {
  sandbox = mkdtempSync(path.join(process.cwd(), ".evidence", "master-token-source-test-"));
  codexHome = path.join(sandbox, "codex-home");
  mkdirSync(path.join(codexHome, "sessions", "2026", "10", "31"), { recursive: true });
});

test.afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function metadata(id: string, parentThreadId: string | null = null): unknown {
  return {
    timestamp: "2026-10-31T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      parent_thread_id: parentThreadId,
      thread_source: "user",
      originator: "Codex Desktop",
    },
  };
}

function tokenCount(total: number, last: number): unknown {
  return {
    timestamp: "2026-10-31T00:01:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total - 10,
          cached_input_tokens: 5,
          cache_write_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 2,
        },
        last_token_usage: {
          total_tokens: last,
          input_tokens: last - 2,
          cached_input_tokens: 1,
          output_tokens: 2,
          reasoning_output_tokens: 1,
        },
        model_context_window: 258_400,
      },
    },
  };
}

function rollout(id: string, records: unknown[], parentThreadId: string | null = null): string {
  const file = path.join(codexHome, "sessions", "2026", "10", "31", `rollout-${id}.jsonl`);
  writeFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return file;
}

function append(file: string, record: unknown): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function renderedWith(result: ReturnType<typeof codexMasterTokenFeedback>): string {
  const input: FeedbackInput = {
    objective: "token source smoke",
    task_id: "task_1",
    attempt: 1,
    bridge_status: "completed",
    delivered: [],
    codex_tokens: result,
    blockers: [],
    decisions: [],
    next_steps: [],
  };
  return renderFeedback(input);
}

test("Master token source is explicitly UNBOUND without guessing an active Thread", async () => {
  const source = new CodexMasterTokenUsageSource({ codexHome, env: {} });
  const result = await source.query();
  assert.equal(result.status, "thread_id_missing");
  assert.equal(result.threadId, null);
  assert.equal(result.total, null);
  assert.equal(codexMasterTokenFeedback(result).note, "未取得");
  assert.match(renderedWith(codexMasterTokenFeedback(result)), /\| Codex 主会话 token \| 未取得 \|/);
});

test("the same explicit Thread uses incremental reads and a new TokenCount updates the existing field", async () => {
  const id = "thread-main";
  const file = rollout(id, [metadata(id), tokenCount(1_000, 100)]);
  const source = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: id } });

  const first = await source.query();
  assert.equal(first.status, "ok");
  assert.equal(first.readMode, "initial");
  assert.equal(first.total?.totalTokens, 1_000);
  assert.equal(first.last?.totalTokens, 100);

  const repeated = await source.query();
  assert.equal(repeated.readMode, "incremental");
  assert.equal(repeated.total?.totalTokens, 1_000);

  append(file, tokenCount(1_250, 125));
  const updated = await source.query({ baselineTotalTokens: 1_000 });
  assert.equal(updated.status, "ok");
  assert.equal(updated.readMode, "incremental");
  assert.equal(updated.total?.totalTokens, 1_250);
  assert.equal(updated.last?.totalTokens, 125);
  assert.equal(updated.reportWindowTotalTokens, 250);
  const mapped = codexMasterTokenFeedback(updated);
  assert.equal(mapped.state, "reported");
  assert.equal(mapped.note, "250");
  assert.doesNotMatch(mapped.note, /最近采样|输入|缓存|输出|推理|上下文|来源|观测/);
  assert.match(renderedWith(mapped), /\| Codex 主会话 token \| 250 \|/);
});

test("missing Rollout, wrong identity, child Agent and no TokenCount remain distinct", async () => {
  const missing = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: "thread-missing" } });
  const missingResult = await missing.query();
  assert.equal(missingResult.status, "rollout_not_found");
  assert.equal(codexMasterTokenFeedback(missingResult).note, "未取得");

  const wrongId = "thread-expected";
  rollout(wrongId, [metadata("thread-other"), tokenCount(10, 10)]);
  const wrong = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: wrongId } });
  const wrongResult = await wrong.query();
  assert.equal(wrongResult.status, "thread_identity_unverified");
  assert.equal(codexMasterTokenFeedback(wrongResult).note, "未取得");

  const childId = "thread-child";
  rollout(childId, [metadata(childId, "thread-parent"), tokenCount(20, 20)], "thread-parent");
  const child = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: childId } });
  const childResult = await child.query();
  assert.equal(childResult.status, "thread_identity_unverified");
  assert.equal(codexMasterTokenFeedback(childResult).note, "未取得");

  const emptyId = "thread-empty";
  rollout(emptyId, [metadata(emptyId)]);
  const empty = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: emptyId } });
  const noTokens = await empty.query();
  assert.equal(noTokens.status, "no_token_count");
  assert.equal(noTokens.total, null);
  assert.equal(codexMasterTokenFeedback(noTokens).note, "未取得");
});

test("temporary Rollout removal reports FILE_CHANGED and a fresh source recovers the absolute snapshot", async () => {
  const id = "thread-recover";
  const file = rollout(id, [metadata(id), tokenCount(500, 50)]);
  const source = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: id } });
  assert.equal((await source.query()).status, "ok");

  const moved = `${file}.away`;
  renameSync(file, moved);
  const missing = await source.query();
  assert.equal(missing.status, "file_changed");
  assert.equal(codexMasterTokenFeedback(missing).note, "未取得");

  renameSync(moved, file);
  append(file, tokenCount(700, 70));
  const recovered = await source.query();
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.readMode, "initial");
  assert.equal(recovered.total?.totalTokens, 700);

  const restarted = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: id } });
  const afterRestart = await restarted.query();
  assert.equal(afterRestart.status, "ok");
  assert.equal(afterRestart.readMode, "initial");
  assert.equal(afterRestart.total?.totalTokens, 700);
});

test("missing report-window baseline never substitutes latest context or Thread total", async () => {
  const id = "thread-no-baseline";
  rollout(id, [metadata(id), tokenCount(9_000, 400)]);
  const source = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: id } });
  const result = await source.query();
  const mapped = codexMasterTokenFeedback(result);
  assert.equal(mapped.state, "unavailable");
  assert.equal(mapped.note, "未取得");
  assert.match(renderedWith(mapped), /\| Codex 主会话 token \| 未取得 \|/);
});

test("a valid report-window boundary renders only its verified delta, including zero", async () => {
  const id = "thread-zero-delta";
  rollout(id, [metadata(id), tokenCount(2_000, 200)]);
  const source = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: id } });
  const result = await source.query({ baselineTotalTokens: 2_000 });
  const mapped = codexMasterTokenFeedback(result);
  assert.equal(result.status, "ok");
  assert.equal(result.reportWindowTotalTokens, 0);
  assert.equal(mapped.state, "reported");
  assert.equal(mapped.note, "0");
  assert.match(renderedWith(mapped), /\| Codex 主会话 token \| 0 \|/);
});

test("feedback without codex token data falls back to the compact unavailable text", () => {
  const input: FeedbackInput = {
    objective: "token source smoke",
    task_id: "task_1",
    attempt: 1,
    bridge_status: "completed",
    delivered: [],
    blockers: [],
    decisions: [],
    next_steps: [],
  };
  assert.match(renderFeedback(input), /\| Codex 主会话 token \| 未取得 \|/);
});

test("a baseline newer than the endpoint is treated as an invalid report-window boundary", async () => {
  const id = "thread-invalid-boundary";
  rollout(id, [metadata(id), tokenCount(1_000, 100)]);
  const source = new CodexMasterTokenUsageSource({ codexHome, env: { CODEX_THREAD_ID: id } });
  const result = await source.query({ baselineTotalTokens: 1_001 });
  assert.equal(result.status, "ok");
  assert.equal(result.reportWindowTotalTokens, null);
  assert.equal(result.reportWindowBasis, null);
  assert.deepEqual(codexMasterTokenFeedback(result), {
    state: "unavailable",
    note: "未取得",
  });
});
