import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { transformSync } from "esbuild";
import { createBridgeServer } from "../../../dist/src/mcp/server.js";
import { TaskManagerError } from "../../../dist/src/manager/errors.js";
import { buildContinuePrompt, buildTaskPrompt } from "../../../dist/src/prompts/task-prompt.js";

const runId = "phase0-20261121-a0";
const baseline = "1f9ff9ef37528205e76156e13fe06ed2b1fd3711";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratchRequire = createRequire(new URL(`../../../.run/${runId}/tokenizer/package.json`, import.meta.url));
const { getEncoding } = scratchRequire("js-tiktoken");
const encoding = getEncoding("o200k_base");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const measureText = (value) => ({ utf8_bytes: Buffer.byteLength(value), proxy_tokens: encoding.encode(value).length });
const measure = (value) => measureText(JSON.stringify(value));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

assert.equal(git("rev-parse", "HEAD"), baseline);
git("diff", "--quiet", "--no-ext-diff", "HEAD", "--", "src", "package-lock.json", "plugins/codex-zcode-bridge", "tools/cost-lab");
const at = "2026-11-21T00:00:00.000Z";
const task = {
  task_id: "phase0-fixture-a",
  workspace: "D:\\fixture",
  objective: "Create fixture.txt with the specified contents.",
  requirements: ["Keep all changes inside the declared workspace."],
  allowed_paths: ["fixture.txt"],
  forbidden_paths: [],
  acceptance_criteria: ["fixture.txt matches the specified contents byte for byte."],
  test_commands: ["node --test"],
};
const status = {
  task_id: task.task_id, status: "running", attempt: 1, created_at: at, updated_at: at,
  started_at: at, finished_at: null, worker_pid: 4242, zcode_session_id: null, exit_code: null,
};
const attention = { task_id: task.task_id, status: "running", attempt: 1, pending_requests: [] };
const result = {
  task_id: task.task_id, status: "completed", attempt: 1, started_at: at, finished_at: at,
  exit_code: 0, session_id: null, summary: "Wrote the requested fixture.", files_changed: ["fixture.txt"],
  tests: [{ command: "node --test", status: "passed" }], issues: [], needs_master_decision: false,
  zcode_output: "Wrote fixture.txt. All fixture checks passed.",
};
const log = Array.from({ length: 1200 }, (_, index) =>
  `ok ${index + 1} - verifies deterministic fixture case ${index + 1}\n`).join("");
const large = {
  ...result,
  files_changed: Array.from({ length: 40 }, (_, index) => `fixtures/case-${index + 1}.txt`),
  tests: [{ command: "node --test", status: "passed", details: log }],
  zcode_output: log,
};
let fixtureResult = result;

const manager = {
  async getStatus(taskId) {
    assert.equal(taskId, task.task_id);
    return status;
  },
  async getEvents({ task_id, after_seq, wait_for }) {
    assert.equal(task_id, task.task_id);
    return {
      task_id, status: "running", events: [], has_more: false, next_seq: after_seq,
      ...(wait_for === "attention" ? { attention } : {}),
    };
  },
  async getResult(taskId) {
    if (taskId === "phase0-fixture-running") throw new TaskManagerError("TASK_NOT_FINISHED", "No committed Result.");
    assert.equal(taskId, task.task_id);
    return fixtureResult;
  },
};

