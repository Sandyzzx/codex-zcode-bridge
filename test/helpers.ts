// Shared test fixtures: fake spawn infrastructure, disposable directories, and
// sample payloads. Unit tests never invoke the real ZCode CLI or any model.
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentReport,
  TaskPackage,
  WorkspaceRef,
  ZCodeRuntimeConfig,
} from "../src/interfaces.js";
import type { SpawnedProcess, SpawnFunction, SpawnOptionsLike } from "../src/adapters/process-spawn.js";

export const SESSION_ID = "sess_11111111-aaaa-4bbb-8ccc-cccccccccccc";

export class FakeStream {
  readonly #emitter = new EventEmitter();

  setEncoding(_encoding: "utf8"): void {
    // encoding is irrelevant for fakes
  }

  on(event: "data", listener: (chunk: string) => void): void {
    this.#emitter.on(event, listener);
  }

  emitData(chunk: string): void {
    this.#emitter.emit("data", chunk);
  }
}

export class FakeChild implements SpawnedProcess {
  readonly stdout: FakeStream = new FakeStream();
  readonly stderr: FakeStream = new FakeStream();
  readonly pid: number;
  killCallCount = 0;
  readonly #events = new EventEmitter();

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.#events.on(event, listener);
    return this;
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killCallCount += 1;
    return true;
  }

  emitStdout(text: string): void {
    this.stdout.emitData(text);
  }

  emitStderr(text: string): void {
    this.stderr.emitData(text);
  }

  /** Deferred so the adapter's listeners (attached synchronously) are ready. */
  emitClose(code: number | null, signal: string | null): void {
    setImmediate(() => this.#events.emit("close", code, signal));
  }

  emitError(error: Error): void {
    setImmediate(() => this.#events.emit("error", error));
  }
}

export interface SpawnRecord {
  readonly file: string;
  readonly args: string[];
  readonly options: SpawnOptionsLike;
  readonly child: FakeChild;
  promptContent: string | null;
}

/**
 * Scriptable fake spawn. Each queued script hook runs after listeners are
 * attached; hooks typically capture the prompt file content and emit
 * stdout/stderr/close.
 */
export class FakeSpawn {
  readonly records: SpawnRecord[] = [];
  readonly script: Array<(child: FakeChild, record: SpawnRecord, index: number) => void> = [];
  /** When set, spawn itself throws synchronously (ENOENT-style failures). */
  spawnThrows: Error | null = null;

  spawnFn: SpawnFunction = (file, args, options) => {
    if (this.spawnThrows) {
      throw this.spawnThrows;
    }
    const child = new FakeChild(30_000 + this.records.length);
    const record: SpawnRecord = { file, args, options, child, promptContent: null };
    this.records.push(record);
    const hook = this.script.shift();
    if (hook) {
      queueMicrotask(() => hook(child, record, this.records.length - 1));
    }
    return child;
  };

  recordForPid(pid: number): SpawnRecord | undefined {
    return this.records.find((record) => record.child.pid === pid);
  }
}

export function fakeConfig(overrides: Partial<ZCodeRuntimeConfig> = {}): ZCodeRuntimeConfig {
  return {
    nodeExecutable: "node-fake",
    zcodeEntrypoint: "C:\\fake\\zcode.cjs",
    providerBuiltinConfigFile: "C:\\fake\\zcode-builtin.json",
    providerPersonalConfigFile: "C:\\fake\\provider_config.json",
    dataRoot: "C:\\fake\\data",
    ...overrides,
  };
}

export function stubResolver(config: ZCodeRuntimeConfig = fakeConfig()): {
  resolve: () => Promise<ZCodeRuntimeConfig>;
} {
  return { resolve: async () => config };
}

export function validReport(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    summary: "Created the requested file",
    files_changed: ["bridge-smoke.txt"],
    tests: [{ command: "pytest -q", status: "passed" }],
    issues: [],
    needs_master_decision: false,
    ...overrides,
  };
}

export function successEnvelope(
  report: AgentReport | object,
  sessionId: string = SESSION_ID,
): string {
  return JSON.stringify({
    sessionId,
    traceId: "trace-1",
    turnId: "turn-1",
    response: JSON.stringify(report),
    usage: { source: "provider", totalTokens: 100 },
    eventCount: 1,
    projection: { status: "idle" },
  });
}

export function makeTask(overrides: Partial<TaskPackage> = {}): TaskPackage {
  return {
    task_id: "task_1",
    workspace: "C:\\work\\demo",
    objective: "Create bridge-smoke.txt containing ZCODE_HEADLESS_SMOKE_OK",
    requirements: ["The file must contain exactly one line"],
    allowed_paths: ["bridge-smoke.txt"],
    forbidden_paths: ["../outside"],
    acceptance_criteria: ["File exists with the expected content"],
    test_commands: [],
    ...overrides,
  };
}

export function makeWorkspace(canonicalPath = "C:\\work\\demo"): WorkspaceRef {
  return { requestedPath: canonicalPath, canonicalPath, mode: "direct" };
}

export async function makeTempDir(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `zcode-bridge-test-${label}-`));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export const TRANSIENT_STDERR = "Error: Bundled 与 Active ZCode Built-in Release 均不可用";
