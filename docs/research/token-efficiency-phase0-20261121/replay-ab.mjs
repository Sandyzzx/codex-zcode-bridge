import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

if (process.argv.length !== 3) {
  console.error("Usage: node replay-ab.mjs <phase0-audit-dist-directory>");
  process.exit(2);
}

const a0Dist = resolve(process.argv[2]);
const candidateDist = fileURLToPath(new URL("../../../dist/", import.meta.url));
const tokenizerDir = join(dirname(a0Dist), ".run", "phase0-20261121-a0", "tokenizer");
const requireTokenizer = createRequire(join(tokenizerDir, "package.json"));
const tokenizerVersion = JSON.parse(
  readFileSync(join(tokenizerDir, "node_modules", "js-tiktoken", "package.json"), "utf8"),
).version;
assert.equal(tokenizerVersion, "1.0.21", "Use the frozen A0 tokenizer");
const encoding = requireTokenizer("js-tiktoken").getEncoding("o200k_base");

const json = JSON.stringify;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const samePayload = (actual, expected, label) => assert.equal(sha256(json(actual)), sha256(json(expected)), label);
const measureText = (text) => ({ utf8_bytes: Buffer.byteLength(text), proxy_tokens: encoding.encode(text).length });
const measure = (value) => measureText(json(value));
const at = "2026-11-21T00:00:00.000Z";
const inlineBytes = 2_048;
const log = Array.from({ length: 1200 }, (_, i) => `ok ${i + 1} - verifies fixture case ${i + 1}\n`).join("");
const failureLine = "not ok 1201 - rejects malformed fixture input\n";
const artifactPath = "fixtures/requirements.txt";
const artifact = Array.from({ length: 60 }, (_, i) => `Case ${i + 1}: preserve field_${i + 1} during export.`).join("\n");

// After startup at cursor 18, both monitoring plans observe the same terminal state.
const samples = [
  { id: "single_file" },
  { id: "multi_file", files: 6, inlineLimit: true },
  { id: "large_code_task", files: 40, output: log, attached: true },
  { id: "long_running", idlePolls: 16, idleWaits: 3, terminalAtSeconds: 81, pollSeconds: 5 },
  { id: "large_test_log", output: log + failureLine, failed: true, fullEvidence: true },
  { id: "worker_failure_recovery", attempt: 2, interrupted: true },
  { id: "master_requeries", idlePolls: 16, idleWaits: 0, terminalAtSeconds: 17, pollSeconds: 1 },
  { id: "related_tasks", attached: true, relatedTo: "large_code_task" },
  { id: "cache_hit_control" },
  { id: "cache_miss_control" },
].map((sample) => {
  const task_id = `phase0-${sample.id}`;
  const files = Array.from({ length: sample.files ?? 1 }, (_, i) => `fixtures/case-${i + 1}.txt`);
  const task = {
    task_id, workspace: "D:\\fixture",
    objective: "Update the specified fixture files.",
    requirements: ["Keep all changes inside the declared workspace."],
    allowed_paths: files,
    forbidden_paths: [],
    acceptance_criteria: ["Fixture files match the declared cases."],
    test_commands: ["node --test"],
    ...(sample.attached ? { context: `Read ${artifactPath} from the execution workspace as the source of truth.` } : {}),
  };
  if (sample.relatedTo) task.context += ` Follow up phase0-${sample.relatedTo} using the same requirements file.`;
  const duplicate = sample.attached ? { ...task, context: `${task.context}\nCopy of ${artifactPath}:\n${artifact}` } : task;
  const attempt = sample.attempt ?? 1;
  const running = {
    task_id, status: "running", attempt, created_at: at, updated_at: at,
    started_at: at, finished_at: null, worker_pid: 4242, zcode_session_id: null, exit_code: null,
  };
  const terminal = sample.interrupted ? {
    ...running,
    worker_pid: null,
    execution_observation: { state: "interrupted_without_result", observed_at: at, evidence_ref: "fixture-hold" },
  } : { ...running, status: sample.failed ? "failed" : "completed", finished_at: at, worker_pid: null, exit_code: sample.failed ? 1 : 0 };
  const result = sample.interrupted ? null : {
    task_id, status: terminal.status, attempt, started_at: at, finished_at: at,
    exit_code: terminal.exit_code, session_id: null,
    summary: sample.failed ? "Fixture suite failed." : "Wrote the requested fixtures.",
    files_changed: files,
    tests: sample.failed ? [
      { command: "node --test smoke", status: "passed" },
      { command: "node --test fixture", status: "failed", details: sample.output },
      { command: "node --test integration", status: "not_run" },
    ] : [{ command: "node --test", status: "passed" }],
    issues: sample.failed ? ["Inspect the failed fixture assertion before continuing."] : [],
    needs_master_decision: Boolean(sample.failed),
    zcode_output: sample.output ?? "Wrote fixtures. All fixture checks passed.",
    ...(sample.failed ? { error_code: "FIXTURE_CHECK_FAILED" } : {}),
  };
  if (sample.inlineLimit) {
    result.zcode_output += "x".repeat(inlineBytes - Buffer.byteLength(json(result)));
    assert.equal(Buffer.byteLength(json(result)), inlineBytes);
  }
  return { ...sample, task, duplicate, running, terminal, result, attempt };
});

