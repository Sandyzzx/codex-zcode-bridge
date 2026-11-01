import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { BridgeTaskManager } from "../../../src/manager/task-manager.js";
import { SqliteLifecycleMcpAuthority } from "../../../src/manager/sqlite-lifecycle-mcp-authority.js";
import { createBridgeServer } from "../../../src/mcp/server.js";
import { createTrustedLocalCandidateContext, serveStdioLifecycleHost, type StdioLifecycleHost } from "../../../src/host/stdio.js";
import { initializeIsolatedCandidateRoot, loadLifecycleCandidateModules, openClaimOnlyDriver, readAllLifecycleEventsForRecovery } from "../../../src/store/lifecycle-gate.js";
import { createJsonHistoryArchive, readJsonHistoryArchive } from "../../../src/store/json-history-archive.js";
import { publishJsonAuthority } from "../../../src/store/json-authority-cutover.js";
import { beginJsonWriterDrain, registerManagerJsonWriter, sealJsonWriterRoot } from "../../../src/store/json-writer-quiescence.js";
import { TaskStore } from "../../../src/store/task-store.js";
import { DirectWorkspaceProvider } from "../../../src/workspace/direct-provider.js";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessProbe, type ProbeRequest, type ProbeVerdict } from "../../../src/runtime/process-probe.js";

const source = (name: string): string => readFileSync(path.join(process.cwd(), "src", name), "utf8");

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalTestJson(item)}`).join(",")}}`;
  }
  throw new TypeError("unsupported synthetic evidence value");
}

function candidateEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalTestJson(value)).digest("hex");
}

function redactTestDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTestDiagnostic);
  if (typeof value === "string") {
    return value
      .replace(/\b(pid|process_id|fingerprint|start_fingerprint)\s*[:=]\s*["']?[0-9A-Za-z_-]+/giu,
        (_match, key: string) => `${key}=[redacted]`)
      .replace(/\b(?:pid|process_id)\s+[0-9]+\b/giu, "process_id [redacted]");
  }
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = /(?:^|_)(?:pid|process_id|fingerprint|start_fingerprint)$/iu.test(key)
      ? "[redacted]"
      : redactTestDiagnostic(item);
  }
  return redacted;
}

