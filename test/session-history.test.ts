import assert from "node:assert/strict";
import test from "node:test";
import {
  continuationSessionId,
  resolveSessionHistory,
  validateSessionHistoryEnvelope,
  type SessionHistory,
} from "../src/manager/session-history.js";
import type { CandidateTaskResult } from "../src/sqlite-candidate/wp6c/fake-result-adapter.js";

function result(overrides: Partial<CandidateTaskResult> = {}): CandidateTaskResult {
  return {
    task_id: "history_task",
    attempt: 1,
    status: "failed",
    summary: "",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "",
    exit_code: 1,
    session_id: "sess-a",
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function history(overrides: Partial<SessionHistory> = {}): SessionHistory {
  return {
    session_id: "sess-a",
    resumable: false,
    reason: "no_turn_history",
    evidence_attempt: null,
    scanned_attempts: 1,
    ...overrides,
  };
}

test("no previous Session ID means nothing can be resumed", () => {
  assert.equal(resolveSessionHistory({
    attempt: 2,
    previousResult: null,
    readResult: () => null,
  }), null);
  assert.equal(resolveSessionHistory({
    attempt: 2,
    previousResult: result({ session_id: null }),
    readResult: () => null,
  }), null);
});

test("a Session that only completed initialization is evidence, not a resume handle", () => {
  const verdict = resolveSessionHistory({
    attempt: 2,
    previousResult: result({ error_code: "provider_config_invalid", model: { turn_id: null }, usage: null }),
    readResult: (attempt) => (attempt === 1 ? result() : null),
  });
  assert.deepEqual(verdict, {
    session_id: "sess-a",
    resumable: false,
    reason: "no_turn_history",
    evidence_attempt: null,
    scanned_attempts: 1,
  });
});

test("a completed Result, a turn id, or measured usage proves turn history", () => {
  for (const evidence of [
    result({ status: "completed" }),
    result({ status: "waiting_for_master" }),
    result({ model: { turn_id: "turn-1" } }),
    result({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }),
  ]) {
    const verdict = resolveSessionHistory({
      attempt: 2,
      previousResult: evidence,
      readResult: (attempt) => (attempt === 1 ? evidence : null),
    });
    assert.equal(verdict?.resumable, true);
    assert.equal(verdict?.reason, "turn_history");
    assert.equal(verdict?.evidence_attempt, 1);
  }
});

test("turn history survives a later failed Result that carries no turn of its own", () => {
  const verdict = resolveSessionHistory({
    attempt: 3,
    previousResult: result({ attempt: 2 }),
    readResult: (attempt) => attempt === 2
      ? result({ attempt: 2, model: { turn_id: null }, usage: null })
      : result({ attempt: 1, status: "completed" }),
  });
  assert.equal(verdict?.resumable, true);
  assert.equal(verdict?.evidence_attempt, 1);
  assert.equal(verdict?.scanned_attempts, 2);
});

test("a known rejected resume keeps the Session ID as evidence and stops the chain", () => {
  const verdict = resolveSessionHistory({
    attempt: 3,
    previousResult: result({ attempt: 2, error_code: "session_not_resumable" }),
    readResult: (attempt) => attempt === 2
      ? result({ attempt: 2, error_code: "session_not_resumable" })
      : result({ attempt: 1, status: "completed" }),
  });
  assert.deepEqual(verdict, {
    session_id: "sess-a",
    resumable: false,
    reason: "session_not_resumable",
    evidence_attempt: 2,
    scanned_attempts: 1,
  });
});

test("an older Attempt from a different Session says nothing about the current one", () => {
  const verdict = resolveSessionHistory({
    attempt: 3,
    previousResult: result({ attempt: 2 }),
    readResult: (attempt) => attempt === 2
      ? result({ attempt: 2, session_id: "sess-other" })
      : result({ attempt: 1, status: "completed" }),
  });
  assert.equal(verdict?.resumable, false);
  assert.equal(verdict?.reason, "no_turn_history");
  assert.equal(verdict?.scanned_attempts, 1);
});

test("a Result without a Session ID is skipped, not treated as a different Session", () => {
  const verdict = resolveSessionHistory({
    attempt: 3,
    previousResult: result({ attempt: 2 }),
    readResult: (attempt) => attempt === 2
      ? result({ attempt: 2, session_id: null, status: "cancelled" })
      : result({ attempt: 1, status: "completed" }),
  });
  assert.equal(verdict?.resumable, true);
  assert.equal(verdict?.evidence_attempt, 1);
  assert.equal(verdict?.scanned_attempts, 2);
});

test("unreadable Results are skipped and the scan stays bounded", () => {
  const throwing = resolveSessionHistory({
    attempt: 2,
    previousResult: result({ status: "completed" }),
    readResult: () => { throw new Error("unreadable"); },
  });
  assert.equal(throwing?.resumable, false);
  assert.equal(throwing?.scanned_attempts, 1);

  const bounded = resolveSessionHistory({
    attempt: 100,
    previousResult: result({ attempt: 99 }),
    readResult: (attempt) => result({ attempt }),
  });
  assert.equal(bounded?.resumable, false);
  assert.equal(bounded?.scanned_attempts, 32);
});

test("a continuation resumes only a resumable verdict and keeps legacy Managers working", () => {
  assert.equal(continuationSessionId(undefined, "sess-legacy"), "sess-legacy");
  assert.equal(continuationSessionId(undefined, null), null);
  assert.equal(continuationSessionId(history({ resumable: false }), "sess-a"), null);
  assert.equal(continuationSessionId(history({ resumable: true, reason: "turn_history", evidence_attempt: 1 }), "sess-a"), "sess-a");
});

test("the Worker envelope accepts only a fully bound session history verdict", () => {
  const context = { attempt: 3, continuation: { feedback: "next" }, previousResultSessionId: "sess-a" };
  assert.deepEqual(validateSessionHistoryEnvelope(history({ scanned_attempts: 2 }), context), history({ scanned_attempts: 2 }));
  assert.deepEqual(
    validateSessionHistoryEnvelope(history({ reason: "session_not_resumable", evidence_attempt: 2 }), context),
    history({ reason: "session_not_resumable", evidence_attempt: 2 }),
  );
  assert.deepEqual(
    validateSessionHistoryEnvelope(
      history({ resumable: true, reason: "turn_history", evidence_attempt: 1 }),
      context,
    ),
    history({ resumable: true, reason: "turn_history", evidence_attempt: 1 }),
  );
});

test("an unbound or contradictory session history verdict is rejected", () => {
  const context = { attempt: 3, continuation: { feedback: "next" }, previousResultSessionId: "sess-a" };
  const rejected: unknown[] = [
    null,
    [],
    { ...history(), extra: true },
    history({ session_id: "sess-other" }),
    history({ scanned_attempts: 0 }),
    history({ scanned_attempts: 33 }),
    history({ resumable: true, reason: "no_turn_history", evidence_attempt: 1 }),
    history({ resumable: false, reason: "turn_history", evidence_attempt: 1 }),
    history({ reason: "turn_history", evidence_attempt: null }),
    history({ reason: "no_turn_history", evidence_attempt: 1 }),
    history({ reason: "session_not_resumable", evidence_attempt: 3 }),
    history({ reason: "session_not_resumable", evidence_attempt: 0 }),
    history({ reason: "session_not_resumable", evidence_attempt: -1 }),
  ];
  for (const value of rejected) {
    assert.throws(() => validateSessionHistoryEnvelope(value, context), /session history binding rejected/u);
  }
  assert.throws(
    () => validateSessionHistoryEnvelope(history(), { ...context, previousResultSessionId: null }),
    /session history binding rejected/u,
  );
  assert.throws(
    () => validateSessionHistoryEnvelope(history(), { ...context, continuation: null }),
    /session history binding rejected/u,
  );
});
