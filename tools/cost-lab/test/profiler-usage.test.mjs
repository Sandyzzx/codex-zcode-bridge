import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeContextAndCache,
  attributeUsagePhases,
  createAggregateUsage,
  emptyUsage,
  normalizeUsage,
  sumUsagesStrict,
  usageIsUnknown,
  validateProfilerSnapshot,
} from "../profiler/index.mjs";

test("cached input remains a subset and reasoning is not added twice", () => {
  const usage = normalizeUsage({
    input_tokens: 100,
    cached_input_tokens: 60,
    cache_write_input_tokens: 5,
    output_tokens: 20,
    reasoning_output_tokens: 7,
    total_tokens: 120,
  });
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.cached_input_tokens, 60);
  assert.equal(usage.uncached_input_tokens, 40);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.reasoning_tokens, 7);
  assert.equal(usage.total_tokens, 120);
  assert.equal(usage.cache_hit_rate, 0.6);
  assert.deepEqual(usage.conflicts, []);
});

test("response-level usage is not added to an observed cumulative total", () => {
  const first = normalizeUsage({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, total_tokens: 15 });
  const second = normalizeUsage({ input_tokens: 20, cached_input_tokens: 10, output_tokens: 5, total_tokens: 25 });
  const cumulative = normalizeUsage({ input_tokens: 30, cached_input_tokens: 14, output_tokens: 10, total_tokens: 40 });
  const aggregate = createAggregateUsage({
    responseUsages: [first, second],
    cumulativeUsages: [{
      event_ref: "cumulative:1",
      observed_at: "2026-11-19T00:00:02.000Z",
      usage: cumulative,
    }],
  });
  assert.equal(aggregate.accounting_mode, "CUMULATIVE");
  assert.equal(aggregate.total_tokens, 40);
  assert.equal(aggregate.response_level_usage.total_tokens, 40);
  assert.equal(aggregate.reconciliation.status, "RECONCILED");
  assert.equal(aggregate.response_count, 2);
});

test("cumulative mismatch remains visible instead of rewriting the reported total", () => {
  const response = normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  const cumulative = normalizeUsage({ input_tokens: 30, output_tokens: 15, total_tokens: 45 });
  const aggregate = createAggregateUsage({
    responseUsages: [response],
    cumulativeUsages: [{
      event_ref: "cumulative:2",
      observed_at: "2026-11-19T00:00:03.000Z",
      usage: cumulative,
    }],
  });
  assert.equal(aggregate.total_tokens, 45);
  assert.equal(aggregate.reconciliation.status, "MISMATCH");
  assert.equal(aggregate.reconciliation.fields.total_tokens.status, "MISMATCH");
});

test("an unknown cumulative checkpoint does not hide known response usage", () => {
  const response = normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  const aggregate = createAggregateUsage({
    responseUsages: [response],
    cumulativeUsages: [{
      event_ref: "cumulative:unknown",
      observed_at: "2026-11-19T00:00:04.000Z",
      usage: normalizeUsage(null),
    }],
  });
  assert.equal(aggregate.accounting_mode, "RESPONSE_LEVEL");
  assert.equal(aggregate.total_tokens, 15);
  assert.equal(aggregate.evidence_level, "OBSERVED");
});

test("unknown response usage prevents RECONCILED and is not counted twice", () => {
  const known = normalizeUsage({
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 5,
    total_tokens: 15,
  });
  const unknown = normalizeUsage(null);
  const cumulative = normalizeUsage({
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 5,
    total_tokens: 15,
  });
  const aggregate = createAggregateUsage({
    responseUsages: [known, unknown],
    cumulativeUsages: [{
      event_ref: "rollout:7",
      observed_at: "2026-11-19T00:00:02.000Z",
      usage: cumulative,
    }],
    unknownUsageResponseCount: 1,
  });
  assert.equal(aggregate.response_count, 2);
  assert.equal(aggregate.usage_response_count, 1);
  assert.equal(aggregate.unknown_usage_response_count, 1);
  assert.equal(aggregate.reconciliation.status, "PARTIAL");
});

test("same-time cumulative checkpoints use numeric source ordinals", () => {
  const first = normalizeUsage({ input_tokens: 80, output_tokens: 10, total_tokens: 90 });
  const second = normalizeUsage({ input_tokens: 90, output_tokens: 10, total_tokens: 100 });
  const aggregate = createAggregateUsage({
    cumulativeUsages: [
      {
        event_ref: "rollout:9",
        observed_at: "2026-11-19T00:00:02.000Z",
        usage: first,
      },
      {
        event_ref: "rollout:10",
        observed_at: "2026-11-19T00:00:02.000Z",
        usage: second,
      },
    ],
  });
  assert.equal(aggregate.total_tokens, 100);
});

test("partial cache fields remain UNKNOWN instead of becoming zero", () => {
  const snapshot = {
    agents: [{ agent_id: "agent-1", kind: "MASTER", usage: { total_tokens: null } }],
    responses: [
      {
        response_id: "response-1",
        agent_id: "agent-1",
        event_ref: "rollout:1",
        observed_at: "2026-11-19T00:00:01.000Z",
        usage: normalizeUsage({
          input_tokens: 100,
          cached_input_tokens: 30,
          output_tokens: 10,
          total_tokens: 110,
        }),
      },
      {
        response_id: "response-2",
        agent_id: "agent-1",
        event_ref: "rollout:2",
        observed_at: "2026-11-19T00:00:02.000Z",
        usage: normalizeUsage({
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
        }),
      },
    ],
    tools: [],
    context_items: [],
    compactions: [],
  };
  const context = analyzeContextAndCache(snapshot);
  assert.equal(context.cache.overall_cache_hit_rate, null);
  assert.equal(context.cache.overall_uncached_input_ratio, null);
  assert.equal(context.cache.evidence_level, "UNKNOWN");
  assert.equal(context.cache.by_agent[0].cache_hit_rate, null);

  const phases = attributeUsagePhases({
    ...snapshot,
    responses: [{
      ...snapshot.responses[0],
      usage: emptyUsage(),
    }],
  });
  assert.equal(phases.summary[0].scope_total_tokens, null);
  assert.equal(phases.summary[0].token_share, null);
});

test("missing fields stay UNKNOWN and are not converted to zero", () => {
  const partial = normalizeUsage({ input_tokens: 12, cached_input_tokens: 2 });
  assert.equal(partial.output_tokens, null);
  assert.equal(partial.total_tokens, null);
  assert.equal(partial.uncached_input_tokens, 10);
  assert.equal(partial.evidence_level, "OBSERVED");
  assert.ok(partial.missing_fields.includes("output_tokens"));

  const sum = sumUsagesStrict([partial]);
  assert.equal(sum.input_tokens, 12);
  assert.equal(sum.output_tokens, null);
  assert.equal(sum.total_tokens, null);

  const missing = normalizeUsage(null);
  assert.equal(usageIsUnknown(missing), true);
  assert.equal(missing.total_tokens, null);
});

test("robust schema rejects a malformed snapshot", () => {
  const result = validateProfilerSnapshot({
    schema_version: 1,
    kind: "profiler_snapshot",
    snapshot_id: "bad",
    read_only: true,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("agents")));
});