test("production Host composition keeps JSON as default and exposes no test Fake adapter", () => {
  const host = source("host/stdio.ts");
  assert.match(host, /const \{ TaskStore \} = await import\("\.\.\/store\/task-store\.js"\)/u);
  assert.match(host, /new TaskStore\(dataRoot,\s*\{\s*writerQuiescence:\s*true,\s*writerLeaseToken:\s*managerWriterLeaseToken\s*\}\)/u);
  assert.match(host, /registerManagerJsonWriter\(dataRoot,/u);
  assert.match(host, /new BridgeTaskManager\(/u);
  assert.doesNotMatch(host, /testOnlyFakeAdapter|executeFakeResultAdapter|adapter_mode\s*:\s*"test_fake"/u,
    "the formal Host entry must not expose the explicit Fake test capability");
});

test("JSON Worker path lazily imports the unchanged TaskStore/Adapter runner only without fd 3", () => {
  const worker = source("worker/worker-main.ts");
  assert.match(worker, /bridgeLaunchMarker && positionalArgs\.length === 0/u);
  assert.match(worker, /await runClaimOnlyHandshake\(\{ interactionMode, dropAfterPrepared,/u);
  assert.match(worker, /const \{ runWorkerTask \} = await import\("\.\/run-task\.js"\)/u);
  assert.match(worker, /else \{[\s\S]*?await import\("\.\/run-task\.js"\)/u);
  assert.doesNotMatch(worker, /from ["']\.\.\/sqlite-candidate\/wp6b2b1\/store\.mjs/u);
});

test("claim-only lifecycle composition has no JSON TaskStore or real Adapter dependency", () => {
  const gate = source("store/lifecycle-gate.ts");
  assert.doesNotMatch(gate, /TaskStore|ZCodeAppServerAdapter|runWorkerTask/u);
  assert.match(gate, /loadLifecycleCandidateModules/u);
  assert.match(gate, /verifyHandshakeAndCommitClaim/u);
});

test("SQLite Manager startup runs read-only Recovery and retains unknown active Operation occupancy", { timeout: 30_000 }, async () => {
  const taskId = `recovery-held-${randomUUID()}`;
  const queuedTaskId = `recovery-root-queued-${randomUUID()}`;
  let spawnCount = 0;
  await withSqliteMcp(async (_client, manager, dataRoot, workspace) => {
    const modules = await loadLifecycleCandidateModules();
      const recovery = modules.Store.openForRecovery(dataRoot);
      assert.ok(recovery, "isolated read-only Recovery Store must open");
    try {
      const port = modules.createPort(recovery);
      const snapshotBefore = port.readRecoverySnapshot() as { root_status: string; operations: Array<Record<string, unknown>> };
      const operation = snapshotBefore.operations.find((row) => row.task_id === taskId);
      assert.equal(snapshotBefore.root_status, "consistent_read_only");
      assert.equal(operation?.phase, "running");
      assert.equal(operation?.claim_permanent, true);
      assert.equal(operation?.capacity_occupied, true);
      const queuedStatus = contentObject(await _client.callTool({ name: "zcode_status", arguments: { task_id: queuedTaskId } }));
      assert.equal(queuedStatus.status, "queued", "a held Operation must not cause a different queued Task to dispatch");
      await assert.rejects(manager.createTask(syntheticTask(workspace, `blocked-by-operation-hold-${taskId}`) as unknown as Parameters<BridgeTaskManager["createTask"]>[0]),
        /blocked by Recovery/u, "a held Operation must make the affected Root read-only for new Admission");
      const eventsBeforeObservation = port.readTaskEvents(taskId).events.length;
      const observed = contentObject(await _client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
      const executionObservation = observed.execution_observation as Record<string, unknown>;
      assert.equal(observed.status, "running", "execution observation must not synthesize a Task status");
      assert.equal(executionObservation.state, "worker_identity_unknown", "synthetic Worker identity cannot establish a live OS executor");
      assert.match(String(executionObservation.evidence_ref), /^[0-9a-f]{64}$/u);
      assert.doesNotMatch(JSON.stringify(executionObservation), /43210/u, "observation reference must not disclose a PID");
      assert.equal(port.readTaskEvents(taskId).events.length, eventsBeforeObservation, "Status observation is read-only and must not append lifecycle events");
      const beforeJson = JSON.stringify(snapshotBefore);
      await assert.rejects(manager.recoverTasks(), /startup-only/u, "Recovery must not be re-entered while the Manager is live");
      assert.equal(JSON.stringify(port.readRecoverySnapshot()), beforeJson, "rejected Recovery re-entry must not alter lifecycle state");
      await assert.rejects(manager.createTask(syntheticTask(path.join(dataRoot, "workspace"), `blocked-${taskId}`) as unknown as Parameters<BridgeTaskManager["createTask"]>[0]), /blocked by Recovery/u);
      assert.equal(port.readTaskProjection(`blocked-${taskId}`), null, "a blocked Recovery root must reject admission before writing Task state");
      assert.equal(spawnCount, 0, "startup Recovery must not Spawn or replay a Worker");
    } finally {
      recovery.close();
    }
  }, {
    beforeAuthority: (dataRoot, modules, workspace) => {
      const store = modules.Store.open(dataRoot);
      try {
        const port = modules.createPort(store);
        port.createTask(syntheticTask(workspace, taskId) as unknown as Parameters<typeof port.createTask>[0]);
      port.createTask(syntheticTask(workspace, queuedTaskId) as unknown as Parameters<typeof port.createTask>[0]);
        const allow = () => ({ state: "allow", fixture: true });
        const admitted = port.admitOperation({ operation_id: `operation-${taskId}`, task_id: taskId, attempt: 1, workspace_ref: workspace }, {
          workspaceValidator: allow,
          executionPermissionCheck: allow,
        }) as Record<string, unknown>;
        const launch = {
          operation_id: `operation-${taskId}`,
          task_id: taskId,
          attempt: 1,
          generation: Number(admitted.generation),
          revision: Number(admitted.revision),
          launch_id: `launch-${taskId}`,
          launch_epoch: 1,
          launch_token: `synthetic-token-${taskId}-0123456789`,
        };
        const intent = port.createLaunchIntent(launch) as Record<string, unknown>;
        const receipt = port.recordLaunchReceipt({
          ...launch,
          revision: Number(intent.revision),
          receipt_id: `receipt-${taskId}`,
          launch_identity: { source: "synthetic_fixture", fixture: true, process_id: 43210, start_fingerprint: `fixture-${taskId}` },
        }) as Record<string, unknown>;
        port.commitPermanentClaim({
          ...launch,
          revision: Number(receipt.revision),
          claim_id: `claim-${taskId}`,
          worker_identity: { source: "synthetic_fixture", fixture: true, worker_id: `worker-${taskId}`, incarnation: "synthetic-1", process_id: 43210, start_fingerprint: `fixture-${taskId}` },
        } as unknown as Parameters<typeof port.commitPermanentClaim>[0]);
      } finally {
        store.close();
      }
    },
    onChildSpawn: () => { spawnCount += 1; },
  });
});

test("SQLite Manager restart releases only persisted cleanup-verified Operations without spawning", { timeout: 30_000 }, async () => {
  const taskId = `recovery-release-${randomUUID()}`;
  const operationId = candidateOperationId(taskId, 1);
  let spawnCount = 0;
  await withSqliteMcp(async (_client, _manager, dataRoot) => {
    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(dataRoot);
    assert.ok(recovery, "isolated read-only Recovery Store must open after Manager startup");
    try {
      const port = modules.createPort(recovery);
      const operation = port.readOperation(operationId) as Record<string, unknown>;
      assert.equal(operation.phase, "released", "Manager startup may release only after persisted cleanup verification");
      assert.equal(operation.claim_id, `claim-${taskId}`);
      assert.equal(typeof operation.claim_worker_identity_digest, "string", "permanent Claim identity must remain recorded");
      const result = port.readCommittedResult(operationId) as Record<string, unknown> | null;
      assert.equal(result?.result_status, "completed", "Recovery Release must preserve the committed Result");

      const lifecycle = port.readRecoverySnapshot() as { operations: Array<Record<string, unknown>> };
      const recovered = lifecycle.operations.find((row) => row.operation_id === operationId);
      assert.equal(recovered?.phase, "released");
      assert.equal(recovered?.capacity_occupied, false, "verified Release must free this Operation's capacity");
      const events = port.readLifecycleEvents(operationId, { afterSequence: 0, limit: 100 });
      assert.equal(events.filter((event) => event.event_type === "cleanup_pending").length, 1);
      assert.equal(events.filter((event) => event.event_type === "cleanup_verified").length, 1);
      assert.equal(events.filter((event) => event.event_type === "released").length, 1,
        "startup recovery must persist exactly one Release event");
      assert.deepEqual(events.slice(-3).map((event) => event.event_type), ["cleanup_pending", "cleanup_verified", "released"]);
      assert.equal(spawnCount, 0, "cleanup-verified Release recovery must not Spawn or replay business work");
    } finally {
      recovery.close();
    }
  }, {
    beforeAuthority: (dataRoot, modules, workspace) => {
      const store = modules.Store.open(dataRoot);
      try {
        const port = modules.createPort(store);
        port.createTask(syntheticTask(workspace, taskId) as unknown as Parameters<typeof port.createTask>[0]);
        const allow = () => ({ state: "allow", fixture: true });
        const admitted = port.admitOperation({ operation_id: operationId, task_id: taskId, attempt: 1, workspace_ref: workspace }, {
          workspaceValidator: allow,
          executionPermissionCheck: allow,
        }) as Record<string, unknown>;
        const launch = {
          operation_id: operationId,
          task_id: taskId,
          attempt: 1,
          generation: Number(admitted.generation),
          revision: Number(admitted.revision),
          launch_id: `launch-${taskId}`,
          launch_epoch: 1,
          launch_token: `synthetic-recovery-token-${taskId}-0123456789`,
        };
        const intent = port.createLaunchIntent(launch) as Record<string, unknown>;
        const processId = 47001;
        const fingerprint = `recovery-${taskId}`;
        const receipt = port.recordLaunchReceipt({
          ...launch,
          revision: Number(intent.revision),
          receipt_id: `receipt-${taskId}`,
          launch_identity: { source: "synthetic_fixture", fixture: true, process_id: processId, start_fingerprint: fingerprint },
        }) as Record<string, unknown>;
        const claim = port.commitPermanentClaim({
          ...launch,
          revision: Number(receipt.revision),
          claim_id: `claim-${taskId}`,
          worker_identity: { source: "synthetic_fixture", fixture: true, worker_id: `worker-${taskId}`, incarnation: "synthetic-1", process_id: processId, start_fingerprint: fingerprint },
        } as unknown as Parameters<typeof port.commitPermanentClaim>[0]) as Record<string, unknown>;
        const operationAfterClaim = port.readOperation(operationId) as Record<string, unknown>;
        const result = {
          task_id: taskId,
          attempt: 1,
          status: "completed" as const,
          summary: "synthetic result before Manager restart",
          files_changed: [],
          tests: [],
          issues: [],
          needs_master_decision: false,
          zcode_output: "",
          exit_code: 0,
          session_id: null,
          started_at: "2026-10-26T00:00:00.000Z",
          finished_at: "2026-10-26T00:00:01.000Z",
        };
        port.commitResult({
          operation_id: operationId,
          task_id: taskId,
          attempt: 1,
          generation: Number(admitted.generation),
          revision: Number(operationAfterClaim.revision),
          claim_id: String(claim.claim_id),
          claim_worker_identity_digest: String(operationAfterClaim.claim_worker_identity_digest),
          result_status: "completed",
          result,
        });
        const committed = port.readOperation(operationId) as Record<string, unknown>;
        const fence = {
          operation_id: operationId,
          task_id: taskId,
          attempt: 1,
          generation: Number(committed.generation),
          revision: Number(committed.revision),
          claim_id: String(committed.claim_id),
          claim_worker_identity_digest: String(committed.claim_worker_identity_digest),
          launch_receipt_digest: String(committed.launch_receipt_digest),
          result_commit_ref: String(committed.result_commit_ref),
          process_id: processId,
          start_fingerprint: fingerprint,
        };
        const pending = port.beginCleanup(fence);
        port.recordCleanupEvidence({
          ...fence,
          revision: Number(pending.revision),
          outcome: "verified",
          cleanup_evidence: {
            source: "synthetic_fixture",
            fixture: true,
            operation_id: operationId,
            task_id: taskId,
            attempt: 1,
            generation: Number(committed.generation),
            claim_id: String(committed.claim_id),
            worker_identity_digest: String(committed.claim_worker_identity_digest),
            launch_receipt_digest: String(committed.launch_receipt_digest),
            result_commit_ref: String(committed.result_commit_ref),
            process_tree_digest: "a".repeat(64),
            resources_digest: "b".repeat(64),
            root_process_id: processId,
            root_start_fingerprint: fingerprint,
            worker_tree_complete: true,
            operation_resources_complete: true,
            workspace_touched: false,
          },
        });
      } finally {
        store.close();
      }
    },
    onChildSpawn: () => { spawnCount += 1; },
  });
});

const projectRoot = process.cwd();
const compiledCandidate = path.join(projectRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1");
const integrationRoot = path.join(compiledCandidate, ".wp6-od13-mcp-integration");

test("Recovery reads lifecycle evidence across the Store's bounded 200-event pages", () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => ({ sequence: index + 1, event_type: "interaction_requested" }));
  const secondPage = [
    { sequence: 201, event_type: "cleanup_verified" },
    { sequence: 202, event_type: "released" },
  ];
  const cursors: number[] = [];
  const events = readAllLifecycleEventsForRecovery({
    readLifecycleEvents(_operationId, options) {
      const cursor = options?.afterSequence ?? 0;
      cursors.push(cursor);
      return cursor === 0 ? firstPage : secondPage;
    },
  }, "recovery-page-test");

  assert.deepEqual(cursors, [0, 200]);
  assert.equal(events.length, 202);
  assert.equal(events.find((event) => event.event_type === "cleanup_verified")?.sequence, 201);
});

test("execution observations expose all four read-only states without changing SQLite lifecycle facts", { timeout: 90_000, skip: process.platform !== "win32" }, async () => {
  const modes = [
    { state: "worker_alive_unmanaged", probeState: "alive" },
    { state: "interrupted_without_result", probeState: "exited" },
    { state: "worker_identity_unknown", probeState: "unknown" },
    { state: "cleanup_held", probeState: "unknown" },
  ] as const;

  for (const mode of modes) {
    const taskId = `execution-observation-${mode.state}-${randomUUID()}`;
    const operationId = candidateOperationId(taskId, 1);
    const processId = 43210;
    const fingerprint = `private-worker-fingerprint-${randomUUID()}`;
    const launchId = `launch-${taskId}`;
    let probeState: "startup" | "alive" | "exited" | "unknown" = "startup";
    const platformProbe = createPlatformProbe();
    const processProbe: ProcessProbe = {
      platform: platformProbe.platform,
      identityOf: (pid) => platformProbe.identityOf(pid),
      selfIdentity: () => platformProbe.selfIdentity(),
      probe: async (requests) => {
        const state = probeState;
        return requests.map(() => state === "startup"
          ? { state: "unknown", reason_code: "startup_identity_unresolved", observed_at: new Date().toISOString() }
          : { state, reason_code: `synthetic_${state}`, observed_at: new Date().toISOString() });
      },
    };

    await withSqliteMcp(async (_client, manager, dataRoot) => {
      const modules = await loadLifecycleCandidateModules();
      const recoveryStore = modules.Store.openForRecovery(dataRoot);
      assert.ok(recoveryStore);
      const port = modules.createPort(recoveryStore);
      const readFacts = (): string => JSON.stringify({
        lifecycle: port.readTaskLifecycle(taskId),
        events: port.readTaskEvents(taskId, { afterCursor: 0, limit: 200 }),
      });
      try {
        const before = readFacts();
        probeState = mode.probeState;
        const status = await manager.getStatus(taskId);
        const observation = status.execution_observation;
        assert.ok(observation);
        assert.equal(observation.state, mode.state);
        assert.match(String(observation.evidence_ref), /^[0-9a-f]{64}$/u);
        assert.equal(status.status, mode.state === "cleanup_held" ? "completed" : "running");
        const serializedObservation = JSON.stringify(observation);
        assert.equal(serializedObservation.includes(String(processId)), false, "read-only observation must not disclose Worker PID");
        assert.equal(serializedObservation.includes(fingerprint), false, "read-only observation must not disclose Worker identity");
        assert.equal(readFacts(), before, "Status observation must not mutate Task, Attempt, Result, Operation or Events");
      } finally {
        recoveryStore.close();
      }
    }, {
      processProbe,
      beforeAuthority: (dataRoot, modules, workspace) => {
        const store = modules.Store.open(dataRoot);
        try {
          const port = modules.createPort(store);
          port.createTask(syntheticTask(workspace, taskId) as unknown as Parameters<typeof port.createTask>[0]);
          const allow = () => ({ state: "allow", fixture: true });
          const admitted = port.admitOperation({ operation_id: operationId, task_id: taskId, attempt: 1, workspace_ref: workspace }, {
            workspaceValidator: allow,
            executionPermissionCheck: allow,
          }) as Record<string, unknown>;
          const launchToken = `synthetic-observation-token-${taskId}-0123456789`;
          const launchRequest = {
            operation_id: operationId,
            task_id: taskId,
            attempt: 1,
            generation: Number(admitted.generation),
            revision: Number(admitted.revision),
            launch_id: launchId,
            launch_epoch: 1,
            launch_token: launchToken,
          };
          const launchIdentityEvidence = {
            source: "manager_os_spawn_observation",
            fixture: false,
            launch_id: launchId,
            generation: Number(admitted.generation),
            process_id: processId,
            start_fingerprint: fingerprint,
            fingerprint_precision: "exact",
            identity_version: PROCESS_IDENTITY_VERSION,
            platform: "win32",
            captured_at: new Date().toISOString(),
          };
          const launchIdentity = { ...launchIdentityEvidence, evidence_digest: candidateEvidenceDigest(launchIdentityEvidence) };
          const intent = port.createLaunchIntent(launchRequest) as Record<string, unknown>;
          const receipt = port.recordLaunchReceipt({
            ...launchRequest,
            revision: Number(intent.revision),
            receipt_id: `receipt-${taskId}`,
            launch_identity: launchIdentity,
          }) as Record<string, unknown>;
          const workerIdentityEvidence = {
            source: "manager_verified_process_probe",
            fixture: false,
            worker_id: `worker-${taskId}`,
            process_id: processId,
            start_fingerprint: fingerprint,
            fingerprint_precision: "exact",
            identity_version: PROCESS_IDENTITY_VERSION,
            platform: "win32",
            captured_at: new Date().toISOString(),
          };
          const workerIdentity = { ...workerIdentityEvidence, evidence_digest: candidateEvidenceDigest(workerIdentityEvidence) };
          const claim = port.commitPermanentClaim({
            ...launchRequest,
            revision: Number(receipt.revision),
            claim_id: `claim-${taskId}`,
            worker_identity: workerIdentity,
          } as unknown as Parameters<typeof port.commitPermanentClaim>[0]) as Record<string, unknown>;

          if (mode.state === "cleanup_held") {
            const operation = port.readOperation(operationId) as Record<string, unknown>;
            const result = {
              task_id: taskId,
              attempt: 1,
              status: "completed" as const,
              summary: "committed synthetic result for cleanup observation",
              files_changed: [],
              tests: [],
              issues: [],
              needs_master_decision: false,
              zcode_output: "",
              exit_code: 0,
              session_id: null,
              started_at: "2026-10-26T00:00:00.000Z",
              finished_at: "2026-10-26T00:00:01.000Z",
            };
            port.commitResult({
              operation_id: operationId,
              task_id: taskId,
              attempt: 1,
              generation: Number(operation.generation),
              revision: Number(operation.revision),
              claim_id: String(claim.claim_id),
              claim_worker_identity_digest: String(operation.claim_worker_identity_digest),
              result_status: "completed",
              result,
            });
            const resultOperation = port.readOperation(operationId) as Record<string, unknown>;
            const cleanupFence = {
              operation_id: operationId,
              task_id: taskId,
              attempt: 1,
              generation: Number(resultOperation.generation),
              revision: Number(resultOperation.revision),
              claim_id: String(resultOperation.claim_id),
              claim_worker_identity_digest: String(resultOperation.claim_worker_identity_digest),
            };
            const pending = port.beginCleanup(cleanupFence) as { readonly revision: number };
            port.recordCleanupEvidence({ ...cleanupFence, revision: pending.revision, outcome: "unverified", probe_state: "unknown", reason: "synthetic_cleanup_unknown" });
          }
        } finally {
          store.close();
        }
      },
    });
  }
});

test("Recovery rejects a full event page that cannot advance its cursor", () => {
  const page = Array.from({ length: 200 }, () => ({ event_type: "interaction_requested" }));
  assert.throws(() => readAllLifecycleEventsForRecovery({
    readLifecycleEvents: () => page,
  }, "recovery-invalid-cursor"), (error: unknown) => error instanceof Error && error.message === "recovery_event_cursor_invalid");
});
const candidateSchema = path.join(compiledCandidate, "schema.sql");
const sourceSchema = path.join(projectRoot, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");

class RawStdioMcpTestClient {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor() {
    this.stdout.on("data", (chunk: Buffer | string) => {
      this.#buffer += chunk.toString();
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof response.id !== "number") continue;
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error.message ?? "MCP stdio request failed"));
        else pending.resolve(response.result);
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "m3-stdio-test", version: "0.0.1" },
    });
    this.notify("notifications/initialized");
  }

  async callTool(input: { readonly name: string; readonly arguments?: Record<string, unknown> }): Promise<unknown> {
    return this.request("tools/call", { name: input.name, arguments: input.arguments ?? {} });
  }

  async close(): Promise<void> {
    this.stdin.end();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  private notify(method: string): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
}

async function withSqliteMcp(
  run: (client: Client, manager: BridgeTaskManager, dataRoot: string, workspace: string) => Promise<void>,
  options: { readonly testBeforeDispatch?: () => Promise<void>; readonly testOnScheduler?: (stage: string, detail: Readonly<Record<string, unknown>>) => void; readonly onStage?: (stage: string, detail?: Readonly<Record<string, unknown>>) => void; readonly onChildSpawn?: (child: { readonly pid?: number; readonly stderr?: NodeJS.ReadableStream | null; readonly resultChannel?: NodeJS.ReadableStream | null }) => void; readonly beforeAuthority?: (dataRoot: string, modules: Awaited<ReturnType<typeof loadLifecycleCandidateModules>>, workspace: string) => void; readonly prepareDataRoot?: (dataRoot: string, fixture: string) => Promise<void>; readonly databaseFileName?: string; readonly enableSyntheticInteractionChannel?: boolean; readonly processProbe?: ProcessProbe; readonly testProcessProbeTimeoutMs?: number; readonly testShutdownWaitMs?: number; readonly stdio?: boolean; readonly preserveFixtureOnFailure?: boolean; readonly onStdioHost?: (host: StdioLifecycleHost) => void; readonly onStdioShutdownComplete?: (reason: string) => void; readonly onStdioShutdownFailure?: (reason: string, error: unknown) => void } = {},
): Promise<void> {
  const fixture = path.join(integrationRoot, randomUUID());
  const dataRoot = path.join(fixture, "sqlite-root");
  const workspace = path.join(fixture, "workspace");
  const settingsDirectory = path.join(fixture, "settings");
  mkdirSync(compiledCandidate, { recursive: true });
  if (existsSync(candidateSchema)) {
    assert.equal(readFileSync(candidateSchema, "utf8"), readFileSync(sourceSchema, "utf8"), "compiled schema must match the tested source schema");
  } else {
    copyFileSync(sourceSchema, candidateSchema);
  }
  mkdirSync(workspace, { recursive: true });
  mkdirSync(settingsDirectory, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  const modules = await loadLifecycleCandidateModules();
  if (options.prepareDataRoot) {
    await options.prepareDataRoot(dataRoot, fixture);
  } else {
    await initializeIsolatedCandidateRoot(dataRoot);
    const store = modules.Store.open(dataRoot);
    try {
      modules.createPort(store).provisionCapacity({
        operation_id: `policy-${path.basename(fixture)}`,
        capacity_limit: 2,
        expected_generation: 0,
        maintenance: { dispatch_blocked: true, writers_drained: true },
      });
    } finally {
      store.close();
    }
  }
  options.beforeAuthority?.(dataRoot, modules, workspace);
  const authority = await SqliteLifecycleMcpAuthority.create({
    dataRoot,
    ...(options.databaseFileName ? { databaseFileName: options.databaseFileName, managedDataDirectory: true } : {}),
    workerEntryPath: path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js"),
    bridgeEntryPath: fileURLToPath(import.meta.url),
    trustedLocalContext: createTrustedLocalCandidateContext({ name: "sqlite-mcp-test", settingsDirectory }),
    ...(options.processProbe ? { processProbe: options.processProbe } : {}),
    ...(options.testProcessProbeTimeoutMs !== undefined ? { testProcessProbeTimeoutMs: options.testProcessProbeTimeoutMs } : {}),
    ...(options.testShutdownWaitMs !== undefined ? { testShutdownWaitMs: options.testShutdownWaitMs } : {}),
    ...(options.testBeforeDispatch ? { testBeforeDispatch: options.testBeforeDispatch } : {}),
    ...(options.testOnScheduler ? { testOnScheduler: options.testOnScheduler } : {}),
    ...(options.onStage ? { onStage: options.onStage } : {}),
    ...(options.onChildSpawn ? { onChildSpawn: options.onChildSpawn } : {}),
    ...(options.enableSyntheticInteractionChannel ? { enableSyntheticInteractionChannel: true } : {}),
    testOnlyFakeAdapter: true,
  });
  const manager = new BridgeTaskManager({ lifecycleAuthority: authority });
  const server = createBridgeServer({ taskManager: manager });
  let client: Client;
  let closeClient: () => Promise<void>;
  if (options.stdio) {
    const raw = new RawStdioMcpTestClient();
    const host = serveStdioLifecycleHost(server, manager, {
      stdin: raw.stdin,
      stdout: raw.stdout,
      onShutdownComplete: options.onStdioShutdownComplete,
      onShutdownFailure: options.onStdioShutdownFailure,
    });
    options.onStdioHost?.(host);
    client = raw as unknown as Client;
    closeClient = () => raw.close();
    await raw.initialize();
  } else {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "sqlite-lifecycle-integration-test", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeClient = () => client.close();
  }
  let runSucceeded = false;
  try {
    await run(client, manager, dataRoot, workspace);
    runSucceeded = true;
  } finally {
    await closeClient().catch(() => undefined);
    await server.close().catch(() => undefined);
    await manager.shutdown().catch(() => undefined);
    if (runSucceeded || !options.preserveFixtureOnFailure) {
      try { rmSync(fixture, { recursive: true, force: true }); } catch { /* retain exact fixture if Windows still holds a handle */ }
    }
  }
}

function syntheticTask(workspace: string, taskId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    workspace,
    objective: "Complete the isolated lifecycle probe",
    requirements: ["synthetic only"],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: ["persist one SQLite Result"],
    test_commands: [],
  };
}

function candidateOperationId(taskId: string, attempt: number): string {
  const digest = createHash("sha256").update(`${taskId}\0${attempt}`, "utf8").digest("hex").slice(0, 32);
  return `sqlite-${digest}`;
}

function contentObject(result: { readonly structuredContent?: unknown; readonly content?: readonly unknown[]; readonly isError?: boolean }, diagnostic = ""): Record<string, unknown> {
  const value = result.structuredContent;
  assert.notEqual(result.isError, true, `MCP tool returned an error: ${JSON.stringify(result)} ${diagnostic}`);
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `MCP tool must return structured content: ${JSON.stringify(result)} ${diagnostic}`);
  return value as Record<string, unknown>;
}

async function waitForTerminal(client: Client, taskId: string, expectedAttempt: number, diagnostic = ""): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  const observed: Array<{ status: unknown; attempt: unknown }> = [];
  while (Date.now() < deadline) {
    const status = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
    if (observed.length < 8 || observed.at(-1)?.status !== status.status || observed.at(-1)?.attempt !== status.attempt) {
      observed.push({ status: status.status, attempt: status.attempt });
      if (observed.length > 20) observed.shift();
    }
    if (["completed", "failed", "cancelled", "waiting_for_master"].includes(String(status.status))
      && Number(status.attempt) === expectedAttempt) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`SQLite MCP task ${taskId} did not reach a terminal status for attempt ${expectedAttempt}: ${JSON.stringify({ observed, diagnostic })}`);
}

async function waitForLifecycleEvent(client: Client, taskId: string, eventType: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const events = Array.isArray(page.events) ? page.events as Array<Record<string, unknown>> : [];
    if (events.some((event) => event.type === eventType)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`SQLite lifecycle event ${eventType} was not observed for ${taskId}`);
}

async function waitForInteractionRequest(client: Client, taskId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const events = Array.isArray(page.events) ? page.events as Array<Record<string, unknown>> : [];
    const request = events.find((event) => event.type === "interaction_requested");
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`SQLite interaction request was not exposed through MCP events for ${taskId}`);
}

const recoveryModes = [
  { name: "never_settles_after_worker_exit", recoveryProbe: async (): Promise<ProbeVerdict[]> => new Promise(() => undefined), expectedReason: "cleanup_identity_unknown" },
  { name: "probe_rejects", recoveryProbe: async (): Promise<ProbeVerdict[]> => { throw new Error("synthetic probe close failure"); }, expectedReason: "cleanup_identity_unknown" },
  { name: "identity_conflict_unknown", recoveryProbe: async (): Promise<ProbeVerdict[]> => [{
    state: "unknown", reason_code: "identity_mismatch", observed_at: new Date().toISOString(),
  }], expectedReason: "cleanup_identity_unknown" },
  { name: "cleanup_unverified_new_hold_during_probe", injectCleanupHold: true, maximumRecoveryMs: 30_000,
    recoveryProbe: async (requests: readonly ProbeRequest[]): Promise<ProbeVerdict[]> => requests.map(() => ({
      state: "exited", reason_code: "synthetic_exact_identity_absent", observed_at: new Date().toISOString(),
    })), expectedReason: "cleanup_incomplete" },
  { name: "cleanup_unverified_exact_exit", maximumRecoveryMs: 30_000, recoveryProbe: async (requests: readonly ProbeRequest[]): Promise<ProbeVerdict[]> => requests.map(() => ({
    state: "exited", reason_code: "synthetic_exact_identity_absent", observed_at: new Date().toISOString(),
  })), expectedReason: "cleanup_incomplete" },
] as const;

for (const mode of recoveryModes) {
  test(`Manager Recovery mode ${mode.name} bounds probes and retains cleanup holds`, { skip: process.platform !== "win32", timeout: 75_000 }, async (scenario) => {
    await scenario.signal.throwIfAborted();
    await runRecoveryBoundedMode(mode, scenario.signal);
  });
}

async function runRecoveryBoundedMode(
  mode: typeof recoveryModes[number],
  signal: AbortSignal,
): Promise<void> {
  const fixture = path.join(integrationRoot, `g4-${randomUUID()}`);
  const dataRoot = path.join(fixture, "sqlite-root");
  const workspace = path.join(fixture, "workspace");
  const settingsDirectory = path.join(fixture, "settings");
  let successful = false;
  let driver: Awaited<ReturnType<typeof openClaimOnlyDriver>> | undefined;
  let recoveryManager: BridgeTaskManager | undefined;
  try {
    mkdirSync(compiledCandidate, { recursive: true });
    if (existsSync(candidateSchema)) {
      assert.equal(readFileSync(candidateSchema, "utf8"), readFileSync(sourceSchema, "utf8"), "compiled schema must match source schema");
    } else {
      copyFileSync(sourceSchema, candidateSchema);
    }
    mkdirSync(workspace, { recursive: true });
    mkdirSync(settingsDirectory, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    await initializeIsolatedCandidateRoot(dataRoot);
    const modules = await loadLifecycleCandidateModules();
    const setupStore = modules.Store.open(dataRoot);
    try {
      modules.createPort(setupStore).provisionCapacity({
        operation_id: `capacity-${randomUUID()}`,
        capacity_limit: 1,
        expected_generation: 0,
        maintenance: { dispatch_blocked: true, writers_drained: true },
      });
    } finally { setupStore.close(); }

    const trustedLocalContext = createTrustedLocalCandidateContext({ name: "g4-bounded-recovery", settingsDirectory });
    const taskId = `g4-bounded-${mode.name}-${randomUUID()}`;
    const operationId = candidateOperationId(taskId, 1);
    const task = syntheticTask(workspace, taskId) as unknown as Parameters<Awaited<ReturnType<typeof openClaimOnlyDriver>>["run"]>[0]["task"];
    const runStages: Array<{ stage: string; detail?: Readonly<Record<string, unknown>> }> = [];
    const platformProbe = createPlatformProbe();
    let runProbeCalls = 0;
    const baseProbe: ProcessProbe = {
      platform: platformProbe.platform,
      identityOf: (pid) => platformProbe.identityOf(pid),
      selfIdentity: () => platformProbe.selfIdentity(),
      probe: async (requests) => {
        runProbeCalls += 1;
        if (runProbeCalls <= 2) return await platformProbe.probe(requests);
        return requests.map(() => ({ state: "unknown", reason_code: "initial_cleanup_unavailable", observed_at: new Date().toISOString() }));
      },
    };

    driver = await openClaimOnlyDriver({
      dataRoot,
      workerEntryPath: path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js"),
      bridgeEntryPath: fileURLToPath(import.meta.url),
      trustedLocalContext,
      testOnlyFakeAdapter: true,
      processProbe: baseProbe,
      testProcessProbeTimeoutMs: 500,
      onStage: (stage, detail) => runStages.push({ stage, detail }),
    });
    driver.createTask(task);
    const run = await driver.run({ task, operationId, launchId: `launch-${randomUUID()}`, launchToken: `token-${randomUUID()}-0123456789`, attempt: 1 });
    assert.equal(run.state, "result_committed", `synthetic Worker must commit its Result before Recovery (${mode.name}): ${JSON.stringify({ run, runStages })}`);
    assert.equal(run.workerExitCode, 0, `synthetic Worker must exit before Recovery Probe (${mode.name})`);
    assert.equal(run.cleanupState, "unverified", `unknown initial cleanup must retain the Operation (${mode.name})`);
    driver.close();
    driver = undefined;

    const startedAt = Date.now();
    let injectedCleanupHold = false;
    const recoveryProbe: ProcessProbe = {
      ...baseProbe,
      probe: async (requests) => {
        if ("injectCleanupHold" in mode && mode.injectCleanupHold && !injectedCleanupHold) {
          injectedCleanupHold = true;
          const holdStore = modules.Store.open(dataRoot) as unknown as {
            close(): void;
            readOperation(id: string): Record<string, unknown> | null;
          };
          try {
            const current = holdStore.readOperation(operationId);
            assert.ok(current);
            const evidence = {
              source: "manager_process_probe",
              operation_id: operationId,
              task_id: String(current.task_id),
              attempt: Number(current.attempt),
              generation: Number(current.generation),
              claim_id: String(current.claim_id),
              worker_identity_digest: String(current.claim_worker_identity_digest),
              observation: "eligible cleanup hold appended while verification probe was pending",
            };
            const observation = {
              operation_id: operationId,
              task_id: String(current.task_id),
              attempt: Number(current.attempt),
              generation: Number(current.generation),
              expected_revision: Number(current.revision),
              claim_id: String(current.claim_id),
              worker_identity_digest: String(current.claim_worker_identity_digest),
              classification: "hold",
              reason_code: "cleanup_incomplete",
              evidence_source: "manager_process_probe",
              evidence_digest: candidateEvidenceDigest(evidence),
            };
            const holdPort = modules.createPort(holdStore as object, {
              recoveryEvidenceVerifier: (context: {
                readonly operation: Readonly<Record<string, unknown>>;
                readonly observation: Readonly<Record<string, unknown>>;
                readonly evidence: Readonly<Record<string, unknown>>;
              }) => {
                const { operation, observation: verifiedObservation, evidence: verifiedEvidence } = context;
                const valid = operation.operation_id === operationId
                  && verifiedObservation.evidence_digest === observation.evidence_digest
                  && candidateEvidenceDigest(verifiedEvidence) === observation.evidence_digest;
                return valid ? {
                  classification: observation.classification,
                  evidence_digest: observation.evidence_digest,
                  evidence_source: observation.evidence_source,
                  reason_code: observation.reason_code,
                } : false;
              },
            });
            holdPort.recordRecoveryObservation(observation, evidence);
          } finally { holdStore.close(); }
        }
        return mode.recoveryProbe ? await mode.recoveryProbe(requests) : platformProbe.probe(requests);
      },
    };
    let recoverySpawnCount = 0;
    const recoveryAuthority = await SqliteLifecycleMcpAuthority.create({
      dataRoot,
      workerEntryPath: path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js"),
      bridgeEntryPath: fileURLToPath(import.meta.url),
      trustedLocalContext,
      processProbe: recoveryProbe,
      testProcessProbeTimeoutMs: 100,
      onChildSpawn: () => { recoverySpawnCount += 1; },
    });
    recoveryManager = new BridgeTaskManager({ lifecycleAuthority: recoveryAuthority });
    const elapsedMs = Date.now() - startedAt;
    const maximumRecoveryMs = "maximumRecoveryMs" in mode ? mode.maximumRecoveryMs : 2_000;
    assert.ok(elapsedMs < maximumRecoveryMs, `Recovery must return within a controlled bound, observed ${elapsedMs}ms (${mode.name})`);
    assert.equal(recoverySpawnCount, 0, "uncertain Recovery must not Spawn or replay an Operation");

    const recoveryStore = modules.Store.openForRecovery(dataRoot);
    assert.ok(recoveryStore);
    try {
      const recoveryPort = modules.createPort(recoveryStore);
      const snapshot = recoveryPort.readRecoverySnapshot() as { operations: Array<Record<string, unknown>> };
      const operation = snapshot.operations.find((item) => item.operation_id === operationId);
      assert.equal(operation?.phase, "cleanup_unverified");
      assert.equal(operation?.recovery_classification, "hold");
      assert.equal(operation?.capacity_occupied, true);
      assert.equal(operation?.claim_permanent, true);

      const lifecycle = recoveryPort.readLifecycleEvents(operationId);
      const recoveryEvents = lifecycle.filter((event) => event.event_type === "observation_recorded").map((event) => {
        const evidence = JSON.parse(String(event.evidence_json)) as Record<string, unknown>;
        return evidence;
      }).filter((evidence) => evidence.reason === "recovery_hold");
      assert.ok(recoveryEvents.length >= 1, "incomplete cleanup proof must persist a queryable Recovery Hold");
      assert.ok(recoveryEvents.some((evidence) => evidence.reason_code === mode.expectedReason),
        "the persistent event must identify why cleanup could not be released");
      assert.ok(recoveryEvents.every((evidence) => evidence.classification === "hold"));
      assert.ok(recoveryEvents.every((evidence) => /^[0-9a-f]{64}$/u.test(String(evidence.evidence_digest))),
        "each persistent event must bind its Recovery evidence by digest");
      assert.equal(lifecycle.filter((event) => event.event_type === "cleanup_reverified").length, 0);
      assert.equal(lifecycle.filter((event) => event.event_type === "cleanup_verified").length, 0);
      assert.equal(lifecycle.filter((event) => event.event_type === "released").length, 0);
      assert.equal(lifecycle.filter((event) => event.event_type === "result_committed").length, 1);
      assert.equal(lifecycle.filter((event) => event.event_type === "claim_committed").length, 1);
      assert.equal(lifecycle.filter((event) => event.event_type === "launch_intent").length, 1,
        "Recovery must not create a second launch Intent or replay the Worker");
    } finally { recoveryStore.close(); }
    await recoveryManager.shutdown();
    recoveryManager = undefined;
    signal.throwIfAborted();
    successful = true;
  } finally {
    await recoveryManager?.shutdown().catch(() => undefined);
    driver?.close();
    if (successful) rmSync(fixture, { recursive: true, force: true });
  }
}

test("Manager Recovery after restart preserves Capacity and Claim when claimant scan lacks complete closure evidence", { timeout: 120_000, skip: process.platform !== "win32" }, async () => {
  const modes = [
    { id: "rc", name: "result-committed-before-cleanup", interruptAt: "result_projection_verified", expectedPhase: "result_committed", concurrent: false, separateManagerProcess: false },
    { id: "cp", name: "cleanup-pending-after-manager-interruption", interruptAt: "cleanup_pending_persisted", expectedPhase: "cleanup_pending", concurrent: true, separateManagerProcess: true },
  ] as const;

  for (const mode of modes) {
    const fixture = path.join(integrationRoot, `g4-${mode.id}-${randomUUID()}`);
    const dataRoot = path.join(fixture, "sqlite-root");
    const workspace = path.join(fixture, "workspace");
    const settingsDirectory = path.join(fixture, "settings");
    let successful = false;
    let driver: Awaited<ReturnType<typeof openClaimOnlyDriver>> | undefined;
    const authorities: SqliteLifecycleMcpAuthority[] = [];
    const platformProbe = createPlatformProbe();
    try {
      mkdirSync(compiledCandidate, { recursive: true });
      if (existsSync(candidateSchema)) {
        assert.equal(readFileSync(candidateSchema, "utf8"), readFileSync(sourceSchema, "utf8"), "compiled schema must match source schema");
      } else {
        copyFileSync(sourceSchema, candidateSchema);
      }
      mkdirSync(workspace, { recursive: true });
      mkdirSync(settingsDirectory, { recursive: true });
      mkdirSync(dataRoot, { recursive: true });
      await initializeIsolatedCandidateRoot(dataRoot);
      const modules = await loadLifecycleCandidateModules();
      const setupStore = modules.Store.open(dataRoot);
      try {
        modules.createPort(setupStore).provisionCapacity({
          operation_id: `capacity-${randomUUID()}`,
          capacity_limit: 1,
          expected_generation: 0,
          maintenance: { dispatch_blocked: true, writers_drained: true },
        });
      } finally { setupStore.close(); }

      const trustedLocalContext = createTrustedLocalCandidateContext({ name: `g4-recovery-${mode.name}`, settingsDirectory });
      const taskId = `g4-recovery-${mode.name}-${randomUUID()}`;
      const operationId = candidateOperationId(taskId, 1);
      const task = syntheticTask(workspace, taskId) as unknown as Parameters<Awaited<ReturnType<typeof openClaimOnlyDriver>>["run"]>[0]["task"];
      let interrupted = false;
      let run: Awaited<ReturnType<NonNullable<typeof driver>["run"]>>;
      const workerEntryPath = path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js");
      const bridgeEntryPath = fileURLToPath(import.meta.url);
      const launchId = `launch-${randomUUID()}`;
      const launchToken = `token-${randomUUID()}-0123456789`;
      if (mode.separateManagerProcess) {
        const childScript = `
          import path from 'node:path';
          import { pathToFileURL } from 'node:url';
          const [dataRoot, settingsDirectory, workspace, taskJson, operationId, launchId, launchToken, workerEntryPath, bridgeEntryPath, interruptAt] = process.argv.slice(1);
          const gateModule = await import(pathToFileURL(path.join(process.cwd(), 'dist-test/src/store/lifecycle-gate.js')).href);
          const hostModule = await import(pathToFileURL(path.join(process.cwd(), 'dist-test/src/host/stdio.js')).href);
          const trustedLocalContext = hostModule.createTrustedLocalCandidateContext({ name: 'g4-recovery-subprocess', settingsDirectory });
          const driver = await gateModule.openClaimOnlyDriver({
            dataRoot, workerEntryPath, bridgeEntryPath, trustedLocalContext,
            testOnlyFakeAdapter: true,
            onStage(stage) { if (stage === interruptAt) throw new Error('controlled manager process interruption'); },
          });
          try {
            const task = JSON.parse(taskJson);
            driver.createTask(task);
            const run = await driver.run({ task, operationId, launchId, launchToken, attempt: 1 });
            process.stdout.write('G4_RECOVERY_FIXTURE=' + JSON.stringify({ run, interrupted: true }) + '\\n');
          } finally { driver.close(); }
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, dataRoot, settingsDirectory,
          workspace, JSON.stringify(task), operationId, launchId, launchToken, workerEntryPath, bridgeEntryPath, mode.interruptAt], {
          cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"],
        });
        let childStdout = "";
        let childStderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { childStdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { childStderr += chunk; });
        const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        assert.equal(status.code, 0, `the prior Manager process must exit cleanly; signal=${status.signal}; stderr=${childStderr}`);
        const fixtureLine = childStdout.split(/\r?\n/u).find((line) => line.startsWith("G4_RECOVERY_FIXTURE="));
        assert.ok(fixtureLine, `the prior Manager process must report its persisted boundary; stderr=${childStderr}`);
        const childResult = JSON.parse(fixtureLine.slice("G4_RECOVERY_FIXTURE=".length)) as { run: Awaited<ReturnType<NonNullable<typeof driver>["run"]>>; interrupted: boolean };
        interrupted = childResult.interrupted;
        run = childResult.run;
      } else {
        driver = await openClaimOnlyDriver({
          dataRoot, workerEntryPath, bridgeEntryPath, trustedLocalContext,
          testOnlyFakeAdapter: true,
          processProbe: platformProbe,
          testProcessProbeTimeoutMs: 5_000,
          onStage: (stage) => {
            if (!interrupted && stage === mode.interruptAt) {
              interrupted = true;
              throw new Error(`controlled manager interruption at ${stage}`);
            }
          },
        });
        driver.createTask(task);
        run = await driver.run({ task, operationId, launchId, launchToken, attempt: 1 });
      }
      assert.equal(interrupted, true, "the deterministic interruption point must be reached");
      assert.equal(run.state, "result_committed");
      assert.equal(run.cleanupState, "unknown");
      driver?.close();
      driver = undefined;

      const beforeRecovery = modules.Store.openForRecovery(dataRoot);
      assert.ok(beforeRecovery);
      try {
        const operation = modules.createPort(beforeRecovery).readOperation(operationId) as Record<string, unknown>;
        assert.equal(operation.phase, mode.expectedPhase, "restart fixture must preserve the intended durable boundary");
        assert.ok(operation.claim_id, "permanent Claim must remain recorded across restart");
        assert.ok(operation.result_commit_ref, "committed Result must remain bound across restart");
      } finally { beforeRecovery.close(); }

      let recoverySpawns = 0;
      if (mode.concurrent) {
        let arrivals = 0;
        let releaseProbe: (() => void) | undefined;
        const bothManagersAtProbe = new Promise<void>((resolve) => { releaseProbe = resolve; });
        const recoveryProbe: ProcessProbe = {
          ...platformProbe,
          probe: async (requests) => {
            arrivals += 1;
            if (arrivals === 2) releaseProbe?.();
            if (arrivals <= 2) await bothManagersAtProbe;
            return await platformProbe.probe(requests);
          },
        };
        const options = {
          dataRoot,
          workerEntryPath,
          bridgeEntryPath,
          trustedLocalContext,
          processProbe: recoveryProbe,
          testProcessProbeTimeoutMs: 5_000,
          onChildSpawn: () => { recoverySpawns += 1; },
        } as const;
        const concurrent = await Promise.allSettled([
          SqliteLifecycleMcpAuthority.create(options),
          SqliteLifecycleMcpAuthority.create(options),
        ]);
        for (const result of concurrent) if (result.status === "fulfilled") authorities.push(result.value);
          assert.ok(authorities.length > 0, "at least one concurrent Recovery manager must complete its fenced observation");
      } else {
        const authority = await SqliteLifecycleMcpAuthority.create({
          dataRoot,
          workerEntryPath,
          bridgeEntryPath,
          trustedLocalContext,
          processProbe: platformProbe,
          testProcessProbeTimeoutMs: 5_000,
          onChildSpawn: () => { recoverySpawns += 1; },
        });
        authorities.push(authority);
      }

      assert.equal(recoverySpawns, 0, "Recovery must never Spawn or Replay the committed Operation");
      const afterRecovery = modules.Store.openForRecovery(dataRoot);
      assert.ok(afterRecovery);
      try {
        const port = modules.createPort(afterRecovery);
        const operation = port.readOperation(operationId) as Record<string, unknown>;
        const snapshot = port.readRecoverySnapshot() as { capacity: Record<string, unknown>; operations: Array<Record<string, unknown>> };
        const recovered = snapshot.operations.find((row) => row.operation_id === operationId);
        assert.equal(operation.phase, mode.expectedPhase);
        assert.equal(recovered?.capacity_occupied, true);
        assert.equal(recovered?.claim_permanent, true, "Release frees only capacity and never reclaims the permanent Claim");
        assert.equal(snapshot.operations.filter((row) => row.capacity_occupied === true).length, 1);
        const events = port.readLifecycleEvents(operationId);
        assert.equal(events.filter((event) => event.event_type === "result_committed").length, 1);
        assert.equal(events.filter((event) => event.event_type === "cleanup_pending").length, mode.expectedPhase === "cleanup_pending" ? 1 : 0);
        assert.equal(events.filter((event) => event.event_type === "cleanup_verified").length, 0);
        assert.equal(events.filter((event) => event.event_type === "released").length, 0);
        const holds = events.filter((event) => event.event_type === "observation_recorded")
          .map((event) => JSON.parse(String(event.evidence_json)) as Record<string, unknown>)
          .filter((evidence) => evidence.reason === "recovery_hold");
        assert.ok(holds.length >= 1);
        assert.ok(holds.some((evidence) => evidence.reason_code === "cleanup_incomplete"));
      } finally { afterRecovery.close(); }

        // Reopen once more as a second restart: the persisted Hold remains
        // occupied and Recovery does not infer Cleanup or Release.
      for (const authority of authorities) await authority.shutdown();
      authorities.length = 0;
      const repeated = await SqliteLifecycleMcpAuthority.create({
        dataRoot,
        workerEntryPath,
        bridgeEntryPath,
        trustedLocalContext,
        processProbe: platformProbe,
        testProcessProbeTimeoutMs: 5_000,
      });
      authorities.push(repeated);
      const afterRepeat = modules.Store.openForRecovery(dataRoot);
      assert.ok(afterRepeat);
      try {
        const events = modules.createPort(afterRepeat).readLifecycleEvents(operationId);
          assert.equal(events.filter((event) => event.event_type === "cleanup_verified").length, 0);
          assert.equal(events.filter((event) => event.event_type === "released").length, 0);
      } finally { afterRepeat.close(); }
      successful = true;
    } finally {
      for (const authority of authorities) await authority.shutdown().catch(() => undefined);
      driver?.close();
      if (successful) rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test("formal MCP Manager routes SQLite Create/Worker/Result/Continue/Events/Feedback without JSON writes", { timeout: 90_000 }, async () => {
  const stages: Array<{ stage: string; detail?: Readonly<Record<string, unknown>> }> = [];
  await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
    const taskId = `mcp-task-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.task_id, taskId);
    assert.equal(created.status, "queued");
    const firstStatus = await waitForTerminal(client, taskId, 1);
    assert.equal(firstStatus.status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const firstResult = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(firstResult.status, "completed");
    const firstEvents = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const firstCursor = Number(firstEvents.next_seq);
    assert.ok(firstCursor > 0);
    const feedback = contentObject(await client.callTool({ name: "zcode_feedback", arguments: { task_id: taskId } }));
    assert.equal(feedback.task_id, taskId);
    assert.equal(feedback.attempt, 1);

    const continueId = `continue-${randomUUID()}`;
    const continuation = { task_id: taskId, feedback: "Apply the next synthetic attempt", operation_id: continueId };
    const nextReceipt = contentObject(await client.callTool({ name: "zcode_continue", arguments: continuation }), JSON.stringify(stages));
    assert.equal(nextReceipt.task_id, taskId);
    assert.equal(nextReceipt.status, "queued");
    stages.push({ stage: "continue_status_after_commit", detail: contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } })) });
    const replay = contentObject(await client.callTool({ name: "zcode_continue", arguments: continuation }));
    assert.equal(replay.task_id, taskId, "same idempotency key must return the original queued Attempt");
    assert.equal((await waitForTerminal(client, taskId, 2, JSON.stringify(stages))).status, "completed");
    assert.equal(stages.filter(({ stage, detail }) => stage === "manager_dispatch_dequeued" && detail?.attempt === 2).length, 1,
      "an idempotent Continue replay must not dispatch the same Attempt twice");
    const nextEvents = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: firstCursor, limit: 200 } }));
    assert.ok(Array.isArray(nextEvents.events) && nextEvents.events.length > 0, "task-wide cursor must continue across Attempts");
    assert.ok((nextEvents.events as Array<Record<string, unknown>>).every((event) => Number(event.seq) > firstCursor));
    assert.equal(existsSync(path.join(dataRoot, ".tasks")), false, "SQLite lifecycle must not write JSON TaskStore state");
  }, { onStage: (stage, detail) => stages.push({ stage, detail }), testOnScheduler: (stage, detail) => stages.push({ stage: `manager_${stage}`, detail }) });
});