function checkSummary(sample, full, summary) {
  if (sample.result === null || Buffer.byteLength(json(sample.result)) <= inlineBytes) {
    samePayload(summary, full, `${sample.id}: inline Result or error changed`);
    return;
  }
  const { zcode_output, ...legacy } = full.structuredContent;
  assert.equal(zcode_output, sample.result.zcode_output);
  const { projection, ...fields } = summary.structuredContent;
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(legacy).sort(), `${sample.id}: Result fields`);
  const { omitted_fields, test_counts } = projection;
  assert.ok(omitted_fields.includes("zcode_output"));
  assert.equal(new Set(omitted_fields).size, omitted_fields.length);
  assert.ok(omitted_fields.every((key) => ["zcode_output", "tests", "files_changed"].includes(key)));
  for (const [key, value] of Object.entries(legacy)) {
    if (!omitted_fields.includes(key)) assert.deepEqual(fields[key], value, `${sample.id}: ${key} changed`);
  }
  assert.deepEqual(fields.files_changed, legacy.files_changed.slice(0, fields.files_changed.length));
  assert.deepEqual(fields.tests.map(({ command, status }) => ({ command, status })),
    legacy.tests.slice(0, fields.tests.length).map(({ command, status }) => ({ command, status })));
  const counts = { passed: 0, failed: 0, not_run: 0 };
  for (const { status } of legacy.tests) counts[status]++;
  assert.deepEqual(test_counts, counts, `${sample.id}: projected test counts`);
}