async function withMcp(read, factory = createBridgeServer) {
  const server = factory({ taskManager: manager });
  const client = new Client({ name: "phase0-replay", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await read(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function measureResult(payload) {
  assert.equal(payload.content[0].type, "text");
  if (!payload.isError) assert.deepEqual(JSON.parse(payload.content[0].text), payload.structuredContent);
  return {
    text: measureText(payload.content[0].text),
    structured_content: measure(payload.structuredContent),
    envelope: measure(payload),
  };
}

const snapshot = await withMcp(async (client) => {
  const toolsList = await client.listTools();
  assert.equal(toolsList.tools.length, 13);
  assert.deepEqual(await client.listTools(), toolsList);
  const call = (name, args = {}) => client.callTool({ name, arguments: { task_id: task.task_id, ...args } });
  const statusReads = [];
  for (let i = 0; i < 16; i++) statusReads.push(await call("zcode_status"));
  for (const read of statusReads) assert.deepEqual(read, statusReads[0]);
  const idle = await call("zcode_events", { after_seq: 18, view: "summary" });
  const idleAttention = await call("zcode_events", { after_seq: 18, wait_for: "attention", view: "summary" });
  const shortResult = await call("zcode_result");
  fixtureResult = large;
  const largeResult = await call("zcode_result");
  const error = await call("zcode_result", { task_id: "phase0-fixture-running" });
  assert.equal(error.isError, true);
  return {
    tools_list: {
      ...measure(toolsList),
      sha256: sha256(JSON.stringify(toolsList)),
      tools: toolsList.tools.map((tool) => ({
        name: tool.name,
        description: measureText(tool.description),
        input_schema: measure(tool.inputSchema),
        output_schema: tool.outputSchema === undefined ? null : measure(tool.outputSchema),
        entry: measure(tool),
      })),
    },
    responses: {
      status: measureResult(statusReads[0]),
      identical_status_calls: statusReads.length,
      repeated_status_envelope_proxy_sum: statusReads.reduce((sum, entry) => sum + measure(entry).proxy_tokens, 0),
      idle_cursor_events: measureResult(idle),
      idle_attention_events: measureResult(idleAttention),
      short_result: measureResult(shortResult),
      large_result: measureResult(largeResult),
      task_not_finished: measureResult(error),
    },
  };
});

const freshTools = await withMcp((client) => client.listTools());
assert.equal(sha256(JSON.stringify(freshTools)), snapshot.tools_list.sha256);
let schemaCandidate;
if (process.argv.includes("--compare-existing-schema-candidate")) {
  const commit = "8b58c381dd5da241965ccee7af7ecea0476a5e7c";
  const source = git("show", `${commit}:src/mcp/server.ts`);
  const entry = new URL("../../../dist/src/mcp/phase0-schema-candidate.mjs", import.meta.url);
  writeFileSync(entry, transformSync(source, { loader: "ts", format: "esm", target: "node24" }).code);
  const candidate = await import(entry);
  const { tools } = await withMcp((client) => client.listTools(), candidate.createBridgeServer);
  const inputs = (list) => list.map(({ name, inputSchema }) => ({ name, inputSchema }));
  assert.deepEqual(inputs(tools), inputs(freshTools.tools));
  schemaCandidate = {
    commit,
    same_tool_names_order_and_input_schemas: true,
    advertised_output_schemas: tools.filter(({ outputSchema }) => outputSchema !== undefined).length,
    baseline_advertised_output_schemas: freshTools.tools.filter(({ outputSchema }) => outputSchema !== undefined).length,
    descriptions_only_counterfactual: measure({
      ...freshTools,
      tools: freshTools.tools.map((tool, index) => ({ ...tool, description: tools[index].description })),
    }),
    actual_candidate_tools_list: measure({ tools }),
  };
}
const prompt = buildTaskPrompt(task);
const otherPrompt = buildTaskPrompt({ ...task, task_id: "phase0-fixture-b" });
const firstDifference = [...prompt].findIndex((char, index) => char !== otherPrompt[index]);
const continuation = buildContinuePrompt({
  task, previousResult: large, feedback: "Verify the reported fixture checks.", additionalRequirements: [],
  previousSessionId: null,
});
const files = [
  "package-lock.json",
  "src/mcp/server.ts",
  "src/mcp/schemas.ts",
  "src/prompts/task-prompt.ts",
  "plugins/codex-zcode-bridge/dist/bridge.mjs",
  "plugins/codex-zcode-bridge/worker/worker-main.mjs",
  "plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md",
  "plugins/codex-zcode-bridge/skills/zcode-bridge/references/task-dispatch.md",
  "plugins/codex-zcode-bridge/skills/zcode-bridge/references/monitoring-and-approval.md",
  "tools/cost-lab/coding-plan-billing.mjs",
];

console.log(JSON.stringify({
  run_id: runId,
  commit: baseline,
  tree: git("rev-parse", "HEAD^{tree}"),
  cost_lab_tree: git("rev-parse", "HEAD:tools/cost-lab"),
  node: process.version,
  evidence_kind: "fixed_in_memory_mcp_replay",
  tokenizer: { package: "js-tiktoken@1.0.21", encoding: "o200k_base" },
  request_counts: { model: 0, billing: 0, worker_spawn: 0 },
  provider_usage: null,
  total_billed_cost: null,
  git_blob_oids: Object.fromEntries(files.map((file) => [file, git("rev-parse", `HEAD:${file}`)])),
  local_sha256: Object.fromEntries(files.map((file) => [file, sha256(readFileSync(new URL(`../../../${file}`, import.meta.url)))])),
  worker_prompt: {
    fresh: { ...measureText(prompt), sha256: sha256(prompt) },
    first_differing_ascii_index_after_task_id_change: firstDifference,
    continuation: {
      ...measureText(continuation),
      sha256: sha256(continuation),
      output_contract_count: continuation.match(/OUTPUT CONTRACT \(mandatory\)/g)?.length ?? 0,
    },
  },
  ...snapshot,
  ...(schemaCandidate ? { schema_candidate: schemaCandidate } : {}),
}, null, 2));