test("SQLite preserves JSON workspace semantics and the Host-selected execution worktree", { timeout: 90_000 }, async () => {
  const stages: Array<{ stage: string; detail?: Readonly<Record<string, unknown>> }> = [];
  await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
    const fixtureRoot = path.dirname(workspace);
    const sourceWorkspace = path.join(fixtureRoot, "source-project");
    const executionWorktree = path.join(fixtureRoot, "execution-worktree");
    mkdirSync(sourceWorkspace, { recursive: true });
    mkdirSync(executionWorktree, { recursive: true });
    const sourceWorkspaceForwardSlash = sourceWorkspace.replaceAll("\\", "/");
    const executionWorktreeForwardSlash = executionWorktree.replaceAll("\\", "/");

    const taskId = `mcp-worktree-${randomUUID()}`;
    const invalid = await client.callTool({
      name: "zcode_task",
      arguments: {
        ...syntheticTask(sourceWorkspaceForwardSlash, `mcp-null-worktree-${randomUUID()}`),
        worktree_path: null,
      },
    });
    assert.equal(invalid.isError, true, "null worktree_path must fail closed before Admission");

    const created = contentObject(await client.callTool({
      name: "zcode_task",
      arguments: {
        ...syntheticTask(sourceWorkspaceForwardSlash, taskId),
        worktree_path: executionWorktreeForwardSlash,
      },
    }), JSON.stringify(stages));
    assert.equal(created.status, "queued");
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");

    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(dataRoot);
    assert.ok(recovery);
    try {
      const lifecycle = recovery.readTaskLifecycle(taskId) as Record<string, unknown>;
      const storedTask = lifecycle.task as Record<string, unknown>;
      assert.equal(path.resolve(String(storedTask.workspace)), path.resolve(sourceWorkspace));
      assert.equal(path.resolve(String(storedTask.worktree_path)), path.resolve(executionWorktree));
      assert.equal(
        (lifecycle.operation as Record<string, unknown>).workspace_ref,
        path.resolve(executionWorktree),
        "Admission must use the execution worktree while retaining the source project",
      );
    } finally {
      recovery.close();
    }

    const continued = contentObject(await client.callTool({
      name: "zcode_continue",
      arguments: {
        task_id: taskId,
        feedback: "Continue in the same Host-selected execution worktree",
        operation_id: `continue-worktree-${randomUUID()}`,
      },
    }), JSON.stringify(stages));
    assert.equal(continued.status, "queued");
    assert.equal((await waitForTerminal(client, taskId, 2, JSON.stringify(stages))).status, "completed");

    const workerStages = stages.filter(({ stage }) => stage === "worker_report_read_complete");
    assert.equal(workerStages.length, 2, "both Attempts must report through the real lifecycle gate");
    assert.ok(workerStages.every(({ detail }) => detail?.workspace_ref === path.resolve(executionWorktree)),
      "the Worker-facing canonical path must remain the Host-selected execution worktree");

    const nextRecovery = modules.Store.openForRecovery(dataRoot);
    assert.ok(nextRecovery);
    try {
      const nextPort = modules.createPort(nextRecovery);
      for (const attempt of [1, 2]) {
        const operation = nextPort.readOperation(candidateOperationId(taskId, attempt)) as Record<string, unknown>;
        assert.equal(operation.workspace_ref, path.resolve(executionWorktree));
      }
      const lifecycle = nextRecovery.readTaskLifecycle(taskId) as Record<string, unknown>;
      assert.equal(path.resolve(String((lifecycle.task as Record<string, unknown>).worktree_path)), path.resolve(executionWorktree),
        "Continue must retain the recorded execution worktree");
    } finally {
      nextRecovery.close();
    }
  }, {
    onStage: (stage, detail) => stages.push({ stage, detail }),
    onChildSpawn: () => undefined,
  });
});