async function replay(dist, candidate) {
  const entry = join(dist, "src/mcp/server.js");
  const importBuild = (path) => import(pathToFileURL(join(dist, "src", path)).href);
  const { createBridgeServer } = await importBuild("mcp/server.js");
  const { TaskManagerError } = await importBuild("manager/errors.js");
  const { buildTaskPrompt } = await importBuild("prompts/task-prompt.js");
  let sample;
  let idle = false;
  function checkTask(taskId) {
    assert.equal(taskId, sample.task.task_id);
  }

  const manager = {
    async createTask(task) {
      checkTask(task.task_id);
      assert.deepEqual(task, task.context === sample.duplicate.context ? sample.duplicate : sample.task);
      return { task_id: task.task_id, status: "queued", created_at: at };
    },
    async getStatus(taskId) {
      checkTask(taskId);
      return idle ? sample.running : sample.terminal;
    },
    async getEvents({ task_id, after_seq, wait_for, wait_ms, include_attempt }) {
      checkTask(task_id);
      assert.equal(wait_for, "attention");
      assert.equal(wait_ms, 25_000);
      const { status, attempt } = idle ? sample.running : sample.terminal;
      const events = idle ? [] : [{
        seq: 19, at, type: "result_committed", summary: "Fixture Result committed.",
        ...(include_attempt ? { attempt } : {}),
      }];
      return {
        task_id, status, events, has_more: false, next_seq: idle ? after_seq : 19,
        attention: { task_id, status, attempt, pending_requests: [] },
      };
    },
    async getResult(taskId) {
      checkTask(taskId);
      if (!sample.result) throw new TaskManagerError("TASK_NOT_FINISHED", "No committed Result.");
      return sample.result;
    },
  };
  const server = createBridgeServer({ taskManager: manager });
  const client = new Client({ name: "phase0-ab-replay", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  let request;
  clientTransport.send = (message, ...options) => {
    if (message.method === "tools/call") request = message.params;
    return send(message, ...options);
  };
  async function call(purpose, name, args, errorCode) {
    request = undefined;
    const payload = await client.callTool({ name, arguments: args });
    assert.equal(request?.name, name);
    assert.equal(payload.content.length, 1);
    const [{ type, text }] = payload.content;
    assert.equal(type, "text");
    if (errorCode) {
      assert.equal(payload.isError, true);
      assert.equal(payload.structuredContent.error.code, errorCode);
      assert.equal(text, `${errorCode}: ${payload.structuredContent.error.message}`);
    } else {
      assert.ok(!payload.isError, `${purpose}: unexpected ${text}`);
      assert.deepEqual(JSON.parse(text), payload.structuredContent);
    }
    return {
      purpose, payload,
      sizes: { request_params: measure(request), text: measureText(text),
        structured_content: measure(payload.structuredContent), envelope: measure(payload) },
    };
  }
  function prompt(task) {
    const text = buildTaskPrompt(task);
    return { ...measureText(text), sha256: sha256(text) };
  }

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const catalog = await client.listTools();
    samePayload(await client.listTools(), catalog, "tools/list changed on repeat");
    const observations = {};
    for (sample of samples) {
      const args = { task_id: sample.task.task_id };
      const dispatch = await call("dispatch_inline", "zcode_task", sample.duplicate);
      const status = [];
      idle = true;
      for (let i = 0; i < (sample.idlePolls ?? 0); i++) status.push(await call("status", "zcode_status", args));
      for (const step of status) samePayload(step.payload, status[0].payload, "Idle status payload changed");
      idle = false;
      status.push(await call("status", "zcode_status", args));
      assert.equal(status.at(-1).payload.structuredContent.status, sample.terminal.status);
      const attention = [];
      const taggedAttention = [];
      let after_seq = 18;
      for (let i = 0; sample.idleWaits !== undefined && i <= sample.idleWaits; i++) {
        idle = i < sample.idleWaits;
        const waitArgs = { ...args, after_seq, view: "summary", wait_for: "attention", wait_ms: 25_000 };
        const step = await call("attention", "zcode_events", waitArgs);
        const page = step.payload.structuredContent;
        assert.equal(page.next_seq, idle ? after_seq : 19);
        assert.equal(page.attention.status, idle ? "running" : sample.terminal.status);
        assert.equal(page.attention.attempt, sample.attempt);
        if (candidate) {
          const tagged = await call("attention", "zcode_events", { ...waitArgs, include_attempt: true });
          assert.deepEqual(tagged.payload.structuredContent, {
            ...page, events: page.events.map((event) => ({ ...event, attempt: sample.attempt })),
          });
          taggedAttention.push(tagged);
        }
        after_seq = page.next_seq;
        attention.push(step);
      }
      const errorCode = sample.interrupted ? "TASK_NOT_FINISHED" : undefined;
      const full = await call("result_full", "zcode_result", args, errorCode);
      if (!errorCode) assert.deepEqual(full.payload.structuredContent, sample.result);
      const observed = { dispatch, status, attention, taggedAttention, full, prompt: prompt(sample.duplicate) };
      observations[sample.id] = observed;
      if (!candidate) continue;

      const expected = sample.id === "single_file" ? {} : { expected_attempt: sample.attempt };
      observed.summary = await call("result_summary", "zcode_result", { ...args, view: "summary", ...expected }, errorCode);
      checkSummary(sample, full.payload, observed.summary.payload);
      if (sample.fullEvidence) {
        const expected_attempt = observed.summary.payload.structuredContent.attempt;
        observed.fallback = await call("result_fallback", "zcode_result", { ...args, view: "full", expected_attempt });
        samePayload(observed.fallback.payload, full.payload, `${sample.id}: explicit full changed`);
      }
      if (sample.attached) {
        // Alternative dispatch arm against the stateless fixture Manager.
        observed.reference = await call("dispatch_reference", "zcode_task", sample.task);
        samePayload(observed.reference.payload, dispatch.payload, `${sample.id}: receipt changed`);
        observed.referencePrompt = prompt(sample.task);
      }
    }
    if (candidate) {
      await call("attempt_guard", "zcode_result", { task_id: sample.task.task_id, view: "full", expected_attempt: 2 }, "TASK_STATE");
    }
    return { catalog, observations, server_sha256: sha256(readFileSync(entry)) };
  } finally {
    await client.close();
    await server.close();
  }
}

const a0 = await replay(a0Dist, false);
const candidate = await replay(candidateDist, true);
assert.equal(a0.observations.long_running.status.length, 17);
assert.equal(sha256(json(a0.catalog)), "893e1f3fd82d0f108f97e80170fbd4d71b8b9597c822185f854ff67f920ef90d", "A0 tools/list differs from the frozen audit");
assert.equal(a0.catalog.tools.length, 13);
const names = ({ tools }) => tools.map(({ name }) => name);
assert.deepEqual(names(candidate.catalog), names(a0.catalog));
const schemas = ({ description, ...tool }) => tool;
const resultTool = (catalog) => catalog.tools.find(({ name }) => name === "zcode_result");
const a0ResultTool = resultTool(a0.catalog);
const candidateResultTool = resultTool(candidate.catalog);
const candidateResultSchemas = {
  inputSchema: candidateResultTool.inputSchema, outputSchema: candidateResultTool.outputSchema,
};
assert.deepEqual(schemas(candidateResultTool), { ...schemas(a0ResultTool), ...candidateResultSchemas });
for (const tool of [...a0.catalog.tools, ...candidate.catalog.tools]) {
  assert.equal(tool.inputSchema.type, "object", `${tool.name}: input schema root`);
  if (tool.outputSchema) assert.equal(tool.outputSchema.type, "object", `${tool.name}: output schema root`);
}
assert.deepEqual(candidateResultTool.outputSchema.oneOf, [{ required: ["zcode_output"] }, { required: ["projection"] }]);
const { view, expected_attempt, ...legacyInputs } = candidateResultTool.inputSchema.properties;
assert.deepEqual(legacyInputs, a0ResultTool.inputSchema.properties);
assert.deepEqual(candidateResultTool.inputSchema.required, a0ResultTool.inputSchema.required);
assert.deepEqual(view.enum, ["summary", "full"]);
assert.equal(expected_attempt.type, "integer");
const { projection, ...legacyOutputs } = candidateResultTool.outputSchema.properties;
assert.deepEqual(legacyOutputs, a0ResultTool.outputSchema.properties);
assert.deepEqual(candidateResultTool.outputSchema.required, a0ResultTool.outputSchema.required.filter((field) => field !== "zcode_output"));
assert.equal(projection.type, "object");
const a0EventsTool = a0.catalog.tools.find(({ name }) => name === "zcode_events");
const candidateEventsTool = candidate.catalog.tools.find(({ name }) => name === "zcode_events");
const legacyEventsSchema = structuredClone(schemas(candidateEventsTool));
assert.equal(legacyEventsSchema.inputSchema.properties.include_attempt.type, "boolean");
assert.equal(legacyEventsSchema.outputSchema.properties.events.items.properties.attempt.type, "integer");
delete legacyEventsSchema.inputSchema.properties.include_attempt;
delete legacyEventsSchema.outputSchema.properties.events.items.properties.attempt;
assert.deepEqual(legacyEventsSchema, schemas(a0EventsTool));
for (const statusToolName of ["zcode_status", "zcode_cancel"]) {
  const a0StatusTool = a0.catalog.tools.find(({ name }) => name === statusToolName);
  const candidateStatusTool = candidate.catalog.tools.find(({ name }) => name === statusToolName);
  const legacyStatusSchema = structuredClone(schemas(candidateStatusTool));
  assert.equal(legacyStatusSchema.outputSchema.properties.dispatch_blocker.type, "object");
  delete legacyStatusSchema.outputSchema.properties.dispatch_blocker;
  assert.deepEqual(legacyStatusSchema, schemas(a0StatusTool));
}
for (const [i, tool] of a0.catalog.tools.entries()) {
  if (!["zcode_result", "zcode_events", "zcode_status", "zcode_cancel"].includes(tool.name)) {
    assert.deepEqual(schemas(candidate.catalog.tools[i]), schemas(tool), tool.name);
  }
}
for (const { id } of samples) {
  for (const key of ["dispatch", "status", "attention", "full", "prompt"]) {
    samePayload(candidate.observations[id][key], a0.observations[id][key], `${id}: legacy ${key} changed`);
  }
}

const catalog = {
  A0: a0.catalog,
  event_attribution_only: { ...a0.catalog, tools: a0.catalog.tools.map((tool) =>
    tool.name === "zcode_events" ? { ...tool, ...schemas(candidateEventsTool) } : tool) },
  result_view_only: { ...a0.catalog, tools: a0.catalog.tools.map((tool) =>
    tool.name === "zcode_result" ? candidateResultTool : tool) },
  descriptions_only: { ...a0.catalog, tools: a0.catalog.tools.map((tool, i) =>
    tool.name === "zcode_result" ? tool : { ...tool, description: candidate.catalog.tools[i].description }) },
  candidate: candidate.catalog,
};
const channels = ["request_params", "text", "structured_content", "envelope"];
function tally(steps) {
  const totals = Object.fromEntries(channels.map((key) => [key, { utf8_bytes: 0, proxy_tokens: 0 }]));
  const calls_by_purpose = {};
  for (const { purpose, sizes } of steps) {
    calls_by_purpose[purpose] = (calls_by_purpose[purpose] ?? 0) + 1;
    for (const key of channels) {
      totals[key].utf8_bytes += sizes[key].utf8_bytes;
      totals[key].proxy_tokens += sizes[key].proxy_tokens;
    }
  }
  return { tool_calls: steps.length, calls_by_purpose, ...totals };
}

function variant({ catalogue = "A0", wait, summary, reference } = {}) {
  const plans = samples.map(({ id }) => {
    const a = a0.observations[id];
    const b = candidate.observations[id];
    const attention = wait === "A0" ? a.attention : b.taggedAttention;
    const monitoring = wait && attention.length ? attention : a.status;
    const dispatch = reference && b.reference ? b.reference : a.dispatch;
    const reads = summary ? [b.summary, b.fallback].filter(Boolean) : [a.full];
    return [id, [dispatch, ...monitoring, ...reads]];
  });
  const totals = tally(plans.flatMap(([, steps]) => steps));
  const tools_list = measure(catalog[catalogue]);
  return {
    sample_count: plans.length,
    tools_list: { source: catalogue, calls: 1, ...tools_list },
    aggregate: { ...totals, envelope_plus_catalogue: {
      utf8_bytes: totals.envelope.utf8_bytes + tools_list.utf8_bytes,
      proxy_tokens: totals.envelope.proxy_tokens + tools_list.proxy_tokens,
    } },
    samples: Object.fromEntries(plans.map(([id, steps]) => [id, tally(steps)])),
  };
}

const variants = {
  A0: variant(),
  A0_attention_control: variant({ wait: "A0" }),
  B1: variant({ wait: "candidate", catalogue: "event_attribution_only" }),
  B2: variant({ summary: true, catalogue: "result_view_only" }),
  B3: variant({ reference: true }),
  B4: variant(),
  B5: variant({ catalogue: "descriptions_only" }),
  "B-All": variant({ wait: "candidate", summary: true, reference: true, catalogue: "candidate" }),
};
assert.equal(variants.B1.aggregate.tool_calls, variants.A0_attention_control.aggregate.tool_calls);
assert.deepEqual(variants.B4, variants.A0);

const attached = samples.filter(({ attached }) => attached);
const fileRead = measureText(artifact);
const baseline = variants.A0.aggregate;
const cacheHitPrompt = a0.observations.cache_hit_control.prompt.sha256;
const cacheMissPrompt = a0.observations.cache_miss_control.prompt.sha256;
assert.notEqual(cacheHitPrompt, cacheMissPrompt);
console.log(JSON.stringify({
  run_id: "token-efficiency-20261121-offline-ab",
  evidence_kind: "deterministic_offline_mcp_replay",
  node: process.version,
  tokenizer: { package: `js-tiktoken@${tokenizerVersion}`, encoding: "o200k_base" },
  builds: Object.fromEntries(Object.entries({ A0: a0, candidate }).map(([name, build]) =>
    [name, { server_sha256: build.server_sha256, tools_list_sha256: sha256(json(build.catalog)) }])),
  request_counts: { model: 0, billing: 0, worker_spawn: 0 },
  usage: null, billing: null, cache: null, real_success: null,
  checks: { legacy_payloads_match: true, result_schema_root: "object", inline_limit_bytes: inlineBytes, attempt_guard: "TASK_STATE" },
  sample_counts: {
    total: samples.length,
    fixture_failed: samples.filter(({ failed }) => failed).length,
    fixture_result_absent: samples.filter(({ interrupted }) => interrupted).length,
    fixture_full_fallback: samples.filter(({ fullEvidence }) => fullEvidence).length,
    attached: attached.length,
  },
  wait_schedules: samples.filter(({ idlePolls }) => idlePolls).map(({ id, idlePolls, idleWaits, terminalAtSeconds, pollSeconds }) =>
    ({ id, running_status_calls: idlePolls, idle_attention_calls: idleWaits, terminal_calls_per_arm: 1, terminal_at_s: terminalAtSeconds, poll_interval_s: pollSeconds, attention_timeout_s: 25 })),
  deltas_vs_A0: Object.fromEntries(Object.entries(variants).map(([name, { aggregate }]) =>
    [name, { tool_calls: aggregate.tool_calls - baseline.tool_calls,
      proxy_tokens: Object.fromEntries([...channels, "envelope_plus_catalogue"].map((key) =>
        [key, aggregate[key].proxy_tokens - baseline[key].proxy_tokens])) }])),
  attachment_sensitivity: {
    artifact_path: artifactPath,
    assumed_extra_reads_in_B3_and_B_All: attached.length,
    raw_text_per_read: fileRead,
    raw_text_added_proxy_tokens: fileRead.proxy_tokens * attached.length,
    worker_prompt_by_sample: Object.fromEntries(attached.map(({ id }) => {
      const { prompt: duplicate, referencePrompt: reference } = candidate.observations[id];
      return [id, { duplicate, reference, reference_plus_raw_read: reference.proxy_tokens + fileRead.proxy_tokens }];
    })),
  },
  cache_control: {
    repeated_tools_lists_match: true,
    worker_prompt_sha256: cacheHitPrompt,
    worker_prompt_with_changed_task_id_sha256: cacheMissPrompt,
  },
  variants,
  limits: [
    "Each variant counts one tools/list for the whole run and one dispatch per sample. Attention starts at cursor 18. Startup reads, initialization and compatibility probes are excluded.",
    "Plans reuse SDK observations from a stateless Manager. No waiting, worker, production SQLite, host context assembly, cache measurement or inference occurs.",
    "Each component uses its own UTF-8/JSON encoding and independent tokenization. Envelope includes text and structured content. JSON-RPC framing is excluded.",
    "B1 uses the A0 Attention schedule with opt-in Event Attempt attribution. B2 charges the Result tool definition and each full evidence fallback. B5 substitutes only descriptions independent of the Result extension.",
    "Both attachment arms have the same synthetic workspace file. Sensitivity assumes one extra raw-text read per reference and zero extra reads for inline copies. Tool wrappers, repeated attachment and actual file reads are unmeasured.",
  ],
}, null, 2));
