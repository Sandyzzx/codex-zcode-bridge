# Codex → ZCode Bridge: V0.1 Frozen Interfaces

**Status: FROZEN for V0.1 implementation**

Version: 0.1.0

Date: 2026-09-26

All MCP argument names are `snake_case`. Unknown arguments are rejected. Implementations may add internal fields but must not change these tool names, required fields, status names, or result semantics in V0.1.

## Shared types

```ts
export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_for_master";

export interface TaskPackage {
  task_id: string;
  workspace: string; // absolute path to an existing directory
  objective: string;
  requirements: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  test_commands: string[];
  context?: string;
}

export interface TestReport {
  command: string;
  status: "passed" | "failed" | "not_run";
  details?: string;
}

export interface TaskResult {
  task_id: string;
  status: "completed" | "failed" | "cancelled" | "waiting_for_master";
  summary: string;
  files_changed: string[];
  tests: TestReport[];
  issues: string[];
  needs_master_decision: boolean;
  zcode_output: string;
  exit_code: number | null;
  session_id: string | null;
  attempt: number;
  started_at: string | null; // RFC 3339 UTC
  finished_at: string | null; // RFC 3339 UTC
  error_code?: string;
}
```

`TaskResult.status` describes Bridge/ZCode execution only. `completed` is not a Codex PASS. `files_changed`, tests, and decisions are normalized claims from the subordinate report and must be checked by Codex.

## MCP tools

### `zcode_task`

Input is exactly `TaskPackage`. `task_id` must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` and be unused. Arrays may be empty but must be present; `workspace` is required and canonicalized.

Returns:

```ts
interface TaskReceipt {
  task_id: string;
  status: "queued" | "running";
  created_at: string;
}
```

The server persists the package before returning. If validation or spawn fails, return an MCP error and persist failure details when a task record has already been allocated.

### `zcode_status`

Input: `{ task_id: string }`.

Returns:

```ts
interface TaskStatusRecord {
  task_id: string;
  status: TaskStatus;
  attempt: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_pid: number | null;
  zcode_session_id: string | null;
  exit_code: number | null;
  error_code?: string;
  error?: string;
}
```

This is execution status only; it never contains a PASS/FAIL code-review judgment.

### `zcode_result`

Input: `{ task_id: string }`. Returns the persisted `TaskResult` for a terminal state. Before a terminal state, return MCP error `TASK_NOT_FINISHED`. Unknown IDs return `TASK_NOT_FOUND`.

### `zcode_continue`

Input:

```ts
interface ContinueTaskInput {
  task_id: string;
  feedback: string;
  additional_requirements?: string[];
}
```

Allowed only from `completed`, `failed`, or `waiting_for_master`. Reuses the task ID and workspace, increments `attempt`, preserves prior results, and returns `TaskReceipt`. The new prompt includes the original task, previous normalized result, feedback, and additional requirements. A decision flagged by ZCode is never auto-approved by the Bridge; Codex must provide the follow-up instruction.

### `zcode_cancel`

Input: `{ task_id: string }`. Allowed only from `queued` or `running`. Returns the updated `TaskStatusRecord`. Running cancellation returns only after process-tree termination is confirmed; if confirmation fails, the task remains nonterminal with a cancellation error recorded.

## Coding agent adapter contract

```ts
export interface WorkspaceRef {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly mode: "direct";
}

export interface AgentHandle {
  readonly taskId: string;
  readonly attempt: number;
  readonly workerPid: number;
  readonly zcodePid: number | null;
  readonly startedAt: string;
}

export interface AgentRunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly sessionId: string | null;
  readonly response: string | null;
  readonly usage: Record<string, unknown> | null;
  readonly timedOut: boolean;
}

export interface AgentProcessStatus {
  readonly state: "starting" | "running" | "exited" | "unknown";
  readonly workerPid: number;
  readonly zcodePid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface CodingAgentAdapter {
  startTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
  }): Promise<AgentHandle>;
  continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: TaskResult | null;
  }): Promise<AgentHandle>;
  getStatus(handle: AgentHandle): Promise<AgentProcessStatus>;
  getResult(handle: AgentHandle): Promise<AgentRunOutcome>;
  cancelTask(handle: AgentHandle): Promise<void>;
}
```

The Bridge `TaskManager` owns public status and persistence; adapter status/result are runtime evidence and must not decide correctness. `WorkspaceProvider` exposes `resolve(workspacePath): Promise<WorkspaceRef>` and `release(ref): Promise<void>`; Direct V0.1 release is a no-op.

```ts
export interface TaskManager {
  createTask(task: TaskPackage): Promise<TaskReceipt>;
  getStatus(taskId: string): Promise<TaskStatusRecord>;
  getResult(taskId: string): Promise<TaskResult>;
  continueTask(input: ContinueTaskInput): Promise<TaskReceipt>;
  cancelTask(taskId: string): Promise<TaskStatusRecord>;
}

export interface WorkspaceProvider {
  resolve(workspacePath: string): Promise<WorkspaceRef>;
  release(workspace: WorkspaceRef): Promise<void>;
}

export interface RuntimeResolver {
  resolve(): Promise<ZCodeRuntimeConfig>;
}

export interface ZCodeRuntimeConfig {
  readonly nodeExecutable: string;
  readonly zcodeEntrypoint: string;
  readonly providerBuiltinConfigFile: string;
  readonly providerPersonalConfigFile: string;
  readonly dataRoot: string;
}
```

`RuntimeResolver` consumes `ZCODE_BRIDGE_NODE`, `ZCODE_BRIDGE_ZCODE_CJS`, and `ZCODE_BRIDGE_DATA_DIR` as optional Bridge overrides; provider config is inherited as the official pair or resolved from the ZCode installation plus `ZCODE_DATA_BASE_DIR` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`. It validates paths without exposing file contents. The worker receives resolved paths and injects both official provider variables into only the ZCode child process.

## Structured subordinate report

The prompt requests that ZCode's `response` contain one JSON object with:

```ts
interface AgentReport {
  summary: string;
  files_changed: string[];
  tests: TestReport[];
  issues: string[];
  needs_master_decision: boolean;
}
```

The adapter parses the CLI JSON envelope first, then parses/validates `response` as `AgentReport`. If the response is not valid, retain raw output, set `invalid_agent_report`, and mark the run failed for review. Never synthesize `needs_master_decision: false` from missing data.

## Persistence contract

```text
<bridge-data-root>/.tasks/<task_id>/
  task.json
  status.json
  stdout.log
  stderr.log
  result.json       # written only after a terminal result
  attempts/         # immutable per-attempt prompt/result metadata
```

Store writes are atomic for JSON records. Logs are UTF-8, byte-bounded, and separate. Secrets and full environment variables are not persisted.