test("SQLite validates both source workspace and execution worktree immediately before Spawn", { timeout: 90_000 }, async () => {
  for (const removed of ["workspace", "worktree_path"] as const) {
    let directoryToRemove: string | undefined;
    let spawnCount = 0;
    const stages: Array<{ stage: string; detail?: Readonly<Record<string, unknown>> }> = [];
    await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
      const fixtureRoot = path.dirname(workspace);
      const sourceWorkspace = path.join(fixtureRoot, "source-project");
      const executionWorktree = path.join(fixtureRoot, "execution-worktree");
      mkdirSync(sourceWorkspace, { recursive: true });
      mkdirSync(executionWorktree, { recursive: true });
      directoryToRemove = removed === "workspace" ? sourceWorkspace : executionWorktree;

      const taskId = `mcp-ws-${removed === "workspace" ? "source" : "exec"}-${randomUUID()}`;
      const created = contentObject(await client.callTool({
        name: "zcode_task",
        arguments: {
          ...syntheticTask(sourceWorkspace, taskId),
          worktree_path: executionWorktree,
        },
      }));
      assert.equal(created.status, "queued");
      const operationId = candidateOperationId(taskId, 1);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !stages.some(({ stage, detail }) =>
        stage === "run_complete" && detail?.operation_id === operationId)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const completedRun = stages.find(({ stage, detail }) =>
        stage === "run_complete" && detail?.operation_id === operationId);
      assert.ok(completedRun, `${removed} must reach a fail-closed pre-Spawn decision`);
      assert.equal(completedRun.detail?.state, "launch_outcome_unknown");
      assert.equal(completedRun.detail?.reason, "trusted_local_workspace_use_denied",
        `${removed} must be revalidated immediately before Worker Spawn`);
      assert.equal(completedRun.detail?.spawnCount, 0);
      assert.equal(spawnCount, 0, `removing ${removed} must prevent Worker Spawn`);
      const status = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
      assert.equal(status.status, "queued", "a fail-closed pre-Spawn result must not invent a terminal Worker Result");

      const modules = await loadLifecycleCandidateModules();
      const recovery = modules.Store.openForRecovery(dataRoot);
      assert.ok(recovery);
      try {
        const operation = modules.createPort(recovery).readOperation(operationId) as Record<string, unknown>;
        assert.equal(operation.phase, "launch_intent", "the launch intent remains durably occupied");
        assert.notEqual(operation.capacity_slot, null, "an unverified launch path must retain Capacity");
      } finally {
        recovery.close();
      }
    }, {
      onStage: (stage, detail) => {
        stages.push({ stage, detail });
        // Remove after durable Admission and Launch Intent, immediately before
        // the production pre-Spawn revalidation.
        if (stage === "intent_complete" && directoryToRemove) {
          rmSync(directoryToRemove, { recursive: true, force: true });
          directoryToRemove = undefined;
        }
      },
      onChildSpawn: () => { spawnCount += 1; },
    });
  }
});

test("startup dispatches only the persisted current queued Attempt and resumes its untouched reserved Operation", { timeout: 90_000 }, async () => {
  const queuedTaskId = `recovery-queued-${randomUUID()}`;
  const reservedTaskId = `recovery-reserved-${randomUUID()}`;
  const cancelledTaskId = `recovery-cancelled-${randomUUID()}`;
  let spawnCount = 0;
  await withSqliteMcp(async (client, _manager, dataRoot) => {
    const queued = await waitForTerminal(client, queuedTaskId, 1);
    const resumed = await waitForTerminal(client, reservedTaskId, 1);
    assert.equal(queued.status, "completed");
    assert.equal(resumed.status, "completed");
    await waitForLifecycleEvent(client, queuedTaskId, "released");
    await waitForLifecycleEvent(client, reservedTaskId, "released");
    const cancelled = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: cancelledTaskId } }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(spawnCount, 2, "cancelled queued Attempts must not Spawn");
    const modules = await loadLifecycleCandidateModules();
    const store = modules.Store.openForRecovery(dataRoot);
    assert.ok(store);
    try {
      const port = modules.createPort(store);
      const operationId = candidateOperationId(reservedTaskId, 1);
      const events = port.readLifecycleEvents(operationId);
      assert.equal(events.filter((event) => event.event_type === "reserved").length, 1,
        "startup must continue the existing reserved Operation, not create a replacement");
      assert.equal(events.at(-1)?.event_type, "released");
      assert.equal((port.readTaskLifecycle(cancelledTaskId) as { readonly operation: unknown } | null)?.operation, null);
    } finally { store.close(); }
  }, {
    beforeAuthority: (dataRoot, modules, workspace) => {
      const store = modules.Store.open(dataRoot);
      try {
        const port = modules.createPort(store);
        port.createTask(syntheticTask(workspace, queuedTaskId) as unknown as Parameters<typeof port.createTask>[0]);
        port.createTask(syntheticTask(workspace, reservedTaskId) as unknown as Parameters<typeof port.createTask>[0]);
        port.createTask(syntheticTask(workspace, cancelledTaskId) as unknown as Parameters<typeof port.createTask>[0]);
        const settingsDirectory = path.join(path.dirname(workspace), "settings");
        const trustedPolicy = createTrustedLocalCandidateContext({ name: "sqlite-recovery-fixture", settingsDirectory }).policy;
        port.admitOperation({ operation_id: candidateOperationId(reservedTaskId, 1), task_id: reservedTaskId,
          attempt: 1, workspace_ref: workspace }, {
          workspaceValidator: trustedPolicy.validateWorkspace,
          executionPermissionCheck: trustedPolicy.checkPermission,
        });
        port.cancelQueuedAttempt({ task_id: cancelledTaskId, expected_attempt: 1 });
      } finally { store.close(); }
    },
    onChildSpawn: () => { spawnCount += 1; },
  });
});

test("formal MCP Continue survives Manager shutdown before Spawn and is dispatched once by the restarted Manager", { timeout: 120_000 }, async () => {
  let holdNextDispatch = false;
  let announceHeldDispatch!: () => void;
  let releaseHeldDispatch!: () => void;
  const heldDispatch = new Promise<void>((resolve) => { announceHeldDispatch = resolve; });
  const dispatchGate = new Promise<void>((resolve) => { releaseHeldDispatch = resolve; });
  let priorManagerSpawns = 0;
  let restartedManagerSpawns = 0;
  const restarted = {
    manager: null as BridgeTaskManager | null,
    server: null as ReturnType<typeof createBridgeServer> | null,
    client: null as Client | null,
  };
  try {
    await withSqliteMcp(async (client, manager, dataRoot, workspace) => {
      const taskId = `recovery-continue-${randomUUID()}`;
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
      assert.equal(created.status, "queued");
      assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
      await waitForLifecycleEvent(client, taskId, "released");
      holdNextDispatch = true;
      const continued = contentObject(await client.callTool({ name: "zcode_continue", arguments: {
        task_id: taskId, feedback: "resume queued attempt after Manager restart", operation_id: `continue-${randomUUID()}`,
      } }));
      assert.equal(continued.status, "queued");
      await Promise.race([heldDispatch, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispatch did not reach deterministic hold")), 5_000))]);

      await manager.shutdown();
      releaseHeldDispatch();

      const settingsDirectory = path.join(path.dirname(dataRoot), "settings");
      const authority = await SqliteLifecycleMcpAuthority.create({
        dataRoot,
        workerEntryPath: path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js"),
        bridgeEntryPath: fileURLToPath(import.meta.url),
        trustedLocalContext: createTrustedLocalCandidateContext({ name: "sqlite-mcp-restart-test", settingsDirectory }),
        onChildSpawn: () => { restartedManagerSpawns += 1; },
        testOnlyFakeAdapter: true,
      });
      restarted.manager = new BridgeTaskManager({ lifecycleAuthority: authority });
      restarted.server = createBridgeServer({ taskManager: restarted.manager });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      restarted.client = new Client({ name: "sqlite-lifecycle-restart-test", version: "0.0.1" });
      await Promise.all([restarted.server.connect(serverTransport), restarted.client.connect(clientTransport)]);
      assert.equal((await waitForTerminal(restarted.client, taskId, 2)).status, "completed");
      await waitForLifecycleEvent(restarted.client, taskId, "released");
      assert.equal(priorManagerSpawns, 1, "the closed Manager must not Spawn after its dispatch gate resumes");
      assert.equal(restartedManagerSpawns, 1, "the restarted Manager must Spawn the persisted queued Attempt exactly once");
      const result = contentObject(await restarted.client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
      assert.equal(result.status, "completed");
      const modules = await loadLifecycleCandidateModules();
      const store = modules.Store.openForRecovery(dataRoot);
      assert.ok(store);
      try {
        const port = modules.createPort(store);
        const events = port.readTaskEvents(taskId).events;
        const attemptTwo = events.filter((event) => event.operation_attempt === 2);
        assert.equal(attemptTwo.filter((event) => event.event_type === "reserved").length, 1);
        assert.equal(attemptTwo.filter((event) => event.event_type === "launch_intent").length, 1);
        assert.equal(attemptTwo.filter((event) => event.event_type === "claim_committed").length, 1);
        const lifecycle = port.readTaskLifecycle(taskId) as { readonly projection: Readonly<Record<string, unknown>> } | null;
        assert.equal(lifecycle?.projection.current_attempt, 2);
      } finally { store.close(); }
      assert.equal(existsSync(path.join(dataRoot, ".tasks")), false);
    }, {
      testBeforeDispatch: async () => {
        if (!holdNextDispatch) return;
        announceHeldDispatch();
        await dispatchGate;
      },
      onChildSpawn: () => { priorManagerSpawns += 1; },
    });
  } finally {
    releaseHeldDispatch();
    await restarted.client?.close().catch(() => undefined);
    await restarted.server?.close().catch(() => undefined);
    await restarted.manager?.shutdown().catch(() => undefined);
  }
});

test("formal MCP queued Cancel is persisted before SQLite dispatch and does not spawn a Worker", { timeout: 30_000 }, async () => {
  let announce!: () => void;
  let unblock!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => { announce = resolve; });
  const dispatchGate = new Promise<void>((resolve) => { unblock = resolve; });
  await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
    const taskId = `mcp-cancel-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.status, "queued");
    await dispatchStarted;
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.attempt, 1);
    assert.equal(existsSync(path.join(dataRoot, ".tasks")), false, "queued cancellation must remain SQLite-only");
  }, { testBeforeDispatch: async () => { announce(); await dispatchGate; } }).finally(() => unblock());
});

test("formal MCP running Cancel persists intent, verifies the Worker tree, and releases only after Cleanup", { timeout: 60_000 }, async () => {
  const tracePath = process.env["WP6_RUNNING_CANCEL_TRACE_PATH"];
  const trace = (name: string, detail?: unknown): void => {
    if (tracePath) appendFileSync(tracePath, `${new Date().toISOString()} ${name} ${JSON.stringify(redactTestDiagnostic(detail ?? null))}\n`, "utf8");
  };
  await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
    const taskId = `mcp-running-cancel-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.status, "queued");
    trace("created", { taskId });
    let request: Record<string, unknown>;
    try {
      request = await waitForInteractionRequest(client, taskId);
    } catch (error) {
      const status = await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } });
      const page = await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } });
      trace("interaction-wait-failed", { taskId, status, page, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    trace("interaction-request-ready", { taskId, event: request });
    assert.equal((request.details as Record<string, unknown>).method, "interaction/requestUserInput");

    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.attempt, 1);
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
    const events = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const lifecycle = events.events as Array<Record<string, unknown>>;
    const cancelIntent = lifecycle.find((event) => event.type === "observation_recorded"
      && (event.details as Record<string, unknown> | undefined)?.reason === "cancel_requested");
    const cancelProof = lifecycle.find((event) => event.type === "observation_recorded"
      && (event.details as Record<string, unknown> | undefined)?.reason === "cancel_tree_verified");
    const resultIndex = lifecycle.findIndex((event) => event.type === "result_committed");
    const cleanupIndex = lifecycle.findIndex((event) => event.type === "cleanup_pending");
    const releaseIndex = lifecycle.findIndex((event) => event.type === "released");
    assert.ok(cancelIntent, "Cancel Intent must be persisted before the cancelled Result");
    assert.ok(cancelProof, "verified process-tree evidence must be persisted before the cancelled Result");
    assert.ok(resultIndex > lifecycle.indexOf(cancelProof));
    assert.ok(cleanupIndex > resultIndex);
    assert.ok(releaseIndex > cleanupIndex);
    assert.equal((cancelIntent.details as Record<string, unknown>).claim_id,
      (cancelProof.details as Record<string, unknown>).claim_id);
    assert.equal(existsSync(path.join(dataRoot, ".tasks")), false, "running cancellation must remain SQLite-only");
  }, {
    enableSyntheticInteractionChannel: true,
    preserveFixtureOnFailure: true,
    onStage: (stage, detail) => trace(`manager:${stage}`, detail),
    onChildSpawn: (child) => {
      trace("child-spawned");
      child.stderr?.on("data", (chunk: Buffer | string) => trace("worker-stderr", chunk.toString().trim()));
    },
  });
});

test("formal MCP Host shutdown cancels an active Worker and closes only after verified Cleanup and Release", { timeout: 90_000 }, async () => {
  const tracePath = process.env["WP6_RUNNING_CANCEL_TRACE_PATH"];
  const trace = (name: string, detail?: unknown): void => {
    if (tracePath) appendFileSync(tracePath, `${new Date().toISOString()} ${name} ${JSON.stringify(redactTestDiagnostic(detail ?? null))}\n`, "utf8");
  };
  const restarted = { manager: null as BridgeTaskManager | null, server: null as ReturnType<typeof createBridgeServer> | null, client: null as Client | null };
  let spawned = 0;
  try {
    await withSqliteMcp(async (client, manager, dataRoot, workspace) => {
      const taskId = `mcp-shutdown-${randomUUID()}`;
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
      assert.equal(created.status, "queued");
      trace("created", { taskId });
      try {
        const request = await waitForInteractionRequest(client, taskId);
        trace("interaction-request-ready", { taskId, event: request });
      } catch (error) {
        const status = await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } });
        const page = await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } });
        trace("interaction-wait-failed", { taskId, status, page, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }

      trace("host-shutdown-start", { taskId });
      await manager.shutdown();
      trace("host-shutdown-complete", { taskId });

      const settingsDirectory = path.join(path.dirname(dataRoot), "settings");
      const authority = await SqliteLifecycleMcpAuthority.create({
        dataRoot,
        workerEntryPath: path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js"),
        bridgeEntryPath: fileURLToPath(import.meta.url),
        trustedLocalContext: createTrustedLocalCandidateContext({ name: "sqlite-shutdown-reopen-test", settingsDirectory }),
        onChildSpawn: () => { spawned += 100; },
      });
      restarted.manager = new BridgeTaskManager({ lifecycleAuthority: authority });
      restarted.server = createBridgeServer({ taskManager: restarted.manager });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      restarted.client = new Client({ name: "sqlite-shutdown-reopen-test", version: "0.0.1" });
      await Promise.all([restarted.server.connect(serverTransport), restarted.client.connect(clientTransport)]);

      const status = contentObject(await restarted.client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
      assert.equal(status.status, "cancelled");
      const result = contentObject(await restarted.client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
      assert.equal(result.status, "cancelled");
      await waitForLifecycleEvent(restarted.client, taskId, "released");
      const events = contentObject(await restarted.client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
      const lifecycle = events.events as Array<Record<string, unknown>>;
      assert.ok(lifecycle.findIndex((event) => event.type === "result_committed") < lifecycle.findIndex((event) => event.type === "cleanup_verified"));
      assert.ok(lifecycle.findIndex((event) => event.type === "cleanup_verified") < lifecycle.findIndex((event) => event.type === "released"));
      assert.equal(spawned, 1, "the original Host must Spawn once and the restarted Manager must not Spawn the cancelled Attempt again");
    }, {
      enableSyntheticInteractionChannel: true,
      preserveFixtureOnFailure: true,
      onStage: (stage, detail) => trace(`manager:${stage}`, detail),
      onChildSpawn: (child) => {
        spawned += 1;
        trace("child-spawned");
        child.stderr?.on("data", (chunk: Buffer | string) => trace("worker-stderr", chunk.toString().trim()));
      },
    });
  } finally {
    await restarted.client?.close().catch(() => undefined);
    await restarted.server?.close().catch(() => undefined);
    await restarted.manager?.shutdown().catch(() => undefined);
  }
});

test("formal MCP Host shutdown lets a committed Result finish Cleanup without cancelling the terminal Attempt", { timeout: 45_000 }, async () => {
  let managerForStage: BridgeTaskManager | undefined;
  let resultProjectionVerified = false;
  let shutdownAtResultProjection: Promise<void> | undefined;
  await withSqliteMcp(async (_client, manager, dataRoot, workspace) => {
    managerForStage = manager;
    const taskId = `mcp-released-shutdown-race-${randomUUID()}`;
    const created = contentObject(await _client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.status, "queued");

    const deadline = Date.now() + 15_000;
    while (!resultProjectionVerified && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(resultProjectionVerified, true, "the controlled run must commit its Result before Cleanup completes");
    assert.ok(shutdownAtResultProjection, "the Result commit boundary must initiate Host shutdown");
    await shutdownAtResultProjection;

    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(dataRoot);
    assert.ok(recovery);
    try {
      const lifecycle = recovery.readTaskLifecycle(taskId) as Record<string, unknown>;
      const projection = lifecycle.projection as Record<string, unknown>;
      const operation = lifecycle.operation as Record<string, unknown>;
      assert.equal(projection.status, "completed", "the Result must remain terminal after shutdown");
      assert.equal(operation.phase, "released", "verified Cleanup and Capacity Release must remain durable");
    } finally {
      recovery.close();
    }
  }, {
    testShutdownWaitMs: 10_000,
    preserveFixtureOnFailure: true,
    onStage: (stage) => {
      if (stage !== "result_projection_verified" || resultProjectionVerified) return;
      resultProjectionVerified = true;
      assert.ok(managerForStage, "the Manager must be available after Result commit");
      shutdownAtResultProjection = managerForStage.shutdown();
    },
  });
});

test("formal MCP Host shutdown is bounded on unknown cancellation and can be retried after verified Cleanup", { timeout: 45_000, skip: process.platform !== "win32" }, async () => {
  const tracePath = process.env["WP6_SHUTDOWN_RETRY_TRACE_PATH"];
  const trace = (name: string, detail?: unknown): void => {
    if (tracePath) appendFileSync(tracePath, `${new Date().toISOString()} ${name} ${JSON.stringify(redactTestDiagnostic(detail ?? null))}\n`, "utf8");
  };
  const platformProbe = createPlatformProbe();
  let probeCalls = 0;
  let injectUnknownOnNextProbe = false;
  let shutdownUnknownObserved = false;
  const processProbe: ProcessProbe = {
    platform: platformProbe.platform,
    identityOf: (pid) => platformProbe.identityOf(pid),
    selfIdentity: () => platformProbe.selfIdentity(),
    probe: async (requests) => {
      probeCalls += 1;
      trace("process-probe", { probeCalls, injectUnknownOnNextProbe });
      if (injectUnknownOnNextProbe) {
        injectUnknownOnNextProbe = false;
        shutdownUnknownObserved = true;
        return requests.map(() => ({ state: "unknown", reason_code: "synthetic_shutdown_identity_unknown", observed_at: new Date().toISOString() }));
      }
      return platformProbe.probe(requests);
    },
  };
  let runReturnedResolve: (() => void) | undefined;
  const runReturned = new Promise<void>((resolve) => { runReturnedResolve = resolve; });
  await withSqliteMcp(async (client, manager, _dataRoot, workspace) => {
    const taskId = `mcp-shutdown-retry-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    trace("created", created);
    assert.equal(created.status, "queued");
    await waitForInteractionRequest(client, taskId);
    trace("interaction-request-ready", { probeCalls: probeCalls });

    injectUnknownOnNextProbe = true;
    const start = Date.now();
    trace("first-shutdown-start", { waitMs: 150 });
    await assert.rejects(manager.shutdown(), /shutdown_worker_wait_timeout/u);
    trace("first-shutdown-rejected", { elapsedMs: Date.now() - start, shutdownUnknownObserved });
    assert.ok(Date.now() - start < 2_000, "unknown cancellation must not leave graceful shutdown waiting without a bound");
    assert.equal(shutdownUnknownObserved, true, "the controlled shutdown identity probe must return Unknown");
    const retained = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
    trace("status-after-first-shutdown", retained);
    assert.equal(retained.status, "running", "unverified shutdown must retain the persisted running fact");

    const cancellation = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    trace("cancel-returned", cancellation);
    assert.equal(cancellation.status, "cancelled", "a later fresh identity/cleanup proof may safely complete cancellation");
    await waitForLifecycleEvent(client, taskId, "released");
    trace("released-event-read");
    await runReturned;
    trace("driver-run-returned");
    await manager.shutdown();
    trace("second-shutdown-closed");
  }, {
    enableSyntheticInteractionChannel: true,
    processProbe,
    testShutdownWaitMs: 150,
    onStage: (stage, detail) => {
      trace(`worker-stage:${stage}`, detail);
    },
    testOnScheduler: (stage, detail) => {
      trace(`manager-stage:${stage}`, detail);
      if (stage === "driver_run_returned") runReturnedResolve?.();
    },
  });
});

test("formal SQLite MCP stdio shutdown closes only after verified Cleanup and Release", { timeout: 90_000, skip: process.platform !== "win32" }, async () => {
  let host: StdioLifecycleHost | undefined;
  let spawned = 0;
  await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
    const taskId = `mcp-stdio-shutdown-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.status, "queued");
    await waitForInteractionRequest(client, taskId);
    assert.ok(host);
    assert.equal(await host.shutdown("SIGTERM"), true, "successful Cleanup/Release must complete before transport close");

    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(dataRoot);
    assert.ok(recovery);
    try {
      const port = modules.createPort(recovery);
      const projection = port.readTaskProjection(taskId) as Record<string, unknown>;
      assert.equal(projection.status, "cancelled");
      const events = port.readTaskEvents(taskId).events as Array<Record<string, unknown>>;
      const resultIndex = events.findIndex((event) => event.event_type === "result_committed");
      const cleanupIndex = events.findIndex((event) => event.event_type === "cleanup_verified");
      const releaseIndex = events.findIndex((event) => event.event_type === "released");
      assert.ok(resultIndex >= 0 && resultIndex < cleanupIndex && cleanupIndex < releaseIndex,
        "the persisted cancellation Result must precede verified Cleanup and Release");
      assert.equal(events.filter((event) => event.event_type === "released").length, 1);
      assert.equal(spawned, 1, "shutdown must not Spawn or Replay another Attempt");
    } finally {
      recovery.close();
    }
  }, {
    stdio: true,
    preserveFixtureOnFailure: true,
    onStdioHost: (value) => { host = value; },
    enableSyntheticInteractionChannel: true,
    onChildSpawn: () => { spawned += 1; },
  });
});

test("stdio remains queryable after Unknown Shutdown and an existing Worker can commit before retry", { timeout: 90_000, skip: process.platform !== "win32" }, async () => {
  const platformProbe = createPlatformProbe();
  let returnUnknown = false;
  let unknownObserved = false;
  const identityTrace: Array<Record<string, unknown>> = [];
  const launchTrace: Array<Record<string, unknown>> = [];
  const tracePath = process.env.WP6_STDIO_UNKNOWN_TRACE_PATH;
  const diagnosticCallTool = async (
    client: Client,
    request: Parameters<Client["callTool"]>[0],
  ): Promise<unknown> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        client.callTool(request),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("diagnostic MCP query timed out after 2000ms")), 2_000);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const writeDiagnostic = (value: unknown): void => {
    if (!tracePath) return;
    try {
      writeFileSync(tracePath, JSON.stringify(redactTestDiagnostic(value), null, 2) + "\n", "utf8");
    } catch (error) {
      console.error(`[stdio-unknown] failed to persist diagnostic: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const recordLaunchStage = (stage: string, detail?: Readonly<Record<string, unknown>>): void => {
    launchTrace.push({
      at: new Date().toISOString(),
      stage,
      detail: detail ? {
        state: detail.state ?? null,
        reason: detail.reason ?? null,
        phase: detail.phase ?? null,
        revision: detail.revision ?? null,
        generation: detail.generation ?? null,
        attempt: detail.attempt ?? null,
        spawn_count: detail.spawnCount ?? null,
      } : null,
    });
  };
  const recordChildStderr = (chunk: Buffer | string): void => {
    launchTrace.push({
      at: new Date().toISOString(),
      stage: "worker_stderr",
      detail: { message: chunk.toString().trim() },
    });
  };
  const processProbe: ProcessProbe = {
    platform: platformProbe.platform,
    identityOf: (pid) => platformProbe.identityOf(pid),
    selfIdentity: () => platformProbe.selfIdentity(),
    probe: async (requests) => {
      if (returnUnknown) {
        returnUnknown = false;
        unknownObserved = true;
        identityTrace.push({
          at: new Date().toISOString(),
          phase: "synthetic_unknown",
          request_count: requests.length,
          identities_supplied: requests.filter((request) => request.identity !== undefined).length,
        });
        return requests.map(() => ({ state: "unknown", reason_code: "m3_synthetic_identity_unknown", observed_at: new Date().toISOString() }));
      }
      const verdicts = await platformProbe.probe(requests);
      identityTrace.push({
        at: new Date().toISOString(),
        phase: "os_probe",
        requests: requests.map(({ pid, identity }) => ({
          pid_present: Number.isSafeInteger(pid),
          fingerprint_present: Boolean(identity?.fingerprint),
          precision: identity?.fingerprint_precision ?? null,
        })),
        verdicts: verdicts.map(({ state, reason_code }) => ({ state, reason_code })),
      });
      return verdicts;
    },
  };
  let host: StdioLifecycleHost | undefined;
  let spawned = 0;
  await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
    const taskId = `mcp-stdio-unknown-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.status, "queued");
    let interaction: Record<string, unknown>;
    try {
      interaction = await waitForInteractionRequest(client, taskId);
    } catch (error) {
      const status = await diagnosticCallTool(client, { name: "zcode_status", arguments: { task_id: taskId } });
      const page = await diagnosticCallTool(client, { name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } });
      writeDiagnostic({
        task_id: taskId,
        failure_stage: "wait_for_interaction_request",
        error: error instanceof Error ? error.message : String(error),
        data_root_identifier: path.basename(path.dirname(dataRoot)),
        database_file_name: path.basename(dataRoot),
        status,
        page,
        events: identityTrace,
        launch_stages: launchTrace,
      });
      throw error;
    }
    returnUnknown = true;
    assert.ok(host);
    assert.equal(await host.shutdown("SIGTERM"), false, "Unknown Cleanup must retain Host and stdio transport");
    assert.equal(unknownObserved, true);

    const status = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
    assert.equal(status.status, "running", "Unknown shutdown must preserve the last committed Task fact");
    const rejected = await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, `blocked-after-shutdown-${randomUUID()}`) });
    assert.equal(rejected.isError, true, "new Admission must remain fenced while shutdown is unresolved");
    assert.match(JSON.stringify(rejected), /shutting down/u);

    const details = interaction.details as Record<string, unknown>;
    const requestId = String(details.request_id);
    const reply = contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: {
      task_id: taskId,
      request_id: requestId,
      decision: "accept",
      answers: { "Synthetic interaction response": "complete during shutdown hold" },
    } }));
    assert.equal(reply.state, "answered", "an existing Worker interaction remains usable while the Root is held");
    const terminal = await waitForTerminal(client, taskId, 1);
    assert.ok(["completed", "cancelled"].includes(String(terminal.status)), "the real Result/Cancel race winner must remain visible");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, terminal.status, "persisted Result must agree with the authoritative Task projection");
    try {
      await waitForLifecycleEvent(client, taskId, "released");
    } catch (error) {
      writeDiagnostic({
        task_id: taskId,
        failure_stage: "wait_for_released",
        error: error instanceof Error ? error.message : String(error),
        data_root_identifier: path.basename(path.dirname(dataRoot)),
        database_file_name: path.basename(dataRoot),
        events: identityTrace,
        launch_stages: launchTrace,
      });
      throw error;
    }

    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(dataRoot);
    assert.ok(recovery);
    try {
      const events = modules.createPort(recovery).readTaskEvents(taskId).events as Array<Record<string, unknown>>;
      const resultIndex = events.findIndex((event) => event.event_type === "result_committed");
      const cleanupIndex = events.findIndex((event) => event.event_type === "cleanup_verified");
      const releaseIndex = events.findIndex((event) => event.event_type === "released");
      assert.ok(resultIndex >= 0 && resultIndex < cleanupIndex && cleanupIndex < releaseIndex,
        "Worker Result, verified Cleanup and Release must remain writable during the connected Unknown window");
      assert.equal(events.filter((event) => event.event_type === "result_committed").length, 1);
      assert.equal(events.filter((event) => event.event_type === "released").length, 1);
    } finally {
      recovery.close();
    }
    assert.equal(spawned, 1, "shutdown retry must not repeat Spawn");
    assert.equal(await host.shutdown("SIGTERM"), true, "a second bounded Shutdown must close after the active Worker has safely released");
  }, {
    stdio: true,
    preserveFixtureOnFailure: true,
    onStdioHost: (value) => { host = value; },
    enableSyntheticInteractionChannel: true,
    processProbe,
    testShutdownWaitMs: 500,
    onStage: recordLaunchStage,
    onChildSpawn: (child) => {
      spawned += 1;
      child.stderr?.on("data", recordChildStderr);
    },
  });
});

test("stdio EOF attempts graceful shutdown without promising a disconnected query channel", { timeout: 30_000 }, async () => {
  let completedReason: string | undefined;
  let host: StdioLifecycleHost | undefined;
  await withSqliteMcp(async (client) => {
    const status = await client.callTool({ name: "zcode_status", arguments: { task_id: "m3-eof-unknown-task" } });
    assert.equal(status.isError, true);
    await client.close();
    const deadline = Date.now() + 5_000;
    while (completedReason === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(completedReason, "EOF", "stdin EOF must run the bounded Manager shutdown path");
    assert.ok(host);
    assert.equal(await host.shutdown("SIGTERM"), true, "EOF-completed Host shutdown is idempotent");
  }, {
    stdio: true,
    onStdioHost: (value) => { host = value; },
    onStdioShutdownComplete: (reason) => { completedReason = reason; },
  });
});

test("stdio Host restart keeps a persisted active Operation Root-held without replay", { timeout: 45_000, skip: process.platform !== "win32" }, async () => {
  const taskId = `m3-restart-held-${randomUUID()}`;
  let spawned = 0;
  const platformProbe = createPlatformProbe();
  const unknownProbe: ProcessProbe = {
    platform: platformProbe.platform,
    identityOf: (pid) => platformProbe.identityOf(pid),
    selfIdentity: () => platformProbe.selfIdentity(),
    probe: async (requests) => requests.map(() => ({ state: "unknown", reason_code: "m3_restart_identity_unknown", observed_at: new Date().toISOString() })),
  };
  await withSqliteMcp(async (client, _manager, _dataRoot, workspace) => {
    const status = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
    assert.equal(status.status, "running", "restart reads the persisted active Attempt rather than synthesizing a terminal Result");
    assert.ok(["worker_identity_unknown", "worker_alive_unmanaged"].includes(String((status.execution_observation as Record<string, unknown> | undefined)?.state)));
    const blocked = await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, `m3-restart-new-${randomUUID()}`) });
    assert.equal(blocked.isError, true, "persisted active Operation must block new Admission after restart");
    assert.match(JSON.stringify(blocked), /blocked by Recovery/u);
    assert.equal(spawned, 0, "restart must not Spawn, Resume, Retry or Replay the active Attempt");
  }, {
    stdio: true,
    processProbe: unknownProbe,
    onChildSpawn: () => { spawned += 1; },
    beforeAuthority: (dataRoot, modules, workspace) => {
      const store = modules.Store.open(dataRoot);
      try {
        const port = modules.createPort(store);
        port.createTask(syntheticTask(workspace, taskId) as unknown as Parameters<typeof port.createTask>[0]);
        const allow = () => ({ state: "allow", fixture: true });
        const admission = port.admitOperation({ operation_id: candidateOperationId(taskId, 1), task_id: taskId, attempt: 1, workspace_ref: workspace }, {
          workspaceValidator: allow,
          executionPermissionCheck: allow,
        }) as Record<string, unknown>;
        const launch = { operation_id: candidateOperationId(taskId, 1), task_id: taskId, attempt: 1, generation: Number(admission.generation), revision: Number(admission.revision), launch_id: `launch-${taskId}`, launch_epoch: 1, launch_token: `synthetic-${taskId}-0123456789` };
        const intent = port.createLaunchIntent(launch) as Record<string, unknown>;
        const receipt = port.recordLaunchReceipt({ ...launch, revision: Number(intent.revision), receipt_id: `receipt-${taskId}`, launch_identity: { source: "synthetic_fixture", fixture: true, process_id: 43210, start_fingerprint: `fixture-${taskId}` } }) as Record<string, unknown>;
        port.commitPermanentClaim({ ...launch, revision: Number(receipt.revision), claim_id: `claim-${taskId}`, worker_identity: { source: "synthetic_fixture", fixture: true, worker_id: `worker-${taskId}`, incarnation: "synthetic-1", process_id: 43210, start_fingerprint: `fixture-${taskId}` } } as unknown as Parameters<typeof port.commitPermanentClaim>[0]);
      } finally {
        store.close();
      }
    },
  });
});

test("formal MCP interaction reply uses persisted SQLite request and a verified live Worker channel", { timeout: 60_000 }, async () => {
  const tracePath = process.env["WP6_INTERACTION_TRACE_PATH"];
  const appendTrace = (line: string): void => {
    if (tracePath) appendFileSync(tracePath, `${new Date().toISOString()} ${line}\n`, "utf8");
  };
  await withSqliteMcp(async (client, _manager, dataRoot, workspace) => {
    const taskId = `mcp-interaction-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.status, "queued");
    const event = await waitForInteractionRequest(client, taskId);
    const details = event.details as Record<string, unknown>;
    assert.equal(details.method, "interaction/requestUserInput");
    assert.deepEqual(details.params, { questions: [{ question: "Synthetic interaction response" }] });
    const requestId = String(details.request_id);
    const reply = contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: {
      task_id: taskId,
      request_id: requestId,
      decision: "accept",
      answers: { "Synthetic interaction response": "Synthetic answer" },
    } }));
    assert.equal(reply.state, "answered");
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const events = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const types = (events.events as Array<Record<string, unknown>>).map((item) => item.type);
    assert.ok(types.includes("interaction_requested"));
    assert.ok(types.includes("interaction_reply_accepted"));
    assert.equal(existsSync(path.join(dataRoot, ".tasks")), false, "SQLite interaction must remain SQLite-only");
  }, {
    enableSyntheticInteractionChannel: true,
    onStage: (stage, detail) => appendTrace(`manager ${stage} ${JSON.stringify(detail ?? {})}`),
    onChildSpawn: (child) => {
      child.stderr?.on("data", (chunk: Buffer) => appendTrace(`worker ${chunk.toString("utf8").trim()}`));
    },
  });
});

test("MVP offline cutover archives sealed JSON and starts the sole empty SQLite MCP stdio Authority", { timeout: 90_000, skip: process.platform !== "win32" }, async () => {
  const fixture = path.join(integrationRoot, `mvp-offline-cutover-${randomUUID()}`);
  const legacyRoot = path.join(fixture, "legacy-json");
  const workspace = path.join(fixture, "workspace");
  const archivePath = path.join(fixture, "archive");
  const oldTaskId = `legacy-queued-${randomUUID()}`;
  const newTaskId = `sqlite-new-${randomUUID()}`;
  mkdirSync(workspace, { recursive: true });
  mkdirSync(legacyRoot, { recursive: true });
  const processProbe = createPlatformProbe();
  const seedStore = new TaskStore(legacyRoot);
  seedStore.createTask(syntheticTask(workspace, oldTaskId) as unknown as Parameters<TaskStore["createTask"]>[0], new Date().toISOString());

  let jsonManager: BridgeTaskManager | undefined;
  let jsonServer: ReturnType<typeof createBridgeServer> | undefined;
  let jsonClient: RawStdioMcpTestClient | undefined;
  let cutoverCompleted = false;
  try {
    const writerLease = await registerManagerJsonWriter(legacyRoot, await processProbe.selfIdentity());
    const jsonStore = new TaskStore(legacyRoot, { writerQuiescence: true, writerLeaseToken: writerLease });
    jsonManager = new BridgeTaskManager({
      store: jsonStore,
      workspaceProvider: new DirectWorkspaceProvider(),
      pollIntervalMs: 0,
      probe: processProbe,
      managerWriterLeaseToken: writerLease,
      spawnWorker: () => { throw new Error("cutover fixture must preserve its queued Task without dispatch"); },
    });
    jsonServer = createBridgeServer({ taskManager: jsonManager });
    jsonClient = new RawStdioMcpTestClient();
    const host = serveStdioLifecycleHost(jsonServer, jsonManager, { stdin: jsonClient.stdin, stdout: jsonClient.stdout });
    await jsonClient.initialize();
    const oldStatus = contentObject(await (jsonClient as unknown as Client).callTool({ name: "zcode_status", arguments: { task_id: oldTaskId } }));
    assert.equal(oldStatus.status, "queued", "the old JSON Task remains real queued history before cutover");

    assert.equal(await jsonManager.beginWriterQuiescence(), "draining");
    const rejected = await (jsonClient as unknown as Client).callTool({
      name: "zcode_task",
      arguments: syntheticTask(workspace, `json-after-drain-${randomUUID()}`),
    });
    assert.equal(rejected.isError, true, "the connected old Host rejects new admission after drain begins");
    assert.equal(await host.shutdown("OFFLINE_CUTOVER"), true, "the old Host closes only after Manager shutdown completes");
    await jsonClient.close();
    await jsonServer.close();
    await jsonManager.shutdown();

    const sealStore = new TaskStore(legacyRoot);
    const sealed = await sealJsonWriterRoot(legacyRoot, sealStore, processProbe);
    assert.equal(sealed.sealed, true, "all supported JSON participants and started executions must be absent before Seal");
    await assert.rejects(registerManagerJsonWriter(legacyRoot, await processProbe.selfIdentity()),
      /new writer registration is closed/u, "the supported Host startup path cannot reacquire the sealed legacy Root");

    const createdArchive = await createJsonHistoryArchive(path.join(legacyRoot, ".tasks"), archivePath, { mode: "raw" });
    assert.equal(createdArchive.manifest.archive_mode, "raw");
    assert.equal(createdArchive.manifest.archive_status, "archived");
    const verifiedArchive = await readJsonHistoryArchive(archivePath);
    assert.equal(verifiedArchive.archive_mode, "raw");
    assert.equal(verifiedArchive.tasks.length, 0);
    assert.equal(new TaskStore(legacyRoot).readStatus(oldTaskId).status, "queued", "cutover must preserve the original JSON bytes and status");

    await withSqliteMcp(async (client, _manager, sqliteRoot, sqliteWorkspace) => {
      assert.notEqual(path.resolve(sqliteRoot), path.resolve(legacyRoot), "SQLite receives a distinct migrated data root");
      const oldLookup = await client.callTool({ name: "zcode_status", arguments: { task_id: oldTaskId } });
      assert.equal(oldLookup.isError, true, "legacy JSON Tasks are not imported into the online SQLite Authority");
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(sqliteWorkspace, newTaskId) }));
      assert.equal(created.task_id, newTaskId);
      assert.equal(created.status, "queued");
      const terminal = await waitForTerminal(client, newTaskId, 1, "new SQLite work after migration");
      assert.equal(terminal.status, "completed");
      const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: newTaskId } }));
      assert.equal(result.status, "completed");
      const modules = await loadLifecycleCandidateModules();
      const recovery = modules.Store.openForRecovery(sqliteRoot, {
        databaseFileName: "bridge.sqlite",
        managedDataDirectory: true,
      });
      assert.ok(recovery);
      try {
        const port = modules.createPort(recovery);
        assert.equal(port.readTaskProjection(oldTaskId), null);
        assert.equal((port.readTaskProjection(newTaskId) as Record<string, unknown>).status, "completed");
      } finally {
        recovery.close();
      }
      assert.equal(existsSync(path.join(sqliteRoot, ".tasks")), false, "the SQLite task never writes JSON TaskStore files");
    }, {
      stdio: true,
      preserveFixtureOnFailure: true,
      databaseFileName: "bridge.sqlite",
      prepareDataRoot: async (sqliteRoot) => {
        const migration = await publishJsonAuthority({
          jsonDataRoot: legacyRoot,
          sqliteRoot,
          archiveDirectory: createdArchive.archive_directory,
          expectedArchiveManifestDigest: createdArchive.identity.manifest_digest,
        });
        assert.equal(migration.status, "published");
        assert.equal(migration.task_count, 0);
      },
    });
    cutoverCompleted = true;
  } finally {
    if (jsonClient) await jsonClient.close().catch(() => undefined);
    if (jsonServer) await jsonServer.close().catch(() => undefined);
    if (jsonManager) await jsonManager.shutdown().catch(() => undefined);
    if (cutoverCompleted) {
      try { rmSync(fixture, { recursive: true, force: true }); } catch { /* preserve fixture if Windows retains a handle */ }
    }
  }
});
